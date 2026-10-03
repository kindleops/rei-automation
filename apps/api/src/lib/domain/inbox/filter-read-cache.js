/**
 * FILTER READS: CACHED, COALESCED, BOUNDED.
 *
 * Opening the Advanced Filters sheet (Inbox and Map) asks for every select
 * field's options plus a match count at once. Each is a scan of the hydrated
 * inbox view: ~2 s alone. Measured 2026-10-03 on the production database:
 * the sheet's 14 concurrent option reads + 1 count all ran past the statement
 * timeout (500 "canceling statement due to statement timeout", count 28 s),
 * so on prod the fields sat on "Loading options…" and the count read 0.
 *
 * Three guards, all in-process and keyed by the exact query arguments:
 *   - a short TTL cache  — reopening the sheet costs nothing;
 *   - in-flight coalescing — the same question asked twice runs once;
 *   - a concurrency bound — at most MAX_CONCURRENT scans hit the database
 *     together, so they finish instead of timing out side by side.
 * Failures are never cached.
 */

const DEFAULT_TTL_MS = 120_000;
const MAX_ENTRIES = 300;
const MAX_CONCURRENT = 3;

const cache = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> Promise
let active = 0;
const waiters = [];

function acquire() {
  if (active < MAX_CONCURRENT) { active += 1; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve)).then(() => { active += 1; });
}
function release() {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

function remember(key, value, at) {
  cache.set(key, { at, value });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/** Run `fn` once per key at a time, bounded, with the result cached for `ttlMs`. */
export async function cachedFilterRead(key, fn, { ttlMs = DEFAULT_TTL_MS, staleMs = 0, now = Date.now } = {}) {
  const hit = cache.get(key);
  const age = hit ? now() - hit.at : Infinity;
  if (hit && age < ttlMs) return hit.value;
  const running = inflight.get(key);
  // stale-while-revalidate: an older answer (within staleMs) is served at once
  // and refreshed behind it, so only the very first open ever waits on a scan
  if (hit && age < staleMs) {
    if (!running) startRead(key, fn, now).catch(() => {});
    return hit.value;
  }
  if (running) return running;
  return startRead(key, fn, now);
}

function startRead(key, fn, now) {
  const run = (async () => {
    await acquire();
    try {
      const value = await fn();
      remember(key, value, now());
      return value;
    } finally {
      release();
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

/** Test-only. */
export function __resetFilterReadCacheForTests() {
  cache.clear();
  inflight.clear();
}
export const __filterReadStateForTests = () => ({ active, waiting: waiters.length, cached: cache.size });
