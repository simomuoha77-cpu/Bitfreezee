// providers/apiSportsProvider.js — "API-Sports", kept as a fully separate
// provider/key-pool per explicit request, even though api-sports.io's
// FOOTBALL product is literally branded "API-FOOTBALL" (see
// apiFootballProvider.js) — there isn't a separately-branded "API-Sports"
// football endpoint distinct from that one. This adapter points at the
// same v3.football.api-sports.io API as api-football, just with its own
// key pool (API_SPORTS_KEYS) and its own rotation/cooldown tracking, so
// if this is meant to be a second, separate api-sports.io account (common
// — free-tier accounts are per-email), it works as intended. If this was
// actually meant to be a different product entirely, say so and this
// adapter's base URL/shape can be swapped out.
const { createKeyPool } = require('../lib/keyPool');
const { fetchWithKeyPool } = require('../lib/providerFetch');
const { normalizeStatus } = require('../lib/matchStatus');

const BASE_URL = 'https://v3.football.api-sports.io';
const pool = createKeyPool('api-sports', process.env.API_SPORTS_KEYS || '');

function isConfigured() {
  return pool.isConfigured();
}

function getStatus() {
  return pool.getStatus();
}

function normalizeMatch(f) {
  if (!f || !f.fixture) return null;
  const home = (f.teams && f.teams.home) || {};
  const away = (f.teams && f.teams.away) || {};
  const goals = f.goals || {};
  const league = f.league || {};
  return {
    provider: 'api-sports',
    providerMatchId: String(f.fixture.id),
    competition: league.name || null,
    season: league.season != null ? String(league.season) : null,
    homeTeam: home.name || 'Unknown',
    awayTeam: away.name || 'Unknown',
    utcDate: f.fixture.date || null,
    status: normalizeStatus(f.fixture.status && f.fixture.status.short, 'api-sports'),
    score: {
      fullTime: (goals.home != null && goals.away != null) ? { home: goals.home, away: goals.away } : null,
      halfTime: (f.score && f.score.halftime) ? { home: f.score.halftime.home, away: f.score.halftime.away } : null
    },
    venue: (f.fixture.venue && f.fixture.venue.name) || null
  };
}

async function getMatchesForDate(dateStr) {
  const data = await fetchWithKeyPool(pool, (key) => ({
    url: BASE_URL + '/fixtures?date=' + encodeURIComponent(dateStr),
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'v3.football.api-sports.io' }
  }));
  const list = Array.isArray(data && data.response) ? data.response : [];
  return list.map(normalizeMatch).filter(Boolean);
}

module.exports = { providerName: 'api-sports', isConfigured, getMatchesForDate, getStatus };
