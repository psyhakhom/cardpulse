/**
 * GET /api/cards?q={query}
 *
 * Card catalog autocomplete endpoint. Returns up to 8 matching cards from:
 *   - pokemontcg.io  (Pokemon)
 *   - Scryfall       (MTG)
 *   - YGOProDeck     (Yu-Gi-Oh)
 *   - OPTCG GitHub   (One Piece)
 *   - DBS site + community JSON fallback (Dragon Ball Super)
 *   - Lorcana API    (Disney Lorcana)
 *   - eBay fallback  (anything else)
 * Plus an "eBay direct" fallback option always included.
 *
 * All responses are in-memory cached for 1 hour per query string.
 * Env vars: POKEMON_TCG_API_KEY (optional — unlocks higher rate limit)
 */

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const cache = new Map()
const CACHE_TTL = 60 * 60 * 1000 // 1 hour
const CACHE_MAX = 200 // max entries before forced eviction

async function withCache(key, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() < hit.expires) return hit.data
  // Evict expired entries when cache is large
  if (cache.size > CACHE_MAX) {
    const now = Date.now()
    for (const [k, v] of cache) { if (now >= v.expires) cache.delete(k) }
    // If still over limit, drop oldest half
    if (cache.size > CACHE_MAX) {
      const keys = [...cache.keys()]
      for (let i = 0; i < keys.length / 2; i++) cache.delete(keys[i])
    }
  }
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
  'ash', 'misty', 'brock', 'team rocket', 'jessie', 'james', 'giovanni',
  'gary', 'professor oak', 'nurse joy', 'gym leader', 'elite four', 'trainer',
]
const MTG_KW = ['mtg', 'magic the gathering', 'magic:', 'planeswalker', 'mana ']
const YGO_KW = [
  'yugioh', 'yu-gi-oh', 'yu gi oh', 'blue-eyes', 'blue eyes', 'dark magician',
  'exodia', 'red-eyes', 'red eyes', 'kuriboh', 'pot of greed', 'raigeki',
  'mirror force', 'monster reborn', 'polymerization', 'stardust dragon',
  'cyber dragon', 'utopia', 'number 39', 'elemental hero',
]
const DBS_KW = [
  'dragon ball', 'dragonball', 'dbs', 'fusion world', 'goku', 'vegeta',
  'vegito', 'gogeta', 'frieza', 'gohan', 'piccolo', 'broly', 'beerus', 'trunks',
  'bardock', 'cell', 'android', 'majin', 'saiyan',
  'kamehameha', 'final flash', 'galick gun', 'spirit bomb', 'instant transmission',
  'hakai', 'ultra instinct', 'god kamehameha', 'destructo disc',
  'special beam cannon', 'makankosappo',
]
const DBS_CODE_RE = /\b(?:BT|FB|SD|ST|D-BT)\d+/i
const OP_KW = [
  'one piece', 'onepiece', 'optcg', 'luffy', 'zoro', 'nami', 'sanji',
  'chopper', 'robin', 'franky', 'brook',
  'op-01', 'op-02', 'op-03', 'op-04', 'op-05', 'op-06', 'op-07',
  'op-08', 'op-09', 'op-10', 'op-11', 'op-12', 'op-13', 'op-14',
  'shanks', 'whitebeard', 'blackbeard', 'hancock', 'mihawk',
  'crocodile', 'doflamingo', 'katakuri', 'kaido', 'big mom', 'yamato', 'uta',
]
const OP_CODE_RE = /\bOP-?\d{2}/i
const LORCANA_KW = ['lorcana', 'disney lorcana']

function detectGame(query) {
  const ql = query.toLowerCase()
  if (POKEMON_KW.some((k) => ql.includes(k))) return 'pokemon'
  if (MTG_KW.some((k) => ql.includes(k))) return 'mtg'
  if (YGO_KW.some((k) => ql.includes(k))) return 'yugioh'
  if (OP_KW.some((k) => ql.includes(k)) || OP_CODE_RE.test(query)) return 'onepiece'
  if (DBS_KW.some((k) => ql.includes(k)) || DBS_CODE_RE.test(query)) return 'dbs'
  if (LORCANA_KW.some((k) => ql.includes(k))) return 'lorcana'
  return null
}

// ─── QUERY SANITIZER ─────────────────────────────────────────────────────────
function sanitizeQuery(query) {
  return query
    .replace(/[:;,!?@#$%^&*()[\]{}|\\<>~`"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── UNIVERSAL QUERY BUILDER ─────────────────────────────────────────────────
// "{card name} {card number} {rarity}" — works across all TCGs on eBay
function buildSearchQuery(name, number, rarity) {
  return [name, number, rarity].filter(Boolean).join(' ').slice(0, 60)
}

// ─── POKEMON-SPECIFIC QUERY BUILDER ─────────────────────────────────────────
function buildPokemonQuery(card) {
  const name = card.name || ''
  const number = card.number || ''
  const total = card.set?.printedTotal || card.set?.total || ''
  const setName = card.set?.name || ''
  const numStr = number && total ? `${number}/${total}` : number
  return [name, numStr, setName].filter(Boolean).join(' ').slice(0, 60)
}

function simplifyDbsName(name) {
  // Only strip colon suffixes for eBay search optimization — keep enough
  // to identify the card. "Son Goku : DA + Evolve" → "Son Goku"
  // but "Kamehameha" stays as "Kamehameha" (no colon to strip)
  let simplified = name
    .replace(/\s*[:+]\s*.*/g, '') // strip from first colon or plus
    .replace(/\s*[-–—]\s*(DA|Evolve|Awakening|Limit Breaker)\b.*/gi, '') // strip only generic descriptors
    .trim()
  return simplified.length >= 3 ? simplified : name
}

// ─── POKEMON TCG API ──────────────────────────────────────────────────────────
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
    const seenIds = new Set()
    let cards = []

    function addCards(rawCards) {
      const mapped = rawCards.map(mapPokemonCard)
      const added = []
      for (const c of mapped) {
        if (!seenIds.has(c.id)) { seenIds.add(c.id); added.push(c) }
      }
      return added
    }

    async function pkmFetch(url) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
      if (!res.ok) return []
      const data = await res.json()
      return data.data || []
    }

    let nameQ
    if (/\bvs\.?\b/i.test(sanitized)) {
      const parts = sanitized.split(/\bvs\.?\b/i).map((s) => s.trim()).filter(Boolean)
      nameQ = parts.map((p) => `name:*${p}*`).join(' ')
    } else {
      nameQ = sanitized.includes(' ') ? `name:"*${sanitized}*"` : `name:${sanitized}*`
    }

    const nameUrl = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(nameQ)}&pageSize=8&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`
    const setsUrl = `https://api.pokemontcg.io/v2/sets?q=name:"*${encodeURIComponent(sanitized)}*"&pageSize=3&orderBy=-releaseDate`

    const [nameRaw, setsRes] = await Promise.allSettled([
      pkmFetch(nameUrl),
      fetch(setsUrl, { headers, signal: AbortSignal.timeout(5000) }),
    ])

    if (nameRaw.status === 'fulfilled') cards.push(...addCards(nameRaw.value))

    if (cards.length < 4) {
      try {
        const subtypeCards = await pkmFetch(`https://api.pokemontcg.io/v2/cards?q=subtypes:"${encodeURIComponent(sanitized)}"&pageSize=4&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`)
        cards.push(...addCards(subtypeCards))
      } catch (_) {}
    }

    if (cards.length < 4) {
      try {
        const setCards = await pkmFetch(`https://api.pokemontcg.io/v2/cards?q=set.name:"*${encodeURIComponent(sanitized)}*"&pageSize=${8 - cards.length}&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`)
        cards.push(...addCards(setCards))
      } catch (_) {}
    }

    if (!cards.length) {
      try {
        const directCards = await pkmFetch(`https://api.pokemontcg.io/v2/cards?q=set.name:"${encodeURIComponent(sanitized)}"&pageSize=8&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`)
        cards.push(...addCards(directCards))
      } catch (_) {}
    }

    const sets = []
    if (setsRes.status === 'fulfilled' && setsRes.value.ok) {
      const data = await setsRes.value.json()
      for (const s of (data.data || [])) {
        sets.push({
          id: `pkm-set-${s.id}`, name: `Browse: ${s.name}`, set: s.name,
          number: `${s.total || '?'} cards`, rarity: s.releaseDate || '',
          game: 'pokemon', imageUrl: s.images?.symbol || null,
          largeImageUrl: s.images?.logo || null,
          searchQuery: `pokemon ${s.name}`, isSet: true,
        })
      }
    }

    const queryIsJp = JP_EXCLUSIVE_SETS.some((jp) => sanitized.toLowerCase().includes(jp))
    const jpExclusive = queryIsJp || cards.some((c) => c.jpExclusive) || sets.some((s) => isJpExclusiveSet(s.set))

    return { cards: [...cards, ...sets], jpExclusive }
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
      searchQuery: buildSearchQuery(card.name, card.collector_number, card.set_name),
    }))
  })
}

// ─── YU-GI-OH / YGOPRODECK ──────────────────────────────────────────────────
async function searchYugioh(query) {
  return withCache(`ygo:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(sanitized)}&num=8&offset=0`
    console.log(`[cards:ygo] fetching: ${sanitized}`)
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.log(`[cards:ygo] API returned ${res.status}`)
      return []
    }
    const data = await res.json()
    if (data.error) { console.log(`[cards:ygo] API error: ${data.error}`); return [] }
    const items = data.data || []
    console.log(`[cards:ygo] got ${items.length} results`)

    return items.slice(0, 8).map((card) => {
      const sets = Array.isArray(card.card_sets) ? card.card_sets : []
      const setInfo = sets[0] || {}
      return {
        id: `ygo-${card.id || Math.random().toString(36).slice(2)}`,
        name: card.name || '',
        set: setInfo.set_name || '',
        number: setInfo.set_code || '',
        rarity: setInfo.set_rarity_code || setInfo.set_rarity || '',
        game: 'yugioh',
        imageUrl: card.card_images?.[0]?.image_url_small || null,
        largeImageUrl: card.card_images?.[0]?.image_url || null,
        searchQuery: buildSearchQuery(card.name, setInfo.set_code, ''),
      }
    })
  })
}

// ─── ONE PIECE / OPTCG GITHUB DATA ──────────────────────────────────────────
let opCardData = null
let opDataLoading = null
let opLoadFailedAt = 0

async function loadOpData() {
  if (opCardData) return opCardData
  if (opDataLoading) return opDataLoading
  // Backoff: don't retry within 60s of a failure
  if (opLoadFailedAt && Date.now() - opLoadFailedAt < 60000) return null

  opDataLoading = (async () => {
    console.log('[cards:op] loading OPTCG card data from GitHub...')
    try {
      const res = await fetch('https://raw.githubusercontent.com/danielisonp/optcg/main/cards.json', {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`GitHub ${res.status}`)
      opCardData = await res.json()
      console.log(`[cards:op] loaded ${Array.isArray(opCardData) ? opCardData.length : 'unknown'} cards`)
      opDataLoading = null
      return opCardData
    } catch (err) {
      console.error(`[cards:op] failed to load card data: ${err.message}`)
      opLoadFailedAt = Date.now()
      opDataLoading = null
      return null
    }
  })()
  return opDataLoading
}

async function searchOnePiece(query) {
  return withCache(`op:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const terms = sanitized.toLowerCase().split(/\s+/)
    const data = await loadOpData()

    if (data && Array.isArray(data)) {
      const results = data.filter((card) => {
        const hay = `${card.name || ''} ${card.id || ''} ${card.number || ''} ${card.type || ''}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      }).slice(0, 8)

      if (results.length > 0) {
        return results.map((card) => ({
          id: `op-${card.id || card.number || Date.now()}`,
          name: card.name || '',
          set: (card.number || card.id || '').replace(/-\d+$/, ''),
          number: card.number || card.id || '',
          rarity: card.rarity || '',
          game: 'onepiece',
          imageUrl: card.image || card.imageUrl || null,
          largeImageUrl: card.image || card.imageUrl || null,
          searchQuery: buildSearchQuery(card.name, card.number || card.id, card.rarity),
        }))
      }
    }

    // Fallback: try the official site
    try {
      const url = `https://en.onepiece-cardgame.com/cardlist/?search=true&freewords=${encodeURIComponent(sanitized)}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'CardPulse/1.0' },
        signal: AbortSignal.timeout(6000),
      })
      if (res.ok) {
        const html = await res.text()
        const cards = []
        const cardRe = /<a[^>]*class="[^"]*modalCol[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
        let match
        while ((match = cardRe.exec(html)) !== null && cards.length < 8) {
          const block = match[1]
          const imgMatch = block.match(/<img[^>]+src="([^"]+)"/)
          const nameMatch = block.match(/cardName[^>]*>([^<]+)/) || block.match(/<div[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)/)
          const numMatch = block.match(/((?:OP|ST|EB)\d+-\d+)/i)
          if (!nameMatch) continue
          const name = nameMatch[1].trim()
          const number = numMatch ? numMatch[1].toUpperCase() : ''
          let imageUrl = imgMatch ? imgMatch[1].trim() : null
          if (imageUrl && imageUrl.startsWith('/')) imageUrl = `https://en.onepiece-cardgame.com${imageUrl}`
          cards.push({
            id: `op-site-${number || cards.length}`, name,
            set: number ? number.replace(/-\d+$/, '') : '', number,
            rarity: '', game: 'onepiece',
            imageUrl, largeImageUrl: imageUrl,
            searchQuery: buildSearchQuery(name, number, ''),
          })
        }
        if (cards.length > 0) return cards
      }
    } catch (err) {
      console.log(`[cards:op] site fallback failed: ${err.message}`)
    }

    return []
  })
}

// ─── DRAGON BALL SUPER ───────────────────────────────────────────────────────
let dbsCardData = null
let dbsDataLoading = null
let dbsLoadFailedAt = 0

async function loadDbsData() {
  if (dbsCardData) return dbsCardData
  if (dbsDataLoading) return dbsDataLoading
  if (dbsLoadFailedAt && Date.now() - dbsLoadFailedAt < 60000) return null

  dbsDataLoading = (async () => {
    console.log('[cards:dbs] loading DBS card data from GitHub...')
    try {
      const res = await fetch('https://raw.githubusercontent.com/boffinism/dbs-card-list/main/cards.json', {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`GitHub ${res.status}`)
      dbsCardData = await res.json()
      console.log(`[cards:dbs] loaded ${Array.isArray(dbsCardData) ? dbsCardData.length : 'unknown'} cards`)
      dbsDataLoading = null
      return dbsCardData
    } catch (err) {
      console.error(`[cards:dbs] failed to load card data: ${err.message}`)
      dbsLoadFailedAt = Date.now()
      dbsDataLoading = null
      return null
    }
  })()
  return dbsDataLoading
}

const DBS_NUM_RE = /\b((?:BT|FB|SD|ST|D-BT|P-)\d+-\d+[A-Z]?)\b/i

async function searchDbsSite(query) {
  const sanitized = sanitizeQuery(query)
  const url = `https://www.dbs-cardgame.com/us-en/cardlist/?search=true&keyword=${encodeURIComponent(sanitized)}`
  console.log(`[cards:dbs] fetching DBS site: "${sanitized}"`)
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CardPulse/1.0' },
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) throw new Error(`DBS site ${res.status}`)
  const html = await res.text()

  const cards = []
  const cardBlockRe = /<li[^>]*class="[^"]*list-inner[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let match
  while ((match = cardBlockRe.exec(html)) !== null && cards.length < 8) {
    const block = match[1]
    const imgMatch = block.match(/<img[^>]+src="([^"]+)"/)
    const nameMatch = block.match(/cardName[^>]*>([^<]+)/) || block.match(/<dt[^>]*>([^<]{3,})<\/dt>/)
    const numMatch = block.match(/cardNumber[^>]*>([^<]+)/) || block.match(/((?:BT|FB|SD|ST|D-BT)\d+-\d+[A-Z]?)/)
    const rarityMatch = block.match(/cardRarity[^>]*>([^<]+)/) || block.match(/rarity[^>]*>([^<]+)/i)
    if (!nameMatch) continue
    const name = nameMatch[1].trim()
    const number = numMatch ? numMatch[1].trim().toUpperCase() : ''
    const rarity = rarityMatch ? rarityMatch[1].trim() : ''
    let imageUrl = imgMatch ? imgMatch[1].trim() : null
    if (imageUrl && imageUrl.startsWith('/')) imageUrl = `https://www.dbs-cardgame.com${imageUrl}`
    cards.push({
      id: `dbs-site-${number || cards.length}`, name,
      set: number ? number.replace(/-\d+[A-Z]?$/, '') : '', number, rarity,
      game: 'dbs', imageUrl, largeImageUrl: imageUrl,
      searchQuery: buildSearchQuery(simplifyDbsName(name), number, rarity),
    })
  }
  return cards
}

async function searchDbs(query) {
  return withCache(`dbs:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const terms = sanitized.toLowerCase().split(/\s+/)

    // Try official DBS site first
    try {
      const siteResults = await searchDbsSite(query)
      if (siteResults.length > 0) {
        console.log(`[cards:dbs] site returned ${siteResults.length} results`)
        return siteResults
      }
    } catch (err) {
      console.log(`[cards:dbs] site failed: ${err.message}`)
    }

    // Try community JSON data
    const data = await loadDbsData()
    if (data && Array.isArray(data)) {
      const results = data.filter((card) => {
        const hay = `${card.name || ''} ${card.number || ''} ${card.cardNumber || ''} ${card.rarity || ''}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      }).slice(0, 8)

      if (results.length > 0) {
        console.log(`[cards:dbs] GitHub data matched ${results.length} cards`)
        return results.map((card) => {
          const num = card.number || card.cardNumber || ''
          return {
            id: `dbs-gh-${num || Date.now()}`,
            name: card.name || '',
            set: num ? num.replace(/-\d+[A-Z]?$/, '') : '',
            number: num,
            rarity: card.rarity || '',
            game: 'dbs',
            imageUrl: card.image || card.imageUrl || null,
            largeImageUrl: card.image || card.imageUrl || null,
            searchQuery: buildSearchQuery(simplifyDbsName(card.name || ''), num, card.rarity),
          }
        })
      }
    }

    // Hardcoded popular cards fallback
    const fbResults = searchDbsFallback(query)
    if (fbResults.length > 0) return fbResults

    // Retry with individual words — only for short queries (2 words) without
    // a specific card number. For 3+ word queries like "SS Broly Banisher Fury",
    // the user is searching for a specific card — returning a generic "Broly" match
    // is worse than falling through to the eBay fallback.
    const queryHasCardNum = DBS_NUM_RE.test(sanitized)
    const words = sanitized.split(/\s+/).filter((w) => w.length >= 3)
    if (!queryHasCardNum && words.length === 2) {
      const sorted = [...words].sort((a, b) => b.length - a.length)
      for (const word of sorted) {
        console.log(`[cards:dbs] retrying with single word: "${word}"`)
        if (data && Array.isArray(data)) {
          const retry = data.filter((card) => {
            const hay = `${card.name || ''} ${card.number || ''} ${card.cardNumber || ''} ${card.rarity || ''}`.toLowerCase()
            return hay.includes(word.toLowerCase())
          }).slice(0, 8)
          if (retry.length > 0) {
            return retry.map((card) => {
              const num = card.number || card.cardNumber || ''
              return {
                id: `dbs-gh-${num || Date.now()}`,
                name: card.name || '',
                set: num ? num.replace(/-\d+[A-Z]?$/, '') : '',
                number: num, rarity: card.rarity || '', game: 'dbs',
                imageUrl: card.image || card.imageUrl || null,
                largeImageUrl: card.image || card.imageUrl || null,
                searchQuery: buildSearchQuery(simplifyDbsName(card.name || ''), num, card.rarity),
              }
            })
          }
        }
        const fbRetry = searchDbsFallback(word)
        if (fbRetry.length > 0) return fbRetry
      }
    }

    // For 3+ word queries that reached here, return empty so eBay fallback triggers
    if (words.length >= 3) {
      console.log(`[cards:dbs] specific query "${sanitized}" not in database, deferring to eBay fallback`)
    }
    return []
  })
}

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
  { name: 'Gogeta BR', number: 'FB01-139', rarity: 'SCR' },
  { name: 'Son Goku, Ultra Instinct Sign', number: 'BT9-026', rarity: 'SCR' },
  { name: 'Son Goku, Strength of Legends', number: 'FB01-001', rarity: 'SR' },
  { name: 'Vegeta, Saiyan Prince', number: 'FB01-028', rarity: 'SR' },
  { name: 'Broly, Unstoppable Rage', number: 'FB01-091', rarity: 'SCR' },
  { name: 'Gogeta, Fusion Reborn', number: 'FB02-139', rarity: 'SCR' },
  { name: 'Vegeta, Beyond Limits', number: 'FB02-028', rarity: 'SCR' },
  { name: 'Son Gohan, Beast Unleashed', number: 'FB02-049', rarity: 'SCR' },
  { name: 'Goku & Vegeta, Saiyan Bond', number: 'FB09-121', rarity: 'SCR' },
  { name: 'Super Saiyan 4 Gogeta', number: 'BT11-001', rarity: 'SCR' },
  { name: 'Omega Shenron, Extreme Malice', number: 'BT11-110', rarity: 'SCR' },
  { name: 'Cooler, Galactic Dynasty', number: 'BT17-059', rarity: 'SCR' },
  { name: 'Son Goku, Mastered Ultra Instinct', number: 'BT7-077', rarity: 'SCR' },
  { name: 'Gogeta, Display of Power', number: 'BT12-136', rarity: 'SCR' },
  { name: 'Gogeta, Beyond Fusion', number: 'FB03-139', rarity: 'SCR' },
  { name: 'Vegeta, Royal Pride', number: 'FB03-028', rarity: 'SCR' },
]

function searchDbsFallback(query) {
  const sanitized = sanitizeQuery(query)
  const terms = sanitized.toLowerCase().split(/\s+/)
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
    searchQuery: buildSearchQuery(simplifyDbsName(card.name), card.number, card.rarity),
  }))
}

// ─── LORCANA ─────────────────────────────────────────────────────────────────
async function searchLorcana(query) {
  return withCache(`lor:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const url = `https://api.lorcana-api.com/cards/fetch?search=Name%20LIKE%20${encodeURIComponent(sanitized)}&limit=8`
    console.log(`[cards:lor] fetching: ${sanitized}`)
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.log(`[cards:lor] API returned ${res.status}`)
      return []
    }
    const data = await res.json()
    if (data.error) { console.log(`[cards:lor] API error: ${data.error}`); return [] }
    const items = Array.isArray(data) ? data : (data.data || data.cards || [])
    if (!items.length) return []
    console.log(`[cards:lor] got ${items.length} results`)

    return items.slice(0, 8).map((card) => ({
      id: `lor-${card.id || card.Name || Math.random().toString(36).slice(2)}`,
      name: card.Name || card.name || '',
      set: card.Set_Name || card.set || '',
      number: card.Card_Num || card.number || '',
      rarity: card.Rarity || card.rarity || '',
      game: 'lorcana',
      imageUrl: card.Image || card.image || null,
      largeImageUrl: card.Image || card.image || null,
      searchQuery: buildSearchQuery(card.Name || card.name, card.Card_Num || card.number, card.Rarity || card.rarity),
    }))
  })
}

// ─── GENERAL EBAY FALLBACK ────────────────────────────────────────────────────
const LISTING_JUNK_RE = /\b(lot|bundle|collection|complete set|booster|pack|box|sealed|\d+\s*cards?|\dx|\bx\d+|buy \d|bogo|get \d free)\b/i

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

async function searchEbayFallback(query) {
  return withCache(`ebay-fallback:${query.toLowerCase()}`, async () => {
    const token = await getEbayToken()
    const sanitized = sanitizeQuery(query)
    const q = `${sanitized} card`
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=buyingOptions:{AUCTION|FIXED_PRICE}&sort=newlyListed&limit=40`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const items = data.itemSummaries || []

    const CARD_NUM_RE = /\b((?:[A-Z]{1,4}-?\d+-\d+[A-Z]?)|(?:\d{1,3}\/\d{1,3}))\b/
    const seen = new Set()
    const cards = []
    for (const item of items) {
      const title = item.title || ''
      if (LISTING_JUNK_RE.test(title)) continue
      let name = title
        .replace(/\b(psa|bgs|cgc|sgc|beckett)\s*\d+[\d.]*/gi, '')
        .replace(/\bnear\s*mint\b|\bnm\b|\bmp\b|\blp\b|\bhp\b/gi, '')
        .replace(/\bcard\b|\bsingle\b|\btrading\b/gi, '')
        .replace(/[[\]()|#•★◆▲●◇■□△▽♦♠♣♥]/g, ' ')
        .replace(/\s{2,}/g, ' ').trim()
      const numMatch = name.match(CARD_NUM_RE)
      const number = numMatch ? numMatch[1] : ''
      if (number) name = name.replace(number, '').trim()
      name = name.replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, '').trim()
      name = name.replace(/\b\w/g, (c) => c.toUpperCase())
      if (!name || name.length < 3) continue
      const key = number ? number.toLowerCase() : name.toLowerCase().slice(0, 30)
      if (seen.has(key)) continue
      seen.add(key)
      cards.push({
        id: `ebay-fb-${item.itemId}`, name,
        set: number ? number.replace(/-\d+[A-Z]?$/, '') : '', number,
        rarity: '', game: 'ebay',
        imageUrl: item.image?.imageUrl || null,
        largeImageUrl: item.image?.imageUrl || null,
        searchQuery: number ? `${name} ${number}` : name,
        viaEbay: true,
      })
      if (cards.length >= 5) break
    }
    return cards
  })
}

// ─── PRE-WARM CACHE ──────────────────────────────────────────────────────────
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
  // Also pre-load One Piece and DBS card data
  loadOpData().catch(() => {})
  loadDbsData().catch(() => {})
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  preWarmCache()
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
    } catch (err) { console.error('[cards] pokemon error:', err.message) }
    if (cards.length) attribution = 'pokemontcg.io'
  } else if (game === 'mtg') {
    try { cards = await searchMtg(query) } catch (err) { console.error('[cards] mtg error:', err.message) }
    if (cards.length) attribution = 'Scryfall'
  } else if (game === 'yugioh') {
    try { cards = await searchYugioh(query) } catch (err) { console.error('[cards] yugioh error:', err.message) }
    if (cards.length) attribution = 'YGOProDeck'
  } else if (game === 'onepiece') {
    try { cards = await searchOnePiece(query) } catch (err) { console.error('[cards] onepiece error:', err.message) }
    if (cards.length) attribution = 'One Piece Card Game'
  } else if (game === 'dbs') {
    try { cards = await searchDbs(query) } catch (err) { console.error('[cards] dbs error:', err.message) }
    if (cards.length) attribution = 'DBS Card Game'
  } else if (game === 'lorcana') {
    try { cards = await searchLorcana(query) } catch (err) { console.error('[cards] lorcana error:', err.message) }
    if (cards.length) attribution = 'Lorcana'
  } else {
    // No game detected — search all databases in parallel
    console.log('[cards] no game detected, searching all databases')
    const [pkm, mtg, ygo, lor] = await Promise.allSettled([
      searchPokemon(query), searchMtg(query), searchYugioh(query), searchLorcana(query),
    ])
    if (pkm.status === 'fulfilled') {
      const result = pkm.value
      cards.push(...(result.cards || []))
      if (result.jpExclusive) jpExclusive = true
    }
    if (mtg.status === 'fulfilled') cards.push(...mtg.value)
    if (ygo.status === 'fulfilled') cards.push(...ygo.value)
    if (lor.status === 'fulfilled') cards.push(...lor.value)

    if (cards.length) attribution = 'Multiple sources'
    console.log(`[cards] parallel search found ${cards.length} total results`)
  }

  // General eBay fallback — when official databases return nothing and query is 3+ words
  if (!cards.length && query.split(/\s+/).length >= 2) {
    console.log('[cards] no catalog results, trying eBay fallback')
    try {
      cards = await searchEbayFallback(query)
      if (cards.length) attribution = 'eBay listings'
    } catch (err) { console.error('[cards] eBay fallback error:', err.message) }
  }

  return res.status(200).json({ cards: cards.slice(0, 8), ebayDirect, game, attribution, jpExclusive })
}
