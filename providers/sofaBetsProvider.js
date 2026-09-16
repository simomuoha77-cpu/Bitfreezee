// SofaBets football provider for JuanAi.
//
// Goals of this version:
// 1. Try the current SofaBets backend host first, then the older feed host.
// 2. Accept several common response envelopes and fixture field names.
// 3. Do not throw away valid fixtures because of UTC-vs-Kenya date formatting.
// 4. Do not require a marketType filter just to discover fixtures.
// 5. Keep provider-native odds on the canonical match so footballProviders.js
//    can expose them to the rest of JuanAi.
//
// The exact SofaBets API contract can change. Keep endpoint/base URL overrideable
// with SOFABETS_BASE_URL / SOFABETS_BASE / SOFABETS_FIXTURES_PATHS.

const BASES = Array.from(new Set([
  process.env.SOFABETS_BASE_URL,
  process.env.SOFABETS_BASE,
  'https://backendapi.sofabets.com',
  'https://feed.sofabets.com'
].filter(Boolean).map(v => String(v).replace(/\/+$/, ''))));

const FOOTBALL_SPORT_ID = Number(process.env.SOFABETS_SPORT_ID || 1);
const REQUEST_TIMEOUT_MS = Number(process.env.SOFABETS_TIMEOUT_MS || 12000);
const MAX_PAGES_PER_FETCH = Number(process.env.SOFABETS_MAX_PAGES || 30);
const PAGE_FETCH_GAP_MS = 250;
// Keep SofaBets odds fresh. Default is no cache so an odds change is picked up
// on the next provider refresh. Set SOFABETS_FIXTURE_CACHE_TTL_MS only if
// you intentionally want caching to reduce upstream requests.
const ALL_FIXTURES_CACHE_TTL_MS = Number(process.env.SOFABETS_FIXTURE_CACHE_TTL_MS || 0);

const DEFAULT_PATHS = [
  '/api/fixtures-by-sport',
  '/api/fixtures',
  '/api/matches',
  '/api/events',
  '/api/sports/1/fixtures',
  '/api/sports/football/fixtures',
  '/api/football/fixtures'
];
const PATHS = String(process.env.SOFABETS_FIXTURES_PATHS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const FIXTURE_PATHS = Array.from(new Set([...PATHS, ...DEFAULT_PATHS]));

const health = {
  status: 'unavailable',
  lastSuccessfulSync: null,
  lastError: null,
  fixturesFetched: 0,
  fixturesForRequestedDate: 0,
  oddsParsed: 0,
  leaguesParsed: 0,
  endpointUsed: null,
  baseUsed: null,
  consecutiveFailures: 0
};

function isConfigured() { return true; }
function getStatus() { return Object.assign({ provider: 'sofabets' }, health); }

function recordSuccess(allCount, dateCount, oddsCount, leaguesCount, base, path) {
  health.status = 'connected';
  health.lastSuccessfulSync = new Date().toISOString();
  health.lastError = null;
  health.fixturesFetched = allCount;
  health.fixturesForRequestedDate = dateCount;
  health.oddsParsed = oddsCount;
  health.leaguesParsed = leaguesCount;
  health.endpointUsed = path;
  health.baseUsed = base;
  health.consecutiveFailures = 0;
}

function recordFailure(err) {
  health.consecutiveFailures += 1;
  health.lastError = err && err.message ? err.message : String(err);
  if (health.consecutiveFailures >= 3) health.status = 'unavailable';
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function sofaFetch(base, path, query, attempt = 1) {
  const qs = new URLSearchParams(query || {});
  const url = base + path + (qs.toString() ? '?' + qs.toString() : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36',
        'Origin': 'https://sofabets.com',
        'Referer': 'https://sofabets.com/'
      },
      signal: controller.signal
    });
    if (resp.status === 429 && attempt < 3) {
      clearTimeout(timer);
      await sleep(1200 * attempt);
      return sofaFetch(base, path, query, attempt + 1);
    }
    if (!resp.ok) throw new Error('SofaBets HTTP ' + resp.status + ' for ' + url);
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch (_) { throw new Error('SofaBets returned non-JSON from ' + url); }
  } catch (e) {
    if (attempt < 2 && e.name !== 'AbortError') {
      await sleep(700);
      return sofaFetch(base, path, query, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function asArray(value) { return Array.isArray(value) ? value : []; }

// SofaBets/backend implementations can wrap the actual list in several layers.
function looksLikeFixture(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const hasId = ['id','fixtureId','fixture_id','eventId','event_id','matchId','match_id'].some(k => x[k] != null);
  const hasTeams = x.homeTeam != null || x.awayTeam != null || x.home_team != null || x.away_team != null || x.home != null || x.away != null || x.teams != null || x.fixture_name != null || x.fixtureName != null;
  return hasId && hasTeams;
}

function extractItems(payload) {
  const direct = [
    payload,
    payload && payload.data,
    payload && payload.data && payload.data.fixtures,
    payload && payload.data && payload.data.matches,
    payload && payload.data && payload.data.items,
    payload && payload.data && payload.data.events,
    payload && payload.fixtures,
    payload && payload.matches,
    payload && payload.results,
    payload && payload.items,
    payload && payload.events
  ];
  for (const c of direct) if (Array.isArray(c) && c.length) return c;

  // Some SofaBets responses group events under sport/league/date objects.
  // Walk the response and find the first substantial array of fixture-like objects.
  const seen = new Set();
  const queue = [payload];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      const fixtureCount = node.filter(looksLikeFixture).length;
      if (fixtureCount >= Math.min(3, node.length)) return node;
      for (const v of node) if (v && typeof v === 'object') queue.push(v);
    } else {
      for (const [k,v] of Object.entries(node)) {
        if (['pagination','meta','config','filters'].includes(k)) continue;
        if (v && typeof v === 'object') queue.push(v);
      }
    }
  }
  return [];
}
function paginationInfo(payload) {
  const root = payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload || {};
  const p = root.pagination || payload?.pagination || payload?.meta || {};
  return {
    hasMore: root.hasMore ?? root.has_more ?? p.hasMore ?? p.has_more ?? payload?.hasMore ?? payload?.has_more,
    totalPages: root.totalPages ?? root.total_pages ?? p.totalPages ?? p.total_pages ?? payload?.totalPages ?? payload?.total_pages,
    nextPage: root.nextPage ?? root.next_page ?? p.nextPage ?? p.next_page ?? payload?.nextPage ?? payload?.next_page
  };
}
async function fetchPages(base, path) {
  const all = [];
  let page = 1;
  let first = true;

  while (page <= MAX_PAGES_PER_FETCH) {
    // Do NOT require marketType=match result. That filter can hide fixtures
    // before JuanAi has even discovered them.
    // Match the public SofaBets frontend contract exactly. The frontend uses
    // sportId + page + limit (+ marketType), and some backend deployments
    // return an empty/sport-null response when extra sport parameters are sent.
    const query = {
      sportId: String(FOOTBALL_SPORT_ID),
      page: String(page),
      limit: '100',
      marketType: 'match result'
    };

    let payload;
    try {
      payload = await sofaFetch(base, path, query);
    } catch (e) {
      // Some installations expose fixtures without the marketType filter.
      const fallbackQuery = {
        sportId: String(FOOTBALL_SPORT_ID),
        page: String(page),
        limit: '100'
      };
      payload = await sofaFetch(base, path, fallbackQuery);
    }
    const items = extractItems(payload);
    if (!items.length) break;
    all.push(...items);

    const pg = paginationInfo(payload);
    if (pg.hasMore === false) break;
    if (pg.totalPages && page >= Number(pg.totalPages)) break;
    if (pg.nextPage != null && Number(pg.nextPage) > page) page = Number(pg.nextPage);
    else if (pg.hasMore === true || pg.totalPages || pg.nextPage != null) page += 1;
    else {
      // If the API gives no pagination metadata, one page is safest. Some
      // APIs return a full catalogue in page 1; repeating it can waste calls.
      break;
    }
    first = false;
    if (!first) await sleep(PAGE_FETCH_GAP_MS);
  }
  return all;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function teamName(value) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') return pick(value, ['name', 'teamName', 'displayName', 'shortName', 'title']);
  return null;
}

function parseOdds(raw) {
  const markets = [];
  for (const key of ['markets', 'odds', 'market', 'betOffers', 'betoffers']) {
    if (Array.isArray(raw?.[key])) markets.push(...raw[key]);
  }

  const direct = raw?.['1X2'] || raw?.oneXTwo || raw?.matchResult || raw?.match_result;
  if (direct && typeof direct === 'object') {
    const o = {
      home: Number(pick(direct, ['home', 'Home', '1', 'homeOdds', 'homePrice'])),
      draw: Number(pick(direct, ['draw', 'Draw', 'X', 'x', 'drawOdds', 'drawPrice'])),
      away: Number(pick(direct, ['away', 'Away', '2', 'awayOdds', 'awayPrice']))
    };
    if ([o.home, o.draw, o.away].every(Number.isFinite)) return o;
  }

  for (const market of markets) {
    const marketName = String(pick(market, ['name', 'marketType', 'marketName', 'market_name', 'type', 'key']) || '').toLowerCase();
    if (!(marketName.includes('1x2') || marketName.includes('match result') || marketName.includes('match_winner') || marketName.includes('match winner'))) continue;
    const outcomes = market.outcomes || market.selections || market.options || market.betOffers;
    if (!Array.isArray(outcomes)) continue;
    const get = wanted => {
      const found = outcomes.find(o => {
        const label = String(pick(o, ['name', 'label', 'selectionName', 'selection_name', 'outcomeName', 'key']) || '').toLowerCase();
        return wanted.some(x => label === x || label.startsWith(x + ' ') || label.startsWith(x + ':'));
      });
      return found ? Number(pick(found, ['odds', 'odd', 'price', 'value', 'decimalOdds'])) : NaN;
    };
    const result = { home: get(['home', '1']), draw: get(['draw', 'x']), away: get(['away', '2']) };
    if ([result.home, result.draw, result.away].every(Number.isFinite)) return result;
  }
  return null;
}

function parseStatus(raw, utcDate) {
  const liveFlag = pick(raw, ['is_live', 'isLive', 'live', 'inPlay', 'in_play']);
  if (liveFlag === true || String(liveFlag).toLowerCase() === 'true' || Number(liveFlag) === 1) return 'IN_PLAY';
  const value = String(pick(raw, ['status', 'matchStatus', 'gameStatus', 'eventStatus', 'state']) || '').toLowerCase();
  if (value.includes('live') || value.includes('inplay') || value.includes('in_play') || value.includes('in-play')) return 'IN_PLAY';
  if (value.includes('half') || value.includes('pause')) return 'PAUSED';
  if (value.includes('finish') || value.includes('ended') || value.includes('settled') || value === 'ft' || value.includes('complete')) return 'FINISHED';
  return 'SCHEDULED';
}

function normalizeMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const nestedFixture = raw.fixture && typeof raw.fixture === 'object' ? raw.fixture : {};
  const nestedTeams = raw.teams && typeof raw.teams === 'object' ? raw.teams : {};
  const nestedLeague = raw.league && typeof raw.league === 'object' ? raw.league : {};
  const source = Object.assign({}, nestedFixture, raw);

  const externalId = pick(source, ['id', 'fixtureId', 'fixture_id', 'externalId', 'eventId', 'event_id', 'matchId', 'match_id'])
    || pick(nestedFixture, ['id', 'fixtureId', 'fixture_id']);
  if (externalId == null) return null;

  let home = teamName(pick(source, ['homeTeam', 'home_team', 'home']))
    || teamName(nestedTeams.home) || teamName(nestedTeams.Home);
  let away = teamName(pick(source, ['awayTeam', 'away_team', 'away']))
    || teamName(nestedTeams.away) || teamName(nestedTeams.Away);

  // SofaBets' public fixture payload commonly uses fixture_name:
  // "Home Team v Away Team" rather than separate home/away fields.
  const fixtureName = pick(source, ['fixture_name', 'fixtureName', 'match_name', 'matchName']);
  if ((!home || !away) && fixtureName) {
    const parts = String(fixtureName).split(/\s+v\s+|\s+vs\.?\s+/i);
    if (parts.length >= 2) {
      home = home || parts[0].trim();
      away = away || parts.slice(1).join(' v ').trim();
    }
  }
  if (!home || !away) return null;

  const competition = teamName(pick(source, ['competition', 'league', 'competitionName', 'tournament', 'championship', 'league_name', 'leagueName']))
    || teamName(nestedLeague);

  const kickoff = pick(source, [
    'startTime', 'start_time', 'date', 'kickoff', 'kickoffTime', 'kickoff_time',
    'scheduled', 'scheduledAt', 'startDate', 'start_date', 'eventDate', 'event_date', 'start_time_utc', 'startTimeUtc'
  ]);

  let utcDate = null;
  if (kickoff != null) {
    // SofaBets feeds may expose kickoff as ISO text OR Unix epoch seconds.
    // Date(number) interprets numbers as milliseconds, which can turn a valid
    // 2026 kickoff into a 1970 date and makes getMatchesForDate() return 0.
    let d;
    if (typeof kickoff === 'number' || (typeof kickoff === 'string' && /^\d{9,13}$/.test(kickoff.trim()))) {
      const n = Number(kickoff);
      d = new Date(n < 100000000000 ? n * 1000 : n);
    } else {
      d = new Date(kickoff);
    }
    if (Number.isFinite(d.getTime())) utcDate = d.toISOString();
  }

  const status = parseStatus(source, utcDate);
  const scoreObj = source.score && typeof source.score === 'object' ? source.score : {};
  const liveScore = source.live_score && typeof source.live_score === 'object' ? source.live_score : (source.liveScore && typeof source.liveScore === 'object' ? source.liveScore : {});
  const homeScore = pick(source, ['homeScore', 'home_score', 'scoreHome', 'home_score_live', 'live_home_score']) ?? pick(liveScore, ['home', 'homeScore', 'home_score']) ?? pick(scoreObj, ['home', 'Home', 'homeScore']);
  const awayScore = pick(source, ['awayScore', 'away_score', 'scoreAway', 'away_score_live', 'live_away_score']) ?? pick(liveScore, ['away', 'awayScore', 'away_score']) ?? pick(scoreObj, ['away', 'Away', 'awayScore']);
  const hasScore = homeScore != null && awayScore != null;

  const odds = parseOdds(source);
  const minute = pick(source, ['minute', 'liveMinute', 'matchMinute', 'elapsed', 'elapsedMinutes']);

  return {
    provider: 'sofabets',
    providerMatchId: String(externalId),
    competition: competition || 'Unknown Competition',
    season: pick(source, ['season', 'seasonName']),
    homeTeam: home,
    awayTeam: away,
    utcDate,
    status,
    score: { fullTime: hasScore ? { home: Number(homeScore), away: Number(awayScore) } : null, halfTime: null },
    venue: teamName(pick(source, ['venue', 'stadium'])),
    minute: minute != null && Number.isFinite(Number(minute)) ? Number(minute) : null,
    minuteIsEstimated: minute == null,
    // SofaBets is the authoritative odds source when odds are present.
    // Expose them directly as well as under the provider-specific field so
    // the canonical merge layer can carry them through without AI odds
    // generation overwriting them.
    odds: odds,
    _sofaProviderOdds: odds,
    _oddsSource: odds ? 'sofabets' : null,
    _hasProviderOdds: !!odds,
    _skipAiOddsGeneration: !!odds,
    _sofaMarkets: Array.isArray(source.markets) ? source.markets : null,
    _sofaRawId: String(externalId)
  };
}

function safeNormalizeMatch(raw) {
  try { return normalizeMatch(raw); }
  catch (e) {
    console.error('[sofaBetsProvider] normalize failed:', e.message);
    return null;
  }
}

function dateInTimeZone(iso, timeZone) {
  if (!iso) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(iso));
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch (_) { return iso.slice(0, 10); }
}

function sameRequestedDate(iso, dateStr) {
  if (!iso || !dateStr) return false;
  const value = String(iso);
  // Preserve date-only values if a provider supplied them.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value === dateStr;
  // JuanAi is used in Kenya; accept both Nairobi and UTC calendar dates so a
  // late-night/early-morning kickoff is never silently lost.
  return dateInTimeZone(value, 'Africa/Nairobi') === dateStr || value.slice(0, 10) === dateStr;
}

const allFixturesCache = { fetchedAt: 0, matches: [], base: null, path: null };

async function fetchAllFootballFixtures() {
  if (Date.now() - allFixturesCache.fetchedAt < ALL_FIXTURES_CACHE_TTL_MS) return allFixturesCache.matches;

  let lastError = null;
  for (const base of BASES) {
    for (const path of FIXTURE_PATHS) {
      try {
        const rawItems = await fetchPages(base, path);
        const matches = rawItems.map(safeNormalizeMatch).filter(Boolean);
        if (!matches.length && rawItems.length) {
          throw new Error('SofaBets returned ' + rawItems.length + ' records but none could be normalized');
        }
        // Do not treat an empty 200 response as a working fixture feed.
        // Continue to the next known SofaBets endpoint/base until we actually
        // obtain football fixtures. This is important because the backend has
        // several public API families and some return 200 with an empty body.
        if (!matches.length) {
          lastError = new Error('SofaBets endpoint returned 0 football fixtures: ' + base + path);
          console.warn('[sofaBetsProvider] ' + lastError.message);
          continue;
        }
        allFixturesCache.fetchedAt = Date.now();
        allFixturesCache.matches = matches;
        allFixturesCache.base = base;
        allFixturesCache.path = path;
        const oddsCount = matches.filter(m => m._sofaProviderOdds).length;
        const leaguesCount = new Set(matches.map(m => m.competition).filter(Boolean)).size;
        recordSuccess(matches.length, 0, oddsCount, leaguesCount, base, path);
        console.log(`[sofaBetsProvider] synced ${matches.length} fixtures from ${base}${path}`);
        return matches;
      } catch (e) {
        lastError = e;
        console.warn('[sofaBetsProvider] ' + base + path + ' failed: ' + e.message);
      }
    }
  }

  recordFailure(lastError || new Error('No SofaBets endpoint succeeded'));
  if (allFixturesCache.matches.length) return allFixturesCache.matches;
  return [];
}

async function fetchLiveFootballFixtures() {
  const livePaths = ['/api/live-games'];
  let lastError = null;

  for (const base of BASES) {
    for (const path of livePaths) {
      try {
        const all = [];
        for (let page = 1; page <= MAX_PAGES_PER_FETCH; page += 1) {
          const payload = await sofaFetch(base, path, {
            page: String(page),
            limit: '100',
            marketType: 'match result',
            sport: 'football'
          });
          const rawItems = extractItems(payload);
          if (!rawItems.length) break;

          all.push(...rawItems);
          const pg = paginationInfo(payload);
          if (pg.hasMore === false) break;
          if (pg.totalPages && page >= Number(pg.totalPages)) break;
          if (pg.nextPage != null && Number(pg.nextPage) > page) {
            page = Number(pg.nextPage) - 1;
          } else if (!(pg.hasMore === true || pg.totalPages || pg.nextPage != null)) {
            break;
          }
          await sleep(PAGE_FETCH_GAP_MS);
        }

        const matches = all
          .map(safeNormalizeMatch)
          .filter(Boolean)
          .map(m => Object.assign(m, { status: 'IN_PLAY' }));

        if (matches.length) {
          console.log(`[sofaBetsProvider] live sync: ${matches.length} live fixtures from ${base}${path}`);
          return matches;
        }
      } catch (e) {
        lastError = e;
        console.warn('[sofaBetsProvider] live ' + base + path + ' failed: ' + e.message);
      }
    }
  }

  if (lastError) console.warn('[sofaBetsProvider] live feed unavailable: ' + lastError.message);
  return [];
}

async function getMatchesForDate(dateStr) {
  const all = await fetchAllFootballFixtures();
  let result = all.filter(m => sameRequestedDate(m.utcDate, dateStr));

  // SofaBets exposes live matches through a separate endpoint. Always merge
  // the live feed for today's date so matches that have already started are
  // not lost when the normal fixtures feed is date/upcoming oriented.
  const todayNairobi = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  if (dateStr === todayNairobi) {
    const live = await fetchLiveFootballFixtures();
    const seen = new Set(result.map(m => String(m.providerMatchId)));
    const liveById = new Map(live.map(m => [String(m.providerMatchId), m]));
    for (let i = 0; i < result.length; i += 1) {
      const fresh = liveById.get(String(result[i].providerMatchId));
      if (fresh) result[i] = Object.assign({}, result[i], fresh, {
        odds: fresh.odds || result[i].odds,
        _sofaProviderOdds: fresh.odds || result[i]._sofaProviderOdds,
        _oddsSource: (fresh.odds || result[i]._sofaProviderOdds) ? 'sofabets' : null,
        _hasProviderOdds: !!(fresh.odds || result[i]._sofaProviderOdds),
        _skipAiOddsGeneration: !!(fresh.odds || result[i]._sofaProviderOdds)
      });
    }
    for (const m of live) {
      if (!seen.has(String(m.providerMatchId))) {
        result.push(m);
        seen.add(String(m.providerMatchId));
      }
    }
  }

  health.fixturesForRequestedDate = result.length;
  return result;
}

module.exports = { providerName: 'sofabets', isConfigured, getMatchesForDate, getStatus };
