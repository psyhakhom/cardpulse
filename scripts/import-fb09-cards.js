/**
 * Clean import of FB09 "Dual Evolution" from the official Bandai Fusion World site.
 *
 * Fetches fresh data first, aborts if 0 cards returned, deletes existing
 * FB09 rows, then upserts clean data.
 *
 * Source: https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&q=FB09
 *
 * Prerequisites:
 *   .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 *
 * Usage: npm run import-fb09
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const SET_CODE = 'FB09'
const SET_NAME = 'Dual Evolution'
const BASE_URL = 'https://www.dbs-cardgame.com/fw/en/cardlist'
const IMG_BASE = 'https://www.dbs-cardgame.com/fw/images/cards/card/en'

// ─── Fetch card list ──────────────────────────────────────────────────────────

async function fetchCardList() {
  console.log(`\n  Fetching ${SET_CODE} card list...`)
  const url = `${BASE_URL}/?search=true&q=${SET_CODE}`
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`Card list fetch failed: ${res.status}`)
  const html = await res.text()
  console.log(`  HTML size: ${(html.length / 1024).toFixed(0)}KB`)

  const cards = []
  const altRe = /alt="((?:FB|FS|SB|EB)\d{2}-\d{3}[A-Z]?)\s+([^"]+)"/gi
  let m
  while ((m = altRe.exec(html)) !== null) {
    const cardNumber = m[1].toUpperCase()
    if (!cardNumber.startsWith(SET_CODE)) continue
    const cardName = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
    cards.push({ cardNumber, cardName })
  }

  const seen = new Set()
  const deduped = cards.filter(c => {
    if (seen.has(c.cardNumber)) return false
    seen.add(c.cardNumber)
    return true
  })

  console.log(`  ${deduped.length} unique ${SET_CODE} cards`)
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

function mapCard(cardNumber, cardName, rarity) {
  return {
    card_name: cardName,
    card_number: cardNumber,
    game: 'dbs',
    set_code: SET_CODE,
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

// ─── Main ─────────────────────────────────────────────────────────────────────

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

  // Fetch rarities from detail pages
  console.log(`\n  Fetching rarities for ${cards.length} cards...`)
  for (let i = 0; i < cards.length; i++) {
    cards[i].rarity = await fetchRarity(cards[i].cardNumber)
    if ((i + 1) % 20 === 0) console.log(`    ${i + 1}/${cards.length}...`)
    await delay(500)
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
