// scheduler.js — the "no clicking needed" background engine.
//
// Runs entirely on the server. Jobs:
//   1. Refresh fixtures from SofaBets ONLY.
//      football-data.org/odds-api.io are NOT used as a fixtures fallback —
//      disabled by explicit request. If BigFootball fails or isn't
//      configured, a cycle simply keeps whatever's already stored rather
//      than reaching for another sports provider.
//   2. SofaBets remains the authoritative source for fixture markets and
//      bookmaker odds; no other sports feed is merged into the main feed.
//   3. Analyze any fixture that doesn't have AI odds yet, or whose odds
//      are older than ANALYSIS_MAX_AGE_MS (so upcoming matches get
//      refreshed analysis as kickoff approaches, not just once).
//
// Live polling is isolated to SofaBets' dedicated live feed.

const db = require('./db');
const footballData = require('./footballData');
const footballProviders = require('./footballProviders'); // SofaBets-only football source

const FIXTURE_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // refresh future-day fixture lists every 15 min — nothing there is live/about-to-finish, so this doesn't need to be fast
const TODAY_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const LIVE_SYNC_INTERVAL_MS = 1000; // refresh SofaBets live score + bookmaker odds every 1 second  // widened from 60s: getMatchesForDate now fans out to ~12 sequential per-competition calls (see footballData.js) instead of 1, so a single refresh can take over a minute on one key alone — 60s was no longer enough headroom to reliably finish one cycle before the next was due.
const ANALYSIS_LOOP_INTERVAL_MS = 90 * 1000;         // check for unanalyzed matches every 90s
const ANALYSIS_MAX_AGE_MS = 3 * 60 * 60 * 1000;      // re-analyze if odds older than 3h (pre-match only)
const LIVE_ANALYSIS_MAX_AGE_MS = 60 * 1000;          // FAST path: if the score has changed since last analysis, re-price within this window — a goal should update odds almost immediately, like a real in-play book
const LIVE_SAFETY_REFRESH_MS = 4 * 60 * 1000;        // SLOW path: even with NO score change, still refresh at least this often — odds should drift with the clock alone (less time left = more certainty), and this is also the safety net for matches this deployment doesn't track a live clock for
// NOTE: per-match serial pacing (ANALYSIS_PACE_MS / LIVE_ANALYSIS_PACE_MS)
// was replaced by concurrent batch processing below — see CONCURRENCY and
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
    // Fixtures now come from footballProviders.js, which is SofaBets-only.
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

let lastBasketballRefresh = {}; // days -> timestamp, entirely separate tracking from football's lastFixtureRefresh

const sportRefreshInFlight = new Map();
const lastSportRefresh = new Map();

async function refreshSofaSportIfDue(sport, days) {
  const sofaBetsProvider = require('./providers/sofaBetsProvider');
  const normalizedSport = String(sport || 'football').toLowerCase();
  const sportId = sofaBetsProvider.SPORT_IDS[normalizedSport];
  if (!sportId) throw new Error('Unsupported SofaBets sport: ' + normalizedSport);
  const key = normalizedSport + ':' + String(days);
  const interval = days === 0 ? TODAY_REFRESH_INTERVAL_MS : FIXTURE_REFRESH_INTERVAL_MS;
  const last = lastSportRefresh.get(key) || 0;
  if (Date.now() - last < interval) return;
  if (sportRefreshInFlight.has(key)) return sportRefreshInFlight.get(key);

  const run = (async () => {
    const dateStr = footballData.getDateString(days);
    const matches = await sofaBetsProvider.getMatchesForDate(dateStr, { sport: normalizedSport, sportId });
    const existing = await db.getFixtures(days, normalizedSport);
    if (matches.length === 0 && existing && Array.isArray(existing.matches) && existing.matches.length > 0) {
      console.warn('[scheduler] SofaBets ' + normalizedSport + ' returned no matches for days=' + days + ' — keeping existing data');
      return;
    }
    await db.saveFixtures(days, matches, normalizedSport);
    lastSportRefresh.set(key, Date.now());
    console.log('[scheduler] Refreshed ' + matches.length + ' SofaBets ' + normalizedSport + ' fixtures for days=' + days + ' (' + dateStr + ')');
  })().finally(() => sportRefreshInFlight.delete(key));
  sportRefreshInFlight.set(key, run);
  return run;
}

// Refreshes basketball fixtures for a single day-bucket. Deliberately
// separate from refreshFixturesForDay above rather than a shared/branching
// function — basketball has no AI-analysis step, no h2h/form lookups, no
// TBD-team self-heal (odds-api.io basketball events always have named
// teams), and a different realistic carry-over window, so trying to share
// one function would mean threading sport-conditionals through logic that
// doesn't actually apply to it. Keeping football's function untouched was
// the explicit goal here.
async function refreshBasketballFixturesForDay(days) {
  const sofaBetsProvider = require('./providers/sofaBetsProvider');
  const dateStr = footballData.getDateString(days);
  try {
    const matches = await sofaBetsProvider.getMatchesForDate(dateStr, { sport: 'basketball' });
    const existing = await db.getFixtures(days, 'basketball');
    if (matches.length === 0 && existing && Array.isArray(existing.matches) && existing.matches.length > 0) {
      console.warn('[scheduler] SofaBets basketball returned no matches for days=' + days + ' — keeping existing data');
      return;
    }
    await db.saveFixtures(days, matches, 'basketball');
    lastBasketballRefresh[days] = Date.now();
    console.log('[scheduler] Refreshed ' + matches.length + ' SofaBets basketball fixtures for days=' + days + ' (' + dateStr + ')');
  } catch (e) {
    console.error('[scheduler] SofaBets basketball refresh FAILED for days=' + days + ': ' + e.message);
  }
}

// Game AI analysis has been removed from the scheduler. SofaBets is the
// sole source of live score and bookmaker odds.

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


// ── REAL-TIME SOFABETS LIVE SYNC ─────────────────────────────────────────────
// SofaBets exposes a dedicated /api/live-games feed. Poll only that small live
// feed every second instead of re-fetching the entire fixture catalogue.
// This keeps live scores and bookmaker odds moving without involving game AI.
let liveSyncInFlight = null;
let lastLiveSyncAt = 0;

function liveMatchChanged(a, b) {
  if (!a || !b) return true;
  const pick = m => ({
    status: m.status || null,
    minute: m.minute == null ? null : m.minute,
    score: m.score || null,
    odds: m.odds || null,
    providerOdds: m.providerOdds || null,
    markets: m.markets || null,
    bookmakers: m.bookmakers || null
  });
  try { return JSON.stringify(pick(a)) !== JSON.stringify(pick(b)); }
  catch (_) { return true; }
}

async function refreshLiveFootballNow() {
  if (liveSyncInFlight) return liveSyncInFlight;
  liveSyncInFlight = (async () => {
    const provider = require('./providers/sofaBetsProvider');
    try {
      const live = await provider.getLiveFootballFixtures();
      lastLiveSyncAt = Date.now();
      if (!Array.isArray(live) || !live.length) return 0;

      const bucket = await db.getFixtures(0, 'football');
      const existing = bucket && Array.isArray(bucket.matches) ? bucket.matches : [];
      const byProviderId = new Map(existing.map(m => [
        String(m.providerMatchId || String(m.id || '').replace(/^sofa_/, '')),
        m
      ]));
      const changed = [];

      for (const fresh of live) {
        const providerId = String(fresh.providerMatchId || '');
        if (!providerId) continue;
        const old = byProviderId.get(providerId);

        // Keep JuanAi's normal canonical fixture shape. The live provider
        // object uses plain team-name strings; never write that raw shape into
        // Mongo or the frontend, because the dashboard expects homeTeam.name.
        const updated = old ? Object.assign({}, old, {
          status: fresh.status || old.status,
          score: fresh.score || old.score,
          minute: fresh.minute != null ? fresh.minute : old.minute,
          minuteIsEstimated: fresh.minute != null ? false : old.minuteIsEstimated,
          odds: fresh.odds || old.odds || null,
          providerOdds: fresh.odds || old.providerOdds || old._sofaProviderOdds || null,
          _sofaProviderOdds: fresh.odds || old._sofaProviderOdds || null,
          _oddsSource: fresh.odds ? 'sofabets' : old._oddsSource,
          oddsSource: fresh.odds ? 'sofabets' : old.oddsSource,
          realOddsSource: fresh.odds ? 'SofaBets' : old.realOddsSource,
          isRealMarketOdds: fresh.odds ? true : !!old.isRealMarketOdds,
          aiGenerated: false,
          _hasProviderOdds: fresh.odds ? true : !!old._hasProviderOdds,
          _skipAiOddsGeneration: true,
          _directProviderOdds: fresh.odds ? true : !!old._directProviderOdds,
          markets: fresh.markets && fresh.markets.length ? fresh.markets : (old.markets || []),
          bookmakers: fresh.bookmakers && fresh.bookmakers.length ? fresh.bookmakers : (old.bookmakers || [])
        }) : {
          id: 'sofa_' + providerId,
          provider: 'sofabets',
          source: 'sofabets',
          primarySource: 'sofabets',
          sourceProviders: ['sofabets'],
          providerMatchId: providerId,
          homeTeam: { id: null, name: fresh.homeTeam || 'Home', crest: null },
          awayTeam: { id: null, name: fresh.awayTeam || 'Away', crest: null },
          competition: { id: null, name: fresh.competition || 'Unknown Competition', code: fresh.competition ? String(fresh.competition).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : null },
          utcDate: fresh.utcDate || null,
          status: fresh.status || 'IN_PLAY',
          score: fresh.score || { fullTime: null, halfTime: null },
          sport: 'football',
          minute: fresh.minute != null ? fresh.minute : null,
          minuteIsEstimated: fresh.minute == null,
          odds: fresh.odds || null,
          providerOdds: fresh.odds || null,
          _sofaProviderOdds: fresh.odds || null,
          _oddsSource: fresh.odds ? 'sofabets' : null,
          oddsSource: fresh.odds ? 'sofabets' : null,
          realOddsSource: fresh.odds ? 'SofaBets' : null,
          isRealMarketOdds: !!fresh.odds,
          aiGenerated: false,
          aiOdds: null,
          _hasProviderOdds: !!fresh.odds,
          _skipAiOddsGeneration: true,
          _directProviderOdds: !!fresh.odds,
          markets: fresh.markets || [],
          bookmakers: fresh.bookmakers || []
        };

        if (!old || liveMatchChanged(old, updated)) changed.push(updated);
      }

      if (changed.length) {
        await db.saveFixtures(0, changed, 'football');
      }
      return changed.length;
    } catch (e) {
      console.warn('[scheduler] SofaBets 1s live sync failed: ' + e.message);
      return 0;
    } finally {
      liveSyncInFlight = null;
    }
  })();
  return liveSyncInFlight;
}

async function liveSyncLoop() {
  if (Date.now() - lastLiveSyncAt < LIVE_SYNC_INTERVAL_MS) return;
  await refreshLiveFootballNow();
}

function start() {
  if (running) return;
  running = true;
  console.log('[scheduler] Starting background SofaBets refresh + 1s live score/odds sync.');
  console.log('[scheduler] SofaBets is the sole sports-data provider for the main fixture feed; provider bookmaker odds are authoritative.');


  // Kick off immediately on boot, then on the FASTER interval — the loop
  // itself checks each day's own due-time internally, so running the outer
  // timer every 2 min (matching TODAY_REFRESH_INTERVAL_MS) just means
  // day=0 actually gets checked often enough to matter; days 1-7 still
  // only fetch every 15 min since their own last-refresh timestamps won't
  // be due yet on most of these checks.
  fixtureRefreshLoop();
  setInterval(fixtureRefreshLoop, TODAY_REFRESH_INTERVAL_MS);
  console.log('[scheduler] Football fixture source: SofaBets only.');

  // Live score + bookmaker odds sync: SofaBets -> JuanAi -> MongoDB every 1s.
  liveSyncLoop();
  setInterval(liveSyncLoop, LIVE_SYNC_INTERVAL_MS);
  console.log('[scheduler] SofaBets LIVE score/odds sync: every 1 second.');

  // Basketball uses SofaBets sportId=4 and preserves its native markets.
  setTimeout(function(){
    basketballFixtureRefreshLoop();
    setInterval(basketballFixtureRefreshLoop, TODAY_REFRESH_INTERVAL_MS);
  }, 5 * 1000);

  // Game AI analysis is intentionally disabled. SofaBets bookmaker odds are the only prices used.\n\n  // Expiry job: deletes any match whose kickoff was more than 3 hours ago,
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

module.exports = { start: start, refreshTodayIfDue, refreshSofaSportIfDue, refreshLiveFootballNow };
