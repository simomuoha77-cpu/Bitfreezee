// scheduler.js -- the "no clicking needed" background engine.
//
// Runs entirely on the server. Three jobs now:
//   1. Refresh fixtures from football-data.org (real matches, free/unlimited tier).
//   2. Refresh REAL bookmaker odds from API-Football for fixtures that don't
//      have odds yet, or whose odds are stale (see ODDS_REFRESH_INTERVAL_MS).
//      API-Football's free tier is rate-limited (~100 req/day), so this is
//      paced deliberately slower than the fixture refresh.
//   3. Run AI analysis on top of whatever real odds are already cached --
//      never on invented numbers. If a match has no real odds yet, it's
//      simply left unanalyzed rather than faked.
//
// Paced conservatively to respect both providers' free-tier limits.

const db = require('./db');
const footballData = require('./footballData');
const oddsData = require('./oddsData');
const ai = require('./ai');

const FIXTURE_REFRESH_INTERVAL_MS = 15 * 60 * 1000;   // refresh fixture list every 15 min
const ODDS_REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000;   // refresh real odds every 8h (free-tier friendly)
const ANALYSIS_LOOP_INTERVAL_MS = 90 * 1000;           // check for unanalyzed matches every 90s
const ANALYSIS_MAX_AGE_MS = 8 * 60 * 60 * 1000;        // re-analyze if odds/analysis older than 8h
const ANALYSIS_PACE_MS = 2500;                          // gap between individual AI calls
const ODDS_PACE_MS = 3000;                              // gap between individual odds lookups
const DAY_BUCKETS = [0, 1]; // today, tomorrow -- extend if you want more lookahead

let running = false;
let lastFixtureRefresh = {}; // days -> timestamp
let lastOddsRefresh = {};    // days -> timestamp

async function refreshFixturesForDay(days) {
  const dateStr = footballData.getDateString(days);
  try {
    const matches = await footballData.getMatchesForDate(dateStr);
    // Merge with any existing real odds + AI analysis already stored, so a
    // fixture refresh doesn't wipe out data that's still valid.
    const existing = db.getFixtures(days);
    const existingById = {};
    if (existing && Array.isArray(existing.matches)) {
      existing.matches.forEach(m => { existingById[String(m.id)] = m; });
    }
    const merged = matches.map(m => {
      const prev = existingById[String(m.id)];
      if (prev && prev.realOdds) {
        return Object.assign({}, m, {
          realOdds: prev.realOdds,
          realOddsFetchedAt: prev.realOddsFetchedAt,
          aiOdds: prev.aiOdds,
          aiPrediction: prev.aiPrediction,
          aiConfidence: prev.aiConfidence,
          aiAnalysis: prev.aiAnalysis,
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
    // Real failure -- log it, do NOT substitute fake fixtures.
    console.error('[scheduler] Fixture refresh FAILED for days=' + days + ': ' + e.message);
  }
}

function needsOdds(match) {
  if (!match.realOdds || !match.realOddsFetchedAt) return true;
  return (Date.now() - match.realOddsFetchedAt) > ODDS_REFRESH_INTERVAL_MS;
}

async function oddsRefreshPass() {
  for (const days of DAY_BUCKETS) {
    const bucket = db.getFixtures(days);
    if (!bucket || !Array.isArray(bucket.matches)) continue;

    const toFetch = bucket.matches.filter(needsOdds);
    for (const match of toFetch) {
      try {
        const realOdds = await oddsData.getRealOdds(match);
        if (realOdds) {
          db.upsertRealOdds(match.id, days, realOdds);
          var home = match.homeTeam && match.homeTeam.name;
          var away = match.awayTeam && match.awayTeam.name;
          console.log('[scheduler] Real odds fetched for match ' + match.id + ' (' + home + ' vs ' + away + ') from ' + realOdds.source);
        } else {
          // No real odds posted yet for this fixture (common far from kickoff).
          // Mark the attempt so we don't hammer the API every pass, but don't
          // fake odds.
          db.markOddsUnavailable(match.id, days);
        }
      } catch (e) {
        console.error('[scheduler] Odds fetch FAILED for match ' + match.id + ': ' + e.message);
      }
      await new Promise(function(r){ setTimeout(r, ODDS_PACE_MS); });
    }
    lastOddsRefresh[days] = Date.now();
  }
}

function needsAnalysis(match) {
  if (!match.realOdds) return false; // never analyze without a real market to read
  if (!match.aiAnalyzedAt) return true;
  return (Date.now() - match.aiAnalyzedAt) > ANALYSIS_MAX_AGE_MS;
}

async function analysisPass() {
  for (const days of DAY_BUCKETS) {
    const bucket = db.getFixtures(days);
    if (!bucket || !Array.isArray(bucket.matches)) continue;

    const toAnalyze = bucket.matches.filter(needsAnalysis);
    for (const match of toAnalyze) {
      try {
        const result = await ai.analyzeMatch(match, match.realOdds);
        db.upsertMatchOdds(match.id, days, result);
        var home = match.homeTeam && match.homeTeam.name;
        var away = match.awayTeam && match.awayTeam.name;
        console.log('[scheduler] Analyzed match ' + match.id + ' (' + home + ' vs ' + away + ') for days=' + days + ' using real odds from ' + match.realOdds.source);
      } catch (e) {
        console.error('[scheduler] Analysis FAILED for match ' + match.id + ': ' + e.message);
        // Leave this match without analysis rather than faking a result.
      }
      await new Promise(function(r){ setTimeout(r, ANALYSIS_PACE_MS); });
    }
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
  console.log('[scheduler] Starting background auto-refresh + real-odds + auto-analysis (no manual clicks needed)');

  fixtureRefreshLoop();
  setInterval(fixtureRefreshLoop, FIXTURE_REFRESH_INTERVAL_MS);

  // Give the first fixture refresh a head start, then start pulling real odds,
  // then run analysis on top of whatever real odds have come in.
  setTimeout(function(){
    oddsRefreshPass();
    setInterval(oddsRefreshPass, ODDS_REFRESH_INTERVAL_MS);
  }, 15 * 1000);

  setTimeout(function(){
    analysisPass();
    setInterval(analysisPass, ANALYSIS_LOOP_INTERVAL_MS);
  }, 30 * 1000);
}

module.exports = { start: start };
