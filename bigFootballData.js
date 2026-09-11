// bigFootballData.js — real fixtures, live scores, events, odds and
// standings from the BigBallsData / "BigFootball" API, fetched server-side.
//
// STATUS OF THIS INTEGRATION (read this before wiring it into betting
// logic): this file is PHASE 1 — a standalone, fully working client for
// BigFootball with real rate-limit protection, caching and error handling.
// It is deliberately NOT yet wired into scheduler.js's Mongo-backed
// fixture pipeline or into /api/fixtures (the endpoint the betting UI and
// settlement logic actually read from) — see server.js's new
// /api/bigfootball/* routes instead, plus GET /api/bigfootball/test.
//
// That's on purpose, per the explicit instruction that came with this
// integration: confirm the API actually returns good data for today's
// matches, live matches, events and odds BEFORE anything touches
// betting/settlement. This file's field-normalizers (normalizeMatch,
// normalizeEvent, normalizeOdds below) were written defensively — trying
// several plausible field-name variants — because BigFootball's exact
// JSON shape has never actually been queried yet (no network access was
// available while writing this, and the account is brand new). Hit
// GET /api/bigfootball/test once real traffic is flowing; it returns the
// RAW provider response next to the normalized one so any field-name
// mismatch is a five-minute fix here, not a guess.
//
// Once that's confirmed good, the natural next step is: point
// scheduler.js's fixture refresh at getMatchesForDate/getLiveMatches
// below instead of (or ahead of) footballData.js's football-data.org
// calls, so /api/fixtures itself serves BigFootball data. Not done yet —
// see the note above.

const BIGFOOTBALL_API_KEY = process.env.BIGFOOTBALL_API_KEY || '';
const BIGFOOTBALL_BASE_URL = process.env.BIGFOOTBALL_BASE_URL || 'https://api.bigballsdata.com';

if (!BIGFOOTBALL_API_KEY) {
  console.warn('[bigFootballData] BIGFOOTBALL_API_KEY is not set — BigFootball requests will fail until it is configured. See .env.example.');
}

// ── Rate limiting ───────────────────────────────────────────────────────
// Real account limits: 100 requests/minute, 2,000 requests/day. We stay
// under both with a safety margin, the same philosophy footballData.js
// already uses for football-data.org (never trust "the limit" as a target
// to fully use — a burst right at the edge risks a block that can outlast
// a simple window reset on some providers).
const PER_MINUTE_LIMIT = 90;   // real cap is 100/min — keep headroom for /health + /test hits
const PER_DAY_SAFETY_CAP = 1900; // real cap is 2000/day — stop well before actually hitting it

const minuteWindow = []; // timestamps (ms) of requests in the last 60s
let dayKey = '';
let dayCount = 0;

function currentDayKey() {
  return new Date().toISOString().slice(0, 10); // UTC date, resets at UTC midnight
}

function pruneMinuteWindow() {
  const cutoff = Date.now() - 60 * 1000;
  while (minuteWindow.length && minuteWindow[0] < cutoff) minuteWindow.shift();
}

function rolloverDayIfNeeded() {
  const today = currentDayKey();
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
}

// Waits (if needed) until a request slot is free under the per-minute
// ceiling, then reserves it. Throws immediately (does not wait) if the
// daily safety cap is already hit — waiting out a full day makes no sense
// for a live request, callers should fall back to cache/graceful-empty
// instead (see cachedFetch below).
async function reserveRequestSlot() {
  rolloverDayIfNeeded();
  if (dayCount >= PER_DAY_SAFETY_CAP) {
    throw new Error('BigFootball daily request budget (' + PER_DAY_SAFETY_CAP + '/' + PER_DAY_SAFETY_CAP + ' safety cap) is used up for today — serving cached data only until the daily reset.');
  }
  pruneMinuteWindow();
  if (minuteWindow.length >= PER_MINUTE_LIMIT) {
    const waitMs = (minuteWindow[0] + 60 * 1000) - Date.now();
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    pruneMinuteWindow();
  }
  minuteWindow.push(Date.now());
  dayCount++;
}

function getRateLimitStatus() {
  rolloverDayIfNeeded();
  pruneMinuteWindow();
  return {
    perMinute: { used: minuteWindow.length, limit: PER_MINUTE_LIMIT, realLimit: 100 },
    perDay: { used: dayCount, safetyCap: PER_DAY_SAFETY_CAP, realLimit: 2000, day: dayKey || currentDayKey() }
  };
}

// ── Low-level HTTP with timeout + graceful error classification ────────
const REQUEST_TIMEOUT_MS = 12000;

async function bfRequest(endpoint) {
  if (!BIGFOOTBALL_API_KEY) {
    throw new Error('BIGFOOTBALL_API_KEY is not configured');
  }
  await reserveRequestSlot();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = BIGFOOTBALL_BASE_URL + endpoint;

  let resp;
  try {
    resp = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + BIGFOOTBALL_API_KEY },
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('BigFootball request timed out after ' + REQUEST_TIMEOUT_MS + 'ms: ' + endpoint);
    }
    throw new Error('BigFootball request failed (network error): ' + e.message);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 429) {
    const retryAfter = resp.headers.get('retry-after');
    throw new Error('BigFootball rate limit hit (HTTP 429)' + (retryAfter ? ' — retry after ' + retryAfter + 's' : '') + ' on ' + endpoint);
  }
  if (resp.status === 401 || resp.status === 403) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error('BigFootball auth error (HTTP ' + resp.status + ') — check BIGFOOTBALL_API_KEY' + (bodyText ? ': ' + bodyText.slice(0, 200) : ''));
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error('BigFootball HTTP ' + resp.status + (bodyText ? ': ' + bodyText.slice(0, 200) : '') + ' on ' + endpoint);
  }
  try {
    return await resp.json();
  } catch (e) {
    throw new Error('BigFootball returned a non-JSON response on ' + endpoint);
  }
}

// ── Caching layer ───────────────────────────────────────────────────────
// Every cache entry keeps its last-good value even after expiring, so a
// live failure (rate limit, timeout, upstream 5xx) can fall back to
// "stale but real" data instead of an empty/broken response — see
// cachedFetch. Cache is in-memory only (per process), which is fine here:
// unlike API keys/fixtures in db.js, this is a short-lived read-through
// cache, not data that needs to survive a restart.
const cache = new Map(); // key -> { data, expiresAt, isFinal }

async function cachedFetch(key, ttlMs, fetchFn, opts) {
  const entry = cache.get(key);
  const now = Date.now();
  if (entry && entry.expiresAt > now) {
    return { data: entry.data, stale: false, fromCache: true };
  }
  try {
    const data = await fetchFn();
    // If the caller says this result represents a finished/immutable
    // state (e.g. a FINISHED match's odds/events never change again),
    // cache it far longer than the normal TTL — no point re-spending
    // quota on something that can't change.
    const finalTtl = (opts && opts.isFinal && opts.isFinal(data)) ? 60 * 60 * 1000 : ttlMs;
    cache.set(key, { data, expiresAt: now + finalTtl, isFinal: !!(opts && opts.isFinal && opts.isFinal(data)) });
    return { data, stale: false, fromCache: false };
  } catch (e) {
    if (entry) {
      console.error('[bigFootballData] live fetch failed for ' + key + ' (' + e.message + ') — serving stale cached data instead');
      return { data: entry.data, stale: true, staleReason: e.message, fromCache: true };
    }
    throw e; // no cache to fall back to — let the caller decide (empty result + error, per route)
  }
}

function qs(params) {
  const parts = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v));
  return parts.length ? '?' + parts.join('&') : '';
}

// ── Field normalization ─────────────────────────────────────────────────
// Defensive on purpose — see the file-header note. `pick` walks a list of
// candidate paths (dot-notation) and returns the first defined value.
function pick(obj, paths, fallback) {
  for (const path of paths) {
    const val = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (val !== undefined && val !== null) return val;
  }
  return fallback;
}

// Maps whatever status string/shape BigFootball uses onto the same
// vocabulary the rest of this codebase already expects from
// footballData.js: SCHEDULED / IN_PLAY / PAUSED / FINISHED (plus
// POSTPONED/CANCELLED passed through uppercased). Extend the arrays below
// the moment /api/bigfootball/test shows the real values in use.
function normalizeStatus(raw) {
  const s = String(raw == null ? '' : raw).toLowerCase().trim();
  if (!s) return 'SCHEDULED';
  if (['live', 'in_play', 'inplay', 'in-play', '1h', '2h', 'first_half', 'second_half', 'et'].includes(s)) return 'IN_PLAY';
  if (['ht', 'halftime', 'half_time', 'paused', 'break'].includes(s)) return 'PAUSED';
  if (['ns', 'not_started', 'notstarted', 'scheduled', 'upcoming', 'pre', 'tbd'].includes(s)) return 'SCHEDULED';
  if (['ft', 'finished', 'ended', 'full_time', 'fulltime', 'aet', 'pen'].includes(s)) return 'FINISHED';
  if (['pst', 'postponed'].includes(s)) return 'POSTPONED';
  if (['canc', 'cancelled', 'canceled'].includes(s)) return 'CANCELLED';
  if (['abd', 'abandoned'].includes(s)) return 'ABANDONED';
  return s.toUpperCase();
}

function normalizeTeam(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return { id: null, name: raw, crest: null };
  return {
    id: pick(raw, ['id', 'team_id', 'teamId'], null),
    name: pick(raw, ['name', 'team_name', 'teamName', 'short_name']),
    crest: pick(raw, ['crest', 'logo', 'badge', 'image'], null)
  };
}

// Normalizes onto the SAME score.fullTime.home/.away shape footballData.js
// already normalizes football-data.org onto (see normalizeFdScore there) —
// this is what keeps existing frontend code that reads
// match.score.fullTime.home/.away working unchanged regardless of source.
function normalizeScore(raw) {
  const home = pick(raw, [
    'score.fullTime.home', 'score.full_time.home', 'score.home', 'score.home_score',
    'goals.home', 'home_score', 'homeScore'
  ], null);
  const away = pick(raw, [
    'score.fullTime.away', 'score.full_time.away', 'score.away', 'score.away_score',
    'goals.away', 'away_score', 'awayScore'
  ], null);
  const htHome = pick(raw, ['score.halfTime.home', 'score.half_time.home'], null);
  const htAway = pick(raw, ['score.halfTime.away', 'score.half_time.away'], null);
  return {
    fullTime: (home != null || away != null) ? { home, away } : null,
    halfTime: (htHome != null || htAway != null) ? { home: htHome, away: htAway } : null
  };
}

// Some fields (competition/league in particular) turned out, from a real
// response, to not match any of the object-shaped guesses below — pulls
// whichever candidate exists and handles it whether it's a plain string
// ("Bundesliga") or an object ({id, name}).
function pickNameOrObject(raw, paths) {
  for (const path of paths) {
    const val = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), raw);
    if (val == null) continue;
    if (typeof val === 'string') return { id: null, name: val };
    if (typeof val === 'object') return { id: val.id != null ? val.id : null, name: val.name || val.title || null };
  }
  return { id: null, name: null };
}

function normalizeMatch(raw) {
  if (!raw) return null;
  const statusRaw = pick(raw, ['status', 'state', 'fixture.status', 'match_status']);
  const competition = pickNameOrObject(raw, ['league', 'competition', 'tournament', 'sport']);
  return {
    id: pick(raw, ['id', 'match_id', 'matchId', 'fixture_id']),
    source: 'bigfootball',
    utcDate: pick(raw, ['utcDate', 'date', 'start_time', 'startTime', 'kickoff', 'scheduled', 'datetime']),
    status: normalizeStatus(statusRaw),
    minute: pick(raw, ['minute', 'elapsed', 'time.elapsed', 'time.minute', 'clock', 'live_minute', 'liveMinute', 'game_time', 'gameTime'], null),
    homeTeam: normalizeTeam(pick(raw, ['homeTeam', 'home_team', 'teams.home', 'home'])),
    awayTeam: normalizeTeam(pick(raw, ['awayTeam', 'away_team', 'teams.away', 'away'])),
    score: normalizeScore(raw),
    competition,
    venue: pick(raw, ['venue', 'stadium', 'location'], null),
    _rawStatus: statusRaw, // kept for debugging via /api/bigfootball/test — remove once statuses are fully confirmed
    _raw: raw // TEMPORARY: full untouched provider object, so /api/bigfootball/test can show it — strip this once every field mapping above is confirmed correct
  };
}

function normalizeEvent(raw) {
  if (!raw) return null;
  const typeRaw = String(pick(raw, ['type', 'event_type', 'eventType'], '')).toLowerCase();
  let type = 'OTHER';
  if (typeRaw.includes('goal')) type = 'GOAL';
  else if (typeRaw.includes('card')) type = typeRaw.includes('red') ? 'RED_CARD' : typeRaw.includes('yellow') ? 'YELLOW_CARD' : 'CARD';
  else if (typeRaw.includes('sub')) type = 'SUBSTITUTION';
  // A real sample showed the scorer's name landing in `detail`, not any of
  // the `player.*` guesses — so `detail` is tried as a player-name fallback
  // too, specifically for goal/card events where "detail" realistically can
  // only be who it happened to, not a free-text description.
  const detail = pick(raw, ['detail', 'description'], null);
  const player = pick(raw, ['player.name', 'player', 'player_name', 'scorer.name', 'scorer'], null)
    || ((type === 'GOAL' || type === 'RED_CARD' || type === 'YELLOW_CARD' || type === 'CARD') ? detail : null);
  return {
    id: pick(raw, ['id', 'event_id'], null),
    minute: pick(raw, ['minute', 'time', 'elapsed', 'time.minute'], null),
    type,
    rawType: typeRaw || null,
    team: pick(raw, ['team.name', 'team', 'side'], null),
    player,
    assist: pick(raw, ['assist.name', 'assist', 'assist_name'], null),
    playerIn: pick(raw, ['player_in.name', 'playerIn', 'in.name'], null),
    playerOut: pick(raw, ['player_out.name', 'playerOut', 'out.name'], null),
    detail,
    _raw: raw // TEMPORARY: see normalizeMatch's _raw note — same reason
  };
}

// Odds shapes vary the most between providers, so this stays close to a
// pass-through: it lifts out the obvious top-level fields and leaves
// `markets`/`bookmakers` as BigFootball actually sends them (whatever that
// turns out to be) rather than guessing a market taxonomy that might be
// wrong. Confirm the real shape via /api/bigfootball/test before building
// UI directly on top of `markets`.
function normalizeOdds(raw) {
  if (!raw) return null;
  return {
    matchId: pick(raw, ['match_id', 'matchId', 'id'], null),
    updatedAt: pick(raw, ['updated_at', 'updatedAt', 'timestamp'], null),
    bookmaker: pick(raw, ['bookmaker', 'provider', 'source'], null),
    markets: pick(raw, ['markets', 'odds', 'bets'], []),
    raw
  };
}

// ── Public API ───────────────────────────────────────────────────────────

async function getUsage(forceFresh) {
  if (forceFresh) return bfRequest('/v1/usage');
  const { data } = await cachedFetch('usage', 30 * 1000, () => bfRequest('/v1/usage'));
  return data;
}

async function getSports() {
  const { data } = await cachedFetch('sports', 24 * 60 * 60 * 1000, () => bfRequest('/v1/sports'));
  return data;
}

async function getLeagues() {
  const { data } = await cachedFetch('leagues', 24 * 60 * 60 * 1000, () => bfRequest('/v1/leagues'));
  return data;
}

// Matches for a given date, optionally filtered by sport/league/status.
// TTL depends on what's being asked for: a live-status query needs to be
// fresh (short TTL, drives auto-refresh for live matches per the caller's
// polling interval); a plain date query for today needs to be reasonably
// fresh; anything else (other days, finished-only) can sit much longer —
// this is the actual mechanism behind "don't repeatedly request
// unnecessary historical matches".
function matchesCacheKey(params) {
  return 'matches:' + JSON.stringify(params || {});
}

function matchesTtlMs(params) {
  if (params && params.status && String(params.status).toLowerCase().includes('live')) return 15 * 1000;
  const today = new Date().toISOString().slice(0, 10);
  if (!params || !params.date || params.date === today) return 45 * 1000;
  return 5 * 60 * 1000;
}

async function getMatches(params) {
  const key = matchesCacheKey(params);
  const ttl = matchesTtlMs(params);
  const result = await cachedFetch(key, ttl, () => bfRequest('/v1/matches' + qs(params)));
  const list = pick(result.data, ['matches', 'data', 'results'], Array.isArray(result.data) ? result.data : []);
  return {
    matches: (list || []).map(normalizeMatch).filter(Boolean),
    stale: result.stale,
    staleReason: result.staleReason
  };
}

function getDateString(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + parseInt(daysAhead || 0, 10));
  return d.toISOString().split('T')[0];
}

async function getMatchesForDate(dateStr) {
  return getMatches({ sport: 'football', date: dateStr });
}

// Live matches specifically — separate helper since it's the one query
// that needs to poll frequently (short TTL above) and is what
// item 3/10 ("auto refresh for live matches") is actually built on: the
// caller (a route, or eventually scheduler.js) can poll this on a short
// interval, and it will only hit BigFootball for real once every 15s no
// matter how often it's called, serving cache in between.
async function getLiveMatches() {
  return getMatches({ sport: 'football', status: 'live' });
}

async function getMatchById(id) {
  const key = 'match:' + id;
  const result = await cachedFetch(key, 20 * 1000, () => bfRequest('/v1/matches/' + encodeURIComponent(id)), {
    isFinal: (raw) => normalizeStatus(pick(raw, ['status', 'state'])) === 'FINISHED'
  });
  return { match: normalizeMatch(pick(result.data, ['match', 'data'], result.data)), stale: result.stale, staleReason: result.staleReason };
}

async function getMatchOdds(id) {
  const key = 'odds:' + id;
  const result = await cachedFetch(key, 30 * 1000, () => bfRequest('/v1/matches/' + encodeURIComponent(id) + '/odds'));
  const rawOdds = pick(result.data, ['odds', 'data'], result.data);
  return {
    odds: Array.isArray(rawOdds) ? rawOdds.map(normalizeOdds) : normalizeOdds(rawOdds),
    stale: result.stale,
    staleReason: result.staleReason
  };
}

async function getMatchEvents(id) {
  const key = 'events:' + id;
  const result = await cachedFetch(key, 12 * 1000, () => bfRequest('/v1/matches/' + encodeURIComponent(id) + '/events'));
  const list = pick(result.data, ['events', 'data'], Array.isArray(result.data) ? result.data : []);
  return {
    events: (list || []).map(normalizeEvent).filter(Boolean),
    stale: result.stale,
    staleReason: result.staleReason
  };
}

async function getStandings(params) {
  const key = 'standings:' + JSON.stringify(params || {});
  const result = await cachedFetch(key, 10 * 60 * 1000, () => bfRequest('/v1/standings' + qs(params)));
  return { standings: pick(result.data, ['standings', 'data'], result.data), stale: result.stale, staleReason: result.staleReason };
}

async function getInjuries(params) {
  const key = 'injuries:' + JSON.stringify(params || {});
  const result = await cachedFetch(key, 30 * 60 * 1000, () => bfRequest('/v1/injuries' + qs(params)));
  return { injuries: pick(result.data, ['injuries', 'data'], result.data), stale: result.stale, staleReason: result.staleReason };
}

async function getPredictions(params) {
  const key = 'predictions:' + JSON.stringify(params || {});
  const result = await cachedFetch(key, 10 * 60 * 1000, () => bfRequest('/v1/predictions' + qs(params)));
  return { predictions: pick(result.data, ['predictions', 'data'], result.data), stale: result.stale, staleReason: result.staleReason };
}

async function getTeams(params) {
  const key = 'teams:' + JSON.stringify(params || {});
  const result = await cachedFetch(key, 24 * 60 * 60 * 1000, () => bfRequest('/v1/teams' + qs(params)));
  return pick(result.data, ['teams', 'data'], result.data);
}

async function getPlayers(params) {
  const key = 'players:' + JSON.stringify(params || {});
  const result = await cachedFetch(key, 24 * 60 * 60 * 1000, () => bfRequest('/v1/players' + qs(params)));
  return pick(result.data, ['players', 'data'], result.data);
}

// Runs the exact confirmation sequence the integration was asked to prove
// out before anything touches betting/settlement: today's matches, live
// matches, events for one live match, odds for one match. Bypasses the
// normal cache (force=true style) only for the /v1/usage call, since the
// whole point is a live connectivity check — everything else still goes
// through the normal cached path so this endpoint doesn't itself burn
// through the daily budget if hit repeatedly.
async function runConnectionTest() {
  const out = { ok: true, checkedAt: new Date().toISOString(), steps: {} };

  try {
    const t0 = Date.now();
    const usage = await getUsage(true);
    out.steps.usage = { ok: true, latencyMs: Date.now() - t0, raw: usage };
  } catch (e) {
    out.ok = false;
    out.steps.usage = { ok: false, error: e.message };
  }

  let todayMatches = [];
  try {
    const today = getDateString(0);
    const res = await getMatchesForDate(today);
    todayMatches = res.matches;
    out.steps.todayMatches = { ok: true, date: today, count: todayMatches.length, sample: todayMatches.slice(0, 3) };
  } catch (e) {
    out.ok = false;
    out.steps.todayMatches = { ok: false, error: e.message };
  }

  let liveMatches = [];
  try {
    const res = await getLiveMatches();
    liveMatches = res.matches;
    out.steps.liveMatches = { ok: true, count: liveMatches.length, sample: liveMatches.slice(0, 3) };
  } catch (e) {
    out.ok = false;
    out.steps.liveMatches = { ok: false, error: e.message };
  }

  const sampleLive = liveMatches[0] || todayMatches[0] || null;
  if (sampleLive && sampleLive.id != null) {
    try {
      const res = await getMatchEvents(sampleLive.id);
      out.steps.events = { ok: true, matchId: sampleLive.id, count: res.events.length, sample: res.events.slice(0, 5) };
    } catch (e) {
      out.steps.events = { ok: false, matchId: sampleLive.id, error: e.message };
    }
    try {
      const res = await getMatchOdds(sampleLive.id);
      out.steps.odds = { ok: true, matchId: sampleLive.id, result: res.odds };
    } catch (e) {
      out.steps.odds = { ok: false, matchId: sampleLive.id, error: e.message };
    }
    // Free-tier odds returned 403 "requires Edge plan" in testing — checking
    // predictions too, since it's a separate endpoint that might not be
    // behind the same plan gate and could stand in for real odds on Free.
    try {
      const res = await getPredictions({ match: sampleLive.id });
      out.steps.predictions = { ok: true, matchId: sampleLive.id, result: res.predictions };
    } catch (e) {
      out.steps.predictions = { ok: false, matchId: sampleLive.id, error: e.message };
    }
  } else {
    out.steps.events = { ok: null, note: 'No live or today match id available to test against yet' };
    out.steps.odds = { ok: null, note: 'No live or today match id available to test against yet' };
    out.steps.predictions = { ok: null, note: 'No live or today match id available to test against yet' };
  }

  out.rateLimit = getRateLimitStatus();
  return out;
}

module.exports = {
  getUsage,
  getSports,
  getLeagues,
  getMatches,
  getMatchesForDate,
  getLiveMatches,
  getMatchById,
  getMatchOdds,
  getMatchEvents,
  getStandings,
  getInjuries,
  getPredictions,
  getTeams,
  getPlayers,
  getDateString,
  getRateLimitStatus,
  runConnectionTest,
  // exported for testing/inspection only
  normalizeMatch,
  normalizeEvent,
  normalizeOdds,
  normalizeStatus
};
