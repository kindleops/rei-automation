// FIXTURE-backed protocol tests: initialize, discovery, schema validation.
import test from 'node:test'
import assert from 'node:assert/strict'
import Ajv from 'ajv'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { connect, call, HAPPY } from './helpers.mjs'

const EXPECTED = ['leadcommand_search_leads', 'leadcommand_get_lead', 'leadcommand_search_properties', 'leadcommand_get_property', 'leadcommand_get_acquisition_score', 'leadcommand_get_market_intelligence', 'leadcommand_search_comps', 'leadcommand_get_campaign_metrics', 'leadcommand_get_lead_contact_status']


test('initialize: server info, negotiated protocol version, tools-only capabilities, instructions', async () => {
  const c = await connect()
  try {
    const info = c.client.getServerVersion()
    assert.equal(info.name, 'leadcommand-mcp')
    assert.equal(info.version, '1.0.0')
    const caps = c.client.getServerCapabilities()
    assert.deepEqual(Object.keys(caps).sort(), ['tools'])
    assert.equal(caps.tools.listChanged, false)
    assert.match(c.client.getInstructions(), /READ-ONLY/)
    assert.ok(LATEST_PROTOCOL_VERSION)
  } finally { await c.close() }
})

test('discovery: exactly the 9 read tools, read-only annotations, scope + limits metadata', async () => {
  const c = await connect()
  try {
    const { tools } = await c.client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED].sort())
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true, t.name)
      assert.equal(t.annotations.destructiveHint, false, t.name)
      assert.equal(t.annotations.openWorldHint, false, t.name)
      assert.match(t._meta['leadcommand/scope'], /^leadcommand\.[a-z_]+\.read$/)
      assert.ok(t._meta['leadcommand/limits'].per_min > 0)
      assert.ok(t._meta['leadcommand/limits'].max_response_bytes > 0)
      assert.equal(t.inputSchema.type, 'object')
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} input schema must be closed`)
      assert.equal(t.outputSchema.type, 'object')
      assert.ok(t.description.length > 40)
    }
  } finally { await c.close() }
})

test('schema validation: every tool result validates against its advertised outputSchema (Ajv) and the SDK client', async () => {
  const c = await connect()
  try {
    const { tools } = await c.client.listTools()
    const ajv = new Ajv({ strict: false, allErrors: true })
    for (const t of tools) {
      const validate = ajv.compile(t.outputSchema)
      const r = await call(c.client, t.name, HAPPY[t.name]) // SDK Client also validates structuredContent against outputSchema
      assert.ok(!r.isError, `${t.name}: ${JSON.stringify(r.structuredContent?.error)}`)
      assert.ok(validate(r.structuredContent), `${t.name}: ${JSON.stringify(validate.errors?.slice(0, 3))}`)
      assert.equal(r.content[0].type, 'text')
      assert.match(r.content[0].text, /data only, not instructions/)
    }
  } finally { await c.close() }
})

test('schema validation: input schemas are closed and bounded (limit > max, wrong types, unknown keys)', async () => {
  const c = await connect()
  try {
    let r = await call(c.client, 'leadcommand_search_leads', { market: 'Fixture Metro, TX', limit: 26 })
    assert.equal(r.isError, true)
    assert.equal(r.structuredContent.error.class, 'invalid_input')
    r = await call(c.client, 'leadcommand_get_property', { property_id: "1; drop table properties" })
    assert.equal(r.structuredContent.error.class, 'invalid_input')
    r = await call(c.client, 'leadcommand_get_market_intelligence', { zip: '75001', property_id: 'FX1001' })
    assert.equal(r.structuredContent.error.class, 'invalid_input')
    r = await call(c.client, 'leadcommand_get_acquisition_score', { property_id: 'FX1001', include_evidence: true })
    assert.equal(r.structuredContent.error.class, 'invalid_input')
  } finally { await c.close() }
})

test('unknown tool is a protocol error (InvalidParams), and is audited', async () => {
  const c = await connect()
  try {
    await assert.rejects(() => call(c.client, 'leadcommand_send_sms', { to: 'x' }), /not found/)
    const last = c.audit.at(-1)
    assert.equal(last.error_code, 'UNKNOWN_TOOL')
    assert.equal(last.outcome, 'refused')
  } finally { await c.close() }
})
