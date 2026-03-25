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
- `cardType()` — classifies as `sr` (sports raw), `sg` (sports graded), `tcg`, or `dbs`
- `acOnInput()` / `fetchAc()` / `renderAc()` / `selectAc()` — autocomplete with 350ms debounce, AbortController, LRU cache (20 entries). First-word name matching filters false positives.
- `pick()` — grade pill click handler. Swaps/adds/removes grade term in search input. `_manualGrade` flag prevents auto-detection from overriding manual clicks.

`selectedCard` — set when user clicks autocomplete result. Passes `exact=1` to bypass preprocessor.

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
2. Graded slab hard block (Raw only) — `isGradedSlab()` detects PSA/BGS/CGC/SGC/CSG/CCG etc
3. Lot/multi-card exclusion (all grades) — lots, bundles, "pick your card", "father & son"
4. Variant exclusion — alt art, foil, parallel, token, promo, memorabilia, accessories. **Sports card queries skip TCG-specific variants** (foil/holo/chrome/refractor) but keep memorabilia/sealed/fan art (`_sports: true` tag).
5. Holo exclusion (non-Pokemon, non-sports only)
6. Set code enforcement (TCG only) — BT/FB/SV/SM/XY/OP/ST codes required in comp titles
7. Card name enforcement — non-modifier, non-set-code query words must appear in comp titles
8. Language exclusion (always enforced, no fallback) — Japanese/JP/Korean/Chinese/Cross Worlds/DBS Master
9. Cheap junk filter ($<3 with code/bulk/lot keywords)
10. Grade-specific filtering — Raw excludes graded terms; graded searches never fall back to ungraded

**Fallback safety**: Variant fallback restores from pre-variant snapshot (not original items). Raw grade fallback restores from post-identity-filter snapshot. Name/lang/set drops are never reversed.

**Hard block** on final `deduped` array — card name enforcement as absolute last safety net before response.

**Rarity enforcement** (`filterByRarity`): SCR vs SCR*/SCR Alt vs SCR**/Two Star correctly separated. Case-insensitive detection. Runs even for `exact=1` autocomplete queries.

**Sports card detection**: `/\b(rookie|rc|topps|bowman|panini|...)\b/i` AND no TCG keywords → lighter filter set (skips set codes, holo, variant filters).

**Outlier removal** in `calcStats()`:
- 2 comps with >10x spread → keep lower only
- Any comp >50x median → always removed
- Small sets (≤5): 40%-200% of median bounds
- Large sets: 20%-300% of median bounds

**Variant/accessory exclusions** (VARIANT_TERMS): alt art, foil, chrome, refractor, memorabilia (relic/jersey/patch/swatch/game-used), event exclusives (national convention), ultra-premium parallels (rapture/shimmer/lime/lava/disco/vortex/pulsar/cosmic/nebula/cracked ice/tiger stripe), One Piece parallels (wanted poster/manga art/SPC), anniversary sets, accessories (figure/plush/sleeve/magnetic/lighter), fan art/proxy/custom cards.

**Word-strip retry**: Strips one modifier word when comps insufficient. Sports queries only strip at 0 comps (not <3). Card names and set codes protected. Max 1 successful retry.

### Autocomplete (`api/cards.js`)

**Priority**: Supabase card_catalog (141,000+ cards) → external APIs → eBay fallback.

**Fuzzy search** via `fuzzy_search_cards()` Supabase RPC (pg_trgm `word_similarity`, threshold 0.25):
- Card number queries → exact PostgREST match (unchanged)
- Name queries → RPC with game keyword stripping + alias correction
- Re-ranking: when query has both name + card number, results matching name terms rank higher

**Alias map** for common misspellings: vegita→vegeta, freiza→frieza, picolo→piccolo, charizrd→charizard, etc.

**One Piece images** routed through `/api/image-proxy` to avoid SAMPLE watermark.

**eBay fallback** filters: Japanese/Cross Worlds listings excluded.

### Image Proxy (`api/image-proxy.js`)

Proxies images from allowed domains (optcgapi.com, en.onepiece-cardgame.com, www.dbs-cardgame.com). Returns 403 for other domains. 24h cache, CORS enabled.

## Supabase (Live)

**Project URL**: `https://jvynhfqcefztfcgznwhe.supabase.co`

### Tables

**`price_history`** — price snapshots from every successful search. Indexed on (card_name, queried_at desc).

**`card_catalog`** — 141,315 cards across 7 games. Unique index: `(game, card_number_key, rarity_key)`. GIN trigram index: `card_catalog_name_trgm_idx` on `card_name`.

### RPC Functions

**`fuzzy_search_cards(q, game_filter, result_limit)`** — pg_trgm word_similarity search with ILIKE fallback. Threshold 0.25. Parameter named `q` (not `search_query` — column name conflict).

### Card Catalog Stats

| Game | Cards | Source |
|------|-------|--------|
| DBS Fusion World | ~1,845 | apitcg.com |
| DBS Classic (BT) | ~2,622 | Deckplanet GCS |
| Pokemon | ~20,148 | pokemontcg.io |
| MTG | ~36,924 | Scryfall bulk |
| Yu-Gi-Oh | ~14,265 | YGOProDeck |
| One Piece | ~1,700 | optcgapi.com |
| Lorcana | ~2,283 | lorcana-api.com |
| **Total** | **~141,315** | |

### Import Scripts

All in `scripts/`, run locally with `.env.local` (SUPABASE_URL + SUPABASE_SERVICE_KEY required):

```bash
npm run import-dbs           # DBS Fusion World (needs APITCG_KEY)
npm run import-dbs-classic   # DBS Classic BT sets
npm run import-pokemon       # Pokemon (~20k cards, retry logic, 1.5s delay for free tier)
npm run import-mtg           # MTG from Scryfall bulk (~80MB download)
npm run import-yugioh        # Yu-Gi-Oh from YGOProDeck
npm run import-onepiece      # One Piece from optcgapi.com
npm run import-lorcana       # Lorcana from lorcana-api.com
npm run import-all           # Run all imports sequentially
```

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
- **DBS FB07+ not in catalog**: apitcg.com hasn't added FB07+ yet. Cards work via eBay fallback.
- **eBay rate limiting**: Heavy usage can trigger 429 errors. Resets after 15-60 minutes.
- **One Piece image proxy**: Images still show SAMPLE watermark from some sources despite proxy.
- In `normalizeApiResponse()`, `ct` and `jx` are referenced before assignment — works via closure.

## Project Info

**GitHub**: https://github.com/psyhakhom/cardpulse
**Deployed**: Vercel — auto-deploys on git push to master.

## Next Tasks

1. Add ZXing barcode scanning to replace mock scan loop
2. Set up Supabase auth for persistent user collections
3. Add PWA manifest.json and service worker for home screen install
4. Validate pricing accuracy (test 30 cards manually vs eBay sold prices)
5. Launch on Reddit (r/pkmntcg, r/footballcards, r/dragonballsuper)
