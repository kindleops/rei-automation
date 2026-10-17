// Data sources behind the adapters. Two modes, ONE service shape:
//
//   live     PostgREST under a DATABASE-ROLE-ENFORCED read-only credential: the owner-
//            minted lc_mcp_reader token (data/credential.mjs). The database refuses
//            every write: no INSERT / UPDATE / DELETE / TRUNCATE grant, no reachable
//            write or egress function, no BYPASSRLS
//            (supabase/migrations/PROPOSED_20261016120000_lc_mcp_reader.sql). In front of
//            it, the transport is narrowed twice: the inventory guard (read-fetch.mjs: the
//            inventory relations / 4 RPCs only, credentials attached here) and the app's
//            guarded read fetch (createGuardedReadFetch). The SAME domain services the
//            agent Quick Scan wraps run on it (createQuickScanServices: dossier, outreach
//            state, entity-contact review, ZIP context). The credential is checked against
//            the database's own privilege report at boot and again every
//            CREDENTIAL_RECHECK_MS; a failure refuses every call (fail closed). The
//            service-role key is not accepted in live mode.
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
import { createInventoryGuardedFetch } from './read-fetch.mjs'
import { evaluateSelfCheck } from './credential.mjs'
import { RELATION_NAMES, RPC_SIGNATURES } from './inventory.mjs'
import { err } from '../errors.mjs'

export const REQUEST_TIMEOUT_MS = 5_000
export const MAX_REQUESTS_PER_CALL = 40
export const CREDENTIAL_RECHECK_MS = 10 * 60_000

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
 * @param {{ supabaseUrl: string, apiKey: string, readerJwt: string, baseFetch?: typeof fetch, onRequest?: Function, onSelfCheck?: Function, now?: () => number }} opts
 *   onSelfCheck(verdict, stage) — called after every credential self-check (boot and re-checks), for the audit
 */
export function createLiveSource({ supabaseUrl, apiKey, readerJwt, baseFetch = globalThis.fetch, onRequest = null, onSelfCheck = null, now = () => Date.now() }) {
  if (!supabaseUrl || !apiKey || !readerJwt) throw err('unavailable', 'live data source is not configured', { code: 'READ_CLIENT_UNCONFIGURED' })
  const origin = new URL(supabaseUrl).origin
  if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin)) throw err('unavailable', 'live data source must be https', { code: 'READ_CLIENT_UNCONFIGURED' })
  const stats = { requests: 0, preference_applied: null }
  const count = (info) => { stats.requests += 1; onRequest?.(info) }
  const appGuard = createGuardedReadFetch({ allowedOrigin: origin, baseFetch, timeoutMs: REQUEST_TIMEOUT_MS })
  const direct = async (url, init) => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(Object.assign(new Error(`aborted after ${REQUEST_TIMEOUT_MS} ms`), { code: 'READ_TIMEOUT' })), REQUEST_TIMEOUT_MS)
    init?.signal?.addEventListener?.('abort', () => ctl.abort(init.signal.reason), { once: true })
    try { return await baseFetch(url, { ...init, signal: ctl.signal }) } finally { clearTimeout(t) }
  }
  const guarded = createInventoryGuardedFetch({ origin, apiKey, readerJwt, inner: appGuard, base: direct, onRequest: count })
  const client = createClient(supabaseUrl, apiKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: callScopedFetch(guarded, stats), headers: { 'x-client-info': 'leadcommand-mcp/1.0' } },
    realtime: { params: { eventsPerSecond: 0 } },
  })

  let checked = null // { at, verdict }
  let inflight = null
  /** Read the database's privilege report AS the token's role and judge it. Never throws for a refusal: returns the verdict. */
  async function selfCheck(stage = 'recheck') {
    let verdict
    try {
      const { data, error } = await client.rpc('lc_mcp_reader_self_check', { p_relations: RELATION_NAMES, p_functions: RPC_SIGNATURES })
      if (error) {
        const code = String(error.code || '')
        // supabase-js turns a network failure into { error } with no code
        const unreachable = !code && /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|network|abort|timed? ?out/i.test(`${error.message || ''} ${error.details || ''}`)
        if (unreachable) verdict = { ok: false, findings: ['self_check_unreachable:network'], info: {} }
        else verdict = { ok: false, findings: [code === 'PGRST202' ? 'self_check_function_missing (migration not applied?)' : code === '42501' ? 'self_check_not_executable (token role lacks EXECUTE)' : /^PGRST30/.test(code) ? `token_rejected_by_postgrest:${code}` : `self_check_error:${code || 'unknown'}`], info: {} }
      } else verdict = evaluateSelfCheck(data)
    } catch (e) {
      verdict = { ok: false, findings: [`self_check_unreachable:${String(e?.code || e?.name || 'error').slice(0, 40)}`], info: {} }
    }
    checked = { at: now(), verdict }
    onSelfCheck?.(verdict, stage)
    return verdict
  }
  async function ensureCredential() {
    if (checked && checked.verdict.ok && now() - checked.at < CREDENTIAL_RECHECK_MS) return
    if (!checked || now() - checked.at >= CREDENTIAL_RECHECK_MS || !checked.verdict.ok) {
      inflight = inflight || selfCheck(checked ? 'recheck' : 'first_call').finally(() => { inflight = null })
      await inflight
    }
    if (!checked.verdict.ok) throw err('unavailable', 'the read credential failed its database self-check; every call is refused until it passes', { code: 'CREDENTIAL_SELF_CHECK_FAILED' })
  }
  async function operatorRole(orgId, userId) {
    const { data, error } = await client.rpc('lc_mcp_operator_role', { p_org_id: orgId, p_user_id: userId })
    if (error) throw Object.assign(new Error('membership lookup failed'), { code: String(error.code || 'MEMBERSHIP_LOOKUP_FAILED') })
    return typeof data === 'string' && data ? data : null
  }
  return makeSource({ mode: 'live', db: client, stats, gate: ensureCredential, extra: { selfCheck, operatorRole, get lastSelfCheck() { return checked } } })
}

/** @param {{ tables, rpc?, faults?, services?: object }} fixture */
export function createFixtureSource(fixture, { faults = {} } = {}) {
  const stats = { requests: 0, preference_applied: null }
  const db = createFixtureDb({ tables: fixture.tables, rpc: fixture.rpc, faults, onRequest: () => { stats.requests += 1 } })
  return makeSource({ mode: 'fixture', db, stats, overrides: fixture.services })
}

function makeSource({ mode, db, stats, overrides = null, gate = null, extra = {} }) {
  return {
    mode,
    stats,
    ...extra,
    /** Run fn(services) inside one call scope (fresh memo, the call's signal, a request budget). Live: the credential gate first. */
    async withCall(signal, fn) {
      if (gate) await gate()
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
