/**
 * Import Gundam Card Game GD03 (Steel Requiem) cards from the official
 * Bandai Gundam card game website into card_catalog.
 *
 * Source: https://www.gundam-gcg.com/en/cards/
 *
 * Two-pass approach:
 *   1. Fetch card list page → extract card numbers + names from HTML
 *   2. Fetch each card's detail page → extract rarity
 *
 * All cards are returned in a single page (client-side pagination only).
 * Cross-set cards are filtered out by card number prefix.
 *
 * Parallel variants use _p1/_p2/_p3/_p5 suffixes on the card number.
 * Rarity uses +/++ suffixes for parallels (e.g., "LR +", "LR ++").
 *
 * Package IDs: GD01=616101, GD02=616102, GD03=616103,
 *   ST01=616001..ST09=616009, Beta=616000, Promo=616901
 *
 * Prerequisites:
 *   .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 *
 * Usage: npm run import-gd03
 *        npm run import-gd03 -- GD02 (override set)
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const SET_CODE = process.argv[2]?.toUpperCase() || 'GD03'
const IMG_BASE = 'https://www.gundam-gcg.com/en/images/cards/card'

// Map set codes to Bandai package IDs
const PACKAGE_IDS = {
  GD01: '616101', GD02: '616102', GD03: '616103',
  ST01: '616001', ST02: '616002', ST03: '616003',
  ST04: '616004', ST05: '616005', ST06: '616006',
  ST07: '616007', ST08: '616008', ST09: '616009',
  BETA: '616000', PROMO: '616901',
}

// ─── Pass 1: Fetch card list and extract card numbers + names ─────────────────

async function fetchCardList() {
  const pkgId = PACKAGE_IDS[SET_CODE]
  if (!pkgId) {
    console.error(`Unknown set code: ${SET_CODE}. Known: ${Object.keys(PACKAGE_IDS).join(', ')}`)
    process.exit(1)
  }

  console.log(`\nPass 1: Fetching card list for ${SET_CODE} (package ${pkgId})...`)
  const url = `https://www.gundam-gcg.com/en/cards/?search=true&package=${pkgId}`
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`Card list fetch failed: ${res.status}`)
  const html = await res.text()

  // Parse card entries: <a ... data-src="detail.php?detailSearch=GD03-001" ...>
  //                       <img ... alt="Gundam NT-1" ...>
  const cards = []
  const entryRe = /data-src="detail\.php\?detailSearch=([\w-]+)"[^>]*>\s*<img[^>]+alt="([^"]+)"/gi
  let m
  while ((m = entryRe.exec(html)) !== null) {
    const rawNumber = m[1]
    // Filter to target set only (page may include cross-set cards)
    if (!rawNumber.toUpperCase().startsWith(SET_CODE)) continue
    // Keep original case — detail pages require lowercase _p1/_p2 suffixes
    const cardNumber = rawNumber.replace(/^[^_]+/, s => s.toUpperCase())
    const cardName = m[2]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    cards.push({ cardNumber, cardName })
  }

  // Deduplicate
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
  const url = `https://www.gundam-gcg.com/en/cards/detail.php?detailSearch=${cardNumber}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const html = await res.text()

    const rarityMatch = html.match(/class="rarity"[^>]*>\s*([^<]+)</)
    return rarityMatch ? rarityMatch[1].trim() : null
  } catch (e) {
    console.log(`  ⚠ Failed to fetch rarity for ${cardNumber}: ${e.message}`)
    return null
  }
}

// ─── Map to card_catalog row ──────────────────────────────────────────────────

function mapCard(cardNumber, cardName, rarity) {
  // Normalize rarity: "LR +" → "LR+", "C ++" → "C++"
  const normRarity = rarity ? rarity.replace(/\s+/g, '') : null
  const storedNumber = cardNumber.toUpperCase()
  const isParallel = /_P\d+$/i.test(storedNumber)
  // Parallel variants get a suffix in card_name so they're distinct
  const name = isParallel
    ? `${cardName} (${storedNumber.match(/_P\d+$/)[0]})`
    : cardName
  return {
    card_name: name,
    card_number: storedNumber,
    game: 'gundam',
    set_code: SET_CODE,
    rarity: normRarity,
    image_url: `${IMG_BASE}/${cardNumber}.webp`,
    search_query: `${cardName} ${cardNumber} ${normRarity || ''}`.trim(),
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
  console.log(`Starting ${SET_CODE} card import from gundam-gcg.com...`)
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

    if (i === 0) {
      console.log('\n  First card data:')
      console.log(JSON.stringify(row, null, 2))
      console.log()
    }

    mapped.push(row)
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${cards.length} — ${cardNumber} ${cardName} [${row.rarity || '?'}]`)

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
