/**
 * Import DBS Classic Promotion cards from the official Bandai card game site
 * into card_catalog with proper card names and rarities.
 *
 * Source: https://www.dbs-cardgame.com/us-en/cardlist/ (POST with category_exp=428901)
 *
 * Card numbers: P-001 through P-738+ (includes _PR variants)
 * ~738 unique cards, ~1041 entries with variants
 *
 * Prerequisites:
 *   .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 *
 * Usage: npm run import-dbs-promo
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const BASE_URL = 'https://www.dbs-cardgame.com/us-en/cardlist/index.php'
const IMG_BASE = 'https://www.dbs-cardgame.com/images/cardlist/cardimg'

// ─── Fetch card list via POST ─────────────────────────────────────────────────

async function fetchPromoCards() {
  console.log('\nFetching promo cards (ID: 428901)...')

  const body = new URLSearchParams({ search: 'true', category_exp: '428901' })
  const res = await fetch(`${BASE_URL}?search=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(60000), // larger timeout — big page
  })
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  const html = await res.text()
  console.log(`  HTML size: ${(html.length / 1024).toFixed(0)}KB`)

  const cards = []

  // Parse cardNumber→cardName pairs from HTML
  // <dt class="cardNumber">P-001</dt> ... <dd class="cardName">One-Hit Destruction Vegeta</dd>
  const tripleRe = /class="cardNumber"[^>]*>\s*(P-\d{3}[A-Z]?(?:_\w+)?)\s*<\/dt>\s*<dd class="cardName"[^>]*>\s*([^<]+)/gi
  const rarityLookup = /(?:Common|Uncommon|Rare|Super Rare|Special Rare|Secret Rare|Campaign Rare|Dragon Ball Rare|Son Gohan Rare|Gold Rare|Expansion Rare|God Rare)\[([A-Z]{1,4})\]/gi
  // Build array of all rarity positions in the HTML
  const rarPositions = []
  let rm
  while ((rm = rarityLookup.exec(html)) !== null) {
    rarPositions.push({ index: rm.index, rarity: rm[1] })
  }

  let m
  while ((m = tripleRe.exec(html)) !== null) {
    const cardNumber = m[1]
    const cardName = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
    // Find the closest rarity AFTER this match position
    const pos = m.index
    const nextRar = rarPositions.find(r => r.index > pos)
    const rarity = nextRar ? nextRar.rarity : null
    cards.push({ cardNumber, cardName, rarity })
  }
  console.log(`  Parsed ${cards.length} cards (${cards.filter(c => c.rarity).length} with rarity)`)

  // Deduplicate by card number
  const seen = new Set()
  const deduped = cards.filter(c => {
    if (seen.has(c.cardNumber)) return false
    seen.add(c.cardNumber)
    return true
  })

  console.log(`  ${deduped.length} unique promo cards`)
  return deduped
}

// ─── Fetch rarity from detail page (fallback when list doesn't have it) ───────

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
    set_code: 'P',
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
  console.log('Starting DBS Promo card import from dbs-cardgame.com...')
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to .env.local')
    process.exit(1)
  }

  const cards = await fetchPromoCards()
  if (!cards.length) {
    console.log('  No cards found, exiting')
    process.exit(0)
  }

  // Check how many have rarity from the list page
  const missingRarity = cards.filter(c => !c.rarity).length
  if (missingRarity > 0) {
    console.log(`  ${missingRarity} cards missing rarity, fetching from detail pages...`)
    for (let i = 0; i < cards.length; i++) {
      if (!cards[i].rarity) {
        cards[i].rarity = await fetchRarity(cards[i].cardNumber)
        await delay(300)
      }
      if ((i + 1) % 50 === 0) console.log(`    ${i + 1}/${cards.length}...`)
    }
  }

  // Log first card
  const firstRow = mapCard(cards[0].cardNumber, cards[0].cardName, cards[0].rarity)
  console.log('\n  First card:')
  console.log(JSON.stringify(firstRow, null, 2))

  // Map and upsert in batches
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
  console.log(`  Done — ${cards.length} promo cards imported`)
  console.log(`${'═'.repeat(50)}`)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
