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

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const realOdds = require('./realOdds');
const footballData = require('./footballData');
const scheduler = require('./scheduler');
const casino = require('./casino');
const casinoIntegration = require('./casinoIntegration');
const walletClient = require('./walletClient');
const userToken = require('./userToken');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Auth middleware: checks the API key against real stored keys ──
// Accepts the key from any of: ?key=jsk_xxx, x-api-key header,
// Authorization: Bearer jsk_xxx, or body.key (for JSON POST bodies that
// bundle the key alongside other fields, like /api/casino/session below)
// — this way every site embedding JuanAi's games (or any future
// frontend) can pass the same key however's convenient, and it's still
// the exact same key/session underneath.
function extractApiKey(req) {
  if (req.query.key) return req.query.key;
  if (req.headers['x-api-key']) return req.headers['x-api-key'];
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.body && req.body.key) return req.body.key;
  return null;
}

async function requireApiKey(req, res, next) {
  const key = extractApiKey(req);
  const valid = await db.isValidApiKey(key);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  req.apiKey = key; // stash so routes don't need to re-parse it
  next();
}

// ── Admin auth middleware: protects every /internal/* route ──────────
// Before this, ALL /internal/* routes (create/list/delete API keys,
// register a partner's wallet secret, clear cached data, trigger
// analysis) had NO authentication at all — anyone who found or guessed
// the URL on this public Render deployment could call them directly.
// That's the single most serious gap in this codebase: /internal/wallet
// in particular controls the HMAC secret that protects real money
// movement, and /internal/apikeys can mint new API keys outright.
//
// ADMIN_SECRET is a single shared password, set via env var, required on
// every /internal/* call as a header. Comparison uses
// crypto.timingSafeEqual — a naive `===` string comparison leaks timing
// information (how many leading characters matched) that could
// theoretically help an attacker guess the secret one byte at a time;
// timingSafeEqual takes the same amount of time regardless of how much of
// the guess is correct.
//
// If ADMIN_SECRET is not set, these routes are REFUSED entirely (fail
// closed) rather than left open — better to have the admin panel
// temporarily unusable until configured than silently unprotected.
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: 'ADMIN_SECRET is not configured on this server — /internal/* routes are disabled until it is set. See .env.example.' });
  }
  const provided = req.headers['x-admin-secret'] || req.query.adminSecret || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_SECRET);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    return res.status(401).json({ error: 'Invalid or missing admin secret' });
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

// ── AI CHAT STREAMING PROXY ─────────────────────────────────────────
// Used by the chat feature built into public/index.html. This exists so
// the Gemini/Groq API keys live ONLY in this server's environment
// variables — never in the HTML/JS sent to the browser, where anyone
// viewing page source could previously copy them directly (this is
// exactly what this route replaces: two real, live keys were hardcoded
// in index.html before this fix).
//
// Request body shape mirrors what the frontend already builds internally
// for each provider, so the frontend's own message-building logic barely
// changes — only the URL and key handling move server-side:
//   { engine: 'gemini', model, systemPrompt, contents, maxTokens, temperature }
//   { engine: 'groq',   model, messages,     maxTokens, temperature }
// (contents/messages are exactly Gemini's/Groq's own expected shapes.)
//
// STREAMING: the provider's raw SSE response body is piped directly back
// to the browser byte-for-byte (see ai.js's streamGeminiRaw/streamGroqRaw)
// — this route does not buffer or re-parse the stream, so the frontend's
// existing SSE-parsing code keeps working almost unchanged, just pointed
// at this endpoint instead of calling Google/Groq directly.
//
// RATE LIMITING: this route has no login/API-key gate (it's used by the
// public chat feature, including guests), but every call costs real
// money against your Gemini/Groq quota. A simple per-IP rate limit
// prevents a single abusive client from running up a large bill; it does
// not attempt to be a full abuse-prevention system.
const chatRateBuckets = new Map(); // ip -> { windowStart, count }
const CHAT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CHAT_RATE_LIMIT_MAX = 20; // 20 chat messages per minute per IP
function checkChatRateLimit(ip) {
  const now = Date.now();
  let b = chatRateBuckets.get(ip);
  if (!b || now - b.windowStart > CHAT_RATE_LIMIT_WINDOW_MS) {
    b = { windowStart: now, count: 0 };
    chatRateBuckets.set(ip, b);
  }
  b.count++;
  return b.count <= CHAT_RATE_LIMIT_MAX;
}

// The "admin mode" system prompt lives ONLY here now — previously it (and
// the password that unlocked it) were both hardcoded in plain text in
// index.html, visible to anyone viewing page source. Now the client only
// ever sends { adminPasswordAttempt } alongside its normal chat request;
// this route verifies it server-side and chooses the system prompt
// itself. Even if a client tried to just send the admin prompt text
// directly as systemPrompt (bypassing the password entirely), that no
// longer matters, because the server ignores the client's systemPrompt
// when isAdminRequest is false, and only accepts the elevated one when
// the password check actually passes.
const ADMIN_MODE_PASSWORD = process.env.ADMIN_MODE_PASSWORD || '';
const ADMIN_MODE_SYSTEM_PROMPT = `You are JuanAi ADMIN MODE — Elite AI Coding Assistant by Home Tech Group. You are in an elevated developer mode activated by the verified system owner.

ADMIN MODE NOTES:
- Full project memory and context awareness
- All slash commands active
- Same elite coding standards as normal mode — production-ready, fully working, secure code every time.

Note: this system prompt can request a different tone/scope, but it cannot and does not override the underlying model's own built-in safety behavior — that's determined by the model provider (Google/Groq), not by any prompt text.`;

function verifyAdminPassword(attempt) {
  if (!ADMIN_MODE_PASSWORD || !attempt) return false;
  const a = Buffer.from(String(attempt));
  const b = Buffer.from(ADMIN_MODE_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/chat/stream', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkChatRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many chat requests — please slow down' });
  }

  const { engine, model, systemPrompt, contents, messages, maxTokens, temperature, adminPasswordAttempt } = req.body || {};

  // Decide the system prompt SERVER-SIDE. If a valid admin password was
  // supplied this request, use the real admin prompt (never sent to the
  // client at any point — it lives only in this file). Otherwise, use
  // whatever normal (non-admin) system prompt the client sent — that part
  // is fine to trust from the client since it doesn't grant any elevated
  // behavior, it's just this feature's ordinary configurable persona text.
  const isAdminRequest = verifyAdminPassword(adminPasswordAttempt);
  const effectiveSystemPrompt = isAdminRequest ? ADMIN_MODE_SYSTEM_PROMPT : (systemPrompt || '');

  try {
    let providerResp;
    if (engine === 'gemini') {
      if (!Array.isArray(contents)) return res.status(400).json({ error: 'contents array is required for engine=gemini' });
      providerResp = await ai.streamGeminiRaw(model || ai.GEMINI_MODELS[0], effectiveSystemPrompt, contents, maxTokens, isAdminRequest ? 1.0 : temperature);
    } else if (engine === 'groq') {
      if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array is required for engine=groq' });
      // Groq takes its system prompt as the first message in the array —
      // swap it out the same way if this is a verified admin request.
      const effectiveMessages = isAdminRequest && messages[0] && messages[0].role === 'system'
        ? [{ role: 'system', content: ADMIN_MODE_SYSTEM_PROMPT }, ...messages.slice(1)]
        : messages;
      providerResp = await ai.streamGroqRaw(model || ai.GROQ_MODELS[0], effectiveMessages, maxTokens, isAdminRequest ? 0.9 : temperature);
    } else {
      return res.status(400).json({ error: "engine must be 'gemini' or 'groq'" });
    }

    // Pipe the provider's SSE stream straight through, unmodified.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Admin-Verified', isAdminRequest ? 'true' : 'false'); // lets the client know whether its password attempt actually worked, without ever seeing the real password
    for await (const chunk of providerResp.body) {
      res.write(chunk);
    }
    res.end();
  } catch (e) {
    // If headers haven't been sent yet (failed before streaming started),
    // respond with a normal JSON error the frontend's existing catch
    // blocks already know how to handle (they check err.status/err.text).
    if (!res.headersSent) {
      res.status(e.status || 500).json({ error: e.message || 'AI request failed' });
    } else {
      res.end();
    }
  }
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
// live server-side instead of in the browser.
//
// PER-USER BALANCE: pass a signed user token as ?utoken=... (or the
// x-user-token header) alongside your API key to give each of YOUR users
// their own isolated free-play "aviator balance", instead of everyone
// sharing one balance under your API key. Generate that token on YOUR
// backend with userToken.js's sign(userId) using the shared secret in
// JUANAI_USER_TOKEN_SECRET — never generate it in the browser, since the
// entire point is that the browser can't forge an identity it wasn't
// given. If you don't pass ?utoken=, all your users share one balance
// under your API key (fine for a single-user test, not for production
// with real end users).
//
// Key can be passed as ?key=jsk_xxx, x-api-key header, or
// Authorization: Bearer jsk_xxx.
function extractUserToken(req) {
  return req.query.utoken || req.headers['x-user-token'] || null;
}

// GET /api/casino/aviator/state?key=jsk_xxx&utoken=...
// Returns the current round's status/history/your balance & bets. Poll
// this every ~300ms from the client, same as the football live-match data.
app.get('/api/casino/aviator/state', requireApiKey, (req, res) => {
  res.json({ success: true, data: casino.getPublicState(req.apiKey, extractUserToken(req)) });
});

// GET /api/casino/aviator/players?key=jsk_xxx
// Lightweight anonymized list of bets placed in the current round, for the
// "All Bets" table. No real user identity — see casino.js's getPlayersView.
app.get('/api/casino/aviator/players', requireApiKey, (req, res) => {
  res.json({ success: true, data: casino.getPlayersView() });
});

// POST /api/casino/aviator/bet?key=jsk_xxx&utoken=...   body: { slot: 1|2, stake: number }
app.post('/api/casino/aviator/bet', requireApiKey, (req, res) => {
  const { slot, stake } = req.body || {};
  const result = casino.placeBet(req.apiKey, extractUserToken(req), slot, Number(stake));
  res.status(result.success ? 200 : 400).json(result);
});

// POST /api/casino/aviator/cashout?key=jsk_xxx&utoken=...   body: { slot: 1|2 }
// NOTE: intentionally does NOT accept a client-reported multiplier — the
// server recomputes it from its own clock. See casino.js's cashOut().
app.post('/api/casino/aviator/cashout', requireApiKey, (req, res) => {
  const { slot } = req.body || {};
  const result = casino.cashOut(req.apiKey, extractUserToken(req), slot);
  res.status(result.success ? 200 : 400).json(result);
});

// ── /api/aviator/* — same engine, shorter path ──────────────────────
// Identical to /api/casino/aviator/* above (same casino.js round engine,
// same one-shared-round-for-everyone model, same requireApiKey auth, same
// optional ?utoken= per-user identity) — this is just an alias under the
// shorter path some frontends (and any betting site embedding the game)
// call instead. There is only ONE game engine underneath both paths, so
// behavior is guaranteed identical; pick whichever path is more
// convenient when integrating.
app.get('/api/aviator/state', requireApiKey, (req, res) => {
  res.json({ success: true, data: casino.getPublicState(req.apiKey, extractUserToken(req)) });
});
app.get('/api/aviator/players', requireApiKey, (req, res) => {
  res.json({ success: true, data: casino.getPlayersView() });
});
app.post('/api/aviator/bet', requireApiKey, (req, res) => {
  const { slot, stake } = req.body || {};
  const result = casino.placeBet(req.apiKey, extractUserToken(req), slot, Number(stake));
  res.status(result.success ? 200 : 400).json(result);
});
app.post('/api/aviator/cashout', requireApiKey, (req, res) => {
  const { slot } = req.body || {};
  const result = casino.cashOut(req.apiKey, extractUserToken(req), slot);
  res.status(result.success ? 200 : 400).json(result);
});

// ── CASINO PARTNER API (real money, server-to-server only) ────────────
// For betting sites (e.g. SafariBet) to integrate JuanAi's casino games
// with THEIR OWN real balance as the only source of truth. See
// casinoIntegration.js's header comment for the full design rationale —
// short version: JuanAi never holds or moves real money; it only records
// bets against its own server-authoritative round engine (same one behind
// /api/casino/aviator/*) and reports factual outcomes for the partner's
// server to act on. Outcomes are retrieved by POLLING, not by JuanAi
// pushing to a callback URL — safer for real money (no public callback
// endpoint on the partner's side to secure/spoof, no retry/webhook
// complexity on JuanAi's side).
//
// IMPORTANT: these endpoints are meant to be called SERVER-TO-SERVER —
// from the partner's own backend, using their JuanAi API key — never
// directly from the partner's website's browser/frontend. Calling these
// from a browser would expose the API key and the partner's internal
// userId values to anyone who opens devtools.

// GET /api/casino/games?key=jsk_xxx
// Returns the catalog of games available to embed. See casinoIntegration
// .js's GAMES list — only lists games that are actually live and working.
app.get('/api/casino/games', requireApiKey, (req, res) => {
  res.json({ success: true, data: casinoIntegration.listGames() });
});

// POST /api/casino/bet   body: { gameId, userId, slot, stake }
// Partner's server calls this AFTER deducting (or reserving) the stake
// from their user's real balance. JuanAi does not touch any balance here
// — it only validates and records the bet against the live round.
app.post('/api/casino/bet', requireApiKey, (req, res) => {
  const { gameId, userId, slot, stake } = req.body || {};
  const result = casinoIntegration.placeBet(req.apiKey, userId, gameId, slot, Number(stake));
  res.status(result.success ? 200 : 400).json(result);
});

// GET /api/casino/bet/:betId?key=jsk_xxx
// Partner's server polls this to find out whether a bet has resolved yet.
// status is 'pending' | 'won' | 'lost'. On 'won', credit `won` to the
// user's real balance; on 'lost', no action needed (stake was already
// deducted/reserved by the partner when placing the bet).
app.get('/api/casino/bet/:betId', requireApiKey, (req, res) => {
  const result = casinoIntegration.getBetResult(req.apiKey, req.params.betId);
  res.status(result.success ? 200 : 404).json(result);
});

// POST /api/casino/bet/:betId/cashout
// Partner's server calls this when their user requests a cashout (e.g.
// taps "Cash Out" in the partner's own UI). Same server-side timing
// guarantee as the free-play engine: the multiplier is always recomputed
// from JuanAi's own clock, never trusted from the partner's request.
app.post('/api/casino/bet/:betId/cashout', requireApiKey, (req, res) => {
  const result = casinoIntegration.cashOut(req.apiKey, req.params.betId);
  res.status(result.success ? 200 : 400).json(result);
});

// GET /api/casino/history?key=jsk_xxx&userId=xxx&limit=50
// Partner's server can pull a user's recent resolved bets for
// reconciliation/auditing against their own ledger.
app.get('/api/casino/history', requireApiKey, (req, res) => {
  const { userId, limit } = req.query;
  if (!userId) return res.status(400).json({ success: false, message: 'userId query param is required' });
  const data = casinoIntegration.getHistory(req.apiKey, userId, limit ? Number(limit) : 50);
  res.json({ success: true, data });
});

// GET /api/casino/balance?key=jsk_xxx&userId=xxx
// SERVER-TO-SERVER ONLY — same warning as above. Do not call this
// directly from a browser: a raw userId here is not verified as
// belonging to whoever is asking, so anyone could query any user's
// balance. The browser-safe equivalent is
// /api/casino/play/balance?key=jsk_xxx&utoken=... below.
app.get('/api/casino/balance', requireApiKey, async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ success: false, message: 'userId query param is required' });
  const result = await casinoIntegration.getBalance(req.apiKey, userId);
  res.status(result.success ? 200 : 502).json(result);
});

// ── CASINO SESSION API (server-to-server only) ─────────────────────────
// POST /api/casino/session   body: { key, userId, username }
// SafariBet's OWN backend calls this — never the browser — when a user
// taps "Play Aviator", to get a signed utoken for that specific user (and
// their current real balance in the same response, so SafariBet doesn't
// need a second call before launching). SafariBet then launches the game
// with: /casino/aviator.html?key=jsk_xxx&utoken=THE_RETURNED_TOKEN
//
// Response: { success: true, utoken, balance }
// `username` is accepted but not currently used for anything server-side
// — it's here in case a future version wants to show a display name in
// the game UI; safe to keep sending it even though it's unused today.
//
// WHY THIS MUST STAY SERVER-TO-SERVER: this endpoint mints proof of "this
// request really is user X" — the same authority userToken.js's signature
// carries everywhere else in this codebase. It's gated on requireApiKey
// (the same jsk_xxx check as every other partner endpoint) precisely
// because whoever can call this can mint a session for ANY userId they
// send. That's fine when the caller is SafariBet's own backend (which
// already knows who is really logged in), and NOT fine if this were ever
// exposed to a browser — anyone could then mint a token for any other
// user's id and play (or query balance/history) as them. Keep your
// jsk_xxx key private on your own server; never send it from a page a
// user's browser can see.
//
// TOKEN LIFETIME: see userToken.js's MAX_TOKEN_AGE_MS (currently 6 hours).
// If a user's play session outlives that, call this endpoint again to
// mint a fresh token — there's no harm in calling it again anytime
// (e.g. right before every launch), it's cheap and stateless.
app.post('/api/casino/session', requireApiKey, async (req, res) => {
  const { userId, username } = req.body || {};
  if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });
  if (!userToken.isConfigured()) {
    return res.status(500).json({ success: false, message: 'JUANAI_USER_TOKEN_SECRET is not set on this server — sessions cannot be issued until it is configured' });
  }
  try {
    const utoken = userToken.sign(String(userId));
    // Fetch the user's real balance from SafariBet's own wallet right now,
    // so this one response gives SafariBet everything needed to launch
    // the game immediately — no second round-trip required. If the
    // wallet call fails (e.g. not registered yet, or SafariBet's balance
    // endpoint is briefly down), still return the utoken — the game page
    // will fetch balance itself on load via /api/casino/play/balance, so
    // a wallet hiccup here doesn't need to block issuing the session.
    const balResult = await casinoIntegration.getBalance(req.apiKey, String(userId));
    res.json({ success: true, utoken, balance: balResult.success ? balResult.balance : null });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to create session: ' + e.message });
  }
});


// These are the ONLY real-money casino endpoints meant to be called
// directly from a game page in the browser (e.g. public/casino/aviator
// .html embedded in an iframe). Instead of a raw userId — which a browser
// could simply swap for someone else's — they require a signed ?utoken=
// (see userToken.js). That token is generated on the PARTNER'S OWN backend
// for the specific logged-in user and passed into the game's launch URL;
// the browser only ever carries it along, never mints it. Each route
// verifies the token server-side and resolves the real userId from it
// before ever calling into casinoIntegration.js/walletClient.js — a
// forged or missing token is rejected outright, so no bet, cashout, or
// balance lookup can ever be performed as a user the caller wasn't
// actually given a valid token for.
function resolveVerifiedUserId(req, res) {
  const token = req.query.utoken || req.body?.utoken;
  const userId = userToken.verify(token);
  if (!userId) {
    res.status(401).json({ success: false, message: 'Missing or invalid utoken — this must be a signed token from the partner\'s own backend, see userToken.js' });
    return null;
  }
  return userId;
}

// GET /api/casino/play/balance?key=jsk_xxx&utoken=...
app.get('/api/casino/play/balance', requireApiKey, async (req, res) => {
  const userId = resolveVerifiedUserId(req, res);
  if (!userId) return;
  const result = await casinoIntegration.getBalance(req.apiKey, userId);
  res.status(result.success ? 200 : 502).json(result);
});

// POST /api/casino/play/bet?key=jsk_xxx   body: { utoken, gameId, slot, stake }
app.post('/api/casino/play/bet', requireApiKey, async (req, res) => {
  const userId = resolveVerifiedUserId(req, res);
  if (!userId) return;
  const { gameId, slot, stake } = req.body || {};
  const result = await casinoIntegration.placeBet(req.apiKey, userId, gameId, slot, Number(stake));
  res.status(result.success ? 200 : 400).json(result);
});

// GET /api/casino/play/bet/:betId?key=jsk_xxx&utoken=...
app.get('/api/casino/play/bet/:betId', requireApiKey, async (req, res) => {
  const userId = resolveVerifiedUserId(req, res);
  if (!userId) return;
  const result = await casinoIntegration.getBetResult(req.apiKey, req.params.betId);
  // Defense in depth: even though betId alone is hard to guess, also
  // confirm the resolved bet actually belongs to this verified user
  // before returning it.
  if (result.success && result.userId && result.userId !== userId) {
    return res.status(403).json({ success: false, message: 'This bet does not belong to the verified user' });
  }
  res.status(result.success ? 200 : 404).json(result);
});

// POST /api/casino/play/bet/:betId/cashout?key=jsk_xxx   body: { utoken }
app.post('/api/casino/play/bet/:betId/cashout', requireApiKey, async (req, res) => {
  const userId = resolveVerifiedUserId(req, res);
  if (!userId) return;
  const existing = await casinoIntegration.getBetResult(req.apiKey, req.params.betId);
  if (existing.success && existing.userId && existing.userId !== userId) {
    return res.status(403).json({ success: false, message: 'This bet does not belong to the verified user' });
  }
  const result = await casinoIntegration.cashOut(req.apiKey, req.params.betId);
  res.status(result.success ? 200 : 400).json(result);
});

// ── INTERNAL API (called by JuanAi's own frontend, not by BetaKE) ──
// These write data. In production, lock these down further (e.g. a
// separate internal-only secret, or only allow from localhost/admin
// session) so a leaked betting-site API key can't be used to write data.

// GET /internal/fixtures-view?days=0 — read-only, used by JuanAi's own UI
// (the public Football tab, shown to ALL visitors, not just admins) to
// display whatever the scheduler already fetched/analyzed. Deliberately
// NOT behind requireAdmin — unlike the other /internal/* routes, this one
// only ever reads already-public match/odds data, so there's nothing
// here an admin secret would meaningfully protect; gating it would have
// broken the regular Football tab for every visitor.
app.get('/internal/fixtures-view', async (req, res) => {
  const days = req.query.days || '0';
  const bucket = await db.getFixtures(days);
  res.json(bucket || { matches: [], fetchedAt: null });
});

// GET /internal/casino/exposure — read-only risk monitoring: current
// round's total staked amount vs the configured MAX_ROUND_EXPOSURE cap
// (see casino.js). Requires X-Admin-Secret header — this is house-side
// risk data, deliberately NOT exposed via the public /api/casino/* or
// /api/aviator/* endpoints.
app.get('/internal/casino/exposure', requireAdmin, (req, res) => {
  res.json(casino.getRoundExposure());
});

// POST /internal/analyze-now { matchId, days } — on-demand re-analysis of one match,
// triggered manually from the UI's public "Re-analyze" button (visible to all
// visitors, not just admins). Deliberately NOT behind requireAdmin — this is a
// regular visitor-facing feature. It DOES cost a real AI API call per click
// though, so it's rate-limited per IP instead (same pattern as /api/chat/stream)
// to prevent runaway cost from repeated clicking/scripting, without blocking the
// feature for everyone.
app.post('/internal/analyze-now', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkChatRateLimit(ip)) { // reuse the same per-IP bucket/limits as the chat proxy
    return res.status(429).json({ error: 'Too many analysis requests — please slow down' });
  }
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
app.get('/internal/clear-fixtures', requireAdmin, async (req, res) => {
  await db.saveFixtures(0, []);
  await db.saveFixtures(1, []);
  await db.saveFixtures(0, [], 'basketball');
  await db.saveFixtures(1, [], 'basketball');
  res.json({ ok: true, message: 'Fixtures cleared for days=0 and days=1 (football + basketball). Scheduler will repopulate with real data on its next cycle (or restart the server to force it immediately).' });
});

// ── API KEY MANAGEMENT (called by JuanAi's admin UI) ───────────────
// All require X-Admin-Secret — these can create/list/delete the API keys
// that gate every partner-facing endpoint in this file, so they need to be
// at least as protected as the keys they manage.

app.post('/internal/apikeys', requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const record = await db.addApiKey(name);
    res.json(record);
  } catch (e) {
    res.status(500).json({ error: 'Failed to create API key: ' + e.message });
  }
});

app.get('/internal/apikeys', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getApiKeys());
  } catch (e) {
    res.status(500).json({ error: 'Failed to load API keys: ' + e.message });
  }
});

app.delete('/internal/apikeys/:id', requireAdmin, async (req, res) => {
  try {
    await db.revokeApiKey(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to revoke API key: ' + e.message });
  }
});

// ── WALLET INTEGRATION SETUP (called by JuanAi's admin UI) ──────────
// Registers a partner's own wallet base URL + shared HMAC secret so
// casinoIntegration.js/walletClient.js know where to call for
// debit/credit/balance. Requires X-Admin-Secret (see requireAdmin above)
// — this endpoint sets the secret that authorizes real money movement, so
// it needs to be at least as protected as ADMIN_SECRET itself.
app.post('/internal/wallet', requireAdmin, async (req, res) => {
  const { apiKey, baseUrl, secret } = req.body || {};
  if (!apiKey || !baseUrl || !secret) {
    return res.status(400).json({ error: 'apiKey, baseUrl, and secret are all required' });
  }
  try {
    await casinoIntegration.registerWallet(apiKey, baseUrl, secret);
    res.json({ ok: true, apiKey, baseUrl });
  } catch (e) {
    res.status(500).json({ error: 'Failed to register wallet: ' + e.message });
  }
});

// ── Serve the JuanAi frontend itself (optional, convenient) ────────
// Put JuanAi-1.html in the same folder as this file, renamed to index.html,
// and it'll be served automatically at http://localhost:3000/
//
// CACHING: explicitly disabled here. Without this, Express's default
// static-file caching (ETag-based) combined with mobile Chrome's own
// aggressive page cache can make a freshly-deployed change (like a CSS
// tweak to aviator.html) invisible even after a real deploy — the phone
// just keeps showing what it cached from the last time that exact URL was
// opened, no error, no obvious sign anything's wrong. Since this app is
// actively iterated on and correctness matters more than shaving a few KB
// of repeat-request bandwidth, always serve fresh copies instead.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // Allow the casino game pages (e.g. aviator.html) to be embedded in an
    // iframe on a partner site like SafariBet. Scoped to /casino/ only —
    // not applied site-wide — since nothing else here (the admin panel,
    // etc.) needs or should allow arbitrary framing. Without this, most
    // browsers refuse to render the page inside an iframe at all.
    if (filePath.includes(`${path.sep}casino${path.sep}`)) {
      // Modern browsers respect frame-ancestors and ignore X-Frame-Options
      // when both are present; X-Frame-Options is kept only for older
      // browsers that don't understand CSP frame-ancestors yet.
      res.setHeader('Content-Security-Policy', 'frame-ancestors *');
      res.removeHeader('X-Frame-Options'); // ALLOWALL isn't a valid value browsers recognize — omitting it entirely (rather than sending an invalid value) is what actually allows framing
    }
  },
}));

app.listen(PORT, () => {
  console.log(`JuanAi backend running on http://localhost:${PORT}`);
  console.log(`External betting sites call: GET http://localhost:${PORT}/api/fixtures?key=YOUR_KEY&days=0`);
  scheduler.start();
  walletClient.loadWalletsFromDb();
});
