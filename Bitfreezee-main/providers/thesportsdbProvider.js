// providers/thesportsdbProvider.js — TheSportsDB v1 (key goes in the URL
// PATH, not a header — confirmed from their own published resource list:
// https://www.thesportsdb.com/api/v1/json/{API_KEY}/eventsday.php?d=YYYY-MM-DD&s=Soccer).
// This is the one provider here where the "key" isn't a header/query
// param — providerFetch.js's buildRequest still works fine since it just
// needs the final url, key gets interpolated into the path instead of a
// header.
const { createKeyPool } = require('../lib/keyPool');
const { fetchWithKeyPool } = require('../lib/providerFetch');
const { normalizeStatus } = require('../lib/matchStatus');

const BASE_URL = 'https://www.thesportsdb.com/api/v1/json';
const pool = createKeyPool('thesportsdb', process.env.THESPORTSDB_KEYS || '');

function isConfigured() {
  return pool.isConfigured();
}

function getStatus() {
  return pool.getStatus();
}

function normalizeMatch(e) {
  if (!e) return null;
  const home = e.strHomeTeam || 'Unknown';
  const away = e.strAwayTeam || 'Unknown';
  const homeScore = e.intHomeScore != null && e.intHomeScore !== '' ? parseInt(e.intHomeScore, 10) : null;
  const awayScore = e.intAwayScore != null && e.intAwayScore !== '' ? parseInt(e.intAwayScore, 10) : null;
  // TheSportsDB's free tier doesn't give a clean live/finished status enum
  // the way the other providers do — strStatus is often blank for
  // not-yet-played and something like "Match Finished"/"FT" once done.
  // Falls back to inferring from whether a score is present, which is the
  // best signal this tier actually gives.
  let status = normalizeStatus(e.strStatus, 'thesportsdb');
  if (!e.strStatus) status = (homeScore != null && awayScore != null) ? 'FINISHED' : 'SCHEDULED';
  return {
    provider: 'thesportsdb',
    providerMatchId: String(e.idEvent),
    competition: e.strLeague || null,
    season: e.strSeason || null,
    homeTeam: home,
    awayTeam: away,
    utcDate: (e.strTimestamp || (e.dateEvent && e.strTime ? e.dateEvent + 'T' + e.strTime + 'Z' : null)),
    status,
    score: {
      fullTime: (homeScore != null && awayScore != null) ? { home: homeScore, away: awayScore } : null,
      halfTime: null
    },
    venue: e.strVenue || null
  };
}

async function getMatchesForDate(dateStr) {
  const data = await fetchWithKeyPool(pool, (key) => ({
    url: BASE_URL + '/' + encodeURIComponent(key) + '/eventsday.php?d=' + encodeURIComponent(dateStr) + '&s=Soccer',
    headers: {}
  }));
  const list = Array.isArray(data && data.events) ? data.events : [];
  return list.map(normalizeMatch).filter(Boolean);
}

module.exports = { providerName: 'thesportsdb', isConfigured, getMatchesForDate, getStatus };
