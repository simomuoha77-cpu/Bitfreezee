# JuanAi Backend

Real HTTP API + fully automatic background analysis engine. No demo data,
no manual clicking, no `localStorage`-only mode, no invented odds.

## What this does

- **Real fixtures.** Pulls actual matches from football-data.org
  server-side (`footballData.js`) — free, effectively unlimited on the free
  tier. No CORS issue here since this runs on a server, not a browser. If
  the fetch fails, it logs an error; it never substitutes fake fixtures.
- **Real odds.** football-data.org's free tier has no odds field at all, so
  `oddsData.js` fetches REAL bookmaker odds separately from API-Football
  (api-football.com / api-sports.io), which does include a real `/odds`
  endpoint on its free tier (~100 req/day). Odds are cached per match and
  only refreshed every 8 hours, so a normal day of fixtures stays well
  under the free-tier request budget.
- **AI analyzes real odds — it does not invent them.** `ai.js` takes the
  real bookmaker odds for a match and writes professional analyst
  commentary on top of them (prediction, confidence, value-bet callout,
  short reasoning). If no real odds are posted yet for a match (common
  for fixtures far from kickoff), the AI is not called at all — the match
  is marked "odds not yet posted", never backfilled with guessed numbers.
- **Automatic background pipeline**, `scheduler.js` runs three loops from
  the moment the server starts:
  1. Refresh fixtures for today + tomorrow every 15 minutes.
  2. Refresh real odds every 8 hours (free-tier friendly pacing).
  3. Run AI analysis on any match that has real odds but no analysis yet,
     or whose analysis is older than 8 hours.
- **Every field is labeled accurately** in the API response (`disclaimer`
  field) and in the UI: `realOdds` are real bookmaker prices (with the
  bookmaker named), `aiOdds`/`aiPrediction`/`aiAnalysis` are AI commentary
  layered on top of those real prices — never invented numbers.
- **Real API keys**, checked server-side, so external servers like BetaKE
  can actually call in over HTTP.

## Two football data providers, two different jobs

| Provider | Used for | Free tier | Key |
|---|---|---|---|
| football-data.org | Real fixtures (teams, dates, competitions) | Effectively unlimited (10 req/min) | `FDORG_KEY` |
| API-Football (api-football.com / api-sports.io) | Real bookmaker odds | ~100 req/day | `APIFOOTBALL_KEY` |

These are separate companies with separate signups — don't confuse the two
keys. football-data.org never had odds on its free tier; that's exactly
why API-Football was added.

## Setup (Termux)

```bash
cd juanai-final
cp .env.example .env
# edit .env:
#   FDORG_KEY        pre-filled, replace with your own if you have one
#   APIFOOTBALL_KEY  REQUIRED for real odds — sign up at
#                    https://dashboard.api-football.com/ and paste your key
#   GEMINI_KEY / GROQ_KEY  at least one required, for AI analysis commentary
npm install
node server.js
```

You'll see background job logs like:
```
[scheduler] Starting background auto-refresh + real-odds + auto-analysis (no manual clicks needed)
[scheduler] Refreshed 8 real fixtures for days=0 (2026-07-05)
[scheduler] Real odds fetched for match 12345 (Arsenal vs Chelsea) from Bet365
[scheduler] Analyzed match 12345 (Arsenal vs Chelsea) for days=0 using real odds from Bet365
```

If `APIFOOTBALL_KEY` is missing, fixtures will still load but odds/analysis
never will — the server won't fake odds just because the key is absent.

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

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/fixtures?key=...&days=0` | API key | What BetaKE calls |
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
- `ODDS_REFRESH_INTERVAL_MS` — how often to refresh real bookmaker odds (default 8h — keep this generous, API-Football's free tier is ~100 req/day)
- `ANALYSIS_LOOP_INTERVAL_MS` — how often to check for matches needing analysis (default 90s)
- `ANALYSIS_MAX_AGE_MS` — re-run AI analysis if older than this (default 8h)
- `DAY_BUCKETS` — which day offsets to track (default: today + tomorrow)

**Free-tier math:** with `DAY_BUCKETS = [0, 1]` and `ODDS_REFRESH_INTERVAL_MS`
at 8h, each match needs roughly 1 fixture-lookup + 1 odds-lookup call to
API-Football every 8 hours (3x/day). For ~10-15 matches/day across both
buckets that's well under the ~100/day free-tier ceiling. If you add more
day buckets or lower the refresh interval, do the math against your plan's
daily limit before deploying.

## Deploying to Render

1. Push this folder to its own GitHub repo.
2. New Render Web Service, point at that repo.
3. Set environment variables in Render's dashboard (Settings, Environment):
   `GEMINI_KEY`, `GROQ_KEY`, `FDORG_KEY`, `APIFOOTBALL_KEY` — do NOT commit
   `.env` to GitHub.
4. Render builds with `npm install`, starts with `npm start` automatically.
5. In `public/index.html`, update `JUANAI_BACKEND_URL` near the top of the
   `<script>` block to your Render URL (e.g. `https://juanai.onrender.com`),
   commit, push — Render redeploys automatically.
6. Give BetaKE that same Render URL plus an API key generated from the panel.

**Free-tier note:** Render's free web services spin down when idle and take
~30-60s to wake on the next request. If BetaKE calls JuanAi's API while it's
asleep, that first call will be slow. Consider a periodic health-check ping
(e.g. a free uptime monitor hitting `/api/health` every 10 min) to keep it
warm, or add a timeout and retry on BetaKE's side.
