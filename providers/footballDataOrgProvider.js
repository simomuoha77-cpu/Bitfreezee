// providers/footballDataOrgProvider.js — thin adapter around the EXISTING
// footballData.js module, which already has its own battle-tested
// multi-key rotation, cooldown tracking, and rate-limit handling for
// football-data.org (env var FOOTBALL_DATA_KEYS, aliased to the legacy
// FDORG_KEY). Deliberately NOT rewritten to use lib/keyPool.js — that
// would mean re-testing logic that's been running in production, for no
// real benefit, since it already does everything the new pool does. This
// file only normalizes its output onto the same common shape every other
// provider in providers/ uses, so footballProviders.js can treat all 7
// uniformly.
const footballData = require('../footballData');

function isConfigured() {
  return footballData.getKeyPoolStatus().totalKeys > 0;
}

function getStatus() {
  const s = footballData.getKeyPoolStatus();
  return { provider: 'football-data.org', configured: s.totalKeys > 0, totalKeys: s.totalKeys, availableKeys: s.availableKeys };
}

function normalizeMatch(m) {
  if (!m) return null;
  return {
    provider: 'football-data.org',
    providerMatchId: String(m.id),
    competition: (m.competition && m.competition.name) || null,
    season: m.season != null ? String(m.season) : null,
    homeTeam: (m.homeTeam && m.homeTeam.name) || 'Unknown',
    awayTeam: (m.awayTeam && m.awayTeam.name) || 'Unknown',
    utcDate: m.utcDate || null,
    status: m.status || 'SCHEDULED', // footballData.js already normalizes to this app's vocabulary
    score: {
      fullTime: (m.score && m.score.fullTime) || null,
      halfTime: (m.score && m.score.halfTime) || null
    },
    venue: m.venue || null
  };
}

async function getMatchesForDate(dateStr) {
  const matches = await footballData.getMatchesForDate(dateStr);
  return (matches || []).map(normalizeMatch).filter(Boolean);
}

module.exports = { providerName: 'football-data.org', isConfigured, getMatchesForDate, getStatus };
