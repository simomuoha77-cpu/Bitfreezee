// walletClient.js — lets JuanAi call a PARTNER's own wallet endpoints
// (debit / credit / balance) synchronously, so the partner's real balance
// stays the one and only source of truth for a game like Aviator.
//
// DIRECTION OF THE CALLS: JuanAi -> partner's server. This is the reverse
// of a traditional "webhook" (partner -> JuanAi push) on purpose — see
// casinoIntegration.js's header comment and the conversation that led
// here for the full reasoning. Short version: JuanAi needs a debit
// CONFIRMED before it will ever accept a bet, and a credit CONFIRMED
// before it will ever report a win — that only works if JuanAi makes the
// call and waits for a real synchronous response, not by trusting that a
// fire-and-forget push arrived and was processed correctly.
//
// AUTHENTICATION: HMAC-SHA256 request signing, not a plain shared key.
// A plain API key sent on every request is a standing liability — if it
// ever leaks (logs, a misconfigured proxy, a compromised box), whoever has
// it can call debit/credit forever until every party rotates it. With
// HMAC signing, the shared secret is NEVER transmitted; it only computes
// a signature locally. Each request is signed with:
//   signature = HMAC_SHA256(secret, `${method}\n${path}\n${timestamp}\n${bodyJson}`)
// sent as headers:
//   X-JuanAi-Timestamp: <unix ms>
//   X-JuanAi-Signature: <hex signature>
// The partner's server recomputes the same signature with the same
// shared secret and rejects the request if it doesn't match, or if the
// timestamp is outside a small tolerance window (replay protection — a
// captured request can't be resent later to double-credit/debit).
//
// PER-PARTNER CONFIG: each partner (identified by their JuanAi API key)
// needs their own wallet base URL + shared secret registered somewhere
// durable (this uses a simple in-memory registry for now — see
// registerPartnerWallet below; wire this to db.js/Mongo for persistence
// across restarts before relying on this in real production traffic).

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const db = require('./db'); // persists wallet configs to Mongo (same durability as API keys) so a restart doesn't silently disable real-money calls

// apiKey -> { baseUrl, secret }
// This Map is a fast in-memory CACHE of what's persisted in db.js — every
// bet/cashout call needs this lookup, so we avoid a database round-trip on
// the hot path. registerPartnerWallet() writes through to both the cache
// and db.js; getPartnerWallet() checks the cache first and falls back to
// a (rarer) db.js lookup + cache-fill on a miss, so a partner's wallet
// config keeps working immediately after a restart even before
// loadWalletsFromDb() has finished its startup pass.
const partnerWallets = new Map();

async function registerPartnerWallet(apiKey, baseUrl, secret) {
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  partnerWallets.set(apiKey, { baseUrl: cleanBaseUrl, secret });
  await db.saveWallet(apiKey, cleanBaseUrl, secret);
}

// Synchronous cache-only lookup, used inside the hot bet/cashout path.
function getPartnerWalletSync(apiKey) {
  return partnerWallets.get(apiKey) || null;
}

// Async lookup that falls back to db.js on a cache miss (e.g. right after
// a restart, before loadWalletsFromDb() has completed) and fills the
// cache so subsequent calls for the same apiKey hit the fast path.
async function getPartnerWallet(apiKey) {
  const cached = partnerWallets.get(apiKey);
  if (cached) return cached;
  const stored = await db.getWallet(apiKey);
  if (!stored) return null;
  const wallet = { baseUrl: stored.baseUrl, secret: stored.secret };
  partnerWallets.set(apiKey, wallet);
  return wallet;
}

// Call once at server startup to warm the cache from whatever's persisted
// in Mongo, so the very first bet after a restart doesn't need to wait on
// an extra db.js round-trip.
async function loadWalletsFromDb() {
  try {
    const all = await db.getAllWallets();
    all.forEach(w => partnerWallets.set(w.apiKey, { baseUrl: w.baseUrl, secret: w.secret }));
    console.log(`[walletClient] Loaded ${all.length} partner wallet config(s) from storage.`);
  } catch (e) {
    console.error('[walletClient] Failed to preload wallet configs: ' + e.message);
  }
}

function sign(secret, method, path, timestamp, bodyJson) {
  const payload = `${method}\n${path}\n${timestamp}\n${bodyJson}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Small dependency-free HTTPS/HTTP JSON request helper (avoids adding a
// new package dependency just for this). Has a hard timeout — a wallet
// call must never hang a bet/cashout request indefinitely.
function requestJson(method, urlStr, headers, bodyObj, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(new Error('Invalid wallet URL: ' + urlStr)); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const bodyJson = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyJson),
      }, headers),
      timeout: timeoutMs,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (e) { json = null; }
        resolve({ statusCode: res.statusCode, body: json, raw: data });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Wallet request timed out')); });
    req.on('error', reject);
    if (bodyJson) req.write(bodyJson);
    req.end();
  });
}

// Makes a signed call to path (e.g. '/api/casino/debit') on the partner's
// registered wallet base URL. Returns { success, ...partnerResponseBody }
// on a clean 2xx response, or { success: false, message } on any failure
// (network error, timeout, non-2xx, partner explicitly returned success:false).
async function callPartnerWallet(apiKey, path, bodyObj) {
  const wallet = await getPartnerWallet(apiKey);
  if (!wallet) return { success: false, message: 'No wallet integration registered for this API key' };

  const method = 'POST';
  const timestamp = Date.now().toString();
  const bodyJson = JSON.stringify(bodyObj);
  const signature = sign(wallet.secret, method, path, timestamp, bodyJson);

  let res;
  try {
    res = await requestJson(method, wallet.baseUrl + path, {
      'X-JuanAi-Timestamp': timestamp,
      'X-JuanAi-Signature': signature,
    }, bodyObj);
  } catch (e) {
    return { success: false, message: 'Wallet call failed: ' + e.message };
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { success: false, message: (res.body && res.body.message) || `Wallet endpoint returned HTTP ${res.statusCode}` };
  }
  if (!res.body || res.body.success !== true) {
    return { success: false, message: (res.body && res.body.message) || 'Wallet endpoint did not confirm success' };
  }
  return res.body;
}

// GET requests (balance) are also signed the same way, over an empty body,
// so the partner can verify these calls too, not just the money-moving ones.
async function callPartnerWalletGet(apiKey, path) {
  const wallet = await getPartnerWallet(apiKey);
  if (!wallet) return { success: false, message: 'No wallet integration registered for this API key' };

  const method = 'GET';
  const timestamp = Date.now().toString();
  const signature = sign(wallet.secret, method, path, timestamp, '');

  let res;
  try {
    res = await requestJson(method, wallet.baseUrl + path, {
      'X-JuanAi-Timestamp': timestamp,
      'X-JuanAi-Signature': signature,
    }, null);
  } catch (e) {
    return { success: false, message: 'Wallet call failed: ' + e.message };
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { success: false, message: (res.body && res.body.message) || `Wallet endpoint returned HTTP ${res.statusCode}` };
  }
  return res.body || { success: false, message: 'Empty response from wallet endpoint' };
}

// ── High-level wallet operations used by casinoIntegration.js ──────────

async function debit(apiKey, userId, amount, roundId) {
  return callPartnerWallet(apiKey, '/api/casino/debit', { userId, amount, roundId });
}

async function credit(apiKey, userId, amount, roundId) {
  return callPartnerWallet(apiKey, '/api/casino/credit', { userId, amount, roundId });
}

async function getBalance(apiKey, userId) {
  return callPartnerWalletGet(apiKey, `/api/casino/balance?userId=${encodeURIComponent(userId)}`);
}

module.exports = { registerPartnerWallet, getPartnerWallet, getPartnerWalletSync, loadWalletsFromDb, debit, credit, getBalance, sign };
