// The Supabase pg_net PLATFORM EXCEPTION, judged on the server side (docs/SUPABASE-PG-NET-POSTURE.md).
//
// Supabase's pg_net is created by supabase_admin, which owns schema net; PUBLIC holds USAGE on net, all privileges
// on its tables and sequences and EXECUTE on net.http_*, and a per-project revoke is unsupported
// (https://supabase.com/docs/guides/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16).
// Supabase's own posture: the API roles cannot use pg_net because they cannot connect directly and the Data API
// does not expose schema net. The database self-checks (lc_mcp_reader_self_check, action_gateway.self_check) carry
// ONE pinned exception for exactly those platform objects; this module is the server's half of it:
//
//   evaluatePlatformExceptions(report)  re-judges the report's platform_exceptions independently: only the known
//                                       exception id, only the pinned fingerprint version, every control reported
//                                       as holding, every excepted object in schema net. Anything else: a finding.
//   probePlatformExposure(...)          compensating control (c), LIVE, as the credential's own role: PostgREST
//                                       must answer PGRST106 (schema not exposed) to Accept-Profile: net (GET) and
//                                       Content-Profile: net (POST), and to Accept-Profile: extensions / cron; the
//                                       GraphQL endpoint must answer an unknown-field error to queries naming net's
//                                       tables. Any other answer (including a network failure) refuses the server.
//
// The probe is side-effect free even where a schema IS exposed: the GET asks for zero rows of the request queue and
// the POST names a function that does not exist (an exposed net answers PGRST202, never an insert).

export const PLATFORM_EXCEPTION_ID = 'supabase_pg_net'
/** Pinned: the SAME constant as the migrations' fingerprint_version (a test asserts both). A new value is a reviewed change. */
export const PG_NET_FINGERPRINT_VERSION = 'supabase_pg_net_default_acl.v1'
export const PROBE_TIMEOUT_MS = 5_000
const NEVER_EXISTS = 'lc_exposure_probe_never_exists'

/** The fixed request set of the live probe (method, path, profile header, expectation). */
export const REST_PROBES = Object.freeze([
  Object.freeze({ name: 'rest_get_net', method: 'GET', path: '/rest/v1/http_request_queue?select=id&limit=0', header: 'accept-profile', schema: 'net' }),
  Object.freeze({ name: 'rest_post_net', method: 'POST', path: `/rest/v1/rpc/${NEVER_EXISTS}`, header: 'content-profile', schema: 'net', body: '{}' }),
  Object.freeze({ name: 'rest_get_extensions', method: 'GET', path: `/rest/v1/${NEVER_EXISTS}?limit=0`, header: 'accept-profile', schema: 'extensions' }),
  Object.freeze({ name: 'rest_get_cron', method: 'GET', path: '/rest/v1/job?select=jobid&limit=0', header: 'accept-profile', schema: 'cron' }),
])
/** GraphQL collection fields that would exist if pg_graphql reflected schema net (plain and inflected names). */
export const GRAPHQL_FIELDS = Object.freeze(['http_request_queueCollection', '_http_responseCollection', 'httpRequestQueueCollection', 'httpResponseCollection'])
export const GRAPHQL_PATH = '/graphql/v1'

const s = (v, n = 80) => String(v ?? '').slice(0, n)
const isNetObject = (o) => /^[a-z_]+:net(\.[A-Za-z0-9_$]+)?$/.test(String(o))

/**
 * Re-judge the report's platform exceptions. An absent list (a report from before the exception) excepts nothing.
 * @returns {{ findings: string[], applied: object[], probeRequired: boolean, summary: object[] }}
 */
export function evaluatePlatformExceptions(rep) {
  const findings = []
  const applied = []
  const list = rep?.platform_exceptions
  if (list === undefined || list === null) return { findings, applied, probeRequired: false, summary: [] }
  if (!Array.isArray(list)) return { findings: ['platform_exceptions_malformed'], applied, probeRequired: false, summary: [] }
  for (const e of list) {
    if (!e || typeof e !== 'object') { findings.push('platform_exception_malformed'); continue }
    if (e.id !== PLATFORM_EXCEPTION_ID) { findings.push(`platform_exception_unknown:${s(e.id, 40)}`); continue }
    if (e.fingerprint_version !== PG_NET_FINGERPRINT_VERSION) findings.push(`platform_exception_fingerprint_version:${s(e.fingerprint_version, 60)} (pinned ${PG_NET_FINGERPRINT_VERSION})`)
    if (e.status === 'not_applied') continue // its objects were judged by the strict rules (the database findings say so)
    if (e.status !== 'applied') { findings.push(`platform_exception_status:${s(e.status, 20)}`); continue }
    const c = e.controls || {}
    if (Array.isArray(e.reasons) ? e.reasons.length : true) findings.push('platform_exception_applied_with_reasons')
    if (!Array.isArray(e.objects) || !e.objects.length || !e.objects.every(isNetObject)) findings.push('platform_exception_objects_outside_net')
    if (c.a_role_posture !== true) findings.push('platform_exception_control:a_role_posture')
    if (!['verified', 'unverified_in_sql'].includes(c.b_exposed_schemas)) findings.push(`platform_exception_control:b_exposed_schemas:${s(c.b_exposed_schemas, 30)}`)
    if (c.d_role_search_path !== true) findings.push('platform_exception_control:d_role_search_path')
    if (c.e_egress_rule_outside_exception !== 'enforced') findings.push('platform_exception_control:e_egress_rule')
    if (c.f_no_create !== true) findings.push('platform_exception_control:f_no_create')
    if (e.live_exposure_probe_required !== true) findings.push('platform_exception_probe_not_required')
    applied.push(e)
  }
  const summary = list.filter((e) => e && typeof e === 'object').map((e) => ({
    id: s(e.id, 40), fingerprint_version: s(e.fingerprint_version, 60), status: s(e.status, 20),
    objects: Array.isArray(e.objects) ? e.objects.length : null, exposed_schemas: s(e.controls?.b_exposed_schemas, 30) || null,
    notes: Array.isArray(e.notes) ? e.notes.slice(0, 5).map((n) => s(n, 80)) : [], reasons: Array.isArray(e.reasons) ? e.reasons.slice(0, 5).map((n) => s(n, 160)) : [],
  }))
  // compensating control (c) is mandatory whenever the exception is applied (and the only proof when the SQL could
  // not see the exposed schemas: exposed_schemas_from_dashboard_unverified_in_sql)
  return { findings, applied, probeRequired: applied.length > 0, summary }
}

async function call(fetchFn, url, init, timeoutMs) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  if (typeof t.unref === 'function') t.unref()
  try {
    const res = await fetchFn(url, { ...init, signal: ctl.signal, redirect: 'manual' })
    let body = null
    try { body = await res.json() } catch { /* not JSON */ }
    return { status: res.status, body }
  } catch (e) {
    return { status: 0, body: null, error: s(e?.code || e?.name || 'network', 40) }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Compensating control (c): the live exposure probe, AS the credential's role (its token rides every request).
 * @param {{ origin: string, apiKey: string, token: string, fetch?: Function, timeoutMs?: number }} o
 * @returns {Promise<{ ok: boolean, findings: string[], checks: object[] }>}
 */
export async function probePlatformExposure({ origin, apiKey, token, fetch: fetchFn = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  const base = new URL(origin).origin
  const headers = (extra) => ({ apikey: apiKey, authorization: `Bearer ${token}`, accept: 'application/json', ...extra })
  const checks = []
  for (const p of REST_PROBES) {
    const r = await call(fetchFn, `${base}${p.path}`, { method: p.method, headers: headers({ [p.header]: p.schema, ...(p.body ? { 'content-type': 'application/json' } : {}) }), ...(p.body ? { body: p.body } : {}) }, timeoutMs)
    const code = s(r.body?.code, 20) || null
    checks.push({ name: p.name, status: r.status, code, pass: code === 'PGRST106', ...(r.error ? { error: r.error } : {}) })
  }
  for (const field of GRAPHQL_FIELDS) {
    const query = `{ ${field}(first: 1) { __typename } }`
    const r = await call(fetchFn, `${base}${GRAPHQL_PATH}`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ query }) }, timeoutMs)
    const errors = Array.isArray(r.body?.errors) ? r.body.errors : []
    const unknown = errors.some((e) => /unknown field/i.test(String(e?.message || '')) && String(e?.message || '').includes(field))
    const reflected = r.body?.data != null && typeof r.body.data === 'object' && r.body.data[field] !== undefined && r.body.data[field] !== null
    checks.push({ name: `graphql:${field}`, status: r.status, code: unknown ? 'unknown_field' : s(errors[0]?.message || r.body?.code || r.error || 'no_unknown_field_error', 60), pass: unknown && !reflected, ...(r.error ? { error: r.error } : {}) })
  }
  const findings = checks.filter((c) => !c.pass).map((c) => `exposure_probe_failed:${c.name}:HTTP ${c.status}${c.code ? ` ${c.code}` : ''}`)
  return { ok: findings.length === 0, findings, checks }
}
