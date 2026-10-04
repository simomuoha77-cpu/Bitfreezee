// JuanAi Developer API: product-scoped Football/Casino credentials.
// This layer is additive: existing /api/* routes and legacy API keys remain
// untouched for backward compatibility.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const scheduler = require('./scheduler');
const asTechApi = require('./asTechApi');

const router = express.Router();
const WINDOW_MS = Number(process.env.DEVELOPER_API_RATE_WINDOW_MS || 60_000);
const DEFAULT_LIMIT = Number(process.env.DEVELOPER_API_RATE_LIMIT || 120);
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
      return rateLimit(req, res, next);
    } catch (e) {
      console.error('[developer-api] auth failed:', e.message);
      return error(res, 500, 'INTERNAL_ERROR', 'Unable to authenticate the API request.');
    }
  };
}

// Football API: exposes JuanAi-normalized fixture data, not upstream provider credentials.
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

// Casino API: these call the existing AS Tech integration; no provider credentials are exposed.
router.get('/casino/providers', requireDeveloperApi('casino'), async (req, res) => {
  try { return res.json({ success: true, data: await asTechApi.listProviders({ force: req.query.refresh === '1' }) }); }
  catch (e) { console.error('[developer-api] casino providers:', e.message); return error(res, 502, 'UPSTREAM_ERROR', 'Unable to load casino providers.'); }
});

router.get('/casino/games', requireDeveloperApi('casino'), async (req, res) => {
  try {
    const providerCode = String(req.query.providerCode || '').trim();
    const search = String(req.query.search || '');
    const page = Number(req.query.page || 1);
    const data = providerCode
      ? await asTechApi.listProviderGames(providerCode, { search, page, force: req.query.refresh === '1' })
      : await asTechApi.listAllGames({ force: req.query.refresh === '1', allPages: true });
    return res.json({ success: true, data });
  } catch (e) { console.error('[developer-api] casino games:', e.message); return error(res, 502, 'UPSTREAM_ERROR', 'Unable to load casino games.'); }
});

router.get('/casino/all-games', requireDeveloperApi('casino'), async (req, res) => {
  try { return res.json({ success: true, data: await asTechApi.listAllGames({ force: req.query.refresh === '1', allPages: true }) }); }
  catch (e) { return error(res, 502, 'UPSTREAM_ERROR', 'Unable to load casino catalogue.'); }
});

router.post('/casino/demo-launch', requireDeveloperApi('casino'), async (req, res) => {
  try {
    if (!req.body?.gameId) return error(res, 400, 'MISSING_PARAMETER', 'gameId is required.');
    const data = await asTechApi.launchDemo(req.body.gameId);
    return res.json({ success: true, data, mode: 'demo' });
  } catch (e) { console.error('[developer-api] demo launch:', e.message); return error(res, 502, 'UPSTREAM_ERROR', 'Unable to launch the casino demo.'); }
});

// Explicitly do not fake production wallet endpoints. The existing wallet bridge remains
// the source of truth for current integrations; these routes can be added when production
// provider callbacks are actually implemented and tested.
router.all('/casino/wallet/:operation', requireDeveloperApi('casino'), (req, res) => {
  return error(res, 501, 'NOT_IMPLEMENTED', `Production wallet operation '${req.params.operation}' is not implemented in this build.`);
});

module.exports = { router, requireDeveloperApi };
