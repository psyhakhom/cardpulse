/**
 * CardPulse — /api/prices.js
 * Vercel serverless function
 *
 * Three-query eBay blending strategy:
 *
 *  Query A  "all sold"     — broadest, last 90 days, no filters   Weight: 0.25
 *  Query B  "recent sold"  — last 30 days (sort=endingSoonest)     Weight: 0.45
 *  Query C  "grade-exact"  — adds grade string to query             Weight: 0.30
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
  { limit = 40, sort = 'endingSoonest', marketplaceId = 'EBAY_US' } = {}
) {
  const params = new URLSearchParams({
    q: query,
    filter: 'buyingOptions:{FIXED_PRICE|AUCTION},soldItems:true',
    sort,
    limit: String(limit),
  })
  const res = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
        'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=US',
      },
    }
  )
  if (!res.ok) throw new Error(`eBay search failed (${res.status})`)
  return res.json()
}

// ─── PRICE STATS ─────────────────────────────────────────────────────────────
const RAW_EXCLUDE = ['psa', 'bgs', 'cgc', 'sgc', 'beckett', 'graded', 'slab', 'black label']

function gradeMatch(title, grade) {
  const t = (title || '').toLowerCase()
  if (grade === 'PSA 10') {
    if (t.includes('psa 9') || t.includes('psa9')) return false   // block PSA 9 contamination
    return t.includes('psa 10') || t.includes('psa10') || t.includes('gem mint') || t.includes('gem-mint')
  }
  if (grade === 'PSA 9') return t.includes('psa 9') || t.includes('psa9')
  if (grade === 'BGS 10') return t.includes('bgs 10') || t.includes('bgs10') || t.includes('black label')
  if (grade === 'CGC 10') return t.includes('cgc 10') || t.includes('cgc10')
  return true
}

function filterByGrade(items, grade, label) {
  if (!items?.length) return items
  const tag = `[filterByGrade:${label || '?'}]`
  if (!grade || grade === 'Raw') {
    const filtered = items.filter((i) => {
      const t = (i.title || '').toLowerCase()
      return !RAW_EXCLUDE.some((kw) => t.includes(kw))
    })
    console.log(`${tag} Raw: ${items.length} → ${filtered.length} (removed ${items.length - filtered.length} graded)`)
    if (filtered.length >= 2) return filtered
    console.log(`${tag} Raw: fewer than 2 remain, keeping full set`)
    return items
  }
  const filtered = items.filter((i) => gradeMatch(i.title, grade))
  console.log(`${tag} ${grade}: ${items.length} → ${filtered.length} match`)
  if (filtered.length >= 2) return filtered
  console.log(`${tag} ${grade}: fewer than 2 remain, keeping full set`)
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
  const ms90 = 90 * 24 * 60 * 60 * 1000

  return items
    .filter((i) => parseFloat(i.price?.value || 0) > 0)
    .filter((i) => !grade || gradeMatch(i.title, grade))
    .filter((i) => {
      const d = i.itemEndDate || i.itemCreationDate
      return d && now - new Date(d).getTime() <= ms90
    })
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

// ─── QUERY PREPROCESSOR ──────────────────────────────────────────────────────

// Rarity codes to extract and preserve
const RARITY_CODES = ['IMIR', 'SIR', 'SCR', 'SPR', 'SAR', 'SSR', 'SEC', 'ACE', 'UR', 'SR', 'RR', 'UC', 'CHR', 'AR']

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
  return {
    a: { q: base, label: 'All sold (90d)', weight: 0.25, limit: 40, sort: 'endingSoonest' },
    b: { q: base, label: 'Recent sold (30d)', weight: 0.45, limit: 15, sort: 'newlyListed' },
    c: {
      q: base,
      label: `Grade-exact (${grade || 'raw'})`,
      weight: 0.3,
      limit: 30,
      sort: 'endingSoonest',
    },
  }
}

// ─── WEIGHTED BLEND ──────────────────────────────────────────────────────────
function blend(results) {
  const active = results.filter((r) => r.stats !== null)
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

  const { q, grade = 'Raw', lang = 'English', history } = req.query
  console.log('Grade received:', JSON.stringify(grade), '| q:', q)

  // History sub-route
  if (history === '1') return handleHistory(res, q, grade)

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Query too short' })
  }

  try {
    const token = await getToken()
    const { query: processed } = preprocessQuery(q.trim(), grade)
    const queries = buildQueries(processed, grade, lang)

    // Three queries in parallel — one failure doesn't kill the others
    const [dataA, dataB, dataC] = await Promise.allSettled([
      ebaySearch(queries.a.q, token, { limit: queries.a.limit, sort: queries.a.sort }),
      ebaySearch(queries.b.q, token, { limit: queries.b.limit, sort: queries.b.sort }),
      ebaySearch(queries.c.q, token, { limit: queries.c.limit, sort: queries.c.sort }),
    ])

    const itemsA =
      dataA.status === 'fulfilled' ? dataA.value.itemSummaries || [] : []
    const itemsB =
      dataB.status === 'fulfilled' ? dataB.value.itemSummaries || [] : []
    const itemsC =
      dataC.status === 'fulfilled' ? dataC.value.itemSummaries || [] : []

    let results = [
      { ...queries.a, stats: calcStats(filterByGrade(itemsA, grade, 'A')) },
      { ...queries.b, stats: calcStats(filterByGrade(itemsB, grade, 'B')) },
      { ...queries.c, stats: calcStats(filterByGrade(itemsC, grade, 'C')) },
    ]

    let blended = blend(results)
    let allItems = [...itemsA, ...itemsB, ...itemsC]

    // Fallback: strip last word and retry when comps are too thin
    if ((!blended || blended.totalComps < 3) && processed.split(/\s+/).length > 1) {
      const fallbackName = processed.split(/\s+/).slice(0, -1).join(' ')
      const fbQueries = buildQueries(fallbackName, grade, lang)
      const [fbA, fbB, fbC] = await Promise.allSettled([
        ebaySearch(fbQueries.a.q, token, { limit: fbQueries.a.limit, sort: fbQueries.a.sort }),
        ebaySearch(fbQueries.b.q, token, { limit: fbQueries.b.limit, sort: fbQueries.b.sort }),
        ebaySearch(fbQueries.c.q, token, { limit: fbQueries.c.limit, sort: fbQueries.c.sort }),
      ])
      const fbItemsA = fbA.status === 'fulfilled' ? fbA.value.itemSummaries || [] : []
      const fbItemsB = fbB.status === 'fulfilled' ? fbB.value.itemSummaries || [] : []
      const fbItemsC = fbC.status === 'fulfilled' ? fbC.value.itemSummaries || [] : []
      const fbResults = [
        { ...fbQueries.a, stats: calcStats(filterByGrade(fbItemsA, grade, 'fbA')) },
        { ...fbQueries.b, stats: calcStats(filterByGrade(fbItemsB, grade, 'fbB')) },
        { ...fbQueries.c, stats: calcStats(filterByGrade(fbItemsC, grade, 'fbC')) },
      ]
      const fbBlended = blend(fbResults)
      if (fbBlended && fbBlended.totalComps > (blended?.totalComps || 0)) {
        results = fbResults
        blended = fbBlended
        allItems = [...fbItemsA, ...fbItemsB, ...fbItemsC]
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
        const qLower = q.trim().toLowerCase()
        const qWords = qLower.split(/\s+/)
        // Terms that signal a specific rare variant — if the query contains them,
        // heavily prefer images from listings that also contain them.
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
      sourceBreakdown: results.map((r) => ({
        label: r.label,
        weight: r.weight,
        available: r.stats !== null,
        avg: r.stats?.avg || null,
        count: r.stats?.count || 0,
      })),
      comps: extractComps(deduped, 10, grade),
      query: q,
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
