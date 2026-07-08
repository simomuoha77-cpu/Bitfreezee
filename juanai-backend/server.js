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
const scheduler = require('./scheduler');

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
// Returns REAL fixtures (football-data.org) + AI-generated odds, kept fresh
// automatically in the background — no manual "Analyze" click required.
app.get('/api/fixtures', requireApiKey, (req, res) => {
  const days = req.query.days || '0';
  const bucket = db.getFixtures(days);
  if (!bucket) {
    return res.json({ matches: [], fetchedAt: null, note: 'No fixtures loaded for this day yet — background refresh runs on a schedule, try again shortly' });
  }
  res.json({
    matches: bucket.matches,
    fetchedAt: bucket.fetchedAt,
    updatedAt: bucket.updatedAt,
    oddsMargin: ai.DEFAULT_MARGIN,
    disclaimer: 'aiOdds are AI-generated estimates with a ' + (ai.DEFAULT_MARGIN * 100).toFixed(0) + '% margin already applied (see aiOdds.fairOdds for the pre-margin AI estimate) — not real bookmaker market odds. Use responsibly and manage your own exposure regardless of these numbers.'
  });
});

// GET /api/health — simple uptime check, no key required
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// GET /api/status — background job visibility (no key required, no sensitive data)
app.get('/api/status', async (req, res) => {
  await db.ensureMongo();
  const days0 = db.getFixtures(0);
  const days1 = db.getFixtures(1);
  function summarize(bucket) {
    if (!bucket || !Array.isArray(bucket.matches)) return { matches: 0, analyzed: 0, updatedAt: null };
    return {
      matches: bucket.matches.length,
      analyzed: bucket.matches.filter(m => m.aiOdds).length,
      updatedAt: bucket.updatedAt || null
    };
  }
  res.json({
    today: summarize(days0),
    tomorrow: summarize(days1),
    apiKeyStorage: db.getMongoStatus(),
    serverTime: new Date().toISOString()
  });
});

// ── INTERNAL API (called by JuanAi's own frontend, not by BetaKE) ──
// These write data. In production, lock these down further (e.g. a
// separate internal-only secret, or only allow from localhost/admin
// session) so a leaked betting-site API key can't be used to write data.

// GET /internal/fixtures-view?days=0 — read-only, used by JuanAi's own UI to display
// whatever the scheduler already fetched/analyzed. No key required (same-origin admin UI).
app.get('/internal/fixtures-view', (req, res) => {
  const days = req.query.days || '0';
  const bucket = db.getFixtures(days);
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
  const bucket = db.getFixtures(days);
  const match = bucket && bucket.matches && bucket.matches.find(m => String(m.id) === String(matchId));
  if (!match) return res.status(404).json({ error: 'Match not found' });

  try {
    const odds = await ai.analyzeMatch(match);
    db.upsertMatchOdds(matchId, days, odds);
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
app.get('/internal/clear-fixtures', (req, res) => {
  db.saveFixtures(0, []);
  db.saveFixtures(1, []);
  res.json({ ok: true, message: 'Fixtures cleared for days=0 and days=1. Scheduler will repopulate with real data on its next cycle (or restart the server to force it immediately).' });
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
