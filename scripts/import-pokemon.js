/**
 * Bulk import all Pokemon cards from pokemontcg.io into card_catalog.
 * Run: npm run import-pokemon
 */
import { createClient } from '@supabase/supabase-js'
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const API_KEY = process.env.POKEMON_TCG_API_KEY
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchPage(page) {
  const headers = { Accept: 'application/json' }
  if (API_KEY) headers['X-Api-Key'] = API_KEY
  const url = `https://api.pokemontcg.io/v2/cards?pageSize=250&page=${page}&select=id,name,number,rarity,set,images`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

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
  console.log('Importing Pokemon cards from pokemontcg.io...')
  const first = await fetchPage(1)
  const total = first.totalCount || 0
  const pages = Math.ceil(total / 250)
  console.log(`Total: ${total} cards, ${pages} pages`)

  let imported = 0, batch = []
  const process = (cards) => {
    for (const c of (cards || [])) {
      batch.push({
        card_name: c.name, game: 'pokemon',
        set_code: c.set?.name || null, rarity: c.rarity || null,
        image_url: c.images?.large || c.images?.small || null,
        search_query: `${c.name} ${c.number || ''} ${c.set?.name || ''}`.trim(),
        times_searched: 0, last_searched: new Date().toISOString(),
      })
      imported++
    }
  }

  process(first.data)
  console.log(`Page 1: ${(first.data||[]).length} cards, total: ${imported}`)
  if (batch.length >= 50) { await flush(batch); batch = [] }

  for (let p = 2; p <= pages; p++) {
    await delay(API_KEY ? 200 : 1000)
    try {
      const res = await fetchPage(p)
      process(res.data)
      console.log(`Page ${p}: ${(res.data||[]).length} cards, total: ${imported}`)
      if (batch.length >= 50) { await flush(batch); batch = [] }
    } catch (e) { console.error(`Page ${p} failed:`, e.message) }
  }
  await flush(batch)
  console.log(`\n═ Pokemon import complete: ${imported} cards ═`)
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
