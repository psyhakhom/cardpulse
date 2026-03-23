/**
 * CardPulse — /api/prices.js
 * Vercel serverless function
 *
 * Four-query eBay blending strategy:
 *
 *  Query A  "all sold"       — broadest, last 90 days, no filters   Weight: 0.20 (0.25 w/o D)
 *  Query B  "recent sold"    — last 30 days (sort=newlyListed)      Weight: 0.35 (0.45 w/o D)
 *  Query C  "grade-exact"    — adds grade string to query            Weight: 0.25 (0.30 w/o D)
 *  Query D  "ending soon"    — live auctions ending <24h, 3+ bids   Weight: 0.20 (0 w/o D)
 *
 * Every result is logged to Supabase (fire-and-forget, never blocks response).
 * This builds a proprietary price history DB — the same compounding asset
 * that makes Card Ladder and Collctr defensible.
 *
 * Env vars (Vercel dashboard → Settings → Environment Variables):
 *   EBAY_CLIENT_ID        — eBay App ID
 *   EBAY_CLIENT_SECRET    — eBay Cert ID
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — service_role key (not anon key)
 *
 * Supabase table — run once in SQL editor:
 *
 *   create table price_history (
 *     id          bigserial primary key,
 *     queried_at  timestamptz not null default now(),
 *     card_name   text        not null,
 *     grade       text        not null default 'Raw',
 *     lang        text        not null default 'English',
 *     price_lo    numeric(10,2),
 *     price_avg   numeric(10,2) not null,
 *     price_hi    numeric(10,2),
 *     confidence  smallint,
 *     comp_count  smallint,
 *     trend_30d   numeric(6,2),
 *     source      text not null default 'ebay'
 *   );
 *   create index on price_history (card_name, queried_at desc);
 *   create index on price_history (queried_at desc);
 */

// ─── TOKEN CACHE ──────────────────────────────────────────────────────────────
let _token = null
let _tokenExpiry = 0

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token
  const creds = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64')
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  })
  if (!res.ok) throw new Error(`eBay token error: ${res.status}`)
  const data = await res.json()
  _token = data.access_token
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
  return _token
}

// ─── EBAY SEARCH ─────────────────────────────────────────────────────────────
async function ebaySearch(
  query,
  token,
  { limit = 40, sort = 'endingSoonest', marketplaceId = 'EBAY_US', live = false } = {}
) {
  let filter
  if (live) {
    const now = new Date().toISOString()
    const in48h = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    filter = `buyingOptions:{AUCTION},itemEndDate:[${now}..${in48h}]`
  } else {
    filter = 'buyingOptions:{FIXED_PRICE|AUCTION},soldItems:true'
  }
  // Build URL manually — URLSearchParams encodes curly braces which eBay rejects
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&filter=${encodeURIComponent(filter)}&sort=${sort}&limit=${limit}`
  if (live) console.log(`[ebay:live] ${url}`)
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
      'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=US',
    },
  })
  if (!res.ok) {
    const body = live ? await res.text().catch(() => '') : ''
    if (live) console.error(`[ebay:live] failed ${res.status}: ${body.slice(0, 200)}`)
    throw new Error(`eBay search failed (${res.status})`)
  }
  return res.json()
}

// ─── PRICE STATS ─────────────────────────────────────────────────────────────
// ─── GRADE FILTERING ─────────────────────────────────────────────────────────
const GRADE_EXCLUDE = {
  'Raw': [
    // Variant listings that skew single-card prices
    'gold alt art', 'gold parallel', 'parallel scr', 'rainbow rare', 'hyper rare',
    // Multi-card lots and sealed product
    'complete set', 'lot of', 'bundle', 'collection lot',
    'x2', 'x3', 'x4', 'x5', '2x', '3x', '4x', '5x',
    '2 card', '3 card', '4 card', '5 card', '10 card', '21 card',
    'booster box', 'booster pack', 'sealed',
    'buy 3 get 1', 'buy 2 get 1', 'buy 1 get 1', 'bogo', 'get 1 free', 'get one free',
    // Multi-word phrases safe for includes() (no false-positive risk)
    'gem mint', 'gem-mint', 'black label',
  ],
}

function gradeMatch(title, grade) {
  const t = (title || '').toLowerCase()
  if (grade === 'PSA 10') {
    if (t.includes('psa 9') || t.includes('psa9')) return false
    return t.includes('psa 10') || t.includes('psa10') || t.includes('gem mint') || t.includes('gem-mint')
  }
  if (grade === 'PSA 9') return t.includes('psa 9') || t.includes('psa9')
  if (grade === 'BGS 10') return t.includes('bgs 10') || t.includes('bgs10') || t.includes('black label')
  if (grade === 'CGC 10') return t.includes('cgc 10') || t.includes('cgc10')
  return true
}

/**
 * Filter a flat list of eBay itemSummary objects by grade.
 * For Raw: removes listings that contain graded/variant keywords.
 * For graded grades: keeps only listings whose title matches the grade.
 * Falls back to the full set if fewer than 2 items survive (avoids empty results).
 */
// Hard sanity check: always exclude graded slabs from Raw, even in fallback
const GRADED_SLAB_RE = /\b(?:psa|bgs|cgc|sgc)\s*\d/i

// Regex patterns with word boundaries — avoids false positives on card names
const EXCLUDE_PATTERNS = [
  // Graded slabs — word-boundary to avoid matching set codes like FB09
  /\bpsa\b/i,
  /\bbgs\b/i,
  /\bcgc\b/i,
  /\bsgc\b/i,
  /\bbeckett\b/i,
  /\bgraded\b/i,
  /\bslab\b/i,
  // Graded with numeric grade (catches "PSA10", "BGS 9.5", "CGC9" etc)
  /\b(?:psa|bgs|cgc|sgc)\s*\d/i,
  /\bgrade[d]?\s*\d/i,
  // Signed/autograph — word-boundary so "Sign" in card names doesn't match
  /\bsigned\b/i,
  /\bautograph(?:ed)?\b/i,
  /\bauto\b/i,
  /\bsignature\b/i,
]

function filterItems(items, grade) {
  if (!items?.length) return items
  const excludeTerms = GRADE_EXCLUDE[grade]
  if (excludeTerms) {
    // Raw — exclude graded/variant listings
    const kept = items.filter((i) => {
      const t = (i.title || '').toLowerCase()
      const hit = excludeTerms.find((kw) => t.includes(kw))
      if (hit) { console.log(`[filter:Raw] dropped "${i.title?.slice(0, 70)}" matched "${hit}"`); return false }
      const patHit = EXCLUDE_PATTERNS.find((re) => re.test(t))
      if (patHit) { console.log(`[filter:Raw] dropped "${i.title?.slice(0, 70)}" matched pattern "${patHit}"`); return false }
      return true
    })
    console.log(`[filter:Raw] ${items.length} → ${kept.length} kept`)
    if (kept.length >= 2) return kept
    // Fallback to full set but ALWAYS strip graded slabs — they are never Raw
    const safeItems = items.filter((i) => !GRADED_SLAB_RE.test(i.title || ''))
    console.log(`[filter:Raw] fallback: ${items.length} → ${safeItems.length} after slab sanity check`)
    return safeItems
  }
  if (grade && grade !== 'Raw') {
    // Graded — keep only titles that match the grade string
    const kept = items.filter((i) => gradeMatch(i.title, grade))
    console.log(`[filter:${grade}] ${items.length} → ${kept.length} match`)
    return kept.length >= 2 ? kept : items
  }
  return items
}

function calcStats(items) {
  if (!items?.length) return null
  const prices = items
    .map((i) => parseFloat(i.price?.value))
    .filter((p) => !isNaN(p) && p > 0)
    .sort((a, b) => a - b)
  if (prices.length < 1) return null
  const mid = Math.floor(prices.length / 2)
  const median = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2
  // Bidirectional outlier removal: drop anything below 20% of median (low junk)
  // or above 5x median (high outliers). Protects SIR/chase cards from cheap
  // trainer tip cards dragging the average down.
  const clipped = prices.filter((p) => p >= median * 0.2 && p <= median * 5)
  if (clipped.length < 1) return null
  const trimmed = clipped.length >= 6
    ? clipped.slice(Math.floor(clipped.length * 0.1), clipped.length - Math.floor(clipped.length * 0.1))
    : clipped
  const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length
  return {
    lo: parseFloat(trimmed[0].toFixed(2)),
    avg: parseFloat(avg.toFixed(2)),
    hi: parseFloat(trimmed[trimmed.length - 1].toFixed(2)),
    count: trimmed.length,
  }
}

// ─── COMP EXTRACTION ─────────────────────────────────────────────────────────
function extractComps(items, limit = 10, grade = null) {
  const now = Date.now()
  const cutoff = now - 90 * 24 * 60 * 60 * 1000

  const priced = items.filter((i) => parseFloat(i.price?.value || 0) > 0)
  const gradeOk = priced.filter((i) => !grade || gradeMatch(i.title, grade))

  let dateDropped = 0
  const dateOk = gradeOk.filter((i) => {
    const d = i.itemEndDate || i.itemCreationDate
    if (!d) { dateDropped++; return false }
    const ts = new Date(d).getTime()
    if (isNaN(ts) || ts < cutoff) { dateDropped++; return false }
    return true
  })
  if (dateDropped > 0) console.log(`[extractComps] dropped ${dateDropped}/${gradeOk.length} items outside 90-day window`)

  return dateOk
    .slice(0, limit)
    .map((i) => ({
      title: i.title,
      price: parseFloat(i.price?.value || 0),
      date: i.itemEndDate || i.itemCreationDate || null,
      url: i.itemWebUrl || null,
      image: i.image?.imageUrl || i.thumbnailImages?.[0]?.imageUrl || null,
      condition: i.condition || null,
      source: 'ebay',
    }))
}

// ─── CLUSTER DETECTION ───────────────────────────────────────────────────────
const BUCKETS = [
  { label: 'Under $20',   min: 0,   max: 20  },
  { label: '$20–$50',     min: 20,  max: 50  },
  { label: '$50–$100',    min: 50,  max: 100 },
  { label: '$100–$200',   min: 100, max: 200 },
  { label: '$200–$500',   min: 200, max: 500 },
  { label: '$500+',       min: 500, max: Infinity },
]

function detectClusters(items) {
  const priced = items.filter((i) => parseFloat(i.price?.value || 0) > 0)
  if (priced.length < 6) return null

  const buckets = BUCKETS.map((b) => {
    const members = priced.filter((i) => {
      const p = parseFloat(i.price.value)
      return p >= b.min && p < b.max
    })
    const avg = members.length
      ? members.reduce((s, i) => s + parseFloat(i.price.value), 0) / members.length
      : 0
    return { label: b.label, min: b.min, max: b.max, count: members.length, avg: parseFloat(avg.toFixed(2)) }
  }).filter((b) => b.count > 0)

  if (buckets.length < 2) return null

  const total = priced.length
  const dominant = buckets.reduce((a, b) => (b.count > a.count ? b : a))

  // Check if dominant bucket has 80%+ of results
  if (dominant.count / total < 0.8) return null

  // Check if any other bucket has items at 10x+ the dominant avg
  const hasHighOutlierCluster = buckets.some(
    (b) => b !== dominant && b.avg >= dominant.avg * 10 && b.count >= 2
  )
  // Also check opposite: dominant is the cheap bucket and there's a high-value cluster
  const hasLowDominantWithHighCluster = buckets.some(
    (b) => b !== dominant && dominant.avg > 0 && b.avg >= dominant.avg * 10 && b.count >= 2
  )

  if (!hasHighOutlierCluster && !hasLowDominantWithHighCluster) return null

  return buckets.filter((b) => b.count >= 2)
}

// ─── TREND ───────────────────────────────────────────────────────────────────
function calcTrend(recentAvg, allAvg) {
  if (!recentAvg || !allAvg || allAvg === 0) return 0
  return parseFloat((((recentAvg - allAvg) / allAvg) * 100).toFixed(1))
}

// ─── CARD IMAGE LOOKUP ───────────────────────────────────────────────────────

const POKEMON_KEYWORDS = ['pokemon', 'pokémon', 'charizard', 'pikachu', 'mewtwo', 'eevee',
  'blastoise', 'venusaur', 'gengar', 'snorlax', 'gyarados', 'dragonite', 'meowth',
  'lugia', 'ho-oh', 'rayquaza', 'mew', 'umbreon', 'espeon', 'sylveon', 'gardevoir',
  'lucario', 'greninja', 'alakazam', 'bulbasaur', 'squirtle']

const MTG_KEYWORDS = ['mtg', 'magic the gathering', 'magic: the gathering', 'planeswalker']

function detectCardSource(query) {
  const ql = query.toLowerCase()
  if (POKEMON_KEYWORDS.some((k) => ql.includes(k))) return 'pokemon'
  if (MTG_KEYWORDS.some((k) => ql.includes(k))) return 'mtg'
  return null
}

/** Extract the likely card name from the query for API lookups — first 2-3 words,
 *  stopping before set codes or rarity abbreviations. */
function extractCardName(query) {
  const tokens = query.split(/\s+/)
  const stopRe = /^(?:[A-Z]{1,4}-?\d+|\d{1,3}\/\d{1,3}|SIR|SCR|SPR|SR|UR|SEC|SAR|EX|GX|V|VMAX|VSTAR)$/i
  const nameTokens = []
  for (const tok of tokens) {
    if (stopRe.test(tok)) break
    nameTokens.push(tok)
    if (nameTokens.length >= 4) break
  }
  return nameTokens.join(' ').trim()
}

async function fetchPokemonImage(query) {
  const cardName = extractCardName(query)
  if (!cardName) return null
  const apiKey = process.env.POKEMON_TCG_API_KEY
  const headers = apiKey ? { 'X-Api-Key': apiKey } : {}
  const url = `https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(cardName)}"&pageSize=1`
  const res = await fetch(url, { headers })
  if (!res.ok) return null
  const data = await res.json()
  return data.data?.[0]?.images?.large || null
}

async function fetchMtgImage(query) {
  const cardName = extractCardName(query)
  if (!cardName) return null
  const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cardName)}`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json()
  return data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal || null
}

/**
 * Fetches the best card image from a dedicated card API based on detected game.
 * Returns null (not throws) on any failure so it never blocks the response.
 */
async function fetchCardImage(query) {
  const source = detectCardSource(query)
  try {
    if (source === 'pokemon') return await fetchPokemonImage(query)
    if (source === 'mtg') return await fetchMtgImage(query)
  } catch (e) {
    console.log(`[cardImage:${source}] failed: ${e.message}`)
  }
  return null
}

// ─── SPELL CORRECTION ────────────────────────────────────────────────────────

// Exact substitutions checked first (fast path)
const SPELL_MAP = {
  shiing: 'shining', shiinging: 'shining', shinnig: 'shining',
  warior: 'warrior', warroir: 'warrior', warrioir: 'warrior',
  potental: 'potential', potenital: 'potential',
  unlimted: 'unlimited', unlimitd: 'unlimited',
  goget: 'gogeta', gogeta_: 'gogeta',
  vegi: 'vegeta',
  vegito_: 'vegito',
  charizrd: 'charizard', charizar: 'charizard', charizrd: 'charizard',
  picachu: 'pikachu', pikach: 'pikachu', pkachu: 'pikachu',
  meowht: 'meowth', meotwh: 'meowth',
  freiza: 'frieza', frieeza: 'frieza',
  piccilo: 'piccolo', picolo: 'piccolo',
  goahn: 'gohan', gohna: 'gohan',
  trunkz: 'trunks',
  bardok: 'bardock',
  brolly: 'broly', broli: 'broly',
}

// Known-good dictionary for Levenshtein matching (only words > 5 chars needed)
const KNOWN_TERMS = [
  // DBS characters
  'shining','warrior','potential','unlimited','awakening','evolution',
  'fusion','instinct','majin','saiyan','namekian','frieza','piccolo',
  'vegeta','vegito','gogeta','gohan','goku','broly','beerus','whis',
  'android','cell','trunks','bardock','cooler','turles','raditz',
  // Pokemon
  'charizard','pikachu','meowth','gengar','eevee','mewtwo','blastoise',
  'venusaur','snorlax','gyarados','dragonite','alakazam','umbreon',
  'espeon','sylveon','gardevoir','lucario','greninja','rayquaza',
  // Rarity / card terms
  'secret','special','illustration','alternate','parallel','rainbow',
  'hyper','ultra','super','uncommon','common','promo','leader',
  // Set names
  'perfect','scarlet','violet','obsidian','temporal','paldea','paradox',
]

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => [i])
  for (let j = 1; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

function correctWord(word) {
  const wl = word.toLowerCase()
  // 1. Exact map hit
  if (SPELL_MAP[wl]) return SPELL_MAP[wl]
  // 2. Already a known term — no correction needed
  if (KNOWN_TERMS.includes(wl)) return word
  // 3. Short words and numbers — don't touch
  if (wl.length <= 5 || /^\d/.test(wl)) return word
  // 4. Levenshtein — find closest known term within distance 2
  let best = null, bestDist = 3
  for (const term of KNOWN_TERMS) {
    if (Math.abs(term.length - wl.length) > 2) continue // prune
    const d = levenshtein(wl, term)
    if (d < bestDist) { bestDist = d; best = term }
  }
  return best || word
}

/**
 * Spell-correct a preprocessed query word by word.
 * Returns { corrected, changed } where changed is true if any word was fixed.
 */
function spellCorrect(query) {
  const tokens = query.split(/\s+/)
  const corrected = tokens.map(correctWord)
  const changed = corrected.some((w, i) => w !== tokens[i])
  return { corrected: corrected.join(' '), changed }
}

// ─── QUERY PREPROCESSOR ──────────────────────────────────────────────────────

// Rarity codes to extract and preserve
const RARITY_CODES = ['IMIR', 'SIR', 'SCR', 'SPR', 'SAR', 'SSR', 'SEC', 'ACE', 'UR', 'SR', 'RRR', 'RR', 'UC', 'CHR', 'AR', 'ALT', 'FA']

// Set code pattern: BT27-019, FB09, OP01-112, D-BT01, SD23-01, 121/088
const SET_CODE_RE = /\b(?:[A-Z]{1,4}-)?(?:BT|FB|OP|SD|P|D-BT|ST)\d+(?:-\d+)?\b|\b[A-Z]{1,4}\d{2,3}(?:-\d+)?\b|\b\d{3}\/\d{3}\b/gi

// Card number standalone: 121/088
const CARD_NUM_RE = /\b\d{1,3}\/\d{1,3}\b/g

// Grade words — strip from query since grade is handled by the grade filter
const GRADE_WORDS_RE = /\b(?:psa|bgs|cgc|sgc|beckett)\s*\d+(?:\.\d+)?|\braw\b|\bgem\s*mint\b|\bnm\b|\bnear\s*mint\b|\bmint\b|\blightly\s*played\b|\bheavily\s*played\b/gi

// Filler phrases/words to remove from FULL_TITLE queries (longest first)
const FULL_TITLE_FILLER = [
  'special illustration rare', 'illustration rare', 'trading card game',
  'pre-owned', 'near mint', 'lightly played', 'heavily played',
  'perfect order', 'scarlet violet', 'scarlet & violet',
  'pokemon tcg', 'pokemon card', 'pokémon card',
  'single card', 'card game',
  'english', 'japanese', 'korean', 'chinese',
  'special', 'trading', 'single', 'holo',
  'new', '1x',
]

function normalize(raw) {
  return raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^\w\s\-\/]/g, ' ')                     // remove special chars
    .replace(/\s+/g, ' ').trim()
}

function detectType(q, grade) {
  const ql = q.toLowerCase()
  if (SET_CODE_RE.test(q)) { SET_CODE_RE.lastIndex = 0; return 'SET_CODE' }
  if (GRADE_WORDS_RE.test(ql)) { GRADE_WORDS_RE.lastIndex = 0; return 'GRADE_INCLUDED' }
  if (q.length > 60) return 'FULL_TITLE'
  return 'SIMPLE_NAME'
}

function extractTokens(q) {
  // Set codes
  const setCodes = q.match(SET_CODE_RE) || []
  SET_CODE_RE.lastIndex = 0

  // Card numbers (e.g. 121/088)
  const cardNums = q.match(CARD_NUM_RE) || []

  // Rarity codes — match as whole uppercase words
  const rarityCode = RARITY_CODES.find((r) => new RegExp(`\\b${r}\\b`).test(q)) || null

  // Grade string (for logging; not used in final query)
  const gradeMatch = q.match(GRADE_WORDS_RE)
  GRADE_WORDS_RE.lastIndex = 0
  const gradeStr = gradeMatch ? gradeMatch[0] : null

  return { setCodes, cardNums, rarityCode, gradeStr }
}

function cleanFullTitle(q) {
  let out = q
  // Strip multi-word filler phrases first
  for (const phrase of FULL_TITLE_FILLER) {
    out = out.replace(new RegExp(`\\b${phrase}\\b`, 'gi'), ' ')
  }
  // Strip grade words
  out = out.replace(GRADE_WORDS_RE, ' ')
  GRADE_WORDS_RE.lastIndex = 0
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Preprocess a raw search query into a tight eBay query.
 * Returns { query, type, tokens } for logging and debugging.
 */
function preprocessQuery(raw, grade = 'Raw') {
  const normalised = normalize(raw)
  const type = detectType(normalised, grade)

  // Short set-code queries are already specific — pass through untouched
  if (type === 'SET_CODE' && normalised.length <= 60) {
    console.log(`[preprocess] type=SET_CODE (passthrough) "${raw}" → "${normalised}"`)
    return { query: normalised, type, tokens: extractTokens(normalised) }
  }

  const tokens = extractTokens(normalised)

  let cleaned
  if (type === 'FULL_TITLE') {
    cleaned = cleanFullTitle(normalised)
  } else if (type === 'GRADE_INCLUDED') {
    // Remove grade words — grade filter handles this separately
    cleaned = normalised.replace(GRADE_WORDS_RE, ' ').replace(/\s+/g, ' ').trim()
    GRADE_WORDS_RE.lastIndex = 0
  } else {
    // SET_CODE or SIMPLE_NAME — keep as-is
    cleaned = normalised
  }

  // Reconstruct: cardName portion (what's left after removing codes/rarity),
  // then re-append set codes and rarity code so they're always present
  const setCodeStr = tokens.setCodes.join(' ')
  const cardNumStr = tokens.cardNums.filter((n) => !setCodeStr.includes(n)).join(' ')
  const rarityStr  = tokens.rarityCode || ''

  // Remove the tokens we're about to re-append, to avoid duplicates
  let base = cleaned
  for (const sc of tokens.setCodes) base = base.replace(sc, '')
  for (const cn of tokens.cardNums) base = base.replace(cn, '')
  if (rarityStr) base = base.replace(new RegExp(`\\b${rarityStr}\\b`, 'g'), '')
  base = base.replace(/\s+/g, ' ').trim()

  const parts = [base, setCodeStr, cardNumStr, rarityStr].filter(Boolean)
  let query = parts.join(' ').replace(/\s+/g, ' ').trim()

  // Hard cap at 50 chars — trim from the end of the base name, not the codes
  if (query.length > 50) {
    const suffix = [setCodeStr, cardNumStr, rarityStr].filter(Boolean).join(' ')
    const maxBase = 50 - (suffix ? suffix.length + 1 : 0)
    base = base.substring(0, maxBase).replace(/\s+\S*$/, '').trim()
    query = [base, suffix].filter(Boolean).join(' ')
  }

  // Fallback: if cleaning gutted the query, return the normalised original
  if (query.length < 3) query = normalised.substring(0, 50)

  console.log(`[preprocess] type=${type} "${raw}" → "${query}"`)
  return { query, type, tokens }
}

// ─── QUERY BUILDERS ──────────────────────────────────────────────────────────
function buildQueries(name, grade, lang) {
  const langSuffix =
    { Japanese: ' japanese', Korean: ' korean', Chinese: ' chinese' }[lang] ||
    ''
  const hasSetCode = /[a-z]{1,4}-?\d+/i.test(name)
  const hasCardWord = /\bcard\b/i.test(name)
  const cardSuffix = hasSetCode || hasCardWord ? '' : ' card'
  const gradeStr = grade && grade !== 'Raw' ? ` ${grade}` : ''
  const base = `${name}${langSuffix}${cardSuffix}${gradeStr}`
  // For Raw, Query C uses "near mint" to find ungraded NM listings (different from A/B)
  const gradeExactQ = grade === 'Raw' ? `${name}${langSuffix}${cardSuffix} near mint` : base
  return {
    a: { q: base, label: 'All sold (90d)', weight: 0.25, limit: 40, sort: 'endingSoonest' },
    b: { q: base, label: 'Recent sold (30d)', weight: 0.45, limit: 15, sort: 'newlyListed' },
    c: {
      q: gradeExactQ,
      label: `Grade-exact (${grade || 'raw'})`,
      weight: 0.3,
      limit: 30,
      sort: 'endingSoonest',
    },
    d: { q: base, label: 'Live auctions', weight: 0.15, limit: 10, sort: 'endingSoonest', live: true },
  }
}

// Weights when Query D has data — rebalanced to sum to 1.0
const WEIGHTS_WITH_LIVE = { a: 0.20, b: 0.35, c: 0.25, d: 0.20 }
// Fallback weights when Query D has no data — original three-query weights
const WEIGHTS_WITHOUT_LIVE = { a: 0.25, b: 0.45, c: 0.30 }

// ─── WEIGHTED BLEND ──────────────────────────────────────────────────────────
function blend(results) {
  // Check if Query D (live auctions) has data to decide weight set
  const hasLive = results.some((r) => r.label === 'Live auctions' && r.stats !== null)
  const weightMap = hasLive ? WEIGHTS_WITH_LIVE : WEIGHTS_WITHOUT_LIVE
  const keys = ['a', 'b', 'c', 'd']

  // Apply rebalanced weights to each result
  const reweighted = results.map((r, i) => ({
    ...r,
    weight: weightMap[keys[i]] ?? r.weight,
  }))

  const active = reweighted.filter((r) => r.stats !== null)
  if (!active.length) return null
  const tw = active.reduce((a, r) => a + r.weight, 0)
  const wAvg = active.reduce((a, r) => a + r.stats.avg * r.weight, 0) / tw
  const wLo = active.reduce((a, r) => a + r.stats.lo * r.weight, 0) / tw
  const wHi = active.reduce((a, r) => a + r.stats.hi * r.weight, 0) / tw
  const totalComps = active.reduce((a, r) => a + r.stats.count, 0)
  const confidence = Math.round(
    (active.length / results.length) * 50 + Math.min(1, totalComps / 20) * 50
  )
  return {
    lo: parseFloat(wLo.toFixed(2)),
    avg: parseFloat(wAvg.toFixed(2)),
    hi: parseFloat(wHi.toFixed(2)),
    confidence,
    activeQueries: active.length,
    totalQueries: results.length,
    totalComps,
    reweighted, // carry reweighted results for sourceBreakdown
  }
}

// ─── SUPABASE LOGGING (fire-and-forget) ──────────────────────────────────────
/**
 * Writes one price snapshot row to Supabase.
 * NEVER awaited — response goes out before this completes.
 * If Supabase is down or not yet configured, the user never knows.
 *
 * Over time this table becomes your price history database.
 * Query it later with:
 *   GET /api/prices?history=1&q=Charizard Base Set Holo&grade=PSA 10
 */
async function logPriceHistory({
  cardName,
  grade,
  lang,
  lo,
  avg,
  hi,
  confidence,
  totalComps,
  trend30,
}) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return // not configured yet — skip silently

  try {
    await fetch(`${url}/rest/v1/price_history`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        card_name: cardName,
        grade: grade || 'Raw',
        lang: lang || 'English',
        price_lo: lo,
        price_avg: avg,
        price_hi: hi,
        confidence,
        comp_count: totalComps,
        trend_30d: trend30,
        source: 'ebay',
      }),
    })
  } catch (err) {
    console.warn('History log failed (non-fatal):', err.message)
  }
}

// ─── HISTORY RETRIEVAL ───────────────────────────────────────────────────────
/**
 * GET /api/prices?history=1&q=Charizard Base Set Holo&grade=PSA 10
 *
 * Returns up to 200 price snapshots for a card over the last 90 days,
 * sorted oldest-first — ready to render as a trend chart on the frontend.
 *
 * This endpoint is what turns CardPulse into Card Ladder over time.
 * Add it to the UI once you have 30+ days of data for popular cards.
 */
async function handleHistory(res, cardName, grade) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key)
    return res.status(503).json({ error: 'History not available yet' })

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const params = new URLSearchParams({
    card_name: `eq.${cardName}`,
    grade: `eq.${grade || 'Raw'}`,
    queried_at: `gte.${since}`,
    select: 'queried_at,price_avg,price_lo,price_hi,confidence,comp_count',
    order: 'queried_at.asc',
    limit: '200',
  })

  const r = await fetch(`${url}/rest/v1/price_history?${params}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  if (!r.ok) return res.status(500).json({ error: 'History query failed' })
  const rows = await r.json()
  return res.status(200).json({ history: rows, card: cardName, grade })
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { q, grade = 'Raw', lang = 'English', history, exact } = req.query
  console.log('Grade received:', JSON.stringify(grade), '| q:', q, exact === '1' ? '(exact/catalog)' : '')

  // History sub-route
  if (history === '1') return handleHistory(res, q, grade)

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Query too short' })
  }

  try {
    const token = await getToken()
    // When exact=1 (card catalog selection), skip preprocessor entirely
    const processed = exact === '1' ? q.trim() : preprocessQuery(q.trim(), grade).query

    // Helper: run the three parallel eBay queries for a given name.
    // Grade filtering is applied immediately after raw results come back,
    // before calcStats, extractComps, or image selection see any data.
    // Detect rarity code in the query — if present, enforce it in results
    const queryRarity = RARITY_CODES.find((r) => new RegExp(`\\b${r}\\b`, 'i').test(processed))
    if (queryRarity) console.log(`[rarity] detected "${queryRarity}" in query — enforcing in results`)

    function filterByRarity(items) {
      if (!queryRarity || !items?.length) return items
      const re = new RegExp(`\\b${queryRarity}\\b`, 'i')
      const kept = items.filter((i) => re.test(i.title || ''))
      console.log(`[rarity] ${items.length} → ${kept.length} with "${queryRarity}" in title`)
      // Fall back to unfiltered if rarity filter leaves too few results
      return kept.length >= 2 ? kept : items
    }

    async function runQueries(name) {
      const qs = buildQueries(name, grade, lang)
      const [dA, dB, dC, dD] = await Promise.allSettled([
        ebaySearch(qs.a.q, token, { limit: qs.a.limit, sort: qs.a.sort }),
        ebaySearch(qs.b.q, token, { limit: qs.b.limit, sort: qs.b.sort }),
        ebaySearch(qs.c.q, token, { limit: qs.c.limit, sort: qs.c.sort }),
        ebaySearch(qs.d.q, token, { limit: qs.d.limit, sort: qs.d.sort, live: true }),
      ])
      const rawA = dA.status === 'fulfilled' ? dA.value.itemSummaries || [] : []
      const rawB = dB.status === 'fulfilled' ? dB.value.itemSummaries || [] : []
      const rawC = dC.status === 'fulfilled' ? dC.value.itemSummaries || [] : []
      const rawD = dD.status === 'fulfilled' ? dD.value.itemSummaries || [] : []

      // Filter by grade, then by rarity — filtered items are used for everything downstream
      const fA = filterByRarity(filterItems(rawA, grade))
      const fB = filterByRarity(filterItems(rawB, grade))
      const fC = filterByRarity(filterItems(rawC, grade))
      // Query D: only include live auctions with 1+ bids (price validated by a buyer)
      const fDgraded = filterByRarity(filterItems(rawD, grade))
      console.log(`[query:D] ${rawD.length} raw auctions → ${fDgraded.length} after grade+rarity filter`)
      const fD = fDgraded.filter((i) => (i.bidCount || 0) >= 1)
      console.log(`[query:D] ${fDgraded.length} auctions → ${fD.length} with 1+ bids`)

      const res = [
        { ...qs.a, stats: calcStats(fA) },
        { ...qs.b, stats: calcStats(fB) },
        { ...qs.c, stats: calcStats(fC) },
        { ...qs.d, stats: calcStats(fD) },
      ]
      return { results: res, blended: blend(res), allItems: [...fA, ...fB, ...fC, ...fD] }
    }

    // Launch card image lookup in parallel with the first eBay query batch
    const [queriesResult, cardImageResult] = await Promise.allSettled([
      runQueries(processed),
      fetchCardImage(q.trim()),
    ])
    let { results, blended, allItems } = queriesResult.value
    const dedicatedImageUrl = cardImageResult.status === 'fulfilled' ? cardImageResult.value : null

    let correctedQuery = null  // set if we used spell correction or word-strip

    // ── Retry 1: spell correction ────────────────────────────────────────────
    if (!blended || blended.totalComps === 0) {
      const { corrected, changed } = spellCorrect(processed)
      if (changed) {
        console.log(`[spellcorrect] "${processed}" → "${corrected}"`)
        const attempt = await runQueries(corrected)
        if (attempt.blended && attempt.blended.totalComps > 0) {
          ;({ results, blended, allItems } = attempt)
          correctedQuery = corrected
        }
      }
    }

    // ── Retry 2: progressive word removal (strip from middle, keep set codes) ─
    if (!blended || blended.totalComps < 3) {
      const base = correctedQuery || processed
      const words = base.split(/\s+/)
      // Identify anchor positions: set codes, card numbers, rarity codes
      const anchorRe = /^(?:[A-Z]{1,4}-?\d+|\d{1,3}\/\d{1,3}|SIR|SCR|SPR|SR|UR|SEC|SAR)$/i
      const anchorIdx = new Set(words.map((w, i) => anchorRe.test(w) ? i : -1).filter(i => i >= 0))

      // Build candidate removal sequence: try removing each non-anchor word
      // starting from the last non-anchor position (right-to-left, skip anchors)
      for (let i = words.length - 1; i >= 1; i--) {
        if (anchorIdx.has(i)) continue
        const candidate = words.filter((_, idx) => idx !== i).join(' ')
        if (candidate === base) continue
        console.log(`[word-strip] trying "${candidate}"`)
        const attempt = await runQueries(candidate)
        if (attempt.blended && attempt.blended.totalComps > (blended?.totalComps || 0)) {
          ;({ results, blended, allItems } = attempt)
          if (!correctedQuery) correctedQuery = candidate
          if (blended.totalComps >= 3) break  // good enough, stop retrying
        }
      }
    }

    if (!blended) {
      return res.status(404).json({
        error: 'Not enough sold comps found. Try a more specific search.',
        searchTip: 'For Dragon Ball cards, include the set code like BT27 or FB09. For Pokémon, include the set name like "Base Set" or "Scarlet & Violet".',
      })
    }

    const trend30 = calcTrend(results[1].stats?.avg, results[0].stats?.avg)

    // Deduplicate comps across all queries
    const seen = new Set()
    const deduped = allItems.filter((i) => {
      const key = i.title?.toLowerCase().slice(0, 40)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const response = {
      lo: blended.lo,
      avg: blended.avg,
      hi: blended.hi,
      confidence: blended.confidence,
      activeQueries: blended.activeQueries,
      totalQueries: blended.totalQueries,
      totalComps: blended.totalComps,
      trend30,
      trend90: null,
      imageUrl: (() => {
        // Prefer a dedicated card API image (pokemontcg.io / Scryfall) when available
        if (dedicatedImageUrl) return dedicatedImageUrl
        // Fall back to best-scored eBay listing image
        const qLower = q.trim().toLowerCase()
        const qWords = qLower.split(/\s+/)
        const rareTerms = ['illustration rare', 'special illustration', ' sir ', 'sir)', 'full art', 'alt art', 'alternate art']
        const queryIsRare = rareTerms.some((t) => qLower.includes(t))
        const scored = deduped
          .filter((i) => i.image?.imageUrl)
          .map((i) => {
            const t = (i.title || '').toLowerCase()
            let score = qWords.filter((w) => t.includes(w)).length
            if (queryIsRare && rareTerms.some((rt) => t.includes(rt))) score += 10
            return { url: i.image.imageUrl, score }
          })
        scored.sort((a, b) => b.score - a.score)
        return scored[0]?.url || null
      })(),
      sourceBreakdown: (blended.reweighted || results).map((r) => ({
        label: r.label,
        weight: r.weight,
        available: r.stats !== null,
        avg: r.stats?.avg || null,
        count: r.stats?.count || 0,
        live: r.label === 'Live auctions',
      })),
      comps: extractComps(deduped, 10, grade),
      query: q,
      correctedQuery: correctedQuery !== processed ? correctedQuery : null,
      grade,
      lang,
      source: 'ebay',
      timestamp: Date.now(),
      searchTip: blended.confidence < 60 && blended.totalComps < 5
        ? 'Try adding the set name or card number for better results'
        : null,
      ...(() => {
        const clusters = detectClusters(allItems)
        return clusters ? { multipleProducts: true, clusters } : { multipleProducts: false }
      })(),
    }

    // Log to Supabase — fire and forget, never blocks the response
    logPriceHistory({
      cardName: q.trim(),
      grade,
      lang,
      lo: blended.lo,
      avg: blended.avg,
      hi: blended.hi,
      confidence: blended.confidence,
      totalComps: blended.totalComps,
      trend30,
    })

    return res.status(200).json(response)
  } catch (err) {
    console.error('CardPulse API error:', err)
    return res.status(500).json({ error: err.message })
  }
}
