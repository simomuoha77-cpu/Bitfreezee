// scheduler.js — the "no clicking needed" background engine.
//
// Runs entirely on the server. Two jobs:
//   1. Refresh fixtures from football-data.org (real matches only).
//   2. Analyze any fixture that doesn't have AI odds yet, or whose odds
//      are older than ANALYSIS_MAX_AGE_MS (so upcoming matches get
//      refreshed analysis as kickoff approaches, not just once).
//
// Paced conservatively to respect football-data.org's 10 req/min free-tier
// limit (footballData.js already throttles its own calls) and to avoid
// hammering the AI providers.

const db = require('./db');
const footballData = require('./footballData');
const ai = require('./ai');

const FIXTURE_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // refresh fixture list every 15 min
const ANALYSIS_LOOP_INTERVAL_MS = 90 * 1000;         // check for unanalyzed matches every 90s
const ANALYSIS_MAX_AGE_MS = 3 * 60 * 60 * 1000;      // re-analyze if odds older than 3h (pre-match only)
const LIVE_ANALYSIS_MAX_AGE_MS = 60 * 1000;          // re-analyze LIVE matches every 60s so odds track the actual score/minute, like a real in-play book
const ANALYSIS_PACE_MS = 8000;                        // gap between individual match analyses (each now costs 3 football-data.org calls: h2h + 2x form, plus the AI call, so paced wider to stay under the 10 req/min free tier)
const DAY_BUCKETS = [0, 1, 2, 3, 4, 5, 6, 7]; // today through 7 days out — matches the frontend's dropdown range

let running = false;
let lastFixtureRefresh = {}; // days -> timestamp

function isLive(match) {
  return match.status === 'IN_PLAY' || match.status === 'PAUSED';
}

async function refreshFixturesForDay(days) {
  const dateStr = footballData.getDateString(days);
  try {
    const matches = await footballData.getMatchesForDate(dateStr);
    // Merge with any existing AI odds already stored, so a refresh doesn't
    // wipe out analysis that's still valid.
    const existing = db.getFixtures(days);
    const existingById = {};
    if (existing && Array.isArray(existing.matches)) {
      existing.matches.forEach(m => { existingById[String(m.id)] = m; });
    }
    const merged = matches.map(m => {
      const prev = existingById[String(m.id)];
      if (prev && prev.aiOdds) {
        return Object.assign({}, m, {
          aiOdds: prev.aiOdds,
          aiPrediction: prev.aiPrediction,
          aiConfidence: prev.aiConfidence,
          aiAnalysis: prev.aiAnalysis,
          aiXG: prev.aiXG,
          aiValueBet: prev.aiValueBet,
          aiAnalyzedAt: prev.aiAnalyzedAt
        });
      }
      return m;
    });
    db.saveFixtures(days, merged);
    lastFixtureRefresh[days] = Date.now();
    console.log('[scheduler] Refreshed ' + merged.length + ' real fixtures for days=' + days + ' (' + dateStr + ')');
  } catch (e) {
    // Real failure — log it, do NOT substitute fake fixtures.
    console.error('[scheduler] Fixture refresh FAILED for days=' + days + ': ' + e.message);
  }
}

function needsAnalysis(match) {
  if (!match.aiOdds || !match.aiAnalyzedAt) return true;
  // Live matches get a much tighter refresh window than pre-match ones —
  // the score/minute changes constantly, so odds need to track it in near
  // real time instead of sitting on stale pre-match numbers for 3 hours.
  const maxAge = isLive(match) ? LIVE_ANALYSIS_MAX_AGE_MS : ANALYSIS_MAX_AGE_MS;
  return (Date.now() - match.aiAnalyzedAt) > maxAge;
}

async function analysisPass() {
  // Collect everything needing analysis across all day-buckets first, then
  // sort so LIVE matches always jump the queue — a live match sitting behind
  // a backlog of pre-match fixtures from other days would otherwise keep
  // showing stale odds well after the score has changed.
  const queue = [];
  for (const days of DAY_BUCKETS) {
    const bucket = db.getFixtures(days);
    if (!bucket || !Array.isArray(bucket.matches)) continue;
    bucket.matches.filter(needsAnalysis).forEach(match => queue.push({ match, days }));
  }
  queue.sort((a, b) => (isLive(b.match) ? 1 : 0) - (isLive(a.match) ? 1 : 0));

  for (const { match, days } of queue) {
    try {
      const live = isLive(match);
      // Head-to-head and recent form don't change mid-match, so skip that
      // fetch for live re-pricing passes — it was already captured pre-match
      // (or isn't needed) and re-fetching it here would just burn API budget
      // that's better spent getting the next live update out faster.
      const history = live ? null : await fetchMatchHistory(match);
      const odds = await ai.analyzeMatch(match, history, live ? buildLiveState(match) : null);
      db.upsertMatchOdds(match.id, days, odds);
      var home = match.homeTeam && match.homeTeam.name;
      var away = match.awayTeam && match.awayTeam.name;
      console.log('[scheduler] Analyzed match ' + match.id + ' (' + home + ' vs ' + away + ') for days=' + days
        + (live ? ' [LIVE re-price, score ' + describeScore(match) + ']' : (history ? ' [with real history]' : ' [no history available]')));
    } catch (e) {
      console.error('[scheduler] Analysis FAILED for match ' + match.id + ': ' + e.message);
      // Leave this match without odds rather than faking a result.
    }
    await new Promise(function(r){ setTimeout(r, ANALYSIS_PACE_MS); });
  }
}

// Builds a compact live-state summary (score, minute, status) to hand to the
// AI so it reprices based on what's actually happening in the match, not
// pre-match assumptions about team strength.
function buildLiveState(match) {
  const score = match.score && match.score.fullTime ? match.score.fullTime : (match.score && match.score.halfTime) || null;
  return {
    minute: match.minute || null,
    status: match.status,
    homeGoals: score ? score.home : null,
    awayGoals: score ? score.away : null
  };
}

function describeScore(match) {
  const s = buildLiveState(match);
  return (s.homeGoals != null ? s.homeGoals : '?') + '-' + (s.awayGoals != null ? s.awayGoals : '?') + (s.minute ? (' @ ' + s.minute + "'") : '');
}

// Pulls real head-to-head + each team's recent form from football-data.org
// so the AI grounds its odds in actual results instead of pure model
// "memory" of the teams. Each call already goes through footballData's own
// throttle, and we space these 3 calls out further since a single match
// analysis now costs 3 requests instead of 0 — still comfortably under the
// free tier's 10 req/min when combined with ANALYSIS_PACE_MS.
async function fetchMatchHistory(match) {
  try {
    const h2h = await footballData.getHeadToHead(match.id, 10);
    const homeId = match.homeTeam && match.homeTeam.id;
    const awayId = match.awayTeam && match.awayTeam.id;
    const homeForm = homeId ? await footballData.getTeamRecentForm(homeId, 5) : null;
    const awayForm = awayId ? await footballData.getTeamRecentForm(awayId, 5) : null;
    if (!h2h && !homeForm && !awayForm) return null;
    return { h2h: h2h, homeForm: homeForm, awayForm: awayForm };
  } catch (e) {
    console.error('[scheduler] History fetch failed for match ' + match.id + ': ' + e.message);
    return null;
  }
}

async function fixtureRefreshLoop() {
  for (const days of DAY_BUCKETS) {
    const last = lastFixtureRefresh[days] || 0;
    if (Date.now() - last >= FIXTURE_REFRESH_INTERVAL_MS) {
      await refreshFixturesForDay(days);
    }
  }
}

function start() {
  if (running) return;
  running = true;
  console.log('[scheduler] Starting background auto-refresh + auto-analysis (no manual clicks needed)');

  // Kick off immediately on boot, then on their own intervals.
  fixtureRefreshLoop();
  setInterval(fixtureRefreshLoop, FIXTURE_REFRESH_INTERVAL_MS);

  // Give the first fixture refresh a head start before the first analysis pass.
  setTimeout(function(){
    analysisPass();
    setInterval(analysisPass, ANALYSIS_LOOP_INTERVAL_MS);
  }, 10 * 1000);
}

module.exports = { start: start };
