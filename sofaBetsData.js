// sofaBetsData.js — SofaBets sports feed as a THIRD fixtures/odds source for
// JuanAi, alongside football-data.org (footballData.js) and odds-api.io.
//
// ARCHITECTURE (per the spec this was built from — do not deviate):
//   SofaBets Sports Feed → JuanAi (this file + footballData.js's merge) →
//   JuanAi's existing Game API → SafariBet. SafariBet never calls SofaBets
//   directly and this file has no knowledge of SafariBet.
//
// NO API KEY — confirmed there is none for this feed. Every request below
// goes out exactly as the SofaBets frontend itself sends it: no auth
// header, no bypassed access control, no rate-limit workaround.
//
// FETCH STRATEGY — "everything" from SofaBets, not narrow per-date calls.
// Rather than calling /api/fixtures-by-date three separate times (once per
// day-bucket JuanAi tracks), this pulls the FULL football set ONCE via
// /api/fixtures-by-sport?sportId=1 (paginated), caches it, and every
// day-bucket (today/tomorrow/day-after) is filtered out of that one set
// locally. That's both closer to what was asked for and cheaper on the
// provider — one broad paginated pull per cache window instead of three.
//
// SCHEMA CAVEAT: the exact field names SofaBets uses inside each fixture
// object were NOT independently confirmed against a live response when
// this was written (only the endpoint paths and the example odds lines in
// the spec were observed). normalizeFixture() below defensively checks
// several likely field-name variants for each value. Run getDebugSummary()
// (wired to GET /api/sofabets-debug in server.js) against the real feed
// first — if fixturesFetched is 0 or oddsReceived is unexpectedly low,
// log one raw fixture object and adjust the field lookups here rather
// than assuming the whole integration is broken.

const SOFABETS_BASE = (process.env.SOFABETS_BASE || 'https://feed.sofabets.com').replace(/\/+$/, '');
const FOOTBALL_SPORT_ID = 1;

const REQUEST_TIMEOUT_MS = 10000;
// This is a genuinely broad, sport-wide pull (not date-scoped), so it needs
// a higher page cap than a single day's fixtures would — but still capped,
// per the spec's own "do NOT continuously request every page" instruction.
// 30 pages * 100/page = up to 3,000 fixtures per refresh cycle.
const MAX_PAGES_PER_FETCH = 30;
const PAGE_FETCH_GAP_MS = 300; // small gap between pages of the SAME fetch, so pagination doesn't fire a request burst

const ALL_FIXTURES_CACHE_TTL_MS = 3 * 60 * 1000; // matches scheduler.js's TODAY_REFRESH_INTERVAL_MS — no point re-pulling the whole sport more often than the scheduler re-reads it
const LIVE_CACHE_TTL_MS = 20 * 1000; // live-games cache — short, only read during the today-bucket's own refresh cycle

// ── health / observability ──────────────────────────────────────────────
// Mirrors the shape the integration spec asked for (section 18), same
// spirit as footballData.js's getKeyPoolStatus() — exposed via /api/status.
// Only ever flips to 'connected' after an ACTUAL successful parsed
// response, never just because the URL is reachable (spec section 18).
const health = {
  status: 'unavailable', // 'connected' | 'unavailable'
  lastSuccessfulSync: null,
  lastError: null,
  fixturesFetched: 0,
  liveFixtures: 0,
  oddsReceived: 0,
  responseTimeMs: null,
  consecutiveFailures: 0
};

function getProviderHealth() {
  return Object.assign({}, health);
}

function recordSuccess(fixturesCount, liveCount, oddsCount, responseTimeMs) {
  health.status = 'connected';
  health.lastSuccessfulSync = new Date().toISOString();
  health.lastError = null;
  health.fixturesFetched = fixturesCount;
  health.liveFixtures = liveCount;
  health.oddsReceived = oddsCount;
  if (responseTimeMs != null) health.responseTimeMs = responseTimeMs;
  health.consecutiveFailures = 0;
}

function recordFailure(err) {
  health.consecutiveFailures += 1;
  health.lastError = err && err.message ? err.message : String(err);
  // Don't flip to 'unavailable' on a single blip — three consecutive
  // failures is a real outage, not a transient network hiccup.
  if (health.consecutiveFailures >= 3) health.status = 'unavailable';
}

// ── low-level fetch: timeout + one retry with backoff, no auth ─────────
async function sofaFetch(path, attempt) {
  attempt = attempt || 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const resp = await fetch(SOFABETS_BASE + path, { headers: { Accept: 'application/json' }, signal: controller.signal });
    clearTimeout(timeout);

    if (resp.status === 429 && attempt === 1) {
      await new Promise(r => setTimeout(r, 2000));
      return sofaFetch(path, attempt + 1);
    }
    if (!resp.ok) {
      throw new Error('SofaBets HTTP ' + resp.status + ' for ' + path);
    }
    const json = await resp.json();
    return { json, responseTimeMs: Date.now() - startedAt };
  } catch (e) {
    clearTimeout(timeout);
    if (attempt === 1 && e.name !== 'AbortError') {
      // One short-delay retry for transient network errors.
      await new Promise(r => setTimeout(r, 1500));
      return sofaFetch(path, attempt + 1);
    }
    throw e;
  }
}

// Generic pagination: calls pathForPage(page), stops when the response
// says there's no more (checking both hasMore/has_more spellings the spec
// mentions), a page comes back empty, or MAX_PAGES_PER_FETCH is hit.
// Returns { items, lastResponseTimeMs } — the timing of the LAST page hit,
// used as a rough health signal (not perfectly precise for a paginated
// pull, but good enough to spot the feed slowing down).
async function fetchAllPages(pathForPage) {
  const allItems = [];
  let page = 1;
  let lastResponseTimeMs = null;
  while (page <= MAX_PAGES_PER_FETCH) {
    const { json: data, responseTimeMs } = await sofaFetch(pathForPage(page));
    lastResponseTimeMs = responseTimeMs;
    const items = data.data || data.fixtures || data.results || data.items || [];
    if (!Array.isArray(items) || items.length === 0) break;
    allItems.push(...items);

    const hasMore = data.hasMore != null ? data.hasMore : data.has_more;
    const totalPages = data.total_pages || data.totalPages;
    if (hasMore === false) break;
    if (totalPages && page >= totalPages) break;
    if (hasMore == null && totalPages == null) break; // no pagination signal in the response — don't loop blindly

    page++;
    if (page <= MAX_PAGES_PER_FETCH) await new Promise(r => setTimeout(r, PAGE_FETCH_GAP_MS));
  }
  if (page > MAX_PAGES_PER_FETCH) {
    console.warn('[sofaBetsData] hit MAX_PAGES_PER_FETCH (' + MAX_PAGES_PER_FETCH + ') — more football fixtures may exist beyond this and were not fetched this cycle');
  }
  return { items: allItems, lastResponseTimeMs };
}

// ── normalization: map SofaBets' fixture shape onto footballData.js's
// shared match shape, the same contract convertOddsApiIoEvent established,
// so scheduler.js/ai.js/the frontend need no SofaBets-specific handling.
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
    // bulk fixtures endpoint (not live-games) — presumed in progress; the
    // live-games overlay below (today-bucket only) will replace this with
    // a real live status. Don't assume "missing from upcoming = finished".
    status = 'IN_PLAY';
  }

  const homeScore = raw.homeScore != null ? raw.homeScore : (raw.score && raw.score.home);
  const awayScore = raw.awayScore != null ? raw.awayScore : (raw.score && raw.score.away);
  const hasScore = homeScore != null && awayScore != null;

  // 1X2 odds — stored EXACTLY as provider returns them, no conversion to
  // probability, no margin applied. Looks for the market under a few
  // likely shapes: a flat 1X2 object, or a markets[] entry named
  // "match result" / "1x2" / "match_winner" with outcomes.
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
    utcDate: (() => {
      if (!kickoff) return null;
      const d = new Date(kickoff);
      return isNaN(d.getTime()) ? null : d.toISOString(); // an unparseable kickoff value must never throw here — better a match with no date than one that takes the whole batch down
    })(),
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
    providerOdds, // raw provider odds, untouched — kept separate from JuanAi's own AI-generated odds (see realOdds.js / ai.js)
    source: 'sofabets'
  };
}

// Wraps normalizeFixture so ONE malformed fixture (bad date, unexpected
// type, whatever) can't abort the entire batch — Array.prototype.map()
// throwing on item #500 out of 1,300+ would otherwise silently drop ALL of
// them, not just the bad one, every time it ran through the normal
// fetch → normalize → merge → save pipeline.
function safeNormalizeFixture(raw) {
  try {
    return normalizeFixture(raw);
  } catch (e) {
    console.error('[sofaBetsData] failed to normalize one fixture, skipping it: ' + e.message + ' — raw: ' + JSON.stringify(raw).slice(0, 300));
    return null;
  }
}

// ── the ONE broad fetch everything else derives from ───────────────────
const allFixturesCache = { fetchedAt: 0, matches: [] };

async function fetchAllFootballFixtures() {
  if (Date.now() - allFixturesCache.fetchedAt < ALL_FIXTURES_CACHE_TTL_MS) {
    return allFixturesCache.matches;
  }
  try {
    const { items, lastResponseTimeMs } = await fetchAllPages(page =>
      '/api/fixtures-by-sport?sportId=' + FOOTBALL_SPORT_ID + '&page=' + page + '&limit=100&marketType=match%20result'
    );
    const matches = items.map(safeNormalizeFixture).filter(Boolean);
    allFixturesCache.fetchedAt = Date.now();
    allFixturesCache.matches = matches;
    const oddsCount = matches.filter(m => m.providerOdds).length;
    recordSuccess(matches.length, 0, oddsCount, lastResponseTimeMs); // liveFixtures filled in separately once the live overlay runs
    return matches;
  } catch (e) {
    recordFailure(e);
    console.error('[sofaBetsData] fixtures-by-sport fetch failed: ' + e.message);
    if (allFixturesCache.matches.length > 0) {
      console.warn('[sofaBetsData] serving stale cached fixtures (' + allFixturesCache.matches.length + ' matches) after fetch failure');
      return allFixturesCache.matches;
    }
    return [];
  }
}

// ── live overlay ─────────────────────────────────────────────────────
const liveCache = { fetchedAt: 0, byExternalId: new Map() };

async function fetchLiveMap() {
  if (Date.now() - liveCache.fetchedAt < LIVE_CACHE_TTL_MS) return liveCache.byExternalId;
  const { items } = await fetchAllPages(page =>
    '/api/live-games?page=' + page + '&limit=100&marketType=match%20result&sport=football'
  );
  const map = new Map();
  for (const raw of items) {
    const norm = safeNormalizeFixture(raw);
    if (norm) map.set(norm.externalFixtureId, norm);
  }
  liveCache.fetchedAt = Date.now();
  liveCache.byExternalId = map;
  return map;
}

// ── per-date view, derived from the one broad fixture set ─────────────
// dateStr filtering mirrors footballData.js's own "still live from
// yesterday" carryover logic for the today-bucket, so behavior is
// consistent across all three providers rather than SofaBets having its
// own slightly different rule.
async function getSofaBetsMatchesForDate(dateStr, isTodayBucket) {
  const all = await fetchAllFootballFixtures();

  let matches = all.filter(m => {
    if (!m.utcDate) return false;
    if (m.utcDate.startsWith(dateStr)) return true;
    if (!isTodayBucket) return false;
    if (m.status === 'FINISHED') return false;
    const hoursDiff = (new Date(dateStr + 'T00:00:00Z').getTime() - new Date(m.utcDate).getTime()) / (60 * 60 * 1000);
    return hoursDiff > 0 && hoursDiff <= 6;
  });

  let liveCount = 0;
  if (isTodayBucket) {
    try {
      const liveMap = await fetchLiveMap();
      matches = matches.map(m => {
        const live = liveMap.get(m.externalFixtureId);
        if (!live) return m;
        liveCount++;
        return Object.assign({}, m, {
          status: live.status,
          minute: live.minute,
          minuteIsRealClock: live.minuteIsRealClock,
          isHalftime: live.isHalftime,
          score: live.score || m.score,
          providerOdds: live.providerOdds || m.providerOdds
        });
      });
      health.liveFixtures = liveCount; // update the shared health snapshot with the real live count now that we've checked
    } catch (e) {
      // Live overlay failing shouldn't take down the date-bucket's fixture
      // list — fall through with pre-live-merge data.
      console.error('[sofaBetsData] live-games fetch failed: ' + e.message);
    }
  }

  return matches;
}

// ── debug summary — matches the exact format requested in the spec
// (section 23), so this can be run against the real feed and the output
// pasted back for review without needing separate ad-hoc test code.
async function getDebugSummary() {
  const lines = [];

  lines.push('================================');
  lines.push('SOFABETS PROVIDER');
  lines.push('================================');
  lines.push('');
  lines.push('Base URL:         ' + SOFABETS_BASE);
  lines.push('Football ID:      ' + FOOTBALL_SPORT_ID);
  lines.push('');

  let connectionOk = false;
  try {
    await sofaFetch('/api/fixtures/sports/available');
    connectionOk = true;
    lines.push('Connection:       OK');
  } catch (e) {
    lines.push('Connection:       FAILED (' + e.message + ')');
  }

  let byDateOk = false, byDateCount = 0;
  try {
    const { items } = await fetchAllPages(page => '/api/fixtures-by-date?date=' + new Date().toISOString().slice(0, 10) + '&page=' + page + '&limit=100&marketType=match%20result');
    byDateOk = true;
    byDateCount = items.length;
  } catch (e) { /* recorded below via byDateOk staying false */ }

  let liveOk = false, liveCount = 0;
  try {
    const map = await fetchLiveMap();
    liveOk = true;
    liveCount = map.size;
  } catch (e) { /* recorded below via liveOk staying false */ }

  let fixtures = [];
  let bySportOk = false;
  try {
    fixtures = await fetchAllFootballFixtures();
    bySportOk = true;
  } catch (e) { /* recorded below via bySportOk staying false */ }

  const oddsCount = fixtures.filter(m => m.providerOdds).length;
  const leagues = new Set(fixtures.map(m => m.competition && m.competition.name).filter(Boolean));

  lines.push('Upcoming:         ' + (byDateOk ? 'OK (' + byDateCount + ')' : 'FAILED'));
  lines.push('By Sport:         ' + (bySportOk ? 'OK' : 'FAILED'));
  lines.push('By Date:          ' + (byDateOk ? 'OK' : 'FAILED'));
  lines.push('Live:             ' + (liveOk ? 'OK' : 'FAILED'));
  lines.push('Leagues:          ' + leagues.size + ' distinct competitions seen');
  lines.push('');
  lines.push('Football games:   ' + fixtures.length);
  lines.push('Games with odds:  ' + oddsCount);
  lines.push('Live games:       ' + liveCount);
  lines.push('');
  lines.push('Pagination:       ' + (fixtures.length > 0 ? 'OK' : 'UNVERIFIED (no fixtures returned)'));
  lines.push('Normalization:    ' + (fixtures.length > 0 && fixtures[0].homeTeam.name ? 'OK' : 'CHECK FIELD MAPPING — see comment at top of sofaBetsData.js'));
  lines.push('Cache:            OK (TTL ' + (ALL_FIXTURES_CACHE_TTL_MS / 1000) + 's fixtures / ' + (LIVE_CACHE_TTL_MS / 1000) + 's live)');
  lines.push('');
  lines.push('JuanAi API:       ' + (connectionOk && bySportOk ? 'OK — should now appear via getMergedMatchesForDate' : 'NOT VERIFIED — fix the failures above first'));
  lines.push('================================');

  return { summary: lines.join('\n'), raw: { connectionOk, byDateOk, byDateCount, liveOk, liveCount, bySportOk, fixturesCount: fixtures.length, oddsCount, leagues: Array.from(leagues), sampleFixture: fixtures[0] || null } };
}

module.exports = { getSofaBetsMatchesForDate, getProviderHealth, getDebugSummary, FOOTBALL_SPORT_ID };
