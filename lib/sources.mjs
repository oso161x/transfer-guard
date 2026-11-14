// Bismillahirrahmanirrahim.
// sources.mjs — small fetch helpers for Transfer Guard.
// Only public, keyless, read-only endpoints. No wallet, no signing.
// Upstreams: DEX Screener, GoPlus Security, Paraswap prices, Base public RPC.
// A failed upstream is NEVER silently treated as "safe": the caller marks
// the affected check `unknown` and the verdict degrades honestly.

const UA = { 'User-Agent': 'TransferGuard/0.1 (+https://github.com/oso161x/transfer-guard)' };

// In-memory cache: key -> { at, value }. TTL 120s. Keeps us polite with
// free rate limits (GeckoTerminal-style 30 req/min on similar APIs) and
// makes repeated demo calls fast.
const cache = new Map();
const TTL_MS = 120_000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (hit) cache.delete(key);
  return undefined;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) {
    // Drop the oldest entry.
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

/**
 * GET JSON with timeout + one retry on 429/5xx. Returns parsed JSON.
 * Throws an Error with `status` attached on HTTP error or timeout.
 */
export async function fetchJson(url, { timeoutMs = 8000, retries = 1 } = {}) {
  const cached = cacheGet(url);
  if (cached !== undefined) return cached;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: UA,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      cacheSet(url, data);
      return data;
    } catch (err) {
      lastErr = err;
      const retryable =
        err?.status === 429 || (err?.status >= 500 && err?.status < 600) || err?.name === 'TimeoutError';
      if (!retryable || attempt === retries) throw lastErr;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** POST JSON, same timeout/retry discipline. No caching (writes). */
export async function postJson(url, body, { timeoutMs = 10000, retries = 0 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...UA, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${new URL(url).hostname}: ${String(text).slice(0, 200)}`);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    } catch (err) {
      lastErr = err;
      const retryable =
        err?.status === 429 || (err?.status >= 500 && err?.status < 600) || err?.name === 'TimeoutError';
      if (!retryable || attempt === retries) throw lastErr;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Read-only Base RPC call (eth_call). Used only for token decimals(). */
export async function baseRpcCall(to, data, { timeoutMs = 8000 } = {}) {
  const res = await fetch('https://mainnet.base.org', {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Base RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

export function clearCache() {
  cache.clear();
}
