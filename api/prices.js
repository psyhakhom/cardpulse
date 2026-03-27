// ─── SUPABASE CLIENT ────────────────────────────────────────────────────────
// Uses raw fetch to Supabase REST API — no external dependency needed
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const _sbConfigured = !!(SUPABASE_URL && SUPABASE_KEY)
console.log(`[supabase] configured: ${_sbConfigured}, URL: ${SUPABASE_URL ? 'set' : 'missing'}, KEY: ${SUPABASE_KEY ? 'set' : 'missing'}`)

// Cache for Pokemon set total card counts (set_code → count)
const _pkmSetCountCache = {}

async function getPkmSetCount(setCode) {
  if (_pkmSetCountCache[setCode] !== undefined) return _pkmSetCountCache[setCode]
  if (!_sbConfigured) return null
  try {
    // Use limit=0 + Prefer:count=exact to get only the count via content-range header
    const url = `${SUPABASE_URL}/rest/v1/card_catalog?select=card_number&game=eq.pokemon&set_code=eq.${encodeURIComponent(setCode)}&limit=0`
    console.log(`[pkm-set-count] fetching count for set_code=${setCode}`)
    const r = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
      signal: AbortSignal.timeout(3000),
    })
    // PostgREST returns 206 for Range requests or 200 — both are fine
    if (!r.ok && r.status !== 206) { console.log(`[pkm-set-count] fetch failed: ${r.status}`); return null }
    const contentRange = r.headers.get('content-range')
    console.log(`[pkm-set-count] content-range header: ${contentRange}`)
    const count = parseInt(contentRange?.split('/')?.[1] || '0', 10)
    if (count > 0) {
      _pkmSetCountCache[setCode] = count
      console.log(`[pkm-set-count] ${setCode} → ${count} cards (cached)`)
    }
    return count || null
  } catch (e) { console.log(`[pkm-set-count] error: ${e.message}`); return null }
}

function sbFetch(table, method, body, options = {}) {
  if (!_sbConfigured) return Promise.resolve({ error: 'not configured' })
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: options.prefer || 'return=minimal',
  }
  let url = `${SUPABASE_URL}/rest/v1/${table}`
  if (options.query) url += `?${options.query}`
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => {
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        return { error: `${r.status}: ${text.slice(0, 200)}` }
      }
      if (options.parseJson) return { data: await r.json(), error: null }
      return { error: null }
    })
    .catch((err) => ({ error: err.message }))
}

/**
 * CardPulse — /api/prices.js
 * Vercel serverless function
 *
 * Four-query eBay blending strategy:
 *
 *  Query A  "all sold"       — broadest, last 90 days, no filters
 *  Query B  "recent sold"    — last 30 days (sort=newlyListed)
 *  Query C  "grade-exact"    — adds grade string to query
 *  Query D  "ending soon"    — live auctions ending <24h, 3+ bids  (sports only)
 *
 *  Weights split by card type:
 *    TCG (dbs/pokemon/mtg/lorcana/yugioh/onepiece): A=0.30, B=0.50, C=0.20, D=skip
 *    Sports (sr/sg):                                 A=0.20, B=0.30, C=0.25, D=0.25
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
  { limit = 40, sort = 'endingSoonest', marketplaceId = 'EBAY_US', live = false, global = false, days = 90 } = {}
) {
  // Strip apostrophes (straight + smart) — they break eBay search matching
  // Strip leading dashes on words — eBay interprets "-Sign-" as exclusion operator
  // Strip promo/parallel suffixes (_PR, _PR02, _p1) — catalog identifiers, not eBay terms
  // Also strip (-P2) name suffixes and -P2 card number suffixes
  query = query.replace(/['''`]/g, '').replace(/\s*\(-?P\d+\)/gi, '').replace(/_PR\d*/gi, '').replace(/_p\d+/gi, '').replace(/(\d{2,3})-P\d+/gi, '$1').replace(/\s+-/g, ' ').replace(/^-/, '').replace(/\s+/g, ' ').trim()
  console.log(`[ebay query] q="${query}" live=${live} global=${global} days=${days}`)
  const locFilter = global ? '' : ',itemLocationCountry:US'
  let filter
  if (live) {
    const now = new Date().toISOString()
    const in48h = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    filter = `buyingOptions:{AUCTION},itemEndDate:[${now}..${in48h}]${locFilter}`
  } else {
    // soldItems:true is required — without it eBay only searches active listings.
    // itemEndDate range added to exclude active listings that leak through soldItems:true.
    // dropStale() remains as a safety net for any that slip through.
    const now = new Date()
    const cutoffDate = new Date(now - days * 24 * 60 * 60 * 1000)
    const nowISO = now.toISOString().split('.')[0] + 'Z'
    const cutoffISO = cutoffDate.toISOString().split('.')[0] + 'Z'
    console.log(`[ebay] itemEndDate filter: ${cutoffISO} .. ${nowISO}`)
    filter = `buyingOptions:{FIXED_PRICE|AUCTION},soldItems:true,itemEndDate:[${cutoffISO}..${nowISO}]${locFilter}`
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
    if (res.status === 429) {
      console.error(`[ebay] rate limited (429) — too many requests`)
      throw new Error('eBay rate limit reached. Please try again in a few minutes.')
    }
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
    '100x', '50x', '25x', '10x',
    '2 card', '3 card', '4 card', '5 card', '10 card', '21 card',
    'booster box', 'booster pack', 'manga booster', 'booster 01', 'sealed',
    'single card lot', 'parallel single', 'card lot', 'lot psa', 'lot bgs', 'lot cgc',
    'father & son', 'father son', 'father/son',
    'bulk', 'bulk lot', 'wholesale', 'random card', 'random lot',
    'buy 3 get 1', 'buy 2 get 1', 'buy 1 get 1', 'bogo', 'get 1 free', 'get one free',
    // Code cards and digital products
    'code card', 'digital code', 'online code', 'tcg online', 'tcgo', 'ptcgo',
    'redeem', 'reward card', 'rewards card', 'digital version',
    // Heavily damaged condition (lightly played is OK)
    'heavily played', 'poor condition', 'damaged condition', 'damaged card',
    // Multi-word phrases safe for includes() (no false-positive risk)
    'gem mint', 'gem-mint', 'black label',
  ],
}

function gradeMatch(title, grade) {
  const t = (title || '').toLowerCase()
  if (grade === 'PSA 10') {
    if (t.includes('psa 9') || t.includes('psa9')) return false
    if (/\b(equal|equivalent)\b/.test(t)) return false
    if (/\bbgs\s*9\.5\b/.test(t)) return false
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

// ─── GRADED SLAB DETECTION ──────────────────────────────────────────────────
// Standalone function — called as double filter: once before filterItems,
// once inside filterItems. A graded slab can NEVER appear in Raw results.
function isGradedSlab(title) {
  const t = (title || '').toLowerCase()
  // 1. Grading company + number: psa 10, bgs 9.5, cgc9, etc
  if (/\b(psa|bgs|cgc|sgc|scg|hga|ace|gma|beckett|mnt|tag|ags|era|rcg|ars|ksa|pgs|cga|csg|ccg)\s*\d/.test(t)) return true
  // 1a. Arena Club grading — "ARENA 10", "ARENA 9" (requires number to avoid false positives)
  if (/\barena\s+\d/i.test(t)) return true
  // 1b. Standalone grading company name (no number) — catches "SCG graded" etc
  if (/\bscg\b/.test(t)) return true
  // 2. Grading keywords anywhere in title
  if (/\b(graded|slab|slabbed|encased|gem\s*mint|black\s*label|pristine|population|pop\s*\d|cert\s*\d|registry|authenticated)\b/.test(t)) return true
  // 3. Grade patterns: "gem 10", "pristine 10", "perfect 10", "mint 10"
  if (/\b(gem|pristine|perfect|mint)\s*\d+\.?\d*\b/.test(t)) return true
  // 4. Reversed: "10 gem mint", "9.5 mint", "10 pristine"
  if (/\b\d+\.?\d*\s*(gem\s*mint|mint|pristine|perfect|grade)\b/.test(t)) return true
  // 5. Standalone numeric grade at end of title after rarity: "SPR 9.5", "SCR 10"
  if (/\b(SPR|SCR|SR|UR|SEC|SSR)\s+\d+\.?\d*\s*$/i.test(t)) return true
  return false
}

// 2. Variant terms — exclude from ALL queries unless query itself contains the term
const VARIANT_TERMS = [
  // Art variants
  { query: /\balt\b/i, title: /\b(alt(?:ernate)?|alternative)\s*art\b/i },
  { query: /\bsuper\s*parallel\b/i, title: /\bsuper\s*parallel\b|\bsp\s*card\b|\bsp\s*parallel\b/i },
  { query: /\bfull\s*art\b/i, title: /\bfull\s*art\b/i },
  { query: /\bSAR\b/, title: /\bSAR\b/ },
  { query: /\bbooster\b/i, title: /\bmanga\s*booster\b|\bbooster\b/i },
  // One Piece premium parallels
  { query: /\bwanted\b/i, title: /\bwanted\s*(poster|parallel)\b/i, _skipWhenQueryContains: /\bwanted\s*poster\b/i },
  { query: /\bmanga\s*(art|version)\b/i, title: /\bmanga\s*(art|version)\b/i },
  { query: /\bSPC\b/i, title: /\bSPC\b/i },
  // Anniversary/special sets — different product from base release
  { query: /\banniversary\b/i, title: /\b\d+(?:st|nd|rd|th)\s*anniversary\b|\banniversary\s*(?:set|card|collection|edition)\b/i },
  // Foil/special finish variants
  { query: /\bsilver\b/i, title: /\bsilver\b/i },
  { query: /\bgold\b/i, title: /\bgold\b/i },
  { query: /\bfoil\b/i, title: /\bfoil\b/i },
  { query: /\brainbow\b/i, title: /\brainbow\b/i },
  { query: /\bprismatic\b/i, title: /\bprismatic\b/i },
  { query: /\bchrome\b/i, title: /\bchrome\b/i },
  { query: /\brefractor\b/i, title: /\brefractor\b/i },
  // Token / promo / version variants
  { query: /\btoken\b/i, title: /\btoken\b/i },
  { query: /\bv\.?2\b/i, title: /\bv\.?\s*2\b|\bversion\s*2\b/i },
  { query: /\bpromo\b/i, title: /\bpromo(?:tional)?\b|\bpromo\s*card\b/i },
  // Memorabilia / relic cards — premium inserts, not standard cards (_sports: apply on sports path too)
  { query: /\brelics?\b/i, title: /\brelics?\b/i, _sports: true },
  { query: /\bpatche?s?\b/i, title: /\bpatche?s?\b/i, _sports: true },
  { query: /\bjerseys?\b/i, title: /\bjerseys?\b/i, _sports: true },
  { query: /\bswatche?s?\b/i, title: /\bswatche?s?\b/i, _sports: true },
  { query: /\bgame.?used\b/i, title: /\bgame[\s-]?used\b/i, _sports: true },
  { query: /\bmemorabilia\b/i, title: /\bmemorabilia\b/i, _sports: true },
  { query: /\b(gloves?|bat|shoes?|socks?)\b/i, title: /\b(gloves?|bat\s*relics?|shoes?|socks?)\b/i, _sports: true },
  // Event exclusives
  { query: /\bnational\b/i, title: /\b(national\s*convention|the\s*national|convention\s*exclusive|industry\s*summit)\b/i, _sports: true },
  // Ultra-premium parallels
  { query: /\brapture\b/i, title: /\brapture\b/i, _sports: true },
  { query: /\bshimmer\b/i, title: /\bshimmer\b/i, _sports: true },
  { query: /\blime\b/i, title: /\blime\b/i, _sports: true },
  { query: /\blava\b/i, title: /\blava\b/i, _sports: true },
  { query: /\bdisco\b/i, title: /\bdisco\b/i, _sports: true },
  { query: /\bvortex\b/i, title: /\bvortex\b/i, _sports: true },
  { query: /\bpulsar\b/i, title: /\bpulsar\b/i, _sports: true },
  { query: /\bcosmic\b/i, title: /\bcosmic\b/i, _sports: true },
  { query: /\bnebula\b/i, title: /\bnebula\b/i, _sports: true },
  { query: /\bcracked\s*ice\b/i, title: /\bcracked\s*ice\b/i, _sports: true },
  { query: /\btiger\s*stripe\b/i, title: /\btiger\s*stripe\b/i, _sports: true },
  // Always excluded — sealed product SKUs and non-card products
  { query: /(?!)/, title: /\bARS\s*\d/i, _skipWhenQueryContains: /\b(OP|ST|EB)\d{1,2}-\d{3}\b/i },
  { query: /(?!)/, title: /\b(figure|plush|sleeve|deck\s*box|binder|album|tin|display|box\s*set|magnetic|lighter)\b/i },
  { query: /(?!)/, title: /\b(manga\s*volume|vol\.\s*\d|volume\s*\d)\b/i },
  // Always excluded — fan art, custom/proxy cards, third-party products
  { query: /(?!)/, title: /\b(fan\s*art|fanart|ai\s*art|custom\s*card|proxy|proxies)\b/i },
  { query: /(?!)/, title: /\b(interdimensional\s*cable|sia0)\b/i },
]
// Note: "holo" excluded from VARIANT_TERMS — it's a base rarity for Pokemon.
// It's handled separately inside filterItems with a game-type check.

// 3. Language bleed — exclude foreign language listings when language filter is set
const LANG_EXCLUDE = {
  English: /\b(japanese|japan|jpn|jp\s+ver|korean|korean\s*ver|chinese|cross\s*worlds)\b|\bJP\b|\b(?:dragon\s*ball\s*super|dbs(?:cg)?)\s*master\b/i,
  Japanese: /\b(english|eng\s*ver|korean|chinese)\b/i,
}

// 4. Additional Raw exclusion patterns (signed/autograph)
const RAW_EXCLUDE_PATTERNS = [
  /\bsigned\b/i,
  /\bautograph(?:ed)?\b/i,
  /\bauto\b/i,
  /\bsignature\b/i,
  /\bheavily\s*played\b/i,
  /\b(poor|damaged)\b/i,
]

function filterItems(items, grade, searchQuery, lang, opts = {}) {
  if (!items?.length) return items
  const ql = (searchQuery || '').toLowerCase()

  // ── 0. Minimum price filter — strip invalid/junk $0 listings ──────────
  let filtered = items.filter((i) => parseFloat(i.price?.value || 0) >= 0.50)

  // Detect sports card queries — skip TCG-specific filters (set codes, holo, foil etc)
  const SPORTS_RE = /\b(rookie|rc\b|refractor|prizm|topps|bowman|panini|donruss|select|optic|mosaic|fleer|upper\s*deck|score|nfl|nba|mlb|nhl|quarterback|qb|mvp|draft\s*pick)\b/i
  const TCG_RE = /\b(pokemon|pokémon|pikachu|charizard|mewtwo|eevee|bulbasaur|squirtle|gengar|deoxys|rayquaza|jirachi|gardevoir|blaziken|sceptile|swampert|flygon|mtg|magic|yugioh|yu-gi-oh|lorcana|dragon\s*ball|dbs|one\s*piece|digimon|holon\s*phantoms|holon|delta\s*species|legend\s*maker|unseen\s*forces|hidden\s*legends|team\s*rocket\s*returns|firered\s*leafgreen|team\s*magma|team\s*aqua|sandstorm|expedition|aquapolis|skyridge|neo\s*genesis|neo\s*discovery|neo\s*revelation|neo\s*destiny|gym\s*heroes|gym\s*challenge|jungle|fossil|base\s*set|rare\s*holo|rare\s*ultra|vmax|vstar|gx\s*card|fortuneteller\s*baba|master\s*roshi|oolong|puar|ox.king|chichi|chi.chi|launch|turtle\s*hermit|kame|yamcha|tien|chiaotzu|raditz|nappa|zarbon|dodoria|ginyu|recoome|burter|jeice|guldo)\b/i
  const isSportsQuery = SPORTS_RE.test(ql) && !TCG_RE.test(ql)
  if (isSportsQuery) console.log(`[filter] sports card query detected`)

  // ── 1. Graded slab hard block (Raw only) — runs FIRST, no bypass ──────
  if (grade === 'Raw') {
    filtered = filtered.filter((i) => {
      if (isGradedSlab(i.title)) {
        console.log(`[filter:slab] dropped "${(i.title || '').slice(0, 70)}"`)
        return false
      }
      return true
    })
    console.log(`[filter:slab] ${items.length} → ${filtered.length} after graded slab hard block`)
  }

  // ── 1b. Lot/multi-card exclusion (all grades) ────────────────────────
  // Lots and multi-card listings are never valid comps regardless of grade.
  {
    const LOT_RE = /\b(\d+\s*card\s*lot|lot\s*of\s*\d+|card\s*lot|lot\s*psa|lot\s*bgs|lot\s*cgc|father\s*[&\/]\s*son|father\s+son|complete\s*set|bundle|\d+\s*more\s*(?:rookie|card)s?)\b|\blot\s*\(\d+\)|\b(pick\s*your\s*card|pick\s*your|you\s*pick|choose\s*your)\b/i
    // Multi-card listing: 3+ card numbers in one title (e.g. "FB07-113, FB07-009, FB07-057")
    const MULTI_CARD_RE = /[A-Z]{1,4}\d+-\d+.*,.*[A-Z]{1,4}\d+-\d+.*,.*[A-Z]{1,4}\d+-\d+/i
    const before = filtered.length
    filtered = filtered.filter((i) => {
      const t = i.title || ''
      if (LOT_RE.test(t)) {
        console.log(`[filter:lot] dropped "${t.slice(0, 70)}"`)
        return false
      }
      if (MULTI_CARD_RE.test(t)) {
        console.log(`[filter:lot] dropped multi-card listing: "${t.slice(0, 70)}"`)
        return false
      }
      return true
    })
    if (filtered.length < before) console.log(`[filter:lot] ${before} → ${filtered.length}`)
  }

  // ── 1c. Merchandise exclusion (MTG primarily) ───────────────────────
  // Drop sleeves, playmats, deck boxes, blankets, proxies and other non-card items
  {
    const MERCH_RE = /\b(sleeves?|deck\s*box|deckbox|playmat|play\s*mat|gaming\s*mat|selling\s*mat|vendor\s*mat|blanket|pillow|poster|art\s*print|oversized|jumbo|6\s*(?:by|x)\s*9|card\s*art|art\s*card|matte\s*art|textured\s*matte|throw|fleece|phone\s*case|keychain|sticker|shirt|hoodie|prox(?:y|ies)|custom\s*card|display\s*card|replica|enamel\s*pin|pin\s*set|pin\s*badge|lapel\s*pin|vendor\s*booth|booth\s*organizer|accessor(?:y|ies)|card?\s*binder|card?\s*album|storage\s*box|card\s*storage|display\s*case|acrylic\s*case|3d\s*print(?:ed)?|wristband|bracelet|lanyard|mouse\s*pad|mousepad|tapestry|flag|banner|figur(?:e|ine)|statue|rulebook|guide\s*book)\b/i
    const before = filtered.length
    filtered = filtered.filter(i => {
      const t = i.title || ''
      if (MERCH_RE.test(t)) {
        console.log(`[filter:merch] dropped "${t.slice(0, 70)}"`)
        return false
      }
      return true
    })
    if (filtered.length < before) console.log(`[filter:merch] ${before} → ${filtered.length}`)
  }

  // ── 2. Variant exclusion ─────────────────────────────────────────────
  // For sports cards: only apply "always excluded" variants (sealed, fan art, memorabilia)
  // For TCG cards: apply all variant terms
  // Skip for parallel queries — targeted queries already ensure correct variant
  const preVariantFiltered = [...filtered] // snapshot before variant filtering
  if (!opts.skipVariants) for (const vt of VARIANT_TERMS) {
    // Sports queries skip TCG-specific variants (foil, holo, chrome, refractor, silver, gold, rainbow, prismatic)
    // but keep: memorabilia (_sports), sealed product (/(?!)/), fan art (/(?!)/)
    if (isSportsQuery && !vt._sports && vt.query.toString() !== '/(?!)/') continue
    if (vt._skipWhenQueryContains && vt._skipWhenQueryContains.test(ql)) continue
    if (!vt.query.test(ql)) {
      const before = filtered.length
      filtered = filtered.filter((i) => {
        const t = i.title || ''
        if (vt.title.test(t)) {
          console.log(`[filter:variant] dropped "${t.slice(0, 70)}" matched "${vt.title}"`)
          return false
        }
        return true
      })
      if (filtered.length < before) console.log(`[filter:variant] ${before} → ${filtered.length}`)
    }
  }
  // If variant filter gutted results, fall back to pre-variant state (not original items).
  // This preserves slab exclusion from step 1.
  if (filtered.length < 2) {
    console.log(`[filter:variant] fallback: ${filtered.length} → ${preVariantFiltered.length} (pre-variant)`)
    filtered = preVariantFiltered
  }

  // ── 2b. Holo exclusion (non-Pokemon only, skip for sports and parallel) ──
  if (!isSportsQuery && !opts.skipVariants) {
    const isPokemon = /\bpokemon\b|\bpokémon\b|\bcharizard\b|\bpikachu\b/i.test(ql)
    if (!isPokemon && !/\bholo\b/i.test(ql)) {
      const before = filtered.length
      const holoFiltered = filtered.filter((i) => !/\bholo\b/i.test(i.title || ''))
      if (holoFiltered.length >= 2) {
        filtered = holoFiltered
        if (filtered.length < before) console.log(`[filter:holo] ${before} → ${filtered.length}`)
      }
    }
  }

  // ── 2b2. Reverse holo exclusion (Pokemon only) ──────────────────────
  // Reverse holos are a different product with very different prices.
  // Exclude unless the user explicitly searched for them.
  if (!isSportsQuery && !/\b(reverse|rev[\s.-]?holo|rholo)\b/i.test(ql)) {
    const before = filtered.length
    const revFiltered = filtered.filter((i) => {
      if (/\b(reverse[\s-]?holo|rev[\s.-]?holo|rholo)\b/i.test(i.title || '')) {
        console.log(`[filter:revholo] dropped "${(i.title || '').slice(0, 70)}"`)
        return false
      }
      return true
    })
    if (revFiltered.length >= 2) {
      filtered = revFiltered
      if (filtered.length < before) console.log(`[filter:revholo] ${before} → ${filtered.length}`)
    }
  }

  // ── 2c. Wrong set code exclusion (TCG only, skip for sports and parallel) ──
  if (!isSportsQuery && !opts.skipVariants) {
    const SET_CODE_RE = /\b(BT|FB|FS|SD|SB|EB|TB|PUMS|SDBH|SV|SM|XY|BW|DP|EX|OP|ST)\d+[A-Z]?\b/i
    const querySetMatch = ql.match(SET_CODE_RE)
    if (querySetMatch) {
      const querySet = querySetMatch[0].toUpperCase()
      const before = filtered.length
      const setFiltered = filtered.filter((i) => {
        const t = (i.title || '').toUpperCase()
        if (!t.includes(querySet)) {
          console.log(`[filter:set] dropped "${(i.title || '').slice(0, 70)}" missing set ${querySet}`)
          return false
        }
        return true
      })
      if (setFiltered.length >= 2) {
        filtered = setFiltered
        console.log(`[filter:set] ${before} → ${filtered.length} enforcing set ${querySet}`)
      }
    }
  }

  // ── 2d. Card name enforcement ─────────────────────────────────────────
  // Extract the card name from the query (non-modifier, non-set-code words).
  // If we have a card name, require comps to contain at least one name word.
  // Prevents "Vespiquen ex SV3" from appearing in "charizard ex sv3" results.
  const MODIFIER_RE = /^(?:SIR|SCR|SPR|SR|UR|SEC|SAR|EX|GX|V|VMAX|VSTAR|NM|raw|near|mint|card|english|holo|reverse|rare|promo|rookie|base|set|1st|first|edition|unlimited|parallel|foil|super|secret|special|ultra|common|uncommon)$/i
  const SET_CODE_WORD_RE = /^(?:[A-Z]{1,4}-?\d+(?:-\d+)?[A-Z]?|\d{1,3}\/\d{1,3})$/i
  const nameWords = ql.split(/\s+/).filter(w => w.length >= 3 && !MODIFIER_RE.test(w) && !SET_CODE_WORD_RE.test(w))
  if (nameWords.length > 0) {
    const before = filtered.length
    const nameFiltered = filtered.filter((i) => {
      const t = (i.title || '').toLowerCase()
      if (nameWords.every(w => t.includes(w))) return true
      console.log(`[filter:name] dropped "${(i.title || '').slice(0, 70)}" — no match for [${nameWords.join(', ')}]`)
      return false
    })
    if (nameFiltered.length >= 1) {
      filtered = nameFiltered
      if (filtered.length < before) console.log(`[filter:name] ${before} → ${filtered.length} enforcing card name [${nameWords.join(', ')}]`)
    }
  }

  // ── 3. Language exclusion (all grades) ────────────────────────────────
  // Always apply — wrong-language items must never remain, even if it leaves 0-1 results.
  // Better to have fewer comps than wrong-language comps polluting the average.
  const langRe = LANG_EXCLUDE[lang]
  if (langRe) {
    const before = filtered.length
    filtered = filtered.filter((i) => {
      const t = i.title || ''
      if (langRe.test(t)) {
        console.log(`[filter:lang] dropped "${t.slice(0, 70)}" wrong language`)
        return false
      }
      return true
    })
    if (filtered.length < before) {
      console.log(`[filter:lang] ${before} → ${filtered.length} after language filter`)
    }
  }

  // ── 3b. Cheap code card / bulk lot exclusion ────────────────────────
  // If price < $3 AND title matches junk patterns, exclude regardless
  const JUNK_CHEAP_RE = /\b(code|digital|redeem|reward|bulk|lot|wholesale|random)\b/i
  {
    const before = filtered.length
    filtered = filtered.filter((i) => {
      const price = parseFloat(i.price?.value || 0)
      if (price > 0 && price < 3 && JUNK_CHEAP_RE.test(i.title || '')) {
        console.log(`[filter:junk] dropped $${price} "${(i.title || '').slice(0, 70)}" cheap code/bulk`)
        return false
      }
      return true
    })
    if (filtered.length < before) console.log(`[filter:junk] ${before} → ${filtered.length} after cheap junk removal`)
  }

  // ── 4. Grade-specific filtering ───────────────────────────────────────
  // Save state after identity filters (name/lang/set) — Raw grade fallback must
  // never restore items dropped by these filters.
  const afterIdentityFilters = [...filtered]

  let excludeTerms = GRADE_EXCLUDE[grade]
  // For parallel queries, remove booster/parallel/alt-art terms from grade exclusion
  // — these are the exact products we're searching for
  if (excludeTerms && opts.skipVariants) {
    const PARALLEL_SAFE = /manga booster|booster 01|booster pack|booster box|parallel single|parallel scr|gold parallel|gold alt art|sealed/
    excludeTerms = excludeTerms.filter(kw => !PARALLEL_SAFE.test(kw))
  }
  if (excludeTerms) {
    const kept = filtered.filter((i) => {
      const t = (i.title || '').toLowerCase()
      const hit = excludeTerms.find((kw) => t.includes(kw))
      if (hit) { console.log(`[filter:Raw] dropped "${i.title?.slice(0, 70)}" matched "${hit}"`); return false }
      const patHit = RAW_EXCLUDE_PATTERNS.find((re) => re.test(t))
      if (patHit) { console.log(`[filter:Raw] dropped "${i.title?.slice(0, 70)}" matched pattern`); return false }
      return true
    })
    console.log(`[filter:Raw] ${filtered.length} → ${kept.length} kept`)
    if (kept.length >= 2) return kept
    // Fallback: restore to post-identity-filter state (preserves name/lang/set drops)
    // but still exclude graded slabs
    const safeItems = afterIdentityFilters.filter((i) => !isGradedSlab(i.title))
    console.log(`[filter:Raw] fallback: ${kept.length} → ${safeItems.length} (post-identity, pre-grade)`)
    return safeItems
  }
  if (grade && grade !== 'Raw') {
    const kept = filtered.filter((i) => gradeMatch(i.title, grade))
    console.log(`[filter:${grade}] ${filtered.length} → ${kept.length} match`)
    // Never fall back to ungraded cards for graded searches — 0 comps is better than wrong data
    return kept
  }
  return filtered
}

function calcStats(items, label) {
  if (!items?.length) return null
  // Log each comp's price, title, and date for debugging
  if (label) {
    for (const i of items) {
      const p = parseFloat(i.price?.value || 0)
      const d = (i.itemEndDate || i.itemCreationDate || '').slice(0, 10)
      const cur = i.price?.currency || '?'
      const loc = i.itemLocation?.country || '?'
      console.log(`[calcStats:${label}] $${p} ${cur} ${loc} ${d} "${(i.title || '').slice(0, 70)}"`)
    }
  }
  let prices = items
    .map((i) => parseFloat(i.price?.value))
    .filter((p) => !isNaN(p) && p > 0)
    .sort((a, b) => a - b)
  if (prices.length < 1) return null

  // Special case: 2 comps with extreme spread (>10x) — drop the outlier
  if (prices.length === 2 && prices[1] > prices[0] * 10) {
    if (label) console.log(`[calcStats:${label}] 2-comp extreme spread: $${prices[0]} vs $${prices[1]} (${(prices[1]/prices[0]).toFixed(0)}x) — keeping lower`)
    prices = [prices[0]]
  }

  const mid = Math.floor(prices.length / 2)
  const median = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2

  // For small comp sets (<=5), use tighter outlier bounds:
  // remove anything >2x median (high) or <40% of median (low).
  // For larger sets, use the standard 20%/3x bounds.
  // Hard cap: any comp >50x median is always an extreme outlier (e.g. $148,888 vs $20 median)
  const preExtreme = prices.length
  prices = prices.filter((p) => p <= median * 50)
  if (label && prices.length < preExtreme) console.log(`[calcStats:${label}] extreme outlier: removed ${preExtreme - prices.length} items >50x median ($${median})`)
  if (prices.length < 1) return null

  const isSmall = prices.length <= 5
  const loThresh = isSmall ? median * 0.4 : median * 0.2
  const hiThresh = isSmall ? median * 2 : median * 3
  const clipped = prices.filter((p) => p >= loThresh && p <= hiThresh)
  if (label && clipped.length < prices.length) {
    console.log(`[calcStats:${label}] outlier removal: ${prices.length} → ${clipped.length} (median=$${median}, bounds=$${loThresh.toFixed(0)}-$${hiThresh.toFixed(0)})`)
  }
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
  // Items are already date-filtered and grade-filtered upstream in runQueries.
  // This function just formats for display + final safety nets.
  const priced = items.filter((i) => parseFloat(i.price?.value || 0) > 0)
  // Final safety net: graded slabs must NEVER appear in Raw comps
  const slabFree = grade === 'Raw'
    ? priced.filter((i) => {
        if (isGradedSlab(i.title)) {
          console.log(`[extractComps:slab] final safety net caught: "${(i.title || '').slice(0, 70)}"`)
          return false
        }
        return true
      })
    : priced

  return slabFree
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
  'lucario', 'greninja', 'alakazam', 'bulbasaur', 'squirtle', 'deoxys', 'jirachi',
  'blaziken', 'sceptile', 'swampert', 'flygon']

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
  // Whitelist: always preserved, never spell-corrected
  'granting','wishing','dragon','ultra','instinct','future','supreme',
  'blazing','awakened','fusion','limit','breaker','shenron','wish',
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
  // 1. Exact map hit — known misspellings only
  if (SPELL_MAP[wl]) return SPELL_MAP[wl]
  // 2. Already a known term — no correction needed
  if (KNOWN_TERMS.includes(wl)) return word
  // 3. Short words and numbers — don't touch
  if (wl.length <= 5 || /^\d/.test(wl)) return word
  // 4. Common English words — never correct these, they're valid
  if (/^(granting|wishing|dragon|super|power|energy|attack|guard|strike|battle|master|spirit|cosmic|divine|eternal|ancient|mighty|sacred|golden|silver|shadow|knight|leader|future|world|force|magic|flame|storm|light|heart|sword|giant|royal|metal|steel|stone|thunder|crystal|phantom|ultimate|infinite|awakened|unleashed|absolute|supreme|majestic|celestial|legendary|mythical|original|pristine|standard|premium|limited|special|classic|modern|vintage)$/i.test(wl)) return word
  // 5. Levenshtein — only correct words very close to known card terms
  // Require distance 1 for words ≤8 chars, distance 2 for longer words
  const maxDist = wl.length <= 8 ? 1 : 2
  let best = null, bestDist = maxDist + 1
  for (const term of KNOWN_TERMS) {
    if (Math.abs(term.length - wl.length) > maxDist) continue
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

// ─── RARITY NORMALIZATION ────────────────────────────────────────────────────
// Normalize rarity aliases to canonical forms BEFORE any other preprocessing.
// Order matters: longer/more specific patterns must come first.
// `tier` tracks the starred rarity for DBS (SR vs SR* vs SCR vs SCR** etc)
const RARITY_ALIASES = [
  // DBS / Fusion World — starred variants (longest first)
  { re: /\bscr\s*(?:double\s*alt|double\s*star|\*\*)/gi, to: 'SCR', tier: 'SCR**' },
  { re: /\bscr\s*(?:alt(?:ernate)?(?:\s*art)?|\+|\*)/gi, to: 'SCR', tier: 'SCR*' },
  { re: /\bsr\s*(?:alt(?:ernate)?(?:\s*art)?|\+|\*)/gi, to: 'SR', tier: 'SR*' },
  // Pokemon — multi-word aliases (longest first)
  { re: /\bspecial\s*illustration\s*rare\b/gi, to: 'SIR' },
  { re: /\billustration\s*rare\b/gi, to: 'IR' },
  { re: /\bspecial\s*art\s*rare\b/gi, to: 'SAR' },
  { re: /\balternate\s*art\b/gi, to: 'ALT' },
  { re: /\balt\s*art\b/gi, to: 'ALT' },
  { re: /\bfull\s*art\b/gi, to: 'FA' },
  { re: /\btrainer\s*gallery\b/gi, to: 'TG' },
  // MTG
  { re: /\bextended\s*art\b/gi, to: 'EA' },
  // One Piece
  { re: /\bsecret\s*(?:rare\s*)?alt\b/gi, to: 'SEC' },
  { re: /\bleader\s*alt\b/gi, to: 'L ALT' },
  // Single-word abbreviation aliases (must come AFTER multi-word)
  { re: /\bsar\b/gi, to: 'SAR' },
  { re: /\bsir\b/gi, to: 'SIR' },
  { re: /\b(?:ir)\b/gi, to: 'IR' },
  { re: /\bea\b/gi, to: 'EA' },
  { re: /\btg\b/gi, to: 'TG' },
]

function normalizeRarity(raw) {
  let q = raw
  let requiredRarity = null
  for (const alias of RARITY_ALIASES) {
    const before = q
    q = q.replace(alias.re, alias.to)
    if (q !== before) {
      console.log(`[rarity-norm] "${before}" → "${q}" (${alias.to}${alias.tier ? ', tier=' + alias.tier : ''})`)
      // Track the starred tier if this alias defines one
      if (alias.tier) requiredRarity = alias.tier
    }
  }
  // If no starred alias matched, detect plain rarity codes (SR, SCR etc)
  // so filterByRarity can exclude starred variants from plain searches
  if (!requiredRarity) {
    if (/\bSCR\b/i.test(q)) requiredRarity = 'SCR'
    else if (/\bSPR\b/i.test(q)) requiredRarity = 'SPR'
    else if (/\bSR\b/i.test(q)) requiredRarity = 'SR'
  }
  if (requiredRarity) console.log(`[rarity-norm] requiredRarity: ${requiredRarity}`)
  return { query: q, requiredRarity }
}

// ─── QUERY PREPROCESSOR ──────────────────────────────────────────────────────

// Rarity codes to extract and preserve
const RARITY_CODES = ['IMIR', 'SIR', 'SCR', 'SPR', 'SAR', 'SSR', 'SEC', 'ACE', 'UR', 'SR', 'RRR', 'RR', 'UC', 'CHR', 'AR', 'ALT', 'FA', 'IR', 'TG', 'EA']

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
  const { query: rarityNormed, requiredRarity } = normalizeRarity(raw)
  const normalised = normalize(rarityNormed)
  const type = detectType(normalised, grade)

  // Short set-code queries are already specific — pass through untouched
  if (type === 'SET_CODE' && normalised.length <= 60) {
    console.log(`[preprocess] type=SET_CODE (passthrough) "${raw}" → "${normalised}"`)
    return { query: normalised, type, tokens: extractTokens(normalised), requiredRarity }
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

  console.log(`[preprocess] type=${type} "${raw}" → "${query}"${requiredRarity ? ' requiredRarity=' + requiredRarity : ''}`)
  return { query, type, tokens, requiredRarity }
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
    b: { q: base, label: 'Recent sold (30d)', weight: 0.45, limit: 20, sort: 'newlyListed' },
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

// TCG weights — no Query D (BIN-dominated, auctions are noise)
const WEIGHTS_TCG = { a: 0.30, b: 0.50, c: 0.20 }
// Sports weights with Query D (auction-dominated market)
const WEIGHTS_SPORTS_WITH_LIVE = { a: 0.20, b: 0.30, c: 0.25, d: 0.25 }
// Sports fallback when Query D has no data
const WEIGHTS_SPORTS_WITHOUT_LIVE = { a: 0.25, b: 0.40, c: 0.35 }

// ─── WEIGHTED BLEND ──────────────────────────────────────────────────────────
function blend(results, isSports) {
  let weightMap
  if (isSports) {
    const hasLive = results.some((r) => r.label === 'Live auctions' && r.stats !== null)
    weightMap = { ...(hasLive ? WEIGHTS_SPORTS_WITH_LIVE : WEIGHTS_SPORTS_WITHOUT_LIVE) }
  } else {
    weightMap = { ...WEIGHTS_TCG }
  }
  const keys = ['a', 'b', 'c', 'd']

  // Query C outlier detection: if C avg is >35% below A+B median, zero out C
  // and redistribute weight to A and B. Catches grade-exact queries that match
  // wrong condition/variant listings.
  const [rA, rB, rC] = results
  if (rC?.stats && rA?.stats && rB?.stats) {
    const abMedian = (rA.stats.avg + rB.stats.avg) / 2
    const shouldZero = rC.stats.avg < abMedian * 0.65
    console.log(`[blend] Query C check: C_avg=$${rC.stats.avg} C_count=${rC.stats.count} AB_median=$${abMedian.toFixed(2)} zeroing=${shouldZero}`)
    if (shouldZero) {
      console.log(`[blend] Query C avg $${rC.stats.avg} is >35% below A+B median $${abMedian.toFixed(2)} — zeroing C weight`)
      const cWeight = weightMap.c || 0
      weightMap.c = 0
      weightMap.a = (weightMap.a || 0) + cWeight / 2
      weightMap.b = (weightMap.b || 0) + cWeight / 2
    }
  } else {
    console.log(`[blend] Query C outlier check skipped: A=${!!rA?.stats} B=${!!rB?.stats} C=${!!rC?.stats}`)
  }

  // Query A stale-data detection: if A avg is >60% below B avg AND B has 3+ comps,
  // A is likely dominated by older cheap variants (UC/common). Zero A, give weight to B.
  if (rA?.stats && rB?.stats && rB.stats.count >= 3 && rA.stats.avg < rB.stats.avg * 0.4) {
    console.log(`[blend] Query A stale: A_avg=$${rA.stats.avg} is >60% below B_avg=$${rB.stats.avg} (B has ${rB.stats.count} comps) — zeroing A`)
    const aWeight = weightMap.a || 0
    weightMap.a = 0
    weightMap.b = (weightMap.b || 0) + aWeight
  }

  // Recency boost: if Query B (recent 30d) has very few comps (1-2) while A has
  // more older comps, the recent price signal is being diluted. Boost B to 0.60
  // so the most recent sale carries majority weight over stale data.
  if (rB?.stats && rA?.stats && rB.stats.count <= 2 && rA.stats.count > rB.stats.count) {
    const oldBw = weightMap.b
    weightMap.b = 0.60
    // Redistribute what we took from other queries proportionally from A (and C if active)
    const excess = weightMap.b - oldBw
    if (weightMap.c > 0) {
      weightMap.a = Math.max(0.05, (weightMap.a || 0) - excess * 0.6)
      weightMap.c = Math.max(0.05, (weightMap.c || 0) - excess * 0.4)
    } else {
      weightMap.a = Math.max(0.05, (weightMap.a || 0) - excess)
    }
    console.log(`[blend] recency boost: B has ${rB.stats.count} recent comps vs A=${rA.stats.count} older — B weight → ${weightMap.b}`)
  }

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
 * Writes one price snapshot row to Supabase price_history.
 * Also upserts a row to card_catalog to build a self-growing card database.
 * NEVER awaited — response goes out before these complete.
 * If Supabase is not configured, silently skipped.
 */
// Track recent writes to prevent duplicates within 60 seconds
const _recentWrites = new Map()

function logPriceHistory({ cardName, grade, lang, lo, avg, hi, confidence, totalComps, trend30 }) {
  console.log(`[debug] logPriceHistory called, _sbConfigured: ${_sbConfigured}, cardName: "${cardName}"`)
  if (!_sbConfigured) { console.log('[debug] logPriceHistory skipped — not configured'); return }

  // Deduplicate: skip if same card+grade+lang was written in last 60 seconds
  const dedupeKey = `${cardName}|${grade}|${lang}`
  const lastWrite = _recentWrites.get(dedupeKey)
  if (lastWrite && Date.now() - lastWrite < 60000) {
    console.log(`[supabase] price_history skipped (duplicate within 60s): "${cardName}"`)
    return
  }
  _recentWrites.set(dedupeKey, Date.now())
  // Clean old entries to prevent memory leak
  if (_recentWrites.size > 100) {
    const now = Date.now()
    for (const [k, v] of _recentWrites) { if (now - v > 60000) _recentWrites.delete(k) }
  }

  sbFetch('price_history', 'POST', {
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
  }).then((r) => {
    if (r.error) console.error('[supabase] price_history write failed:', r.error)
    else console.log(`[supabase] price_history write success: "${cardName}"`)
  })
}

function logCardCatalog({ cardName, game, setCode, rarity, imageUrl, searchQuery }) {
  console.log(`[debug] logCardCatalog called, _sbConfigured: ${_sbConfigured}, cardName: "${cardName}", game: "${game}"`)
  if (!_sbConfigured) { console.log('[debug] logCardCatalog skipped — not configured'); return }

  // Use raw SQL upsert via POST with Prefer: resolution=merge-duplicates
  // The table has unique index on (card_name, game, rarity_key) where
  // rarity_key is a generated column: coalesce(rarity, '')
  // Only include image_url if it's a real official image (not eBay seller photo)
  const safeImageUrl = (imageUrl && !imageUrl.includes('ebayimg.com')) ? imageUrl : null
  const body = {
    card_name: cardName,
    game: game || 'unknown',
    set_code: setCode || null,
    rarity: rarity || null,
    search_query: searchQuery || cardName,
    times_searched: 1,
    last_searched: new Date().toISOString(),
  }
  // Only set image_url if we have a good one — don't overwrite existing official image with null
  if (safeImageUrl) body.image_url = safeImageUrl
  sbFetch('card_catalog', 'POST', body, {
    prefer: 'return=minimal,resolution=merge-duplicates',
  }).then((r) => {
    if (r.error) console.error('[supabase] card_catalog write failed:', r.error)
    else console.log(`[supabase] card_catalog write success: "${cardName}" [${game}]`)
  })
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
  if (!_sbConfigured) return res.status(503).json({ error: 'History not available yet' })

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const params = new URLSearchParams({
    card_name: `eq.${cardName}`,
    grade: `eq.${grade || 'Raw'}`,
    queried_at: `gte.${since}`,
    select: 'queried_at,price_avg,price_lo,price_hi,confidence,comp_count',
    order: 'queried_at.asc',
    limit: '200',
  })

  const result = await sbFetch('price_history', 'GET', null, {
    query: params.toString(),
    prefer: 'return=representation',
    parseJson: true,
  })
  if (result.error) return res.status(500).json({ error: 'History query failed' })
  return res.status(200).json({ history: result.data, card: cardName, grade })
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  console.log('PRICES.JS loaded')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { q, lang = 'English', history, exact, parallel, cardImageUrl } = req.query
  console.log(`[prices] q="${q}"${exact === '1' ? ' exact' : ''}${parallel === '1' ? ' parallel' : ''}`)
  // Normalize grade — ensure exact case match for all filtering logic
  const VALID_GRADES = ['Raw', 'PSA 9', 'PSA 10', 'BGS 10', 'CGC 10', 'BGS 9.5']
  const rawGrade = req.query.grade || 'Raw'
  const grade = VALID_GRADES.find((g) => g.toLowerCase() === rawGrade.toLowerCase()) || 'Raw'
  console.log('Grade received:', JSON.stringify(rawGrade), '→', JSON.stringify(grade), '| q:', q, exact === '1' ? '(exact/catalog)' : '')

  // History sub-route
  if (history === '1') return handleHistory(res, q, grade)

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Query too short' })
  }

  try {
    const token = await getToken()
    // When exact=1 (card catalog selection), skip preprocessor but still extract rarity
    let requiredRarity = null
    let processed
    if (exact === '1') {
      processed = q.trim()
      // Truncate long catalog queries: keep name up to first comma + card number
      // "Vegeta, Combination Attack in Hell BT22-049" → "Vegeta BT22-049"
      const cardNumMatch = processed.match(/\b([A-Z]{1,4}\d+-\d{3}[A-Z]?)\b/i)
      if (cardNumMatch && processed.length > 50) {
        const shortName = processed.split(',')[0].split(' // ')[0].trim()
        processed = (shortName + ' ' + cardNumMatch[1]).replace(/\s+/g, ' ').trim()
        console.log(`[exact] truncated long query → "${processed}"`)
      }
      // Extract rarity from query text first
      const { query: cleaned, requiredRarity: rr } = normalizeRarity(processed)
      processed = cleaned
      // Keep rarity enforcement for starred variants + high-value plain rarities when user typed them
      const HIGH_VALUE_RARITIES = ['SPR', 'SCR', 'SEC', 'SSR', 'SAR']
      if (rr && (/\*/.test(rr) || HIGH_VALUE_RARITIES.includes(rr))) {
        requiredRarity = rr
        // Strip the rarity code from eBay query (enforcement handles filtering, code in query hurts matching)
        processed = processed.replace(/\b(?:SPR|SCR|SR|SSR|SAR|SEC)\b/gi, '').replace(/\s+/g, ' ').trim()
        console.log(`[exact] enforcing ${rr}, stripped from query → "${processed}"`)
      } else {
        // Strip low-value rarity codes — not worth enforcing
        processed = processed.replace(/\b(?:SPR|SCR|SR|SSR|SAR|SEC|UC|R|C|L|ST|FR|GFR|DR|DAR|DBR|IVR)\b/gi, '').replace(/\s+/g, ' ').trim()
        console.log(`[exact] stripped rarity from query → "${processed}"`)
      }
    } else {
      const pp = preprocessQuery(q.trim(), grade)
      processed = pp.query
      requiredRarity = pp.requiredRarity || null
    }

    // Catalog rarity lookup — start async, resolve before filtering
    // Prevents cheaper SR comps from bleeding into SPR/SCR pricing
    const cardNumInQ = processed.match(/\b([A-Z]{1,4}\d+-\d{3}[A-Z]?)\b/i)
    let _rarityLookupPromise = null
    if (!requiredRarity && cardNumInQ && _sbConfigured) {
      const numEnc = encodeURIComponent(cardNumInQ[1].toUpperCase())
      const catUrl = `${SUPABASE_URL}/rest/v1/card_catalog?select=rarity&card_number=eq.${numEnc}&rarity=not.is.null&limit=1`
      console.log(`[rarity-lookup] starting async for ${cardNumInQ[1]}`)
      _rarityLookupPromise = fetch(catUrl, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        signal: AbortSignal.timeout(8000),
      }).then(async r => {
        if (!r.ok) { console.log(`[rarity-lookup] fetch failed: ${r.status}`); return null }
        const rows = await r.json()
        const rarity = (rows[0]?.rarity || '').toUpperCase()
        console.log(`[rarity-lookup] result: ${cardNumInQ[1]} → ${rarity || 'none'}`)
        return ['SPR', 'SCR', 'SEC', 'SSR', 'SAR'].includes(rarity) ? rarity : null
      }).catch(e => { console.log(`[rarity-lookup] error: ${e.message}`); return null })
    }

    // Infer starred rarity from "alt art" keyword in query (added by selectAc for SR*/SCR* cards)
    if (!requiredRarity && /\balt\s*art\b/i.test(processed)) {
      requiredRarity = 'SR*'
      console.log(`[rarity] inferred SR* from "alt art" keyword in query`)
    }

    console.log(`[prices] processed query: "${processed}" (exact=${exact}, original q="${q}")`)
    if (requiredRarity) console.log(`[rarity] enforcing tier: ${requiredRarity}`)

    // Pokemon internal card number → collector number conversion
    // eBay sellers use "5/110" format, not "EX13-5" (pokemontcg.io internal codes)
    const PKM_SET_PREFIXES = /^(EX|BASE|ECARD|SM|SV|SWSH|XY|BW|DP|NEO|GYM|POP|NP|RUM)\d*$/i
    const pkmCardNumMatch = processed.match(/\b([A-Z]{2,6}\d+)-(\d+)\b/i)
    console.log(`[pkm-convert] processed="${processed}" match=${JSON.stringify(pkmCardNumMatch)}`)
    if (pkmCardNumMatch) {
      const pkmSetCode = pkmCardNumMatch[1].toUpperCase()
      const collectorNum = pkmCardNumMatch[2]
      console.log(`[pkm-convert] setCode=${pkmSetCode} num=${collectorNum} isPkm=${PKM_SET_PREFIXES.test(pkmSetCode)}`)
      // Only convert for Pokemon-style set codes — skip DBS/OP codes (FB07, BT22, OP05, ST01, etc.)
      if (PKM_SET_PREFIXES.test(pkmSetCode)) {
        const totalCount = await getPkmSetCount(pkmSetCode)
        console.log(`[pkm-convert] totalCount=${totalCount}`)
        if (totalCount) {
          const ebayNum = `${collectorNum}/${totalCount}`
          processed = processed.replace(pkmCardNumMatch[0], ebayNum)
          console.log(`[pkm-convert] converted ${pkmCardNumMatch[0]} → ${ebayNum}, final="${processed}"`)
        } else {
          // Set count unavailable — just use bare collector number
          processed = processed.replace(pkmCardNumMatch[0], collectorNum)
          console.log(`[pkm-convert] fallback stripped prefix: ${pkmCardNumMatch[0]} → ${collectorNum}, final="${processed}"`)
        }
      }
    }

    function filterByRarity(items) {
      if (!requiredRarity || !items?.length) {
        console.log(`[filterByRarity] SKIPPED — requiredRarity: ${requiredRarity}, items: ${items?.length || 0}`)
        return items
      }
      console.log(`[filterByRarity] RUNNING — requiredRarity: ${requiredRarity}, items: ${items.length}`)
      const kept = items.filter((i) => {
        const t = i.title || ''
        let pass = false
        switch (requiredRarity) {
          case 'SR*':
            pass = /\bSR\s*\*/i.test(t) && !/\bSR\s*\*\*/i.test(t); break
          case 'SCR*':
            if (/\bSCR\s*\*\*/i.test(t) || /\b(?:two|2|double)\s*star\b/i.test(t)) { pass = false; break }
            pass = /\bSCR\s*\*/i.test(t) || /\bSCR\s*alt\b/i.test(t) || /\balt(?:ernate)?\s*art\b/i.test(t); break
          case 'SCR**':
            pass = /\bSCR\s*\*\*/i.test(t) || /\b(?:two|2|double)\s*star\b/i.test(t); break
          case 'SR':
            pass = /\bSR\b/i.test(t) && !/\bSR\s*\*/i.test(t) && !/\bSR\s*alt\b/i.test(t) && !/\balt(?:ernate)?\s*art\b/i.test(t); break
          case 'SCR':
            pass = /\bSCR\b/i.test(t) && !/\bSCR\s*\*/i.test(t) && !/\bSCR\s*alt\b/i.test(t) && !/\balt(?:ernate)?\s*art\b/i.test(t) && !/\b(?:two|2|double)\s*star\b/i.test(t); break
          case 'SPR':
            pass = /\bSPR\b/i.test(t) || /\bspecial\s*rare\b/i.test(t); break
          default:
            pass = new RegExp(`\\b${requiredRarity}\\b`, 'i').test(t); break
        }
        console.log(`[filterByRarity] "${t.slice(0,70)}" → ${pass ? 'KEEP' : 'DROP'}`)
        return pass
      })
      if (kept.length < items.length) {
        const dropped = items.filter((i) => !kept.includes(i))
        for (const d of dropped) {
          console.log(`[rarity] dropped "${(d.title || '').slice(0, 80)}" (tier=${requiredRarity})`)
        }
      }
      console.log(`[rarity] ${items.length} → ${kept.length} with tier "${requiredRarity}"`)
      // Do NOT fall back — wrong rarity comps are worse than no data
      return kept
    }

    // Sports detection — computed once, shared by runQueries + blend
    const _SPORTS_RE = /\b(rookie|rc\b|refractor|prizm|topps|bowman|panini|donruss|select|optic|mosaic|fleer|upper\s*deck|score|nfl|nba|mlb|nhl|quarterback|qb|mvp|draft\s*pick)\b/i
    const _TCG_RE = /\b(pokemon|pokémon|pikachu|charizard|mewtwo|eevee|bulbasaur|squirtle|gengar|mtg|magic|yugioh|yu-gi-oh|lorcana|dragon\s*ball|dbs|one\s*piece|digimon|fortuneteller\s*baba|master\s*roshi|oolong|puar|ox.king|chichi|chi.chi|launch|turtle\s*hermit|kame|yamcha|tien|chiaotzu|raditz|nappa|zarbon|dodoria|ginyu|recoome|burter|jeice|guldo)\b/i
    const isSportsQuery = _SPORTS_RE.test(processed) && !_TCG_RE.test(processed)
    console.log(`[blend] card type: ${isSportsQuery ? 'sports' : 'tcg'} (query: "${processed}")`)

    async function runQueries(name) {
      const qs = buildQueries(name, grade, lang)

      // ── Parallel mode: fire 3 targeted queries as PRIMARY source ──────
      // Normal A/B/C return base card comps ($1) that pollute pricing.
      // $10 price floor strips cheap base cards that slip through "manga" query.
      if (parallel === '1') {
        const PARALLEL_PRICE_FLOOR = 10
        const base = qs.a.q
        // Name without card number — eBay API can't match card numbers with varied formatting
        const nameOnly = base.replace(/\b[A-Z]{1,4}\d+-\d+[A-Z]?\b/gi, '').replace(/\s+/g, ' ').trim()
        console.log(`[parallel] firing 3 name-only US-sold queries for: "${nameOnly}" (base: "${base}")`)
        // US-only sold search — global=true doesn't return sold items reliably
        const pOpts = { limit: 30, sort: 'newlyListed', days: 180 }
        const [pA, pB, pC, dA, dB] = await Promise.allSettled([
          ebaySearch(nameOnly + ' alt art', token, pOpts),
          ebaySearch(nameOnly + ' parallel', token, pOpts),
          ebaySearch(nameOnly + ' manga', token, { ...pOpts, sort: 'endingSoonest', days: 180 }),
          // Normal A+B as fallback if parallel queries return nothing
          ebaySearch(qs.a.q, token, { limit: qs.a.limit, sort: qs.a.sort, days: 90 }),
          ebaySearch(qs.b.q, token, { limit: qs.b.limit, sort: qs.b.sort, days: 30 }),
        ])
        const rawPAlt = pA.status === 'fulfilled' ? pA.value.itemSummaries || [] : []
        const rawPPar = pB.status === 'fulfilled' ? pB.value.itemSummaries || [] : []
        const rawPMng = pC.status === 'fulfilled' ? pC.value.itemSummaries || [] : []
        const parallelTotal = rawPAlt.length + rawPPar.length + rawPMng.length
        console.log(`[parallel] results: alt_art=${rawPAlt.length} parallel=${rawPPar.length} manga=${rawPMng.length} total=${parallelTotal}`)

        if (parallelTotal > 0) {
          // Merge all three, dedup by itemId
          const allRaw = [...rawPAlt, ...rawPPar, ...rawPMng]
          const seen = new Set()
          let merged = allRaw.filter(i => {
            const id = i.itemId || i.legacyItemId
            if (!id || seen.has(id)) return false
            seen.add(id)
            return true
          })
          // NOTE: eBay Browse API returns active listings despite soldItems:true for
          // SB01 parallel cards. No itemEndDate = no sold data available in the API.
          // We use active listing prices as a market indicator instead.

          // Price floor ($10) + ceiling ($500): drop base cards and speculative outliers
          const beforePrice = merged.length
          merged = merged.filter(i => {
            const p = parseFloat(i.price?.value || 0)
            return p >= PARALLEL_PRICE_FLOOR && p <= 500
          })
          if (merged.length < beforePrice) console.log(`[parallel] price filter: ${beforePrice} → ${merged.length}`)

          if (grade === 'Raw') {
            merged = merged.filter(i => !isGradedSlab(i.title))
          }
          const filterQ = processed + ' alt art'
          let filtered = filterByRarity(filterItems(merged, grade, filterQ, lang, { skipVariants: true }))
          // Hard block: card name enforcement
          const _MOD_P = /^(?:SIR|SCR|SPR|SR|UR|SEC|SAR|NM|raw|near|mint|card|english|holo|reverse|rare|promo|parallel|foil|alt|art|manga|red|booster|special|super|secret|common|uncommon)$/i
          const _SET_P = /^(?:[A-Z]{1,4}-?\d+(?:-\d+)?[A-Z]?|\d{1,3}\/\d{1,3})$/i
          const _nameP = processed.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !_MOD_P.test(w) && !_SET_P.test(w))
          if (_nameP.length > 0) {
            filtered = filtered.filter(i => _nameP.every(w => (i.title || '').toLowerCase().includes(w)))
          }
          console.log(`[parallel] after all filters: ${filtered.length} comps`)

          if (filtered.length > 0) {
            // Active listings: use lowest 5 BIN prices as market indicator
            // This represents what a buyer would actually pay (cheapest available)
            filtered.sort((a, b) => parseFloat(a.price?.value || 0) - parseFloat(b.price?.value || 0))
            const lowest = filtered.slice(0, 5)
            const prices = lowest.map(i => parseFloat(i.price?.value || 0))
            const avg = prices.reduce((a, b) => a + b, 0) / prices.length
            const lo = prices[0]
            const hi = prices[prices.length - 1]
            console.log(`[parallel] lowest ${prices.length} listings: $${prices.join(', $')} → avg $${avg.toFixed(2)}`)
            // Build a synthetic blend result
            const syntheticStats = { avg, lo, hi, count: lowest.length }
            const res_ = [
              { ...qs.a, label: 'Lowest BIN prices', weight: 1.0, stats: syntheticStats },
            ]
            const blended_ = {
              lo: parseFloat(lo.toFixed(2)),
              avg: parseFloat(avg.toFixed(2)),
              hi: parseFloat(hi.toFixed(2)),
              confidence: Math.min(80, 30 + lowest.length * 10),
              activeQueries: 1,
              totalQueries: 1,
              totalComps: lowest.length,
              reweighted: res_,
            }
            return { results: res_, blended: blended_, allItems: lowest, hadJapaneseResults: false, activeListings: true }
          }
          console.log(`[parallel] all parallel comps filtered out, falling back to normal queries`)
        } else {
          console.log(`[parallel] 0 parallel results, falling back to normal queries`)
        }
        // Fallback: use the normal A+B we already fetched
        let rawA = dA.status === 'fulfilled' ? dA.value.itemSummaries || [] : []
        let rawB = dB.status === 'fulfilled' ? dB.value.itemSummaries || [] : []
        if (grade === 'Raw') {
          rawA = rawA.filter(i => !isGradedSlab(i.title))
          rawB = rawB.filter(i => !isGradedSlab(i.title))
        }
        const fA = filterByRarity(filterItems(rawA, grade, processed, lang))
        const fB = filterByRarity(filterItems(rawB, grade, processed, lang))
        const res_ = [
          { ...qs.a, stats: calcStats(fA, 'A') },
          { ...qs.b, stats: calcStats(fB, 'B') },
        ]
        return { results: res_, blended: blend(res_, isSportsQuery), allItems: [...fA, ...fB], hadJapaneseResults: false }
      }

      // ── Normal (non-parallel) flow ────────────────────────────────────
      // TCG: skip Query D (live auctions) — BIN-dominated, saves one eBay API call
      const promises = [
        ebaySearch(qs.a.q, token, { limit: qs.a.limit, sort: qs.a.sort, days: 90 }),
        ebaySearch(qs.b.q, token, { limit: qs.b.limit, sort: qs.b.sort, days: 30 }),
        ebaySearch(qs.c.q, token, { limit: qs.c.limit, sort: qs.c.sort, days: 90 }),
      ]
      if (isSportsQuery) {
        promises.push(ebaySearch(qs.d.q, token, { limit: qs.d.limit, sort: qs.d.sort, live: true }))
      }
      const settled = await Promise.allSettled(promises)
      const [dA, dB, dC] = settled
      const dD = isSportsQuery ? settled[3] : { status: 'fulfilled', value: { itemSummaries: [] } }
      let rawA = dA.status === 'fulfilled' ? dA.value.itemSummaries || [] : []
      let rawB = dB.status === 'fulfilled' ? dB.value.itemSummaries || [] : []
      let rawC = dC.status === 'fulfilled' ? dC.value.itemSummaries || [] : []
      let rawD = dD.status === 'fulfilled' ? dD.value.itemSummaries || [] : []

      // ── Pre-filter: strip graded slabs BEFORE filterItems (double filter for Raw) ──
      if (grade === 'Raw') {
        const preFilter = (items, label) => {
          const kept = items.filter((i) => {
            if (isGradedSlab(i.title)) {
              console.log(`[pre-filter:${label}] slab removed: "${(i.title || '').slice(0, 70)}"`)
              return false
            }
            return true
          })
          if (kept.length < items.length) console.log(`[pre-filter:${label}] ${items.length} → ${kept.length}`)
          return kept
        }
        rawA = preFilter(rawA, 'A')
        rawB = preFilter(rawB, 'B')
        rawC = preFilter(rawC, 'C')
        rawD = preFilter(rawD, 'D')
      }

      // ── EARLY DISAMBIGUATION: check before variant/rarity filters strip alt arts ──
      const queryHasCardNum = /\b[A-Z]{1,4}\d+-\d+/i.test(processed)
      if (!queryHasCardNum && exact !== '1') {
        // Merge raw items (after slab/lot pre-filter) for card number analysis
        const allRawForDisambig = [...rawA, ...rawB, ...rawC].filter(i => parseFloat(i.price?.value || 0) >= 0.50)
        const _CNUM_RE = /\b([A-Z]{1,4}\d+-\d+[A-Z]?)\b/gi
        const byNum = new Map()
        for (const item of allRawForDisambig) {
          const t = item.title || ''
          const nums = t.match(_CNUM_RE)
          if (!nums) continue
          const num = nums[0].toUpperCase()
          if (!byNum.has(num)) byNum.set(num, [])
          byNum.get(num).push(item)
        }
        if (byNum.size >= 3) {
          const allPrices = allRawForDisambig.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0).sort((a, b) => a - b)
          const spread = allPrices.length >= 2 ? allPrices[allPrices.length - 1] / allPrices[0] : 1
          if (spread > 5) {
            console.log(`[disambig] ${byNum.size} distinct card numbers with ${spread.toFixed(1)}x spread — returning picker`)
            let variants = [...byNum.entries()].map(([num, items]) => {
              // Only use comps where this card number is the ONLY card number in the title
              const exactItems = items.filter(i => {
                const allNums = (i.title || '').match(_CNUM_RE) || []
                return allNums.length === 1
              })
              const useItems = exactItems.length > 0 ? exactItems : items
              const ps = useItems.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0).sort((a, b) => a - b)
              const avg = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0
              // Detect rarity: check each title individually for rarity near the card number
              let rarity = ''
              for (const item of useItems) {
                const t = item.title || ''
                // Check for explicit starred rarity in THIS title
                const starred = t.match(/\b(SCR\s*\*\*|SCR\s*\*|SR\s*\*|SPR\s*\*)\b/i)
                if (starred) { rarity = starred[1].toUpperCase().replace(/\s+/g, ''); break }
                // Check for alt art indicator + rarity in SAME title
                const hasAlt = /\balt(?:ernate)?\s*art\b/i.test(t) || /\b(?:SCR|SR)\s*alt\b/i.test(t)
                const plain = t.match(/\b(SCR|SPR|SR|UR|SEC|SSR|SAR|UC|R|C|L|SP)\b/i)
                if (plain) {
                  const r = plain[1].toUpperCase()
                  if (hasAlt && (r === 'SCR' || r === 'SR')) { rarity = r + '*'; break }
                  if (!rarity) rarity = r // keep first plain rarity found
                }
              }
              return {
                cardNumber: num,
                name: processed.replace(/\b[A-Z]{1,4}\d+\b/gi, '').trim() || num,
                rarity,
                estimatedPrice: parseFloat(avg.toFixed(2)),
                compCount: useItems.length,
                imageUrl: useItems[0]?.image?.imageUrl || null,
              }
            })
            // Filter: require 2+ comps, remove price outliers >10x median
            variants = variants.filter(v => v.compCount >= 2)
            if (variants.length >= 2) {
              const vPrices = variants.map(v => v.estimatedPrice).filter(p => p > 0).sort((a, b) => a - b)
              const vMid = Math.floor(vPrices.length / 2)
              const vMedian = vPrices.length % 2 !== 0 ? vPrices[vMid] : (vPrices[vMid - 1] + vPrices[vMid]) / 2
              variants = variants.filter(v => v.estimatedPrice <= vMedian * 10)
            }
            // Sort by price descending, limit to 6
            variants.sort((a, b) => b.estimatedPrice - a.estimatedPrice)
            variants = variants.slice(0, 6)
            if (variants.length >= 2) {
              return { disambiguation: true, variants, query: processed }
            }
          }
        }
      }

      // Resolve catalog rarity lookup before filtering (started in parallel with eBay queries)
      // Only enforce if user explicitly typed the rarity code in their query
      if (_rarityLookupPromise && !requiredRarity) {
        const lookupResult = await _rarityLookupPromise
        if (lookupResult) {
          const origQ = q.toUpperCase()
          const userTypedRarity = new RegExp(`\\b${lookupResult}\\b`).test(origQ)
          if (userTypedRarity) {
            requiredRarity = lookupResult
            console.log(`[rarity-lookup] resolved: enforcing ${requiredRarity} (user typed it)`)
          } else {
            console.log(`[rarity-lookup] resolved: ${lookupResult} found but user didn't type it — skipping enforcement`)
          }
        }
        _rarityLookupPromise = null
      }

      // Filter by grade + variant + rarity — filtered items are used for everything downstream
      const fA = filterByRarity(filterItems(rawA, grade, processed, lang))
      const fB = filterByRarity(filterItems(rawB, grade, processed, lang))
      const fC = filterByRarity(filterItems(rawC, grade, processed, lang))
      // Query D: only include live auctions with 1+ bids (price validated by a buyer)
      const fDgraded = filterByRarity(filterItems(rawD, grade, processed, lang))
      console.log(`[query:D] ${rawD.length} raw auctions → ${fDgraded.length} after grade+rarity filter`)
      const fD = fDgraded.filter((i) => (i.bidCount || 0) >= 1)
      console.log(`[query:D] ${fDgraded.length} auctions → ${fD.length} with 1+ bids`)

      // Strip items older than 90 days BEFORE calcStats — stale comps must not
      // contribute to the weighted average (only extractComps was filtering before)
      const cutoff90d = Date.now() - 90 * 24 * 60 * 60 * 1000
      const dropStale = (items, label) => {
        let droppedActive = 0, droppedOld = 0
        const now = Date.now()
        const kept = items.filter((i) => {
          const endDate = i.itemEndDate
          // Future itemEndDate = active listing (not sold) — exclude
          if (endDate && new Date(endDate).getTime() > now) {
            droppedActive++
            return false
          }
          const d = endDate || i.itemCreationDate
          if (!d) return true // no date = keep (can't determine age)
          if (new Date(d).getTime() < cutoff90d) { droppedOld++; return false }
          return true
        })
        if (droppedActive || droppedOld)
          console.log(`[date-filter:${label}] ${items.length} → ${kept.length} (${droppedActive} active, ${droppedOld} stale)`)
        return kept
      }
      // Don't date-filter Query D (live auctions — they're current by definition)
      const freshA = dropStale(fA, 'A'), freshB = dropStale(fB, 'B'), freshC = dropStale(fC, 'C')

      const totalComps = freshA.length + freshB.length + freshC.length + fD.length
      console.log(`[comps] US item counts (after 90d filter): A=${freshA.length} B=${freshB.length} C=${freshC.length} D=${fD.length} total=${totalComps}`)

      // Low-volume fallback: if US-only returned < 5 comps, retry A+B without location filter
      let finalA = freshA, finalB = freshB
      if (totalComps < 5) {
        console.log(`[low-volume] only ${totalComps} US comps, retrying A+B globally`)
        const [gA, gB] = await Promise.allSettled([
          ebaySearch(qs.a.q, token, { limit: qs.a.limit, sort: qs.a.sort, global: true, days: 90 }),
          ebaySearch(qs.b.q, token, { limit: qs.b.limit, sort: qs.b.sort, global: true, days: 30 }),
        ])
        let rawGA = gA.status === 'fulfilled' ? gA.value.itemSummaries || [] : []
        let rawGB = gB.status === 'fulfilled' ? gB.value.itemSummaries || [] : []
        if (grade === 'Raw') {
          rawGA = rawGA.filter((i) => !isGradedSlab(i.title))
          rawGB = rawGB.filter((i) => !isGradedSlab(i.title))
        }
        // Filter global results to North America only — UK/EU sellers list in USD but ship internationally,
        // their prices don't reflect the US market
        const naOnly = (items) => items.filter((i) => {
          const c = i.itemLocation?.country
          return !c || c === 'US' || c === 'CA'
        })
        const gfA = dropStale(naOnly(filterByRarity(filterItems(rawGA, grade, processed, lang))), 'A-global')
        const gfB = dropStale(naOnly(filterByRarity(filterItems(rawGB, grade, processed, lang))), 'B-global')
        if (gfA.length + gfB.length > freshA.length + freshB.length) {
          console.log(`[low-volume] global A+B: ${gfA.length}+${gfB.length} comps (was ${freshA.length}+${freshB.length})`)
          finalA = gfA
          finalB = gfB
        }
      }

      // ── HARD BLOCK: card-name enforcement before calcStats ─────────────
      // Ensures wrong-card items never contribute to weighted average OR display.
      const _MOD = /^(?:SIR|SCR|SPR|SR|UR|SEC|SAR|EX|GX|V|VMAX|VSTAR|NM|raw|near|mint|card|english|holo|reverse|rare|promo|rookie|base|set|1st|first|edition|unlimited|parallel|foil|super|secret|special|ultra|common|uncommon)$/i
      const _SET = /^(?:[A-Z]{1,4}-?\d+(?:-\d+)?[A-Z]?|\d{1,3}\/\d{1,3})$/i
      const _nameW = processed.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !_MOD.test(w) && !_SET.test(w))
      const hardBlock = (items, label) => {
        if (!_nameW.length) return items
        const kept = items.filter((i) => {
          const t = (i.title || '').toLowerCase()
          if (_nameW.every(w => t.includes(w))) return true
          console.log(`[HARD BLOCK:${label}] removed: "${(i.title || '').slice(0, 70)}" — missing [${_nameW.join(', ')}]`)
          return false
        })
        if (kept.length < items.length) console.log(`[HARD BLOCK:${label}] ${items.length} → ${kept.length}`)
        return kept
      }

      const cleanA = hardBlock(finalA, 'A')
      const cleanB = hardBlock(finalB, 'B')
      const cleanC = hardBlock(freshC, 'C')
      const cleanD = hardBlock(fD, 'D')

      // Track if raw results had Japanese items that were filtered out
      const langRe = LANG_EXCLUDE[lang]
      const allRaw = [...rawA, ...rawB, ...rawC]
      const hadJapaneseResults = langRe && allRaw.some((i) => langRe.test(i.title || ''))

      const res = [
        { ...qs.a, stats: calcStats(cleanA, 'A') },
        { ...qs.b, stats: calcStats(cleanB, 'B') },
        { ...qs.c, stats: calcStats(cleanC, 'C') },
      ]
      if (isSportsQuery) {
        res.push({ ...qs.d, stats: calcStats(cleanD, 'D') })
      }
      return { results: res, blended: blend(res, isSportsQuery), allItems: [...cleanA, ...cleanB, ...cleanC, ...cleanD], hadJapaneseResults }
    }

    // Launch card image lookup in parallel with the first eBay query batch
    const [queriesResult, cardImageResult] = await Promise.allSettled([
      runQueries(processed),
      fetchCardImage(q.trim()),
    ])
    if (queriesResult.status !== 'fulfilled') {
      console.error(`[runQueries] failed:`, queriesResult.reason?.message || queriesResult.reason)
      return res.status(200).json({ type: 'no-data', error: 'Search failed. Please try again.', searchTip: null })
    }
    const qResult = queriesResult.value
    // Check for early disambiguation from runQueries
    if (qResult.disambiguation) {
      console.log(`[disambig] returning picker with ${qResult.variants.length} variants`)
      return res.status(200).json({
        type: 'disambiguation',
        query: q.trim(),
        grade,
        lang,
        variants: qResult.variants,
      })
    }
    let { results, blended, allItems, hadJapaneseResults, activeListings } = qResult
    const dedicatedImageUrl = cardImageResult.status === 'fulfilled' ? cardImageResult.value : null

    let correctedQuery = null  // set if we used spell correction or word-strip

    // ── Retry 1: spell correction ────────────────────────────────────────────
    if (!blended || blended.totalComps === 0) {
      const { corrected, changed } = spellCorrect(processed)
      if (changed) {
        console.log(`[spellcorrect] "${processed}" → "${corrected}"`)
        const attempt = await runQueries(corrected)
        if (attempt.blended && attempt.blended.totalComps > 0) {
          ;({ results, blended, allItems, hadJapaneseResults } = attempt)
          correctedQuery = corrected
        }
      }
    }

    // ── Retry 2: single word-strip retry (remove one modifier word) ────────
    // Only strip modifier words (rarity, grade, etc), never the card name.
    // Never retry if the result would be fewer than 2 meaningful words.
    // Maximum 1 retry to avoid catastrophic broadening (e.g. "sv3" alone).
    // For sports queries: only word-strip when 0 comps (not < 3) to keep specific results
    const stripThreshold = isSportsQuery ? 0 : 3
    if (!blended || blended.totalComps < stripThreshold) {
      const base = correctedQuery || processed
      const words = base.split(/\s+/)
      // Only rarity, grade, and descriptor terms can be stripped — card names and set codes are protected
      const modifierRe = /^(?:SIR|SCR|SPR|SR|UR|SEC|SAR|EX|GX|V|VMAX|VSTAR|NM|raw|near\s*mint|card|english|rookie|rc|base|prizm|optic|select|mosaic|silver|holo)$/i
      const setCodeOnlyRe = /^[A-Z]{1,4}-?\d+[A-Z]?$|^\d{1,3}\/\d{1,3}$/i

      // Try stripping one modifier word at a time, from the end
      for (let i = words.length - 1; i >= 1; i--) {
        if (!modifierRe.test(words[i])) continue // only strip modifiers, not card names
        const candidate = words.filter((_, idx) => idx !== i).join(' ')
        if (candidate === base) continue
        // Never use a query that is only set codes / card numbers with no card name
        const remainingWords = candidate.split(/\s+/)
        const hasCardName = remainingWords.some(w => !setCodeOnlyRe.test(w))
        if (!hasCardName || remainingWords.length < 2) {
          console.log(`[word-strip] skipping "${candidate}" — no card name or too short`)
          continue
        }
        console.log(`[word-strip] trying "${candidate}"`)
        const attempt = await runQueries(candidate)
        if (attempt.blended && attempt.blended.totalComps > (blended?.totalComps || 0)) {
          ;({ results, blended, allItems, hadJapaneseResults } = attempt)
          console.log(`[word-strip] accepted "${candidate}" with ${blended.totalComps} comps`)
          break // maximum 1 successful retry
        }
      }
    }

    if (!blended || blended.totalComps === 0) {
      if (hadJapaneseResults) {
        return res.status(200).json({
          type: 'no-data',
          error: 'Limited US sales found for this card.',
          searchTip: 'This may be a Japanese-market card. Try selecting "Japanese" in the language filter.',
        })
      }
      return res.status(200).json({
        type: 'no-data',
        error: 'Not enough sold comps found. Try a more specific search.',
        searchTip: 'For Dragon Ball cards, include the set code like BT27 or FB09. For Pokémon, include the set name like "Base Set" or "Scarlet & Violet".',
      })
    }

    const trend30 = calcTrend(results[1]?.stats?.avg, results[0]?.stats?.avg)

    // Deduplicate comps across all queries, strip slabs for Raw
    const seen = new Set()
    let deduped = allItems.filter((i) => {
      // Hard slab exclusion at dedup stage — triple safety net
      if (grade === 'Raw' && isGradedSlab(i.title)) return false
      const key = i.title?.toLowerCase().slice(0, 40)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // ── HARD BLOCK: final card-name enforcement ──────────────────────────
    // Absolute last safety net — no wrong-card comp can survive past this point.
    // Extract card name words (non-modifier, non-set-code) from original query.
    {
      const _MOD_RE = /^(?:SIR|SCR|SPR|SR|UR|SEC|SAR|EX|GX|V|VMAX|VSTAR|NM|raw|near|mint|card|english|holo|reverse|rare|promo|rookie|base|set|1st|first|edition|unlimited|parallel|foil|super|secret|special|ultra|common|uncommon)$/i
      const _SET_RE = /^(?:[A-Z]{1,4}-?\d+(?:-\d+)?[A-Z]?|\d{1,3}\/\d{1,3})$/i
      const _nameWords = processed.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !_MOD_RE.test(w) && !_SET_RE.test(w))
      if (_nameWords.length > 0) {
        const before = deduped.length
        deduped = deduped.filter((i) => {
          const t = (i.title || '').toLowerCase()
          if (_nameWords.every(w => t.includes(w))) return true
          console.log(`[HARD BLOCK] removed wrong card: "${(i.title || '').slice(0, 80)}" — missing [${_nameWords.join(', ')}]`)
          return false
        })
        if (deduped.length < before) console.log(`[HARD BLOCK] ${before} → ${deduped.length} after card name enforcement`)
      }
    }

    // Detect SR/SPR rarity split — mixed comps from different rarity tiers
    // Only trigger when user didn't specify a card number or rarity
    // For exact=1 (autocomplete), card number was auto-added — don't count it as user-specified
    const _hasCardNum = exact !== '1' && /\b[A-Z]{2,5}\d{1,2}-\d{2,3}\b/i.test(q)
    const _hasRarity = /\b(SCR\*{0,2}|SPR|SR\*?|DBR|SGR|SEC|SSR|SAR)\b/i.test(q)
    console.log(`[rarity-split] check: requiredRarity=${requiredRarity}, hasCardNum=${_hasCardNum}, hasRarity=${_hasRarity}, exact=${exact}, deduped=${deduped.length}, q="${q}"`)
    if (!requiredRarity && !_hasCardNum && !_hasRarity && deduped.length >= 4) {
      const sprComps = deduped.filter(i => /\bSPR\b/i.test(i.title) || /\bspecial\s*rare\b/i.test(i.title))
      const srComps = deduped.filter(i => /\bSR\b/i.test(i.title) && !/\bSPR\b/i.test(i.title) && !/\bSR\s*\*/i.test(i.title))
      const sprPct = sprComps.length / deduped.length
      const srPct = srComps.length / deduped.length
      if (sprPct >= 0.2 && srPct >= 0.2) {
        const sprPrices = sprComps.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0)
        const srPrices = srComps.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0)
        const sprAvg = sprPrices.length ? sprPrices.reduce((a, b) => a + b, 0) / sprPrices.length : 0
        const srAvg = srPrices.length ? srPrices.reduce((a, b) => a + b, 0) / srPrices.length : 0
        // Only trigger if price gap is significant (>2x difference)
        if (sprAvg > 0 && srAvg > 0 && (sprAvg / srAvg > 2 || srAvg / sprAvg > 2)) {
          console.log(`[rarity-split] detected SR ($${srAvg.toFixed(2)}, ${srComps.length} comps) vs SPR ($${sprAvg.toFixed(2)}, ${sprComps.length} comps)`)
          const cardNum = processed.match(/\b([A-Z]{1,4}\d+-\d{3}[A-Z]?)\b/i)?.[1] || ''
          // Extract card name from best comp title (strip card number, rarity, set name noise)
          const bestTitle = (sprComps[0]?.title || srComps[0]?.title || '').replace(/\b[A-Z]{2,5}\d+-\d{3}\b/gi, '').replace(/\b(SPR|SR|SCR|UC|R|C|NM|LP|HP|Mint)\b/gi, '').replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim()
          const cardName = bestTitle.split(/\b(Dawn|Dragon Ball|DBS|TCG|Card Game|Super Card)\b/i)[0].replace(/[,()]/g, ' ').replace(/\s+/g, ' ').trim() || q.trim()
          return res.status(200).json({
            type: 'rarity-split',
            query: q.trim(),
            cardName,
            grade,
            lang,
            cardNumber: cardNum,
            variants: [
              { rarity: 'SPR', label: 'Special Rare (SPR)', estimatedPrice: sprAvg, compCount: sprComps.length },
              { rarity: 'SR', label: 'Super Rare (SR)', estimatedPrice: srAvg, compCount: srComps.length },
            ],
          })
        }
      }
    }

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
      comps: (() => {
        const c = extractComps(deduped, 10, grade)
        if (grade === 'Raw') {
          console.log(`[comps:Raw] ${c.length} comps returned:`)
          c.forEach((comp, i) => console.log(`  [comp ${i}] $${comp.price} "${comp.title?.slice(0, 80)}"`))
        }
        // Flag outliers: >2x median or <0.4x median (display-only, doesn't affect pricing)
        // Skip when price gap is explained by rarity split (SR vs SPR in same result set)
        if (c.length >= 3) {
          const sprCount = c.filter(x => /\bSPR\b/i.test(x.title) || /\bspecial\s*rare\b/i.test(x.title)).length
          const srCount = c.filter(x => /\bSR\b/i.test(x.title) && !/\bSPR\b/i.test(x.title)).length
          const isRaritySplit = sprCount >= 1 && srCount >= 1
          if (!isRaritySplit) {
            const prices = c.map(x => x.price).sort((a, b) => a - b)
            const mid = Math.floor(prices.length / 2)
            const median = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2
            for (const comp of c) {
              if (comp.price > median * 2 || comp.price < median * 0.4) comp.outlier = true
            }
          }
        }
        return c
      })(),
      query: q,
      correctedQuery: correctedQuery !== processed ? correctedQuery : null,
      grade,
      lang,
      source: 'ebay',
      activeListings: activeListings || false,
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
    console.log(`[debug] about to call logPriceHistory for: "${q.trim()}"`)
    console.log(`[debug] _sbConfigured: ${_sbConfigured}`)
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

    // Build self-growing card catalog — saves every searched card for future autocomplete
    const detectedGame = (() => {
      const ql = q.trim().toLowerCase()
      if (/dragon ball|dbs|goku|vegeta|gogeta|broly|frieza|fusion world|energy marker|fortuneteller baba|master roshi|yamcha|tien|chiaotzu|raditz|nappa|zarbon|dodoria|ginyu|recoome|burter|jeice|guldo/i.test(ql) || /\b(BT|FB|FS|SD|ST|SB)\d+/i.test(ql)) return 'dbs'
      if (/pokemon|charizard|pikachu/i.test(ql)) return 'pokemon'
      if (/mtg|magic/i.test(ql)) return 'mtg'
      if (/yugioh|yu-gi-oh/i.test(ql)) return 'yugioh'
      if (/one piece|luffy|zoro/i.test(ql)) return 'onepiece'
      if (/lorcana/i.test(ql)) return 'lorcana'
      return 'unknown'
    })()
    const detectedSetCode = (processed.match(/\b(?:BT|FB|FS|SD|ST|SB|EB|TB|OP|D-BT)\d+(?:-\d+)?/i) || [])[0] || null
    // Prefer official card image (from autocomplete) over eBay listing photo
    const catalogImageUrl = cardImageUrl || (response.imageUrl && !response.imageUrl.includes('ebayimg.com') ? response.imageUrl : null)
    console.log(`[debug] about to call logCardCatalog for: "${q.trim()}" game: ${detectedGame}, imageUrl: ${catalogImageUrl ? 'official' : 'none'}`)
    logCardCatalog({
      cardName: q.trim(),
      game: detectedGame,
      setCode: detectedSetCode,
      rarity: requiredRarity || null,
      imageUrl: catalogImageUrl,
      searchQuery: processed,
    })

    return res.status(200).json(response)
  } catch (err) {
    console.error('CardPulse API error:', err)
    return res.status(500).json({ error: err.message })
  }
}
