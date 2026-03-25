/**
 * Bulk import Lorcana cards from lorcana-api.com into card_catalog.
 * Run: npm run import-lorcana
 */
import { createClient } from '@supabase/supabase-js'
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

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
  console.log('Importing Lorcana cards from lorcana-api.com...')

  let imported = 0, batch = [], page = 1

  while (true) {
    console.log(`Fetching page ${page}...`)
    try {
      const url = `https://api.lorcana-api.com/cards/fetch?page=${page}&pageSize=200`
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) { console.log(`API returned ${res.status}, stopping`); break }
      const data = await res.json()
      const cards = Array.isArray(data) ? data : (data.data || data.cards || [])
      if (!cards.length) { console.log('No more cards, stopping'); break }

      for (const c of cards) {
        const name = c.Name || c.name || ''
        if (!name) continue
        batch.push({
          card_name: name, game: 'lorcana',
          set_code: c.Set_Name || c.set || null,
          rarity: c.Rarity || c.rarity || null,
          image_url: c.Image || c.image || null,
          search_query: `${name} ${c.Card_Num || c.number || ''} ${c.Set_Name || c.set || ''}`.trim(),
          times_searched: 0, last_searched: new Date().toISOString(),
        })
        imported++
      }
      console.log(`Page ${page}: ${cards.length} cards, total: ${imported}`)
      if (batch.length >= 50) { await flush(batch); batch = [] }
      page++
      await delay(300)
    } catch (e) {
      console.error(`Page ${page} failed:`, e.message)
      break
    }
  }
  await flush(batch)
  console.log(`\n═ Lorcana import complete: ${imported} cards ═`)
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
