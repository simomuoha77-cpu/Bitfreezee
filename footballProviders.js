// footballProviders.js — orchestrates all football data providers:
// priority cascade, canonical cross-provider dedup, and per-provider
// key-pool status. This is the ONLY module scheduler.js talks to for
// fixtures now — it decides which provider(s) actually get called.
//
// PRIORITY ORDER:
//   SofaBets → BigBallsData → API-Football → football-data.org →
//   Sportmonks → TheSportsDB → Highlightly → API-Sports
//
// CASCADE RULE: query EVERY CONFIGURED provider for the date, not just the
// first one that has data. All configured providers' results are merged
// and deduplicated below (see lib/canonicalMatch.js); priority order
// still matters for which provider's data "wins" when two providers
// report the SAME real match (earlier in the list = primary source for
// that match's fields), and for the /internal/providers/test log ordering.
const { mergeProviderMatches } = require('./lib/canonicalMatch');

const sofabets = require('./providers/sofaBetsProvider');
const bigballsdata = require('./providers/bigballsdataProvider');
const apiFootball = require('./providers/apiFootballProvider');
const footballDataOrg = require('./providers/footballDataOrgProvider');
const sportmonks = require('./providers/sportmonksProvider');
const thesportsdb = require('./providers/thesportsdbProvider');
const highlightly = require('./providers/highlightlyProvider');
const apiSports = require('./providers/apiSportsProvider');

const PROVIDERS_IN_PRIORITY_ORDER = [sofabets, bigballsdata, apiFootball, footballDataOrg, sportmonks, thesportsdb, highlightly, apiSports];

function toAppShape(m) {
  const leagueCode = m.competition ? m.competition.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : null;
  return {
    id: m.id,
    providerMatchId: m.providerMatchId,
    source: m.primarySource,
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
  let anyProviderSucceeded = false;
  const perProviderResults = [];

  for (const provider of PROVIDERS_IN_PRIORITY_ORDER) {
    if (!provider.isConfigured()) {
      attempted.push({ provider: provider.providerName, result: 'not configured (no key set)' });
      continue;
    }

    let matches = [];
    try {
      matches = provider === bigballsdata
        ? await provider.getMatchesForDate(dateStr, options)
        : await provider.getMatchesForDate(dateStr);
      anyProviderSucceeded = true;
    } catch (e) {
      attempted.push({ provider: provider.providerName, result: 'error: ' + e.message });
      console.error('[footballProviders] ' + provider.providerName + ' failed for ' + dateStr + ': ' + e.message);
      continue;
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
