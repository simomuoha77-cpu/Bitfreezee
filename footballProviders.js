// footballProviders.js — orchestrates all 7 football data providers:
// priority cascade, canonical cross-provider dedup, and per-provider
// key-pool status. This is the ONLY module scheduler.js talks to for
// fixtures now — it decides which provider(s) actually get called.
//
// PRIORITY ORDER (per explicit request):
//   BigBallsData → API-Football → football-data.org → Sportmonks →
//   TheSportsDB → Highlightly → API-Sports
//
// CASCADE RULE: do NOT call every provider for every date. Call the
// highest-priority CONFIGURED provider first; only fall through to the
// next one if that call fails outright OR returns zero matches for the
// date. The very first provider to return a non-empty list wins — the
// cascade stops there.
//
// IMPORTANT HONEST LIMITATION: the request describes gap-filling at
// per-COMPETITION/per-match granularity ("if BigBallsData doesn't have
// THIS match, ask API-Football for it"). Implementing that precisely
// would require a maintained reference table of which specific
// competitions each of the 7 providers covers — nothing here can safely
// invent that without real coverage data from each provider. What's
// implemented instead is date-level cascade: if the top provider returns
// SOMETHING for a date, that's used (matching "don't call the others
// unnecessarily"); if it returns NOTHING (misconfigured, down, or
// genuinely has no data for that date), the next provider is tried. The
// dedup/canonical-ID/sourceProviders machinery below is fully wired and
// ready for tighter per-competition gap-filling later — it just isn't
// being asked to do that yet, since only one provider's list normally
// reaches the merge step under this cascade rule.
const { mergeProviderMatches } = require('./lib/canonicalMatch');

const bigballsdata = require('./providers/bigballsdataProvider');
const apiFootball = require('./providers/apiFootballProvider');
const footballDataOrg = require('./providers/footballDataOrgProvider');
const sportmonks = require('./providers/sportmonksProvider');
const thesportsdb = require('./providers/thesportsdbProvider');
const highlightly = require('./providers/highlightlyProvider');
const apiSports = require('./providers/apiSportsProvider');

const PROVIDERS_IN_PRIORITY_ORDER = [bigballsdata, apiFootball, footballDataOrg, sportmonks, thesportsdb, highlightly, apiSports];

// Converts the canonical merged shape (plain-string homeTeam/awayTeam/
// competition — see lib/canonicalMatch.js) back onto the SAME object shape
// the rest of this app has always used (homeTeam.name, competition.name,
// etc.) — db.js, server.js, and public/index.html all key off that shape,
// and rewriting all of them to understand the new canonical shape would
// be a much bigger, riskier change than converting once here. This is
// also where the canonical id (not any single provider's own id) becomes
// this match's `id` everywhere downstream, per the explicit requirement
// that JuanAi's match identity not be tied to any one provider.
function toAppShape(m) {
  const leagueCode = m.competition ? m.competition.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : null;
  return {
    id: m.id, // canonical — see lib/canonicalMatch.js, NOT any provider's native id
    providerMatchId: m.providerMatchId, // the ORIGINAL provider id — needed by scheduler.js to call that provider's per-match endpoints (events/odds), since `id` above is now canonical
    source: m.primarySource, // kept for any code still checking m.source (e.g. scheduler's live-enrichment filter)
    sourceProviders: m.sourceProviders,
    primarySource: m.primarySource,
    utcDate: m.utcDate,
    status: m.status,
    minute: m.minute != null ? m.minute : null,
    minuteIsEstimated: m.minuteIsEstimated !== undefined ? m.minuteIsEstimated : true,
    homeTeam: { id: null, name: m.homeTeam, crest: null },
    awayTeam: { id: null, name: m.awayTeam, crest: null },
    score: { winner: null, fullTime: (m.score && m.score.fullTime) || null, halfTime: (m.score && m.score.halfTime) || null },
    competition: { id: null, name: m.competition || null, code: leagueCode },
    season: m.season || null,
    venue: m.venue || null,
    sport: 'football'
  };
}

async function getMatchesForDate(dateStr, options) {
  options = options || {};
  const attempted = [];
  let anyProviderSucceeded = false; // true the moment ANY provider call completes without throwing, even with 0 matches — lets callers distinguish "genuinely no matches today" from "every provider is unconfigured/down"

  for (const provider of PROVIDERS_IN_PRIORITY_ORDER) {
    if (!provider.isConfigured()) {
      attempted.push({ provider: provider.providerName, result: 'not configured (no key set)' });
      continue;
    }

    let matches = [];
    try {
      // Only bigballsdata currently accepts the {fullCatalogue} option
      // (its own per-league backfill pass) — every other provider gets a
      // plain date call.
      matches = provider === bigballsdata
        ? await provider.getMatchesForDate(dateStr, options)
        : await provider.getMatchesForDate(dateStr);
      anyProviderSucceeded = true;
    } catch (e) {
      attempted.push({ provider: provider.providerName, result: 'error: ' + e.message });
      console.error('[footballProviders] ' + provider.providerName + ' failed for ' + dateStr + ': ' + e.message);
      continue; // fall through to next provider in priority order
    }

    if (matches.length > 0) {
      attempted.push({ provider: provider.providerName, result: matches.length + ' match(es) — cascade stops here' });
      const merged = mergeProviderMatches([{ provider: provider.providerName, matches }]).map(toAppShape);
      return { matches: merged, providerLog: attempted, primaryProviderUsed: provider.providerName, anyProviderSucceeded };
    }

    attempted.push({ provider: provider.providerName, result: '0 matches — trying next provider' });
  }

  return { matches: [], providerLog: attempted, primaryProviderUsed: null, anyProviderSucceeded };
}

function getAllProviderStatus() {
  return PROVIDERS_IN_PRIORITY_ORDER.map(p => {
    try {
      return p.getStatus();
    } catch (e) {
      return { provider: p.providerName, error: e.message };
    }
  });
}

module.exports = { getMatchesForDate, getAllProviderStatus, PROVIDER_NAMES: PROVIDERS_IN_PRIORITY_ORDER.map(p => p.providerName) };
