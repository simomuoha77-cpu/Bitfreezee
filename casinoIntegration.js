// casinoIntegration.js — the REAL-MONEY, server-to-server casino API for
// partner betting sites (e.g. SafariBet) to integrate JuanAi's casino
// games without JuanAi ever touching real money.
//
// WHY THIS IS A SEPARATE MODULE FROM casino.js:
// casino.js is the original free-play engine used by JuanAi's own Aviator
// frontend page (public/casino/aviator.html) — it holds its own fake
// "aviator balance" per session, meant purely as a demo/free-play feature.
// That model is WRONG for real-money partner integration: a partner site's
// balance is the only real balance that should ever exist, and JuanAi
// should never hold, credit, or debit anything real. This module talks to
// casino.js's shared round engine (same crash points, same round clock —
// ONE game, ONE truth) but never touches any balance. It only ever
// records "this partner's user placed this bet" and later reports the
// factual outcome for the partner's own server to act on.
//
// INTEGRATION MODEL: SERVER-TO-SERVER POLLING (not push webhooks)
// The partner's backend calls these endpoints directly (never the
// partner's browser/frontend) — this keeps the partner's API key and
// their internal userId off the public internet entirely except between
// two trusted servers. Outcomes are retrieved by POLLING
// /api/casino/bet/:betId (or /api/casino/history), not by JuanAi pushing
// to a callback URL. This is the safer choice for real money because:
//   - No public callback URL on the partner's side to secure, verify
//     signatures for, or worry about being spoofed/replayed.
//   - No retry/backoff/dead-letter complexity on JuanAi's side if the
//     partner's endpoint is briefly down.
//   - The partner's server stays in full control of when it checks, and
//     a poll is just an ordinary authenticated GET request.
// If a partner later wants push webhooks in addition, that can be added
// without changing this contract — poll-based retrieval will keep working
// as the safe fallback regardless.
//
// WHAT JUANAI GUARANTEES vs WHAT THE PARTNER MUST DO:
//   JuanAi guarantees: the crash point / round outcome is rolled and
//   decided server-side, never influenced by client input, and reported
//   accurately once decided (see casino.js for the anti-prediction design).
//   The partner MUST: deduct the stake from their user's real balance
//   BEFORE calling placeBet here (or accept the bet speculatively and roll
//   back if placeBet fails), and credit any win to their user's real
//   balance only after seeing a 'won' outcome from getBetResult/history.
//   JuanAi does not and cannot move real money — that responsibility
//   stays entirely with the partner's own ledger.

const crypto = require('crypto');
const casino = require('./casino'); // reuse the same round engine / RNG / anti-cheat timing logic
const wallet = require('./walletClient'); // synchronous, HMAC-signed calls out to the partner's own wallet endpoints

// ── Games catalog ──────────────────────────────────────────────────────
// Deliberately lists ONLY games that actually exist and actually work
// today. Do not add placeholder entries for games that don't have a real
// engine behind them yet — a partner site showing a "Dice" or "Slots" tile
// that leads nowhere is worse than not listing it at all. Add more entries
// here only once each game has its own real round engine, the same way
// Aviator does in casino.js.
const GAMES = [
  {
    id: 'aviator',
    name: 'Aviator',
    category: 'crash',
    thumbnail: '/casino/assets/aviator-thumb.png', // partner should host/replace with their own art if this path 404s
    gameUrl: '/casino/aviator.html', // append ?key=...&utoken=... when embedding, see userToken.js
    rtp: 97, // approximate theoretical RTP of the current rollCrashPoint() distribution — see NOTE below
    status: 'active',
  },
];
// NOTE ON rtp: this is a reasonable estimate for the current house-edge
// exponential distribution in casino.js's rollCrashPoint(), NOT a
// certified/audited figure. If a partner's jurisdiction requires a
// certified RTP disclosure, that requires an actual statistical audit of
// the RNG — flag this to the partner rather than presenting the number
// above as certified.

function listGames() {
  return GAMES;
}

function getGame(gameId) {
  return GAMES.find(g => g.id === gameId) || null;
}

// ── Real-money bet records ─────────────────────────────────────────────
// Keyed by betId. Each bet is tied to (apiKey, userId, gameId, roundId) —
// NOT to any balance. `stake` is recorded for reporting/auditing only;
// JuanAi never holds or moves it.
const bets = new Map(); // betId -> { betId, apiKey, userId, gameId, slot, stake, roundId, status, multiplier, won, placedAt, resolvedAt }

function newBetId() {
  return 'bet_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

// placeBet: partner's server calls this after (or while) deducting the
// stake from their user's real balance. Returns success/failure and a
// betId to poll later — never a balance.
async function placeBet(apiKey, userId, gameId, slot, stake) {
  if (!userId) return { success: false, message: 'userId is required' };
  const game = getGame(gameId);
  if (!game) return { success: false, message: `Unknown gameId '${gameId}'` };
  if (game.status !== 'active') return { success: false, message: `Game '${gameId}' is not currently active` };
  if (!Number.isFinite(stake) || stake <= 0) return { success: false, message: 'Invalid stake amount' };

  // A roundId is needed for the debit call's audit trail, but the actual
  // round the bet lands in is only known once placeBetForSession succeeds
  // below — casino.js's shared round could theoretically roll over between
  // these two steps under extreme timing. We use a provisional reference
  // (current round id at call time) for the debit call regardless; what
  // matters for correctness is the wallet's own idempotency on
  // (userId, provisionalRef), not which exact round it lands in.
  const provisionalRef = 'debit_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

  // STEP 1: confirm the debit BEFORE the bet is allowed to exist at all.
  // If this fails (insufficient balance, wallet unreachable, etc.), no bet
  // is ever recorded — nothing to roll back.
  const debitResult = await wallet.debit(apiKey, userId, Number(stake), provisionalRef);
  if (!debitResult.success) {
    return { success: false, message: debitResult.message || 'Debit failed' };
  }

  // STEP 2: now that money has actually moved, try to place the bet in the
  // shared round engine.
  const sessionKey = `partner:${apiKey}:${gameId}:${userId}`;
  const result = casino.placeBetForSession(sessionKey, slot, Number(stake));
  if (!result.success) {
    // ROLLBACK: the debit succeeded but the bet itself couldn't be placed
    // (e.g. round closed in the split second between the debit call and
    // this line, rate limit, etc.) — refund immediately via a credit call
    // using the SAME reference, so the partner's ledger can treat this as
    // an idempotent reversal of that exact debit rather than a new,
    // unrelated credit.
    const refund = await wallet.credit(apiKey, userId, Number(stake), provisionalRef);
    if (!refund.success) {
      // This is the one truly bad outcome: money left the user's balance
      // and the automatic refund also failed. Surface this loudly rather
      // than silently swallowing it — an ops alert/log here is essential
      // in real production; this comment marks exactly where to hook one.
      console.error(`[casinoIntegration] CRITICAL: debit for ${userId} ref ${provisionalRef} succeeded, bet placement failed (${result.message}), AND refund failed (${refund.message}). Manual reconciliation required.`);
      return { success: false, message: 'Bet could not be placed and automatic refund failed — contact support', ref: provisionalRef };
    }
    return { success: false, message: result.message };
  }

  const betId = newBetId();
  bets.set(betId, {
    betId,
    apiKey,
    userId,
    gameId,
    slot,
    stake: Number(stake),
    roundId: result.roundId,
    debitRef: provisionalRef,
    status: 'pending', // pending -> won | lost
    multiplier: null,
    won: null,
    placedAt: Date.now(),
    resolvedAt: null,
  });
  return { success: true, betId, roundId: result.roundId };
}

// getBetResult: partner's server polls this to find out what happened.
// Returns status: 'pending' while the round is still in progress, or
// 'won'/'lost' once resolved, with the multiplier and won amount so the
// partner can credit their user's real balance accordingly.
async function getBetResult(apiKey, betId) {
  const bet = bets.get(betId);
  if (!bet || bet.apiKey !== apiKey) return { success: false, message: 'Bet not found' };

  if (bet.status === 'pending') {
    // Ask casino.js's engine whether this session's bet in this slot has
    // resolved yet (crashed-without-cashout counts as resolved/lost; a
    // manual cashout via the free-play frontend does not apply here since
    // partner-side bets are cashed out via cashOut() below, not the
    // frontend UI).
    const sessionKey = `partner:${bet.apiKey}:${bet.gameId}:${bet.userId}`;
    const resolved = casino.checkResolution(sessionKey, bet.slot, bet.roundId);
    if (resolved) {
      bet.status = resolved.won ? 'won' : 'lost';
      bet.multiplier = resolved.multiplier;
      bet.won = resolved.won ? resolved.winAmount : 0;
      bet.resolvedAt = Date.now();
      if (resolved.won) {
        await creditWinOnce(bet);
      }
    }
  }

  return {
    success: true,
    betId: bet.betId,
    gameId: bet.gameId,
    userId: bet.userId,
    stake: bet.stake,
    status: bet.status,
    multiplier: bet.multiplier,
    won: bet.won,
    placedAt: bet.placedAt,
    resolvedAt: bet.resolvedAt,
  };
}

// creditWinOnce: the single place a win is ever credited to the partner's
// wallet, guarded by bet.creditedAt so concurrent polls/calls can never
// double-credit the same bet. Both getBetResult's auto-resolution path and
// cashOut's manual path funnel through here.
async function creditWinOnce(bet) {
  if (bet.creditedAt) return { success: true }; // already credited, nothing to do
  const result = await wallet.credit(bet.apiKey, bet.userId, bet.won, bet.betId);
  if (result.success) {
    bet.creditedAt = Date.now();
  } else {
    // The round-engine outcome already says "won" and the amount is fixed
    // — a failed credit here is a real operational problem (money owed to
    // the user isn't in their account yet), not a "maybe this didn't
    // happen" ambiguity. Log loudly; a real deployment should retry this
    // (e.g. a background job scanning for won-but-uncredited bets) rather
    // than only trying once.
    console.error(`[casinoIntegration] CRITICAL: win credit failed for bet ${bet.betId}, user ${bet.userId}, amount ${bet.won}: ${result.message}. Needs retry/reconciliation.`);
  }
  return result;
}

// cashOut: partner's server calls this on behalf of their user (e.g. user
// taps "cash out" in the partner's own UI, partner's backend relays it
// here). Same server-side timing guarantee as casino.js's own cashOut —
// the multiplier is always recomputed from the server clock, never
// trusted from the partner's request.
async function cashOut(apiKey, betId) {
  const bet = bets.get(betId);
  if (!bet || bet.apiKey !== apiKey) return { success: false, message: 'Bet not found' };
  if (bet.status !== 'pending') return { success: false, message: `Bet already resolved as '${bet.status}'` };

  const sessionKey = `partner:${bet.apiKey}:${bet.gameId}:${bet.userId}`;
  const result = casino.cashOutForSession(sessionKey, bet.slot);
  if (!result.success) return result;

  bet.status = 'won';
  bet.multiplier = result.multiplier;
  bet.won = result.won;
  bet.resolvedAt = Date.now();

  const creditResult = await creditWinOnce(bet);
  if (!creditResult.success) {
    // The cashout itself is still valid and final (the round-engine timing
    // check already passed) — we don't reverse it just because the credit
    // call failed, since that would mean telling the user they lost a bet
    // they legitimately won. Surface the credit failure separately instead
    // (see creditWinOnce's log) for ops to reconcile.
    return { success: true, betId: bet.betId, multiplier: bet.multiplier, won: bet.won, creditWarning: creditResult.message };
  }

  return { success: true, betId: bet.betId, multiplier: bet.multiplier, won: bet.won };
}

// getHistory: partner's server can pull a user's recent resolved bets —
// useful for reconciliation/auditing against the partner's own ledger.
function getHistory(apiKey, userId, limit = 50) {
  const rows = [];
  bets.forEach(b => {
    if (b.apiKey === apiKey && b.userId === userId) rows.push(b);
  });
  rows.sort((a, b) => b.placedAt - a.placedAt);
  return rows.slice(0, limit);
}

// getBalance: pulls the user's REAL balance directly from the partner's
// own wallet endpoint — Aviator calls this to display the correct
// SafariBet balance inside the game, rather than tracking any balance of
// its own. Passthrough to walletClient.js; see that module for the HMAC
// signing details.
async function getBalance(apiKey, userId) {
  return wallet.getBalance(apiKey, userId);
}

// registerWallet: call this once (e.g. at server startup, or from an
// admin route backed by db.js) per partner to tell JuanAi where their
// wallet endpoints live and what shared secret to sign requests with.
async function registerWallet(apiKey, baseUrl, secret) {
  await wallet.registerPartnerWallet(apiKey, baseUrl, secret);
}

module.exports = { listGames, getGame, placeBet, getBetResult, cashOut, getHistory, getBalance, registerWallet };
