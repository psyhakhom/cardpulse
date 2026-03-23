# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development & Deployment

There is no build step. The app deploys directly to Vercel:

- **Frontend**: `public/index.html` is served for all non-API routes
- **Backend**: `api/prices.js` handles `/api/prices` requests as a Vercel serverless function
- **Deploy**: `vercel --prod` (or push to linked git repo)

To develop locally with the real API, use `vercel dev`. For offline/mock work, set `USE_REAL_API = false` in `public/index.html` (line ~371) — this routes searches through the local `price()` mock function instead of calling the backend.

## Architecture

### Frontend (`public/index.html`)
A single-file vanilla JS SPA. No framework, no bundler — all HTML, CSS, and JS are inline.

**Four tabs**: Search, Scan, Collection, History. State managed in global variables; persistence via `localStorage` (`cph` = history, `cpc` = collection).

Key functions:
- `search()` — calls real API or mock depending on `USE_REAL_API`
- `normalizeApiResponse()` — adapter that transforms the API response shape into the internal format `renderResult()` expects. **Change this function (not `renderResult`) when the API shape changes.**
- `price()` — mock pricing engine used when `USE_REAL_API = false`; also used for collection scan and manual-add flows (always uses mock)
- `renderResult()` — builds and injects the result card HTML
- `renderColl()` — renders the collection tab, grouped by TCG type via `TCG_GROUPS` / `getGroup()`

Card type detection (`cardType()`) classifies cards as `sr` (sports raw), `sg` (sports graded), `tcg`, or `dbs` (Dragon Ball). This drives which source config (`SC`) and display group are used.

### Backend (`api/prices.js`)
Vercel serverless function. Fetches from the **eBay Browse API** using three parallel queries (all-sold, recent-sold, grade-exact) with weighted blending:

| Query | Label | Weight |
|-------|-------|--------|
| A | All sold (90d) | 0.25 |
| B | Recent sold (30d) | 0.45 |
| C | Grade-exact | 0.30 |

Prices are trimmed (10% each end) before averaging. Trend is computed as `(recentAvg - allAvg) / allAvg`.

After every successful price lookup, a row is logged to Supabase `price_history` **fire-and-forget** (never awaited, never blocks response). If Supabase env vars are absent, logging is silently skipped.

Secondary endpoint: `GET /api/prices?history=1&q=<card>&grade=<grade>` — returns up to 200 price snapshots from the last 90 days (requires Supabase to be configured).

## Environment Variables

Set these in Vercel dashboard → Settings → Environment Variables:

| Variable | Purpose |
|----------|---------|
| `EBAY_CLIENT_ID` | eBay App ID |
| `EBAY_CLIENT_SECRET` | eBay Cert ID |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | service_role key (not anon key) |

## Supabase Setup

Run once in Supabase SQL editor to create the price history table:

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

## Known Issues

- In `normalizeApiResponse()` (`public/index.html`), `ct` and `jx` are referenced before assignment (lines ~417-418). The inner `cardType()` call assigns to a local `ct` via the closure but the outer `const jx = ct === 'dbs' && jpEx(q)` on the same line reads `ct` from the outer scope before it's defined — this is a bug in the existing code.

---

# CardPulse — Claude Code Handoff Document
Paste this at the start of every Claude Code session to get up to speed instantly.

---

## What is CardPulse
A mobile-first PWA for card collectors and sellers to look up real-time market prices for trading cards and sports cards. Pricing is powered by the eBay Browse API using a three-query weighted blending strategy. Live at a Vercel URL.

---

## Project location on disk
```
~/cardpulse/
  public/
    index.html     ← entire frontend (HTML + CSS + JS, single file)
  api/
    prices.js      ← Vercel serverless backend (eBay API + Supabase logging)
  vercel.json      ← Vercel routing config
  package.json     ← { "type": "module" }
```

GitHub repo: https://github.com/psyhakhom/cardpulse
Deployed on Vercel — auto-deploys on every git push to master.

---

## Environment variables (set in Vercel dashboard)
```
EBAY_CLIENT_ID        = (see Vercel dashboard)
EBAY_CLIENT_SECRET    = (see Vercel dashboard)
SUPABASE_URL          = (not yet configured)
SUPABASE_SERVICE_KEY  = (not yet configured)
```

---

## How the pricing works
Every search fires three eBay Browse API queries in parallel:

| Query | Description | Weight |
|-------|-------------|--------|
| A — All sold (90d) | Broad query, high volume, `limit=40` | 25% |
| B — Recent sold (30d) | Same query, `limit=10` to get most recent | 45% |
| C — Grade-exact | Appends grade string to query, `limit=30` | 30% |

- Each query adds " card" to the search string to reduce noise
- Outlier removal: strips top and bottom 10% of prices from each query
- Results blended into weighted average Low / Avg / High
- Confidence score = (queries that returned data / 3) × 50% + (comp volume / 20) × 50%
- All three queries run via `Promise.allSettled` so one failure doesn't kill the others
- Every successful result is logged to Supabase `price_history` table (fire-and-forget)

---

## Frontend state (index.html)
- `USE_REAL_API = true` — hitting real eBay API, not mock data
- `G` = selected grade (Raw / PSA 9 / PSA 10 / BGS 9.5)
- `C` = selected condition (Any / NM / EX / VG)
- `L` = selected language (English / Japanese / Korean / Chinese / Other)
- `coll` = collection array, persisted to `localStorage` key `cpc`
- `hist` = search history array, persisted to `localStorage` key `cph`

---

## Card type detection (cardType function in index.html)
Detects card type from search query to determine correct label and routing:
- `dbs` — Dragon Ball Super: detected by keywords including `dragon ball`, `fusion world`, `fb0`-`fb9`, `gogeta`, `goku`, `vegeta`, `frieza`, `gohan`, `piccolo`, `trunks`, `beerus`, `broly`, `cell`, `majin`, `android`, `sdbh`, `pums`
- `tcg` — Pokemon/MTG/etc: detected by `pokemon`, `charizard`, `pikachu`, `mtg`, `yugioh`, `lorcana`, `one piece` etc
- `sg` — Graded sports: grade !== Raw and not DBS/TCG
- `sr` — Raw sports: everything else

---

## Collection tab — grouped by TCG type
Cards in the collection are automatically grouped into:
- Pokémon, Dragon Ball, Gundam, Magic: The Gathering, Yu-Gi-Oh!, One Piece, Lorcana, Sports Cards
- Each group shows: total value, gain/loss vs paid, top 3 cards by value with images
- "See all N cards" expands the full list inline

---

## APIs and services
- **eBay Browse API** — legitimate approved access, Production keys active, exemption granted for marketplace deletion notifications
- **TCGPlayer** — denied API access, affiliate program application in progress via Impact (app.impact.com)
- **PriceCharting** — email sent to support@pricecharting.com requesting API key, pending response
- **Supabase** — not yet set up, needed for: price history logging, user auth, persistent collections

---

## Known issues to fix
1. **Recent sold (30d) query returns "no data"** — query B and A are identical so eBay returns same pool. Need a better strategy to isolate recent sales.
2. **Card type label shows "Sports Raw" for DBS cards** — `normalizeApiResponse` was calling `cardType` correctly but latest push should fix this. Verify after next deploy.
3. **Scan tab uses mock data** — `runScanLoop()` in index.html uses hardcoded mock cards. Needs ZXing barcode scanning library to make it real.
4. **Collection uses localStorage** — no user accounts, data lost if browser cleared. Supabase auth needed.
5. **Trend arrows show 0%** — `trend30` calculation needs improvement, currently comparing two identical queries.

---

## Immediate next tasks in priority order
1. Verify card type fix is working (search "Gogeta BR FB09-121" — should show "Dragon Ball TCG" not "Sports Raw")
2. Fix Recent sold (30d) query to return actual recent data
3. Set up Supabase — create project, run price_history table SQL, add env vars to Vercel
4. Add ZXing barcode scanning to replace mock scan loop
5. Set up Supabase auth for persistent user collections
6. Add PWA manifest.json and service worker for home screen install
7. Launch on Reddit (r/pkmntcg, r/footballcards, r/dragonballsuper)

---

## How to deploy changes
```bash
cd ~/cardpulse
git add .
git commit -m "your message"
git push
```
Vercel auto-deploys in ~30 seconds after every push.

---

## Monetization plan (not yet built)
- Free tier: unlimited searches, basic prices, 5 comps, 25-card collection
- Pro tier $6/month: full comps with links, 30/90 day price history charts, unlimited collection, price alerts, CSV export
- TCGPlayer affiliate links: every comp that exists on TCGPlayer gets affiliate tag (via Impact program, pending approval)
- eBay Partner Network: affiliate links on eBay comp rows (apply at partner.ebay.com)

---

## Launch plan summary
1. Get prices accurate (validate 30 cards manually vs eBay)
2. Set up Supabase for persistence
3. Post on r/pkmntcg, r/footballcards, r/dragonballsuper with real screenshots
4. Reach out to 10 mid-tier YouTube creators (5k-100k subs) in card space
5. Post in Whatnot seller Facebook groups and Discord servers
6. Add Pro paywall once 200+ daily active users
