// bigFootballData.js — real fixtures, live scores, events and odds from the
// BigBallsData / BigFootball API.
//
// This is the NEW primary football data source, replacing football-data.org
// + odds-api.io (footballData.js) as the source of truth for fixtures, live
// scores, match events and odds. footballData.js is left in place untouched
// (h2h/team-form lookups still use it, and it's a safe fallback), but the
// scheduler now pulls matches/live-state/events/odds from here first.
//
// Auth: `Authorization: Bearer ${BIGFOOTBALL_API_KEY}` — the key lives ONLY
// in this server's environment (.env / Render env vars), never sent to the
// browser. There is no client-side code anywhere in this file.
//
// Plan limits (Free + GitHub connected): 100 requests/minute, 2,000
// requests/day. Both are enforced client-side below (in addition to
// whatever the API itself returns on 429) so a bug here can't silently
// burn through the whole daily quota.

const BASE_URL = (process.env.BIGFOOTBALL_BASE_URL || 'https://api.bigballsdata.com').replace(/\/+$/, '');
const API_KEY = process.env.BIGFOOTBALL_API_KEY || '';

if (!API_KEY) {
  console.warn('[bigFootballData] BIGFOOTBALL_API_KEY is not set — BigFootball requests will fail until it is configured in .env.');
}

const REQUEST_TIMEOUT_MS = 10000;

// ── Rate limiting: 100 req/min, 2000 req/day ───────────────────────────
// Tracked purely in-memory. This resets on a restart, which under-counts
// slightly (a redeploy mid-day forgets requests already spent), but that's
// the safe direction to be wrong in — it never OVER-reports remaining
// quota to the provider itself, it can only make us more conservative
// than necessary for the rest of that day. Good enough for a free-tier
// key; persisting this to Mongo would be the next step if that ever
// becomes a real problem.
const MINUTE_LIMIT = 100;
const DAY_LIMIT = 2000;
// Keep a safety margin below the hard caps rather than riding the exact
// line — a few concurrent in-flight requests landing in the same instant
// shouldn't be able to tip the account over its real limit.
const MINUTE_SAFETY_LIMIT = 90;
const DAY_SAFETY_LIMIT = 1900;

let minuteWindowStart = Date.now();
let minuteCount = 0;
let dayWindowStart = new Date().toISOString().slice(0, 10); // UTC date string
let dayCount = 0;

function rollWindows() {
  const now = Date.now();
  if (now - minuteWindowStart >= 60 * 1000) {
    minuteWindowStart = now;
    minuteCount = 0;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayWindowStart) {
    dayWindowStart = today;
    dayCount = 0;
  }
}

function getRateLimitStatus() {
  rollWindows();
  return {
    minute: { used: minuteCount, limit: MINUTE_LIMIT, safetyLimit: MINUTE_SAFETY_LIMIT, resetsInMs: Math.max(0, 60000 - (Date.now() - minuteWindowStart)) },
    day: { used: dayCount, limit: DAY_LIMIT, safetyLimit: DAY_SAFETY_LIMIT, date: dayWindowStart }
  };
}

// Returns null if a request can go out right now, or the number of ms to
// wait before it's safe to try again.
function checkBudget() {
  rollWindows();
  if (dayCount >= DAY_SAFETY_LIMIT) {
    // Daily budget is done for today — no amount of waiting helps until
    // UTC midnight, so callers should treat this as "no data available
    // right now" rather than retry in a loop.
    return { blocked: true, reason: 'daily', retryAfterMs: null };
  }
  if (minuteCount >= MINUTE_SAFETY_LIMIT) {
    return { blocked: true, reason: 'minute', retryAfterMs: Math.max(0, 60000 - (Date.now() - minuteWindowStart)) + 250 };
  }
  return { blocked: false };
}

function recordRequest() {
  rollWindows();
  minuteCount++;
  dayCount++;
}

// ── Simple in-memory response cache ────────────────────────────────────
// Every endpoint below is cached with a TTL suited to how fast that data
// actually changes — this is what keeps a 2,000/day budget realistic once
// several live matches are being polled every few seconds by the
// frontend/scheduler. A cache hit costs zero requests and doesn't touch
// the rate limiter at all.
const cache = new Map(); // key -> { expiresAt, value }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  // Opportunistic cleanup so the Map doesn't grow forever across a long
  // uptime — cheap, and only runs on writes.
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
  }
}

const TTL = {
  SPORTS: 12 * 60 * 60 * 1000,      // 12h — essentially static
  LEAGUES: 12 * 60 * 60 * 1000,     // 12h — essentially static
  TEAMS: 60 * 60 * 1000,            // 1h
  PLAYERS: 60 * 60 * 1000,          // 1h
  STANDINGS: 10 * 60 * 1000,        // 10m — changes only when a match finishes
  INJURIES: 30 * 60 * 1000,         // 30m
  PREDICTIONS: 15 * 60 * 1000,      // 15m
  MATCHES_TODAY: 45 * 1000,         // today's list, non-live — refreshed often but not on every request
  MATCHES_LIVE: 12 * 1000,          // the live-status list itself — short, this drives "is anything live right now"
  MATCH_DETAIL_LIVE: 12 * 1000,     // a single live match's detail
  MATCH_DETAIL_FINAL: 30 * 60 * 1000, // a finished/not-started match's detail barely changes
  EVENTS_LIVE: 10 * 1000,           // events for a currently-live match — this is what powers goal/card/sub updates
  EVENTS_FINAL: 30 * 60 * 1000,     // events for a match that's over are final
  ODDS_LIVE: 15 * 1000,             // in-play odds move fast
  ODDS_PREMATCH: 5 * 60 * 1000      // pre-match odds move slowly
};

// ── Core fetch wrapper ──────────────────────────────────────────────────
// Handles: auth header, timeout, 429/backoff, transient 5xx retry (once),
// empty-body/parse safety, and the client-side rate budget above. Throws a
// descriptive Error on real failure — callers decide whether to surface
// that or degrade gracefully (see the getX wrappers below, which mostly
// choose to degrade).
async function bfFetch(pathAndQuery, { retried = false } = {}) {
  if (!API_KEY) {
    throw new Error('BIGFOOTBALL_API_KEY is not configured');
  }

  const budget = checkBudget();
  if (budget.blocked) {
    if (budget.reason === 'daily') {
      throw new Error('BigFootball daily request budget (' + DAY_SAFETY_LIMIT + '/' + DAY_LIMIT + ') is used up for today — resets at UTC midnight');
    }
    // Minute budget — worth a short wait rather than failing outright,
    // since it clears itself within a few seconds at most.
    await new Promise(r => setTimeout(r, budget.retryAfterMs));
  }

  const url = BASE_URL + pathAndQuery;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let resp;
  try {
    recordRequest();
    resp = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Accept': 'application/json' },
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error('BigFootball request timed out after ' + REQUEST_TIMEOUT_MS + 'ms: ' + pathAndQuery);
    }
    throw new Error('BigFootball request failed: ' + e.message);
  }
  clearTimeout(timer);

  if (resp.status === 429) {
    // Respect Retry-After if the API sends one; otherwise back off 5s and
    // retry ONCE — a single retry here is about not failing a whole
    // fixture refresh over one momentary bump, not a substitute for the
    // client-side budget above, which is what actually prevents this in
    // normal operation.
    if (!retried) {
      const retryAfterHeader = resp.headers.get('retry-after');
      const waitMs = retryAfterHeader ? Math.min(30000, parseInt(retryAfterHeader, 10) * 1000) : 5000;
      console.warn('[bigFootballData] 429 rate limited on ' + pathAndQuery + ' — waiting ' + waitMs + 'ms and retrying once');
      await new Promise(r => setTimeout(r, waitMs));
      return bfFetch(pathAndQuery, { retried: true });
    }
    throw new Error('BigFootball HTTP 429 (rate limited) on ' + pathAndQuery);
  }

  if (resp.status >= 500 && !retried) {
    // Transient server error — one short retry, same philosophy as 429.
    await new Promise(r => setTimeout(r, 1500));
    return bfFetch(pathAndQuery, { retried: true });
  }

  if (!resp.ok) {
    let bodyText = '';
    try { bodyText = await resp.text(); } catch (_) {}
    throw new Error('BigFootball HTTP ' + resp.status + (bodyText ? ': ' + bodyText.slice(0, 300) : '') + ' on ' + pathAndQuery);
  }

  try {
    return await resp.json();
  } catch (e) {
    throw new Error('BigFootball returned a non-JSON response for ' + pathAndQuery);
  }
}

// Cached GET — the shared path every getX function below funnels through.
async function cachedGet(cacheKey, pathAndQuery, ttlMs) {
  const hit = cacheGet(cacheKey);
  if (hit !== undefined) return hit;
  const data = await bfFetch(pathAndQuery);
  cacheSet(cacheKey, data, ttlMs);
  return data;
}

function qs(params) {
  const parts = [];
  for (const k in params) {
    if (params[k] === undefined || params[k] === null || params[k] === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// Unwraps whatever envelope shape the API uses for a list response —
// BigFootball's exact wrapper isn't documented anywhere we have access to,
// so this tries the common shapes defensively instead of assuming one.
// Logged once per distinct top-level key set so unexpected shapes are
// easy to spot in the logs without spamming them every request.
const loggedShapes = new Set();
function unwrapList(data, endpointLabel) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];

  // Surface a real API-reported error distinctly from an empty/no-data
  // response — these look identical structurally ({data:null,...}) but
  // mean very different things.
  if (data.error) {
    console.warn('[bigFootballData] ' + endpointLabel + ' responded with an error field: ' + JSON.stringify(data.error).slice(0, 300));
    return [];
  }

  const candidates = ['data', 'matches', 'results', 'items', 'sports', 'leagues', 'teams', 'players', 'standings', 'injuries', 'predictions', 'events'];
  for (const key of candidates) {
    if (Array.isArray(data[key])) return data[key];
    // A present-but-null/undefined `data`/`events`/etc with no `error`
    // alongside it is a legitimate empty result (e.g. "no events yet for
    // this match"), not an unrecognized shape — return [] quietly rather
    // than warning every time a live match simply hasn't had a goal/card
    // yet.
    if ((key === 'data' || key === 'events') && key in data && (data[key] === null || data[key] === undefined)) {
      return [];
    }
  }
  const shapeKey = endpointLabel + ':' + Object.keys(data).sort().join(',');
  if (!loggedShapes.has(shapeKey)) {
    loggedShapes.add(shapeKey);
    console.warn('[bigFootballData] unrecognized list shape for ' + endpointLabel + ' — full response (truncated): ' + JSON.stringify(data).slice(0, 500) + '. Returning [] for this call; check bigFootballData.js unwrapList().');
  }
  return [];
}

// ── Status normalization ────────────────────────────────────────────────
// Maps whatever status strings BigFootball uses onto the SAME vocabulary
// footballData.js already uses everywhere else in this app (SCHEDULED,
// IN_PLAY, PAUSED, FINISHED, POSTPONED, CANCELLED, SUSPENDED) — this is
// what lets server.js's existing isLive()/recomputeLiveMinutes() logic and
// the frontend keep working unchanged. Covers the common spellings a
// sports API tends to use; anything unrecognized passes through uppercased
// (logged once) rather than being silently dropped, so a status this app
// doesn't yet know about still shows up instead of disappearing.
const STATUS_MAP = {
  'scheduled': 'SCHEDULED', 'not_started': 'SCHEDULED', 'upcoming': 'SCHEDULED', 'ns': 'SCHEDULED', 'timed': 'SCHEDULED',
  'live': 'IN_PLAY', 'in_play': 'IN_PLAY', 'inplay': 'IN_PLAY', '1h': 'IN_PLAY', '2h': 'IN_PLAY', 'playing': 'IN_PLAY',
  'ht': 'PAUSED', 'halftime': 'PAUSED', 'half_time': 'PAUSED', 'paused': 'PAUSED',
  'finished': 'FINISHED', 'ft': 'FINISHED', 'full_time': 'FINISHED', 'ended': 'FINISHED', 'complete': 'FINISHED',
  'postponed': 'POSTPONED', 'cancelled': 'CANCELLED', 'canceled': 'CANCELLED', 'abandoned': 'CANCELLED', 'suspended': 'SUSPENDED'
};
const loggedStatuses = new Set();
function normalizeStatus(raw) {
  if (!raw) return 'SCHEDULED';
  const key = String(raw).toLowerCase().trim();
  if (STATUS_MAP[key]) return STATUS_MAP[key];
  if (!loggedStatuses.has(key)) {
    loggedStatuses.add(key);
    console.warn('[bigFootballData] unrecognized match status "' + raw + '" — passing through as-is. Add a mapping in bigFootballData.js STATUS_MAP if this should map to a known status.');
  }
  return String(raw).toUpperCase();
}

// Normalizes one raw BigFootball match object onto the SAME shape the rest
// of this app already expects from footballData.js: id, utcDate, status,
// homeTeam{id,name,crest}, awayTeam{id,name,crest}, score.fullTime{home,away},
// score.halfTime{home,away}, competition{id,name}, venue, minute. Reads
// several plausible field-name variants for each value since the exact raw
// shape hasn't been confirmed against a live response yet — safe either
// way (falls back to null rather than throwing), but worth spot-checking
// against /internal/bigfootball/test the first time real data comes back
// and tightening this if a field isn't landing correctly.
function normalizeMatch(m) {
  if (!m) return null;
  const home = m.home_team || m.homeTeam || m.home || {};
  const away = m.away_team || m.awayTeam || m.away || {};
  const homeScore = firstDefined(m.home_score, m.homeScore, home.score, m.score && m.score.home, m.score && m.score.home_score);
  const awayScore = firstDefined(m.away_score, m.awayScore, away.score, m.score && m.score.away, m.score && m.score.away_score);
  const htHome = firstDefined(m.ht_home_score, m.halftime_home_score, m.score && m.score.halftime && m.score.halftime.home);
  const htAway = firstDefined(m.ht_away_score, m.halftime_away_score, m.score && m.score.halftime && m.score.halftime.away);

  // CONFIRMED against a real response (2026-09-11): `league` is a plain
  // STRING (e.g. "La Liga"), not an object — `league.name` on a string is
  // always undefined, which is why every match showed up as "Other".
  // Still handling the object-shaped case too (m.competition), in case a
  // different endpoint/sport ever sends it that way.
  const leagueRaw = m.league != null ? m.league : m.competition;
  const leagueName = typeof leagueRaw === 'string'
    ? leagueRaw
    : (leagueRaw && (leagueRaw.name || leagueRaw.league_name)) || m.league_name || m.competitionName || null;
  const leagueId = (leagueRaw && typeof leagueRaw === 'object') ? idOf(leagueRaw) : null;
  // Frontend's "Leagues" stat and league-filter dropdown key off
  // competition.code (a short code like football-data.org's "PL"/"SA") —
  // BigFootball only gives us a plain name string, no code, so that stat
  // silently broke for BigFootball matches even after the name itself
  // started showing correctly. Deriving a stable synthetic code from the
  // name (e.g. "La Liga" -> "LA_LIGA") fixes the COUNT and in-app grouping
  // consistently. It won't match football-data.org's own codes (e.g. the
  // league filter dropdown's option list, which still comes from
  // /internal/competitions — a football-data.org-only endpoint) — that's
  // a separate follow-up (pointing that dropdown at BigFootball's own
  // /v1/leagues instead) if the league filter itself needs to work too,
  // not just the count.
  const leagueCode = leagueName ? leagueName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : null;

  // CONFIRMED: kickoff time field is `kickoff_utc`, not `date`/`utc_date`/
  // `kickoff`/`start_time` (all of which this app's other data sources use
  // for the same concept) — that mismatch is why utcDate was null for
  // every match. Keeping the old guesses as fallbacks costs nothing.
  const utcDate = firstDefined(m.kickoff_utc, m.date, m.utc_date, m.kickoff, m.start_time, m.scheduled);

  // BigFootball's match payload has no live minute/clock field at all
  // (confirmed: only status: "live"/"finished", nothing else timing-
  // related) — so minute is ALWAYS estimated for a live match here, never
  // read directly. Setting minuteIsEstimated lets db.js's existing
  // recompute-at-read-time logic (already wired for football, see
  // getFixtures in db.js) derive a real, continuously-advancing minute
  // from kickoff_utc automatically — no separate estimation code needed
  // in this file.
  const rawMinute = firstDefined(m.minute, m.elapsed, m.clock, m.time);

  return {
    id: String(m.id != null ? m.id : m.match_id != null ? m.match_id : m.matchId),
    source: 'bigfootball',
    utcDate: utcDate,
    status: normalizeStatus(m.status),
    minute: rawMinute,
    minuteIsEstimated: rawMinute == null,
    homeTeam: { id: idOf(home), name: home.name || m.home_team_name || m.homeTeamName || 'Unknown', crest: home.logo_url || home.logo || home.crest || null },
    awayTeam: { id: idOf(away), name: away.name || m.away_team_name || m.awayTeamName || 'Unknown', crest: away.logo_url || away.logo || away.crest || null },
    score: {
      winner: null,
      fullTime: (homeScore != null && awayScore != null) ? { home: homeScore, away: awayScore } : null,
      halfTime: (htHome != null && htAway != null) ? { home: htHome, away: htAway } : null
    },
    competition: { id: leagueId, name: leagueName, code: leagueCode },
    venue: m.venue || m.stadium || null,
    sport: m.sport || 'football',
    raw: m // kept for debugging/verification — safe to ignore, not sent by /api/fixtures (see server.js stripRaw)
  };
}

function idOf(obj) {
  if (!obj) return null;
  return obj.id != null ? String(obj.id) : null;
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function normalizeEvent(e) {
  if (!e) return null;
  return {
    id: e.id != null ? String(e.id) : null,
    type: (e.type || e.event_type || '').toLowerCase() || 'unknown', // expected: goal, card (yellow/red), substitution
    minute: firstDefined(e.minute, e.time, e.elapsed),
    team: e.team && (e.team.name || e.team) || e.team_name || null,
    player: e.player && (e.player.name || e.player) || e.player_name || null,
    assist: e.assist && (e.assist.name || e.assist) || e.assist_name || null,
    detail: e.detail || e.description || null,
    raw: e
  };
}

function normalizeOdds(o) {
  if (!o) return null;
  // Passed through close to raw shape since betting/settlement logic isn't
  // being touched yet (see the top of this file) — this just gives callers
  // a consistent envelope + fetchedAt timestamp to reason about freshness.
  return { matchId: o.match_id != null ? String(o.match_id) : null, markets: o.markets || o.odds || o, fetchedAt: new Date().toISOString(), raw: o };
}

// ── Public getters ───────────────────────────────────────────────────────

async function getSports() {
  const data = await cachedGet('sports', '/v1/sports', TTL.SPORTS);
  return unwrapList(data, 'sports');
}

async function getLeagues(params) {
  const query = qs(params || {});
  const data = await cachedGet('leagues' + query, '/v1/leagues' + query, TTL.LEAGUES);
  return unwrapList(data, 'leagues');
}

// filters: { sport, league, date (YYYY-MM-DD), status }
async function getMatches(filters) {
  filters = filters || {};
  const query = qs(filters);
  const isLiveQuery = filters.status === 'live' || filters.status === 'in_play';
  const ttl = isLiveQuery ? TTL.MATCHES_LIVE : TTL.MATCHES_TODAY;
  const data = await cachedGet('matches' + query, '/v1/matches' + query, ttl);
  return unwrapList(data, 'matches').map(normalizeMatch).filter(Boolean);
}

// Today's matches for football, in the SAME shape footballData.js's
// getMatchesForDate/getMergedMatchesForDate already return — this is the
// function scheduler.js's refresh loop calls.
async function getMatchesForDate(dateStr) {
  return getMatches({ sport: 'football', date: dateStr });
}

// Live matches right now — uses the API's own status=live filter rather
// than fetching everything and filtering client-side, per BigFootball's
// documented "matches" filters (sport, league, date, status).
async function getLiveMatches(extra) {
  return getMatches(Object.assign({ sport: 'football', status: 'live' }, extra || {}));
}

async function getMatchById(id) {
  // We don't know up front whether a given match is still live (that's
  // often WHY this is being called), so cache detail lookups on the
  // shorter live TTL — a finished/not-yet-started match just means a few
  // extra harmless cache misses, not stale live data.
  const data = await cachedGet('match:' + id, '/v1/matches/' + encodeURIComponent(id), TTL.MATCH_DETAIL_LIVE);
  const raw = (data && (data.data || data.match)) || data;
  return normalizeMatch(raw);
}

// ── Odds entitlement tracking ───────────────────────────────────────────
// BigBallsData's Free tier returns HTTP 403 on /odds ("Access to bookmaker
// odds requires the Edge plan or higher") — confirmed in production logs.
// This is an ACCOUNT-LEVEL plan limitation, not a per-match or transient
// failure, so retrying it match-by-match on every live-enrichment cycle
// just burns quota and floods the logs with the same 403 forever. Once
// we've seen this once, remember it for a while and skip the network call
// entirely — getMatchOdds still returns null (never fabricates odds), it
// just does so instantly and quietly instead of hitting the API and
// logging the same "needs Edge plan" error every 20 seconds per live match.
const ODDS_FORBIDDEN_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h — long enough to stop the spam, short enough to notice automatically if the account is ever upgraded
let oddsForbiddenUntil = 0;
let oddsForbiddenLogged = false;

async function getMatchOdds(id) {
  if (Date.now() < oddsForbiddenUntil) {
    return null; // known account-level 403 — see note above, don't waste a request or log noise
  }
  try {
    const data = await cachedGet('odds:' + id, '/v1/matches/' + encodeURIComponent(id) + '/odds', TTL.ODDS_LIVE);
    return normalizeOdds((data && (data.data || data.odds)) || data);
  } catch (e) {
    if (/HTTP 403/.test(e.message)) {
      oddsForbiddenUntil = Date.now() + ODDS_FORBIDDEN_COOLDOWN_MS;
      if (!oddsForbiddenLogged) {
        oddsForbiddenLogged = true;
        console.warn('[bigFootballData] /odds returned HTTP 403 (plan limitation, not a bug) — this BigBallsData account\'s tier does not include bookmaker odds. Pausing odds requests for ' + (ODDS_FORBIDDEN_COOLDOWN_MS / 3600000) + 'h to stop wasting quota/log spam. Matches/live scores/events are unaffected — only match.bigFootballOdds will stay null until the plan is upgraded or this cooldown expires and rechecks automatically.');
      }
      return null;
    }
    console.error('[bigFootballData] odds fetch failed for match ' + id + ': ' + e.message);
    return null; // no odds available right now — caller should treat as "not priced yet", never fabricate
  }
}

async function getMatchEvents(id) {
  try {
    const data = await cachedGet('events:' + id, '/v1/matches/' + encodeURIComponent(id) + '/events', TTL.EVENTS_LIVE);
    return unwrapList(data, 'events').map(normalizeEvent).filter(Boolean);
  } catch (e) {
    console.error('[bigFootballData] events fetch failed for match ' + id + ': ' + e.message);
    return []; // empty, not an error the caller needs to handle — a match can genuinely have zero events so far
  }
}

async function getTeams(params) {
  const query = qs(params || {});
  const data = await cachedGet('teams' + query, '/v1/teams' + query, TTL.TEAMS);
  return unwrapList(data, 'teams');
}

async function getPlayers(params) {
  const query = qs(params || {});
  const data = await cachedGet('players' + query, '/v1/players' + query, TTL.PLAYERS);
  return unwrapList(data, 'players');
}

async function getStandings(params) {
  const query = qs(params || {});
  const data = await cachedGet('standings' + query, '/v1/standings' + query, TTL.STANDINGS);
  return unwrapList(data, 'standings');
}

async function getInjuries(params) {
  const query = qs(params || {});
  const data = await cachedGet('injuries' + query, '/v1/injuries' + query, TTL.INJURIES);
  return unwrapList(data, 'injuries');
}

async function getPredictions(params) {
  const query = qs(params || {});
  const data = await cachedGet('predictions' + query, '/v1/predictions' + query, TTL.PREDICTIONS);
  return unwrapList(data, 'predictions');
}

// Never cached — this is the whole point of calling it, it needs to be live.
async function getUsage() {
  return bfFetch('/v1/usage');
}

// Lightweight connectivity test for the health endpoint — does NOT count
// as a "real" data call in spirit, but it does cost one request against
// the daily budget like any other call (there's no way around that; the
// point is to verify the key/base URL/auth actually work end to end).
async function testConnection() {
  const startedAt = Date.now();
  try {
    const sports = await getSports();
    return {
      ok: true,
      baseUrl: BASE_URL,
      responseTimeMs: Date.now() - startedAt,
      sportsReturned: Array.isArray(sports) ? sports.length : 0,
      rateLimit: getRateLimitStatus()
    };
  } catch (e) {
    return {
      ok: false,
      baseUrl: BASE_URL,
      error: e.message,
      responseTimeMs: Date.now() - startedAt,
      rateLimit: getRateLimitStatus()
    };
  }
}

function getCacheStatus() {
  return { entries: cache.size };
}

function clearCache() {
  const n = cache.size;
  cache.clear();
  return n;
}

module.exports = {
  getSports, getLeagues, getMatches, getMatchesForDate, getLiveMatches,
  getMatchById, getMatchOdds, getMatchEvents,
  getTeams, getPlayers, getStandings, getInjuries, getPredictions,
  getUsage, testConnection, getRateLimitStatus, getCacheStatus, clearCache,
  normalizeMatch, normalizeEvent, normalizeOdds, normalizeStatus, // exported for reuse/testing
  isConfigured: () => !!API_KEY
};
