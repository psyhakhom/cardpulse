# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development & Deployment

No build step. Deploys directly to Vercel:

- **Frontend**: `public/index.html` — single-file vanilla JS SPA (all HTML/CSS/JS inline)
- **Backend**: `api/prices.js` — eBay Browse API pricing with weighted blending
- **Autocomplete**: `api/cards.js` — Supabase card_catalog + external API fallback
- **Image proxy**: `api/image-proxy.js` — proxies One Piece/DBS/Gundam/Deckplanet images to avoid hotlink blocking
- **Import scripts**: `scripts/import-*.js` — bulk import card data into Supabase (local only)
- **Deploy**: `git push` to master → Vercel auto-deploys in ~30s. Force: `vercel --prod --force --scope phanousits-projects`
- **Local dev**: `vercel dev`. For offline/mock: set `USE_REAL_API = false` in `public/index.html`

## Architecture

### Frontend (`public/index.html`)

**Three tabs**: Search, Collection, History (Scan tab removed — mock data only). State in globals; persistence via `localStorage` (`cph` = history, `cpc` = collection).

Key functions:
- `search()` — grade auto-detection from query (strips grade terms, sets `G` variable), calls API or mock
- `normalizeApiResponse()` — adapter between API response and `renderResult()`. **Change this (not renderResult) when API shape changes.** Now includes `cardSet` and `cardNum` from `selectedCard` for display.
- `renderResult()` — builds result card HTML. Shows set name + card number subtitle below title. Grade/condition/language filters rendered dynamically inside the result (not in search pane). P-suffix stripped from display names (`(-P2)` → hidden, shown in card number subtitle instead).
- `cardType()` — classifies as `sr` (sports raw), `sg` (sports graded), `tcg`, or `dbs`. **Two copies exist**: one inside `normalizeApiResponse()` (complete DBS keywords) and one global (synced). DBS keywords include character names (vegeta, goku, frieza, gogeta, fortuneteller baba, master roshi, yamcha, ginyu force, raditz, nappa, zarbon, dodoria, etc.), set codes (FB0x, BT1-20, SD0x, SB0x), subtitle markers (`: da`), and attack names. `renderResult()` uses `r.ct` from normalizeApiResponse, not a recomputed value.
- `acOnInput()` / `fetchAc()` / `renderAc()` / `selectAc()` — autocomplete with 350ms debounce, AbortController, LRU cache (20 entries). First-word name matching filters false positives.
- `pick()` — grade pill click handler (now rendered inside result card). Swaps/adds/removes grade term in search input, re-triggers search. `_manualGrade` flag prevents auto-detection from overriding manual clicks.

`selectedCard` — set when user clicks autocomplete result. Passes `exact=1` to bypass preprocessor. `selectAc()` builds per-game eBay-optimized queries:
- **MTG/Pokemon/Lorcana**: card name + set name (sellers use set names, not collector numbers)
- **Yu-Gi-Oh**: card name only (sellers rarely include set/number)
- **DBS/One Piece**: card name + card number (sellers use card numbers like FB07-079, BT22-049)
- Strips promo/parallel suffixes: `_PR`, `_p1`, `-P1`, `-P2`, `(-P2)` name suffix
- **Parallel detection**: `-P` suffix detected before stripping. Extracts P-number (`parallelNum`) and `variantSource` from catalog. Sets `selectedCard.parallel=true`, frontend passes `parallel=1`, `pnum=N`, and `vsrc=...` to backend. Query uses name + base number (no -P suffix): "Fortuneteller Baba SB01-049"
- SR\*/SCR\* selected → appends "alt art"; DBR → "dragon ball rare"; SGR → "gold rare"
- Truncates at first comma: "Special Beam Cannon, Inherited Power" → "Special Beam Cannon"

**Back navigation** (`navStack`): Stack-based navigation tracks search → browse → disambiguation → result transitions. Back button appears on browse, disambiguation, and result views (styled as pill: border #444, bg #1a1a24, border-radius 20px). Browser back (popstate) also triggers `goBack()`. `disambigPick()` skips intermediate nav push so back from result returns to disambiguation. Back from result to 'search' state uses cached `_lastBrowseHTML` for instant render (no re-fetch). Browse: Enter/search → shows all catalog matches (limit=50) before pricing; tapping a card triggers pricing.

**Browse view**: `renderBrowse()` shows catalog-only results (no eBay mixing) filtered by detected game. `browsePick()` delegates to `selectAc()` for pricing flow. `_browseCards` stores browse results; `AC_CACHE_V = 'v2'` for cache busting.

**No-data response handling**: `prices.js` returns `200` with `{type: 'no-data', error, searchTip}` instead of HTTP 404. Frontend checks `data.type === 'no-data'` and shows card image + message + searchTip. Search tip suppressed when query already contains a card number pattern.

**Rarity split picker**: When comps contain mixed SR ($5-6) and SPR ($28-30) with >2x price gap and >20% each, backend returns `{type: 'rarity-split'}` with per-variant avg prices. Frontend shows a picker; tapping re-searches with rarity appended. Only fires when no card number AND no rarity in original query; `exact=1` forces `_hasCardNum=false` so autocomplete selections can trigger it.

**Outlier flagging**: Comps >2x or <0.4x median flagged `outlier:true` (display-only). Shows "⚠ Possible outlier" in red below price. Skipped when SR/SPR rarity split explains the price gap.

**Game-aware spread warning**: Wide spread tip text shows per-game examples (DBS: set codes/card numbers, Pokemon: set names/1st edition, MTG: Alpha/Beta/foil, Lorcana: enchanted, YGO: LOB/1st edition, One Piece: card numbers/language, Sports: year/set/parallel).

### Backend (`api/prices.js`)

Vercel serverless function. eBay queries with weighted blending, split by card type:

**TCG cards** (dbs, pokemon, mtg, lorcana, yugioh, onepiece — 3 queries, no live auctions):

| Query | Label | Weight |
|-------|-------|--------|
| A | All sold (90d) | 0.30 |
| B | Recent sold (30d) | 0.50 |
| C | Grade-exact | 0.20 |

**Sports cards** (sr/sg — 4 queries, auctions matter):

| Query | Label | Weight (with D) | Weight (without D) |
|-------|-------|-----------------|-------------------|
| A | All sold (90d) | 0.20 | 0.25 |
| B | Recent sold (30d) | 0.30 | 0.40 |
| C | Grade-exact | 0.25 | 0.35 |
| D | Live auctions (48h) | 0.25 | — |

**eBay query filters**: `itemLocationCountry:US` on all queries. Global fallback (US/CA only) when < 5 US comps. `Cache-Control: no-store` prevents Vercel edge caching.

**Recency boost**: When Query B has 1-2 comps but A has more older comps, B weight → 0.60.

**Query C outlier detection**: If C avg is >35% below A+B median, C weight → 0 (redistributed to A+B).

**Unified filter path** — `filterItems()` output feeds BOTH `calcStats` (pricing) AND `allItems` (display). No separate paths.

**filterItems()** multi-layer filtering:
1. Minimum price ($0.50) — strips $0/invalid listings
2. Graded slab hard block (Raw only) — `isGradedSlab()` detects PSA/BGS/CGC/SGC/SCG/CSG/CCG/ARS/KSA/PGS/CGA/RCG/ARENA etc. SCG (Southern Grading) also detected standalone without trailing number. ARENA requires trailing number (`ARENA 10`) to avoid false positives.
3. Lot/multi-card exclusion (all grades) — lots, bundles, "pick your card", "father & son"
4. Merchandise exclusion — sleeves, playmats, deck boxes, blankets, pins, binders, display cases, figures, proxies, mousepads, tapestries, apparel, 3d prints, enamel pins, gaming mats, vendor booths. All use multi-word patterns to avoid false positives.
5. Variant exclusion — alt art, foil, parallel, token, promo, memorabilia, accessories. **Sports card queries skip TCG-specific variants** (foil/holo/chrome/refractor) but keep memorabilia/sealed/fan art (`_sports: true` tag). **Parallel queries (`opts.skipVariants`) skip variant, holo, and set code filters entirely.**
5b. Reverse holo exclusion (Pokemon-aware) — excludes reverse holo unless query contains "reverse"
6. Holo exclusion (non-Pokemon, non-sports, non-parallel only)
7. Set code enforcement (TCG only, skipped for sports and parallel) — BT/FB/SB/SV/SM/XY/OP/ST codes required in comp titles
7. Card name enforcement — non-modifier, non-set-code query words must appear in comp titles
8. Language exclusion (always enforced, no fallback) — Japanese/JP/Korean/Chinese/Cross Worlds/DBS Master
9. Cheap junk filter ($<3 with code/bulk/lot keywords)
10. Grade-specific filtering — Raw excludes graded terms; graded searches never fall back to ungraded

**Fallback safety**: Variant fallback restores from pre-variant snapshot (not original items). Raw grade fallback restores from post-identity-filter snapshot. Name/lang/set drops are never reversed.

**Hard block** on final `deduped` array — card name enforcement as absolute last safety net before response.

**Rarity enforcement** (`filterByRarity`): SCR vs SCR*/SCR Alt vs SCR**/Two Star correctly separated. Case-insensitive detection. For `exact=1` queries, high-value rarities (SPR, SCR, SEC, SSR, SAR) AND starred variants (SR\*, SCR\*) are enforced when explicitly in the query. "alt art" in query infers `requiredRarity = 'SR*'`. Base rarities (SR, R, UC, C) auto-enforce to exclude alt art/starred/anniversary comps — prevents mixing $4 base SR with $50 anniversary versions.

**Catalog rarity lookup**: Async Supabase promise (8s timeout) runs in parallel with eBay queries, resolved before `filterByRarity`. Looks up card's rarity from `card_catalog` by card number. High-value rarities enforce only when user typed the rarity code. Base rarities (SR, R, UC, C) auto-enforce to filter out starred variants and anniversary reprints. Filters null-rarity rows from results.

**eBay query sanitization** (in `ebaySearch()`): Strips apostrophes (`'''``), leading dashes (`-Sign-`), promo suffixes (`_PR`, `_p1`, `-P1`, `-P2`), `(-P2)` name suffixes, and `//` dual name prefixes before sending to eBay API. Display names and catalog lookups are unaffected. Name enforcement filters strip curly apostrophes (`''`) from both name words and comp titles to prevent mismatch (e.g., "Power's" vs "powers").

**Sports card detection**: `/\b(rookie|rc|topps|bowman|panini|...)\b/i` AND no TCG keywords → lighter filter set (skips set codes, holo, variant filters). TCG_RE expanded with DBS characters: fortuneteller baba, master roshi, yamcha, tien, chiaotzu, ginyu force members (ginyu, recoome, burter, jeice, guldo), raditz, nappa, zarbon, dodoria, oolong, puar, ox-king, chichi, launch, turtle hermit, kame.

**Outlier removal** in `calcStats()`:
- 2 comps with >10x spread → keep lower only
- Any comp >50x median → always removed
- Small sets (≤5): 40%-200% of median bounds
- Large sets: 20%-300% of median bounds

**Variant/accessory exclusions** (VARIANT_TERMS): alt art, foil, chrome, refractor, memorabilia (relic/jersey/patch/swatch/game-used), event exclusives (national convention), ultra-premium parallels (rapture/shimmer/lime/lava/disco/vortex/pulsar/cosmic/nebula/cracked ice/tiger stripe), One Piece parallels (wanted poster/manga art/SPC), anniversary sets, accessories (figure/plush/sleeve/magnetic/lighter), fan art/proxy/custom cards.

**Word-strip retry**: Strips one modifier word when comps insufficient. Sports queries only strip at 0 comps (not <3). Card names and set codes protected. Max 1 successful retry.

**Parallel pricing** (`parallel=1` flag from frontend): Dedicated query path for parallel/alt-art cards (-P suffix). Frontend passes `pnum` (P-number) and `vsrc` (variant source from catalog). Fires 3 eBay queries using variant-specific terms when `vsrc` is available:
- Q1: `"{card name} {card number} {vsrc term}"` or `"{card name} {card number} alt art"` (if no vsrc)
- Q2: `"{card name} parallel"` (broad, US sold)
- Q3: `"{card name} {vsrc term}"` or `"{card name} {card number} manga"` (if no vsrc)

The `vsrc` value comes from apitcg.com's `getIt` field stored in `variant_source` column. Mapped to seller-friendly eBay terms (catalog names don't match seller language):
- Tournament Pack → "promo"
- Championship → "championship promo"
- Judge Pack → "judge promo"
- Manga Booster → "manga"
- Anniversary → "anniversary"
- Starter Deck → "starter deck promo"
- Sparking Zero → "sparking zero"
- Ultimate Battle/Release Event/Limited Pack/Selection Pack → "promo"
- BOOSTER PACK with dash-enclosed name → extracted (e.g., "RAGING ROAR" from "-RAGING ROAR-")
- Unknown → "alt art"

**Dokkan rescue**: Dokkan Battle alt art cards aren't catalog -P variants but appear on eBay with "dokkan" in titles. When the hard card number filter drops all comps, dokkan-titled comps matching the card name are rescued.

Results merged, deduped by itemId, then filtered:
1. $10 price floor (removes base card listings)
2. $500 price ceiling (removes speculative outliers)
3. Slab filter (Raw only)
4. `filterItems()` with `opts.skipVariants=true` — skips variant, holo, set code filters; keeps slab, lot, merch, name enforcement, language, grade
5. Card name hard block
6. Hard card number filter (require full card number → set code → dokkan rescue → drop all). No-data is better than wrong-card pricing. When parallel path has 0 comps, returns no-data instead of falling back to mixed-variant normal queries.
7. **Tiered date filter**: 30d → 60d → 90d (uses `itemCreationDate` for active listings)

**Active listing fallback**: eBay Browse API returns no sold data for some newer cards (e.g., SB01 parallels). When `soldItems:true` returns only active BIN listings (no `itemEndDate`), the parallel path uses BIN prices as market indicator. Response includes `activeListings: true` flag; frontend shows "Active listings" header + disclaimer instead of "Recent sold comps".

**Price population script** (`scripts/populate-prices.js`): Bulk-searches high-value cards through the deployed API to populate `price_history`. Prioritizes recent sets and high rarities (SCR, SPR, SR*, SEC, SAR, DBR, SGR). Throttled at 2s/request, skips cards searched in last 24h. Run: `npm run populate-prices` or `npm run populate-prices -- --limit 100 --game dbs`.

### Autocomplete (`api/cards.js`)

**Priority**: Supabase card_catalog (~150,000+ cards) → external APIs → eBay fallback. Catalog-first merge: catalog results always fill slots 1-N before external. Attribution shows 'CardPulse catalog' when catalog results present. Browse mode (`limit=50`) returns up to 50 catalog-only results.

**Fuzzy search** via `fuzzy_search_cards()` Supabase RPC (pg_trgm `word_similarity`, threshold 0.25):
- Card number queries → exact PostgREST match. Recognizes P-NNN promo card numbers alongside BT/FB/GD etc.
- Name queries → RPC with game keyword stripping + alias correction
- Re-ranking: when query has both name + card number, results matching name terms rank higher

**Variant field**: `variant` column (nullable text) passed through from catalog to frontend. Displayed as muted `· Gold Stamped` tag in autocomplete/browse subtitles and on pricing result subtitle line. In `selectAc()`, variant mapped to eBay terms via `VARIANT_EBAY_TERMS` (gold stamped→gold stamp, silver stamped→silver stamp, stamped→stamp). Unmapped variants are not appended to eBay queries.

**Alias map** for common misspellings: vegita→vegeta, freiza→frieza, picolo→piccolo, charizrd→charizard, etc.

**Classic DBS aliases** (`CLASSIC_ALIASES`): Maps common card name variations to BT card numbers when fuzzy search returns 0 results. E.g., "gogeta blue" → BT6-109, "piccolo awakening" → BT3-018. Stopgap until full BT card names are imported.

**Set code filtering**: Extracts set codes (FB07, BT01, OP01, etc.) from queries, strips them before fuzzy search, then post-filters results by `set_code` or `card_number` prefix. Falls back to unfiltered if no matches. Direct set_code + ILIKE query fires when fuzzy results miss the target set.

**Pokemon set keyword filtering** (`PKM_SET_KEYWORDS`): Maps 40+ set names ("base set", "jungle", "fossil", "scarlet violet", etc.) to internal set codes. Strips keyword from fuzzy search, filters results by set_code prefix.

**Pokemon set name mapping** (`PKM_SET_NAMES`): 150+ set codes → human-readable names (BASE1→"Base Set", SM12→"Cosmic Eclipse", SWSH35→"Champions Path", SV3PT5→"151"). Used in catalog response so `selectAc` builds "Charizard Base Set" not "Charizard BASE1".

**Apostrophe handling**: `sqlSanitized` (double-escaped `''`) only for PostgREST URL params. RPC receives original query with apostrophes intact — trigram matching needs them.

**ILIKE prefix fallback**: When fuzzy search returns 0 results and query is 5+ chars, tries `card_name ILIKE '%query%'`. Catches truncated words ("powe" → "power").

**Relevance filter**: When query has 4+ words, drops results matching <60% of query terms vs the best match. Prevents "Son Gohan : Youth" from cluttering results for "SS Son Gohan Youth Defying Terror".

**Result sorting**: Prefix boost (cards whose name starts with full query rank first) → rarity priority tiebreaker (SCR=0, SCR\*=1, SR=3, SPR=5, R=9, UC=10, C=11). Full query used for prefix match, punctuation stripped.

**Search-log dedup**: Rows without `card_number` (from eBay search logs, e.g., "Fortuneteller Baba alt art") are classified as search-log rows and excluded when proper import rows exist. Prevents duplicate entries in browse results.

**Set code duplicate display**: Set label hidden in autocomplete subtitle when already a prefix of the card number (no "FB07 · FB07-079").

**One Piece images** routed through `/api/image-proxy` to avoid SAMPLE watermark.

**Game detection expanded**: `DBS_KW` includes fortuneteller baba, master roshi, yamcha, tien, chiaotzu, ginyu force members, raditz, nappa, zarbon, dodoria, oolong, puar, ox-king, chichi, launch, turtle hermit, kame. `POKEMON_KW` includes EX-era set names. `detectGame()` returns correct game for EX-era Pokemon and DBS character searches.

**eBay fallback** filters: Japanese/Cross Worlds listings excluded.

### Image Proxy (`api/image-proxy.js`)

Proxies images from allowed domains (optcgapi.com, en.onepiece-cardgame.com, www.dbs-cardgame.com, www.gundam-gcg.com, deckplanet.com). Returns 403 for other domains. 24h cache, CORS enabled. Frontend `proxyImg()` helper routes dbs-cardgame.com and deckplanet URLs through proxy automatically — applied to autocomplete, browse, disambiguation, and no-data image renders.

## Supabase (Live)

**Project URL**: `https://jvynhfqcefztfcgznwhe.supabase.co`

### Tables

**`price_history`** — price snapshots from every successful search. Indexed on (card_name, queried_at desc).

**`card_catalog`** — ~152,000+ cards across 8 games. Columns: `card_name`, `card_number`, `game`, `set_code`, `rarity`, `image_url`, `search_query`, `variant_source`, `variant`, `times_searched`, `last_searched`. Generated columns: `card_number_key`, `rarity_key`. Unique index: `(game, card_number_key, rarity_key)`. GIN trigram index: `card_catalog_name_trgm_idx` on `card_name`. Additional indexes: `idx_card_catalog_card_number` on `card_number`, `idx_card_catalog_game_set` on `(game, set_code)`. Dedup in autocomplete uses `card_number|rarity` key (parallel cards dedup by `card_number` only, ignoring SR vs SR*). `variant_source` stores product origin from apitcg.com `getIt` field (e.g., "1st Anniversary Set", "BOOSTER PACK -RAGING ROAR- [FB03]"). `variant` (nullable text) stores display variant info (e.g., "Gold Stamped") — shown in autocomplete/browse/result UI, mapped to eBay terms via `VARIANT_EBAY_TERMS` in `selectAc()`.

### RPC Functions

**`fuzzy_search_cards(q, game_filter, result_limit)`** — pg_trgm word_similarity search with ILIKE fallback. Threshold 0.25. Parameter named `q` (not `search_query` — column name conflict). Returns all columns including `variant_source`.

**`increment_search_count(target_name)`** — atomically increments `times_searched` and updates `last_searched` for a card by name.

### Card Catalog Stats

| Game | Cards | Source |
|------|-------|--------|
| DBS Fusion World | ~2,248 | apitcg.com + Bandai official (FB01-FB09, FS01-FS12, SB01) |
| DBS Classic (BT) | ~5,868 | Bandai US-EN (BT01-BT30 fully named, clean re-imports) |
| DBS EX/Anniversary | ~465 | Bandai US-EN (EX01-EX25) |
| DBS Promo | ~1,039 | Bandai US-EN (P-001 through P-738 + variants) |
| DBS TB/SD/Other | ~568 | Deckplanet GCS + Bandai |
| Gundam Card Game | ~800 | gundam-gcg.com (GD01-GD03, ST01-ST09, beta, promos) |
| Pokemon | ~20,150 | pokemontcg.io |
| MTG | ~104,015 | Scryfall bulk |
| Yu-Gi-Oh | ~14,298 | YGOProDeck |
| One Piece | ~1,705 | optcgapi.com |
| Lorcana | ~2,291 | lorcana-api.com |
| **Total** | **~153,447** | |

### Import Scripts

All in `scripts/`, run locally with `.env.local` (SUPABASE_URL + SUPABASE_SERVICE_KEY required):

```bash
npm run import-dbs             # DBS Fusion World (needs APITCG_KEY) — populates variant_source
npm run import-dbs-classic     # DBS Classic BT sets (Deckplanet GCS, numbers only)
npm run import-fb07            # FB07 Wish for Shenron from Bandai official (names+rarities)
npm run import-fb08            # FB08 from Bandai official (reuses fb07 script)
npm run import-fb09            # FB09 Dual Evolution from Bandai FW (clean delete+re-import)
npm run import-fs11-fs12       # FS11+FS12 starter decks from Bandai FW (clean delete+re-import)
npm run import-bt19-bt23       # BT19-BT23 from Bandai US-EN (clean delete+re-import, 954 cards)
npm run import-bt24-bt27       # BT24-BT28 from Bandai US-EN POST API
npm run import-bt26-clean      # BT26 Ultimate Advent clean re-import from Bandai US-EN
npm run import-bt29            # BT29 (UB02) from Bandai US-EN
npm run import-bt29-clean      # BT29 Fearsome Rivals clean re-import from Bandai US-EN
npm run import-bt30            # BT30 (UB03 Three Glorious Fighters) from Bandai US-EN
npm run import-bt01-bt18-names # Fill BT01-BT18+TB01-TB03 placeholder names from Bandai US-EN
npm run import-dbs-ex          # EX01-EX25 expansion/anniversary sets from Bandai
npm run import-dbs-promo       # DBS promo cards P-001 to P-738 from Bandai US-EN (~1,039 cards)
npm run import-gundam          # Gundam Card Game from gundam-gcg.com (~800 cards)
npm run import-gd03            # GD03 from gundam-gcg.com (reusable for other sets via CLI arg)
npm run import-pokemon         # Pokemon (~20k cards, retry logic, 1.5s delay for free tier)
npm run import-mtg             # MTG from Scryfall bulk (~80MB download)
npm run import-yugioh          # Yu-Gi-Oh from YGOProDeck
npm run import-onepiece        # One Piece from optcgapi.com
npm run import-lorcana         # Lorcana from lorcana-api.com
npm run import-all             # Run all imports sequentially
npm run populate-prices        # Bulk-search high-value cards to populate price_history
```

**Bandai import scripts**:
- `import-fb07-cards.js`: GET `dbs-cardgame.com/fw/en/cardlist/?search=true&q=FB07`, parses alt text. Reusable for FB08 via CLI arg.
- `import-fb09-cards.js`: Dedicated FB09 script with clean delete+re-import pattern.
- `import-fs11-fs12-cards.js`: FS11+FS12 starter decks, 2-digit card numbers (FS11-01 not FS11-001).
- `import-bt19-bt23-cards.js`: Clean delete+re-import from Bandai US-EN. IDs 428019-428023. Processes sets sequentially, aborts individual set on fetch failure.
- `import-bt24-bt27-cards.js`: IDs 428024-428030 (BT24-BT30), uses US-EN source.
- `import-bt26-clean.js`: BT26 Ultimate Advent clean re-import. Strips `_SPR/_SCR/_GDR` suffixes from card numbers.
- `import-bt29-clean.js`: BT29 Fearsome Rivals clean re-import.
- `import-dbs-bt01-bt18-names.js`: Updates placeholder rows (card_name=card_number) with real names from Bandai US-EN. Only updates placeholders, preserves manually named cards. Also inserts new SPR variants not in Deckplanet. IDs 428001-428018 (BT) + 428101-428103 (TB).
- `import-dbs-ex-cards.js`: EX01-EX25, IDs 428401-428425. Full upsert with names/rarities/images.
- `import-dbs-promo-cards.js`: DBS promo cards P-001 to P-738 from Bandai US-EN (category_exp=428901).
- `import-gundam-cards.js`: Gundam Card Game from gundam-gcg.com API. GD01-GD02, ST01-ST09, beta, promos.
- `import-gd03-cards.js`: GD03 from gundam-gcg.com scraper. Reusable for other sets via CLI arg.

**Clean import pattern** (used by bt19-bt23, bt26-clean, bt29-clean, fb09, fs11-fs12): Fetch fresh data BEFORE deleting. If 0 cards fetched, abort to protect existing data. Delete all rows for that set_code, then upsert. Prevents data loss from fetch failures.

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

- **Scan tab hidden**: Removed from nav (mock data only). HTML/JS still in codebase for future ZXing integration.
- **Collection uses localStorage**: No user accounts, data lost if browser cleared. Supabase auth needed.
- **DBS Fusion World in catalog**: FB01-FB09 (123 cards each), FS01-FS12, SB01. FB09 "Dual Evolution" + FS11/FS12 starter decks imported 2026-03-28.
- **Gold accent theme**: `--ac: #F5A623` (gold), `--bg: #0D0D0D`, `--s1: #141418`, `--s2: #1C1C24`. Grade pills: unselected `#252530`, selected gold. Market price: `3rem`. Confidence dot: green (high), amber (moderate), red (low). `--gn: #22c55e` for trend up arrows (not gold).
- **Parallel card rarity codes** updated with star suffix (C→C*, UC→UC*, R→R*, SR→SR*, L→L*) across FB01-FB08, FS01-FS10, SB01. SCR and PR parallels excluded. Energy marker parallels (E-XX-P1) set to C*.
- **BT01-BT18 now fully named** from Bandai US-EN (2,565 placeholders filled + 831 new SPR variants). Some Deckplanet images show wrong art — Bandai images preferred. Manual corrections: BT16-035 Videl, BT16-036 Beerus, BT23-139 Super Shenron SCR.
- **BT19-BT23 clean re-import** (2026-03-28): 954 cards from Bandai US-EN, replaced old Asia data. Null images resolved.
- **BT26 clean re-import**: Card numbers were shifted, now correct. `_SPR/_SCR/_GDR` suffix bug fixed in import script. SS Son Gohan Youth Defying Terror = BT26-101 SPR/SR.
- **BT29 clean re-import**: Card number corruption fixed, 177 clean cards.
- **BT30 verified clean**: 179 cards correct.
- **DBS Promo cards imported**: P-001 through P-738 (~1,039 cards) from Bandai US-EN.
- **`_SPR/_SCR/_GDR` suffix bug**: Import scripts now strip rarity suffixes from card numbers (e.g., BT26-013_SPR → BT26-013 with rarity=SPR). 200+ bad rows deleted across all sets.
- **Beast Gohan**: BT22-009 "Son Gohan, Beast Roar" SR — not BT21-015. Pricing works correctly.
- **Dual name cards** (`//` format): DBS promo cards like "Vegeta // SSG Vegeta, Crimson Warrior" strip first half before eBay query. P-360 inserted with `variant = 'Gold Stamped'`.
- **Gundam Card Game**: ~800 cards imported (GD01, GD02, GD03, ST01-ST09, beta, promos). Wired into pricing engine and frontend with blue badge (#47c8ff). GD03 import uses gundam-gcg.com scraper.
- **Pokemon catalog**: all `_hires.png` URLs replaced with `.png` (direct URLs work, proxy was timing out).
- **eBay Browse API limits**: 5,000 calls/day (resets midnight UTC). Each search = 3 calls (TCG) or 4 (sports). populate-prices uses ~3 calls per card.
- **eBay Marketplace Insights API**: Not available — scope `buy.marketplace.insights` not enabled on app. Would provide real sold data for parallel cards. Requires eBay developer approval.
- **Parallel sold data gap**: eBay Browse API returns active listings (not sold) for SB01 parallels despite `soldItems:true`. Active BIN prices used as fallback with disclaimer.
- **Comp date tiering**: `extractComps()` and parallel pricing path filter comps to 30d first, expanding to 60d then 90d if <2 results. Uses `itemCreationDate` for active listings (no `itemEndDate`). Prevents stale comps from skewing market price.
- **Filters moved to result page**: Grade/condition/language pills render dynamically inside the result view (between search bar and result card), not in the search pane. State tracked in `G`, `C`, `L` globals; pills re-rendered with correct highlights on each search.
- **One Piece image proxy**: Images still show SAMPLE watermark from some sources despite proxy.
- In `normalizeApiResponse()`, `ct` and `jx` are referenced before assignment — works via closure.
- **P-suffix stripped from display**: Card names like "Pan : GT (-P2)" display as "Pan : GT" everywhere (result title, browse, autocomplete). P-number visible in card number subtitle (e.g., "PROMOTION · FB03-124-P2").

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
