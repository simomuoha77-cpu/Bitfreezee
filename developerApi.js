// JuanAi Developer API: product-scoped Football/Casino credentials.
// Existing Football routes are unchanged. Casino routes preserve JuanAi's
// legacy games while using AS Tech's existing public backend/server-function
// system as the upstream catalogue source. No AS Tech partner key/secret is
// required for this catalogue feed.
const express = require('express');
const db = require('./db');
const scheduler = require('./scheduler');
const asTechApi = require('./asTechApi');
const casino = require('./casino');
const casinoIntegration = require('./casinoIntegration');

const router = express.Router();
const WINDOW_MS = Number(process.env.DEVELOPER_API_RATE_WINDOW_MS || 60_000);
const DEFAULT_LIMIT = Number(process.env.DEVELOPER_API_RATE_LIMIT || 300);
const rate = new Map();

function error(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function extractPair(req) {
  const key = req.headers['x-juanai-key'] || req.headers['x-api-key'] || req.query.key || req.body?.key;
  const secret = req.headers['x-juanai-secret'] || req.headers['x-api-secret'] || req.body?.secret;
  return { key: key ? String(key) : '', secret: secret ? String(secret) : '' };
}

function rateLimit(req, res, next) {
  const key = req.developerCredential?.apiKey || req.ip || 'unknown';
  const now = Date.now();
  let row = rate.get(key);
  if (!row || now - row.startedAt >= WINDOW_MS) row = { startedAt: now, count: 0 };
  row.count += 1;
  rate.set(key, row);
  if (row.count > DEFAULT_LIMIT) {
    res.setHeader('Retry-After', Math.ceil((WINDOW_MS - (now - row.startedAt)) / 1000));
    return error(res, 429, 'RATE_LIMITED', 'Developer API rate limit exceeded.');
  }
  next();
}

function requireDeveloperApi(product) {
  return async (req, res, next) => {
    const { key, secret } = extractPair(req);
    if (!key || !secret) return error(res, 401, 'INVALID_API_CREDENTIALS', 'API key and secret are required.');
    try {
      const credential = await db.verifyDeveloperCredential(key, secret, product);
      if (!credential) {
        const state = await db.getDeveloperCredentialByKey(key);
        if (state?.status === 'revoked') return error(res, 401, 'API_KEY_REVOKED', 'The API credential has been revoked.');
        if (state && state.product !== product) return error(res, 403, 'INSUFFICIENT_SCOPE', 'This API credential is not authorized for this product.');
        return error(res, 401, 'INVALID_API_CREDENTIALS', 'The API credentials are invalid.');
      }
      req.developerCredential = credential;
      req.developerSecret = secret;
      return rateLimit(req, res, next);
    } catch (e) {
      console.error('[developer-api] auth failed:', e.message);
      return error(res, 500, 'INTERNAL_ERROR', 'Unable to authenticate the API request.');
    }
  };
}

// Football API — unchanged.
router.get('/football/fixtures', requireDeveloperApi('football'), async (req, res) => {
  try {
    const days = String(req.query.days ?? '0');
    const sport = String(req.query.sport || 'football').toLowerCase();
    const supported = ['football', 'basketball', 'tennis', 'hockey', 'cricket', 'volleyball', 'rugby', 'handball'];
    if (!supported.includes(sport)) return error(res, 400, 'INVALID_REQUEST', 'Unsupported sport.');
    try { await scheduler.refreshSofaSportIfDue(sport, Number(days)); } catch (e) { console.warn('[developer-api] fixture refresh:', e.message); }
    const bucket = await db.getFixtures(days, sport);
    const includeFinished = req.query.includeFinished === '1';
    const matches = (bucket?.matches || []).filter(m => includeFinished || m.status !== 'FINISHED');
    return res.json({ success: true, sport, days: Number(days), fetchedAt: bucket?.fetchedAt || null, matches });
  } catch (e) {
    console.error('[developer-api] football fixtures:', e.message);
    return error(res, 500, 'INTERNAL_ERROR', 'Unable to load football data.');
  }
});

router.get('/football/competitions', requireDeveloperApi('football'), async (req, res) => {
  try {
    const footballData = require('./footballData');
    const competitions = await footballData.getAvailableCompetitions();
    return res.json({ success: true, competitions });
  } catch (e) {
    return error(res, 502, 'UPSTREAM_ERROR', 'Unable to load competitions.');
  }
});

// ── Casino Developer API ──────────────────────────────────────────────
// Casino catalogue exposed to partners. The complete AS Tech catalogue is
// fetched dynamically through AS Tech's existing public backend/server-function
// feed. JuanAi's legacy Aviator/JetX routes remain available for compatibility.
// IMPORTANT: the public AS Tech launch function is a public/demo mechanism;
// it must never be described as an AS Tech production real-money session.
router.get('/casino/games', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const ownGames = casinoIntegration.listGames().map(g => ({
      ...g,
      source: 'juanai',
      launchMode: 'real-money',
      realMoney: true,
    }));
    let asTechGames = [];
    try {
      const catalogue = await asTechApi.listAllGames({ force: req.query.refresh === '1', allPages: true });
      asTechGames = (catalogue?.games || []).map(g => ({
        id: String(g.id),
        gameId: String(g.id),
        name: String(g.name || g.title || g.id),
        title: String(g.title || g.name || g.id),
        category: String(g.category || 'casino'),
        thumbnail: g.image || null,
        image: g.image || null,
        gameUrl: null,
        status: 'active',
        rtp: null,
        providerCode: g.providerCode || null,
        source: 'as-tech',
        launchMode: 'demo',
        realMoney: false,
        demoLaunch: true,
        launchEndpoint: '/api/developer/casino/launch',
      }));
    } catch (e) {
      console.warn('[developer-api] AS Tech catalogue unavailable:', e.message);
    }
    const seen = new Set();
    const data = [...ownGames, ...asTechGames].filter(g => {
      const id = String(g.id || g.gameId);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return res.json({ success: true, count: data.length, data, sources: { juanai: ownGames.length, asTech: asTechGames.length } });
  }
  catch (e) { console.error('[developer-api] casino games:', e.message); return error(res, 500, 'INTERNAL_ERROR', 'Unable to load JuanAi casino games.'); }
});

router.get('/casino/state/:gameId', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const gameId = String(req.params.gameId || '').toLowerCase();
    if (!casinoIntegration.getGame(gameId)) return error(res, 404, 'RESOURCE_NOT_FOUND', 'Casino game not found.');
    const state = casino.getPublicState(gameId, req.developerCredential.apiKey, null);
    delete state.balance;
    delete state.bets;
    return res.json({ success: true, gameId, data: state, ...state });
  } catch (e) { return error(res, 500, 'INTERNAL_ERROR', 'Unable to load casino game state.'); }
});

router.get('/casino/players/:gameId', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const gameId = String(req.params.gameId || '').toLowerCase();
    if (!casinoIntegration.getGame(gameId)) return error(res, 404, 'RESOURCE_NOT_FOUND', 'Casino game not found.');
    return res.json({ success: true, data: casino.getPlayersView(gameId) });
  } catch (e) { return error(res, 500, 'INTERNAL_ERROR', 'Unable to load casino players.'); }
});

router.post('/casino/wallet/register', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const baseUrl = String(req.body?.baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(baseUrl)) return error(res, 400, 'INVALID_REQUEST', 'Wallet baseUrl must use HTTPS.');
    // The Developer API secret is also used as the HMAC secret for the
    // server-to-server wallet channel. It never leaves the JuanAi backend.
    await casinoIntegration.registerWallet(req.developerCredential.apiKey, baseUrl, req.developerSecret);
    return res.json({ success: true, registered: true, baseUrl });
  } catch (e) { console.error('[developer-api] wallet register:', e.message); return error(res, 500, 'INTERNAL_ERROR', 'Unable to register the casino wallet.'); }
});

router.get('/casino/balance', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) return error(res, 400, 'MISSING_PARAMETER', 'userId is required.');
    const data = await casinoIntegration.getBalance(req.developerCredential.apiKey, userId);
    return res.status(data?.success === false ? 502 : 200).json(data);
  } catch (e) { return error(res, 502, 'UPSTREAM_ERROR', 'Unable to load the player balance.'); }
});

router.post('/casino/bet', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const gameId = String(req.body?.gameId || '').toLowerCase();
    const slot = Number(req.body?.slot);
    const stake = Number(req.body?.stake);
    if (!userId || !gameId) return error(res, 400, 'MISSING_PARAMETER', 'userId and gameId are required.');
    if (![1, 2].includes(slot)) return error(res, 400, 'INVALID_REQUEST', 'slot must be 1 or 2.');
    if (!Number.isFinite(stake) || stake < 1 || stake > 50000) return error(res, 400, 'INVALID_REQUEST', 'stake must be between KES 1 and KES 50,000.');
    const result = await casinoIntegration.placeBet(req.developerCredential.apiKey, userId, gameId, slot, stake);
    return res.status(result?.success ? 200 : 400).json(result);
  } catch (e) { return error(res, 502, 'UPSTREAM_ERROR', 'Unable to place the casino bet.'); }
});

router.get('/casino/bet/:betId', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const result = await casinoIntegration.getBetResult(req.developerCredential.apiKey, req.params.betId);
    if (!result?.success) return error(res, 404, 'RESOURCE_NOT_FOUND', 'Bet not found.');
    const userId = String(req.query.userId || '').trim();
    if (userId && String(result.userId) !== userId) return error(res, 403, 'INSUFFICIENT_SCOPE', 'This bet does not belong to the specified user.');
    return res.json(result);
  } catch (e) { return error(res, 502, 'UPSTREAM_ERROR', 'Unable to load the casino bet.'); }
});

router.post('/casino/bet/:betId/cashout', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const existing = await casinoIntegration.getBetResult(req.developerCredential.apiKey, req.params.betId);
    if (!existing?.success) return error(res, 404, 'RESOURCE_NOT_FOUND', 'Bet not found.');
    if (!userId || String(existing.userId) !== userId) return error(res, 403, 'INSUFFICIENT_SCOPE', 'This bet does not belong to the specified user.');
    const result = await casinoIntegration.cashOut(req.developerCredential.apiKey, req.params.betId);
    return res.status(result?.success ? 200 : 400).json(result);
  } catch (e) { return error(res, 502, 'UPSTREAM_ERROR', 'Unable to cash out the casino bet.'); }
});

// Existing AS Tech Developer API endpoints remain available for other clients;
// SafariBet's JuanAi casino adapter does not use them.
router.get('/casino/providers', requireDeveloperApi('casino'), async (req, res) => {
  try { return res.json({ success: true, data: await asTechApi.listProviders({ force: req.query.refresh === '1' }) }); }
  catch (e) { console.error('[developer-api] casino providers:', e.message); return error(res, 502, 'UPSTREAM_ERROR', 'Unable to load casino providers.'); }
});
router.get('/casino/all-games', requireDeveloperApi('casino'), async (req, res) => {
  try { return res.json({ success: true, data: await asTechApi.listAllGames({ force: req.query.refresh === '1', allPages: true }) }); }
  catch (e) { console.error('[developer-api] casino all-games:', e.message); return error(res, 502, 'UPSTREAM_ERROR', 'Unable to load casino catalogue.'); }
});
// Universal launch endpoint for every game in the JuanAI Casino catalogue.
// AS Tech's public integration currently provides a demo launch URL; this
// endpoint deliberately does not pretend that a public demo is a real-money
// provider session. SafariBet only needs the JuanAI credential pair and never
// talks to AS Tech directly.
router.post('/casino/launch', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const gameId = String(req.body?.gameId || '').trim();
    if (!gameId) return error(res, 400, 'MISSING_PARAMETER', 'gameId is required.');

    const catalogue = await asTechApi.listAllGames({ force: false, allPages: true });
    const game = (catalogue.games || []).find(g => String(g.id) === gameId);
    if (!game) return error(res, 404, 'RESOURCE_NOT_FOUND', 'Casino game is not available in the JuanAI catalogue.');

    const data = await asTechApi.launchDemo(gameId);
    const launchUrl = data?.gameUrl || data?.url || data?.launchUrl || data?.game_url || null;
    return res.json({
      success: true,
      mode: 'as-tech-public',
      realMoney: false,
      launchUrl,
      gameUrl: launchUrl,
      game: {
        id: String(game.id),
        name: game.title || game.name || game.id,
        providerCode: game.providerCode || null,
        category: game.category || 'casino',
        image: game.image || null,
      },
      data,
    });
  } catch (e) {
    console.error('[developer-api] casino launch:', e.message);
    return error(res, 502, 'UPSTREAM_ERROR', 'Unable to launch the casino game.');
  }
});

// Backward-compatible alias.
router.post('/casino/demo-launch', requireDeveloperApi('casino'), async (req, res) => {
  try {
    if (!req.body?.gameId) return error(res, 400, 'MISSING_PARAMETER', 'gameId is required.');
    const data = await asTechApi.launchDemo(req.body.gameId);
    return res.json({ success: true, data, mode: 'as-tech-public', realMoney: false });
  } catch (e) { console.error('[developer-api] demo launch:', e.message); return error(res, 502, 'UPSTREAM_ERROR', 'Unable to launch the casino demo.'); }
});

// Do not expose a fake production wallet. A real-money AS Tech wallet bridge
// requires the authorized provider contract/callback specification and must
// be implemented against those signed callbacks. Returning 501 makes this
// boundary explicit instead of silently accepting money operations.
router.all('/casino/wallet/:operation', requireDeveloperApi('casino'), (req, res) => {
  return error(res, 501, 'PROVIDER_WALLET_NOT_CONFIGURED', `Production wallet operation '${req.params.operation}' requires an authorized upstream casino wallet integration.`);
});

module.exports = { router, requireDeveloperApi };
