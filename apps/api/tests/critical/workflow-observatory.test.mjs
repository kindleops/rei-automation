/**
 * Workflow Studio observatory — truth rules (spec §5, §15, §52–56).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEmailDb } from '../helpers/email-db-mock.mjs'
import { SYSTEM_WORKFLOWS, outlineOf } from '@/lib/domain/workflow-studio/system-workflows.js'
import { sendOutcome, sellerRunState, pathOf, getWorkflowOverview, getWorkflowRun, getWorkflowAttention } from '@/lib/domain/workflow-studio/observatory-service.js'

const NOW = Date.parse('2026-09-29T15:00:00Z')
const at = (h) => new Date(NOW + h * 3600e3).toISOString()
const step = (k, st = 'succeeded', extra = {}) => ({ action_key: k, execution_status: st, created_at: at(-1), ...extra })

test('send truth comes from the queue row, never the step label', () => {
  assert.equal(sendOutcome({ queue_status: 'delivered' }).state, 'delivered')
  assert.equal(sendOutcome({ queue_status: 'failed_transport' }).state, 'failed')
  assert.equal(sendOutcome({ queue_status: 'blocked_by_health_guard' }).state, 'held')
  assert.equal(sendOutcome({ queue_status: 'cancelled' }).state, 'superseded')
  // an old-ledger run that "sent" with no queue row is NOT a send
  const legacy = [step('contactability_checked', 'blocked', { block_reason: 'execution_gated' }), step('automation_blocked', 'blocked', { block_reason: 'execution_gated' }), step('message_queued'), step('message_sent')]
  const st = sellerRunState(legacy, null)
  assert.equal(st.state, 'held')
  assert.match(st.reason, /Review-only/)
  const path = pathOf(SYSTEM_WORKFLOWS.seller_inbound, legacy)
  assert.equal(path.queued, undefined, 'no queue row → never queued')
  assert.equal(path.sent, undefined)
})

test('run states: needs review (with the specific reason), failed, waiting, delivered', () => {
  assert.deepEqual(
    sellerRunState([step('contactability_checked', 'blocked', { block_reason: 'unclear_low_confidence' }), step('needs_review_created', 'needs_review', { block_reason: 'automation_review' })]).reason,
    'Low confidence — needs a human read',
  )
  assert.equal(sellerRunState([step('message_queued', 'succeeded', { queue_id: 'q1' })], { queue_status: 'failed_transport' }).state, 'failed')
  assert.equal(sellerRunState([step('message_queued', 'succeeded', { queue_id: 'q1' })], { queue_status: 'scheduled' }).state, 'waiting')
  assert.equal(sellerRunState([step('message_queued', 'succeeded', { queue_id: 'q1' })], { queue_status: 'delivered' }).label, 'Reply delivered')
})

test('outline is deterministic from topology and names the branches as business decisions', () => {
  const o = outlineOf(SYSTEM_WORKFLOWS.seller_inbound)
  assert.equal(o[0].label, 'Seller reply received')
  const contact = o.find((x) => x.id === 'contact')
  assert.deepEqual(contact.branch, ['Clear', 'Blocked'])
  for (const wf of Object.values(SYSTEM_WORKFLOWS)) {
    const ids = new Set(wf.nodes.map((x) => x.id))
    for (const e of wf.edges) { assert.ok(ids.has(e.from), `${wf.key} edge from ${e.from}`); assert.ok(ids.has(e.to), `${wf.key} edge to ${e.to}`) }
  }
})

function seed() {
  const execs = [
    { id: 'x1', workflow_id: 'seller-inbound-v1', status: 'blocked', thread_id: '+1612', property_id: 'p1', lifecycle_stage: 'offer_interest', started_at: at(-2) },
    { id: 'x2', workflow_id: 'seller-inbound-v1', status: 'blocked', thread_id: '+1613', property_id: 'p2', lifecycle_stage: 'ownership_confirmation', started_at: at(-3) },
    { id: 'x3', workflow_id: 'seller-inbound-v1', status: 'succeeded', thread_id: '+1614', property_id: 'p3', lifecycle_stage: 'asking_price', started_at: at(-4) },
  ]
  const s = (id, k, st = 'succeeded', extra = {}) => ({ id: `${id}:${k}`, execution_id: id, action_key: k, execution_status: st, created_at: at(-2), ...extra })
  return {
    seller_automation_executions: execs,
    seller_automation_execution_steps: [
      s('x1', 'inbound_message_received'), s('x1', 'contactability_checked', 'blocked', { block_reason: 'unclear_low_confidence' }), s('x1', 'needs_review_created', 'needs_review', { block_reason: 'automation_review' }),
      s('x2', 'inbound_message_received'), s('x2', 'contactability_checked', 'blocked', { block_reason: 'unclear_low_confidence' }), s('x2', 'needs_review_created', 'needs_review'),
      s('x3', 'inbound_message_received'), s('x3', 'decision_intelligence_evaluated', 'succeeded', { output_summary: { stage_before: 'offer_interest', stage_after: 'asking_price' } }), s('x3', 'message_queued', 'succeeded', { queue_id: 'q9' }),
    ],
    send_queue: [{ id: 'q9', queue_status: 'delivered', sent_at: at(-3.9) }],
    // x1's conversation is still open; x2's was already handled by the operator
    v_inbox_thread_state_buckets: [{ thread_key: '+1612', in_needs_review: true, in_new_replies: false }, { thread_key: '+1613', in_needs_review: false, in_new_replies: false }],
    inbox_thread_state: [{ thread_key: '+1612', seller_display_name: 'David Larson' }],
    properties: [{ property_id: 'p1', property_address_full: '123 Main St' }],
    closing_cases: [], closing_email_requests: [], campaigns: [{ id: 'c1', name: 'MPLS', status: 'active', updated_at: at(-1) }],
    workflow_definitions: [{ id: 'd1', name: 'Test WF2', definition_key: 'test_wf2', status: 'active' }, { id: 'd2', name: 'Offer Follow-Up', definition_key: 'offer_follow_up', status: 'published', is_locked: true }],
    workflow_runs: [{ workflow_definition_id: 'd1', status: 'completed', created_at: at(-10) }],
    system_control: [{ key: 'closing_automation_heartbeat_at', value: at(-0.05) }, { key: 'auto_reply_mode', value: 'live_limited' }],
  }
}

test('overview: needs-you counts only still-open conversations; test workflows are not "live"; no heartbeat = never', async () => {
  const db = makeEmailDb(seed())
  const o = await getWorkflowOverview({ supabase: db, now: () => NOW })
  const seller = o.system.find((w) => w.key === 'seller_inbound')
  assert.equal(seller.live.reviewed_7d, 2)
  assert.equal(seller.live.needs_you, 1, 'handled conversation is history, not attention')
  assert.equal(o.counts.live, 3, 'seller + closing + campaign; Test WF2 excluded')
  assert.equal(o.studio.find((w) => w.key === 'offer_follow_up').status, 'defined')
  assert.equal(o.system.find((w) => w.key === 'email_dispatch').health.state, 'never')
  assert.equal(o.system.find((w) => w.key === 'closing_execution').health.state, 'current')
})

test('run inspector: path, why, send outcome and deep links', async () => {
  const db = makeEmailDb(seed())
  const r = await getWorkflowRun('seller_inbound', 'x3', { supabase: db })
  assert.equal(r.run.state, 'completed')
  assert.equal(r.run.label, 'Reply delivered')
  assert.equal(r.path.sent.status, 'succeeded')
  assert.ok(r.why.some((w) => w.k === 'Seller stage' && /offer interest → asking price/.test(w.v)))
  assert.ok(r.why.some((w) => w.k === 'Send outcome'))
  assert.equal(r.links.conversation, '/inbox?thread=%2B1614')
})

test('attention: one item per open conversation', async () => {
  const db = makeEmailDb(seed())
  const a = await getWorkflowAttention({ supabase: db, now: () => NOW })
  assert.equal(a.items.length, 1)
  assert.equal(a.items[0].subject.name, 'David Larson')
})
