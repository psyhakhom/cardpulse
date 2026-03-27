#!/usr/bin/env node
/**
 * Populate price_history by searching high-value cards through the deployed API.
 *
 * Usage:
 *   node scripts/populate-prices.js              # run full batch (up to 1500 cards)
 *   node scripts/populate-prices.js --limit 50   # test with 50 cards
 *   node scripts/populate-prices.js --game dbs   # only DBS cards
 *
 * Requires .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY.
 * Hits the deployed Vercel endpoint — logPriceHistory fires server-side.
 */

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const API_BASE = 'https://cardpulse-topaz.vercel.app'
const THROTTLE_MS = 2000 // 2 seconds between requests
const DEFAULT_LIMIT = 1500

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local')
  process.exit(1)
}

// Parse CLI args
const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || DEFAULT_LIMIT : DEFAULT_LIMIT
const gameIdx = args.indexOf('--game')
const GAME_FILTER = gameIdx >= 0 ? args[gameIdx + 1] : null

async function sbFetch(path, params = {}) {
  const qs = new URLSearchParams(params)
  const url = `${SUPABASE_URL}/rest/v1/${path}?${qs}`
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  })
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status}`)
  return res.json()
}

async function getHighValueCards() {
  console.log('[catalog] fetching high-value cards...')

  // Priority tiers — queried separately to control ordering
  const tiers = [
    { rarities: ['SCR', 'SCR*', 'SCR**', 'SPR', 'DBR', 'SGR'], label: 'ultra-high' },
    { rarities: ['SR*', 'SEC', 'SAR', 'SSR'], label: 'high' },
    { rarities: ['SR'], label: 'mid', gameFilter: 'dbs' }, // only DBS SR, not all games
  ]

  // Game priority order
  const GAME_ORDER = { dbs: 0, pokemon: 1, onepiece: 2, mtg: 3, yugioh: 4, lorcana: 5 }

  let allCards = []

  for (const tier of tiers) {
    const params = {
      select: 'card_name,card_number,game,rarity,set_code',
      'rarity': `in.(${tier.rarities.join(',')})`,
      order: 'game.asc,card_number.asc',
      limit: '2000',
    }
    if (GAME_FILTER) params.game = `eq.${GAME_FILTER}`
    else if (tier.gameFilter) params.game = `eq.${tier.gameFilter}`
    // Filter out null-rarity rows (old Deckplanet dupes)
    params['rarity'] = `in.(${tier.rarities.join(',')})`

    const cards = await sbFetch('card_catalog', params)
    console.log(`[catalog] ${tier.label}: ${cards.length} cards`)
    allCards = allCards.concat(cards)
  }

  // Sort: recent sets first (higher set numbers = newer), then by game priority
  // FB09 > FB07 > BT27 > BT01, then pokemon > mtg etc.
  const setNum = (c) => {
    const m = (c.set_code || c.card_number || '').match(/(\d+)/)
    return m ? parseInt(m[1]) : 0
  }
  allCards.sort((a, b) => {
    const gA = GAME_ORDER[a.game] ?? 99, gB = GAME_ORDER[b.game] ?? 99
    if (gA !== gB) return gA - gB
    return setNum(b) - setNum(a) // higher set number = newer = first
  })

  // Dedup by card_number (some cards have multiple rarity rows)
  const seen = new Set()
  allCards = allCards.filter(c => {
    const key = `${c.game}|${c.card_number}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  console.log(`[catalog] ${allCards.length} unique cards after dedup`)
  return allCards
}

async function getRecentlySearched() {
  console.log('[dedup] checking recently searched cards...')
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const rows = await sbFetch('price_history', {
    select: 'card_name',
    'queried_at': `gte.${since}`,
    limit: '5000',
  })
  const set = new Set(rows.map(r => r.card_name.toLowerCase().trim()))
  console.log(`[dedup] ${set.size} cards searched in last 24h — will skip`)
  return set
}

async function searchCard(card) {
  const q = `${card.card_name} ${card.card_number || ''}`.trim()
  const params = new URLSearchParams({
    q,
    grade: 'Raw',
    lang: 'English',
    exact: '1',
  })
  const url = `${API_BASE}/api/prices?${params}`
  const res = await fetch(url)
  if (!res.ok) {
    if (res.status === 429) throw new Error('RATE_LIMITED')
    return { error: `HTTP ${res.status}` }
  }
  return res.json()
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log(`\n=== CardPulse Price Population ===`)
  console.log(`Limit: ${LIMIT} cards | Game: ${GAME_FILTER || 'all'} | Throttle: ${THROTTLE_MS}ms\n`)

  const cards = await getHighValueCards()
  const recent = await getRecentlySearched()

  // Filter out recently searched
  const todo = cards.filter(c => {
    const q = `${c.card_name} ${c.card_number || ''}`.trim().toLowerCase()
    return !recent.has(q)
  }).slice(0, LIMIT)

  console.log(`\n[run] ${todo.length} cards to search (${cards.length} total - ${cards.length - todo.length} skipped)\n`)

  let success = 0, noData = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < todo.length; i++) {
    const card = todo[i]
    const label = `${card.card_name} ${card.card_number || ''} ${card.rarity || ''}`.trim()

    try {
      const data = await searchCard(card)

      if (data.error === 'RATE_LIMITED') {
        console.error(`\n[STOP] eBay rate limited at card ${i + 1}. Resume later.`)
        break
      }

      if (data.type === 'no-data' || data.error) {
        noData++
        process.stdout.write(`\r[${i + 1}/${todo.length}] -- no data | ${label.slice(0, 50).padEnd(50)}`)
      } else if (data.avg) {
        success++
        const avg = typeof data.avg === 'number' ? data.avg.toFixed(2) : '?'
        process.stdout.write(`\r[${i + 1}/${todo.length}] $${avg.padStart(7)} avg | ${label.slice(0, 50).padEnd(50)}`)
      } else {
        noData++
        process.stdout.write(`\r[${i + 1}/${todo.length}] -- empty  | ${label.slice(0, 50).padEnd(50)}`)
      }
    } catch (err) {
      if (err.message === 'RATE_LIMITED') {
        console.error(`\n[STOP] eBay rate limited at card ${i + 1}. Resume later.`)
        break
      }
      errors++
      process.stdout.write(`\r[${i + 1}/${todo.length}] !! error  | ${label.slice(0, 50).padEnd(50)}`)
    }

    // Throttle
    if (i < todo.length - 1) await sleep(THROTTLE_MS)
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
  console.log(`\n\n=== Done in ${elapsed} min ===`)
  console.log(`Success: ${success} | No data: ${noData} | Errors: ${errors}`)
  console.log(`eBay calls used: ~${(success + noData) * 3} of 5000 daily limit`)
}

main().catch(e => { console.error(e); process.exit(1) })
