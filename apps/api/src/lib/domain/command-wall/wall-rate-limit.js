/**
 * COMMAND WALL — in-process sliding-window rate limiter.
 *
 * The API runs as one container instance (infra/cloudflare: "api-singleton"),
 * so process memory is a sound place for these counters. If that topology ever
 * changes, the pairing limits stay safe anyway: codes are single-use, expire in
 * minutes, and claiming one already requires an operator session.
 */

export function createRateLimiter({ now = () => Date.now(), maxKeys = 5000 } = {}) {
  const hits = new Map()
  return {
    /** Records one hit; returns { ok, retryAfterMs }. */
    take(key, { limit, windowMs }) {
      const t = now()
      const list = (hits.get(key) || []).filter((at) => t - at < windowMs)
      if (list.length >= limit) {
        hits.set(key, list)
        return { ok: false, retryAfterMs: Math.max(1000, windowMs - (t - list[0])) }
      }
      list.push(t)
      hits.set(key, list)
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value)
      return { ok: true, retryAfterMs: 0 }
    },
    reset() { hits.clear() },
  }
}

/** The wall's limits, in one place so the tests can pin them. */
export const WALL_LIMITS = Object.freeze({
  pair_start_per_client: { limit: 6, windowMs: 10 * 60_000 },
  pair_start_global: { limit: 60, windowMs: 10 * 60_000 },
  pair_poll_per_pairing: { limit: 40, windowMs: 60_000 },
  claim_per_operator: { limit: 10, windowMs: 10 * 60_000 },
  claim_failures_global: { limit: 30, windowMs: 10 * 60_000 },
  read_per_display: { limit: 40, windowMs: 60_000 },
  heartbeat_per_display: { limit: 6, windowMs: 60_000 },
})

let shared = null
export function wallRateLimiter() {
  if (!shared) shared = createRateLimiter()
  return shared
}
