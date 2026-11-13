// The Action MCP's transport guard, INSIDE the database-role enforcement (lc_action_gateway), not instead of
// it. Every request passes here before the network:
//   * any origin but the configured data service                         → EGRESS_REFUSED
//   * a table outside the read inventory, or any non-GET/HEAD on a table → RELATION_NOT_IN_INVENTORY / WRITE_REFUSED
//   * an RPC outside the gateway's entry points + automation_hold_for    → RPC_NOT_ALLOWLISTED
//   * a schema profile other than public                                 → SCHEMA_REFUSED
//   * a write / transaction Prefer header                                → WRITE_REFUSED
//   * any other path (auth admin, storage, functions, graphql, realtime) → WRITE_REFUSED
// It is also the ONLY place credentials are attached for the gateway's data path (apikey = the public key,
// Authorization = the lc_action_gateway token); whatever a library set is overwritten, so no other identity can ride a
// request. (The one other sender is the boot exposure probe of the Supabase pg_net platform exception,
// leadcommand-mcp/src/data/platform-exposure.mjs: a FIXED set of side-effect-free requests that must be REFUSED.)
import { RELATIONS, RPCS, SCHEMA } from './inventory.mjs'

const refusal = (code, message) => Object.assign(new Error(message), { code })

/**
 * @param {{ origin: string, apiKey: string, gatewayJwt: string, base?: Function, onRefused?: Function, timeoutMs?: number }} o
 */
export function createGuardedFetch({ origin, apiKey, gatewayJwt, base = globalThis.fetch, onRefused = null, timeoutMs = 10_000 }) {
  if (!origin || !apiKey || !gatewayJwt || typeof base !== 'function') throw refusal('CLIENT_UNCONFIGURED', 'guarded fetch needs origin, keys and a fetch')
  const allowed = new URL(origin).origin
  const refuse = (code, message, info) => { try { onRefused?.({ code, ...info }) } catch { /* reporting never turns a refusal into a pass */ } return refusal(code, message) }
  return async function guardedFetch(input, init = {}) {
    const isRequest = typeof input === 'object' && input !== null && typeof input.url === 'string'
    const url = new URL(isRequest ? input.url : String(input))
    const method = String(init.method || (isRequest && input.method) || 'GET').toUpperCase()
    if (url.origin !== allowed) throw refuse('EGRESS_REFUSED', `origin ${url.origin} is not the app data service`, { method, kind: 'egress', target: 'other_origin' })
    const headers = new Headers(isRequest ? input.headers : undefined)
    for (const [k, v] of new Headers(init.headers || {}).entries()) headers.set(k, v)
    for (const h of ['accept-profile', 'content-profile']) {
      const v = headers.get(h)
      if (v && v !== SCHEMA) throw refuse('SCHEMA_REFUSED', 'schema profile refused', { method, kind: 'schema', target: String(v).replace(/[^a-z0-9_]/gi, '').slice(0, 32) })
    }
    if (/return=|resolution=|missing=|tx=/i.test(String(headers.get('prefer') || ''))) throw refuse('WRITE_REFUSED', 'write / transaction preference refused', { method, kind: 'prefer' })
    let m
    if ((m = /^\/rest\/v1\/([A-Za-z0-9_]+)$/.exec(url.pathname))) {
      if (method !== 'GET' && method !== 'HEAD') throw refuse('WRITE_REFUSED', `${method} on a table is refused`, { method, kind: 'table_write', target: m[1] })
      if (!RELATIONS.includes(m[1])) throw refuse('RELATION_NOT_IN_INVENTORY', `relation ${m[1]} is not in the read inventory`, { method, kind: 'table_read', target: m[1] })
    } else if ((m = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/.exec(url.pathname))) {
      if (!['GET', 'HEAD', 'POST'].includes(method)) throw refuse('WRITE_REFUSED', `${method} on an rpc is refused`, { method, kind: 'rpc', target: m[1] })
      if (!RPCS.includes(m[1])) throw refuse('RPC_NOT_ALLOWLISTED', `rpc ${m[1]} is not a gateway entry point`, { method, kind: 'rpc', target: m[1] })
    } else {
      throw refuse('WRITE_REFUSED', 'path refused', { method, kind: 'path', target: url.pathname.split('/').slice(0, 3).join('/').slice(0, 40) })
    }
    headers.set('apikey', apiKey)
    headers.set('authorization', `Bearer ${gatewayJwt}`)
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    init.signal?.addEventListener?.('abort', () => ctl.abort(), { once: true })
    try {
      return await base(url.toString(), { ...init, method, headers, signal: ctl.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}
