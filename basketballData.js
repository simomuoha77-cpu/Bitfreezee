// basketballData.js — real basketball fixtures + odds from odds-api.io.
//
// WHY A SEPARATE FILE FROM footballData.js: basketball is structurally
// different enough (4 quarters instead of 2 halves, no draw outcome, no
// stoppage/injury time, different realistic game-length ceiling) that
// bolting it onto football's file would mean sport-specific branches
// scattered through code that's already carrying a lot of football-only
// nuance (half-time detection, kickoff-delay buffer, stoppage-time cap,
// etc). Keeping it separate means football's logic — already carefully
// tuned against real production bugs — stays completely untouched.
//
// NO AI DEPENDENCY BY DESIGN: this module only surfaces matches that
// odds-api.io has REAL bookmaker odds for (see getRealOddsForMatch in
// realOdds.js). If a basketball match has no real odds available, it's
// simply not included here rather than falling through to AI-generated
// estimates — the explicit goal (per user request) was adding a sport
// without adding any new load to the AI-analysis queue/backlog that
// football already strains against. If real-odds coverage turns out to be
// too sparse in practice, that's a reason to revisit, not a reason to
// silently start estimating.

const realOdds = require('./realOdds');

const ODDSAPIIO_SPORT_SLUG = 'nba'; // odds-api.io's own docs example uses `sport=nba` for the /events endpoint — confirmed against their published NBA odds example response shape

// Realistic real-time ceiling for an NBA/basketball game: 4x 12-minute
// quarters + 3 breaks (~2 min each between Q1-Q2/Q3-Q4, ~15 min halftime)
// + overtime allowance. Real games essentially never run past ~150 real
// minutes from tip-off including all breaks and a couple of OT periods.
// Used the same way football's REALISTIC_MAX_LIVE_MIN is used: anything
// odds-api.io still shows as unsettled past this point is treated as
// finished rather than left live with a frozen/stale clock.
const REALISTIC_MAX_LIVE_MIN = 150;

// Basketball quarter structure, used for the same kind of estimate
// football-data.js does for football — NOT a real game clock (odds-api.io
// doesn't provide one, confirmed against their documented event/odds
// response shape: only `status` and a final `scores` object, no live
// clock/period field for any sport). This estimate is deliberately
// approximate and flagged as such via minuteIsEstimated, same convention
// as football.
const QUARTER_MIN = 12;
const BREAK_BETWEEN_QUARTERS_MIN = 2;
const HALFTIME_BREAK_MIN = 15;
// Same kickoff-delay-buffer reasoning as football's estimateMatchMinute:
// real tip-off tends to run a few minutes after the officially listed
// start time (warm-ups, broadcast delays), so elapsed time from the raw
// listed start time alone tends to overstate the real game clock.
const TIPOFF_DELAY_BUFFER_MIN = 5; // shorter than football's 8 — pregame warcmup/broadcast overhead tends to be less variable for indoor arena sports on a fixed broadcast slot

// Returns { quarter, minuteInQuarter, isBreak, displayMinute } estimated
// from tip-off time, or null if the game hasn't started yet.
function estimateBasketballClock(tipoffIso) {
  if (!tipoffIso) return null;
  const rawElapsedMin = Math.floor((Date.now() - new Date(tipoffIso).getTime()) / 60000);
  if (rawElapsedMin < 0) return null;
  const elapsedMin = Math.max(0, rawElapsedMin - TIPOFF_DELAY_BUFFER_MIN);

  const Q1_END = QUARTER_MIN;
  const BREAK1_END = Q1_END + BREAK_BETWEEN_QUARTERS_MIN;
  const Q2_END = BREAK1_END + QUARTER_MIN;
  const HALFTIME_END = Q2_END + HALFTIME_BREAK_MIN;
  const Q3_END = HALFTIME_END + QUARTER_MIN;
  const BREAK3_END = Q3_END + BREAK_BETWEEN_QUARTERS_MIN;
  const Q4_END = BREAK3_END + QUARTER_MIN;

  if (elapsedMin <= Q1_END) return { quarter: 1, minuteInQuarter: elapsedMin, isBreak: false, displayMinute: elapsedMin };
  if (elapsedMin <= BREAK1_END) return { quarter: 1, minuteInQuarter: QUARTER_MIN, isBreak: true, displayMinute: QUARTER_MIN };
  if (elapsedMin <= Q2_END) return { quarter: 2, minuteInQuarter: elapsedMin - BREAK1_END, isBreak: false, displayMinute: elapsedMin - BREAK_BETWEEN_QUARTERS_MIN };
  if (elapsedMin <= HALFTIME_END) return { quarter: 2, minuteInQuarter: QUARTER_MIN, isBreak: true, displayMinute: Q2_END - BREAK_BETWEEN_QUARTERS_MIN };
  if (elapsedMin <= Q3_END) return { quarter: 3, minuteInQuarter: elapsedMin - HALFTIME_END, isBreak: false, displayMinute: (elapsedMin - HALFTIME_END) + (Q2_END - BREAK_BETWEEN_QUARTERS_MIN) };
  if (elapsedMin <= BREAK3_END) return { quarter: 3, minuteInQuarter: QUARTER_MIN, isBreak: true, displayMinute: (Q3_END - HALFTIME_END) + (Q2_END - BREAK_BETWEEN_QUARTERS_MIN) };
  if (elapsedMin <= Q4_END) {
    const q4Elapsed = elapsedMin - BREAK3_END;
    return { quarter: 4, minuteInQuarter: q4Elapsed, isBreak: false, displayMinute: q4Elapsed + (Q3_END - HALFTIME_END) + (Q2_END - BREAK_BETWEEN_QUARTERS_MIN) };
  }
  // Past regulation — cap here rather than guessing at overtime structure
  // (OT length/count varies by league and isn't worth estimating blindly).
  const cappedFinalMinute = (Q4_END - BREAK3_END) + (Q3_END - HALFTIME_END) + (Q2_END - BREAK_BETWEEN_QUARTERS_MIN);
  return { quarter: 4, minuteInQuarter: QUARTER_MIN, isBreak: false, displayMinute: cappedFinalMinute };
}

// Converts an odds-api.io basketball event into a shape consistent with
// footballData.js's match objects (same field names where the concept
// applies) so the rest of the pipeline — db.js, server.js's /api/fixtures
// — doesn't need sport-specific branches to handle it, EXCEPT it never
// carries aiOdds fields, since basketball skips AI analysis by design.
function convertOddsApiIoBasketballEvent(e) {
  let status = 'SCHEDULED';
  if (e.status === 'settled') status = 'FINISHED';
  else if (e.status === 'cancelled') status = 'FINISHED';
  else if (e.status === 'pending') status = 'SCHEDULED';

  let estimatedMinute = null;
  let isHalftime = false;
  let quarter = null;
  if (status === 'SCHEDULED' && e.date && new Date(e.date).getTime() < Date.now()) {
    const elapsedMin = Math.floor((Date.now() - new Date(e.date).getTime()) / 60000);
    if (elapsedMin > REALISTIC_MAX_LIVE_MIN) {
      status = 'FINISHED'; // same stale-live safety net as football — see REALISTIC_MAX_LIVE_MIN above
    } else {
      const clock = estimateBasketballClock(e.date);
      if (clock) {
        estimatedMinute = clock.displayMinute;
        isHalftime = clock.isBreak && clock.quarter === 2; // only the Q2->Q3 break is the real "halftime"; Q1->Q2 and Q3->Q4 are short quarter breaks, not halftime
        quarter = clock.quarter;
        status = clock.isBreak ? 'PAUSED' : 'IN_PLAY';
      } else {
        status = 'IN_PLAY';
      }
    }
  }

  return {
    id: 'oaio_bball_' + e.id,
    utcDate: e.date,
    status,
    minute: estimatedMinute,
    minuteIsEstimated: estimatedMinute !== null,
    isHalftime,
    quarter, // basketball-specific: which quarter (1-4), null if not started/finished
    sport: 'basketball',
    homeTeam: { name: e.home },
    awayTeam: { name: e.away },
    competition: { name: e.league && e.league.name || 'Basketball' },
    area: { name: null },
    score: e.scores ? {
      fullTime: e.scores.periods && e.scores.periods.ft
        ? { home: e.scores.periods.ft.home, away: e.scores.periods.ft.away }
        : (e.scores.home != null ? { home: e.scores.home, away: e.scores.away } : null)
    } : null,
    source: 'odds-api.io'
  };
}

// Returns real basketball fixtures for a given date (YYYY-MM-DD), merged
// with real bookmaker odds where odds-api.io has them. Matches with NO
// real odds available are still returned (so the fixture list itself is
// complete/honest) but their `realOdds` field will be null — callers
// should treat null realOdds the same way football treats
// aiOdds.isRealMarketOdds === false: not safe to show as a bettable price.
// Deliberately does NOT fall back to AI estimation (see file header).
async function getBasketballMatchesForDate(dateStr, isTodayBucket) {
  if (!realOdds.isOddsApiIoConfigured()) return [];
  try {
    const events = await realOdds.fetchOddsApiIoEvents(ODDSAPIIO_SPORT_SLUG);
    const filtered = events.filter(e => {
      if (!e.date) return false;
      if (e.date.startsWith(dateStr)) return true;
      // Same "still live from yesterday" carryover concept as football,
      // but with a basketball-appropriate window (games run ~2.5h max
      // including breaks, vs football's ~2h + the wider 6h safety margin
      // football used) — kept narrower here since there's no extra-time
      // ambiguity to buffer against the way football's has.
      if (!isTodayBucket) return false;
      if (e.status === 'settled' || e.status === 'cancelled') return false;
      const matchDate = new Date(e.date);
      const bucketDate = new Date(dateStr + 'T00:00:00Z');
      const hoursDiff = (bucketDate.getTime() - matchDate.getTime()) / (60 * 60 * 1000);
      return hoursDiff > 0 && hoursDiff <= 3;
    });

    // Fetch real odds for each candidate match IN PARALLEL is tempting but
    // would burn through odds-api.io's per-key hourly budget fast on a
    // busy NBA slate — sequential with the shared throttle/rotation in
    // realOdds.js (same pattern football already relies on for its
    // per-match real-odds lookups) keeps this within the existing budget
    // math rather than needing a separate basketball-specific rate plan.
    const results = [];
    for (const e of filtered) {
      const match = convertOddsApiIoBasketballEvent(e);
      const real = await realOdds.getRealOddsForMatch(e.home, e.away, ODDSAPIIO_SPORT_SLUG).catch(err => {
        console.error('[basketballData] real odds lookup failed for ' + e.home + ' vs ' + e.away + ': ' + err.message);
        return null;
      });
      match.realOdds = real; // null if no real bookmaker price is available yet — never backfilled with an AI guess
      results.push(match);
    }
    return results;
  } catch (e) {
    console.error('[basketballData] fixtures fetch failed for ' + dateStr + ': ' + e.message);
    return [];
  }
}

function getDateString(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + parseInt(daysAhead || 0, 10));
  return d.toISOString().split('T')[0];
}

module.exports = { getBasketballMatchesForDate, getDateString, estimateBasketballClock };
