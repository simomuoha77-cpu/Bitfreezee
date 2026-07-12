# JuanAi Backend

Real HTTP API + fully automatic background analysis engine. No demo data,
no manual clicking, no `localStorage`-only mode.

## What this does

- **Real fixtures only.** Pulls actual matches from football-data.org
  server-side (`footballData.js`). No CORS issue here — that only affects
  browsers, not servers. If the fetch fails, it logs an error; it never
  substitutes fake fixtures.
- **Automatic AI analysis, no clicks.** `scheduler.js` runs in the
  background from the moment the server starts:
  - Refreshes fixtures for today + tomorrow every 15 minutes.
  - Analyzes any match missing odds, and re-analyzes odds older than 3
    hours, automatically — nothing needs a button press.
  - Paced to stay under football-data.org's free-tier limit (10 req/min)
    and to avoid hammering the AI providers.
- **Every AI-generated odd is labeled as such**, in the API response
  (`disclaimer` field) and in the UI (explicit "AI-Generated Estimate —
  Not Real Market Odds" badge). These are AI predictions, never real
  bookmaker prices — don't present them otherwise to end users.
- **Real API keys**, checked server-side, so external servers like BetaKE
  can actually call in over HTTP.

## Setup (Termux)

```bash
cd juanai-final
cp .env.example .env
# edit .env: set GEMINI_KEY and/or GROQ_KEY (at least one required),
# FDORG_KEY is pre-filled but replace with your own if you have one
npm install
node server.js
```

You'll see background job logs like:
```
[scheduler] Starting background auto-refresh + auto-analysis (no manual clicks needed)
[scheduler] Refreshed 8 real fixtures for days=0 (2026-07-05)
[scheduler] Analyzed match 12345 (Arsenal vs Chelsea) for days=0
```

Open `http://localhost:3000` to view JuanAi — fixtures and odds will
populate automatically within the first ~30 seconds to a couple minutes,
depending on how many matches are scheduled.

## Generate an API key for BetaKE

In JuanAi's API Keys panel: name it, click Generate. Copy the `jsk_...` key.

## Call it from BetaKE

```js
const JUANAI_URL = 'http://localhost:3000'; // or your deployed Render URL
const API_KEY = 'jsk_xxxxxxxxxxxxxxxx';

async function getJuanAiFixtures(days = 0) {
  const resp = await fetch(`${JUANAI_URL}/api/fixtures?key=${API_KEY}&days=${days}`);
  if (!resp.ok) throw new Error('JuanAi API error: ' + resp.status);
  const data = await resp.json();
  return data.matches || [];
}
```

Real HTTP call — works from anywhere, no shared browser or localStorage
needed.

## ⚠️ Real-money safety — read this before accepting real stakes

Not every match's odds come from a real bookmaker. JuanAi tries real market
odds first (SharpAPI, then odds-api.io), and only falls back to an
AI-generated *estimate* when neither provider has priced that match — which
is common for smaller leagues (lower divisions, youth/reserve teams,
regional cups) that major sportsbooks simply don't cover on their free
tiers.

**An AI-generated odds estimate is a probability guess, not a real market
price.** There's no real liquidity, no real bookmaker risk management, and
no guarantee of accuracy behind it. If BetaKE accepts real-money stakes
against an AI-estimated price, JuanAi's 6% margin only protects you if the
AI's underlying probability is roughly correct — for a match no real
bookmaker will price, that can't be verified.

**Before accepting a real-money bet on any match, check:**
```js
if (match.aiOdds && match.aiOdds.isRealMarketOdds === true) {
  // Safe — a real bookmaker (SharpAPI/odds-api.io) actually priced this match
} else {
  // AI estimate only — do NOT accept real-money stakes on this match
}
```

Or simpler: pass `?realOddsOnly=1` on the `/api/fixtures` call and JuanAi
will only return matches that are actually safe to bet real money on:

```js
const resp = await fetch(`${JUANAI_URL}/api/fixtures?key=${API_KEY}&days=${days}&realOddsOnly=1`);
```

Every match in that response is guaranteed to have real bookmaker odds
behind it. AI-only matches simply won't appear — nothing further to check
on BetaKE's side.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/fixtures?key=...&days=0` | API key | What BetaKE calls |
| GET | `/api/fixtures?key=...&days=0&realOddsOnly=1` | API key | Same, but ONLY matches with real bookmaker odds — safe for real-money betting |
| GET | `/api/status` | none | Background job visibility (match counts, last update) |
| GET | `/api/health` | none | Uptime check |
| GET | `/internal/fixtures-view?days=0` | none* | JuanAi's own UI reads current state |
| POST | `/internal/analyze-now` | none* | Force re-analysis of one match on demand |
| POST | `/internal/apikeys` | none* | Generate a new API key |
| GET | `/internal/apikeys` | none* | List keys |
| DELETE | `/internal/apikeys/:id` | none* | Revoke a key |

\* `/internal/*` routes are meant for JuanAi's own admin UI only. Before
deploying publicly, put these behind a login check or bind them to
`localhost`, or anyone with your JuanAi URL could generate/revoke keys.

## Data storage

JSON file at `data/fixtures.json` and `data/apikeys.json` — no native
modules, so `npm install` works cleanly on Termux. Fine for one JuanAi
instance; swap for a real database later if you need concurrent writes,
backups, or querying at scale — `db.js` is the only file that would need
to change.

## Tuning the background engine

All in `scheduler.js`:
- `FIXTURE_REFRESH_INTERVAL_MS` — how often to pull fresh fixtures (default 15 min)
- `ANALYSIS_LOOP_INTERVAL_MS` — how often to check for matches needing analysis (default 90s)
- `ANALYSIS_MAX_AGE_MS` — re-analyze odds older than this (default 3h)
- `DAY_BUCKETS` — which day offsets to track (default: today through 7 days out, matching the frontend's dropdown)

## Deploying to Render

1. Push this folder to its own GitHub repo.
2. New Render Web Service, point at that repo.
3. Set environment variables in Render's dashboard (Settings, Environment):
   `GEMINI_KEY`, `GROQ_KEY`, `FDORG_KEY`, `MONGO_URI` — do NOT commit `.env` to GitHub.
4. Render builds with `npm install`, starts with `npm start` automatically.
5. In `public/index.html`, `JUANAI_BACKEND_URL` is already set to
   `window.location.origin`, so it automatically points at whatever domain
   served the page — no manual edit needed before deploying.
6. Give BetaKE that same Render URL plus an API key generated from the panel.

**MONGO_URI is required for API keys to survive restarts.** Render's free
tier has an ephemeral filesystem — any local file (including the old
`data/apikeys.json`) is wiped every time the service restarts, redeploys, or
spins down from inactivity (which free services do automatically). Without
`MONGO_URI` set, API keys still work, but only until the next restart, then
they're gone and you'll need to regenerate them. Set up a free MongoDB Atlas
cluster (M0 tier, $0/mo), whitelist `0.0.0.0/0` under Network Access since
Render doesn't give you a fixed IP on the free tier, and paste the connection
string as `MONGO_URI`. The API Keys panel in the UI shows a warning banner if
this isn't connected.

**Free-tier note:** Render's free web services spin down when idle and take
~30-60s to wake on the next request. If BetaKE calls JuanAi's API while it's
asleep, that first call will be slow. Consider a periodic health-check ping
(e.g. a free uptime monitor hitting `/api/health` every 10 min) to keep it
warm, or add a timeout and retry on BetaKE's side.

## Real-money casino wallet integration (Aviator + SafariBet)

Aviator no longer holds any balance of its own — SafariBet's real balance
is the only source of truth. This works via signed, server-to-server calls
in both directions. See `casinoIntegration.js`, `walletClient.js`, and
`userToken.js` for the full design rationale in comments; short version
below.

**One-time setup, per partner site (e.g. SafariBet):**

1. Set `JUANAI_USER_TOKEN_SECRET` in `.env` — a long random string, shared
   between JuanAi and SafariBet's backend only. Generate one with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. On SafariBet's backend, implement 3 endpoints for JuanAi to call
   (JuanAi calls SafariBet, never the other way around):
   - `POST /api/casino/debit` — body `{userId, amount, roundId}`, return
     `{success: true, newBalance}` or `{success: false, message}` if the
     user doesn't have enough balance.
   - `POST /api/casino/credit` — body `{userId, amount, roundId}`, return
     `{success: true, newBalance}`.
   - `GET /api/casino/balance?userId=X` — return `{success: true, balance}`.
   Every request from JuanAi carries `X-JuanAi-Timestamp` and
   `X-JuanAi-Signature` headers — verify these using the SAME shared
   secret from step 1 before trusting the request (see `walletClient.js`'s
   `sign()` function for the exact algorithm to replicate on SafariBet's
   side: `HMAC_SHA256(secret, method + "\n" + path + "\n" + timestamp +
   "\n" + bodyJson)`, where `path` includes the query string exactly as
   sent, and reject any request more than a minute or two old to prevent
   replay).
3. Register SafariBet's wallet with JuanAi (do this once, or again after
   any restart if you're not yet on MongoDB — see `MONGO_URI` note above):
   ```
   curl -X POST https://your-juanai-url.onrender.com/internal/wallet \
     -H "Content-Type: application/json" \
     -d '{"apiKey":"jsk_xxx","baseUrl":"https://safaribet.com","secret":"THE_SAME_SHARED_SECRET"}'
   ```
4. When a real logged-in user wants to play Aviator, SafariBet's backend
   calls JuanAi's session endpoint to get a signed token for that user —
   SafariBet never needs to implement the signing itself:
   ```
   POST https://your-juanai-url.onrender.com/api/casino/session
   Content-Type: application/json

   { "key": "jsk_xxx", "userId": "USER_ID", "username": "USERNAME" }
   ```
   Response:
   ```json
   { "success": true, "utoken": "VALID_TOKEN", "balance": 500 }
   ```
   (`balance` is the user's current real balance, fetched live from
   SafariBet's own `/api/casino/balance` endpoint in the same call — no
   extra round-trip needed before launching. `username` is accepted but
   not currently used server-side; safe to keep sending it.)

   Then launch the game with the returned token:
   `https://your-juanai-url.onrender.com/casino/aviator.html?key=jsk_xxx&utoken=VALID_TOKEN`

   **This endpoint is server-to-server only** — call it from SafariBet's
   own backend, never from a page a user's browser can see. Anyone who can
   call it can mint a session for any userId they send, which is exactly
   why it requires your private `jsk_xxx` key and must never be exposed
   client-side. Tokens last 6 hours (`userToken.js`'s `MAX_TOKEN_AGE_MS`);
   call this endpoint again anytime to mint a fresh one — it's cheap and
   stateless, so calling it fresh before every launch is fine too.

**Why this direction, and why signed tokens instead of a raw userId:**
see the header comments in `casinoIntegration.js` and `walletClient.js` —
short version: JuanAi confirms a real debit before ever accepting a bet,
confirms a real credit before ever reporting a win, and the browser can
never forge a user's identity because it never has the shared secret used
to sign `utoken`.

**Known limitation:** partner-side (real-money) bets don't currently show
up in the in-game "All Bets" list — that list still only reflects the
free-play engine's own sessions. Cosmetic only, not a balance/security
issue, but worth fixing if that list matters for your product.

