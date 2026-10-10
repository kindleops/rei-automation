// Guarded READ-ONLY data client for live Quick Scan tools (S3).
//
// The tools call the app's own services (entity-graph-service, outreach state,
// zip context, column enrichment) with `deps.supabase` = this client, so the
// business logic is the app's, and this layer only constrains transport:
//   * egress: the ONLY host it will contact is the configured Supabase host
//     (the app's own data service). Anything else → EGRESS_REFUSED, no request.
//   * read-only: GET/HEAD on /rest/v1/<table>, and POST only to
//     /rest/v1/rpc/<fn> for an allowlisted STABLE function (verified
//     provolatile='s' in prod 10-09). PATCH/PUT/DELETE, POST to a table,
//     Prefer: return=… writes, storage, auth admin, functions → refused.
//   * timeout: every request aborts at 30 s (statement_timeout parity; the
//     service_role has no server-side statement_timeout of its own)
//   * a counter records every request (tests assert no other egress)
import { createClient } from '@supabase/supabase-js'
import { AgentError } from '../runtime/store.js'

export const READ_TIMEOUT_MS = 30_000

/** STABLE RPCs the wrapped services call. Anything else is refused. */
export const READ_ONLY_RPC_ALLOWLIST = Object.freeze([
  'entity_graph_property_records', // getEntityGraphDossier → recorded documents (seller.*)
  'campaign_entity_contact_review_flags', // getEntityGraphOutreachState → entity-contact review (S9)
  'campaign_entity_contact_evidence', // same path, ENTITY_CONTACT_ROLE_V2 ≠ off (PROPOSED 20261009100000; STABLE, read-only facts)
])

function refuse(code, message) {
  const e = new AgentError(code, message)
  e.refusal = false
  return e
}

/**
 * Build a guarded fetch. Exposed for tests.
 * @param {{ allowedHost: string, baseFetch?: typeof fetch, timeoutMs?: number, onRequest?: (info: object) => void }} opts
 */
export function createGuardedReadFetch({ allowedHost = null, allowedOrigin = null, baseFetch = globalThis.fetch, timeoutMs = READ_TIMEOUT_MS, onRequest = null } = {}) {
  if (!allowedHost && !allowedOrigin) throw new AgentError('READ_CLIENT_HOST_REQUIRED', 'allowed origin required')
  // L7: compare the full origin (scheme + host + port), not only the hostname
  const origin = allowedOrigin ? new URL(allowedOrigin).origin : `https://${allowedHost}`
  return async function guardedFetch(input, init = {}) {
    const isRequest = typeof input === 'object' && input !== null && typeof input.url === 'string'
    const url = new URL(isRequest ? input.url : String(input))
    const method = String(init.method || (isRequest && input.method) || 'GET').toUpperCase()
    if (url.origin !== origin) throw refuse('EGRESS_REFUSED', `origin ${url.origin} is not the app data service`)
    const p = url.pathname
    let kind = null
    if ((method === 'GET' || method === 'HEAD') && /^\/rest\/v1\/[A-Za-z0-9_]+$/.test(p)) kind = 'table_read'
    else if ((method === 'GET' || method === 'HEAD' || method === 'POST') && /^\/rest\/v1\/rpc\/[A-Za-z0-9_]+$/.test(p)) {
      const fn = p.split('/').pop()
      if (!READ_ONLY_RPC_ALLOWLIST.includes(fn)) throw refuse('RPC_NOT_ALLOWLISTED', `rpc ${fn} is not an allowlisted read-only function`)
      kind = 'rpc_read'
    }
    if (!kind) throw refuse('WRITE_REFUSED', `${method} ${p} is not a read`)
    const headers = new Headers(isRequest ? input.headers : undefined)
    for (const [k, v] of new Headers(init.headers || {}).entries()) headers.set(k, v)
    const prefer = String(headers.get('prefer') || '')
    if (/return=|resolution=|missing=default/i.test(prefer)) throw refuse('WRITE_REFUSED', 'write preference refused')
    onRequest?.({ method, path: p, kind, at: new Date().toISOString() })
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(new AgentError('READ_TIMEOUT', `aborted after ${timeoutMs} ms`)), timeoutMs)
    if (init.signal) init.signal.addEventListener?.('abort', () => ctl.abort(init.signal.reason), { once: true })
    try {
      return await baseFetch(input, { ...init, signal: ctl.signal })
    } finally {
      clearTimeout(t)
    }
  }
}

/**
 * The live Quick Scan data client (service role, read-guarded).
 * @param {{ env?: Record<string,string|undefined>, baseFetch?: typeof fetch, onRequest?: Function }} [opts]
 */
export function createQuickScanReadClient({ env = process.env, baseFetch = globalThis.fetch, onRequest = null } = {}) {
  const url = String(env.SUPABASE_URL || '').trim()
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!url || !key) throw new AgentError('READ_CLIENT_UNCONFIGURED', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const allowedOrigin = new URL(url).origin
  const allowedHost = new URL(url).hostname
  const requests = []
  const fetchImpl = createGuardedReadFetch({ allowedOrigin, baseFetch, onRequest: (info) => { requests.push(info); onRequest?.(info) } })
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl, headers: { 'x-client-info': 'lc-agent-quick-scan/s3' } },
    realtime: { params: { eventsPerSecond: 0 } },
  })
  return { client, allowedHost, requests }
}
