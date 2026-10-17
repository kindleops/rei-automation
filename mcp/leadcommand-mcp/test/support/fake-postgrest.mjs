// A FAKE PostgREST for live-mode unit tests (no network, synthetic rows only).
// It behaves like PostgREST where these tests depend on it:
//   * it decodes the bearer token's role claim and answers 401 PGRST301 unless the claim
//     is the accepted role (lc_mcp_reader). The signature is not checked; the real
//     PostgREST does that in test/postgrest-e2e.test.mjs;
//   * any non-read on a table → 403 / 42501, as the database refuses it for lc_mcp_reader;
//   * GET / HEAD with eq. / in. filters, limit, Prefer count=exact → Content-Range;
//   * RPCs: lc_mcp_reader_self_check (a configurable report), lc_mcp_operator_role,
//     entity_graph_property_records, campaign_entity_contact_review_flags.
// Every request is recorded: tests assert exactly which relations / RPCs were reached
// and with which credentials.
import { RELATION_NAMES, RPC_SIGNATURES, READER_ROLE } from '../../src/data/inventory.mjs'

export function b64url(o) {
  return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
/** An UNSIGNED-but-shaped test token (fake signature). Never a real credential. */
export function testJwt(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  return `${b64url(header)}.${b64url(payload)}.fake-signature-for-tests-only`
}
export const nowSec = () => Math.floor(Date.now() / 1000)
export const READER_TOKEN = testJwt({ role: READER_ROLE, iss: 'supabase', iat: nowSec(), exp: nowSec() + 30 * 86_400 })
export const ANON_KEY = testJwt({ role: 'anon', iss: 'supabase', iat: nowSec(), exp: nowSec() + 3650 * 86_400 })
export const SERVICE_ROLE_KEY = testJwt({ role: 'service_role', iss: 'supabase', iat: nowSec(), exp: nowSec() + 3650 * 86_400 })

/** A report the real lc_mcp_reader_self_check returns for a correctly applied role. */
export function passingReport(over = {}) {
  return {
    version: 1, role: READER_ROLE, exists: true, current_user: READER_ROLE, session_user: 'authenticator', server_version_num: 170006,
    attributes: { superuser: false, bypassrls: false, createrole: false, createdb: false, replication: false, canlogin: false, inherit: false },
    member_of: [], granted_to: ['authenticator'],
    relations: RELATION_NAMES.map((name) => ({ name, exists: true, kind: ['probate_status', 'preforeclosure_status_v2'].includes(name) ? 'v' : ['mv_map_market_sales', 'eg_buyer_index'].includes(name) ? 'm' : 'r', select: true, rls: true, permissive_policy: true, restrictive_policy: false, invoker_view: false })),
    functions: RPC_SIGNATURES.map((signature) => ({ signature, exists: true, executable: true, volatility: 's', security_definer: !/self_check/.test(signature), language: 'sql', search_path_pinned: true })),
    write_privileges: [], sequence_privileges: [], schema_create: [], database_create: false, database_temp: true,
    reachable_definer_functions: [], reachable_egress_functions: [], exposed_select_outside_inventory: [], select_outside_inventory: [],
    generated_at: new Date().toISOString(), findings: [], ok: true,
    ...over,
  }
}

const decodeRole = (auth) => {
  const tok = String(auth || '').replace(/^Bearer\s+/i, '')
  try { return JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).role || null } catch { return null }
}

/** Rows that drive every branch of the reused services, so each inventory relation is reached. */
export const LIVE_ROWS = Object.freeze({
  properties: [{ property_id: 'P1', master_owner_id: 'O1', property_address_full: '1 Fixture St', property_address_city: 'Fixture', property_address_state: 'TX', property_address_zip: '75001', latitude: 32.9, longitude: -96.8, units_count: 1, property_type: 'Single Family', building_square_feet: 1500, market: 'Fixture Metro, TX' }],
  master_owners: [{ master_owner_id: 'O1', display_name: 'FIXTURE OWNER', joined_property_ids_json: '["P1"]' }],
  prospects: [{ prospect_id: 'R1', master_owner_id: 'O1', full_name: 'FIXTURE PERSON', linked_property_ids_json: '["P1"]', phones_json: [] }],
  phones: [], emails: [], inbox_thread_state: [], acquisition_opportunities: [],
  property_acquisition_scores: [{ property_id: 'P1', aos_score: 71, decision_tier: 'A', computed_at: new Date().toISOString(), evidence: {} }],
  eg_property_facts: [{ property_id: 'P1', market: 'Fixture Metro, TX', zip_code: '75001', property_address_state: 'TX', refreshed_at: new Date().toISOString() }],
  campaign_target_graph: [{ property_id: 'P1', canonical_e164: '+15550100001', seller_person_key: 'K1', sms_eligible: true }],
  campaign_targets: [{ id: 'T1', property_id: 'P1', campaign_id: '00000000-0000-4000-8000-0000000000c1', target_status: 'sent' }],
  campaigns: [{ id: '00000000-0000-4000-8000-0000000000c1', name: 'Fixture Spring', status: 'active', updated_at: new Date().toISOString() }],
  mi_rollup_builds: [{ build_id: 42, status: 'ready' }],
  mi_geo_period_rollup: [{ build_id: 42, geo_key: '75001', period: '1y', sale_count: 12 }],
  census_geo_metrics: [], eg_buyer_index: [{ buyer_id: 'B1' }], mv_map_market_sales: [],
  probate_status: [], preforeclosure_status_v2: [], sms_suppression_list: [],
})

/**
 * @param {{ rows?: object, report?: object|Function, membership?: Array<{org_id,user_id,role}>, acceptRole?: string, rpcError?: object }} [o]
 */
export function createFakePostgrest({ rows = LIVE_ROWS, report = passingReport(), membership = [], acceptRole = READER_ROLE, rpcError = {} } = {}) {
  const requests = []
  const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  async function fakeFetch(input, init = {}) {
    const url = new URL(String(input))
    const method = String(init.method || 'GET').toUpperCase()
    const h = new Headers(init.headers || {})
    const role = decodeRole(h.get('authorization'))
    const rec = { method, path: url.pathname, role, apikey_role: decodeRole(`Bearer ${h.get('apikey') || ''}`), prefer: h.get('prefer'), signal: Boolean(init.signal) }
    requests.push(rec)
    if (!h.get('apikey')) return json(401, { message: 'No API key found in request' })
    if (role !== acceptRole) return json(401, { code: 'PGRST301', message: 'JWT role not accepted' })
    const rpc = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/.exec(url.pathname)
    if (rpc) {
      rec.rpc = rpc[1]
      if (rpcError[rpc[1]]) return json(rpcError[rpc[1]].status || 400, rpcError[rpc[1]])
      const args = init.body ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams)
      if (rpc[1] === 'lc_mcp_reader_self_check') return json(200, typeof report === 'function' ? report(args) : report)
      if (rpc[1] === 'lc_mcp_operator_role') return json(200, membership.find((m) => m.org_id === args.p_org_id && m.user_id === args.p_user_id)?.role ?? null)
      if (rpc[1] === 'entity_graph_property_records') return json(200, { mortgages: [], liens: [], sales: [], foreclosures: [], parcel: null })
      if (rpc[1] === 'campaign_entity_contact_review_flags') return json(200, (args.p_property_ids || []).map((id) => ({ property_id: id, requires_review: false, exclusion_reasons: [] })))
      return json(404, { code: 'PGRST202', message: 'function not found' })
    }
    const tbl = /^\/rest\/v1\/([A-Za-z0-9_]+)$/.exec(url.pathname)
    if (!tbl) return json(404, { message: 'not found' })
    rec.relation = tbl[1]
    if (method !== 'GET' && method !== 'HEAD') return json(403, { code: '42501', message: `permission denied for table ${tbl[1]}` })
    let out = [...(rows[tbl[1]] || [])]
    for (const [k, v] of url.searchParams) {
      if (['select', 'limit', 'order', 'offset', 'or', 'and'].includes(k)) continue
      if (v.startsWith('eq.')) out = out.filter((r) => String(r[k]) === v.slice(3))
      else if (v.startsWith('in.(')) { const s = new Set(v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, ''))); out = out.filter((r) => s.has(String(r[k]))) }
    }
    const limit = Number(url.searchParams.get('limit'))
    const total = out.length
    if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit)
    const range = { 'content-range': total ? `0-${Math.max(out.length - 1, 0)}/${total}` : `*/${total}` }
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'application/json', ...range } })
    if (/vnd\.pgrst\.object/.test(h.get('accept') || '')) return out.length === 1 ? json(200, out[0], range) : json(406, { code: 'PGRST116', message: 'not one row' })
    return json(200, out, range)
  }
  return {
    fetch: fakeFetch,
    requests,
    relationsRead: () => [...new Set(requests.filter((r) => r.relation).map((r) => r.relation))].sort(),
    rpcsCalled: () => [...new Set(requests.filter((r) => r.rpc).map((r) => r.rpc))].sort(),
  }
}
