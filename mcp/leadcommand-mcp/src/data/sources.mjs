// Data sources behind the adapters. Two modes, ONE service shape:
//
//   live     the EXISTING agent read path: the guarded read-only transport
//            (createGuardedReadFetch — GET/HEAD on /rest/v1/<table> of the app's
//            own Supabase origin + 3 allowlisted STABLE RPCs; PATCH/PUT/DELETE,
//            table POSTs and write Prefer headers are refused before any
//            request) under a supabase-js client, plus the SAME domain services
//            the agent Quick Scan wraps (createQuickScanServices: dossier,
//            outreach state, entity-contact review, ZIP context). The service
//            key is held in this closure only; it is never in process.env,
//            never in a tool result, never in a log line.
//   fixture  synthetic data (fixtures/), same shape, same write refusal.
//
// Per call: a fresh service memo, the call's AbortSignal on every request, a
// request budget (fan-out bound) and a 5 s per-request abort.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createClient } from '@supabase/supabase-js'
import { createGuardedReadFetch } from '@/lib/agent/quick-scan/read-client.js'
import { createQuickScanServices } from '@/lib/agent/quick-scan/services.js'
import { queryActiveSuppression } from '@/lib/domain/compliance/query-active-suppression.js'
import { createFixtureDb } from './fixture-db.mjs'
import { err } from '../errors.mjs'

export const REQUEST_TIMEOUT_MS = 5_000
export const MAX_REQUESTS_PER_CALL = 40

const callStore = new AsyncLocalStorage()

/** Fetch wrapper: joins the call's abort signal, enforces the per-call request budget, records Preference-Applied. */
function callScopedFetch(inner, stats) {
  return async function scopedFetch(input, init = {}) {
    const call = callStore.getStore()
    if (call) {
      call.requests += 1
      if (call.requests > call.budget) throw err('rate_limited', 'per-call read budget exhausted', { code: 'READ_BUDGET' })
      if (call.signal?.aborted) throw err('timeout', 'call aborted', { code: 'CALL_TIMEOUT' })
    }
    const ctl = new AbortController()
    const onAbort = () => ctl.abort(call?.signal?.reason)
    call?.signal?.addEventListener?.('abort', onAbort, { once: true })
    init.signal?.addEventListener?.('abort', () => ctl.abort(init.signal.reason), { once: true })
    const headers = new Headers(init.headers || {})
    // ask PostgREST to bound the statement server-side too (ignored when unsupported; reported via Preference-Applied)
    if (!headers.has('prefer')) headers.set('prefer', 'timeout=5')
    else if (!/timeout=/i.test(headers.get('prefer'))) headers.set('prefer', `${headers.get('prefer')}, timeout=5`)
    try {
      const res = await inner(input, { ...init, headers, signal: ctl.signal })
      const applied = res?.headers?.get?.('preference-applied')
      stats.preference_applied = applied ? String(applied).slice(0, 80) : stats.preference_applied ?? null
      return res
    } finally {
      call?.signal?.removeEventListener?.('abort', onAbort)
    }
  }
}

/**
 * @param {{ supabaseUrl: string, serviceKey: string, baseFetch?: typeof fetch, onRequest?: Function }} opts
 */
export function createLiveSource({ supabaseUrl, serviceKey, baseFetch = globalThis.fetch, onRequest = null }) {
  if (!supabaseUrl || !serviceKey) throw err('unavailable', 'live data source is not configured', { code: 'READ_CLIENT_UNCONFIGURED' })
  const origin = new URL(supabaseUrl).origin
  if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) throw err('unavailable', 'live data source must be https', { code: 'READ_CLIENT_UNCONFIGURED' })
  const stats = { requests: 0, preference_applied: null }
  const guarded = createGuardedReadFetch({ allowedOrigin: origin, baseFetch, timeoutMs: REQUEST_TIMEOUT_MS, onRequest: (info) => { stats.requests += 1; onRequest?.(info) } })
  const client = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: callScopedFetch(guarded, stats), headers: { 'x-client-info': 'leadcommand-mcp/1.0' } },
    realtime: { params: { eventsPerSecond: 0 } },
  })
  return makeSource({ mode: 'live', db: client, stats })
}

/** @param {{ tables, rpc?, faults?, services?: object }} fixture */
export function createFixtureSource(fixture, { faults = {} } = {}) {
  const stats = { requests: 0, preference_applied: null }
  const db = createFixtureDb({ tables: fixture.tables, rpc: fixture.rpc, faults, onRequest: () => { stats.requests += 1 } })
  return makeSource({ mode: 'fixture', db, stats, overrides: fixture.services })
}

function makeSource({ mode, db, stats, overrides = null }) {
  return {
    mode,
    stats,
    /** Run fn(services) inside one call scope (fresh memo, the call's signal, a request budget). */
    async withCall(signal, fn) {
      const scope = { requests: 0, budget: MAX_REQUESTS_PER_CALL, signal }
      return callStore.run(scope, async () => {
        const qs = overrides ? null : createQuickScanServices({ db })
        const services = Object.freeze({
          mode,
          db,
          signal,
          dossier: overrides?.dossier || qs.dossier,
          outreach: overrides?.outreach || qs.outreach,
          entityContact: overrides?.entityContact || qs.entityContact,
          zipContext: overrides?.zipContext || qs.zipContext,
          /** Active suppression for ONE number via the existing compliance lookup; a lookup error is UNKNOWN, never "not suppressed". */
          async suppression(phone) {
            const r = await queryActiveSuppression(db, phone)
            if (r?.lookup_error) return { state: 'unknown', reason: 'suppression_lookup_failed' }
            if (r?.suppressed) return { state: 'suppressed', reason: String(r.suppression_reason || 'phone_suppressed').slice(0, 60), types: (r.rows || []).map((x) => x.suppression_type).filter(Boolean).slice(0, 3) }
            return { state: 'not_suppressed', reason: null }
          },
        })
        return fn(services)
      })
    },
  }
}
