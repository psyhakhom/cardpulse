/**
 * Bulk import Digimon TCG cards from apitcg.com
 * into the card_catalog Supabase table.
 *
 * Prerequisites:
 *   1. Register at https://apitcg.com/platform to get an API key
 *   2. Create .env.local with:
 *      SUPABASE_URL=https://your-project.supabase.co
 *      SUPABASE_SERVICE_KEY=your-service-role-key
 *      APITCG_KEY=your-apitcg-api-key
 *   3. Run: npm run import-digimon
 *
 * API response shape (www.apitcg.com/api/digimon/cards):
 *   { page, limit, total, totalPages, data: [ { id, code, name, level,
 *     colors, images: { small, large }, cardType, form, attribute, type,
 *     dp, playCost, digivolveCost1, digivolveCost2, effect, inheritedEffect,
 *     securityEffect, set: { id, name } } ] }
 *
 * ~5,823 cards total across all sets (ST, BT, EX, etc.).
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const API_KEY = process.env.APITCG_KEY

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchPage(page) {
  const url = `https://www.apitcg.com/api/digimon/cards?limit=100&page=${page}`
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
  const code = (card.code || card.id || '').toUpperCase()
  const rarity = (card.cardType === 'Digi-Egg' ? 'Digi-Egg' : '') || ''
  const setCode = card.set?.id?.toUpperCase() || code.replace(/-\d+$/i, '') || null
  return {
    card_name: card.name || '',
    card_number: code || null,
    game: 'digimon',
    set_code: setCode,
    rarity: rarity || null,
    image_url: card.images?.large || card.images?.small || null,
    search_query: `${card.name || ''} ${code}`.trim(),
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
  console.log('Starting Digimon TCG import from apitcg.com...')
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)
  console.log(`APITCG Key:   ${API_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to .env.local')
    process.exit(1)
  }
  if (!API_KEY) {
    console.error('\nMissing APITCG_KEY. Register at https://apitcg.com/platform')
    process.exit(1)
  }

  console.log('\nFetching page 1...')
  const first = await fetchPage(1)
  const totalCount = first.total || first.totalCount || 0
  const firstData = first.data || first.cards || first.results || []
  const totalPages = Math.ceil(totalCount / 100) || 1
  console.log(`Total cards in API: ${totalCount} (${totalPages} pages)`)

  let totalImported = 0
  let batch = []

  const firstCards = firstData.map(mapCard).filter((c) => c.card_name)
  batch.push(...firstCards)
  totalImported += firstCards.length
  console.log(`Page 1: fetched ${firstCards.length} cards`)

  if (firstCards.length > 0) {
    console.log('\n  First card data:')
    console.log(JSON.stringify(firstCards[0], null, 2))
    console.log()
  }

  if (batch.length >= 50) { await flushBatch(batch); batch = [] }

  for (let page = 2; page <= totalPages; page++) {
    await delay(200)
    try {
      const result = await fetchPage(page)
      const pageData = result.data || result.cards || result.results || []
      const cards = pageData.map(mapCard).filter((c) => c.card_name)
      batch.push(...cards)
      totalImported += cards.length
      if (page % 10 === 0) console.log(`Page ${page}/${totalPages}: total ${totalImported} cards`)
      if (batch.length >= 50) { await flushBatch(batch); batch = [] }
    } catch (err) {
      console.error(`Page ${page} failed: ${err.message}`)
    }
  }

  await flushBatch(batch)

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  ✓ Done — ${totalImported} Digimon TCG cards imported`)
  console.log(`${'═'.repeat(50)}`)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
