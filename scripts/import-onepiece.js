/**
 * Bulk import One Piece cards from optcgapi.com into card_catalog.
 * Run: npm run import-onepiece
 */
import { createClient } from '@supabase/supabase-js'
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const SETS = [
  // Main sets OP-01 through OP-14
  ...Array.from({ length: 14 }, (_, i) => `OP-${String(i + 1).padStart(2, '0')}`),
  // Starter decks ST-01 through ST-21
  ...Array.from({ length: 21 }, (_, i) => `ST-${String(i + 1).padStart(2, '0')}`),
  // Extra boosters
  'EB-01', 'EB-02',
]

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

async function fetchSet(setId) {
  const url = `https://optcgapi.com/api/sets/${setId}/`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return []
  return res.json()
}

async function main() {
  console.log('Importing One Piece cards from optcgapi.com...')
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase credentials'); process.exit(1)
  }

  let totalImported = 0, batch = []

  for (const setId of SETS) {
    try {
      const cards = await fetchSet(setId)
      if (!cards.length) { console.log(`  ${setId}: 0 cards (skipped)`); continue }

      for (const c of cards) {
        batch.push({
          card_name: c.card_name || '',
          card_number: c.card_set_id || c.card_image_id || null,
          game: 'onepiece',
          set_code: c.set_id || setId,
          rarity: c.rarity || null,
          image_url: c.card_image || null,
          search_query: `${c.card_name || ''} ${c.card_set_id || ''} ${c.rarity || ''}`.trim(),
          times_searched: 0,
          last_searched: new Date().toISOString(),
        })
        totalImported++
      }

      console.log(`  ${setId}: ${cards.length} cards, total: ${totalImported}`)
      if (batch.length >= 50) { await flush(batch); batch = [] }
      await delay(300) // rate limit
    } catch (err) {
      console.error(`  ${setId} failed: ${err.message}`)
    }
  }

  await flush(batch)

  console.log('')
  console.log('═══════════════════════════════════════')
  console.log(`Import complete. Total cards imported: ${totalImported}`)
  console.log('═══════════════════════════════════════')
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
