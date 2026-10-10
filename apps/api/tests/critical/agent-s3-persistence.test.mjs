// Agent S3 — durable local-dev store: a live Quick Scan's events survive a
// store reopen (simulated API restart) byte-identical; cursor replay pages are
// gapless and duplicate-free; a scan interrupted mid-run resumes after the
// restart without duplicating any event; fixtures and live never mix.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createFileAgentStore } from '../../src/lib/agent/runtime/file-store.js'
import { createEventLog, appendEventTx } from '../../src/lib/agent/runtime/event-log.js'
import { createLiveAgent } from '../../src/lib/agent/live/live-agent.js'
import { createQuickScanServices } from '../../src/lib/agent/quick-scan/services.js'
import { getEntityGraphDossier } from '../../src/lib/domain/entity-graph/entity-graph-service.js'
import { reduceEvents } from '../../src/lib/agent/contracts/reducer.js'
import { multiDb, killableStore } from '../helpers/agent-s3-fake-db.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-s3-store-'))
const IDS = ['9000000001', '9000000002', '9000000003']

function agentOn(dir, { impl = {}, leaseTtlMs = 15_000 } = {}) {
  const db = multiDb(IDS)
  const store = killableStore(createFileAgentStore({ dir, namespace: 'live', env: { NODE_ENV: 'test' } }))
  return createLiveAgent({ env: { AGENT_MAX_MODE: 'read' }, store, leaseTtlMs, createServices: () => createQuickScanServices({ db, impl }) })
}

function pageAll(eventLog, run_id, size) {
  const out = []
  let cursor = 0
  for (;;) {
    const p = eventLog.replay({ run_id, after: cursor, limit: size })
    if (!p.events.length) break
    out.push(...p.events)
    cursor = p.cursor
  }
  return out
}

test('events + snapshot survive a store reopen (simulated restart) identically; replay pages have no gaps or dupes', async () => {
  const dir = tmp()
  const a = agentOn(dir)
  const pf = await a.quickScan.preflight({ operator_id: 'op_1', property_ids: IDS })
  const c = await a.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id: 'op_1' })
  await c.done
  const before = JSON.stringify(a.store.read().events.filter((e) => e.run_id === pf.run_id))
  const snapBefore = a.quickScan.snapshot(pf.run_id)

  // "restart": a brand-new store + agent over the same directory
  const b = agentOn(dir)
  await b.quickScan.recover()
  const after = JSON.stringify(b.store.read().events.filter((e) => e.run_id === pf.run_id))
  assert.equal(after, before)
  const snapAfter = b.quickScan.snapshot(pf.run_id)
  assert.deepEqual(snapAfter.view, snapBefore.view)
  assert.equal(snapAfter.last_event_id, snapBefore.last_event_id)
  assert.equal(snapAfter.findings.length, snapBefore.findings.length)

  for (const size of [1, 7, 50, 2000]) {
    const pages = pageAll(b.eventLog, pf.run_id, size)
    assert.equal(JSON.stringify(pages), before, `page size ${size}`)
    const ids = pages.map((e) => e.event_id)
    assert.equal(new Set(ids).size, ids.length, 'no duplicate event ids')
    pages.forEach((e, i) => assert.equal(e.seq, i + 1, 'gapless seq'))
  }
  // a client resuming from a mid-stream cursor sees exactly the remainder
  const mid = JSON.parse(before)[40].event_id
  const rest = b.eventLog.replay({ run_id: pf.run_id, after: mid, limit: 2000 }).events
  assert.equal(rest[0].event_id > mid, true)
  assert.equal(rest.length, JSON.parse(before).filter((e) => e.event_id > mid).length)
  // reducer is idempotent under overlap (replay after reconnect)
  const all = JSON.parse(before)
  assert.deepEqual(reduceEvents([...all, ...all.slice(10, 30)])[pf.run_id], reduceEvents(all)[pf.run_id])
})

test('a scan interrupted mid-run resumes after restart: interrupted task re-runs as attempt 2, no event duplicated, gapless, completes', async () => {
  const dir = tmp()
  let hang = true
  const impl = { getEntityGraphDossier: async (kind, id, deps) => { if (hang && id === '9000000002') await new Promise(() => {}); return getEntityGraphDossier(kind, id, deps) } }
  const a = agentOn(dir, { impl, leaseTtlMs: 200 })
  const pf = await a.quickScan.preflight({ operator_id: 'op_1', property_ids: IDS })
  await a.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id: 'op_1' })
  for (let i = 0; i < 400 && !a.store.read().events.some((e) => e.run_id === pf.run_id && e.type === 'task.started' && e.property_id === '9000000002'); i += 1) await new Promise((r) => setTimeout(r, 5))
  // let the other worker finish its property, then "kill" process A (its dispatcher hangs forever on property 2)
  await new Promise((r) => setTimeout(r, 100))
  a.store.kill() // SIGKILL: no more heartbeats or writes from A
  const eventsAtCrash = a.store.read().events.filter((e) => e.run_id === pf.run_id).length
  hang = false

  const b = agentOn(dir, { impl, leaseTtlMs: 200 })
  const resumed = await b.quickScan.recover()
  assert.deepEqual([...resumed, ...resumed.deferred], [pf.job_id], 'resumed now, or deferred until the old lease expires — never stolen')
  // wait for B's dispatcher (it waits out A's lease first)
  for (let i = 0; i < 400 && !['completed', 'completed_partial'].includes(b.store.read().runs.get(pf.run_id).state); i += 1) await new Promise((r) => setTimeout(r, 10))
  await b.quickScan.idle()
  const run = b.store.read().runs.get(pf.run_id)
  assert.ok(['completed', 'completed_partial'].includes(run.state), run.state)
  const events = b.store.read().events.filter((e) => e.run_id === pf.run_id)
  assert.ok(events.length > eventsAtCrash)
  events.forEach((e, i) => assert.equal(e.seq, i + 1))
  const key = (e) => `${e.task_id}|${e.type}|${e.attempt}`
  const taskScoped = events.filter((e) => e.task_id && /^(task|source|observation)\./.test(e.type))
  assert.equal(new Set(taskScoped.map(key)).size, taskScoped.length, 'no duplicated task-scoped event')
  const interrupted = events.find((e) => e.type === 'task.unavailable' && e.payload.reason === 'interrupted_by_restart')
  assert.ok(interrupted, 'the interrupted read is reported, not hidden')
  assert.ok(events.some((e) => e.type === 'task.started' && e.task_id === interrupted.task_id && e.attempt === 2), 'and re-run as attempt 2')
  assert.equal(events.filter((e) => e.type === 'job.property_state' && ['completed', 'completed_partial'].includes(e.payload.state)).length, 3)
  assert.equal(events.filter((e) => e.type === 'run.completed').length, 1)
})

test('a PAUSED worker that wakes after a takeover is fenced out: its late result is dropped, it claims nothing, the run completes once', async () => {
  const dir = tmp()
  let release
  const gate = new Promise((r) => { release = r })
  const implA = { getEntityGraphDossier: async (kind, id, deps) => { if (id === '9000000001') await gate; return getEntityGraphDossier(kind, id, deps) } }
  const a = agentOn(dir, { impl: implA, leaseTtlMs: 200 })
  const pf = await a.quickScan.preflight({ operator_id: 'op_1', property_ids: IDS })
  const ca = await a.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id: 'op_1' })
  for (let i = 0; i < 400 && !a.store.read().events.some((e) => e.run_id === pf.run_id && e.type === 'task.started' && e.property_id === '9000000001'); i += 1) await new Promise((r) => setTimeout(r, 5))
  a.store.kill() // pause A (GC stall / frozen container): its heartbeats and writes park
  const b = agentOn(dir, { leaseTtlMs: 200 })
  await new Promise((r) => setTimeout(r, 300)) // A's lease expires
  await b.quickScan.recover()
  for (let i = 0; i < 400 && !['completed', 'completed_partial'].includes(b.store.read().runs.get(pf.run_id).state); i += 1) await new Promise((r) => setTimeout(r, 10))
  await b.quickScan.idle()
  const before = b.store.read().events.filter((e) => e.run_id === pf.run_id)
  release()
  a.store.revive() // A wakes up late
  const resA = await ca.done
  assert.ok(['lease_lost', 'completed', 'completed_partial'].includes(resA.state), resA.state) // A only observes the outcome
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(b.store.read().runs.get(pf.run_id).lease_owner, null, 'A never re-leases the finished run')
  const after = b.store.read().events.filter((e) => e.run_id === pf.run_id)
  assert.deepEqual(after.map((e) => e.event_id), before.map((e) => e.event_id), 'A wrote nothing after waking')
  after.forEach((e, i) => assert.equal(e.seq, i + 1))
  assert.equal(after.filter((e) => e.type === 'run.completed').length, 1)
  assert.ok(['completed', 'completed_partial'].includes(b.store.read().runs.get(pf.run_id).state))
})

test('cancel survives a restart: a cancel recorded before the crash is acknowledged by the next process', async () => {
  const dir = tmp()
  const impl = { getEntityGraphDossier: async () => new Promise(() => {}) }
  const a = agentOn(dir, { impl, leaseTtlMs: 100 })
  const pf = await a.quickScan.preflight({ operator_id: 'op_1', property_ids: IDS.slice(0, 1) })
  await a.quickScan.confirm({ job_id: pf.job_id, scope_hash: pf.scope_hash, operator_id: 'op_1' })
  for (let i = 0; i < 200 && !a.store.read().events.some((e) => e.run_id === pf.run_id && e.type === 'task.started'); i += 1) await new Promise((r) => setTimeout(r, 5))
  // record the cancel directly in the store (as if A crashed right after accepting it)
  await a.store.transaction((tx) => {
    const run = tx.runs.get(pf.run_id)
    run.cancel_requested_at = new Date().toISOString()
    appendEventTx(tx, { run_id: pf.run_id, type: 'run.cancel_requested', payload: { requested_by: 'op_1', scope: 'research_job' } })
  })
  const b = agentOn(dir, { leaseTtlMs: 100 })
  await b.quickScan.recover()
  for (let i = 0; i < 300 && b.store.read().runs.get(pf.run_id).state !== 'cancelled'; i += 1) await new Promise((r) => setTimeout(r, 10))
  assert.equal(b.store.read().runs.get(pf.run_id).state, 'cancelled')
  assert.equal(b.store.read().events.filter((e) => e.run_id === pf.run_id && e.type === 'run.cancelled').length, 1)
})

test('file store: atomic + namespaced; live refuses fixture events; production refuses the store', async () => {
  const dir = tmp()
  const live = createFileAgentStore({ dir, namespace: 'live', env: {} })
  assert.ok(fs.existsSync(path.join(dir, 'live', 'state.json')))
  const doc = JSON.parse(fs.readFileSync(live.file, 'utf8'))
  assert.deepEqual([doc.namespace, doc.fixture], ['live', false])
  // a fixtures file copied over the live one is refused
  const fx = createFileAgentStore({ dir, namespace: 'fixtures', env: {} })
  fs.copyFileSync(fx.file, live.file)
  assert.throws(() => createFileAgentStore({ dir, namespace: 'live', env: {} }), (e) => e.code === 'FILE_STORE_NAMESPACE_MISMATCH')
  // a fresh live store refuses fixture events
  const dir2 = tmp()
  const s = createFileAgentStore({ dir: dir2, namespace: 'live', env: {} })
  await s.transaction((tx) => { tx.runs.set('r1', { id: 'r1', state: 'created' }) })
  const log = createEventLog({ store: s, allowFixture: false })
  await assert.rejects(log.append({ run_id: 'r1', type: 'run.state', payload: { from: 'a', to: 'b' }, fixture: true }), (e) => e.code === 'FIXTURE_EVENT_REFUSED')
  // a throwing transaction leaves the file untouched
  const bytes = fs.readFileSync(s.file, 'utf8')
  await assert.rejects(s.transaction((tx) => { tx.runs.set('r2', {}); throw new Error('boom') }))
  assert.equal(fs.readFileSync(s.file, 'utf8'), bytes)
  assert.equal(createFileAgentStore({ dir: dir2, namespace: 'live', env: {} }).read().runs.has('r2'), false)
  assert.throws(() => createFileAgentStore({ dir: dir2, namespace: 'live', env: { NODE_ENV: 'production' } }), (e) => e.code === 'FILE_STORE_REFUSED_IN_PRODUCTION')
  assert.throws(() => createFileAgentStore({ dir: dir2, namespace: 'live', env: { VERCEL_ENV: 'production' } }), (e) => e.code === 'FILE_STORE_REFUSED_IN_PRODUCTION')
})

test('two store instances on one file (Next dev module duplication) see each other\'s commits', async () => {
  const dir = tmp()
  const s1 = createFileAgentStore({ dir, namespace: 'live', env: {} })
  const s2 = createFileAgentStore({ dir, namespace: 'live', env: {} })
  await s1.transaction((tx) => { tx.runs.set('a', { id: 'a', state: 'created' }) })
  assert.ok(s2.read().runs.has('a'))
  await s2.transaction((tx) => { tx.runs.set('b', { id: 'b', state: 'created' }) })
  assert.ok(s1.read().runs.has('a') && s1.read().runs.has('b'))
})
