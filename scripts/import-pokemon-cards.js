/**
 * Bulk import all Pokemon cards from pokemontcg.io into card_catalog.
 * Paginates through all cards at 250/page.
 * Run: npm run import-pokemon
 */
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const POKEMON_API_KEY = process.env.POKEMON_TCG_API_KEY || ''
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function dedup(batch) {
  const seen = new Set()
  return batch.filter((c) => {
    const k = `${c.game}|${c.card_number || c.card_name}|${c.rarity || ''}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })
}

async function flush(batch) {
  const d = dedup(batch)
  if (!d.length) return 0
  const { error } = await supabase.from('card_catalog').upsert(d, {
    onConflict: 'game,card_number_key,rarity_key',
    ignoreDuplicates: true,
  })
  if (error) {
    console.error(`  Upsert failed (${d.length}):`, error.message)
    return 0
  }
  return d.length
}

async function fetchPage(page) {
  const headers = { Accept: 'application/json' }
  if (POKEMON_API_KEY) headers['X-Api-Key'] = POKEMON_API_KEY
  const url = `https://api.pokemontcg.io/v2/cards?pageSize=250&page=${page}&select=id,name,number,rarity,set,images`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`API returned ${res.status}`)
  return res.json()
}

async function main() {
  console.log('Importing Pokemon cards from pokemontcg.io...')
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`API key: ${POKEMON_API_KEY ? 'YES — higher rate limits' : 'NO — using free tier (slower)'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase credentials'); process.exit(1)
  }

  const PAGE_DELAY = POKEMON_API_KEY ? 100 : 500

  // Fetch first page to get totalCount
  console.log('Fetching page 1...')
  const first = await fetchPage(1)
  const totalCount = first.totalCount || 0
  const totalPages = Math.ceil(totalCount / 250)
  console.log(`Total: ${totalCount} cards, ${totalPages} pages`)

  let processed = 0, imported = 0, batch = []

  function processCards(cards) {
    for (const card of (cards || [])) {
      const setId = card.set?.id?.toUpperCase() || ''
      const cardNumber = setId && card.number ? `${setId}-${card.number}` : null

      batch.push({
        card_name: card.name || '',
        card_number: cardNumber,
        game: 'pokemon',
        set_code: setId || null,
        rarity: card.rarity || null,
        image_url: card.images?.large || card.images?.small || null,
        search_query: `${card.name || ''} ${card.number || ''} ${card.set?.name || ''} ${card.rarity || ''}`.trim(),
        times_searched: 0,
        last_searched: new Date().toISOString(),
      })
      processed++
    }
  }

  // Process first page
  processCards(first.data)
  if (batch.length >= 100) {
    imported += await flush(batch)
    batch = []
  }
  console.log(`Page 1: ${(first.data || []).length} cards, processed: ${processed}`)

  // Paginate remaining pages
  for (let page = 2; page <= totalPages; page++) {
    await delay(PAGE_DELAY)
    try {
      const result = await fetchPage(page)
      processCards(result.data)
      if (batch.length >= 100) {
        imported += await flush(batch)
        batch = []
      }
      if (processed % 1000 < 250) {
        console.log(`Processed ${processed}/${totalCount} Pokemon cards (imported: ${imported})...`)
      }
    } catch (err) {
      console.error(`Page ${page} failed: ${err.message}`)
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    imported += await flush(batch)
  }

  console.log('')
  console.log('═══════════════════════════════════════')
  console.log(`Import complete!`)
  console.log(`Total cards: ${totalCount}`)
  console.log(`Processed: ${processed}`)
  console.log(`Imported/updated: ${imported}`)
  console.log('═══════════════════════════════════════')
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
