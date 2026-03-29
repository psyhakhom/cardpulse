/**
 * Clean import of BT26 "Ultimate Advent" from Bandai US-EN.
 *
 * Deletes ALL existing BT26 rows from card_catalog first, then re-imports
 * from scratch using the authoritative Bandai US-EN source. This ensures
 * no bad Asia/Deckplanet data survives.
 *
 * Source: https://www.dbs-cardgame.com/us-en/cardlist/ (POST with category_exp=428026)
 *
 * Prerequisites:
 *   .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 *
 * Usage: npm run import-bt26-clean
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const BASE_URL = 'https://www.dbs-cardgame.com/us-en/cardlist/index.php'
const IMG_BASE = 'https://www.dbs-cardgame.com/images/cardlist/cardimg'

const SET_CODE = 'BT26'
const SET_ID = 428026
const SET_NAME = 'Ultimate Advent'

// ─── Fetch card list via POST ─────────────────────────────────────────────────

async function fetchSetCards() {
  console.log(`\nFetching ${SET_CODE} (ID: ${SET_ID})...`)

  const body = new URLSearchParams({ search: 'true', category_exp: String(SET_ID) })
  const res = await fetch(`${BASE_URL}?search=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`Fetch failed for ${SET_CODE}: ${res.status}`)
  const html = await res.text()
  console.log(`  HTML size: ${(html.length / 1024).toFixed(0)}KB`)

  const cards = []

  // Try alt text first (most reliable: alt="BT26-001 Krillin")
  const altRe = /alt="(BT26-\d{3}[A-Z]?(?:_(?:PR|SPR|SCR|GDR))?)\s+([^"]+)"/gi
  let m
  while ((m = altRe.exec(html)) !== null) {
    const cardNumber = m[1].toUpperCase()
    const cardName = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
    cards.push({ cardNumber, cardName, rarity: null })
  }
  console.log(`  Parsed ${cards.length} cards from alt text`)

  // Fallback: parse cardNumber→cardName→Rarity triples from HTML
  if (cards.length === 0) {
    const tripleRe = /class="cardNumber"[^>]*>\s*(BT26-\d{3}[A-Z]?(?:_\w+)?)\s*<\/dt>\s*<dd class="cardName"[^>]*>\s*([^<]+)/gi
    const rarityLookup = /(?:Common|Uncommon|Rare|Super Rare|Special Rare|Secret Rare|Campaign Rare|Dragon Ball Rare|Son Gohan Rare|Gold Rare|Expansion Rare|God Rare)\[([A-Z]{1,4})\]/gi
    const rarPositions = []
    let rm
    while ((rm = rarityLookup.exec(html)) !== null) {
      rarPositions.push({ index: rm.index, rarity: rm[1] })
    }
    while ((m = tripleRe.exec(html)) !== null) {
      const cardNumber = m[1].toUpperCase()
      const cardName = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
      const pos = m.index
      const nextRar = rarPositions.find(r => r.index > pos)
      const rarity = nextRar ? nextRar.rarity : null
      cards.push({ cardNumber, cardName, rarity })
    }
    console.log(`  Parsed ${cards.length} cards (${cards.filter(c => c.rarity).length} with rarity)`)
  }

  // Deduplicate by card number
  const seen = new Set()
  const deduped = cards.filter(c => {
    if (seen.has(c.cardNumber)) return false
    seen.add(c.cardNumber)
    return true
  })

  console.log(`  ${deduped.length} unique ${SET_CODE} cards`)
  return deduped
}

// ─── Fetch rarity from detail page (fallback) ────────────────────────────────

async function fetchRarity(cardNumber) {
  const url = `https://www.dbs-cardgame.com/us-en/cardlist/detail.php?card_no=${cardNumber}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const html = await res.text()
    const m = html.match(/\[([A-Z]{1,4})\]/) || html.match(/class="rarity"[^>]*>([^<]+)</)
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
    image_url: `${IMG_BASE}/${cardNumber}.png`,
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
  console.log(`Starting CLEAN ${SET_CODE} "${SET_NAME}" import from Bandai US-EN...`)
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to .env.local')
    process.exit(1)
  }

  // Step 1: Fetch fresh data from Bandai BEFORE deleting
  const cards = await fetchSetCards()
  if (!cards.length) {
    console.error('  No cards fetched — aborting to protect existing data')
    process.exit(1)
  }

  // Fetch missing rarities from detail pages
  const missingRarity = cards.filter(c => !c.rarity).length
  if (missingRarity > 0) {
    console.log(`  ${missingRarity} cards missing rarity, fetching from detail pages...`)
    for (let i = 0; i < cards.length; i++) {
      if (!cards[i].rarity) {
        cards[i].rarity = await fetchRarity(cards[i].cardNumber)
        await delay(300)
      }
      if ((i + 1) % 20 === 0) console.log(`    ${i + 1}/${cards.length}...`)
    }
  }

  // Step 2: Delete all existing BT26 rows
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
  console.log(`\n  Inserting ${cards.length} clean ${SET_CODE} cards...`)

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
