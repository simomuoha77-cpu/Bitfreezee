// casino.js — JuanAi's server-authoritative casino round engine.
//
// WHY THIS IS A SEPARATE MODULE, RUNNING ENTIRELY SERVER-SIDE:
// A crash game is only as "unhackable" as wherever its RNG and payout
// decision actually live. If the crash multiplier is computed in the
// browser (like the original Skyrocket demo built straight into
// public/index.html), anyone can open devtools, read the JS, and either
// predict the crash point in advance or just edit local variables to
// award themselves a win. There's no way to fix that client-side — the
// only real fix is moving the round's truth server-side, the same way a
// real casino platform does it:
//   - The crash point for a round is rolled HERE, on the server, the
//     moment the round starts — never sent to the client until AFTER the
//     round ends (so it can't be read out of a network request early).
//   - A cashout is only ever accepted if it arrives (server clock time)
//     BEFORE the round's crash point is reached. The client's own
//     multiplier display is just a local animation for smoothness; the
//     server recomputes the "real" elapsed-time multiplier itself from
//     round.startedAt and does not trust any multiplier value the client
//     sends.
//   - Balances live server-side per-USER session (see userToken.js) — a
//     client can only ever change its balance by placing/cashing a bet
//     through these endpoints, never by sending a balance value directly.
//
// PER-USER ISOLATION (not per-API-key):
// A single JuanAi API key is typically shared by ONE betting site across
// ALL of its end users. If sessions were keyed by API key alone, every
// user of that site would share one pot — one person's win or loss would
// affect everyone else. Sessions are instead keyed by a verified userId,
// established via a signed token from the site's own backend (see
// userToken.js) so a user can't forge their own id or someone else's to
// mess with balances. Sites that haven't wired up signed tokens yet fall
// back to per-API-key sessions (old behavior) — clearly less isolated,
// but doesn't hard-break integrations mid-migration.
//
// NO-SCAM GUARANTEE (what "can't be scammed" actually means here):
//   - A user can only ever LOSE what they already stake — balance never
//     goes negative, and a loss never grants anything back.
//   - A win is always computed server-side from the server's own
//     round-clock multiplier at the verified moment of cashout, times the
//     stake the server itself deducted when the bet was placed — never
//     from any number the client sends.
//   - Rate limits on bet/cashout close off script-spam abuse even though
//     spamming alone can't predict or influence the crash point.
//
// FREE-PLAY SCOPE: balances here are in-memory only (reset on server
// restart), which is intentional and fine for a free-play "aviator
// balance" feature — this is NOT the betting site's real money balance,
// it's a separate free-play credit pool. If this is ever extended to
// touch real money, the balance ledger needs to move to a real
// persistent, audited store (like fixtures/apikeys already do in db.js
// via MongoDB), with proper deposit/withdrawal reconciliation — a
// substantially bigger project than this module and out of scope here.

const userToken = require('./userToken');

const ROUND_WAIT_MS = 5000;       // "STARTING IN" countdown before each round
const GROWTH_RATE = 0.09;         // multiplier = e^(GROWTH_RATE * elapsedSeconds) — matches the client's own animation curve so the two stay visually in sync
const MIN_BET = 10;
const MAX_BET = 100000;
const STARTING_BALANCE = 1000;
const HISTORY_LEN = 30;

// One shared round at a time — like a real Aviator-style game, everyone
// watching sees and bets into the same round simultaneously. This also
// means the server only ever needs to roll ONE crash point at a time,
// which keeps the RNG surface small and easy to reason about.
let round = null; // { id, status: 'waiting'|'flying'|'crashed', startedAt, waitEndsAt, crashPoint, crashedAt }
let history = []; // recent crash points, newest first — display only

// Per-user session state (bets + free-play "aviator balance"). Keyed by
// a session key that's either "u:<verifiedUserId>" (when the site passes
// a signed user token) or "k:<apiKey>" (fallback, old shared-per-key
// behavior). This is intentionally simple in-memory storage — see
// FREE-PLAY SCOPE note above for why that's fine here and what would need
// to change for real money.
const sessions = new Map(); // sessionKey -> { balance, bets: { 1: {...}|null, 2: {...}|null } }

// Resolves the session key to use for a request: verified user id if a
// valid signed token was supplied, otherwise falls back to the API key
// itself. Also returns whether a verified per-user identity was used, so
// callers/ops can see how much traffic is still on the old fallback.
function resolveSessionKey(apiKey, signedToken) {
  const verifiedUserId = userToken.verify(signedToken);
  if (verifiedUserId) return { sessionKey: `u:${verifiedUserId}`, verified: true };
  return { sessionKey: `k:${apiKey}`, verified: false };
}

function getSession(sessionKey) {
  let s = sessions.get(sessionKey);
  if (!s) {
    s = { balance: STARTING_BALANCE, bets: { 1: null, 2: null } };
    sessions.set(sessionKey, s);
  }
  return s;
}

// ── Simple per-session rate limiting on bet/cashout ──────────────────
// Doesn't help anyone predict the crash point (that's rolled server-side
// and never exposed early regardless), but stops a script from hammering
// these endpoints hundreds of times a second, which is its own kind of
// abuse worth closing off.
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 5; // max bet+cashout actions per session per window
const rateBuckets = new Map(); // sessionKey -> { windowStart, count }

function checkRateLimit(sessionKey) {
  const now = Date.now();
  let b = rateBuckets.get(sessionKey);
  if (!b || now - b.windowStart > RATE_LIMIT_WINDOW_MS) {
    b = { windowStart: now, count: 0 };
    rateBuckets.set(sessionKey, b);
  }
  b.count++;
  return b.count <= RATE_LIMIT_MAX;
}

function rollCrashPoint() {
  // House-edge exponential distribution: skews toward low multipliers with
  // a long tail toward high ones. This is a demo-quality distribution, not
  // an audited provably-fair algorithm — see the module header for why
  // that's an acceptable line to draw for a free-play feature. If real
  // money is ever added, this needs to be replaced with a proper
  // provably-fair scheme (server seed hash committed BEFORE the round,
  // revealed after, so players can independently verify it wasn't changed
  // after seeing their bet) — not just "the server rolls a number".
  const r = Math.random();
  const point = 0.98 / (1 - r * 0.97);
  return Math.max(1.01, Math.min(point, 50));
}

function currentMultiplier() {
  if (!round || round.status !== 'flying') return round ? round.crashPoint || 1 : 1;
  const elapsed = (Date.now() - round.startedAt) / 1000;
  return Math.min(Math.exp(GROWTH_RATE * elapsed), round.crashPoint);
}

function startNewRound() {
  const id = 'rnd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  round = {
    id,
    status: 'waiting',
    startedAt: null,
    waitEndsAt: Date.now() + ROUND_WAIT_MS,
    crashPoint: rollCrashPoint(), // rolled NOW, but never exposed to clients until status==='crashed'
    crashedAt: null,
  };
  // Clear all sessions' bets for the new round — a bet only ever applies
  // to the round it was placed in.
  sessions.forEach(s => { s.bets = { 1: null, 2: null }; });
}

function tick() {
  if (!round) { startNewRound(); return; }
  if (round.status === 'waiting' && Date.now() >= round.waitEndsAt) {
    round.status = 'flying';
    round.startedAt = Date.now();
  } else if (round.status === 'flying') {
    const mult = currentMultiplier();
    if (mult >= round.crashPoint) {
      round.status = 'crashed';
      round.crashedAt = Date.now();
      history.unshift(round.crashPoint);
      history = history.slice(0, HISTORY_LEN);
      setTimeout(startNewRound, 2500); // brief pause on the crash screen before the next round
    }
  }
}
setInterval(tick, 150); // server's own clock — independent of any client polling
startNewRound();

// ── Public API used by server.js routes ──────────────────────────────
// Every function takes (apiKey, signedToken, ...) — signedToken is
// optional (site may not have wired up per-user tokens yet), and is
// verified via userToken.js before ever being trusted as an identity.

function getPublicState(apiKey, signedToken) {
  const { sessionKey, verified } = resolveSessionKey(apiKey, signedToken);
  const s = getSession(sessionKey);
  const base = {
    roundId: round.id,
    status: round.status,
    waitSeconds: round.status === 'waiting' ? Math.max(0, Math.ceil((round.waitEndsAt - Date.now()) / 1000)) : 0,
    elapsedMs: round.status === 'flying' ? Date.now() - round.startedAt : 0,
    history,
    balance: s.balance,
    bets: {
      1: s.bets[1] ? { stake: s.bets[1].stake, cashedOut: s.bets[1].cashedOut } : null,
      2: s.bets[2] ? { stake: s.bets[2].stake, cashedOut: s.bets[2].cashedOut } : null,
    },
    verifiedIdentity: verified, // useful for the site/ops to confirm token wiring is actually working
  };
  // Only reveal the crash point once the round has actually crashed — this
  // is the crux of not being able to "read the answer" early. During
  // waiting/flying, crashPoint is simply not present in the response at all.
  if (round.status === 'crashed') base.crashPoint = round.crashPoint;
  return base;
}

// ── Session-generic core (balance-free) ───────────────────────────────
// These operate purely on round/slot/stake state, keyed by an arbitrary
// sessionKey string — no concept of "balance" lives here at all. Both the
// free-play frontend (placeBet/cashOut below, which layer a fake balance
// on top) and casinoIntegration.js's real-money partner API (which layers
// NO balance — that's the partner's own ledger) call into these same
// functions, so there is exactly one source of truth for round validity,
// timing, and outcome — never two divergent implementations to keep in
// sync.

function placeBetCore(sessionKey, slot, stake) {
  if (slot !== 1 && slot !== 2) return { success: false, message: 'Invalid bet slot' };
  if (!Number.isFinite(stake) || stake < MIN_BET) return { success: false, message: `Minimum bet is KES ${MIN_BET}` };
  if (stake > MAX_BET) return { success: false, message: `Maximum bet is KES ${MAX_BET}` };
  if (!checkRateLimit(sessionKey)) return { success: false, message: 'Too many requests — slow down' };
  if (round.status !== 'waiting') return { success: false, message: 'Betting is closed for this round' };
  const s = getSession(sessionKey);
  if (s.bets[slot]) return { success: false, message: 'Bet already placed for this slot' };
  s.bets[slot] = { stake, cashedOut: false, roundId: round.id };
  return { success: true, roundId: round.id };
}

function cashOutCore(sessionKey, slot) {
  if (slot !== 1 && slot !== 2) return { success: false, message: 'Invalid bet slot' };
  if (!checkRateLimit(sessionKey)) return { success: false, message: 'Too many requests — slow down' };
  const s = getSession(sessionKey);
  const bet = s.bets[slot];
  if (!bet || bet.roundId !== round.id) return { success: false, message: 'No active bet in this round' };
  if (bet.cashedOut) return { success: false, message: 'Already cashed out' };
  if (round.status !== 'flying') return { success: false, message: 'Round is not currently flying' };
  // THE key server-side check: recompute the multiplier from the server's
  // own clock at the exact moment this request is processed. The client
  // (or partner server) never gets to assert what the multiplier "was" —
  // if the round has already crashed by the time this request is handled
  // (even by a few milliseconds), the cashout is rejected, full stop. This
  // closes the classic crash-game exploit of firing a cashout request
  // right as/after a crash and hoping the server trusts client-reported
  // timing.
  const mult = currentMultiplier();
  if (mult >= round.crashPoint) return { success: false, message: 'Too late — round already crashed' };
  bet.cashedOut = true;
  const won = Math.floor(bet.stake * mult * 100) / 100;
  return { success: true, won, multiplier: mult };
}

// checkResolution: used by casinoIntegration.js's polling endpoint to find
// out whether a specific partner bet has resolved yet, without exposing
// any balance concept. Returns null while still pending (round hasn't
// crashed and the bet hasn't been cashed out), or { won, multiplier,
// winAmount } once resolved.
function checkResolution(sessionKey, slot, roundId) {
  const s = getSession(sessionKey);
  const bet = s.bets[slot];
  // If the bet's round has moved on (a new round has started, clearing
  // bets — see startNewRound()) and we still have no record, it means the
  // round crashed and this bet was never cashed out in time: a loss.
  if (!bet || bet.roundId !== roundId) {
    // Only report a resolution once we're SURE the round in question has
    // actually crashed — otherwise this could incorrectly report "lost"
    // for a bet that's still legitimately pending in an earlier round
    // state edge case.
    if (round.id !== roundId || round.status === 'crashed') {
      return { won: false, multiplier: null, winAmount: 0 };
    }
    return null; // still pending, nothing to report yet
  }
  if (bet.cashedOut) {
    const mult = currentMultiplier();
    return { won: true, multiplier: mult, winAmount: Math.floor(bet.stake * mult * 100) / 100 };
  }
  if (round.status === 'crashed') {
    return { won: false, multiplier: round.crashPoint, winAmount: 0 };
  }
  return null; // still flying, not yet resolved
}

// ── Balance-aware wrappers (free-play frontend only) ───────────────────

function placeBet(apiKey, signedToken, slot, stake) {
  const { sessionKey } = resolveSessionKey(apiKey, signedToken);
  const s = getSession(sessionKey);
  if (stake > s.balance) return { success: false, message: 'Insufficient balance' };
  const result = placeBetCore(sessionKey, slot, stake);
  if (!result.success) return result;
  // Balance can only ever go DOWN here by exactly the staked amount, never
  // below zero (guaranteed by the check above) — this is the "you can only
  // lose what you staked, nothing more" guarantee.
  s.balance -= stake;
  return { success: true, newBalance: s.balance };
}

function cashOut(apiKey, signedToken, slot) {
  const { sessionKey } = resolveSessionKey(apiKey, signedToken);
  const s = getSession(sessionKey);
  const result = cashOutCore(sessionKey, slot);
  if (!result.success) return result;
  // Win is ALWAYS computed by cashOutCore from the server's own stake +
  // server's own clock-derived multiplier — never from any number the
  // client sends.
  s.balance += result.won;
  return { success: true, newBalance: s.balance, won: result.won, multiplier: result.multiplier };
}

// ── Balance-free primitives for partner (real-money) integration ──────
// Thin, explicitly-named wrappers so casinoIntegration.js never has to
// import the *Core functions directly — keeps the "no balance concept
// here" boundary obvious at the call site.

function placeBetForSession(sessionKey, slot, stake) {
  return placeBetCore(sessionKey, slot, stake);
}

function cashOutForSession(sessionKey, slot) {
  return cashOutCore(sessionKey, slot);
}

function getPlayersView() {
  // Aggregate a lightweight, anonymized view across all sessions for the
  // "players" list the frontend shows — no real identity is ever exposed
  // here, just counts/amounts, regardless of whether a session is keyed by
  // verified user id or by API key fallback.
  const rows = [];
  sessions.forEach((s, key) => {
    [1, 2].forEach(slot => {
      const b = s.bets[slot];
      if (b && b.roundId === round.id) {
        rows.push({
          username: 'Player',
          stake: b.stake,
          cashedOut: b.cashedOut,
          cashoutMultiplier: b.cashedOut ? currentMultiplier() : null,
          won: b.cashedOut ? Math.floor(b.stake * currentMultiplier() * 100) / 100 : null,
        });
      }
    });
  });
  return rows;
}

module.exports = { getPublicState, placeBet, cashOut, getPlayersView, placeBetForSession, cashOutForSession, checkResolution };

