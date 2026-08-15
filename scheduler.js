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
const realOdds = require('./realOdds'); // needed directly (not just via footballData) to persist/restore odds-api.io key-pool usage state across restarts — see restoreKeyPoolState/exportKeyPoolState in realOdds.js

const FIXTURE_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // refresh future-day fixture lists every 15 min — nothing there is live/about-to-finish, so this doesn't need to be fast
const TODAY_REFRESH_INTERVAL_MS = 60 * 1000;      // TODAY's bucket refreshes every 60s (tightened from 2min) — this controls how quickly a match flips from SCHEDULED to IN_PLAY once it actually kicks off. Still comfortably within football-data.org's 10 req/min budget (just today's single bucket, not all 8), and odds-api.io's shared cached /events response means this doesn't cost extra calls there either.
const ANALYSIS_LOOP_INTERVAL_MS = 90 * 1000;         // check for unanalyzed matches every 90s
const ANALYSIS_MAX_AGE_MS = 3 * 60 * 60 * 1000;      // re-analyze if odds older than 3h (pre-match only)
const LIVE_ANALYSIS_MAX_AGE_MS = 60 * 1000;          // FAST path: if the score has changed since last analysis, re-price within this window — a goal should update odds almost immediately, like a real in-play book
const LIVE_SAFETY_REFRESH_MS = 4 * 60 * 1000;        // SLOW path: even with NO score change, still refresh at least this often — odds should drift with the clock alone (less time left = more certainty), and this is also the safety net for matches this deployment doesn't track a live clock for
// NOTE: per-match serial pacing (ANALYSIS_PACE_MS / LIVE_ANALYSIS_PACE_MS)
// was replaced by concurrent batch processing below — see CONCURRENCY and
// BATCH_GAP_MS inside analysisPassInner. Serializing every single match
// behind a fixed delay meant total throughput was capped by that delay
// alone, never by actual AI capacity — so adding more keys couldn't help,
// since nothing was ever using more than one key at a time to begin with.
const EXPIRY_CHECK_INTERVAL_MS = 2 * 60 * 1000;      // how often to delete FINISHED matches immediately + anything stuck past the 3h cutoff — shortened from 5min so finished matches disappear from the app/API promptly
const DAY_BUCKETS = [0, 1, 2]; // today, tomorrow, day after — reduced from 8 days. With real AI capacity tested at ~4 matches/min sustainable (11 keys across Gemini+Groq, each recovering every 1-2 min), 8 days of even a league-narrowed fixture list produced 1,376+ pending matches — a backlog that would take 5+ hours to clear even in ideal conditions, meaning almost everything sat AI-pending indefinitely. 3 days keeps total volume small enough to realistically stay fully analyzed rather than perpetually behind. If you want more lookahead later, the AI capacity needs to grow first (more genuinely separate accounts, or a paid tier) — otherwise more days just means a bigger permanent backlog, not more useful coverage.

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

let lastBasketballRefresh = {}; // days -> timestamp, entirely separate tracking from football's lastFixtureRefresh

// Refreshes basketball fixtures for a single day-bucket. Deliberately
// separate from refreshFixturesForDay above rather than a shared/branching
// function — basketball has no AI-analysis step, no h2h/form lookups, no
// TBD-team self-heal (odds-api.io basketball events always have named
// teams), and a different realistic carry-over window, so trying to share
// one function would mean threading sport-conditionals through logic that
// doesn't actually apply to it. Keeping football's function untouched was
// the explicit goal here.
async function refreshBasketballFixturesForDay(days) {
  const basketballData = require('./basketballData');
  const dateStr = basketballData.getDateString(days);
  try {
    const matches = await basketballData.getBasketballMatchesForDate(dateStr, days === 0);
    const existing = await db.getFixtures(days, 'basketball');

    // Same "don't wipe good data on a temporary empty fetch" protection as
    // football's version — see the matching comment above for the reasoning.
    if (matches.length === 0 && existing && Array.isArray(existing.matches) && existing.matches.length > 0) {
      console.warn('[scheduler] Basketball fixture source returned nothing for days=' + days + ' (' + dateStr + ') — keeping ' + existing.matches.length + ' existing fixtures rather than wiping them');
      return;
    }

    await db.saveFixtures(days, matches, 'basketball');
    lastBasketballRefresh[days] = Date.now();
    console.log('[scheduler] Refreshed ' + matches.length + ' real basketball fixtures for days=' + days + ' (' + dateStr + ')');
  } catch (e) {
    console.error('[scheduler] Basketball fixture refresh FAILED for days=' + days + ': ' + e.message);
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

  if (!isLive(match)) {
    return (Date.now() - match.aiAnalyzedAt) > ANALYSIS_MAX_AGE_MS;
  }

  // REAL FIX for "too many live matches to keep up with": re-analyzing
  // EVERY live match every 60s regardless of whether anything actually
  // happened was spending the same limited AI budget on a scoreless,
  // unchanged 0-0 match as on one where a goal just went in. With 100+
  // matches live at once, that's a lot of wasted calls on matches where
  // nothing changed, crowding out matches that genuinely need a fresh
  // price. Now: a real score change gets the fast refresh (near
  // real-time); an unchanged score only gets refreshed on the slower
  // safety-net interval, freeing up capacity for whatever actually moved.
  const scoreChanged = match.aiAnalyzedAtScore != null && match.aiAnalyzedAtScore !== describeGoalsOnly(match);
  const age = Date.now() - match.aiAnalyzedAt;
  if (scoreChanged) return age > 5000; // near-instant — a tiny debounce only, not a real gate
  return age > LIVE_SAFETY_REFRESH_MS;
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
const MAX_MATCHES_PER_ANALYSIS_PASS = 14; // raised from 6 — that number was tuned for 11 total AI keys; the pool has since grown to 23 combined (16 Gemini + 7 Groq), and /api/status showed ALL of them healthy with zero blocked while coverage was still crawling (59/1370 analyzed). 14 is a deliberately moderate ~2.3x increase, not a jump to what 23 keys might theoretically sustain — raise further only after confirming this doesn't reintroduce the mass-blocking bursts seen at higher rates before.
const MAX_LIVE_MATCHES_PER_PASS = 60; // raised from 25 — that "generous safety ceiling... should never realistically be hit" WAS being hit (49 live matches observed in production, above the old cap of 25), silently truncating live re-pricing coverage every single pass. 60 leaves real headroom above what's actually been observed.

// RE-ENTRANCY GUARD: setInterval fires on a fixed schedule regardless of
// whether the PREVIOUS analysisPass() call has actually finished yet. Even
// with concurrent batch processing (CONCURRENCY matches at once, see
// analysisPassInner below), a busy period with live matches near the
// MAX_LIVE_MATCHES_PER_PASS ceiling can still take longer than the
// 90-second interval between scheduled triggers. Without this guard, a new
// pass could start while a previous one was still mid-flight, running TWO
// OR MORE analysis loops concurrently, each independently hitting the same
// shared AI
// (Gemini/Groq) and real-odds (odds-api.io) key pools — multiplying actual
// call volume well beyond what the pacing constants were designed for,
// and a very plausible root cause of "entire key pool blocked" errors
// appearing despite the pacing looking conservative on paper.
let analysisPassRunning = false;

async function analysisPass() {
  if (analysisPassRunning) {
    console.log('[scheduler] Skipping this analysisPass trigger — a previous pass is still running (prevents overlapping concurrent passes from multiplying API call volume)');
    return;
  }
  analysisPassRunning = true;
  try {
    await analysisPassInner();
  } finally {
    analysisPassRunning = false;
  }
}

async function analysisPassInner() {
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
  // Live matches are NEVER capped — they always get processed this pass,
  // regardless of MAX_MATCHES_PER_ANALYSIS_PASS. Only the non-live backlog
  // catch-up respects the cap. This guarantees a live match never gets
  // skipped/delayed just because there's a large backlog of pre-match
  // fixtures competing for the same pass — the exact "missing live games"
  // symptom this fixes.
  const liveMatches = queue.filter(q => isLive(q.match)).slice(0, MAX_LIVE_MATCHES_PER_PASS);
  const nonLiveMatches = queue.filter(q => !isLive(q.match));
  const thisPass = liveMatches.concat(nonLiveMatches.slice(0, MAX_MATCHES_PER_ANALYSIS_PASS));
  if (totalPending > thisPass.length) {
    console.log('[scheduler] ' + totalPending + ' matches need analysis (' + liveMatches.length + ' live, processed uncapped) — processing ' + Math.min(nonLiveMatches.length, MAX_MATCHES_PER_ANALYSIS_PASS) + ' non-live this pass, rest will follow in subsequent passes');
  }

  // REAL FIX for "analyzing fewer games than before, even with more API
  // keys added": matches were being processed one at a time in a strict
  // serial line, with an artificial delay between EACH one, regardless of
  // how many AI keys were sitting idle. That made total throughput capped
  // by the pacing delay alone, not by actual AI capacity — adding more keys
  // couldn't help, because nothing was ever calling more than one key at a
  // time in the first place. With 90 live matches needing re-analysis every
  // 60s, a strictly serial line (even at a fast per-match pace) takes
  // several minutes to cycle through — by the time it loops back around,
  // most matches are stale again, so the same matches dominate every pass
  // while the rest of the backlog barely moves. Processing in small
  // concurrent batches actually uses the key pool the way it was meant to
  // be used — each concurrent request naturally picks its own available key
  // via the existing round-robin picker in ai.js.
  const CONCURRENCY = 3; // pulled back from 6 — production logs after deploying 6 showed the entire Gemini+Groq pool going fully blocked again within minutes, the same failure pattern seen at LIVE_ANALYSIS_PACE_MS=2500 before. This confirms the real ceiling here isn't about serial-vs-concurrent processing alone — the providers' actual sustainable burst rate is lower than 6 simultaneous requests, regardless of total key count. 3 is a more conservative step up from strictly-serial (1); if the pool still goes dark at this level, the next real lever is spacing BATCH_GAP_MS out further, not raising concurrency again.
  const BATCH_GAP_MS = 3000; // raised from 1500 alongside the concurrency pullback — more breathing room between waves of requests.

  for (let i = 0; i < thisPass.length; i += CONCURRENCY) {
    const batch = thisPass.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ match, days }) => {
      const live = isLive(match);
      try {
        // Head-to-head and recent form don't change mid-match, so skip that
        // fetch for live re-pricing passes — it was already captured
        // pre-match (or isn't needed) and re-fetching it here would just
        // burn API budget that's better spent getting the next live update
        // out faster.
        const history = live ? null : await fetchMatchHistory(match);
        const odds = await ai.analyzeMatch(match, history, live ? buildLiveState(match) : null);
        await db.upsertMatchOdds(match.id, days, odds, describeGoalsOnly(match));
        var home = match.homeTeam && match.homeTeam.name;
        var away = match.awayTeam && match.awayTeam.name;
        console.log('[scheduler] Analyzed match ' + match.id + ' (' + home + ' vs ' + away + ') for days=' + days
          + (live ? ' [LIVE re-price, score ' + describeScore(match) + ']' : (history ? ' [with real history]' : ' [no history available]')));
      } catch (e) {
        console.error('[scheduler] Analysis FAILED for match ' + match.id + ': ' + e.message);
        // Leave this match without odds rather than faking a result. One
        // match failing inside Promise.all does NOT block or cancel the
        // rest of the batch — each has its own try/catch.
      }
    }));
    if (i + CONCURRENCY < thisPass.length) {
      await new Promise(function(r){ setTimeout(r, BATCH_GAP_MS); });
    }
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

// Goals-only, deliberately WITHOUT the minute — used specifically for
// score-change detection in needsAnalysis(). describeScore() above
// includes the minute for human-readable log lines, but the minute changes
// on nearly every poll regardless of whether a goal happened, which would
// make a "has the score changed" comparison against it true almost every
// single time — silently defeating the entire point of the optimization.
function describeGoalsOnly(match) {
  const s = buildLiveState(match);
  return (s.homeGoals != null ? s.homeGoals : '?') + '-' + (s.awayGoals != null ? s.awayGoals : '?');
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

// Same today/future-days pacing pattern as football's loop, running against
// lastBasketballRefresh instead so the two sports' refresh timers never
// interfere with each other.
async function basketballFixtureRefreshLoop() {
  for (const days of DAY_BUCKETS) {
    const last = lastBasketballRefresh[days] || 0;
    const interval = days === 0 ? TODAY_REFRESH_INTERVAL_MS : FIXTURE_REFRESH_INTERVAL_MS;
    if (Date.now() - last >= interval) {
      await refreshBasketballFixturesForDay(days);
    }
  }
}

function start() {
  if (running) return;
  running = true;
  console.log('[scheduler] Starting background auto-refresh + auto-analysis (no manual clicks needed)');

  // REAL FIX for "all 11 odds-api.io keys hit their daily limit at the same
  // moment, on a day with unusually many restarts": the app's own tracking
  // of how much of each key's daily/hourly budget was already used lived
  // ONLY in memory, so every restart reset it to zero — while the
  // PROVIDER's real, server-side count did NOT reset, since that only
  // happens at midnight UTC regardless of how many times our app restarts.
  // A day with many restarts (redeploys, Render's free-tier spin-down/
  // cold-start cycle) let the app keep confidently using keys it THOUGHT
  // had room, until the real count finally caught up across the board.
  // Restoring this once at boot, then saving it periodically below, closes
  // that gap — a restart no longer blinds the app to budget it's already
  // spent today.
  db.getSetting('oddsApiIoKeyPoolState')
    .then(saved => realOdds.restoreKeyPoolState(saved))
    .catch(e => console.error('[scheduler] Failed to restore odds-api.io key pool state (starting fresh, same as before this fix): ' + e.message));
  setInterval(function () {
    db.setSetting('oddsApiIoKeyPoolState', realOdds.exportKeyPoolState())
      .catch(e => console.error('[scheduler] Failed to persist odds-api.io key pool state: ' + e.message));
  }, 60 * 1000); // frequent enough that even an unexpected crash (not just a clean restart) loses at most ~1 minute of usage-tracking accuracy

  // Kick off immediately on boot, then on the FASTER interval — the loop
  // itself checks each day's own due-time internally, so running the outer
  // timer every 2 min (matching TODAY_REFRESH_INTERVAL_MS) just means
  // day=0 actually gets checked often enough to matter; days 1-7 still
  // only fetch every 15 min since their own last-refresh timestamps won't
  // be due yet on most of these checks.
  fixtureRefreshLoop();
  setInterval(fixtureRefreshLoop, TODAY_REFRESH_INTERVAL_MS);

  // Basketball: DISABLED — odds-api.io is rejecting sport=nba with "Invalid
  // sport slug" for this account (confirmed in production logs, not a code
  // bug — likely the plan doesn't include basketball access, or the
  // provider's accepted slug value changed). Since every cycle just fails
  // anyway, there's no point spending a request on it every 60s; turned off
  // at the source instead of leaving it to fail loudly forever. Re-enable
  // by uncommenting below once the odds-api.io account/slug issue is
  // resolved on their end.
  //
  // setTimeout(function(){
  //   basketballFixtureRefreshLoop();
  //   setInterval(basketballFixtureRefreshLoop, TODAY_REFRESH_INTERVAL_MS);
  // }, 5 * 1000);

  // Give the first fixture refresh a head start before the first analysis pass.
  setTimeout(function(){
    analysisPass();
    setInterval(analysisPass, ANALYSIS_LOOP_INTERVAL_MS);
  }, 10 * 1000);

  // Expiry job: deletes any match whose kickoff was more than 3 hours ago,
  // regardless of what status any source reports — this is what actually
  // stops a match from being stuck showing as live/pending forever if
  // odds-api.io never marks it "settled" in our data. Runs every 5 min;
  // cheap since it's a single deleteMany with no external API calls.
  //
  // Also runs deduplication right after — cleans up matches that exist
  // twice under different match IDs (e.g. Spain vs Belgium appearing
  // separately from football-data.org's "FIFA World Cup" and odds-api.io's
  // "International - FIFA World Cup", which the merge-time dedup didn't
  // catch before the fix in footballData.js). This self-heals any
  // duplicates already sitting in the database from before that fix.
  setInterval(async function(){
    try {
      const deleted = await db.expireOldMatches();
      if (deleted > 0) console.log('[scheduler] Expired ' + deleted + ' match(es) older than 3 hours — removed from database entirely');
    } catch (e) {
      console.error('[scheduler] expireOldMatches failed: ' + e.message);
    }
    try {
      const deduped = await db.deduplicateExistingMatches();
      if (deduped > 0) console.log('[scheduler] Removed ' + deduped + ' duplicate match(es) (same teams, same kickoff window, different source)');
    } catch (e) {
      console.error('[scheduler] deduplicateExistingMatches failed: ' + e.message);
    }
  }, EXPIRY_CHECK_INTERVAL_MS);
}

// Callable on-demand from server.js's /api/fixtures route, for days=0
// (today) specifically — this is what makes live match data feel
// genuinely real-time instead of only ever updating on the fixed
// setInterval tick. Without this, a request arriving right after a
// refresh could still wait up to TODAY_REFRESH_INTERVAL_MS for the next
// scheduled tick even though the data IS due for a refresh — there was no
// way for an incoming request to "poke" the scheduler early. This reuses
// the exact same due-time check (Date.now() - last >= interval) as the
// timer-driven loop, so it can never over-fetch beyond what the rate
// limit already allows — it just means the FIRST request after a refresh
// becomes due triggers it immediately, rather than that request getting
// stale data and a later, unrelated timer tick eventually catching up.
// Guards against multiple concurrent requests all seeing "a refresh is
// due" at the same instant and each independently kicking one off — only
// the first one actually fetches; the rest just wait for it (or move on
// immediately once it's known to already be in flight).
let todayRefreshInFlight = null;

async function refreshTodayIfDue() {
  const last = lastFixtureRefresh[0] || 0;
  if (Date.now() - last >= TODAY_REFRESH_INTERVAL_MS) {
    if (!todayRefreshInFlight) {
      todayRefreshInFlight = refreshFixturesForDay(0).finally(() => { todayRefreshInFlight = null; });
    }
    await todayRefreshInFlight;
  }
}

module.exports = { start: start, refreshTodayIfDue };
