/**
 * SENDER ROUTING 2.0 — the double gate (same contract as the IC8 flags).
 *
 * ON only when BOTH are true:
 *   1. env ceiling   process.env.SENDER_ROUTING_V2_ENABLED === "true"
 *                    (synchronous; deploy-time; a stray system_control write
 *                    cannot enable it and a stray env var cannot either)
 *   2. runtime       system_control.sender_routing_v2_enabled truthy, read
 *                    through an injected or lazily-imported reader, cached 30 s,
 *                    250 ms budget.
 * Missing, unreadable, slow or malformed = OFF. Never throws.
 *
 * GATE OFF = TODAY'S BEHAVIOUR, BYTE-IDENTICAL: callers test senderRoutingCeiling()
 * synchronously first; with the ceiling off they take no await, import nothing
 * and run the legacy router exactly as before.
 *
 * Independently, the wake sweep's APPLY mode needs its own pair
 * (SENDER_ROUTING_WAKE_APPLY + system_control.sender_routing_wake_apply) so the
 * routing switch alone can never start re-queuing parked sends.
 */

export const SENDER_ROUTING_FLAGS = Object.freeze({
  ROUTING: Object.freeze({ env: "SENDER_ROUTING_V2_ENABLED", control: "sender_routing_v2_enabled" }),
  WAKE_APPLY: Object.freeze({ env: "SENDER_ROUTING_WAKE_APPLY", control: "sender_routing_wake_apply" }),
  GRAPH_WRITES: Object.freeze({ env: "SENDER_ROUTING_GRAPH_WRITES", control: "sender_routing_graph_writes" }),
});

const TRUE_VALUES = new Set(["true", "1", "yes", "on", "enabled"]);
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 250;

function truthy(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

export function senderRoutingCeiling(env = process.env, flag = SENDER_ROUTING_FLAGS.ROUTING) {
  if (!env || !flag) return false;
  return String(env[flag.env] ?? "").trim().toLowerCase() === "true";
}

async function within(fn, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn).then((value) => ({ value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
        if (typeof timer?.unref === "function") timer.unref();
      }),
    ]);
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultReader() {
  const [{ hasSupabaseConfig }, { getSystemValue }] = await Promise.all([
    import("../../../supabase/client.js"),
    import("../../../system-control.js"),
  ]);
  return hasSupabaseConfig() ? getSystemValue : async () => null;
}

const cache = new Map();

/** Both gates. Returns { enabled, ceiling, runtime, reason }. */
export async function isSenderRoutingFlagEnabled(flag = SENDER_ROUTING_FLAGS.ROUTING, { env = process.env, readSystemValue = null, ttlMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() } = {}) {
  if (!senderRoutingCeiling(env, flag)) return { enabled: false, ceiling: false, runtime: false, reason: "env_ceiling_off" };
  const cached = readSystemValue ? null : cache.get(flag.control);
  if (cached && now() - cached.at < ttlMs) return { enabled: cached.on, ceiling: true, runtime: cached.on, reason: cached.on ? "on" : "runtime_off_cached" };
  let reader = readSystemValue;
  if (typeof reader !== "function") {
    try {
      reader = await defaultReader();
    } catch {
      return { enabled: false, ceiling: true, runtime: false, reason: "runtime_reader_unavailable" };
    }
  }
  const result = await within(() => reader(flag.control), timeoutMs);
  if (result.timedOut) return { enabled: false, ceiling: true, runtime: false, reason: "runtime_reader_timeout" };
  if (result.error) return { enabled: false, ceiling: true, runtime: false, reason: "runtime_reader_error" };
  const on = truthy(result.value);
  if (!readSystemValue) cache.set(flag.control, { on, at: now() });
  return { enabled: on, ceiling: true, runtime: on, reason: on ? "on" : "runtime_off_or_missing" };
}

export function resetSenderRoutingGateCache() {
  cache.clear();
}
