// footballProviders.js — orchestrates all 7 football data providers:
// priority cascade, canonical cross-provider dedup, and per-provider
// key-pool status. This is the ONLY module scheduler.js talks to for
// fixtures now — it decides which provider(s) actually get called.
//
// PRIORITY ORDER (per explicit request):
//   BigBallsData → API-Football → football-data.org → Sportmonks →
//   TheSportsDB → Highlightly → API-Sports
//
// CASCADE RULE (UPDATED): query EVERY CONFIGURED provider for the date,
// not just the first one that has data. Originally this stopped at the
// first provider with any matches at all — but since BigBallsData almost
// always has SOMETHING for a given date, that meant the other 6
// providers, even with real keys added, were never actually called. This
// defeats the actual goal (more total games reaching SafariBet). Every
// UNCONFIGURED provider (no key) is still skipped entirely — that part of
// "don't call providers unnecessarily" stays. All configured providers'
// results are merged and deduplicated below (see lib/canonicalMatch.js);
// priority order still matters for which provider's data "wins" when two
// providers report the SAME real match (earlier in the list = primary
// source for that match's fields), and for the /internal/providers/test
// log ordering.
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
  const perProviderResults = []; // [{ provider, matches }] IN PRIORITY ORDER — order matters for merge below

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
      continue; // this provider's data just doesn't get included this cycle — the others still run
    }

    attempted.push({ provider: provider.providerName, result: matches.length + ' match(es)' });
    if (matches.length > 0) perProviderResults.push({ provider: provider.providerName, matches });
  }

  const merged = mergeProviderMatches(perProviderResults).map(toAppShape);
  const providersWithData = perProviderResults.map(r => r.provider);
  return { matches: merged, providerLog: attempted, primaryProviderUsed: providersWithData[0] || null, providersUsed: providersWithData, anyProviderSucceeded };
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
