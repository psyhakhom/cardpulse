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
async function searchPokemon(query) {
  return withCache(`pkm:${query.toLowerCase()}`, async () => {
    const apiKey = process.env.POKEMON_TCG_API_KEY
    const headers = { Accept: 'application/json' }
    if (apiKey) headers['X-Api-Key'] = apiKey

    const q = `name:${query}*`
    const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=8&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`
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
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=released&dir=desc`
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

// ─── DBS CARD GAME SITE ──────────────────────────────────────────────────────
async function searchDbsSite(query) {
  return withCache(`dbs-site:${query.toLowerCase()}`, async () => {
    const url = `https://www.dbs-cardgame.com/us-en/cardlist/?search=true&keyword=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CardPulse/1.0' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) throw new Error(`DBS site ${res.status}`)
    const html = await res.text()

    const cards = []
    // Parse card list items from the HTML — each card is in a <li> with class "list-inner"
    // Card image: <img src="..."> inside the list item
    // Card name: inside <dd class="cardName"> or similar
    // Card number: inside <dd class="cardNumber">
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
      const number = numMatch ? numMatch[1].trim() : ''
      const rarity = rarityMatch ? rarityMatch[1].trim() : ''
      let imageUrl = imgMatch ? imgMatch[1].trim() : null
      if (imageUrl && imageUrl.startsWith('/')) {
        imageUrl = `https://www.dbs-cardgame.com${imageUrl}`
      }

      cards.push({
        id: `dbs-${number || cards.length}`,
        name,
        set: number ? number.replace(/-\d+[A-Z]?$/, '') : '',
        number,
        rarity,
        game: 'dbs',
        imageUrl,
        largeImageUrl: imageUrl,
        searchQuery: buildDbsQuery({ name, number, rarity }),
      })
    }

    // If HTML parsing found nothing, try a simpler pattern for the card page format
    if (!cards.length) {
      const simpleRe = /<a[^>]+href="[^"]*\/cardlist\/([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[\s\S]*?<\/a>/gi
      while ((match = simpleRe.exec(html)) !== null && cards.length < 8) {
        const slug = match[1]
        const imgUrl = match[2].startsWith('/') ? `https://www.dbs-cardgame.com${match[2]}` : match[2]
        const numFromSlug = slug.match(/((?:BT|FB|SD|ST|D-BT)\d+-\d+[A-Z]?)/i)
        cards.push({
          id: `dbs-${slug}`,
          name: slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          set: numFromSlug ? numFromSlug[1].replace(/-\d+[A-Z]?$/, '') : '',
          number: numFromSlug ? numFromSlug[1] : '',
          rarity: '',
          game: 'dbs',
          imageUrl: imgUrl,
          largeImageUrl: imgUrl,
          searchQuery: numFromSlug ? `${slug.replace(/[-_]/g, ' ')} ${numFromSlug[1]}` : slug.replace(/[-_]/g, ' '),
        })
      }
    }

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
  const ql = query.toLowerCase()
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
  try {
    const siteResults = await searchDbsSite(query)
    if (siteResults.length > 0) return siteResults
  } catch (err) {
    console.log(`[cards] DBS site scrape failed: ${err.message}, using fallback`)
  }
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
      cards = await searchDbs(query)
      attribution = 'DBS Card Game'
      console.log('[cards] dbs results:', cards.length)
    } catch (err) {
      console.error('[cards] dbs error:', err.message)
    }
  } else {
    // Unknown game — try Pokemon and MTG in parallel
    const [pkm, mtg] = await Promise.allSettled([searchPokemon(query), searchMtg(query)])
    if (pkm.status === 'fulfilled') { cards.push(...pkm.value); console.log('[cards] unknown/pkm:', pkm.value.length) }
    else console.error('[cards] unknown/pkm error:', pkm.reason?.message)
    if (mtg.status === 'fulfilled') { cards.push(...mtg.value); console.log('[cards] unknown/mtg:', mtg.value.length) }
    else console.error('[cards] unknown/mtg error:', mtg.reason?.message)

    if (cards.length) {
      attribution = 'pokemontcg.io & Scryfall'
    }
  }

  return res.status(200).json({ cards: cards.slice(0, 8), ebayDirect, game, attribution })
}
