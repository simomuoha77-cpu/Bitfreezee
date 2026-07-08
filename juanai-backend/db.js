// db.js — fixtures use a simple JSON file (self-healing every 15 min via the
// scheduler, so file-based storage is fine for them — see saveFixtures below).
//
// API keys use MongoDB Atlas instead, because Render's free tier has an
// EPHEMERAL filesystem: any local file (including the old data/apikeys.json)
// gets wiped every time the service restarts, redeploys, or spins down from
// inactivity — which free services do automatically. That was the actual
// cause of API keys "disappearing" — nothing was deleting them on purpose,
// Render was just resetting its disk as normal free-tier behavior. MongoDB
// Atlas is a separate, persistent service, so keys survive restarts.

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const DATA_DIR = path.join(__dirname, 'data');
const FIXTURES_FILE = path.join(DATA_DIR, 'fixtures.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FIXTURES_FILE)) fs.writeFileSync(FIXTURES_FILE, '{}');

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

// ── Fixtures storage (unchanged — plain file is fine, see note above) ────

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

// Merge/update a single match's AI odds into whichever days-bucket it lives in.
function upsertMatchOdds(matchId, days, odds) {
  const all = readJson(FIXTURES_FILE) || {};
  const bucket = all[String(days)];
  if (!bucket || !Array.isArray(bucket.matches)) return false;

  let found = false;
  bucket.matches = bucket.matches.map(m => {
    if (String(m.id) === String(matchId)) {
      found = true;
      return {
        ...m,
        aiOdds: odds,
        aiPrediction: odds.prediction,
        aiConfidence: odds.confidence,
        aiAnalysis: odds.analysis,
        aiXG: { home: odds.xgHome, away: odds.xgAway },
        aiValueBet: odds.valueBet,
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

// ── API key storage — MongoDB Atlas (persists across Render restarts) ────

const MONGO_URI = process.env.MONGO_URI || '';
const DB_NAME = 'juanai';
const COLLECTION = 'apikeys';

let client = null;
let collection = null;
let mongoReady = false;
let mongoConnectAttempted = false;

// A small in-memory fallback so the server doesn't hard-crash if MONGO_URI
// is missing/unreachable — keys just won't survive a restart in that case,
// same as before, but at least the API Keys panel keeps working within a
// single running instance instead of throwing errors on every request.
let memoryFallback = [];
let usingFallback = false;

async function connectMongo() {
  if (mongoConnectAttempted) return;
  mongoConnectAttempted = true;

  if (!MONGO_URI) {
    console.warn('[db] MONGO_URI not set — API keys will use in-memory storage and will NOT survive a restart. Set MONGO_URI on Render to fix this permanently.');
    usingFallback = true;
    return;
  }

  try {
    client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db(DB_NAME);
    collection = db.collection(COLLECTION);
    await collection.createIndex({ key: 1 }, { unique: true });
    mongoReady = true;
    usingFallback = false;
    console.log('[db] Connected to MongoDB Atlas — API keys will persist across restarts.');
  } catch (e) {
    console.error('[db] MongoDB connection FAILED — falling back to in-memory API key storage (will not survive a restart): ' + e.message);
    usingFallback = true;
  }
}

// Kick off the connection attempt immediately on module load; callers await
// ensureMongo() before touching `collection` so nothing races the connect.
const initialConnect = connectMongo();
async function ensureMongo() {
  await initialConnect;
}

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'jsk_';
  for (let i = 0; i < 32; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

async function getApiKeys() {
  await ensureMongo();
  if (usingFallback) return memoryFallback;
  try {
    return await collection.find({}).sort({ createdAt: -1 }).toArray();
  } catch (e) {
    console.error('[db] getApiKeys failed, falling back to in-memory: ' + e.message);
    return memoryFallback;
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
    memoryFallback.push(record);
    return record;
  }
  try {
    await collection.insertOne(record);
    return record;
  } catch (e) {
    console.error('[db] addApiKey failed, falling back to in-memory: ' + e.message);
    memoryFallback.push(record);
    return record;
  }
}

async function isValidApiKey(key) {
  if (!key) return false;
  await ensureMongo();
  if (usingFallback) {
    const found = memoryFallback.find(k => k.key === key && k.active);
    if (!found) return false;
    found.requests = (found.requests || 0) + 1;
    found.lastUsedAt = new Date().toISOString();
    return true;
  }
  try {
    const found = await collection.findOne({ key, active: true });
    if (!found) return false;
    await collection.updateOne(
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
    memoryFallback = memoryFallback.filter(k => k.id !== Number(id));
    return;
  }
  try {
    await collection.deleteOne({ id: Number(id) });
  } catch (e) {
    console.error('[db] revokeApiKey failed: ' + e.message);
  }
}

function getMongoStatus() {
  if (!MONGO_URI) return { configured: false, connected: false, note: 'MONGO_URI not set — API keys stored in-memory only, will NOT survive a restart' };
  return {
    configured: true,
    connected: mongoReady && !usingFallback,
    note: mongoReady && !usingFallback
      ? 'Connected — API keys persist across restarts'
      : 'MONGO_URI set but connection failed — API keys stored in-memory only, will NOT survive a restart'
  };
}

module.exports = {
  saveFixtures,
  getFixtures,
  upsertMatchOdds,
  getApiKeys,
  addApiKey,
  isValidApiKey,
  revokeApiKey,
  getMongoStatus,
  ensureMongo
};
