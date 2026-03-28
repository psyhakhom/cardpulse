/**
 * Bulk import Gundam Card Game cards from apitcg.com
 * into the card_catalog Supabase table.
 *
 * Prerequisites:
 *   1. Register at https://apitcg.com/platform to get an API key
 *   2. Create .env.local with:
 *      SUPABASE_URL=https://your-project.supabase.co
 *      SUPABASE_SERVICE_KEY=your-service-role-key
 *      APITCG_KEY=your-apitcg-api-key
 *   3. Run: npm run import-gundam
 *
 * API response shape (apitcg.com/api/gundam/cards):
 *   { page, limit, total, totalPages, data: [ { id, code, name, rarity,
 *     images: { small, large }, set: { id, name }, cardType, level, cost,
 *     color, effect, zone, trait, link, ap, hp, sourceTitle, getIt } ] }
 *
 * Sets: GD01 (Newtype Rising), GD02 (Dual Impact), ST01–ST06, promotion, beta
 * Rarities: LR, R, U, C — parallels use "LR +", "R +", "C ++" with whitespace
 *
 * NOTE: GD03 (Steel Requiem, Jan 2026) is NOT in apitcg yet (repo dormant since Nov 2025).
 * When needed, scrape directly from gundam-gcg.com (like the FB07 Bandai pattern).
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const API_KEY = process.env.APITCG_KEY

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchPage(page) {
  const url = `https://apitcg.com/api/gundam/cards?limit=100&page=${page}`
  const res = await fetch(url, {
    headers: { 'x-api-key': API_KEY },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API returned ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

// Extract direct Bandai URL from weserv.nl proxy
// "https://images.weserv.nl/?url=www.gundam-gcg.com/en/images/cards/card/GD01-001.webp?250711"
// → "https://www.gundam-gcg.com/en/images/cards/card/GD01-001.webp"
function directImageUrl(proxyUrl) {
  if (!proxyUrl) return null
  const m = proxyUrl.match(/[?&]url=([^&]+)/)
  if (!m) return proxyUrl // not a weserv URL, use as-is
  const raw = m[1].replace(/\?\d+$/, '') // strip cache-buster like ?250711
  return raw.startsWith('http') ? raw : `https://${raw}`
}

function mapCard(card) {
  const code = (card.code || card.id || '').toUpperCase()
  // Normalize rarity: "LR +" → "LR+", "C ++" → "C++"
  const rawRarity = (card.rarity || '').replace(/\s+/g, '')
  const isParallel = /\+/.test(rawRarity)
  // Parallel variants get a suffix in card_name so they're distinct
  const name = isParallel
    ? `${card.name || ''} (${rawRarity})`
    : (card.name || '')
  return {
    card_name: name,
    card_number: code || null,
    game: 'gundam',
    set_code: card.set?.id?.toUpperCase() || code.replace(/-\d+$/i, '') || null,
    rarity: rawRarity || null,
    image_url: directImageUrl(card.images?.large || card.images?.small),
    search_query: `${card.name || ''} ${code} ${rawRarity}`.trim(),
    variant_source: card.getIt || null,
    times_searched: 0,
    last_searched: new Date().toISOString(),
  }
}

async function flushBatch(batch) {
  if (!batch.length) return
  const seen = new Set()
  const deduped = batch.filter((c) => {
    const key = `${c.game}|${c.card_number || c.card_name}|${c.rarity || ''}`
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

async function main() {
  console.log('Starting Gundam Card Game import from apitcg.com...')
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)
  console.log(`APITCG Key:   ${API_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY.')
    console.error('Add them to .env.local')
    process.exit(1)
  }
  if (!API_KEY) {
    console.error('\nMissing APITCG_KEY.')
    console.error('Register at https://apitcg.com/platform to get a free API key.')
    console.error('Then add APITCG_KEY=your-key to .env.local')
    process.exit(1)
  }

  // Fetch first page to get total count
  console.log('\nFetching page 1...')
  const first = await fetchPage(1)
  const totalCount = first.totalCount || first.total || 0
  const firstData = first.data || first.cards || first.results || []
  const totalPages = Math.ceil(totalCount / 100) || 1
  console.log(`Total cards in API: ${totalCount} (${totalPages} pages)`)

  let totalImported = 0
  let batch = []

  // Process first page
  const firstCards = firstData.map(mapCard).filter((c) => c.card_name)
  batch.push(...firstCards)
  totalImported += firstCards.length
  console.log(`Page 1: fetched ${firstCards.length} cards, total imported: ${totalImported}`)

  if (firstCards.length > 0) {
    console.log('\n  First card data:')
    console.log(JSON.stringify(firstCards[0], null, 2))
    console.log()
  }

  if (batch.length >= 50) { await flushBatch(batch); batch = [] }

  // Paginate remaining pages
  for (let page = 2; page <= totalPages; page++) {
    await delay(200)

    try {
      const result = await fetchPage(page)
      const pageData = result.data || result.cards || result.results || []
      const cards = pageData.map(mapCard).filter((c) => c.card_name)
      batch.push(...cards)
      totalImported += cards.length
      console.log(`Page ${page}: fetched ${cards.length} cards, total imported: ${totalImported}`)

      if (batch.length >= 50) { await flushBatch(batch); batch = [] }
    } catch (err) {
      console.error(`Page ${page} failed: ${err.message}`)
    }
  }

  // Flush remaining
  await flushBatch(batch)

  console.log('')
  console.log('═══════════════════════════════════════')
  console.log(`Import complete. Total cards imported: ${totalImported}`)
  console.log('═══════════════════════════════════════')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
