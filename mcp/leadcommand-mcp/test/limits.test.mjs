// FIXTURE-backed budget tests: pagination, max results, response cap, timeout,
// rate limit, DB failure, concurrency, disconnect / recover.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { connect, call, fixtureEnv } from './helpers.mjs'
import { FIXTURE } from '../fixtures/dataset.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const errOf = (r) => { assert.equal(r.isError, true, JSON.stringify(r.structuredContent)); return r.structuredContent.error }

test('pagination: keyset pages cover the whole anchored set exactly once', async () => {
  const c = await connect()
  try {
    const seen = []
    let cursor
    let pages = 0
    do {
      const r = await call(c.client, 'leadcommand_search_properties', { market: 'Fixture Metro, TX', limit: 7, ...(cursor ? { cursor } : {}) })
      assert.ok(!r.isError, JSON.stringify(r.structuredContent.error))
      seen.push(...r.structuredContent.result.rows.map((x) => x.property_id))
      cursor = r.structuredContent.page.next_cursor
      pages += 1
      assert.ok(pages < 10)
    } while (cursor)
    const all = FIXTURE.tables.eg_property_facts.map((r) => r.property_id).sort()
    assert.deepEqual(seen, all)
    assert.equal(new Set(seen).size, seen.length)
    assert.equal(pages, Math.ceil(all.length / 7))
  } finally { await c.close() }
})

test('max results: limit is capped at 25 by schema; default 10', async () => {
  const c = await connect()
  try {
    const d = await call(c.client, 'leadcommand_search_leads', { market: 'Fixture Metro, TX' })
    assert.equal(d.structuredContent.result.rows.length, 10)
    assert.equal(d.structuredContent.page.has_more, true)
    const m = await call(c.client, 'leadcommand_search_leads', { market: 'Fixture Metro, TX', limit: 25 })
    assert.equal(m.structuredContent.result.rows.length, 25)
    assert.equal(errOf(await call(c.client, 'leadcommand_search_leads', { market: 'Fixture Metro, TX', limit: 1000 })).class, 'invalid_input')
  } finally { await c.close() }
})

test('response size cap: rows are dropped to fit, the page says so and offers no cursor', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_MAX_RESPONSE_BYTES: '9000' }) })
  try {
    const r = await call(c.client, 'leadcommand_search_leads', { market: 'Fixture Metro, TX', limit: 25 })
    assert.ok(!r.isError, JSON.stringify(r.structuredContent.error))
    assert.ok(r.structuredContent.result.rows.length < 25)
    assert.equal(r.structuredContent.page.truncated_for_size, true)
    assert.equal(r.structuredContent.page.next_cursor, null)
    assert.ok(Buffer.byteLength(JSON.stringify(r.structuredContent)) <= 9000)
    assert.equal(c.audit.at(-1).truncated, true)
  } finally { await c.close() }
})

test('response size cap: a single record that cannot fit fails (internal), it is never cut mid-document', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_MAX_RESPONSE_BYTES: '2048' }) })
  try {
    const e = errOf(await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' }))
    assert.equal(e.code, 'RESPONSE_TOO_LARGE')
  } finally { await c.close() }
})

test('timeout: a slow source is cut at the call budget → timeout (late result discarded)', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_CALL_TIMEOUT_MS: '150' }), faults: { delayMs: 600 } })
  try {
    const t0 = Date.now()
    const e = errOf(await call(c.client, 'leadcommand_get_acquisition_score', { property_id: 'FX1001' }))
    assert.equal(e.class, 'timeout')
    assert.equal(e.retryable, true)
    assert.ok(Date.now() - t0 < 550, 'returned at the deadline, not after the slow read')
  } finally { await c.close() }
})

test('rate limit: per-principal budget → rate_limited with retry hint', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_RATE_PER_MIN: '3' }) })
  try {
    for (let i = 0; i < 3; i += 1) assert.ok(!(await call(c.client, 'leadcommand_get_market_intelligence', { zip: '75001' })).isError)
    const e = errOf(await call(c.client, 'leadcommand_get_market_intelligence', { zip: '75001' }))
    assert.equal(e.class, 'rate_limited')
    assert.ok(e.details.retry_after_ms >= 0)
  } finally { await c.close() }
})

test('rate limit: the per-tool budget is enforced independently (contact status 20/min)', async () => {
  const c = await connect()
  try {
    for (let i = 0; i < 20; i += 1) assert.ok(!(await call(c.client, 'leadcommand_get_lead_contact_status', { property_id: 'FX1001' })).isError)
    assert.equal(errOf(await call(c.client, 'leadcommand_get_lead_contact_status', { property_id: 'FX1001' })).class, 'rate_limited')
    assert.ok(!(await call(c.client, 'leadcommand_get_property', { property_id: 'FX1001' })).isError, 'other tools unaffected')
  } finally { await c.close() }
})

test('DB failure: a failing table → data_unavailable (no upstream text leaks)', async () => {
  const c = await connect({ faults: { failTables: ['eg_property_facts'], errorCode: 'XX000' } })
  try {
    const e = errOf(await call(c.client, 'leadcommand_search_leads', { market: 'Fixture Metro, TX' }))
    assert.equal(e.class, 'data_unavailable')
    assert.equal(JSON.stringify(e).includes('fixture fault'), false)
  } finally { await c.close() }
})

test('DB failure: a missing relation → data_unavailable SOURCE_NOT_APPLIED', async () => {
  const fx = { ...FIXTURE, tables: { ...FIXTURE.tables } }
  delete fx.tables.mv_map_market_sales
  const c = await connect({ fixture: fx })
  try {
    const e = errOf(await call(c.client, 'leadcommand_search_comps', { property_id: 'FX1001' }))
    assert.equal(e.class, 'data_unavailable')
    assert.equal(e.code, 'SOURCE_NOT_APPLIED')
  } finally { await c.close() }
})

test('concurrent calls: within the bound all succeed; over the bound the excess is refused, never queued without bound', async () => {
  const c = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_MAX_CONCURRENCY: '2' }), faults: { delayMs: 120 } })
  try {
    const rs = await Promise.all(Array.from({ length: 6 }, () => call(c.client, 'leadcommand_get_market_intelligence', { zip: '75001' })))
    const okN = rs.filter((r) => !r.isError).length
    const limited = rs.filter((r) => r.isError && r.structuredContent.error.code === 'CONCURRENCY_LIMIT').length
    assert.equal(okN, 2)
    assert.equal(limited, 4)
    assert.equal(c.app.gateway.inFlight, 0)
  } finally { await c.close() }
  const d = await connect({ env: fixtureEnv({ LEADCOMMAND_MCP_MAX_CONCURRENCY: '4' }) })
  try {
    const names = ['leadcommand_get_property', 'leadcommand_get_lead', 'leadcommand_get_acquisition_score', 'leadcommand_search_comps']
    const rs = await Promise.all(names.map((n) => call(d.client, n, { property_id: 'FX1001' })))
    assert.ok(rs.every((r) => !r.isError))
    assert.equal(new Set(rs.map((r) => r.structuredContent.correlation_id)).size, 4)
  } finally { await d.close() }
})

test('disconnect / recover (in-memory): the server accepts a new client after the first disconnects', async () => {
  const c = await connect()
  assert.ok(!(await call(c.client, 'leadcommand_get_market_intelligence', { zip: '75001' })).isError)
  await c.client.close()
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await c.app.server.connect(st)
  const client2 = new Client({ name: 'reconnect', version: '1.0.0' })
  await client2.connect(ct)
  try {
    assert.ok(!(await call(client2, 'leadcommand_get_market_intelligence', { zip: '75001' })).isError)
  } finally { await client2.close(); await c.app.close() }
})

test('disconnect / recover (real stdio subprocess): kill → the server exits; relaunch serves again', async () => {
  const launch = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(ROOT, 'bin/leadcommand-mcp.mjs')], env: { PATH: process.env.PATH, ...fixtureEnv() }, stderr: 'pipe', cwd: ROOT })
    const client = new Client({ name: 'stdio-test', version: '1.0.0' })
    await client.connect(transport)
    return { client, transport }
  }
  const a = await launch()
  const pid = a.transport.pid
  assert.ok(pid)
  assert.equal((await a.client.listTools()).tools.length, 13)
  assert.ok(!(await call(a.client, 'leadcommand_get_market_intelligence', { zip: '75001' })).isError)
  await a.client.close() // closes stdin → server exits
  await new Promise((r) => setTimeout(r, 300))
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'server process exited after disconnect')
  const b = await launch()
  try {
    assert.ok(!(await call(b.client, 'leadcommand_get_property', { property_id: 'FX1001' })).isError)
  } finally { await b.client.close() }
})
