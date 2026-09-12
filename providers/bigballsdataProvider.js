// providers/bigballsdataProvider.js — thin adapter around the EXISTING
// bigFootballData.js module (already handles multi-key rotation, caching,
// pagination, the full league-catalogue backfill, and the odds-403-plan
// cooldown). Normalizes its already-normalized match shape onto the ONE
// common shape every provider in providers/ uses, so footballProviders.js
// can treat all 7 uniformly.
const bigFootballData = require('../bigFootballData');

function isConfigured() {
  return bigFootballData.isConfigured();
}

function getStatus() {
  return bigFootballData.getKeyPoolStatus();
}

function normalizeMatch(m) {
  if (!m) return null;
  return {
    provider: 'bigballsdata',
    providerMatchId: m.id,
    competition: (m.competition && m.competition.name) || null,
    season: null, // BigBallsData's raw payload hasn't shown a season field yet — add here once confirmed
    homeTeam: (m.homeTeam && m.homeTeam.name) || 'Unknown',
    awayTeam: (m.awayTeam && m.awayTeam.name) || 'Unknown',
    utcDate: m.utcDate || null,
    status: m.status || 'SCHEDULED', // already normalized by bigFootballData.js
    score: {
      fullTime: (m.score && m.score.fullTime) || null,
      halfTime: (m.score && m.score.halfTime) || null
    },
    venue: m.venue || null,
    minute: m.minute,
    minuteIsEstimated: m.minuteIsEstimated
  };
}

async function getMatchesForDate(dateStr, options) {
  const matches = await bigFootballData.getMatchesForDate(dateStr, options);
  return (matches || []).map(normalizeMatch).filter(Boolean);
}

module.exports = { providerName: 'bigballsdata', isConfigured, getMatchesForDate, getStatus };
