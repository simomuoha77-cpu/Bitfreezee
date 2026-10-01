// casinoApiProWallet.js — Casino API Pro -> JuanAi -> SafariBet wallet bridge.
//
// Casino API Pro calls the operator wallet. In our deployment JuanAi is the
// integration layer, while SafariBet remains the source of truth for the
// player's balance.
//
// The partner wallet selected by CASINO_API_PRO_PARTNER_API_KEY must already
// be registered through the existing /internal/wallet admin endpoint.
//
// Casino API Pro's default wallet contract:
//   POST /wallet/balance
//   POST /wallet/debit
//   POST /wallet/credit
//   POST /wallet/refund
//   POST /wallet/rollback
//
// HMAC authentication is supported exactly as documented by Casino API Pro:
// hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`)) in x-signature and
// Unix-seconds timestamp in x-timestamp.

const crypto = require('crypto');
const wallet = require('./walletClient');

function configured() {
  return !!process.env.CASINO_API_PRO_PARTNER_API_KEY;
}

function verifyHmac(req) {
  const mode = (process.env.CASINO_API_PRO_WALLET_AUTH || 'HMAC_SIGNATURE').toUpperCase();
  if (mode === 'NONE') {
    return process.env.CASINO_API_PRO_ALLOW_UNAUTH_WALLET === 'true';
  }

  if (mode !== 'HMAC_SIGNATURE') {
    // This adapter intentionally supports the secure documented mode only.
    return false;
  }

  const secret = process.env.CASINO_API_PRO_WALLET_HMAC_SECRET || '';
  if (!secret || !req.rawBody) return false;

  const timestamp = req.get('x-timestamp');
  const signature = req.get('x-signature');
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;

  // Reject stale/replayed requests.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${req.rawBody.toString()}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function partnerKey() {
  return process.env.CASINO_API_PRO_PARTNER_API_KEY || '';
}

function amount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be a positive number');
  return n;
}

function required(body, fields) {
  for (const field of fields) {
    if (body[field] == null || body[field] === '') {
      const e = new Error(`${field} is required`);
      e.code = 'invalid_request';
      throw e;
    }
  }
}

function providerError(res, err) {
  const code = err?.code || 'invalid_request';
  const status =
    code === 'insufficient_funds' ? 402 :
    code === 'player_not_found' || code === 'player_blocked' ? 403 :
    code === 'currency_mismatch' ? 422 :
    code === 'transaction_not_found' ? 404 :
    code === 'already_reversed' ? 409 : 502;

  return res.status(status).json({
    error_code: code,
    message: err?.message || 'Wallet request failed',
  });
}

async function balance(req, res) {
  try {
    required(req.body || {}, ['playerId', 'currency']);
    const result = await wallet.getBalance(partnerKey(), String(req.body.playerId));
    if (!result.success) {
      const e = new Error(result.message || 'Unable to read wallet');
      e.code = 'player_not_found';
      throw e;
    }
    return res.json({
      balance: String(result.balance ?? '0'),
      currency: String(req.body.currency).toUpperCase(),
    });
  } catch (e) {
    return providerError(res, e);
  }
}

async function debit(req, res) {
  try {
    required(req.body || {}, ['transactionId', 'playerId', 'amount', 'currency']);
    const result = await wallet.debit(
      partnerKey(),
      String(req.body.playerId),
      amount(req.body.amount),
      String(req.body.roundId || req.body.transactionId),
      String(req.body.gameId || 'casino-api-pro')
    );
    if (!result.success) {
      const e = new Error(result.message || 'Debit rejected');
      e.code = result.code || 'insufficient_funds';
      throw e;
    }
    return res.json({
      balance: String(result.balance ?? '0'),
      currency: String(req.body.currency).toUpperCase(),
      reference: String(req.body.transactionId),
      ...(result.duplicate ? { duplicate: true } : {}),
    });
  } catch (e) {
    return providerError(res, e);
  }
}

async function credit(req, res) {
  try {
    required(req.body || {}, ['transactionId', 'playerId', 'amount', 'currency']);
    const result = await wallet.credit(
      partnerKey(),
      String(req.body.playerId),
      amount(req.body.amount),
      String(req.body.roundId || req.body.transactionId),
      String(req.body.gameId || 'casino-api-pro')
    );
    if (!result.success) {
      const e = new Error(result.message || 'Credit rejected');
      e.code = result.code || 'invalid_request';
      throw e;
    }
    return res.json({
      balance: String(result.balance ?? '0'),
      currency: String(req.body.currency).toUpperCase(),
      reference: String(req.body.transactionId),
      ...(result.duplicate ? { duplicate: true } : {}),
    });
  } catch (e) {
    return providerError(res, e);
  }
}

async function refund(req, res) {
  try {
    required(req.body || {}, ['transactionId', 'referenceTransactionId', 'playerId', 'amount', 'currency']);
    const result = await wallet.refund(
      partnerKey(),
      String(req.body.playerId),
      amount(req.body.amount),
      String(req.body.roundId || req.body.transactionId),
      String(req.body.gameId || 'casino-api-pro'),
      String(req.body.referenceTransactionId)
    );
    if (!result.success) {
      const e = new Error(result.message || 'Refund rejected');
      e.code = result.code || 'transaction_not_found';
      throw e;
    }
    return res.json({
      balance: String(result.balance ?? '0'),
      currency: String(req.body.currency).toUpperCase(),
      reference: String(req.body.transactionId),
      ...(result.duplicate ? { duplicate: true } : {}),
    });
  } catch (e) {
    return providerError(res, e);
  }
}

async function rollback(req, res) {
  try {
    required(req.body || {}, ['transactionId', 'referenceTransactionId', 'playerId', 'amount', 'currency']);
    const result = await wallet.rollback(
      partnerKey(),
      String(req.body.playerId),
      amount(req.body.amount),
      String(req.body.roundId || req.body.transactionId),
      String(req.body.gameId || 'casino-api-pro'),
      String(req.body.referenceTransactionId)
    );
    if (!result.success) {
      const e = new Error(result.message || 'Rollback rejected');
      e.code = result.code || 'transaction_not_found';
      throw e;
    }
    return res.json({
      balance: String(result.balance ?? '0'),
      currency: String(req.body.currency).toUpperCase(),
      reference: String(req.body.transactionId),
      ...(result.duplicate ? { duplicate: true } : {}),
    });
  } catch (e) {
    return providerError(res, e);
  }
}

function authMiddleware(req, res, next) {
  if (!configured()) {
    return res.status(503).json({ error_code: 'wallet_not_configured' });
  }
  if (!verifyHmac(req)) {
    return res.status(401).json({ error_code: 'unauthorized' });
  }
  next();
}

module.exports = {
  authMiddleware,
  balance,
  debit,
  credit,
  refund,
  rollback,
};
