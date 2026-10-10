// Per-user rate limits for the agent routes (Gate B).
//
// Two layers, both keyed by the VERIFIED user id (never an IP, never a header):
//   1. request rate, in-process sliding window per bucket:
//        mutation  preflight / confirm / cancel     default 6 / min   (hard max 30)
//        read      status / runs / snapshot / events default 240 / min (hard max 1200)
//      Per API instance (the pool allows ≤ 3 instances, so the effective
//      ceiling is ≤ 3× — documented in the Gate B packet). → 429 RATE_LIMITED
//   2. runs per user per UTC day, counted from the DURABLE store (every
//      instance sees the same runs after refresh): default 20 (hard max 100).
//      → 429 DAILY_RUN_CAP
// Env (lower-or-equal to the hard maxima; invalid ⇒ default):
//   AGENT_RATE_MUTATIONS_PER_MIN, AGENT_RATE_READS_PER_MIN, AGENT_USER_DAILY_RUNS
import { RUN_TERMINAL_STATES } from '../contracts/states.js'

export const RATE_LIMIT_DEFAULTS = Object.freeze({ mutation_per_min: 6, read_per_min: 240, daily_runs: 20 })
export const RATE_LIMIT_MAX = Object.freeze({ mutation_per_min: 30, read_per_min: 1200, daily_runs: 100 })
const WINDOW_MS = 60_000
const MAX_USERS = 1000

function bounded(raw, def, max) {
  const n = Number(String(raw ?? '').trim())
  if (String(raw ?? '').trim() === '' || !Number.isInteger(n) || n < 0) return def
  return Math.min(n, max)
}

export function resolveRateLimits(env = process.env) {
  return Object.freeze({
    mutation_per_min: bounded(env?.AGENT_RATE_MUTATIONS_PER_MIN, RATE_LIMIT_DEFAULTS.mutation_per_min, RATE_LIMIT_MAX.mutation_per_min),
    read_per_min: bounded(env?.AGENT_RATE_READS_PER_MIN, RATE_LIMIT_DEFAULTS.read_per_min, RATE_LIMIT_MAX.read_per_min),
    daily_runs: bounded(env?.AGENT_USER_DAILY_RUNS, RATE_LIMIT_DEFAULTS.daily_runs, RATE_LIMIT_MAX.daily_runs),
  })
}

/**
 * @param {{ limits?: ReturnType<typeof resolveRateLimits>, now?: () => number }} [deps]
 */
export function createUserRateLimiter({ limits = resolveRateLimits(), now = () => Date.now() } = {}) {
  const hits = new Map() // `${bucket}:${user}` → number[] (timestamps, ascending)

  /** @returns {{ ok: true, remaining: number } | { ok: false, code: 'RATE_LIMITED', retry_after_s: number, limit: number }} */
  function check(user_id, bucket) {
    const limit = bucket === 'mutation' ? limits.mutation_per_min : limits.read_per_min
    const key = `${bucket}:${user_id}`
    const t = now()
    const arr = (hits.get(key) || []).filter((x) => t - x < WINDOW_MS)
    if (arr.length >= limit) {
      hits.set(key, arr)
      return { ok: false, code: 'RATE_LIMITED', retry_after_s: Math.max(1, Math.ceil((WINDOW_MS - (t - arr[0])) / 1000)), limit }
    }
    arr.push(t)
    if (!hits.has(key) && hits.size >= MAX_USERS) hits.clear()
    hits.set(key, arr)
    return { ok: true, remaining: limit - arr.length }
  }

  return { check, limits }
}

/**
 * Durable per-user daily run count (research runs created today, UTC), from the
 * store snapshot. Cancelled drafts count too: the cap bounds work started.
 */
export function runsStartedToday(storeState, user_id, nowDate = new Date()) {
  const day = nowDate.toISOString().slice(0, 10)
  let n = 0
  for (const r of storeState.runs.values()) {
    if (r.operator_id === user_id && String(r.created_at || '').slice(0, 10) === day) n += 1
  }
  return n
}

/** Active (non-terminal) runs for a user — reported, not capped here (the org caps bind). */
export function activeRunsFor(storeState, user_id) {
  let n = 0
  for (const r of storeState.runs.values()) if (r.operator_id === user_id && !RUN_TERMINAL_STATES.includes(r.state)) n += 1
  return n
}
