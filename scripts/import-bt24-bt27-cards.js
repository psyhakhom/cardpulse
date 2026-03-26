/**
 * Import DBS Classic BT24-BT27 cards from the official Bandai card game site
 * into card_catalog with proper card names and rarities.
 *
 * Source: https://www.dbs-cardgame.com/us-en/cardlist/ (POST with category_exp)
 *
 * Set IDs:
 *   BT24 (Zenith of Power)       = 428024
 *   BT25 (Legend of the Dragon Balls) = 428025
 *   BT26                         = 428026
 *   BT27                         = 428027
 *
 * Prerequisites:
 *   .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 *
 * Usage: npm run import-bt24-bt27
 *   Or single set: node --env-file=.env.local scripts/import-bt24-bt27-cards.js BT27
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const BASE_URL = 'https://www.dbs-cardgame.com/us-en/cardlist/index.php'
const IMG_BASE = 'https://www.dbs-cardgame.com/images/cardlist/cardimg'

const SETS = {
  BT24: { id: 428024, name: 'Zenith of Power' },
  BT25: { id: 428025, name: 'Legend of the Dragon Balls' },
  BT26: { id: 428026, name: 'BT26' },
  BT27: { id: 428027, name: 'BT27' },
}

// ─── Fetch card list via POST ─────────────────────────────────────────────────

async function fetchSetCards(setCode, setId) {
  console.log(`\nFetching ${setCode} (ID: ${setId})...`)

  const body = new URLSearchParams({ search: 'true', category_exp: String(setId) })
  const res = await fetch(`${BASE_URL}?search=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`Fetch failed for ${setCode}: ${res.status}`)
  const html = await res.text()

  const cards = []

  // Parse card entries from HTML
  // Card number: <dt class="cardNumber">BT19-001</dt>
  // Card name: <dd class="cardName">Son Goku & Vegeta & Trunks</dd>
  // Rarity: Uncommon[UC] or Super Rare[SR] etc.

  // Extract card numbers
  const cardNumRe = /class="cardNumber"[^>]*>(BT\d+-\d{3}[A-Z]?)<\/dt>/gi
  const cardNameRe = /class="cardName"[^>]*>([^<]+)<\/dd>/gi
  const rarityRe = /(?:Common|Uncommon|Rare|Super Rare|Special Rare|Secret Rare|Campaign Rare|Son Gohan Rare|Expansion Rare|God Rare)\[([A-Z]{1,4})\]/gi

  const numbers = [...html.matchAll(cardNumRe)].map(m => m[1].toUpperCase())
  const names = [...html.matchAll(cardNameRe)].map(m => {
    return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
  })
  const rarities = [...html.matchAll(rarityRe)].map(m => m[1])

  console.log(`  Parsed: ${numbers.length} numbers, ${names.length} names, ${rarities.length} rarities`)

  // If structured parsing didn't work, try broader patterns
  if (numbers.length === 0) {
    // Try alt text pattern: alt="BT19-001 Son Goku"
    const altRe = /alt="(BT\d+-\d{3}[A-Z]?)\s+([^"]+)"/gi
    let m
    while ((m = altRe.exec(html)) !== null) {
      const cardNumber = m[1].toUpperCase()
      if (!cardNumber.startsWith(setCode)) continue
      const cardName = m[2].replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim()
      cards.push({ cardNumber, cardName, rarity: null })
    }
    console.log(`  Alt-text fallback: found ${cards.length} cards`)
  } else {
    // Zip numbers with names and rarities
    for (let i = 0; i < numbers.length; i++) {
      if (!numbers[i].startsWith(setCode)) continue
      cards.push({
        cardNumber: numbers[i],
        cardName: names[i] || numbers[i],
        rarity: rarities[i] || null,
      })
    }
  }

  // Deduplicate by card number
  const seen = new Set()
  const deduped = cards.filter(c => {
    if (seen.has(c.cardNumber)) return false
    seen.add(c.cardNumber)
    return true
  })

  console.log(`  ${deduped.length} unique ${setCode} cards`)
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

function mapCard(cardNumber, cardName, rarity, setCode) {
  // Normalize set_code to padded format: BT1 → BT01, BT19 stays BT19
  const normalizedSet = setCode.replace(/^(BT)(\d)$/, '$10$2')
  return {
    card_name: cardName,
    card_number: cardNumber,
    game: 'dbs',
    set_code: normalizedSet,
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
  console.log('Starting BT24-BT27 card import from dbs-cardgame.com...')
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to .env.local')
    process.exit(1)
  }

  // Allow single set via CLI arg: node script.js BT19
  const targetSet = process.argv[2]?.toUpperCase()
  const setsToImport = targetSet && SETS[targetSet]
    ? { [targetSet]: SETS[targetSet] }
    : SETS

  let grandTotal = 0

  for (const [setCode, { id, name }] of Object.entries(setsToImport)) {
    console.log(`\n${'═'.repeat(50)}`)
    console.log(`  ${setCode} — ${name}`)
    console.log(`${'═'.repeat(50)}`)

    const cards = await fetchSetCards(setCode, id)
    if (!cards.length) {
      console.log(`  ⚠ No cards found for ${setCode}, skipping`)
      continue
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
        if ((i + 1) % 20 === 0) console.log(`    ${i + 1}/${cards.length}...`)
      }
    }

    // Log first card
    const firstRow = mapCard(cards[0].cardNumber, cards[0].cardName, cards[0].rarity, setCode)
    console.log('\n  First card:')
    console.log(JSON.stringify(firstRow, null, 2))

    // Map and upsert in batches
    const mapped = []
    for (const c of cards) {
      mapped.push(mapCard(c.cardNumber, c.cardName, c.rarity, setCode))
      if (mapped.length >= 50) {
        await flushBatch(mapped)
        mapped.length = 0
      }
    }
    await flushBatch(mapped)

    grandTotal += cards.length
    console.log(`  ✓ ${setCode} done — ${cards.length} cards`)

    // Brief pause between sets
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
