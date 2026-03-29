/**
 * Clean import of FS11 and FS12 starter decks from the official Bandai
 * Fusion World site.
 *
 * For each set: fetches fresh data first, aborts if 0 cards returned,
 * deletes existing rows for that set_code, then upserts clean data.
 *
 * Source: https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&q=FS11
 *
 * Note: FS starter decks use 2-digit card numbers (FS11-01) not 3-digit.
 *
 * Prerequisites:
 *   .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 *
 * Usage: npm run import-fs11-fs12
 *   Or single set: node --env-file=.env.local scripts/import-fs11-fs12-cards.js FS12
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const BASE_URL = 'https://www.dbs-cardgame.com/fw/en/cardlist'
const IMG_BASE = 'https://www.dbs-cardgame.com/fw/images/cards/card/en'

const SETS = {
  FS11: { name: 'Starter Deck FS11' },
  FS12: { name: 'Starter Deck FS12' },
}

// ─── Fetch card list ──────────────────────────────────────────────────────────

async function fetchCardList(setCode) {
  console.log(`\n  Fetching ${setCode} card list...`)
  const url = `${BASE_URL}/?search=true&q=${setCode}`
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`Card list fetch failed: ${res.status}`)
  const html = await res.text()
  console.log(`  HTML size: ${(html.length / 1024).toFixed(0)}KB`)

  const cards = []
  // FS starter decks use 2-digit numbers: alt="FS11-01 Son Goku"
  const altRe = new RegExp(`alt="(${setCode}-\\d{2,3}[A-Z]?)\\s+([^"]+)"`, 'gi')
  let m
  while ((m = altRe.exec(html)) !== null) {
    const cardNumber = m[1].toUpperCase()
    const cardName = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
    cards.push({ cardNumber, cardName })
  }

  const seen = new Set()
  const deduped = cards.filter(c => {
    if (seen.has(c.cardNumber)) return false
    seen.add(c.cardNumber)
    return true
  })

  console.log(`  ${deduped.length} unique ${setCode} cards`)
  return deduped
}

// ─── Fetch rarity from detail page ────────────────────────────────────────────

async function fetchRarity(cardNumber) {
  const url = `${BASE_URL}/detail.php?card_no=${cardNumber}`
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

// ─── Map to card_catalog row ──────────────────────────────────────────────────

function mapCard(cardNumber, cardName, rarity, setCode) {
  return {
    card_name: cardName,
    card_number: cardNumber,
    game: 'dbs',
    set_code: setCode,
    rarity: rarity || null,
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

// ─── Process one set ──────────────────────────────────────────────────────────

async function processSet(setCode, setName) {
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  ${setCode} — ${setName}`)
  console.log(`${'═'.repeat(50)}`)

  // Step 1: Fetch fresh data BEFORE deleting
  const cards = await fetchCardList(setCode)
  if (!cards.length) {
    console.error(`  ⚠ No cards fetched for ${setCode} — skipping to protect existing data`)
    return 0
  }

  // Fetch rarities from detail pages
  console.log(`\n  Fetching rarities for ${cards.length} cards...`)
  for (let i = 0; i < cards.length; i++) {
    cards[i].rarity = await fetchRarity(cards[i].cardNumber)
    if ((i + 1) % 10 === 0) console.log(`    ${i + 1}/${cards.length}...`)
    await delay(500)
  }

  // Step 2: Delete existing rows
  console.log(`\n  Deleting existing ${setCode} rows from card_catalog...`)
  const { error: delError, count } = await supabase
    .from('card_catalog')
    .delete({ count: 'exact' })
    .eq('game', 'dbs')
    .eq('set_code', setCode)
  if (delError) {
    console.error(`  Delete failed for ${setCode}:`, delError.message)
    return 0
  }
  console.log(`  Deleted ${count ?? '?'} existing ${setCode} rows`)

  // Step 3: Insert fresh data
  const firstRow = mapCard(cards[0].cardNumber, cards[0].cardName, cards[0].rarity, setCode)
  console.log('\n  First card:')
  console.log(JSON.stringify(firstRow, null, 2))

  const mapped = []
  for (const c of cards) {
    mapped.push(mapCard(c.cardNumber, c.cardName, c.rarity, setCode))
    if (mapped.length >= 50) {
      await flushBatch(mapped)
      mapped.length = 0
    }
  }
  await flushBatch(mapped)

  console.log(`  ✓ ${setCode} done — deleted ${count ?? '?'} old, inserted ${cards.length} new`)
  return cards.length
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting CLEAN FS11-FS12 import from Bandai FW...')
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to .env.local')
    process.exit(1)
  }

  const targetSet = process.argv[2]?.toUpperCase()
  const setsToImport = targetSet && SETS[targetSet]
    ? { [targetSet]: SETS[targetSet] }
    : SETS

  let grandTotal = 0

  for (const [setCode, { name }] of Object.entries(setsToImport)) {
    try {
      grandTotal += await processSet(setCode, name)
    } catch (e) {
      console.error(`  ✗ ${setCode} failed: ${e.message}`)
      console.error(`    Continuing with next set...`)
    }
    await delay(1000)
  }

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  ✓ All done — ${grandTotal} total cards imported`)
  console.log(`${'═'.repeat(50)}`)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
