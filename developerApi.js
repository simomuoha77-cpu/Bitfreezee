// JuanAi Developer API: product-scoped Football/Casino credentials.
// Existing Football routes are unchanged. Casino routes below expose only
// JuanAi's own Aviator/JetX real-money partner layer.
const express = require('express');
const db = require('./db');
const scheduler = require('./scheduler');
const casino = require('./casino');
const casinoIntegration = require('./casinoIntegration');
const userToken = require('./userToken');

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
// JuanAi's own real-money casino catalogue. The only games exposed are
// the server-authoritative Aviator and JetX engines in casinoIntegration.js.
// No external casino provider is required for this catalogue or launch.
router.get('/casino/games', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const ownGames = casinoIntegration.listGames();
    const data = [];
    for (const g of ownGames) {
      const image = await db.getSetting(`casino_game_image_${g.id}`);
      data.push({
        id: g.id,
        gameId: g.id,
        name: g.name,
        title: g.name,
        category: g.category,
        thumbnail: image || g.thumbnail || null,
        image: image || g.thumbnail || null,
        gameUrl: g.gameUrl || null,
        status: g.status || 'active',
        rtp: g.rtp == null ? null : g.rtp,
        providerCode: 'juanai',
        source: 'juanai',
        launchMode: 'real-money',
        realMoney: true,
        demoLaunch: false,
        launchEndpoint: '/api/developer/casino/launch'
      });
    }
    return res.json({ success: true, count: data.length, data, sources: { juanai: data.length } });
  } catch (e) {
    console.error('[developer-api] casino games:', e.message);
    return error(res, 500, 'INTERNAL_ERROR', 'Unable to load JuanAi casino games.');
  }
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

// Production casino launch. The caller is authenticated by the JuanAI
// Developer API credential and supplies the already-authenticated SafariBet
// userId. JuanAI signs a short-lived user token for its own Aviator/JetX
// engine and returns the real-money game URL. No external provider is used.
router.post('/casino/launch', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const gameId = String(req.body?.gameId || '').trim().toLowerCase();
    const userId = String(req.body?.userId || '').trim();
    const username = String(req.body?.username || userId).trim();
    if (!gameId) return error(res, 400, 'MISSING_PARAMETER', 'gameId is required.');
    if (!userId) return error(res, 400, 'MISSING_PARAMETER', 'userId is required.');
    const game = casinoIntegration.getGame(gameId);
    if (!game) return error(res, 404, 'RESOURCE_NOT_FOUND', 'Casino game is not available in the JuanAI catalogue.');
    if (!userToken.isConfigured()) return error(res, 503, 'USER_TOKEN_NOT_CONFIGURED', 'JUANAI_USER_TOKEN_SECRET is not configured.');

    // Read the real partner balance before issuing a playable session.
    // This does not create a JuanAI balance; SafariBet remains the source of truth.
    const balance = await casinoIntegration.getBalance(req.developerCredential.apiKey, userId);
    if (!balance?.success) return error(res, 502, 'WALLET_UNAVAILABLE', balance?.message || 'Unable to verify the player wallet.');

    const utoken = userToken.sign(userId);
    const separator = String(game.gameUrl || '').includes('?') ? '&' : '?';
    const launchUrl = `${game.gameUrl}${separator}key=${encodeURIComponent(req.developerCredential.apiKey)}&utoken=${encodeURIComponent(utoken)}`;
    const image = await db.getSetting(`casino_game_image_${gameId}`);
    return res.json({
      success: true,
      mode: 'real-money',
      realMoney: true,
      currency: 'KES',
      gameId,
      username,
      balance: Number(balance.balance ?? balance.main ?? 0),
      launchUrl,
      game: {
        id: game.id,
        gameId: game.id,
        name: game.name,
        category: game.category,
        thumbnail: image || game.thumbnail || null,
        image: image || game.thumbnail || null,
        launchMode: 'real-money',
        realMoney: true
      }
    });
  } catch (e) {
    console.error('[developer-api] casino launch:', e.message);
    return error(res, 502, 'UPSTREAM_ERROR', 'Unable to launch the casino game.');
  }
});

// Persistent casino artwork. Images are stored in MongoDB's settings
// collection as data URLs so the dashboard upload survives restarts and
// deployments. No external image URL is required.
router.get('/casino/images', requireDeveloperApi('casino'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    const out = {};
    for (const id of ['aviator', 'jetx']) out[id] = await db.getSetting(`casino_game_image_${id}`);
    return res.json({ success: true, images: out });
  } catch (e) { return error(res, 500, 'INTERNAL_ERROR', 'Unable to load casino images.'); }
});

module.exports = { router, requireDeveloperApi };
