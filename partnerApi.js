// partnerApi.js — separate JuanAI Casino API and Game API credentials.
//
// Each betting-site integration gets its own API key + HMAC secret.
// Casino credentials (jcas_...) can never authenticate Game API routes,
// and Game credentials (jgam_...) can never authenticate Casino API routes.
//
// The secret is used to sign requests; it is not sent as a plain credential.
// Signature: HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
// Headers:
//   X-JuanAI-Casino-Key / X-JuanAI-Game-Key
//   X-JuanAI-Timestamp
//   X-JuanAI-Signature

const crypto = require('crypto');
const db = require('./db');

const WINDOW_SECONDS = 300;

function randomToken(prefix, bytes = 24) {
  return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;
}

function createCredentials(type, name) {
  const casino = type === 'casino';
  return {
    id: crypto.randomUUID(),
    type,
    name: String(name || (casino ? 'Unnamed casino integration' : 'Unnamed game integration')).slice(0, 100),
    apiKey: randomToken(casino ? 'jcas_' : 'jgam_'),
    secret: randomToken(casino ? 'jcs_' : 'jgs_', 32),
    active: true,
    createdAt: new Date().toISOString(),
  };
}

function signature(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody || ''}`)
    .digest('hex');
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

async function authenticate(req, type) {
  const keyHeader = type === 'casino' ? 'x-juanai-casino-key' : 'x-juanai-game-key';
  const key = req.get(keyHeader) || '';
  if (!key) return { ok: false, status: 401, message: 'Missing JuanAI API key' };

  const expectedPrefix = type === 'casino' ? 'jcas_' : 'jgam_';
  if (!key.startsWith(expectedPrefix)) {
    return { ok: false, status: 401, message: `Invalid ${type} API key` };
  }

  const credential = await db.getPartnerApiCredential(key, type);
  if (!credential || !credential.active) {
    return { ok: false, status: 401, message: 'Invalid or revoked JuanAI API key' };
  }

  const timestamp = req.get('x-juanai-timestamp') || '';
  const supplied = req.get('x-juanai-signature') || '';
  if (!/^\d+$/.test(timestamp) || !supplied) {
    return { ok: false, status: 401, message: 'Missing request signature' };
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > WINDOW_SECONDS) {
    return { ok: false, status: 401, message: 'Request timestamp expired' };
  }

  const expected = signature(credential.secret, timestamp, req.rawBody ? req.rawBody.toString() : '');
  if (!safeEqual(expected, supplied)) {
    return { ok: false, status: 401, message: 'Invalid request signature' };
  }

  return { ok: true, credential };
}

function requireCasinoApi(req, res, next) {
  authenticate(req, 'casino').then(result => {
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    req.partnerApiKey = result.credential.apiKey;
    req.partnerCredential = result.credential;
    next();
  }).catch(next);
}

function requireGameApi(req, res, next) {
  authenticate(req, 'game').then(result => {
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });
    req.partnerApiKey = result.credential.apiKey;
    req.partnerCredential = result.credential;
    next();
  }).catch(next);
}

module.exports = {
  createCredentials,
  requireCasinoApi,
  requireGameApi,
  signature,
  WINDOW_SECONDS,
};
