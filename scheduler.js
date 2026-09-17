// scheduler.js — the "no clicking needed" background engine.
//
// Runs entirely on the server. Jobs:
//   1. Refresh fixtures from BigFootball ONLY (see bigFootballData.js).
//      football-data.org/odds-api.io are NOT used as a fixtures fallback —
//      disabled by explicit request. If BigFootball fails or isn't
//      configured, a cycle simply keeps whatever's already stored rather
//      than reaching for the legacy source.
//   2. When BigFootball is configured: enrich already-live matches with
//      real events (goals/cards/subs) and odds on a fast interval (see
//      enrichLiveMatches below) — separate from AI analysis entirely.
//   3. Analyze any fixture that doesn't have AI odds yet, or whose odds
//      are older than ANALYSIS_MAX_AGE_MS (so upcoming matches get
//      refreshed analysis as kickoff approaches, not just once).
//
// Paced conservatively to respect BigFootball's free-tier rate limits
// (bigFootballData.js throttles its own calls) and to avoid hammering the
// AI providers.

const db = require('./db');
const footballData = require('./footballData');
const bigFootballData = require('./bigFootballData'); // still used directly for live events/odds enrichment (per-match endpoints), and by the h2h/team-form helpers — fixture fetching itself now goes through footballProviders.js
const footballProviders = require('./footballProviders'); // orchestrates all 7 providers (priority cascade + dedup) — see footballProviders.js for the full priority order and cascade rule
const realOdds = require('./realOdds'); // needed directly (not just via footballData) to persist/restore odds-api.io key-pool usage state across restarts — see restoreKeyPoolState/exportKeyPoolState in realOdds.js

const FIXTURE_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // refresh future-day fixture lists every 15 min — nothing there is live/about-to-finish, so this doesn't need to be fast
const TODAY_REFRESH_INTERVAL_MS = 3 * 60 * 1000;  // widened from 60s: getMatchesForDate now fans out to ~12 sequential per-competition calls (see footballData.js) instead of 1, so a single refresh can take over a minute on one key alone — 60s was no longer enough headroom to reliably finish one cycle before the next was due.
const LIVE_SAFETY_REFRESH_MS = 4 * 60 * 1000;        // SLOW path: even with NO score change, still refresh at least this often — odds should drift with the clock alone (less time left = more certainty), and this is also the safety net for matches this deployment doesn't track a live clock for
// NOTE: per-match serial pacing (ANALYSIS_PACE_MS / LIVE_ANALYSIS_PACE_MS)
// was replaced by concurrent batch processing below — see CONCURRENCY and
// BATCH_GAP_MS inside analysisPassInner. Serializing every single match
// behind a fixed delay meant total throughput was capped by that delay
// alone, never by actual AI capacity — so adding more keys couldn't help,
// since nothing was ever using more than one key at a time to begin with.
const EXPIRY_CHECK_INTERVAL_MS = 2 * 60 * 1000;      // how often to delete FINISHED matches immediately + anything stuck past the 3h cutoff — shortened from 5min so finished matches disappear from the app/API promptly
const FOOTBALL_DAY_BUCKETS = [0, 1, 2, 3, 4, 5, 6]; // today through 6 days ahead — one full week.
// Previously capped at [0,1,2] because football-data.org's much larger
// catalogue produced 1,376+ pending matches over 8 days — a backlog the AI
// analysis pipeline (≈4 matches/min sustainable) couldn't realistically
// clear. That constraint no longer applies: BigFootball only covers 8
// leagues (~30 matches/day, confirmed via /v1/leagues), so a full week is
// roughly ~200 matches total — comfortably clearable in under an hour of
// AI capacity, not a permanent backlog. If BigFootball's league coverage
// ever grows substantially, revisit this the same way.
const BASKETBALL_DAY_BUCKETS = [0, 1, 2]; // unrelated to the football week-lookahead change above — basketballData.js has its own separate API/budget, deliberately left untouched

let running = false;
let lastFixtureRefresh = {}; // days -> timestamp

function isLive(match) {
  return match.status === 'IN_PLAY' || match.status === 'PAUSED';
}

// Strips BigFootball's raw source payload (see bigFootballData.js
// normalizeMatch's `raw` field) before anything gets written to Mongo or
// served to the frontend/BetaKE — it's only there to help debug field
// mapping via /internal/bigfootball/test, which calls bigFootballData.js
// directly and never goes through this stripping step. Keeps stored
// documents and API responses the same shape/size as before BigFootball
// was added, per "keep the existing frontend/API response format".
function stripRawForStorage(matches) {
  return matches.map(m => {
    if (!m || !('raw' in m)) return m;
    const copy = Object.assign({}, m);
    delete copy.raw;
    return copy;
  });
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
    // Fixtures now come from footballProviders.js — the 7-provider
    // priority cascade (BigBallsData → API-Football → football-data.org →
    // Sportmonks → TheSportsDB → Highlightly → API-Sports). It internally
    // decides which provider(s) actually get called; this function no
    // longer needs to know that detail, just the result.
    const result = await footballProviders.getMatchesForDate(dateStr, { fullCatalogue: days === 0 });
    const matches = result.matches;
    const anyProviderSucceeded = result.anyProviderSucceeded;
    if (result.primaryProviderUsed) {
      console.log('[scheduler] days=' + days + ' (' + dateStr + '): using ' + result.primaryProviderUsed + ' — ' + result.providerLog.map(l => l.provider + ': ' + l.result).join(' | '));
    }

    // A provider genuinely succeeding with zero matches for the date is a
    // trustworthy "no matches today" signal (unlike every provider
    // failing/being unconfigured) — handled separately from the "keep
    // existing data" safety net below, and clears the bucket instead of
    // preserving stale matches.
    if (matches.length === 0 && anyProviderSucceeded) {
      await db.saveFixtures(days, []);
      const pruned = await db.pruneMatchesNotIn(days, 'football', []);
      lastFixtureRefresh[days] = Date.now();
      console.log('[scheduler] All providers returned 0 matches for days=' + days + ' (' + dateStr + ') — treating as authoritative, bucket cleared' + (pruned ? ' (' + pruned + ' stale match(es) removed)' : ''));
      return;
    }

    const existing = await db.getFixtures(days);

    // If every provider failed/was unconfigured this cycle, don't
    // overwrite whatever fixtures we already have with an empty list —
    // keep showing slightly-stale-but-real data rather than wiping the
    // board over a transient outage.
    if (matches.length === 0 && existing && Array.isArray(existing.matches) && existing.matches.length > 0) {
      console.warn('[scheduler] All providers failed/unconfigured for days=' + days + ' (' + dateStr + ') — keeping ' + existing.matches.length + ' existing fixtures rather than wiping them');
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
    await db.saveFixtures(days, stripRawForStorage(matches));
    lastFixtureRefresh[days] = Date.now();

    // Now that a provider has returned a complete, authoritative list for
    // this bucket, remove anything left over that ISN'T in that list —
    // this is what clears out stale matches from a previous cycle that
    // used a different (lower-priority) provider, or leftovers from
    // before this whole multi-provider system existed. Only runs when a
    // provider actually succeeded this cycle — never prunes based on a
    // fully-failed cycle, since matches is empty in that case for the
    // wrong reason (see the "keep existing" branch above).
    if (anyProviderSucceeded) {
      const pruned = await db.pruneMatchesNotIn(days, 'football', matches.map(m => m.id));
      if (pruned > 0) console.log('[scheduler] Pruned ' + pruned + ' stale match(es) from days=' + days + ' now that ' + (result.primaryProviderUsed || 'a provider') + ' is authoritative for this cycle');
    }

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

    console.log('[scheduler] Refreshed ' + matches.length + ' real fixtures for days=' + days + ' (' + dateStr + ') via ' + (result.primaryProviderUsed || 'no provider (all failed/unconfigured)'));

    // Temporary diagnostic line, requested explicitly to trace the
    // fetch->storage pipeline for today's bucket without needing to hit
    // an admin endpoint separately. Safe to remove once the pipeline is
    // confirmed healthy end to end.
    if (days === 0) {
      const liveCount = matches.filter(isLive).length;
      const analyzedCount = matches.filter(m => !!m.aiOdds).length;
      console.log('[scheduler] DATA SOURCE: ' + (result.primaryProviderUsed || 'NONE (all providers failed this cycle — kept existing data)') + ' | matches received: ' + matches.length + ' | live matches: ' + liveCount + ' | analyzed matches: ' + analyzedCount + ' | last API update: ' + new Date().toISOString());
    }
  } catch (e) {
    // Real failure — log it, do NOT substitute fake fixtures.
    console.error('[scheduler] Fixture refresh FAILED for days=' + days + ': ' + e.message);
  }
}

// ── BigFootball live enrichment: events + odds for matches in progress ──
//
// Runs independently of the fixture refresh above, on a much shorter
// interval, and ONLY touches matches already sitting in today's bucket as
// IN_PLAY/PAUSED — never a full re-fetch of the day's fixture list. This is
// what actually updates goals/cards/subs (via /v1/matches/{id}/events) and
// in-play prices (via /v1/matches/{id}/odds) while a match is live, per
// BigFootball's per-match endpoints.
//
// Deliberately writes to bigFootballEvents/bigFootballOdds ONLY (see
// db.upsertBigFootballLiveData) — never aiOdds/aiPrediction/etc, so this
// can run freely without any risk of touching the AI-priced odds actually
// used for settlement.
const BIGFOOTBALL_LIVE_ENRICH_INTERVAL_MS = 25 * 1000; // matched to bigFootballData.js's EVENTS_LIVE cache TTL — no point polling faster than the cache itself refreshes
let liveEnrichInFlight = false;

async function enrichLiveMatches() {
  if (!bigFootballData.isConfigured() || liveEnrichInFlight) return;
  liveEnrichInFlight = true;
  try {
    const bucket = await db.getFixtures(0, 'football'); // "live" only ever matters for today's bucket
    if (!bucket || !Array.isArray(bucket.matches)) return;
    // primarySource, not the old m.source==='bigfootball' check — matches
    // now carry a canonical id (see footballProviders.js/lib/canonicalMatch.js),
    // and only BigBallsData-sourced matches have a providerMatchId that
    // BigFootball's own per-match endpoints will recognize.
    const live = bucket.matches.filter(m => (m.status === 'IN_PLAY' || m.status === 'PAUSED') && m.primarySource === 'bigballsdata' && m.providerMatchId);
    if (!live.length) return;

    // Sequential, not Promise.all — this naturally paces requests against
    // BigFootball's own rate limiter (bigFootballData.js already enforces
    // 100/min, 90/min safety margin) instead of bursting one request pair
    // per live match all at once, which could otherwise spike well past
    // the per-minute cap on a day with many simultaneous live matches.
    for (const m of live) {
      try {
        const [events, odds] = await Promise.all([
          bigFootballData.getMatchEvents(m.providerMatchId),
          bigFootballData.getMatchOdds(m.providerMatchId)
        ]);
        // Stored keyed by the CANONICAL id (m.id) — that's what db.js's
        // matchId field uses everywhere else now, so lookups by canonical
        // id (e.g. server.js's on-demand routes) find this data correctly.
        await db.upsertBigFootballLiveData(m.id, 0, 'football', events, odds);
      } catch (e) {
        console.error('[scheduler] BigFootball live enrichment failed for match ' + m.id + ' (provider id ' + m.providerMatchId + '): ' + e.message);
      }
    }
  } catch (e) {
    console.error('[scheduler] enrichLiveMatches failed: ' + e.message);
  } finally {
    liveEnrichInFlight = false;
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

// AI GAME ANALYSIS DISABLED.
// JuanAi never sends fixtures to Gemini/Groq or generates/reprices game odds.
// SofaBets/provider data is used as supplied; fixtureRefreshLoop only refreshes data.
// The separate AI chat/admin features in server.js are unrelated to game analysis.

let fixtureRefreshLoopInFlight = false;
async function fixtureRefreshLoop() {
  if (fixtureRefreshLoopInFlight) return; // previous cycle (now potentially ~12 calls per day bucket) still running — never overlap
  fixtureRefreshLoopInFlight = true;
  try {
    for (const days of FOOTBALL_DAY_BUCKETS) {
      const last = lastFixtureRefresh[days] || 0;
      const interval = days === 0 ? TODAY_REFRESH_INTERVAL_MS : FIXTURE_REFRESH_INTERVAL_MS;
      if (Date.now() - last >= interval) {
        await refreshFixturesForDay(days);
      }
    }
  } finally {
    fixtureRefreshLoopInFlight = false;
  }
}

// Same today/future-days pacing pattern as football's loop, running against
// lastBasketballRefresh instead so the two sports' refresh timers never
// interfere with each other.
async function basketballFixtureRefreshLoop() {
  for (const days of BASKETBALL_DAY_BUCKETS) {
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
  console.log('[scheduler] Starting background auto-refresh (game AI analysis disabled) (no manual clicks needed)');
  console.log('[scheduler] Running in football-data.org-only mode — odds-api.io is disabled (see comment in footballData.js getOddsApiIoMatchesForDate). Real live scores/minutes for ~12 major leagues; all odds are AI-estimated. This is intentional, not an error.');

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

  const providerNames = footballProviders.PROVIDER_NAMES.join(', ');
  console.log('[scheduler] Football providers in priority order: ' + providerNames + '. Fixtures pull from the first CONFIGURED provider that has data for a given date — see footballProviders.js.');

  if (bigFootballData.isConfigured()) {
    // Live-match event/odds enrichment is BigBallsData-specific (its own
    // per-match endpoints) — still gated on it directly here, since the
    // other 6 providers don't have an equivalent wired up yet.
    enrichLiveMatches();
    setInterval(enrichLiveMatches, BIGFOOTBALL_LIVE_ENRICH_INTERVAL_MS);
  } else {
    console.warn('[scheduler] BIGBALLSDATA_KEYS is not set — live match events/odds enrichment disabled (fixtures themselves may still come from another configured provider in the cascade).');
  }

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
  // Game analysis is intentionally disabled. No analysisPass is scheduled.

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
