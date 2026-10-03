// casinoApiPro.js — server-side Casino API Pro integration.
//
// IMPORTANT:
// - Casino API Pro credentials NEVER go to the browser.
// - Sandbox/live are selected by the credential prefix (ck_test_ / ck_live_).
// - The game provider calls our wallet endpoints for balance/debit/credit/
//   refund/rollback. SafariBet remains the real wallet when its partner wallet
//   is configured.
// - This module is intentionally separate from casino.js and the existing
//   Aviator/JetX implementation. Do not mix the two engines.

const https = require('https');

const BASE_URL = (process.env.CASINO_API_PRO_BASE_URL || 'https://api.casinoapipro.com/v1').replace(/\/$/, '');
const API_KEY = process.env.CASINO_API_PRO_KEY || '';
const API_SECRET = process.env.CASINO_API_PRO_SECRET || '';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function isConfigured() {
  return !!(API_KEY && API_SECRET);
}

function environment() {
  if (API_KEY.startsWith('ck_live_')) return 'live';
  if (API_KEY.startsWith('ck_test_')) return 'sandbox';
  return 'unknown';
}

function requestJson(method, urlString, headers = {}, body = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (e) {
      return reject(new Error('Invalid Casino API Pro URL'));
    }

    const bodyText = body == null ? '' : JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: {
        Accept: 'application/json',
        ...(body != null ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
        } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) {}
        resolve({ statusCode: res.statusCode, body: parsed, raw: data });
      });
    });

    req.on('timeout', () => req.destroy(new Error('Casino API Pro request timed out')));
    req.on('error', reject);
    if (body != null) req.write(bodyText);
    req.end();
  });
}

async function getAccessToken() {
  if (!isConfigured()) {
    throw new Error('CASINO_API_PRO_KEY and CASINO_API_PRO_SECRET are not configured');
  }

  // Refresh a little before actual expiry.
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 30000) return cachedToken;

  const response = await requestJson(
    'POST',
    `${BASE_URL}/auth/token`,
    {},
    { api_key: API_KEY, api_secret: API_SECRET }
  );

  if (response.statusCode < 200 || response.statusCode >= 300 || !response.body?.access_token) {
    const code = response.body?.error?.code || response.body?.code || 'AUTH_FAILED';
    throw new Error(`Casino API Pro authentication failed: ${code}`);
  }

  cachedToken = response.body.access_token;
  const expiresIn = Number(response.body.expires_in || 3600);
  cachedTokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
  return cachedToken;
}

async function apiRequest(method, path, body = null) {
  const token = await getAccessToken();
  let response = await requestJson(
    method,
    `${BASE_URL}${path}`,
    { Authorization: `Bearer ${token}` },
    body
  );

  // One automatic token refresh on an expired/revoked access token.
  if (response.statusCode === 401) {
    cachedToken = null;
    cachedTokenExpiresAt = 0;
    const freshToken = await getAccessToken();
    response = await requestJson(
      method,
      `${BASE_URL}${path}`,
      { Authorization: `Bearer ${freshToken}` },
      body
    );
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const err = response.body?.error || response.body || {};
    const code = err.code || err.error_code || `HTTP_${response.statusCode}`;
    const message = err.message || 'Casino API Pro request failed';
    const e = new Error(`${code}: ${message}`);
    e.statusCode = response.statusCode;
    e.providerBody = response.body;
    throw e;
  }

  return response.body;
}


function extractAccountCurrencies(data) {
  const candidates = [
    data && data.currencies,
    data && data.data && data.data.currencies,
    data && data.games && data.games.currencies,
    Array.isArray(data) && data.currencies,
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value.map(v => String(v).toUpperCase()).filter(Boolean);
    }
  }
  return null;
}

async function ensureCurrency(currency) {
  const wanted = String(currency || '').toUpperCase();
  if (!wanted) throw new Error('currency is required');

  const games = await apiRequest('GET', '/games');
  const current = extractAccountCurrencies(games);
  if (current && current.includes(wanted)) return current;

  // The provider's PATCH replaces the whole list, so never guess an existing
  // currency. If GET /games does not expose the list in this account/version,
  // use an explicit env list supplied by the operator.
  const configured = String(process.env.CASINO_API_PRO_ACCOUNT_CURRENCIES || '')
    .split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
  const base = current || configured;
  if (!base.length) {
    const e = new Error('KES is not enabled on Casino API Pro. Set CASINO_API_PRO_ACCOUNT_CURRENCIES to the full currency list for the account (for example KES,USD), then restart JuanAI.');
    e.code = 'CURRENCY_CONFIGURATION_REQUIRED';
    e.statusCode = 502;
    throw e;
  }

  const merged = Array.from(new Set([...base, wanted]));
  await apiRequest('PATCH', '/business', { currencies: merged });
  return merged;
}

async function listGames() {
  return apiRequest('GET', '/games');
}

async function createSession({ gameId, playerId, currency, ttlSeconds, playerName }) {
  if (!gameId) throw new Error('gameId is required');
  if (!playerId) throw new Error('playerId is required');
  if (!currency) throw new Error('currency is required');

  const sessionCurrency = String(currency).toUpperCase();
  if (String(process.env.CASINO_API_PRO_AUTO_ENABLE_CURRENCY || 'true').toLowerCase() === 'true') {
    await ensureCurrency(sessionCurrency);
  }

  const body = {
    game_id: String(gameId),
    player_id: String(playerId),
    currency: sessionCurrency,
  };
  if (ttlSeconds != null) body.ttl_seconds = Number(ttlSeconds);
  if (playerName) body.player_name = String(playerName).slice(0, 40);

  return apiRequest('POST', '/sessions', body);
}

async function getSession(sessionId) {
  if (!sessionId) throw new Error('sessionId is required');
  return apiRequest('GET', `/sessions/${encodeURIComponent(sessionId)}`);
}

async function closeSession(sessionId) {
  if (!sessionId) throw new Error('sessionId is required');
  return apiRequest('POST', `/sessions/${encodeURIComponent(sessionId)}/close`);
}

module.exports = {
  isConfigured,
  environment,
  getAccessToken,
  listGames,
  ensureCurrency,
  createSession,
  getSession,
  closeSession,
};
