/**
 * Pipeline ownership: who holds the next action, proven from the queue.
 *
 * Built from the 2026-10-01 production audit. `next_action` is the last
 * turn's intent and nothing clears it after the send, so these lock:
 *   - a reply that went out is not "Automation overdue"
 *   - an answer to an EARLIER message does not count for the current turn
 *   - the machine's failures (never queued, health guard, failed, held) are
 *     named for what they are
 *   - only a real queue row is a machine schedule; a date on the row is not
 *   - S10 needs a closing record; canary fixtures never count as deals
 *   - offers are AUTONOMOUS / SYSTEM RESOLVING / EXCEPTION only where the
 *     engine's authority and re-evaluation support it; dormant is parked
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveOfferAutonomy,
  holdClassOf,
  isConversationSend,
  isSyntheticOpportunity,
  offerPlausibility,
  ownerOfLane,
  resolveQueuedStep,
  sendIsHuman,
  summarizeThreadQueue,
} from '../../src/lib/domain/opportunity/pipeline-ownership.js'
import {
  aggregateStageFlows,
  countOwners,
  deriveLane,
  deriveStall,
  flowBuckets,
  movementBy,
  movementFromHistory,
  stageAging,
  withoutSyntheticOpportunities,
} from '../../src/lib/domain/opportunity/pipeline-command-service.js'

const NOW = Date.parse('2026-10-01T12:00:00Z')
const at = (iso) => new Date(Date.parse(iso)).toISOString()
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString()
const opp = (over = {}) => ({ id: 'o1', acquisition_stage: 'offer_interest', opportunity_status: 'active', last_activity_at: ago(1), stage_entered_at: ago(3), ...over })
const row = (over = {}) => ({ id: Math.random().toString(36).slice(2), queue_status: 'delivered', source: 'auto_reply', use_case_template: 'consider_selling', type: 'auto_reply', ...over })

/* ── the queued step ───────────────────────────────────────────────────── */

test('an autopilot reply delivered after the triggering message is a completed step', () => {
  const step = resolveQueuedStep({ due: '2026-09-30T19:25:22Z', anchor: '2026-09-30T19:25:18Z', rows: [row({ created_at: '2026-09-30T19:25:40Z', delivered_at: '2026-09-30T19:26:29Z' })], now: NOW })
  assert.equal(step.outcome, 'sent')
})

test('the step row is written just before the opportunity — a row seconds before `due` still counts', () => {
  const step = resolveQueuedStep({ due: '2026-09-10T15:21:45Z', anchor: '2026-09-10T15:21:35Z', rows: [row({ queue_status: 'sent', created_at: '2026-09-10T15:21:40Z' })], now: NOW })
  assert.equal(step.outcome, 'sent')
})

test('an answer to an EARLIER message never counts for the current turn (anchor = the triggering inbound)', () => {
  // 2765 NW 27th: ownership_check delivered 18:25, seller replied 18:31:57,
  // turn due 18:31:59, next outbound was the operator 28h later.
  const rows = [
    row({ use_case_template: 'ownership_check', source: null, created_at: '2026-09-08T18:25:00Z' }),
    row({ use_case_template: 'manual_reply', source: 'inbox', created_at: '2026-09-09T22:33:57Z' }),
  ]
  const step = resolveQueuedStep({ due: '2026-09-08T18:31:59Z', anchor: '2026-09-08T18:31:57Z', rows, now: NOW })
  assert.equal(step.outcome, 'sent_by_you')
})

test('a slow turn can queue its reply minutes before it persists `due` — the trigger, not `due`, opens the window', () => {
  // 4729 Lyndale: seller 14:55:05, reply queued 15:06:43 (failed_transport), due persisted 15:13:20
  const slow = resolveQueuedStep({ due: '2026-09-28T15:13:20Z', anchor: '2026-09-28T14:55:05Z', rows: [row({ queue_status: 'failed_transport', created_at: '2026-09-28T15:06:43Z' })], now: NOW })
  assert.equal(slow.outcome, 'failed')
  // 4601 Newton: an answer delivered 12 minutes before the triggering message is not this turn's reply
  const earlier = resolveQueuedStep({ due: '2026-09-28T20:33:29Z', anchor: '2026-09-28T20:33:26Z', rows: [row({ use_case_template: 'asking_price_follow_up', created_at: '2026-09-28T20:21:25Z' })], now: NOW })
  assert.equal(earlier.outcome, 'never_queued')
})

test('machine failures are named: never queued, health guard, transport failure, held for review, stuck', () => {
  const due = '2026-09-28T20:33:29Z'
  const anchor = '2026-09-28T20:33:26Z'
  assert.equal(resolveQueuedStep({ due, anchor, rows: [], now: NOW }).outcome, 'never_queued')
  assert.equal(resolveQueuedStep({ due, anchor, rows: [row({ queue_status: 'blocked_by_health_guard', created_at: '2026-09-28T20:33:40Z' })], now: NOW }).outcome, 'health_guard')
  assert.equal(resolveQueuedStep({ due, anchor, rows: [row({ queue_status: 'failed_transport', created_at: '2026-09-28T20:33:40Z' })], now: NOW }).outcome, 'failed')
  assert.equal(resolveQueuedStep({ due, anchor, rows: [row({ queue_status: 'paused_operator_review', use_case_template: 'justify_price', created_at: '2026-09-28T20:33:40Z' })], now: NOW }).outcome, 'held')
  assert.equal(resolveQueuedStep({ due, anchor, rows: [row({ queue_status: 'queued', created_at: '2026-09-28T20:33:40Z', scheduled_for_utc: '2026-09-28T20:34:40Z' })], now: NOW }).outcome, 'stuck')
  assert.equal(resolveQueuedStep({ due, anchor, rows: [row({ queue_status: 'scheduled', type: 'followup', created_at: '2026-09-28T20:33:40Z', scheduled_for_utc: '2026-10-28T20:33:40Z' })], now: NOW }).outcome, 'scheduled')
})

test('manual replies and inbox bulk follow-ups are an operator’s hand', () => {
  assert.equal(sendIsHuman({ source: 'inbox' }), true)
  assert.equal(sendIsHuman({ source: 'inbox_bulk_follow_up' }), true)
  assert.equal(sendIsHuman({ source: null, use_case_template: 'manual_reply' }), true)
  assert.equal(sendIsHuman({ source: 'auto_reply' }), false)
  assert.equal(sendIsHuman({ source: 'seller_inbound_orchestrator' }), false)
})

/* ── lanes with queue evidence ─────────────────────────────────────────── */

const overdue = (over = {}) => opp({ next_action: 'send_message_now', next_action_due: '2026-09-30T15:18:26Z', last_activity_at: '2026-09-30T15:18:26Z', ...over })

test('a reply that went out is not "Automation overdue" — the ball is with the seller', () => {
  const thread = { latest_direction: 'outbound', last_inbound_at: '2026-09-30T15:18:25Z', last_outbound_at: '2026-09-30T15:30:03Z' }
  const lane = deriveLane(overdue(), { thread, queue: [row({ created_at: '2026-09-30T15:18:50Z', delivered_at: '2026-09-30T15:19:40Z' })], now: NOW })
  assert.equal(lane.key, 'seller')
  assert.match(lane.evidence, /Autopilot reply delivered/)
  assert.equal(ownerOfLane(lane), 'seller')
})

test('an autopilot reply that was never queued is a blocked machine step, not "Needs you"', () => {
  const thread = { latest_direction: 'inbound', last_inbound_at: '2026-09-30T15:18:30Z' }
  const lane = deriveLane(overdue(), { thread, queue: [], now: NOW })
  assert.equal(lane.key, 'blocked')
  assert.equal(lane.cause, 'never_queued')
  assert.equal(holdClassOf(lane), 'send_failure')
  assert.equal(deriveStall(overdue(), lane, { now: NOW }).key, 'automation')
})

test('a drafted reply held for review is the operator’s', () => {
  const lane = deriveLane(overdue(), { thread: { last_inbound_at: '2026-09-30T15:18:20Z' }, queue: [row({ queue_status: 'paused_operator_review', use_case_template: 'justify_price', created_at: '2026-09-30T15:18:40Z' })], now: NOW })
  assert.equal(lane.key, 'operator')
  assert.equal(lane.reason, 'review_draft')
  assert.match(lane.detail, /price justification/)
  assert.equal(ownerOfLane(lane), 'needs_you')
})

test('a draft held for review on a live deal (no overdue step) is still the operator’s until something goes out', () => {
  const thread = { latest_direction: 'outbound', last_outbound_at: '2026-09-10T13:10:20Z' }
  const lane = deriveLane(opp({ last_activity_at: '2026-09-11T14:19:00Z' }), { thread, queue: [row({ queue_status: 'paused_operator_review', source: 'inbox_bulk_follow_up', use_case_template: 'reengagement', created_at: '2026-09-11T14:19:04Z' })], now: NOW })
  assert.equal(lane.key, 'operator')
  assert.equal(lane.reason, 'review_draft')
})

test('only a real queue row is a schedule: a follow-up date on the opportunity is intent nobody executes', () => {
  const noted = opp({ next_action: 'future_seller_followup', next_action_due: '2027-01-01T00:00:00Z', last_activity_at: ago(92) })
  const lane = deriveLane(noted, { thread: { latest_direction: 'outbound', last_outbound_at: ago(92) }, queue: [], now: NOW })
  assert.equal(lane.key, 'dormant')
  assert.match(lane.evidence, /nothing is queued/)
  const scheduled = deriveLane(noted, { thread: { latest_direction: 'outbound', last_outbound_at: ago(92) }, queue: [row({ queue_status: 'scheduled', type: 'followup', use_case_template: 'nurture_not_interested', created_at: ago(1), scheduled_for_utc: ago(-29) })], now: NOW })
  assert.equal(scheduled.key, 'system')
  assert.equal(scheduled.reason, 'scheduled')
  assert.equal(ownerOfLane(scheduled), 'scheduled')
  assert.equal(deriveStall(noted, scheduled, { now: NOW }), null)
})

test('a recovery-sweep review flag is named as such', () => {
  const swept = opp({ next_action: 'human_review', last_updated_source: 'seller_execution_gap_recovery', last_activity_at: ago(2) })
  const lane = deriveLane(swept, { thread: { latest_direction: 'inbound', last_inbound_at: ago(2) }, queue: [], now: NOW })
  assert.equal(lane.key, 'operator')
  assert.match(lane.detail, /recovery sweep/)
  assert.equal(holdClassOf(lane, { updatedSource: 'seller_execution_gap_recovery' }), 'sweep')
})

test('execution-mode holds are send gates, not a decision about the seller', () => {
  const lane = deriveLane(opp(), { execution: { status: 'blocked', reason: 'auto_reply_mode_disabled', created_at: ago(1) }, thread: { latest_direction: 'outbound', last_outbound_at: ago(2) }, queue: [], now: NOW })
  assert.equal(lane.key, 'system')
  assert.equal(lane.reason, 'gated')
  assert.equal(ownerOfLane(lane), 'autopilot')
})

test('a gate that held an earlier turn is history once anyone has written to the seller since', () => {
  const lane = deriveLane(opp(), { execution: { status: 'blocked', reason: 'auto_reply_mode_disabled', created_at: ago(5) }, thread: { latest_direction: 'outbound', last_outbound_at: ago(2) }, queue: [], now: NOW })
  assert.equal(lane.key, 'seller')
})

test('campaign launches and fixture sends are not the deal’s conversation; auto-replies on campaign threads are', () => {
  assert.equal(isConversationSend({ type: 'campaign_launch', source: 'campaign_launch_execution' }), false)
  assert.equal(isConversationSend({ type: 'outbound', source: 'enqueue_campaign_target_one' }), false)
  assert.equal(isConversationSend({ type: 'outbound', source: 'internal_canary' }), false)
  assert.equal(isConversationSend({ type: 'auto_reply', source: 'auto_reply', campaign_id: 'c1' }), true)
})

test('a failed or cancelled attempt is not a touch; a held draft is', () => {
  const failed = summarizeThreadQueue([row({ queue_status: 'failed_transport', created_at: ago(3) })], { now: NOW })
  assert.equal(failed.lastTouchAt, null)
  const held = summarizeThreadQueue([row({ queue_status: 'paused_operator_review', created_at: ago(3) })], { now: NOW })
  assert.equal(held.lastTouchAt, ago(3))
})

test('hostile language and relationship questions are classed, not judged', () => {
  const hostile = deriveLane(opp({ latest_intent: 'hostile_or_legal' }), { execution: { status: 'blocked', reason: 'hostile_or_legal_intent', created_at: ago(1) }, queue: [], now: NOW })
  assert.equal(holdClassOf(hostile, { intent: 'hostile_or_legal' }), 'safety')
  const rel = deriveLane(opp(), { execution: { status: 'blocked', reason: 'property_relationship_review_required', created_at: ago(1) }, queue: [], now: NOW })
  assert.equal(holdClassOf(rel), 'authority')
  const unclear = deriveLane(opp({ latest_intent: 'unclear' }), { execution: { status: 'blocked', reason: 'unclear_low_confidence', created_at: ago(1) }, queue: [], now: NOW })
  assert.equal(holdClassOf(unclear, { intent: 'unclear' }), 'classifier')
})

test('S10 is only reached through a closing record: stage closed without one is closed-lost', () => {
  const lane = deriveLane(opp({ acquisition_stage: 'closed', next_action: 'future_seller_followup_tenant_timing' }), { queue: [], now: NOW })
  assert.equal(lane.key, 'closed_out')
  assert.equal(lane.reason, 'closed_without_closing')
  assert.equal(deriveLane(opp({ acquisition_stage: 'closed' }), { closing: { closing_status: 'closed' }, queue: [], now: NOW }).key, 'complete')
})

test('canary fixtures never count as deals', () => {
  assert.equal(isSyntheticOpportunity({ primary_property_id: 'canaryprop_offerauth_v2_75060' }), true)
  assert.equal(isSyntheticOpportunity({ primary_property_id: 'p1', property_address_full: '0 Internal Canary Way, Irving, TX' }), true)
  assert.equal(isSyntheticOpportunity({ primary_property_id: 'p1', property_address_full: '3622 Humboldt Ave N' }), false)
  // thread-only canary: no property, owner carries the marker
  assert.equal(isSyntheticOpportunity({ primary_property_id: null, master_owner_id: 'mo_canary_v2_3055376631' }), true)
  assert.equal(isSyntheticOpportunity({ primary_property_id: null, master_owner_id: 'canaryowner_offerauth_v2' }), true)
  assert.equal(isSyntheticOpportunity({ primary_property_id: null, master_owner_id: 'mo_8a4ba81354944404ebaa47a6' }), false)
  const [kept, excluded] = withoutSyntheticOpportunities([{ primary_property_id: 'canaryprop_x' }, { primary_property_id: 'p2' }])
  assert.equal(kept.length, 1)
  assert.equal(excluded, 1)
})

test('the thread queue summary finds the next live row and an un-superseded held draft', () => {
  const q = summarizeThreadQueue([
    row({ queue_status: 'paused_operator_review', created_at: '2026-09-11T14:20:07Z', use_case_template: 'safe_clarifier' }),
    row({ queue_status: 'scheduled', type: 'followup', created_at: '2026-09-30T17:43:23Z', scheduled_for_utc: '2026-10-30T17:43:22Z', use_case_template: 'nurture_not_interested' }),
  ], { lastOutboundAt: '2026-09-11T14:00:21Z', now: NOW })
  assert.equal(q.next.future, true)
  assert.equal(q.next.kind, 'follow_up')
  assert.equal(q.held.useCase, 'safe_clarifier')
  const superseded = summarizeThreadQueue([row({ queue_status: 'paused_operator_review', created_at: '2026-09-12T18:56:44Z' })], { lastOutboundAt: '2026-09-23T23:47:17Z', now: NOW })
  assert.equal(superseded.held, null)
})

/* ── offers ────────────────────────────────────────────────────────────── */

const card = (over = {}) => ({ stageIndex: 5, lane: { key: 'seller', label: 'Waiting on seller' }, money: { value: 200000 }, ...over })
const spendable = { spendable: true, tierLabel: 'Range offer authorized', reason: 'valuation_offer_authoritative' }
const unspendable = { spendable: false, tierLabel: 'Creative terms', reason: 'valuation_tier_not_offer_authoritative' }
const eng = (over = {}) => ({ mid: 210000, recommended: 150000, computedAt: ago(2), ...over })

test('AUTONOMOUS only when the engine may spend and the conversation is the machine’s', () => {
  assert.equal(deriveOfferAutonomy({ card: card(), readiness: spendable, engine: eng(), now: NOW }).state, 'autonomous')
  const stuck = deriveOfferAutonomy({ card: card({ lane: { key: 'blocked', label: 'Reply never queued', detail: 'no message was ever queued' } }), readiness: spendable, engine: eng(), now: NOW })
  assert.equal(stuck.state, 'exception')
  assert.equal(stuck.cause, 'conversation_held')
})

test('SYSTEM RESOLVING: still qualifying (S1–S4), or a large gap the autopilot negotiates without a number', () => {
  assert.equal(deriveOfferAutonomy({ card: card({ stageIndex: 4 }), readiness: unspendable, engine: eng(), now: NOW }).state, 'resolving')
  const gap = deriveOfferAutonomy({ card: card(), readiness: unspendable, negotiation: { negotiation_zone: 'large_gap' }, engine: eng(), now: NOW })
  assert.equal(gap.state, 'resolving')
  assert.equal(gap.reprices, 'next_seller_reply')
})

test('EXCEPTION where only a human resolves it', () => {
  const highValue = deriveOfferAutonomy({ card: card({ money: { value: 900000 } }), readiness: unspendable, negotiation: { negotiation_zone: 'large_gap' }, engine: eng({ mid: 900000 }), now: NOW })
  assert.equal(highValue.state, 'exception')
  assert.equal(highValue.cause, 'high_value_gap')
  const moderate = deriveOfferAutonomy({ card: card(), readiness: unspendable, negotiation: { negotiation_zone: 'moderate_gap' }, engine: eng(), now: NOW })
  assert.equal(moderate.cause, 'offer_step_unpriced')
  // a pending hand-off reads through the lane; a superseded one (we wrote since) does not
  const pending = deriveOfferAutonomy({ card: card({ lane: { key: 'operator', label: 'Needs you', detail: 'Review requested by the autopilot' } }), readiness: unspendable, negotiation: { negotiation_zone: 'large_gap', next_action: 'human_review' }, engine: eng(), now: NOW })
  assert.equal(pending.state, 'exception')
  assert.equal(pending.cause, 'negotiation_review')
  const superseded = deriveOfferAutonomy({ card: card({ stageIndex: 2 }), readiness: unspendable, negotiation: { next_action: 'human_review' }, engine: eng(), now: NOW })
  assert.equal(superseded.state, 'resolving')
  // Austin: $173M engine offer on a 1-comp seller-finance valuation
  const absurd = deriveOfferAutonomy({ card: card({ stageIndex: 2, money: { value: 310000 } }), readiness: unspendable, engine: eng({ mid: 300000, recommended: 173028700 }), now: NOW })
  assert.equal(absurd.state, 'exception')
  assert.equal(absurd.cause, 'implausible')
})

test('a dormant deal’s offer is parked — nothing re-prices it — and a stale valuation is stated', () => {
  const parked = deriveOfferAutonomy({ card: card({ lane: { key: 'dormant', label: 'Dormant' } }), readiness: unspendable, engine: eng({ computedAt: ago(80) }), now: NOW })
  assert.equal(parked.state, 'parked')
  assert.equal(parked.reprices, 'none')
  assert.equal(parked.stale, true)
  assert.equal(parked.valuationAgeDays, 80)
})

test('engine numbers far from the recorded value are flagged, not charted', () => {
  assert.equal(offerPlausibility({ engineMid: 300000000, recommended: 200000, recordedValue: 400000 }).engineValueOff, true)
  assert.equal(offerPlausibility({ engineMid: 210000, recommended: 150000, recordedValue: 200000 }).implausible, false)
})

/* ── flow + aggregates ─────────────────────────────────────────────────── */

test('an operator’s move is human; the autopilot’s and sweeps are the machine’s', () => {
  assert.equal(movementBy({ source: 'operator', actor: 'operator' }), 'human')
  assert.equal(movementBy({ source: 'seller_autopilot', actor: 'seller_inbound_orchestrator' }), 'system')
  assert.equal(movementBy({ source: 'seller_execution_gap_recovery', actor: 'gap_recovery_sweep' }), 'system')
})

test('not-interested nurture reads as nurture, not suppression', () => {
  const m = movementFromHistory({ id: 'h', opportunity_id: 'o', event_type: 'opportunity_status_changed', previous_value: 'active', new_value: 'suppressed', reason: 'S1_NOT_INTERESTED_NURTURE_30D', source: 'seller_autopilot', created_at: ago(1) })
  assert.equal(m.title, 'Moved to nurture')
  assert.equal(m.kind, 'exit')
})

test('stage flows: entered / left / created / exited, with system vs human', () => {
  const flows = aggregateStageFlows([
    { kind: 'advance', fromStage: 'offer_interest', toStage: 'property_condition', by: 'system' },
    { kind: 'advance', fromStage: 'asking_price', toStage: 'offer', by: 'human' },
    { kind: 'created', toStage: 'offer_interest', by: 'system' },
    { kind: 'exit', stage: 'offer_interest', by: 'system' },
    { kind: 'reply', stage: 'offer_interest', by: 'seller' },
  ])
  assert.deepEqual([flows.offer_interest.entered, flows.offer_interest.left, flows.offer_interest.created, flows.offer_interest.exited], [1, 2, 1, 1])
  assert.equal(flows.property_condition.entered, 1)
  assert.equal(flows.offer.human, 1)
  assert.equal(flows.asking_price.left, 1)
})

test('period buckets: 24 hourly for a day, one per day otherwise (operator time zone)', () => {
  assert.equal(flowBuckets(1, NOW).keys.length, 24)
  assert.equal(flowBuckets(1, NOW).hourly, true)
  assert.equal(flowBuckets(7, NOW).keys.length, 7)
})

test('aging is judged against the stage clock', () => {
  const a = stageAging([{ daysInStage: 2 }, { daysInStage: 6 }, { daysInStage: 40 }], 'offer') // S5 clock 7d
  assert.deepEqual(a.buckets, { fresh: 1, aging: 1, over: 1 })
  assert.equal(a.median, 6)
  assert.equal(a.overClock, 1)
})

test('owners are counted from the card', () => {
  const c = countOwners([{ owner: 'seller' }, { owner: 'needs_you' }, { owner: 'seller' }, { lane: { key: 'dormant' } }])
  assert.equal(c.seller, 2)
  assert.equal(c.needs_you, 1)
  assert.equal(c.dormant, 1)
})

void at
