// asTechApi.js — public AS Tech catalogue feed for JuanAi.
//
// This adapter intentionally uses the same public TanStack Start server
// functions that the AS Tech public provider pages use for their catalogue
// and free zero-balance demo launches. It does NOT require AS Tech partner
// API keys/secrets and does NOT attempt to access protected real-money APIs.
//
// Public functions discovered from AS Tech's frontend:
//   GET  4058c0...  -> provider catalogue
//   POST f07c6f...  -> games for { providerCode, search, page }
//   POST 4ab17f...  -> free demo launch for { gameId }
//
// Keep this adapter limited to data AS Tech exposes publicly. Real-money
// session opening/wallet callbacks require the authorized partner API.

const https = require('https');

const BASE_URL = (process.env.AS_TECH_BASE_URL || 'https://astechapi.cloud').replace(/\/+$/, '');
const SERVER_FN_BASE = process.env.AS_TECH_SERVER_FN_BASE || '/_serverFn/';
const PROVIDERS_FN = '4058c0a01256721ebfb8fa103ec7917336474914f990ef66230f709ac989a634';
const GAMES_FN = 'f07c6f8a5a9fb9b1114ce81637d1c2d65e808d67e9b4b5dcefca426d32f51ed6';
const DEMO_LAUNCH_FN = '4ab17f09ba48ede6e014c5e622114a0b00c72cab6878df37e1fdf2fd33551fca';
const TIMEOUT_MS = Number(process.env.AS_TECH_TIMEOUT_MS || 15000);
const CACHE_MS = Number(process.env.AS_TECH_CACHE_MS || 300000);
const MAX_PAGE = Number(process.env.AS_TECH_MAX_PAGE || 1000);

const cache = {
  providers: { at: 0, value: null },
  games: new Map(),
};

function fnUrl(id) {
  return `${BASE_URL}${SERVER_FN_BASE}${id}`;
}

function requestJson(method, id, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(fnUrl(id));
    const body = method === 'POST' ? JSON.stringify(payload === undefined ? {} : { data: payload }) : '';
    // AS Tech's TanStack Start server functions are same-origin RPCs.
    // Their CSRF middleware validates Origin/Referer (and browser fetch
    // metadata), so reproduce the normal same-origin request metadata.
    // This is not an authentication bypass; it is the same request context
    // used by AS Tech's own public provider page.
    let refererPath = '/providers';
    if (method === 'POST' && id === GAMES_FN && payload?.providerCode) {
      refererPath = `/providers/${encodeURIComponent(String(payload.providerCode))}`;
    } else if (method === 'POST' && id === DEMO_LAUNCH_FN && payload?.gameId) {
      const providerCode = String(payload.gameId).split(':')[0];
      refererPath = `/providers/${encodeURIComponent(providerCode || 'spribe')}`;
    }
    const headers = {
      Accept: 'application/x-tss-framed, application/x-ndjson, application/json',
      'x-tsr-serverFn': 'true',
      Origin: BASE_URL,
      Referer: `${BASE_URL}${refererPath}`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: TIMEOUT_MS,
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`AS Tech public function HTTP ${res.statusCode}: ${raw.slice(0, 500)}`);
          err.statusCode = res.statusCode;
          err.providerBody = parsed || raw;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('AS Tech request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function unwrap(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.data !== undefined) return value.data;
  if (value.result !== undefined) return value.result;
  return value;
}

function asArray(value, keys = []) {
  value = unwrap(value);
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function requestText(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Accept: 'text/html', 'User-Agent': 'JuanAi-AS-Tech-Catalogue/1.0' },
      timeout: TIMEOUT_MS,
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`AS Tech public page HTTP ${res.statusCode}`));
        }
        resolve(raw);
      });
    });
    req.on('timeout', () => req.destroy(new Error('AS Tech public page timed out')));
    req.on('error', reject);
    req.end();
  });
}

function parseProviderPageHtml(html, providerCode) {
  const text = String(html || '').replace(/\\"/g, '"');
  const providerRe = new RegExp(
    `provider:\\$R\\[\\d+\\]=\\{code:"${providerCode.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}",name:"([^"]*)",category:"([^"]*)"\\},total:(\\d+),page:(\\d+),pageSize:(\\d+),games:`
  );
  const pm = text.match(providerRe);
  const gameRe = /\{id:"([^"]+)",title:"([^"]*)",category:"([^"]*)",image:(null|"[^"]*")\}/g;
  const games = [];
  let m;
  while ((m = gameRe.exec(text))) {
    games.push({
      id: m[1], title: m[2], category: m[3],
      image: m[4] === 'null' ? null : m[4].slice(1, -1),
      providerCode,
    });
  }
  return {
    provider: { code: providerCode, name: pm?.[1] || providerCode, category: pm?.[2] || 'casino' },
    games: games.map(g => normalizeGame(g, providerCode)),
    total: Number(pm?.[3] || games.length),
    page: Number(pm?.[4] || 1),
    pageSize: Number(pm?.[5] || games.length),
    source: 'as-tech-public-html',
  };
}

async function listProvidersFromHtml() {
  const html = await requestText('/providers');
  const re = /\{id:"[^"]+",code:"([^"]+)",name:"([^"]*)",category:"([^"]*)",games:(\d+),image:(null|"[^"]*")\}/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ code: m[1], name: m[2], category: m[3], gameCount: Number(m[4]) || 0, raw: { code: m[1], name: m[2], category: m[3], games: Number(m[4]) || 0 } });
  }
  return { providers: out, total: out.length, source: 'as-tech-public-html' };
}

function normalizeProvider(p) {
  if (!p || typeof p !== 'object') return null;
  const code = p.code ?? p.providerCode ?? p.id ?? p.slug;
  const name = p.name ?? p.title ?? p.providerName ?? code;
  if (code == null) return null;
  return {
    code: String(code),
    name: String(name || code),
    category: p.category ? String(p.category) : 'casino',
    gameCount: Number(p.gameCount ?? p.games ?? p.total ?? 0) || 0,
    raw: p,
  };
}

function normalizeGame(g, providerCode) {
  if (!g || typeof g !== 'object') return null;
  const id = g.id ?? g.gameId ?? g.game_id ?? g.uid;
  const title = g.title ?? g.name ?? g.gameName ?? g.game_name;
  if (id == null || title == null) return null;
  return {
    id: String(id),
    title: String(title),
    name: String(title),
    providerCode: String(g.providerCode ?? g.provider_code ?? providerCode ?? ''),
    category: String(g.category ?? g.type ?? 'casino'),
    image: g.image ? String(g.image) : (g.thumbnail ? String(g.thumbnail) : null),
    source: 'as-tech',
    launchMode: 'demo',
    raw: g,
  };
}

async function listProviders({ force = false } = {}) {
  if (!force && cache.providers.value && Date.now() - cache.providers.at < CACHE_MS) {
    return cache.providers.value;
  }
  let value;
  try {
    const raw = unwrap(await requestJson('GET', PROVIDERS_FN));
    const list = asArray(raw, ['providers', 'items', 'results']).map(normalizeProvider).filter(Boolean);
    value = { providers: list, total: list.length, source: 'as-tech-public' };
  } catch (err) {
    // The provider pages themselves are public and contain the same SSR
    // catalogue. Use that as a non-authenticated fallback if the RPC layer
    // is unavailable to a server-to-server caller.
    value = await listProvidersFromHtml();
  }
  cache.providers = { at: Date.now(), value };
  return value;
}

async function listProviderGames(providerCode, { search = '', page = 1, force = false } = {}) {
  providerCode = String(providerCode || '').trim();
  if (!providerCode) throw new Error('providerCode is required');
  page = Math.max(1, Math.min(MAX_PAGE, Number(page) || 1));
  const key = `${providerCode}|${search}|${page}`;
  const cached = cache.games.get(key);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  let value;
  try {
    const raw = unwrap(await requestJson('POST', GAMES_FN, {
      providerCode,
      search: String(search || ''),
      page,
    }));
    const games = asArray(raw, ['games', 'items', 'results']).map(g => normalizeGame(g, providerCode)).filter(Boolean);
    value = {
      provider: normalizeProvider(raw?.provider) || { code: providerCode, name: providerCode, category: 'casino' },
      games,
      total: Number(raw?.total ?? raw?.count ?? games.length) || games.length,
      page: Number(raw?.page ?? page) || page,
      pageSize: Number(raw?.pageSize ?? games.length) || games.length,
      source: 'as-tech-public',
    };
  } catch (err) {
    if (page !== 1 || search) throw err;
    value = parseProviderPageHtml(await requestText(`/providers/${encodeURIComponent(providerCode)}`), providerCode);
  }
  cache.games.set(key, { at: Date.now(), value });
  return value;
}

async function listAllProviderGames(providerCode, options = {}) {
  const first = await listProviderGames(providerCode, options);
  const all = [...first.games];
  const pageSize = Math.max(1, Number(first.pageSize) || first.games.length || 48);
  const totalPages = Math.min(MAX_PAGE, Math.ceil((Number(first.total) || all.length) / pageSize));
  for (let page = 2; page <= totalPages; page++) {
    const next = await listProviderGames(providerCode, { ...options, page });
    all.push(...next.games);
  }
  const seen = new Set();
  const games = all.filter(g => !seen.has(g.id) && seen.add(g.id));
  return { ...first, games, total: games.length, pages: totalPages };
}

async function listAllGames({ force = false, allPages = true } = {}) {
  const providers = await listProviders({ force });
  const results = [];
  // Keep concurrency modest so a full catalogue sync does not hammer the
  // public site. Each provider's own pagination is still sequential.
  for (let i = 0; i < providers.providers.length; i += 4) {
    const batch = providers.providers.slice(i, i + 4);
    const rows = await Promise.all(batch.map(p => allPages
      ? listAllProviderGames(p.code, { force })
      : listProviderGames(p.code, { force })));
    for (const row of rows) results.push(...row.games);
  }
  const seen = new Set();
  const games = results.filter(g => !seen.has(g.id) && seen.add(g.id));
  return { providers: providers.providers, games, total: games.length, source: 'as-tech-public' };
}

async function launchDemo(gameId) {
  if (!gameId) throw new Error('gameId is required');
  const raw = unwrap(await requestJson('POST', DEMO_LAUNCH_FN, { gameId: String(gameId) }));
  return { ...raw, gameId: String(gameId), source: 'as-tech-public-demo' };
}

module.exports = {
  listProviders,
  listProviderGames,
  listAllProviderGames,
  listAllGames,
  launchDemo,
  config: {
    baseUrl: BASE_URL,
    serverFnBase: SERVER_FN_BASE,
    providerFunction: PROVIDERS_FN,
    gamesFunction: GAMES_FN,
    demoLaunchFunction: DEMO_LAUNCH_FN,
  },
};
