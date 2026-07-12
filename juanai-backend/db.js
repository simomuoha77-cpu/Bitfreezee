// db.js — simple JSON-file store.
// No native modules (no better-sqlite3), so this installs cleanly on Termux/Android
// with just `npm install express cors`. Swap for real SQLite/Mongo later if you
// outgrow this — the function signatures below won't need to change.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FIXTURES_FILE = path.join(DATA_DIR, 'fixtures.json');
const KEYS_FILE = path.join(DATA_DIR, 'apikeys.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FIXTURES_FILE)) fs.writeFileSync(FIXTURES_FILE, '{}');
if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, '[]');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

function writeJson(file, data) {
  // write to temp file then rename — avoids corruption if process dies mid-write
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ── Fixtures storage ──────────────────────────────────────────────
// Stored keyed by "days" bucket (0 = today, 1 = tomorrow, etc), matching
// the same shape JuanAi's frontend already uses for jfb_fixtures_<days>.

function saveFixtures(days, matches) {
  const all = readJson(FIXTURES_FILE) || {};
  all[String(days)] = {
    matches,
    fetchedAt: Date.now(),
    updatedAt: new Date().toISOString()
  };
  writeJson(FIXTURES_FILE, all);
}

function getFixtures(days) {
  const all = readJson(FIXTURES_FILE) || {};
  return all[String(days)] || null;
}

// Merge/update a single match's REAL bookmaker odds (from oddsData.js) into
// whichever days-bucket it lives in. This is separate from the AI analysis
// step -- real odds can be cached and refreshed on their own schedule.
function upsertRealOdds(matchId, days, realOdds) {
  const all = readJson(FIXTURES_FILE) || {};
  const bucket = all[String(days)];
  if (!bucket || !Array.isArray(bucket.matches)) return false;

  let found = false;
  bucket.matches = bucket.matches.map(m => {
    if (String(m.id) === String(matchId)) {
      found = true;
      return {
        ...m,
        realOdds,
        realOddsFetchedAt: Date.now(),
        oddsUnavailable: false
      };
    }
    return m;
  });
  bucket.updatedAt = new Date().toISOString();
  all[String(days)] = bucket;
  writeJson(FIXTURES_FILE, all);
  return found;
}

// Marks that we checked for real odds and none were posted yet (e.g. match is
// too far out for bookmakers to have priced it). Prevents re-checking every
// single pass while still being honest that no real odds exist yet.
function markOddsUnavailable(matchId, days) {
  const all = readJson(FIXTURES_FILE) || {};
  const bucket = all[String(days)];
  if (!bucket || !Array.isArray(bucket.matches)) return false;

  let found = false;
  bucket.matches = bucket.matches.map(m => {
    if (String(m.id) === String(matchId)) {
      found = true;
      return { ...m, oddsUnavailable: true, realOddsFetchedAt: Date.now() };
    }
    return m;
  });
  all[String(days)] = bucket;
  writeJson(FIXTURES_FILE, all);
  return found;
}

// Merge/update a single match's AI analysis (built on top of real odds) into
// whichever days-bucket it lives in.
function upsertMatchOdds(matchId, days, result) {
  const all = readJson(FIXTURES_FILE) || {};
  const bucket = all[String(days)];
  if (!bucket || !Array.isArray(bucket.matches)) return false;

  let found = false;
  bucket.matches = bucket.matches.map(m => {
    if (String(m.id) === String(matchId)) {
      found = true;
      return {
        ...m,
        aiOdds: result,
        aiPrediction: result.prediction,
        aiConfidence: result.confidence,
        aiAnalysis: result.analysis,
        aiValueBet: result.valueBet,
        aiAnalyzedAt: Date.now()
      };
    }
    return m;
  });
  bucket.updatedAt = new Date().toISOString();
  all[String(days)] = bucket;
  writeJson(FIXTURES_FILE, all);
  return found;
}

// ── API key storage ───────────────────────────────────────────────

function getApiKeys() {
  return readJson(KEYS_FILE) || [];
}

function saveApiKeys(keys) {
  writeJson(KEYS_FILE, keys);
}

function addApiKey(name, key) {
  const keys = getApiKeys();
  const record = {
    id: Date.now(),
    name,
    key,
    createdAt: new Date().toISOString(),
    requests: 0,
    active: true
  };
  keys.push(record);
  saveApiKeys(keys);
  return record;
}

function isValidApiKey(key) {
  if (!key) return false;
  const keys = getApiKeys();
  const found = keys.find(k => k.key === key && k.active);
  if (!found) return false;
  found.requests = (found.requests || 0) + 1;
  found.lastUsedAt = new Date().toISOString();
  saveApiKeys(keys);
  return true;
}

function revokeApiKey(id) {
  const keys = getApiKeys().filter(k => k.id !== Number(id));
  saveApiKeys(keys);
}

module.exports = {
  saveFixtures,
  getFixtures,
  upsertRealOdds,
  markOddsUnavailable,
  upsertMatchOdds,
  getApiKeys,
  addApiKey,
  isValidApiKey,
  revokeApiKey
};
