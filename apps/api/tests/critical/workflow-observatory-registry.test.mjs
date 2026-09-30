/**
 * Workflow Studio 3.0 — Observatory registry, topologies and projection.
 *
 * The seller ledger sequences below are REAL production step orders captured
 * 2026-09-30 (seller_automation_execution_steps, grouped by run), with ids,
 * thread keys and names replaced. They pin the registry mapping: every ledger
 * key the runtime writes must land on exactly one topology node, and each run
 * must project to a connected path with no orphans.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEmailDb } from '../helpers/email-db-mock.mjs'
import { validateTopology, pathOf, evidenceIndex, foldTelemetry } from '@/lib/domain/workflow-studio/observatory/core.js'
import { REGISTRY, SYSTEM_ADAPTERS, resolveSystemStatus, notRunningEntries, v2Entries, studioEntry } from '@/lib/domain/workflow-studio/observatory/registry.js'
import { projectSellerRun, sellerAdapter } from '@/lib/domain/workflow-studio/observatory/adapters/seller.js'
import { decidingGate, projectQueueRow } from '@/lib/domain/workflow-studio/observatory/adapters/queue.js'
import { topologyFromGraph, studioRunToObserved } from '@/lib/domain/workflow-studio/observatory/adapters/studio.js'
import { SELLER_REVIEW_ESCALATION } from '@/lib/domain/workflow-studio/orchestrator/definitions.js'
import { getRegistry, getWorkflow, listRuns, getRun, getNeedsYou } from '@/lib/domain/workflow-studio/observatory/service.js'
import { aggregate, resolutionOf } from '@/lib/domain/workflow-studio/observatory/analytics.js'

const NOW = Date.parse('2026-09-30T12:00:00Z')
const at = (m) => new Date(NOW + m * 60e3).toISOString()

// ── real production step orders (2026-09-30) ──────────────────────────────
const REAL = {
  held_follow_up: 'inbound_message_received:succeeded > property_resolved:succeeded > participant_resolved:succeeded > phone_thread_resolved:succeeded > message_classified:succeeded > facts_extracted:succeeded > ownership_inferred:succeeded > decision_intelligence_evaluated:succeeded > automatic_reply_selected:succeeded > template_rendered:succeeded > contactability_checked:blocked > automation_blocked:blocked > follow_up_scheduled:succeeded > stage_advanced:succeeded > operational_status_changed:succeeded > temperature_changed:succeeded > disposition_changed:succeeded > contactability_changed:succeeded > notification_emitted:succeeded',
  review: 'inbound_message_received:succeeded > property_resolved:succeeded > participant_resolved:succeeded > phone_thread_resolved:succeeded > message_classified:succeeded > facts_extracted:succeeded > decision_intelligence_evaluated:succeeded > contactability_checked:blocked > automation_blocked:blocked > operational_status_changed:succeeded > temperature_changed:succeeded > contactability_changed:succeeded > needs_review_created:needs_review > notification_emitted:succeeded',
  held_then_queued: 'inbound_message_received:succeeded > property_resolved:succeeded > participant_resolved:succeeded > phone_thread_resolved:succeeded > message_classified:succeeded > facts_extracted:succeeded > seller_interest_detected:succeeded > asking_price_extracted:succeeded > decision_intelligence_evaluated:succeeded > automatic_reply_selected:succeeded > template_rendered:succeeded > contactability_checked:blocked > automation_blocked:blocked > duplicate_send_check:succeeded > message_queued:succeeded > message_sent:succeeded > stage_advanced:succeeded > operational_status_changed:succeeded > temperature_changed:succeeded > disposition_changed:succeeded > contactability_changed:succeeded > notification_emitted:succeeded',
  clear_queued: 'inbound_message_received:succeeded > property_resolved:succeeded > participant_resolved:succeeded > phone_thread_resolved:succeeded > message_classified:succeeded > facts_extracted:succeeded > ownership_confirmed:succeeded > decision_intelligence_evaluated:succeeded > automatic_reply_selected:succeeded > template_rendered:succeeded > contactability_checked:succeeded > duplicate_send_check:succeeded > message_queued:succeeded > message_sent:succeeded > stage_advanced:succeeded > operational_status_changed:succeeded > temperature_changed:succeeded > contactability_changed:succeeded > notification_emitted:succeeded',
  no_identity: 'inbound_message_received:succeeded > phone_thread_resolved:succeeded > message_classified:succeeded > facts_extracted:succeeded > decision_intelligence_evaluated:succeeded > contactability_checked:blocked > automation_blocked:blocked > operational_status_changed:succeeded > temperature_changed:succeeded > contactability_changed:succeeded > needs_review_created:needs_review > notification_emitted:succeeded',
  ownership_denied: 'inbound_message_received:succeeded > property_resolved:succeeded > participant_resolved:succeeded > phone_thread_resolved:succeeded > message_classified:succeeded > facts_extracted:succeeded > ownership_denied:blocked > decision_intelligence_evaluated:succeeded > contactability_checked:blocked > automation_blocked:blocked > operational_status_changed:succeeded > temperature_changed:succeeded > disposition_changed:succeeded > contactability_changed:succeeded > notification_emitted:succeeded',
}

function stepsOf(seq, execId = 'x1', extra = {}) {
  return seq.split(' > ').map((s, i) => {
    const [action_key, execution_status] = s.split(':')
    return { id: `${execId}-${i}`, execution_id: execId, action_key, execution_status, created_at: at(i * 0.001), block_reason: execution_status === 'blocked' && ['contactability_checked', 'automation_blocked'].includes(action_key) ? extra.block || 'execution_gated' : execution_status === 'needs_review' ? 'automation_review' : null, queue_id: action_key === 'message_queued' ? extra.queue_id || 'q1' : null, output_summary: action_key === 'decision_intelligence_evaluated' ? { stage_before: 'ownership_confirmation', stage_after: 'offer_interest' } : action_key === 'follow_up_scheduled' ? { follow_up_at: at(60 * 24 * 30) } : {} }
  })
}
const EXEC = (id = 'x1') => ({ id, workflow_id: 'seller-inbound-v1', thread_id: '+15550000001', property_id: 'p1', source_message_id: 'm1', started_at: at(0), completed_at: at(1) })

test('every system topology is structurally valid (stable keys, one trigger, reachable, unique evidence)', () => {
  for (const [key, a] of Object.entries(SYSTEM_ADAPTERS)) {
    const v = validateTopology(a.topology)
    assert.ok(v.ok, `${key}: ${v.errors.join(' | ')}`)
    assert.equal(a.topology.workflow_key, key)
    assert.match(a.topology.badge, /read-only topology|SUBWORKFLOW/)
    for (const s of a.topology.stages || []) for (const n of s.nodes) assert.ok(a.topology.nodes.some((x) => x.key === n), `${key} stage ${s.key} → unknown node ${n}`)
  }
  assert.equal(REGISTRY.length, Object.keys(SYSTEM_ADAPTERS).length, 'every registry entry has an adapter')
})

test('registry mapping on real ledger samples: every seller key lands on a node, every path is connected', () => {
  const idx = evidenceIndex(SYSTEM_ADAPTERS.seller_inbound.topology)
  const known = new Set(['message_sent']) // the ledger's own send label — never mapped: send truth is the queue row
  for (const [name, seq] of Object.entries(REAL)) {
    for (const s of seq.split(' > ')) { const k = s.split(':')[0]; assert.ok(idx.has(k) || known.has(k), `${name}: ${k} is unmapped`) }
    const o = projectSellerRun(EXEC(), stepsOf(seq), { queue: seq.includes('message_queued') ? { id: 'q1', queue_status: 'delivered', created_at: at(0.5), delivered_at: at(3) } : null })
    const p = pathOf(SYSTEM_ADAPTERS.seller_inbound.topology, o.events)
    assert.deepEqual(p.orphans, [], `${name}: orphans ${p.orphans.join(',')}`)
    assert.equal(p.order[0], 'reply_received')
  }
})

test('held run is drawn through the hold — never through Opt-out & DNC — and skipped identity steps are bridged, not invented', () => {
  const o = projectSellerRun(EXEC(), stepsOf(REAL.no_identity))
  const p = pathOf(SYSTEM_ADAPTERS.seller_inbound.topology, o.events)
  assert.equal(p.nodes.resolve_property.status, 'skipped')
  assert.equal(p.nodes.resolve_seller.status, 'skipped')
  assert.equal(p.nodes.opt_out_dnc, undefined, 'a hold that is not an opt-out never touches DNC')
  assert.ok(p.edges.includes('policy_hold__schedule_follow_up') || p.edges.some((e) => e.startsWith('policy_hold__')), 'the held path continues from the hold')
  const optOut = projectSellerRun(EXEC(), stepsOf(REAL.ownership_denied, 'x1', { block: 'opt_out' }))
  const q = pathOf(SYSTEM_ADAPTERS.seller_inbound.topology, optOut.events)
  assert.equal(q.nodes.opt_out_dnc.status, 'succeeded', 'an opt-out block routes through the DNC subworkflow')
  assert.deepEqual(q.orphans, [])
})

test('precedence: the queue row owns the send result; the ledger’s "message_sent" never does', () => {
  const steps = stepsOf(REAL.clear_queued)
  const failed = projectSellerRun(EXEC(), steps, { queue: { id: 'q1', queue_status: 'failed_transport', failed_reason: 'delivery_failed', created_at: at(0.5), updated_at: at(2) } })
  assert.equal(failed.run.status, 'failed')
  const pf = pathOf(SYSTEM_ADAPTERS.seller_inbound.topology, failed.events)
  assert.equal(pf.nodes.reply_failed.status, 'failed')
  assert.equal(pf.nodes.reply_delivered, undefined)
  const legacy = projectSellerRun(EXEC(), stepsOf(REAL.held_then_queued).map((s) => ({ ...s, queue_id: null })))
  const pl = pathOf(SYSTEM_ADAPTERS.seller_inbound.topology, legacy.events)
  assert.equal(pl.nodes.queue_reply, undefined, 'a queue step without a queue row never reached the queue')
  assert.equal(legacy.run.status, 'held')
  // review hold: drafted reply parked for approval → needs you only while the conversation is open
  const hold = { id: 'q1', queue_status: 'paused_operator_review', created_at: at(0.5) }
  assert.equal(projectSellerRun(EXEC(), stepsOf(REAL.held_then_queued), { queue: hold, open: true }).run.status, 'needs_you')
  const closed = projectSellerRun(EXEC(), stepsOf(REAL.held_then_queued), { queue: hold, open: false })
  assert.equal(closed.run.status, 'held')
  assert.equal(pathOf(SYSTEM_ADAPTERS.seller_inbound.topology, closed.events).nodes.approval_hold.status, 'human')
  // reviewed-then-closed runs count as a human intervention, not a failure
  const reviewed = projectSellerRun(EXEC(), stepsOf(REAL.review), { open: false })
  assert.equal(reviewed.run.status, 'completed')
  assert.equal(reviewed.run.human, true)
  assert.equal(resolutionOf(reviewed.run), 'human')
})

test('queue dispatch: every production status maps to the gate that decided it', () => {
  const cases = [
    [{ queue_status: 'delivered' }, 'delivery_result', 'delivered'],
    [{ queue_status: 'sent' }, 'provider_accepted', null],
    [{ queue_status: 'failed_transport', failed_reason: 'delivery_failed' }, 'delivery_result', 'carrier_failed'],
    [{ queue_status: 'failed', failed_reason: 'provider_rejected' }, 'provider_dispatch', 'transport_failed'],
    [{ queue_status: 'blocked_by_health_guard', failed_reason: 'blocked_template_id' }, 'health_guard', 'health_hold'],
    [{ queue_status: 'blocked_sender_ineligible' }, 'select_sender', 'sender_ineligible'],
    [{ queue_status: 'paused_name_missing' }, 'name_guard', 'content_hold'],
    [{ queue_status: 'duplicate_blocked' }, 'duplicate_lock', 'content_hold'],
    [{ queue_status: 'paused_operator_review' }, 'row_due', 'review_hold'],
    [{ queue_status: 'cancelled', failed_reason: 'not_interested' }, 'stale_reply_guard', 'withdrawn'],
    [{ queue_status: 'cancelled', failed_reason: 'suppressed_opt_out' }, 'compliance', 'compliance_block'],
    [{ queue_status: 'queued' }, 'row_due', null],
  ]
  for (const [row, gate, terminal] of cases) {
    const [g, , t] = decidingGate(row)
    assert.equal(g, gate, row.queue_status)
    assert.equal(t, terminal, row.queue_status)
    const o = projectQueueRow({ id: `r-${row.queue_status}`, created_at: at(0), sent_at: at(1), delivered_at: row.queue_status === 'delivered' ? at(2) : null, updated_at: at(2), ...row })
    const p = pathOf(SYSTEM_ADAPTERS.queue_dispatch.topology, o.events)
    assert.deepEqual(p.orphans, [], `${row.queue_status}: ${p.orphans}`)
  }
  const d = projectQueueRow({ id: 'r1', queue_status: 'delivered', created_at: at(0), sent_at: at(1), delivered_at: at(3) })
  assert.equal(d.events.find((e) => e.node_key === 'provider_accepted').duration_ms, 60e3, 'queued → sent is measured')
  assert.equal(d.events.find((e) => e.node_key === 'delivery_result').duration_ms, 120e3, 'sent → delivered is measured')
})

test('registry status is resolved from heartbeats and switches, never declared', () => {
  const R = (k) => REGISTRY.find((r) => r.workflow_key === k)
  assert.equal(resolveSystemStatus(R('queue_dispatch'), { ctl: { queue_processor_heartbeat_at: at(-1) }, now: NOW }).status, 'live')
  const stale = resolveSystemStatus(R('queue_dispatch'), { ctl: { queue_processor_heartbeat_at: at(-60) }, now: NOW })
  assert.equal(stale.status, 'not_running')
  assert.equal(stale.group, 'not_running')
  const email = resolveSystemStatus(R('email_dispatch'), { ctl: { email_dispatch_heartbeat_at: at(-1), email_enabled: 'false' }, now: NOW })
  assert.equal(email.status, 'off')
  assert.match(email.status_note, /hard-off/)
  assert.equal(resolveSystemStatus(R('closing_execution'), { ctl: { closing_automation_heartbeat_at: at(-2), closing_automation_enabled: 'false' }, now: NOW }).status, 'paused')
  const closing = resolveSystemStatus(R('closing_execution'), { ctl: { closing_automation_heartbeat_at: at(-2), closing_automation_enabled: 'true' }, now: NOW, current: { in_flight: 0, needs_you: [] } })
  assert.equal(closing.status, 'live')
  assert.match(closing.status_note, /no live closings/)
  assert.equal(resolveSystemStatus(R('seller_inbound'), { now: NOW, stats: { last_run_at: at(-60 * 24 * 9) } }).status, 'idle', 'event-driven with no run in 7 days is idle, not live')
  for (const x of notRunningEntries()) { assert.equal(x.status, 'not_running'); assert.equal(x.supports.live, false) }
})

test('Workflow V2 templates are never live; test fixtures are flagged for hiding', async () => {
  const db = makeEmailDb({ workflow_definitions: [
    { id: 'd1', name: 'Test WF2 timing', definition_key: 'test_wf2_timing', status: 'active', trigger_type: 'lead_entered_workflow' },
    { id: 'd2', name: 'Offer Follow-Up', definition_key: 'system_offer_follow_up', status: 'published', trigger_type: 'trigger.offer_sent' },
  ] })
  const v2 = await v2Entries(db)
  assert.ok(v2.every((w) => w.status === 'not_running' && w.group === 'not_running'))
  assert.equal(v2.find((w) => w.workflow_key === 'v2:test_wf2_timing').test, true)
  assert.equal(v2.find((w) => w.workflow_key === 'v2:system_offer_follow_up').test, false)
  assert.equal(studioEntry({ workflow_key: 'test_x', name: 'Test flow', status: 'armed', live_version: 1 }, []).test, true)
})

test('studio workflow: the pinned graph is the topology and the run path matches wf_run_steps', () => {
  const t = topologyFromGraph('seller_review_escalation', 1, SELLER_REVIEW_ESCALATION)
  const v = validateTopology(t)
  assert.ok(v.ok, v.errors.join(' | '))
  const run = { id: 'r1', workflow_key: 'seller_review_escalation', version: 1, state: 'completed', cursor: 'escalated', outcome: 'escalated', trigger_event_type: 'human_review_requested', started_at: at(0), finished_at: at(240), context: { trigger: { thread_key: '+15550000002' }, event: { at: at(0) } }, subject_kind: 'thread_key', subject_id: '+15550000002' }
  const steps = [
    { id: 1, node_id: 'grace', kind: 'wait', status: 'waiting', at: at(0) },
    { id: 2, node_id: 'grace', kind: 'wait', status: 'resolved', exit: 'Next', at: at(240) },
    { id: 3, node_id: 'still_open', kind: 'condition', status: 'resolved', exit: 'Open', at: at(240) },
    { id: 4, node_id: 'escalate', kind: 'action', status: 'succeeded', capability: 'notify.operator', at: at(240) },
  ]
  const o = studioRunToObserved(run, steps)
  const p = pathOf(t, o.events)
  assert.deepEqual(p.order, ['trigger', 'grace', 'still_open', 'escalate', 'escalated'])
  assert.ok(p.edges.includes('still_open__escalate__Open'))
  assert.equal(o.run.status, 'completed')
})

function seed() {
  const exec = (id, thread, mins) => ({ id, workflow_id: 'seller-inbound-v1', status: 'blocked', thread_id: thread, property_id: 'p1', source_message_id: `m-${id}`, lifecycle_stage: 'offer_interest', started_at: at(mins), completed_at: at(mins + 0.1) })
  return {
    seller_automation_executions: [exec('e1', '+15550000011', -30), exec('e2', '+15550000012', -90)],
    seller_automation_execution_steps: [...stepsOf(REAL.review, 'e1').map((s) => ({ ...s, created_at: at(-30), thread_id: '+15550000011' })), ...stepsOf(REAL.clear_queued, 'e2', { queue_id: 'q2' }).map((s) => ({ ...s, created_at: at(-90) }))],
    send_queue: [{ id: 'q2', queue_status: 'delivered', created_at: at(-90), sent_at: at(-89), delivered_at: at(-88), source: 'auto_reply', thread_key: '+15550000012' }],
    v_inbox_thread_state_buckets: [{ thread_key: '+15550000011', in_needs_review: true, in_new_replies: false }],
    inbox_thread_state: [{ thread_key: '+15550000011', seller_display_name: 'Test Seller One', property_id: 'p1' }],
    properties: [{ property_id: 'p1', property_address_full: '1 Test St' }],
    message_events: [{ id: 'm-e1', intent: 'unclear', confidence: '0.41', emotion: 'neutral', language: 'English' }],
    system_control: [{ key: 'queue_processor_heartbeat_at', value: at(-1) }, { key: 'email_dispatch_heartbeat_at', value: at(-1) }, { key: 'email_enabled', value: 'false' }],
    campaign_runs: [], campaign_events: [], campaigns: [], closing_cases: [], closing_email_requests: [], closing_activity_events: [], wf_workflows: [], wf_versions: [], wf_runs: [], wf_run_steps: [], wf_waits: [], workflow_definitions: [],
    universal_lead_state_events: [], notification_events: [], workflow_events: [], automation_events: [], acquisition_score_snapshots: [], buyer_match_runs: [], sms_suppression_list: [],
  }
}

test('service: registry telemetry, workflow telemetry, runs ledger and run detail read only owners’ facts', async () => {
  const deps = { supabase: makeEmailDb(seed()), now: () => NOW }
  const reg = await getRegistry({}, deps)
  const seller = reg.workflows.find((w) => w.workflow_key === 'seller_inbound')
  assert.equal(seller.status, 'live')
  assert.equal(seller.stats.needs_you, 1, 'only the still-open review needs you')
  assert.ok(reg.telemetry.live_automations >= 2)
  assert.equal(reg.workflows.find((w) => w.workflow_key === 'email_dispatch').status, 'off')

  const wf = await getWorkflow('seller_inbound', { period: '24h' }, deps)
  assert.equal(wf.telemetry.runs.total, 2)
  assert.equal(wf.telemetry.nodes.reply_received.entered, 2)
  assert.equal(wf.telemetry.nodes.human_review.waiting_now, 1, 'pressure = the open review, from the Inbox bucket')
  assert.equal(wf.telemetry.nodes.reply_delivered.entered, 1, 'delivery from the queue row')
  assert.ok(wf.telemetry.edges.queue_reply__dispatch_handoff >= 1)
  assert.ok(wf.telemetry.recent.human_review.length >= 1)

  const runs = await listRuns('seller_inbound', { period: '24h' }, deps)
  assert.equal(runs.counts.needs_you, 1)
  assert.equal((await listRuns('seller_inbound', { period: '24h', node: 'reply_delivered' }, deps)).runs.length, 1, 'drill-down by node')

  const d = await getRun('seller_inbound', 'e1', deps)
  assert.equal(d.run.status, 'needs_you')
  assert.equal(d.path.focus, 'human_review', 'the run opens centred on the node holding it')
  assert.equal(d.why.headline, 'WHY IT NEEDS YOU')
  assert.ok(d.ai.some((x) => /Unclear · 41% confidence/.test(x.v)), 'AI output is structured (intent + confidence), never prose')
  assert.ok(d.decisions.some((x) => x.k === 'Seller stage' && /Ownership confirmation → Offer interest/.test(x.v)))

  const needs = await getNeedsYou(deps)
  assert.equal(needs.items.length, 1)
  assert.equal(needs.items[0].node_key, 'human_review')
  assert.equal(needs.items[0].subject.name, 'Test Seller One')
})

test('analytics: resolution separates human intervention and policy holds from failure; branches carry counts', () => {
  const t = SYSTEM_ADAPTERS.seller_inbound.topology
  const runs = [
    projectSellerRun(EXEC('a'), stepsOf(REAL.clear_queued, 'a'), { queue: { id: 'q1', queue_status: 'delivered', created_at: at(0), delivered_at: at(1) } }),
    projectSellerRun(EXEC('b'), stepsOf(REAL.review, 'b'), { open: true }),
    projectSellerRun(EXEC('c'), stepsOf(REAL.held_follow_up, 'c')),
    projectSellerRun(EXEC('d'), stepsOf(REAL.clear_queued, 'd'), { queue: { id: 'q2', queue_status: 'failed_transport', failed_reason: 'delivery_failed', created_at: at(0) } }),
  ]
  const a = aggregate(t, runs, { period: '24h', now: NOW + 3600e3 })
  assert.equal(a.population.runs, 4)
  assert.equal(a.resolution.system, 1)
  assert.equal(a.resolution.human, 1)
  assert.equal(a.resolution.held, 1)
  assert.equal(a.resolution.failed, 1)
  const contact = a.branches.find((b) => b.node === 'contactable_now')
  assert.ok(contact.exits.find((x) => x.label === 'IF HELD').count >= 2)
  assert.ok(a.hold_reasons.some((r) => r.reason === 'execution_gated'))
  const folded = foldTelemetry(t, runs.map((r) => ({ ...r, path: pathOf(t, r.events) })))
  assert.equal(folded.nodes.reply_received.entered, 4)
})

test('unmapped-event monitor reports ledger keys no node claims', async () => {
  const db = makeEmailDb({ seller_automation_execution_steps: [{ action_key: 'inbound_message_received', created_at: at(-5) }, { action_key: 'brand_new_step', created_at: at(-4) }, { action_key: 'message_sent', created_at: at(-3) }] })
  const u = await sellerAdapter.unmapped(db, { since: at(-60) })
  assert.deepEqual(u, [{ source_key: 'brand_new_step', count: 1 }])
})

test('an open conversation needs a person once — on its latest run, not on every earlier review', async () => {
  const s = seed()
  s.seller_automation_executions.push({ id: 'e0', workflow_id: 'seller-inbound-v1', status: 'blocked', thread_id: '+15550000011', property_id: 'p1', source_message_id: 'm-e0', lifecycle_stage: 'offer_interest', started_at: at(-300), completed_at: at(-299.9) })
  s.seller_automation_execution_steps.push(...stepsOf(REAL.review, 'e0').map((x) => ({ ...x, created_at: at(-300) })))
  const deps = { supabase: makeEmailDb(s), now: () => NOW }
  const runs = await listRuns('seller_inbound', { period: '24h' }, deps)
  assert.equal(runs.counts.needs_you, 1)
  assert.equal(runs.runs.find((r) => r.run_id === 'e0').status, 'completed')
  assert.equal(runs.runs.find((r) => r.run_id === 'e0').human, true)
  assert.equal((await getRun('seller_inbound', 'e0', deps)).run.status, 'completed')
  assert.equal((await getRun('seller_inbound', 'e1', deps)).run.status, 'needs_you')
})
