# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development & Deployment

No build step. Deploys directly to Vercel:

- **Frontend**: `public/index.html` — single-file vanilla JS SPA (all HTML/CSS/JS inline)
- **Backend**: `api/prices.js` — eBay Browse API pricing with weighted blending
- **Autocomplete**: `api/cards.js` — Supabase card_catalog + external API fallback
- **Image proxy**: `api/image-proxy.js` — proxies One Piece/DBS images to avoid hotlink blocking
- **Import scripts**: `scripts/import-*.js` — bulk import card data into Supabase (local only)
- **Deploy**: `git push` to master → Vercel auto-deploys in ~30s. Force: `vercel --prod --force --scope phanousits-projects`
- **Local dev**: `vercel dev`. For offline/mock: set `USE_REAL_API = false` in `public/index.html`

## Architecture

### Frontend (`public/index.html`)

**Four tabs**: Search, Scan, Collection, History. State in globals; persistence via `localStorage` (`cph` = history, `cpc` = collection).

Key functions:
- `search()` — grade auto-detection from query (strips grade terms, updates pill UI), calls API or mock
- `normalizeApiResponse()` — adapter between API response and `renderResult()`. **Change this (not renderResult) when API shape changes.**
- `renderResult()` — builds result card HTML. Shows sports-specific or TCG-specific wide spread guidance.
- `cardType()` — classifies as `sr` (sports raw), `sg` (sports graded), `tcg`, or `dbs`. **Two copies exist**: one inside `normalizeApiResponse()` (complete DBS keywords) and one global (synced). DBS keywords include character names (vegeta, goku, frieza, gogeta), set codes (FB0x, BT1-20, SD0x), subtitle markers (`: da`), and attack names. `renderResult()` uses `r.ct` from normalizeApiResponse, not a recomputed value.
- `acOnInput()` / `fetchAc()` / `renderAc()` / `selectAc()` — autocomplete with 350ms debounce, AbortController, LRU cache (20 entries). First-word name matching filters false positives.
- `pick()` — grade pill click handler. Swaps/adds/removes grade term in search input. `_manualGrade` flag prevents auto-detection from overriding manual clicks.

`selectedCard` — set when user clicks autocomplete result. Passes `exact=1` to bypass preprocessor. `selectAc()` builds per-game eBay-optimized queries:
- **MTG/Pokemon/Lorcana**: card name + set name (sellers use set names, not collector numbers)
- **Yu-Gi-Oh**: card name only (sellers rarely include set/number)
- **DBS/One Piece**: card name + card number (sellers use card numbers like FB07-079, BT22-049)
- Strips promo/parallel suffixes: `_PR`, `_p1`, `-P1`, `-P2`, `(-P2)` name suffix
- SR\*/SCR\* selected → appends "alt art"; DBR → "dragon ball rare"; SGR → "gold rare"
- Truncates at first comma: "Special Beam Cannon, Inherited Power" → "Special Beam Cannon"

**Back navigation** (`navStack`): Stack-based navigation tracks search → disambiguation → result transitions. Back button appears on disambiguation and result views. Browser back (popstate) also triggers `goBack()`. `disambigPick()` skips intermediate nav push so back from result returns to disambiguation.

**No-data response handling**: `prices.js` returns `200` with `{type: 'no-data', error, searchTip}` instead of HTTP 404. Frontend checks `data.type === 'no-data'` and shows card image + message + searchTip. Search tip suppressed when query already contains a card number pattern.

**Rarity split picker**: When comps contain mixed SR ($5-6) and SPR ($28-30) with >2x price gap and >20% each, backend returns `{type: 'rarity-split'}` with per-variant avg prices. Frontend shows a picker; tapping re-searches with rarity appended. Only fires when no card number AND no rarity in original query; `exact=1` forces `_hasCardNum=false` so autocomplete selections can trigger it.

**Outlier flagging**: Comps >2x or <0.4x median flagged `outlier:true` (display-only). Shows "⚠ Possible outlier" in red below price. Skipped when SR/SPR rarity split explains the price gap.

**Game-aware spread warning**: Wide spread tip text shows per-game examples (DBS: set codes/card numbers, Pokemon: set names/1st edition, MTG: Alpha/Beta/foil, Lorcana: enchanted, YGO: LOB/1st edition, One Piece: card numbers/language, Sports: year/set/parallel).

### Backend (`api/prices.js`)

Vercel serverless function. Four parallel eBay queries with weighted blending:

| Query | Label | Weight (with D) | Weight (without D) |
|-------|-------|-----------------|-------------------|
| A | All sold (90d) | 0.20 | 0.25 |
| B | Recent sold (30d) | 0.35 | 0.45 |
| C | Grade-exact | 0.25 | 0.30 |
| D | Live auctions (48h) | 0.20 | — |

**eBay query filters**: `itemLocationCountry:US` on all queries. Global fallback (US/CA only) when < 5 US comps.

**Recency boost**: When Query B has 1-2 comps but A has more older comps, B weight → 0.60.

**Query C outlier detection**: If C avg is >35% below A+B median, C weight → 0 (redistributed to A+B).

**Unified filter path** — `filterItems()` output feeds BOTH `calcStats` (pricing) AND `allItems` (display). No separate paths.

**filterItems()** multi-layer filtering:
1. Minimum price ($0.50) — strips $0/invalid listings
2. Graded slab hard block (Raw only) — `isGradedSlab()` detects PSA/BGS/CGC/SGC/SCG/CSG/CCG etc. SCG (Southern Grading) also detected standalone without trailing number.
3. Lot/multi-card exclusion (all grades) — lots, bundles, "pick your card", "father & son"
4. Merchandise exclusion — sleeves, playmats, deck boxes, blankets, pins, binders, display cases, figures, proxies, mousepads, tapestries, apparel, 3d prints. All use multi-word patterns to avoid false positives.
5. Variant exclusion — alt art, foil, parallel, token, promo, memorabilia, accessories. **Sports card queries skip TCG-specific variants** (foil/holo/chrome/refractor) but keep memorabilia/sealed/fan art (`_sports: true` tag).
5. Holo exclusion (non-Pokemon, non-sports only)
6. Set code enforcement (TCG only) — BT/FB/SV/SM/XY/OP/ST codes required in comp titles
7. Card name enforcement — non-modifier, non-set-code query words must appear in comp titles
8. Language exclusion (always enforced, no fallback) — Japanese/JP/Korean/Chinese/Cross Worlds/DBS Master
9. Cheap junk filter ($<3 with code/bulk/lot keywords)
10. Grade-specific filtering — Raw excludes graded terms; graded searches never fall back to ungraded

**Fallback safety**: Variant fallback restores from pre-variant snapshot (not original items). Raw grade fallback restores from post-identity-filter snapshot. Name/lang/set drops are never reversed.

**Hard block** on final `deduped` array — card name enforcement as absolute last safety net before response.

**Rarity enforcement** (`filterByRarity`): SCR vs SCR*/SCR Alt vs SCR**/Two Star correctly separated. Case-insensitive detection. For `exact=1` queries, high-value rarities (SPR, SCR, SEC, SSR, SAR) AND starred variants (SR\*, SCR\*) are enforced when explicitly in the query. Plain low-value codes (SR, R, UC, C) are stripped. "alt art" in query infers `requiredRarity = 'SR*'`.

**Catalog rarity lookup**: Async Supabase promise (8s timeout) runs in parallel with eBay queries, resolved before `filterByRarity`. Looks up card's rarity from `card_catalog` by card number. Only enforces when user explicitly typed the rarity code in the original query (not auto-inferred). Filters null-rarity rows from results.

**eBay query sanitization** (in `ebaySearch()`): Strips apostrophes (`'''``), leading dashes (`-Sign-`), promo suffixes (`_PR`, `_p1`, `-P1`, `-P2`), and `(-P2)` name suffixes before sending to eBay API. Display names and catalog lookups are unaffected.

**Sports card detection**: `/\b(rookie|rc|topps|bowman|panini|...)\b/i` AND no TCG keywords → lighter filter set (skips set codes, holo, variant filters).

**Outlier removal** in `calcStats()`:
- 2 comps with >10x spread → keep lower only
- Any comp >50x median → always removed
- Small sets (≤5): 40%-200% of median bounds
- Large sets: 20%-300% of median bounds

**Variant/accessory exclusions** (VARIANT_TERMS): alt art, foil, chrome, refractor, memorabilia (relic/jersey/patch/swatch/game-used), event exclusives (national convention), ultra-premium parallels (rapture/shimmer/lime/lava/disco/vortex/pulsar/cosmic/nebula/cracked ice/tiger stripe), One Piece parallels (wanted poster/manga art/SPC), anniversary sets, accessories (figure/plush/sleeve/magnetic/lighter), fan art/proxy/custom cards.

**Word-strip retry**: Strips one modifier word when comps insufficient. Sports queries only strip at 0 comps (not <3). Card names and set codes protected. Max 1 successful retry.

### Autocomplete (`api/cards.js`)

**Priority**: Supabase card_catalog (~148,000+ cards) → external APIs → eBay fallback.

**Fuzzy search** via `fuzzy_search_cards()` Supabase RPC (pg_trgm `word_similarity`, threshold 0.25):
- Card number queries → exact PostgREST match (unchanged)
- Name queries → RPC with game keyword stripping + alias correction
- Re-ranking: when query has both name + card number, results matching name terms rank higher

**Alias map** for common misspellings: vegita→vegeta, freiza→frieza, picolo→piccolo, charizrd→charizard, etc.

**Classic DBS aliases** (`CLASSIC_ALIASES`): Maps common card name variations to BT card numbers when fuzzy search returns 0 results. E.g., "gogeta blue" → BT6-109, "piccolo awakening" → BT3-018. Stopgap until full BT card names are imported.

**Set code filtering**: Extracts set codes (FB07, BT01, OP01, etc.) from queries, strips them before fuzzy search, then post-filters results by `set_code` or `card_number` prefix. Falls back to unfiltered if no matches. Direct set_code + ILIKE query fires when fuzzy results miss the target set.

**Pokemon set keyword filtering** (`PKM_SET_KEYWORDS`): Maps 40+ set names ("base set", "jungle", "fossil", "scarlet violet", etc.) to internal set codes. Strips keyword from fuzzy search, filters results by set_code prefix.

**Pokemon set name mapping** (`PKM_SET_NAMES`): 150+ set codes → human-readable names (BASE1→"Base Set", SM12→"Cosmic Eclipse", SWSH35→"Champions Path", SV3PT5→"151"). Used in catalog response so `selectAc` builds "Charizard Base Set" not "Charizard BASE1".

**Apostrophe handling**: `sqlSanitized` (double-escaped `''`) only for PostgREST URL params. RPC receives original query with apostrophes intact — trigram matching needs them.

**ILIKE prefix fallback**: When fuzzy search returns 0 results and query is 5+ chars, tries `card_name ILIKE '%query%'`. Catches truncated words ("powe" → "power").

**Result sorting**: Prefix boost (cards whose name starts with full query rank first) → rarity priority tiebreaker (SCR=0, SCR\*=1, SR=3, SPR=5, R=9, UC=10, C=11). Full query used for prefix match, punctuation stripped.

**Set code duplicate display**: Set label hidden in autocomplete subtitle when already a prefix of the card number (no "FB07 · FB07-079").

**One Piece images** routed through `/api/image-proxy` to avoid SAMPLE watermark.

**eBay fallback** filters: Japanese/Cross Worlds listings excluded.

### Image Proxy (`api/image-proxy.js`)

Proxies images from allowed domains (optcgapi.com, en.onepiece-cardgame.com, www.dbs-cardgame.com). Returns 403 for other domains. 24h cache, CORS enabled.

## Supabase (Live)

**Project URL**: `https://jvynhfqcefztfcgznwhe.supabase.co`

### Tables

**`price_history`** — price snapshots from every successful search. Indexed on (card_name, queried_at desc).

**`card_catalog`** — ~150,000+ cards across 7 games. Unique index: `(game, card_number_key, rarity_key)`. GIN trigram index: `card_catalog_name_trgm_idx` on `card_name`. Dedup in autocomplete uses `card_number|rarity` key so SR and SR* variants both appear. Some cards have duplicate rows from old Deckplanet import (rarity=null) and new Bandai import (rarity set) — catalog rarity lookup filters null rows with `rarity=not.is.null`.

### RPC Functions

**`fuzzy_search_cards(q, game_filter, result_limit)`** — pg_trgm word_similarity search with ILIKE fallback. Threshold 0.25. Parameter named `q` (not `search_query` — column name conflict).

### Card Catalog Stats

| Game | Cards | Source |
|------|-------|--------|
| DBS Fusion World | ~1,967 | apitcg.com + Bandai official (FB07+) |
| DBS Classic (BT) | ~4,922 | Bandai US-EN (BT01-BT27 fully named + 831 SPR variants) |
| DBS EX/Anniversary | ~465 | Bandai US-EN (EX01-EX25) |
| DBS TB/SD/Other | ~568 | Deckplanet GCS + Bandai |
| Pokemon | ~20,150 | pokemontcg.io |
| MTG | ~104,015 | Scryfall bulk |
| Yu-Gi-Oh | ~14,298 | YGOProDeck |
| One Piece | ~1,705 | optcgapi.com |
| Lorcana | ~2,291 | lorcana-api.com |
| **Total** | **~150,381** | |

### Import Scripts

All in `scripts/`, run locally with `.env.local` (SUPABASE_URL + SUPABASE_SERVICE_KEY required):

```bash
npm run import-dbs             # DBS Fusion World (needs APITCG_KEY)
npm run import-dbs-classic     # DBS Classic BT sets (Deckplanet GCS, numbers only)
npm run import-fb07            # FB07 Wish for Shenron from Bandai official (names+rarities)
npm run import-fb08            # FB08 from Bandai official (reuses fb07 script)
npm run import-fb09            # FB09 from Bandai official (reuses fb07 script)
npm run import-bt19-bt23       # BT19-BT23 from Bandai US-EN POST API (names+rarities)
npm run import-bt24-bt27       # BT24-BT27 from Bandai US-EN POST API
npm run import-bt01-bt18-names # Fill BT01-BT18+TB01-TB03 placeholder names from Bandai US-EN
npm run import-dbs-ex          # EX01-EX25 expansion/anniversary sets from Bandai
npm run import-pokemon         # Pokemon (~20k cards, retry logic, 1.5s delay for free tier)
npm run import-mtg             # MTG from Scryfall bulk (~80MB download)
npm run import-yugioh          # Yu-Gi-Oh from YGOProDeck
npm run import-onepiece        # One Piece from optcgapi.com
npm run import-lorcana         # Lorcana from lorcana-api.com
npm run import-all             # Run all imports sequentially
```

**Bandai import scripts**:
- `import-fb07-cards.js`: GET `dbs-cardgame.com/fw/en/cardlist/?search=true&q=FB07`, parses alt text. Reusable for FB08/FB09 via CLI arg.
- `import-bt19-bt23-cards.js`: POST `dbs-cardgame.com/us-en/cardlist/index.php?search=true` with `category_exp` IDs (428019-428023).
- `import-bt24-bt27-cards.js`: Same approach, IDs 428024-428027, uses US-EN source.
- `import-dbs-bt01-bt18-names.js`: Updates placeholder rows (card_name=card_number) with real names from Bandai US-EN. Only updates placeholders, preserves manually named cards. Also inserts new SPR variants not in Deckplanet. IDs 428001-428018 (BT) + 428101-428103 (TB).
- `import-dbs-ex-cards.js`: EX01-EX25, IDs 428401-428425. Full upsert with names/rarities/images.

**Bandai category_exp ID ranges**: BT=428001-428030, TB=428101-428103, SD=428301-428323, EX=428401-428425, XD=428501-428503, DB=428601-428603, Promo=428901.

## Environment Variables

Set in Vercel dashboard → Settings → Environment Variables:

| Variable | Purpose | Status |
|----------|---------|--------|
| `EBAY_CLIENT_ID` | eBay App ID | Configured |
| `EBAY_CLIENT_SECRET` | eBay Cert ID | Configured |
| `SUPABASE_URL` | Supabase project URL | Configured |
| `SUPABASE_SERVICE_KEY` | service_role key (not anon key) | Configured |
| `POKEMON_TCG_API_KEY` | Optional — higher rate limit for pokemontcg.io | Not set |

## Known Issues

- **Scan tab uses mock data**: `runScanLoop()` uses hardcoded mock cards. Needs ZXing barcode scanning.
- **Collection uses localStorage**: No user accounts, data lost if browser cleared. Supabase auth needed.
- **DBS FB07 in catalog** (122 cards). FB08+ still missing — run `npm run import-fb08` / `import-fb09` when needed.
- **BT01-BT18 now fully named** from Bandai US-EN (2,565 placeholders filled + 831 new SPR variants). Some Deckplanet images show wrong art — Bandai images preferred.
- **eBay rate limiting**: Heavy usage can trigger 429 errors. Resets after 15-60 minutes.
- **One Piece image proxy**: Images still show SAMPLE watermark from some sources despite proxy.
- In `normalizeApiResponse()`, `ct` and `jx` are referenced before assignment — works via closure.

## Project Info

**GitHub**: https://github.com/psyhakhom/cardpulse
**Deployed**: Vercel — auto-deploys on git push to master.

## Price History (post-launch milestone)

`price_history` table logs every search to Supabase (fire-and-forget). Data is accumulating now but not yet used in pricing results.

**Thresholds before enabling historical prices in results:**
- Per card: 5+ logged prices before showing "CardPulse historical avg"
- Time window: 30+ days of data before trends are reliable
- Overall traffic: 200+ DAU before dataset is dense enough for most cards

**Implementation plan (when ready):**
- Query `price_history` for card name + game, calculate 30d and 90d averages
- Blend as a 5th source alongside the 4 eBay queries
- Weight: start at 10-15%, increase as data volume grows
- Powers sparkline charts on Pro tier ($6/month)
- Popular cards (Charizard, Black Lotus, key DBS SCRs) will reach threshold within 2-3 weeks of launch at 200+ DAU

**Do NOT implement until post-launch with sufficient data volume.**

## Next Tasks

1. Add ZXing barcode scanning to replace mock scan loop
2. Set up Supabase auth for persistent user collections
3. Add PWA manifest.json and service worker for home screen install
4. Validate pricing accuracy (test 30 cards manually vs eBay sold prices)
5. Launch on Reddit (r/pkmntcg, r/footballcards, r/dragonballsuper)
