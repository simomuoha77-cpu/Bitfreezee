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

const FIXTURE_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // refresh future-day fixture lists every 15 min — nothing there is live/about-to-finish, so this doesn't need to be fast
const TODAY_REFRESH_INTERVAL_MS = 2 * 60 * 1000;      // but TODAY's bucket refreshes every 2 min — this is the one that actually matters for live/finished status accuracy. Matches appearing to "start late" or "still show live after ending" was a direct symptom of only checking every 15 min; 2 min keeps that lag small without meaningfully increasing football-data.org's request volume (only day=0 gets the faster cadence, days 1-7 stay at 15 min)
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

function hasKnownTeams(match) {
  const home = match.homeTeam && match.homeTeam.name;
  const away = match.awayTeam && match.awayTeam.name;
  if (!home || !away) return false;
  // football-data.org uses literal "TBD" for knockout-stage fixtures where
  // the previous round hasn't finished yet, so the participants aren't
  // decided. Generating AI odds for two unknown teams is meaningless and
  // misleads whoever displays it — better to just wait until the real teams
  // are confirmed by a later fixture refresh.
  return home.toUpperCase() !== 'TBD' && away.toUpperCase() !== 'TBD';
}

async function refreshFixturesForDay(days) {
  const dateStr = footballData.getDateString(days);
  try {
    const matches = await footballData.getMergedMatchesForDate(dateStr, days === 0);
    const existing = await db.getFixtures(days);

    // If BOTH sources failed/returned nothing this cycle (e.g. football-data.org
    // hit its 429 at the same moment odds-api.io was cooling down from its
    // own rate limit — a real scenario we hit in testing), don't overwrite
    // whatever fixtures we already have with an empty list. The scheduler
    // runs every 15 minutes; better to keep showing slightly-stale-but-real
    // data than to wipe the board because of a temporary, simultaneous
    // outage on both providers.
    if (matches.length === 0 && existing && Array.isArray(existing.matches) && existing.matches.length > 0) {
      console.warn('[scheduler] Both fixture sources returned nothing for days=' + days + ' (' + dateStr + ') — keeping ' + existing.matches.length + ' existing fixtures rather than wiping them');
      return;
    }

    // NOTE: no manual "carry forward prior odds" merge needed here anymore —
    // db.js's saveFixtures only ever updates each match's base fixture data
    // (teams, date, status, score) via MongoDB $set, and deliberately never
    // touches aiOdds/aiPrediction/etc (those are ONLY written by
    // upsertMatchOdds). So existing analysis is automatically preserved by
    // the database itself on every refresh — this used to require manual
    // merging when fixtures lived in a single JSON file that got fully
    // overwritten each time; that's no longer how storage works.
    await db.saveFixtures(days, matches);
    lastFixtureRefresh[days] = Date.now();

    // Self-heal: clear any stale odds that were generated for a match
    // BEFORE the TBD-filter existed (needsAnalysis now skips TBD matches
    // going forward, but that doesn't retroactively clean up odds already
    // sitting in the database from before that fix). This only does
    // anything on matches that still have both aiOdds AND TBD teams —
    // harmless no-op otherwise.
    const stillTbdWithOdds = matches.filter(m => !hasKnownTeams(m));
    for (const m of stillTbdWithOdds) {
      await db.clearMatchOdds(String(m.id), days);
    }

    console.log('[scheduler] Refreshed ' + matches.length + ' real fixtures for days=' + days + ' (' + dateStr + ')');
  } catch (e) {
    // Real failure — log it, do NOT substitute fake fixtures.
    console.error('[scheduler] Fixture refresh FAILED for days=' + days + ': ' + e.message);
  }
}

function needsAnalysis(match) {
  // Never analyze a finished match — the game is over, there's nothing left
  // to price, and without this check a finished match that somehow never
  // got odds (e.g. it ended faster than the scheduler's cycle) would keep
  // getting retried every single pass, forever, burning API calls for
  // nothing.
  if (match.status === 'FINISHED') return false;
  // Never analyze a match with undetermined teams (TBD vs TBD) — there's
  // nothing real to price yet, and it'll be picked up automatically once a
  // later fixture refresh resolves the actual participants.
  if (!hasKnownTeams(match)) return false;
  if (!match.aiOdds || !match.aiAnalyzedAt) return true;
  // Live matches get a much tighter refresh window than pre-match ones —
  // the score/minute changes constantly, so odds need to track it in near
  // real time instead of sitting on stale pre-match numbers for 3 hours.
  const maxAge = isLive(match) ? LIVE_ANALYSIS_MAX_AGE_MS : ANALYSIS_MAX_AGE_MS;
  return (Date.now() - match.aiAnalyzedAt) > maxAge;
}

// Caps how many matches we attempt to analyze in a single pass. With two
// merged fixture sources now returning far more matches than
// football-data.org alone (1500+ across 8 day-buckets in real testing),
// trying to analyze everything at once immediately exhausts both Gemini's
// and Groq's free-tier quotas in minutes. Instead, each pass only takes the
// highest-priority slice — live matches first, then soonest-kickoff first —
// and leaves the rest for the next pass. Over enough passes everything
// still gets analyzed eventually; it just respects real rate limits instead
// of front-loading a burst that guarantees failures.
const MAX_MATCHES_PER_ANALYSIS_PASS = 15;

async function analysisPass() {
  // Collect everything needing analysis across all day-buckets first, then
  // sort so LIVE matches always jump the queue, and everything else is
  // ordered by soonest kickoff first — a match kicking off in an hour
  // should never sit behind one 6 days out just because of iteration order.
  const queue = [];
  for (const days of DAY_BUCKETS) {
    const bucket = await db.getFixtures(days);
    if (!bucket || !Array.isArray(bucket.matches)) continue;
    bucket.matches.filter(needsAnalysis).forEach(match => queue.push({ match, days }));
  }
  queue.sort((a, b) => {
    const liveA = isLive(a.match) ? 1 : 0;
    const liveB = isLive(b.match) ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA; // live matches always first
    const timeA = a.match.utcDate ? new Date(a.match.utcDate).getTime() : Infinity;
    const timeB = b.match.utcDate ? new Date(b.match.utcDate).getTime() : Infinity;
    return timeA - timeB; // soonest kickoff next
  });

  const totalPending = queue.length;
  const thisPass = queue.slice(0, MAX_MATCHES_PER_ANALYSIS_PASS);
  if (totalPending > MAX_MATCHES_PER_ANALYSIS_PASS) {
    console.log('[scheduler] ' + totalPending + ' matches need analysis — processing the ' + MAX_MATCHES_PER_ANALYSIS_PASS + ' soonest/live this pass, rest will follow in subsequent passes');
  }

  for (const { match, days } of thisPass) {
    try {
      const live = isLive(match);
      // Head-to-head and recent form don't change mid-match, so skip that
      // fetch for live re-pricing passes — it was already captured pre-match
      // (or isn't needed) and re-fetching it here would just burn API budget
      // that's better spent getting the next live update out faster.
      const history = live ? null : await fetchMatchHistory(match);
      const odds = await ai.analyzeMatch(match, history, live ? buildLiveState(match) : null);
      await db.upsertMatchOdds(match.id, days, odds);
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
  // odds-api.io-sourced matches (prefixed "oaio_") don't have a valid
  // football-data.org match/team ID — calling getHeadToHead or
  // getTeamRecentForm with one would just burn API quota on a guaranteed
  // failure. These matches simply proceed without real history; the AI
  // prompt already handles a null history gracefully (falls back to
  // general knowledge, flags lower confidence).
  if (String(match.id).startsWith('oaio_')) return null;

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
    const interval = days === 0 ? TODAY_REFRESH_INTERVAL_MS : FIXTURE_REFRESH_INTERVAL_MS;
    if (Date.now() - last >= interval) {
      await refreshFixturesForDay(days);
    }
  }
}

function start() {
  if (running) return;
  running = true;
  console.log('[scheduler] Starting background auto-refresh + auto-analysis (no manual clicks needed)');

  // Kick off immediately on boot, then on the FASTER interval — the loop
  // itself checks each day's own due-time internally, so running the outer
  // timer every 2 min (matching TODAY_REFRESH_INTERVAL_MS) just means
  // day=0 actually gets checked often enough to matter; days 1-7 still
  // only fetch every 15 min since their own last-refresh timestamps won't
  // be due yet on most of these checks.
  fixtureRefreshLoop();
  setInterval(fixtureRefreshLoop, TODAY_REFRESH_INTERVAL_MS);

  // Give the first fixture refresh a head start before the first analysis pass.
  setTimeout(function(){
    analysisPass();
    setInterval(analysisPass, ANALYSIS_LOOP_INTERVAL_MS);
  }, 10 * 1000);
}

module.exports = { start: start };
