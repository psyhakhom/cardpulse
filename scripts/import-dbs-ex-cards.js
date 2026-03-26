/**
 * Import DBS Classic EX/Anniversary/Expansion set cards from the official
 * Bandai card game website into card_catalog.
 *
 * Source: https://www.dbs-cardgame.com/asia/cardlist/ (POST with category_exp)
 *
 * EX Set IDs: 428401 (EX01) through 428425 (EX25)
 *
 * Usage:
 *   npm run import-dbs-ex          # Import all EX01-EX25
 *   node --env-file=.env.local scripts/import-dbs-ex-cards.js EX23   # Single set
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const BASE_URL = 'https://www.dbs-cardgame.com/asia/cardlist/index.php'
const IMG_BASE = 'https://www.dbs-cardgame.com/images/cardlist/cardimg'

// EX01-EX25 → category_exp 428401-428425
const SETS = {}
for (let i = 1; i <= 25; i++) {
  const code = `EX${String(i).padStart(2, '0')}`
  SETS[code] = { id: 428400 + i, name: `Expansion Set ${i}` }
}
// Override names for known sets
Object.assign(SETS.EX01, { name: 'Mighty Heroes' })
Object.assign(SETS.EX06, { name: 'Special Anniversary Box' })
Object.assign(SETS.EX13, { name: 'Special Anniversary Box 2020' })
Object.assign(SETS.EX16, { name: 'Ultimate Deck' })
Object.assign(SETS.EX19, { name: 'Special Anniversary Box 2021' })
Object.assign(SETS.EX20, { name: 'Ultimate Deck 2022' })
Object.assign(SETS.EX21, { name: '5th Anniversary Set' })
Object.assign(SETS.EX22, { name: 'Ultimate Deck 2023' })
Object.assign(SETS.EX23, { name: 'Premium Anniversary Box 2023' })
Object.assign(SETS.EX24, { name: 'Premium Anniversary Box 2024' })
Object.assign(SETS.EX25, { name: 'Premium Anniversary Box 2025' })

// ─── Fetch card list via POST ─────────────────────────────────────────────────

async function fetchSetCards(setCode, setId) {
  console.log(`\nFetching ${setCode} (ID: ${setId})...`)

  const body = new URLSearchParams({ search: 'true', category_exp: String(setId) })
  const res = await fetch(`${BASE_URL}?search=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`Fetch failed for ${setCode}: ${res.status}`)
  const html = await res.text()

  const cards = []

  // Card number pattern: EX23-01, EX23-03_PR, EX06-27 etc.
  // EX numbers use 2-digit card numbers (not 3-digit like BT)
  const cardNumRe = /class="cardNumber"[^>]*>(EX\d+-\d{2,3}[A-Z_]*)<\/dt>/gi
  const cardNameRe = /class="cardName"[^>]*>([^<]+)<\/dd>/gi
  const rarityRe = /(?:Common|Uncommon|Rare|Super Rare|Special Rare|Secret Rare|Campaign Rare|Expansion Rare|God Rare|Dragon Ball Rare)\[([A-Z]{1,4})\]/gi

  const numbers = [...html.matchAll(cardNumRe)].map(m => m[1].toUpperCase())
  const names = [...html.matchAll(cardNameRe)].map(m => {
    return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
  })
  const rarities = [...html.matchAll(rarityRe)].map(m => m[1])

  console.log(`  Parsed: ${numbers.length} numbers, ${names.length} names, ${rarities.length} rarities`)

  if (numbers.length === 0) {
    // Fallback: alt text pattern
    const altRe = /alt="(EX\d+-\d{2,3}[A-Z_]*)\s+([^"]+)"/gi
    let m
    while ((m = altRe.exec(html)) !== null) {
      const cardNumber = m[1].toUpperCase()
      if (!cardNumber.startsWith(setCode)) continue
      const cardName = m[2].replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim()
      cards.push({ cardNumber, cardName, rarity: null })
    }
    console.log(`  Alt-text fallback: found ${cards.length} cards`)
  } else {
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

// ─── Map to card_catalog row ──────────────────────────────────────────────────

function mapCard(cardNumber, cardName, rarity, setCode) {
  return {
    card_name: cardName,
    card_number: cardNumber,
    game: 'dbs',
    set_code: setCode,
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
  console.log('Starting DBS EX set import from dbs-cardgame.com...')
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to .env.local')
    process.exit(1)
  }

  // Allow single set via CLI arg: node script.js EX23
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

    // Log first card
    const firstRow = mapCard(cards[0].cardNumber, cards[0].cardName, cards[0].rarity, setCode)
    if (grandTotal === 0) {
      console.log('\n  First card:')
      console.log(JSON.stringify(firstRow, null, 2))
    }

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
