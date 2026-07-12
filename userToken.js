// userToken.js — verifies signed per-user identity tokens for the Aviator
// game, so a betting site's real logged-in users each get their own
// isolated free-play balance, WITHOUT trusting anything the browser itself
// claims about who it is.
//
// THE PROBLEM THIS SOLVES:
// If a "user id" were just a value the browser makes up and sends (e.g.
// something generated in localStorage), anyone could open devtools and set
// it to whatever they want — a fresh id for infinite free balances, or
// someone else's id to mess with their balance. That's not an identity,
// it's a label the user fully controls.
//
// THE FIX:
// The betting site's OWN backend (which already knows who is really
// logged in) signs a token using a secret ONLY it and JuanAi share
// (JUANAI_USER_TOKEN_SECRET). The browser just carries that token along —
// it can't forge a valid signature for a user id it wasn't given, because
// it doesn't have the secret. JuanAi verifies the signature server-side
// before trusting the user id inside it.
//
// TOKEN FORMAT: "<userId>.<expiryUnixMs>.<hexHmac>"
//   hexHmac = HMAC-SHA256(secret, `${userId}.${expiryUnixMs}`)
// Short-lived (see MAX_TOKEN_AGE_MS) so a leaked/old token can't be replayed
// forever.
//
// FREE-PLAY FALLBACK: if no secret is configured (JUANAI_USER_TOKEN_SECRET
// unset) OR no token is supplied, we fall back to keying sessions by API
// key alone — same behavior as before, clearly less isolated between
// users, but doesn't hard-break existing integrations that haven't wired
// up signed tokens yet. Log this so it's visible in ops, not silent.

const crypto = require('crypto');

const SECRET = process.env.JUANAI_USER_TOKEN_SECRET || '';
const MAX_TOKEN_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours — long enough for a session, short enough to limit replay value

function sign(userId, ttlMs = MAX_TOKEN_AGE_MS) {
  if (!SECRET) throw new Error('JUANAI_USER_TOKEN_SECRET is not configured');
  const expiry = Date.now() + ttlMs;
  const payload = `${userId}.${expiry}`;
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

// Returns the verified userId string, or null if missing/invalid/expired.
function verify(token) {
  if (!token || !SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [userId, expiryStr, mac] = parts;
  const expiry = Number(expiryStr);
  if (!userId || !Number.isFinite(expiry)) return null;
  if (Date.now() > expiry) return null; // expired — must be re-issued by the site's backend
  const expectedPayload = `${userId}.${expiryStr}`;
  const expectedMac = crypto.createHmac('sha256', SECRET).update(expectedPayload).digest('hex');
  // Constant-time compare — avoids leaking timing info about how many
  // leading hex chars matched, which could otherwise help an attacker
  // guess their way to a valid signature byte-by-byte.
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(expectedMac, 'hex');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return userId;
}

module.exports = { sign, verify, isConfigured: () => !!SECRET };
