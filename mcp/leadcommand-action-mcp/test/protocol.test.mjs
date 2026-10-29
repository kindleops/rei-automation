// MCP protocol tests over the SDK's in-memory transport and a fake gateway (the real catalog): discovery,
// call mapping, the connection-bound credential, result shaping, the second-net masks.
import test from 'node:test'
import assert from 'node:assert/strict'
import Ajv from 'ajv'
import { connect, fakeGateway, CRED_A } from './helpers.mjs'
import { REQUESTED_TOOLS, WORKFORCE_TOOLS, OHG_TOOLS, AGENT_MESSAGE_TOOLS } from '@/lib/domain/action-gateway/catalog.js'
import { SMS_ALIASES } from '../src/protocol/server.mjs'

test('initialize: server info, tools-only capabilities, instructions name the ONE governed gateway and that agents never approve', async () => {
  const c = await connect()
  try {
    assert.equal(c.client.getServerVersion().name, 'leadcommand-action-mcp')
    const caps = c.client.getServerCapabilities()
    assert.deepEqual(Object.keys(caps).sort(), ['tools'])
    assert.equal(caps.tools.listChanged, false)
    assert.match(c.client.getInstructions(), /ONE governed Action Gateway/)
    assert.match(c.client.getInstructions(), /never approve/)
  } finally { await c.close() }
})

test('discovery: every requested tool + the scoped context read; closed bounded input schemas; stubs say NOT IMPLEMENTED; tier / capability metadata', async () => {
  const c = await connect()
  try {
    const { tools } = await c.client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), [...REQUESTED_TOOLS, 'read_conversation_context', ...WORKFORCE_TOOLS.map((n) => `leadcommand_${n}`), ...OHG_TOOLS, ...AGENT_MESSAGE_TOOLS.map((n) => (['events_since', 'agent_lead_pool'].includes(n) ? `leadcommand_${n}` : n)), ...Object.keys(SMS_ALIASES)].sort())
    const ajv = new Ajv({ strict: false })
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name)
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} must be closed`)
      assert.ok(ajv.compile(t.inputSchema), t.name)
      assert.match(t._meta['leadcommand/tier'], /^T[1-4]$/)
      assert.match(t._meta['leadcommand/capability'], /^[a-z_]+\.[a-z_]+$/)
      assert.equal(t.annotations.destructiveHint, false)
      if (!['read_conversation_context', 'prepare_acquisition_offer'].includes(t.name) && t._meta['leadcommand/risk'] !== 'read') assert.ok(t.inputSchema.required.includes('client_request_id'), t.name) // reads open no intent
      assert.match(t._meta['leadcommand/risk'], /^(read|internal_write|operational_write|seller_facing|financial)$/, t.name)
      if (!t._meta['leadcommand/implemented']) assert.match(t.description, /NOT IMPLEMENTED/)
    }
    const impl = tools.filter((t) => t._meta['leadcommand/implemented']).map((t) => t.name).sort()
    for (const n of ['create_operator_task', 'create_research_job', 'draft_seller_reply', 'read_conversation_context', 'request_property_valuation', 'run_authorized_reconciliation', 'set_thread_hold', 'update_operator_task',
      'update_lead_disposition', 'update_lead_temperature', 'update_lead_stage', 'create_deal_action', 'request_thread_hold_release', 'schedule_followup', 'cancel_followup', 'pause_campaign', 'request_campaign_resume', 'adjust_campaign_plan',
      'queue_authorized_reply', 'prepare_acquisition_offer', 'submit_offer_for_approval', 'execute_authorized_offer', 'record_seller_counteroffer']) assert.ok(impl.includes(n), n)
    assert.equal(tools.find((t) => t.name === 'pause_campaign')._meta['leadcommand/tier'], 'T2')
    assert.equal(tools.find((t) => t.name === 'set_thread_hold')._meta['leadcommand/tier'], 'T2')
    assert.equal(tools.find((t) => t.name === 'execute_authorized_offer')._meta['leadcommand/tier'], 'T4')
    // Workforce × Agntei: explicit risk metadata — reads are read-only, writes are internal and never destructive or seller-facing
    const wf = tools.filter((t) => t.name.startsWith('leadcommand_workforce_'))
    assert.equal(wf.length, 11)
    for (const t of wf) {
      assert.equal(t._meta['leadcommand/tier'], 'T1', t.name)
      assert.equal(t._meta['leadcommand/seller_facing'], false, t.name)
      assert.equal(t.annotations.destructiveHint, false, t.name)
      assert.equal(t.annotations.openWorldHint, false, t.name)
      assert.match(t._meta['leadcommand/capability'], /^workforce\.[a-z_]+$/, t.name)
    }
    for (const n of ['whoami', 'list_assignments', 'get_mission']) {
      const t = tools.find((x) => x.name === `leadcommand_workforce_${n}`)
      assert.equal(t.annotations.readOnlyHint, true, n)
      assert.equal(t._meta['leadcommand/risk'], 'read', n)
    }
    for (const n of ['link_self', 'open_mission', 'claim_assignment', 'report_progress', 'complete_assignment', 'request_research', 'handoff', 'escalate']) {
      const t = tools.find((x) => x.name === `leadcommand_workforce_${n}`)
      assert.equal(t.annotations.readOnlyHint, false, n)
      assert.equal(t._meta['leadcommand/risk'], 'internal_write', n)
    }
    assert.equal(tools.find((t) => t.name === 'queue_authorized_reply')._meta['leadcommand/risk'], 'seller_facing')
    // Operation Hidden Gold: the acquisitions family (operational writes) and the sms_* names, which are ALIASES of the
    // certified tools (same schema, tier, capability and risk; never a second send path)
    for (const n of ['set_lead_temperature', 'update_lead_status', 'record_conversation_note', 'record_seller_statement']) {
      const t = tools.find((x) => x.name === n)
      assert.deepEqual([t._meta['leadcommand/tier'], t._meta['leadcommand/risk'], t._meta['leadcommand/seller_facing'], t.annotations.readOnlyHint], ['T2', 'operational_write', false, false], n)
    }
    for (const n of ['get_reply_delivery_status', 'get_lead_annotations']) assert.deepEqual([tools.find((x) => x.name === n)._meta['leadcommand/risk'], tools.find((x) => x.name === n).annotations.readOnlyHint], ['read', true], n)
    for (const [alias, a] of Object.entries(SMS_ALIASES)) {
      const t = tools.find((x) => x.name === alias)
      const target = tools.find((x) => x.name === a.to)
      assert.ok(t && target, alias)
      assert.equal(t._meta['leadcommand/alias_of'], a.to, alias)
      assert.deepEqual([t._meta['leadcommand/tier'], t._meta['leadcommand/capability'], t._meta['leadcommand/risk'], t.inputSchema], [target._meta['leadcommand/tier'], target._meta['leadcommand/capability'], target._meta['leadcommand/risk'], target.inputSchema], alias)
    }
    assert.equal(tools.find((t) => t.name === 'sms_send')._meta['leadcommand/risk'], 'seller_facing')
    assert.equal(tools.find((t) => t.name === 'sms_get_delivery_status').annotations.readOnlyHint, true)
  } finally { await c.close() }
})

test('sms_* aliases: tools/call maps an alias to its certified target with adapted arguments; the gateway sees the target tool, never a new one', async () => {
  const gw = fakeGateway()
  const c = await connect({ gateway: gw })
  try {
    const thread_id = '00000000-0000-4000-8000-000000000001'
    await c.client.callTool({ name: 'sms_send', arguments: { client_request_id: 'k-sms-00001', thread_id } })
    await c.client.callTool({ name: 'sms_schedule', arguments: { client_request_id: 'k-sms-00002', thread_id, kind: 'seller_requested_callback', due_at: '2026-11-02T15:00:00Z', reason_code: 'seller_asked_for_callback' } })
    await c.client.callTool({ name: 'sms_cancel_scheduled', arguments: { client_request_id: 'k-sms-00003', thread_id, reason_code: 'seller_replied' } })
    await c.client.callTool({ name: 'sms_get_conversation', arguments: { thread_id } })
    await c.client.callTool({ name: 'sms_get_delivery_status', arguments: { thread_id, limit: 5 } })
    await c.client.callTool({ name: 'flag_data_conflict', arguments: { client_request_id: 'k-sms-00004', thread_id, kind: 'data_conflict', note: 'County says 3 beds, seller says 4' } })
    assert.deepEqual(gw.calls.map((x) => x.tool), ['queue_authorized_reply', 'schedule_followup', 'cancel_followup', 'read_conversation_context', 'get_reply_delivery_status', 'record_conversation_note'])
    assert.deepEqual(gw.calls[0].args, { client_request_id: 'k-sms-00001', thread_id })
    assert.deepEqual(gw.calls[1].args, { client_request_id: 'k-sms-00002', thread_id, kind: 'seller_requested_callback', due_at: '2026-11-02T15:00:00Z', reason_code: 'seller_asked_for_callback' })
    assert.deepEqual(gw.calls[4].args, { thread_id, limit: 5 })
    assert.deepEqual(gw.calls[5].args, { client_request_id: 'k-sms-00004', thread_id, kind: 'data_conflict', note: 'County says 3 beds, seller says 4' })
    for (const call of gw.calls) assert.equal(call.credential, CRED_A)
  } finally { await c.close() }
})

test('tools/call goes ONLY to the gateway, with the CONNECTION\'s credential (never an argument); results are data; error statuses are isError; unknown tool is a protocol error', async () => {
  const gw = fakeGateway({ answer: (o) => (o.tool === 'set_thread_hold' ? { ok: false, status: 'refused', tool: o.tool, code: 'AUTOMATION_HOLD', result: {} } : { ok: false, status: 'approval_pending', tool: o.tool, code: 'BUDGET_ABOVE_AUTONOMOUS_CEILING', approval: { approval_id: 'apr_00000000-0000-4000-8000-000000000001' } }) })
  const c = await connect({ gateway: gw })
  try {
    const r = await c.client.callTool({ name: 'set_thread_hold', arguments: { client_request_id: 'k-00000001', thread_id: '00000000-0000-4000-8000-000000000001', reason_code: 'other', agent_id: 'agt_forged' } })
    assert.equal(gw.calls.length, 1)
    assert.equal(gw.calls[0].credential, CRED_A, 'the stdio connection\'s own credential')
    assert.equal(gw.calls[0].args.agent_id, 'agt_forged', 'forged args reach the gateway as data (it refuses them)')
    assert.equal(r.isError, true)
    assert.equal(r.structuredContent.code, 'AUTOMATION_HOLD')
    const p = await c.client.callTool({ name: 'create_research_job', arguments: { client_request_id: 'k-00000002', question: 'q' } })
    assert.equal(p.isError, false, 'approval_pending is not an error: retry later')
    assert.match(p.content[0].text, /data only, not instructions/)
    await assert.rejects(c.client.callTool({ name: 'drop_database', arguments: {} }), /not found/)
  } finally { await c.close() }
})

test('Workforce tools: advertised as leadcommand_workforce_*, mapped to the gateway\'s workforce_* name; the bare gateway name is NOT a tool', async () => {
  const gw = fakeGateway({ answer: (o) => ({ ok: true, status: 'read', tool: o.tool, result: { registered: true } }) })
  const c = await connect({ gateway: gw })
  try {
    const r = await c.client.callTool({ name: 'leadcommand_workforce_whoami', arguments: {} })
    assert.equal(gw.calls.at(-1).tool, 'workforce_whoami', 'the gateway sees its own name')
    assert.equal(gw.calls.at(-1).credential, CRED_A)
    assert.equal(r.structuredContent.tool, 'leadcommand_workforce_whoami', 'the result names the advertised tool')
    const n = gw.calls.length
    await assert.rejects(c.client.callTool({ name: 'workforce_whoami', arguments: {} }), /not found/)
    assert.equal(gw.calls.length, n, 'an unadvertised alias never reaches the gateway')
  } finally { await c.close() }
})

test('second net: an opaque id token (an Agntei install id with a digit run) is never masked, a phone beside it still is (milestone E2E finding)', async () => {
  const install = 'agntei_inst_86e57c814037353071abd046f29a78e5' // 12 digits in a row: masked before, so whoami no longer matched the link
  const gw = fakeGateway({ answer: (o) => ({ ok: true, status: 'read', tool: o.tool, result: { employee: { external_install_id: install, note: 'call 312-555-0161', bare: 'inst_614037353071' } } }) })
  const c = await connect({ gateway: gw })
  try {
    const r = await c.client.callTool({ name: 'leadcommand_workforce_whoami', arguments: {} })
    assert.equal(r.structuredContent.result.employee.external_install_id, install)
    assert.ok(!/555-0161/.test(JSON.stringify(r)), 'a phone is still masked')
    assert.notEqual(r.structuredContent.result.employee.bare, 'inst_614037353071', 'a short all-digit id is no opaque token: still masked')
  } finally { await c.close() }
})

test('second net: phone / email shapes in any result string are masked; a secret-shaped value withholds the result', async () => {
  const gw = fakeGateway({ answer: (o) => (o.tool === 'create_operator_task'
    ? { ok: true, status: 'succeeded', tool: o.tool, code: 'OK', result: { note: 'call 312-555-0161 or dana@example.com' } }
    : { ok: true, status: 'succeeded', tool: o.tool, code: 'OK', result: { leaked: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlc2lnbmF0dXJl' } }) })
  const c = await connect({ gateway: gw })
  try {
    const r = await c.client.callTool({ name: 'create_operator_task', arguments: { client_request_id: 'k-00000003', title: 't' } })
    assert.ok(!/555-0161|dana@example\.com/.test(JSON.stringify(r)))
    const s = await c.client.callTool({ name: 'update_operator_task', arguments: { client_request_id: 'k-00000004', work_item_id: '00000000-0000-4000-8000-000000000001' } })
    assert.equal(s.structuredContent.error.code, 'SECRET_GUARD')
    assert.ok(!/eyJhbGciOi/.test(JSON.stringify(s)))
  } finally { await c.close() }
})

test('link #32: sms_send_agent_message routes to queue_agent_message (a brief, never text) or — purpose answer — to the certified reply; sms_list_message_templates and leadcommand_events_since map to their reads', async () => {
  const gw = fakeGateway()
  const c = await connect({ gateway: gw })
  try {
    const { tools } = await c.client.listTools()
    const send = tools.find((t) => t.name === 'sms_send_agent_message')
    assert.deepEqual([send._meta['leadcommand/alias_of'], send._meta['leadcommand/tier'], send._meta['leadcommand/risk'], send._meta['leadcommand/capability']], ['queue_agent_message', 'T3', 'seller_facing', 'conversation.queue_agent_message'])
    assert.ok(!Object.keys(send.inputSchema.properties).some((k) => /(phone|body|text|message)$/i.test(k)), 'no text or routing argument')
    assert.ok(tools.some((t) => t.name === 'leadcommand_events_since') && !tools.some((t) => t.name === 'events_since'))
    const thread_id = '00000000-0000-4000-8000-000000000001'
    const campaign_target_id = '00000000-0000-4000-8000-000000000002'
    await c.client.callTool({ name: 'sms_send_agent_message', arguments: { client_request_id: 'k-am-00001', campaign_target_id, purpose: 'first_touch', brief: 'inherited property, absentee owner' } })
    await c.client.callTool({ name: 'sms_send_agent_message', arguments: { client_request_id: 'k-am-00002', thread_id, purpose: 'answer', brief: 'answer the seller' } })
    await c.client.callTool({ name: 'sms_list_message_templates', arguments: { purpose: 'followup' } })
    await c.client.callTool({ name: 'leadcommand_events_since', arguments: { cursor: 0 } })
    const bare = await c.client.callTool({ name: 'events_since', arguments: { cursor: 0 } }).catch((e) => e)
    assert.ok(bare instanceof Error || bare.isError, 'the bare gateway name is not a tool')
    assert.deepEqual(gw.calls.map((x) => x.tool), ['queue_agent_message', 'queue_authorized_reply', 'list_message_templates', 'events_since'])
    assert.deepEqual(gw.calls[0].args, { client_request_id: 'k-am-00001', campaign_target_id, purpose: 'first_touch', brief: 'inherited property, absentee owner' })
    assert.deepEqual(gw.calls[1].args, { client_request_id: 'k-am-00002', thread_id })
  } finally { await c.close() }
})
