// providers/sportmonksProvider.js — Sportmonks Football API v3.
// Confirmed from Sportmonks' own docs: base https://api.sportmonks.com/v3/football,
// token passed as ?api_token=KEY (query param auth — Sportmonks also
// supports an Authorization header, but query-param is the simplest to
// rotate per-key without touching header-building logic per key).
// Fixtures-by-date endpoint: /fixtures/date/{YYYY-MM-DD}.
// `include=participants;league;scores` pulls team names/league/score in
// one call instead of separate lookups. Field names below match
// Sportmonks' documented v3 fixture shape; verify via
// /internal/providers/test once a real key is added, same as every other
// provider here.
const { createKeyPool } = require('../lib/keyPool');
const { fetchWithKeyPool } = require('../lib/providerFetch');
const { normalizeStatus } = require('../lib/matchStatus');

const BASE_URL = 'https://api.sportmonks.com/v3/football';
const pool = createKeyPool('sportmonks', process.env.SPORTMONKS_KEYS || '');

function isConfigured() {
  return pool.isConfigured();
}

function getStatus() {
  return pool.getStatus();
}

function normalizeMatch(f) {
  if (!f) return null;
  const participants = Array.isArray(f.participants) ? f.participants : [];
  const home = participants.find(p => p.meta && p.meta.location === 'home') || participants[0] || {};
  const away = participants.find(p => p.meta && p.meta.location === 'away') || participants[1] || {};
  const scores = Array.isArray(f.scores) ? f.scores : [];
  // Sportmonks reports home/away goals as SEPARATE entries in the scores
  // array (each tagged score.participant: "home"/"away"), not one combined
  // object — this was wrong in an earlier draft of this file; fixed to
  // actually match their documented shape.
  const currentScores = scores.filter(s => s.description === 'CURRENT');
  const homeGoals = currentScores.find(s => s.score && s.score.participant === 'home');
  const awayGoals = currentScores.find(s => s.score && s.score.participant === 'away');
  return {
    provider: 'sportmonks',
    providerMatchId: String(f.id),
    competition: (f.league && f.league.name) || null,
    season: (f.season && f.season.name) || (f.season_id != null ? String(f.season_id) : null),
    homeTeam: home.name || 'Unknown',
    awayTeam: away.name || 'Unknown',
    // Sportmonks returns "starting_at" as "YYYY-MM-DD HH:mm:ss" (no
    // timezone marker) — treated as UTC per their docs' starting_at_timestamp
    // being a plain Unix timestamp.
    utcDate: f.starting_at ? new Date(f.starting_at.replace(' ', 'T') + 'Z').toISOString() : null,
    status: normalizeStatus(f.state && (f.state.short_name || f.state.state), 'sportmonks'),
    score: {
      fullTime: (homeGoals && awayGoals) ? { home: homeGoals.score.goals, away: awayGoals.score.goals } : null,
      halfTime: null
    },
    venue: null
  };
}

async function getMatchesForDate(dateStr) {
  const data = await fetchWithKeyPool(pool, (key) => ({
    url: BASE_URL + '/fixtures/date/' + encodeURIComponent(dateStr) + '?api_token=' + encodeURIComponent(key) + '&include=participants;league;scores;state',
    headers: {}
  }));
  const list = Array.isArray(data && data.data) ? data.data : [];
  return list.map(normalizeMatch).filter(Boolean);
}

module.exports = { providerName: 'sportmonks', isConfigured, getMatchesForDate, getStatus };
