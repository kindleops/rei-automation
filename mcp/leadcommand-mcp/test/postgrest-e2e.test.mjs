// END TO END over a REAL PostgREST + disposable PostgreSQL 17 with the role migration
// applied (test/support/local-stack.mjs). Never production. Opt-in, because it needs
// local binaries:
//   LC_PG_BIN=<dir with initdb, pg_ctl, postgres> LC_POSTGREST_BIN=<postgrest> [LC_PSQL=<psql>] npm test
// Proves at the DATABASE, through the real JWT → SET ROLE path:
//   * a reader token minted HS256 with the role claim runs as lc_mcp_reader; the privilege
//     report the server's boot check reads is ok;
//   * INSERT / UPDATE / DELETE on inventory and sentinel tables are refused with 42501
//     (403); SELECT outside the inventory is refused; the agent schema is unreachable;
//     write RPCs are not executable;
//   * the acceptance probes are side-effect free even where a write IS permitted (a
//     service_role control: zero rows change);
//   * the MCP server boots against it (real self-check, real membership RPC) and every
//     tool returns live data (the four rc-8.5.21 operations reads included, through their
//     definer projections; their sources are unreadable to the role directly); a token
//     signed with the wrong secret is refused at boot;
//   * scripts/live-acceptance.mjs PASSES against this stack (the owner's script, validated
//     here so its first production run is not its first run).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startLocalStack, COVERAGE_CALLS } from './support/local-stack.mjs'
import { liveEnv, tmpDir, writeSecret } from './support/live-env.mjs'
import { buildApp } from '../src/app.mjs'
import { RELATION_NAMES, RPC_SIGNATURES } from '../src/data/inventory.mjs'
import { FIXTURE_OWNER, FIXTURE_ORG } from '../fixtures/dataset.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const PG_BIN = process.env.LC_PG_BIN
const PGRST_BIN = process.env.LC_POSTGREST_BIN
const skip = !(PG_BIN && PGRST_BIN) && 'set LC_PG_BIN and LC_POSTGREST_BIN to run the real-PostgREST end-to-end'
const exp = (days) => Math.floor(Date.now() / 1000) + days * 86_400

test('real PostgREST + PG17: the lc_mcp_reader token is read-only at the DATABASE and the server works end to end', { skip, timeout: 240_000 }, async (t) => {
  const stack = await startLocalStack({ pgBin: PG_BIN, postgrestBin: PGRST_BIN })
  try {
    const reader = stack.mint({ role: 'lc_mcp_reader', iss: 'supabase', iat: exp(0), exp: exp(7) })
    const anon = stack.mint({ role: 'anon', iss: 'supabase', iat: exp(0), exp: exp(365) })
    const service = stack.mint({ role: 'service_role', iss: 'supabase', iat: exp(0), exp: exp(1) })
    const h = (tok, extra = {}) => ({ apikey: anon, authorization: `Bearer ${tok}`, 'content-type': 'application/json', prefer: 'return=minimal', ...extra })
    const req = async (method, p, tok, body, extra) => {
      const r = await fetch(`${stack.url}${p}`, { method, headers: h(tok, extra), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      let b = null
      try { b = await r.json() } catch { /* empty */ }
      return { status: r.status, code: b?.code ?? null, body: b }
    }

    await t.test('the token runs AS lc_mcp_reader and the database privilege report is ok', async () => {
      const r = await req('POST', '/rest/v1/rpc/lc_mcp_reader_self_check', reader, { p_relations: RELATION_NAMES, p_functions: RPC_SIGNATURES })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.current_user, 'lc_mcp_reader')
      assert.equal(r.body.session_user, 'authenticator')
      assert.equal(r.body.ok, true, JSON.stringify(r.body.findings))
      assert.equal(r.body.attributes.bypassrls, false)
    })

    await t.test('reads of the inventory work; reads outside it are refused by the database', async () => {
      const ok = await req('GET', '/rest/v1/properties?select=property_id&limit=1', reader)
      assert.equal(ok.status, 200)
      assert.equal(ok.body[0].property_id, 'P1', 'RLS policy lets the role see the row')
      for (const rel of ['send_queue', 'sms_templates', 'system_control', 'message_events']) {
        const r = await req('GET', `/rest/v1/${rel}?select=*&limit=1`, reader)
        assert.equal(r.code, '42501', `${rel}: ${JSON.stringify(r.body)}`)
      }
      const agent = await req('GET', '/rest/v1/operator_membership?select=role', reader, undefined, { 'accept-profile': 'agent' })
      assert.ok(agent.status === 406 || agent.code === '42501', JSON.stringify(agent.body))
      // the operations sources: only through the lc_mcp_* definer projections
      for (const rel of ['automation_holds', 'followup_intents', 'v_followup_intent_health', 'v_followup_intent_reasons']) {
        const r = await req('GET', `/rest/v1/${rel}?select=*&limit=1`, reader)
        assert.equal(r.code, '42501', `${rel}: ${JSON.stringify(r.body)}`)
      }
      for (const [rel, profile] of [['finding', 'agent'], ['conversation_action_state', 'agent']]) {
        const r = await req('GET', `/rest/v1/${rel}?select=*&limit=1`, reader, undefined, { 'accept-profile': profile })
        assert.ok(r.status === 406 || r.code === '42501', `${profile}.${rel}: ${JSON.stringify(r.body)}`)
      }
      const hf = await req('POST', '/rest/v1/rpc/automation_hold_for', reader, { p_thread_key: '+15550100001' })
      assert.equal(hf.code, '42501', `automation_hold_for: ${JSON.stringify(hf.body)}`)
    })

    await t.test('the operations read functions answer AS the role with their projection only (no keys, ids or reason text)', async () => {
      const held = await req('POST', '/rest/v1/rpc/lc_mcp_thread_hold_status', reader, { p_thread_id: '00000000-0000-4000-8000-000000000101' })
      assert.equal(held.status, 200, JSON.stringify(held.body))
      assert.deepEqual(held.body.holds.map((h) => [h.reason_category, h.matched_on]), [['ownership_attribution_unresolved', 'thread']])
      const opp = await req('POST', '/rest/v1/rpc/lc_mcp_thread_hold_status', reader, { p_thread_id: '00000000-0000-4000-8000-000000000102' })
      assert.deepEqual(opp.body.holds.map((h) => h.matched_on), ['opportunity'])
      assert.doesNotMatch(JSON.stringify([held.body.holds, opp.body.holds]), /\+1555|Fixture Person|fixture_operator_hold|ownership_unresolved:/)
      const ac = await req('POST', '/rest/v1/rpc/lc_mcp_action_center', reader, { p_org_id: FIXTURE_ORG, p_state: null, p_lost_only: true, p_after: null, p_limit: 5 })
      assert.equal(ac.status, 200, JSON.stringify(ac.body))
      assert.equal(ac.body.items.length, 1)
      const other = await req('POST', '/rest/v1/rpc/lc_mcp_action_center', reader, { p_org_id: '00000000-0000-4000-8000-0000000000a9', p_state: null, p_lost_only: false, p_after: null, p_limit: 5 })
      assert.equal(other.body.items.length, 0, 'another org reads nothing')
      const bad = await req('POST', '/rest/v1/rpc/lc_mcp_ops_finding', reader, { p_org_id: FIXTURE_ORG, p_finding_type: 'recovery.candidate' })
      assert.equal(bad.code, '22023', JSON.stringify(bad.body))
      const fu = await req('POST', '/rest/v1/rpc/lc_mcp_followup_intent_health', reader, {})
      assert.equal(fu.status, 200)
      assert.equal(fu.body.health.planned, 2)
    })

    await t.test('INSERT / UPDATE / DELETE are refused with 42501 by the database (inventory + sentinels)', async () => {
      for (const [rel, pk] of [['send_queue', 'id'], ['sms_templates', 'id'], ['system_control', 'key'], ['properties', 'property_id'], ['campaigns', 'id'], ['phones', 'phone_id'], ['sms_suppression_list', 'id']]) {
        for (const [m, p, body] of [['POST', `/rest/v1/${rel}?columns=${pk}`, []], ['PATCH', `/rest/v1/${rel}?${pk}=is.null`, { [pk]: null }], ['DELETE', `/rest/v1/${rel}?${pk}=is.null`, undefined], ['POST', `/rest/v1/${rel}`, { [pk]: 'x' }]]) {
          const r = await req(m, p, reader, body)
          assert.equal(r.code, '42501', `${m} ${rel}: HTTP ${r.status} ${JSON.stringify(r.body)}`)
          assert.equal(r.status, 403)
        }
      }
      assert.equal(stack.sql('select count(*) from public.send_queue'), '1', 'nothing changed')
    })

    await t.test('write and raw-SQL RPCs are not executable; the invoker writer cannot write', async () => {
      for (const [fn, args] of [['exec_sql', { q: 'delete from public.send_queue' }], ['reap_stale_campaign_target_graph_refresh_runs', { p_age: '1 day' }]]) {
        const r = await req('POST', `/rest/v1/rpc/${fn}`, reader, args)
        assert.equal(r.code, '42501', `${fn}: ${JSON.stringify(r.body)}`)
      }
      const inv = await req('POST', '/rest/v1/rpc/run_sql', reader, { q: 'insert into public.send_queue (body) values (\'x\')' })
      assert.equal(inv.code, '42501', JSON.stringify(inv.body))
      assert.equal(stack.sql('select count(*) from public.send_queue'), '1')
    })

    await t.test('control: the acceptance probes change nothing even where a write IS permitted (service_role)', async () => {
      const before = stack.sql('select count(*) from public.send_queue')
      for (const [m, p, body] of [['POST', '/rest/v1/send_queue?columns=id', []], ['PATCH', '/rest/v1/send_queue?id=is.null', { id: null }], ['DELETE', '/rest/v1/send_queue?id=is.null', undefined]]) {
        const r = await req(m, p, service, body)
        assert.ok(r.status >= 200 && r.status < 300, `${m}: ${r.status} ${JSON.stringify(r.body)}`)
      }
      assert.equal(stack.sql('select count(*) from public.send_queue'), before, 'zero rows inserted / updated / deleted')
      assert.equal(stack.sql("select count(*) from public.send_queue where id is null"), '0')
    })

    await t.test('the MCP server boots on the real self-check and every tool returns live data; a wrongly signed token is refused at boot', async () => {
      const dir = tmpDir()
      const audit = []
      const env = liveEnv({ dir, reader, apiKey: anon, over: { LEADCOMMAND_MCP_SUPABASE_URL: stack.url } })
      const app = await buildApp({ env, scrub: false, auditSink: (r) => audit.push(r) })
      try {
        const check = audit.find((a) => a.event === 'credential_self_check')
        assert.equal(check.outcome, 'ok', JSON.stringify(check.findings))
        assert.equal(check.running_as, 'lc_mcp_reader')
        const outcomes = {}
        for (const [name, args] of COVERAGE_CALLS) {
          const r = await app.gateway.call(name, args)
          outcomes[`${name} ${JSON.stringify(args)}`] = r.ok ? `ok:${r.structured.data_mode}` : `${r.structured.error.class}/${r.structured.error.code}`
        }
        assert.deepEqual(Object.values(outcomes).filter((x) => x !== 'ok:live'), [], JSON.stringify(outcomes, null, 1))
      } finally { await app.close() }
      const forged = stack.mint({ role: 'lc_mcp_reader', exp: exp(1) }).replace(/\.[^.]+$/, '.' + Buffer.from('not-the-signature').toString('base64url'))
      const audit2 = []
      await assert.rejects(buildApp({ env: liveEnv({ dir: tmpDir(), reader: forged, apiKey: anon, over: { LEADCOMMAND_MCP_SUPABASE_URL: stack.url } }), scrub: false, auditSink: (r) => audit2.push(r) }), { code: 'CREDENTIAL_SELF_CHECK_FAILED' })
      assert.match(audit2.find((a) => a.event === 'credential_self_check').findings.join(' '), /token_rejected_by_postgrest|self_check_error/)
    })

    await t.test('scripts/live-acceptance.mjs PASSES against this stack (all stages)', async () => {
      const dir = tmpDir()
      const env = {
        PATH: process.env.PATH, HOME: dir,
        LEADCOMMAND_MCP_SUPABASE_URL: stack.url,
        LEADCOMMAND_MCP_READER_JWT_FILE: writeSecret(dir, 'reader.jwt', reader),
        LEADCOMMAND_MCP_API_KEY_FILE: writeSecret(dir, 'anon.key', anon),
        LEADCOMMAND_MCP_PRINCIPAL_USER_ID: FIXTURE_OWNER, LEADCOMMAND_MCP_ORG_ID: FIXTURE_ORG,
      }
      // async spawn: the stack's gateway runs in THIS process, so a blocking spawnSync would starve it
      const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(PKG, 'scripts/live-acceptance.mjs'), '--zip', '75001'], { env, cwd: PKG })
        let stdout = ''
        let stderr = ''
        c.stdout.on('data', (d) => { stdout += d })
        c.stderr.on('data', (d) => { stderr += d })
        const kill = setTimeout(() => c.kill('SIGKILL'), 120_000)
        c.on('exit', (status) => { clearTimeout(kill); resolve({ status, stdout, stderr }) })
      })
      const summary = JSON.parse(r.stdout)
      assert.equal(summary.result, 'PASS', `${summary.error}\n${r.stderr.slice(-500)}`)
      assert.equal(r.status, 0)
      assert.equal(summary.stages.database.probes.filter((p) => p.refused_by_database).length >= 18, true)
      assert.equal(new Set(summary.stages.capability.results.map((x) => x.tool)).size, 13)
      assert.deepEqual(summary.stages.capability.skipped_not_granted, [])
      assert.equal(summary.stages.audit.self_check.running_as, 'lc_mcp_reader')
      if (process.env.LC_E2E_SUMMARY_OUT) fs.writeFileSync(process.env.LC_E2E_SUMMARY_OUT, JSON.stringify(summary, null, 2))
    })
  } finally {
    await stack.stop()
  }
})
