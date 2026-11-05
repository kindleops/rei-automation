// BOOT SELF-CHECK + AUDIT (live mode over the fake PostgREST; synthetic tokens and rows).
//   * evaluateSelfCheck judges the database's privilege report independently: every way
//     the credential could write, egress, read past RLS or miss a read is a named
//     finding, and a disagreement with the database's own verdict refuses too;
//   * buildApp refuses to start on any finding, and on a token PostgREST rejects. Either
//     way the refusal is in the audit FILE;
//   * the credential is re-checked on a TTL; a regression refuses every call (fail closed,
//     audited) and a recovery reopens them;
//   * every tool call (allowed, refused, failed, unknown tool) is one audit line in the
//     audit FILE, with no credential in it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildApp } from '../src/app.mjs'
import { evaluateSelfCheck } from '../src/data/credential.mjs'
import { createLiveSource, CREDENTIAL_RECHECK_MS } from '../src/data/sources.mjs'
import { createFakePostgrest, passingReport, READER_TOKEN, ANON_KEY } from './support/fake-postgrest.mjs'
import { liveEnv, tmpDir, LIVE_MEMBERSHIP } from './support/live-env.mjs'

const readAudit = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('evaluateSelfCheck: a correctly applied role passes', () => {
  const v = evaluateSelfCheck(passingReport())
  assert.equal(v.ok, true, v.findings.join('; '))
  assert.equal(v.info.running_as, 'lc_mcp_reader')
  assert.deepEqual(v.info.owner_rights_views.sort(), ['preforeclosure_status_v2', 'probate_status'])
})

test('evaluateSelfCheck: every way the credential could write, egress, read past RLS or miss a read is a named finding', () => {
  const rels = passingReport().relations
  const fns = passingReport().functions
  const cases = [
    [{ current_user: 'anon' }, /running_as:anon/],
    [{ current_user: 'service_role' }, /running_as:service_role/],
    [{ attributes: { ...passingReport().attributes, bypassrls: true } }, /attr_bypassrls/],
    [{ attributes: { ...passingReport().attributes, superuser: true } }, /attr_superuser/],
    [{ attributes: { ...passingReport().attributes, canlogin: true } }, /attr_canlogin/],
    [{ member_of: ['authenticated'] }, /member_of:authenticated/],
    [{ write_privileges: ['public.send_queue'] }, /write_privileges:public.send_queue/],
    [{ sequence_privileges: ['public.x_id_seq'] }, /sequence_privileges/],
    [{ schema_create: ['public'] }, /schema_create:public/],
    [{ database_create: true }, /database_create/],
    [{ reachable_definer_functions: ['public.exec_sql(text)'] }, /reachable_definer_functions:public.exec_sql/],
    [{ reachable_egress_functions: ['public.dblink(text)'] }, /reachable_egress_functions:public.dblink/],
    [{ reachable_egress_functions: ['net.http_get(text,jsonb,jsonb,integer)', 'net.http_post(text,jsonb,jsonb,jsonb,integer)'], write_privileges: ['net.http_request_queue', 'net._http_response'] }, /pg_net_public: .*drop the extension/],
    [{ member_of: ['anon'] }, /member_of:anon/],
    [{ exposed_select_outside_inventory: ['public.v_seller_work_items'] }, /exposed_select_outside_inventory:public.v_seller_work_items/],
    [{ relations: rels.map((r) => (r.name === 'campaigns' ? { ...r, permissive_policy: false } : r)) }, /rls_without_policy:campaigns/],
    [{ relations: rels.map((r) => (r.name === 'properties' ? { ...r, restrictive_policy: true } : r)) }, /restrictive_policy:properties/],
    [{ relations: rels.map((r) => (r.name === 'phones' ? { ...r, select: false } : r)) }, /no_select:phones/],
    [{ relations: rels.map((r) => (r.name === 'probate_status' ? { ...r, invoker_view: true } : r)) }, /invoker_view:probate_status/],
    [{ relations: rels.map((r) => (r.name === 'campaigns' ? { ...r, exists: false } : r)) }, /relation_missing:campaigns/],
    [{ relations: rels.filter((r) => r.name !== 'emails') }, /relation_not_reported:emails/],
    [{ relations: [...rels, { name: 'send_queue', exists: true, select: true }] }, /relation_not_in_inventory:send_queue/],
    [{ functions: fns.map((f) => (/operator_role/.test(f.signature) ? { ...f, executable: false } : f)) }, /no_execute:public.lc_mcp_operator_role/],
    [{ functions: fns.map((f) => (/property_records/.test(f.signature) ? { ...f, volatility: 'v' } : f)) }, /volatile_function:public.entity_graph_property_records/],
    [{ functions: fns.filter((f) => !/review_flags/.test(f.signature)) }, /function_missing:public.campaign_entity_contact_review_flags/],
    [{ ok: false, findings: ['something_only_the_database_saw'] }, /database_findings:something_only_the_database_saw/],
    [{ version: 2 }, /report_version/],
    [{ exists: false }, /role_missing/],
  ]
  for (const [over, re] of cases) {
    const v = evaluateSelfCheck(passingReport(over))
    assert.equal(v.ok, false, JSON.stringify(over))
    assert.match(v.findings.join(' | '), re)
  }
  assert.equal(evaluateSelfCheck(null).ok, false)
  // optional relation absent: fine
  const opt = evaluateSelfCheck(passingReport({ relations: rels.map((r) => (r.name === 'census_geo_metrics' ? { ...r, exists: false } : r)) }))
  assert.equal(opt.ok, true, opt.findings.join('; '))
})

test('boot: a failing self-check refuses to start and is audited to the FILE (no server_boot)', async () => {
  const dir = tmpDir()
  const auditFile = path.join(dir, 'audit.jsonl')
  const pg = createFakePostgrest({ report: passingReport({ write_privileges: ['public.send_queue'], reachable_definer_functions: ['public.new_writer()'], ok: false, findings: ['write_privileges'] }), membership: LIVE_MEMBERSHIP })
  await assert.rejects(buildApp({ env: liveEnv({ dir, over: { LEADCOMMAND_MCP_AUDIT_FILE: auditFile } }), baseFetch: pg.fetch, scrub: false }), { code: 'CREDENTIAL_SELF_CHECK_FAILED' })
  const audit = readAudit(auditFile)
  const check = audit.find((a) => a.event === 'credential_self_check')
  assert.equal(check.outcome, 'refused')
  assert.equal(check.stage, 'boot')
  assert.ok(check.findings.some((f) => /write_privileges:public.send_queue/.test(f)))
  assert.ok(check.findings.some((f) => /reachable_definer_functions:public.new_writer/.test(f)))
  assert.equal(audit.some((a) => a.event === 'server_boot'), false)
  assert.deepEqual(pg.rpcsCalled(), ['lc_mcp_reader_self_check'], 'nothing but the self-check ran')
})

test('boot: a token PostgREST rejects (401 PGRST301), a missing self-check function (PGRST202) and an unreachable service all refuse, audited', async () => {
  for (const [label, pg, re] of [
    ['jwt rejected', createFakePostgrest({ acceptRole: 'nobody' }), /token_rejected_by_postgrest:PGRST301/],
    ['migration not applied', createFakePostgrest({ rpcError: { lc_mcp_reader_self_check: { status: 404, code: 'PGRST202', message: 'not found' } } }), /self_check_function_missing/],
    ['no EXECUTE', createFakePostgrest({ rpcError: { lc_mcp_reader_self_check: { status: 403, code: '42501', message: 'denied' } } }), /self_check_not_executable/],
    ['unreachable', { fetch: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }) } }, /self_check_unreachable/],
  ]) {
    const dir = tmpDir()
    const auditFile = path.join(dir, 'audit.jsonl')
    const e = await buildApp({ env: liveEnv({ dir, over: { LEADCOMMAND_MCP_AUDIT_FILE: auditFile } }), baseFetch: pg.fetch, scrub: false }).then(() => null, (x) => x)
    assert.equal(e?.code, 'CREDENTIAL_SELF_CHECK_FAILED', label)
    const check = readAudit(auditFile).find((a) => a.event === 'credential_self_check')
    assert.equal(check.outcome, 'refused', label)
    assert.match(check.findings.join(' '), re, label)
  }
})

test('re-check: after the TTL a regression refuses every call (fail closed, audited once); a recovery reopens', async () => {
  let t = Date.now()
  let report = passingReport()
  const pg = createFakePostgrest({ report: () => report, membership: LIVE_MEMBERSHIP })
  const seen = []
  const src = createLiveSource({ supabaseUrl: 'https://fixture-project.supabase.test', apiKey: ANON_KEY, readerJwt: READER_TOKEN, baseFetch: pg.fetch, now: () => t, onSelfCheck: (v, stage) => seen.push(`${stage}:${v.ok}`) })
  assert.equal((await src.selfCheck('boot')).ok, true)
  await src.withCall(null, (svc) => svc.db.from('campaigns').select('id').limit(1))
  assert.equal(pg.requests.filter((r) => r.rpc === 'lc_mcp_reader_self_check').length, 1, 'no re-check inside the TTL')
  report = passingReport({ write_privileges: ['public.properties'] })
  t += CREDENTIAL_RECHECK_MS + 1
  await assert.rejects(src.withCall(null, (svc) => svc.db.from('campaigns').select('id').limit(1)), { code: 'CREDENTIAL_SELF_CHECK_FAILED' })
  await assert.rejects(src.withCall(null, (svc) => svc.db.from('campaigns').select('id').limit(1)), { code: 'CREDENTIAL_SELF_CHECK_FAILED' })
  report = passingReport()
  await src.withCall(null, (svc) => svc.db.from('campaigns').select('id').limit(1))
  assert.deepEqual(seen, ['boot:true', 'recheck:false', 'recheck:false', 'recheck:true'])
  assert.equal(pg.requests.filter((r) => r.relation === 'campaigns').length, 2, 'no read ran while the credential was refused')
})

test('audit FILE: every call (ok, refused, failed, unknown tool) is one line; boot self-check first; no credential anywhere in the file', async () => {
  const dir = tmpDir()
  const auditFile = path.join(dir, 'audit.jsonl')
  const pg = createFakePostgrest({ membership: LIVE_MEMBERSHIP })
  const env = liveEnv({ dir, over: { LEADCOMMAND_MCP_AUDIT_FILE: auditFile, LEADCOMMAND_MCP_SCOPES: 'leadcommand.leads.read leadcommand.properties.read leadcommand.scores.read' } })
  const app = await buildApp({ env, baseFetch: pg.fetch, scrub: false })
  try {
    const ok = await app.gateway.call('leadcommand_get_acquisition_score', { property_id: 'P1' })
    assert.equal(ok.ok, true, ok.text)
    const refused = await app.gateway.call('leadcommand_get_lead_contact_status', { property_id: 'P1' }) // scope not granted
    assert.equal(refused.structured.error.code, 'SCOPE_NOT_GRANTED')
    const invalid = await app.gateway.call('leadcommand_get_property', { property_id: 'P1', org_id: 'x' }) // forged context
    assert.equal(invalid.structured.error.code, 'FORGED_CONTEXT')
    const unknown = await app.gateway.call('leadcommand_send_sms', {})
    assert.equal(unknown.structured.error.code, 'UNKNOWN_TOOL')
    const failed = await app.gateway.call('leadcommand_get_property', { property_id: 'NOPE' })
    assert.equal(failed.ok, false)
  } finally { await app.close() }
  const lines = readAudit(auditFile)
  assert.deepEqual(lines.slice(0, 2).map((l) => l.event), ['credential_self_check', 'server_boot'])
  const calls = lines.filter((l) => l.event === 'tool_call')
  assert.equal(calls.length, 5)
  assert.deepEqual(calls.map((c) => c.outcome), ['ok', 'refused', 'refused', 'refused', 'failed'])
  assert.deepEqual(calls.map((c) => c.tool), ['leadcommand_get_acquisition_score', 'leadcommand_get_lead_contact_status', 'leadcommand_get_property', 'leadcommand_send_sms', 'leadcommand_get_property'])
  for (const c of calls) {
    assert.equal(c.data_mode, 'live')
    assert.match(c.correlation_id, /^[0-9a-f-]{36}$/)
    assert.match(c.principal, /^#[0-9a-f]{12}$/, 'principal hashed')
  }
  const raw = fs.readFileSync(auditFile, 'utf8')
  for (const secret of [READER_TOKEN, ANON_KEY, READER_TOKEN.split('.')[1], ANON_KEY.split('.')[1]]) assert.equal(raw.includes(secret), false)
  assert.equal(fs.statSync(auditFile).mode & 0o077, 0, 'audit file is 0600')
})
