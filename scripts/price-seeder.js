#!/usr/bin/env node
/**
 * Proactive price history seeder with Claude comp validation.
 *
 * For each card:
 *   1. Calls /api/prices to get eBay comps
 *   2. Passes raw comps to Claude Sonnet for validation
 *   3. Claude flags bad comps (wrong card/set/language, lots, slabs, outliers)
 *   4. Logs validated price + confidence to Supabase price_history
 *
 * Usage:
 *   npm run seed-prices                        # full run (100 per game)
 *   npm run seed-prices -- --limit 10          # 10 per game
 *   npm run seed-prices -- --game dbs          # only DBS
 *   npm run seed-prices -- --dry-run           # validate but don't write
 *   npm run seed-prices -- --verbose           # show Claude analysis
 *
 * Requires .env.local: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const API_BASE = 'https://cardpulse-topaz.vercel.app'
const CARD_DELAY_MS = 2000   // 2s between cards
const GAME_DELAY_MS = 10000  // 10s between games
const CARDS_PER_GAME = 100
const CLAUDE_MODEL = 'claude-sonnet-4-20250514'

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local')
  process.exit(1)
}
if (!ANTHROPIC_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env.local — needed for comp validation')
  process.exit(1)
}

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name) => args.some(a => a === name || a.startsWith(name + '='))
const param = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) return args[i + 1]
    if (args[i].startsWith(name + '=')) return args[i].split('=')[1]
  }
  return null
}

const LIMIT = parseInt(param('--limit')) || CARDS_PER_GAME
const GAME_FILTER = param('--game')
const DRY_RUN = flag('--dry-run')
const VERBOSE = flag('--verbose')

// ── Claude system prompt ────────────────────────────────────────────────────
const CLAUDE_SYSTEM = `You are a trading card comp validator. Given a card name, set, rarity, and a list of eBay sold listings, identify which comps are bad and explain why. Bad comps include: wrong card, wrong set, wrong language, lot listings, graded slabs, bundle deals, damaged cards, suspiciously high/low outliers (>3x or <0.25x median). Return JSON only:
{
  "validComps": [{"title": "...", "price": 0.00, "reason": "clean"}],
  "flaggedComps": [{"title": "...", "price": 0.00, "reason": "explanation"}],
  "suggestedPrice": 0.00,
  "confidence": "high|medium|low",
  "notes": "any observations"
}`

// ── Supabase helpers ────────────────────────────────────────────────────────
async function sbFetch(path, params = {}) {
  const qs = new URLSearchParams(params)
  const url = `${SUPABASE_URL}/rest/v1/${path}?${qs}`
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status}`)
  return res.json()
}

async function sbInsert(table, row) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase insert ${table}: ${res.status} ${body}`)
  }
}

// ── Rarity priority per game ────────────────────────────────────────────────
// Higher index = lower priority. Cards queried in this order per game.
const RARITY_TIERS = {
  dbs: [
    ['SCR', 'SCR*', 'SCR**'],
    ['GDR'],
    ['SPR', 'DBR', 'SGR'],
    ['SR*', 'SEC', 'SAR', 'SSR'],
    ['SR'],
    ['SLR'],
    ['CR'],
  ],
  pokemon: [
    ['Special Illustration Rare', 'Mega Hyper Rare'],
    ['Hyper Rare', 'Illustration Rare'],
    ['Ultra Rare', 'Rare Secret', 'Shiny Ultra Rare'],
    ['Double Rare', 'Rare Ultra', 'Rare Holo VSTAR', 'Rare Holo VMAX'],
  ],
  onepiece: [
    ['SEC', 'Manga Rare', 'Treasury Rare'],
    ['SPR', 'SR'],
    ['L'],
  ],
  mtg: [
    ['Mythic'],
    ['Rare'],
  ],
  yugioh: [
    ['Secret Rare', 'Starlight Rare', 'Ghost Rare'],
    ['Ultra Rare', 'Collector\'s Rare'],
  ],
  lorcana: [
    ['Legendary', 'Enchanted'],
    ['Super Rare'],
  ],
  gundam: [
    ['SCR', 'SR'],
  ],
  digimon: [
    ['SEC', 'SR'],
  ],
}

// MTG reserved list / iconic fallbacks (Supabase may not have rarity data for these)
const MTG_FALLBACKS = [
  'Black Lotus', 'Ancestral Recall', 'Time Walk', 'Mox Sapphire', 'Mox Ruby',
  'Mox Pearl', 'Mox Emerald', 'Mox Jet', 'Timetwister', 'Underground Sea',
  'Volcanic Island', 'Tropical Island', 'Tundra', 'Bayou', 'Badlands',
  'Scrubland', 'Savannah', 'Taiga', 'Plateau', 'Force of Will',
  'Jace, the Mind Sculptor', 'Liliana of the Veil', 'Ragavan, Nimble Pilferer',
  'The One Ring', 'Sheoldred, the Apocalypse', 'Wrenn and Six',
]

// ── Build seed card list from Supabase ──────────────────────────────────────
async function buildSeedCards(limit) {
  const games = GAME_FILTER ? [GAME_FILTER] : Object.keys(RARITY_TIERS)
  const allCards = {}

  for (const game of games) {
    const tiers = RARITY_TIERS[game] || []
    let cards = []
    const seen = new Set()

    for (const rarities of tiers) {
      if (cards.length >= limit) break
      const remaining = limit - cards.length
      const rows = await sbFetch('card_catalog', {
        select: 'card_name,card_number,game,rarity,set_code',
        game: `eq.${game}`,
        rarity: `in.(${rarities.join(',')})`,
        order: 'card_number.desc',
        limit: String(remaining + 500), // overfetch — re-sort client-side for value priority
      })
      // Sort by set series priority (main sets first), then set number desc (BT30 > BT8)
      // Promos (P-xxx) sort last since they're usually lower value
      const SET_PREFIX_PRIORITY = { BT: 0, FB: 1, SB: 2, EX: 3, TB: 4, SD: 5, FS: 6, P: 99, PROMOTION: 99 }
      const setPrefix = (c) => {
        const sc = (c.set_code || '').toUpperCase()
        const m = sc.match(/^([A-Z]+)/)
        return m ? (SET_PREFIX_PRIORITY[m[1]] ?? 50) : 99
      }
      const setNum = (c) => {
        const m = (c.set_code || c.card_number || '').match(/(\d+)/)
        return m ? parseInt(m[1]) : 0
      }
      rows.sort((a, b) => {
        const pa = setPrefix(a), pb = setPrefix(b)
        if (pa !== pb) return pa - pb          // main sets before promos
        return setNum(b) - setNum(a)           // newer sets first (BT30 > BT8)
      })
      // Pokemon: filter out non-English sets (Japanese Z/R prefixes, non-whitelisted PT5)
      const PKM_EN_PREFIX = /^(SV|ME|BASE|SWSH|SM|XY|BW|HGSS|HS|PL|DP|EX|E(?:\d)|G1|RU1|POP|NP|NEO|GYM|SI1|ECARD|DET|DV|DC|COL|SMA|HSP|SMP|BWP|XYP)/i
      const PKM_EN_PT5 = new Set(['SV3PT5', 'SV6PT5', 'SV8PT5'])
      for (const r of rows) {
        if (cards.length >= limit) break
        const key = `${r.game}|${r.card_number}`
        if (seen.has(key)) continue
        // Skip non-English Pokemon sets
        if (game === 'pokemon') {
          const sc = (r.set_code || '').toUpperCase()
          if (/PT5/i.test(sc) && !PKM_EN_PT5.has(sc)) continue
          if (/^[ZR]/i.test(sc)) continue
          if (!PKM_EN_PREFIX.test(sc) && sc) continue
        }
        seen.add(key)
        cards.push(r)
      }
    }

    // MTG fallback: add reserved list cards not already in results
    if (game === 'mtg' && cards.length < limit) {
      for (const name of MTG_FALLBACKS) {
        if (cards.length >= limit) break
        if (cards.some(c => c.card_name === name)) continue
        const rows = await sbFetch('card_catalog', {
          select: 'card_name,card_number,game,rarity,set_code',
          game: 'eq.mtg',
          card_name: `eq.${name}`,
          limit: '1',
        })
        if (rows.length > 0 && !seen.has(`mtg|${rows[0].card_number}`)) {
          seen.add(`mtg|${rows[0].card_number}`)
          cards.push(rows[0])
        }
      }
    }

    allCards[game] = cards
    console.log(`  ${game}: ${cards.length} cards`)
  }

  return allCards
}

// ── Query building (mirrors selectAc / populate-prices) ─────────────────────
const PKM_SET_NAMES = {
  BASE1:'Base Set',BASE2:'Jungle',BASE3:'Fossil',BASE4:'Base Set 2',BASE5:'Team Rocket',BASE6:'Legendary Collection',BASEP:'Wizards Promo',
  GYM1:'Gym Heroes',GYM2:'Gym Challenge',NEO1:'Neo Genesis',NEO2:'Neo Discovery',NEO3:'Neo Revelation',NEO4:'Neo Destiny',
  ECARD1:'Expedition',ECARD2:'Aquapolis',ECARD3:'Skyridge',
  EX1:'Ruby & Sapphire',EX2:'Sandstorm',EX3:'Dragon',EX4:'Team Magma vs Team Aqua',EX5:'Hidden Legends',EX6:'FireRed & LeafGreen',
  EX7:'Team Rocket Returns',EX8:'Deoxys',EX9:'Emerald',EX10:'Unseen Forces',EX11:'Delta Species',EX12:'Legend Maker',
  EX13:'Holon Phantoms',EX14:'Crystal Guardians',EX16:'Power Keepers',
  DP1:'Diamond & Pearl',DP2:'Mysterious Treasures',DP3:'Secret Wonders',DP4:'Great Encounters',DP5:'Majestic Dawn',DP6:'Legends Awakened',DP7:'Stormfront',
  PL1:'Platinum',PL2:'Rising Rivals',PL3:'Supreme Victors',PL4:'Arceus',
  HGSS1:'HeartGold SoulSilver',HGSS2:'Unleashed',HGSS3:'Undaunted',HGSS4:'Triumphant',COL1:'Call of Legends',
  BW1:'Black & White',BW2:'Emerging Powers',BW3:'Noble Victories',BW4:'Next Destinies',BW5:'Dark Explorers',BW6:'Dragons Exalted',
  BW7:'Boundaries Crossed',BW8:'Plasma Storm',BW9:'Plasma Freeze',BW10:'Plasma Blast',BW11:'Legendary Treasures',
  XY1:'XY',XY2:'Flashfire',XY3:'Furious Fists',XY4:'Phantom Forces',XY5:'Primal Clash',XY6:'Roaring Skies',
  XY7:'Ancient Origins',XY8:'BREAKthrough',XY9:'BREAKpoint',XY10:'Fates Collide',XY11:'Steam Siege',XY12:'Evolutions',
  SM1:'Sun & Moon',SM2:'Guardians Rising',SM3:'Burning Shadows',SM35:'Shining Legends',SM4:'Crimson Invasion',SM5:'Ultra Prism',
  SM6:'Forbidden Light',SM7:'Celestial Storm',SM75:'Dragon Majesty',SM8:'Lost Thunder',SM9:'Team Up',SM10:'Unbroken Bonds',
  SM11:'Unified Minds',SM115:'Hidden Fates',SM12:'Cosmic Eclipse',
  SWSH1:'Sword & Shield',SWSH2:'Rebel Clash',SWSH3:'Darkness Ablaze',SWSH35:'Champions Path',SWSH4:'Vivid Voltage',
  SWSH5:'Battle Styles',SWSH6:'Chilling Reign',SWSH7:'Evolving Skies',SWSH8:'Fusion Strike',SWSH9:'Brilliant Stars',
  SWSH10:'Astral Radiance',SWSH11:'Lost Origin',SWSH12:'Silver Tempest',
  SV1:'Scarlet & Violet',SV2:'Paldea Evolved',SV3:'Obsidian Flames',SV3PT5:'151',SV4:'Paradox Rift',SV5:'Temporal Forces',
  SV6:'Twilight Masquerade',SV6PT5:'Shrouded Fable',SV7:'Stellar Crown',SV8:'Surging Sparks',SV8PT5:'Prismatic Evolutions',
  SV9:'Journey Together',SV10:'Destined Rivals',
  G1:'Generations',ME1:'Mega Evolution',ME3:'Perfect Order',
}

const PKM_SET_SIZES = {
  ME3:88,
  SV10:191,SV9:180,SV8:191,SV8PT5:96,SV7:175,SV6:167,SV6PT5:64,SV5:191,SV4:182,SV3PT5:165,SV3:197,SV2:193,SV1:198,
  SWSH12:195,SWSH11:196,SWSH10:189,SWSH9:172,SWSH8:264,SWSH7:203,SWSH6:198,SWSH5:163,SWSH4:185,SWSH35:73,SWSH3:189,SWSH2:192,SWSH1:202,
  SM12:236,SM115:68,SM11:236,SM10:214,SM9:181,SM8:214,SM75:70,SM7:168,SM6:131,SM5:156,SM4:111,SM35:73,SM3:147,SM2:145,SM1:149,
}

function buildQuery(card) {
  const name = (card.card_name || '').split(',')[0].split(' // ')[0].trim()
  const g = card.game || ''
  if (g === 'pokemon') {
    const sc = (card.set_code || '').toUpperCase()
    const setName = PKM_SET_NAMES[sc] || card.set_code || ''
    // Extract collector number from card_number (e.g. SV8-238 → 238)
    const m = (card.card_number || '').match(/^[A-Z]{2,6}\d*-(\d+)$/i)
    if (m) {
      const num = parseInt(m[1], 10)
      const baseSize = PKM_SET_SIZES[sc]
      if (baseSize) {
        // Zero-pad to 3 digits: "Pikachu ex 238/191 Surging Sparks"
        const pad = (n) => String(n).padStart(3, '0')
        return `${name} ${pad(num)}/${pad(baseSize)} ${setName}`.trim()
      }
    }
    // Fallback: name + set name (no collector number)
    return `${name} ${setName}`.trim()
  }
  if (g === 'mtg' || g === 'lorcana') return `${name} ${card.set_code || ''}`.trim()
  if (g === 'yugioh') return name
  const num = (card.card_number || '').replace(/_PR\d*$/i, '').replace(/_p\d+$/i, '').replace(/-P\d+$/i, '')
  return `${name} ${num}`.trim()
}

// ── eBay API call via CardPulse ─────────────────────────────────────────────
async function fetchComps(card) {
  const q = buildQuery(card)
  const params = new URLSearchParams({ q, grade: 'Raw', lang: 'English', exact: '1' })
  if (card.game) params.set('game', card.game)
  const res = await fetch(`${API_BASE}/api/prices?${params}`)
  if (!res.ok) {
    if (res.status === 429) throw new Error('RATE_LIMITED')
    return { error: `HTTP ${res.status}` }
  }
  return res.json()
}

// ── Claude comp validation ──────────────────────────────────────────────────
async function validateComps(card, comps, apiPrice) {
  if (!comps || comps.length === 0) return null

  const userMsg = [
    `Card: ${card.card_name}`,
    `Set: ${card.set_code || 'unknown'}`,
    `Number: ${card.card_number || 'unknown'}`,
    `Rarity: ${card.rarity || 'unknown'}`,
    `Game: ${card.game || 'unknown'}`,
    ``,
    `eBay sold comps (${comps.length} total):`,
    ...comps.map((c, i) =>
      `${i + 1}. $${c.price.toFixed(2)} — "${c.title}"${c.date ? ` (${c.date.slice(0, 10)})` : ''}`
    ),
    ``,
    `CardPulse algorithmic price: $${apiPrice.toFixed(2)}`,
  ].join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: CLAUDE_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`\n  [claude] API error: ${res.status} ${body.slice(0, 200)}`)
    return null
  }

  const data = await res.json()
  const text = data.content?.[0]?.text || ''

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.error(`\n  [claude] no JSON in response: ${text.slice(0, 100)}`)
    return null
  }

  try {
    return JSON.parse(jsonMatch[0])
  } catch (e) {
    console.error(`\n  [claude] JSON parse failed: ${e.message}`)
    return null
  }
}

// ── Price logging ───────────────────────────────────────────────────────────
async function logValidatedPrice(card, validation, apiData) {
  const validPrices = (validation.validComps || []).map(c => c.price).filter(p => p > 0)
  const avg = validation.suggestedPrice || (validPrices.length > 0
    ? validPrices.reduce((a, b) => a + b, 0) / validPrices.length
    : apiData.avg)
  const lo = validPrices.length > 0 ? Math.min(...validPrices) : apiData.lo
  const hi = validPrices.length > 0 ? Math.max(...validPrices) : apiData.hi

  const confMap = { high: 80, medium: 50, low: 25 }
  const confidence = confMap[validation.confidence] || 25

  const row = {
    card_name: card.card_name,
    grade: 'Raw',
    lang: 'English',
    price_lo: lo,
    price_avg: parseFloat(avg.toFixed(2)),
    price_hi: hi,
    confidence,
    comp_count: (validation.validComps || []).length,
    trend_30d: apiData.trend30 ?? null,
    source: 'seeder',
  }

  if (!DRY_RUN) {
    await sbInsert('price_history', row)
  }
  return row
}

// ── Utilities ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── Shared core — used by both CLI and API endpoint ─────────────────────────
// Exported for use by api/seed-prices.js
export async function seedCards(options = {}) {
  const limit = options.limit || CARDS_PER_GAME
  const gameFilter = options.gameFilter || GAME_FILTER
  const dryRun = options.dryRun ?? DRY_RUN
  const verbose = options.verbose ?? VERBOSE
  const log = options.log || console.log

  log(`[seed] Building card list (${limit} per game)...`)
  // Temporarily set GAME_FILTER for buildSeedCards if called from API
  const origFilter = GAME_FILTER
  const cardsByGame = await buildSeedCards(limit)

  const games = Object.keys(cardsByGame)
  const stats = { success: 0, noData: 0, claudeFail: 0, errors: 0, flagged: 0, total: 0 }
  const results = []

  for (let gi = 0; gi < games.length; gi++) {
    const game = games[gi]
    const cards = cardsByGame[game]
    if (!cards.length) continue

    log(`\n── ${game.toUpperCase()} (${cards.length} cards) ${'─'.repeat(40)}`)

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]
      stats.total++
      const label = `${card.card_number || ''} ${card.rarity || ''}`.trim()
      const prefix = `[${game.toUpperCase()}] ${label}`

      try {
        // Step 1: Fetch comps
        const data = await fetchComps(card)

        if (data.type === 'no-data' || data.error || !data.avg) {
          stats.noData++
          log(`${prefix} — ${card.card_name}`)
          log(`  Comps: 0 raw → skipped (no data)`)
          if (i < cards.length - 1) await sleep(CARD_DELAY_MS)
          continue
        }

        const rawComps = data.comps || []

        // Step 2: Claude validation
        const validation = await validateComps(card, rawComps, data.avg)

        if (!validation) {
          stats.claudeFail++
          // Fall back to API price — still tagged as seeder
          if (!dryRun) {
            await sbInsert('price_history', {
              card_name: card.card_name,
              grade: 'Raw', lang: 'English',
              price_lo: data.lo, price_avg: data.avg, price_hi: data.hi,
              confidence: 25, comp_count: data.totalComps,
              trend_30d: data.trend30 ?? null, source: 'seeder',
            })
          }
          log(`${prefix} — ${card.card_name}`)
          log(`  Comps: ${rawComps.length} raw → Claude failed → API fallback: $${data.avg.toFixed(2)}`)
          if (!dryRun) log(`  Logged ✓ (API fallback)`)
          if (i < cards.length - 1) await sleep(CARD_DELAY_MS)
          continue
        }

        const nValid = (validation.validComps || []).length
        const nFlagged = (validation.flaggedComps || []).length
        stats.flagged += nFlagged

        // Step 3: Log validated price
        const row = await logValidatedPrice(card, validation, data)
        stats.success++

        // Output
        log(`${prefix} — ${card.card_name}`)
        log(`  Comps: ${rawComps.length} raw → ${nValid} valid${nFlagged > 0 ? ` → flagged: ${(validation.flaggedComps || []).map(f => `"$${f.price.toFixed(2)} — ${f.reason}"`).join(', ')}` : ''}`)
        log(`  Price: $${row.price_avg.toFixed(2)} | Confidence: ${validation.confidence}`)
        if (!dryRun) log(`  Logged ✓`)
        else log(`  [dry-run] would log`)

        if (verbose && validation.notes) {
          log(`  Notes: ${validation.notes}`)
        }

        results.push({
          card: card.card_name,
          number: card.card_number,
          game,
          price: row.price_avg,
          confidence: validation.confidence,
          validComps: nValid,
          flaggedComps: nFlagged,
        })

      } catch (err) {
        if (err.message === 'RATE_LIMITED') {
          log(`\n[STOP] eBay rate limited at ${prefix}. Resume later.`)
          return { stats, results, stopped: true }
        }
        stats.errors++
        log(`${prefix} — ${card.card_name}`)
        log(`  !! Error: ${err.message}`)
      }

      if (i < cards.length - 1) await sleep(CARD_DELAY_MS)
    }

    // Delay between games
    if (gi < games.length - 1) {
      log(`\n  ⏳ ${GAME_DELAY_MS / 1000}s cooldown between games...`)
      await sleep(GAME_DELAY_MS)
    }
  }

  return { stats, results, stopped: false }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════╗`)
  console.log(`║  CardPulse Price Seeder + Claude Validator    ║`)
  console.log(`╚══════════════════════════════════════════════╝`)
  console.log(`Cards/game: ${LIMIT} | Game: ${GAME_FILTER || 'all'} | Model: ${CLAUDE_MODEL}`)
  console.log(`Dry run: ${DRY_RUN} | Verbose: ${VERBOSE}\n`)

  const startTime = Date.now()
  const { stats, stopped } = await seedCards({
    limit: LIMIT,
    gameFilter: GAME_FILTER,
    dryRun: DRY_RUN,
    verbose: VERBOSE,
  })

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
  console.log(`\n\n╔══════════════════════════════════════════════╗`)
  console.log(`║  Done in ${elapsed} min${stopped ? ' (stopped early)' : ''}`.padEnd(47) + '║')
  console.log(`╠══════════════════════════════════════════════╣`)
  console.log(`║  Total cards:   ${String(stats.total).padStart(5)}                        ║`)
  console.log(`║  Validated:     ${String(stats.success).padStart(5)}                        ║`)
  console.log(`║  No data:       ${String(stats.noData).padStart(5)}                        ║`)
  console.log(`║  Claude fail:   ${String(stats.claudeFail).padStart(5)} (API fallback)         ║`)
  console.log(`║  Errors:        ${String(stats.errors).padStart(5)}                        ║`)
  console.log(`║  Comps flagged: ${String(stats.flagged).padStart(5)}                        ║`)
  console.log(`╠══════════════════════════════════════════════╣`)
  console.log(`║  eBay calls:  ~${String((stats.success + stats.noData + stats.claudeFail) * 3).padStart(5)} / 5000 daily       ║`)
  console.log(`║  Claude calls: ${String(stats.success + stats.claudeFail).padStart(5)}                        ║`)
  console.log(`╚══════════════════════════════════════════════╝`)
}

main().catch(e => { console.error(e); process.exit(1) })
