// server.js — JuanAi's real backend.
//
// Runs entirely server-side, in the background:
//   - Pulls real fixtures from football-data.org on a schedule (no CORS
//     issue here since this is a server, not a browser).
//   - Analyzes each fixture with AI (Gemini/Groq) automatically — no
//     button clicks required, see scheduler.js.
//   - Serves the results over a real HTTP API that any external server
//     (e.g. BetaKE) can call.
//
// Run:
//   cp .env.example .env   (then fill in your real keys)
//   npm install
//   node server.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const realOdds = require('./realOdds');
const footballData = require('./footballData');
const scheduler = require('./scheduler');
const casino = require('./casino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Auth middleware: checks the API key against real stored keys ──
async function requireApiKey(req, res, next) {
  const key = req.query.key || req.headers['x-api-key'];
  const valid = await db.isValidApiKey(key);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ── PUBLIC-FACING API (what BetaKE calls) ──────────────────────────

// GET /api/fixtures?key=jsk_xxx&days=0
// Returns REAL fixtures (football-data.org + odds-api.io) + odds — real
// market prices (SharpAPI/odds-api.io) where available, AI estimates as
// fallback — kept fresh automatically in the background.
//
// REAL-MONEY SAFETY: AI-generated odds are a probability ESTIMATE, not a
// real market price with real liquidity behind it. If you're accepting
// real stakes, only do so on matches where match.aiOdds.isRealMarketOdds
// is true — that's the only case where a real bookmaker has actually
// priced the match. Pass ?realOddsOnly=1 to have this endpoint filter to
// ONLY such matches server-side, so you don't have to replicate this check
// in your own code and risk missing a match that should have been excluded.
app.get('/api/fixtures', requireApiKey, async (req, res) => {
  const days = req.query.days || '0';
  // sport defaults to 'football' so every existing caller (BetaKE included)
  // keeps working identically without needing to add this param at all.
  // Pass ?sport=basketball for basketball fixtures instead.
  const sport = req.query.sport === 'basketball' ? 'basketball' : 'football';
  const bucket = await db.getFixtures(days, sport);
  if (!bucket) {
    return res.json({ matches: [], fetchedAt: null, note: 'No fixtures loaded for this day yet — background refresh runs on a schedule, try again shortly' });
  }
  // Exclude finished matches by default — external sites like BetaKE have no
  // way to filter this themselves and shouldn't need to reimplement that
  // logic. A finished match has nothing left to bet on, so it has no
  // business appearing in an "upcoming matches" list. Pass
  // ?includeFinished=1 explicitly if a caller genuinely wants historical
  // results (e.g. for a "recent results" feature).
  const includeFinished = req.query.includeFinished === '1';
  const realOddsOnly = req.query.realOddsOnly === '1';
  const STALE_MATCH_CUTOFF_MS = 3 * 60 * 60 * 1000; // matches with a kickoff older than this are certainly over — same 3h cutoff as db.js's expireOldMatches background job, applied here too as a real-time safety net for the brief window before that job's next run
  const matches = bucket.matches.filter(m => {
    if (!includeFinished && m.status === 'FINISHED') return false;
    // Real-time staleness check — a match whose kickoff was more than 3h
    // ago is certainly over regardless of what status our data shows for
    // it. This catches the exact gap that let matches appear "stuck live"
    // in production: odds-api.io doesn't reliably report when a match
    // ends, so without this, a stale match could keep showing here until
    // the periodic cleanup job (every 5 min) gets to it.
    if (!includeFinished && m.utcDate && (Date.now() - new Date(m.utcDate).getTime()) > STALE_MATCH_CUTOFF_MS) return false;
    // TBD vs TBD matches (knockout rounds not yet decided) have nothing
    // real to bet on and shouldn't be exposed to external sites at all.
    const home = m.homeTeam && m.homeTeam.name;
    const away = m.awayTeam && m.awayTeam.name;
    if (!home || !away || home.toUpperCase() === 'TBD' || away.toUpperCase() === 'TBD') return false;
    // If the caller only wants matches safe for real-money staking, drop
    // anything whose odds are an AI estimate rather than a real bookmaker
    // price. A match with no odds at all (not yet analyzed) is also
    // excluded here, since there's nothing to bet on yet either way.
    //
    // Basketball matches never carry aiOdds at all — they skip AI analysis
    // entirely by design (see basketballData.js) and instead carry a
    // top-level `realOdds` field set directly from odds-api.io. Checking
    // only `m.aiOdds.isRealMarketOdds` here would silently exclude EVERY
    // basketball match under realOddsOnly=1, since that field structurally
    // doesn't exist for them — not because their odds aren't real.
    if (realOddsOnly) {
      const hasRealOdds = sport === 'basketball'
        ? !!m.realOdds
        : !!(m.aiOdds && m.aiOdds.isRealMarketOdds);
      if (!hasRealOdds) return false;
    }
    return true;
  });
  res.json({
    matches,
    sport,
    fetchedAt: bucket.fetchedAt,
    updatedAt: bucket.updatedAt,
    oddsMargin: ai.DEFAULT_MARGIN,
    realOddsOnlyFilterApplied: realOddsOnly,
    disclaimer: sport === 'basketball'
      ? 'Basketball matches only ever carry REAL bookmaker odds (via odds-api.io) or no odds at all (match.realOdds === null) — there is no AI-estimated fallback for this sport. A null match.realOdds means no bookmaker has priced this match yet; do not bet real money against it.'
      : (realOddsOnly
        ? 'realOddsOnly=1 was set: every match returned has aiOdds.isRealMarketOdds === true, meaning a real bookmaker (SharpAPI/odds-api.io) actually priced it — safe to use for real-money staking. A ' + (ai.DEFAULT_MARGIN * 100).toFixed(0) + '% margin is applied on top of the real price. Still manage your own exposure regardless of these numbers.'
        : 'IMPORTANT for real-money betting: check aiOdds.isRealMarketOdds on EVERY match before accepting a stake. true = a real bookmaker priced this match (via SharpAPI/odds-api.io) — safe to bet real money against. false/absent = the odds are an AI-generated ESTIMATE, not a real market price, and should NOT be used to accept real-money stakes — there is no real liquidity or bookmaker risk management behind that number. Pass ?realOddsOnly=1 to have this filtering done for you server-side. A ' + (ai.DEFAULT_MARGIN * 100).toFixed(0) + '% margin is applied either way.')
  });
});

// GET /api/health — simple uptime check, no key required
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// GET /api/status — background job visibility (no key required, no sensitive data)
app.get('/api/status', async (req, res) => {
  await db.ensureMongo();
  const days0 = await db.getFixtures(0);
  const days1 = await db.getFixtures(1);
  const basketballDays0 = await db.getFixtures(0, 'basketball');
  function summarize(bucket) {
    if (!bucket || !Array.isArray(bucket.matches)) return { matches: 0, analyzed: 0, realOdds: 0, updatedAt: null };
    return {
      matches: bucket.matches.length,
      analyzed: bucket.matches.filter(m => m.aiOdds).length,
      realOdds: bucket.matches.filter(m => m.aiOdds && m.aiOdds.isRealMarketOdds).length,
      updatedAt: bucket.updatedAt || null
    };
  }
  // Basketball has no AI-analysis step at all (see basketballData.js) — its
  // "analyzed" concept doesn't apply, so this summary shape is deliberately
  // different (realOdds only) rather than forcing basketball into fields
  // that don't mean anything for it.
  function summarizeBasketball(bucket) {
    if (!bucket || !Array.isArray(bucket.matches)) return { matches: 0, realOdds: 0, updatedAt: null };
    return {
      matches: bucket.matches.length,
      realOdds: bucket.matches.filter(m => m.realOdds).length,
      updatedAt: bucket.updatedAt || null
    };
  }
  res.json({
    today: summarize(days0),
    tomorrow: summarize(days1),
    basketballToday: summarizeBasketball(basketballDays0),
    apiKeyStorage: db.getMongoStatus(),
    realOddsSource: {
      configured: realOdds.isConfigured(),
      note: realOdds.isConfigured()
        ? 'SharpAPI configured — pre-match odds use real market prices where available, AI fills gaps'
        : 'SHARPAPI_KEY not set — all odds are AI-generated estimates. Set SHARPAPI_KEY for real market odds (see .env.example).'
    },
    footballDataOrgKeyPool: footballData.getKeyPoolStatus(),
    oddsApiIoKeyPool: realOdds.getOddsApiIoKeyPoolStatus(),
    aiKeyPool: ai.getAiKeyPoolStatus(),
    serverTime: new Date().toISOString()
  });
});

// ── CASINO API (what BetaKE — or any site with a JuanAi key — calls) ──
// Server-authoritative crash game. See casino.js's header comment for the
// full explanation of why the round state, RNG, and cashout timing all
// live server-side instead of in the browser. The API key doubles as the
// session identity here (one shared free-play balance per key) — same
// requireApiKey middleware as the football endpoints, so BetaKE uses its
// existing JuanAi key with no extra setup.
//
// GET /api/casino/aviator/state?key=jsk_xxx
// Returns the current round's status/history/your balance & bets. Poll
// this every ~300ms from the client, same as the football live-match data.
app.get('/api/casino/aviator/state', requireApiKey, (req, res) => {
  const key = req.query.key || req.headers['x-api-key'];
  res.json({ success: true, data: casino.getPublicState(key) });
});

// GET /api/casino/aviator/players?key=jsk_xxx
// Lightweight anonymized list of bets placed in the current round, for the
// "All Bets" table. No real user identity — see casino.js's getPlayersView.
app.get('/api/casino/aviator/players', requireApiKey, (req, res) => {
  const key = req.query.key || req.headers['x-api-key'];
  res.json({ success: true, data: casino.getPlayersView() });
});

// POST /api/casino/aviator/bet?key=jsk_xxx   body: { slot: 1|2, stake: number }
app.post('/api/casino/aviator/bet', requireApiKey, (req, res) => {
  const key = req.query.key || req.headers['x-api-key'];
  const { slot, stake } = req.body || {};
  const result = casino.placeBet(key, slot, Number(stake));
  res.status(result.success ? 200 : 400).json(result);
});

// POST /api/casino/aviator/cashout?key=jsk_xxx   body: { slot: 1|2 }
// NOTE: intentionally does NOT accept a client-reported multiplier — the
// server recomputes it from its own clock. See casino.js's cashOut().
app.post('/api/casino/aviator/cashout', requireApiKey, (req, res) => {
  const key = req.query.key || req.headers['x-api-key'];
  const { slot } = req.body || {};
  const result = casino.cashOut(key, slot);
  res.status(result.success ? 200 : 400).json(result);
});

// ── INTERNAL API (called by JuanAi's own frontend, not by BetaKE) ──
// These write data. In production, lock these down further (e.g. a
// separate internal-only secret, or only allow from localhost/admin
// session) so a leaked betting-site API key can't be used to write data.

// GET /internal/fixtures-view?days=0 — read-only, used by JuanAi's own UI to display
// whatever the scheduler already fetched/analyzed. No key required (same-origin admin UI).
app.get('/internal/fixtures-view', async (req, res) => {
  const days = req.query.days || '0';
  const bucket = await db.getFixtures(days);
  res.json(bucket || { matches: [], fetchedAt: null });
});

// POST /internal/analyze-now { matchId, days } — on-demand re-analysis of one match,
// triggered manually from the UI. The scheduler already does this automatically on
// a timer; this just lets you force a refresh for one match immediately.
app.post('/internal/analyze-now', async (req, res) => {
  const { matchId, days } = req.body || {};
  if (!matchId || days === undefined) {
    return res.status(400).json({ error: 'matchId and days are required' });
  }
  const bucket = await db.getFixtures(days);
  const match = bucket && bucket.matches && bucket.matches.find(m => String(m.id) === String(matchId));
  if (!match) return res.status(404).json({ error: 'Match not found' });

  try {
    const odds = await ai.analyzeMatch(match);
    await db.upsertMatchOdds(matchId, days, odds);
    res.json({ ok: true, odds });
  } catch (e) {
    res.status(502).json({ error: 'AI analysis failed: ' + e.message });
  }
});

// NOTE: The old POST /internal/fixtures and POST /internal/odds routes have
// been removed. They let anything that could reach this server write
// arbitrary match data (including fake teams/dates) straight into
// data/fixtures.json with zero validation — a leftover from before
// footballData.js + scheduler.js existed, when the browser itself fetched
// and wrote fixtures. Now that the scheduler is the single source of real
// data (see scheduler.js), these write-open endpoints only created a way for
// stale or fabricated matches to persist. If you ever see fixtures that
// don't match football-data.org's real schedule, it's from data written by
// these routes before this fix — clear data/fixtures.json and let the
// scheduler repopulate it from a real API call.

// GET /internal/clear-fixtures — wipes all stored fixtures so the scheduler
// repopulates from a clean slate on its next cycle. Use this once to flush
// any stale/fake-looking data (e.g. leftover from the old unauthenticated
// POST /internal/fixtures route, now removed). Safe to call anytime — the
// scheduler will refetch real matches from football-data.org within 15 min,
// or immediately if you also restart the server.
app.get('/internal/clear-fixtures', async (req, res) => {
  await db.saveFixtures(0, []);
  await db.saveFixtures(1, []);
  await db.saveFixtures(0, [], 'basketball');
  await db.saveFixtures(1, [], 'basketball');
  res.json({ ok: true, message: 'Fixtures cleared for days=0 and days=1 (football + basketball). Scheduler will repopulate with real data on its next cycle (or restart the server to force it immediately).' });
});

// ── API KEY MANAGEMENT (called by JuanAi's admin UI) ───────────────

app.post('/internal/apikeys', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const record = await db.addApiKey(name);
    res.json(record);
  } catch (e) {
    res.status(500).json({ error: 'Failed to create API key: ' + e.message });
  }
});

app.get('/internal/apikeys', async (req, res) => {
  try {
    res.json(await db.getApiKeys());
  } catch (e) {
    res.status(500).json({ error: 'Failed to load API keys: ' + e.message });
  }
});

app.delete('/internal/apikeys/:id', async (req, res) => {
  try {
    await db.revokeApiKey(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to revoke API key: ' + e.message });
  }
});

// ── Serve the JuanAi frontend itself (optional, convenient) ────────
// Put JuanAi-1.html in the same folder as this file, renamed to index.html,
// and it'll be served automatically at http://localhost:3000/
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`JuanAi backend running on http://localhost:${PORT}`);
  console.log(`External betting sites call: GET http://localhost:${PORT}/api/fixtures?key=YOUR_KEY&days=0`);
  scheduler.start();
});
