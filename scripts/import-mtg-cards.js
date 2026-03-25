/**
 * Bulk import all MTG cards from Scryfall's default_cards bulk data.
 * Downloads ~200MB JSON with 300,000+ printings.
 * Filters out tokens and art cards, imports ~250,000 game cards.
 * Takes 10-20 minutes. Run: npm run import-mtg
 */
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const SKIP_LAYOUTS = new Set(['token', 'art_series', 'double_faced_token'])
const SKIP_SET_TYPES = new Set(['memorabilia', 'token'])

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

async function main() {
  console.log('Importing MTG cards from Scryfall bulk data...')
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase credentials'); process.exit(1)
  }

  // Step 1: Get bulk data download URL
  console.log('Fetching bulk data manifest...')
  const manifest = await fetch('https://api.scryfall.com/bulk-data')
  const json = await manifest.json()
  const entry = json.data.find((d) => d.type === 'default_cards')
  if (!entry) throw new Error('default_cards not found in bulk-data manifest')
  console.log(`Found: ${entry.name} (${entry.size ? Math.round(entry.size / 1024 / 1024) + 'MB' : 'unknown size'})`)
  console.log(`Updated: ${entry.updated_at}`)

  // Step 2: Download bulk JSON
  console.log('Downloading bulk card data (this may take a minute)...')
  const bulkRes = await fetch(entry.download_uri, { signal: AbortSignal.timeout(300000) })
  if (!bulkRes.ok) throw new Error(`Download failed: ${bulkRes.status}`)
  const cards = await bulkRes.json()
  console.log(`Downloaded ${cards.length} total cards`)

  // Step 3: Filter and import
  let processed = 0, imported = 0, skipped = 0, errors = 0, batch = []

  for (const card of cards) {
    processed++

    // Skip tokens, art cards, memorabilia
    if (SKIP_LAYOUTS.has(card.layout)) { skipped++; continue }
    if (SKIP_SET_TYPES.has(card.set_type)) { skipped++; continue }
    if (!card.name) { skipped++; continue }

    const setUpper = card.set?.toUpperCase() || ''
    const cardNumber = setUpper && card.collector_number
      ? `${setUpper}-${card.collector_number}`
      : null

    batch.push({
      card_name: card.name,
      card_number: cardNumber,
      game: 'mtg',
      set_code: setUpper || null,
      rarity: card.rarity || null,
      image_url: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || null,
      search_query: `${card.name} ${card.set_name || ''} ${card.rarity || ''}`.trim(),
      times_searched: 0,
      last_searched: new Date().toISOString(),
    })

    if (batch.length >= 100) {
      const count = await flush(batch)
      imported += count
      if (!count) errors++
      batch = []
      await delay(100)
    }

    if (processed % 5000 === 0) {
      console.log(`Processed ${processed}/${cards.length} (imported: ${imported}, skipped: ${skipped})...`)
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const count = await flush(batch)
    imported += count
  }

  console.log('')
  console.log('═══════════════════════════════════════')
  console.log(`Import complete!`)
  console.log(`Total cards in file: ${cards.length}`)
  console.log(`Processed: ${processed}`)
  console.log(`Imported/updated: ${imported}`)
  console.log(`Skipped (tokens/art): ${skipped}`)
  console.log(`Batch errors: ${errors}`)
  console.log('═══════════════════════════════════════')
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
