/**
 * RESEARCH SOURCES route (Browser 1.0 Save Source). No network, no database:
 * an in-memory table pair behind the supabase query surface.
 *   auth gate · operator required (from x-ops-user-id, never the body) ·
 *   validation (http(s) only, no javascript:/data:, no credentials) ·
 *   attach writes ONE source row + ONE audit row and nothing else ·
 *   idempotent re-save · soft remove audited · report_broken audited ·
 *   missing table → research_store_unavailable (the dashboard keeps it locally) ·
 *   the Machine Feed adapter emits research.source_saved for attach only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createResearchSourcesService, validateSource } from '../../src/lib/domain/research/research-sources-service.js'
import { createResearchSourcesRoutes } from '../../src/lib/domain/research/research-sources-routes.js'
import { researchAdapter, researchEvent } from '../../src/lib/domain/platform/events/adapters/research.js'

function memoryDb({ missing = false } = {}) {
  const tables = { research_sources: [], research_source_audit: [] }
  const touched = new Set()
  let seq = 0
  const from = (name) => {
    touched.add(name)
    const rows = tables[name] ?? (tables[name] = [])
    const q = { op: 'select', filters: [], payload: null, single: false, maybe: false }
    const match = (r) => q.filters.every(([k, v, kind]) => (kind === 'is' ? (r[k] ?? null) === v : kind === 'in' ? v.includes(r[k]) : r[k] === v))
    const run = () => {
      if (missing) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache` } }
      if (q.op === 'select') {
        const hits = rows.filter(match).map((r) => ({ ...r }))
        if (q.maybe) return { data: hits[0] ?? null, error: null }
        return { data: hits, error: null }
      }
      if (q.op === 'insert') {
        const row = { ...(name === 'research_sources' ? { research_source_id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}` } : { id: ++seq }), ...q.payload }
        rows.push(row)
        return { data: { ...row }, error: null }
      }
      if (q.op === 'update') {
        const hits = rows.filter(match)
        for (const r of hits) Object.assign(r, q.payload)
        return { data: hits[0] ? { ...hits[0] } : null, error: null }
      }
      return { data: null, error: null }
    }
    const b = {
      select() { return b },
      eq(k, v) { q.filters.push([k, v, 'eq']); return b },
      is(k, v) { q.filters.push([k, v, 'is']); return b },
      in(k, v) { q.filters.push([k, v, 'in']); return b },
      gte() { return b }, lte() { return b }, lt() { return b },
      order() { return b }, limit() { return b }, range() { return b },
      insert(p) { q.op = 'insert'; q.payload = p; return b },
      update(p) { q.op = 'update'; q.payload = p; return b },
      maybeSingle() { q.maybe = true; return Promise.resolve(run()) },
      single() { return Promise.resolve(run()) },
      then(res, rej) { return Promise.resolve(run()).then(res, rej) },
    }
    return b
  }
  return { tables, touched, from }
}

const allow = () => ({ ok: true })
const deny = () => ({ ok: false, response: new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 }) })
const cors = () => ({ 'Access-Control-Allow-Origin': 'http://localhost:5173' })

function req(method, { operator = 'op-1', body, query = '' } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (operator) headers.set('x-ops-user-id', operator)
  return new Request(`http://localhost/api/cockpit/research/sources${query}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

const source = (over = {}) => ({ object_type: 'property', object_id: '273312064', url: 'https://gis.hennepin.us/property/', page_title: 'Hennepin GIS', destination_type: 'GIS', ...over })

function setup(opts = {}) {
  const db = memoryDb(opts)
  const routes = createResearchSourcesRoutes({ service: createResearchSourcesService({ db, now: () => new Date('2026-10-02T20:00:00Z') }), authorize: opts.deny ? deny : allow, cors })
  return { db, routes }
}

test('the dashboard gate runs first', async () => {
  const { routes, db } = setup({ deny: true })
  const res = await routes.POST(req('POST', { body: { source: source() } }))
  assert.equal(res.status, 401)
  assert.equal(db.tables.research_sources.length, 0)
})

test('no Worker-verified operator → refused, nothing written', async () => {
  const { routes, db } = setup()
  const res = await routes.POST(req('POST', { operator: null, body: { source: source() } }))
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error, 'operator_unknown')
  assert.equal(db.tables.research_sources.length + db.tables.research_source_audit.length, 0)
})

test('attach writes one pointer + one audit row and touches no fact table', async () => {
  const { routes, db } = setup()
  const res = await routes.POST(req('POST', { body: { source: { ...source(), captured_by: 'someone-else' } } }))
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.created, true)
  assert.equal(body.source.url, 'https://gis.hennepin.us/property/')
  assert.equal(db.tables.research_sources[0].captured_by, 'op-1') // the header decides, never the body
  assert.deepEqual(db.tables.research_source_audit.map((a) => [a.action, a.actor, a.object_id]), [['attach', 'op-1', '273312064']])
  assert.deepEqual([...db.touched].sort(), ['research_source_audit', 'research_sources'])
})

test('saving the same page again is idempotent (no duplicate, no second audit)', async () => {
  const { routes, db } = setup()
  await routes.POST(req('POST', { body: { source: source() } }))
  const again = await routes.POST(req('POST', { body: { source: source() } }))
  assert.equal(again.status, 200)
  assert.equal((await again.json()).created, false)
  assert.equal(db.tables.research_sources.length, 1)
  assert.equal(db.tables.research_source_audit.length, 1)
})

test('rejects unsafe or malformed sources', async () => {
  for (const bad of [
    source({ url: 'javascript:alert(1)' }),
    source({ url: 'data:text/html,hi' }),
    source({ url: 'file:///etc/passwd' }),
    source({ url: 'https://u:p@x.gov/' }),
    source({ object_type: 'seller' }),
    source({ object_id: '' }),
    source({ destination_type: 'NOPE' }),
  ]) {
    assert.throws(() => validateSource(bad))
  }
  const { routes } = setup()
  const res = await routes.POST(req('POST', { body: { source: source({ url: 'javascript:alert(1)' }) } }))
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'invalid_source')
})

test('operator-private: another operator never sees or removes my sources', async () => {
  const { routes, db } = setup()
  const mine = await (await routes.POST(req('POST', { body: { source: source() } }))).json()
  const theirs = await (await routes.GET(req('GET', { operator: 'op-2', query: '?object_type=property&object_id=273312064' }))).json()
  assert.deepEqual(theirs.sources, [])
  const del = await routes.DELETE(req('DELETE', { operator: 'op-2', query: `?research_source_id=${mine.source.research_source_id}` }))
  assert.equal(del.status, 404)
  assert.equal(db.tables.research_sources[0].removed_at, undefined)
  // a second operator saving the same page gets their own row
  const r2 = await routes.POST(req('POST', { operator: 'op-2', body: { source: source() } }))
  assert.equal(r2.status, 201)
})

test('stores provenance only: no notes, no page content, no free-form payload', async () => {
  const { routes, db } = setup()
  await routes.POST(req('POST', { body: { source: { ...source(), notes: 'private', content: '<html>…</html>' } } }))
  assert.deepEqual(Object.keys(db.tables.research_sources[0]).sort(), ['captured_at', 'captured_by', 'destination_type', 'object_id', 'object_type', 'page_title', 'research_source_id', 'url'])
  assert.deepEqual(Object.keys(db.tables.research_source_audit[0]).sort(), ['action', 'actor', 'created_at', 'destination_type', 'id', 'object_id', 'object_type', 'page_title', 'research_source_id', 'url'])
})

test('lists live sources for one object; remove is soft and audited', async () => {
  const { routes, db } = setup()
  const created = await (await routes.POST(req('POST', { body: { source: source() } }))).json()
  await routes.POST(req('POST', { body: { source: source({ object_id: 'other' }) } }))
  let list = await (await routes.GET(req('GET', { query: '?object_type=property&object_id=273312064' }))).json()
  assert.deepEqual(list.sources.map((s) => s.object_id), ['273312064'])
  const del = await routes.DELETE(req('DELETE', { query: `?research_source_id=${created.source.research_source_id}` }))
  assert.equal(del.status, 200)
  list = await (await routes.GET(req('GET', { query: '?object_type=property&object_id=273312064' }))).json()
  assert.equal(list.sources.length, 0)
  assert.equal(db.tables.research_sources.length, 2) // soft
  assert.deepEqual(db.tables.research_source_audit.map((a) => a.action), ['attach', 'attach', 'remove'])
})

test('a broken destination report is audit-only', async () => {
  const { routes, db } = setup()
  const res = await routes.POST(req('POST', { body: { report: { destination_id: 'mn-hennepin-assessor', url: 'https://www.hennepin.us/x', note: 'moved' } } }))
  assert.equal(res.status, 200)
  assert.equal(db.tables.research_sources.length, 0)
  assert.deepEqual(db.tables.research_source_audit.map((a) => [a.action, a.destination_id]), [['report_broken', 'mn-hennepin-assessor']])
})

test('until the migration is applied: research_store_unavailable (503)', async () => {
  const { routes } = setup({ missing: true })
  const res = await routes.POST(req('POST', { body: { source: source() } }))
  assert.equal(res.status, 503)
  assert.equal((await res.json()).error, 'research_store_unavailable')
})

test('Machine Feed: attach → research.source_saved; other actions never appear', async () => {
  const ev = researchEvent({ id: 7, action: 'attach', object_type: 'property', object_id: '273312064', url: 'https://www.hennepin.us/x?pid=1', destination_type: 'ASSESSOR', created_at: '2026-10-02T20:00:00Z' })
  assert.equal(ev.event_type, 'research.source_saved')
  assert.equal(ev.summary, 'Source saved · hennepin.us')
  assert.equal(ev.property_id, '273312064')
  assert.equal(JSON.stringify(ev).includes('pid=1'), false) // the shared feed shows the host, never the page URL
  assert.equal(researchEvent({ id: 8, action: 'remove', created_at: '2026-10-02T20:00:00Z' }), null)
  assert.equal(researchEvent({ id: 9, action: 'report_broken', created_at: '2026-10-02T20:00:00Z' }), null)
  // a store that does not exist yet is quiet, not a degraded feed
  const r = await researchAdapter.read({ cursor: null, since: null, until: null, limit: 10, subject: null }, { db: memoryDb({ missing: true }) })
  assert.deepEqual(r, { events: [], complete_above: null })
})
