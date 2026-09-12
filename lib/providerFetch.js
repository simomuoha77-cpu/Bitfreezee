// lib/providerFetch.js — shared HTTP helper for every provider adapter.
// Tries each available key in the pool (via keyPool.getKey's round-robin)
// until one succeeds or every key has been tried/is cooling down. A 429 or
// 401/403 on one key moves to the NEXT key automatically within the same
// logical request — the caller never sees a "your key is rate-limited"
// failure unless every configured key is simultaneously exhausted.

const DEFAULT_TIMEOUT_MS = 10000;

// buildRequest(key) => { url, headers }
async function fetchWithKeyPool(pool, buildRequest, options) {
  options = options || {};
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!pool.isConfigured()) {
    throw new Error('[' + pool.providerLabel + '] not configured (no API key set)');
  }

  let lastErr = new Error('[' + pool.providerLabel + '] no available key (all configured keys inactive or cooling down)');
  const maxAttempts = pool.keyCount();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slot = pool.getKey();
    if (!slot) break; // every key is inactive or cooling down right now

    const { url, headers } = buildRequest(slot.key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      if (resp.status === 429) {
        const retryAfterHeader = resp.headers.get('retry-after');
        pool.reportFailure(slot, { status: 429, retryAfterMs: retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : undefined });
        lastErr = new Error('[' + pool.providerLabel + '] HTTP 429 on key #' + slot.index + ' — rotating to next key');
        continue;
      }
      if (resp.status === 401 || resp.status === 403) {
        pool.reportFailure(slot, { status: resp.status, permanent: true });
        lastErr = new Error('[' + pool.providerLabel + '] HTTP ' + resp.status + ' on key #' + slot.index + ' (auth) — marked inactive, rotating to next key');
        continue;
      }
      if (!resp.ok) {
        pool.reportFailure(slot, { status: resp.status });
        let bodyText = '';
        try { bodyText = (await resp.text()).slice(0, 300); } catch (_) {}
        lastErr = new Error('[' + pool.providerLabel + '] HTTP ' + resp.status + (bodyText ? ': ' + bodyText : '') + ' on key #' + slot.index);
        continue;
      }

      const data = await resp.json();
      pool.reportSuccess(slot);
      return data;
    } catch (e) {
      clearTimeout(timer);
      pool.reportFailure(slot, {});
      lastErr = e.name === 'AbortError'
        ? new Error('[' + pool.providerLabel + '] request timed out after ' + timeoutMs + 'ms on key #' + slot.index)
        : new Error('[' + pool.providerLabel + '] request failed on key #' + slot.index + ': ' + e.message);
      continue;
    }
  }

  throw lastErr;
}

module.exports = { fetchWithKeyPool };
