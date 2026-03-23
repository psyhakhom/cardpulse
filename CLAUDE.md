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
