/**
 * Vercel Cron endpoint for nightly price seeding.
 * Runs top 20 cards per game with Claude comp validation.
 *
 * Cron schedule: nightly at 2am UTC (configured in vercel.json)
 * Manual trigger: GET /api/seed-prices?limit=5&game=dbs
 */

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const API_BASE = 'https://cardpulse-topaz.vercel.app'
const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
const CARD_DELAY_MS = 2000
const GAME_DELAY_MS = 10000
const DEFAULT_LIMIT = 20

const CLAUDE_SYSTEM = `You are a trading card comp validator. Given a card name, set, rarity, and a list of eBay sold listings, identify which comps are bad and explain why. Bad comps include: wrong card, wrong set, wrong language, lot listings, graded slabs, bundle deals, damaged cards, suspiciously high/low outliers (>3x or <0.25x median). Return JSON only:
{
  "validComps": [{"title": "...", "price": 0.00, "reason": "clean"}],
  "flaggedComps": [{"title": "...", "price": 0.00, "reason": "explanation"}],
  "suggestedPrice": 0.00,
  "confidence": "high|medium|low",
  "notes": "any observations"
}`

const RARITY_TIERS = {
  dbs: [['SCR','SCR*','SCR**','GDR'],['SPR','DBR','SGR'],['SR*','SEC','SAR','SSR']],
  pokemon: [['Special Illustration Rare','Mega Hyper Rare'],['Hyper Rare','Illustration Rare'],['Ultra Rare','Rare Secret']],
  onepiece: [['SEC','Manga Rare'],['SPR','SR']],
  mtg: [['Mythic']],
  yugioh: [['Secret Rare','Starlight Rare']],
  lorcana: [['Legendary','Enchanted']],
  gundam: [['SCR','SR']],
  digimon: [['SEC','SR']],
}

const PKM_SETS = {
  SV1:'Scarlet & Violet',SV2:'Paldea Evolved',SV3:'Obsidian Flames',SV3PT5:'151',
  SV4:'Paradox Rift',SV5:'Temporal Forces',SV6:'Twilight Masquerade',
  SV7:'Stellar Crown',SV8:'Surging Sparks',SV9:'Journey Together',SV10:'Destined Rivals',
  ME3:'Perfect Order',SM115:'Hidden Fates',SWSH7:'Evolving Skies',
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function sbFetch(path, params = {}) {
  const qs = new URLSearchParams(params)
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${qs}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status}`)
  return res.json()
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  })
  if (!res.ok) throw new Error(`Supabase insert: ${res.status}`)
}

function buildQuery(card) {
  const name = (card.card_name || '').split(',')[0].split(' // ')[0].trim()
  const g = card.game || ''
  if (g === 'pokemon') return `${name} ${PKM_SETS[(card.set_code || '').toUpperCase()] || card.set_code || ''}`.trim()
  if (g === 'mtg' || g === 'lorcana') return `${name} ${card.set_code || ''}`.trim()
  if (g === 'yugioh') return name
  const num = (card.card_number || '').replace(/_PR\d*$/i, '').replace(/_p\d+$/i, '').replace(/-P\d+$/i, '')
  return `${name} ${num}`.trim()
}

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

async function validateComps(card, comps, apiPrice) {
  if (!comps?.length) return null
  const userMsg = [
    `Card: ${card.card_name}`, `Set: ${card.set_code || 'unknown'}`,
    `Number: ${card.card_number || 'unknown'}`, `Rarity: ${card.rarity || 'unknown'}`,
    `Game: ${card.game || 'unknown'}`, '',
    `eBay sold comps (${comps.length} total):`,
    ...comps.map((c, i) => `${i + 1}. $${c.price.toFixed(2)} — "${c.title}"${c.date ? ` (${c.date.slice(0, 10)})` : ''}`),
    '', `CardPulse algorithmic price: $${apiPrice.toFixed(2)}`,
  ].join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 1024,
      system: CLAUDE_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })
  if (!res.ok) return null

  const data = await res.json()
  const text = data.content?.[0]?.text || ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try { return JSON.parse(jsonMatch[0]) } catch { return null }
}

// ── Build card list ─────────────────────────────────────────────────────────
async function buildCards(limit, gameFilter) {
  const games = gameFilter ? [gameFilter] : Object.keys(RARITY_TIERS)
  const result = {}
  for (const game of games) {
    const tiers = RARITY_TIERS[game] || []
    const cards = []
    const seen = new Set()
    for (const rarities of tiers) {
      if (cards.length >= limit) break
      const rows = await sbFetch('card_catalog', {
        select: 'card_name,card_number,game,rarity,set_code',
        game: `eq.${game}`,
        rarity: `in.(${rarities.join(',')})`,
        order: 'card_number.desc',
        limit: String(limit + 20),
      })
      for (const r of rows) {
        if (cards.length >= limit) break
        const key = `${r.game}|${r.card_number}`
        if (seen.has(key)) continue
        seen.add(key); cards.push(r)
      }
    }
    result[game] = cards
  }
  return result
}

// ── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Verify cron secret or allow manual trigger
  const authHeader = req.headers['authorization']
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // Allow without auth if no CRON_SECRET configured (dev mode)
    if (cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Missing environment variables' })
  }

  const limit = parseInt(req.query?.limit) || DEFAULT_LIMIT
  const gameFilter = req.query?.game || null

  const logs = []
  const log = (msg) => { logs.push(msg); console.log(msg) }

  log(`[seed-cron] Starting: ${limit} cards/game, game=${gameFilter || 'all'}`)

  const stats = { success: 0, noData: 0, claudeFail: 0, errors: 0, flagged: 0 }
  const results = []

  try {
    const cardsByGame = await buildCards(limit, gameFilter)

    for (const [gi, game] of Object.keys(cardsByGame).entries()) {
      const cards = cardsByGame[game]
      if (!cards.length) continue

      log(`[${game.toUpperCase()}] Processing ${cards.length} cards`)

      for (let i = 0; i < cards.length; i++) {
        const card = cards[i]
        const label = `${card.card_number || ''} ${card.rarity || ''}`.trim()

        try {
          const data = await fetchComps(card)

          if (data.type === 'no-data' || data.error || !data.avg) {
            stats.noData++
            log(`  ${label} — ${card.card_name}: no data`)
            if (i < cards.length - 1) await sleep(CARD_DELAY_MS)
            continue
          }

          const rawComps = data.comps || []
          const validation = await validateComps(card, rawComps, data.avg)

          if (!validation) {
            stats.claudeFail++
            await sbInsert('price_history', {
              card_name: card.card_name, grade: 'Raw', lang: 'English',
              price_lo: data.lo, price_avg: data.avg, price_hi: data.hi,
              confidence: 25, comp_count: data.totalComps,
              trend_30d: data.trend30 ?? null, source: 'seeder',
            })
            log(`  ${label} — ${card.card_name}: $${data.avg.toFixed(2)} (API fallback)`)
            if (i < cards.length - 1) await sleep(CARD_DELAY_MS)
            continue
          }

          const nValid = (validation.validComps || []).length
          const nFlagged = (validation.flaggedComps || []).length
          stats.flagged += nFlagged

          const validPrices = (validation.validComps || []).map(c => c.price).filter(p => p > 0)
          const avg = validation.suggestedPrice || (validPrices.length > 0
            ? validPrices.reduce((a, b) => a + b, 0) / validPrices.length : data.avg)
          const confMap = { high: 80, medium: 50, low: 25 }

          await sbInsert('price_history', {
            card_name: card.card_name, grade: 'Raw', lang: 'English',
            price_lo: validPrices.length > 0 ? Math.min(...validPrices) : data.lo,
            price_avg: parseFloat(avg.toFixed(2)),
            price_hi: validPrices.length > 0 ? Math.max(...validPrices) : data.hi,
            confidence: confMap[validation.confidence] || 25,
            comp_count: nValid,
            trend_30d: data.trend30 ?? null, source: 'seeder',
          })
          stats.success++

          const flagStr = nFlagged > 0 ? ` (${nFlagged} flagged)` : ''
          log(`  ${label} — ${card.card_name}: $${avg.toFixed(2)} | ${validation.confidence}${flagStr} ✓`)

          results.push({
            card: card.card_name, number: card.card_number, game,
            price: parseFloat(avg.toFixed(2)), confidence: validation.confidence,
            validComps: nValid, flaggedComps: nFlagged,
          })

        } catch (err) {
          if (err.message === 'RATE_LIMITED') {
            log(`[STOP] eBay rate limited`)
            break
          }
          stats.errors++
          log(`  ${label} — ${card.card_name}: ERROR ${err.message}`)
        }

        if (i < cards.length - 1) await sleep(CARD_DELAY_MS)
      }

      // Delay between games
      if (gi < Object.keys(cardsByGame).length - 1) await sleep(GAME_DELAY_MS)
    }
  } catch (err) {
    log(`[seed-cron] Fatal: ${err.message}`)
    return res.status(500).json({ error: err.message, stats, logs })
  }

  log(`[seed-cron] Done: ${stats.success} validated, ${stats.noData} no-data, ${stats.claudeFail} claude-fail, ${stats.errors} errors, ${stats.flagged} flagged`)

  return res.status(200).json({ stats, results, logs })
}
