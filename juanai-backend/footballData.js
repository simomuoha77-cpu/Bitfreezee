// footballData.js — real fixtures from football-data.org, fetched server-side.
//
// CORS never applies to server-to-server requests, so unlike the browser
// version in JuanAi's frontend, this doesn't need proxy workarounds or a
// "demo fixtures" fallback. If this fails, callers should surface the real
// error — never substitute fabricated matches.

const FDORG_KEY = process.env.FDORG_KEY || '881689e6b5a341c6bdd557bfa6c55834';
const FDORG_BASE = 'https://api.football-data.org/v4';

// Free tier = 10 requests/minute. Keep a healthy margin below that everywhere
// this module is used from (see scheduler.js for the cron pacing).
const MIN_MS_BETWEEN_CALLS = 6500; // ~9.2 req/min ceiling
let lastCallAt = 0;

async function throttle() {
  const wait = MIN_MS_BETWEEN_CALLS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function fdFetch(endpoint) {
  await throttle();
  const url = FDORG_BASE + endpoint;
  const resp = await fetch(url, { headers: { 'X-Auth-Token': FDORG_KEY } });
  if (resp.status === 429) {
    throw new Error('football-data.org rate limit hit (429) — back off and retry later');
  }
  if (!resp.ok) {
    throw new Error(`football-data.org HTTP ${resp.status}`);
  }
  return resp.json();
}

// Returns real matches for a given date (YYYY-MM-DD). Throws on failure —
// callers must not paper over this with sample/demo data.
async function getMatchesForDate(dateStr) {
  const data = await fdFetch('/matches?date=' + dateStr);
  return data.matches || [];
}

function getDateString(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + parseInt(daysAhead || 0, 10));
  return d.toISOString().split('T')[0];
}

module.exports = { getMatchesForDate, getDateString };
