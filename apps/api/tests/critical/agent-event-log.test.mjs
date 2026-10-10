// Agent S1 — append-only event stream: ordering, replay cursor, sanitization,
// same-transaction emission, label rule, lifecycle + cooperative cancellation.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createInMemoryAgentStore, AgentError } from '../../src/lib/agent/runtime/store.js'
import { appendEventTx, createEventLog, toSse } from '../../src/lib/agent/runtime/event-log.js'
import { createRunService } from '../../src/lib/agent/runtime/run-service.js'
import { sanitizeEventPayload } from '../../src/lib/agent/runtime/sanitize.js'
import { reduceEvents } from '../../src/lib/agent/contracts/reducer.js'

async function setup() {
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store, activeRunLimit: 100 })
  const log = createEventLog({ store })
  return { store, runs, log }
}

test('event_id is global + monotonic; seq is per-run and gapless across interleaved runs', async () => {
  const { store, runs, log } = await setup()
  const a = await runs.createRun({ kind: 'task', operator_id: 'o' })
  const b = await runs.createRun({ kind: 'conversation', operator_id: 'o' })
  for (let i = 0; i < 20; i += 1) {
    await log.append({ run_id: i % 2 ? a.id : b.id, type: 'decision', payload: { summary: `step ${i}` } })
  }
  const all = store.read().events
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i].event_id > all[i - 1].event_id)
  assert.deepEqual(log.gaps(a.id), [])
  assert.deepEqual(log.gaps(b.id), [])
  assert.equal(all.filter((e) => e.run_id === a.id).pop().seq, 11) // run.created + 10
})

test('concurrent appends are serialized (no duplicate ids, no seq gaps)', async () => {
  const { store, runs, log } = await setup()
  const r = await runs.createRun({ kind: 'task', operator_id: 'o' })
  await Promise.all(Array.from({ length: 50 }, (_, i) => log.append({ run_id: r.id, type: 'decision', payload: { summary: String(i) } })))
  const ids = store.read().events.map((e) => e.event_id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(log.gaps(r.id), [])
})

test('replay after a cursor is exclusive, ordered, run-scoped and hides internal events', async () => {
  const { runs, log } = await setup()
  const r = await runs.createRun({ kind: 'task', operator_id: 'o' })
  const other = await runs.createRun({ kind: 'task', operator_id: 'o' })
  for (let i = 0; i < 5; i += 1) await log.append({ run_id: r.id, type: 'decision', payload: { summary: `s${i}` } })
  await log.append({ run_id: r.id, type: 'decision', payload: { summary: 'hidden' }, visibility: 'internal' })
  await log.append({ run_id: other.id, type: 'decision', payload: { summary: 'other run' } })
  const page1 = log.replay({ run_id: r.id, after: 0, limit: 3 })
  assert.equal(page1.events.length, 3)
  const page2 = log.replay({ run_id: r.id, after: page1.cursor })
  assert.ok(page2.events.every((e) => e.event_id > page1.cursor && e.run_id === r.id))
  assert.ok(!page2.events.some((e) => e.payload.summary === 'hidden'))
  assert.equal(page1.events.length + page2.events.length, 6) // run.created + 5
  // reconnect at the last cursor yields nothing new
  assert.equal(log.replay({ run_id: r.id, after: page2.cursor }).events.length, 0)
})

test('long-poll resolves on the next commit, or returns an empty page at timeout', async () => {
  const { runs, log } = await setup()
  const r = await runs.createRun({ kind: 'task', operator_id: 'o' })
  const cursor = log.replay({ run_id: r.id }).cursor
  const empty = await log.poll({ run_id: r.id, after: cursor, timeout_ms: 30 })
  assert.equal(empty.events.length, 0)
  const pending = log.poll({ run_id: r.id, after: cursor, timeout_ms: 2000 })
  setTimeout(() => log.append({ run_id: r.id, type: 'decision', payload: { summary: 'late' } }), 20)
  const got = await pending
  assert.equal(got.events[0].payload.summary, 'late')
})

test('SSE serialization uses event_id as the Last-Event-ID cursor', async () => {
  const { runs, log } = await setup()
  const r = await runs.createRun({ kind: 'task', operator_id: 'o' })
  const sse = toSse(log.replay({ run_id: r.id }).events)
  assert.match(sse, /^id: \d+\nevent: run\.created\ndata: \{/)
})

test('event + state change commit together; a failed state change leaves no event', async () => {
  const { store, runs } = await setup()
  const r = await runs.createRun({ kind: 'task', operator_id: 'o' })
  const before = store.read().events.length
  await assert.rejects(runs.transition(r.id, 'completed_partial'), (e) => e.code === 'ILLEGAL_RUN_TRANSITION') // created → completed_partial illegal
  assert.equal(store.read().events.length, before)
  await assert.rejects(store.transaction((tx) => {
    appendEventTx(tx, { run_id: r.id, type: 'decision', payload: { summary: 'x' } })
    throw new AgentError('BOOM', 'state write failed')
  }))
  assert.equal(store.read().events.length, before, 'rolled back')
  assert.equal(store.read().counters.event_id, before, 'event_id sequence rolled back too')
})

test('unregistered event types and fixture events are refused by a live log', async () => {
  const { runs, log } = await setup()
  const r = await runs.createRun({ kind: 'task', operator_id: 'o' })
  await assert.rejects(log.append({ run_id: r.id, type: 'thinking.delta', payload: { text: 'hmm' } }), (e) => e.code === 'UNREGISTERED_EVENT_TYPE')
  await assert.rejects(log.append({ run_id: r.id, type: 'decision', payload: { summary: 'x' }, fixture: true }), (e) => e.code === 'FIXTURE_EVENT_REFUSED')
  await assert.rejects(log.append({ run_id: 'nope', type: 'decision', payload: {} }), (e) => e.code === 'EVENT_RUN_UNKNOWN')
})

test('labels are rendered from registered operation templates; free-text labels are refused', async () => {
  const { store, runs, log } = await setup()
  const r = await runs.createRun({ kind: 'research', depth: 'deep', operator_id: 'o' })
  const vars = { jurisdiction: 'Cuyahoga County', finding_label: 'tax delinquency', source_name: 'County tax roll' }
  await log.append({ run_id: r.id, task_id: 't1', type: 'task.started', payload: { operation: 'research.check', source_id: 's' }, label_vars: vars })
  assert.equal(store.read().events.pop().payload.label, 'Checking Cuyahoga County tax delinquency (County tax roll)')
  await assert.rejects(log.append({ run_id: r.id, task_id: 't2', type: 'task.started', payload: { operation: 'research.check', label: 'Hacking the mainframe' }, label_vars: vars }), (e) => e.code === 'EVENT_LABEL_MISMATCH')
  await assert.rejects(log.append({ run_id: r.id, task_id: 't3', type: 'task.started', payload: { operation: 'made.up', label: 'x' } }), (e) => e.code === 'EVENT_LABEL_UNRENDERABLE')
  await assert.rejects(log.append({ run_id: r.id, task_id: 't4', type: 'task.started', payload: { label: 'no op' } }), (e) => e.code === 'EVENT_OPERATION_REQUIRED')
})

test('task-scoped events are idempotent per attempt; a retry emits attempt 2', async () => {
  const { store, runs, log } = await setup()
  const r = await runs.createRun({ kind: 'research', depth: 'deep', operator_id: 'o' })
  const vars = { jurisdiction: 'X', finding_label: 'tax', source_name: 'Y' }
  const a = await log.append({ run_id: r.id, task_id: 't1', type: 'task.started', payload: { operation: 'research.check' }, label_vars: vars })
  const dup = await log.append({ run_id: r.id, task_id: 't1', type: 'task.started', payload: { operation: 'research.check' }, label_vars: vars })
  assert.equal(dup.duplicate, true)
  assert.equal(dup.event.event_id, a.event.event_id)
  const retry = await log.append({ run_id: r.id, task_id: 't1', type: 'task.started', payload: { operation: 'research.check' }, label_vars: vars, attempt: 2 })
  assert.equal(retry.duplicate, false)
  assert.equal(store.read().events.filter((e) => e.type === 'task.started').length, 2)
})

test('sanitizer: whitelist, forbidden keys, phones/emails masked, URLs stripped, summary ≤ 240', () => {
  const { payload, dropped } = sanitizeEventPayload('decision', {
    summary: `Call +1 (612) 555-0199 or mail jane.doe@example.com — see https://user:pw@api.example.com/x?key=SECRET ${'z'.repeat(300)}`,
    thinking: 'private chain of thought',
    basis_refs: [{ api_key: 'sk-123', ok: 'kept', stack: 'Error at …' }],
    injected_field: 'drop me',
  })
  assert.ok(dropped.includes('thinking') && dropped.includes('injected_field'))
  assert.ok(!payload.summary.includes('555-0199') && payload.summary.includes('••0199'))
  assert.ok(!payload.summary.includes('jane.doe'))
  assert.ok(!payload.summary.includes('SECRET') && !payload.summary.includes('pw@'))
  assert.ok(payload.summary.length <= 240)
  assert.deepEqual(payload.basis_refs, [{ ok: 'kept' }])
  assert.equal(sanitizeEventPayload('source.blocked', { message: 'see http://localhost:3000/internal' }).payload.message, 'see [internal]')
})

test('run lifecycle: illegal transitions refused; terminal states are final', async () => {
  const { runs } = await setup()
  const r = await runs.createRun({ kind: 'task', operator_id: 'o' })
  await runs.transition(r.id, 'running')
  await runs.transition(r.id, 'awaiting_approval')
  await runs.transition(r.id, 'running')
  await runs.transition(r.id, 'completed')
  await assert.rejects(runs.transition(r.id, 'running'), (e) => e.code === 'ILLEGAL_RUN_TRANSITION')
  await assert.rejects(runs.createRun({ kind: 'nope', operator_id: 'o' }), (e) => e.code === 'RUN_KIND_INVALID')
  await assert.rejects(runs.createRun({ kind: 'task' }), (e) => e.code === 'OPERATOR_REQUIRED')
})

test('cooperative cancel: idle runs cancel now; executing runs get an abort signal and cancel on acknowledgement', async () => {
  const { store, runs } = await setup()
  const idle = await runs.createRun({ kind: 'task', operator_id: 'o' })
  assert.deepEqual(await runs.requestCancel(idle.id), { state: 'cancelled', pending: false })
  const busy = await runs.createRun({ kind: 'task', operator_id: 'o' })
  await runs.transition(busy.id, 'running')
  await runs.claimLease(busy.id, { owner: 'worker-1' })
  const signal = runs.signalFor(busy.id)
  const res = await runs.requestCancel(busy.id, { requested_by: 'o' })
  assert.deepEqual(res, { state: 'running', pending: true })
  assert.equal(signal.aborted, true)
  const types = () => store.read().events.filter((e) => e.run_id === busy.id).map((e) => e.type)
  assert.ok(types().includes('run.cancel_requested'))
  assert.ok(!types().includes('run.cancelled'), 'never claim cancelled before the worker acknowledges')
  await assert.rejects(runs.claimLease(busy.id, { owner: 'worker-2' }), (e) => e.code === 'RUN_CANCEL_PENDING')
  await runs.acknowledgeCancel(busy.id, { after_cancel_settled_usd: 0.002 })
  assert.equal(runs.getRun(busy.id).state, 'cancelled')
  const ev = store.read().events.filter((e) => e.run_id === busy.id && e.type === 'run.cancelled')[0]
  assert.equal(ev.payload.after_cancel_settled_usd, 0.002)
  assert.deepEqual((await runs.requestCancel(busy.id)).already_terminal, true)
})

test('pause / resume; a cancel-pending run cannot resume; lease sweep after expiry', async () => {
  let t = Date.parse('2026-10-08T15:00:00Z')
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store, now: () => new Date(t) })
  const r = await runs.createRun({ kind: 'task', operator_id: 'o' })
  await runs.transition(r.id, 'running')
  await runs.pause(r.id)
  await runs.resume(r.id)
  await runs.claimLease(r.id, { owner: 'w1', ttl_ms: 1000 })
  await assert.rejects(runs.claimLease(r.id, { owner: 'w2' }), (e) => e.code === 'LEASE_HELD')
  t += 1001
  const swept = await runs.sweepExpiredLeases()
  assert.equal(swept[0].previous_owner, 'w1')
  await runs.claimLease(r.id, { owner: 'w2' })
})

test('reload snapshot carries last_event_id so the client resumes with Last-Event-ID', async () => {
  const { runs, log } = await setup()
  const r = await runs.createRun({ kind: 'task', operator_id: 'o' })
  await runs.transition(r.id, 'running')
  await log.append({ run_id: r.id, type: 'decision', payload: { summary: 'one' } })
  const snap = runs.snapshot(r.id)
  assert.equal(snap.state, 'running')
  const tail = log.replay({ run_id: r.id, after: snap.last_event_id })
  assert.equal(tail.events.length, 0)
  const view = reduceEvents(log.replay({ run_id: r.id }).events)[r.id]
  assert.equal(view.last_event_id, snap.last_event_id)
})

test('org active-run limit (6) applies to non-research runs', async () => {
  const store = createInMemoryAgentStore()
  const runs = createRunService({ store })
  for (let i = 0; i < 6; i += 1) await runs.createRun({ kind: 'task', operator_id: 'o' })
  await assert.rejects(runs.createRun({ kind: 'task', operator_id: 'o' }), (e) => e.code === 'ACTIVE_RUN_LIMIT')
  await runs.createRun({ kind: 'research', depth: 'quick', operator_id: 'o' })
})
