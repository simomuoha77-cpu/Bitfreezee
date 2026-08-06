// realOdds.js — real bookmaker market odds, tried across TWO providers in
// sequence before falling back to AI-generated estimates.
//
// WHY THIS EXISTS: the AI-generated odds in ai.js are estimates, not real
// market prices. This module fetches ACTUAL odds that real sportsbooks are
// currently offering, so JuanAi can serve genuine market data wherever
// possible. The AI's role becomes analysis/value-bet commentary layered on
// top of real prices — see ai.js's buildValueBetPrompt — rather than
// inventing odds from scratch.
//
// TWO PROVIDERS, TRIED IN ORDER, because real testing (not just marketing
// pages — every "free tier" claim in this space needed independent
// verification) showed they cover different, mostly non-overlapping leagues:
//
// 1. SharpAPI (sharpapi.io) — free tier: 12 req/min, no monthly cap, but
//    ONLY 2 bookmakers (DraftKings + FanDuel) and free soccer coverage is
//    limited to major club leagues: EPL, La Liga, Serie A, Bundesliga,
//    Ligue 1, MLS, Champions League. Confirmed via real test: NO World Cup
//    coverage on free tier.
//
// 2. odds-api.io — free tier: 100 req/hour, also only 2 bookmakers, but
//    much broader league depth (confirmed via real test: returns lower
//    division and international friendly fixtures SharpAPI doesn't have).
//    Also confirmed via real test: still NO World Cup coverage on free tier
//    — likely because 2-bookmaker free access just doesn't extend to
//    tournaments this far from kickoff, or it's excluded the same way
//    SharpAPI excludes it. If you later see World Cup odds appear here,
//    that's the coverage having genuinely expanded, not a bug.
//
// Both providers were verified with real curl requests against a live key
// before this was wired in — see the conversation history for the actual
// responses. Nothing here is built on an unverified marketing claim.

const SHARPAPI_KEY = process.env.SHARPAPI_KEY || '';
const SHARPAPI_BASE = 'https://api.sharpapi.io/api/v1';

// ODDSAPIIO_KEY supports MULTIPLE comma-separated keys, same rotation
// pattern as football-data.org in footballData.js. Since the free tier's
// limit is 100 req/HOUR PER KEY (confirmed via a real 429 hit in testing —
// see the error-handling below), each additional key adds real, meaningful
// headroom: 2 keys = ~200/hour, 20 keys = ~2000/hour. This matters more
// here than for football-data.org, since we're realistically much closer
// to odds-api.io's ceiling given how many matches can need pricing across
// a merged fixture list spanning 8 day-buckets.
const ODDSAPIIO_KEYS = (process.env.ODDSAPIIO_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);
const ODDSAPIIO_BASE = 'https://api.odds-api.io/v3';// odds-api.io free tier only unlocks 2 bookmakers; Bet365 was confirmed
// working in real testing. If your account has different books enabled,
// change this — there's no single endpoint that tells us which books a
// given free key can actually query without trial and error.
const ODDSAPIIO_BOOKMAKER = process.env.ODDSAPIIO_BOOKMAKER || 'Bet365';

// Cache: keyed by a rounded-to-the-minute cache bucket, so multiple calls
// within the same short window reuse one fetch instead of burning either
// provider's rate limit on every single match lookup during a scheduler pass.
const CACHE_MS = 5 * 60 * 1000; // 5 min — real ODDS don't need to be fresher (see EVENTS_LIST_CACHE_MS below for the separate, much shorter duration used for live score/status data)
const EVENTS_LIST_CACHE_MS = 30 * 1000; // 30s — the events list carries LIVE SCORE/STATUS, which needs to be much fresher than odds; roughly half of scheduler.js's TODAY_REFRESH_INTERVAL_MS so a fresh fetch is essentially always available whenever the scheduler wants to check
                                 // than this for pre-match markets, and it
                                 // keeps us comfortably under both rate
                                 // limits even with many matches per cycle.
let sharpApiCache = { data: null, fetchedAt: 0 };
// (per-sport odds-api.io events cache now lives as oddsApiIoCacheBySport, defined near fetchOddsApiIoEvents)

// Per-EVENT odds cache — this was the actual gap that let the same match's
// odds get re-fetched from odds-api.io repeatedly within a short window
// (e.g. one request from /api/fixtures, another moments later from the
// scheduler's own pass, another from a different day-bucket's overlapping
// check) even though nothing about that match's price had any reason to
// have changed yet. The event LIST was already cached (see CACHE_MS above)
// but the per-match odds lookup was not — every single distinct call site
// asking about the same match paid for its own fresh API hit. Reusing the
// same CACHE_MS window here directly cuts real call volume without making
// any single request wait longer than it already would have.
const oddsApiIoOddsCacheByEvent = {}; // eventId -> { data, fetchedAt }

const MIN_MS_BETWEEN_CALLS = 5500; // ~10.9 req/min ceiling, under SharpAPI's 12/min cap
let lastSharpApiCallAt = 0;
async function throttleSharpApi() {
  const wait = MIN_MS_BETWEEN_CALLS - (Date.now() - lastSharpApiCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSharpApiCallAt = Date.now();
}

// odds-api.io free tier is capped at 100 requests/HOUR PER KEY — not just a
// per-minute rate — and we learned the hard way (a real 429-equivalent hit
// during testing, returned as HTTP 200 with an {"error":...} body) that
// simple inter-call spacing isn't enough. Each key in the pool gets its OWN
// independent sliding-hour budget and its OWN cooldown if it gets rate-
// limited, mirroring the football-data.org key-rotation design.
// PACING — REVISED based on real observed evidence, not the original
// assumption. A live status check showed all 7 configured keys blocked
// simultaneously, each having made only ~6 calls in the preceding hour
// (nowhere near the old 90/hour assumption), each reporting almost the
// exact same "~11 minutes until available." Three keys independently
// exhausting at nearly the same moment with nearly the same remaining
// cooldown is not consistent with 7 genuinely independent per-key limits —
// it strongly suggests odds-api.io enforces its real rate limit per
// account (or per source IP), not per individual key string, and that the
// real limit is much stricter than 90/hour. The 3-second minimum gap
// between calls let a single key fire up to 20 requests/minute, which is
// almost certainly what triggered the block after only ~6 real calls.
// These values are a conservative correction based on that evidence, not a
// number pulled from odds-api.io's own documented limits (their docs
// weren't checked for this fix, since the discrepancy was severe enough to
// require an immediate, safe correction rather than waiting on that) — if
// you have access to the actual plan/dashboard for these keys, check the
// real documented rate limit there and adjust these two constants to match
// it precisely rather than relying on this estimate indefinitely.
// UNIFIED PER-KEY BUDGET TRACKING — replaces the old split between a
// single "reserved" key (for events/live-clock calls) and a separate pool
// for per-match odds lookups, plus a global daily counter shared across
// everything regardless of key. That older design meant adding more keys
// (e.g. from separate odds-api.io accounts) didn't actually buy any extra
// daily capacity — the reserved key was still just one key, and the daily
// cap was one shared number no matter how many keys existed. This tracks
// EVERY key's own real budget independently: 100 requests/hour AND 500/day
// each (odds-api.io's own documented free-plan limits, confirmed directly
// from their docs — https://docs.odds-api.io/ — not an estimate this
// time). If you're running N separate odds-api.io accounts, this is what
// makes that actually worth N x the daily capacity instead of just 1x.
const ODDSAPIIO_HOURLY_BUDGET_PER_KEY = 90; // just under the documented 100/hour, per key
const ODDSAPIIO_DAILY_BUDGET_PER_KEY = 480; // just under the documented 500/day, per key
const ODDSAPIIO_MIN_MS_BETWEEN_CALLS = 3000; // simple per-key pacing floor — real protection against bursting now comes from the hourly/daily counters above, not this gap; this just avoids firing a key's whole hourly budget in the same second
function nextUtcMidnightMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}
const oddsApiIoKeyState = ODDSAPIIO_KEYS.map(key => ({
  key,
  hourlyTimestamps: [], // sliding window of call times within the last hour, for THIS key
  dailyCount: 0,
  dailyResetAtMs: nextUtcMidnightMs(),
  lastCallAt: 0,
  blockedUntil: 0 // set when this specific key hits a real rate-limit error
}));
let nextOddsApiIoKeyIndex = 0;

// PRIORITY LANE — this is the fix for a real, measured bug: comparing
// JuanAi's live scores against Betika/SportPesa/Google for the same match
// showed JuanAi lagging the real score by MANY REAL MINUTES (not seconds).
// The events list (fetchOddsApiIoEvents) and the live-clock endpoint
// (fetchOddsApiIoLiveClocks) are the ONLY sources of live score/status/
// minute data in this whole pipeline, yet calls for them used to share the
// exact same queue and pacing as the much higher-volume, far less
// time-sensitive PER-MATCH odds lookups. Fix: priority calls now pick
// whichever key currently has the MOST remaining daily budget (see
// pickAvailableOddsApiIoKey below), spreading this critical, low-volume,
// time-sensitive traffic across every available key instead of queuing
// behind one specific key's backlog — while regular per-match odds lookups
// keep round-robin ordering to spread their own higher volume evenly.


// GLOBAL (account-wide) pacing — separate from each key's own individual
// gap above. This exists specifically because of the "maybe the real limit
// is shared across all keys, not independent per key" possibility raised
// by the evidence in the comment above. Rotating through 7 keys that each
// only respect their OWN gap could still let calls hit odds-api.io in
// rapid succession overall (e.g. 7 different keys firing one after another
// within a couple seconds), which would defeat the point of the per-key
// gap entirely if the account/IP-level theory is correct. This global gap
// protects against that regardless of which theory turns out to be true.
let lastOddsApiIoCallAtGlobal = 0;
const ODDSAPIIO_GLOBAL_MIN_MS_BETWEEN_CALLS = 2000;

// REAL BUG FIX: not every {error} response from odds-api.io means "you're
// rate limited, back off and try another key." Some errors are permanent
// and deterministic — e.g. "Invalid sport slug" for a bad `sport` param —
// meaning the SAME request will fail on every single key, forever, no
// matter how many times it's retried. The old code treated every error
// identically: block this key, recurse to the next one. For a permanent
// error, that recursion burns through the ENTIRE key pool in a handful of
// milliseconds (each key gets the exact same deterministic rejection),
// leaving every key falsely marked "blocked" for the next 11+ minutes —
// which then starves the completely unrelated, working football live-score
// calls that share this same pool. This was confirmed happening in
// production logs: a basketball request with sport=nba failing with
// "Invalid sport slug" cascaded through all 6 keys and knocked out live
// football scores too. Only genuine rate-limit-shaped errors (the ones
// that mention a reset time, or otherwise look like a quota/limit message)
// should trigger a block-and-retry; anything else should fail immediately
// without touching any key's state, since retrying it anywhere is pointless.
function isRateLimitError(errorMsg) {
  if (!errorMsg) return false;
  return /resets in|rate limit|too many requests|quota|throttl/i.test(errorMsg);
}

// isPriority: for the events-list / live-clock calls, pick whichever key
// has the MOST remaining daily budget rather than following round-robin
// order — spreads this critical traffic across every account evenly
// instead of concentrating it on whichever key happens to be "next" (which
// is fine for high-volume, low-urgency per-match odds lookups, but for a
// small number of critical calls per cycle, load-balancing by remaining
// budget makes much better use of N separate accounts' capacity).
function refreshKeyDailyWindow(state) {
  if (Date.now() >= state.dailyResetAtMs) {
    state.dailyCount = 0;
    state.dailyResetAtMs = nextUtcMidnightMs();
  }
}
function pickAvailableOddsApiIoKey(isPriority) {
  const now = Date.now();
  oddsApiIoKeyState.forEach(refreshKeyDailyWindow);
  const usable = oddsApiIoKeyState.filter(state => {
    state.hourlyTimestamps = state.hourlyTimestamps.filter(t => now - t < 60 * 60 * 1000);
    return now >= state.blockedUntil &&
      state.hourlyTimestamps.length < ODDSAPIIO_HOURLY_BUDGET_PER_KEY &&
      state.dailyCount < ODDSAPIIO_DAILY_BUDGET_PER_KEY;
  });
  if (!usable.length) return null; // every key is blocked, or has used its hourly OR daily budget
  if (isPriority) {
    // Prefer the key with the most daily headroom left, so priority calls
    // spread evenly across accounts instead of draining one first.
    return usable.reduce((best, s) => (s.dailyCount < best.dailyCount ? s : best));
  }
  // Regular per-match odds lookups: keep round-robin ordering for even load.
  for (let i = 0; i < oddsApiIoKeyState.length; i++) {
    const idx = (nextOddsApiIoKeyIndex + i) % oddsApiIoKeyState.length;
    const state = oddsApiIoKeyState[idx];
    if (usable.includes(state)) {
      nextOddsApiIoKeyIndex = (idx + 1) % oddsApiIoKeyState.length;
      return state;
    }
  }
  return null;
}

async function throttleOddsApiIoKey(state) {
  const gapWait = ODDSAPIIO_MIN_MS_BETWEEN_CALLS - (Date.now() - state.lastCallAt);
  if (gapWait > 0) await new Promise(r => setTimeout(r, gapWait));
  // Global gap check happens AFTER the per-key wait, using a fresh
  // Date.now() — this way if two calls (to different keys) land close
  // together, the second one still respects the account-wide minimum gap
  // even though its own key's individual timer had nothing to wait for.
  const globalGapWait = ODDSAPIIO_GLOBAL_MIN_MS_BETWEEN_CALLS - (Date.now() - lastOddsApiIoCallAtGlobal);
  if (globalGapWait > 0) await new Promise(r => setTimeout(r, globalGapWait));
  state.lastCallAt = Date.now();
  lastOddsApiIoCallAtGlobal = state.lastCallAt;
  state.hourlyTimestamps.push(state.lastCallAt);
  refreshKeyDailyWindow(state);
  state.dailyCount++;
}

function isConfigured() {
  return !!SHARPAPI_KEY || ODDSAPIIO_KEYS.length > 0;
}

// Fetches all currently-available soccer odds from SharpAPI, using the
// 5-minute cache to avoid re-fetching on every single match lookup.
async function fetchSharpApiOdds() {
  const now = Date.now();
  if (sharpApiCache.data && (now - sharpApiCache.fetchedAt) < CACHE_MS) {
    return sharpApiCache.data;
  }
  await throttleSharpApi();
  const res = await fetch(SHARPAPI_BASE + '/odds?sport=football&market=moneyline', {
    headers: { 'X-API-Key': SHARPAPI_KEY }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('SharpAPI request failed: ' + res.status + ' ' + body.slice(0, 200));
  }
  const json = await res.json();
  sharpApiCache = { data: json.data || [], fetchedAt: now };
  return sharpApiCache.data;
}

// Shared fetch helper for odds-api.io: picks an available key from the
// pool, throttles per that key's own timer, and on a rate-limit response
// (returned as HTTP 200 with an {"error":...} body — confirmed via real
// testing, not a standard 429) marks that specific key as blocked and
// retries on the NEXT available key, same rotation pattern as
// footballData.js. Only throws once every key in the pool is either
// blocked or has exhausted its hourly OR daily budget.
//
// isEventsListCall (renamed in spirit to "isPriority" — kept the param
// name for compatibility with existing call sites): for events-list and
// live-clock calls, picks whichever key has the most daily budget left
// (see pickAvailableOddsApiIoKey), spreading this critical traffic evenly
// across every configured key/account instead of concentrating on one.
async function oaioFetch(path, isEventsListCall) {
  if (!ODDSAPIIO_KEYS.length) {
    throw new Error('No ODDSAPIIO_KEY configured');
  }

  const state = pickAvailableOddsApiIoKey(isEventsListCall);
  if (!state) {
    throw new Error('All ' + oddsApiIoKeyState.length + ' odds-api.io key(s) are currently blocked or have used their hourly/daily budget');
  }

  await throttleOddsApiIoKey(state);
  const separator = path.includes('?') ? '&' : '?';
  const res = await fetch(ODDSAPIIO_BASE + path + separator + 'apiKey=' + state.key);
  const json = await res.json().catch(() => null);

  if (json && json.error) {
    if (!isRateLimitError(json.error)) {
      // Permanent/deterministic error (bad param, unsupported sport, etc.)
      // — will fail on every key identically, so don't block this key or
      // retry another one. Fail once, immediately, key left untouched.
      console.error('[realOdds] request failed with a non-rate-limit error (key left untouched): ' + json.error);
      throw new Error('odds-api.io error: ' + json.error);
    }
    // Prefer the provider's own stated reset time when it gives one (also
    // matches a "seconds" form, not just "minutes"). Falls back to 11
    // minutes when no explicit reset time is given, matching the real
    // ~10-11 minute cooldowns observed in testing.
    const minutesMatch = /resets in (\d+) minutes?/i.exec(json.error);
    const secondsMatch = /resets in (\d+) seconds?/i.exec(json.error);
    let backoffMs;
    if (minutesMatch) backoffMs = (parseInt(minutesMatch[1], 10) + 1) * 60 * 1000;
    else if (secondsMatch) backoffMs = parseInt(secondsMatch[1], 10) * 1000 + 5000;
    else backoffMs = 11 * 60 * 1000;
    state.blockedUntil = Date.now() + backoffMs;
    console.error('[realOdds] key ' + state.key.slice(0, 6) + '... blocked for ' + Math.round(backoffMs / 1000) + 's: ' + json.error);
    // Retry on the next available key rather than failing the whole
    // request — this is the actual point of having a key pool.
    return oaioFetch(path, isEventsListCall);
  }
  if (!res.ok) {
    throw new Error('odds-api.io request failed: ' + res.status + ' ' + JSON.stringify(json).slice(0, 200));
  }
  return json;
}

// Fetches the current list of pending events from odds-api.io for a given
// sport (defaults to 'football' so existing callers are unaffected), using
// the same 5-minute cache pattern. This is a much heavier payload (~1MB,
// thousands of matches) than SharpAPI's response, so caching matters even
// more here to stay under the 100 req/hour-per-key free-tier limit. Cache
// is keyed PER SPORT now (was a single shared slot) — needed once
// basketball was added alongside football: with one shared cache slot,
// alternating football/basketball fetches would each evict the other's
// cached data, so neither sport would ever actually benefit from caching.
const oddsApiIoCacheBySport = {}; // sport -> { data, fetchedAt }
async function fetchOddsApiIoEvents(sport) {
  sport = sport || 'football';
  const now = Date.now();
  const cached = oddsApiIoCacheBySport[sport];
  // EVENTS_LIST_CACHE_MS (short) instead of the general CACHE_MS (5 min) —
  // this is deliberately separate. CACHE_MS was designed for per-match
  // ODDS, which are genuinely fine to be a few minutes stale (see that
  // constant's own comment). This events list carries the LIVE SCORE and
  // STATUS for every match, which is exactly the opposite: comparing
  // JuanAi's live scores against Betika/SportPesa/Google for the same real
  // match showed goals not reflected for many real minutes. Reusing the
  // 5-minute odds-cache duration for this fundamentally more time-critical
  // data was a real, separate contributor to that delay — a live score
  // being up to 5 minutes stale from caching ALONE, before any fetch
  // scheduling delay is even considered, is a serious problem for a
  // real-money betting product. This should stay roughly aligned with how
  // often the scheduler actually wants fresh live data (see
  // TODAY_REFRESH_INTERVAL_MS in scheduler.js).
  if (cached && (now - cached.fetchedAt) < EVENTS_LIST_CACHE_MS) {
    return cached.data;
  }
  try {
    const json = await oaioFetch('/events?sport=' + encodeURIComponent(sport), true); // true = priority lane, see pickAvailableOddsApiIoKey above
    const data = Array.isArray(json) ? json : [];
    oddsApiIoCacheBySport[sport] = { data, fetchedAt: now };
    return data;
  } catch (e) {
    // FIX: a failed fetch here used to propagate up and get caught by
    // getOddsApiIoMatchesForDate as a blanket []  — which meant every match
    // that ONLY exists via odds-api.io (e.g. Colombia, Venezuela, Chile —
    // leagues football-data.org's free tier doesn't cover) vanished from
    // that cycle's merge entirely and its last-saved score just sat
    // untouched in the database, with nothing logged to explain why. If we
    // have ANY previous snapshot (even an expired one), keep serving it —
    // the score stays exactly as stale as it would have anyway, but the
    // match doesn't flicker in and out of the fixture list, and the log
    // line below makes the actual staleness visible instead of silent.
    if (cached && cached.data) {
      const staleForMs = now - cached.fetchedAt;
      console.warn('[realOdds] events fetch failed (' + e.message + ') — serving cached ' + sport + ' events data that is ' + Math.round(staleForMs / 1000) + 's old');
      return cached.data;
    }
    console.error('[realOdds] events fetch failed with no cache to fall back on (' + sport + '): ' + e.message);
    return [];
  }
}

// THE REAL FIX for matching Betika/SportPesa exactly: odds-api.io actually
// has a genuine live match-clock endpoint (GET /events/live) that returns
// real minute/period/running data straight from their feed — not an
// estimate. This was never being called before; only /events (schedule +
// scores, no clock) was used, which is why estimateMatchMinute() existed
// at all. Cached briefly (same window as the events list) since it's a
// single call that covers every live match across every sport at once —
// cheap relative to per-match polling, and shares the same daily budget
// tracked in oaioFetch above.
let liveClocksCache = null; // { data: Map<eventId, clock>, fetchedAt }
const LIVE_CLOCKS_CACHE_MS = 30 * 1000;
async function fetchOddsApiIoLiveClocks() {
  const now = Date.now();
  if (liveClocksCache && (now - liveClocksCache.fetchedAt) < LIVE_CLOCKS_CACHE_MS) {
    return liveClocksCache.data;
  }
  try {
    const json = await oaioFetch('/events/live', true); // true = priority lane — this is exactly the kind of call that lane exists for
    const list = Array.isArray(json) ? json : (json && Array.isArray(json.events) ? json.events : []);
    const byId = new Map();
    list.forEach(ev => {
      if (ev && ev.id != null && ev.clock) byId.set(String(ev.id), ev.clock);
    });
    liveClocksCache = { data: byId, fetchedAt: now };
    return byId;
  } catch (e) {
    // Same principle as fetchOddsApiIoEvents: never let a failed call here
    // silently wipe out every match's real clock. Falling back to the old
    // kickoff-time estimate for this cycle (handled by the caller when this
    // returns an empty/stale map) is strictly better than throwing and
    // losing score display entirely.
    if (liveClocksCache) {
      console.warn('[realOdds] live-clocks fetch failed (' + e.message + ') — serving cached clock data that is ' + Math.round((now - liveClocksCache.fetchedAt) / 1000) + 's old');
      return liveClocksCache.data;
    }
    console.warn('[realOdds] live-clocks fetch failed with no cache to fall back on: ' + e.message + ' — matches will use the kickoff-time estimate instead');
    return new Map();
  }
}

// Fetches real odds for a specific event ID from odds-api.io. Cached per-
// event for CACHE_MS (see oddsApiIoOddsCacheByEvent above) — this is what
// actually stops the same match's odds being re-fetched many times an hour
// by different, overlapping call sites (a page load, the scheduler's own
// pass, an overlapping day-bucket check, etc.) when nothing about the
// price had any reason to have changed since the last check.
async function fetchOddsApiIoOddsForEvent(eventId) {
  const now = Date.now();
  const cached = oddsApiIoOddsCacheByEvent[eventId];
  if (cached && (now - cached.fetchedAt) < CACHE_MS) {
    return cached.data;
  }
  const data = await oaioFetch('/odds?eventId=' + eventId + '&bookmakers=' + encodeURIComponent(ODDSAPIIO_BOOKMAKER));
  oddsApiIoOddsCacheByEvent[eventId] = { data, fetchedAt: now };
  return data;
}

// Normalizes a team name for fuzzy matching — SharpAPI and football-data.org
// don't always use identical naming (e.g. "Manchester City" vs "Man City").
// Small alias table for common abbreviations that don't share a substring
// relationship with their full name (e.g. "Man City" vs "Manchester City" —
// "mancity" isn't a substring of "manchestercity"). Deliberately short and
// conservative: better to miss a match (falls back to AI odds, safe) than
// to risk a false positive pairing wrong teams' real odds together.
const TEAM_ALIASES = {
  'mancity': 'manchestercity',
  'manutd': 'manchesterunited',
  'manu': 'manchesterunited',
  'spurs': 'tottenhamhotspur',
  'psg': 'parissaintgermain',
  'bayern': 'bayernmunich',
  'inter': 'internazionale',
  'atleti': 'atleticomadrid'
};

function normalizeTeamName(name) {
  if (!name) return '';
  const base = name.toLowerCase()
    .replace(/\bfc\b|\bcf\b|\bafc\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
  return TEAM_ALIASES[base] || base;
}

function teamsMatch(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  // Exact match, or one contains the other (handles "Man City" vs
  // "Manchester City" style differences without a full alias table).
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Tries SharpAPI's odds dump for a specific match by team-name matching.
// Returns null if not found or not configured (caller tries next provider).
async function getFromSharpApi(homeTeam, awayTeam) {
  if (!SHARPAPI_KEY) return null;
  try {
    const allOdds = await fetchSharpApiOdds();
    const matchRows = allOdds.filter(row =>
      teamsMatch(row.home_team, homeTeam) && teamsMatch(row.away_team, awayTeam)
    );
    if (!matchRows.length) return null;

    // Rows are one-per-(sportsbook, selection) on SharpAPI's schema — group
    // them back into a single {home, draw, away} price set. Prefer Pinnacle
    // if present (sharpest line per SharpAPI's own docs), otherwise use
    // whatever book is present (free tier only has DraftKings + FanDuel).
    const bySportsbook = {};
    matchRows.forEach(row => {
      const book = row.sportsbook || 'unknown';
      if (!bySportsbook[book]) bySportsbook[book] = {};
      const sel = (row.selection || '').toLowerCase();
      if (sel.includes(homeTeam.toLowerCase().slice(0, 4)) || teamsMatch(row.selection, homeTeam)) {
        bySportsbook[book].home = row.odds_decimal;
      } else if (sel === 'draw') {
        bySportsbook[book].draw = row.odds_decimal;
      } else if (sel.includes(awayTeam.toLowerCase().slice(0, 4)) || teamsMatch(row.selection, awayTeam)) {
        bySportsbook[book].away = row.odds_decimal;
      }
    });

    const books = Object.keys(bySportsbook);
    if (!books.length) return null;

    const preferred = books.find(b => b.toLowerCase() === 'pinnacle') || books[0];
    const source = bySportsbook[preferred];
    if (!source.home || !source.draw || !source.away) return null; // incomplete row — don't guess

    return {
      homeWin: source.home,
      draw: source.draw,
      awayWin: source.away,
      sportsbook: preferred,
      provider: 'SharpAPI',
      fetchedAt: sharpApiCache.fetchedAt
    };
  } catch (e) {
    console.error('[realOdds] SharpAPI lookup failed for ' + homeTeam + ' vs ' + awayTeam + ': ' + e.message);
    return null;
  }
}

// Tries odds-api.io for a specific match: first finds the event by team-name
// match against the cached pending-events list for the given sport, then
// fetches odds for that specific event ID. Returns null if not found, not
// configured, or the matched event has no priced odds yet (common for
// far-out fixtures). `sport` defaults to 'football' so existing callers are
// unaffected; pass 'nba' (or another odds-api.io sport slug) for other
// sports. Handles BOTH 3-way markets (football: home/draw/away) and 2-way
// markets (basketball: home/away, no draw exists in the sport) — confirmed
// against odds-api.io's own published NBA example response, which omits
// "draw" entirely rather than sending a null/zero placeholder for it.
async function getFromOddsApiIo(homeTeam, awayTeam, sport) {
  if (!ODDSAPIIO_KEYS.length) return null;
  sport = sport || 'football';
  try {
    const events = await fetchOddsApiIoEvents(sport);
    const match = events.find(e =>
      e.status === 'pending' && teamsMatch(e.home, homeTeam) && teamsMatch(e.away, awayTeam)
    );
    if (!match) return null;

    const oddsData = await fetchOddsApiIoOddsForEvent(match.id);
    const bookmakerKey = Object.keys(oddsData.bookmakers || {})[0]; // e.g. "Bet365 (no latency)"
    if (!bookmakerKey) return null;

    const mlMarket = (oddsData.bookmakers[bookmakerKey] || []).find(m => m.name === 'ML');
    if (!mlMarket || !mlMarket.odds || !mlMarket.odds[0]) return null;

    // REAL HANDICAP — odds-api.io's own response for this event already
    // includes a "Spread" market alongside "ML" (confirmed via odds-api.io's
    // own published documentation example: a single /odds call returns ML,
    // Spread, Totals, and many more markets together in one response). This
    // was previously being fetched and then thrown away, since the code
    // only ever looked for market.name === 'ML'. Extracting it here costs
    // ZERO additional API calls — it's already sitting in oddsData from the
    // fetch above. This replaces JuanAi's own mathematically-ESTIMATED
    // handicap (derived from 1X2 odds) with an actual bookmaker line
    // whenever one is available for this match.
    const spreadMarket = (oddsData.bookmakers[bookmakerKey] || []).find(m => m.name === 'Spread');
    let handicap = null;
    if (spreadMarket && spreadMarket.odds && spreadMarket.odds[0]) {
      const sp = spreadMarket.odds[0];
      if (sp.hdp != null && sp.home != null && sp.away != null) {
        handicap = {
          line: parseFloat(sp.hdp), // e.g. -1, 0, +0.5 — from the home team's perspective, matching odds-api.io's own convention
          home: parseFloat(sp.home),
          away: parseFloat(sp.away),
          isRealMarketOdds: true // matches the SAME flag name/meaning as aiOdds.isRealMarketOdds elsewhere in this codebase — true = real bookmaker price, safe for real-money use
        };
      }
    }

    const prices = mlMarket.odds[0];
    if (!prices.home || !prices.away) return null; // incomplete — don't guess
    const hasDraw = prices.draw != null; // absent for 2-way sports like basketball, present for football/soccer

    if (!hasDraw) {
      // 2-way market (basketball etc.) — no draw field to require or return.
      return {
        homeWin: parseFloat(prices.home),
        draw: null,
        awayWin: parseFloat(prices.away),
        isTwoWay: true, // flag so ai.js / the frontend know not to expect a draw price for this sport
        handicap,
        sportsbook: bookmakerKey.replace(/\s*\(no latency\)\s*/i, ''),
        provider: 'odds-api.io',
        fetchedAt: Date.now()
      };
    }

    return {
      homeWin: parseFloat(prices.home),
      draw: parseFloat(prices.draw),
      awayWin: parseFloat(prices.away),
      isTwoWay: false,
      handicap,
      sportsbook: bookmakerKey.replace(/\s*\(no latency\)\s*/i, ''), // clean up SharpAPI-style latency suffix if present
      provider: 'odds-api.io',
      fetchedAt: Date.now()
    };
  } catch (e) {
    console.error('[realOdds] odds-api.io lookup failed for ' + homeTeam + ' vs ' + awayTeam + ' (sport=' + sport + '): ' + e.message);
    return null;
  }
}

// Finds real odds for a specific match, trying SharpAPI first (faster, more
// reliable rate limit — but football/soccer only), then odds-api.io
// (broader league AND sport coverage) as a second attempt. `sport` defaults
// to 'football' so existing football callers are unaffected. Returns null
// if neither provider has this match — caller falls back to AI-generated
// odds in that case.
async function getRealOddsForMatch(homeTeam, awayTeam, sport) {
  if (!isConfigured()) return null;
  sport = sport || 'football';

  // SharpAPI is football-only (see the module header note on both
  // providers' real, tested coverage) — skip it entirely for other sports
  // rather than wasting a throttled call that can never succeed.
  if (sport === 'football') {
    const fromSharp = await getFromSharpApi(homeTeam, awayTeam);
    if (fromSharp) return fromSharp;
  }

  const fromOddsApiIo = await getFromOddsApiIo(homeTeam, awayTeam, sport);
  if (fromOddsApiIo) return fromOddsApiIo;

  return null; // neither provider covers this match — caller falls back to AI
}

function getOddsApiIoKeyPoolStatus() {
  const now = Date.now();
  oddsApiIoKeyState.forEach(refreshKeyDailyWindow);
  const perKey = oddsApiIoKeyState.map(s => {
    s.hourlyTimestamps = s.hourlyTimestamps.filter(t => now - t < 3600000);
    return {
      keyPreview: s.key.slice(0, 6) + '...',
      callsInLastHour: s.hourlyTimestamps.length,
      hourlyBudget: ODDSAPIIO_HOURLY_BUDGET_PER_KEY,
      callsToday: s.dailyCount,
      dailyBudget: ODDSAPIIO_DAILY_BUDGET_PER_KEY,
      blocked: now < s.blockedUntil,
      availableInMinutes: s.blockedUntil > now ? Math.ceil((s.blockedUntil - now) / 60000) : 0
    };
  });
  const usableNow = perKey.filter(k => !k.blocked && k.callsInLastHour < k.hourlyBudget && k.callsToday < k.dailyBudget);
  return {
    totalKeys: oddsApiIoKeyState.length,
    availableKeys: usableNow.length,
    // Combined capacity across every key — this is the number that
    // actually answers "how much daily headroom do I really have," which
    // is what adding more accounts is meant to increase. Compare this
    // total against what a single key alone would give you (1 x
    // ODDSAPIIO_DAILY_BUDGET_PER_KEY) to see whether extra keys are
    // actually paying off.
    totalDailyBudgetAcrossAllKeys: oddsApiIoKeyState.length * ODDSAPIIO_DAILY_BUDGET_PER_KEY,
    totalCallsTodayAcrossAllKeys: perKey.reduce((sum, k) => sum + k.callsToday, 0),
    lastCachedEventsAgeSeconds: oddsApiIoCacheBySport.football ? Math.round((now - oddsApiIoCacheBySport.football.fetchedAt) / 1000) : null,
    perKey,
    blockedOrExhaustedKeys: perKey.filter(k => k.blocked || k.callsInLastHour >= k.hourlyBudget || k.callsToday >= k.dailyBudget)
  };
}

module.exports = { isConfigured, getRealOddsForMatch, teamsMatch, normalizeTeamName, fetchOddsApiIoEvents, fetchOddsApiIoLiveClocks, isOddsApiIoConfigured: () => ODDSAPIIO_KEYS.length > 0, getOddsApiIoKeyPoolStatus };
