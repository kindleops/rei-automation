/**
 * Pipeline command: whose move is it, and is it stuck?
 *
 * The system is automation-first. These lock the promises the Pipeline makes:
 *   - an old review flag the autopilot has since acted past is NOT a task
 *   - untouched inventory is Dormant, never an exception
 *   - an overdue autopilot step IS an exception (the machine stalled)
 *   - stalls are judged against the stage's own clock
 *   - certification / probe history never appears as movement
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveLane,
  deriveStall,
  movementFromHistory,
  isSyntheticHistory,
  DORMANT_DAYS,
} from '../../src/lib/domain/opportunity/pipeline-command-service.js'

const NOW = Date.parse('2026-09-27T12:00:00Z')
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString()
const opp = (over = {}) => ({ id: 'o1', acquisition_stage: 'offer_interest', opportunity_status: 'active', last_activity_at: ago(2), stage_entered_at: ago(3), ...over })

test('a review the autopilot asked for, still pending, is the operator’s', () => {
  const lane = deriveLane(opp({ next_action: 'human_review', last_activity_at: ago(1) }), { thread: { latest_direction: 'inbound', last_inbound_at: ago(1) }, now: NOW })
  assert.equal(lane.key, 'operator')
})

test('a review flag the automation has since messaged past is superseded', () => {
  const lane = deriveLane(opp({ next_action: 'human_review', last_activity_at: ago(20) }), { thread: { latest_direction: 'outbound', last_outbound_at: ago(3) }, now: NOW })
  assert.equal(lane.key, 'seller')
})

test('untouched inventory is Dormant, not an exception', () => {
  const lane = deriveLane(opp({ next_action: 'human_review', last_activity_at: ago(DORMANT_DAYS + 90) }), { now: NOW })
  assert.equal(lane.key, 'dormant')
  assert.equal(deriveStall(opp(), lane, { now: NOW }), null)
})

test('a future scheduled autopilot step keeps an old deal out of Dormant', () => {
  const lane = deriveLane(opp({ next_action: 'schedule_follow_up', next_action_due: ago(-2), last_activity_at: ago(60) }), { now: NOW })
  assert.equal(lane.key, 'system')
})

test('an overdue autopilot step is an exception and a stall', () => {
  const o = opp({ next_action: 'send_message_now', next_action_due: ago(5), last_activity_at: ago(5) })
  const lane = deriveLane(o, { now: NOW })
  assert.equal(lane.key, 'blocked')
  assert.equal(lane.reason, 'automation_overdue')
  assert.equal(deriveStall(o, lane, { now: NOW }).key, 'automation')
})

test('a suppressed thread blocks an active deal', () => {
  const lane = deriveLane(opp(), { thread: { is_suppressed: true }, now: NOW })
  assert.equal(lane.key, 'blocked')
})

test('send gates are the system’s, not the operator’s', () => {
  const lane = deriveLane(opp(), { execution: { status: 'blocked', reason: 'execution_gated', created_at: ago(1) }, thread: { latest_direction: 'outbound', last_outbound_at: ago(2) }, now: NOW })
  assert.equal(lane.key, 'system')
  assert.equal(lane.reason, 'gated')
})

test('seller silence is judged by the stage clock', () => {
  const s5 = opp({ acquisition_stage: 'offer', stage_entered_at: ago(2) })
  const lane = deriveLane(s5, { thread: { latest_direction: 'outbound', last_outbound_at: ago(4) }, now: NOW })
  assert.equal(lane.key, 'seller')
  assert.equal(deriveStall(s5, lane, { thread: { last_outbound_at: ago(4) }, now: NOW }).key, 'seller') // S5 limit 3d
  const s2 = opp({ acquisition_stage: 'offer_interest', stage_entered_at: ago(2) })
  assert.equal(deriveStall(s2, deriveLane(s2, { thread: { latest_direction: 'outbound', last_outbound_at: ago(4) }, now: NOW }), { thread: { last_outbound_at: ago(4) }, now: NOW }), null) // S2 limit 10d
})

test('closed-lost is never shown as a close', () => {
  const lane = deriveLane(opp({ acquisition_stage: 'closed', opportunity_status: 'dead' }), { now: NOW })
  assert.equal(lane.key, 'closed_out')
  const won = deriveLane(opp({ acquisition_stage: 'closed' }), { closing: { closing_status: 'closed' }, now: NOW })
  assert.equal(won.key, 'complete')
})

test('movement: real stage advances read as S→S; certification history is dropped', () => {
  const real = movementFromHistory({ id: 'h1', opportunity_id: 'o1', event_type: 'stage_transition', previous_value: 'property_condition', new_value: 'offer', reason: 'S4_TO_S5_ASKING_PRICE_PROVIDED', source: 'seller_autopilot', created_at: ago(1) })
  assert.equal(real.title, 'S4 → S5')
  assert.equal(real.detail, 'Asking price provided')
  assert.equal(real.kind, 'advance')
  const cert = { event_type: 'stage_transition', previous_value: 'offer_interest', new_value: 'property_condition', reason: 'pipeline_mobile_lock_certification', actor: 'certification', source: 'operator' }
  assert.equal(isSyntheticHistory(cert), true)
  assert.equal(movementFromHistory(cert), null)
  assert.equal(movementFromHistory({ event_type: 'next_action_changed' }), null)
  assert.equal(movementFromHistory({ id: 'h2', opportunity_id: 'o1', event_type: 'asking_price_changed', new_value: '150000', created_at: ago(1) }).detail, '$150K')
})
