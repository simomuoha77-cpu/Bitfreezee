// providers/highlightlyProvider.js — Highlightly football API.
// Confirmed base URL + auth header from Highlightly's own docs: base
// https://soccer.highlightly.net, header x-rapidapi-key. The exact path
// for a date-scoped MATCH list (as opposed to their documented
// highlights/standings/teams endpoints) isn't confirmed against their
// full football-specific reference — using the conventional /matches
// path with a date filter, consistent with their other sport products'
// naming. Verify via /internal/providers/test and adjust the path below
// if Highlightly's actual football matches endpoint differs.
const { createKeyPool } = require('../lib/keyPool');
const { fetchWithKeyPool } = require('../lib/providerFetch');
const { normalizeStatus } = require('../lib/matchStatus');

const BASE_URL = 'https://soccer.highlightly.net';
const pool = createKeyPool('highlightly', process.env.HIGHLIGHTLY_KEYS || '');

function isConfigured() {
  return pool.isConfigured();
}

function getStatus() {
  return pool.getStatus();
}

function normalizeMatch(m) {
  if (!m) return null;
  const home = m.homeTeam || m.home_team || {};
  const away = m.awayTeam || m.away_team || {};
  return {
    provider: 'highlightly',
    providerMatchId: String(m.id),
    competition: (m.league && m.league.name) || null,
    season: m.season != null ? String(m.season) : null,
    homeTeam: home.name || 'Unknown',
    awayTeam: away.name || 'Unknown',
    utcDate: m.date || m.kickoff || null,
    status: normalizeStatus(m.status || m.state, 'highlightly'),
    score: {
      fullTime: (m.homeScore != null && m.awayScore != null) ? { home: m.homeScore, away: m.awayScore } : null,
      halfTime: null
    },
    venue: null
  };
}

async function getMatchesForDate(dateStr) {
  const data = await fetchWithKeyPool(pool, (key) => ({
    url: BASE_URL + '/matches?date=' + encodeURIComponent(dateStr),
    headers: { 'x-rapidapi-key': key }
  }));
  const list = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : [];
  return list.map(normalizeMatch).filter(Boolean);
}

module.exports = { providerName: 'highlightly', isConfigured, getMatchesForDate, getStatus };
