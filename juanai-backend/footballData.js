// footballData.js — real fixtures from football-data.org, fetched server-side.
//
// CORS never applies to server-to-server requests, so unlike the browser
// version in JuanAi's frontend, this doesn't need proxy workarounds or a
// "demo fixtures" fallback. If this fails, callers should surface the real
// error — never substitute fabricated matches.

const FDORG_KEY = process.env.FDORG_KEY || '881689e6b5a341c6bdd557bfa6c55834';
const FDORG_BASE = 'https://api.football-data.org/v4';

// Free tier = 10 requests/minute. Keep a healthy margin below that everywhere
// this module is used from (see scheduler.js for the cron pacing).
const MIN_MS_BETWEEN_CALLS = 6500; // ~9.2 req/min ceiling
let lastCallAt = 0;

async function throttle() {
  const wait = MIN_MS_BETWEEN_CALLS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function fdFetch(endpoint) {
  await throttle();
  const url = FDORG_BASE + endpoint;
  const resp = await fetch(url, { headers: { 'X-Auth-Token': FDORG_KEY } });
  if (resp.status === 429) {
    throw new Error('football-data.org rate limit hit (429) — back off and retry later');
  }
  if (!resp.ok) {
    throw new Error(`football-data.org HTTP ${resp.status}`);
  }
  return resp.json();
}

// Returns real matches for a given date (YYYY-MM-DD). Throws on failure —
// callers must not paper over this with sample/demo data.
async function getMatchesForDate(dateStr) {
  const data = await fdFetch('/matches?date=' + dateStr);
  return data.matches || [];
}

// Returns real head-to-head history + recent form for a match, straight from
// football-data.org's own aggregation (last 10 meetings + each side's wins/
// draws/losses). Used to ground the AI's odds in actual results instead of
// pure model "memory" of the teams. Returns null on failure — callers should
// just proceed without history rather than blocking analysis entirely.
async function getHeadToHead(matchId, limit) {
  try {
    const data = await fdFetch('/matches/' + matchId + '/head2head?limit=' + (limit || 10));
    return {
      numberOfMatches: data.resultSet && data.resultSet.count || 0,
      homeTeamWins: data.aggregates && data.aggregates.homeTeam && data.aggregates.homeTeam.wins || 0,
      awayTeamWins: data.aggregates && data.aggregates.awayTeam && data.aggregates.awayTeam.wins || 0,
      draws: data.aggregates && data.aggregates.homeTeam && data.aggregates.homeTeam.draws || 0,
      recentMatches: (data.matches || []).slice(0, 5).map(function(m) {
        return {
          date: m.utcDate,
          home: m.homeTeam && m.homeTeam.name,
          away: m.awayTeam && m.awayTeam.name,
          score: m.score && m.score.fullTime ? (m.score.fullTime.home + '-' + m.score.fullTime.away) : 'N/A',
          competition: m.competition && m.competition.name
        };
      })
    };
  } catch (e) {
    console.error('[footballData] head2head fetch failed for match ' + matchId + ': ' + e.message);
    return null;
  }
}

// Returns a team's recent finished matches (form guide), most recent first.
// Free tier only exposes each team's own match list, not a dedicated
// "form" endpoint, so we fetch and filter client-side.
async function getTeamRecentForm(teamId, count) {
  try {
    const data = await fdFetch('/teams/' + teamId + '/matches?status=FINISHED&limit=' + (count || 5));
    return (data.matches || []).slice(0, count || 5).map(function(m) {
      const isHome = m.homeTeam && m.homeTeam.id === teamId;
      const gf = m.score && m.score.fullTime ? (isHome ? m.score.fullTime.home : m.score.fullTime.away) : null;
      const ga = m.score && m.score.fullTime ? (isHome ? m.score.fullTime.away : m.score.fullTime.home) : null;
      let result = 'D';
      if (gf !== null && ga !== null) result = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
      return {
        date: m.utcDate,
        opponent: isHome ? (m.awayTeam && m.awayTeam.name) : (m.homeTeam && m.homeTeam.name),
        venue: isHome ? 'H' : 'A',
        score: (gf !== null ? gf + '-' + ga : 'N/A'),
        result: result
      };
    });
  } catch (e) {
    console.error('[footballData] recent form fetch failed for team ' + teamId + ': ' + e.message);
    return null;
  }
}

function getDateString(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + parseInt(daysAhead || 0, 10));
  return d.toISOString().split('T')[0];
}

module.exports = { getMatchesForDate, getDateString, getHeadToHead, getTeamRecentForm };
