/**
 * HOME LAYOUTS route — operator-private persistence for the Home command board.
 * No network, no database: an in-memory table behind the supabase query surface.
 *   auth gate · operator required · per-operator isolation · validation ·
 *   revision conflict returns the current row · one default per operator ·
 *   missing table → home_store_unavailable (the dashboard falls back to local).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createHomeLayoutService, validateLayout, MAX_WIDGETS } from '../../src/lib/domain/home/home-layout-service.js'
import { createHomeLayoutRoutes } from '../../src/lib/domain/home/home-layout-routes.js'

function memoryDb({ missing = false } = {}) {
  const rows = []
  const from = () => {
    const q = { op: 'select', filters: [], payload: null, head: false, count: null, single: false, maybe: false }
    const match = (r) => q.filters.every(([k, v, neg]) => (neg ? r[k] !== v : r[k] === v))
    const run = () => {
      if (missing) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.operator_home_layouts' in the schema cache" } }
      if (q.op === 'select') {
        const hits = rows.filter(match)
        if (q.head) return { data: null, count: hits.length, error: null }
        if (q.maybe) return { data: hits[0] ? { ...hits[0] } : null, error: null }
        return { data: hits.map((r) => ({ ...r })), error: null }
      }
      if (q.op === 'update') { for (const r of rows.filter(match)) Object.assign(r, q.payload); return { data: null, error: null } }
      if (q.op === 'delete') { for (const r of rows.filter(match)) rows.splice(rows.indexOf(r), 1); return { data: null, error: null } }
      if (q.op === 'upsert') {
        const p = q.payload
        const i = rows.findIndex((r) => r.operator_id === p.operator_id && r.layout_id === p.layout_id)
        if (i >= 0) rows[i] = { ...rows[i], ...p }
        else rows.push({ created_at: p.updated_at, ...p })
        const row = rows.find((r) => r.operator_id === p.operator_id && r.layout_id === p.layout_id)
        return { data: { ...row }, error: null }
      }
      return { data: null, error: null }
    }
    const b = {
      select(_cols, opts) { if (q.op === 'select') { q.head = Boolean(opts?.head) } return b },
      eq(k, v) { q.filters.push([k, v, false]); return b },
      neq(k, v) { q.filters.push([k, v, true]); return b },
      order() { return b },
      limit() { return b },
      maybeSingle() { q.maybe = true; return Promise.resolve(run()) },
      single() { return Promise.resolve(run()) },
      update(p) { q.op = 'update'; q.payload = p; return b },
      upsert(p) { q.op = 'upsert'; q.payload = p; return b },
      delete() { q.op = 'delete'; return b },
      then(res, rej) { return Promise.resolve(run()).then(res, rej) },
    }
    return b
  }
  return { rows, from }
}

const allow = () => ({ ok: true })
const deny = () => ({ ok: false, response: new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 }) })
const cors = () => ({ 'Access-Control-Allow-Origin': 'http://localhost:5173' })

function req(method, { operator = 'op-1', body, query = '' } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (operator) headers.set('x-ops-user-id', operator)
  return new Request(`http://localhost/api/cockpit/home/layouts${query}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

const layout = (over = {}) => ({
  layout_id: 'l_command1', name: 'Command', is_default: true, profile: 'desktop', schema_version: 1, revision: 1,
  preset: 'command', primary_family: 'standard',
  widget_instances: [{ id: 'w_brief01', type: 'home.brief', geometry: { standard: { x: 0, y: 0, w: 8, h: 3 } }, config: {} }],
  ...over,
})

function setup(opts) {
  const db = memoryDb(opts)
  const routes = createHomeLayoutRoutes({ service: createHomeLayoutService({ db, now: () => new Date('2026-10-02T15:00:00Z') }), authorize: opts?.deny ? deny : allow, cors })
  return { db, routes }
}

test('the dashboard gate runs first', async () => {
  const { routes } = setup({ deny: true })
  const res = await routes.GET(req('GET'))
  assert.equal(res.status, 401)
})

test('a request without a Worker-verified operator is refused (never saved for "someone")', async () => {
  const { routes, db } = setup()
  const res = await routes.PUT(req('PUT', { operator: null, body: { layout: layout() } }))
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error, 'operator_unknown')
  assert.equal(db.rows.length, 0)
})

test('saves and lists layouts per operator only', async () => {
  const { routes } = setup()
  let res = await routes.PUT(req('PUT', { body: { layout: layout() } }))
  assert.equal(res.status, 200)
  const saved = (await res.json()).layout
  assert.equal(saved.layout_id, 'l_command1')
  assert.equal(saved.revision, 1)
  res = await routes.PUT(req('PUT', { operator: 'op-2', body: { layout: layout({ layout_id: 'l_theirs01', name: 'Theirs' }) } }))
  assert.equal(res.status, 200)
  const mine = await (await routes.GET(req('GET'))).json()
  assert.deepEqual(mine.layouts.map((l) => l.layout_id), ['l_command1'])
  const theirs = await (await routes.GET(req('GET', { operator: 'op-2' }))).json()
  assert.deepEqual(theirs.layouts.map((l) => l.layout_id), ['l_theirs01'])
  // a body cannot name another operator: the Worker's header decides
  const spoof = await routes.PUT(req('PUT', { body: { layout: layout({ layout_id: 'l_spoofed1' }), operator_id: 'op-2' } }))
  assert.equal(spoof.status, 200)
  const theirsAfter = await (await routes.GET(req('GET', { operator: 'op-2' }))).json()
  assert.deepEqual(theirsAfter.layouts.map((l) => l.layout_id), ['l_theirs01'])
})

test('a stale revision is refused with the current row', async () => {
  const { routes } = setup()
  await routes.PUT(req('PUT', { body: { layout: layout({ revision: 4 }) } }))
  const res = await routes.PUT(req('PUT', { body: { layout: layout({ revision: 4, name: 'Older' }) } }))
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'revision_conflict')
  assert.equal(body.current.revision, 4)
  assert.equal(body.current.name, 'Command')
  const ok = await routes.PUT(req('PUT', { body: { layout: layout({ revision: 5, name: 'Newer' }) } }))
  assert.equal(ok.status, 200)
})

test('one default layout per operator', async () => {
  const { routes, db } = setup()
  await routes.PUT(req('PUT', { body: { layout: layout() } }))
  await routes.PUT(req('PUT', { body: { layout: layout({ layout_id: 'l_minimal1', name: 'Minimal', preset: 'minimal' }) } }))
  const defaults = db.rows.filter((r) => r.operator_id === 'op-1' && r.is_default).map((r) => r.layout_id)
  assert.deepEqual(defaults, ['l_minimal1'])
})

test('deletes only the operator\'s own layout', async () => {
  const { routes, db } = setup()
  await routes.PUT(req('PUT', { body: { layout: layout() } }))
  await routes.PUT(req('PUT', { operator: 'op-2', body: { layout: layout() } }))
  const res = await routes.DELETE(req('DELETE', { query: '?layout_id=l_command1' }))
  assert.equal(res.status, 200)
  assert.deepEqual(db.rows.map((r) => r.operator_id), ['op-2'])
})

test('rejects malformed layouts', async () => {
  assert.throws(() => validateLayout(layout({ layout_id: 'bad id!' })), /layout_id/)
  assert.throws(() => validateLayout(layout({ name: '' })), /name/)
  assert.throws(() => validateLayout(layout({ revision: -1 })), /revision/)
  assert.throws(() => validateLayout(layout({ widget_instances: {} })), /array/)
  assert.throws(() => validateLayout(layout({ widget_instances: [{ type: 'x' }] })), /stable id/)
  assert.throws(() => validateLayout(layout({ widget_instances: Array.from({ length: MAX_WIDGETS + 1 }, (_, i) => ({ id: `w_${String(i).padStart(4, '0')}`, type: 'x' })) })), /at most/)
  assert.throws(() => validateLayout(layout({ preset: 'chaos' })), /preset/)
  const { routes } = setup()
  const res = await routes.PUT(req('PUT', { body: { layout: layout({ layout_id: '!!' }) } }))
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'invalid_layout')
})

test('before the migration is applied every call says home_store_unavailable', async () => {
  const { routes } = setup({ missing: true })
  for (const res of [await routes.GET(req('GET')), await routes.PUT(req('PUT', { body: { layout: layout() } })), await routes.DELETE(req('DELETE', { query: '?layout_id=l_command1' }))]) {
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error, 'home_store_unavailable')
  }
})
