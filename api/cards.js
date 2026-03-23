/**
 * GET /api/cards?q={query}
 *
 * Card catalog autocomplete endpoint. Returns up to 8 matching cards from:
 *   - pokemontcg.io  (Pokemon)
 *   - Scryfall       (MTG)
 *   - dbs-cardgame.com (DBS) with hardcoded fallback
 *   - Sports: returns empty — falls back to direct eBay search
 * Plus an "eBay direct" fallback option always included.
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
  // Trainer/character names
  'ash', 'misty', 'brock', 'team rocket', 'jessie', 'james', 'giovanni',
  'gary', 'professor oak', 'nurse joy', 'gym leader', 'elite four', 'trainer',
]
const MTG_KW = ['mtg', 'magic the gathering', 'magic:', 'planeswalker', 'mana ']
const DBS_KW = [
  'dragon ball', 'dragonball', 'dbs', 'fusion world', 'goku', 'vegeta',
  'vegito', 'gogeta', 'frieza', 'gohan', 'piccolo', 'broly', 'beerus', 'trunks',
  'bardock', 'cell', 'android', 'majin', 'saiyan',
  // Attack/move names
  'kamehameha', 'final flash', 'galick gun', 'spirit bomb', 'instant transmission',
  'hakai', 'ultra instinct', 'god kamehameha', 'destructo disc',
  'special beam cannon', 'makankosappo',
]
const DBS_CODE_RE = /\b(?:BT|FB|SD|OP|ST|D-BT)\d+/i

function detectGame(query) {
  const ql = query.toLowerCase()
  if (POKEMON_KW.some((k) => ql.includes(k))) return 'pokemon'
  if (MTG_KW.some((k) => ql.includes(k))) return 'mtg'
  if (DBS_KW.some((k) => ql.includes(k)) || DBS_CODE_RE.test(query)) return 'dbs'
  return null
}

// ─── QUERY SANITIZER ─────────────────────────────────────────────────────────
// Strip colons, commas, and other special chars that break card database searches
// (e.g. "Son Goku: Childhood" → "Son Goku Childhood" for the API query)
function sanitizeQuery(query) {
  return query
    .replace(/[:;,!?@#$%^&*()[\]{}|\\<>~`"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── QUERY BUILDERS ──────────────────────────────────────────────────────────
function buildPokemonQuery(card) {
  const name = card.name || ''
  const number = card.number || ''
  const total = card.set?.printedTotal || card.set?.total || ''
  const setName = card.set?.name || ''
  const numStr = number && total ? `${number}/${total}` : number
  return [name, numStr, setName].filter(Boolean).join(' ').slice(0, 60)
}

function buildMtgQuery(card) {
  return [card.name, card.set_name, card.collector_number].filter(Boolean).join(' ').slice(0, 60)
}

function buildDbsQuery(card) {
  return [card.name, card.number, card.rarity].filter(Boolean).join(' ').slice(0, 60)
}

// ─── POKEMON TCG API ──────────────────────────────────────────────────────────
// Japanese exclusive sets — when detected, flag results so frontend can auto-set language
const JP_EXCLUSIVE_SETS = [
  'ash vs team rocket', 'tag team gx', 'dream league', 'alter genesis',
  'remix bout', 'miraculous intermezzo', 'shiny star v', 'eevee heroes',
  'vmax climax', 'battle region', 'dark phantasma', 'lost abyss',
  'incandescent arcana', 'paradigm trigger', 'vstar universe', 'triplet beat',
  'snow hazard', 'clay burst', 'ruler of the black flame', 'raging surf',
  'ancient roar', 'future flash', 'wild force', 'cyber judge',
  'crimson haze', 'mask of change', 'night wanderer', 'stellar miracle',
  'superelectric breaker', 'paradise dragona', 'terastal festival',
]

function isJpExclusiveSet(setName) {
  if (!setName) return false
  const sl = setName.toLowerCase()
  return JP_EXCLUSIVE_SETS.some((jp) => sl.includes(jp))
}

function mapPokemonCard(card) {
  const jpExclusive = isJpExclusiveSet(card.set?.name)
  return {
    id: `pkm-${card.id}`,
    name: card.name,
    set: card.set?.name || '',
    number: card.number || '',
    rarity: card.rarity || '',
    game: 'pokemon',
    imageUrl: card.images?.small || null,
    largeImageUrl: card.images?.large || null,
    searchQuery: buildPokemonQuery(card),
    jpExclusive,
  }
}

function pokemonHeaders() {
  const apiKey = process.env.POKEMON_TCG_API_KEY
  const headers = { Accept: 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  return headers
}

async function searchPokemon(query) {
  return withCache(`pkm:${query.toLowerCase()}`, async () => {
    const headers = pokemonHeaders()
    const sanitized = sanitizeQuery(query)

    // Build the name query — handle "vs" queries specially
    let nameQ
    if (/\bvs\.?\b/i.test(sanitized)) {
      const parts = sanitized.split(/\bvs\.?\b/i).map((s) => s.trim()).filter(Boolean)
      nameQ = parts.map((p) => `name:*${p}*`).join(' ')
      console.log(`[cards:pkm] VS query detected: "${nameQ}"`)
    } else {
      nameQ = `name:${sanitized}*`
    }

    // Run name search + set name search in parallel
    const nameUrl = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(nameQ)}&pageSize=8&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`
    const setUrl = `https://api.pokemontcg.io/v2/cards?q=set.name:"*${encodeURIComponent(sanitized)}*"&pageSize=4&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`
    const setsUrl = `https://api.pokemontcg.io/v2/sets?q=name:"*${encodeURIComponent(sanitized)}*"&pageSize=3&orderBy=-releaseDate`

    const [nameRes, setRes, setsRes] = await Promise.allSettled([
      fetch(nameUrl, { headers, signal: AbortSignal.timeout(5000) }),
      fetch(setUrl, { headers, signal: AbortSignal.timeout(5000) }),
      fetch(setsUrl, { headers, signal: AbortSignal.timeout(5000) }),
    ])

    // Collect cards from name search
    let cards = []
    if (nameRes.status === 'fulfilled' && nameRes.value.ok) {
      const data = await nameRes.value.json()
      cards.push(...(data.data || []).map(mapPokemonCard))
    }

    // Merge cards from set name search, deduplicating by id
    if (setRes.status === 'fulfilled' && setRes.value.ok) {
      const data = await setRes.value.json()
      const seenIds = new Set(cards.map((c) => c.id))
      for (const card of (data.data || [])) {
        const mapped = mapPokemonCard(card)
        if (!seenIds.has(mapped.id)) {
          cards.push(mapped)
          seenIds.add(mapped.id)
        }
      }
    }

    // Collect matching sets as "Browse set" options
    const sets = []
    if (setsRes.status === 'fulfilled' && setsRes.value.ok) {
      const data = await setsRes.value.json()
      for (const s of (data.data || [])) {
        sets.push({
          id: `pkm-set-${s.id}`,
          name: `Browse: ${s.name}`,
          set: s.name,
          number: `${s.total || '?'} cards`,
          rarity: s.releaseDate || '',
          game: 'pokemon',
          imageUrl: s.images?.symbol || null,
          largeImageUrl: s.images?.logo || null,
          searchQuery: `pokemon ${s.name}`,
          isSet: true,
        })
      }
    }

    // If no cards found, retry with a direct set.name match (catches JP exclusives like "Ash vs Team Rocket")
    if (!cards.length && !sets.length) {
      console.log(`[cards:pkm] no results, retrying with direct set.name:"${sanitized}"`)
      const directSetUrl = `https://api.pokemontcg.io/v2/cards?q=set.name:"${encodeURIComponent(sanitized)}"&pageSize=8&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`
      try {
        const directRes = await fetch(directSetUrl, { headers, signal: AbortSignal.timeout(5000) })
        if (directRes.ok) {
          const data = await directRes.json()
          cards.push(...(data.data || []).map(mapPokemonCard))
          console.log(`[cards:pkm] direct set.name retry found ${cards.length} cards`)
        }
      } catch (err) {
        console.log(`[cards:pkm] direct set.name retry failed: ${err.message}`)
      }
    }

    // Also flag if the query itself matches a known JP exclusive set
    const queryIsJp = JP_EXCLUSIVE_SETS.some((jp) => sanitized.toLowerCase().includes(jp))
    const jpExclusive = queryIsJp || cards.some((c) => c.jpExclusive) || sets.some((s) => isJpExclusiveSet(s.set))

    // Sets go at the top, then card results
    return { cards: [...sets, ...cards], jpExclusive }
  })
}

// ─── MTG / SCRYFALL ──────────────────────────────────────────────────────────
async function searchMtg(query) {
  return withCache(`mtg:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(sanitized)}&unique=prints&order=released&dir=desc`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data = await res.json()

    return (data.data || []).slice(0, 8).map((card) => ({
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

// ─── GENERAL EBAY FALLBACK ────────────────────────────────────────────────────
// When official card databases return nothing, search eBay active listings
// and extract card suggestions from listing titles. Works for any card game.
const LISTING_NOISE_RE = /\b(psa|bgs|cgc|sgc|beckett)\s*\d+[\d.]*/gi
const LISTING_JUNK_RE = /\b(lot|bundle|collection|complete set|booster|pack|box|sealed|\d+\s*cards?|\dx|\bx\d+|buy \d|bogo|get \d free)\b/i
const CARD_NUM_GENERAL_RE = /\b((?:[A-Z]{1,4}-?\d+-\d+[A-Z]?)|(?:\d{1,3}\/\d{1,3}))\b/

function extractCardFromTitle(title) {
  let name = title
    .replace(LISTING_NOISE_RE, '')
    .replace(/\bnear\s*mint\b|\bnm\b|\bmp\b|\blp\b|\bhp\b|\bgd\b/gi, '')
    .replace(/\bfoil\b|\bholo\b|\balt\s*art\b|\bfull\s*art\b/gi, '')
    .replace(/\bsingle\b|\btrading\b|\bcard\s*game\b/gi, '')
    .replace(/\benglish\b|\bjapanese\b|\bkorean\b|\bchinese\b/gi, '')
    .replace(/[[\]()|#]/g, ' ')
    .replace(/\s*[-–—]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  const numMatch = name.match(CARD_NUM_GENERAL_RE)
  const number = numMatch ? numMatch[1] : ''
  if (number) name = name.replace(number, '').trim()

  name = name.replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, '').trim()
  // Title-case
  name = name.replace(/\b\w/g, (c) => c.toUpperCase())

  return { name, number }
}

async function searchEbayFallback(query) {
  return withCache(`ebay-fallback:${query.toLowerCase()}`, async () => {
    const token = await getEbayToken()
    const sanitized = sanitizeQuery(query)
    const q = `${sanitized} card`
    console.log(`[cards:fallback] searching eBay active listings: "${q}"`)
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=buyingOptions:{AUCTION|FIXED_PRICE}&sort=newlyListed&limit=40`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) {
      console.error(`[cards:fallback] eBay search error: ${res.status}`)
      return []
    }
    const data = await res.json()
    const items = data.itemSummaries || []
    console.log(`[cards:fallback] eBay returned ${items.length} active listings`)

    const seen = new Set()
    const cards = []
    for (const item of items) {
      const title = item.title || ''
      if (LISTING_JUNK_RE.test(title)) continue

      const { name, number } = extractCardFromTitle(title)
      if (!name || name.length < 3) continue

      const dedupeKey = number ? number.toLowerCase() : name.toLowerCase().slice(0, 30)
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      cards.push({
        id: `ebay-fb-${item.itemId}`,
        name,
        set: number ? number.replace(/-\d+[A-Z]?$/, '') : '',
        number,
        rarity: '',
        game: 'ebay',
        imageUrl: item.image?.imageUrl || null,
        largeImageUrl: item.image?.imageUrl || null,
        searchQuery: number ? `${name} ${number}` : name,
        viaEbay: true,
      })
      if (cards.length >= 5) break
    }
    console.log(`[cards:fallback] extracted ${cards.length} unique cards`)
    return cards
  })
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

// ─── DBS VIA EBAY ACTIVE LISTINGS ────────────────────────────────────────────
// Search eBay active listings, extract unique card identities from titles,
// and return them as autocomplete suggestions with images.
const DBS_NUM_RE = /\b((?:BT|FB|SD|ST|D-BT|P-)\d+-\d+[A-Z]?)\b/i
const DBS_RARITY_RE = /\b(SCR|SPR|SR|SIR|SSR|SEC|UR|RR|UC|CHR|AR|R|C)\b/
const JUNK_RE = /\b(lot|bundle|collection|complete set|booster|pack|box|sealed|\d+\s*cards?|\dx|\bx\d+)\b/i

function extractDbsCard(title) {
  const numMatch = title.match(DBS_NUM_RE)
  const number = numMatch ? numMatch[1].toUpperCase() : ''
  const set = number ? number.replace(/-\d+[A-Z]?$/, '') : ''

  // Extract rarity
  const rarityMatch = title.match(DBS_RARITY_RE)
  const rarity = rarityMatch ? rarityMatch[1].toUpperCase() : ''

  // Extract card name: strip noise from the title
  let name = title
    .replace(/\bdragon\s*ball\s*(super\s*)?(card\s*game|tcg|dbscg)?\b/gi, '')
    .replace(/\bfusion\s*world\b/gi, '')
    .replace(/\bdbs\b/gi, '')
    .replace(DBS_NUM_RE, '')
    .replace(DBS_RARITY_RE, '')
    .replace(/\bpsa\s*\d+\b/gi, '')
    .replace(/\bbgs\s*[\d.]+\b/gi, '')
    .replace(/\bcgc\s*[\d.]+\b/gi, '')
    .replace(/\bnear\s*mint\b|\bnm\b|\bmp\b|\blp\b|\bhp\b|\bgd\b/gi, '')
    .replace(/\bfoil\b|\bholo\b|\balt\s*art\b|\bfull\s*art\b/gi, '')
    .replace(/\bcard\b|\bsingle\b|\btrading\b|\bgame\b/gi, '')
    .replace(/\benglish\b|\bjapanese\b/gi, '')
    .replace(/[[\]()|#]/g, ' ')
    .replace(/\s*[-–—]\s*$/g, '') // trailing dashes
    .replace(/\s{2,}/g, ' ')
    .trim()

  // Clean leading/trailing punctuation
  name = name.replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, '').trim()

  // Title-case
  name = name.replace(/\b\w/g, (c) => c.toUpperCase())

  return { name, number, set, rarity }
}

async function searchDbsEbay(query) {
  return withCache(`dbs-ebay:${query.toLowerCase()}`, async () => {
    const token = await getEbayToken()
    const sanitized = sanitizeQuery(query)
    const q = `${sanitized} dragon ball card`
    console.log(`[cards:dbs] searching eBay active listings: "${q}"`)
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=buyingOptions:{AUCTION|FIXED_PRICE}&sort=newlyListed&limit=40`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) {
      console.error(`[cards:dbs] eBay search error: ${res.status}`)
      return []
    }
    const data = await res.json()
    const items = data.itemSummaries || []
    console.log(`[cards:dbs] eBay returned ${items.length} active listings`)

    // Extract unique cards from listing titles
    const seen = new Set()
    const cards = []
    for (const item of items) {
      const title = item.title || ''
      if (JUNK_RE.test(title)) continue

      const { name, number, set, rarity } = extractDbsCard(title)
      if (!name || name.length < 3) continue

      // Deduplicate by card number (best) or lowercase name
      const dedupeKey = number ? number.toLowerCase() : name.toLowerCase()
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      cards.push({
        id: `dbs-ebay-${item.itemId}`,
        name,
        set,
        number,
        rarity,
        game: 'dbs',
        imageUrl: item.image?.imageUrl || null,
        largeImageUrl: item.image?.imageUrl || null,
        searchQuery: buildDbsQuery({ name, number, rarity }),
      })
      if (cards.length >= 8) break
    }

    console.log(`[cards:dbs] extracted ${cards.length} unique cards from listings`)
    return cards
  })
}

// ─── DBS HARDCODED FALLBACK (top 200 popular cards) ─────────────────────────
const DBS_POPULAR = [
  { name: 'Son Goku, The Awakened Power', number: 'BT1-059', rarity: 'SPR' },
  { name: 'Vegito, Path to Greatness', number: 'BT20-138', rarity: 'SCR' },
  { name: 'Super Saiyan God Son Goku', number: 'BT1-032', rarity: 'SR' },
  { name: 'Gogeta, Hero Revived', number: 'BT5-038', rarity: 'SPR' },
  { name: 'Frieza, Emperor of Universe 7', number: 'BT9-002', rarity: 'SR' },
  { name: 'Cell, Android Evolved', number: 'BT17-049', rarity: 'SPR' },
  { name: 'Broly, The Legendary Super Saiyan', number: 'BT1-057', rarity: 'SR' },
  { name: 'Vegeta, Prince of Destruction', number: 'BT15-065', rarity: 'SCR' },
  { name: 'Gohan, Potential Unleashed', number: 'BT3-033', rarity: 'SPR' },
  { name: 'Piccolo, Fused with Kami', number: 'BT16-079', rarity: 'SR' },
  { name: 'Trunks, Bridge to the Future', number: 'BT3-062', rarity: 'SPR' },
  { name: 'Beerus, God of Destruction', number: 'BT1-029', rarity: 'SR' },
  { name: 'Bardock, Will of Iron', number: 'BT3-083', rarity: 'SR' },
  { name: 'Android 17, Protector of Wildlife', number: 'BT14-068', rarity: 'SR' },
  { name: 'Hit, Time Skip Strike', number: 'BT4-100', rarity: 'SPR' },
  { name: 'Kefla, Surge of Energy', number: 'BT7-080', rarity: 'SPR' },
  { name: 'Majin Buu, Infinite Multiplication', number: 'BT6-041', rarity: 'SR' },
  { name: 'Gogeta BR', number: 'FB01-139', rarity: 'SCR' },
  { name: 'Son Goku, Ultra Instinct Sign', number: 'BT9-026', rarity: 'SCR' },
  { name: 'Vegito, Unison of Might', number: 'BT10-002', rarity: 'SPR' },
  { name: 'Son Goku, Path to Greatness', number: 'BT6-005', rarity: 'SPR' },
  { name: 'Super Saiyan Vegeta', number: 'BT1-056', rarity: 'SR' },
  { name: 'Gotenks, Display of Might', number: 'BT11-002', rarity: 'SPR' },
  { name: 'Jiren, Fist of Justice', number: 'BT5-047', rarity: 'SPR' },
  { name: 'Whis, The Advisor', number: 'BT1-044', rarity: 'SR' },
  { name: 'Android 18, Graceful Warrior', number: 'BT13-069', rarity: 'SPR' },
  { name: 'Cooler, Galactic Dynasty', number: 'BT17-059', rarity: 'SCR' },
  { name: 'Zamasu, The Invincible', number: 'BT2-056', rarity: 'SR' },
  { name: 'Tien Shinhan, Tri-Beam Master', number: 'BT12-086', rarity: 'SR' },
  { name: 'Caulifla, Daring Fighter', number: 'BT7-079', rarity: 'SR' },
  { name: 'Super 17, Hell\'s Storm', number: 'BT14-129', rarity: 'SCR' },
  { name: 'Son Goku, Strength of Legends', number: 'FB01-001', rarity: 'SR' },
  { name: 'Vegeta, Saiyan Prince', number: 'FB01-028', rarity: 'SR' },
  { name: 'Frieza, Galactic Tyrant', number: 'FB01-077', rarity: 'SR' },
  { name: 'Gohan, Hidden Potential', number: 'FB01-049', rarity: 'SR' },
  { name: 'Piccolo, Namekian Guardian', number: 'FB01-058', rarity: 'SR' },
  { name: 'Trunks, Hope of the Future', number: 'FB01-036', rarity: 'SR' },
  { name: 'Broly, Unstoppable Rage', number: 'FB01-091', rarity: 'SCR' },
  { name: 'Cell, Ultimate Lifeform', number: 'FB01-083', rarity: 'SR' },
  { name: 'Beerus, Universe 7 Destroyer', number: 'FB01-067', rarity: 'SR' },
  { name: 'Goku Black, Dark Overload', number: 'BT3-051', rarity: 'SPR' },
  { name: 'Krillin, Trusty Aid', number: 'BT18-011', rarity: 'SR' },
  { name: 'Yamcha, Merciless Striker', number: 'BT19-076', rarity: 'SR' },
  { name: 'Videl, Supporting Fighter', number: 'BT18-081', rarity: 'SR' },
  { name: 'Pan, Ready to Fight', number: 'BT18-047', rarity: 'SR' },
  { name: 'Android 21, Scholarly Scientist', number: 'BT20-025', rarity: 'SPR' },
  { name: 'Son Goku, Explosion of Power', number: 'FB02-001', rarity: 'SR' },
  { name: 'Vegeta, Beyond Limits', number: 'FB02-028', rarity: 'SCR' },
  { name: 'Gogeta, Fusion Reborn', number: 'FB02-139', rarity: 'SCR' },
  { name: 'Frieza, True Golden Form', number: 'FB02-077', rarity: 'SR' },
  { name: 'Son Gohan, Beast Unleashed', number: 'FB02-049', rarity: 'SCR' },
  { name: 'Piccolo, Orange Form', number: 'FB02-058', rarity: 'SR' },
  { name: 'Broly, Full Power', number: 'FB02-091', rarity: 'SR' },
  { name: 'Cell Max, Destructive Force', number: 'FB02-083', rarity: 'SR' },
  { name: 'Gamma 1, Red Warrior', number: 'FB02-034', rarity: 'SR' },
  { name: 'Gamma 2, Blue Warrior', number: 'FB02-035', rarity: 'SR' },
  { name: 'Super Saiyan 4 Gogeta', number: 'BT11-001', rarity: 'SCR' },
  { name: 'SSB Vegito, Unison Warrior', number: 'BT10-003', rarity: 'SCR' },
  { name: 'Janemba, Agent of Destruction', number: 'BT5-086', rarity: 'SPR' },
  { name: 'Turles, Crusher Corps Commander', number: 'BT15-111', rarity: 'SR' },
  { name: 'Raditz, Saiyan Invader', number: 'BT18-053', rarity: 'SR' },
  { name: 'Nappa, Saiyan Warrior', number: 'BT18-051', rarity: 'SR' },
  { name: 'Dabura, Dark Demon', number: 'BT19-091', rarity: 'SR' },
  { name: 'Babidi, Dark Magician', number: 'BT11-078', rarity: 'SR' },
  { name: 'Toppo, God of Destruction Candidate', number: 'BT9-045', rarity: 'SR' },
  { name: 'Dyspo, Lightspeed Warrior', number: 'BT9-044', rarity: 'SR' },
  { name: 'Android 13, Fused Force', number: 'BT13-094', rarity: 'SPR' },
  { name: 'Champa, Universe 6 Destroyer', number: 'BT7-077', rarity: 'SR' },
  { name: 'Vados, Angelic Support', number: 'BT7-078', rarity: 'SR' },
  { name: 'Cabba, Saiyan Pride', number: 'BT7-081', rarity: 'SR' },
  { name: 'Son Goku, Hero of Earth', number: 'FB03-001', rarity: 'SR' },
  { name: 'Vegeta, Royal Pride', number: 'FB03-028', rarity: 'SCR' },
  { name: 'Gogeta, Beyond Fusion', number: 'FB03-139', rarity: 'SCR' },
  { name: 'Frieza, Final Form', number: 'FB03-077', rarity: 'SR' },
  { name: 'Gohan, Father-Son Kamehameha', number: 'FB03-049', rarity: 'SR' },
  { name: 'Piccolo, Special Beam Cannon', number: 'FB03-058', rarity: 'SR' },
  { name: 'Son Goku, Mastered Ultra Instinct', number: 'BT7-077', rarity: 'SCR' },
  { name: 'Vegito, Absolute Annihilation', number: 'BT4-003', rarity: 'SPR' },
  { name: 'Gogeta, Display of Power', number: 'BT12-136', rarity: 'SCR' },
  { name: 'Son Goku, Spirit Bomb', number: 'BT8-108', rarity: 'SPR' },
  { name: 'Cell, Return of the Terror', number: 'BT9-073', rarity: 'SPR' },
  { name: 'Vegeta, Determined to Fight', number: 'BT18-028', rarity: 'SR' },
  { name: 'Goku & Vegeta, Saiyan Bond', number: 'FB09-121', rarity: 'SCR' },
  { name: 'Gotenks, Fusion Warrior', number: 'BT2-015', rarity: 'SR' },
  { name: 'Android 16, Gentle Giant', number: 'BT2-091', rarity: 'SR' },
  { name: 'Captain Ginyu, Ginyu Force', number: 'BT1-085', rarity: 'SR' },
  { name: 'Majin Vegeta, Prideful Warrior', number: 'BT4-030', rarity: 'SPR' },
  { name: 'Kid Buu, Infinite Terror', number: 'BT6-042', rarity: 'SPR' },
  { name: 'Super Saiyan 3 Goku', number: 'BT4-005', rarity: 'SPR' },
  { name: 'Syn Shenron, Shadow Dragon', number: 'BT11-109', rarity: 'SPR' },
  { name: 'Omega Shenron, Extreme Malice', number: 'BT11-110', rarity: 'SCR' },
  { name: 'Pan, Granddaughter of Goku', number: 'BT11-014', rarity: 'SR' },
  { name: 'Giru, Machine Mutant', number: 'BT11-016', rarity: 'SR' },
  { name: 'Uub, Potential Awakened', number: 'BT11-018', rarity: 'SR' },
  { name: 'Great Ape Vegeta', number: 'BT3-093', rarity: 'SR' },
  { name: 'Great Ape Bardock', number: 'BT3-084', rarity: 'SPR' },
  { name: 'Golden Frieza, Resurrected Terror', number: 'BT1-086', rarity: 'SPR' },
  { name: 'Mecha Frieza, Rebuilt', number: 'BT2-103', rarity: 'SR' },
  { name: 'King Cold, Father of the Emperor', number: 'BT2-104', rarity: 'SR' },
  { name: 'Sorbet, Frieza\'s Loyal Subject', number: 'BT1-088', rarity: 'SR' },
]

function searchDbsFallback(query) {
  const sanitized = sanitizeQuery(query)
  const ql = sanitized.toLowerCase()
  const terms = ql.split(/\s+/)
  return DBS_POPULAR.filter((card) => {
    const hay = `${card.name} ${card.number} ${card.rarity}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  }).slice(0, 8).map((card) => ({
    id: `dbs-fb-${card.number}`,
    name: card.name,
    set: card.number.replace(/-\d+[A-Z]?$/, ''),
    number: card.number,
    rarity: card.rarity,
    game: 'dbs',
    imageUrl: null,
    largeImageUrl: null,
    searchQuery: buildDbsQuery(card),
  }))
}

async function searchDbs(query) {
  // Primary: search eBay active listings with full query
  try {
    const ebayResults = await searchDbsEbay(query)
    if (ebayResults.length > 0) return ebayResults
  } catch (err) {
    console.log(`[cards:dbs] eBay active listing search failed: ${err.message}`)
  }

  // Retry: try individual key words from the query (longest first)
  // "god kamehameha" → try "kamehameha", then "god"
  const words = sanitizeQuery(query).split(/\s+/).filter((w) => w.length >= 3)
  if (words.length > 1) {
    const sorted = [...words].sort((a, b) => b.length - a.length)
    for (const word of sorted) {
      console.log(`[cards:dbs] retrying broader search with: "${word}"`)
      try {
        const retry = await searchDbsEbay(word)
        if (retry.length > 0) return retry
      } catch (_) { /* continue */ }
      // Also try hardcoded fallback with the single word
      const fbRetry = searchDbsFallback(word)
      if (fbRetry.length > 0) return fbRetry
    }
  }

  // Final fallback: hardcoded popular cards dictionary with full query
  console.log('[cards:dbs] falling back to hardcoded dictionary')
  return searchDbsFallback(query)
}

// ─── PRE-WARM CACHE (cold start) ─────────────────────────────────────────────
// Fire-and-forget: pre-fetch the 10 most popular Pokemon names so the first
// user search for any of these is instant (served from the withCache Map).
const PRE_WARM_QUERIES = [
  'charizard', 'pikachu', 'mewtwo', 'eevee', 'gengar',
  'blastoise', 'venusaur', 'rayquaza', 'lugia', 'ho-oh',
]
let _preWarmed = false
function preWarmCache() {
  if (_preWarmed) return
  _preWarmed = true
  console.log('[cards] pre-warming Pokemon cache for top 10 cards')
  for (const q of PRE_WARM_QUERIES) {
    searchPokemon(q).catch((err) => console.log(`[cards] pre-warm ${q} failed: ${err.message}`))
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  preWarmCache() // fire once on first request
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
    name: `Search eBay directly for '${query}'`,
    set: '', number: '', rarity: '',
    game: 'direct',
    imageUrl: null, largeImageUrl: null,
    searchQuery: query,
    isDirect: true,
  }

  let cards = []
  let attribution = null
  let jpExclusive = false

  if (game === 'pokemon') {
    try {
      const result = await searchPokemon(query)
      cards = result.cards || []
      jpExclusive = result.jpExclusive || false
      console.log('[cards] pokemon results:', cards.length, jpExclusive ? '(JP exclusive)' : '')
    } catch (err) {
      console.error('[cards] pokemon error:', err.message)
    }
    if (cards.length) attribution = 'pokemontcg.io'
  } else if (game === 'mtg') {
    try {
      cards = await searchMtg(query)
      console.log('[cards] mtg results:', cards.length)
    } catch (err) {
      console.error('[cards] mtg error:', err.message)
    }
    if (cards.length) attribution = 'Scryfall'
  } else if (game === 'dbs') {
    try {
      cards = await searchDbs(query)
      console.log('[cards] dbs results:', cards.length)
    } catch (err) {
      console.error('[cards] dbs error:', err.message)
    }
    if (cards.length) attribution = 'eBay listings'
  } else {
    // Unknown game — try Pokemon and MTG in parallel
    const [pkm, mtg] = await Promise.allSettled([searchPokemon(query), searchMtg(query)])
    if (pkm.status === 'fulfilled') {
      const result = pkm.value
      cards.push(...(result.cards || []))
      if (result.jpExclusive) jpExclusive = true
      console.log('[cards] unknown/pkm:', (result.cards || []).length)
    } else {
      console.error('[cards] unknown/pkm error:', pkm.reason?.message)
    }
    if (mtg.status === 'fulfilled') { cards.push(...mtg.value); console.log('[cards] unknown/mtg:', mtg.value.length) }
    else console.error('[cards] unknown/mtg error:', mtg.reason?.message)

    if (cards.length) attribution = 'pokemontcg.io & Scryfall'
  }

  // General eBay fallback — when official databases return nothing and query is 3+ words
  if (!cards.length && query.split(/\s+/).length >= 3) {
    console.log('[cards] no catalog results, trying eBay fallback')
    try {
      cards = await searchEbayFallback(query)
      if (cards.length) attribution = 'eBay listings'
    } catch (err) {
      console.error('[cards] eBay fallback error:', err.message)
    }
  }

  return res.status(200).json({ cards: cards.slice(0, 8), ebayDirect, game, attribution, jpExclusive })
}
