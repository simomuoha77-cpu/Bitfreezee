// db.js — fixtures + odds are stored in MongoDB Atlas, same as API keys.
//
// WHY THIS MOVED FROM A LOCAL FILE: Render's free tier has an EPHEMERAL
// filesystem — any local file gets wiped every time the service restarts,
// redeploys, or spins down from inactivity (which free services do
// automatically). That was already the cause of API keys "disappearing"
// earlier, and it turned out to affect fixtures/odds too: every deploy was
// silently discarding all completed AI analysis, forcing a full re-analysis
// of a 2000+ match backlog from scratch on every single push. MongoDB is a
// separate, persistent service, so this data now survives restarts.
//
// SCHEMA: one document per match (not one per day-bucket) in the
// "fixtures" collection, keyed by match id + days bucket. This means
// updating one match's odds is a single atomic upsert that only touches
// that match — not a read-modify-write of an entire day's fixture list —
// so odds updates apply immediately and show up on the very next read from
// anywhere (JuanAi's own UI, BetaKE's API calls), with no risk of two
// concurrent writes clobbering each other's unrelated changes.

const { MongoClient } = require('mongodb');
const footballData = require('./footballData');

const MONGO_URI = process.env.MONGO_URI || '';
const DB_NAME = 'juanai';
const FIXTURES_COLLECTION = 'fixtures';
const KEYS_COLLECTION = 'apikeys';

let client = null;
let mongoReady = false;
let mongoConnectAttempted = false;
let fixturesCollection = null;
let apiKeysCollection = null;

// In-memory fallback so the server keeps working (within a single running
// instance) if MONGO_URI is missing/unreachable — same safety net pattern
// as the API-key storage already uses. Data won't survive a restart in
// this fallback mode, which is the exact problem we're fixing, so this is
// only a "don't crash" safety net, not a real substitute for Mongo.
let fixturesFallback = {}; // keyed by `${days}` -> { matches: [...], fetchedAt, updatedAt }
let apiKeysFallback = [];
let usingFallback = false;

async function connectMongo() {
  if (mongoConnectAttempted) return;
  mongoConnectAttempted = true;

  if (!MONGO_URI) {
    console.warn('[db] MONGO_URI not set — fixtures/odds AND API keys will use in-memory storage and will NOT survive a restart. Set MONGO_URI on Render to fix this permanently.');
    usingFallback = true;
    return;
  }

  try {
    client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db(DB_NAME);
    fixturesCollection = db.collection(FIXTURES_COLLECTION);
    apiKeysCollection = db.collection(KEYS_COLLECTION);
    await fixturesCollection.createIndex({ matchId: 1, days: 1 }, { unique: true });
    await fixturesCollection.createIndex({ days: 1 }); // for fetching a whole day-bucket efficiently
    await apiKeysCollection.createIndex({ key: 1 }, { unique: true });
    mongoReady = true;
    usingFallback = false;
    console.log('[db] Connected to MongoDB Atlas — fixtures/odds AND API keys will persist across restarts.');
  } catch (e) {
    console.error('[db] MongoDB connection FAILED — falling back to in-memory storage (will not survive a restart): ' + e.message);
    usingFallback = true;
  }
}

const initialConnect = connectMongo();
async function ensureMongo() {
  await initialConnect;
}

// ── Fixtures storage ───────────────────────────────────────────────

// Replaces an entire day-bucket's match list — called by the scheduler's
// fixture refresh. Uses bulkWrite upserts keyed by (matchId, days) so
// existing per-match aiOdds data is naturally preserved for any match that
// appears in both the old and new fetch (MongoDB just updates the fields
// we send; if we don't include aiOdds in this call, it stays untouched —
// unlike the old file-based approach, we don't need to manually copy prior
// odds forward, since we're not overwriting the whole bucket anymore).
async function saveFixtures(days, matches) {
  await ensureMongo();
  const now = new Date().toISOString();

  if (usingFallback) {
    const existing = fixturesFallback[String(days)];
    const existingById = {};
    if (existing) existing.matches.forEach(m => { existingById[String(m.id)] = m; });
    const merged = matches.map(m => {
      const prev = existingById[String(m.id)];
      return prev && prev.aiOdds ? Object.assign({}, m, { aiOdds: prev.aiOdds, aiPrediction: prev.aiPrediction, aiConfidence: prev.aiConfidence, aiAnalysis: prev.aiAnalysis, aiXG: prev.aiXG, aiValueBet: prev.aiValueBet, aiAnalyzedAt: prev.aiAnalyzedAt }) : m;
    });
    fixturesFallback[String(days)] = { matches: merged, fetchedAt: Date.now(), updatedAt: now };
    // Same cross-bucket cleanup in fallback mode — see the real-Mongo path
    // below for why this matters.
    Object.keys(fixturesFallback).forEach(otherDays => {
      if (otherDays === String(days)) return;
      const bucket = fixturesFallback[otherDays];
      if (!bucket) return;
      const matchIds = new Set(matches.map(m => String(m.id)));
      bucket.matches = bucket.matches.filter(m => !matchIds.has(String(m.id)));
    });
    return;
  }

  try {
    const ops = matches.map(m => ({
      updateOne: {
        filter: { matchId: String(m.id), days: String(days) },
        // $set updates the match's base fixture data (teams, date, status,
        // score) WITHOUT touching aiOdds/aiPrediction/etc — those fields are
        // only ever written by upsertMatchOdds below, so a fixture refresh
        // can never accidentally wipe out existing analysis.
        update: { $set: { matchId: String(m.id), days: String(days), match: m, fetchedAt: Date.now(), updatedAt: now } },
        upsert: true
      }
    }));
    if (ops.length) await fixturesCollection.bulkWrite(ops);

    // CROSS-BUCKET CLEANUP: a match's kickoff timing can cause it to
    // legitimately satisfy TWO different day-buckets' inclusion criteria at
    // once (e.g. a match near a midnight boundary, or odds-api.io's
    // "still-live from previous day" window overlapping two buckets'
    // checks independently) — this was the actual cause of a match showing
    // FINISHED in one bucket and stuck LIVE in another, since each bucket
    // tracked its own independent copy that never reconciled. Deleting the
    // match from every OTHER bucket whenever we save it into this one
    // guarantees exactly one authoritative copy exists at any time — the
    // most recently refreshed one.
    const matchIds = matches.map(m => String(m.id));
    if (matchIds.length) {
      await fixturesCollection.deleteMany({
        matchId: { $in: matchIds },
        days: { $ne: String(days) }
      });
    }
  } catch (e) {
    console.error('[db] saveFixtures failed, falling back to in-memory: ' + e.message);
    fixturesFallback[String(days)] = { matches, fetchedAt: Date.now(), updatedAt: now };
  }
}

async function getFixtures(days) {
  await ensureMongo();
  if (usingFallback) return fixturesFallback[String(days)] || null;

  try {
    const docs = await fixturesCollection.find({ days: String(days) }).toArray();
    if (!docs.length) return null;
    const matches = docs.map(d => {
      let m = Object.assign({}, d.match, d.aiOdds ? {
        aiOdds: d.aiOdds,
        aiPrediction: d.aiPrediction,
        aiConfidence: d.aiConfidence,
        aiAnalysis: d.aiAnalysis,
        aiXG: d.aiXG,
        aiValueBet: d.aiValueBet,
        aiAnalyzedAt: d.aiAnalyzedAt
      } : {});
      // Recalculate the estimated live minute at READ time, not just at the
      // last save — this keeps it advancing in near-real-time (checked on
      // every API/UI request) instead of only updating every 2 minutes
      // when the fixture refresh job happens to run. Only applies to
      // odds-api.io-sourced matches still IN_PLAY; football-data.org's
      // minute is already a real value from the source, left untouched.
      if (m.minuteIsEstimated && m.status === 'IN_PLAY' && m.utcDate) {
        m.minute = footballData.estimateMatchMinute(m.utcDate);
      }
      return m;
    });
    const updatedAt = docs.reduce((latest, d) => d.updatedAt > latest ? d.updatedAt : latest, docs[0].updatedAt);
    const fetchedAt = Math.max(...docs.map(d => d.fetchedAt || 0));
    return { matches, fetchedAt, updatedAt };
  } catch (e) {
    console.error('[db] getFixtures failed, falling back to in-memory: ' + e.message);
    return fixturesFallback[String(days)] || null;
  }
}

// Updates ONLY the odds fields for one specific match — this is the atomic
// write that means a re-analysis (e.g. odds moving from 2.0 to 3.1 as new
// info comes in, or a live repricing) shows up immediately on the next
// read, from JuanAi's UI or BetaKE's API call, with no risk of clobbering
// unrelated fixture data written by a concurrent saveFixtures call.
async function upsertMatchOdds(matchId, days, odds) {
  await ensureMongo();
  const now = Date.now();

  if (usingFallback) {
    const bucket = fixturesFallback[String(days)];
    if (!bucket) return false;
    let found = false;
    bucket.matches = bucket.matches.map(m => {
      if (String(m.id) === String(matchId)) {
        found = true;
        return Object.assign({}, m, { aiOdds: odds, aiPrediction: odds.prediction, aiConfidence: odds.confidence, aiAnalysis: odds.analysis, aiXG: { home: odds.xgHome, away: odds.xgAway }, aiValueBet: odds.valueBet, aiAnalyzedAt: now });
      }
      return m;
    });
    bucket.updatedAt = new Date().toISOString();
    return found;
  }

  try {
    const result = await fixturesCollection.updateOne(
      { matchId: String(matchId), days: String(days) },
      {
        $set: {
          aiOdds: odds,
          aiPrediction: odds.prediction,
          aiConfidence: odds.confidence,
          aiAnalysis: odds.analysis,
          aiXG: { home: odds.xgHome, away: odds.xgAway },
          aiValueBet: odds.valueBet,
          aiAnalyzedAt: now,
          updatedAt: new Date().toISOString()
        }
      }
    );
    return result.matchedCount > 0;
  } catch (e) {
    console.error('[db] upsertMatchOdds failed: ' + e.message);
    return false;
  }
}
// ── API key storage (uses the SAME MongoDB connection as fixtures above) ──

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'jsk_';
  for (let i = 0; i < 32; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

async function getApiKeys() {
  await ensureMongo();
  if (usingFallback) return apiKeysFallback;
  try {
    return await apiKeysCollection.find({}).sort({ createdAt: -1 }).toArray();
  } catch (e) {
    console.error('[db] getApiKeys failed, falling back to in-memory: ' + e.message);
    return apiKeysFallback;
  }
}

async function addApiKey(name) {
  await ensureMongo();
  const record = {
    id: Date.now(),
    name: name || 'Unnamed key',
    key: generateApiKey(),
    createdAt: new Date().toISOString(),
    requests: 0,
    active: true
  };
  if (usingFallback) {
    apiKeysFallback.push(record);
    return record;
  }
  try {
    await apiKeysCollection.insertOne(record);
    return record;
  } catch (e) {
    console.error('[db] addApiKey failed, falling back to in-memory: ' + e.message);
    apiKeysFallback.push(record);
    return record;
  }
}

async function isValidApiKey(key) {
  if (!key) return false;
  await ensureMongo();
  if (usingFallback) {
    const found = apiKeysFallback.find(k => k.key === key && k.active);
    if (!found) return false;
    found.requests = (found.requests || 0) + 1;
    found.lastUsedAt = new Date().toISOString();
    return true;
  }
  try {
    const found = await apiKeysCollection.findOne({ key, active: true });
    if (!found) return false;
    await apiKeysCollection.updateOne(
      { key },
      { $inc: { requests: 1 }, $set: { lastUsedAt: new Date().toISOString() } }
    );
    return true;
  } catch (e) {
    console.error('[db] isValidApiKey failed: ' + e.message);
    return false;
  }
}

async function revokeApiKey(id) {
  await ensureMongo();
  if (usingFallback) {
    apiKeysFallback = apiKeysFallback.filter(k => k.id !== Number(id));
    return;
  }
  try {
    await apiKeysCollection.deleteOne({ id: Number(id) });
  } catch (e) {
    console.error('[db] revokeApiKey failed: ' + e.message);
  }
}

function getMongoStatus() {
  if (!MONGO_URI) return { configured: false, connected: false, note: 'MONGO_URI not set — fixtures/odds AND API keys stored in-memory only, will NOT survive a restart' };
  return {
    configured: true,
    connected: mongoReady && !usingFallback,
    note: mongoReady && !usingFallback
      ? 'Connected — fixtures/odds AND API keys persist across restarts'
      : 'MONGO_URI set but connection failed — fixtures/odds AND API keys stored in-memory only, will NOT survive a restart'
  };
}

// Clears any previously-generated odds fields from a match — used to
// self-heal matches that got bad odds before the TBD/unknown-team filter
// existed. Safe no-op if the match never had odds in the first place.
async function clearMatchOdds(matchId, days) {
  await ensureMongo();
  if (usingFallback) {
    const bucket = fixturesFallback[String(days)];
    if (!bucket) return;
    bucket.matches = bucket.matches.map(m => {
      if (String(m.id) === String(matchId)) {
        const { aiOdds, aiPrediction, aiConfidence, aiAnalysis, aiXG, aiValueBet, aiAnalyzedAt, ...rest } = m;
        return rest;
      }
      return m;
    });
    return;
  }
  try {
    await fixturesCollection.updateOne(
      { matchId: String(matchId), days: String(days) },
      { $unset: { aiOdds: '', aiPrediction: '', aiConfidence: '', aiAnalysis: '', aiXG: '', aiValueBet: '', aiAnalyzedAt: '' } }
    );
  } catch (e) {
    console.error('[db] clearMatchOdds failed: ' + e.message);
  }
}

// Deletes any match whose kickoff was long enough ago that it is certainly
// over by now, REGARDLESS of what status any data source reports for it.
// This is the real fix for matches getting stuck showing as live/pending
// forever: odds-api.io doesn't have a true "in progress" status (only
// pending/settled/cancelled — confirmed via direct testing), and if a
// match ages out of odds-api.io's own /events feed before ever being
// marked "settled", nothing else would ever touch it again — it would just
// sit in the database with its last-known status permanently. A football
// match plus stoppage/extra time essentially never exceeds ~3 hours, so
// anything older than that is deleted outright — not just hidden — freeing
// the space and guaranteeing it can never show as live/pending again.
async function expireOldMatches() {
  await ensureMongo();
  const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // matches that kicked off more than 3 hours ago, regardless of reported status

  if (usingFallback) {
    let deletedCount = 0;
    Object.keys(fixturesFallback).forEach(days => {
      const bucket = fixturesFallback[days];
      if (!bucket) return;
      const before = bucket.matches.length;
      // Two deletion conditions: (1) explicitly FINISHED — delete
      // immediately, no need to wait for the time cutoff since we already
      // KNOW it's over; (2) time-based cutoff as a catch-all for matches
      // odds-api.io never marks "settled" at all.
      bucket.matches = bucket.matches.filter(m => m.status !== 'FINISHED' && (!m.utcDate || m.utcDate >= cutoff));
      deletedCount += before - bucket.matches.length;
    });
    return deletedCount;
  }

  try {
    // match.utcDate and match.status are both stored inside the nested
    // `match` object. Delete anything explicitly FINISHED immediately, OR
    // anything older than the time cutoff regardless of status (the
    // catch-all for matches odds-api.io never marks "settled"), OR anything
    // sitting in a day-bucket that's no longer refreshed at all (days 3-7,
    // orphaned when DAY_BUCKETS shrank to [0,1,2] to keep analysis volume
    // sustainable — this data would otherwise sit forever with no bucket
    // ever touching it again).
    const result = await fixturesCollection.deleteMany({
      $or: [
        { 'match.status': 'FINISHED' },
        { 'match.utcDate': { $lt: cutoff, $ne: null } },
        { days: { $in: ['3', '4', '5', '6', '7'] } }
      ]
    });
    return result.deletedCount || 0;
  } catch (e) {
    console.error('[db] expireOldMatches failed: ' + e.message);
    return 0;
  }
}

module.exports = {
  saveFixtures,
  getFixtures,
  upsertMatchOdds,
  clearMatchOdds,
  expireOldMatches,
  getApiKeys,
  addApiKey,
  isValidApiKey,
  revokeApiKey,
  getMongoStatus,
  ensureMongo
};
