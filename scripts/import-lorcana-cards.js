/**
 * Bulk import all Lorcana cards from lorcana-api.com into card_catalog.
 * Run: npm run import-lorcana
 */
import { createClient } from '@supabase/supabase-js'
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

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
  if (!d.length) return
  const { error } = await supabase.from('card_catalog').upsert(d, { onConflict: 'game,card_number_key,rarity_key', ignoreDuplicates: false })
  if (error) console.error(`  Upsert failed (${d.length}):`, error.message)
  else console.log(`  → Upserted ${d.length} cards`)
}

async function main() {
  console.log('Importing Lorcana cards from lorcana-api.com...')
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase credentials'); process.exit(1)
  }

  console.log('Fetching all cards...')
  const res = await fetch('https://api.lorcana-api.com/cards/all', { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`API returned ${res.status}`)
  const cards = await res.json()
  console.log(`Fetched ${cards.length} cards`)

  let imported = 0, batch = []
  for (const c of cards) {
    const name = c.Name || ''
    if (!name) continue

    const cardNum = c.Card_Num ? `${c.Set_ID || ''}-${c.Card_Num}`.replace(/^-/, '') : null

    batch.push({
      card_name: name,
      card_number: cardNum,
      game: 'lorcana',
      set_code: c.Set_Name || null,
      rarity: c.Rarity || null,
      image_url: c.Image || null,
      search_query: `${name} ${cardNum || ''} ${c.Rarity || ''}`.trim(),
      times_searched: 0,
      last_searched: new Date().toISOString(),
    })
    imported++

    if (batch.length >= 50) { await flush(batch); batch = [] }
    if (imported % 500 === 0) console.log(`Processed ${imported}/${cards.length}...`)
  }
  await flush(batch)

  console.log('')
  console.log('═══════════════════════════════════════')
  console.log(`Import complete. Total cards imported: ${imported}`)
  console.log('═══════════════════════════════════════')
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
