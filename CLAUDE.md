# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development & Deployment

There is no build step. The app deploys directly to Vercel:

- **Frontend**: `public/index.html` is served for all non-API routes
- **Backend**: `api/prices.js` handles `/api/prices` requests as a Vercel serverless function
- **Autocomplete**: `api/cards.js` handles `/api/cards` requests — card catalog lookup from Supabase + external API fallback
- **Import scripts**: `scripts/import-*.js` — bulk import card data into Supabase (local only, not deployed)
- **Deploy**: `vercel --prod` (or push to linked git repo)

To develop locally with the real API, use `vercel dev`. For offline/mock work, set `USE_REAL_API = false` in `public/index.html` (line ~371) — this routes searches through the local `price()` mock function instead of calling the backend.

## Architecture

### Frontend (`public/index.html`)
A single-file vanilla JS SPA. No framework, no bundler — all HTML, CSS, and JS are inline.

**Four tabs**: Search, Scan, Collection, History. State managed in global variables; persistence via `localStorage` (`cph` = history, `cpc` = collection).

Key functions:
- `search()` — calls real API or mock depending on `USE_REAL_API`. When `selectedCard` is set (from autocomplete), passes `exact=1` to bypass the query preprocessor. Strips colons and converts `-p` suffixes to "parallel" for eBay queries.
- `normalizeApiResponse()` — adapter that transforms the API response shape into the internal format `renderResult()` expects. **Change this function (not `renderResult`) when the API shape changes.**
- `price()` — mock pricing engine used when `USE_REAL_API = false`; also used for collection scan and manual-add flows (always uses mock)
- `renderResult()` — builds and injects the result card HTML
- `renderColl()` — renders the collection tab, grouped by TCG type via `TCG_GROUPS` / `getGroup()`
- `acOnInput()` / `fetchAc()` / `renderAc()` / `selectAc()` — autocomplete system with 350ms debounce, AbortController for stale requests, client-side LRU cache (20 entries)

`selectedCard` — global variable set when user clicks an autocomplete result. Stores card metadata (name, number, rarity, game, imageUrl, searchQuery). Used to bypass preprocessor and supply the hero image.

Card type detection (`cardType()`) classifies cards as `sr` (sports raw), `sg` (sports graded), `tcg`, or `dbs` (Dragon Ball). Also detects Yu-Gi-Oh, One Piece, and Lorcana keywords. This drives which source config (`SC`) and display group are used.

### Backend (`api/prices.js`)
Vercel serverless function. Fetches from the **eBay Browse API** using four parallel queries with weighted blending:

| Query | Label | Weight (with D) | Weight (without D) |
|-------|-------|-----------------|-------------------|
| A | All sold (90d) | 0.20 | 0.25 |
| B | Recent sold (30d) | 0.35 | 0.45 |
| C | Grade-exact | 0.25 | 0.30 |
| D | Live auctions (48h) | 0.20 | — |

Query D searches live eBay auctions ending within 48 hours, filtered to listings with 1+ bids. Weights dynamically rebalance when D has no data.

**Query preprocessing**: `preprocessQuery()` normalizes, spell-corrects (with safelist of common English words), and trims queries. Supports `exact=1` parameter to bypass preprocessing (used when autocomplete selects a specific card). Rarity aliases normalized via `normalizeRarity()` (e.g., "sr alt" → "SR*").

**Grade filtering**: `filterItems()` multi-layer filtering:
1. `isGradedSlab()` — triple safety net (pre-filter, filterItems, extractComps) for Raw grade
2. Variant exclusion — alt art, foil, parallel, token, promo excluded unless in query
3. Language filtering — excludes wrong-language listings
4. Cheap junk filter — items under $3 with code/bulk/lot keywords
5. DBS set code enforcement — wrong set numbers excluded
6. Rarity tier enforcement — SR vs SR* vs SCR** treated as separate products

**Supabase writes (fire-and-forget)**:
- `logPriceHistory()` — writes to `price_history` table, deduplicated within 60 seconds
- `logCardCatalog()` — upserts to `card_catalog` table, only saves official images (never eBay URLs)

### Autocomplete (`api/cards.js`)
**Priority order**: Supabase card_catalog (73,000+ cards) → external APIs → eBay fallback.

`searchCatalog()` queries card_catalog FIRST before any external API:
- Card number in query (FB05-054, OP01-003) → exact `card_number` match, threshold 1
- Name-only query → word-split ILIKE pattern (handles colons: "Son Gohan : Future"), threshold 5 for catalog-only, 1-4 merges with external APIs
- Deduplication: import rows prioritized over search-log rows, parallel variants kept separate

**External API fallback** (when catalog has insufficient results):

| Game | Source | Auth |
|------|--------|------|
| Pokemon | pokemontcg.io | Optional `POKEMON_TCG_API_KEY` |
| MTG | Scryfall | None |
| Yu-Gi-Oh | YGOProDeck | None |
| One Piece | optcgapi.com (live API) | None |
| DBS | dbs-cardgame.com site scraping + hardcoded dictionary | None |
| Lorcana | lorcana-api.com | None |

Game detection via keyword matching in `detectGame()`. When no game detected, searches Pokemon, MTG, Yu-Gi-Oh, and Lorcana in parallel. General eBay fallback for 2+ word queries when all databases return nothing.

## Supabase (Live)

**Project URL**: `https://jvynhfqcefztfcgznwhe.supabase.co`
**Status**: Fully configured and live. Env vars set in Vercel dashboard.

### Tables

**`price_history`** — price snapshots from every successful search:
```sql
create table price_history (
  id          bigserial primary key,
  queried_at  timestamptz not null default now(),
  card_name   text        not null,
  grade       text        not null default 'Raw',
  lang        text        not null default 'English',
  price_lo    numeric(10,2),
  price_avg   numeric(10,2) not null,
  price_hi    numeric(10,2),
  confidence  smallint,
  comp_count  smallint,
  trend_30d   numeric(6,2),
  source      text not null default 'ebay'
);
create index on price_history (card_name, queried_at desc);
create index on price_history (queried_at desc);
```

**`card_catalog`** — 73,252 cards across 7 games (self-growing from searches + bulk imports):
```sql
create table card_catalog (
  id              bigserial primary key,
  card_name       text        not null,
  card_number     text,
  card_number_key text        generated always as (coalesce(card_number, card_name)) stored,
  game            text        not null default 'unknown',
  set_code        text,
  rarity          text,
  rarity_key      text        generated always as (coalesce(rarity, '')) stored,
  image_url       text,
  search_query    text,
  times_searched  int         not null default 0,
  last_searched   timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  source          text
);
create unique index card_catalog_game_cardnum_rarity_idx
  on card_catalog (game, card_number_key, rarity_key);
create index on card_catalog (game, lower(card_name));
create index on card_catalog (last_searched desc);
```

### Card Catalog Stats

| Game | Cards | Source | Images |
|------|-------|--------|--------|
| DBS Fusion World | ~1,845 | apitcg.com (requires APITCG_KEY) | dbs-cardgame.com/fw |
| DBS Classic (BT) | ~2,622 | Deckplanet GCS HEAD checks | storage.googleapis.com/deckplanet_card_images |
| Pokemon | ~13,613 | pokemontcg.io (paginated, 250/page) | pokemontcg.io |
| MTG | ~36,924 | Scryfall bulk-data oracle_cards | Scryfall CDN |
| Yu-Gi-Oh | ~14,265 | YGOProDeck (single request, all cards) | YGOProDeck CDN |
| One Piece | ~1,700 | optcgapi.com (per-set endpoint) | optcgapi.com |
| Lorcana | ~2,283 | lorcana-api.com (paginated) | lorcana-api.com |
| **Total** | **~73,252** | | |

**Note**: One Piece images use optcgapi.com URLs. Bandai hotlink-blocks their official card image URLs.

### Import Scripts

All in `scripts/` folder, run locally with `.env.local`:

```bash
npm run import-dbs           # DBS Fusion World from apitcg.com (needs APITCG_KEY)
npm run import-dbs-classic   # DBS Classic BT sets from Deckplanet GCS
npm run import-pokemon       # Pokemon from pokemontcg.io (~3 min, free tier)
npm run import-mtg           # MTG from Scryfall bulk (~2 min, 80MB download)
npm run import-yugioh        # Yu-Gi-Oh from YGOProDeck (~30s)
npm run import-onepiece      # One Piece from optcgapi.com (~15s)
npm run import-lorcana       # Lorcana from lorcana-api.com (~10s)
npm run import-all           # Run all imports sequentially
```

`.env.local` required variables:
```
SUPABASE_URL=https://jvynhfqcefztfcgznwhe.supabase.co
SUPABASE_SERVICE_KEY=<service_role key>
EBAY_CLIENT_ID=<for DBS classic import>
EBAY_CLIENT_SECRET=<for DBS classic import>
APITCG_KEY=<for DBS Fusion World import>
```

## Environment Variables

Set these in Vercel dashboard → Settings → Environment Variables:

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
- **eBay rate limiting**: Heavy usage or bulk testing can trigger 429 errors. Resets after 15-60 minutes.
- In `normalizeApiResponse()` (`public/index.html`), `ct` and `jx` are referenced before assignment — works by accident via closure.

---

# CardPulse — Claude Code Handoff Document

## What is CardPulse
A mobile-first PWA for card collectors and sellers to look up real-time market prices for trading cards and sports cards. Pricing is powered by the eBay Browse API using a four-query weighted blending strategy. Card catalog with 73,000+ cards across 7 games provides instant autocomplete.

## Project location on disk
```
~/cardpulse/
  public/
    index.html     ← entire frontend (HTML + CSS + JS, single file)
  api/
    prices.js      ← Vercel serverless backend (eBay API + Supabase logging)
    cards.js       ← Card catalog autocomplete (Supabase + external API fallback)
  scripts/
    import-dbs-cards.js     ← DBS Fusion World import (apitcg.com)
    import-dbs-classic.js   ← DBS Classic BT import (Deckplanet GCS)
    import-pokemon.js       ← Pokemon import (pokemontcg.io)
    import-mtg.js           ← MTG import (Scryfall bulk)
    import-yugioh.js        ← Yu-Gi-Oh import (YGOProDeck)
    import-onepiece.js      ← One Piece import (optcgapi.com)
    import-lorcana.js       ← Lorcana import (lorcana-api.com)
    import-all.js           ← Run all imports
  vercel.json      ← Vercel routing config
  package.json     ← { "type": "module" }
  .env.local       ← Local env vars (gitignored)
  .gitignore
```

GitHub repo: https://github.com/psyhakhom/cardpulse
Deployed on Vercel — auto-deploys on every git push to master.

## APIs and services
- **eBay Browse API** — legitimate approved access, Production keys active
- **Supabase** — fully configured. `price_history` + `card_catalog` tables live. 73,252 cards imported.
- **pokemontcg.io** — Pokemon card database. Optional `POKEMON_TCG_API_KEY` for higher rate limits.
- **Scryfall** — MTG card database. No auth needed.
- **YGOProDeck** — Yu-Gi-Oh card database. No auth needed.
- **optcgapi.com** — One Piece card database. No auth needed.
- **apitcg.com** — DBS Fusion World card database. Requires `APITCG_KEY` (free registration).
- **lorcana-api.com** — Disney Lorcana card database. No auth needed.
- **Deckplanet GCS** — DBS Classic card images. Public Google Cloud Storage bucket.

## Immediate next tasks in priority order
1. Add ZXing barcode scanning to replace mock scan loop
2. Set up Supabase auth for persistent user collections
3. Add PWA manifest.json and service worker for home screen install
4. Validate pricing accuracy (test 30 cards manually vs eBay sold prices)
5. Launch on Reddit (r/pkmntcg, r/footballcards, r/dragonballsuper)

## How to deploy changes
```bash
cd ~/cardpulse
git add .
git commit -m "your message"
git push
```
Vercel auto-deploys in ~30 seconds after every push.

## Monetization plan (not yet built)
- Free tier: unlimited searches, basic prices, 5 comps, 25-card collection
- Pro tier $6/month: full comps with links, 30/90 day price history charts, unlimited collection, price alerts, CSV export
- TCGPlayer affiliate links: every comp that exists on TCGPlayer gets affiliate tag (via Impact program, pending approval)
- eBay Partner Network: affiliate links on eBay comp rows (apply at partner.ebay.com)

## Launch plan summary
1. Get prices accurate (validate 30 cards manually vs eBay)
2. Post on r/pkmntcg, r/footballcards, r/dragonballsuper with real screenshots
3. Reach out to 10 mid-tier YouTube creators (5k-100k subs) in card space
4. Post in Whatnot seller Facebook groups and Discord servers
5. Add Pro paywall once 200+ daily active users
