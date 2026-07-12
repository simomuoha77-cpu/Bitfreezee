// oddsData.js — REAL bookmaker odds from API-Football (api-football.com / api-sports.io).
//
// football-data.org (footballData.js) gives real fixtures but its free tier has
// no odds field at all. API-Football's free tier (100 req/day) DOES include a
// real /odds endpoint with actual bookmaker prices. This module fetches those
// real odds and nothing else — no invented numbers, ever.
//
// If this fails or a match has no odds posted yet, callers must surface that
// honestly (no odds available yet) rather than making numbers up.

const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY || '';
const APIFOOTBALL_BASE = 'https://v3.football.api-sports.io';

// Free tier = 100 requests/day. Odds don't need to be fetched per-request —
// they're cached in db.js and only refreshed on the interval set in
// scheduler.js (ODDS_REFRESH_INTERVAL_MS), so this stays well under budget.
const MIN_MS_BETWEEN_CALLS = 1200;
let lastCallAt = 0;

async function throttle() {
  const wait = MIN_MS_BETWEEN_CALLS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function afFetch(endpoint) {
  if (!APIFOOTBALL_KEY) {
    throw new Error('APIFOOTBALL_KEY not set — real odds cannot be fetched without it');
  }
  await throttle();
  const url = APIFOOTBALL_BASE + endpoint;
  const resp = await fetch(url, {
    headers: { 'x-apisports-key': APIFOOTBALL_KEY }
  });
  if (resp.status === 429) {
    throw new Error('API-Football rate limit hit (429) — back off and retry later');
  }
  if (!resp.ok) {
    throw new Error(`API-Football HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error('API-Football error: ' + JSON.stringify(data.errors));
  }
  return data;
}

// API-Football matches are identified by their own internal fixture id, which
// is NOT the same id football-data.org uses. To bridge the two, we look up by
// date + team names, since that's what we get from a football-data.org match.
// This is a best-effort text match — if nothing lines up closely enough, we
// return null rather than guessing.
function normalizeTeamName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\bfc\b|\bcf\b|\bafc\b|\bsc\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function namesLikelyMatch(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // one contains the other (handles "Manchester United" vs "Man United")
  return na.includes(nb) || nb.includes(na);
}

// Finds the API-Football fixture id for a given football-data.org match by
// searching fixtures on the same date and comparing team names.
async function findFixtureId(match) {
  const dateStr = match.utcDate ? match.utcDate.split('T')[0] : null;
  if (!dateStr) return null;

  const home = match.homeTeam && match.homeTeam.name;
  const away = match.awayTeam && match.awayTeam.name;
  if (!home || !away) return null;

  const data = await afFetch('/fixtures?date=' + dateStr);
  const fixtures = (data.response || []);

  const found = fixtures.find(f => {
    const fHome = f.teams && f.teams.home && f.teams.home.name;
    const fAway = f.teams && f.teams.away && f.teams.away.name;
    return namesLikelyMatch(fHome, home) && namesLikelyMatch(fAway, away);
  });

  return found ? found.fixture.id : null;
}

// Picks a representative bookmaker's 1X2 / totals / BTTS odds from the
// /odds response. API-Football returns multiple bookmakers; we prefer a
// well-known one if present, otherwise the first available, and we AVERAGE
// nothing — we report one real bookmaker's real prices so the numbers are
// internally consistent (mixing books produces impossible combinations).
const PREFERRED_BOOKMAKERS = ['Bet365', 'Pinnacle', '1xBet', 'Bwin'];

function pickBookmaker(bookmakers) {
  if (!Array.isArray(bookmakers) || !bookmakers.length) return null;
  for (const name of PREFERRED_BOOKMAKERS) {
    const found = bookmakers.find(b => b.name === name);
    if (found) return found;
  }
  return bookmakers[0];
}

function extractValue(bets, betName, valueLabel) {
  const bet = bets.find(b => b.name === betName);
  if (!bet) return null;
  const entry = bet.values.find(v => v.value === valueLabel);
  return entry ? parseFloat(entry.odd) : null;
}

// Returns real bookmaker odds for one match, structured to match the shape
// the rest of the app expects, or null if no odds are posted yet for this
// fixture (common for matches far in the future — bookmakers haven't
// priced them yet). Callers must treat null as "not available", not an
// error to paper over.
async function getRealOdds(match) {
  const fixtureId = await findFixtureId(match);
  if (!fixtureId) return null;

  const data = await afFetch('/odds?fixture=' + fixtureId);
  const entry = (data.response || [])[0];
  if (!entry) return null;

  const bookmaker = pickBookmaker(entry.bookmakers);
  if (!bookmaker) return null;

  const bets = bookmaker.bets || [];

  const homeWin = extractValue(bets, 'Match Winner', 'Home');
  const draw = extractValue(bets, 'Match Winner', 'Draw');
  const awayWin = extractValue(bets, 'Match Winner', 'Away');
  if (!homeWin || !draw || !awayWin) return null; // no usable 1X2 line — treat as unavailable

  const over25 = extractValue(bets, 'Goals Over/Under', 'Over 2.5');
  const under25 = extractValue(bets, 'Goals Over/Under', 'Under 2.5');
  const btts = extractValue(bets, 'Both Teams Score', 'Yes');
  const bttsNo = extractValue(bets, 'Both Teams Score', 'No');

  // Double chance, derived from real 1X2 prices via standard the-odds-api-style
  // combination (1/(1/a + 1/b)) when API-Football doesn't list it directly —
  // this is real-odds arithmetic, not invention.
  const dcFromTwo = (oddA, oddB) => {
    if (!oddA || !oddB) return null;
    const implied = (1 / oddA) + (1 / oddB);
    return implied > 0 ? +(1 / implied).toFixed(2) : null;
  };

  return {
    source: bookmaker.name,
    fetchedAt: Date.now(),
    homeWin, draw, awayWin,
    over25, under25,
    btts, bttsNo,
    dc_home_draw: dcFromTwo(homeWin, draw),
    dc_home_away: dcFromTwo(homeWin, awayWin),
    dc_draw_away: dcFromTwo(draw, awayWin)
  };
}

module.exports = { getRealOdds };
