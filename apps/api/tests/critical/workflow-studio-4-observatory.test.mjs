/**
 * Workflow Studio 4.0 — observatory read models (system map, exception queue,
 * analytics definitions, live traversals) and the truth fixes they rely on:
 * PostgREST row cap, test traffic, "queued" only with a queue row, latency
 * measured from the due time, the orchestrator's real heartbeat.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEmailDb } from '../helpers/email-db-mock.mjs'
import { pathOf } from '@/lib/domain/workflow-studio/observatory/core.js'
import { REGISTRY, SYSTEM_ADAPTERS, studioEntry } from '@/lib/domain/workflow-studio/observatory/registry.js'
import { projectSellerRun, matchIngress, sellerAdapter } from '@/lib/domain/workflow-studio/observatory/adapters/seller.js'
import { queueAdapter, isTestRow } from '@/lib/domain/workflow-studio/observatory/adapters/queue.js'
import { campaignAdapter } from '@/lib/domain/workflow-studio/observatory/adapters/campaign.js'
import { inChunksPaged } from '@/lib/domain/workflow-studio/observatory/adapters/shared.js'
import { getRegistry, getLive, listRuns, runtimeHealth, traversalsOf, getRun } from '@/lib/domain/workflow-studio/observatory/service.js'
import { getSystemMap, SYSTEM_MAP_NODES, SYSTEM_MAP_EDGES, SYSTEM_EDGE_KINDS, neighboursOf } from '@/lib/domain/workflow-studio/observatory/system-map.js'
import { getExceptions, EXCEPTION_CATEGORIES } from '@/lib/domain/workflow-studio/observatory/exceptions.js'
import { aggregate, distribution, AUTOMATION_DEFINITION, getAnalytics } from '@/lib/domain/workflow-studio/observatory/analytics.js'

const NOW = Date.parse('2026-10-01T15:00:00Z')
const at = (m) => new Date(NOW + m * 60e3).toISOString()
const TEST_PHONE = '+16127433952'

const SEQ = {
  clear_queued: 'inbound_message_received:succeeded > property_resolved:succeeded > participant_resolved:succeeded > phone_thread_resolved:succeeded > message_classified:succeeded > facts_extracted:succeeded > ownership_confirmed:succeeded > decision_intelligence_evaluated:succeeded > automatic_reply_selected:succeeded > template_rendered:succeeded > contactability_checked:succeeded > duplicate_send_check:succeeded > message_queued:succeeded > message_sent:succeeded > stage_advanced:succeeded > operational_status_changed:succeeded > temperature_changed:succeeded > contactability_changed:succeeded > notification_emitted:succeeded',
  review: 'inbound_message_received:succeeded > property_resolved:succeeded > participant_resolved:succeeded > phone_thread_resolved:succeeded > message_classified:succeeded > facts_extracted:succeeded > decision_intelligence_evaluated:succeeded > contactability_checked:blocked > automation_blocked:blocked > operational_status_changed:succeeded > temperature_changed:succeeded > contactability_changed:succeeded > needs_review_created:needs_review > notification_emitted:succeeded',
}
const steps = (seq, execId, { queue_id = 'q1', minute = 0, block = 'unclear_low_confidence', thread = null } = {}) => seq.split(' > ').map((s, i) => {
  const [action_key, execution_status] = s.split(':')
  return { id: `${execId}-${String(i).padStart(2, '0')}`, execution_id: execId, thread_id: thread, action_key, execution_status, created_at: at(minute + i * 0.001), block_reason: execution_status === 'blocked' ? block : execution_status === 'needs_review' ? 'automation_review' : null, queue_id: action_key === 'message_queued' ? queue_id : null, output_summary: action_key === 'decision_intelligence_evaluated' ? { stage_before: 'ownership_confirmation', stage_after: 'offer_interest' } : {} }
})
const exec = (id, thread, minute, extra = {}) => ({ id, workflow_id: 'seller-inbound-v1', status: 'blocked', thread_id: thread, property_id: 'p1', source_message_id: `m-${id}`, lifecycle_stage: 'offer_interest', started_at: at(minute), completed_at: at(minute + 0.01), ...extra })

const EMPTY = () => ({
  seller_automation_executions: [], seller_automation_execution_steps: [], send_queue: [], v_inbox_thread_state_buckets: [], inbox_thread_state: [], properties: [], message_events: [],
  system_control: [], campaign_runs: [], campaign_events: [], campaigns: [], closing_cases: [], closing_email_requests: [], closing_activity_events: [], wf_workflows: [], wf_versions: [], wf_runs: [], wf_run_steps: [], wf_waits: [], workflow_definitions: [],
  universal_lead_state_events: [], notification_events: [], workflow_events: [], automation_events: [], acquisition_score_snapshots: [], buyer_match_runs: [], sms_suppression_list: [], inbound_processing_ledger: [], email_queue: [],
})

/* ── truth fixes ─────────────────────────────────────────────────────────── */

test('row cap: child rows past PostgREST max-rows are read page by page, never dropped', async () => {
  // a fake PostgREST that caps EVERY response at 1000 rows, like production
  const rows = Array.from({ length: 2600 }, (_, i) => ({ id: `s${String(i).padStart(5, '0')}`, execution_id: `e${i % 120}` }))
  const db = { from: () => { let ids = []; let lo = 0; let hi = 1e9; const q = { select: () => q, in: (_c, v) => { ids = v; return q }, order: () => q, range: (a, b) => { lo = a; hi = b; return q }, then: (res) => { const m = rows.filter((r) => ids.includes(r.execution_id)).sort((a, b) => a.id.localeCompare(b.id)); return Promise.resolve({ data: m.slice(lo, Math.min(hi + 1, lo + 1000)), error: null }).then(res) } }; return q } }
  const got = await inChunksPaged(db, 'seller_automation_execution_steps', 'id, execution_id', 'execution_id', Array.from({ length: 120 }, (_, i) => `e${i}`), [], { chunk: 150 })
  assert.equal(got.length, 2600, 'every step of every execution arrives')
})

test('seller: internal test handsets never count as operations', async () => {
  const s = EMPTY()
  s.seller_automation_executions.push(exec('real', '+15550000001', -30), exec('test', TEST_PHONE, -20))
  s.seller_automation_execution_steps.push(...steps(SEQ.review, 'real'), ...steps(SEQ.review, 'test'))
  const db = makeEmailDb(s)
  const runs = await sellerAdapter.load(db, { since: at(-120), degraded: [] })
  assert.deepEqual(runs.map((r) => r.run.run_id), ['real'])
  const sum = await sellerAdapter.summary(db, { now: NOW, dayStart: at(-600), degraded: [] })
  assert.equal(sum.runs_24h, 1)
})

test('seller: "queued" needs the queue row itself — a ledger queue id with no readable row claims no send', () => {
  const o = projectSellerRun(exec('x', '+15550000001', -10), steps(SEQ.clear_queued, 'x', { queue_id: 'ghost' }), { queue: null })
  const p = pathOf(SYSTEM_ADAPTERS.seller_inbound.topology, o.events)
  assert.equal(p.nodes.dispatch_handoff, undefined, 'never reached dispatch')
  assert.equal(p.nodes.reply_delivered, undefined, 'never delivered')
  assert.equal(p.nodes.queue_reply.status, 'held')
  assert.equal(o.run.status, 'held')
  assert.match(o.run.reason, /could not be read/)
})

test('seller: dispatch latency runs from when the reply was DUE, not from when it was scheduled', () => {
  const queue = { id: 'q1', queue_status: 'delivered', created_at: at(0), scheduled_for_utc: at(60), delivered_at: at(61) }
  const o = projectSellerRun(exec('x', '+15550000001', -1), steps(SEQ.clear_queued, 'x'), { queue })
  assert.equal(o.events.find((e) => e.node_key === 'dispatch_handoff').duration_ms, 60e3)
})

test('seller: real inbound latency comes from the inbound ledger (same conversation, arrival before the run)', () => {
  const ex = exec('x', '+15550000001', 0)
  const rows = [{ thread_key: '+15550000001', received_at: at(-0.2), latency_ms: 8600 }, { thread_key: '+15550000001', received_at: at(-40), latency_ms: 1 }, { thread_key: '+15559999999', received_at: at(-0.1), latency_ms: 2 }]
  assert.equal(matchIngress(ex, rows).latency_ms, 8600)
  assert.equal(matchIngress(ex, [{ thread_key: '+15550000001', received_at: at(3), latency_ms: 5 }]), null, 'arrived after the run started → not its trigger')
  const o = projectSellerRun(ex, steps(SEQ.review, 'x'), { ingress: rows[0] })
  assert.equal(o.run.ingress.latency_ms, 8600)
  assert.match(o.run.ingress.matched_by, /arrival time/)
})

test('queue: proof lanes and internal handsets are test traffic', async () => {
  assert.equal(isTestRow({ source: 'internal_canary' }), true)
  assert.equal(isTestRow({ source: 'auto_reply', thread_key: TEST_PHONE }), true)
  assert.equal(isTestRow({ source: 'campaign_launch_execution', thread_key: '+15550000001' }), false)
  const s = EMPTY()
  s.send_queue.push(
    { id: 'a', queue_status: 'queued', source: 'campaign_launch_execution', thread_key: '+15550000001', created_at: at(-90), scheduled_for_utc: at(-60) },
    { id: 'b', queue_status: 'sending', source: 'auto_reply', thread_key: '+15550000002', created_at: at(-1) },
    { id: 'c', queue_status: 'queued', source: 'internal_canary', thread_key: '+15550000003', created_at: at(-90) },
    { id: 'd', queue_status: 'scheduled', source: 'seller_inbound_orchestrator', thread_key: '+15550000004', created_at: at(-5), scheduled_for_utc: at(600) },
  )
  const c = await queueAdapter.current(makeEmailDb(s), { now: NOW, degraded: [] })
  assert.equal(c.executing, 1, 'only a row being sent is executing')
  assert.equal(c.waiting, 2, 'scheduled rows are healthy waits')
  assert.deepEqual(c.overdue.map((o) => o.run_id), ['a'], 'due an hour ago and unclaimed → overdue; a future follow-up is not')
  assert.ok(!c.live.some((l) => l.run_id === 'c'), 'canary row hidden')
})

test('campaign: a stalled feeder opens its latest REAL pass; test campaigns never surface', async () => {
  const s = EMPTY()
  s.campaigns.push(
    { id: 'c1', name: 'Map area · Dallas', status: 'active', auto_queue_enabled: true, metadata: { feeder_last: { stalled: true, at: at(-1), reason: 'no_row_placed' } } },
    { id: 'c2', name: 'Miami - Test Campaign', status: 'active', auto_queue_enabled: true, metadata: { feeder_last: { stalled: true, at: at(-1) } } },
  )
  s.campaign_runs.push(
    { id: 'p-old', campaign_id: 'c1', run_type: 'launch_queue_plan', status: 'completed', queue_rows_created: 0, ready_to_queue: 40, blocked_counts: { ROUTING_BLOCKED: 30 }, created_at: at(-10) },
    { id: 'p-new', campaign_id: 'c1', run_type: 'launch_queue_plan', status: 'completed', queue_rows_created: 0, ready_to_queue: 42, blocked_counts: { TEMPLATE_RENDER_LINT_FAILURE: 12, ROUTING_BLOCKED: 30 }, created_at: at(-5) },
  )
  const c = await campaignAdapter.current(makeEmailDb(s), { now: NOW, degraded: [] })
  assert.equal(c.needs_you.length, 1)
  assert.equal(c.needs_you[0].run_id, 'p-new')
  assert.equal(c.needs_you[0].category, 'stalled')
  assert.match(c.needs_you[0].reason, /42 sendable targets, none placed · 30 routing blocked · 12 template render lint failure/)
  assert.equal(c.executing, 0, 'a live campaign between passes is not executing')
})

test('registry: the orchestrator heartbeat is read, not assumed; executing and waiting never double-count needs', async () => {
  const wf = { workflow_key: 'seller_review_escalation', name: 'Seller review escalation', status: 'armed', live_version: 1, latest: { version: 1, graph: { trigger: { type: 'seller_needs_review' } } } }
  assert.equal(studioEntry(wf, [], null, { now: NOW, ctl: {} }).heartbeat.state, 'never')
  assert.equal(studioEntry(wf, [], null, { now: NOW, ctl: { workflow_orchestrator_heartbeat_at: at(-60) } }).heartbeat.state, 'stale')
  assert.equal(studioEntry(wf, [], null, { now: NOW, ctl: { workflow_orchestrator_heartbeat_at: at(-3) } }).heartbeat.state, 'current')
  const h = runtimeHealth({ queue_processor_heartbeat_at: at(-9), email_dispatch_heartbeat_at: at(-1), email_enabled: 'false', webhook_live_inbound_last_at: at(-600) }, NOW)
  assert.equal(h.find((x) => x.key === 'queue_runner').state, 'stale')
  assert.equal(h.find((x) => x.key === 'email').switched_off, true)
  assert.equal(h.find((x) => x.key === 'textgrid_inbound').state, 'seen', 'a provider is seen, never "stale"')
  assert.equal(h.find((x) => x.key === 'closing').state, 'never')

  const s = EMPTY()
  s.seller_automation_executions.push(exec('e1', '+15550000011', -30))
  s.seller_automation_execution_steps.push(...steps(SEQ.review, 'e1', { minute: -30 }).map((x) => ({ ...x, thread_id: '+15550000011' })))
  s.v_inbox_thread_state_buckets.push({ thread_key: '+15550000011', in_needs_review: true })
  s.system_control.push({ key: 'queue_processor_heartbeat_at', value: at(-1) })
  const reg = await getRegistry({}, { supabase: makeEmailDb(s), now: () => NOW })
  const seller = reg.workflows.find((w) => w.workflow_key === 'seller_inbound')
  assert.equal(seller.stats.needs_you, 1)
  assert.equal(seller.stats.executing, 0, 'a held review is not an execution')
  assert.equal(reg.telemetry.executing_now, 0)
  assert.ok(Array.isArray(reg.runtimes) && reg.runtimes.length >= 7)
})

/* ── system map ──────────────────────────────────────────────────────────── */

test('system map: only real relationships between declared systems, every system backed by a runtime', () => {
  const keys = new Set(SYSTEM_MAP_NODES.map((n) => n.key))
  for (const e of SYSTEM_MAP_EDGES) {
    assert.ok(keys.has(e.from) && keys.has(e.to), `${e.id} joins declared systems`)
    assert.ok(SYSTEM_EDGE_KINDS.includes(e.kind), `${e.id} kind ${e.kind}`)
    assert.ok(e.evidence, `${e.id} names its evidence`)
    if (!e.measure) assert.ok(e.note, `${e.id} explains why it is not counted`)
  }
  for (const n of SYSTEM_MAP_NODES.filter((x) => x.kind === 'system')) assert.ok(REGISTRY.some((r) => r.workflow_key === n.workflow_key), `${n.key} is a registered runtime`)
  // no edge to things that do not run in production
  for (const dead of ['delivery_retry', 'autopilot', 'inbound_burst_flush']) assert.ok(!SYSTEM_MAP_EDGES.some((e) => e.from === dead || e.to === dead))
  assert.deepEqual(neighboursOf('offer_negotiation').upstream, ['seller_inbound'])
})

test('system map: traffic is counted from each edge’s own evidence; switched-off edges say so', async () => {
  const s = EMPTY()
  s.send_queue.push(
    { id: 'r1', source: 'auto_reply', created_at: at(-60), sent_at: at(-59), delivered_at: at(-58) },
    { id: 'r2', source: 'seller_inbound_orchestrator', created_at: at(-60) },
    { id: 'r3', source: 'campaign_launch_execution', created_at: at(-30), sent_at: at(-29) },
    { id: 'r4', source: 'inbox', created_at: at(-30) },
  )
  s.automation_events.push(
    { id: 'o1', source: 'seller_negotiation_engine', event_type: 'offer_queued', queue_row_id: 'r1', created_at: at(-60) },
    { id: 'o2', source: 'seller_negotiation_engine', event_type: 'offer_queued', queue_row_id: 'missing', created_at: at(-60) },
  )
  s.system_control.push({ key: 'email_enabled', value: 'false' })
  const m = await getSystemMap({ window: '24h' }, { supabase: makeEmailDb(s), now: () => NOW, noCache: true })
  const e = (id) => m.edges.find((x) => x.id === id)
  assert.equal(e('seller__dispatch').traffic.count, 2, 'auto replies + follow-ups, never manual inbox sends')
  assert.equal(e('campaign__dispatch').traffic.count, 1)
  assert.equal(e('negotiation__dispatch').traffic.count, 1, 'an offer counts only when its queue row exists')
  assert.equal(e('dispatch__textgrid').traffic.count, 2)
  assert.equal(e('textgrid__dispatch').traffic.count, 1)
  assert.equal(e('email__brevo').state, 'off')
  assert.equal(e('seller__decision').state, 'unmeasured')
  assert.equal(e('seller__decision').traffic.count, null)
  assert.equal(e('closing__email').state, 'quiet', 'wired, nothing carried')
})

/* ── exception queue ─────────────────────────────────────────────────────── */

test('exceptions: linked to workflow · run · node · subject, grouped by why; transport noise aggregated, a failed reply personal', async () => {
  const s = EMPTY()
  s.seller_automation_executions.push(exec('e1', '+15550000011', -30), exec('e2', '+15550000012', -40, { status: 'succeeded' }))
  s.seller_automation_execution_steps.push(...steps(SEQ.review, 'e1', { minute: -30 }).map((x) => ({ ...x, thread_id: '+15550000011' })), ...steps(SEQ.clear_queued, 'e2', { minute: -40, queue_id: 'fq' }))
  s.v_inbox_thread_state_buckets.push({ thread_key: '+15550000011', in_needs_review: true })
  s.inbox_thread_state.push({ thread_key: '+15550000011', seller_display_name: 'Ana Ruiz', property_id: 'p1' })
  s.send_queue.push(
    { id: 'fq', queue_status: 'failed_transport', failed_reason: 'delivery_failed', source: 'auto_reply', thread_key: '+15550000012', created_at: at(-39), updated_at: at(-38) },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `cf${i}`, queue_status: 'failed_transport', failed_reason: 'delivery_failed', source: 'campaign_launch_execution', campaign_id: 'c9', thread_key: `+1555000010${i}`, created_at: at(-100 - i) })),
  )
  s.system_control.push({ key: 'queue_processor_heartbeat_at', value: at(-20) }, { key: 'email_dispatch_heartbeat_at', value: at(-30) }, { key: 'email_enabled', value: 'false' })
  const x = await getExceptions({ supabase: makeEmailDb(s), now: () => NOW, noCache: true })
  assert.deepEqual(x.categories.map((c) => c.key), EXCEPTION_CATEGORIES.map((c) => c.key))
  const review = x.items.find((i) => i.category === 'human_review' && i.workflow_key === 'seller_inbound')
  assert.equal(review.run_id, 'e1')
  assert.equal(review.node_key, 'human_review')
  assert.deepEqual(review.open, { workflow_key: 'seller_inbound', run_id: 'e1' })
  assert.equal(review.subject.name, 'Ana Ruiz')
  assert.ok(review.actions.some((a) => a.kind === 'open_conversation'))
  const personal = x.items.find((i) => i.category === 'failed' && i.workflow_key === 'seller_inbound')
  assert.equal(personal.run_id, 'e2', 'the failed reply opens the seller run that queued it')
  const agg = x.items.find((i) => i.category === 'failed' && i.workflow_key === 'queue_dispatch')
  assert.equal(agg.count, 5, 'the failed seller reply is listed on its own, never counted twice')
  assert.deepEqual(agg.drill.status, 'failed')
  const degraded = x.items.filter((i) => i.category === 'degraded')
  assert.equal(degraded.length, 1, 'a stale queue heartbeat is degraded; email switched off on purpose is not')
  assert.equal(degraded[0].workflow_key, 'queue_dispatch')
})

test('exceptions: lead-state recovery that parks a conversation where no Inbox bucket shows it is surfaced as a finding', async () => {
  const s = EMPTY()
  s.universal_lead_state_events.push(...['+15550000201', '+15550000202', '+15550000203'].map((t, i) => ({ id: `u${i}`, thread_key: t, source_view: 'seller_execution_gap_recovery', new_value: 'human_review', created_at: at(-600 - i) })))
  s.inbox_thread_state.push({ thread_key: '+15550000201', next_action: 'human_review' }, { thread_key: '+15550000202', next_action: 'human_review' }, { thread_key: '+15550000203', next_action: 'call' })
  s.v_inbox_thread_state_buckets.push({ thread_key: '+15550000202', in_needs_review: true })
  const x = await getExceptions({ supabase: makeEmailDb(s), now: () => NOW, noCache: true })
  const f = x.items.find((i) => i.id === 'lead_state_reconcile:surfaced_not_visible')
  assert.equal(f.count, 1)
  assert.equal(f.finding, true)
})

/* ── analytics ───────────────────────────────────────────────────────────── */

test('analytics: automation rate is defined over finished runs; interventions by reason and node; days and rhythm reconcile', () => {
  const t = SYSTEM_ADAPTERS.seller_inbound.topology
  const runs = [
    projectSellerRun(exec('a', '+15550000001', -100), steps(SEQ.clear_queued, 'a', { minute: -100 }), { queue: { id: 'q1', queue_status: 'delivered', created_at: at(-100), delivered_at: at(-99) } }),
    projectSellerRun(exec('b', '+15550000002', -90), steps(SEQ.review, 'b', { minute: -90 }), { open: true }),
    projectSellerRun(exec('c', '+15550000003', -80), steps(SEQ.clear_queued, 'c', { minute: -80, queue_id: 'q3' }), { queue: { id: 'q3', queue_status: 'scheduled', created_at: at(-80), scheduled_for_utc: at(600) } }),
  ]
  const a = aggregate(t, runs, { period: '24h', now: NOW, timing: 'recorder' })
  assert.equal(a.automation.eligible, 2, 'the waiting run is still in flight — not eligible')
  assert.equal(a.automation.automated, 1)
  assert.equal(a.automation.rate, 0.5)
  assert.equal(a.automation.definition, AUTOMATION_DEFINITION)
  assert.equal(a.intervention.runs, 1)
  assert.equal(a.intervention.by_node[0].node, 'human_review')
  assert.equal(a.days.reduce((n, d) => n + d.runs, 0), 3, 'the heatmap counts every run once')
  assert.equal(a.rhythm.cells.reduce((n, c) => n + c.runs, 0), 3)
  assert.equal(a.dwell.length, 0, 'recorder timings never become dwell')
  const d = distribution([100, 200, 300, 400, 10_000])
  assert.equal(d.samples, 5)
  assert.equal(d.p50, 300)
  assert.equal(d.p95, 10_000)
  assert.equal(d.histogram.reduce((n, b) => n + b.count, 0), 5)
})

test('analytics → runs: a branch cohort and the human cohort reconcile with the ledger', async () => {
  const s = EMPTY()
  s.seller_automation_executions.push(exec('e1', '+15550000011', -30), exec('e2', '+15550000012', -90, { status: 'succeeded' }))
  s.seller_automation_execution_steps.push(...steps(SEQ.review, 'e1', { minute: -30 }), ...steps(SEQ.clear_queued, 'e2', { minute: -90, queue_id: 'q2' }))
  s.send_queue.push({ id: 'q2', queue_status: 'delivered', created_at: at(-90), delivered_at: at(-88), source: 'auto_reply', thread_key: '+15550000012' })
  s.v_inbox_thread_state_buckets.push({ thread_key: '+15550000011', in_needs_review: true })
  const deps = { supabase: makeEmailDb(s), now: () => NOW }
  const a = await getAnalytics({ key: 'seller_inbound', period: '24h' }, deps)
  const contact = a.branches.find((b) => b.node === 'contactable_now')
  for (const exit of contact.exits.filter((x) => x.count)) {
    const r = await listRuns('seller_inbound', { period: '24h', edge: exit.edge }, deps)
    assert.equal(r.counts.all, exit.count, `${exit.label}: the cohort is exactly the runs that took the branch`)
  }
  const human = await listRuns('seller_inbound', { period: '24h', human: true }, deps)
  assert.equal(human.counts.all, a.intervention.runs)
  const run = await getRun('seller_inbound', 'e1', deps)
  assert.equal(run.timing.quality, 'recorder', 'replay is told how far the step times can be trusted')
})

/* ── live ────────────────────────────────────────────────────────────────── */

test('live: one traversal per edge a run crossed after the cursor — none for history', () => {
  const t = SYSTEM_ADAPTERS.seller_inbound.topology
  const o = projectSellerRun(exec('x', '+15550000001', 0), steps(SEQ.review, 'x', { minute: 0 }))
  const all = traversalsOf(t, [o], at(-1))
  assert.ok(all.length >= 8)
  assert.ok(all.every((x) => t.edges.some((e) => e.id === x.edge_id)))
  assert.equal(traversalsOf(t, [o], at(5)).length, 0, 'nothing newer than the cursor → no pulse')
})

test('live: a key reads one runtime', async () => {
  const s = EMPTY()
  s.send_queue.push({ id: 'b', queue_status: 'sending', source: 'auto_reply', thread_key: '+15550000002', created_at: at(-1) })
  const l = await getLive({ key: 'queue_dispatch' }, { supabase: makeEmailDb(s), now: () => NOW })
  assert.ok(l.active.every((a) => a.workflow_key === 'queue_dispatch'))
  assert.ok(Array.isArray(l.traversals))
})
