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
const ANALYSIS_MAX_AGE_MS = 3 * 60 * 60 * 1000;      // re-analyze if odds older than 3h
const ANALYSIS_PACE_MS = 2500;                        // gap between individual AI calls
const DAY_BUCKETS = [0, 1]; // today, tomorrow — extend if you want more lookahead

let running = false;
let lastFixtureRefresh = {}; // days -> timestamp

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
  return (Date.now() - match.aiAnalyzedAt) > ANALYSIS_MAX_AGE_MS;
}

async function analysisPass() {
  for (const days of DAY_BUCKETS) {
    const bucket = db.getFixtures(days);
    if (!bucket || !Array.isArray(bucket.matches)) continue;

    const toAnalyze = bucket.matches.filter(needsAnalysis);
    for (const match of toAnalyze) {
      try {
        const odds = await ai.analyzeMatch(match);
        db.upsertMatchOdds(match.id, days, odds);
        var home = match.homeTeam && match.homeTeam.name;
        var away = match.awayTeam && match.awayTeam.name;
        console.log('[scheduler] Analyzed match ' + match.id + ' (' + home + ' vs ' + away + ') for days=' + days);
      } catch (e) {
        console.error('[scheduler] Analysis FAILED for match ' + match.id + ': ' + e.message);
        // Leave this match without odds rather than faking a result.
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
