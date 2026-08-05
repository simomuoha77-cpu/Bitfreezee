// footballData.js — real fixtures from football-data.org, fetched server-side.
//
// CORS never applies to server-to-server requests, so unlike the browser
// version in JuanAi's frontend, this doesn't need proxy workarounds or a
// "demo fixtures" fallback. If this fails, callers should surface the real
// error — never substitute fabricated matches.
//
// MULTI-KEY ROTATION: football-data.org's free tier is 10 req/min PER KEY,
// and — confirmed the hard way in production — a burst of over-limit
// requests can trigger a temporary block that outlasts a simple per-minute
// reset (the block persisted across a full service restart in testing).
// Rather than depend on one key never being over-used (e.g. if this app is
// ever run locally and on Render at the same time, sharing one key), this
// supports multiple comma-separated keys in FDORG_KEY. Each key gets its
// OWN independent throttle timer and its OWN independent "blocked until"
// cooldown, and a 429 on one key immediately fails over to the next
// available key rather than failing the whole request. This means one
// key's temporary block doesn't take fixture-fetching down entirely, as
// long as at least one key in the pool is currently healthy.
//
// To add more keys: sign up for additional free football-data.org accounts
// (different email each time) and set FDORG_KEY as a comma-separated list,
// e.g. FDORG_KEY=key1,key2,key3

const FDORG_KEYS = (process.env.FDORG_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);
if (FDORG_KEYS.length === 0) {
  console.warn('[footballData] FDORG_KEY is not set — fixture fetching from football-data.org will fail until it is configured. See .env.example.');
}
const FDORG_BASE = 'https://api.football-data.org/v4';

// Shared, single-source-of-truth constant: even with extra time, a real
// football match is essentially always decided within this many minutes of
// kickoff. Used in TWO places that must never drift apart: (1) here in
// footballData.js, when the background fixture refresh converts an
// odds-api.io event and decides whether a still-unsettled match should be
// treated as FINISHED/AWAITING_RESULT rather than staying live forever;
// and (2) in server.js's recomputeLiveMinutes, as an INDEPENDENT safety
// check that runs at actual request time — this second check exists
// because the first one only ever runs when the background refresh
// actually succeeds. If odds-api.io's key pool is exhausted (which does
// happen — see realOdds.js's pacing comments) and stays exhausted for a
// while, the background refresh can silently fail for an extended period,
// during which the match's status stays frozen at whatever it was last
// successfully fetched as (e.g. IN_PLAY) — see scheduler.js's "keeping
// existing fixtures rather than wiping them" fallback. Meanwhile the
// DISPLAYED minute still climbs live on every request (that part doesn't
// depend on the background refresh succeeding), capping out and sitting at
// the display ceiling — which looks exactly like a genuinely live match
// still worth pricing/betting on, even though the underlying data could be
// hours stale by that point. That combination is a real, exploitable gap:
// anyone who already knows the real-world result (from another source)
// could bet against JuanAi's stale "still live" odds with certainty. The
// fix is for BOTH places to independently enforce this same cutoff, so a
// stale match can never keep presenting as live/bettable regardless of
// whether the background data pipeline happens to be healthy right now.
const REALISTIC_MAX_LIVE_MIN = 130;

// Free tier = 10 requests/minute PER KEY. Keep a healthy margin below that.
const MIN_MS_BETWEEN_CALLS = 6500; // ~9.2 req/min ceiling, per key

// Independent state per key: last call time (for throttling) and a
// "blocked until" timestamp (set when a key hits 429, so we stop trying it
// for a while instead of hammering a key that's already blocked).
const keyState = FDORG_KEYS.map(key => ({ key, lastCallAt: 0, blockedUntil: 0 }));
let nextKeyIndex = 0; // round-robins the starting point so load spreads across keys over time, not always favoring key[0]

const KEY_BLOCK_COOLDOWN_MS = 20 * 60 * 1000; // how long to avoid a key after it 429s — confirmed in testing that these blocks outlast a simple 1-minute reset, so 20 min is a conservative, safer assumption than "reset immediately"

function pickAvailableKey() {
  const now = Date.now();
  // Try each key once, starting from nextKeyIndex, wrapping around —
  // prefers a key that's both past its cooldown AND past its throttle gap.
  for (let i = 0; i < keyState.length; i++) {
    const idx = (nextKeyIndex + i) % keyState.length;
    const state = keyState[idx];
    if (now >= state.blockedUntil) {
      nextKeyIndex = (idx + 1) % keyState.length; // next call starts from the following key, spreading load
      return state;
    }
  }
  return null; // every key is currently in its post-429 cooldown
}

async function throttleForKey(state) {
  const wait = MIN_MS_BETWEEN_CALLS - (Date.now() - state.lastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  state.lastCallAt = Date.now();
}

async function fdFetch(endpoint) {
  const state = pickAvailableKey();
  if (!state) {
    const soonestReady = Math.min(...keyState.map(s => s.blockedUntil));
    const minutesLeft = Math.max(0, Math.ceil((soonestReady - Date.now()) / 60000));
    throw new Error('All ' + keyState.length + ' football-data.org key(s) are currently blocked/cooling down — soonest available in ~' + minutesLeft + ' min');
  }

  await throttleForKey(state);
  const url = FDORG_BASE + endpoint;
  const resp = await fetch(url, { headers: { 'X-Auth-Token': state.key } });

  if (resp.status === 429) {
    state.blockedUntil = Date.now() + KEY_BLOCK_COOLDOWN_MS;
    // Recurse to try the NEXT available key immediately, rather than
    // failing the whole request just because this one key is rate-limited —
    // this is the actual point of having multiple keys.
    return fdFetch(endpoint);
  }
  if (!resp.ok) {
    throw new Error(`football-data.org HTTP ${resp.status}`);
  }
  return resp.json();
}

// Returns real matches for a given date (YYYY-MM-DD). Throws on failure —
// callers must not paper over this with sample/demo data.
//
// Uses dateFrom+dateTo rather than the bare `date=` filter. Both are
// documented, but in production the bare `date=` param started returning a
// hard HTTP 400 ("malformed request or invalid filter value" per
// football-data.org's own error docs) even for a plain valid YYYY-MM-DD
// value — confirmed in Render logs (`Fixture refresh FAILED ... HTTP 400`)
// well before this file was touched for anything else, so it isn't
// something a code change introduced. dateFrom/dateTo is the more
// universally-supported filter shape across every endpoint in the docs, so
// switching to it is the safer fix rather than debugging the single-date
// filter further.
// Normalizes football-data.org's real score shape onto the SAME field names
// odds-api.io's converted matches already use (home/away, not homeTeam/
// awayTeam) — see convertOddsApiIoEvent's score.fullTime a bit further down
// in this file. Without this, every real football-data.org match (Premier
// League, La Liga, Bundesliga, Champions League, World Cup, etc.) had its
// score silently broken wherever code read score.fullTime.home/.away,
// because football-data.org's REAL field names are score.fullTime.homeTeam
// /.awayTeam (confirmed against football-data.org's own official v4 docs).
// This was a real, separate bug from the odds-api.io FINISHED-status issue
// fixed earlier — it affected THREE places: the frontend's own score
// display, getHeadToHead's recentMatches score string (always showed
// "undefined-undefined"), and getTeamRecentForm's W/D/L calculation (always
// fell through to 'D' since gf/ga were always undefined) — the latter
// directly degrading AI analysis quality, since ai.js uses that recent-form
// guide as real input. Also normalizes halfTime the same way, which is
// needed for the half-time-score feature below (SafariBet asked whether
// half-time data is available to safely support First Half markets — it
// turns out football-data.org already sends it in every response, we just
// weren't reading it).
function normalizeFdScore(rawScore) {
  if (!rawScore) return null;
  const conv = (period) => {
    const p = rawScore[period];
    if (!p || p.homeTeam == null || p.awayTeam == null) return null;
    return { home: p.homeTeam, away: p.awayTeam };
  };
  return {
    winner: rawScore.winner || null,
    duration: rawScore.duration || null,
    fullTime: conv('fullTime'),
    halfTime: conv('halfTime'),
    extraTime: conv('extraTime'),
    penalties: conv('penalties')
  };
}

async function getMatchesForDate(dateStr) {
  const data = await fdFetch('/matches?dateFrom=' + dateStr + '&dateTo=' + dateStr);
  const matches = data.matches || [];
  // Normalize score field names in place — every other field on these raw
  // football-data.org match objects (status, utcDate, homeTeam.name,
  // competition.name, etc.) is passed through completely unchanged; only
  // the score sub-object's internal key names are touched.
  matches.forEach(m => { m.score = normalizeFdScore(m.score); });
  return matches;
}

// ── odds-api.io as a SECOND fixtures source ────────────────────────────
//
// WHY THIS EXISTS: football-data.org only covers ~12 curated top-flight
// competitions (see its /coverage page — Premier League, La Liga, Serie A,
// Bundesliga, Ligue 1, Champions League, World Cup, and a handful of
// others). Real bookmakers show hundreds of matches at once because they
// cover lower divisions and regional leagues worldwide (confirmed via real
// testing: odds-api.io's /v3/events genuinely returns fixtures like
// "Cameroon Regional League", "Nigeria Nationwide League One", "Myanmar
// Championship Women", "Latvia Virsliga" — leagues football-data.org has
// never had at any tier). Merging both sources closes that gap without
// dropping football-data.org's cleaner, more curated top-flight data.
//
// odds-api.io match IDs are prefixed with "oaio_" to guarantee they can
// never collide with football-data.org's plain numeric IDs when both
// sources are merged into one list — both providers mint IDs independently
// and there's no guarantee their numbering schemes don't overlap.

const realOdds = require('./realOdds');

// LEAGUE ALLOWLIST for odds-api.io fixtures — without this, the merge pulls
// in every league worldwide odds-api.io tracks (confirmed via real testing
// earlier: Cameroon Regional League, Myanmar Women's Championship, Latvia
// Virsliga, etc), which pushed the pending-analysis backlog past 3,600
// matches — a volume the free-tier AI budget can never realistically clear
// (~600 matches/hour ceiling even in ideal conditions, so 3,600+ pending
// means most matches sit unanalyzed for hours). Narrowing to leagues people
// actually bet on keeps the list small enough that everything shown
// actually gets analyzed in a reasonable time, and these leagues are also
// far more likely to have real bookmaker odds from SharpAPI/odds-api.io in
// the first place — a double win, not just a volume cut.
//
// Matches against the league NAME odds-api.io provides (case-insensitive
// substring match) — edit this list to add/remove leagues as needed.
const ODDSAPIIO_LEAGUE_ALLOWLIST = [
  'england - premier league', 'england premier league', // specific match — plain "premier league" was matching regional/youth leagues worldwide (e.g. "Australia - U23 Victoria Premier League 1")
  'la liga', 'serie a', 'bundesliga', 'ligue 1',
  'champions league', 'europa league', 'conference league',
  'mls', 'eredivisie', 'primeira liga', 'scottish premiership',
  'super lig', 'england - championship', 'england championship', // specific to England's 2nd tier — plain "championship" was matching unrelated leagues worldwide (e.g. "Myanmar Championship, Women")
  'copa libertadores', 'copa sudamericana', 'copa do brasil',
  'brasileirao', 'liga mx', 'saudi pro league',
  'fifa world cup', 'uefa euro', 'uefa nations league', 'copa america', 'afcon' // "world cup"/"euro"/"nations league" alone were too broad (e.g. matched U19/U20/U23 youth tournaments, women's qualifiers) — anchored to the specific senior men's tournament names
];

// Additional exclusion list: substrings that, if present ANYWHERE in the
// league name, disqualify a match regardless of allowlist matches above.
// This catches youth/reserve/lower-tier competitions that might otherwise
// slip through an allowlist keyword coincidentally appearing in their name.
const ODDSAPIIO_LEAGUE_EXCLUSIONS = [
  'u23', 'u20', 'u19', 'u18', 'u17', ' u16', 'youth', 'reserve', 'reserves',
  'academy', 'junior', 'women', // women's football is a legitimate real market in some leagues, but our current real-odds providers don't reliably price it — excluding here keeps AI-only volume down; revisit if a provider adds real coverage
  'amateur', 'regional'
];

// TOGGLE: set FILTER_LEAGUES=1 in the environment to re-enable the
// allowlist/exclusion narrowing above. Default is OFF — every league
// odds-api.io returns is shown, same as SafariBet and other real betting
// sites, instead of JuanAi silently dropping most of the world's matches.
// Turn this back on only if the AI-analysis backlog becomes unmanageable
// again (see note above ODDSAPIIO_LEAGUE_ALLOWLIST for why it existed).
const FILTER_LEAGUES = process.env.FILTER_LEAGUES === '1';

function isTrackedLeague(leagueName) {
  if (!leagueName) return false;
  if (!FILTER_LEAGUES) return true; // filtering disabled — accept every league
  const n = leagueName.toLowerCase();
  if (ODDSAPIIO_LEAGUE_EXCLUSIONS.some(kw => n.includes(kw))) return false;
  return ODDSAPIIO_LEAGUE_ALLOWLIST.some(kw => n.includes(kw));
}

// Estimates the current match minute from kickoff time, accounting for a
// realistic half-time break — this fixes a real bug where a match showed
// "111'" (impossible; regulation is ~90 min + stoppage), because the naive
// version just used raw wall-clock time since kickoff with no adjustment
// for the ~15 min half-time pause. odds-api.io doesn't give us a true match
// clock (confirmed via testing: only pending/settled/cancelled status, no
// live minute field), so this is necessarily an ESTIMATE — flagged with a
// "~" prefix wherever displayed — but it should track the real minute much
// more closely than raw elapsed time did.
function estimateMatchMinute(kickoffIso, htObservedAt) {
  if (!kickoffIso) return null;
  // NO KICKOFF-DELAY BUFFER (removed): an earlier version of this function
  // subtracted a fixed 8 minutes from elapsed time, based on a prior report
  // that the estimate ran ahead of real match time. That buffer has since
  // been checked against TWO independent real sources at once (Betika —
  // an established real betting site — and SafariBet, both showing ~43'
  // for the same live matches) and found to overshoot: with the buffer
  // applied, this function was reporting ~33' for those same matches,
  // roughly 10 minutes BEHIND both independent sources, not ahead. Rather
  // than guess at a new buffer value without further real-world
  // verification, this now uses raw elapsed time directly, which is what
  // actually matched the two independent sources in that comparison. If a
  // consistent systematic offset is observed again in the future, verify
  // it against an independent source (not just one side of a two-party
  // disagreement) before reintroducing any correction.
  const rawElapsedMin = Math.floor((Date.now() - new Date(kickoffIso).getTime()) / 60000);
  if (rawElapsedMin < 0) return null; // hasn't kicked off yet

  const HALF_TIME_BREAK_MIN = 16; // was 15 — real broadcast half-time breaks commonly run slightly past the strict 15-minute rule
  const FIRST_HALF_MIN = 45;
  const SECOND_HALF_MIN = 45;
  const MAX_STOPPAGE_PER_HALF = 9; // was 8 — modern IFAB directives (timing goal celebrations, subs, VAR reviews) have pushed typical added time up in recent seasons

  // THE ACTUAL FIX for "runs ahead of reality after half-time": when we
  // have a real, provider-confirmed half-time checkpoint (htObservedAt —
  // see htObservedAtCache in convertOddsApiIoEvent), anchor the second-half
  // clock to THAT real moment instead of a fixed 16-minute guess measured
  // from kickoff. This is what actually varies match-to-match (broadcast
  // delays, extended breaks) and is exactly what a fixed formula can never
  // get right — using the real checkpoint sidesteps the guess entirely for
  // any match where the provider has reported it.
  if (htObservedAt) {
    const minSinceHtObserved = Math.floor((Date.now() - htObservedAt) / 60000);
    // Deliberately shorter than HALF_TIME_BREAK_MIN: htObservedAt marks
    // when WE first detected the real half-time score, which is itself a
    // few minutes after it actually happened (our own ~60-90s poll cadence
    // plus the provider's own reporting lag). Treating detection time as
    // if it were the exact start of the break would double-count that lag
    // on top of the buffer and push the clock ahead again — the same bug
    // in a new spot. If this still runs ahead after deploying, verify
    // against a real independent source and shorten this further rather
    // than reverting to the fixed-formula approach.
    const RESUME_BUFFER_MIN = 10;
    if (minSinceHtObserved < RESUME_BUFFER_MIN) {
      return { minute: FIRST_HALF_MIN, isHalftime: true };
    }
    const secondHalfElapsed = minSinceHtObserved - RESUME_BUFFER_MIN;
    const cappedSecondHalf = Math.min(secondHalfElapsed, SECOND_HALF_MIN + MAX_STOPPAGE_PER_HALF);
    return { minute: FIRST_HALF_MIN + cappedSecondHalf, isHalftime: false };
  }

  // HONEST LIMITATION, not a bug fix claim: below this point (no real
  // half-time checkpoint observed yet — either genuinely still in the
  // first half, or this competition never sends odds-api.io a half-time
  // score at all) we're back to estimating from kickoff time alone, since
  // odds-api.io does not provide a genuine live match clock — confirmed by
  // checking their own API docs, which expose period SCORES (half-time/
  // full-time results) but no live "elapsed minutes" field the way some
  // premium sports-data providers do. The values below are a modest,
  // real-world-grounded adjustment, not a fix for match-to-match variance
  // in stoppage time, which simply cannot be known in advance.
  const elapsedMin = rawElapsedMin;

  if (elapsedMin <= FIRST_HALF_MIN + MAX_STOPPAGE_PER_HALF) {
    // Still in the first half (or its stoppage time) — no adjustment needed.
    return { minute: elapsedMin, isHalftime: false };
  }
  if (elapsedMin <= FIRST_HALF_MIN + MAX_STOPPAGE_PER_HALF + HALF_TIME_BREAK_MIN) {
    // In the half-time window itself. Returning isHalftime:true here is the
    // actual fix for matches appearing to "keep counting" through the
    // break — without this flag, every consumer (JuanAi's own dashboard,
    // and SafariBet reading match.minute over the API) had no way to tell
    // "paused at 45, clock stopped" apart from "still live at minute 45",
    // since both looked like the exact same bare number.
    return { minute: FIRST_HALF_MIN, isHalftime: true };
  }
  // Past the half-time window and STILL no real htObservedAt checkpoint —
  // fall back to the old formulaic estimate as a last resort. This is the
  // one remaining case that can still run ahead of reality (same root
  // cause as before), because there's no real signal to anchor to for
  // this specific match.
  const secondHalfElapsed = elapsedMin - FIRST_HALF_MIN - MAX_STOPPAGE_PER_HALF - HALF_TIME_BREAK_MIN;
  const cappedSecondHalf = Math.min(Math.max(0, secondHalfElapsed), SECOND_HALF_MIN + MAX_STOPPAGE_PER_HALF);
  return { minute: FIRST_HALF_MIN + cappedSecondHalf, isHalftime: false };
}

// REAL FIX for "minute runs ahead of reality after half-time": the old
// estimateMatchMinute() assumed a fixed 16-minute half-time break measured
// from kickoff time alone. Real broadcast half-time breaks routinely run
// longer than that (delays, extended breaks, second-half kickoff delays),
// and since this was a pure formula with no real-world checkpoint, the
// clock would immediately start overshooting the instant it crossed the
// fixed threshold — and the error only compounds for the rest of the
// match, exactly matching the "matches fine in 1st half, loses control
// after half-time" symptom reported in production.
//
// odds-api.io DOES send a real signal we weren't using: the actual
// half-time score (scores.periods.ht), populated only once the real first
// half has genuinely ended. The first TIME we observe that field for a
// given match is a real, provider-confirmed checkpoint — far more reliable
// than any fixed-duration guess. This cache records that moment per match
// (in-memory; also persisted onto the match doc as htObservedAt so
// db.js/server.js's re-computation on every read can reuse the same
// anchor instead of falling back to the old formula).
const htObservedAtCache = new Map(); // matchId -> timestamp ms of first observation

function convertOddsApiIoEvent(e, liveClock) {
  // Maps odds-api.io's event shape onto football-data.org's match shape,
  // so the rest of the pipeline (scheduler.js, ai.js, the frontend) can
  // treat both sources identically without any special-casing.
  const matchId = 'oaio_' + e.id;
  let status = 'SCHEDULED';
  if (e.status === 'settled') status = 'FINISHED';
  else if (e.status === 'cancelled') status = 'FINISHED'; // hide cancelled matches same as finished ones — nothing to bet on
  else if (e.status === 'pending') status = 'SCHEDULED';
  // odds-api.io doesn't expose a distinct "currently live" status in the
  // /events list the same way football-data.org does (IN_PLAY/PAUSED) — it
  // only tells us pending/settled/cancelled. A match whose kickoff time has
  // already passed but isn't "settled" yet is presumably in progress; we
  // treat that as IN_PLAY so the frontend's live badge and the scheduler's
  // faster live-repricing cadence both apply correctly.
  let estimatedMinute = null;
  let isHalftime = false;
  let minuteIsRealClock = false; // true when sourced from odds-api.io's real /events/live clock, not the kickoff-time estimate

  // Does this event actually carry a real, usable final/current score right
  // now? Checked once here so both branches below can rely on it — this is
  // the exact fact that was missing before, which is how a match got
  // marked FINISHED while still showing a stale/wrong 0-0.
  const hasRealScore = !!(e.scores && (
    (e.scores.periods && e.scores.periods.ft && e.scores.periods.ft.home != null && e.scores.periods.ft.away != null) ||
    (e.scores.home != null && e.scores.away != null)
  ));

  // Real half-time checkpoint (see comment on htObservedAtCache above).
  const htPresent = !!(e.scores && e.scores.periods && e.scores.periods.ht && e.scores.periods.ht.home != null && e.scores.periods.ht.away != null);
  if (htPresent && !htObservedAtCache.has(matchId)) {
    htObservedAtCache.set(matchId, Date.now());
  }
  const htObservedAt = htObservedAtCache.get(matchId) || null;

  if (status === 'FINISHED' && !hasRealScore) {
    // odds-api.io says settled/cancelled, but sent no usable score. Rather
    // than call this FINISHED with nothing (which downstream code could
    // still misread as "0-0, over"), fall through to the same
    // AWAITING_RESULT handling below as a stale-live match with no score —
    // it's the same underlying problem (we don't actually know the result
    // yet), just reached via a different signal.
    status = 'SCHEDULED';
  }

  if (status === 'SCHEDULED' && e.date && new Date(e.date).getTime() < Date.now()) {
    const elapsedMin = Math.floor((Date.now() - new Date(e.date).getTime()) / 60000);
    if (elapsedMin > REALISTIC_MAX_LIVE_MIN) {
      // THE ACTUAL FIX: a match well past any realistic duration is
      // presumably over, but if odds-api.io never sent a real score for
      // it, we must NOT claim FINISHED — that previously locked in
      // whatever stale score happened to be cached (in one real case, a
      // FIFA World Cup semifinal got stuck at "FT: 0-0" long after the
      // actual 1-2 final score existed everywhere else, because this
      // exact code path fired before a real score ever arrived). Using a
      // distinct status here means any consumer checking specifically for
      // status==='FINISHED' (e.g. a betting site settling wagers) will
      // correctly NOT treat this as a confirmed result, instead of
      // silently paying out (or rejecting) based on a guess.
      status = hasRealScore ? 'FINISHED' : 'AWAITING_RESULT';
    } else {
      // THE ACTUAL FIX for matching Betika/SportPesa exactly: if odds-
      // api.io's real /events/live clock is available for this match, use
      // it directly instead of the kickoff-time estimate below — this is
      // the provider's own authoritative minute, not a guess, so it's what
      // "matching Betika/SportPesa" actually requires. `running === false`
      // covers halftime AND any other moment the clock isn't advancing
      // (red card stoppage, etc.), which is a more complete pause signal
      // than the old halftime-only estimate could ever provide. Falls
      // through to the estimate below only when this endpoint has no data
      // for this specific match yet (just went live this cycle, or this
      // competition isn't covered by the live-clock feed).
      if (liveClock && typeof liveClock.minute === 'number') {
        estimatedMinute = liveClock.minute;
        isHalftime = liveClock.running === false;
      } else {
        const est = estimateMatchMinute(e.date, htObservedAt);
        estimatedMinute = est ? est.minute : null;
        isHalftime = est ? est.isHalftime : false;
      }
      minuteIsRealClock = !!(liveClock && typeof liveClock.minute === 'number');
      // PAUSED matches football-data.org's own convention for half-time —
      // using it here (instead of leaving status as IN_PLAY) means any
      // consumer already handling football-data.org's real PAUSED status
      // (JuanAi's own frontend already does: `status === 'IN_PLAY' ||
      // status === 'PAUSED'` counts as live) gets correct half-time
      // handling for free, without needing special-case logic just for
      // odds-api.io matches.
      status = isHalftime ? 'PAUSED' : 'IN_PLAY';
    }
  }

  return {
    id: 'oaio_' + e.id,
    utcDate: e.date,
    status,
    // Set directly on the match object — NOT just computed client-side in
    // the frontend — so it flows through the database and out through
    // /api/fixtures automatically. This is what makes it visible to
    // external sites like BetaKE, not just JuanAi's own UI.
    minute: estimatedMinute,
    minuteIsEstimated: estimatedMinute !== null && !minuteIsRealClock, // true only when this is the kickoff-time guess — false (not an estimate) when sourced from odds-api.io's real live clock
    minuteIsRealClock, // transparency flag in the other direction: true means this IS a genuine provider-reported clock value, safe to treat as authoritative
    isHalftime, // explicit flag: true means the clock is PAUSED at half-time, not still running — fixes matches appearing to "keep counting" through the break
    htObservedAt, // persisted so db.js/server.js's live re-computation on every read can reuse this real checkpoint instead of falling back to the fixed-duration formula — see htObservedAtCache above
    homeTeam: { name: e.home },
    awayTeam: { name: e.away },
    competition: { name: e.league && e.league.name || 'Unknown League' },
    area: { name: null }, // odds-api.io doesn't provide a country/flag field the same way football-data.org does
    score: hasRealScore ? {
      fullTime: e.scores.periods && e.scores.periods.ft
        ? { home: e.scores.periods.ft.home, away: e.scores.periods.ft.away }
        : { home: e.scores.home, away: e.scores.away },
      // Half-time score: odds-api.io's own docs advertise "period scores
      // for every period (half-time, 90min, overtime)" and this codebase
      // already confirmed the "ft" (full-time) key works in production —
      // "ht" here follows that same established naming convention, but has
      // NOT been independently verified against a live response the way
      // "ft" was. If half-time data doesn't actually appear for odds-api.io
      // matches after this ships, check the real key name in an actual API
      // response rather than assuming this guess was correct.
      halfTime: (e.scores.periods && e.scores.periods.ht && e.scores.periods.ht.home != null && e.scores.periods.ht.away != null)
        ? { home: e.scores.periods.ht.home, away: e.scores.periods.ht.away }
        : null
    } : null, // explicitly null (not a stale/guessed score) whenever hasRealScore is false — this is the second half of the actual fix
    source: 'odds-api.io' // transparency field — lets callers know this didn't come from football-data.org
  };
}

// Returns odds-api.io fixtures for a given date, converted to match
// football-data.org's shape. Reuses realOdds.js's existing cached
// /v3/events fetch (already pulled for odds-matching purposes) rather than
// hitting the API again — this is a read of data already in memory, not an
// extra network call, so it doesn't add to odds-api.io's rate-limit budget.
async function getOddsApiIoMatchesForDate(dateStr, isTodayBucket) {
  if (!realOdds.isOddsApiIoConfigured()) return [];
  try {
    // Fetched together: /events gives the day's schedule + settled scores,
    // /events/live gives the REAL match clock (minute/period/running) for
    // whatever's currently in play — see fetchOddsApiIoLiveClocks in
    // realOdds.js. Only actually calls out for the live-clock map when
    // this is the today-bucket refresh (isTodayBucket), since that's the
    // only bucket where anything can actually be live right now — this
    // avoids spending daily budget on a live-clock call while refreshing
    // days=1/2/etc, which can never have live matches by definition.
    const [events, liveClocks] = await Promise.all([
      realOdds.fetchOddsApiIoEvents(),
      isTodayBucket ? realOdds.fetchOddsApiIoLiveClocks() : Promise.resolve(new Map())
    ]);
    return events
      .filter(e => {
        // League allowlist first — cuts total volume down to a realistically
        // analyzable size and improves real-odds match rate (see note above
        // ODDSAPIIO_LEAGUE_ALLOWLIST for why this exists).
        if (!isTrackedLeague(e.league && e.league.name)) return false;
        if (!e.date) return false;
        if (e.date.startsWith(dateStr)) return true;
        // "Still live from yesterday" carryover ONLY applies when refreshing
        // TODAY's bucket specifically — this is a deliberate, narrow UX
        // exception so a match that kicked off before midnight still shows
        // as live on "today" instead of vanishing. It must NOT apply when
        // refreshing any other day-bucket, or the same match can end up
        // satisfying two different buckets' criteria at once (its real
        // kickoff-date bucket, AND some other bucket's carryover window),
        // leaving two independently-tracked copies that can disagree on
        // status — which was the actual cause of a match showing FINISHED
        // in one bucket while stuck LIVE in another.
        if (!isTodayBucket) return false;
        if (e.status !== 'settled' && e.status !== 'cancelled') {
          const matchDate = new Date(e.date);
          const bucketDate = new Date(dateStr + 'T00:00:00Z');
          const hoursDiff = (bucketDate.getTime() - matchDate.getTime()) / (60 * 60 * 1000);
          // A match that started up to 6 hours before this bucket's midnight
          // and still isn't settled is presumably still in progress —
          // football matches (plus stoppage time, potential extra time)
          // essentially never run longer than that.
          return hoursDiff > 0 && hoursDiff <= 6;
        }
        return false;
      })
      .map(e => convertOddsApiIoEvent(e, liveClocks.get(String(e.id))));
  } catch (e) {
    console.error('[footballData] odds-api.io fixtures fetch failed for ' + dateStr + ': ' + e.message);
    return []; // real failure — log it, but don't block football-data.org's matches from showing
  }
}

// Merges football-data.org and odds-api.io fixtures for a given date.
// football-data.org matches come first (cleaner, more curated data);
// odds-api.io matches are appended after, giving broader league depth.
// De-duplicates by team-name match (teamsMatch from realOdds.js) + same
// date, in case both sources happen to cover the same fixture — prefers the
// football-data.org version when that happens, since it has richer data
// (proper competition/area info) that odds-api.io's shape doesn't provide.
async function getMergedMatchesForDate(dateStr, isTodayBucket) {
  const [fdMatches, oaioMatches] = await Promise.all([
    getMatchesForDate(dateStr).catch(e => {
      console.error('[footballData] football-data.org fetch failed for ' + dateStr + ': ' + e.message);
      return []; // real failure — log it, let odds-api.io matches still show if available
    }),
    getOddsApiIoMatchesForDate(dateStr, isTodayBucket)
  ]);

  // Dedup by team names AND kickoff time proximity (within 3 hours) — team
  // names alone wasn't catching real-world duplicates like Spain vs Belgium
  // appearing under both "FIFA World Cup" (football-data.org) and
  // "International - FIFA World Cup" (odds-api.io) as two separate match
  // IDs, since slightly different competition-name strings meant the two
  // sources' matches were never being recognized as the same fixture. Real
  // matches between the same two teams essentially never happen within
  // hours of each other, so adding a time check makes this safe without
  // needing to compare competition names directly (which vary too much
  // between sources to match reliably).
  const dedupedOaio = oaioMatches.filter(oaio =>
    !fdMatches.some(fd => {
      const sameTeams = realOdds.teamsMatch(fd.homeTeam && fd.homeTeam.name, oaio.homeTeam.name) &&
        realOdds.teamsMatch(fd.awayTeam && fd.awayTeam.name, oaio.awayTeam.name);
      if (!sameTeams) return false;
      if (!fd.utcDate || !oaio.utcDate) return sameTeams; // no date to compare — fall back to team-name-only match
      const hoursDiff = Math.abs(new Date(fd.utcDate).getTime() - new Date(oaio.utcDate).getTime()) / (60 * 60 * 1000);
      return hoursDiff <= 3;
    })
  );

  return fdMatches.concat(dedupedOaio);
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
        const score = normalizeFdScore(m.score);
        return {
          date: m.utcDate,
          home: m.homeTeam && m.homeTeam.name,
          away: m.awayTeam && m.awayTeam.name,
          score: score && score.fullTime ? (score.fullTime.home + '-' + score.fullTime.away) : 'N/A',
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
      const score = normalizeFdScore(m.score);
      const gf = score && score.fullTime ? (isHome ? score.fullTime.home : score.fullTime.away) : null;
      const ga = score && score.fullTime ? (isHome ? score.fullTime.away : score.fullTime.home) : null;
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

function getKeyPoolStatus() {
  const now = Date.now();
  return {
    totalKeys: keyState.length,
    availableKeys: keyState.filter(s => now >= s.blockedUntil).length,
    blockedKeys: keyState.filter(s => now < s.blockedUntil).map(s => ({
      keyPreview: s.key.slice(0, 6) + '...',
      availableInMinutes: Math.ceil((s.blockedUntil - now) / 60000)
    }))
  };
}

module.exports = { getMatchesForDate, getMergedMatchesForDate, getDateString, getHeadToHead, getTeamRecentForm, getKeyPoolStatus, estimateMatchMinute, REALISTIC_MAX_LIVE_MIN };
