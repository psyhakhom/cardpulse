/**
 * Clean import of SB02 "Manga Booster 02" from the official Bandai
 * Fusion World site.
 *
 * Fetches fresh data first, aborts if 0 cards returned, deletes existing
 * SB02 rows, then upserts clean data.
 *
 * Source: https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&q=SB02
 *
 * Prerequisites:
 *   .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 *
 * Usage: npm run import-sb02
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const SET_CODE = 'SB02'
const SET_NAME = 'Manga Booster 02'
const BASE_URL = 'https://www.dbs-cardgame.com/fw/en/cardlist'
const IMG_BASE = 'https://www.dbs-cardgame.com/fw/images/cards/card/en'

// ─── Fetch card list ───────────────────���──────────────────────────────────────

async function fetchCardList() {
  console.log(`\n  Fetching ${SET_CODE} card list...`)
  const url = `${BASE_URL}/?search=true&q=${SET_CODE}`
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`Card list fetch failed: ${res.status}`)
  const html = await res.text()
  console.log(`  HTML size: ${(html.length / 1024).toFixed(0)}KB`)

  // Pass 1: Parse base cards from alt text — alt="SB02-001 Trunks : Future"
  const nameMap = new Map() // cardNumber → cardName
  const altRe = /alt="(SB02-\d{3}[A-Z]?)\s+([^"]+)"/gi
  let m
  while ((m = altRe.exec(html)) !== null) {
    const num = m[1].toUpperCase()
    if (!nameMap.has(num)) {
      const name = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
      nameMap.set(num, name)
    }
  }
  console.log(`  ${nameMap.size} base cards from alt text`)

  // Pass 2: Find ALL card codes including variants (_p1, _p2, _f suffixes) from image src URLs
  // src="../../images/cards/card/en/SB02-001_f.webp?v1"
  const allCodes = new Set()
  const srcRe = /SB02-\d{3}(?:_[a-z0-9_]+)?/gi
  while ((m = srcRe.exec(html)) !== null) {
    allCodes.add(m[0].toUpperCase())
  }

  // Build card list: base cards + variants (inherit name from base)
  const cards = []
  for (const code of [...allCodes].sort()) {
    const baseNum = code.replace(/_.*$/, '')
    const cardName = nameMap.get(baseNum) || baseNum
    const suffix = code.includes('_') ? code.replace(/^.*?_/, '_') : ''
    // Parallels get suffix in name: "Trunks : Future (_P1)"
    const displayName = suffix ? `${cardName} (${suffix.replace(/_/g, '').toUpperCase()})` : cardName
    cards.push({ cardNumber: code, cardName: displayName })
  }

  console.log(`  ${cards.length} total cards (${nameMap.size} base + ${cards.length - nameMap.size} variants)`)
  return cards
}

// ─── Fetch rarity from detail page ───────────────��────────────────────────────

async function fetchRarity(cardNumber) {
  // Use base card number for detail page (variants share rarity with base)
  const baseNum = cardNumber.replace(/_.*$/, '')
  const url = `${BASE_URL}/detail.php?card_no=${baseNum}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const html = await res.text()
    const m = html.match(/class="rarity"[^>]*>([^<]+)</) ||
              html.match(/Rarity<\/[^>]+>\s*<[^>]+>([^<]+)</)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

// ─── Map to card_catalog row ──────────────────���───────────────────────────────

function mapCard(cardNumber, cardName, rarity) {
  const isVariant = cardNumber.includes('_')
  // Parallel variants get star suffix on rarity (SR → SR*, UC → UC*)
  const displayRarity = isVariant && rarity ? `${rarity}*` : (rarity || null)
  return {
    card_name: cardName,
    card_number: cardNumber,
    game: 'dbs',
    set_code: SET_CODE,
    rarity: displayRarity,
    image_url: `${IMG_BASE}/${cardNumber}.webp`,
    search_query: `${cardName} ${cardNumber} ${rarity || ''}`.trim(),
    times_searched: 0,
    last_searched: new Date().toISOString(),
  }
}

// ─── Upsert batch to Supabase ─────────────────────────────────────────────────

async function flushBatch(batch) {
  if (!batch.length) return
  const seen = new Set()
  const deduped = batch.filter(c => {
    const key = `${c.game}|${c.card_number}|${c.rarity || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const { error } = await supabase
    .from('card_catalog')
    .upsert(deduped, { onConflict: 'game,card_number_key,rarity_key', ignoreDuplicates: false })
  if (error) {
    console.error(`  Batch upsert failed (${deduped.length} cards):`, error.message)
  } else {
    console.log(`  → Upserted ${deduped.length} cards to Supabase`)
  }
}

// ─── Main ────���──────────────────��─────────────────────────���───────────────────

async function main() {
  console.log(`Starting CLEAN ${SET_CODE} "${SET_NAME}" import from Bandai FW...`)
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to .env.local')
    process.exit(1)
  }

  // Step 1: Fetch fresh data BEFORE deleting
  const cards = await fetchCardList()
  if (!cards.length) {
    console.error('  No cards fetched — aborting to protect existing data')
    process.exit(1)
  }

  // Fetch rarities from detail pages (cache by base card number)
  const rarityCache = new Map()
  const baseCards = cards.filter(c => !c.cardNumber.includes('_'))
  console.log(`\n  Fetching rarities for ${baseCards.length} base cards...`)
  for (let i = 0; i < baseCards.length; i++) {
    const rarity = await fetchRarity(baseCards[i].cardNumber)
    rarityCache.set(baseCards[i].cardNumber, rarity)
    baseCards[i].rarity = rarity
    if ((i + 1) % 20 === 0) console.log(`    ${i + 1}/${baseCards.length}...`)
    await delay(500)
  }
  // Apply cached rarities to all cards (variants inherit from base)
  for (const c of cards) {
    const baseNum = c.cardNumber.replace(/_.*$/, '')
    c.rarity = rarityCache.get(baseNum) || null
  }

  // Step 2: Delete existing rows
  console.log(`\n  Deleting existing ${SET_CODE} rows from card_catalog...`)
  const { error: delError, count } = await supabase
    .from('card_catalog')
    .delete({ count: 'exact' })
    .eq('game', 'dbs')
    .eq('set_code', SET_CODE)
  if (delError) {
    console.error(`  Delete failed:`, delError.message)
    process.exit(1)
  }
  console.log(`  Deleted ${count ?? '?'} existing ${SET_CODE} rows`)

  // Step 3: Insert fresh data
  const firstRow = mapCard(cards[0].cardNumber, cards[0].cardName, cards[0].rarity)
  console.log('\n  First card:')
  console.log(JSON.stringify(firstRow, null, 2))

  const mapped = []
  for (const c of cards) {
    mapped.push(mapCard(c.cardNumber, c.cardName, c.rarity))
    if (mapped.length >= 50) {
      await flushBatch(mapped)
      mapped.length = 0
    }
  }
  await flushBatch(mapped)

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  ✓ Clean import done — deleted ${count ?? '?'} old, inserted ${cards.length} new ${SET_CODE} cards`)
  console.log(`${'═'.repeat(50)}`)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
