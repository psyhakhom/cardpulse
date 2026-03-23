/**
 * GET /api/cards?q={query}
 *
 * Card autocomplete endpoint. Returns up to 6 matching cards from:
 *   - pokemontcg.io  (Pokemon)
 *   - Scryfall       (MTG)
 *   - eBay sold titles (DBS + fallback)
 * Plus an "eBay direct" fallback option.
 *
 * All responses are in-memory cached for 1 hour per query string.
 * Env vars: POKEMON_TCG_API_KEY (optional — unlocks higher rate limit)
 *           EBAY_CLIENT_ID / EBAY_CLIENT_SECRET (for DBS eBay title search)
 */

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const cache = new Map()
const CACHE_TTL = 60 * 60 * 1000 // 1 hour

async function withCache(key, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() < hit.expires) return hit.data
  const data = await fn()
  cache.set(key, { data, expires: Date.now() + CACHE_TTL })
  return data
}

// ─── GAME DETECTION ──────────────────────────────────────────────────────────
const POKEMON_KW = [
  'pokemon', 'pokémon', 'charizard', 'pikachu', 'mewtwo', 'eevee', 'blastoise',
  'venusaur', 'gengar', 'snorlax', 'gyarados', 'meowth', 'lugia', 'ho-oh',
  'rayquaza', 'mew', 'umbreon', 'espeon', 'sylveon', 'gardevoir', 'lucario',
  'greninja', 'alakazam', 'bulbasaur', 'squirtle', 'jigglypuff', 'dragonite',
]
const MTG_KW = ['mtg', 'magic the gathering', 'magic:', 'planeswalker', 'mana ']
const DBS_KW = [
  'dragon ball', 'dragonball', 'dbs', 'fusion world', 'goku', 'vegeta',
  'vegito', 'gogeta', 'frieza', 'gohan', 'piccolo', 'broly', 'beerus', 'trunks',
  'bardock', 'cell', 'android', 'majin', 'saiyan',
]
const DBS_CODE_RE = /\b(?:BT|FB|SD|OP|ST|D-BT)\d+/i

function detectGame(query) {
  const ql = query.toLowerCase()
  if (POKEMON_KW.some((k) => ql.includes(k))) return 'pokemon'
  if (MTG_KW.some((k) => ql.includes(k))) return 'mtg'
  if (DBS_KW.some((k) => ql.includes(k)) || DBS_CODE_RE.test(query)) return 'dbs'
  return null
}

// ─── QUERY BUILDER ────────────────────────────────────────────────────────────
function buildPokemonQuery(card) {
  const name = card.name || ''
  const number = card.number || ''
  const total = card.set?.printedTotal || card.set?.total || ''
  const setName = card.set?.name || ''
  const numStr = number && total ? `${number}/${total}` : number
  return [name, numStr, setName].filter(Boolean).join(' ').slice(0, 60)
}

function buildMtgQuery(card) {
  return [card.name, card.set_name].filter(Boolean).join(' ').slice(0, 60)
}

// ─── EBAY TOKEN ───────────────────────────────────────────────────────────────
let ebayToken = null
let ebayTokenExp = 0

async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExp) return ebayToken
  const id = process.env.EBAY_CLIENT_ID
  const secret = process.env.EBAY_CLIENT_SECRET
  if (!id || !secret) throw new Error('eBay credentials not configured')
  const creds = Buffer.from(`${id}:${secret}`).toString('base64')
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`eBay token ${res.status}`)
  const data = await res.json()
  ebayToken = data.access_token
  ebayTokenExp = Date.now() + (data.expires_in - 60) * 1000
  return ebayToken
}

// ─── DBS / EBAY TITLE SEARCH ─────────────────────────────────────────────────
// Patterns that indicate a listing is NOT a single card
const JUNK_RE = /\b(lot|bundle|collection|set|booster|pack|box|\d+\s*card|\dx|\bx\d+)\b/i
// DBS card number pattern
const DBS_NUM_RE = /\b(?:BT|FB|SD|ST|D-BT)\d+-\d+[A-Z]?\b/i

function extractDbsCardName(title) {
  // Remove common suffix noise
  let t = title
    .replace(/\bpsa\s*\d+\b/gi, '')
    .replace(/\bbgs\s*[\d.]+\b/gi, '')
    .replace(/\bcgc\s*[\d.]+\b/gi, '')
    .replace(/\bsgc\s*\d+\b/gi, '')
    .replace(/\bnear\s*mint\b|\bnm\b|\bmp\b|\blp\b|\bgd\b/gi, '')
    .replace(/\bfoil\b|\bholo\b|\balt\s*art\b/gi, '')
    .replace(/\bdragon\s*ball\s*(super\s*)?(card\s*game)?\b/gi, '')
    .replace(/\bfusion\s*world\b/gi, '')
    .replace(/\bdbs\b/gi, '')
    .replace(/\bcard\b/gi, '')
    .replace(/[[\]()|]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  // Extract card number if present and use it in display
  const numMatch = t.match(DBS_NUM_RE)
  const num = numMatch ? numMatch[0] : ''

  // Remove the card number from the name portion
  if (num) t = t.replace(num, '').trim()

  // Clean leading/trailing punctuation
  t = t.replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, '').trim()

  // Capitalize first letter of each word
  t = t.replace(/\b\w/g, (c) => c.toUpperCase())

  return { name: t, number: num }
}

async function searchEbayTitles(query, game) {
  return withCache(`ebay-titles:${game}:${query.toLowerCase()}`, async () => {
    const token = await getEbayToken()
    // Append "card" to reduce noise from non-card results
    const q = `${query} card`
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=buyingOptions:{AUCTION|FIXED_PRICE},conditions:{USED|UNGRADED}&sort=newlyListed&limit=50`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) {
      console.error('[cards] eBay titles search error:', res.status, await res.text().catch(() => ''))
      return []
    }
    const data = await res.json()
    const items = data.itemSummaries || []

    // Deduplicate by extracted card name
    const seen = new Set()
    const cards = []
    for (const item of items) {
      const title = item.title || ''
      if (JUNK_RE.test(title)) continue
      const { name, number } = extractDbsCardName(title)
      if (!name || name.length < 3) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      cards.push({
        id: `ebay-title-${item.itemId}`,
        name,
        set: number || '',
        number: number || '',
        rarity: '',
        game: game || 'dbs',
        imageUrl: item.image?.imageUrl || null,
        largeImageUrl: item.image?.imageUrl || null,
        searchQuery: number ? `${name} ${number}` : name,
      })
      if (cards.length >= 8) break
    }
    return cards
  })
}

// ─── POKEMON TCG API ──────────────────────────────────────────────────────────
async function searchPokemon(query) {
  return withCache(`pkm:${query.toLowerCase()}`, async () => {
    const apiKey = process.env.POKEMON_TCG_API_KEY
    const headers = { Accept: 'application/json' }
    if (apiKey) headers['X-Api-Key'] = apiKey

    // Wildcard suffix for partial matching (e.g. "Chariza" → "Charizard")
    // Note: no quotes around name value — pokemontcg.io Lucene doesn't support quoted wildcards
    const q = `name:${query}*`
    const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=20&select=id,name,number,rarity,set,images`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`pokemontcg ${res.status}`)
    const data = await res.json()

    return (data.data || []).map((card) => ({
      id: `pkm-${card.id}`,
      name: card.name,
      set: card.set?.name || '',
      number: card.number || '',
      rarity: card.rarity || '',
      game: 'pokemon',
      imageUrl: card.images?.small || null,
      largeImageUrl: card.images?.large || null,
      searchQuery: buildPokemonQuery(card),
    }))
  })
}

// ─── MTG / SCRYFALL ──────────────────────────────────────────────────────────
async function searchMtg(query) {
  return withCache(`mtg:${query.toLowerCase()}`, async () => {
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&limit=20`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data = await res.json()

    return (data.data || []).slice(0, 10).map((card) => ({
      id: `mtg-${card.id}`,
      name: card.name,
      set: card.set_name || '',
      number: card.collector_number || '',
      rarity: card.rarity || '',
      game: 'mtg',
      imageUrl: card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || null,
      largeImageUrl: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || null,
      searchQuery: buildMtgQuery(card),
    }))
  })
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { q } = req.query
  console.log('[cards] handler called, q:', q)

  if (!q || q.trim().length < 3) {
    return res.status(400).json({ error: 'Query too short' })
  }

  const query = q.trim()
  const game = detectGame(query)
  console.log('[cards] game detected:', game)
  const ebayDirect = {
    id: 'ebay-direct',
    name: `Search eBay for "${query}"`,
    set: '', number: '', rarity: '',
    game: 'direct',
    imageUrl: null, largeImageUrl: null,
    searchQuery: query,
    isDirect: true,
  }

  let cards = []
  let attribution = null

  if (game === 'pokemon') {
    try {
      cards = await searchPokemon(query)
      attribution = 'pokemontcg.io'
      console.log('[cards] pokemon results:', cards.length)
    } catch (err) {
      console.error('[cards] pokemon error:', err.message)
    }
  } else if (game === 'mtg') {
    try {
      cards = await searchMtg(query)
      attribution = 'Scryfall'
      console.log('[cards] mtg results:', cards.length)
    } catch (err) {
      console.error('[cards] mtg error:', err.message)
    }
  } else if (game === 'dbs') {
    try {
      cards = await searchEbayTitles(query, 'dbs')
      attribution = 'eBay listings'
      console.log('[cards] dbs ebay-titles results:', cards.length)
    } catch (err) {
      console.error('[cards] dbs ebay-titles error:', err.message)
    }
  } else {
    // Unknown game — try Pokemon and MTG in parallel, fall back to eBay titles
    const [pkm, mtg] = await Promise.allSettled([searchPokemon(query), searchMtg(query)])
    if (pkm.status === 'fulfilled') { cards.push(...pkm.value); console.log('[cards] unknown/pkm:', pkm.value.length) }
    else console.error('[cards] unknown/pkm error:', pkm.reason?.message)
    if (mtg.status === 'fulfilled') { cards.push(...mtg.value); console.log('[cards] unknown/mtg:', mtg.value.length) }
    else console.error('[cards] unknown/mtg error:', mtg.reason?.message)

    if (cards.length) {
      attribution = 'pokemontcg.io & Scryfall'
    } else {
      // Nothing from card APIs — try eBay titles as last resort
      try {
        cards = await searchEbayTitles(query, null)
        attribution = 'eBay listings'
        console.log('[cards] unknown/ebay-titles fallback:', cards.length)
      } catch (err) {
        console.error('[cards] unknown/ebay-titles error:', err.message)
      }
    }
  }

  return res.status(200).json({ cards: cards.slice(0, 6), ebayDirect, game, attribution })
}
