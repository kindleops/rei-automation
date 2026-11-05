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
//                                       GraphQL endpoint must answer, to queries naming net's tables, EITHER an
//                                       unknown-field error (the resolver runs and does not reflect net) OR PostgREST's
//                                       exact 42501 for a role that cannot execute the resolver at all (no USAGE on
//                                       schema graphql_public / no EXECUTE on graphql_public.graphql: no GraphQL for
//                                       that role, so nothing to reflect). The four GraphQL answers must agree. Any
//                                       other answer (data, another error or code, a 5xx, a timeout, a network failure,
//                                       a body that is not exactly one of those shapes) refuses the server.
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
/**
 * The ONE accepted GraphQL answer other than "unknown field": the role cannot execute the resolver. Supabase routes
 * /graphql/v1 to PostgREST POST /rpc/graphql (Content-Profile: graphql_public); PostgREST surfaces PostgreSQL's 42501
 * for an AUTHENTICATED role (the probe always sends the credential's role token) as HTTP 403 with exactly
 *   {"code":"42501","details":null,"hint":null,"message":"permission denied for schema graphql_public"}   (no USAGE)
 *   {"code":"42501","details":null,"hint":null,"message":"permission denied for function graphql"}        (no EXECUTE)
 * (observed on PostgREST 16.4 + PostgreSQL 17, mcp/leadcommand-mcp/test/graphql-access-e2e.test.mjs). Nothing else is
 * accepted: not a 401 (the request did not run as the role), not a 42501 naming any other object (e.g. pg_graphql's
 * internal schema graphql: the resolver RAN), not a body carrying data / errors / any other key.
 */
export const GRAPHQL_NO_ACCESS_MESSAGES = Object.freeze(['permission denied for schema graphql_public', 'permission denied for function graphql'])
/** The pass variants, as the boot audit line names them (`<check>:refused_as_required:<variant>`). */
export const PROBE_VARIANTS = Object.freeze({ PGRST106: 'pgrst106', UNKNOWN_FIELD: 'unknown_field', NO_GRAPHQL_ACCESS: 'refused_no_graphql_access' })
const NO_ACCESS_KEYS = new Set(['code', 'message', 'details', 'hint'])

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

/**
 * The PINNED platform allowlists of the indirect-egress rule (public.lc_egress_platform_allowlists, docs/SUPABASE-PG-NET-POSTURE.md
 * §4b). The SAME constants as the migrations (a test asserts both). A new id, version or object is a reviewed change.
 */
export const PLATFORM_ALLOWLISTS = Object.freeze({
  supabase_postgis_dynamic_sql: Object.freeze({
    version: 'supabase_postgis_dynamic_sql.v1',
    objects: Object.freeze([
      'public.addgeometrycolumn(character varying,character varying,character varying,character varying,integer,character varying,integer,boolean)',
      'public.addgeometrycolumn(character varying,character varying,character varying,integer,character varying,integer,boolean)',
      'public.addgeometrycolumn(character varying,character varying,integer,character varying,integer,boolean)',
      'public.checkauth(text,text,text)', 'public.checkauth(text,text)', 'public.disablelongtransactions()', 'public.enablelongtransactions()',
      'public.dropgeometrycolumn(character varying,character varying,character varying,character varying)',
      'public.dropgeometrycolumn(character varying,character varying,character varying)', 'public.dropgeometrycolumn(character varying,character varying)',
      'public.dropgeometrytable(character varying,character varying,character varying)', 'public.dropgeometrytable(character varying,character varying)',
      'public.dropgeometrytable(character varying)', 'public.lockrow(text,text,text,text,timestamp without time zone)', 'public.lockrow(text,text,text,text)',
      'public.lockrow(text,text,text)', 'public.lockrow(text,text,text,timestamp without time zone)', 'public.populate_geometry_columns(boolean)',
      'public.populate_geometry_columns(oid,boolean)', 'public.postgis_extensions_upgrade()', 'public.st_findextent(text,text,text)', 'public.st_findextent(text,text)',
      'public.unlockrows(text)', 'public.updategeometrysrid(character varying,character varying,character varying,character varying,integer)',
      'public.updategeometrysrid(character varying,character varying,character varying,integer)', 'public.updategeometrysrid(character varying,character varying,integer)']),
  }),
  supabase_pg_net_access_event_trigger: Object.freeze({
    version: 'supabase_pg_net_access_event_trigger.v1',
    objects: Object.freeze(['event:issue_pg_net_access -> extensions.grant_pg_net_access()']),
  }),
})
const ALLOWLIST_STATUSES = ['applied', 'not_applied', 'not_present']

/**
 * Re-judge the report's platform_allowlists. An absent list (a report from before the allowlists) excepts nothing.
 * Only the pinned ids and versions; an APPLIED entry must carry no reasons and only pinned objects. Anything else: a finding.
 * @returns {{ findings: string[], summary: object[] }}
 */
export function evaluatePlatformAllowlists(rep) {
  const list = rep?.platform_allowlists
  if (list === undefined || list === null) return { findings: [], summary: [] }
  if (!Array.isArray(list)) return { findings: ['platform_allowlists_malformed'], summary: [] }
  const findings = []
  for (const e of list) {
    if (!e || typeof e !== 'object') { findings.push('platform_allowlist_malformed'); continue }
    const pin = Object.hasOwn(PLATFORM_ALLOWLISTS, e.id) ? PLATFORM_ALLOWLISTS[e.id] : null
    if (!pin) { findings.push(`platform_allowlist_unknown:${s(e.id, 40)}`); continue }
    if (e.version !== pin.version) findings.push(`platform_allowlist_version:${s(e.id, 40)}:${s(e.version, 60)} (pinned ${pin.version})`)
    if (!ALLOWLIST_STATUSES.includes(e.status)) { findings.push(`platform_allowlist_status:${s(e.id, 40)}:${s(e.status, 20)}`); continue }
    if (e.status !== 'applied') continue // nothing excepted: those objects were judged by the strict rule (the database findings say so)
    if (!Array.isArray(e.reasons) || e.reasons.length) findings.push(`platform_allowlist_applied_with_reasons:${s(e.id, 40)}`)
    if (!Array.isArray(e.objects) || !e.objects.every((o) => pin.objects.includes(o))) findings.push(`platform_allowlist_objects_outside_pin:${s(e.id, 40)}`)
  }
  const summary = list.filter((e) => e && typeof e === 'object').map((e) => ({
    id: s(e.id, 40), version: s(e.version, 60), status: s(e.status, 20),
    objects: Array.isArray(e.objects) ? e.objects.length : null, reasons: Array.isArray(e.reasons) ? e.reasons.slice(0, 5).map((n) => s(n, 160)) : [],
  }))
  return { findings, summary }
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

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Judge ONE GraphQL probe answer for `field` ({ status, body, error? } as call() returns it). Pure; exported for tests.
 * @returns {{ pass: boolean, variant: string|null, code: string }}
 */
export function classifyGraphqlAnswer(field, r) {
  if (r?.error) return { pass: false, variant: null, code: s(r.error, 60) }
  const body = r?.body
  if (!isPlainObject(body)) return { pass: false, variant: null, code: 'malformed_body' }
  const errors = Array.isArray(body.errors) ? body.errors : []
  const unknown = errors.some((e) => /unknown field/i.test(String(e?.message || '')) && String(e?.message || '').includes(field))
  const reflected = body.data != null && typeof body.data === 'object' && body.data[field] !== undefined && body.data[field] !== null
  if (unknown && !reflected) return { pass: true, variant: PROBE_VARIANTS.UNKNOWN_FIELD, code: 'unknown_field' }
  const noAccess = r.status === 403 && body.code === '42501' && GRAPHQL_NO_ACCESS_MESSAGES.includes(body.message)
    && Object.keys(body).every((k) => NO_ACCESS_KEYS.has(k)) && body.details == null && body.hint == null
  if (noAccess) return { pass: true, variant: PROBE_VARIANTS.NO_GRAPHQL_ACCESS, code: '42501' }
  return { pass: false, variant: null, code: s(errors[0]?.message || body.code || 'no_unknown_field_error', 60) }
}

/** The boot audit line's exposure_probe entries: `<check>:refused_as_required:<variant>` or `<check>:EXPOSED_OR_UNPROVEN`. */
export const probeAuditEntries = (probe) => (probe?.checks || []).map((c) => `${c.name}:${c.pass ? `refused_as_required:${c.variant}` : 'EXPOSED_OR_UNPROVEN'}`)

/**
 * Compensating control (c): the live exposure probe, AS the credential's role (its token rides every request).
 * @param {{ origin: string, apiKey: string, token: string, fetch?: Function, timeoutMs?: number }} o
 * @returns {Promise<{ ok: boolean, findings: string[], checks: object[], graphql_variant: string|null }>}
 */
export async function probePlatformExposure({ origin, apiKey, token, fetch: fetchFn = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  const base = new URL(origin).origin
  const headers = (extra) => ({ apikey: apiKey, authorization: `Bearer ${token}`, accept: 'application/json', ...extra })
  const checks = []
  for (const p of REST_PROBES) {
    const r = await call(fetchFn, `${base}${p.path}`, { method: p.method, headers: headers({ [p.header]: p.schema, ...(p.body ? { 'content-type': 'application/json' } : {}) }), ...(p.body ? { body: p.body } : {}) }, timeoutMs)
    const code = s(r.body?.code, 20) || null
    const pass = code === 'PGRST106'
    checks.push({ name: p.name, status: r.status, code, pass, variant: pass ? PROBE_VARIANTS.PGRST106 : null, ...(r.error ? { error: r.error } : {}) })
  }
  for (const field of GRAPHQL_FIELDS) {
    const query = `{ ${field}(first: 1) { __typename } }`
    const r = await call(fetchFn, `${base}${GRAPHQL_PATH}`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ query }) }, timeoutMs)
    const v = classifyGraphqlAnswer(field, r)
    checks.push({ name: `graphql:${field}`, status: r.status, code: v.code, pass: v.pass, variant: v.variant, ...(r.error ? { error: r.error } : {}) })
  }
  const findings = checks.filter((c) => !c.pass).map((c) => `exposure_probe_failed:${c.name}:HTTP ${c.status}${c.code ? ` ${c.code}` : ''}`)
  // one role, one resolver: the four GraphQL answers must be the SAME accepted variant (a mix is not a proof of either)
  const gql = checks.filter((c) => c.name.startsWith('graphql:'))
  const variants = [...new Set(gql.map((c) => c.variant))]
  if (gql.every((c) => c.pass) && variants.length !== 1) findings.push(`exposure_probe_failed:graphql:inconsistent_variants:${variants.join('+')}`)
  return { ok: findings.length === 0, findings, checks, graphql_variant: !findings.length && variants.length === 1 ? variants[0] : null }
}
