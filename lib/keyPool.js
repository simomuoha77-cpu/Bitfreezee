// lib/keyPool.js — generic multi-API-key rotation pool, shared by every
// football data provider (bigballsdata, api-football, football-data.org,
// sportmonks, thesportsdb, highlightly, api-sports).
//
// Add more keys by editing the provider's env var (comma-separated) —
// nothing in this file or any provider adapter needs to change.
//
// Tracks per key: active/inactive, request/success/failure counts, last
// request time, last SUCCESSFUL request time, and a cooldown window (used
// for both real 429s and generic transient failures, with exponential
// backoff on repeats). A key that comes back 401/403 (bad/revoked
// credentials) is marked permanently inactive for this process — retrying
// a dead key on every cycle wastes a rotation slot forever otherwise.
//
// This is about spreading load across the keys YOU'VE configured, not
// about evading a provider's own rate limits or terms — see the top-level
// request this was built for.

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return key[0] + '***';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function createKeyPool(providerLabel, rawEnvValue) {
  const keys = (rawEnvValue || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  const state = keys.map((key, index) => ({
    index,
    key,
    masked: maskKey(key),
    active: true,
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    lastRequest: null,
    lastSuccess: null,
    cooldownUntil: 0,
    cooldownReason: null
  }));

  let pointer = -1;

  function isConfigured() {
    return keys.length > 0;
  }

  function keyCount() {
    return keys.length;
  }

  // Round-robin across ACTIVE, not-currently-cooling-down keys. Returns
  // null when every configured key is either inactive or cooling down —
  // callers should treat that as "provider temporarily unavailable", not
  // an error to retry immediately.
  function getKey() {
    const now = Date.now();
    for (let attempt = 0; attempt < state.length; attempt++) {
      pointer = (pointer + 1) % state.length;
      const s = state[pointer];
      if (s.active && now >= s.cooldownUntil) return s;
    }
    return null;
  }

  function reportSuccess(slot) {
    slot.requestCount++;
    slot.successCount++;
    slot.consecutiveFailures = 0;
    slot.lastRequest = Date.now();
    slot.lastSuccess = Date.now();
    slot.cooldownReason = null;
  }

  // opts: { status, retryAfterMs, permanent }
  function reportFailure(slot, opts) {
    opts = opts || {};
    slot.requestCount++;
    slot.failureCount++;
    slot.consecutiveFailures++;
    slot.lastRequest = Date.now();

    if (opts.permanent || opts.status === 401 || opts.status === 403) {
      slot.active = false;
      slot.cooldownReason = 'auth (' + (opts.status || 'permanent') + ') — key marked inactive for this run';
      return;
    }

    const backoffBase = opts.status === 429 ? 60 * 1000 : 5 * 1000;
    const backoffCap = opts.status === 429 ? 30 * 60 * 1000 : 10 * 60 * 1000;
    const scaled = backoffBase * Math.pow(2, Math.min(slot.consecutiveFailures - 1, 6));
    const cooldownMs = opts.retryAfterMs != null ? opts.retryAfterMs : Math.min(backoffCap, scaled);
    slot.cooldownUntil = Date.now() + cooldownMs;
    slot.cooldownReason = (opts.status ? 'HTTP ' + opts.status : 'request error') + ', cooling down ' + Math.round(cooldownMs / 1000) + 's';
  }

  function getStatus() {
    const now = Date.now();
    return {
      provider: providerLabel,
      configured: isConfigured(),
      totalKeys: state.length,
      availableKeys: state.filter(s => s.active && now >= s.cooldownUntil).length,
      keys: state.map(s => ({
        index: s.index,
        masked: s.masked,
        active: s.active,
        requestCount: s.requestCount,
        successCount: s.successCount,
        failureCount: s.failureCount,
        consecutiveFailures: s.consecutiveFailures,
        lastRequest: s.lastRequest,
        lastSuccess: s.lastSuccess,
        coolingDown: now < s.cooldownUntil,
        cooldownRemainingMs: Math.max(0, s.cooldownUntil - now),
        cooldownReason: s.cooldownReason
      }))
    };
  }

  return { providerLabel, isConfigured, keyCount, getKey, reportSuccess, reportFailure, getStatus };
}

module.exports = { createKeyPool, maskKey };
