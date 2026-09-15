// sofaBetsData.js — SofaBets sports feed as a THIRD fixtures/odds source for
// JuanAi, alongside football-data.org (footballData.js) and odds-api.io.
//
// ARCHITECTURE (per the spec this was built from — do not deviate):
//   SofaBets Sports Feed → JuanAi (this file + footballData.js's merge) →
//   JuanAi's existing Game API → SafariBet. SafariBet never calls SofaBets
//   directly and this file has no knowledge of SafariBet.
//
// AUTHORIZATION: the endpoints below were observed being called by
// SofaBets' own frontend — that establishes they're reachable, NOT that
// redistributing this data (e.g. through JuanAi's API to SafariBet) is
// licensed. Before this runs against production traffic, confirm with
// SofaBets whether that's permitted (ToS review / written permission /
// commercial agreement). Until then, treat this as a dev/staging
// integration. This file never bypasses auth, rate limits, or access
// controls — if SOFABETS_KEY is unset, it calls the feed exactly as an
// unauthenticated client would; it doesn't attempt to work around a 401/403.
//
// SCHEMA CAVEAT: the exact field names SofaBets uses inside each fixture
// object were NOT independently confirmed against a live response when
// this was written (only the endpoint paths and one example odds line were
// observed). normalizeFixture() below defensively checks several likely
// field-name variants for each value. If fixtures come back with missing
// teams/odds/dates after this ships, log a raw fixture object and adjust
// the field lookups there — don't assume the shape is wrong everywhere.

const SOFABETS_BASE = (process.env.SOFABETS_BASE || 'https://feed.sofabets.com').replace(/\/+$/, '');
const SOFABETS_KEYS = (process.env.SOFABETS_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);
const FOOTBALL_SPORT_ID = 1;

const REQUEST_TIMEOUT_MS = 10000;
const MAX_PAGES_PER_FETCH = 8; // safety cap — a date/league-scoped query should never realistically need more than this; /api/upcoming unscoped could report 180+ total_pages, but we never call that endpoint unscoped for a single day's refresh
const PAGE_FETCH_GAP_MS = 300; // small gap between pages of the SAME logical fetch, so a paginated pull doesn't fire a burst of simultaneous requests

const UPCOMING_CACHE_TTL_MS = 2 * 60 * 1000; // fixtures-by-date cache — scheduler.js already re-triggers a full refresh every 3 min (today) / 15 min (future days), this just avoids a second redundant fetch if something else asks for the same date inside that window
const LIVE_CACHE_TTL_MS = 20 * 1000; // live-games cache — short, since live status is only ever read for the today-bucket during its own 3-min refresh cycle, but a couple of callers landing within the same window shouldn't double-fetch

// ── health / observability ──────────────────────────────────────────────
// Mirrors the shape the integration spec asked for, and the same spirit as
// footballData.js's getKeyPoolStatus() — exposed via server.js's /api/status.
const health = {
  status: 'unavailable', // 'connected' | 'unavailable' — flips to connected on first successful call
  lastSuccessfulSync: null,
  lastError: null,
  fixturesFetched: 0,   // count from the most recent successful fetch cycle
  liveFixtures: 0,
  oddsReceived: 0,
  consecutiveFailures: 0
};

function getProviderHealth() {
  return Object.assign({}, health);
}

function recordSuccess(fixturesCount, liveCount, oddsCount) {
  health.status = 'connected';
  health.lastSuccessfulSync = new Date().toISOString();
  health.lastError = null;
  health.fixturesFetched = fixturesCount;
  health.liveFixtures = liveCount;
  health.oddsReceived = oddsCount;
  health.consecutiveFailures = 0;
}

function recordFailure(err) {
  health.consecutiveFailures += 1;
  health.lastError = err && err.message ? err.message : String(err);
  // Don't flip to 'unavailable' on a single blip — matches footballData.js's
  // "keep going, log it" philosophy. Three consecutive failures is a real
  // outage, not a transient network hiccup.
  if (health.consecutiveFailures >= 3) health.status = 'unavailable';
}

// ── low-level fetch: timeout + one retry with backoff, optional key ────
let nextKeyIndex = 0;
function pickKey() {
  if (SOFABETS_KEYS.length === 0) return null;
  const key = SOFABETS_KEYS[nextKeyIndex % SOFABETS_KEYS.length];
  nextKeyIndex++;
  return key;
}

async function sofaFetch(path, attempt) {
  attempt = attempt || 1;
  const key = pickKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { Accept: 'application/json' };
    // Auth scheme unconfirmed — SOFABETS_KEY is sent as a bearer token,
    // the most common pattern. If SofaBets actually requires something
    // else (query param, custom header), adjust here once confirmed rather
    // than guessing further variants speculatively.
    if (key) headers.Authorization = 'Bearer ' + key;

    const resp = await fetch(SOFABETS_BASE + path, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (resp.status === 429 && attempt === 1) {
      await new Promise(r => setTimeout(r, 2000));
      return sofaFetch(path, attempt + 1);
    }
    if (!resp.ok) {
      throw new Error('SofaBets HTTP ' + resp.status + ' for ' + path);
    }
    return await resp.json();
  } catch (e) {
    clearTimeout(timeout);
    if (attempt === 1 && e.name !== 'AbortError') {
      // One short-delay retry for transient network errors — same rationale
      // as footballData.js's fdFetch retry-once-before-giving-up pattern.
      await new Promise(r => setTimeout(r, 1500));
      return sofaFetch(path, attempt + 1);
    }
    throw e;
  }
}

// Generic pagination: calls pathForPage(page), stops when the response
// says there's no more (checking both hasMore/has_more spellings observed
// in testing), a page comes back empty, or MAX_PAGES_PER_FETCH is hit.
async function fetchAllPages(pathForPage) {
  const allItems = [];
  let page = 1;
  while (page <= MAX_PAGES_PER_FETCH) {
    const data = await sofaFetch(pathForPage(page));
    const items = data.data || data.fixtures || data.results || data.items || [];
    if (!Array.isArray(items) || items.length === 0) break;
    allItems.push(...items);

    const hasMore = data.hasMore != null ? data.hasMore : data.has_more;
    const totalPages = data.total_pages || data.totalPages;
    if (hasMore === false) break;
    if (totalPages && page >= totalPages) break;
    if (hasMore == null && totalPages == null) break; // response gives no pagination signal — don't loop blindly

    page++;
    if (page <= MAX_PAGES_PER_FETCH) await new Promise(r => setTimeout(r, PAGE_FETCH_GAP_MS));
  }
  if (page > MAX_PAGES_PER_FETCH) {
    console.warn('[sofaBetsData] hit MAX_PAGES_PER_FETCH (' + MAX_PAGES_PER_FETCH + ') for a single fetch — more pages may exist and were not fetched this cycle');
  }
  return allItems;
}

// ── normalization: map SofaBets' fixture shape onto footballData.js's
// shared match shape, the same contract convertOddsApiIoEvent already
// established, so scheduler.js/ai.js/the frontend need no special-casing.
function normalizeFixture(raw) {
  const externalId = raw.id || raw.fixtureId || raw.fixture_id || raw.externalId;
  if (externalId == null) return null; // can't dedupe or reference this fixture without an ID — skip rather than guess

  const home = raw.homeTeam || raw.home_team || (raw.home && raw.home.name) || raw.home;
  const away = raw.awayTeam || raw.away_team || (raw.away && raw.away.name) || raw.away;
  const competitionName = (raw.competition && raw.competition.name) || raw.league || raw.competitionName || raw.tournament || 'Unknown League';
  const country = (raw.country && (raw.country.name || raw.country)) || raw.area || null;
  const kickoff = raw.startTime || raw.start_time || raw.date || raw.kickoff;

  const rawStatus = (raw.status || raw.matchStatus || '').toString().toLowerCase();
  let status = 'SCHEDULED';
  if (rawStatus.includes('live') || rawStatus.includes('inplay') || rawStatus.includes('in_play')) status = 'IN_PLAY';
  else if (rawStatus.includes('half')) status = 'PAUSED';
  else if (rawStatus.includes('finish') || rawStatus.includes('ended') || rawStatus.includes('settled') || rawStatus.includes('ft')) status = 'FINISHED';
  else if (kickoff && new Date(kickoff).getTime() < Date.now() && rawStatus === '') {
    // No explicit status but kickoff has passed and this came from the
    // upcoming/date endpoint (not live-games) — presumed in progress,
    // same "can't assume finished just because it's not in upcoming"
    // handling the spec calls for. The live-games merge below (when this
    // is the today-bucket) will overwrite this with a real live status.
    status = 'IN_PLAY';
  }

  const homeScore = raw.homeScore != null ? raw.homeScore : (raw.score && raw.score.home);
  const awayScore = raw.awayScore != null ? raw.awayScore : (raw.score && raw.score.away);
  const hasScore = homeScore != null && awayScore != null;

  // 1X2 odds — stored EXACTLY as provider returns them, no conversion to
  // probability, no margin applied. Looks for the market under a few
  // likely shapes (a flat 1X2 object, or a markets array entry named
  // "match result" / "1x2" / "match_winner").
  let providerOdds = null;
  const flat1x2 = raw['1X2'] || raw.oneXTwo || raw.matchResult;
  if (flat1x2 && (flat1x2.home != null || flat1x2.Home != null)) {
    providerOdds = {
      home: parseFloat(flat1x2.home != null ? flat1x2.home : flat1x2.Home),
      draw: parseFloat(flat1x2.draw != null ? flat1x2.draw : flat1x2.Draw),
      away: parseFloat(flat1x2.away != null ? flat1x2.away : flat1x2.Away)
    };
  } else if (Array.isArray(raw.markets)) {
    const m = raw.markets.find(mk => {
      const n = (mk.name || mk.marketType || '').toString().toLowerCase();
      return n.includes('1x2') || n.includes('match result') || n.includes('match_winner') || n.includes('match winner');
    });
    if (m && Array.isArray(m.outcomes) && m.outcomes.length >= 3) {
      const find = label => {
        const o = m.outcomes.find(o => (o.name || o.label || '').toString().toLowerCase().startsWith(label));
        return o ? parseFloat(o.odds != null ? o.odds : o.price) : null;
      };
      providerOdds = { home: find('home') || find('1'), draw: find('draw') || find('x'), away: find('away') || find('2') };
    }
  }
  if (providerOdds && (isNaN(providerOdds.home) || isNaN(providerOdds.draw) || isNaN(providerOdds.away))) {
    providerOdds = null; // partial/garbled parse — don't surface half-broken odds
  }

  return {
    id: 'sofa_' + externalId,
    externalFixtureId: String(externalId),
    utcDate: kickoff ? new Date(kickoff).toISOString() : null,
    status,
    minute: raw.minute != null ? raw.minute : (raw.liveMinute != null ? raw.liveMinute : null),
    minuteIsEstimated: false, // SofaBets' own reported minute, when present, is authoritative — not a JuanAi estimate
    minuteIsRealClock: raw.minute != null || raw.liveMinute != null,
    isHalftime: status === 'PAUSED',
    homeTeam: { name: home || null },
    awayTeam: { name: away || null },
    competition: { name: competitionName },
    area: { name: country },
    score: hasScore ? { fullTime: { home: homeScore, away: awayScore }, halfTime: null } : null,
    providerOdds, // raw provider odds, untouched — kept separate from JuanAi's own AI-generated odds (see realOdds.js / ai.js), which live elsewhere on the match once analyzed
    source: 'sofabets'
  };
}

// ── fixtures for a given date (+ live overlay when isTodayBucket) ──────
const upcomingCache = new Map(); // dateStr -> { fetchedAt, matches }
const liveCache = { fetchedAt: 0, byExternalId: new Map() };

async function fetchLiveMap() {
  if (Date.now() - liveCache.fetchedAt < LIVE_CACHE_TTL_MS) return liveCache.byExternalId;
  const items = await fetchAllPages(page =>
    '/api/live-games?page=' + page + '&limit=100&marketType=match%20result&sport=football'
  );
  const map = new Map();
  for (const raw of items) {
    const norm = normalizeFixture(raw);
    if (norm) map.set(norm.externalFixtureId, norm);
  }
  liveCache.fetchedAt = Date.now();
  liveCache.byExternalId = map;
  return map;
}

async function getSofaBetsMatchesForDate(dateStr, isTodayBucket) {
  if (SOFABETS_KEYS.length === 0 && process.env.SOFABETS_REQUIRE_KEY === '1') {
    return []; // explicit opt-out if you later decide auth is mandatory — default stays open per the observed public feed
  }

  const cached = upcomingCache.get(dateStr);
  let matches;
  try {
    if (cached && Date.now() - cached.fetchedAt < UPCOMING_CACHE_TTL_MS) {
      matches = cached.matches;
    } else {
      const raw = await fetchAllPages(page =>
        '/api/fixtures-by-date?date=' + dateStr + '&page=' + page + '&limit=100&marketType=match%20result'
      );
      matches = raw.map(normalizeFixture).filter(Boolean);
      upcomingCache.set(dateStr, { fetchedAt: Date.now(), matches });
    }

    let liveCount = 0;
    let oddsCount = matches.filter(m => m.providerOdds).length;

    if (isTodayBucket) {
      try {
        const liveMap = await fetchLiveMap();
        matches = matches.map(m => {
          const live = liveMap.get(m.externalFixtureId);
          if (!live) return m;
          liveCount++;
          // Live endpoint overrides status/score/minute/odds — it's the
          // more current signal for a match already in progress.
          return Object.assign({}, m, {
            status: live.status,
            minute: live.minute,
            minuteIsRealClock: live.minuteIsRealClock,
            isHalftime: live.isHalftime,
            score: live.score || m.score,
            providerOdds: live.providerOdds || m.providerOdds
          });
        });
        oddsCount = matches.filter(m => m.providerOdds).length;
      } catch (e) {
        // Live overlay failing shouldn't take down the whole fixture list —
        // fall through with pre-live-merge data, same as the rest of this
        // file's "keep going, log it" pattern.
        console.error('[sofaBetsData] live-games fetch failed: ' + e.message);
      }
    }

    recordSuccess(matches.length, liveCount, oddsCount);
    return matches;
  } catch (e) {
    recordFailure(e);
    console.error('[sofaBetsData] fixtures-by-date fetch failed for ' + dateStr + ': ' + e.message);
    // Serve stale cache rather than an empty list, if we have any —
    // mirrors scheduler.js's own "don't wipe good data on a blip" rule.
    if (cached) {
      console.warn('[sofaBetsData] serving stale cached fixtures for ' + dateStr + ' (' + cached.matches.length + ' matches) after fetch failure');
      return cached.matches;
    }
    return [];
  }
}

module.exports = { getSofaBetsMatchesForDate, getProviderHealth, FOOTBALL_SPORT_ID };
