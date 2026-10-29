// END TO END on a DISPOSABLE PostgreSQL 17 (AGENT_PG_TEST_DB_URL, loopback only): the REAL Action MCP app — boot
// self-check, the real gateway, its database entry points AS lc_action_gateway with the tenant claim — behind
// the loopback HTTP transport, driven by the official SDK client as two different agents.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.mjs'
import { startHttp } from '../src/protocol/http.mjs'
import { baseEnv, DIR } from './helpers.mjs'
import { pgAvailable, skipReason } from '../../../apps/api/tests/pg/agent-pg-harness.mjs'
import { pgSupabase, isoPool } from '../../../apps/api/tests/helpers/pg-supabase.mjs'
import { gatewayDb, seedWorld, registerAgent, seedThread, gatewayPool, setControls, sel, ORG, SELLER } from '../../../apps/api/tests/helpers/action-gateway-pg.mjs'

const skip = pgAvailable() ? false : skipReason
const httpEnv = (over = {}) => baseEnv({ LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_ACTION_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_ACTION_MCP_HTTP_PORT: '0', LEADCOMMAND_ACTION_MCP_AGENT_CREDENTIAL_FILE: '', ...over })
async function client(url, token) {
  const c = new Client({ name: 'e2e', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return c
}
const json = (r) => r.structuredContent

test('E2E (PG): the Action MCP boots only after the database self-check of lc_action_gateway; two agents act ONLY within their own grants; the hold lands in the ONE registry; stubs never succeed; the emergency stop stops everything; the audit file carries no credential or phone', { skip }, async () => {
  const env = await gatewayDb()
  const auditFile = path.join(DIR, `audit-${Date.now()}.jsonl`)
  let listener
  let app
  try {
    await seedWorld(env.owner)
    const credA = await registerAgent(env.owner, { agent_id: 'agt_ops', grants: [['holds.set_thread_hold', 2], ['research.create_job', 1, { spendPerDay: 5 }], ['tasks.create_operator_task', 1]] })
    const credB = await registerAgent(env.owner, { agent_id: 'agt_research', grants: [['research.create_job', 1, { spendPerDay: 5 }]] })
    const t = await seedThread(env.owner)
    const db = pgSupabase(env.db.trackPool(gatewayPool(env.url, ORG)))
    app = await buildApp({ env: httpEnv({ LEADCOMMAND_ACTION_MCP_AUDIT_FILE: auditFile }), db, scrub: false })
    listener = await startHttp({ app })
    const a = await client(listener.url, credA)
    const b = await client(listener.url, credB)

    const h = await a.callTool({ name: 'set_thread_hold', arguments: { client_request_id: 'e2e-hold-0001', thread_id: t.thread_id, reason_code: 'seller_requested_pause' } })
    assert.equal(h.isError, false, JSON.stringify(json(h)))
    assert.equal(json(h).code, 'HOLD_SET')
    assert.equal((await sel(env.owner, `select set_by from public.automation_holds where thread_key = $1 and released_at is null`, [SELLER]))[0].set_by, 'agent:agt_ops')
    const again = await a.callTool({ name: 'set_thread_hold', arguments: { client_request_id: 'e2e-hold-0001', thread_id: t.thread_id, reason_code: 'seller_requested_pause' } })
    assert.equal(json(again).status, 'replayed')

    const denied = await b.callTool({ name: 'set_thread_hold', arguments: { client_request_id: 'e2e-hold-0002', thread_id: t.thread_id, reason_code: 'other' } })
    assert.equal(denied.isError, true)
    assert.equal(json(denied).error.code, 'CAPABILITY_NOT_GRANTED')
    const rj = await b.callTool({ name: 'create_research_job', arguments: { client_request_id: 'e2e-research-1', question: 'Market check for the Oak St area' } })
    assert.equal(json(rj).code, 'JOB_ENQUEUED', JSON.stringify(json(rj)))
    assert.equal((await sel(env.owner, `select i.agent_id from action_gateway.action_intents i where i.client_key = 'e2e-research-1'`))[0].agent_id, 'agt_research')

    // every requested tool is implemented now (T2: #27, T3 / T4: #28); an incomplete call never succeeds
    const stub = await a.callTool({ name: 'record_seller_counteroffer', arguments: { client_request_id: 'e2e-stub-0001' } })
    assert.equal(json(await a.callTool({ name: 'queue_authorized_reply', arguments: { client_request_id: 'e2e-stub-0002' } })).error.code, 'TIER_DISABLED', 'T3 is not enabled at all')
    assert.equal(stub.isError, true)
    assert.ok(['capability_not_implemented', 'INPUT_INVALID', 'CAPABILITY_NOT_GRANTED', 'TIER_DISABLED'].includes(json(stub).error.code), json(stub).error.code)
    const forged = await a.callTool({ name: 'create_operator_task', arguments: { client_request_id: 'e2e-forged-01', title: 'x', agent_id: 'agt_research' } })
    assert.equal(json(forged).error.code, 'FORGED_CONTEXT')

    await setControls(env.owner, { action_gateway_enabled: null })
    const stopped = await a.callTool({ name: 'create_operator_task', arguments: { client_request_id: 'e2e-stop-0001', title: 'after the stop' } })
    assert.equal(json(stopped).error.code, 'ACTION_GATEWAY_STOPPED')
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.ops_work_item`))[0].n, 0)

    await a.close()
    await b.close()
    const lines = fs.readFileSync(auditFile, 'utf8')
    assert.ok(lines.includes('"credential_self_check"') && lines.includes('"outcome":"ok"'))
    assert.ok(!lines.includes(credA) && !lines.includes(credB), 'no credential in the audit file')
    assert.ok(!lines.includes('13125550161') && !lines.includes('3125550161'), 'no phone in the audit file')
  } finally {
    await listener?.close().catch(() => {})
    await app?.close().catch(() => {})
    await env.db.drop()
  }
})

test('E2E (PG): the server REFUSES to boot when its database credential is not exactly lc_action_gateway (a superuser / owner connection fails the self-check)', { skip }, async () => {
  const env = await gatewayDb()
  try {
    const ownerDb = pgSupabase(env.db.trackPool(isoPool(env.url, 2)))
    await assert.rejects(buildApp({ env: baseEnv(), db: ownerDb, scrub: false }), (e) => e.code === 'CREDENTIAL_SELF_CHECK_FAILED')
  } finally { await env.db.drop() }
})

test('E2E (PG) link #32: the real Action MCP boots on the full chain (#26 → #27 → #28 → #29 → #31 → ledger → #32); an agent takes a lead and sends an agent message through sms_send_agent_message (no approval on a standing grant); the event feed and the template read answer', { skip }, async () => {
  const { agentMessageDb } = await import('../../../apps/api/tests/helpers/action-gateway-agent-message-pg.mjs')
  const { seedT34, agent } = await import('../../../apps/api/tests/helpers/action-gateway-t34-world.mjs')
  const { evaluateReplyTiming, resolveRecipientZones } = await import('@/lib/domain/queue/reply-timing.js')
  // a recipient whose zone is lawful NOW (the app runs on the wall clock); none at all ⇒ the window refusal is the proof
  const candidates = [['+12125550174', 'NY'], ['+13125550174', 'IL'], ['+13035550174', 'CO'], ['+12135550174', 'CA'], ['+19075550174', 'AK'], ['+18085550174', 'HI']]
  const lawfulAt = ([p, st]) => evaluateReplyTiming({ purpose: 'campaign', at: new Date().toISOString(), zones: resolveRecipientZones({ recipientPhone: p, propertyGeography: { state: st } }).zones }).lawful === true
  const pick = candidates.find(lawfulAt) || null
  const lawful = Boolean(pick)
  const [phone, state] = pick || candidates[1]
  const env = await agentMessageDb()
  let listener
  let app
  try {
    await seedT34(env)
    await setControls(env.owner, { ai_conversation_send_enabled: 'true', ai_conversation_send_policy: JSON.stringify({ enabled: true, scope: { thread_keys: [phone] }, categories: ['first_touch'] }),
      ai_agent_message_enabled: 'true', ai_agent_message_policy: JSON.stringify({ enabled: true }) })
    const cred = await agent(env, { agent_id: 'agt_sterling', grants: [['leads.assign_lead', 2], ['events.read', 1], ['conversation.read_message_templates', 1]] })
    await env.owner.query(`insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, granted_by, expires_at, standing_seller_facing, standing_basis) values ($1, 'agt_sterling', 'conversation.queue_agent_message', 3, '2b3ee0ff-0000-4000-8000-0000000000c1', now() + interval '30 days', true, 'owner decision (disposable e2e): agent messages')`, [ORG])
    await env.owner.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address) values ('pe2e', 'SFR', 'Springfield', $1, null, '18 Elm St')`, [state])
    const camp = (await env.owner.query(`insert into public.campaigns (name, status) values ('e2e', 'active') returning id`)).rows[0].id
    const target = (await env.owner.query(`insert into public.campaign_targets (campaign_id, property_id, prospect_id, to_phone_number, market, language, target_status, routing_status, identity_status, suppression_status, metadata) values ($1, 'pe2e', 'pr1', $2, 'Chicago', 'English', 'ready', 'ready', 'verified', 'clear', '{"candidate_snapshot":{"seller_first_name":"Dana"}}') returning id`, [camp, phone])).rows[0].id
    const db = pgSupabase(env.db.trackPool(gatewayPool(env.url, ORG)))
    app = await buildApp({ env: httpEnv(), db, scrub: false })
    listener = await startHttp({ app })
    const a = await client(listener.url, cred)
    const tpl = await a.callTool({ name: 'sms_list_message_templates', arguments: {} })
    assert.equal(tpl.isError, false, JSON.stringify(json(tpl)))
    const own = await a.callTool({ name: 'assign_lead', arguments: { client_request_id: 'e2e-am-assign', campaign_target_id: target } })
    assert.equal(json(own).code, 'LEAD_ASSIGNED', JSON.stringify(json(own)))
    const sent = await a.callTool({ name: 'sms_send_agent_message', arguments: { client_request_id: 'e2e-am-send-1', campaign_target_id: target, purpose: 'first_touch', brief: 'absentee owner, inherited property' } })
    if (lawful) assert.equal(json(sent).code, 'HANDOFF_QUEUED', JSON.stringify(json(sent)))
    else assert.equal(json(sent).code, 'OUTSIDE_RECIPIENT_WINDOW', JSON.stringify(json(sent)))
    assert.equal((await sel(env.owner, 'select count(*)::int n from agent.approval_request'))[0].n, 0, 'no per-message approval on the standing grant')
    const ev = await a.callTool({ name: 'leadcommand_events_since', arguments: { cursor: 0 } })
    assert.equal(ev.isError, false, JSON.stringify(json(ev)))
    assert.ok(!JSON.stringify(json(sent)).includes(phone.slice(2)) && !JSON.stringify(json(ev)).includes(phone.slice(2)), 'no phone in any result')
    await a.close()
  } finally {
    await listener?.close().catch(() => {})
    await app?.close().catch(() => {})
    await env.db.drop()
  }
})
