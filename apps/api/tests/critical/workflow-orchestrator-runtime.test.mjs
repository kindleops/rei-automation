import test from 'node:test'
import assert from 'node:assert/strict'

import { makeWfDb, ENABLED, ENV_ON } from '../helpers/wf-db-mock.mjs'
import { publishVersion, setWorkflowStatus, tickOrchestrator, startRunsForEvent, deliverEvent, decideApproval, resumeRun, cancelRun, stepRun, scopeFor } from '@/lib/domain/workflow-studio/orchestrator/runtime.js'
import { SELLER_REVIEW_ESCALATION } from '@/lib/domain/workflow-studio/orchestrator/definitions.js'
import { validateGraph } from '@/lib/domain/workflow-studio/orchestrator/graph.js'
import { STATUS, POLICY } from '@/lib/domain/workflow-studio/orchestrator/capabilities.js'

const T0 = '2026-09-29T12:00:00.000Z'
const at = (h) => new Date(Date.parse(T0) + h * 3600_000).toISOString()
const clone = (x) => JSON.parse(JSON.stringify(x))

// Test capabilities: same contracts, recorded invocations, no domain writes.
function caps(behaviour = {}) {
  const calls = []
  const mk = (key, policy = POLICY.AUTO) => ({
    label: key, policy, retry: { max: 3, backoffSeconds: 60 },
    idempotencyKey: (i, ctx) => `wf:${ctx.runId}:${ctx.nodeId}:${key}`,
    availability: () => ({ state: 'AVAILABLE' }),
    async invoke(i, ctx) { calls.push({ key, i, node: ctx.nodeId, run: ctx.runId }); const b = behaviour[key]; return typeof b === 'function' ? b(calls.filter((c) => c.key === key).length) : { status: STATUS.SUCCESS, outputs: { ok: true } } },
  })
  return { calls, capabilities: { 'notify.operator': mk('notify.operator'), 'seller.schedule_follow_up': mk('seller.schedule_follow_up'), 'outbound.send_sms': mk('outbound.send_sms', POLICY.APPROVAL) } }
}

const reviewEvent = (id, thread = '+16125550101', created_at = T0) => ({ id, event_type: 'human_review_requested', subject_type: 'opportunity', subject_id: `opp-${thread}`, payload: { thread_key: thread, property_id: 'p1', master_owner_id: 'mo1' }, created_at })
const replyEvent = (id, thread = '+16125550101', created_at = T0) => ({ id, event_type: 'inbound_reply', subject_type: 'opportunity', subject_id: `opp-${thread}`, payload: { thread_key: thread }, created_at })

async function armed(db, graph = SELLER_REVIEW_ESCALATION, key = graph.key, reentry) {
  const p = await publishVersion(db, { workflow_key: key, name: graph.name, graph: clone(graph), actor: 'ryan', reentry })
  assert.equal(p.ok, true, JSON.stringify(p))
  assert.equal((await setWorkflowStatus(db, key, 'armed', 'ryan')).ok, true)
  return p
}

async function tick(db, now, extra = {}) {
  return tickOrchestrator({ supabase: db, now, env: ENV_ON, worker: 'w1', ...extra })
}

test('the bounded escalation workflow is valid and send-incapable', () => {
  assert.deepEqual(validateGraph(SELLER_REVIEW_ESCALATION).errors, [])
  const caps = SELLER_REVIEW_ESCALATION.nodes.filter((n) => n.kind === 'action').map((n) => n.config.capability)
  assert.deepEqual(caps, ['notify.operator'])
})

test('disabled by default: no flag → no runs, heartbeat still written', async () => {
  const db = makeWfDb({ workflow_events: [reviewEvent('e1')] })
  await armed(db)
  const r = await tickOrchestrator({ supabase: db, now: T0, env: ENV_ON })
  assert.equal(r.skipped, 'disabled')
  assert.equal(db.state.wf_runs.length, 0)
  assert.ok(db.state.system_control.find((x) => x.key === 'workflow_orchestrator_heartbeat_at'))
  // DB flag on but env off is still off.
  const db2 = makeWfDb({ system_control: clone(ENABLED) })
  assert.equal((await tickOrchestrator({ supabase: db2, now: T0, env: {} })).skipped, 'disabled')
})

test('publish is versioned and immutable; invalid graphs never publish; arming needs a version', async () => {
  const db = makeWfDb()
  assert.equal((await setWorkflowStatus(db, 'nope', 'armed', 'ryan')).code, 'workflow_not_found')
  const bad = clone(SELLER_REVIEW_ESCALATION); bad.nodes[1].config.condition = 'vibes'
  const r0 = await publishVersion(db, { workflow_key: 'x_wf', graph: bad, actor: 'ryan' })
  assert.equal(r0.code, 'validation_failed')
  assert.equal(db.state.wf_versions.length, 0)

  const r1 = await publishVersion(db, { workflow_key: 'x_wf', graph: clone(SELLER_REVIEW_ESCALATION), actor: 'ryan' })
  assert.equal(r1.version, 1)
  const same = await publishVersion(db, { workflow_key: 'x_wf', graph: clone(SELLER_REVIEW_ESCALATION), actor: 'ryan' })
  assert.equal(same.unchanged, true)
  const g2 = clone(SELLER_REVIEW_ESCALATION); g2.nodes[0].config.duration_hours = 2
  const r2 = await publishVersion(db, { workflow_key: 'x_wf', graph: g2, actor: 'ryan', note: 'faster' })
  assert.equal(r2.version, 2)
  assert.ok(r2.diff.some((d) => d.text.includes('4 hours → 2 hours')))
  const upd = await db.from('wf_versions').update({ graph: {} }).eq('version', 1)
  assert.equal(upd.error?.message, 'WF_VERSION_IMMUTABLE')
})

test('first tick sets the cursor to NOW — history is never replayed into a new workflow', async () => {
  const db = makeWfDb({ system_control: clone(ENABLED), workflow_events: [reviewEvent('old', '+1', at(-1))] })
  await armed(db)
  const { capabilities } = caps()
  const r = await tick(db, T0, { capabilities })
  assert.equal(r.ingest.first_run, true)
  assert.equal(db.state.wf_runs.length, 0)
})

test('happy path: review requested → wait 4h → still open → one notification → escalated', async () => {
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [reviewEvent('e1')] })
  await armed(db)
  const { calls, capabilities } = caps()
  const facts = { readFacts: async (key) => (key === 'seller.conversation_open' ? { in_needs_review: true } : null) }

  const r1 = await tick(db, T0, { capabilities, ...facts })
  assert.equal(r1.ingest.started, 1)
  const run = db.state.wf_runs[0]
  assert.equal(run.state, 'waiting')
  assert.equal(run.wake_at, at(4))
  assert.equal(run.subject_kind, 'thread_key')
  assert.equal(run.subject_id, '+16125550101')
  assert.equal(run.version, 1)

  await tick(db, at(2), { capabilities, ...facts }) // not due
  assert.equal(calls.length, 0)
  await tick(db, at(4), { capabilities, ...facts })
  assert.equal(run.state, 'completed')
  assert.equal(run.outcome, 'escalated')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].i.entity, { kind: 'seller_thread', id: '+16125550101' })
  assert.deepEqual(db.state.wf_run_steps.map((s) => `${s.node_id}:${s.status}${s.exit ? ':' + s.exit : ''}`), ['grace:waiting', 'still_open:resolved:Open', 'escalate:succeeded'])
  assert.equal(run.lease_owner, null)
})

test('handled in time → no notification; unreadable facts HOLD instead of guessing', async () => {
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [reviewEvent('e1'), reviewEvent('e2', '+16125550102')] })
  await armed(db)
  const { calls, capabilities } = caps()
  const readFacts = async (key, run) => (run.subject_id === '+16125550101' ? { in_needs_review: false, in_new_replies: false } : null)
  await tick(db, T0, { capabilities, readFacts })
  await tick(db, at(4), { capabilities, readFacts })
  const [a, b] = db.state.wf_runs
  assert.equal(a.outcome, 'handled')
  assert.equal(b.state, 'held')
  assert.equal(b.reason, 'facts_unavailable:seller.conversation_open')
  assert.equal(calls.length, 0)
  // Operator resumes once facts are readable again.
  assert.equal((await resumeRun(db, b.id, 'ryan', at(5))).ok, true)
  await tick(db, at(5), { capabilities, readFacts: async () => ({ in_needs_review: true }) })
  assert.equal(b.outcome, 'escalated')
  assert.equal(calls.length, 1)
})

test('double delivery and re-entry: one live run per subject, duplicate events start nothing', async () => {
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [reviewEvent('e1'), reviewEvent('e1'), reviewEvent('e3')] })
  await armed(db)
  const r = await tick(db, T0, caps())
  assert.equal(r.ingest.started, 1)
  assert.equal(db.state.wf_runs.length, 1)
  // Same event re-delivered outside the tick is idempotent too.
  const again = await startRunsForEvent(db, reviewEvent('e1'), { now: T0 })
  assert.equal(again.started.length, 0)
})

test('cursor: events are consumed once across ticks, including same-timestamp events', async () => {
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [reviewEvent('e1', '+1', T0), reviewEvent('e2', '+2', T0)] })
  await armed(db)
  await tick(db, T0, { ...caps(), eventLimit: 1 })
  await tick(db, at(0.1), { ...caps(), eventLimit: 1 })
  await tick(db, at(0.2), { ...caps(), eventLimit: 1 })
  assert.deepEqual(db.state.wf_runs.map((r) => r.subject_id).sort(), ['+1', '+2'])
})

test('a running run keeps its pinned version after a new version is published', async () => {
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [reviewEvent('e1')] })
  await armed(db)
  const { calls, capabilities } = caps()
  await tick(db, T0, { capabilities, readFacts: async () => ({ in_needs_review: true }) })
  const g2 = clone(SELLER_REVIEW_ESCALATION); g2.nodes[0].config.duration_hours = 48
  assert.equal((await publishVersion(db, { workflow_key: g2.key, graph: g2, actor: 'ryan' })).version, 2)
  await tick(db, at(4), { capabilities, readFacts: async () => ({ in_needs_review: true }) })
  assert.equal(db.state.wf_runs[0].version, 1)
  assert.equal(db.state.wf_runs[0].outcome, 'escalated')
  assert.equal(calls.length, 1)
})

const chase = {
  trigger: { type: 'offer_sent' },
  nodes: [
    { id: 'reply', kind: 'wait', config: { mode: 'event', event: 'seller_reply_received', timeout_hours: 24 } },
    { id: 'loop', kind: 'follow_up_loop', config: { action: { capability: 'seller.schedule_follow_up', inputs: { seller: { var: 'trigger' }, intent: 'offer_follow_up' } }, max_attempts: 2, cadence_hours: 48, stop: { event: 'seller_reply_received' } } },
    { id: 'replied', kind: 'terminate', config: { outcome: 'replied' } },
    { id: 'replied_late', kind: 'terminate', config: { outcome: 'replied_during_follow_up' } },
    { id: 'cold', kind: 'terminate', config: { outcome: 'no_response' } },
  ],
  edges: [
    { from: 'trigger', to: 'reply' }, { from: 'reply', exit: 'Event', to: 'replied' }, { from: 'reply', exit: 'Timeout', to: 'loop' },
    { from: 'loop', exit: 'Stopped', to: 'replied_late' }, { from: 'loop', exit: 'Exhausted', to: 'cold' },
  ],
}
const offerEvent = (id, thread = '+16125550101') => ({ id, event_type: 'offer_sent', subject_type: 'opportunity', subject_id: 'opp-1', payload: { thread_key: thread, property_id: 'p1' }, created_at: T0 })

test('event wait resumes exactly once on the reply; a late timeout cannot also fire', async () => {
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [offerEvent('o1')] })
  await armed(db, chase, 'offer_chase')
  const c = caps()
  await tick(db, T0, c)
  const run = db.state.wf_runs[0]
  assert.equal(run.state, 'waiting')
  assert.equal((await deliverEvent(db, replyEvent('r1'), { now: at(3) })).resolved, 1)
  assert.equal((await deliverEvent(db, replyEvent('r1'), { now: at(3) })).resolved, 0) // duplicate delivery
  await tick(db, at(3), c)
  assert.equal(run.outcome, 'replied')
  assert.equal(db.state.wf_waits[0].status, 'resolved')
  assert.equal(c.calls.length, 0)
})

test('follow-up loop: bounded attempts on cadence, stops on reply, exhausts otherwise; idempotent per attempt', async () => {
  // no reply at all → 2 follow-ups then no_response
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [offerEvent('o1')] })
  await armed(db, chase, 'offer_chase')
  const c = caps()
  for (const h of [0, 24, 30, 72, 120]) await tick(db, at(h), c)
  const run = db.state.wf_runs[0]
  assert.equal(run.outcome, 'no_response')
  assert.equal(c.calls.length, 2)
  assert.deepEqual(c.calls.map((x) => x.node), ['loop#1', 'loop#2'])
  assert.equal(c.calls[0].i.seller.thread_key, '+16125550101')

  // reply after the first follow-up → Stopped
  const db2 = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [offerEvent('o1')] })
  await armed(db2, chase, 'offer_chase')
  const c2 = caps()
  await tick(db2, T0, c2)
  await tick(db2, at(24), c2)
  assert.equal(c2.calls.length, 1)
  assert.equal((await deliverEvent(db2, replyEvent('r9'), { now: at(30) })).resolved, 1)
  await tick(db2, at(30), c2)
  assert.equal(db2.state.wf_runs[0].outcome, 'replied_during_follow_up')
  assert.equal(c2.calls.length, 1)
  assert.ok(!db2.state.wf_waits.some((w) => w.status === 'open'))
})

test('retries reuse the same logical action; blocked holds; approval-policy actions need an Approved path', async () => {
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [reviewEvent('e1')] })
  await armed(db)
  const c = caps({ 'notify.operator': (n) => (n < 3 ? { status: STATUS.RETRYABLE, reason: 'timeout' } : { status: STATUS.SUCCESS }) })
  const readFacts = async () => ({ in_needs_review: true })
  await tick(db, T0, { ...c, readFacts })
  await tick(db, at(4), { ...c, readFacts })
  const run = db.state.wf_runs[0]
  assert.equal(run.state, 'waiting')
  assert.match(run.reason, /^retrying:timeout/)
  await tick(db, at(4.1), { ...c, readFacts })
  await tick(db, at(5), { ...c, readFacts })
  assert.equal(run.outcome, 'escalated')
  assert.equal(c.calls.length, 3)
  assert.equal(db.state.wf_run_steps.filter((s) => s.status === 'succeeded').length, 1)

  // Blocked by the domain → held with the reason, never silently skipped.
  const db2 = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [reviewEvent('e1')] })
  await armed(db2)
  const b = caps({ 'notify.operator': () => ({ status: STATUS.BLOCKED, reason: 'rate_limited_by_owner' }) })
  await tick(db2, T0, { ...b, readFacts })
  await tick(db2, at(4), { ...b, readFacts })
  assert.equal(db2.state.wf_runs[0].state, 'held')
  assert.match(db2.state.wf_runs[0].reason, /^blocked:notify.operator/)

  // Runtime refuses an APPROVAL capability on a run that never passed an Approved exit,
  // even if a bad graph slipped past publish validation.
  const db3 = makeWfDb()
  await db3.from('wf_versions').insert({ workflow_key: 'bypass', version: 1, graph: { trigger: { type: 'seller_reply_received' }, nodes: [{ id: 'sms', kind: 'action', config: { capability: 'outbound.send_sms', inputs: {} } }], edges: [{ from: 'trigger', to: 'sms' }] } })
  await db3.from('wf_runs').insert({ id: 'r1', workflow_key: 'bypass', version: 1, subject_kind: 'thread_key', subject_id: '+1', start_key: 'k', state: 'running', context: {} })
  const s = caps()
  const out = await stepRun(db3, db3.state.wf_runs[0], { ...s, now: T0 })
  assert.equal(out.state, 'held')
  assert.equal(out.reason, 'approval_missing:outbound.send_sms')
  assert.equal(s.calls.length, 0)
})

test('approvals: decided exactly once; rejected path never sends; paused workflow does not advance; cancel closes waits', async () => {
  const g = {
    trigger: { type: 'seller_reply_received' },
    nodes: [
      { id: 'ok', kind: 'approval', config: { title: 'Send follow-up SMS?' } },
      { id: 'sms', kind: 'action', config: { capability: 'outbound.send_sms', inputs: { seller: { var: 'trigger' }, template_id: 't1', message_body: 'Hi' } } },
      { id: 'sent', kind: 'terminate', config: { outcome: 'sent' } },
      { id: 'no', kind: 'terminate', config: { outcome: 'rejected' } },
    ],
    edges: [{ from: 'trigger', to: 'ok' }, { from: 'ok', exit: 'Approved', to: 'sms' }, { from: 'ok', exit: 'Rejected', to: 'no' }, { from: 'sms', to: 'sent' }],
  }
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [replyEvent('r1', '+1'), replyEvent('r2', '+2'), replyEvent('r3', '+3')] })
  await armed(db, g, 'approve_sms')
  const c = caps()
  await tick(db, T0, c)
  const [a, b, x] = db.state.wf_runs
  assert.deepEqual([a.state, b.state, x.state], ['awaiting_approval', 'awaiting_approval', 'awaiting_approval'])
  assert.equal((await decideApproval(db, { run_id: a.id, node_id: 'ok', decision: 'Approved', actor: 'ryan', now: at(1) })).ok, true)
  assert.equal((await decideApproval(db, { run_id: a.id, node_id: 'ok', decision: 'Rejected', actor: 'ryan', now: at(1) })).code, 'approval_not_open')
  await decideApproval(db, { run_id: b.id, node_id: 'ok', decision: 'Rejected', actor: 'ryan', now: at(1) })
  await tick(db, at(1), c)
  assert.equal(a.outcome, 'sent')
  assert.equal(b.outcome, 'rejected')
  assert.equal(c.calls.length, 1)

  await setWorkflowStatus(db, 'approve_sms', 'paused', 'ryan')
  await decideApproval(db, { run_id: x.id, node_id: 'ok', decision: 'Approved', actor: 'ryan', now: at(2) })
  await tick(db, at(2), c)
  assert.equal(x.state, 'awaiting_approval')
  assert.equal(c.calls.length, 1)
  assert.equal((await cancelRun(db, x.id, 'ryan', 'not needed', at(3))).ok, true)
  assert.equal(x.state, 'cancelled')
})

test('a lease held by another worker is not stepped; an expired lease is reclaimed', async () => {
  const db = makeWfDb({ system_control: [...clone(ENABLED), { key: 'workflow_orchestrator_cursor', value: JSON.stringify({ at: at(-1), ids: [] }) }], workflow_events: [reviewEvent('e1')] })
  await armed(db)
  const c = caps()
  await tick(db, T0, c)
  const run = db.state.wf_runs[0]
  Object.assign(run, { lease_owner: 'other', lease_until: at(4.5) })
  await tick(db, at(4), { ...c, readFacts: async () => ({ in_needs_review: true }) })
  assert.equal(run.state, 'waiting')
  await tick(db, at(5), { ...c, readFacts: async () => ({ in_needs_review: true }) })
  assert.equal(run.outcome, 'escalated')
})

test('scope comes from canonical identity on the event, never a guessed string', () => {
  assert.deepEqual(scopeFor('seller_needs_review', reviewEvent('e1')), { kind: 'thread_key', id: '+16125550101', scope: { thread_key: '+16125550101', property_id: 'p1', master_owner_id: 'mo1', opportunity_id: 'opp-+16125550101' } })
  assert.equal(scopeFor('seller_needs_review', { id: 'x', event_type: 'human_review_requested', subject_type: 'opportunity', subject_id: 'o', payload: {} }).id, null)
})

test('studio service: migration pending is explicit; actions need the verified operator; bounded workflow publishes by key', async () => {
  const { getOrchestratorState, applyOrchestratorAction, validateAndSimulate, getStudioCatalog } = await import('@/lib/domain/workflow-studio/orchestrator/studio-service.js')
  const missing = { from: () => { const q = { select: () => q, order: () => q, limit: () => q, eq: () => q, in: () => q, then: (r) => Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "wf_workflows" does not exist' } }).then(r) }; return q } }
  const s = await getOrchestratorState({ supabase: missing })
  assert.equal(s.available, false)
  assert.equal(s.reason, 'migration_pending')

  const db = makeWfDb()
  assert.equal((await applyOrchestratorAction('publish', { workflow_key: 'seller_review_escalation' }, { actor: '', supabase: db })).error, 'operator_identity_required')
  const pub = await applyOrchestratorAction('publish', { workflow_key: 'seller_review_escalation' }, { actor: 'op-1', supabase: db })
  assert.equal(pub.ok, true)
  assert.equal(db.state.wf_versions[0].published_by, 'op-1')
  assert.equal((await applyOrchestratorAction('arm', { workflow_key: 'seller_review_escalation' }, { actor: 'op-1', supabase: db })).status, 'armed')
  const st = await getOrchestratorState({ supabase: db })
  assert.equal(st.available, true)
  assert.equal(st.workflows[0].status, 'armed')

  const sim = validateAndSimulate({ graph: SELLER_REVIEW_ESCALATION, scenario: { facts: { still_open: { in_needs_review: true } } } })
  assert.equal(sim.simulation.outcome, 'escalated')
  assert.ok(getStudioCatalog({}).capabilities.find((c) => c.key === 'email.send').availability.state === 'CONFIG_REQUIRED')
})
