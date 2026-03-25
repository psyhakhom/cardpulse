/**
 * Bulk import MTG cards from Scryfall bulk data into card_catalog.
 * Downloads oracle_cards (~80MB JSON), parses all unique cards.
 * Run: npm run import-mtg
 */
import { createClient } from '@supabase/supabase-js'
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

function dedup(batch) {
  const seen = new Set()
  return batch.filter((c) => {
    const k = `${c.card_name}|${c.game}|${c.rarity || ''}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })
}

async function flush(batch) {
  const d = dedup(batch)
  if (!d.length) return
  const { error } = await supabase.from('card_catalog').upsert(d, { onConflict: 'game,card_number_key,rarity_key', ignoreDuplicates: false })
  if (error) console.error(`  Upsert failed (${d.length}):`, error.message)
  else console.log(`  → Upserted ${d.length} cards`)
}

async function main() {
  console.log('Importing MTG cards from Scryfall bulk data...')

  // Get bulk data download URL
  const bulkRes = await fetch('https://api.scryfall.com/bulk-data')
  const bulk = await bulkRes.json()
  const oracleEntry = bulk.data.find((d) => d.type === 'oracle_cards')
  if (!oracleEntry) throw new Error('oracle_cards not found in bulk-data')
  console.log(`Downloading ${oracleEntry.name} (${oracleEntry.size ? Math.round(oracleEntry.size / 1024 / 1024) + 'MB' : 'unknown size'})...`)

  const dataRes = await fetch(oracleEntry.download_uri, { signal: AbortSignal.timeout(120000) })
  if (!dataRes.ok) throw new Error(`Download failed: ${dataRes.status}`)
  const cards = await dataRes.json()
  console.log(`Downloaded ${cards.length} unique cards`)

  let imported = 0, batch = []
  for (const c of cards) {
    const imageUrl = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || null
    batch.push({
      card_name: c.name, game: 'mtg',
      set_code: c.set_name || null, rarity: c.rarity || null,
      image_url: imageUrl,
      search_query: `${c.name} ${c.collector_number || ''} ${c.set_name || ''}`.trim(),
      times_searched: 0, last_searched: new Date().toISOString(),
    })
    imported++
    if (batch.length >= 50) { await flush(batch); batch = [] }
    if (imported % 5000 === 0) console.log(`Processed ${imported}/${cards.length}...`)
  }
  await flush(batch)
  console.log(`\n═ MTG import complete: ${imported} cards ═`)
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
