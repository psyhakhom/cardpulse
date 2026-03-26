/**
 * Fill in placeholder names for BT01-BT18 + TB01-TB03 cards in card_catalog.
 * Existing rows have card_name = card_number (e.g. "BT2-001") with null rarity.
 * This script fetches real names, rarities, and image URLs from Bandai US-EN.
 *
 * Only updates rows where card_name = card_number (placeholder).
 * Rows with real names are left untouched.
 *
 * Source: https://www.dbs-cardgame.com/us-en/cardlist/ (POST with category_exp)
 *
 * Usage:
 *   npm run import-bt01-bt18-names         # All sets
 *   node --env-file=.env.local scripts/import-dbs-bt01-bt18-names.js BT01  # Single set
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const BASE_URL = 'https://www.dbs-cardgame.com/us-en/cardlist/index.php'
const IMG_BASE = 'https://www.dbs-cardgame.com/images/cardlist/cardimg'

const SETS = {}
// BT01-BT18: category_exp 428001-428018
for (let i = 1; i <= 18; i++) {
  // Bandai uses non-padded: BT1, BT2, ... BT10, BT11, etc.
  const code = `BT${i}`
  const padded = `BT${String(i).padStart(2, '0')}`
  SETS[padded] = { id: 428000 + i, searchCode: code }
}
// TB01-TB03: category_exp 428101-428103
for (let i = 1; i <= 3; i++) {
  const code = `TB${i}`
  const padded = `TB${String(i).padStart(2, '0')}`
  SETS[padded] = { id: 428100 + i, searchCode: code }
}

// ─── Fetch card list from Bandai ──────────────────────────────────────────────

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

  // Card number: BT1-001, BT10-131, TB1-001 etc.
  const cardNumRe = /class="cardNumber"[^>]*>((?:BT|TB)\d+-\d{3}[A-Z_]*)<\/dt>/gi
  const cardNameRe = /class="cardName"[^>]*>([^<]+)<\/dd>/gi
  const rarityRe = /(?:Common|Uncommon|Rare|Super Rare|Special Rare|Secret Rare|Campaign Rare|Expansion Rare|God Rare|Dragon Ball Rare|Son Gohan Rare)\[([A-Z]{1,4})\]/gi

  const numbers = [...html.matchAll(cardNumRe)].map(m => m[1].toUpperCase())
  const names = [...html.matchAll(cardNameRe)].map(m => {
    return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
  })
  const rarities = [...html.matchAll(rarityRe)].map(m => m[1])

  console.log(`  Parsed: ${numbers.length} numbers, ${names.length} names, ${rarities.length} rarities`)

  if (numbers.length === 0) {
    console.log(`  ⚠ No cards parsed for ${setCode}`)
    return []
  }

  // Zip — filter to only this set's cards
  for (let i = 0; i < numbers.length; i++) {
    if (!numbers[i].startsWith(setCode)) continue
    cards.push({
      cardNumber: numbers[i],
      cardName: names[i] || numbers[i],
      rarity: rarities[i] || null,
    })
  }

  // Deduplicate by card number (keep first occurrence)
  const seen = new Set()
  const deduped = cards.filter(c => {
    if (seen.has(c.cardNumber)) return false
    seen.add(c.cardNumber)
    return true
  })

  console.log(`  ${deduped.length} unique ${setCode} cards from Bandai`)
  return deduped
}

// ─── Update placeholders in Supabase ──────────────────────────────────────────

async function updatePlaceholders(bandaiCards, setCode) {
  // Fetch existing placeholder rows for this set (card_name = card_number)
  const prefix = setCode + '-'
  const { data: existing, error } = await supabase
    .from('card_catalog')
    .select('id,card_name,card_number,rarity')
    .eq('game', 'dbs')
    .like('card_number', prefix + '%')

  if (error) {
    console.error(`  Failed to fetch existing rows: ${error.message}`)
    return 0
  }

  // Build lookup: card_number → bandai data
  const bandaiMap = new Map()
  for (const c of bandaiCards) {
    bandaiMap.set(c.cardNumber, c)
  }

  let updated = 0
  const batch = []

  for (const row of existing) {
    // Only update placeholders (card_name = card_number)
    if (row.card_name !== row.card_number) continue

    const bandai = bandaiMap.get(row.card_number)
    if (!bandai) continue

    // Update by id directly — avoids upsert constraint issues
    const updateData = {
      card_name: bandai.cardName,
      set_code: setCode.replace(/^(BT|TB)(\d)$/, '$10$2'),
      rarity: bandai.rarity || null,
      image_url: `${IMG_BASE}/${row.card_number}.png`,
      search_query: `${bandai.cardName} ${row.card_number} ${bandai.rarity || ''}`.trim(),
    }
    batch.push({ id: row.id, ...updateData })
    updated++

    if (batch.length >= 50) {
      for (const row of batch) {
        const { id, ...data } = row
        await supabase.from('card_catalog').update(data).eq('id', id)
      }
      console.log(`  → Updated ${batch.length} placeholders`)
      batch.length = 0
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    for (const row of batch) {
      const { id, ...data } = row
      await supabase.from('card_catalog').update(data).eq('id', id)
    }
    console.log(`  → Updated ${batch.length} placeholders`)
  }

  // Also insert NEW cards from Bandai that don't exist in catalog at all
  // (e.g. SPR variants that Deckplanet didn't have)
  const existingNums = new Set(existing.map(r => r.card_number))
  const newCards = bandaiCards.filter(c => !existingNums.has(c.cardNumber))
  if (newCards.length > 0) {
    const newBatch = newCards.map(c => ({
      card_name: c.cardName,
      card_number: c.cardNumber,
      game: 'dbs',
      set_code: setCode.replace(/^(BT|TB)(\d)$/, '$10$2'),
      rarity: c.rarity || null,
      image_url: `${IMG_BASE}/${c.cardNumber}.png`,
      search_query: `${c.cardName} ${c.cardNumber} ${c.rarity || ''}`.trim(),
      times_searched: 0,
      last_searched: new Date().toISOString(),
    }))
    const { error: nErr } = await supabase
      .from('card_catalog')
      .upsert(newBatch, { onConflict: 'game,card_number_key,rarity_key', ignoreDuplicates: false })
    if (nErr) console.error(`  New card insert failed: ${nErr.message}`)
    else console.log(`  → Inserted ${newCards.length} new cards (not in catalog before)`)
  }

  return updated
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting BT01-BT18 + TB01-TB03 name fill from dbs-cardgame.com (US-EN)...')
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to .env.local')
    process.exit(1)
  }

  // Allow single set via CLI arg: node script.js BT01
  const targetArg = process.argv[2]?.toUpperCase()
  // Normalize: BT1 → BT01, TB2 → TB02
  const targetSet = targetArg?.replace(/^(BT|TB)(\d)$/, '$10$2')
  const setsToImport = targetSet && SETS[targetSet]
    ? { [targetSet]: SETS[targetSet] }
    : SETS

  let grandTotal = 0

  for (const [setCode, { id, searchCode }] of Object.entries(setsToImport)) {
    console.log(`\n${'═'.repeat(50)}`)
    console.log(`  ${setCode}`)
    console.log(`${'═'.repeat(50)}`)

    const bandaiCards = await fetchSetCards(searchCode, id)
    if (!bandaiCards.length) {
      console.log(`  ⚠ No cards from Bandai for ${setCode}, skipping`)
      continue
    }

    // Log first card
    if (grandTotal === 0) {
      console.log('\n  First Bandai card:')
      console.log(`  ${bandaiCards[0].cardNumber} | ${bandaiCards[0].cardName} | ${bandaiCards[0].rarity}`)
    }

    const updated = await updatePlaceholders(bandaiCards, searchCode)
    grandTotal += updated
    console.log(`  ✓ ${setCode} done — ${updated} placeholders filled`)

    await delay(1000)
  }

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  ✓ All done — ${grandTotal} placeholders filled`)
  console.log(`${'═'.repeat(50)}`)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
