// FIXTURE-backed authentication / authorization tests: unauthenticated,
// forged ids, cross-org, scope and role denial, cursor forgery.
import test from 'node:test'
import assert from 'node:assert/strict'
import { connect, call, fixtureEnv } from './helpers.mjs'
import { FIXTURE_OTHER_ORG, FIXTURE_STRANGER, FIXTURE_OPERATOR, FIXTURE_ORG } from '../fixtures/dataset.mjs'
import { createFixtureMembershipStore } from '../src/auth/principal.mjs'

const errOf = (r) => { assert.equal(r.isError, true, JSON.stringify(r.structuredContent)); return r.structuredContent.error }

test('unauthenticated: no principal configured → unauthorized on every tool; audited as refused', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_PRINCIPAL_USER_ID: '' }) })
  try {
    for (const n of ['leadcommand_get_property', 'leadcommand_get_lead_contact_status']) {
      const e = errOf(await call(c.client, n, { property_id: 'FX1001' }))
      assert.equal(e.class, 'unauthorized')
      assert.equal(e.code, 'NO_PRINCIPAL')
    }
    assert.ok(c.audit.every((a) => a.event !== 'tool_call' || a.outcome === 'refused'))
  } finally { await c.close() }
})

test('unauthenticated: principal not in agent.operator_membership → unauthorized', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_PRINCIPAL_USER_ID: '00000000-0000-4000-8000-00000000ffff' }) })
  try {
    const e = errOf(await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' }))
    assert.equal(e.class, 'unauthorized')
    assert.equal(e.code, 'NOT_A_MEMBER')
  } finally { await c.close() }
})

test('cross-org: a principal of another org is forbidden even though it is a member there', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_PRINCIPAL_USER_ID: FIXTURE_STRANGER, LEADCOMMAND_MCP_ORG_ID: FIXTURE_OTHER_ORG, LEADCOMMAND_MCP_DATA_ORG_ID: FIXTURE_ORG }) })
  try {
    const e = errOf(await call(c.client, 'leadcommand_search_leads', { market: 'Fixture Metro, TX' }))
    assert.equal(e.class, 'forbidden')
    assert.equal(e.code, 'CROSS_ORG')
  } finally { await c.close() }
})

test('cross-org: membership in the right org id but under a different user → not a member', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_PRINCIPAL_USER_ID: FIXTURE_STRANGER }) })
  try {
    const e = errOf(await call(c.client, 'leadcommand_get_lead', { property_id: 'FX1001' }))
    assert.equal(e.code, 'NOT_A_MEMBER')
  } finally { await c.close() }
})

test('forged ids: org / user / principal / role / scope arguments are refused, never honoured', async () => {
  const c = await connect()
  try {
    for (const k of ['org_id', 'user_id', 'principal', 'tenant_id', 'role', 'scopes', 'approved', 'impersonate']) {
      const e = errOf(await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001', [k]: FIXTURE_OTHER_ORG }))
      assert.equal(e.class, 'invalid_input')
      assert.equal(e.code, 'FORGED_CONTEXT', k)
    }
  } finally { await c.close() }
})

test('forged ids: injection-shaped and oversized ids are invalid_input', async () => {
  const c = await connect()
  try {
    for (const id of ["FX1001' or '1'='1", 'FX1001;select', '../../etc/passwd', 'x'.repeat(65), '']) {
      const e = errOf(await call(c.client, 'leadcommand_get_property', { property_id: id }))
      assert.equal(e.class, 'invalid_input', id)
    }
  } finally { await c.close() }
})

test('scope denial: contact status is not in the default grant', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: '' }) })
  try {
    const e = errOf(await call(c.client, 'leadcommand_get_lead_contact_status', { property_id: 'FX1001' }))
    assert.equal(e.class, 'forbidden')
    assert.equal(e.code, 'SCOPE_NOT_GRANTED')
    assert.equal(e.details.required_scope, 'leadcommand.contact_status.read')
    const r = await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' })
    assert.ok(!r.isError, 'default scopes still allow property reads')
  } finally { await c.close() }
})

test('scope denial: a narrow grant allows only its tools', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: 'leadcommand.market.read' }) })
  try {
    assert.ok(!(await call(c.client, 'leadcommand_get_market_intelligence', { zip: '75001' })).isError)
    assert.equal(errOf(await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' })).class, 'forbidden')
    assert.equal(errOf(await call(c.client, 'leadcommand_get_campaign_metrics', {})).class, 'forbidden')
  } finally { await c.close() }
})

test('scope config: an unknown or write scope refuses to boot', async () => {
  await assert.rejects(() => connect({ env: fixtureEnv({ LEADCOMMAND_MCP_SCOPES: 'leadcommand.sms.send' }) }), /unknown scope/)
})

test('role: operator role is honoured for operator tools', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_PRINCIPAL_USER_ID: FIXTURE_OPERATOR }) })
  try {
    assert.ok(!(await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' })).isError)
  } finally { await c.close() }
})

test('membership store failure fails CLOSED (unavailable), never open', async () => {
  const broken = { async lookup() { throw new Error('connection refused') }, async close() {} }
  const c = await connect({ membershipStore: broken })
  try {
    const e = errOf(await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' }))
    assert.equal(e.class, 'unavailable')
    assert.equal(e.code, 'MEMBERSHIP_UNAVAILABLE')
  } finally { await c.close() }
})

test('membership is re-checked (cache TTL) — a revoked member is refused after expiry', async () => {
  const rows = [{ org_id: FIXTURE_ORG, user_id: '00000000-0000-4000-8000-0000000000b1', role: 'owner' }]
  const store = createFixtureMembershipStore(rows)
  const c = await connect({ membershipStore: store })
  try {
    assert.ok(!(await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' })).isError)
    rows.length = 0
    c.app.authorizer.reset() // TTL expiry
    assert.equal(errOf(await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' })).code, 'NOT_A_MEMBER')
  } finally { await c.close() }
})

test('cursor forgery: tampered, cross-filter, cross-tool and cross-principal cursors are refused', async () => {
  const c = await connect()
  try {
    const p1 = await call(c.client, 'leadcommand_search_properties', { market: 'Fixture Metro, TX', limit: 5 })
    const cur = p1.structuredContent.page.next_cursor
    assert.ok(cur)
    const [ver, body, sig] = cur.split('.')
    assert.equal(ver, 'lc1')
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), a: 'FX9999' })).toString('base64url')
    assert.equal(errOf(await call(c.client, 'leadcommand_search_properties', { market: 'Fixture Metro, TX', limit: 5, cursor: `lc1.${forgedBody}.${sig}` })).code, 'CURSOR_INVALID')
    assert.equal(errOf(await call(c.client, 'leadcommand_search_properties', { market: 'Fixture Metro, TX', units_min: 2, limit: 5, cursor: cur })).code, 'CURSOR_MISMATCH')
    assert.equal(errOf(await call(c.client, 'leadcommand_search_leads', { market: 'Fixture Metro, TX', limit: 5, cursor: cur })).code, 'CURSOR_MISMATCH')
    // another principal (operator) on a separate server instance: different key AND binding
    const other = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_PRINCIPAL_USER_ID: FIXTURE_OPERATOR }) })
    try {
      assert.equal(errOf(await call(other.client, 'leadcommand_search_properties', { market: 'Fixture Metro, TX', limit: 5, cursor: cur })).class, 'invalid_input')
    } finally { await other.close() }
  } finally { await c.close() }
})

test('unsupported filters: an unknown filter on a search tool is unsupported_filter; no anchor is unsupported_filter', async () => {
  const c = await connect()
  try {
    let e = errOf(await call(c.client, 'leadcommand_search_properties', { zip: '75001', owner_name: 'x' }))
    assert.equal(e.class, 'unsupported_filter')
    assert.deepEqual(e.details.unsupported, ['owner_name'])
    e = errOf(await call(c.client, 'leadcommand_search_leads', { state: 'TX' }))
    assert.equal(e.class, 'unsupported_filter')
    assert.equal(e.code, 'ANCHOR_REQUIRED')
    e = errOf(await call(c.client, 'leadcommand_search_leads', { phone: '5550100101', market: 'Fixture Metro, TX' }))
    assert.equal(e.class, 'unsupported_filter')
  } finally { await c.close() }
})

test('HTTP transport is disabled in 1.0: refuses to boot', async () => {
  await assert.rejects(() => connect({ env: fixtureEnv({ LEADCOMMAND_MCP_TRANSPORT: 'http' }) }), /not enabled in 1\.0/)
})
