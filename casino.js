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
//   - Balances live server-side per API key session; a client can only
//     ever change its balance by placing/cashing a bet through these
//     endpoints, never by sending a balance value directly.
//
// FREE-PLAY SCOPE: balances here are in-memory only (reset on server
// restart), which is intentional and fine for a free-play demo — nothing
// real is at stake. If this is ever extended to handle real money, the
// balance ledger needs to move to a real persistent, audited store (like
// fixtures/apikeys already do in db.js via MongoDB), with proper
// deposit/withdrawal reconciliation — that's a substantially bigger
// project than this module and out of scope here.

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

// Per-API-key session state (bets + balance). Keyed by API key string.
// This is intentionally simple in-memory storage — see FREE-PLAY SCOPE
// note above for why that's fine here and what would need to change for
// real money.
const sessions = new Map(); // apiKey -> { balance, bets: { 1: {stake,cashedOut,roundId}|null, 2: {...}|null } }

function getSession(apiKey) {
  let s = sessions.get(apiKey);
  if (!s) {
    s = { balance: STARTING_BALANCE, bets: { 1: null, 2: null } };
    sessions.set(apiKey, s);
  }
  return s;
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

function getPublicState(apiKey) {
  const s = getSession(apiKey);
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
  };
  // Only reveal the crash point once the round has actually crashed — this
  // is the crux of not being able to "read the answer" early. During
  // waiting/flying, crashPoint is simply not present in the response at all.
  if (round.status === 'crashed') base.crashPoint = round.crashPoint;
  return base;
}

function placeBet(apiKey, slot, stake) {
  if (slot !== 1 && slot !== 2) return { success: false, message: 'Invalid bet slot' };
  if (!Number.isFinite(stake) || stake < MIN_BET) return { success: false, message: `Minimum bet is KES ${MIN_BET}` };
  if (stake > MAX_BET) return { success: false, message: `Maximum bet is KES ${MAX_BET}` };
  if (round.status !== 'waiting') return { success: false, message: 'Betting is closed for this round' };
  const s = getSession(apiKey);
  if (s.bets[slot]) return { success: false, message: 'Bet already placed for this slot' };
  if (stake > s.balance) return { success: false, message: 'Insufficient balance' };
  s.balance -= stake;
  s.bets[slot] = { stake, cashedOut: false, roundId: round.id };
  return { success: true, newBalance: s.balance };
}

function cashOut(apiKey, slot) {
  if (slot !== 1 && slot !== 2) return { success: false, message: 'Invalid bet slot' };
  const s = getSession(apiKey);
  const bet = s.bets[slot];
  if (!bet || bet.roundId !== round.id) return { success: false, message: 'No active bet in this round' };
  if (bet.cashedOut) return { success: false, message: 'Already cashed out' };
  if (round.status !== 'flying') return { success: false, message: 'Round is not currently flying' };
  // THE key server-side check: recompute the multiplier from the server's
  // own clock at the exact moment this request is processed. The client
  // never gets to assert what the multiplier "was" — if the round has
  // already crashed by the time this request is handled (even by a few
  // milliseconds), the cashout is rejected, full stop. This closes the
  // classic crash-game exploit of firing a cashout request right as/after
  // a crash and hoping the server trusts client-reported timing.
  const mult = currentMultiplier();
  if (mult >= round.crashPoint) return { success: false, message: 'Too late — round already crashed' };
  bet.cashedOut = true;
  const won = Math.floor(bet.stake * mult * 100) / 100;
  s.balance += won;
  return { success: true, newBalance: s.balance, won, multiplier: mult };
}

function getPlayersView() {
  // Aggregate a lightweight, anonymized view across all sessions for the
  // "players" list the frontend shows — no per-user identity is tracked
  // here at all (sessions are keyed by API key, not by end-user account),
  // so this reports counts/amounts only, not real usernames.
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

module.exports = { getPublicState, placeBet, cashOut, getPlayersView };
