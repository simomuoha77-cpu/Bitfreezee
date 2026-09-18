// providers/apiFootballProvider.js — API-FOOTBALL (v3.football.api-sports.io).
// Auth: header x-rapidapi-key (direct api-sports.io host, not the RapidAPI
// marketplace host — matches the documented "signed up directly at
// api-sports.io" flow). Confirmed base URL + auth header shape from
// API-Football's own public docs/examples; the exact response field names
// below (fixture.date, teams.home.name, goals.home, etc.) match their
// documented v3 fixtures response shape, but haven't been verified against
// a live call with a real key from this account — check
// /internal/providers/test after adding a key and adjust normalizeMatch()
// the same way bigFootballData.js's was tuned earlier if anything looks off.
const { createKeyPool } = require('../lib/keyPool');
const { fetchWithKeyPool } = require('../lib/providerFetch');
const { normalizeStatus } = require('../lib/matchStatus');

const BASE_URL = 'https://v3.football.api-sports.io';
const pool = createKeyPool('api-football', process.env.API_FOOTBALL_KEYS || '');

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
    provider: 'api-football',
    providerMatchId: String(f.fixture.id),
    competition: league.name || null,
    season: league.season != null ? String(league.season) : null,
    homeTeam: home.name || 'Unknown',
    awayTeam: away.name || 'Unknown',
    utcDate: f.fixture.date || null,
    status: normalizeStatus(f.fixture.status && f.fixture.status.short, 'api-football'),
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

module.exports = { providerName: 'api-football', isConfigured, getMatchesForDate, getStatus };
