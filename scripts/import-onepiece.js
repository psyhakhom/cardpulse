/**
 * Bulk import One Piece cards from OPTCG GitHub JSON into card_catalog.
 * Run: npm run import-onepiece
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
  const { error } = await supabase.from('card_catalog').upsert(d, { onConflict: 'game,card_number,rarity_key', ignoreDuplicates: false })
  if (error) console.error(`  Upsert failed (${d.length}):`, error.message)
  else console.log(`  → Upserted ${d.length} cards`)
}

async function main() {
  console.log('Importing One Piece cards from GitHub...')

  const urls = [
    'https://raw.githubusercontent.com/danielisonp/optcg/main/cards.json',
    'https://raw.githubusercontent.com/danielisonp/optcg/master/cards.json',
  ]

  let cards = null
  for (const url of urls) {
    try {
      console.log(`Trying ${url}...`)
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) { console.log(`  ${res.status}`); continue }
      cards = await res.json()
      if (Array.isArray(cards) && cards.length > 0) {
        console.log(`Loaded ${cards.length} cards`)
        break
      }
    } catch (e) { console.log(`  Failed: ${e.message}`) }
  }

  if (!cards || !cards.length) {
    console.error('Could not load One Piece card data from any source')
    process.exit(1)
  }

  let imported = 0, batch = []
  for (const c of cards) {
    const num = c.number || c.id || ''
    batch.push({
      card_name: c.name || '', game: 'onepiece',
      set_code: num ? num.replace(/-\d+$/, '') : null,
      rarity: c.rarity || null,
      image_url: c.image || c.imageUrl || null,
      search_query: `${c.name || ''} ${num} ${c.rarity || ''}`.trim(),
      times_searched: 0, last_searched: new Date().toISOString(),
    })
    imported++
    if (batch.length >= 50) { await flush(batch); batch = [] }
    if (imported % 500 === 0) console.log(`Processed ${imported}/${cards.length}...`)
  }
  await flush(batch)
  console.log(`\n═ One Piece import complete: ${imported} cards ═`)
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
