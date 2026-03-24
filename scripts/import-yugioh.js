/**
 * Bulk import Yu-Gi-Oh cards from YGOProDeck into card_catalog.
 * Single request returns all cards (~13,000+).
 * Run: npm run import-yugioh
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
  const { error } = await supabase.from('card_catalog').upsert(d, { onConflict: 'card_name,game,rarity_key', ignoreDuplicates: false })
  if (error) console.error(`  Upsert failed (${d.length}):`, error.message)
  else console.log(`  → Upserted ${d.length} cards`)
}

async function main() {
  console.log('Importing Yu-Gi-Oh cards from YGOProDeck...')
  console.log('Fetching all cards (this may take a moment)...')

  const res = await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  const data = await res.json()
  const cards = data.data || []
  console.log(`Fetched ${cards.length} cards`)

  let imported = 0, batch = []
  for (const c of cards) {
    const sets = Array.isArray(c.card_sets) ? c.card_sets : []
    const setInfo = sets[0] || {}
    batch.push({
      card_name: c.name || '', game: 'yugioh',
      set_code: setInfo.set_name || null,
      rarity: setInfo.set_rarity_code || setInfo.set_rarity || null,
      image_url: c.card_images?.[0]?.image_url_small || null,
      search_query: `${c.name || ''} ${setInfo.set_code || ''}`.trim(),
      times_searched: 0, last_searched: new Date().toISOString(),
    })
    imported++
    if (batch.length >= 50) { await flush(batch); batch = [] }
    if (imported % 2000 === 0) console.log(`Processed ${imported}/${cards.length}...`)
  }
  await flush(batch)
  console.log(`\n═ Yu-Gi-Oh import complete: ${imported} cards ═`)
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
