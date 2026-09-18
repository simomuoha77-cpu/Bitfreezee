// footballProviders.js — JuanAi's canonical football source.
// SofaBets is the ONLY provider used for the main football fixture feed.
const sofabets = require('./providers/sofaBetsProvider');

function toAppShape(m) {
  const leagueCode = m.competition ? String(m.competition).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') : null;
  const odds = m.providerOdds || m._sofaProviderOdds || m.odds || null;
  // Backward-compat mirror: before the SofaBets-only switch, real odds
  // (from odds-api.io) lived under `aiOdds` — the same field AI-generated
  // estimates used, just flagged isRealMarketOdds:true. SafariBet's own
  // code (a separate, unmodified app) almost certainly still reads
  // match.aiOdds.homeWin/draw/awayWin, not the newer providerOdds field —
  // confirmed live: real SofaBets fixtures currently return aiOdds:
  // undefined, since needsAnalysis correctly skips AI for them and nothing
  // else populates aiOdds anymore. Mirroring the real odds into aiOdds too
  // (in addition to, never instead of, the explicit provider fields below)
  // means old consumers and new ones both see real data, with zero changes
  // needed on SafariBet's side.
  const aiOddsMirror = m.aiOdds || (odds ? Object.assign({}, odds, {
    isRealMarketOdds: true,
    aiGenerated: false,
    oddsSource: 'sofabets'
  }) : null);
  return Object.assign({}, m, {
    id: m.id || ('sofa_' + String(m.providerMatchId)),
    provider: 'sofabets',
    source: 'sofabets',
    primarySource: 'sofabets',
    sourceProviders: ['sofabets'],
    homeTeam: { id: null, name: m.homeTeam, crest: null },
    awayTeam: { id: null, name: m.awayTeam, crest: null },
    competition: { id: null, name: m.competition || null, code: leagueCode },
    score: { winner: null, fullTime: (m.score && m.score.fullTime) || null, halfTime: (m.score && m.score.halfTime) || null },
    sport: 'football',
    odds,
    providerOdds: odds,
    _sofaProviderOdds: odds,
    aiOdds: aiOddsMirror,
    oddsSource: odds ? 'sofabets' : null,
    realOddsSource: odds ? 'SofaBets' : null,
    isRealMarketOdds: !!odds,
    aiGenerated: false,
    _skipAiOddsGeneration: !!odds,
    _directProviderOdds: !!odds,
    markets: m.markets || (odds && odds.markets) || [],
    bookmakers: m.bookmakers || (odds && odds.bookmakers) || []
  });
}

async function getMatchesForDate(dateStr, options) {
  options = options || {};
  const attempted = [];
  try {
    const rawMatches = await sofabets.getMatchesForDate(dateStr, options);
    const matches = rawMatches.map(toAppShape);
    attempted.push({ provider: sofabets.providerName, result: matches.length + ' match(es)' });
    return {
      matches,
      providerLog: attempted,
      primaryProviderUsed: matches.length ? 'sofabets' : null,
      providersUsed: matches.length ? ['sofabets'] : [],
      anyProviderSucceeded: true
    };
  } catch (e) {
    attempted.push({ provider: sofabets.providerName, result: 'error: ' + e.message });
    console.error('[footballProviders] sofabets failed for ' + dateStr + ': ' + e.message);
    return { matches: [], providerLog: attempted, primaryProviderUsed: null, providersUsed: [], anyProviderSucceeded: false };
  }
}

function getAllProviderStatus() {
  try { return [sofabets.getStatus()]; }
  catch (e) { return [{ provider: sofabets.providerName, error: e.message }]; }
}

module.exports = {
  getMatchesForDate,
  getAllProviderStatus,
  PROVIDER_NAMES: ['sofabets']
};
