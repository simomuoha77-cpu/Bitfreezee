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
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const oddsData = require('./oddsData');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Auth middleware: checks the API key against real stored keys ──
function requireApiKey(req, res, next) {
  const key = req.query.key || req.headers['x-api-key'];
  if (!db.isValidApiKey(key)) {
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
    disclaimer: 'realOdds are real bookmaker market prices (see realOdds.source per match). aiPrediction/aiConfidence/aiAnalysis/aiValueBet are AI commentary written on top of those real odds, not invented numbers.'
  });
});

// GET /api/health — simple uptime check, no key required
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// GET /api/status — background job visibility (no key required, no sensitive data)
app.get('/api/status', (req, res) => {
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

// POST /internal/analyze-now { matchId, days } — on-demand refresh of one match,
// triggered manually from the UI. Fetches REAL bookmaker odds first (if not
// already cached or stale), then runs AI analysis on top of those real odds.
// The scheduler already does both automatically on a timer; this just lets
// you force it for one match immediately.
app.post('/internal/analyze-now', async (req, res) => {
  const { matchId, days } = req.body || {};
  if (!matchId || days === undefined) {
    return res.status(400).json({ error: 'matchId and days are required' });
  }
  const bucket = db.getFixtures(days);
  const match = bucket && bucket.matches && bucket.matches.find(m => String(m.id) === String(matchId));
  if (!match) return res.status(404).json({ error: 'Match not found' });

  try {
    let realOdds = match.realOdds;
    if (!realOdds) {
      realOdds = await oddsData.getRealOdds(match);
      if (realOdds) db.upsertRealOdds(matchId, days, realOdds);
    }
    if (!realOdds) {
      return res.status(409).json({ error: 'No real bookmaker odds are posted for this match yet — try again closer to kickoff' });
    }
    const result = await ai.analyzeMatch(match, realOdds);
    db.upsertMatchOdds(matchId, days, result);
    res.json({ ok: true, odds: result });
  } catch (e) {
    res.status(502).json({ error: 'Analysis failed: ' + e.message });
  }
});

// POST /internal/fixtures  { days, matches: [...] }
// Called by JuanAi frontend right after it loads/generates a fixture list.
app.post('/internal/fixtures', (req, res) => {
  const { days, matches } = req.body || {};
  if (days === undefined || !Array.isArray(matches)) {
    return res.status(400).json({ error: 'days and matches[] are required' });
  }
  db.saveFixtures(days, matches);
  res.json({ ok: true, count: matches.length });
});

// POST /internal/odds  { matchId, days, odds: {...} }
// Called by JuanAi frontend right after analyzeMatch() gets a result from Groq/Gemini.
app.post('/internal/odds', (req, res) => {
  const { matchId, days, odds } = req.body || {};
  if (!matchId || days === undefined || !odds) {
    return res.status(400).json({ error: 'matchId, days, and odds are required' });
  }
  const found = db.upsertMatchOdds(matchId, days, odds);
  if (!found) {
    return res.status(404).json({ error: 'Match not found in stored fixtures for that day bucket' });
  }
  res.json({ ok: true });
});

// ── API KEY MANAGEMENT (called by JuanAi's admin UI) ───────────────

app.post('/internal/apikeys', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const key = 'jsk_' + crypto.randomBytes(24).toString('hex');
  const record = db.addApiKey(name, key);
  res.json(record);
});

app.get('/internal/apikeys', (req, res) => {
  res.json(db.getApiKeys());
});

app.delete('/internal/apikeys/:id', (req, res) => {
  db.revokeApiKey(req.params.id);
  res.json({ ok: true });
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
