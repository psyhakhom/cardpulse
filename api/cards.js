/**
 * GET /api/cards?q={query}
 *
 * Card autocomplete endpoint. Returns up to 6 matching cards from:
 *   - pokemontcg.io  (Pokemon)
 *   - Scryfall       (MTG)
 * Plus an "eBay direct" fallback option.
 *
 * All responses are in-memory cached for 1 hour per query string.
 * Env vars: POKEMON_TCG_API_KEY (optional — unlocks higher rate limit)
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

// ─── POKEMON TCG API ──────────────────────────────────────────────────────────
async function searchPokemon(query) {
  return withCache(`pkm:${query.toLowerCase()}`, async () => {
    const apiKey = process.env.POKEMON_TCG_API_KEY
    const headers = { Accept: 'application/json' }
    if (apiKey) headers['X-Api-Key'] = apiKey

    // Wildcard suffix for partial matching (e.g. "Chariza" → "Charizard")
    const q = `name:"${query}"*`
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
  if (!q || q.trim().length < 3) {
    return res.status(400).json({ error: 'Query too short' })
  }

  const query = q.trim()
  const game = detectGame(query)
  const ebayDirect = {
    id: 'ebay-direct',
    name: `Search eBay for "${query}"`,
    set: '', number: '', rarity: '',
    game: 'direct',
    imageUrl: null, largeImageUrl: null,
    searchQuery: query,
    isDirect: true,
  }

  try {
    let cards = []
    let attribution = null

    if (game === 'pokemon') {
      cards = await searchPokemon(query)
      attribution = 'pokemontcg.io'
    } else if (game === 'mtg') {
      cards = await searchMtg(query)
      attribution = 'Scryfall'
    } else if (game === 'dbs') {
      // No stable public DBS card API — eBay direct is the search strategy
      cards = []
    } else {
      // Unknown game — try Pokemon and MTG in parallel
      const [pkm, mtg] = await Promise.allSettled([searchPokemon(query), searchMtg(query)])
      if (pkm.status === 'fulfilled') cards.push(...pkm.value)
      if (mtg.status === 'fulfilled') cards.push(...mtg.value)
      if (cards.length) attribution = 'pokemontcg.io & Scryfall'
    }

    return res.status(200).json({ cards: cards.slice(0, 6), ebayDirect, game, attribution })
  } catch (err) {
    console.error('[cards]', err.message)
    return res.status(200).json({ cards: [], ebayDirect, game, attribution: null })
  }
}
