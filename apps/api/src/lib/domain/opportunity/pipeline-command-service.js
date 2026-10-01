/**
 * PIPELINE COMMAND — the lifecycle as the operator needs to read it.
 *
 * Read-only. Nothing here moves a stage, writes a row, or re-derives lifecycle
 * semantics: the stage is `acquisition_stage` as the seller autopilot and the
 * authority registry left it. What this layer adds is the answer to "whose
 * move is it?" — assembled from evidence that already exists:
 *
 *   acquisition_opportunities   stage, next_action (+due), intent, blocker, money
 *   inbox_thread_state          suppression, operational_status, last direction
 *   seller_automation_executions the autopilot's latest verdict + hold reason
 *   closing_cases               contract / title / closing evidence (S6+)
 *   acquisition_opportunity_history  movement (test/certification rows excluded)
 *
 * WAITING-ON LANE (first rule that matches wins; each carries its evidence):
 *   complete  closing evidence says closed/funded/recorded
 *   blocked   thread suppressed · contact blocked · opt-out / wrong number ·
 *             blocker set · autopilot action overdue
 *   operator  human review requested · autopilot held for review · seller
 *             replied with no next step
 *   external  S6+ with contract/title/buyer work outstanding
 *   system    autopilot has a scheduled next action, or sends are gated
 *   seller    we spoke last / waiting on seller
 *   dormant   active on paper, untouched ≥ DORMANT_DAYS, nothing scheduled
 *
 * STALLED is judged against STAGE CONTEXT, never one global clock — see
 * STAGE_MAX_DAYS / SELLER_SILENCE_DAYS. The thresholds ship in the payload so
 * the UI can state them.
 *
 * S10: `acquisition_stage='closed'` in production is overwhelmingly closed-LOST
 * (347 dead, 127 suppressed). A closing is only "Closed" with closing evidence;
 * dead/suppressed terminal rows are reported as "closed out", never as won —
 * and so is an "active" row parked at stage closed with no closing record.
 *
 * QUEUE EVIDENCE (2026-10-01 audit). `next_action` is the last turn's intent and
 * nothing clears it after the send; nothing executes from `next_action_due`.
 * So "the machine owns it" and "the machine failed" are proven from the
 * thread's own send_queue rows (see pipeline-ownership.js), never from the
 * intent: 10 of 16 "Automation overdue" deals had in fact been answered.
 */
import { latestRunCandidates } from '@/lib/domain/buyer-match/buyer-identity-rules.js'
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { applyFilters, normalizeOpportunityRow } from './opportunity-service.js'
import { batchHydrateOpportunityProperties } from './opportunity-property-hydration.js'
import { UNIVERSAL_STAGE_ORDER, UNIVERSAL_STAGE_LABELS } from './universal-pipeline-registry.js'
import { NON_SPENDABLE_REASONS, resolveValuationSpendability } from '../seller-flow/valuation-offer-authority.js'
import {
  AUTONOMY_ORDER,
  OWNER_ORDER,
  SEND_HELD,
  SEND_IN_FLIGHT,
  STEP_GRACE_MS,
  deriveOfferAutonomy,
  holdClassOf,
  isConversationSend,
  isSyntheticOpportunity,
  offerPlausibility,
  ownerOfLane,
  resolveQueuedStep,
  summarizeThreadQueue,
  useCaseLabel,
} from './pipeline-ownership.js'

const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const DAY = 86_400_000
const HOUR = 3_600_000
const SCOPE_CAP = 5000
const CHUNK = 150

export const STAGE_INDEX = Object.freeze(Object.fromEntries(UNIVERSAL_STAGE_ORDER.map((code, i) => [code, i + 1])))

/** Presentation groups over the canonical stages (never collapsed server-side). */
export const STAGE_GROUPS = Object.freeze([
  { key: 'discovery', label: 'Discovery', stages: ['ownership_confirmation', 'offer_interest'] },
  { key: 'qualification', label: 'Qualification', stages: ['asking_price', 'property_condition'] },
  { key: 'negotiation', label: 'Negotiation', stages: ['offer'] },
  { key: 'contracting', label: 'Contracting', stages: ['formal_contract'] },
  { key: 'disposition', label: 'Disposition', stages: ['disposition'] },
  { key: 'closing', label: 'Closing', stages: ['under_contract', 'prepared_to_close'] },
  { key: 'complete', label: 'Closed', stages: ['closed'] },
])
const GROUP_OF = Object.fromEntries(STAGE_GROUPS.flatMap((g) => g.stages.map((s) => [s, g.key])))

/** Days in stage beyond which a deal is stalled, by stage. */
export const STAGE_MAX_DAYS = Object.freeze({
  ownership_confirmation: 14, offer_interest: 21, asking_price: 10, property_condition: 10,
  offer: 7, formal_contract: 5, disposition: 14, under_contract: 30, prepared_to_close: 10,
})
/** Days of seller silence (after our last message) that count as stalled, by stage. */
export const SELLER_SILENCE_DAYS = Object.freeze({
  ownership_confirmation: 10, offer_interest: 10, asking_price: 5, property_condition: 5,
  offer: 3, formal_contract: 2, disposition: 5, under_contract: 5, prepared_to_close: 3,
})
const OPERATOR_WAIT_HOURS = 24
/**
 * DORMANT: marked active, but nothing has happened in this many days and no
 * future automation step is scheduled. In production this is the pre-autopilot
 * backfill (235 of 264 "active" rows untouched for 90+ days). It is not an
 * exception and not a task — it is inventory the machine is not working.
 */
export const DORMANT_DAYS = 30
const SYSTEM_OVERDUE_HOURS = 2

const SYSTEM_ACTIONS = new Set(['send_message_now', 'schedule_follow_up', 'future_seller_followup', 'future_seller_followup_tenant_timing'])
/** Execution-mode holds are send gates (configuration), not a decision about this seller. */
const SYSTEM_GATE_REASONS = new Set(['execution_gated', 'auto_reply_mode_disabled', 'review_only', 'shadow', 'disabled', 'live_limited'])
const HOLD_REASON_LABEL = {
  execution_gated: 'Held by send gates',
  auto_reply_mode_disabled: 'Held — auto replies are off',
  review_only: 'Held — autopilot is in review-only mode',
  shadow: 'Held — autopilot is in shadow mode',
  disabled: 'Held — autopilot is disabled',
  live_limited: 'Held — outside the live-limited scope',
  unclear_low_confidence: 'Reply unclear — autopilot held',
  hostile_or_legal_intent: 'Hostile / legal language',
  opt_out_intent_no_marketing: 'Seller opted out',
  missing_context: 'Missing context — needs review',
  property_relationship_review_required: 'Property relationship needs review',
}
const INTENT_LABEL = {
  asking_price_provided: 'Asking price provided',
  asks_offer: 'Seller asked for an offer',
  ownership_confirmed: 'Ownership confirmed',
  unclear: 'Reply unclear',
  opt_out: 'Opted out',
  hostile_or_legal: 'Hostile / legal',
  wrong_number: 'Wrong number',
  callback_requested: 'Asked for a call',
  need_time: 'Needs time',
  tenant_occupied: 'Tenant occupied',
  tenant_respondent: 'Tenant replied',
  executor_heir_respondent: 'Executor / heir replied',
}
const SELLER_WAIT_LABEL = {
  ownership_confirmation: 'Waiting for ownership confirmation',
  offer_interest: 'Waiting on seller interest',
  asking_price: 'Waiting for asking price',
  property_condition: 'Waiting for condition details',
  offer: 'Offer out — waiting on seller',
  formal_contract: 'Agreement out — waiting on signature',
  disposition: 'Waiting on buyer response',
  under_contract: 'Waiting on buyer commitment',
  prepared_to_close: 'Waiting on closing',
}

/** History rows that are tests, probes or certification — never shown as movement. */
export function isSyntheticHistory(row) {
  const actor = clean(row?.actor).toLowerCase()
  const reason = clean(row?.reason).toLowerCase()
  if (/cert|probe|fixture|qa_|test/.test(actor)) return true
  if (/(certification|probe|fixture|restore test|regression)/.test(reason)) return true
  return false
}

const stageShort = (code) => (STAGE_INDEX[code] ? `S${STAGE_INDEX[code]}` : null)

function reasonLabel(reason) {
  const r = clean(reason)
  if (!r || r === 'None') return null
  const m = /^S\d+_(?:TO_S\d+|HOLD)_(.+)$/.exec(r)
  const tail = (m ? m[1] : r).toLowerCase().replace(/_/g, ' ')
  return tail.charAt(0).toUpperCase() + tail.slice(1)
}

async function inChunks(ids, fn) {
  const out = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK)
    if (part.length) out.push(...((await fn(part)) || []))
  }
  return out
}

/**
 * Whose move is it? Pure — every input is evidence already on the row.
 * Exported for tests.
 *
 * `queue` is the thread's non-campaign send_queue rows. When it is given
 * (every production read), "the machine owns it" needs a live or scheduled
 * row and "the machine failed" needs the turn's step to have gone nowhere;
 * when it is absent (legacy callers), the stated intent is read as before.
 */
export function deriveLane(opp, { thread = null, execution = null, closing = null, queue = null, trigger = null, now = Date.now() } = {}) {
  const stage = opp.acquisition_stage
  const idx = STAGE_INDEX[stage] ?? 0
  const status = clean(opp.opportunity_status).toLowerCase()
  const next = clean(opp.next_action).toLowerCase()
  const intent = clean(opp.latest_intent).toLowerCase()
  const due = opp.next_action_due ? Date.parse(opp.next_action_due) : null
  const execReason = clean(execution?.reason)
  const lastInbound = thread?.last_inbound_at ? Date.parse(thread.last_inbound_at) : null
  const lastOutbound = thread?.last_outbound_at ? Date.parse(thread.last_outbound_at) : null
  const latestDirection = clean(thread?.latest_direction).toLowerCase()
  const closingStatus = clean(closing?.closing_status).toLowerCase()
  const rows = Array.isArray(queue) ? queue : null
  const q = rows ? summarizeThreadQueue(rows, { lastOutboundAt: thread?.last_outbound_at || null, now }) : null
  const noun = next === 'send_message_now' ? 'reply' : 'follow-up'
  const Noun = noun === 'reply' ? 'Reply' : 'Follow-up'

  if (['closed', 'funded', 'recorded'].includes(closingStatus) || closing?.revenue_confirmed_date) {
    return { key: 'complete', label: 'Closed', detail: 'Closing recorded', since: closing?.revenue_confirmed_date || closing?.updated_at || null }
  }
  if (['dead', 'suppressed', 'lost', 'archived'].includes(status)) {
    return { key: 'closed_out', label: status === 'suppressed' ? 'Suppressed' : 'Closed out', detail: INTENT_LABEL[intent] || null, since: opp.last_activity_at }
  }
  // S10 is reached only through the closing finalize path. A row parked at
  // stage "closed" without a closing record is closed-lost, whatever its status.
  if (stage === 'closed') {
    return { key: 'closed_out', label: 'Closed (lost)', detail: 'Stage is Closed with no closing record', since: opp.last_activity_at, reason: 'closed_without_closing' }
  }
  const lastTouch = Math.max(
    opp.last_activity_at ? Date.parse(opp.last_activity_at) : 0,
    lastInbound || 0,
    lastOutbound || 0,
    execution?.created_at ? Date.parse(execution.created_at) : 0,
    q?.lastTouchAt ? Date.parse(q.lastTouchAt) : 0,
  )
  // Only a real queue row is a machine schedule; a date on the opportunity is
  // intent nobody executes. Legacy callers (no queue evidence) read the intent.
  const scheduledAhead = rows ? Boolean(q?.next?.future) : Boolean(SYSTEM_ACTIONS.has(next) && due && due > now)
  const notedFollowUp = rows && !q?.next && SYSTEM_ACTIONS.has(next) && next !== 'send_message_now' && due && due > now
    ? `Follow-up noted for ${new Date(due).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: /T00:00:00(\.0+)?(Z|\+00:00?)$/.test(String(opp.next_action_due)) || new Date(due).toISOString().endsWith('T00:00:00.000Z') ? 'UTC' : 'America/Chicago' })} — nothing is queued to send it`
    : null
  if (!scheduledAhead && idx < 6 && lastTouch && now - lastTouch > DORMANT_DAYS * DAY) {
    const days = Math.floor((now - lastTouch) / DAY)
    return {
      key: 'dormant',
      label: 'Dormant',
      detail: next === 'human_review' ? `Untouched ${days}d · last flagged for review` : `Untouched ${days}d · not in an automation lane`,
      since: new Date(lastTouch).toISOString(),
      reason: 'dormant',
      ...(notedFollowUp ? { evidence: notedFollowUp } : {}),
    }
  }
  if (thread?.is_suppressed || clean(thread?.inbox_bucket) === 'suppressed') {
    return { key: 'blocked', label: 'Contact suppressed', detail: 'Thread suppressed — automation cannot reach the seller', since: thread?.suppressed_at || opp.last_activity_at, reason: 'suppressed' }
  }
  if (next === 'no_action_contact_blocked' || ['opt_out', 'wrong_number'].includes(intent)) {
    return { key: 'blocked', label: 'Contact blocked', detail: INTENT_LABEL[intent] || 'No sendable contact', since: opp.last_activity_at, reason: 'contact_blocked' }
  }
  if (clean(opp.blocker)) {
    return { key: 'blocked', label: 'Blocked', detail: clean(opp.blocker), since: opp.last_activity_at, reason: 'blocker' }
  }

  // The turn's queued step, proven from the queue (never from the intent).
  let nextLive = next
  let evidence = notedFollowUp
  if (SYSTEM_ACTIONS.has(next) && due && now - due > SYSTEM_OVERDUE_HOURS * HOUR) {
    if (!rows) {
      return { key: 'blocked', label: 'Automation overdue', detail: next === 'send_message_now' ? 'Queued reply never went out' : 'Scheduled follow-up never ran', since: opp.next_action_due, reason: 'automation_overdue' }
    }
    const step = resolveQueuedStep({ due: opp.next_action_due, anchor: trigger, rows, now })
    const what = useCaseLabel(step.row?.use_case_template)
    switch (step.outcome) {
      case 'sent':
        nextLive = null
        evidence = `Autopilot ${noun} ${clean(step.row?.queue_status) === 'delivered' ? 'delivered' : 'sent'}${what ? ` (${what})` : ''}`
        break
      case 'sent_by_you':
        nextLive = null
        evidence = `You replied — the autopilot’s own ${noun} never went out`
        break
      case 'scheduled':
        return { key: 'system', label: 'Next action scheduled', detail: `${Noun}${what ? ` · ${what}` : ''} scheduled`, since: step.at, at: step.at, reason: 'scheduled' }
      case 'in_flight':
        return { key: 'system', label: 'Automation active', detail: `${Noun} sending${what ? ` · ${what}` : ''}`, since: step.at }
      case 'held':
        return { key: 'operator', label: 'Needs you', detail: `${Noun} drafted${what ? ` (${what})` : ''} — held for your review`, since: step.at, reason: 'review_draft' }
      case 'stuck':
        return { key: 'blocked', label: 'Queued reply not sent', detail: `In the queue since ${relDays(step.at, now)} — the send runner hasn’t taken it`, since: step.at, reason: 'automation_overdue', cause: 'stuck' }
      case 'health_guard':
        return { key: 'blocked', label: `${Noun} blocked`, detail: `The send health guard blocked the autopilot’s ${noun}${what ? ` (${what})` : ''}`, since: step.at, reason: 'automation_overdue', cause: 'health_guard' }
      case 'failed':
        return { key: 'blocked', label: `${Noun} failed to send`, detail: `The carrier/transport failed the autopilot’s ${noun}${what ? ` (${what})` : ''}`, since: step.at, reason: 'automation_overdue', cause: 'failed' }
      case 'cancelled':
        return { key: 'blocked', label: `${Noun} cancelled`, detail: `The autopilot’s ${noun} was cancelled in the queue and nothing replaced it`, since: step.at, reason: 'automation_overdue', cause: 'cancelled' }
      default:
        return { key: 'blocked', label: `${Noun} never queued`, detail: `The autopilot decided to ${noun === 'reply' ? 'reply' : 'follow up'} but no message was ever queued`, since: opp.next_action_due, reason: 'automation_overdue', cause: 'never_queued' }
    }
  }
  // A drafted message held for review that nothing has gone out after.
  if (q?.held) {
    const what = useCaseLabel(q.held.useCase)
    return { key: 'operator', label: 'Needs you', detail: `${what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}` : 'Message'} drafted — held for your review`, since: q.held.at, reason: 'review_draft' }
  }
  // A review flag the automation has since acted past (it messaged the seller
  // AFTER the flag was set) is superseded — the ball is with the seller now.
  const flaggedAt = opp.last_activity_at ? Date.parse(opp.last_activity_at) : 0
  const reviewSuperseded = Boolean(lastOutbound && flaggedAt && lastOutbound > flaggedAt + HOUR && latestDirection === 'outbound')
  const execHold = execution?.status === 'blocked' && execReason && !SYSTEM_GATE_REASONS.has(execReason)
    && !(lastOutbound && Date.parse(execution.created_at) < lastOutbound)
  if (((nextLive === 'human_review' || clean(thread?.operational_status) === 'needs_review' || clean(opp.conversation_state) === 'needs_review') && !reviewSuperseded)
    || execHold) {
    const sweep = !execHold && nextLive === 'human_review' && clean(opp.last_updated_source) === 'seller_execution_gap_recovery'
    return {
      key: 'operator',
      label: 'Needs you',
      detail: (execHold && HOLD_REASON_LABEL[execReason]) || (sweep ? 'Flagged by the recovery sweep — no next step was recorded' : null) || INTENT_LABEL[intent] || 'Review requested by the autopilot',
      since: execHold ? execution.created_at : (opp.last_activity_at || execution?.created_at),
      reason: execHold ? execReason : 'human_review',
    }
  }
  if (idx >= 6 && idx <= 9) {
    const title = clean(closing?.title_status)
    return { key: 'external', label: idx >= 8 ? 'Title / closing' : idx === 7 ? 'Buyer side' : 'Contract', detail: title ? `Title ${title.replace(/_/g, ' ')}` : SELLER_WAIT_LABEL[stage], since: opp.stage_entered_at }
  }
  if (q?.next) {
    const what = useCaseLabel(q.next.useCase)
    const kind = q.next.kind === 'follow_up' ? 'Follow-up' : 'Reply'
    return q.next.future
      ? { key: 'system', label: 'Next action scheduled', detail: `${kind}${what ? ` · ${what}` : ''} scheduled`, since: q.next.at, at: q.next.at, reason: 'scheduled' }
      : { key: 'system', label: 'Automation active', detail: `${kind} sending${what ? ` · ${what}` : ''}`, since: q.next.at }
  }
  if (!rows && (SYSTEM_ACTIONS.has(next) || (thread?.pending_queue_count ?? 0) > 0)) {
    return { key: 'system', label: 'Automation active', detail: next === 'send_message_now' ? 'Reply queued by the autopilot' : 'Follow-up scheduled', since: opp.next_action_due || opp.last_activity_at }
  }
  if (rows && nextLive === 'send_message_now' && due && now - due <= STEP_GRACE_MS) {
    return { key: 'system', label: 'Automation active', detail: 'Reply being prepared by the autopilot', since: opp.next_action_due }
  }
  // A gate that held an earlier turn is history once anyone has written to the seller since.
  if (execution?.status === 'blocked' && SYSTEM_GATE_REASONS.has(execReason) && !(lastOutbound && Date.parse(execution.created_at) < lastOutbound)) {
    return { key: 'system', label: 'Automation gated', detail: HOLD_REASON_LABEL[execReason], since: execution.created_at, reason: 'gated' }
  }
  if (latestDirection === 'inbound' && (!lastOutbound || (lastInbound && lastInbound > lastOutbound))) {
    // The machine is supposed to answer every reply; an unanswered one is an
    // automation gap, surfaced as an exception rather than a chore.
    return { key: 'operator', label: 'Reply not handled', detail: 'Seller replied and the autopilot scheduled nothing', since: thread?.last_inbound_at || opp.last_activity_at, reason: 'unanswered_reply' }
  }
  return {
    key: 'seller',
    label: 'Waiting on seller',
    detail: SELLER_WAIT_LABEL[stage] || 'Waiting on seller',
    since: thread?.last_outbound_at || opp.last_contact_at || opp.last_activity_at,
    ...(evidence ? { evidence } : {}),
  }
}

function relDays(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return 'earlier'
  const d = Math.floor((now - t) / DAY)
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}

/** Stalled against the stage's own clock. Returns null when moving. Exported for tests. */
export function deriveStall(opp, lane, { thread = null, now = Date.now() } = {}) {
  if (['complete', 'closed_out', 'dormant'].includes(lane.key)) return null
  const stage = opp.acquisition_stage
  if (lane.reason === 'automation_overdue') return { key: 'automation', label: lane.label === 'Automation overdue' ? 'Automation overdue' : lane.label }
  // A machine step in flight or on the calendar is movement, not a stall.
  if (lane.key === 'system' && lane.reason !== 'gated') return null
  if (lane.key === 'operator') {
    const since = lane.since ? Date.parse(lane.since) : null
    if (since && now - since > OPERATOR_WAIT_HOURS * HOUR) return { key: 'operator', label: `Waiting on operator ${Math.floor((now - since) / DAY) || 1}d` }
  }
  if (lane.key === 'seller') {
    const lastOut = thread?.last_outbound_at ? Date.parse(thread.last_outbound_at) : (opp.last_contact_at ? Date.parse(opp.last_contact_at) : null)
    const limit = SELLER_SILENCE_DAYS[stage]
    if (limit && lastOut && now - lastOut > limit * DAY) return { key: 'seller', label: `Seller silent ${Math.floor((now - lastOut) / DAY)}d` }
  }
  if (lane.key === 'external') {
    const entered = opp.stage_entered_at ? Date.parse(opp.stage_entered_at) : null
    const limit = STAGE_MAX_DAYS[stage]
    if (limit && entered && now - entered > limit * DAY) return { key: 'external', label: `${stageShort(stage)} over ${limit}d` }
  }
  const entered = opp.stage_entered_at ? Date.parse(opp.stage_entered_at) : null
  const limit = STAGE_MAX_DAYS[stage]
  if (limit && entered && now - entered > limit * DAY) return { key: 'stage', label: `${Math.floor((now - entered) / DAY)}d in ${stageShort(stage)}` }
  return null
}

const LANE_WEIGHT = { blocked: 70, operator: 90, external: 60, system: 10, seller: 20, dormant: 0, complete: 0, closed_out: 0 }

/** Higher = look sooner. Evidence-weighted, stage-weighted, freshness-weighted. */
export function urgencyScore(opp, lane, stall, now = Date.now()) {
  let score = LANE_WEIGHT[lane.key] ?? 0
  score += (STAGE_INDEX[opp.acquisition_stage] ?? 0) * 4
  if (stall) score += 18
  if (lane.reason === 'unanswered_reply') score += 12
  if (clean(opp.latest_intent) === 'hostile_or_legal') score += 10
  if (['hot', 'warm'].includes(clean(opp.temperature))) score += clean(opp.temperature) === 'hot' ? 14 : 6
  const since = lane.since ? Date.parse(lane.since) : null
  if (since && lane.key === 'operator') score += Math.min(20, (now - since) / DAY * 2)
  return Math.round(score)
}

/**
 * Every opportunity column except `metadata`. Nothing on this path reads it
 * (the offer view selects negotiation_state on its own), and it is the weight:
 * 273 active deals shipped 6.9 MB of JSON with it (engine snapshots, up to
 * 225 KB a deal), 1.55 s against 0.14 s without (measured 2026-09-30).
 */
export const PIPELINE_SCOPE_COLUMNS = [
  'id', 'dedupe_key', 'master_owner_id', 'decision_maker_ids', 'primary_property_id', 'portfolio_group_id',
  'portfolio_property_ids', 'primary_thread_key', 'related_thread_keys', 'campaign_ids', 'workflow_enrollment_ids',
  'workflow_run_ids', 'acquisition_engine_run_id', 'acquisition_stage', 'opportunity_status', 'conversation_state',
  'queue_state', 'workflow_state', 'priority', 'temperature', 'strategy', 'aos', 'confidence', 'estimated_value',
  'arv', 'asking_price', 'recommended_offer', 'current_offer', 'seller_counter', 'offer_to_ask_gap',
  'motivation_score', 'cooperation_score', 'assigned_operator', 'automation_state', 'next_action', 'next_action_due',
  'blocker', 'approval_state', 'latest_intent', 'latest_message_preview', 'asset_class', 'market',
  'property_address_full', 'seller_display_name', 'portfolio_property_count', 'stage_entered_at', 'last_activity_at',
  'last_contact_at', 'last_updated_source', 'last_updated_by', 'promotion_reason', 'version', 'created_at',
  'updated_at', 'universal_status', 'property_state', 'property_type', 'active_offer_id', 'accepted_offer_id',
  'source_application', 'source_channel', 'source_submission_id', 'strategy_status', 'strategy_started_at',
  'strategy_resolved_at', 'strategy_resolution_reason', 'cash_attempted_at', 'cash_rejected_at',
  'creative_attempted_at', 'creative_rejected_at', 'novation_attempted_at', 'novation_rejected_at',
  'creative_ineligible_reason', 'novation_ineligible_reason', 'last_presented_terms_id', 'favorable_spread',
].join(',')

async function loadScope(client, params) {
  const run = (columns) => {
    let query = client.from('acquisition_opportunities').select(columns)
    query = applyFilters(query, { ...params, scope: clean(params.scope) || 'active' })
    return query.order('last_activity_at', { ascending: false, nullsFirst: false }).limit(SCOPE_CAP)
  }
  let { data, error } = await run(PIPELINE_SCOPE_COLUMNS)
  // One unknown column fails the whole PostgREST query; a renamed or dropped
  // column must cost this page its speed, never the page.
  if (error && (error.code === '42703' || /column/i.test(String(error.message || '')))) {
    ;({ data, error } = await run('*'))
  }
  if (error) throw error
  return (data || []).map(normalizeOpportunityRow).filter(Boolean)
}

/** Fixtures (canary properties) never count as deals. Returns [kept, excludedCount]. */
export function withoutSyntheticOpportunities(rows) {
  const kept = []
  let excluded = 0
  for (const r of rows || []) {
    if (isSyntheticOpportunity(r)) excluded += 1
    else kept.push(r)
  }
  return [kept, excluded]
}

const QUEUE_COLUMNS = 'id, thread_key, queue_status, scheduled_for_utc, created_at, sent_at, delivered_at, source, use_case_template, message_type, type'
const QUEUE_LOOKBACK_DAYS = 90

/** Deals whose stated system step is past due — the only ones that need a trigger time. */
function overdueStepRows(rows, now = Date.now()) {
  return rows.filter((r) => {
    const due = r.next_action_due ? Date.parse(r.next_action_due) : null
    return SYSTEM_ACTIONS.has(clean(r.next_action).toLowerCase()) && due && now - due > SYSTEM_OVERDUE_HOURS * HOUR && clean(r.primary_thread_key)
  })
}

async function loadEvidence(client, rows) {
  const threadKeys = [...new Set(rows.map((r) => clean(r.primary_thread_key)).filter(Boolean))]
  const oppIds = rows.map((r) => r.id)
  const overdue = overdueStepRows(rows)
  const overdueKeys = [...new Set(overdue.map((r) => clean(r.primary_thread_key)))]
  const earliestDue = overdue.reduce((m, r) => Math.min(m, Date.parse(r.next_action_due)), Date.now())
  const since = new Date(Date.now() - 120 * DAY).toISOString()
  const queueSince = new Date(Date.now() - QUEUE_LOOKBACK_DAYS * DAY).toISOString()
  const liveStatuses = [...SEND_IN_FLIGHT, ...SEND_HELD]
  const [threads, executions, closings, recentQueue, liveQueue, triggers] = await Promise.all([
    inChunks(threadKeys, async (keys) => (await client.from('inbox_thread_state')
      .select('thread_key, inbox_bucket, is_suppressed, suppressed_at, operational_status, latest_direction, last_inbound_at, last_outbound_at, latest_message_body, latest_message_at, pending_queue_count, is_hot_lead, automation_lane')
      .in('thread_key', keys)).data),
    inChunks(threadKeys, async (keys) => (await client.from('seller_automation_executions')
      .select('thread_id, status, lifecycle_stage, metadata, created_at')
      .in('thread_id', keys).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(2000)).data),
    inChunks(oppIds, async (ids) => (await client.from('closing_cases')
      .select('opportunity_id, closing_status, contract_status, title_status, escrow_status, disposition_status, scheduled_closing_date, revenue_confirmed_date, buyer_id, buyer_price, seller_contract_price, earnest_money, updated_at, provenance')
      .in('opportunity_id', ids)).data),
    // The thread's own (non-campaign) queue rows: what really happened to the
    // autopilot's steps. Recent rows, plus any row still live or held, any age.
    inChunks(threadKeys, async (keys) => (await client.from('send_queue')
      .select(QUEUE_COLUMNS)
      .in('thread_key', keys).gte('created_at', queueSince)
      .order('created_at', { ascending: false }).limit(4000)).data),
    inChunks(threadKeys, async (keys) => (await client.from('send_queue')
      .select(QUEUE_COLUMNS)
      .in('thread_key', keys).in('queue_status', liveStatuses)
      .order('created_at', { ascending: false }).limit(1000)).data),
    // The seller message each overdue step answered (only those threads).
    overdueKeys.length
      ? inChunks(overdueKeys, async (keys) => (await client.from('message_events')
        .select('thread_key, created_at')
        .in('thread_key', keys).ilike('direction', 'in%').gte('created_at', new Date(earliestDue - 3 * DAY).toISOString())
        .order('created_at', { ascending: false }).limit(2000)).data)
      : Promise.resolve([]),
  ])
  const threadBy = new Map(threads.map((t) => [clean(t.thread_key), t]))
  const execBy = new Map()
  for (const e of executions) {
    const key = clean(e.thread_id)
    if (!execBy.has(key)) execBy.set(key, { status: e.status, reason: clean(e.metadata?.block_reason) || null, created_at: e.created_at, stage: e.lifecycle_stage })
  }
  // A voided closing case (provenance.voided) is not closing evidence.
  const closingBy = new Map(closings.filter((c) => !c.provenance?.voided).map((c) => [clean(c.opportunity_id), c]))
  const queueBy = new Map()
  const seenRow = new Set()
  for (const r of [...(recentQueue || []), ...(liveQueue || [])]) {
    if (!r || seenRow.has(r.id) || !isConversationSend(r)) continue
    seenRow.add(r.id)
    const key = clean(r.thread_key)
    if (!queueBy.has(key)) queueBy.set(key, [])
    queueBy.get(key).push(r)
  }
  const inboundBy = new Map()
  for (const m of triggers || []) {
    const key = clean(m.thread_key)
    if (!inboundBy.has(key)) inboundBy.set(key, [])
    inboundBy.get(key).push(Date.parse(m.created_at))
  }
  const triggerBy = new Map()
  for (const r of overdue) {
    const due = Date.parse(r.next_action_due)
    const times = (inboundBy.get(clean(r.primary_thread_key)) || []).filter((t) => Number.isFinite(t) && t <= due + 60_000)
    if (times.length) triggerBy.set(clean(r.id), new Date(Math.max(...times)).toISOString())
  }
  return { threadBy, execBy, closingBy, queueBy, triggerBy }
}

function shapeCard(opp, ev, now) {
  const thread = ev.threadBy.get(clean(opp.primary_thread_key)) || null
  const execution = ev.execBy.get(clean(opp.primary_thread_key)) || null
  const closing = ev.closingBy.get(clean(opp.id)) || null
  const queue = ev.queueBy ? (ev.queueBy.get(clean(opp.primary_thread_key)) || []) : null
  const trigger = ev.triggerBy ? (ev.triggerBy.get(clean(opp.id)) || null) : null
  const lane = deriveLane(opp, { thread, execution, closing, queue, trigger, now })
  const stall = deriveStall(opp, lane, { thread, now })
  const qs = queue ? summarizeThreadQueue(queue, { lastOutboundAt: thread?.last_outbound_at || null, now }) : null
  const stage = opp.acquisition_stage
  const entered = opp.stage_entered_at ? Date.parse(opp.stage_entered_at) : null
  return {
    id: opp.id,
    stage,
    stageIndex: STAGE_INDEX[stage] ?? null,
    stageLabel: UNIVERSAL_STAGE_LABELS[stage] ?? stage,
    group: GROUP_OF[stage] ?? null,
    status: opp.opportunity_status,
    lane,
    owner: ownerOfLane(lane),
    hold: holdClassOf(lane, { intent: opp.latest_intent, updatedSource: opp.last_updated_source }),
    // What the last turn intended — shown beside the evidence, never as truth.
    intent_next: clean(opp.next_action) ? { action: clean(opp.next_action), due: opp.next_action_due || null, source: clean(opp.last_updated_source) || null } : null,
    queue: qs ? { next: qs.next, held: qs.held } : null,
    stall,
    urgency: urgencyScore(opp, lane, stall, now),
    daysInStage: entered ? Math.floor((now - entered) / DAY) : null,
    seller: clean(opp.seller_display_name) || null,
    sellerSource: opp.seller_name_source || null,
    address: clean(opp.property_address_full) || null,
    city: opp.property_city || null,
    state: opp.property_state || null,
    market: clean(opp.market) || null,
    propertyType: clean(opp.property_type) || null,
    units: num(opp.units_count),
    propertyId: clean(opp.primary_property_id) || null,
    masterOwnerId: clean(opp.master_owner_id) || null,
    threadKey: clean(opp.primary_thread_key) || null,
    temperature: opp.temperature || null,
    hot: Boolean(thread?.is_hot_lead) || opp.temperature === 'hot',
    intent: clean(opp.latest_intent) || null,
    intentLabel: INTENT_LABEL[clean(opp.latest_intent)] || null,
    lastActivityAt: opp.last_activity_at || null,
    lastInboundAt: thread?.last_inbound_at || null,
    lastMessage: clean(thread?.latest_message_body || opp.latest_message_preview).slice(0, 160) || null,
    lastMessageAt: thread?.latest_message_at || null,
    lastDirection: clean(thread?.latest_direction) || null,
    money: {
      asking: num(opp.asking_price) || null,
      offer: num(opp.current_offer) || null,
      counter: num(opp.seller_counter) || null,
      value: num(opp.estimated_value) || null,
      equity: num(opp.equity_amount) || null,
      contractPrice: num(closing?.seller_contract_price) || null,
      buyerPrice: num(closing?.buyer_price) || null,
      // a seller number the conversation captured wrongly (same rule as Offers / Deal Intelligence)
      askImplausible: isImplausibleSellerNumber(opp.asking_price, opp.estimated_value),
      counterImplausible: isImplausibleSellerNumber(opp.seller_counter, opp.estimated_value),
    },
    closing: closing ? {
      status: closing.closing_status || null,
      contract: closing.contract_status || null,
      title: closing.title_status || null,
      disposition: closing.disposition_status || null,
      date: closing.scheduled_closing_date || null,
      hasBuyer: Boolean(closing.buyer_id),
      emd: num(closing.earnest_money),
    } : null,
    createdAt: opp.created_at || null,
  }
}

const SORTS = {
  urgent: (a, b) => b.urgency - a.urgency,
  recent: (a, b) => (Date.parse(b.lastActivityAt || 0) || 0) - (Date.parse(a.lastActivityAt || 0) || 0),
  stage_age: (a, b) => (b.daysInStage ?? -1) - (a.daysInStage ?? -1),
  newest: (a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0),
  value: (a, b) => (b.money.value ?? -1) - (a.money.value ?? -1),
  equity: (a, b) => (b.money.equity ?? -1) - (a.money.equity ?? -1),
  asking: (a, b) => (b.money.asking ?? -1) - (a.money.asking ?? -1),
  closing: (a, b) => (Date.parse(a.closing?.date || '9999') || 0) - (Date.parse(b.closing?.date || '9999') || 0),
  progression: (a, b) => (b.stageIndex ?? 0) - (a.stageIndex ?? 0) || b.urgency - a.urgency,
}
const VIEW_DEFAULT_SORT = { attention: 'urgent', moving: 'recent', stalled: 'stage_age', all: 'progression', closing: 'closing' }

function matchesView(card, view, movedIds) {
  if (!view || view === 'all') return true
  if (view === 'attention') return card.lane.key === 'operator' || (card.lane.key === 'blocked' && card.lane.reason !== 'suppressed')
  if (view === 'stalled') return Boolean(card.stall)
  if (view === 'moving') return movedIds.has(card.id)
  if (view === 'offers') return card.stage === 'offer' || Boolean(card.money.offer)
  if (view === 'contracts') return card.stage === 'formal_contract'
  if (view === 'disposition') return card.stage === 'disposition'
  if (view === 'closing') return ['under_contract', 'prepared_to_close'].includes(card.stage)
  if (view === 'blocked') return card.lane.key === 'blocked'
  if (view === 'working') return !['dormant', 'closed_out', 'complete'].includes(card.lane.key)
  if (view === 'dormant') return card.lane.key === 'dormant'
  if (view.startsWith('lane:')) return card.lane.key === view.slice(5)
  if (view.startsWith('stage:')) return card.stage === view.slice(6)
  if (view.startsWith('group:')) return card.group === view.slice(6)
  return true
}

const MOVEMENT_TYPES = new Set(['stage_transition', 'asking_price_changed', 'current_offer_changed', 'seller_counter_changed', 'opportunity_created', 'opportunity_status_changed'])
const money = (v) => {
  const n = num(v)
  if (!n) return null
  return n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2).replace(/\.?0+$/, '')}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`
}

/** Who moved it: an operator's hand, or the machine (autopilot, sweeps, workflows). */
export function movementBy(row) {
  const who = `${clean(row?.source)} ${clean(row?.actor)}`.toLowerCase()
  return /\b(operator|dashboard|manual|inbox)\b/.test(who) ? 'human' : 'system'
}

/** One movement line from a history row, or null when it is noise. Exported for tests. */
export function movementFromHistory(row) {
  if (!row || isSyntheticHistory(row) || !MOVEMENT_TYPES.has(row.event_type)) return null
  const base = { id: row.id, opportunityId: row.opportunity_id, at: row.created_at, source: row.source || null, actor: row.actor || null, by: movementBy(row) }
  if (row.event_type === 'stage_transition') {
    const from = stageShort(row.previous_value)
    const to = stageShort(row.new_value)
    if (!to) return null
    const forward = (STAGE_INDEX[row.new_value] ?? 0) > (STAGE_INDEX[row.previous_value] ?? 0)
    return { ...base, kind: forward ? 'advance' : 'regress', title: from ? `${from} → ${to}` : `Entered ${to}`, detail: reasonLabel(row.reason) || UNIVERSAL_STAGE_LABELS[row.new_value], fromStage: row.previous_value, toStage: row.new_value }
  }
  if (row.event_type === 'asking_price_changed') {
    const v = money(row.new_value)
    return v ? { ...base, kind: 'price', title: 'Asking price captured', detail: v } : null
  }
  if (row.event_type === 'current_offer_changed') {
    const v = money(row.new_value)
    return v ? { ...base, kind: 'offer', title: 'Offer set', detail: v } : null
  }
  if (row.event_type === 'seller_counter_changed') {
    const v = money(row.new_value)
    return v ? { ...base, kind: 'counter', title: 'Seller countered', detail: v } : null
  }
  if (row.event_type === 'opportunity_created') {
    const at = stageShort(row.new_value)
    return { ...base, kind: 'created', title: at ? `Opened at ${at}` : 'Opportunity opened', detail: reasonLabel(row.reason), toStage: STAGE_INDEX[row.new_value] ? row.new_value : undefined }
  }
  if (row.event_type === 'opportunity_status_changed') {
    const to = clean(row.new_value)
    // "Not interested" is a 30-day nurture, not a suppression — the engine
    // writes status 'suppressed' with a *_NURTURE_30D reason; say what it is.
    const nurture = to === 'suppressed' && /NURTURE/i.test(clean(row.reason))
    const label = nurture ? 'Moved to nurture' : { dead: 'Closed out', suppressed: 'Suppressed', active: 'Reactivated', nurture: 'Moved to nurture' }[to]
    return label ? { ...base, kind: to === 'active' ? 'advance' : 'exit', title: label, detail: nurture ? '30-day follow-up' : reasonLabel(row.reason), status: to } : null
  }
  return null
}

async function loadMovement(client, cards, { days = 7, limit = 40 } = {}) {
  const ids = cards.map((c) => c.id)
  const since = new Date(Date.now() - days * DAY).toISOString()
  const history = await inChunks(ids, async (part) => (await client.from('acquisition_opportunity_history')
    .select('id, opportunity_id, event_type, previous_value, new_value, reason, actor, source, created_at')
    .in('opportunity_id', part).gte('created_at', since).in('event_type', [...MOVEMENT_TYPES])
    .order('created_at', { ascending: false }).limit(400)).data)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const events = history.map(movementFromHistory).filter(Boolean)
  // Seller replies are movement too — the live pulse of the machine.
  for (const card of cards) {
    if (card.lastInboundAt && Date.parse(card.lastInboundAt) > Date.now() - days * DAY && card.lastDirection === 'inbound') {
      events.push({ id: `reply:${card.id}:${card.lastInboundAt}`, opportunityId: card.id, at: card.lastInboundAt, kind: 'reply', title: 'Seller replied', detail: card.lastMessage, by: 'seller' })
    }
  }
  return events
    .filter((e) => byId.has(e.opportunityId))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit)
    .map((e) => {
      const c = byId.get(e.opportunityId)
      return { ...e, address: c.address, seller: c.seller, stage: c.stage, stageIndex: c.stageIndex }
    })
}

/** Live deals by who holds the next action (dormant and closed kept apart). */
export function countOwners(cards) {
  const out = { autopilot: 0, scheduled: 0, seller: 0, external: 0, needs_you: 0, blocked: 0, dormant: 0, complete: 0 }
  for (const c of cards || []) {
    const k = c.owner || ownerOfLane(c.lane)
    if (k in out) out[k] += 1
  }
  return out
}

/** Days in stage across the stage's working deals, against the stage's own clock. */
export function stageAging(cards, stage) {
  const days = (cards || []).map((c) => c.daysInStage).filter((d) => typeof d === 'number' && d >= 0).sort((a, b) => a - b)
  if (!days.length) return { median: null, max: null, overClock: 0, clockDays: STAGE_MAX_DAYS[stage] ?? null, buckets: { fresh: 0, aging: 0, over: 0 } }
  const clock = STAGE_MAX_DAYS[stage] ?? null
  const buckets = { fresh: 0, aging: 0, over: 0 }
  for (const d of days) {
    if (!clock) buckets.fresh += 1
    else if (d > clock) buckets.over += 1
    else if (d > clock / 2) buckets.aging += 1
    else buckets.fresh += 1
  }
  return { median: days[Math.floor((days.length - 1) / 2)], max: days[days.length - 1], overClock: buckets.over, clockDays: clock, buckets }
}

/** Short-lived memo so the overview and the first feed page share one scope load. */
const memo = new Map()
async function scopeCards(client, params) {
  const key = JSON.stringify({ s: params.scope || 'active', q: params.q || '', m: params.market || '', p: params.property_type || '', t: params.temperature || '' })
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < 45_000) return hit.value
  const now = Date.now()
  const loaded = await loadScope(client, params)
  // Hydrate first: a fixture's address can live only on the property row.
  const [rows, synthetic] = withoutSyntheticOpportunities(await batchHydrateOpportunityProperties(client, loaded))
  const ev = await loadEvidence(client, rows)
  let cards = rows.map((r) => shapeCard(r, ev, now))
  if (clean(params.temperature)) cards = cards.filter((c) => c.temperature === clean(params.temperature))
  const value = { cards, capped: loaded.length >= SCOPE_CAP, excluded: { synthetic } }
  memo.set(key, { at: Date.now(), value })
  if (memo.size > 40) memo.delete(memo.keys().next().value)
  return value
}

export async function getPipelineCommandOverview(params = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const { cards, capped, excluded } = await scopeCards(client, params)
  const movement = await loadMovement(client, cards, { days: 7, limit: 40 })
  const dayAgo = Date.now() - DAY
  const movedToday = new Set(movement.filter((m) => Date.parse(m.at) > dayAgo).map((m) => m.opportunityId))

  const stages = UNIVERSAL_STAGE_ORDER.map((code) => {
    const inStage = cards.filter((c) => c.stage === code)
    const liveInStage = code === 'closed' ? inStage.filter((c) => c.lane.key === 'complete') : inStage.filter((c) => c.lane.key !== 'closed_out')
    return {
      code,
      index: STAGE_INDEX[code],
      short: `S${STAGE_INDEX[code]}`,
      label: UNIVERSAL_STAGE_LABELS[code],
      group: GROUP_OF[code],
      count: liveInStage.length,
      attention: liveInStage.filter((c) => matchesView(c, 'attention', movedToday)).length,
      working: liveInStage.filter((c) => !['dormant', 'complete'].includes(c.lane.key)).length,
      dormant: liveInStage.filter((c) => c.lane.key === 'dormant').length,
      stalled: liveInStage.filter((c) => c.stall).length,
      movedToday: liveInStage.filter((c) => movedToday.has(c.id)).length,
      value: liveInStage.reduce((s, c) => s + (c.money.value || 0), 0) || null,
      valued: liveInStage.filter((c) => c.money.value).length,
      asking: liveInStage.reduce((s, c) => s + (c.money.asking || 0), 0) || null,
      owners: countOwners(liveInStage),
      aging: stageAging(liveInStage.filter((c) => !['dormant', 'complete'].includes(c.lane.key)), code),
    }
  })
  const lanes = {}
  for (const c of cards) lanes[c.lane.key] = (lanes[c.lane.key] || 0) + 1
  const gated = cards.filter((c) => c.lane.reason === 'gated').length
  const stalledBy = {}
  for (const c of cards) if (c.stall) stalledBy[c.stall.key] = (stalledBy[c.stall.key] || 0) + 1
  const live = cards.filter((c) => !['closed_out'].includes(c.lane.key))
  const working = live.filter((c) => !['dormant', 'complete'].includes(c.lane.key))
  const attention = cards.filter((c) => matchesView(c, 'attention', movedToday)).sort(SORTS.urgent)
  const ownership = countOwners(live)

  return {
    scope: clean(params.scope) || 'active',
    generatedAt: new Date().toISOString(),
    capped,
    excluded: excluded || { synthetic: 0 },
    ownership,
    totals: {
      opportunities: live.length,
      working: working.length,
      dormant: live.filter((c) => c.lane.key === 'dormant').length,
      automated: working.filter((c) => ['system', 'seller', 'external'].includes(c.lane.key)).length,
      closedOut: cards.length - live.length,
      value: live.reduce((s, c) => s + (c.money.value || 0), 0) || null,
      valued: live.filter((c) => c.money.value).length,
      asking: live.reduce((s, c) => s + (c.money.asking || 0), 0) || null,
      offersOut: live.filter((c) => c.money.offer).length,
      movedToday: movedToday.size,
      attention: attention.length,
      stalled: live.filter((c) => c.stall).length,
      closed: cards.filter((c) => c.lane.key === 'complete').length,
      // machine-held = the next action is the autopilot's, the seller's or an
      // outside party's; nobody inside has to do anything
      machine: OWNER_ORDER.filter((k) => !['needs_you', 'blocked'].includes(k)).reduce((n, k) => n + (ownership[k] || 0), 0),
      needsYou: ownership.needs_you || 0,
      blocked: ownership.blocked || 0,
    },
    stages,
    groups: STAGE_GROUPS.map((g) => ({ ...g, count: stages.filter((s) => g.stages.includes(s.code)).reduce((n, s) => n + s.count, 0) })),
    lanes: { ...lanes, gated },
    stalled: { total: live.filter((c) => c.stall).length, by: stalledBy },
    attentionTop: attention.slice(0, 6),
    movement,
    thresholds: { dormantDays: DORMANT_DAYS, stageMaxDays: STAGE_MAX_DAYS, sellerSilenceDays: SELLER_SILENCE_DAYS, operatorWaitHours: OPERATOR_WAIT_HOURS, systemOverdueHours: SYSTEM_OVERDUE_HOURS },
  }
}

export async function getPipelineCommandFeed(params = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const { cards, capped } = await scopeCards(client, params)
  const view = clean(params.view) || 'all'
  let movedIds = new Set()
  if (view === 'moving') {
    const movement = await loadMovement(client, cards, { days: 7, limit: 400 })
    movedIds = new Set(movement.map((m) => m.opportunityId))
  }
  const sortKey = SORTS[clean(params.sort)] ? clean(params.sort) : (VIEW_DEFAULT_SORT[view.split(':')[0]] || (view.startsWith('stage:') || view.startsWith('group:') ? 'urgent' : 'progression'))
  const filtered = cards
    .filter((c) => matchesView(c, view, movedIds))
    .filter((c) => (params.lane ? c.lane.key === clean(params.lane) : true))
    .filter((c) => (params.stalled === '1' ? Boolean(c.stall) : true))
    .sort(SORTS[sortKey])
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 30))
  const cursor = Math.max(0, Number(params.cursor) || 0)
  return {
    view,
    sort: sortKey,
    total: filtered.length,
    capped,
    rows: filtered.slice(cursor, cursor + limit),
    nextCursor: cursor + limit < filtered.length ? cursor + limit : null,
  }
}

/** Points for a Map focus set (bounded). */
export async function getPipelineCommandPoints(params = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const feed = await getPipelineCommandFeed({ ...params, limit: 100, cursor: 0 }, deps)
  const { cards } = await scopeCards(client, params)
  const view = clean(params.view) || 'all'
  const ids = (params.view ? cards.filter((c) => matchesView(c, view, new Set())) : cards).map((c) => c.propertyId).filter(Boolean).slice(0, 2000)
  const props = await inChunks(ids, async (part) => (await client.from('properties').select('property_id, latitude, longitude, property_address_full').in('property_id', part)).data)
  return {
    total: feed.total,
    points: props.filter((p) => Number(p.latitude) && Number(p.longitude)).map((p) => ({ id: p.property_id, lat: Number(p.latitude), lng: Number(p.longitude), label: p.property_address_full })),
  }
}

/* ══ FLOW ════════════════════════════════════════════════════════════════════
 * The river over a period: what entered and left each stage, by whom (the
 * machine or an operator), what is in flight in the queue right now, and the
 * period's real movement. Same sources as the overview's movement (history,
 * test/certification rows excluded) — never a second movement model.
 *
 *   entered   stage transitions into the stage + opportunities opened at it
 *   left      stage transitions out of it + deals that exited the pipeline
 *             from it (dead / suppressed / nurture — they are no longer in the
 *             live scope, so they are read from history and filtered by the
 *             same market / type / search filters)
 *   replies   inbound seller messages on the scope's threads (message_events)
 */
export const FLOW_PERIODS = Object.freeze({ '24h': 1, '7d': 7, '30d': 30 })
const EXIT_STATUSES = ['dead', 'suppressed', 'lost', 'archived']
const OPERATOR_TZ = 'America/Chicago'

function bucketKey(iso, hourly) {
  const d = new Date(iso)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: OPERATOR_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]))
  return hourly ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}` : `${parts.year}-${parts.month}-${parts.day}`
}

/** Empty, ordered buckets for the period (operator time zone). Exported for tests. */
export function flowBuckets(days, now = Date.now()) {
  const hourly = days === 1
  const step = hourly ? HOUR : DAY
  const count = hourly ? 24 : days
  const keys = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const k = bucketKey(new Date(now - i * step).toISOString(), hourly)
    if (!keys.includes(k)) keys.push(k)
  }
  return { hourly, keys }
}

/** Per-stage period flows from movement lines. Pure; exported for tests. */
export function aggregateStageFlows(moves) {
  const flows = Object.fromEntries(UNIVERSAL_STAGE_ORDER.map((code) => [code, { entered: 0, left: 0, advanced: 0, regressed: 0, created: 0, exited: 0, system: 0, human: 0 }]))
  for (const m of moves) {
    if (m.kind === 'reply') continue
    const by = m.by === 'human' ? 'human' : 'system'
    if (m.fromStage && flows[m.fromStage] && m.toStage && m.fromStage !== m.toStage) flows[m.fromStage].left += 1
    if ((m.kind === 'advance' || m.kind === 'regress') && m.toStage && flows[m.toStage] && m.fromStage !== m.toStage) {
      flows[m.toStage].entered += 1
      flows[m.toStage][m.kind === 'advance' ? 'advanced' : 'regressed'] += 1
      flows[m.toStage][by] += 1
    } else if (m.kind === 'created' && m.toStage && flows[m.toStage]) {
      flows[m.toStage].entered += 1
      flows[m.toStage].created += 1
      flows[m.toStage][by] += 1
    } else if (m.kind === 'exit' && m.stage && flows[m.stage]) {
      flows[m.stage].left += 1
      flows[m.stage].exited += 1
      flows[m.stage][by] += 1
    }
  }
  return flows
}

export async function getPipelineCommandFlow(params = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const now = deps.now ? deps.now() : Date.now()
  const period = FLOW_PERIODS[clean(params.period)] ? clean(params.period) : '7d'
  const days = FLOW_PERIODS[period]
  const since = new Date(now - days * DAY).toISOString()
  const { cards, capped, excluded } = await scopeCards(client, params)
  const byId = new Map(cards.map((c) => [c.id, c]))
  const threadKeys = [...new Set(cards.map((c) => c.threadKey).filter(Boolean))]
  const HISTORY_COLS = 'id, opportunity_id, event_type, previous_value, new_value, reason, actor, source, created_at'

  const [history, exitsRaw, replies] = await Promise.all([
    inChunks(cards.map((c) => c.id), async (part) => (await client.from('acquisition_opportunity_history')
      .select(HISTORY_COLS).in('opportunity_id', part).gte('created_at', since).in('event_type', [...MOVEMENT_TYPES])
      .order('created_at', { ascending: false }).limit(1500)).data),
    (clean(params.scope) || 'active') === 'active'
      ? client.from('acquisition_opportunity_history').select(HISTORY_COLS)
        .eq('event_type', 'opportunity_status_changed').in('new_value', EXIT_STATUSES).gte('created_at', since)
        .order('created_at', { ascending: false }).limit(800).then((r) => r.data || [])
      : Promise.resolve([]),
    inChunks(threadKeys, async (keys) => (await client.from('message_events')
      .select('id, thread_key, created_at, message_body, detected_intent')
      .in('thread_key', keys).ilike('direction', 'in%').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(1500)).data),
  ])

  // Deals that left the live scope in the period: read them back through the
  // same filters, so an exit belongs to this view only if the deal would have.
  const exitIds = [...new Set((exitsRaw || []).filter((r) => !isSyntheticHistory(r)).map((r) => r.opportunity_id).filter((id) => id && !byId.has(id)))]
  const exitedRows = exitIds.length ? await inChunks(exitIds, async (part) => {
    let q = client.from('acquisition_opportunities').select('id, acquisition_stage, primary_property_id, property_address_full, seller_display_name, market, property_type, opportunity_status')
    q = applyFilters(q, { ...params, scope: 'all' })
    return (await q.in('id', part)).data
  }) : []
  const exitedHydrated = exitedRows?.length ? await batchHydrateOpportunityProperties(client, exitedRows.map(normalizeOpportunityRow).filter(Boolean)) : []
  const exitedBy = new Map(exitedHydrated.filter((r) => !isSyntheticOpportunity(r)).map((r) => [r.id, r]))

  const moves = []
  for (const h of history || []) {
    const mv = movementFromHistory(h)
    const c = mv && byId.get(mv.opportunityId)
    if (!c) continue
    moves.push({ ...mv, address: c.address, seller: c.seller, stage: c.stage, stageIndex: c.stageIndex })
  }
  for (const h of exitsRaw || []) {
    const r = exitedBy.get(h.opportunity_id)
    const mv = r && movementFromHistory(h)
    if (!mv) continue
    moves.push({ ...mv, address: clean(r.property_address_full) || null, seller: clean(r.seller_display_name) || null, stage: r.acquisition_stage, stageIndex: STAGE_INDEX[r.acquisition_stage] ?? null, left: true })
  }
  const replyByThread = new Map()
  for (const c of cards) if (c.threadKey) replyByThread.set(c.threadKey, c)
  for (const m of replies || []) {
    const c = replyByThread.get(clean(m.thread_key))
    if (!c) continue
    moves.push({ id: `reply:${m.id}`, opportunityId: c.id, at: m.created_at, kind: 'reply', title: 'Seller replied', detail: clean(m.message_body).slice(0, 140) || null, intent: clean(m.detected_intent) || null, by: 'seller', address: c.address, seller: c.seller, stage: c.stage, stageIndex: c.stageIndex })
  }
  moves.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

  const flows = aggregateStageFlows(moves)
  const { hourly, keys } = flowBuckets(days, now)
  const series = new Map(keys.map((k) => [k, { key: k, moves: 0, replies: 0 }]))
  for (const m of moves) {
    const b = series.get(bucketKey(m.at, hourly))
    if (!b) continue
    if (m.kind === 'reply') b.replies += 1
    else b.moves += 1
  }
  const nonReply = moves.filter((m) => m.kind !== 'reply')
  const inFlight = cards
    .filter((c) => c.queue?.next && !['closed_out', 'complete'].includes(c.lane.key))
    .map((c) => ({ opportunityId: c.id, address: c.address, seller: c.seller, stage: c.stage, stageIndex: c.stageIndex, ...c.queue.next }))
    .sort((a, b) => (Date.parse(a.at || 0) || 0) - (Date.parse(b.at || 0) || 0))
  const held = cards
    .filter((c) => c.queue?.held && !['closed_out', 'complete'].includes(c.lane.key))
    .map((c) => ({ opportunityId: c.id, address: c.address, seller: c.seller, stage: c.stage, stageIndex: c.stageIndex, ...c.queue.held }))
    .sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0))

  return {
    scope: clean(params.scope) || 'active',
    period,
    since,
    generatedAt: new Date(now).toISOString(),
    capped,
    excluded: excluded || { synthetic: 0 },
    totals: {
      moved: new Set(nonReply.map((m) => m.opportunityId)).size,
      events: nonReply.length,
      advanced: nonReply.filter((m) => m.kind === 'advance').length,
      regressed: nonReply.filter((m) => m.kind === 'regress').length,
      created: nonReply.filter((m) => m.kind === 'created').length,
      exited: nonReply.filter((m) => m.kind === 'exit').length,
      nurtured: nonReply.filter((m) => m.kind === 'exit' && m.title === 'Moved to nurture').length,
      priced: nonReply.filter((m) => ['price', 'offer', 'counter'].includes(m.kind)).length,
      replies: moves.length - nonReply.length,
      bySystem: nonReply.filter((m) => m.by !== 'human').length,
      byHuman: nonReply.filter((m) => m.by === 'human').length,
    },
    stages: UNIVERSAL_STAGE_ORDER.map((code) => ({ code, index: STAGE_INDEX[code], ...flows[code] })),
    series: { hourly, buckets: [...series.values()] },
    movement: moves.slice(0, 160),
    inFlight,
    held,
  }
}

const STORY_TYPES = new Set([...MOVEMENT_TYPES, 'temperature_changed', 'automation_state_changed'])

/**
 * The deal story: canonical events only, oldest → newest, plus TODAY (the
 * lane's current state). Sources: first outbound (campaign contact), history,
 * inbound replies (with their classified intent), offers, closing events.
 */
export async function getPipelineDealStory(id, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const { data: raw, error } = await client.from('acquisition_opportunities').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  if (!raw) return null
  const [row] = await batchHydrateOpportunityProperties(client, [normalizeOpportunityRow(raw)])
  const ev = await loadEvidence(client, [row])
  const card = shapeCard(row, ev, Date.now())
  const thread = card.threadKey

  const [historyRes, messagesRes, offersRes, closingEventsRes, scoreRes, buyersRes] = await Promise.all([
    client.from('acquisition_opportunity_history').select('id, event_type, previous_value, new_value, reason, actor, source, created_at').eq('opportunity_id', id).order('created_at', { ascending: true }).limit(300),
    thread
      ? client.from('message_events').select('id, direction, message_body, intent:detected_intent, created_at, delivery_status').or(`thread_key.eq.${thread},from_phone_number.eq.${thread},to_phone_number.eq.${thread}`).order('created_at', { ascending: true }).limit(200)
      : Promise.resolve({ data: [] }),
    client.from('seller_offers').select('offer_id, offer_version, direction, purchase_price, status, created_at, sent_at, accepted_at, accepted_price').eq('opportunity_id', id).order('created_at', { ascending: true }),
    client.from('closing_activity_events').select('event_type, detail, created_at, closing_case_id').ilike('closing_case_id', `%${id}%`).order('created_at', { ascending: true }).limit(100),
    card.propertyId
      ? client.from('property_acquisition_scores').select('aos_score, decision_tier, confidence, best_strategy, recommended_cash_offer, minimum_acceptable_offer, valuation_low, valuation_mid, valuation_high, expected_assignment_fee, computed_at').eq('property_id', card.propertyId).order('computed_at', { ascending: false }).limit(1)
      : Promise.resolve({ data: [] }),
    card.propertyId
      ? client.from('buyer_match_candidates').select('buyer_match_run_id, created_at, buyer_display_name, match_grade, match_score, buyer_response_status, selected, package_sent_at, suggested_dispo_price').eq('property_id', card.propertyId).order('created_at', { ascending: false }).order('match_score', { ascending: false }).limit(150)
      : Promise.resolve({ data: [] }),
  ])

  const beats = []
  const messages = messagesRes.data || []
  const firstOut = messages.find((m) => clean(m.direction).startsWith('out'))
  if (firstOut) beats.push({ at: firstOut.created_at, kind: 'contact', title: firstOut.campaign_id ? 'Campaign contacted owner' : 'First message sent', detail: clean(firstOut.message_body).slice(0, 120) || null })
  const inbound = messages.filter((m) => clean(m.direction).startsWith('in'))
  inbound.forEach((m, i) => {
    const intent = clean(m.intent)
    if (i === 0 || INTENT_LABEL[intent]) {
      beats.push({ at: m.created_at, kind: 'reply', title: i === 0 ? 'Seller replied' : (INTENT_LABEL[intent] || 'Seller replied'), detail: clean(m.message_body).slice(0, 140) || null, intent: intent || null })
    }
  })
  for (const h of historyRes.data || []) {
    if (!STORY_TYPES.has(h.event_type) || isSyntheticHistory(h)) continue
    const mv = movementFromHistory(h)
    if (mv) beats.push({ at: h.created_at, kind: mv.kind, title: mv.title, detail: mv.detail, stage: mv.toStage || null })
    else if (h.event_type === 'temperature_changed' && clean(h.new_value) === 'hot') beats.push({ at: h.created_at, kind: 'heat', title: 'Turned hot', detail: null })
  }
  for (const o of offersRes.data || []) {
    const v = money(o.purchase_price)
    if (o.sent_at) beats.push({ at: o.sent_at, kind: 'offer', title: `Offer sent${v ? ` ${v}` : ''}`, detail: `v${o.offer_version ?? 1}` })
    if (o.accepted_at) beats.push({ at: o.accepted_at, kind: 'accepted', title: `Seller accepted${o.accepted_price ? ` ${money(o.accepted_price)}` : ''}`, detail: null })
  }
  for (const e of closingEventsRes.data || []) beats.push({ at: e.created_at, kind: 'closing', title: clean(e.event_type).replace(/_/g, ' '), detail: typeof e.detail === 'string' ? e.detail : null })

  beats.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  // De-duplicate identical beats within a minute (history + offers can echo).
  const story = []
  for (const b of beats) {
    const prev = story[story.length - 1]
    if (prev && prev.title === b.title && Math.abs(Date.parse(prev.at) - Date.parse(b.at)) < 60_000) continue
    story.push(b)
  }
  story.push({ at: new Date().toISOString(), kind: 'now', title: card.lane.label, detail: card.lane.detail, lane: card.lane.key })

  const score = (scoreRes.data || [])[0] || null
  const buyers = latestRunCandidates(buyersRes.data || []).sort((x, y) => (Number(y.match_score) || 0) - (Number(x.match_score) || 0))
  return {
    card,
    story,
    conversation: {
      threadKey: thread,
      lastInbound: [...inbound].reverse()[0] ? { at: [...inbound].reverse()[0].created_at, body: clean([...inbound].reverse()[0].message_body).slice(0, 400), intent: clean([...inbound].reverse()[0].intent) || null } : null,
      lastOutbound: [...messages].reverse().find((m) => clean(m.direction).startsWith('out')) || null,
      messages: messages.length,
      inbound: inbound.length,
    },
    negotiation: {
      asking: card.money.asking,
      offer: card.money.offer,
      counter: card.money.counter,
      recommended: num(raw.recommended_offer) || null,
      gap: num(raw.offer_to_ask_gap),
      offers: (offersRes.data || []).map((o) => ({ id: o.offer_id, version: o.offer_version, direction: o.direction, price: num(o.purchase_price), status: o.status, sentAt: o.sent_at, acceptedAt: o.accepted_at })),
    },
    decision: score ? {
      aos: num(score.aos_score), tier: score.decision_tier, confidence: num(score.confidence), strategy: score.best_strategy,
      offer: num(score.recommended_cash_offer), floor: num(score.minimum_acceptable_offer),
      valueLow: num(score.valuation_low), valueMid: num(score.valuation_mid), valueHigh: num(score.valuation_high),
      assignmentFee: num(score.expected_assignment_fee), computedAt: score.computed_at,
    } : null,
    disposition: {
      matched: buyers.length,
      aGrade: buyers.filter((b) => clean(b.match_grade).toUpperCase() === 'A').length,
      packagesSent: buyers.filter((b) => b.package_sent_at).length,
      interested: buyers.filter((b) => /interest|yes|reviewing/i.test(clean(b.buyer_response_status))).length,
      selected: buyers.find((b) => b.selected)?.buyer_display_name || null,
      top: buyers.slice(0, 3).map((b) => ({ name: b.buyer_display_name, grade: b.match_grade, score: num(b.match_score), status: b.buyer_response_status || null })),
    },
    closing: card.closing,
  }
}

/* ══ OFFERS ══════════════════════════════════════════════════════════════════
 * The offer picture per deal — read-only, like everything in this module.
 *
 *   which deals    the Offer stage, any current offer, any Decision Engine
 *                  recommendation, any seller_offers row
 *   engine         property_acquisition_scores (tier, confidence, comp count,
 *                  valuation range, recommended / floor offer)
 *   offer          the binding seller_offers row (sent/presented/pending/
 *                  countered/accepted, not superseded) — else the latest one
 *   authorization  metadata.negotiation_state — the negotiation's own verdict
 *   readiness      the canonical spendability rule (valuation-offer-authority)
 *                  over the stored engine row; a verdict the negotiation
 *                  already persisted always wins over the recomputation
 *
 * Nothing here computes a price: every figure is the engine's or the seller's.
 * Nothing here can authorize, send or accept an offer.
 */
const OFFER_TIER_LABEL = Object.freeze({
  AUTO_HARD_OFFER: 'Hard offer authorized', AUTO_RANGE_OFFER: 'Range offer authorized', REVIEW_REQUIRED: 'Review required',
  CREATIVE_TERMS: 'Creative terms', NURTURE: 'Nurture',
})
const OFFER_READINESS_TEXT = Object.freeze({
  [NON_SPENDABLE_REASONS.NO_VALUATION]: 'No offer-authoritative valuation yet',
  [NON_SPENDABLE_REASONS.NO_RECOMMENDATION]: 'The engine computed no offer',
  [NON_SPENDABLE_REASONS.TIER_NOT_AUTHORITATIVE]: 'The engine tier is not offer-authoritative',
  [NON_SPENDABLE_REASONS.UNDEFENDED_LOW_N]: 'Too few comps to defend the valuation',
  ask_out_of_band: 'Seller ask is outside the authorized band',
})
const OFFER_GATE_LABELS = Object.freeze({
  aos_at_least_780: 'Acquisition score ≥ 780',
  comp_count_at_least_4: '4+ qualified comps',
  confidence_at_least_85: 'Confidence ≥ 85',
  valuation_confidence_at_least_80: 'Valuation confidence ≥ 80',
  assignment_fee_meets_minimum_economics: 'Assignment fee clears minimum',
  recommended_offer_available: 'Offer computed',
})
/** The engine's own coverage gate (comp_count_at_least_4). */
export const OFFER_COMP_COVERAGE_MIN = 4
const BINDING_OFFER_STATUSES = new Set(['sent', 'accepted', 'countered', 'pending', 'presented'])
const OFFER_ROWS_CAP = 200

/** A seller number the conversation captured wrongly (same rule Deal Intelligence uses). */
export function isImplausibleSellerNumber(value, reference) {
  const v = num(value)
  if (!v || v <= 0) return false
  const ref = num(reference)
  return v < 5000 || Boolean(ref && v < ref * 0.05)
}

/**
 * Is this deal's offer spendable, and if not, why? Pure.
 *   authorized        spendable under the canonical rule (the engine's tier +
 *                     contamination defense) — the send path's own gate
 *   needs_validation  priced, but the canonical rule will not spend it
 *   not_priced        the Decision Engine has not priced the property
 *
 * The negotiation's persisted verdict is a per-turn artifact: an inbound turn
 * that did not run the engine writes `valuation_absent` even when a score
 * exists (persist-seller-transition), and nothing re-writes it when a newer
 * score lands. So the persisted verdict wins only when it is a real verdict
 * (not `valuation_absent` while a score exists) and is not older than the
 * score. No send path reads the persisted verdict; this only decides what the
 * read model says.
 *
 * Thin comp coverage is a caution the operator should see, not a gate: the
 * engine itself spends an AUTO_RANGE_OFFER from 3 comps.
 */
export function deriveOfferReadiness({ score = null, negotiation = null } = {}) {
  const tier = clean(score?.decision_tier).toUpperCase() || null
  const compCount = num(score?.comp_count)
  const gates = Object.entries(score?.gates && typeof score.gates === 'object' ? score.gates : {})
    .map(([key, pass]) => ({ key, label: OFFER_GATE_LABELS[key] || key.replace(/_/g, ' '), pass: pass === true }))
  if (!score) {
    return { state: 'not_priced', spendable: false, source: null, reason: NON_SPENDABLE_REASONS.NO_VALUATION, reasons: ['The Decision Engine has not priced this property'], tier: null, tierLabel: null, compCount: null, thinCoverage: false, gates: [], persistedIgnored: null }
  }
  const computed = resolveValuationSpendability({ valuation: score })
  const rawPersisted = negotiation && typeof negotiation.valuation_spendable === 'boolean' ? negotiation.valuation_spendable : null
  // Prefer the CURRENT reason; recommended_offer_withheld_reason is carried
  // forward by the negotiation state and never cleared.
  const persistedReason = clean(negotiation?.valuation_non_spendable_reason || negotiation?.recommended_offer_withheld_reason) || null
  const verdictAt = negotiation?.updated_at ? Date.parse(negotiation.updated_at) : null
  const scoreAt = score?.computed_at ? Date.parse(score.computed_at) : null
  let persistedIgnored = null
  if (rawPersisted === false && (!persistedReason || persistedReason === NON_SPENDABLE_REASONS.NO_VALUATION)) persistedIgnored = 'turn_without_engine_run'
  else if (rawPersisted !== null && verdictAt && scoreAt && scoreAt > verdictAt) persistedIgnored = 'older_than_score'
  const persisted = persistedIgnored ? null : rawPersisted
  const spendable = persisted ?? computed.spendable
  const reason = persisted === null ? computed.reason : (persisted ? 'valuation_offer_authoritative' : (persistedReason || computed.reason))
  const thinCoverage = compCount !== null && compCount < OFFER_COMP_COVERAGE_MIN
  const reasons = []
  if (!spendable) reasons.push(OFFER_READINESS_TEXT[reason] || reason.replace(/_/g, ' '))
  if (thinCoverage) reasons.push(`Thin comp coverage — ${compCount} qualified comp${compCount === 1 ? '' : 's'}`)
  for (const g of gates) if (!g.pass && !(g.key === 'comp_count_at_least_4' && thinCoverage)) reasons.push(`Gate not met: ${g.label}`)
  return {
    state: spendable ? 'authorized' : 'needs_validation',
    spendable: Boolean(spendable),
    source: persisted === null ? 'engine_row' : 'negotiation',
    reason,
    reasons: [...new Set(reasons)],
    tier,
    tierLabel: tier ? OFFER_TIER_LABEL[tier] || tier : null,
    compCount,
    thinCoverage,
    gates,
    persistedIgnored,
  }
}

export async function getPipelineCommandOffers(params = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const { cards, capped, excluded } = await scopeCards(client, params)
  const propertyIds = [...new Set(cards.map((c) => c.propertyId).filter(Boolean))]
  const oppIds = cards.map((c) => c.id)
  const [scores, offers] = await Promise.all([
    inChunks(propertyIds, async (ids) => (await client.from('property_acquisition_scores')
      .select('property_id, decision_tier, confidence, valuation_confidence, comp_count, best_strategy, valuation_low, valuation_mid, valuation_high, recommended_cash_offer, minimum_acceptable_offer, expected_assignment_fee, computed_at, gates:evidence->decision_tier_reasoning->hard_gate_checks, cds:evidence->comp_data_status->status')
      .in('property_id', ids)).data),
    inChunks(oppIds, async (ids) => (await client.from('seller_offers')
      .select('offer_id, opportunity_id, offer_version, direction, purchase_price, status, created_at, sent_at, accepted_at, accepted_price, superseded_at')
      .in('opportunity_id', ids).order('created_at', { ascending: false }).limit(1000)).data),
  ])
  const scoreBy = new Map()
  for (const s of scores) {
    const prev = scoreBy.get(clean(s.property_id))
    if (!prev || Date.parse(s.computed_at || 0) > Date.parse(prev.computed_at || 0)) scoreBy.set(clean(s.property_id), s)
  }
  const offersBy = new Map()
  for (const o of offers) {
    const key = clean(o.opportunity_id)
    if (!offersBy.has(key)) offersBy.set(key, [])
    offersBy.get(key).push(o)
  }
  const candidates = cards.filter((c) => c.stage === 'offer' || c.money.offer || (c.propertyId && scoreBy.has(c.propertyId)) || offersBy.has(c.id))
  const negotiations = await inChunks(candidates.map((c) => c.id), async (ids) => (await client.from('acquisition_opportunities')
    .select('id, ns:metadata->negotiation_state').in('id', ids)).data)
  const nsBy = new Map(negotiations.map((r) => [clean(r.id), r.ns && typeof r.ns === 'object' ? r.ns : null]))

  const rows = candidates.map((card) => {
    const s = card.propertyId ? scoreBy.get(card.propertyId) || null : null
    const ns = nsBy.get(card.id) || null
    const history = offersBy.get(card.id) || []
    const binding = history.find((o) => !o.superseded_at && BINDING_OFFER_STATUSES.has(clean(o.status).toLowerCase())) || null
    const last = binding || history[0] || null
    const readiness = deriveOfferReadiness({ score: s, negotiation: ns })
    const valueRef = num(s?.valuation_mid) || card.money.value
    const engineView = s ? { mid: num(s.valuation_mid), recommended: num(s.recommended_cash_offer), computedAt: s.computed_at || null } : null
    const plausibility = offerPlausibility({ engineMid: engineView?.mid ?? null, recommended: engineView?.recommended ?? null, recordedValue: card.money.value })
    const autonomy = s ? deriveOfferAutonomy({ card, readiness, negotiation: ns, engine: engineView }) : null
    return {
      card,
      autonomy,
      plausibility: { engineValueOff: plausibility.engineValueOff, recommendedOff: plausibility.recommendedOff },
      negotiation: ns ? {
        zone: clean(ns.negotiation_zone) || null,
        strategy: clean(ns.current_strategy || ns.strategy) || null,
        nextAction: clean(ns.next_action) || null,
        reviewReason: clean(ns.human_review_reason) || null,
        updatedAt: ns.updated_at || null,
      } : null,
      engine: s ? {
        tier: readiness.tier,
        tierLabel: readiness.tierLabel,
        strategy: clean(s.best_strategy) || null,
        confidence: num(s.confidence),
        valuationConfidence: num(s.valuation_confidence),
        compCount: num(s.comp_count),
        compStatus: clean(s.cds) || null,
        low: num(s.valuation_low),
        mid: num(s.valuation_mid),
        high: num(s.valuation_high),
        recommended: num(s.recommended_cash_offer),
        floor: num(s.minimum_acceptable_offer),
        assignmentFee: num(s.expected_assignment_fee),
        computedAt: s.computed_at || null,
      } : null,
      offer: last ? {
        price: num(last.purchase_price),
        status: clean(last.status) || null,
        binding: Boolean(binding),
        version: num(last.offer_version),
        direction: clean(last.direction) || null,
        createdAt: last.created_at || null,
        sentAt: last.sent_at || null,
        acceptedAt: last.accepted_at || null,
        acceptedPrice: num(last.accepted_price),
      } : null,
      offersCount: history.length,
      authorization: ns ? {
        presentable: typeof ns.valuation_spendable === 'boolean' ? ns.valuation_spendable : null,
        withheldReason: clean(ns.recommended_offer_withheld_reason || ns.valuation_non_spendable_reason) || null,
        zone: clean(ns.negotiation_zone) || null,
      } : null,
      readiness,
      askImplausible: isImplausibleSellerNumber(card.money.asking, valueRef),
      counterImplausible: isImplausibleSellerNumber(card.money.counter, valueRef),
    }
  })
  const STATE_RANK = { needs_validation: 0, authorized: 1, not_priced: 2 }
  rows.sort((a, b) => (b.card.stageIndex ?? 0) - (a.card.stageIndex ?? 0)
    || STATE_RANK[a.readiness.state] - STATE_RANK[b.readiness.state]
    || (b.engine?.recommended ?? -1) - (a.engine?.recommended ?? -1))
  const autonomy = Object.fromEntries(AUTONOMY_ORDER.map((k) => [k, rows.filter((r) => r.autonomy?.state === k).length]))

  const byMarket = new Map()
  for (const r of rows) {
    const key = r.card.market || [r.card.city, r.card.state].filter(Boolean).join(', ') || 'Market unknown'
    const m = byMarket.get(key) || { market: key, deals: 0, priced: 0, needsValidation: 0, authorized: 0, comps: [] }
    m.deals += 1
    if (r.engine) m.priced += 1
    if (r.readiness.state === 'needs_validation') m.needsValidation += 1
    if (r.readiness.state === 'authorized') m.authorized += 1
    if (r.engine?.compCount !== null && r.engine?.compCount !== undefined) m.comps.push(r.engine.compCount)
    byMarket.set(key, m)
  }
  const markets = [...byMarket.values()].map(({ comps, ...m }) => {
    const sorted = [...comps].sort((a, b) => a - b)
    return { ...m, medianComps: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null, thinCoverage: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] < OFFER_COMP_COVERAGE_MIN : null }
  }).sort((a, b) => b.deals - a.deals)

  const sentStatuses = new Set(['sent', 'presented', 'pending', 'countered', 'accepted'])
  return {
    scope: clean(params.scope) || 'active',
    generatedAt: new Date().toISOString(),
    capped,
    excluded: excluded || { synthetic: 0 },
    totals: {
      deals: rows.length,
      atOfferStage: rows.filter((r) => r.card.stage === 'offer').length,
      priced: rows.filter((r) => r.engine).length,
      withEngineOffer: rows.filter((r) => r.engine?.recommended).length,
      engineOfferValue: rows.reduce((s, r) => s + (r.engine?.recommended || 0), 0) || null,
      authorized: rows.filter((r) => r.readiness.state === 'authorized').length,
      needsValidation: rows.filter((r) => r.readiness.state === 'needs_validation').length,
      notPriced: rows.filter((r) => r.readiness.state === 'not_priced').length,
      thinCoverage: rows.filter((r) => r.readiness.thinCoverage).length,
      sent: rows.filter((r) => r.offer && sentStatuses.has(clean(r.offer.status).toLowerCase())).length,
      countered: rows.filter((r) => clean(r.offer?.status).toLowerCase() === 'countered' || r.card.money.counter).length,
      accepted: rows.filter((r) => clean(r.offer?.status).toLowerCase() === 'accepted' || r.offer?.acceptedAt).length,
      offerRecords: offers.length,
      persistedVerdictsIgnored: rows.filter((r) => r.readiness.persistedIgnored).length,
    },
    autonomy,
    thresholds: { compCoverageMin: OFFER_COMP_COVERAGE_MIN, highValueReview: 750_000, valuationStaleDays: 30 },
    markets,
    rows: rows.slice(0, OFFER_ROWS_CAP),
    truncated: rows.length > OFFER_ROWS_CAP,
  }
}
