// Rate, concurrency, time and size budgets. All in-process (one stdio server =
// one principal). Streamable HTTP (1.x, loopback only) serves the same one host-configured
// principal, so the principal-wide rate and the process-wide concurrency gate are shared
// across HTTP sessions, plus a per-session gate (see protocol/http.mjs).
import { err } from '../errors.mjs'

/** Sliding-window limiter: `${principal}|${bucket}` → timestamps in the last window. */
export function createRateLimiter({ now = () => Date.now(), windowMs = 60_000 } = {}) {
  const hits = new Map()
  return {
    /** Consume one unit or throw rate_limited. */
    take(key, limit) {
      const t = now()
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs)
      if (arr.length >= limit) {
        hits.set(key, arr)
        const retryMs = windowMs - (t - arr[0])
        throw err('rate_limited', `rate limit reached (${limit} per ${Math.round(windowMs / 1000)} s)`, { code: 'RATE_LIMITED', details: { retry_after_ms: Math.max(retryMs, 0) } })
      }
      arr.push(t)
      hits.set(key, arr)
      if (hits.size > 10_000) hits.delete(hits.keys().next().value)
    },
  }
}

/** Bounded in-flight calls; a call over the bound is refused (never queued without bound). */
export function createConcurrencyGate({ max = 4, code = 'CONCURRENCY_LIMIT', label = 'concurrent calls' } = {}) {
  let inFlight = 0
  return {
    get inFlight() { return inFlight },
    get max() { return max },
    async run(fn) {
      if (inFlight >= max) throw err('rate_limited', `too many ${label} (max ${max})`, { code })
      inFlight += 1
      try { return await fn() } finally { inFlight -= 1 }
    },
  }
}

/**
 * Run fn(signal) with a hard deadline. On expiry the signal aborts (the read
 * client cancels its HTTP requests) and the caller gets `timeout`; a late
 * result is discarded, never returned.
 */
export async function withDeadline(ms, fn) {
  const ctl = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort(err('timeout', `the call exceeded its ${ms} ms budget`, { code: 'CALL_TIMEOUT' }))
      reject(err('timeout', `the call exceeded its ${ms} ms budget`, { code: 'CALL_TIMEOUT' }))
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([Promise.resolve().then(() => fn(ctl.signal)), deadline])
  } finally {
    clearTimeout(timer)
  }
}
