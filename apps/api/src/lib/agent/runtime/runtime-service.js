// R2 runtime wiring: gates, the handler registry, the store, the scheduled tick.
//
// THREE independent default-OFF gates before any job runs:
//   1. Worker   CRON_AGENT_RUNTIME_ENABLED="true"  registers the "*/1" call (infra/cloudflare/worker/index.ts)
//   2. API      AGENT_RUNTIME_ENABLED=1 (container ceiling, forwarded by AGENT_FORWARDED_VARS)
//               AND the Gate B kill switch AGENT_ENABLED (agent-config.js)
//   3. DB       agent.runtime_limits.runtime_enabled = true, emergency_stop = false,
//               and the kind enabled in kind_limits (armed by a named operator)
// The route answers 200 { skipped } without touching the database while gate 2 is off.
import { isAgentEnabled, isProductionRuntime } from '../config/agent-config.js'
import { getAgentPgPool, assertAgentPoolTls } from '../live/live-agent.js'
import { createRuntimePgStore } from './job-runtime.js'
import { runRuntimeTick, DEFAULT_TICK_BUDGET_MS, TICK_HARD_MAX_MS } from './runtime-tick.js'
import { opsHealthCheckHandler, OPS_HEALTH_CHECK_KIND } from './handlers/ops-health-check.js'

export const AGENT_RUNTIME_FLAG = 'AGENT_RUNTIME_ENABLED'
export const RUNTIME_WORKER_ID = 'agent-runtime-tick'

/** Exactly one built-in handler in R2. */
export const DEFAULT_RUNTIME_HANDLERS = Object.freeze({ [OPS_HEALTH_CHECK_KIND]: opsHealthCheckHandler })

const ON = new Set(['1', 'true', 'on'])

export function runtimeGate(env = process.env) {
  if (!isAgentEnabled(env)) return { enabled: false, reason: 'AGENT_ENABLED_off' }
  if (!ON.has(String(env?.[AGENT_RUNTIME_FLAG] ?? '').trim().toLowerCase())) return { enabled: false, reason: `${AGENT_RUNTIME_FLAG}_off` }
  return { enabled: true, reason: null }
}

export function tickBudgetMs(env = process.env) {
  const v = Number(env?.AGENT_RUNTIME_TICK_BUDGET_MS)
  return Number.isFinite(v) && v > 0 ? Math.min(v, TICK_HARD_MAX_MS) : DEFAULT_TICK_BUDGET_MS
}

/** AGENT_RUNTIME_TICK_CONCURRENT=1: a tick runs its claims in parallel (bounded by the DB's grants). Default off. */
export function tickConcurrent(env = process.env) {
  return ON.has(String(env?.AGENT_RUNTIME_TICK_CONCURRENT ?? '').trim().toLowerCase())
}

const STORE_KEY = Symbol.for('lc.agent.runtime.store')

/** One process-wide store over the shared agent_api pool (never the app's full-privilege URL in production). */
export function getRuntimeStore(env = process.env) {
  if (!globalThis[STORE_KEY]) globalThis[STORE_KEY] = createRuntimePgStore({ pool: getAgentPgPool(env), statementTimeoutMs: 5000 })
  return globalThis[STORE_KEY]
}

const VERIFIED_KEY = Symbol.for('lc.agent.runtime.store.verified')

/** Production: verified client-side TLS + least-privilege role, checked once per process (a failure is retried next tick). */
export async function getVerifiedRuntimeStore(env = process.env) {
  const store = getRuntimeStore(env)
  if (!isProductionRuntime(env) || globalThis[VERIFIED_KEY]) return store
  await assertAgentPoolTls(getAgentPgPool(env), env)
  await store.assertLeastPrivilege()
  globalThis[VERIFIED_KEY] = true
  return store
}

let inFlight = null

/**
 * The scheduled tick (single flight per process: an overlapping cron call returns skipped).
 * @param {{ env?: object, store?: object, handlers?: object, now?: () => number }} [o]
 */
export async function runScheduledRuntimeTick({ env = process.env, store = null, handlers = DEFAULT_RUNTIME_HANDLERS, now } = {}) {
  const gate = runtimeGate(env)
  if (!gate.enabled) return { ok: true, skipped: gate.reason }
  if (inFlight) return { ok: true, skipped: 'in_flight' }
  try {
    inFlight = (store ? Promise.resolve(store) : getVerifiedRuntimeStore(env)).then((s) => runRuntimeTick({ store: s, handlers, workerId: RUNTIME_WORKER_ID, budgetMs: tickBudgetMs(env), concurrent: tickConcurrent(env), ...(now ? { now } : {}) }))
    const summary = await inFlight
    return { ok: summary.errors.length === 0, skipped: null, summary }
  } finally {
    inFlight = null
  }
}
