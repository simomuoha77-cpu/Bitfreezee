// providers/sofaBetsProvider.js — SofaBets sports feed as a football data
// provider in the footballProviders.js cascade. Self-contained (unlike
// bigballsdataProvider.js, there's no pre-existing low-level module to
// wrap) — fetch, pagination, caching, and normalization all live here.
//
// NO API KEY — confirmed there isn't one for this feed. isConfigured()
// always returns true so this provider is never skipped as "not
// configured" the way a keyed provider would be with an empty env var.
//
// AUTHORIZATION: the endpoints below were observed being called by
// SofaBets' own frontend — that establishes they're reachable, NOT that
// redistributing this data through JuanAi's API is licensed. Confirm with
// SofaBets before this runs against real commercial betting traffic.
//
// SCHEMA CAVEAT: exact SofaBets field names were not independently
// confirmed when this was written. normalizeMatch()/parseCompetition()/
// parseOdds() below defensively check several likely field-name variants.
// getStatus() reports live counts (fixturesFetched, oddsParsed,
// leaguesParsed) — if oddsParsed or leaguesParsed stay at/near 0 against
// real traffic, the field-name guesses need adjusting; that does NOT mean
// fixtures themselves are wrong (see fixturesFetched for that).
//
// ODDS NOTE: this canonical provider shape (matching bigballsdataProvider.js)
// has no odds field — footballProviders.js's toAppShape() doesn't carry
// one either, since JuanAi's existing odds pipeline (AI analysis +
// realOdds.js) looks odds up separately by team name after fixtures land,
// decoupled from whichever provider supplied the fixture. SofaBets' real
// market odds are fetched and normalized here (see parsedOdds below,
// attached as a non-standard `_sofaProviderOdds` field) but will be
// DROPPED at the toAppShape() step until that pipeline is extended to
// carry provider-native odds through. Kept here anyway so that extension
// is a small follow-up instead of a re-fetch.

const SOFABETS_BASE = (process.env.SOFABETS_BASE || 'https://feed.sofabets.com').replace(/\/+$/, '');
const FOOTBALL_SPORT_ID = 1;

const REQUEST_TIMEOUT_MS = 10000;
const MAX_PAGES_PER_FETCH = 30; // broad sport-wide pull, not date-scoped — see fetchAllFootballFixtures
const PAGE_FETCH_GAP_MS = 300;
const ALL_FIXTURES_CACHE_TTL_MS = 3 * 60 * 1000;

const health = {
  status: 'unavailable',
  lastSuccessfulSync: null,
  lastError: null,
  fixturesFetched: 0,
  oddsParsed: 0,
  leaguesParsed: 0,
  consecutiveFailures: 0
};

function isConfigured() {
  return true; // keyless feed — always attempted, never skipped as unconfigured
}

function getStatus() {
  return Object.assign({ provider: 'sofabets' }, health);
}

function recordSuccess(fixturesCount, oddsCount, leaguesCount) {
  health.status = 'connected';
  health.lastSuccessfulSync = new Date().toISOString();
  health.lastError = null;
  health.fixturesFetched = fixturesCount;
  health.oddsParsed = oddsCount;
  health.leaguesParsed = leaguesCount;
  health.consecutiveFailures = 0;
}

function recordFailure(err) {
  health.consecutiveFailures += 1;
  health.lastError = err && err.message ? err.message : String(err);
  if (health.consecutiveFailures >= 3) health.status = 'unavailable';
}

async function sofaFetch(path, attempt) {
  attempt = attempt || 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(SOFABETS_BASE + path, { headers: { Accept: 'application/json' }, signal: controller.signal });
    clearTimeout(timeout);
    if (resp.status === 429 && attempt === 1) {
      await new Promise(r => setTimeout(r, 2000));
      return sofaFetch(path, attempt + 1);
    }
    if (!resp.ok) throw new Error('SofaBets HTTP ' + resp.status + ' for ' + path);
    return await resp.json();
  } catch (e) {
    clearTimeout(timeout);
    if (attempt === 1 && e.name !== 'AbortError') {
      await new Promise(r => setTimeout(r, 1500));
      return sofaFetch(path, attempt + 1);
    }
    throw e;
  }
}

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
    if (hasMore == null && totalPages == null) break;
    page++;
    if (page <= MAX_PAGES_PER_FETCH) await new Promise(r => setTimeout(r, PAGE_FETCH_GAP_MS));
  }
  if (page > MAX_PAGES_PER_FETCH) {
    console.warn('[sofaBetsProvider] hit MAX_PAGES_PER_FETCH (' + MAX_PAGES_PER_FETCH + ') — more fixtures may exist beyond this cycle');
  }
  return allItems;
}

function parseOdds(raw) {
  let odds = null;
  const flat1x2 = raw['1X2'] || raw.oneXTwo || raw.matchResult;
  if (flat1x2 && (flat1x2.home != null || flat1x2.Home != null)) {
    odds = {
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
      odds = { home: find('home') || find('1'), draw: find('draw') || find('x'), away: find('away') || find('2') };
    }
  }
  if (odds && (isNaN(odds.home) || isNaN(odds.draw) || isNaN(odds.away))) odds = null;
  return odds;
}

// Normalizes ONE raw SofaBets fixture onto the SAME canonical shape
// bigballsdataProvider.js's normalizeMatch() produces — provider,
// providerMatchId, competition (string), season, homeTeam (string),
// awayTeam (string), utcDate, status, score{fullTime,halfTime}, venue,
// minute, minuteIsEstimated — so footballProviders.js needs zero
// SofaBets-specific handling anywhere in the merge/dedup/toAppShape path.
function normalizeMatch(raw) {
  if (!raw) return null;
  const externalId = raw.id || raw.fixtureId || raw.fixture_id || raw.externalId;
  if (externalId == null) return null;

  const home = raw.homeTeam || raw.home_team || (raw.home && raw.home.name) || raw.home;
  const away = raw.awayTeam || raw.away_team || (raw.away && raw.away.name) || raw.away;
  const competition = (raw.competition && raw.competition.name) || raw.league || raw.competitionName || raw.tournament || null;
  const kickoff = raw.startTime || raw.start_time || raw.date || raw.kickoff;

  let utcDate = null;
  if (kickoff) {
    const d = new Date(kickoff);
    if (!isNaN(d.getTime())) utcDate = d.toISOString(); // unparseable kickoff must never throw — a match with no date beats one that crashes the whole batch
  }

  const rawStatus = (raw.status || raw.matchStatus || '').toString().toLowerCase();
  let status = 'SCHEDULED';
  if (rawStatus.includes('live') || rawStatus.includes('inplay') || rawStatus.includes('in_play')) status = 'IN_PLAY';
  else if (rawStatus.includes('half')) status = 'PAUSED';
  else if (rawStatus.includes('finish') || rawStatus.includes('ended') || rawStatus.includes('settled') || rawStatus.includes('ft')) status = 'FINISHED';
  else if (utcDate && new Date(utcDate).getTime() < Date.now() && rawStatus === '') {
    // Missing from an "upcoming" style response with a past kickoff isn't
    // proof it's finished — presumed in progress; a live-enrichment pass
    // (if wired into scheduler.js the way bigballsdata's is) would correct this.
    status = 'IN_PLAY';
  }

  const homeScore = raw.homeScore != null ? raw.homeScore : (raw.score && raw.score.home);
  const awayScore = raw.awayScore != null ? raw.awayScore : (raw.score && raw.score.away);
  const hasScore = homeScore != null && awayScore != null;

  return {
    provider: 'sofabets',
    providerMatchId: String(externalId),
    competition,
    season: null,
    homeTeam: home || 'Unknown',
    awayTeam: away || 'Unknown',
    utcDate,
    status,
    score: { fullTime: hasScore ? { home: homeScore, away: awayScore } : null, halfTime: null },
    venue: raw.venue || null,
    minute: raw.minute != null ? raw.minute : (raw.liveMinute != null ? raw.liveMinute : null),
    minuteIsEstimated: !(raw.minute != null || raw.liveMinute != null), // SofaBets' own reported minute, when present, is authoritative — not an estimate
    _sofaProviderOdds: parseOdds(raw) // NOT part of the standard provider shape — see ODDS NOTE at top of file. Dropped by toAppShape() today; kept here for when that pipeline is extended.
  };
}

function safeNormalizeMatch(raw) {
  try {
    return normalizeMatch(raw);
  } catch (e) {
    console.error('[sofaBetsProvider] failed to normalize one fixture, skipping it: ' + e.message);
    return null;
  }
}

const allFixturesCache = { fetchedAt: 0, matches: [] };

async function fetchAllFootballFixtures() {
  if (Date.now() - allFixturesCache.fetchedAt < ALL_FIXTURES_CACHE_TTL_MS) {
    return allFixturesCache.matches;
  }
  try {
    const items = await fetchAllPages(page =>
      '/api/fixtures-by-sport?sportId=' + FOOTBALL_SPORT_ID + '&page=' + page + '&limit=100&marketType=match%20result'
    );
    const matches = items.map(safeNormalizeMatch).filter(Boolean);
    allFixturesCache.fetchedAt = Date.now();
    allFixturesCache.matches = matches;
    const oddsCount = matches.filter(m => m._sofaProviderOdds).length;
    const leaguesCount = new Set(matches.map(m => m.competition).filter(Boolean)).size;
    recordSuccess(matches.length, oddsCount, leaguesCount);
    return matches;
  } catch (e) {
    recordFailure(e);
    console.error('[sofaBetsProvider] fixtures-by-sport fetch failed: ' + e.message);
    if (allFixturesCache.matches.length > 0) return allFixturesCache.matches; // stale-but-real beats empty on a transient failure
    return [];
  }
}

// Matches the (dateStr, options) contract every provider in
// footballProviders.js exposes. `options` (bigballsdata's {fullCatalogue})
// doesn't apply here — the broad fetch above already pulls everything —
// so it's accepted but unused, same as every other non-bigballsdata provider.
async function getMatchesForDate(dateStr, options) { // eslint-disable-line no-unused-vars
  const all = await fetchAllFootballFixtures();
  return all.filter(m => m.utcDate && m.utcDate.startsWith(dateStr));
}

module.exports = { providerName: 'sofabets', isConfigured, getMatchesForDate, getStatus };
