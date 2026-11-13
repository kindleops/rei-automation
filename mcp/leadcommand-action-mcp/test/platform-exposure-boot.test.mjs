// The Action MCP boot and the Supabase pg_net PLATFORM EXCEPTION (docs/SUPABASE-PG-NET-POSTURE.md), with a fake
// Supabase-shaped client (no network, no database). The database report is re-judged by the server
// (leadcommand-mcp/src/data/platform-exposure.mjs#evaluatePlatformExceptions): an applied exception makes the live
// exposure probe MANDATORY; an injected client has no data service to probe, so the start is refused; a tampered
// exception is refused; a report without an applied exception boots exactly as before (no probe).
// The live probe over a REAL PostgREST: test/pg-net-exposure-e2e.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.mjs'
import { baseEnv } from './helpers.mjs'
import { PG_NET_FINGERPRINT_VERSION } from '../../leadcommand-mcp/src/data/platform-exposure.mjs'

const applied = (over = {}) => ({
  id: 'supabase_pg_net', fingerprint_version: PG_NET_FINGERPRINT_VERSION, status: 'applied', reasons: [],
  objects: ['schema:net', 'table:net.http_request_queue', 'function:net.http_post'],
  controls: { a_role_posture: true, b_exposed_schemas: 'verified', c_live_exposure_probe: 'required', d_role_search_path: true, e_egress_rule_outside_exception: 'enforced', f_no_create: true },
  notes: [], live_exposure_probe_required: true, ...over,
})
const report = (over = {}) => ({ version: 1, role: 'lc_action_gateway', exists: true, current_user: 'lc_action_gateway', ok: true, findings: [], platform_exceptions: [], ...over })
const fakeDb = (rep) => ({ from: () => { throw new Error('no table read at boot') }, rpc: async (fn) => (fn === 'action_gateway_self_check' ? { data: rep, error: null } : { data: null, error: { code: 'PGRST202', message: 'not in this fake' } }) })
const boot = async (rep) => {
  const audit = []
  const r = await buildApp({ env: baseEnv(), db: fakeDb(rep), scrub: false, auditSink: (x) => audit.push(x) }).then((app) => ({ app }), (error) => ({ error }))
  await r.app?.close()
  return { ...r, check: audit.find((a) => a.event === 'credential_self_check'), booted: audit.some((a) => a.event === 'server_boot') }
}

test('no applied exception (no pg_net / not Supabase): boots exactly as before, no probe', async () => {
  for (const rep of [report(), report({ platform_exceptions: undefined })]) {
    const r = await boot(rep)
    assert.equal(r.error, undefined, String(r.error?.message))
    assert.equal(r.check.outcome, 'ok')
    assert.equal(r.check.exposure_probe, null)
    assert.equal(r.booted, true)
  }
})

test('an applied exception makes the live probe mandatory: with no data service to probe the start is REFUSED (audited)', async () => {
  const r = await boot(report({ platform_exceptions: [applied()] }))
  assert.equal(r.error?.code, 'CREDENTIAL_SELF_CHECK_FAILED')
  assert.match(r.error.message, /exposure_probe_unavailable:no_live_data_service/)
  assert.equal(r.check.outcome, 'refused')
  assert.equal(r.check.platform_exceptions[0].status, 'applied')
  assert.equal(r.booted, false)
})

test('a tampered exception is refused before any probe (version pin, controls, objects outside net)', async () => {
  for (const [entry, re] of [
    [applied({ fingerprint_version: 'v-unreviewed' }), /platform_exception_fingerprint_version/],
    [applied({ controls: { ...applied().controls, d_role_search_path: false } }), /platform_exception_control:d_role_search_path/],
    [applied({ objects: ['table:public.send_queue'] }), /platform_exception_objects_outside_net/],
    [applied({ id: 'another_platform' }), /platform_exception_unknown/],
  ]) {
    const r = await boot(report({ platform_exceptions: [entry] }))
    assert.equal(r.error?.code, 'CREDENTIAL_SELF_CHECK_FAILED', JSON.stringify(entry))
    assert.match(r.error.message, re)
    assert.equal(r.check.exposure_probe, null, 'no probe ran')
  }
})

test('the database\'s own refusal still refuses (a not-applied exception: the strict findings)', async () => {
  const r = await boot(report({ ok: false, findings: ['reachable_egress_function:net.http_get(text,jsonb,jsonb,integer)'], platform_exceptions: [applied({ status: 'not_applied', reasons: ['not_extension_member:table:net.x'], controls: null })] }))
  assert.equal(r.error?.code, 'CREDENTIAL_SELF_CHECK_FAILED')
  assert.match(r.error.message, /reachable_egress_function:net\.http_get/)
})
