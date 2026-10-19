// The MCP's own transport guard, INSIDE the database-role enforcement (lc_mcp_reader),
// not instead of it. Every live request passes here first, then the app's guarded
// read fetch (quick-scan/read-client.js#createGuardedReadFetch) for table reads and
// the two app RPCs. Refused before the network:
//   * any origin but the configured data service;
//   * a table read outside the inventory (data/inventory.mjs), or any non-GET/HEAD on a table;
//   * an RPC outside the 4 allowlisted read RPCs;
//   * a schema profile other than public (Accept-Profile / Content-Profile);
//   * write / transaction Prefer headers (return=, resolution=, missing=, tx=);
//   * any other path (auth admin, storage, functions, graphql, realtime).
// It is also the ONLY place the credentials are attached: apikey = the public key and
// Authorization = Bearer <the lc_mcp_reader token>. Whatever header a library set is
// overwritten, so no other identity can ride a request.
import { RELATION_NAMES, RPC_NAMES, MCP_RPCS, rpcName, SCHEMA } from './inventory.mjs'

const MCP_RPC_NAMES = Object.freeze(Object.keys(MCP_RPCS).map(rpcName))

function refusal(code, message) {
  return Object.assign(new Error(message), { code, refusal: false })
}

/**
 * @param {{ origin: string, apiKey: string, readerJwt: string, inner: Function, base: Function, onRequest?: Function, onRefused?: Function }} o
 *   inner = the app's guarded read fetch (tables + app RPCs); base = the raw fetch (MCP RPCs only, after these checks)
 *   onRefused({ code, method, kind, target }) — every refusal, BEFORE it is thrown. A reused service that
 *   catches the error and degrades would otherwise hide a read the inventory is missing; the inventory
 *   test asserts this is never called, and the server audits it (transport_refused). `target` is a
 *   relation / function NAME or the path shape, never a query string.
 */
export function createInventoryGuardedFetch({ origin, apiKey, readerJwt, inner, base, onRequest = null, onRefused = null }) {
  if (!origin || !apiKey || !readerJwt || typeof inner !== 'function' || typeof base !== 'function') throw refusal('READ_CLIENT_UNCONFIGURED', 'inventory guard needs origin, keys and fetches')
  const allowedOrigin = new URL(origin).origin
  const refuse = (code, message, { method = null, kind = null, target = null } = {}) => {
    try { onRefused?.({ code, method, kind, target }) } catch { /* a reporting failure never turns a refusal into a pass */ }
    return refusal(code, message)
  }
  return async function inventoryFetch(input, init = {}) {
    const isRequest = typeof input === 'object' && input !== null && typeof input.url === 'string'
    const url = new URL(isRequest ? input.url : String(input))
    const method = String(init.method || (isRequest && input.method) || 'GET').toUpperCase()
    if (url.origin !== allowedOrigin) throw refuse('EGRESS_REFUSED', `origin ${url.origin} is not the app data service`, { method, kind: 'egress', target: 'other_origin' })
    const headers = new Headers(isRequest ? input.headers : undefined)
    for (const [k, v] of new Headers(init.headers || {}).entries()) headers.set(k, v)
    for (const h of ['accept-profile', 'content-profile']) {
      const v = headers.get(h)
      if (v && v !== SCHEMA) throw refuse('SCHEMA_REFUSED', `schema profile ${String(v).slice(0, 32)} is not allowed`, { method, kind: 'schema', target: String(v).replace(/[^a-z0-9_]/gi, '').slice(0, 32) })
    }
    if (/return=|resolution=|missing=|tx=/i.test(String(headers.get('prefer') || ''))) throw refuse('WRITE_REFUSED', 'write / transaction preference refused', { method, kind: 'prefer', target: url.pathname.split('/').pop().slice(0, 64) })
    const p = url.pathname
    let kind
    let target
    let m
    if ((m = /^\/rest\/v1\/([A-Za-z0-9_]+)$/.exec(p))) {
      if (method !== 'GET' && method !== 'HEAD') throw refuse('WRITE_REFUSED', `${method} ${p} is not a read`, { method, kind: 'table_write', target: m[1] })
      if (!RELATION_NAMES.includes(m[1])) throw refuse('RELATION_NOT_IN_INVENTORY', `relation ${m[1]} is not in the read inventory`, { method, kind: 'table_read', target: m[1] })
      kind = 'table_read'
      target = inner
    } else if ((m = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/.exec(p))) {
      if (!['GET', 'HEAD', 'POST'].includes(method)) throw refuse('WRITE_REFUSED', `${method} ${p} is not a read`, { method, kind: 'rpc_write', target: m[1] })
      if (!RPC_NAMES.includes(m[1])) throw refuse('RPC_NOT_ALLOWLISTED', `rpc ${m[1]} is not an allowlisted read function`, { method, kind: 'rpc_read', target: m[1] })
      kind = 'rpc_read'
      target = MCP_RPC_NAMES.includes(m[1]) ? base : inner
    } else {
      throw refuse('WRITE_REFUSED', `${method} ${p} is not a read path`, { method, kind: 'path', target: p.split('/').slice(0, 3).join('/').slice(0, 40) })
    }
    headers.set('apikey', apiKey)
    headers.set('authorization', `Bearer ${readerJwt}`)
    onRequest?.({ method, path: p, kind })
    return target(url.toString(), { ...init, method, headers })
  }
}
