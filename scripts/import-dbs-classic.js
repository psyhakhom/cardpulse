/**
 * Import classic Dragon Ball Super Card Game Masters cards (BT sets)
 * using Google Cloud Storage images from Deckplanet.
 *
 * Images confirmed at: https://storage.googleapis.com/deckplanet_card_images/{cardNumber}.png
 * Iterates BT01-BT23, SD01-SD23, checks if image exists via HEAD request.
 *
 * Run: npm run import-dbs-classic
 */
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const IMAGE_BASE = 'https://storage.googleapis.com/deckplanet_card_images'

const SETS = [
  { prefix: 'BT', from: 1, to: 23, maxCards: 200 },
  { prefix: 'SD', from: 1, to: 23, maxCards: 30 },
  { prefix: 'EB', from: 1, to: 2,  maxCards: 40 },
  { prefix: 'TB', from: 1, to: 4,  maxCards: 40 },
  { prefix: 'SB', from: 1, to: 4,  maxCards: 40 },
]

function pad(n) { return String(n).padStart(2, '0') }
function pad3(n) { return String(n).padStart(3, '0') }

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
  const { error } = await supabase
    .from('card_catalog')
    .upsert(d, { onConflict: 'game,card_number,rarity_key', ignoreDuplicates: false })
  if (error) console.error(`  Upsert failed (${d.length}):`, error.message)
  else console.log(`  → Upserted ${d.length} cards`)
}

async function imageExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch { return false }
}

async function main() {
  console.log('Importing DBS Classic cards via Deckplanet GCS images...')
  console.log(`Supabase: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase credentials'); process.exit(1)
  }

  let totalFound = 0, totalChecked = 0, batch = []

  for (const { prefix, from, to, maxCards } of SETS) {
    console.log(`\n── ${prefix} sets (${from}-${to}) ──`)

    for (let setNum = from; setNum <= to; setNum++) {
      let setFound = 0, misses = 0

      for (let cardNum = 1; cardNum <= maxCards; cardNum++) {
        // GCS uses non-padded set numbers: BT1-001 not BT01-001
        const cardNumber = `${prefix}${setNum}-${pad3(cardNum)}`
        const imageUrl = `${IMAGE_BASE}/${cardNumber}.png`

        const exists = await imageExists(imageUrl)
        totalChecked++

        if (exists) {
          batch.push({
            card_name: cardNumber,  // Card number as name — real name added when user searches
            game: 'dbs',
            set_code: `${prefix}${pad(setNum)}`,  // Padded for consistency: BT01, BT02
            rarity: null,
            image_url: imageUrl,
            search_query: cardNumber,
            times_searched: 0,
            last_searched: new Date().toISOString(),
          })
          totalFound++
          setFound++
          misses = 0
        } else {
          misses++
        }

        // 15 consecutive misses = end of set
        if (misses >= 15) break

        if (batch.length >= 50) { await flush(batch); batch = [] }
        await delay(50)  // Light rate limit for GCS
      }

      console.log(`  ${prefix}${pad(setNum)}: ${setFound} cards found`)
    }
  }

  await flush(batch)

  console.log('')
  console.log('═══════════════════════════════════════')
  console.log(`Import complete!`)
  console.log(`Card numbers checked: ${totalChecked}`)
  console.log(`Images found & imported: ${totalFound}`)
  console.log('═══════════════════════════════════════')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
