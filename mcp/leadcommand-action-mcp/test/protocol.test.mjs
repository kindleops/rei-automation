// MCP protocol tests over the SDK's in-memory transport and a fake gateway (the real catalog): discovery,
// call mapping, the connection-bound credential, result shaping, the second-net masks.
import test from 'node:test'
import assert from 'node:assert/strict'
import Ajv from 'ajv'
import { connect, fakeGateway, CRED_A } from './helpers.mjs'
import { REQUESTED_TOOLS } from '@/lib/domain/action-gateway/catalog.js'

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
    assert.deepEqual(tools.map((t) => t.name).sort(), [...REQUESTED_TOOLS, 'read_conversation_context'].sort())
    const ajv = new Ajv({ strict: false })
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name)
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} must be closed`)
      assert.ok(ajv.compile(t.inputSchema), t.name)
      assert.match(t._meta['leadcommand/tier'], /^T[1-4]$/)
      assert.match(t._meta['leadcommand/capability'], /^[a-z_]+\.[a-z_]+$/)
      assert.equal(t.annotations.destructiveHint, false)
      if (t.name !== 'read_conversation_context') assert.ok(t.inputSchema.required.includes('client_request_id'), t.name)
      if (!t._meta['leadcommand/implemented']) assert.match(t.description, /NOT IMPLEMENTED/)
    }
    const impl = tools.filter((t) => t._meta['leadcommand/implemented']).map((t) => t.name).sort()
    assert.deepEqual(impl, ['create_operator_task', 'create_research_job', 'draft_seller_reply', 'read_conversation_context', 'request_property_valuation', 'run_authorized_reconciliation', 'set_thread_hold', 'update_operator_task'])
    assert.equal(tools.find((t) => t.name === 'set_thread_hold')._meta['leadcommand/tier'], 'T2')
    assert.equal(tools.find((t) => t.name === 'execute_authorized_offer')._meta['leadcommand/tier'], 'T4')
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
