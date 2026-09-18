// lib/canonicalMatch.js — canonical match identity + cross-provider
// deduplication, so the SAME real-world match reported by two different
// providers (e.g. BigBallsData AND API-Football both having "Arsenal vs
// Chelsea") becomes exactly ONE match in JuanAi, not two.
//
// A match's canonical identity is: normalized competition name + season +
// normalized home team + normalized away team + kickoff time (with a
// tolerance window, since kickoff times sometimes shift by a few minutes
// between providers or get rescheduled slightly). This is deliberately
// NOT any single provider's own match ID — provider IDs never survive a
// provider being dropped/swapped, canonical identity does.

const crypto = require('crypto');

// Strips accents/diacritics, common club-name filler words, and
// punctuation, so "FC København" / "Kobenhavn" / "F.C. Copenhagen" all
// normalize to something comparable. Deliberately conservative — this
// trades a few missed matches for never accidentally merging two
// DIFFERENT real teams into one.
const FILLER_WORDS = /\b(fc|cf|afc|sc|ac|cd|sd|ud|rc|club|calcio|futbol|futebol|the)\b/g;

function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(FILLER_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompetitionName(name) {
  if (!name) return '';
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Kickoff tolerance for treating two providers' listings as "the same
// match" even when times don't match exactly (rescheduling, provider
// clock-rounding, timezone conversion slop). 90 minutes comfortably covers
// normal reschedules without being wide enough to conflate two genuinely
// different fixtures between the same two teams days apart.
const KICKOFF_TOLERANCE_MS = 90 * 60 * 1000;

// Canonical key is a STABLE identity string (used for the Mongo unique
// index) — built from normalized fields rounded to the DAY, not the exact
// minute, since two providers' matches for the same real fixture must
// collapse to one key even if their kickoff timestamps differ by a few
// minutes. Fine-grained tolerance-based comparison (for genuinely
// borderline cases) is handled separately by isSameMatch, used during the
// merge pass below.
function canonicalKey({ competition, season, homeTeam, awayTeam, utcDate }) {
  const dayBucket = utcDate ? new Date(utcDate).toISOString().slice(0, 10) : 'unknown-date';
  const raw = [
    normalizeCompetitionName(competition),
    season || '',
    normalizeTeamName(homeTeam),
    normalizeTeamName(awayTeam),
    dayBucket
  ].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

// Looser same-match check used when MERGING providers' lists (as opposed
// to the exact canonicalKey grouping above) — tolerates a kickoff-time
// difference up to KICKOFF_TOLERANCE_MS, since this is what actually
// catches "same match, slightly different reported kickoff" cases that a
// pure day-bucket key could still separate if they land on different UTC
// calendar days near midnight.
function isSameMatch(a, b) {
  if (normalizeTeamName(a.homeTeam) !== normalizeTeamName(b.homeTeam)) return false;
  if (normalizeTeamName(a.awayTeam) !== normalizeTeamName(b.awayTeam)) return false;
  if (normalizeCompetitionName(a.competition) !== normalizeCompetitionName(b.competition)) return false;
  if (!a.utcDate || !b.utcDate) return true; // no kickoff to compare — team+competition match is enough
  const diff = Math.abs(new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());
  return diff <= KICKOFF_TOLERANCE_MS;
}

// Merges match lists from multiple providers, IN PRIORITY ORDER (first
// list = highest-priority/primary source), into one deduplicated list.
// Each input match must already be normalized to the common shape: {
//   provider, competition, season, homeTeam, awayTeam, utcDate, status,
//   score: {fullTime:{home,away}, halfTime}, ...anything else to keep
// }
//
// Output matches gain: id (canonical, stable across providers),
// sourceProviders (array, in the order they were found), primarySource
// (the first/highest-priority provider that had this match). All other
// fields come from whichever provider found it FIRST (primary source's
// data wins on conflict) — a later provider only ever adds its name to
// sourceProviders, never overwrites fields, so the primary source's data
// stays authoritative for anything downstream (AI odds analysis, live
// enrichment) that keys off those fields.
function mergeProviderMatches(providerResultsInOrder) {
  const merged = []; // list of { canonical fields..., id, sourceProviders, primarySource, _providerMatches: [...] }

  for (const { provider, matches } of providerResultsInOrder) {
    for (const m of matches) {
      const existing = merged.find(x => isSameMatch(x, m));
      if (existing) {
        if (!existing.sourceProviders.includes(provider)) existing.sourceProviders.push(provider);
        continue; // primary source's fields stay authoritative — see comment above
      }
      const id = canonicalKey(m);
      merged.push(Object.assign({}, m, {
        id,
        sourceProviders: [provider],
        primarySource: provider
      }));
    }
  }

  return merged;
}

module.exports = { normalizeTeamName, normalizeCompetitionName, canonicalKey, isSameMatch, mergeProviderMatches, KICKOFF_TOLERANCE_MS };
