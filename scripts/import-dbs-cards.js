/**
 * Bulk import Dragon Ball Super Fusion World cards from apitcg.com
 * into the card_catalog Supabase table.
 *
 * Prerequisites:
 *   1. Register at https://apitcg.com/platform to get an API key
 *   2. Create .env.local with:
 *      SUPABASE_URL=https://your-project.supabase.co
 *      SUPABASE_SERVICE_KEY=your-service-role-key
 *      APITCG_KEY=your-apitcg-api-key
 *   3. Run: npm run import-dbs
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const API_KEY = process.env.APITCG_KEY

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchPage(page) {
  const url = `https://apitcg.com/api/dragon-ball-fusion/cards?limit=100&page=${page}`
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

function mapCard(card) {
  return {
    card_name: card.name || '',
    game: 'dbs',
    set_code: card.set?.id?.toUpperCase() || card.code?.replace(/-\d+$/, '') || null,
    rarity: card.rarity || null,
    image_url: card.images?.large || card.images?.small || card.image || null,
    search_query: `${card.name || ''} ${card.code || ''} ${card.rarity || ''}`.trim(),
    times_searched: 0,
    last_searched: new Date().toISOString(),
  }
}

async function flushBatch(batch) {
  if (!batch.length) return
  const { error } = await supabase
    .from('card_catalog')
    .upsert(batch, { onConflict: 'card_name,game,rarity_key', ignoreDuplicates: false })
  if (error) {
    console.error(`  Batch upsert failed (${batch.length} cards):`, error.message)
  } else {
    console.log(`  → Upserted ${batch.length} cards to Supabase`)
  }
}

async function main() {
  console.log('Starting DBS Fusion World card import from apitcg.com...')
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

  // Fetch first page to get totalCount
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
