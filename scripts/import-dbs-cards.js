/**
 * Bulk import Dragon Ball Super card images into card_catalog.
 *
 * Usage:
 *   1. Create .env.local with SUPABASE_URL and SUPABASE_SERVICE_KEY
 *   2. Run: npm run import-dbs
 *
 * This is a one-time local script — not deployed to Vercel.
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ─── DBS SET DEFINITIONS ────────────────────────────────────────────────────
const DBS_SETS = [
  { prefix: 'BT', sets: 23, cardsPerSet: 230 },
  { prefix: 'FB', sets: 7,  cardsPerSet: 230 },
  { prefix: 'SD', sets: 23, cardsPerSet: 60  },
  { prefix: 'SB', sets: 4,  cardsPerSet: 60  },
  { prefix: 'EB', sets: 2,  cardsPerSet: 60  },
  { prefix: 'TB', sets: 4,  cardsPerSet: 60  },
]

// ─── HELPERS ────────────────────────────────────────────────────────────────
function pad(n, len) {
  return String(n).padStart(len, '0')
}

function buildCardNumber(prefix, setNum, cardNum) {
  const setPad = prefix === 'BT' && setNum < 10 ? pad(setNum, 2) : pad(setNum, 2)
  const cardPad = pad(cardNum, 3)
  return `${prefix}${setPad}-${cardPad}`
}

async function checkImage(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ─── LOAD COMMUNITY CARD DATA ───────────────────────────────────────────────
async function loadCardData() {
  console.log('Loading community card data from GitHub...')

  const urls = [
    'https://raw.githubusercontent.com/boffinism/dbs-card-list/master/dbs-cards.json',
    'https://raw.githubusercontent.com/boffinism/dbs-card-list/main/dbs-cards.json',
    'https://raw.githubusercontent.com/boffinism/dbs-card-list/master/cards.json',
    'https://raw.githubusercontent.com/boffinism/dbs-card-list/main/cards.json',
  ]

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) continue
      const data = await res.json()
      const cards = Array.isArray(data) ? data : []
      console.log(`Loaded ${cards.length} cards from ${url}`)

      // Build lookup map by card number
      const lookup = new Map()
      for (const card of cards) {
        const num = card.number || card.cardNumber || card.id || ''
        if (num) lookup.set(num.toUpperCase(), card)
      }
      return lookup
    } catch (err) {
      console.log(`Failed to load ${url}: ${err.message}`)
    }
  }

  console.log('Could not load community card data — will use card numbers as names')
  return new Map()
}

// ─── MAIN IMPORT ────────────────────────────────────────────────────────────
async function main() {
  console.log('Starting DBS card import...')
  console.log(`Supabase URL: ${process.env.SUPABASE_URL ? 'set' : 'MISSING'}`)
  console.log(`Supabase Key: ${process.env.SUPABASE_SERVICE_KEY ? 'set' : 'MISSING'}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Create .env.local first.')
    process.exit(1)
  }

  const cardLookup = await loadCardData()

  let totalProcessed = 0
  let totalFound = 0
  let batch = []

  async function flushBatch() {
    if (!batch.length) return
    const { error } = await supabase
      .from('card_catalog')
      .upsert(batch, { onConflict: 'card_name,game,rarity_key', ignoreDuplicates: false })

    if (error) {
      console.error(`Batch upsert failed (${batch.length} cards):`, error.message)
    } else {
      console.log(`Batch upserted ${batch.length} cards`)
    }
    batch = []
  }

  for (const { prefix, sets, cardsPerSet } of DBS_SETS) {
    for (let setNum = 1; setNum <= sets; setNum++) {
      for (let cardNum = 1; cardNum <= cardsPerSet; cardNum++) {
        const cardNumber = buildCardNumber(prefix, setNum, cardNum)

        // Check if base image exists
        const baseUrl = `https://www.dbs-cardgame.com/images/card/${cardNumber}.png`
        const exists = await checkImage(baseUrl)

        if (exists) {
          const cardData = cardLookup.get(cardNumber) || {}
          const name = cardData.name || cardNumber
          const rarity = cardData.rarity || null

          batch.push({
            card_name: name,
            game: 'dbs',
            set_code: `${prefix}${pad(setNum, 2)}`,
            rarity,
            image_url: baseUrl,
            search_query: `${name} ${cardNumber} ${rarity || ''}`.trim(),
            times_searched: 0,
            last_searched: new Date().toISOString(),
            source: 'dbs-cardgame.com',
          })
          totalFound++

          // Also check parallel version (_p)
          const parallelUrl = `https://www.dbs-cardgame.com/images/card/${cardNumber}_p.png`
          const parallelExists = await checkImage(parallelUrl)
          if (parallelExists) {
            batch.push({
              card_name: `${name} (Parallel)`,
              game: 'dbs',
              set_code: `${prefix}${pad(setNum, 2)}`,
              rarity: rarity ? `${rarity}*` : null,
              image_url: parallelUrl,
              search_query: `${name} ${cardNumber} ${rarity || ''} parallel`.trim(),
              times_searched: 0,
              last_searched: new Date().toISOString(),
              source: 'dbs-cardgame.com',
            })
            totalFound++
          }
        }

        totalProcessed++
        if (totalProcessed % 100 === 0) {
          console.log(`Processed ${totalProcessed} cards, found ${totalFound} images...`)
        }

        // Flush batch every 50 cards
        if (batch.length >= 50) await flushBatch()

        // Rate limit: 100ms between HEAD requests
        await delay(100)
      }
    }
  }

  // Flush remaining
  await flushBatch()

  console.log('')
  console.log('═══════════════════════════════════════')
  console.log(`Import complete!`)
  console.log(`Total card numbers checked: ${totalProcessed}`)
  console.log(`Total images found & imported: ${totalFound}`)
  console.log('═══════════════════════════════════════')
}

main().catch((err) => {
  console.error('Import failed:', err)
  process.exit(1)
})
