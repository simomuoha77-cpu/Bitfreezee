// footballProviders.js — merges all configured football providers.
// SofaBets is first so its fixture/odds data is retained when available.
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
    sport: 'football',
    // Preserve provider-native odds. Previously these were silently dropped.
    odds: m.providerOdds || m._sofaProviderOdds || null,
    providerOdds: m.providerOdds || m._sofaProviderOdds || null
  };
}

function matchKey(m) {
  return [
    String(m.homeTeam || '').trim().toLowerCase(),
    String(m.awayTeam || '').trim().toLowerCase(),
    m.utcDate ? new Date(m.utcDate).getTime() : ''
  ].join('|');
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

    try {
      const matches = provider === bigballsdata
        ? await provider.getMatchesForDate(dateStr, options)
        : await provider.getMatchesForDate(dateStr);
      anyProviderSucceeded = true;
      attempted.push({ provider: provider.providerName, result: matches.length + ' match(es)' });
      if (matches.length) perProviderResults.push({ provider: provider.providerName, matches });
    } catch (e) {
      attempted.push({ provider: provider.providerName, result: 'error: ' + e.message });
      console.error('[footballProviders] ' + provider.providerName + ' failed for ' + dateStr + ': ' + e.message);
    }
  }

  const mergedCanonical = mergeProviderMatches(perProviderResults);

  // Recover SofaBets native odds after canonicalMatch.js deduplication. The
  // previous version attached _sofaProviderOdds to a raw fixture and then
  // lost it during merge/toAppShape, so JuanAi could never use those odds.
  const oddsByKey = new Map();
  for (const bucket of perProviderResults) {
    for (const m of bucket.matches) {
      const odds = m._sofaProviderOdds || m.providerOdds || null;
      if (odds) oddsByKey.set(matchKey(m), odds);
    }
  }

  for (const m of mergedCanonical) {
    if (!m.providerOdds) {
      const odds = oddsByKey.get(matchKey(m));
      if (odds) m.providerOdds = odds;
    }
  }

  const merged = mergedCanonical.map(toAppShape);
  const providersWithData = perProviderResults.map(r => r.provider);
  return {
    matches: merged,
    providerLog: attempted,
    primaryProviderUsed: providersWithData[0] || null,
    providersUsed: providersWithData,
    anyProviderSucceeded
  };
}

function getAllProviderStatus() {
  return PROVIDERS_IN_PRIORITY_ORDER.map(p => {
    try { return p.getStatus(); }
    catch (e) { return { provider: p.providerName, error: e.message }; }
  });
}

module.exports = {
  getMatchesForDate,
  getAllProviderStatus,
  PROVIDER_NAMES: PROVIDERS_IN_PRIORITY_ORDER.map(p => p.providerName)
};
