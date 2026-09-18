// lib/matchStatus.js — maps every provider's own status strings onto the
// ONE vocabulary the rest of this app already uses (SCHEDULED, IN_PLAY,
// PAUSED, FINISHED, POSTPONED, CANCELLED, SUSPENDED). Shared by every NEW
// provider adapter (api-football, sportmonks, thesportsdb, highlightly,
// api-sports). bigFootballData.js keeps its own copy of this mapping
// (written and confirmed against real responses already) — deliberately
// left untouched here to avoid any risk of regressing something already
// working.
const STATUS_MAP = {
  // generic
  'scheduled': 'SCHEDULED', 'not_started': 'SCHEDULED', 'ns': 'SCHEDULED', 'upcoming': 'SCHEDULED', 'timed': 'SCHEDULED', 'tbd': 'SCHEDULED',
  'live': 'IN_PLAY', 'in_play': 'IN_PLAY', 'inplay': 'IN_PLAY', '1h': 'IN_PLAY', '2h': 'IN_PLAY', 'playing': 'IN_PLAY', 'et': 'IN_PLAY', 'p': 'IN_PLAY',
  'ht': 'PAUSED', 'halftime': 'PAUSED', 'half_time': 'PAUSED', 'paused': 'PAUSED', 'break': 'PAUSED',
  'finished': 'FINISHED', 'ft': 'FINISHED', 'full_time': 'FINISHED', 'ended': 'FINISHED', 'complete': 'FINISHED', 'aet': 'FINISHED', 'pen': 'FINISHED',
  'postponed': 'POSTPONED', 'pst': 'POSTPONED',
  'cancelled': 'CANCELLED', 'canceled': 'CANCELLED', 'abd': 'CANCELLED', 'awarded': 'CANCELLED', 'wo': 'CANCELLED',
  'suspended': 'SUSPENDED', 'susp': 'SUSPENDED', 'int': 'SUSPENDED',
  // Sportmonks numeric-ish state names sometimes come through as short codes
  'inplay_1st_half': 'IN_PLAY', 'inplay_2nd_half': 'IN_PLAY', 'inplay_et': 'IN_PLAY'
};

const logged = new Set();
function normalizeStatus(raw, providerLabel) {
  if (!raw) return 'SCHEDULED';
  const key = String(raw).toLowerCase().trim();
  if (STATUS_MAP[key]) return STATUS_MAP[key];
  const logKey = (providerLabel || '?') + ':' + key;
  if (!logged.has(logKey)) {
    logged.add(logKey);
    console.warn('[matchStatus] unrecognized status "' + raw + '" from ' + (providerLabel || 'unknown provider') + ' — passing through uppercased. Add a mapping in lib/matchStatus.js if this should map to a known status.');
  }
  return String(raw).toUpperCase();
}

module.exports = { normalizeStatus };
