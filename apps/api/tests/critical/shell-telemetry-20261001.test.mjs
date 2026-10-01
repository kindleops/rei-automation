/**
 * Command rail telemetry — every rail transient must come from a ledger node
 * with runtime evidence; nothing animates from a guess. Also: the operator
 * day boundary and the no-replay rule.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { endOfOperatorDay, getShellTelemetry, mapMovement, mapObservedEvent } from '@/lib/domain/shell/shell-telemetry-service.js'

const ev = (workflow_key, node_key, extra = {}) => ({ event_id: `${workflow_key}:${node_key}`, workflow_key, run_id: 'r1', node_key, event_type: 'node_completed', status: 'succeeded', occurred_at: '2026-10-01T15:00:00.000Z', label: '', source_ref: null, ...extra })

test('seller ledger: reply received types, queued reply resolves, review holds, failure fails', () => {
  assert.equal(mapObservedEvent(ev('seller_inbound', 'reply_received')).transient, 'typing')
  // the ledger's own queue claim proves nothing; the real queue row (dispatch_handoff) does
  assert.equal(mapObservedEvent(ev('seller_inbound', 'queue_reply')), null)
  assert.equal(mapObservedEvent(ev('seller_inbound', 'dispatch_handoff', { label: 'queued · due 2:00 PM' })).transient, 'success')
  assert.equal(mapObservedEvent(ev('seller_inbound', 'dispatch_handoff', { label: 'review hold', source_ref: 'send_queue:review_hold' })), null)
  assert.equal(mapObservedEvent(ev('seller_inbound', 'dispatch_handoff', { event_type: 'node_held', status: 'held' })).transient, 'attention')
  assert.equal(mapObservedEvent(ev('seller_inbound', 'human_review')).transient, 'attention')
  assert.equal(mapObservedEvent(ev('seller_inbound', 'policy_hold')).transient, 'attention')
  assert.equal(mapObservedEvent(ev('seller_inbound', 'reply_failed')).transient, 'failure')
  // ordinary understanding steps never animate the rail
  assert.equal(mapObservedEvent(ev('seller_inbound', 'classify_message')), null)
  assert.equal(mapObservedEvent(ev('seller_inbound', 'reply_received')).app, '/inbox')
})

test('queue: dispatch processes, delivery resolves, transport failure fails — a claim alone proves nothing', () => {
  assert.equal(mapObservedEvent(ev('queue_dispatch', 'provider_dispatch')).transient, 'processing')
  assert.equal(mapObservedEvent(ev('queue_dispatch', 'delivered')).transient, 'success')
  assert.equal(mapObservedEvent(ev('queue_dispatch', 'transport_failed')).transient, 'failure')
  assert.equal(mapObservedEvent(ev('queue_dispatch', 'claim_once')), null)
  assert.equal(mapObservedEvent(ev('queue_dispatch', 'window_defer')), null, 'a deferral is a scheduled retry, not an executing one')
})

test('campaign refill shows the real placed count, never a guessed one', () => {
  const placed = mapObservedEvent(ev('campaign_execution', 'queue_plan', { label: '100 rows scheduled' }))
  assert.equal(placed.transient, 'refill')
  assert.equal(placed.display, '+100')
  assert.equal(mapObservedEvent(ev('campaign_execution', 'queue_plan', { label: 'no row placed' })), null)
  assert.equal(mapObservedEvent(ev('campaign_execution', 'queue_plan', { label: '100 rows scheduled', event_type: 'node_held', status: 'held' })), null)
  assert.equal(mapObservedEvent(ev('campaign_execution', 'stalled')).transient, 'attention')
  assert.equal(mapObservedEvent(ev('campaign_execution', 'campaign_tick')), null, 'a scheduler tick is routine')
})

test('pipeline movement: canonical advances read as S→S; opened deals as +1', () => {
  const adv = mapMovement({ id: 'm1', at: '2026-10-01T15:00:00Z', kind: 'advance', title: 'S2 → S4', fromStage: 'offer_interest', toStage: 'property_condition', seller: 'T. H.' })
  assert.equal(adv.transient, 'stage')
  assert.equal(adv.display, 'S2→S4')
  assert.equal(mapMovement({ id: 'm2', at: '2026-10-01T15:00:00Z', kind: 'created', title: 'Opportunity opened' }).display, '+1')
  assert.equal(mapMovement({ id: 'm3', at: '2026-10-01T15:00:00Z', kind: 'price', title: 'Asking price captured' }), null)
})

test('operator day ends at local midnight in America/Chicago', () => {
  // 2026-10-01 09:00 UTC = 04:00 CDT → day ends 2026-10-02 05:00 UTC
  assert.equal(endOfOperatorDay(Date.parse('2026-10-01T09:00:00Z')).toISOString(), '2026-10-02T05:00:00.000Z')
  // 2026-12-01 18:00 UTC = 12:00 CST → day ends 2026-12-02 06:00 UTC
  assert.equal(endOfOperatorDay(Date.parse('2026-12-01T18:00:00Z')).toISOString(), '2026-12-02T06:00:00.000Z')
})

test('a cold read and a stale cursor return no events (no replay storm)', async () => {
  const empty = { from() { return { select() { return this }, in() { return this }, lt() { return this }, eq() { return this }, is() { return this }, then(r) { return Promise.resolve({ data: [], count: 0, error: null }).then(r) } } } }
  const now = () => Date.parse('2026-10-01T15:00:00Z')
  const cold = await getShellTelemetry({ since: null }, { supabase: empty, now })
  assert.equal(cold.events.length, 0)
  assert.equal(cold.replay_suppressed, false)
  const stale = await getShellTelemetry({ since: '2026-10-01T14:30:00Z' }, { supabase: empty, now })
  assert.equal(stale.events.length, 0)
  assert.equal(stale.replay_suppressed, true)
})

test('pipeline movement uses the canonical S1–S10 order and never announces a bare close as a win', () => {
  const mv = (fromStage, toStage) => mapMovement({ id: `${fromStage}-${toStage}`, at: '2026-10-01T15:00:00.000Z', kind: 'advance', fromStage, toStage, title: 'Stage moved', opportunityId: 'o1' })
  assert.equal(mv('offer', 'formal_contract').display, 'S5→S6')
  assert.equal(mv('disposition', 'under_contract').display, 'S7→S8')
  assert.equal(mv('under_contract', 'prepared_to_close').display, 'S8→S9')
  const closed = mv('offer', 'closed')
  assert.equal(closed.display, 'S5→S10')
  assert.equal(closed.transient, 'stage')
  assert.equal(closed.kind, 'deal_closed_out')
})
