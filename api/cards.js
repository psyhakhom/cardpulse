/**
 * GET /api/cards?q={query}
 *
 * Card catalog autocomplete endpoint. Priority order:
 *   1. Supabase card_catalog (71,000+ pre-imported cards — instant)
 *   2. External APIs (pokemontcg.io, Scryfall, YGOProDeck, etc.)
 *   3. eBay fallback
 * Plus an "eBay direct" fallback option always included.
 *
 * All responses are in-memory cached for 1 hour per query string.
 * Env vars: POKEMON_TCG_API_KEY (optional — unlocks higher rate limit)
 */

// ─── SUPABASE CLIENT (for card_catalog reads) ────────────────────────────────
const SB_URL = process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_KEY
const _sbReady = !!(SB_URL && SB_KEY)

// Pokemon set code → eBay-friendly set name (sellers use these names, not internal codes)
const PKM_SET_NAMES = {
  BASE1:'Base Set',BASE2:'Jungle',BASE3:'Fossil',BASE4:'Base Set 2',BASE5:'Team Rocket',BASE6:'Legendary Collection',BASEP:'Wizards Promo',
  GYM1:'Gym Heroes',GYM2:'Gym Challenge',NEO1:'Neo Genesis',NEO2:'Neo Discovery',NEO3:'Neo Revelation',NEO4:'Neo Destiny',SI1:'Southern Islands',
  ECARD1:'Expedition',ECARD2:'Aquapolis',ECARD3:'Skyridge',
  EX1:'Ruby & Sapphire',EX2:'Sandstorm',EX3:'Dragon',EX4:'Team Magma vs Team Aqua',EX5:'Hidden Legends',EX6:'FireRed & LeafGreen',
  EX7:'Team Rocket Returns',EX8:'Deoxys',EX9:'Emerald',EX10:'Unseen Forces',EX11:'Delta Species',EX12:'Legend Maker',
  EX13:'Holon Phantoms',EX14:'Crystal Guardians',EX16:'Power Keepers',
  DP1:'Diamond & Pearl',DP2:'Mysterious Treasures',DP3:'Secret Wonders',DP4:'Great Encounters',DP5:'Majestic Dawn',DP6:'Legends Awakened',DP7:'Stormfront',DPP:'DP Promo',
  PL1:'Platinum',PL2:'Rising Rivals',PL3:'Supreme Victors',PL4:'Arceus',
  HGSS1:'HeartGold SoulSilver',HGSS2:'Unleashed',HGSS3:'Undaunted',HGSS4:'Triumphant',HSP:'HGSS Promo',COL1:'Call of Legends',
  BW1:'Black & White',BW2:'Emerging Powers',BW3:'Noble Victories',BW4:'Next Destinies',BW5:'Dark Explorers',BW6:'Dragons Exalted',
  BW7:'Boundaries Crossed',BW8:'Plasma Storm',BW9:'Plasma Freeze',BW10:'Plasma Blast',BW11:'Legendary Treasures',BWP:'BW Promo',DV1:'Dragon Vault',
  XY0:'Kalos Starter Set',XY1:'XY',XY2:'Flashfire',XY3:'Furious Fists',XY4:'Phantom Forces',XY5:'Primal Clash',XY6:'Roaring Skies',
  XY7:'Ancient Origins',XY8:'BREAKthrough',XY9:'BREAKpoint',XY10:'Fates Collide',XY11:'Steam Siege',XY12:'Evolutions',XYP:'XY Promo',DC1:'Double Crisis',
  SM1:'Sun & Moon',SM2:'Guardians Rising',SM3:'Burning Shadows',SM35:'Shining Legends',SM4:'Crimson Invasion',SM5:'Ultra Prism',
  SM6:'Forbidden Light',SM7:'Celestial Storm',SM75:'Dragon Majesty',SM8:'Lost Thunder',SM9:'Team Up',SM10:'Unbroken Bonds',
  SM11:'Unified Minds',SM115:'Hidden Fates',SM12:'Cosmic Eclipse',SMP:'SM Promo',SMA:'Sinnoh Stars',DET1:'Detective Pikachu',
  SWSH1:'Sword & Shield',SWSH2:'Rebel Clash',SWSH3:'Darkness Ablaze',SWSH35:'Champions Path',SWSH4:'Vivid Voltage',
  SWSH5:'Battle Styles',SWSH6:'Chilling Reign',SWSH7:'Evolving Skies',SWSH8:'Fusion Strike',SWSH9:'Brilliant Stars',
  SWSH10:'Astral Radiance',SWSH11:'Lost Origin',SWSH12:'Silver Tempest',
  SV1:'Scarlet & Violet',SV2:'Paldea Evolved',SV3:'Obsidian Flames',SV3PT5:'151',SV4:'Paradox Rift',SV5:'Temporal Forces',
  SV6:'Twilight Masquerade',SV7:'Stellar Crown',SV8:'Surging Sparks',SV9:'Journey Together',SV10:'Destined Rivals',
  G1:'Generations',ME1:'Mega Evolution',RU1:'Rumble',
  POP1:'POP 1',POP2:'POP 2',POP3:'POP 3',POP4:'POP 4',POP5:'POP 5',POP6:'POP 6',POP7:'POP 7',POP8:'POP 8',POP9:'POP 9',
}

async function searchCatalog(query, game, maxResults = 8) {
  if (!_sbReady) return []
  try {
    // Double apostrophes only for PostgREST URL params (SQL escaping)
    const sqlSanitized = query.replace(/'/g, "''")
    // Keep original apostrophes for RPC JSON body (no SQL escaping needed)
    const sanitized = query

    // If query has a specific card number (FB02-099, BT1-031), require exact match on it
    const cardNumMatch = query.match(/\b((?:BT|FB|FS|SD|ST|SB|EB|TB|GD|D-BT)\d+-\d+[A-Z]?|E\d+-\d+|E-\d+)\b/i)

    let rows
    if (cardNumMatch) {
      const num = cardNumMatch[1].toUpperCase()
      const numEnc = encodeURIComponent(num)
      console.log(`[cards:db] card number detected: ${num}`)
      let url = `${SB_URL}/rest/v1/card_catalog?select=card_name,card_number,game,set_code,rarity,image_url,search_query,variant_source&or=(card_number.eq.${numEnc},card_number.ilike.${numEnc}-P*,search_query.ilike.*${numEnc}*)&order=times_searched.desc&limit=16`
      if (game) url += `&game=eq.${game}`
      const res = await fetch(url, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) return []
      rows = await res.json()

      // Re-rank: if query has name terms beyond the card number, boost rows that match them
      const CARD_NUM_RE = /\b(?:BT|FB|FS|SD|ST|SB|EB|TB|GD|D-BT)\d+-\d+[A-Z]?\b|\bE\d+-\d+\b|\bE-\d+\b/gi
      const RARITY_RE = /\b(spr|scr|sr|ssr|ur|sec|sar|r|c|uc|sp|pr|sdr)\b/gi
      const GAME_WORDS = ['pokemon','pokémon','mtg','magic','yugioh','yu-gi-oh','lorcana','disney','one piece','onepiece','optcg','dragon ball','dragonball','dbs','fusion world','raw','english']
      const nameTerms = query.toLowerCase().replace(CARD_NUM_RE, '').replace(RARITY_RE, '').split(/\s+/)
        .filter(w => w.length >= 2 && !GAME_WORDS.includes(w))
      if (nameTerms.length > 0 && rows.length > 1) {
        console.log(`[cards:db] re-ranking with name terms: [${nameTerms.join(', ')}]`)
        rows.sort((a, b) => {
          const aName = (a.card_name || '').toLowerCase()
          const bName = (b.card_name || '').toLowerCase()
          const aHits = nameTerms.filter(t => aName.includes(t)).length
          const bHits = nameTerms.filter(t => bName.includes(t)).length
          return bHits - aHits // more name hits = ranked higher
        })
      }
    } else {
      // Fuzzy name search via pg_trgm similarity + ILIKE fallback
      const GAME_WORDS = ['pokemon','pokémon','mtg','magic','yugioh','yu-gi-oh','lorcana','disney','one piece','onepiece','optcg','dragon ball','dragonball','dbs','fusion world']

      // Classic DBS card name → card number aliases (stopgap until full BT import)
      const CLASSIC_ALIASES = {
        'kamis power piccolo': 'BT3-018', 'piccolo awakening': 'BT3-018',
        'broly br': 'BT9-SP3', 'gogeta blue': 'BT6-109',
        'vegeta blue evolution': 'BT3-063', 'blue evolution vegeta': 'BT3-063',
        'super saiyan blue goku': 'BT1-030', 'ssb goku': 'BT1-030',
        'beerus god of destruction': 'BT1-029', 'golden frieza': 'BT1-089',
        'ultra instinct goku': 'BT9-127', 'ui goku': 'BT9-127',
        'ss4 gogeta': 'BT12-136', 'super saiyan 4 gogeta': 'BT12-136',
        'cell max': 'BT22-070', 'android 21': 'BT20-024',
      }

      const ALIASES = {
        'vegita': 'vegeta', 'vegetta': 'vegeta',
        'freiza': 'frieza', 'friesa': 'frieza', 'freezer': 'frieza',
        'gokou': 'goku', 'picolo': 'piccolo', 'piccalo': 'piccolo',
        'charizrd': 'charizard', 'charazard': 'charizard',
        'pikchu': 'pikachu', 'mewtow': 'mewtwo',
        'delta': 'δ',
      }
      // Extract set code from query (FB07, BT01, OP01, ST01, SV3, etc.) for post-filtering
      const SET_CODE_RE = /\b(FB|BT|FS|SD|ST|SB|EB|TB|GD|OP|SV|SM|XY|SS|SW|BS|EX|D-BT|SWSH)\d{1,3}\b/i
      const setCodeMatch = sanitized.match(SET_CODE_RE)
      let detectedSetCode = setCodeMatch ? setCodeMatch[0].toUpperCase() : null

      // Pokemon set keyword → set_code prefix mapping (check longest matches first)
      const PKM_SET_KEYWORDS = [
        ['base set 2','BASE4'],['base set','BASE1'],['base','BASE'],
        ['jungle','BASE2'],['fossil','BASE3'],['team rocket','BASE5'],['legendary collection','BASE6'],
        ['gym heroes','GYM1'],['gym challenge','GYM2'],
        ['neo genesis','NEO1'],['neo discovery','NEO2'],['neo revelation','NEO3'],['neo destiny','NEO4'],
        ['expedition','ECARD1'],['aquapolis','ECARD2'],['skyridge','ECARD3'],
        ['scarlet violet','SV'],['sword shield','SWSH'],['sun moon','SM'],
        ['black white','BW'],['diamond pearl','DP'],['evolutions','XY12'],
        ['hidden fates','SM115'],['champions path','SWSH35'],['shining legends','SM35'],
        ['brilliant stars','SWSH9'],['astral radiance','SWSH10'],['lost origin','SWSH11'],
        ['cosmic eclipse','SM12'],['evolving skies','SWSH7'],['obsidian flames','SV3'],
        ['paldea evolved','SV2'],['surging sparks','SV8'],['prismatic evolutions','SV8PT5'],
        ['temporal forces','SV5'],['paradox rift','SV4'],['151','SV3PT5'],
        ['stellar crown','SV7'],['journey together','SV9'],['destined rivals','SV10'],
        ['twilight masquerade','SV6'],
        ['vivid voltage','SWSH4'],['battle styles','SWSH5'],['chilling reign','SWSH6'],
        ['fusion strike','SWSH8'],
        ['silver tempest','SWSH12'],['burning shadows','SM3'],
        ['guardians rising','SM2'],['team up','SM9'],['unbroken bonds','SM10'],
        ['unified minds','SM11'],['darkness ablaze','SWSH3'],
        ['rebel clash','SWSH2'],['dragon majesty','SM75'],
        ['crimson invasion','SM4'],['forbidden light','SM6'],
        ['celestial storm','SM7'],['lost thunder','SM8'],
        ['ruby sapphire','EX1'],
        ['holon phantoms','EX13'],['delta species','EX13'],
        ['legend maker','EX12'],['unseen forces','EX11'],
        ['emerald','EX10'],['hidden legends','EX9'],
        ['deoxys','EX8'],['team rocket returns','EX7'],
        ['firered leafgreen','EX6'],
        ['team magma vs team aqua','EX5'],['magma aqua','EX5'],
        ['sandstorm','EX4'],['dragon','EX3'],
        ['phantom forces','XY4'],['flashfire','XY2'],['furious fists','XY3'],
        ['roaring skies','XY6'],['ancient origins','XY7'],['steam siege','XY11'],
        ['fates collide','XY10'],
      ]
      let pkmSetStrip = null
      if (!detectedSetCode) {
        const ql = sanitized.toLowerCase()
        for (const [kw, code] of PKM_SET_KEYWORDS) {
          if (ql.includes(kw)) {
            detectedSetCode = code
            pkmSetStrip = kw
            console.log(`[cards:db] Pokemon set keyword "${kw}" → ${code}`)
            break
          }
        }
      }

      const stripped = sanitized.split(/\s+/).filter(w => !GAME_WORDS.includes(w.toLowerCase()) && !(detectedSetCode && w.toUpperCase() === detectedSetCode))
      let cleanedQuery = (stripped.length > 0 ? stripped : sanitized.split(/\s+/)).join(' ')
      // Strip Pokemon set keyword phrase from fuzzy search query
      if (pkmSetStrip) {
        cleanedQuery = cleanedQuery.toLowerCase().replace(pkmSetStrip, '').replace(/\s+/g, ' ').trim()
      }
      // Strip standalone "ex" when an EX-era set is detected (it's the set prefix, not a card suffix)
      if (detectedSetCode && /^EX\d*$/.test(detectedSetCode)) {
        cleanedQuery = cleanedQuery.replace(/\bex\b/gi, '').replace(/\s+/g, ' ').trim()
      }

      if (detectedSetCode) console.log(`[cards:db] set code detected: ${detectedSetCode}, searching name: "${cleanedQuery}"`)

      // Apply alias corrections for common misspellings (includes delta → δ)
      const corrected = cleanedQuery.toLowerCase().split(' ').map(w => ALIASES[w] || w).join(' ')
      if (corrected !== cleanedQuery.toLowerCase()) {
        console.log(`[cards:db] alias corrected: "${cleanedQuery}" → "${corrected}"`)
        cleanedQuery = corrected
      }

      console.log(`[cards:db] calling fuzzy_search_cards with q="${cleanedQuery}", game_filter=${game || 'null'}`)
      const rpcUrl = `${SB_URL}/rest/v1/rpc/fuzzy_search_cards`
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: cleanedQuery,
          game_filter: game || null,
          result_limit: detectedSetCode ? 50 : 16,
        }),
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) {
        const body = await res.text()
        console.log(`[cards:db] RPC fuzzy_search_cards failed: ${res.status} ${body}`)
        return []
      }
      rows = await res.json()
      console.log(`[cards:db] RPC returned ${rows.length} rows, first: ${rows[0]?.card_name || 'none'}`)
      if (rows.length > 0) console.log(`[cards:db] RPC set_codes: ${[...new Set(rows.map(r => r.set_code))].join(', ')}`)

      // Delta species retry: collectors type "ex" but catalog uses "δ"
      if (rows.length === 0 && /\bex\b/i.test(cleanedQuery)) {
        const deltaQuery = cleanedQuery.replace(/\bex\b/gi, 'δ').replace(/\s+/g, ' ').trim()
        console.log(`[cards:db] retrying with delta symbol: "${deltaQuery}"`)
        const deltaRes = await fetch(rpcUrl, {
          method: 'POST',
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: deltaQuery, game_filter: game || null, result_limit: 16 }),
          signal: AbortSignal.timeout(3000),
        })
        if (deltaRes.ok) {
          const deltaRows = await deltaRes.json()
          if (deltaRows.length > 0) {
            console.log(`[cards:db] delta retry found ${deltaRows.length} results`)
            rows = deltaRows
          }
        }
      }

      // Classic alias retry: if fuzzy search returned 0 results, check name aliases
      if (rows.length === 0) {
        const lowerQ = cleanedQuery.toLowerCase().trim()
        const aliasNum = CLASSIC_ALIASES[lowerQ]
        if (aliasNum) {
          console.log(`[cards:db] classic alias match: "${lowerQ}" → ${aliasNum}, retrying as card number`)
          const numEnc = encodeURIComponent(aliasNum)
          let retryUrl = `${SB_URL}/rest/v1/card_catalog?select=card_name,card_number,game,set_code,rarity,image_url,search_query,variant_source&or=(card_number.eq.${numEnc},card_number.ilike.${numEnc}*,search_query.ilike.*${numEnc}*)&order=times_searched.desc&limit=16`
          if (game) retryUrl += `&game=eq.${game}`
          const retryRes = await fetch(retryUrl, {
            headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
            signal: AbortSignal.timeout(3000),
          })
          if (retryRes.ok) {
            const retryRows = await retryRes.json()
            if (retryRows.length > 0) {
              console.log(`[cards:db] classic alias found ${retryRows.length} results for ${aliasNum}`)
              rows = retryRows
            }
          }
        }
      }

      // ILIKE prefix fallback: catches truncated words ("powe" → "power")
      if (rows.length === 0 && cleanedQuery.length >= 5) {
        console.log(`[cards:db] fuzzy returned 0, trying ILIKE fallback for "${cleanedQuery}"`)
        const ilikeEnc = encodeURIComponent(`%${cleanedQuery}%`)
        let ilikeUrl = `${SB_URL}/rest/v1/card_catalog?select=card_name,card_number,game,set_code,rarity,image_url,search_query,variant_source&card_name=ilike.${ilikeEnc}&order=times_searched.desc&limit=16`
        if (game) ilikeUrl += `&game=eq.${game}`
        try {
          const ilikeRes = await fetch(ilikeUrl, {
            headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
            signal: AbortSignal.timeout(3000),
          })
          if (ilikeRes.ok) {
            const ilikeRows = await ilikeRes.json()
            if (ilikeRows.length > 0) {
              console.log(`[cards:db] ILIKE fallback found ${ilikeRows.length} results`)
              rows = ilikeRows
            }
          }
        } catch (e) {
          console.log(`[cards:db] ILIKE fallback failed: ${e.message}`)
        }
      }

      // Post-filter by set code if detected (supports exact match and prefix match)
      if (detectedSetCode && rows.length > 0) {
        const before = rows.length
        const dsc = detectedSetCode
        const filtered = rows.filter(r => {
          const sc = (r.set_code || '').toUpperCase()
          const cn = (r.card_number || '').toUpperCase()
          return sc === dsc || sc.startsWith(dsc) || cn.startsWith(dsc + '-')
        })
        console.log(`[cards:db] set code filter ${detectedSetCode}: ${before} → ${filtered.length} rows`)
        if (filtered.length > 0) rows = filtered
      }
      // Direct set_code + name query when fuzzy results didn't include the target set
      const setFilterFailed = detectedSetCode && rows.length > 0 && !rows.some(r => (r.set_code || '').toUpperCase().startsWith(detectedSetCode))
      if (detectedSetCode && (rows.length === 0 || setFilterFailed) && cleanedQuery.length >= 2) {
        console.log(`[cards:db] fuzzy missed set ${detectedSetCode}, trying direct set_code query`)
        const nameEnc = encodeURIComponent(`%${cleanedQuery}%`)
        const scEnc = encodeURIComponent(`${detectedSetCode}%`)
        let directUrl = `${SB_URL}/rest/v1/card_catalog?select=card_name,card_number,game,set_code,rarity,image_url,search_query,variant_source&card_name=ilike.${nameEnc}&set_code=ilike.${scEnc}&order=times_searched.desc&limit=16`
        if (game) directUrl += `&game=eq.${game}`
        try {
          const directRes = await fetch(directUrl, {
            headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
            signal: AbortSignal.timeout(3000),
          })
          if (directRes.ok) {
            const directRows = await directRes.json()
            if (directRows.length > 0) {
              console.log(`[cards:db] direct set query found ${directRows.length} results`)
              rows = directRows
            }
          }
        } catch (e) {
          console.log(`[cards:db] direct set query failed: ${e.message}`)
        }
      }
    }
    if (!rows.length) return []

    console.log(`[cards:db] card_catalog returned ${rows.length} raw results for "${query}"${game ? ` [${game}]` : ''}`)

    // Deduplicate: extract card number from search_query, group by it.
    // Prefer rows where card_name is a proper name (not just the card number)
    // and rows that have an image_url.
    // Dedup logic:
    // - Parallel variants (FB05-054, FB05-054-p1, FB05-054-p2) are SEPARATE results
    // - Search-log rows (card_name looks like a user query, e.g., "son gohan future fb02-099")
    //   are dropped if a properly-named import row exists
    const cardNumRe = /\b((?:BT|FB|FS|SD|ST|SB|EB|TB|D-BT|OP|P-)\d+-\d+[A-Z]?(?:-p\d+)?)\b/i

    // Separate import rows (proper names with card_number) from search-log rows (user queries saved as names)
    // A search-log row has: no card_number, OR all-lowercase card_name, OR card_name contains a card number pattern
    const importRows = []
    const searchLogRows = []

    for (const r of rows) {
      const hasCardNumber = !!r.card_number
      const nameIsLowercase = r.card_name === r.card_name?.toLowerCase()
      const nameContainsNum = cardNumRe.test(r.card_name || '')

      if (hasCardNumber && !nameIsLowercase && !nameContainsNum) {
        importRows.push(r)
      } else {
        searchLogRows.push(r)
      }
    }

    // Dedup import rows by card_number + rarity, prefer rows with images and variant_source
    // Different rarities (SR vs SR*) are kept as separate entries
    // Exception: parallel cards (-P suffix) dedup by card_number only since
    // SR and SR* are the same physical card from different import sources
    const byNumber = new Map()
    for (const r of importRows) {
      const num = r.card_number?.toUpperCase() || (r.search_query || '').match(cardNumRe)?.[1]?.toUpperCase()
      const rarity = (r.rarity || '').toUpperCase()
      const isParallel = /-P\d+$/i.test(num || '')
      const key = isParallel
        ? (num || r.card_name.toLowerCase())
        : (num || r.card_name.toLowerCase()) + (rarity ? `|${rarity}` : '')
      const existing = byNumber.get(key)
      if (!existing || (!existing.variant_source && r.variant_source) || (!existing.image_url && r.image_url)) {
        byNumber.set(key, r)
      }
    }

    // Add search-log rows ONLY if NO import rows were found at all.
    // If we have any import rows, search-log rows are redundant or misleading
    // (they often point to the wrong card variant).
    if (byNumber.size === 0) {
      for (const r of searchLogRows) {
        const key = r.card_name.toLowerCase()
        if (!byNumber.has(key)) byNumber.set(key, r)
      }
    }

    // Sort: exact name prefix matches first, then rarity priority as tiebreaker
    const RARITY_PRIORITY = { 'SCR': 0, 'SCR*': 1, 'SCR**': 2, 'SR': 3, 'SR*': 4, 'SPR': 5, 'SEC': 6, 'SSR': 7, 'SAR': 8, 'R': 9, 'UC': 10, 'C': 11, 'L': 12, 'ST': 13, 'CR': 7, 'EX': 8, 'GFR': 2, 'IVR': 4, 'DAR': 4, 'DBR': 1, 'SGR': 1, 'GDR': 2, 'SLR': 3, 'RLR': 5, 'FR': 6, 'PR': 14, 'LR': 0, 'LR+': 1, 'LR++': 2, 'R+': 4, 'U+': 6, 'C+': 8, 'C++': 10 }
    const byRarity = (a, b) => (RARITY_PRIORITY[(a.rarity || '').toUpperCase()] ?? 99) - (RARITY_PRIORITY[(b.rarity || '').toUpperCase()] ?? 99)
    const allResults = [...byNumber.values()]
    const stripPunct = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
    const qLower = stripPunct(query)
    const nameMatch = allResults.filter(r => stripPunct(r.card_name || '').startsWith(qLower))
    const nameRest = allResults.filter(r => !stripPunct(r.card_name || '').startsWith(qLower))
    let deduped = [...nameMatch.sort(byRarity), ...nameRest.sort(byRarity)]

    // Relevance filter: when query has 4+ words, drop results that match <60% of
    // query terms compared to the best match. Prevents "Son Gohan : Youth" from
    // cluttering results for "SS Son Gohan Youth Defying Terror".
    const STOP_WORDS = new Set(['the','a','an','of','and','in','on','at','to','for','is','it','by','or','no'])
    const queryWords = qLower.split(/\s+/).filter(w => w.length >= 2 && !STOP_WORDS.has(w))
    if (queryWords.length >= 4 && deduped.length > 1) {
      const countHits = r => {
        const name = stripPunct(r.card_name || '')
        return queryWords.filter(w => name.includes(w)).length
      }
      const maxHits = Math.max(...deduped.map(countHits))
      if (maxHits >= 3) {
        const threshold = Math.ceil(maxHits * 0.6)
        const before = deduped.length
        const relevant = deduped.filter(r => countHits(r) >= threshold)
        if (relevant.length > 0) {
          deduped = relevant
          if (deduped.length < before) console.log(`[cards:db] relevance filter: ${before} → ${deduped.length} (threshold ${threshold}/${maxHits} words)`)
        }
      }
    }

    deduped = deduped.slice(0, maxResults)

    // If user searched for a base card number (no -p suffix) but we only found
    // parallel variants, the base card isn't in the catalog — return empty so
    // eBay search can find it instead of showing the wrong variant
    if (cardNumMatch) {
      const searchedNum = cardNumMatch[1].toUpperCase()
      const hasBaseCard = deduped.some(r => r.card_number?.toUpperCase() === searchedNum)
      if (!hasBaseCard && !/-P\d+$/i.test(searchedNum)) {
        // User searched for base but only parallels found — check if any result is actually the right card
        const onlyParallels = deduped.every(r => /-P\d+$/i.test(r.card_number || ''))
        if (onlyParallels) {
          console.log(`[cards:db] base card ${searchedNum} not in catalog, only parallels found — deferring to external search`)
          return []
        }
      }
    }

    console.log(`[cards:db] ${deduped.length} unique results (${deduped.filter(r => r.image_url).length} with images)`)
    return deduped.map((r) => {
      // Rewrite One Piece images: optcgapi.com URLs use direct card image files
      // which work without hotlink blocking (unlike Bandai official URLs)
      let imageUrl = r.image_url || null
      if (r.game === 'onepiece' && r.card_number && !imageUrl) {
        imageUrl = `https://optcgapi.com/media/static/Card_Images/${r.card_number}.jpg`
      }
      // Proxy One Piece images to avoid SAMPLE watermark from hotlink detection
      if (r.game === 'onepiece' && imageUrl) {
        imageUrl = `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`
      }
      // Resolve Pokemon set codes to human-readable names for eBay queries
      const setDisplay = r.game === 'pokemon' && r.set_code ? (PKM_SET_NAMES[r.set_code.toUpperCase()] || r.set_code) : (r.set_code || '')
      return {
        id: `db-${r.card_number || r.card_name}-${r.game}`,
        name: r.card_name,
        set: setDisplay,
        number: r.card_number || '',
        rarity: r.rarity || '',
        game: r.game,
        imageUrl,
        largeImageUrl: imageUrl,
        searchQuery: r.search_query || r.card_name,
        variantSource: r.variant_source || null,
      }
    })
  } catch (err) {
    console.log(`[cards:db] catalog query failed: ${err.message}`)
    return []
  }
}

// Fire-and-forget: atomically increment times_searched + update last_searched
function incrementSearchCount(results) {
  if (!_sbReady || !results.length) return
  for (const r of results.slice(0, 8)) {
    const name = r.name || ''
    if (!name) continue
    fetch(`${SB_URL}/rest/v1/rpc/increment_search_count`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ target_name: name }),
    }).catch(() => {})
  }
}

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const cache = new Map()
const CACHE_TTL = 60 * 60 * 1000 // 1 hour
const CACHE_MAX = 200 // max entries before forced eviction

async function withCache(key, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() < hit.expires) return hit.data
  // Evict expired entries when cache is large
  if (cache.size > CACHE_MAX) {
    const now = Date.now()
    for (const [k, v] of cache) { if (now >= v.expires) cache.delete(k) }
    // If still over limit, drop oldest half
    if (cache.size > CACHE_MAX) {
      const keys = [...cache.keys()]
      for (let i = 0; i < keys.length / 2; i++) cache.delete(keys[i])
    }
  }
  const data = await fn()
  cache.set(key, { data, expires: Date.now() + CACHE_TTL })
  return data
}

// ─── GAME DETECTION ──────────────────────────────────────────────────────────
const POKEMON_KW = [
  'pokemon', 'pokémon', 'charizard', 'pikachu', 'mewtwo', 'eevee', 'blastoise',
  'venusaur', 'gengar', 'snorlax', 'gyarados', 'meowth', 'lugia', 'ho-oh',
  'rayquaza', 'mew', 'umbreon', 'espeon', 'sylveon', 'gardevoir', 'lucario',
  'greninja', 'alakazam', 'bulbasaur', 'squirtle', 'jigglypuff', 'dragonite',
  'deoxys', 'jirachi', 'blaziken', 'sceptile', 'swampert', 'flygon',
  'ash', 'misty', 'brock', 'team rocket', 'jessie', 'james', 'giovanni',
  'gary', 'professor oak', 'nurse joy', 'gym leader', 'elite four', 'trainer',
  // EX-era set names — detect as Pokemon when no other game keyword present
  'holon phantoms', 'holon', 'delta species', 'legend maker', 'unseen forces',
  'hidden legends', 'team rocket returns', 'firered leafgreen',
  'team magma', 'team aqua', 'sandstorm', 'aquapolis', 'skyridge',
  'neo genesis', 'neo discovery', 'neo revelation', 'neo destiny',
  'gym heroes', 'gym challenge',
]
const MTG_KW = ['mtg', 'magic the gathering', 'magic:', 'planeswalker', 'mana ']
const YGO_KW = [
  'yugioh', 'yu-gi-oh', 'yu gi oh', 'blue-eyes', 'blue eyes', 'dark magician',
  'exodia', 'red-eyes', 'red eyes', 'kuriboh', 'pot of greed', 'raigeki',
  'mirror force', 'monster reborn', 'polymerization', 'stardust dragon',
  'cyber dragon', 'utopia', 'number 39', 'elemental hero',
]
const DBS_KW = [
  'dragon ball', 'dragonball', 'dbs', 'fusion world', 'goku', 'vegeta',
  'vegito', 'gogeta', 'frieza', 'gohan', 'piccolo', 'broly', 'beerus', 'trunks',
  'bardock', 'cell', 'android', 'majin', 'saiyan', 'shenron', 'krillin',
  'videl', 'whis', 'hit', 'jiren', 'zamasu', 'goten', 'bulma', 'chi-chi',
  'kamehameha', 'final flash', 'galick gun', 'spirit bomb', 'instant transmission',
  'hakai', 'ultra instinct', 'god kamehameha', 'destructo disc',
  'special beam cannon', 'makankosappo',
  'energy marker',
  'fortuneteller baba', 'baba', 'master roshi', 'oolong', 'puar',
  'ox-king', 'chichi', 'launch', 'turtle hermit', 'kame',
  'yamcha', 'tien', 'chiaotzu', 'raditz', 'nappa',
  'zarbon', 'dodoria', 'ginyu', 'recoome', 'burter', 'jeice', 'guldo',
]
const DBS_CODE_RE = /\b(?:BT|FB|FS|SD|SB|TB|D-BT|PUMS|SDBH)\d+|\bE-\d+/i
const OP_KW = [
  'one piece', 'onepiece', 'optcg',
  // Character names
  'luffy', 'zoro', 'nami', 'sanji', 'usopp', 'chopper', 'robin', 'franky', 'brook', 'jinbe',
  'shanks', 'ace', 'whitebeard', 'blackbeard', 'hancock', 'mihawk',
  'crocodile', 'doflamingo', 'katakuri', 'kaido', 'big mom', 'yamato', 'uta',
  // Set codes (with and without hyphen)
  'op-01', 'op-02', 'op-03', 'op-04', 'op-05', 'op-06', 'op-07',
  'op-08', 'op-09', 'op-10', 'op-11', 'op-12', 'op-13', 'op-14',
  'op01', 'op02', 'op03', 'op04', 'op05', 'op06', 'op07',
  'op08', 'op09', 'op10', 'op11', 'op12', 'op13', 'op14',
  'st-01', 'st-02', 'st-03', 'st-04', 'st-05', 'st-06', 'st-07', 'st-08', 'st-09',
  'st-10', 'st-11', 'st-12', 'st-13', 'st-14', 'st-15', 'st-16', 'st-17', 'st-18',
  'st01', 'st02', 'st03', 'st04', 'st05', 'st06', 'st07', 'st08', 'st09',
  'st10', 'st11', 'st12', 'st13', 'st14', 'st15', 'st16', 'st17', 'st18',
  'eb-01', 'eb-02', 'eb01', 'eb02',
]
const OP_CODE_RE = /\b(?:OP|ST|EB)-?\d{2}/i
const LORCANA_KW = ['lorcana', 'disney lorcana']
const GUNDAM_KW = ['gundam', 'mobile suit', 'gundanium', 'zaku', 'rx-78', 'newtype', 'char aznable', 'amuro']
const GUNDAM_CODE_RE = /\bGD\d{2}/i

function detectGame(query) {
  const ql = query.toLowerCase()
  if (POKEMON_KW.some((k) => ql.includes(k))) return 'pokemon'
  if (MTG_KW.some((k) => ql.includes(k))) return 'mtg'
  if (YGO_KW.some((k) => ql.includes(k))) return 'yugioh'
  if (OP_KW.some((k) => ql.includes(k)) || OP_CODE_RE.test(query)) return 'onepiece'
  if (DBS_KW.some((k) => ql.includes(k)) || DBS_CODE_RE.test(query)) return 'dbs'
  if (LORCANA_KW.some((k) => ql.includes(k))) return 'lorcana'
  if (GUNDAM_KW.some((k) => ql.includes(k)) || GUNDAM_CODE_RE.test(query)) return 'gundam'
  return null
}

// ─── QUERY SANITIZER ─────────────────────────────────────────────────────────
function sanitizeQuery(query) {
  return query
    .replace(/[:;,!?@#$%^&*()[\]{}|\\<>~`"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── UNIVERSAL QUERY BUILDER ─────────────────────────────────────────────────
// "{card name} {card number} {rarity}" — works across all TCGs on eBay
function buildSearchQuery(name, number, rarity) {
  return [name, number, rarity].filter(Boolean).join(' ').slice(0, 60)
}

// ─── POKEMON-SPECIFIC QUERY BUILDER ─────────────────────────────────────────
function buildPokemonQuery(card) {
  const name = card.name || ''
  const number = card.number || ''
  const total = card.set?.printedTotal || card.set?.total || ''
  const setName = card.set?.name || ''
  const numStr = number && total ? `${number}/${total}` : number
  return [name, numStr, setName].filter(Boolean).join(' ').slice(0, 60)
}

function simplifyDbsName(name) {
  // Only strip colon suffixes for eBay search optimization — keep enough
  // to identify the card. "Son Goku : DA + Evolve" → "Son Goku"
  // but "Kamehameha" stays as "Kamehameha" (no colon to strip)
  let simplified = name
    .replace(/\s*[:+]\s*.*/g, '') // strip from first colon or plus
    .replace(/\s*[-–—]\s*(DA|Evolve|Awakening|Limit Breaker)\b.*/gi, '') // strip only generic descriptors
    .trim()
  return simplified.length >= 3 ? simplified : name
}

// ─── POKEMON TCG API ──────────────────────────────────────────────────────────
const JP_EXCLUSIVE_SETS = [
  'ash vs team rocket', 'tag team gx', 'dream league', 'alter genesis',
  'remix bout', 'miraculous intermezzo', 'shiny star v', 'eevee heroes',
  'vmax climax', 'battle region', 'dark phantasma', 'lost abyss',
  'incandescent arcana', 'paradigm trigger', 'vstar universe', 'triplet beat',
  'snow hazard', 'clay burst', 'ruler of the black flame', 'raging surf',
  'ancient roar', 'future flash', 'wild force', 'cyber judge',
  'crimson haze', 'mask of change', 'night wanderer', 'stellar miracle',
  'superelectric breaker', 'paradise dragona', 'terastal festival',
]

function isJpExclusiveSet(setName) {
  if (!setName) return false
  const sl = setName.toLowerCase()
  return JP_EXCLUSIVE_SETS.some((jp) => sl.includes(jp))
}

function mapPokemonCard(card) {
  const jpExclusive = isJpExclusiveSet(card.set?.name)
  return {
    id: `pkm-${card.id}`,
    name: card.name,
    set: card.set?.name || '',
    number: card.number || '',
    rarity: card.rarity || '',
    game: 'pokemon',
    imageUrl: card.images?.small || null,
    largeImageUrl: card.images?.large || null,
    searchQuery: buildPokemonQuery(card),
    jpExclusive,
  }
}

function pokemonHeaders() {
  const apiKey = process.env.POKEMON_TCG_API_KEY
  const headers = { Accept: 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  return headers
}

async function searchPokemon(query) {
  return withCache(`pkm:${query.toLowerCase()}`, async () => {
    const headers = pokemonHeaders()
    const sanitized = sanitizeQuery(query)
    const seenIds = new Set()
    let cards = []

    function addCards(rawCards) {
      const mapped = rawCards.map(mapPokemonCard)
      const added = []
      for (const c of mapped) {
        if (!seenIds.has(c.id)) { seenIds.add(c.id); added.push(c) }
      }
      return added
    }

    async function pkmFetch(url) {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
      if (!res.ok) return []
      const data = await res.json()
      return data.data || []
    }

    let nameQ
    if (/\bvs\.?\b/i.test(sanitized)) {
      const parts = sanitized.split(/\bvs\.?\b/i).map((s) => s.trim()).filter(Boolean)
      nameQ = parts.map((p) => `name:*${p}*`).join(' ')
    } else {
      nameQ = sanitized.includes(' ') ? `name:"*${sanitized}*"` : `name:${sanitized}*`
    }

    const nameUrl = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(nameQ)}&pageSize=8&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`
    const setsUrl = `https://api.pokemontcg.io/v2/sets?q=name:"*${encodeURIComponent(sanitized)}*"&pageSize=3&orderBy=-releaseDate`

    const [nameRaw, setsRes] = await Promise.allSettled([
      pkmFetch(nameUrl),
      fetch(setsUrl, { headers, signal: AbortSignal.timeout(5000) }),
    ])

    if (nameRaw.status === 'fulfilled') cards.push(...addCards(nameRaw.value))

    if (cards.length < 4) {
      try {
        const subtypeCards = await pkmFetch(`https://api.pokemontcg.io/v2/cards?q=subtypes:"${encodeURIComponent(sanitized)}"&pageSize=4&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`)
        cards.push(...addCards(subtypeCards))
      } catch (_) {}
    }

    if (cards.length < 4) {
      try {
        const setCards = await pkmFetch(`https://api.pokemontcg.io/v2/cards?q=set.name:"*${encodeURIComponent(sanitized)}*"&pageSize=${8 - cards.length}&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`)
        cards.push(...addCards(setCards))
      } catch (_) {}
    }

    if (!cards.length) {
      try {
        const directCards = await pkmFetch(`https://api.pokemontcg.io/v2/cards?q=set.name:"${encodeURIComponent(sanitized)}"&pageSize=8&orderBy=-set.releaseDate&select=id,name,number,rarity,set,images`)
        cards.push(...addCards(directCards))
      } catch (_) {}
    }

    const sets = []
    if (setsRes.status === 'fulfilled' && setsRes.value.ok) {
      const data = await setsRes.value.json()
      for (const s of (data.data || [])) {
        sets.push({
          id: `pkm-set-${s.id}`, name: `Browse: ${s.name}`, set: s.name,
          number: `${s.total || '?'} cards`, rarity: s.releaseDate || '',
          game: 'pokemon', imageUrl: s.images?.symbol || null,
          largeImageUrl: s.images?.logo || null,
          searchQuery: `pokemon ${s.name}`, isSet: true,
        })
      }
    }

    const queryIsJp = JP_EXCLUSIVE_SETS.some((jp) => sanitized.toLowerCase().includes(jp))
    const jpExclusive = queryIsJp || cards.some((c) => c.jpExclusive) || sets.some((s) => isJpExclusiveSet(s.set))

    return { cards: [...cards, ...sets], jpExclusive }
  })
}

// ─── MTG / SCRYFALL ──────────────────────────────────────────────────────────
async function searchMtg(query) {
  return withCache(`mtg:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(sanitized)}&unique=prints&order=released&dir=desc`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data = await res.json()

    return (data.data || []).slice(0, 8).map((card) => ({
      id: `mtg-${card.id}`,
      name: card.name,
      set: card.set_name || '',
      number: card.collector_number || '',
      rarity: card.rarity || '',
      game: 'mtg',
      imageUrl: card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || null,
      largeImageUrl: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || null,
      searchQuery: [card.name, card.set_name].filter(Boolean).join(' ').slice(0, 60),
    }))
  })
}

// ─── YU-GI-OH / YGOPRODECK ──────────────────────────────────────────────────
async function searchYugioh(query) {
  return withCache(`ygo:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(sanitized)}&num=8&offset=0`
    console.log(`[cards:ygo] fetching: ${sanitized}`)
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.log(`[cards:ygo] API returned ${res.status}`)
      return []
    }
    const data = await res.json()
    if (data.error) { console.log(`[cards:ygo] API error: ${data.error}`); return [] }
    const items = data.data || []
    console.log(`[cards:ygo] got ${items.length} results`)

    return items.slice(0, 8).map((card) => {
      const sets = Array.isArray(card.card_sets) ? card.card_sets : []
      const setInfo = sets[0] || {}
      return {
        id: `ygo-${card.id || Math.random().toString(36).slice(2)}`,
        name: card.name || '',
        set: setInfo.set_name || '',
        number: setInfo.set_code || '',
        rarity: setInfo.set_rarity_code || setInfo.set_rarity || '',
        game: 'yugioh',
        imageUrl: card.card_images?.[0]?.image_url_small || null,
        largeImageUrl: card.card_images?.[0]?.image_url || null,
        searchQuery: buildSearchQuery(card.name, setInfo.set_code, ''),
      }
    })
  })
}

// ─── ONE PIECE / OPTCG GITHUB DATA ──────────────────────────────────────────
let opCardData = null
let opDataLoading = null
let opLoadFailedAt = 0

async function loadOpData() {
  if (opCardData) return opCardData
  if (opDataLoading) return opDataLoading
  // Backoff: don't retry within 60s of a failure
  if (opLoadFailedAt && Date.now() - opLoadFailedAt < 60000) return null

  opDataLoading = (async () => {
    console.log('[cards:op] loading OPTCG card data from GitHub...')
    try {
      const res = await fetch('https://raw.githubusercontent.com/danielisonp/optcg/main/cards.json', {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`GitHub ${res.status}`)
      opCardData = await res.json()
      console.log(`[cards:op] loaded ${Array.isArray(opCardData) ? opCardData.length : 'unknown'} cards`)
      opDataLoading = null
      return opCardData
    } catch (err) {
      console.error(`[cards:op] failed to load card data: ${err.message}`)
      opLoadFailedAt = Date.now()
      opDataLoading = null
      return null
    }
  })()
  return opDataLoading
}

async function searchOnePiece(query) {
  return withCache(`op:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const terms = sanitized.toLowerCase().split(/\s+/)
    const data = await loadOpData()

    if (data && Array.isArray(data)) {
      const results = data.filter((card) => {
        const hay = `${card.name || ''} ${card.id || ''} ${card.number || ''} ${card.type || ''}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      }).slice(0, 8)

      if (results.length > 0) {
        return results.map((card) => {
          let img = card.image || card.imageUrl || null
          if (img) img = `/api/image-proxy?url=${encodeURIComponent(img)}`
          return {
            id: `op-${card.id || card.number || Date.now()}`,
            name: card.name || '',
            set: (card.number || card.id || '').replace(/-\d+$/, ''),
            number: card.number || card.id || '',
            rarity: card.rarity || '',
            game: 'onepiece',
            imageUrl: img,
            largeImageUrl: img,
            searchQuery: buildSearchQuery(card.name, card.number || card.id, card.rarity),
          }
        })
      }
    }

    // Fallback: try the official site
    try {
      const url = `https://en.onepiece-cardgame.com/cardlist/?search=true&freewords=${encodeURIComponent(sanitized)}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'CardPulse/1.0' },
        signal: AbortSignal.timeout(6000),
      })
      if (res.ok) {
        const html = await res.text()
        const cards = []
        const cardRe = /<a[^>]*class="[^"]*modalCol[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
        let match
        while ((match = cardRe.exec(html)) !== null && cards.length < 8) {
          const block = match[1]
          const imgMatch = block.match(/<img[^>]+src="([^"]+)"/)
          const nameMatch = block.match(/cardName[^>]*>([^<]+)/) || block.match(/<div[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)/)
          const numMatch = block.match(/((?:OP|ST|EB)\d+-\d+)/i)
          if (!nameMatch) continue
          const name = nameMatch[1].trim()
          const number = numMatch ? numMatch[1].toUpperCase() : ''
          let imageUrl = imgMatch ? imgMatch[1].trim() : null
          if (imageUrl && imageUrl.startsWith('/')) imageUrl = `https://en.onepiece-cardgame.com${imageUrl}`
          if (imageUrl) imageUrl = `/api/image-proxy?url=${encodeURIComponent(imageUrl)}`
          cards.push({
            id: `op-site-${number || cards.length}`, name,
            set: number ? number.replace(/-\d+$/, '') : '', number,
            rarity: '', game: 'onepiece',
            imageUrl, largeImageUrl: imageUrl,
            searchQuery: buildSearchQuery(name, number, ''),
          })
        }
        if (cards.length > 0) return cards
      }
    } catch (err) {
      console.log(`[cards:op] site fallback failed: ${err.message}`)
    }

    return []
  })
}

// ─── DRAGON BALL SUPER ───────────────────────────────────────────────────────
// DBS GitHub JSON repo (boffinism/dbs-card-list) is dead (404).
// DBS autocomplete now relies on: site scraping → hardcoded dictionary → eBay fallback.

const DBS_NUM_RE = /\b((?:BT|FB|FS|SD|ST|SB|EB|TB|D-BT|P-|PUMS|SDBH)\d+-\d+[A-Z]?)\b/i

async function searchDbsSite(query) {
  const sanitized = sanitizeQuery(query)
  const url = `https://www.dbs-cardgame.com/us-en/cardlist/?search=true&keyword=${encodeURIComponent(sanitized)}`
  console.log(`[cards:dbs] fetching DBS site: "${sanitized}"`)
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CardPulse/1.0' },
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) throw new Error(`DBS site ${res.status}`)
  const html = await res.text()

  const cards = []
  const cardBlockRe = /<li[^>]*class="[^"]*list-inner[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let match
  while ((match = cardBlockRe.exec(html)) !== null && cards.length < 8) {
    const block = match[1]
    const imgMatch = block.match(/<img[^>]+src="([^"]+)"/)
    const nameMatch = block.match(/cardName[^>]*>([^<]+)/) || block.match(/<dt[^>]*>([^<]{3,})<\/dt>/)
    const numMatch = block.match(/cardNumber[^>]*>([^<]+)/) || block.match(/((?:BT|FB|SD|ST|D-BT)\d+-\d+[A-Z]?)/)
    const rarityMatch = block.match(/cardRarity[^>]*>([^<]+)/) || block.match(/rarity[^>]*>([^<]+)/i)
    if (!nameMatch) continue
    const name = nameMatch[1].trim()
    const number = numMatch ? numMatch[1].trim().toUpperCase() : ''
    const rarity = rarityMatch ? rarityMatch[1].trim() : ''
    let imageUrl = imgMatch ? imgMatch[1].trim() : null
    if (imageUrl && imageUrl.startsWith('/')) imageUrl = `https://www.dbs-cardgame.com${imageUrl}`
    cards.push({
      id: `dbs-site-${number || cards.length}`, name,
      set: number ? number.replace(/-\d+[A-Z]?$/, '') : '', number, rarity,
      game: 'dbs', imageUrl: imageUrl || dbsImageUrl(number), largeImageUrl: imageUrl || dbsImageUrl(number),
      searchQuery: buildSearchQuery(simplifyDbsName(name), number, rarity),
    })
  }
  return cards
}

async function searchDbs(query) {
  return withCache(`dbs:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const terms = sanitized.toLowerCase().split(/\s+/)

    // Try official DBS site first
    try {
      const siteResults = await searchDbsSite(query)
      if (siteResults.length > 0) {
        console.log(`[cards:dbs] site returned ${siteResults.length} results`)
        return siteResults
      }
    } catch (err) {
      console.log(`[cards:dbs] site failed: ${err.message}`)
    }

    // Hardcoded popular cards fallback
    const fbResults = searchDbsFallback(query)
    if (fbResults.length > 0) return fbResults

    // Retry with individual words — only for short queries (2 words) without
    // a specific card number. For 3+ word queries like "SS Broly Banisher Fury",
    // the user is searching for a specific card — returning a generic "Broly" match
    // is worse than falling through to the eBay fallback.
    const queryHasCardNum = DBS_NUM_RE.test(sanitized)
    const words = sanitized.split(/\s+/).filter((w) => w.length >= 3)
    if (!queryHasCardNum && words.length === 2) {
      const sorted = [...words].sort((a, b) => b.length - a.length)
      for (const word of sorted) {
        console.log(`[cards:dbs] retrying with single word: "${word}"`)
        const fbRetry = searchDbsFallback(word)
        if (fbRetry.length > 0) return fbRetry
      }
    }

    // For 3+ word queries that reached here, return empty so eBay fallback triggers
    if (words.length >= 3) {
      console.log(`[cards:dbs] specific query "${sanitized}" not in database, deferring to eBay fallback`)
    }
    return []
  })
}

const DBS_POPULAR = [
  { name: 'Son Goku, The Awakened Power', number: 'BT1-059', rarity: 'SPR' },
  { name: 'Vegito, Path to Greatness', number: 'BT20-138', rarity: 'SCR' },
  { name: 'Super Saiyan God Son Goku', number: 'BT1-032', rarity: 'SR' },
  { name: 'Gogeta, Hero Revived', number: 'BT5-038', rarity: 'SPR' },
  { name: 'Frieza, Emperor of Universe 7', number: 'BT9-002', rarity: 'SR' },
  { name: 'Cell, Android Evolved', number: 'BT17-049', rarity: 'SPR' },
  { name: 'Broly, The Legendary Super Saiyan', number: 'BT1-057', rarity: 'SR' },
  { name: 'Vegeta, Prince of Destruction', number: 'BT15-065', rarity: 'SCR' },
  { name: 'Gohan, Potential Unleashed', number: 'BT3-033', rarity: 'SPR' },
  { name: 'Piccolo, Fused with Kami', number: 'BT16-079', rarity: 'SR' },
  { name: 'Trunks, Bridge to the Future', number: 'BT3-062', rarity: 'SPR' },
  { name: 'Beerus, God of Destruction', number: 'BT1-029', rarity: 'SR' },
  { name: 'Gogeta BR', number: 'FB01-139', rarity: 'SCR' },
  { name: 'Son Goku, Ultra Instinct Sign', number: 'BT9-026', rarity: 'SCR' },
  { name: 'Son Goku, Strength of Legends', number: 'FB01-001', rarity: 'SR' },
  { name: 'Vegeta, Saiyan Prince', number: 'FB01-028', rarity: 'SR' },
  { name: 'Broly, Unstoppable Rage', number: 'FB01-091', rarity: 'SCR' },
  { name: 'Gogeta, Fusion Reborn', number: 'FB02-139', rarity: 'SCR' },
  { name: 'Vegeta, Beyond Limits', number: 'FB02-028', rarity: 'SCR' },
  { name: 'Son Gohan, Beast Unleashed', number: 'FB02-049', rarity: 'SCR' },
  { name: 'Goku & Vegeta, Saiyan Bond', number: 'FB09-121', rarity: 'SCR' },
  { name: 'Super Saiyan 4 Gogeta', number: 'BT11-001', rarity: 'SCR' },
  { name: 'Omega Shenron, Extreme Malice', number: 'BT11-110', rarity: 'SCR' },
  { name: 'Cooler, Galactic Dynasty', number: 'BT17-059', rarity: 'SCR' },
  { name: 'Son Goku, Mastered Ultra Instinct', number: 'BT7-077', rarity: 'SCR' },
  { name: 'Gogeta, Display of Power', number: 'BT12-136', rarity: 'SCR' },
  { name: 'Gogeta, Beyond Fusion', number: 'FB03-139', rarity: 'SCR' },
  { name: 'Vegeta, Royal Pride', number: 'FB03-028', rarity: 'SCR' },
  // Attack-name cards (for word-retry on "kamehameha", "spirit bomb" etc)
  { name: 'Gohan, Father-Son Kamehameha', number: 'FB03-049', rarity: 'SR' },
  { name: 'Son Goku, God Kamehameha', number: 'FB04-001', rarity: 'SCR' },
  { name: 'God Kamehameha', number: 'FS01-16', rarity: 'SR' },
  { name: 'Son Goku, Spirit Bomb', number: 'BT8-108', rarity: 'SPR' },
  { name: 'Vegeta, Final Flash', number: 'BT4-030', rarity: 'SPR' },
  { name: 'Piccolo, Special Beam Cannon', number: 'FB03-058', rarity: 'SR' },
  { name: 'SS Broly, Banisher of Fury', number: 'BT29-145', rarity: 'SCR' },
]

// Generate official DBS card image URL from card number
function dbsImageUrl(number) {
  if (!number) return null
  return `https://www.dbs-cardgame.com/images/card/${number}.png`
}

function searchDbsFallback(query) {
  const sanitized = sanitizeQuery(query)
  const terms = sanitized.toLowerCase().split(/\s+/)
  return DBS_POPULAR.filter((card) => {
    const hay = `${card.name} ${card.number} ${card.rarity}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  }).slice(0, 8).map((card) => ({
    id: `dbs-fb-${card.number}`,
    name: card.name,
    set: card.number.replace(/-\d+[A-Z]?$/, ''),
    number: card.number,
    rarity: card.rarity,
    game: 'dbs',
    imageUrl: dbsImageUrl(card.number),
    largeImageUrl: dbsImageUrl(card.number),
    searchQuery: buildSearchQuery(simplifyDbsName(card.name), card.number, card.rarity),
  }))
}

// ─── LORCANA ─────────────────────────────────────────────────────────────────
async function searchLorcana(query) {
  return withCache(`lor:${query.toLowerCase()}`, async () => {
    const sanitized = sanitizeQuery(query)
    const url = `https://api.lorcana-api.com/cards/fetch?search=Name%20LIKE%20${encodeURIComponent(sanitized)}&limit=8`
    console.log(`[cards:lor] fetching: ${sanitized}`)
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.log(`[cards:lor] API returned ${res.status}`)
      return []
    }
    const data = await res.json()
    if (data.error) { console.log(`[cards:lor] API error: ${data.error}`); return [] }
    const items = Array.isArray(data) ? data : (data.data || data.cards || [])
    if (!items.length) return []
    console.log(`[cards:lor] got ${items.length} results`)

    return items.slice(0, 8).map((card) => ({
      id: `lor-${card.id || card.Name || Math.random().toString(36).slice(2)}`,
      name: card.Name || card.name || '',
      set: card.Set_Name || card.set || '',
      number: card.Card_Num || card.number || '',
      rarity: card.Rarity || card.rarity || '',
      game: 'lorcana',
      imageUrl: card.Image || card.image || null,
      largeImageUrl: card.Image || card.image || null,
      searchQuery: buildSearchQuery(card.Name || card.name, card.Card_Num || card.number, card.Rarity || card.rarity),
    }))
  })
}

// ─── GENERAL EBAY FALLBACK ────────────────────────────────────────────────────
const LISTING_JUNK_RE = /\b(lot|bundle|collection|complete set|booster|pack|box|sealed|\d+\s*cards?|\dx|\bx\d+|buy \d|bogo|get \d free)\b/i

let ebayToken = null
let ebayTokenExp = 0

async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExp) return ebayToken
  const id = process.env.EBAY_CLIENT_ID
  const secret = process.env.EBAY_CLIENT_SECRET
  if (!id || !secret) throw new Error('eBay credentials not configured')
  const creds = Buffer.from(`${id}:${secret}`).toString('base64')
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`eBay token ${res.status}`)
  const data = await res.json()
  ebayToken = data.access_token
  ebayTokenExp = Date.now() + (data.expires_in - 60) * 1000
  return ebayToken
}

async function searchEbayFallback(query) {
  return withCache(`ebay-fallback:${query.toLowerCase()}`, async () => {
    const token = await getEbayToken()
    const sanitized = sanitizeQuery(query)
    const q = `${sanitized} card`
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=buyingOptions:{AUCTION|FIXED_PRICE}&sort=newlyListed&limit=40`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const items = data.itemSummaries || []

    const CARD_NUM_RE = /\b((?:[A-Z]{1,4}-?\d+-\d+[A-Z]?)|(?:\d{1,3}\/\d{1,3}))\b/
    const seen = new Set()
    const cards = []
    const LANG_JUNK_RE = /\b(cross\s*worlds|japanese|japan|jpn)\b/i
    for (const item of items) {
      const title = item.title || ''
      if (LISTING_JUNK_RE.test(title)) continue
      if (LANG_JUNK_RE.test(title)) continue
      let name = title
        .replace(/\b(psa|bgs|cgc|sgc|beckett)\s*\d+[\d.]*/gi, '')
        .replace(/\bnear\s*mint\b|\bnm\b|\bmp\b|\blp\b|\bhp\b/gi, '')
        .replace(/\bcard\b|\bsingle\b|\btrading\b/gi, '')
        .replace(/[[\]()|#•★◆▲●◇■□△▽♦♠♣♥]/g, ' ')
        .replace(/\s{2,}/g, ' ').trim()
      const numMatch = name.match(CARD_NUM_RE)
      const number = numMatch ? numMatch[1] : ''
      if (number) name = name.replace(number, '').trim()
      name = name.replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, '').trim()
      name = name.replace(/\b\w/g, (c) => c.toUpperCase())
      if (!name || name.length < 3) continue
      const key = number ? number.toLowerCase() : name.toLowerCase().slice(0, 30)
      if (seen.has(key)) continue
      seen.add(key)
      cards.push({
        id: `ebay-fb-${item.itemId}`, name,
        set: number ? number.replace(/-\d+[A-Z]?$/, '') : '', number,
        rarity: '', game: 'ebay',
        imageUrl: item.image?.imageUrl || null,
        largeImageUrl: item.image?.imageUrl || null,
        searchQuery: number ? `${name} ${number}` : name,
        viaEbay: true,
      })
      if (cards.length >= 5) break
    }
    return cards
  })
}

// ─── PRE-WARM CACHE ──────────────────────────────────────────────────────────
const PRE_WARM_QUERIES = [
  'charizard', 'pikachu', 'mewtwo', 'eevee', 'gengar',
  'blastoise', 'venusaur', 'rayquaza', 'lugia', 'ho-oh',
]
let _preWarmed = false
function preWarmCache() {
  if (_preWarmed) return
  _preWarmed = true
  console.log('[cards] pre-warming Pokemon cache for top 10 cards')
  for (const q of PRE_WARM_QUERIES) {
    searchPokemon(q).catch((err) => console.log(`[cards] pre-warm ${q} failed: ${err.message}`))
  }
  // Also pre-load One Piece and DBS card data
  loadOpData().catch(() => {})
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  preWarmCache()
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { q, limit: limitParam } = req.query
  const maxResults = Math.min(parseInt(limitParam) || 8, 50)

  if (!q || q.trim().length < 3) {
    return res.status(400).json({ error: 'Query too short' })
  }

  const query = q.trim()
  const game = detectGame(query)
  console.log(`[cards] q="${query}" game=${game} limit=${maxResults}`)
  const ebayDirect = null

  let cards = []
  let attribution = null
  let jpExclusive = false

  // ── Step 1: Check card_catalog FIRST (instant, no external API) ─────────
  const catalogResults = await searchCatalog(query, game, maxResults)
  console.log(`[catalog] catalogResults: ${catalogResults.length}`, catalogResults.map(r => `${r.name} (${r.number})`))
  const hasCardNum = /\b(?:BT|FB|FS|SD|ST|SB|EB|TB|D-BT|OP)-?\d+(?:-\d+)?|\bE-?\d+/i.test(query)

  if (catalogResults.length >= 5) {
    // 5+ results: great catalog coverage — return immediately, skip external APIs
    cards = catalogResults
    attribution = 'CardPulse catalog'
    console.log(`[cards] catalog has ${cards.length} results, skipping external APIs`)
    incrementSearchCount(catalogResults)
    return res.status(200).json({ cards: cards.slice(0, maxResults), ebayDirect, game, attribution, jpExclusive })
  }

  if (catalogResults.length >= 1 && hasCardNum) {
    // Card number search with 1+ catalog results — return immediately
    cards = catalogResults
    attribution = 'CardPulse catalog'
    console.log(`[cards] catalog has ${cards.length} results for card number, skipping external APIs`)
    incrementSearchCount(catalogResults)
    return res.status(200).json({ cards: cards.slice(0, maxResults), ebayDirect, game, attribution, jpExclusive })
  }

  // ── Step 2: 1-4 catalog results — save them, then fill remaining slots ──
  if (catalogResults.length >= 1) {
    console.log(`[cards] catalog has ${catalogResults.length} partial results, merging with external API`)
    incrementSearchCount(catalogResults)
  }

  // ── Step 3: Run external APIs (catalog had <5 results or 0 for name search) ─
  let externalCards = []
  if (game === 'pokemon') {
    try {
      const result = await searchPokemon(query)
      externalCards = result.cards || []
      jpExclusive = result.jpExclusive || false
    } catch (err) { console.error('[cards] pokemon error:', err.message) }
    if (externalCards.length) attribution = 'pokemontcg.io'
  } else if (game === 'mtg') {
    try { externalCards = await searchMtg(query) } catch (err) { console.error('[cards] mtg error:', err.message) }
    if (externalCards.length) attribution = 'Scryfall'
  } else if (game === 'yugioh') {
    try { externalCards = await searchYugioh(query) } catch (err) { console.error('[cards] yugioh error:', err.message) }
    if (externalCards.length) attribution = 'YGOProDeck'
  } else if (game === 'onepiece') {
    try { externalCards = await searchOnePiece(query) } catch (err) { console.error('[cards] onepiece error:', err.message) }
    if (externalCards.length) attribution = 'One Piece Card Game'
  } else if (game === 'dbs') {
    try { externalCards = await searchDbs(query) } catch (err) { console.error('[cards] dbs error:', err.message) }
    if (externalCards.length) attribution = 'DBS Card Game'
  } else if (game === 'lorcana') {
    try { externalCards = await searchLorcana(query) } catch (err) { console.error('[cards] lorcana error:', err.message) }
    if (externalCards.length) attribution = 'Lorcana'
  } else {
    // No game detected — search all databases in parallel
    console.log('[cards] no game detected, searching all databases')
    const [pkm, mtg, ygo, lor] = await Promise.allSettled([
      searchPokemon(query), searchMtg(query), searchYugioh(query), searchLorcana(query),
    ])
    if (pkm.status === 'fulfilled') {
      const result = pkm.value
      externalCards.push(...(result.cards || []))
      if (result.jpExclusive) jpExclusive = true
    }
    if (mtg.status === 'fulfilled') externalCards.push(...mtg.value)
    if (ygo.status === 'fulfilled') externalCards.push(...ygo.value)
    if (lor.status === 'fulfilled') externalCards.push(...lor.value)

    if (externalCards.length) attribution = 'Multiple sources'
    console.log(`[cards] parallel search found ${externalCards.length} total results`)
  }

  console.log(`[external] externalCards: ${externalCards.length}`)

  // General eBay fallback — when no catalog AND no external API results
  if (!catalogResults.length && !externalCards.length && query.split(/\s+/).length >= 2) {
    console.log('[cards] no catalog or external results, trying eBay fallback')
    try {
      externalCards = await searchEbayFallback(query)
      if (externalCards.length) attribution = 'eBay listings'
    } catch (err) { console.error('[cards] eBay fallback error:', err.message) }
  }

  // Merge: catalog results FIRST, then external fills remaining slots up to 8
  // Catalog always takes priority — external only fills gaps
  const seenKeys = new Set()
  const merged = []
  // Add catalog results first
  for (const c of catalogResults) {
    const key = (c.number || c.name || '').toLowerCase()
    if (key && !seenKeys.has(key)) { seenKeys.add(key); merged.push(c) }
  }
  // Fill remaining slots with external results (dedup against catalog)
  for (const c of externalCards) {
    if (merged.length >= maxResults) break
    const key = (c.number || c.name || '').toLowerCase()
    if (key && !seenKeys.has(key)) { seenKeys.add(key); merged.push(c) }
  }
  if (catalogResults.length > 0) attribution = 'CardPulse catalog'
  console.log(`[cards] final: ${catalogResults.length} catalog + ${merged.length - catalogResults.length} external = ${merged.length} total`)

  return res.status(200).json({ cards: merged.slice(0, maxResults), ebayDirect, game, attribution, jpExclusive })
}
