// The Supabase pg_net PLATFORM EXCEPTION, server side (src/data/platform-exposure.mjs; docs/SUPABASE-PG-NET-POSTURE.md).
//   * evaluateSelfCheck re-judges the report's platform_exceptions independently: only the known exception id, only the
//     pinned fingerprint version, every compensating control reported as holding, every excepted object in schema net;
//     an applied exception makes the live exposure probe MANDATORY (probeRequired);
//   * probePlatformExposure: PGRST106 for Accept-Profile net / extensions / cron and Content-Profile net, an "unknown
//     field" GraphQL error for net's tables; every other answer (an exposed schema, a 5xx, a network failure, a GraphQL
//     answer that reflects net or is anything but unknown-field) is a finding;
//   * the live source runs the probe AS the token after a passing report with an applied exception, and refuses the
//     boot when it fails; WITHOUT an applied exception the probe is never sent (behaviour unchanged).
// Real PostgREST + PG17 proofs: mcp/leadcommand-action-mcp/test/pg-net-exposure-e2e.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.mjs'
import { evaluateSelfCheck } from '../src/data/credential.mjs'
import { evaluatePlatformExceptions, evaluatePlatformAllowlists, PLATFORM_ALLOWLISTS, probePlatformExposure, PG_NET_FINGERPRINT_VERSION, REST_PROBES, GRAPHQL_FIELDS } from '../src/data/platform-exposure.mjs'
import { createFakePostgrest, passingReport, READER_TOKEN, ANON_KEY } from './support/fake-postgrest.mjs'
import { liveEnv, tmpDir, LIVE_MEMBERSHIP } from './support/live-env.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ORIGIN = 'https://fixture-project.supabase.test'

/** The applied exception exactly as the SQL reports it (shape of the migrations' platform_exceptions entry). */
const applied = (over = {}) => ({
  id: 'supabase_pg_net', fingerprint_version: PG_NET_FINGERPRINT_VERSION, status: 'applied', reasons: [], owner: 'supabase_admin', extension: 'pg_net', extension_version: '0.20.0',
  objects: ['schema:net', 'table:net.http_request_queue', 'table:net._http_response', 'sequence:net.http_request_queue_id_seq', 'function:net.http_get', 'function:net.http_post', 'type:net.request_status'],
  acl: ['schema|net|PUBLIC|USAGE'],
  controls: { a_role_posture: true, b_exposed_schemas: 'unverified_in_sql', c_live_exposure_probe: 'required', d_role_search_path: true, e_egress_rule_outside_exception: 'enforced', f_no_create: true },
  notes: ['exposed_schemas_from_dashboard_unverified_in_sql'], live_exposure_probe_required: true, ...over,
})

test('the pinned fingerprint version is the migrations\' (both files)', () => {
  for (const f of ['PROPOSED_20261019150000_lc_mcp_reader.sql', 'PROPOSED_20261019160000_action_gateway.sql']) {
    const src = fs.readFileSync(path.join(REPO, 'supabase/migrations', f), 'utf8')
    assert.equal(/fp_version constant text := '([^']+)'/.exec(src)?.[1], PG_NET_FINGERPRINT_VERSION, f)
  }
})

test('evaluateSelfCheck: an applied exception passes, is reported, and makes the live probe mandatory; no exception → no probe', () => {
  const v = evaluateSelfCheck(passingReport({ platform_exceptions: [applied()] }))
  assert.equal(v.ok, true, v.findings.join('; '))
  assert.equal(v.probeRequired, true)
  assert.deepEqual(v.info.platform_exceptions.map((x) => [x.id, x.status, x.exposed_schemas, x.notes[0]]), [['supabase_pg_net', 'applied', 'unverified_in_sql', 'exposed_schemas_from_dashboard_unverified_in_sql']])
  for (const rep of [passingReport(), passingReport({ platform_exceptions: [] })]) {
    const n = evaluateSelfCheck(rep)
    assert.equal(n.ok, true)
    assert.equal(n.probeRequired, false)
  }
})

test('evaluateSelfCheck: every tampered / unproven exception is a named finding (never silently trusted)', () => {
  const cases = [
    [applied({ id: 'some_other_platform' }), /platform_exception_unknown:some_other_platform/],
    [applied({ fingerprint_version: 'supabase_pg_net_default_acl.v0' }), /platform_exception_fingerprint_version/],
    [applied({ status: 'maybe' }), /platform_exception_status:maybe/],
    [applied({ reasons: ['owner:table:net.x:postgres'] }), /platform_exception_applied_with_reasons/],
    [applied({ objects: ['schema:net', 'table:public.send_queue'] }), /platform_exception_objects_outside_net/],
    [applied({ objects: [] }), /platform_exception_objects_outside_net/],
    [applied({ controls: { ...applied().controls, a_role_posture: false } }), /platform_exception_control:a_role_posture/],
    [applied({ controls: { ...applied().controls, b_exposed_schemas: 'failed' } }), /platform_exception_control:b_exposed_schemas:failed/],
    [applied({ controls: { ...applied().controls, d_role_search_path: false } }), /platform_exception_control:d_role_search_path/],
    [applied({ controls: { ...applied().controls, e_egress_rule_outside_exception: 'skipped' } }), /platform_exception_control:e_egress_rule/],
    [applied({ controls: { ...applied().controls, f_no_create: false } }), /platform_exception_control:f_no_create/],
    [applied({ live_exposure_probe_required: false }), /platform_exception_probe_not_required/],
  ]
  for (const [entry, re] of cases) {
    const v = evaluateSelfCheck(passingReport({ platform_exceptions: [entry] }))
    assert.equal(v.ok, false, JSON.stringify(entry))
    assert.match(v.findings.join(' | '), re)
  }
  assert.match(evaluateSelfCheck(passingReport({ platform_exceptions: { id: 'x' } })).findings.join(' '), /platform_exceptions_malformed/)
  // NOT applied: the net objects count again (the database's strict findings) and the server names the reasons
  const strict = evaluateSelfCheck(passingReport({ ok: false, findings: ['reachable_egress_functions:["net.http_get(text,jsonb,jsonb,integer)"]'], reachable_egress_functions: ['net.http_get(text,jsonb,jsonb,integer)'],
    platform_exceptions: [applied({ status: 'not_applied', reasons: ['not_extension_member:table:net.side_channel'], controls: null })] }))
  assert.equal(strict.ok, false)
  assert.equal(strict.probeRequired, false)
  assert.match(strict.findings.join(' | '), /pg_net_public: .*platform exception does not apply \(not_extension_member:table:net\.side_channel\).*drop the extension/)
})

/** A fake Supabase edge for the probe: per request, the answer a PostgREST / pg_graphql would give. */
function probeFetch({ exposed = [], graphql = 'unknown', status5xx = false, throwOn = null } = {}) {
  const seen = []
  const fetch = async (url, init = {}) => {
    const u = new URL(url)
    const h = new Headers(init.headers || {})
    seen.push({ method: init.method || 'GET', path: u.pathname + u.search, profile: h.get('accept-profile') || h.get('content-profile'), auth: h.get('authorization'), apikey: h.get('apikey') })
    if (throwOn && u.pathname.includes(throwOn)) throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (status5xx) return json(503, { message: 'unavailable' })
    if (u.pathname === '/graphql/v1') {
      const field = /\{\s*([A-Za-z_]+)/.exec(JSON.parse(init.body).query)[1]
      if (graphql === 'reflected') return json(200, { data: { [field]: { __typename: 'X' } } })
      if (graphql === 'denied') return json(401, { code: '42501', message: 'permission denied for schema graphql_public' })
      return json(200, { data: null, errors: [{ message: `Unknown field "${field}" on type Query` }] })
    }
    const schema = h.get('accept-profile') || h.get('content-profile')
    if (exposed.includes(schema)) return init.method === 'POST' ? json(404, { code: 'PGRST202', message: 'not found' }) : json(200, [])
    return json(406, { code: 'PGRST106', message: 'Invalid schema', hint: 'Only the following schemas are exposed: public, graphql_public' })
  }
  return { fetch, seen }
}

test('probePlatformExposure: refused as required → ok; the fixed request set rides the role token on the same origin', async () => {
  const f = probeFetch()
  const p = await probePlatformExposure({ origin: ORIGIN, apiKey: ANON_KEY, token: READER_TOKEN, fetch: f.fetch })
  assert.equal(p.ok, true, JSON.stringify(p.checks))
  assert.equal(f.seen.length, REST_PROBES.length + GRAPHQL_FIELDS.length)
  assert.deepEqual(f.seen.slice(0, 4).map((r) => [r.method, r.profile]), [['GET', 'net'], ['POST', 'net'], ['GET', 'extensions'], ['GET', 'cron']])
  assert.ok(f.seen.every((r) => r.auth === `Bearer ${READER_TOKEN}` && r.apikey === ANON_KEY))
  assert.ok(f.seen.filter((r) => r.method === 'POST' && r.profile === 'net').every((r) => /lc_exposure_probe_never_exists/.test(r.path)), 'the POST names a function that cannot exist: no side effect when net IS exposed')
})

test('probePlatformExposure: an exposed schema, a GraphQL that reflects net or is not "unknown field", a 5xx or a network failure → findings', async () => {
  for (const [label, opts, re] of [
    ['net exposed', { exposed: ['net'] }, /exposure_probe_failed:rest_get_net:HTTP 200.*exposure_probe_failed:rest_post_net:HTTP 404 PGRST202/],
    ['extensions exposed', { exposed: ['extensions'] }, /exposure_probe_failed:rest_get_extensions/],
    ['cron exposed', { exposed: ['cron'] }, /exposure_probe_failed:rest_get_cron/],
    ['graphql reflects net', { graphql: 'reflected' }, /exposure_probe_failed:graphql:http_request_queueCollection/],
    ['graphql denied (not an unknown-field answer)', { graphql: 'denied' }, /exposure_probe_failed:graphql:http_request_queueCollection:HTTP 401/],
    ['service unavailable', { status5xx: true }, /exposure_probe_failed:rest_get_net:HTTP 503/],
    ['network failure', { throwOn: '/graphql/v1' }, /exposure_probe_failed:graphql:.*HTTP 0/],
  ]) {
    const p = await probePlatformExposure({ origin: ORIGIN, apiKey: ANON_KEY, token: READER_TOKEN, fetch: probeFetch(opts).fetch })
    assert.equal(p.ok, false, label)
    assert.match(p.findings.join(' | '), re, label)
  }
})

/** The fake PostgREST for everything else; the probe's requests answered by `edge`. */
function liveFetch(pg, edge) {
  return async (url, init = {}) => {
    const u = new URL(String(url))
    const h = new Headers(init.headers || {})
    const profile = h.get('accept-profile') || h.get('content-profile')
    if (u.pathname === '/graphql/v1' || (profile && profile !== 'public')) return edge.fetch(url, init)
    return pg.fetch(url, init)
  }
}

test('boot (live, fake PostgREST): an applied exception → the probe runs AS the token; refused as required → the server starts, audited with the exception and the probe', async () => {
  const pg = createFakePostgrest({ report: passingReport({ platform_exceptions: [applied()] }), membership: LIVE_MEMBERSHIP })
  const edge = probeFetch()
  const audit = []
  const app = await buildApp({ env: liveEnv({ dir: tmpDir() }), baseFetch: liveFetch(pg, edge), scrub: false, auditSink: (r) => audit.push(r) })
  await app.close()
  const check = audit.find((a) => a.event === 'credential_self_check')
  assert.equal(check.outcome, 'ok', JSON.stringify(check.findings))
  assert.equal(check.platform_exceptions[0].status, 'applied')
  assert.equal(check.exposure_probe.length, REST_PROBES.length + GRAPHQL_FIELDS.length)
  assert.equal(edge.seen.length, REST_PROBES.length + GRAPHQL_FIELDS.length)
})

test('boot (live, fake PostgREST): an applied exception with net exposed → the server REFUSES to start (audited, no server_boot)', async () => {
  const pg = createFakePostgrest({ report: passingReport({ platform_exceptions: [applied()] }), membership: LIVE_MEMBERSHIP })
  const audit = []
  await assert.rejects(buildApp({ env: liveEnv({ dir: tmpDir() }), baseFetch: liveFetch(pg, probeFetch({ exposed: ['net'] })), scrub: false, auditSink: (r) => audit.push(r) }),
    (e) => e.code === 'CREDENTIAL_SELF_CHECK_FAILED' && /exposure_probe_failed:rest_get_net/.test(e.message))
  assert.equal(audit.find((a) => a.event === 'credential_self_check').outcome, 'refused')
  assert.equal(audit.some((a) => a.event === 'server_boot'), false)
})

test('boot (live, fake PostgREST): WITHOUT an applied exception the probe is never sent (non-Supabase / no pg_net: unchanged)', async () => {
  const pg = createFakePostgrest({ report: passingReport(), membership: LIVE_MEMBERSHIP })
  const edge = probeFetch()
  const app = await buildApp({ env: liveEnv({ dir: tmpDir() }), baseFetch: liveFetch(pg, edge), scrub: false, auditSink: () => {} })
  await app.close()
  assert.equal(edge.seen.length, 0)
  assert.deepEqual(pg.rpcsCalled(), ['lc_mcp_reader_self_check'])
})

// ── the pinned platform allowlists of the indirect-egress rule (public.lc_egress_platform_allowlists) ──
const pgisAllow = (over = {}) => ({ id: 'supabase_postgis_dynamic_sql', version: 'supabase_postgis_dynamic_sql.v1', status: 'applied', rule: 'dynamic_sql_function', reasons: [],
  extension: 'postgis', extension_version: '3.3.7', extension_owner: 'supabase_admin', extension_schema: 'public',
  objects: [...PLATFORM_ALLOWLISTS.supabase_postgis_dynamic_sql.objects], absent: [], ...over })
const etAllow = (over = {}) => ({ id: 'supabase_pg_net_access_event_trigger', version: 'supabase_pg_net_access_event_trigger.v1', status: 'applied', rule: 'event_trigger_egress',
  reasons: [], enabled: 'O', objects: ['event:issue_pg_net_access -> extensions.grant_pg_net_access()'], ...over })

test('the JS allowlist pins are the migrations\' (ids, versions, the 26 PostGIS signatures, the event trigger)', () => {
  for (const f of ['PROPOSED_20261019150000_lc_mcp_reader.sql', 'PROPOSED_20261019160000_action_gateway.sql']) {
    const src = fs.readFileSync(path.join(REPO, 'supabase/migrations', f), 'utf8')
    const sigs = [...(/pg_sigs constant text\[\] := array\[([\s\S]*?)\];/.exec(src)[1]).matchAll(/'([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(sigs, [...PLATFORM_ALLOWLISTS.supabase_postgis_dynamic_sql.objects], f)
    assert.equal(/pg_version constant text := '([^']+)'/.exec(src)[1], PLATFORM_ALLOWLISTS.supabase_postgis_dynamic_sql.version, f)
    assert.equal(/et_version constant text := '([^']+)'/.exec(src)[1], PLATFORM_ALLOWLISTS.supabase_pg_net_access_event_trigger.version, f)
  }
})

test('evaluateSelfCheck: pinned allowlists (applied / not_applied / not_present) pass and are summarised; absent list excepts nothing', () => {
  for (const list of [undefined, [], [pgisAllow(), etAllow()], [pgisAllow({ status: 'not_applied', reasons: ['extension_version:3.3.8'] }), etAllow({ status: 'not_present', objects: [] })]]) {
    const v = evaluateSelfCheck(passingReport({ platform_allowlists: list }))
    assert.equal(v.ok, true, JSON.stringify(v.findings))
  }
  const v = evaluateSelfCheck(passingReport({ platform_allowlists: [pgisAllow(), etAllow()] }))
  assert.deepEqual(v.info.platform_allowlists.map((x) => [x.id, x.status, x.objects]), [['supabase_postgis_dynamic_sql', 'applied', 26], ['supabase_pg_net_access_event_trigger', 'applied', 1]])
})

test('evaluateSelfCheck: an unknown / re-versioned / widened / reasoned allowlist is a finding', () => {
  const cases = [
    [[{ ...etAllow(), id: 'supabase_everything' }], /platform_allowlist_unknown:supabase_everything/],
    [[pgisAllow({ version: 'supabase_postgis_dynamic_sql.v2' })], /platform_allowlist_version:supabase_postgis_dynamic_sql/],
    [[pgisAllow({ objects: [...PLATFORM_ALLOWLISTS.supabase_postgis_dynamic_sql.objects, 'public.run_sql(text)'] })], /platform_allowlist_objects_outside_pin:supabase_postgis_dynamic_sql/],
    [[etAllow({ objects: ['event:lc_other -> public.hook()'] })], /platform_allowlist_objects_outside_pin:supabase_pg_net_access_event_trigger/],
    [[pgisAllow({ reasons: ['owner:public.lockrow(text,text,text):postgres'] })], /platform_allowlist_applied_with_reasons/],
    [[pgisAllow({ status: 'partially' })], /platform_allowlist_status/],
    [{ id: 'x' }, /platform_allowlists_malformed/],
  ]
  for (const [list, re] of cases) {
    const v = evaluateSelfCheck(passingReport({ platform_allowlists: list }))
    assert.equal(v.ok, false, JSON.stringify(list).slice(0, 80))
    assert.match(v.findings.join(' '), re)
  }
  assert.deepEqual(evaluatePlatformAllowlists({}).findings, [])
})
