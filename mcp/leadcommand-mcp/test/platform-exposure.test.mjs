// The Supabase pg_net PLATFORM EXCEPTION, server side (src/data/platform-exposure.mjs; docs/SUPABASE-PG-NET-POSTURE.md).
//   * evaluateSelfCheck re-judges the report's platform_exceptions independently: only the known exception id, only the
//     pinned fingerprint version, every compensating control reported as holding, every excepted object in schema net;
//     an applied exception makes the live exposure probe MANDATORY (probeRequired);
//   * probePlatformExposure: PGRST106 for Accept-Profile net / extensions / cron and Content-Profile net; for net's
//     tables GraphQL answers EITHER "unknown field" OR PostgREST's exact 42501 (HTTP 403) for a role that cannot
//     execute the resolver (refused_no_graphql_access), the four answers agreeing; every other answer (an exposed
//     schema, a 5xx, a timeout, a network failure, a GraphQL answer that reflects net, another error / code / status,
//     a malformed body, a mix of variants) is a finding;
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
import { evaluatePlatformExceptions, evaluatePlatformAllowlists, PLATFORM_ALLOWLISTS, probePlatformExposure, classifyGraphqlAnswer, probeAuditEntries, PROBE_VARIANTS, GRAPHQL_NO_ACCESS_MESSAGES, PG_NET_FINGERPRINT_VERSION, REST_PROBES, GRAPHQL_FIELDS } from '../src/data/platform-exposure.mjs'
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
// PostgREST 16.4's exact 42501 bodies on POST /rpc/graphql AS an authenticated role (HTTP 403; observed on PG17)
const PGRST_42501 = (message) => ({ code: '42501', details: null, hint: null, message })
const NO_USAGE = PGRST_42501('permission denied for schema graphql_public')
const NO_EXECUTE = PGRST_42501('permission denied for function graphql')
const unknownField = (field) => ({ data: null, errors: [{ message: `Unknown field "${field}" on type "Query"` }] })

/** graphql: 'unknown' | 'reflected' | 'no_usage' | 'no_execute' | 'mixed' | 'timeout' | 'raw' (graphqlRaw: (field) => Response) */
function probeFetch({ exposed = [], graphql = 'unknown', graphqlRaw = null, status5xx = false, throwOn = null } = {}) {
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
      if (graphql === 'raw') return graphqlRaw(field)
      if (graphql === 'timeout') {
        // a server that never answers (a ref'd handle stands in for the open socket a real fetch holds)
        return new Promise((_, reject) => { const hold = setTimeout(() => {}, 60_000); init.signal.addEventListener('abort', () => { clearTimeout(hold); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }) })
      }
      if (graphql === 'reflected') return json(200, { data: { [field]: { __typename: 'X' } } })
      if (graphql === 'no_usage') return json(403, NO_USAGE)
      if (graphql === 'no_execute') return json(403, NO_EXECUTE)
      if (graphql === 'mixed') return field === GRAPHQL_FIELDS[0] ? json(403, NO_USAGE) : json(200, unknownField(field))
      return json(200, unknownField(field))
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

test('probePlatformExposure: the variants are named per check and in the audit entries (unknown field)', async () => {
  const p = await probePlatformExposure({ origin: ORIGIN, apiKey: ANON_KEY, token: READER_TOKEN, fetch: probeFetch().fetch })
  assert.equal(p.graphql_variant, 'unknown_field')
  assert.deepEqual(probeAuditEntries(p), [...REST_PROBES.map((r) => `${r.name}:refused_as_required:pgrst106`), ...GRAPHQL_FIELDS.map((f) => `graphql:${f}:refused_as_required:unknown_field`)])
})

test('probePlatformExposure: the role CANNOT EXECUTE the resolver (PostgREST 42501, no USAGE on graphql_public / no EXECUTE on graphql_public.graphql) → ok, refused_no_graphql_access', async () => {
  for (const graphql of ['no_usage', 'no_execute']) {
    const p = await probePlatformExposure({ origin: ORIGIN, apiKey: ANON_KEY, token: READER_TOKEN, fetch: probeFetch({ graphql }).fetch })
    assert.equal(p.ok, true, `${graphql}: ${JSON.stringify(p.checks)}`)
    assert.equal(p.graphql_variant, 'refused_no_graphql_access')
    assert.deepEqual(p.checks.filter((c) => c.name.startsWith('graphql:')).map((c) => [c.status, c.code, c.variant]), Array(GRAPHQL_FIELDS.length).fill([403, '42501', 'refused_no_graphql_access']))
    assert.deepEqual(probeAuditEntries(p).slice(REST_PROBES.length), GRAPHQL_FIELDS.map((f) => `graphql:${f}:refused_as_required:refused_no_graphql_access`))
    assert.ok(probeAuditEntries(p).slice(0, REST_PROBES.length).every((x) => x.endsWith(':refused_as_required:pgrst106')), 'REST is still required to refuse')
  }
  // the no-access answer never excuses REST: net exposed still refuses
  const p = await probePlatformExposure({ origin: ORIGIN, apiKey: ANON_KEY, token: READER_TOKEN, fetch: probeFetch({ graphql: 'no_usage', exposed: ['net'] }).fetch })
  assert.equal(p.ok, false)
  assert.match(p.findings.join(' | '), /rest_get_net/)
})

test('classifyGraphqlAnswer: only "unknown field" and the EXACT PostgREST 42501 for graphql_public / graphql_public.graphql pass', () => {
  const F = GRAPHQL_FIELDS[0]
  assert.deepEqual(GRAPHQL_NO_ACCESS_MESSAGES, ['permission denied for schema graphql_public', 'permission denied for function graphql'])
  assert.deepEqual(Object.values(PROBE_VARIANTS), ['pgrst106', 'unknown_field', 'refused_no_graphql_access'])
  const pass = [
    ['unknown field', { status: 200, body: unknownField(F) }, 'unknown_field'],
    ['no USAGE on graphql_public', { status: 403, body: NO_USAGE }, 'refused_no_graphql_access'],
    ['no EXECUTE on graphql_public.graphql', { status: 403, body: NO_EXECUTE }, 'refused_no_graphql_access'],
    ['42501 without details / hint keys', { status: 403, body: { code: '42501', message: 'permission denied for schema graphql_public' } }, 'refused_no_graphql_access'],
  ]
  for (const [label, r, variant] of pass) assert.deepEqual([classifyGraphqlAnswer(F, r).pass, classifyGraphqlAnswer(F, r).variant], [true, variant], label)
  const refuse = [
    ['data reflecting net', { status: 200, body: { data: { [F]: { __typename: 'X' } } } }],
    ['data AND an unknown-field error (net reflected)', { status: 200, body: { data: { [F]: { __typename: 'X' } }, errors: [{ message: `Unknown field "${F}"` }] } }],
    ['empty data, no errors', { status: 200, body: { data: {} } }],
    ['unknown field naming ANOTHER field', { status: 200, body: unknownField('somethingElseCollection') }],
    ['another GraphQL error', { status: 200, body: { data: null, errors: [{ message: 'syntax error' }] } }],
    ['HTTP 500', { status: 500, body: { message: 'internal' } }],
    ['HTTP 503 with the 42501 body', { status: 503, body: NO_USAGE }],
    ['42501 as HTTP 401 (did not run as the role)', { status: 401, body: NO_USAGE }],
    ['42501 as HTTP 200', { status: 200, body: NO_USAGE }],
    ['42501 naming pg_graphql\'s internal schema (the resolver RAN)', { status: 403, body: PGRST_42501('permission denied for schema graphql') }],
    ['42501 naming another schema', { status: 403, body: PGRST_42501('permission denied for schema net') }],
    ['42501 naming another function', { status: 403, body: PGRST_42501('permission denied for function resolve') }],
    ['42501 on a table', { status: 403, body: PGRST_42501('permission denied for table http_request_queue') }],
    ['42501, message with a suffix', { status: 403, body: PGRST_42501('permission denied for schema graphql_public; hello') }],
    ['42501, message differently cased', { status: 403, body: PGRST_42501('Permission denied for schema graphql_public') }],
    ['another code, same message', { status: 403, body: { ...NO_USAGE, code: '42000' } }],
    ['PGRST301 (JWT)', { status: 403, body: { code: 'PGRST301', details: null, hint: null, message: 'JWT invalid' } }],
    ['PGRST202 (no resolver)', { status: 404, body: { code: 'PGRST202', details: null, hint: null, message: 'Could not find the function graphql_public.graphql' } }],
    ['PGRST106 (graphql_public not exposed)', { status: 406, body: { code: 'PGRST106', details: null, hint: null, message: 'Invalid schema: graphql_public' } }],
    ['42501 with details', { status: 403, body: { ...NO_USAGE, details: 'x' } }],
    ['42501 with a hint', { status: 403, body: { ...NO_USAGE, hint: 'grant usage' } }],
    ['42501 carrying data', { status: 403, body: { ...NO_USAGE, data: { [F]: { __typename: 'X' } } } }],
    ['42501 carrying errors', { status: 403, body: { ...NO_USAGE, errors: [] } }],
    ['42501 with an extra key', { status: 403, body: { ...NO_USAGE, extra: 1 } }],
    ['code as a number', { status: 403, body: { ...NO_USAGE, code: 42501 } }],
    ['a JSON array', { status: 403, body: [NO_USAGE] }],
    ['a JSON string', { status: 403, body: 'permission denied for schema graphql_public' }],
    ['no / non-JSON body', { status: 403, body: null }],
    ['timeout', { status: 0, body: null, error: 'AbortError' }],
    ['network failure', { status: 0, body: null, error: 'ECONNREFUSED' }],
    ['a network error even with an accepted body', { status: 403, body: NO_USAGE, error: 'ECONNRESET' }],
  ]
  for (const [label, r] of refuse) {
    const v = classifyGraphqlAnswer(F, r)
    assert.equal(v.pass, false, label)
    assert.equal(v.variant, null, label)
  }
})

test('probePlatformExposure: an exposed schema, a GraphQL that reflects net / errs otherwise / is malformed, a mix of variants, a 5xx, a timeout or a network failure → findings', async () => {
  const raw = (status, text) => () => new Response(text, { status, headers: { 'content-type': 'application/json' } })
  for (const [label, opts, re] of [
    ['net exposed', { exposed: ['net'] }, /exposure_probe_failed:rest_get_net:HTTP 200.*exposure_probe_failed:rest_post_net:HTTP 404 PGRST202/],
    ['extensions exposed', { exposed: ['extensions'] }, /exposure_probe_failed:rest_get_extensions/],
    ['cron exposed', { exposed: ['cron'] }, /exposure_probe_failed:rest_get_cron/],
    ['graphql reflects net', { graphql: 'reflected' }, /exposure_probe_failed:graphql:http_request_queueCollection/],
    ['graphql 42501 as 401 (not the role)', { graphql: 'raw', graphqlRaw: raw(401, JSON.stringify(NO_USAGE)) }, /exposure_probe_failed:graphql:http_request_queueCollection:HTTP 401/],
    ['graphql 42501 on pg_graphql\'s internal schema', { graphql: 'raw', graphqlRaw: raw(403, JSON.stringify(PGRST_42501('permission denied for schema graphql'))) }, /exposure_probe_failed:graphql:http_request_queueCollection:HTTP 403/],
    ['graphql another error code', { graphql: 'raw', graphqlRaw: raw(400, JSON.stringify({ code: 'PGRST100', details: null, hint: null, message: 'parse error' })) }, /exposure_probe_failed:graphql:.*HTTP 400 PGRST100/],
    ['graphql 500', { graphql: 'raw', graphqlRaw: raw(500, JSON.stringify({ message: 'internal' })) }, /exposure_probe_failed:graphql:.*HTTP 500/],
    ['graphql malformed body', { graphql: 'raw', graphqlRaw: raw(403, '{"code":"42501",') }, /exposure_probe_failed:graphql:.*HTTP 403 malformed_body/],
    ['graphql empty body', { graphql: 'raw', graphqlRaw: raw(403, '') }, /exposure_probe_failed:graphql:.*HTTP 403 malformed_body/],
    ['graphql timeout', { graphql: 'timeout' }, /exposure_probe_failed:graphql:.*HTTP 0 AbortError/],
    ['graphql variants disagree', { graphql: 'mixed' }, /exposure_probe_failed:graphql:inconsistent_variants:refused_no_graphql_access\+unknown_field/],
    ['service unavailable', { status5xx: true }, /exposure_probe_failed:rest_get_net:HTTP 503/],
    ['network failure', { throwOn: '/graphql/v1' }, /exposure_probe_failed:graphql:.*HTTP 0/],
  ]) {
    const p = await probePlatformExposure({ origin: ORIGIN, apiKey: ANON_KEY, token: READER_TOKEN, fetch: probeFetch(opts).fetch, timeoutMs: 200 })
    assert.equal(p.ok, false, label)
    assert.equal(p.graphql_variant, null, label)
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
  assert.ok(check.exposure_probe.every((x) => /:refused_as_required:(pgrst106|unknown_field)$/.test(x)), JSON.stringify(check.exposure_probe))
  assert.equal(check.exposure_probe_graphql, 'unknown_field')
  assert.equal(edge.seen.length, REST_PROBES.length + GRAPHQL_FIELDS.length)
})

test('boot (live, fake PostgREST): the role cannot execute the resolver (42501) → the server starts; the audit line names refused_no_graphql_access', async () => {
  const pg = createFakePostgrest({ report: passingReport({ platform_exceptions: [applied()] }), membership: LIVE_MEMBERSHIP })
  const audit = []
  const app = await buildApp({ env: liveEnv({ dir: tmpDir() }), baseFetch: liveFetch(pg, probeFetch({ graphql: 'no_usage' })), scrub: false, auditSink: (r) => audit.push(r) })
  await app.close()
  const check = audit.find((a) => a.event === 'credential_self_check')
  assert.equal(check.outcome, 'ok', JSON.stringify(check.findings))
  assert.equal(check.exposure_probe_graphql, 'refused_no_graphql_access')
  assert.deepEqual(check.exposure_probe.filter((x) => x.startsWith('graphql:')), GRAPHQL_FIELDS.map((f) => `graphql:${f}:refused_as_required:refused_no_graphql_access`))
})

test('boot (live, fake PostgREST): a GraphQL answer that is neither accepted shape → the server REFUSES to start', async () => {
  for (const graphql of ['reflected', 'mixed', 'no_execute_as_401']) {
    const pg = createFakePostgrest({ report: passingReport({ platform_exceptions: [applied()] }), membership: LIVE_MEMBERSHIP })
    const audit = []
    const edge = graphql === 'no_execute_as_401' ? probeFetch({ graphql: 'raw', graphqlRaw: () => new Response(JSON.stringify(NO_EXECUTE), { status: 401 }) }) : probeFetch({ graphql })
    await assert.rejects(buildApp({ env: liveEnv({ dir: tmpDir() }), baseFetch: liveFetch(pg, edge), scrub: false, auditSink: (r) => audit.push(r) }),
      (e) => e.code === 'CREDENTIAL_SELF_CHECK_FAILED' && /exposure_probe_failed:graphql/.test(e.message), graphql)
    const check = audit.find((a) => a.event === 'credential_self_check')
    assert.equal(check.outcome, 'refused', graphql)
    assert.equal(check.exposure_probe_graphql, null, graphql)
    assert.equal(audit.some((a) => a.event === 'server_boot'), false, graphql)
  }
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
