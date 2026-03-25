/**
 * Import DBS Fusion World FB07 (Wish for Shenron) cards from the official
 * Bandai card game website into card_catalog.
 *
 * Source: https://www.dbs-cardgame.com/fw/en/cardlist/
 *
 * Two-pass approach:
 *   1. Fetch card list page → extract card numbers + names from alt text
 *   2. Fetch each card's detail page → extract rarity
 *
 * Prerequisites:
 *   .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 *
 * Usage: npm run import-fb07
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const SET_CODE = process.argv[2]?.toUpperCase() || 'FB07'
const BASE_URL = 'https://www.dbs-cardgame.com/fw/en/cardlist'
const IMG_BASE = 'https://www.dbs-cardgame.com/fw/images/cards/card/en'

// ─── Pass 1: Fetch card list and extract card numbers + names ─────────────────

async function fetchCardList() {
  console.log(`\nPass 1: Fetching card list for ${SET_CODE}...`)
  const url = `${BASE_URL}/?search=true&q=${SET_CODE}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`Card list fetch failed: ${res.status}`)
  const html = await res.text()

  // Parse alt attributes: alt="FB07-001 Glorio : DA"
  const cards = []
  const altRe = /alt="((?:FB|BT|FS|SD|ST|SB|EB|TB|OP)\d{2}-\d{3}[A-Z]?)\s+([^"]+)"/gi
  let m
  while ((m = altRe.exec(html)) !== null) {
    const cardNumber = m[1].toUpperCase()
    // Only include cards from the target set
    if (!cardNumber.startsWith(SET_CODE)) continue
    const cardName = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    cards.push({ cardNumber, cardName })
  }

  // Deduplicate (parallel variants may appear multiple times)
  const seen = new Set()
  const deduped = cards.filter(c => {
    if (seen.has(c.cardNumber)) return false
    seen.add(c.cardNumber)
    return true
  })

  console.log(`  Found ${deduped.length} unique ${SET_CODE} cards`)
  return deduped
}

// ─── Pass 2: Fetch rarity from individual card detail pages ───────────────────

async function fetchRarity(cardNumber) {
  const url = `${BASE_URL}/detail.php?card_no=${cardNumber}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const html = await res.text()

    // Look for rarity in the HTML — typically: <div class="rarity">L</div>
    // or in text content near "Rarity" label
    const rarityMatch = html.match(/class="rarity"[^>]*>([^<]+)</) ||
                        html.match(/Rarity<\/[^>]+>\s*<[^>]+>([^<]+)</)
    return rarityMatch ? rarityMatch[1].trim() : null
  } catch (e) {
    console.log(`  ⚠ Failed to fetch rarity for ${cardNumber}: ${e.message}`)
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
  console.log(`Starting ${SET_CODE} card import from dbs-cardgame.com...`)
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to .env.local')
    process.exit(1)
  }

  // Pass 1: get card list
  const cards = await fetchCardList()
  if (!cards.length) {
    console.error(`No ${SET_CODE} cards found on the page.`)
    process.exit(1)
  }

  // Pass 2: fetch rarity for each card
  console.log(`\nPass 2: Fetching rarity for ${cards.length} cards (with 500ms delay)...`)
  const mapped = []
  for (let i = 0; i < cards.length; i++) {
    const { cardNumber, cardName } = cards[i]
    const rarity = await fetchRarity(cardNumber)
    const row = mapCard(cardNumber, cardName, rarity)

    // Log first card's full data structure
    if (i === 0) {
      console.log('\n  First card data:')
      console.log(JSON.stringify(row, null, 2))
      console.log()
    }

    mapped.push(row)
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${cards.length} — ${cardNumber} ${cardName} [${rarity || '?'}]`)

    // Flush every 50 cards
    if (mapped.length >= 50) {
      await flushBatch(mapped)
      mapped.length = 0
    }

    await delay(500)
  }

  // Flush remaining
  await flushBatch(mapped)

  console.log(`\n✓ Done — imported ${cards.length} ${SET_CODE} cards`)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
