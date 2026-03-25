/**
 * Bulk import all Yu-Gi-Oh cards from YGOProDeck into card_catalog.
 * Single request returns all ~15,000 unique cards.
 * Run: npm run import-yugioh
 */
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
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

async function main() {
  console.log('Importing Yu-Gi-Oh cards from YGOProDeck...')
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase credentials'); process.exit(1)
  }

  console.log('Fetching all cards (this may take a moment)...')
  const res = await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes', {
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`API returned ${res.status}`)
  const json = await res.json()
  const cards = json.data || []
  console.log(`Fetched ${cards.length} Yu-Gi-Oh cards`)

  let processed = 0, imported = 0, batch = []

  for (const card of cards) {
    if (!card.name) continue
    processed++

    const sets = Array.isArray(card.card_sets) ? card.card_sets : []
    const firstSet = sets[0] || {}

    batch.push({
      card_name: card.name,
      card_number: card.id?.toString() || null,
      game: 'yugioh',
      set_code: firstSet.set_code?.split('-')[0] || null,
      rarity: firstSet.set_rarity || null,
      image_url: card.card_images?.[0]?.image_url_small || null,
      search_query: `${card.name} ${firstSet.set_code || ''}`.trim(),
      times_searched: 0,
      last_searched: new Date().toISOString(),
    })

    if (batch.length >= 100) {
      const count = await flush(batch)
      imported += count
      batch = []
      await delay(100)
    }

    if (processed % 500 === 0) {
      console.log(`Processed ${processed}/${cards.length} (imported: ${imported})...`)
    }
  }

  if (batch.length > 0) {
    const count = await flush(batch)
    imported += count
  }

  console.log('')
  console.log('═══════════════════════════════════════')
  console.log(`Import complete!`)
  console.log(`Total cards fetched: ${cards.length}`)
  console.log(`Processed: ${processed}`)
  console.log(`Imported/updated: ${imported}`)
  console.log('═══════════════════════════════════════')
}

main().catch((e) => { console.error('Failed:', e); process.exit(1) })
