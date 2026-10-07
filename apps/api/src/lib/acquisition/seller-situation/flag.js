// ─── seller-situation/flag.js ───────────────────────────────────────────────
// SELLER_SCORING_RAW_FACTS (§84: its own flag, no master switch). Double gate,
// IC8 pattern (lib/domain/intelligence/config/flags.js):
//   1. env ceiling   process.env.SELLER_SCORING_RAW_FACTS === "true"  (sync)
//   2. runtime switch system_control.seller_scoring_raw_facts truthy  (async,
//      primed into a short-lived cache by primeSellerScoringRawFactsFlag())
// The engine is synchronous, so it reads isSellerScoringRawFactsActive(), which
// is ON only when the env ceiling is "true" AND a primed, unexpired runtime
// value is true. Unprimed / expired / unreadable / slow = OFF. Never throws.

export const SELLER_SCORING_RAW_FACTS_ENV = 'SELLER_SCORING_RAW_FACTS';
export const SELLER_SCORING_RAW_FACTS_CONTROL = 'seller_scoring_raw_facts';
export const RUNTIME_TTL_MS = 30_000;
export const READ_TIMEOUT_MS = 250;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on', 'enabled']);
let runtime = { value: false, expires_at: 0 };

export function envCeiling(env = process.env) {
  return String(env?.[SELLER_SCORING_RAW_FACTS_ENV] ?? '').trim().toLowerCase() === 'true';
}

function truthy(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  return TRUE_VALUES.has(String(v).trim().toLowerCase());
}

async function defaultReadSystemFlag(key) {
  const { getSystemFlag } = await import('@/lib/system-control.js');
  return getSystemFlag(key, { failClosedOnError: true });
}

/** Async: read the runtime switch (bounded) and cache it. Returns the combined verdict. */
export async function primeSellerScoringRawFactsFlag({ env = process.env, readSystemFlag = defaultReadSystemFlag, nowMs = Date.now(), timeoutMs = READ_TIMEOUT_MS } = {}) {
  if (!envCeiling(env)) {
    runtime = { value: false, expires_at: nowMs + RUNTIME_TTL_MS };
    return false;
  }
  let value = false;
  try {
    value = truthy(await Promise.race([
      Promise.resolve().then(() => readSystemFlag(SELLER_SCORING_RAW_FACTS_CONTROL)),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]));
  } catch {
    value = false;
  }
  runtime = { value, expires_at: nowMs + RUNTIME_TTL_MS };
  return value;
}

/** Sync verdict for the engine. */
export function isSellerScoringRawFactsActive({ env = process.env, nowMs = Date.now() } = {}) {
  if (!envCeiling(env)) return false;
  return runtime.value === true && nowMs < runtime.expires_at;
}

/** Tests only. */
export function __resetSellerScoringRawFactsFlag() {
  runtime = { value: false, expires_at: 0 };
}
