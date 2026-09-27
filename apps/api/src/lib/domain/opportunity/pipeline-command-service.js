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
 * dead/suppressed terminal rows are reported as "closed out", never as won.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { applyFilters, normalizeOpportunityRow } from './opportunity-service.js'
import { batchHydrateOpportunityProperties } from './opportunity-property-hydration.js'
import { UNIVERSAL_STAGE_ORDER, UNIVERSAL_STAGE_LABELS } from './universal-pipeline-registry.js'

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
const SYSTEM_GATE_REASONS = new Set(['execution_gated'])
const HOLD_REASON_LABEL = {
  execution_gated: 'Held by send gates',
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
 */
export function deriveLane(opp, { thread = null, execution = null, closing = null, now = Date.now() } = {}) {
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

  if (['closed', 'funded', 'recorded'].includes(closingStatus) || closing?.revenue_confirmed_date) {
    return { key: 'complete', label: 'Closed', detail: 'Closing recorded', since: closing?.revenue_confirmed_date || closing?.updated_at || null }
  }
  if (['dead', 'suppressed', 'lost', 'archived'].includes(status)) {
    return { key: 'closed_out', label: status === 'suppressed' ? 'Suppressed' : 'Closed out', detail: INTENT_LABEL[intent] || null, since: opp.last_activity_at }
  }
  const lastTouch = Math.max(
    opp.last_activity_at ? Date.parse(opp.last_activity_at) : 0,
    lastInbound || 0,
    lastOutbound || 0,
    execution?.created_at ? Date.parse(execution.created_at) : 0,
  )
  const scheduledAhead = SYSTEM_ACTIONS.has(next) && due && due > now
  if (!scheduledAhead && idx < 6 && lastTouch && now - lastTouch > DORMANT_DAYS * DAY) {
    const days = Math.floor((now - lastTouch) / DAY)
    return {
      key: 'dormant',
      label: 'Dormant',
      detail: next === 'human_review' ? `Untouched ${days}d · last flagged for review` : `Untouched ${days}d · not in an automation lane`,
      since: new Date(lastTouch).toISOString(),
      reason: 'dormant',
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
  if (SYSTEM_ACTIONS.has(next) && due && now - due > SYSTEM_OVERDUE_HOURS * HOUR) {
    return { key: 'blocked', label: 'Automation overdue', detail: next === 'send_message_now' ? 'Queued reply never went out' : 'Scheduled follow-up never ran', since: opp.next_action_due, reason: 'automation_overdue' }
  }
  // A review flag the automation has since acted past (it messaged the seller
  // AFTER the flag was set) is superseded — the ball is with the seller now.
  const flaggedAt = opp.last_activity_at ? Date.parse(opp.last_activity_at) : 0
  const reviewSuperseded = Boolean(lastOutbound && flaggedAt && lastOutbound > flaggedAt + HOUR && latestDirection === 'outbound')
  const execHold = execution?.status === 'blocked' && execReason && !SYSTEM_GATE_REASONS.has(execReason)
    && !(lastOutbound && Date.parse(execution.created_at) < lastOutbound)
  if (((next === 'human_review' || clean(thread?.operational_status) === 'needs_review' || clean(opp.conversation_state) === 'needs_review') && !reviewSuperseded)
    || execHold) {
    return {
      key: 'operator',
      label: 'Needs you',
      detail: (execHold && HOLD_REASON_LABEL[execReason]) || INTENT_LABEL[intent] || 'Review requested by the autopilot',
      since: execHold ? execution.created_at : (opp.last_activity_at || execution?.created_at),
      reason: execHold ? execReason : 'human_review',
    }
  }
  if (idx >= 6 && idx <= 9) {
    const title = clean(closing?.title_status)
    return { key: 'external', label: idx >= 8 ? 'Title / closing' : idx === 7 ? 'Buyer side' : 'Contract', detail: title ? `Title ${title.replace(/_/g, ' ')}` : SELLER_WAIT_LABEL[stage], since: opp.stage_entered_at }
  }
  if (SYSTEM_ACTIONS.has(next) || (thread?.pending_queue_count ?? 0) > 0) {
    return { key: 'system', label: 'Automation active', detail: next === 'send_message_now' ? 'Reply queued by the autopilot' : 'Follow-up scheduled', since: opp.next_action_due || opp.last_activity_at }
  }
  if (execution?.status === 'blocked' && SYSTEM_GATE_REASONS.has(execReason)) {
    return { key: 'system', label: 'Automation gated', detail: HOLD_REASON_LABEL[execReason], since: execution.created_at, reason: 'gated' }
  }
  if (latestDirection === 'inbound' && (!lastOutbound || (lastInbound && lastInbound > lastOutbound))) {
    // The machine is supposed to answer every reply; an unanswered one is an
    // automation gap, surfaced as an exception rather than a chore.
    return { key: 'operator', label: 'Reply not handled', detail: 'Seller replied and the autopilot scheduled nothing', since: thread?.last_inbound_at || opp.last_activity_at, reason: 'unanswered_reply' }
  }
  return { key: 'seller', label: 'Waiting on seller', detail: SELLER_WAIT_LABEL[stage] || 'Waiting on seller', since: thread?.last_outbound_at || opp.last_contact_at || opp.last_activity_at }
}

/** Stalled against the stage's own clock. Returns null when moving. Exported for tests. */
export function deriveStall(opp, lane, { thread = null, now = Date.now() } = {}) {
  if (['complete', 'closed_out', 'dormant'].includes(lane.key)) return null
  const stage = opp.acquisition_stage
  if (lane.reason === 'automation_overdue') return { key: 'automation', label: 'Automation overdue' }
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

async function loadScope(client, params) {
  let query = client.from('acquisition_opportunities').select('*')
  query = applyFilters(query, { ...params, scope: clean(params.scope) || 'active' })
  const { data, error } = await query.order('last_activity_at', { ascending: false, nullsFirst: false }).limit(SCOPE_CAP)
  if (error) throw error
  return (data || []).map(normalizeOpportunityRow).filter(Boolean)
}

async function loadEvidence(client, rows) {
  const threadKeys = [...new Set(rows.map((r) => clean(r.primary_thread_key)).filter(Boolean))]
  const oppIds = rows.map((r) => r.id)
  const since = new Date(Date.now() - 120 * DAY).toISOString()
  const [threads, executions, closings] = await Promise.all([
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
  ])
  const threadBy = new Map(threads.map((t) => [clean(t.thread_key), t]))
  const execBy = new Map()
  for (const e of executions) {
    const key = clean(e.thread_id)
    if (!execBy.has(key)) execBy.set(key, { status: e.status, reason: clean(e.metadata?.block_reason) || null, created_at: e.created_at, stage: e.lifecycle_stage })
  }
  // A voided closing case (provenance.voided) is not closing evidence.
  const closingBy = new Map(closings.filter((c) => !c.provenance?.voided).map((c) => [clean(c.opportunity_id), c]))
  return { threadBy, execBy, closingBy }
}

function shapeCard(opp, ev, now) {
  const thread = ev.threadBy.get(clean(opp.primary_thread_key)) || null
  const execution = ev.execBy.get(clean(opp.primary_thread_key)) || null
  const closing = ev.closingBy.get(clean(opp.id)) || null
  const lane = deriveLane(opp, { thread, execution, closing, now })
  const stall = deriveStall(opp, lane, { thread, now })
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

/** One movement line from a history row, or null when it is noise. Exported for tests. */
export function movementFromHistory(row) {
  if (!row || isSyntheticHistory(row) || !MOVEMENT_TYPES.has(row.event_type)) return null
  const base = { id: row.id, opportunityId: row.opportunity_id, at: row.created_at, source: row.source || null }
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
  if (row.event_type === 'opportunity_created') return { ...base, kind: 'created', title: 'Opportunity opened', detail: reasonLabel(row.reason) }
  if (row.event_type === 'opportunity_status_changed') {
    const to = clean(row.new_value)
    const label = { dead: 'Closed out', suppressed: 'Suppressed', active: 'Reactivated', nurture: 'Moved to nurture' }[to]
    return label ? { ...base, kind: to === 'active' ? 'advance' : 'exit', title: label, detail: reasonLabel(row.reason) } : null
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
      events.push({ id: `reply:${card.id}:${card.lastInboundAt}`, opportunityId: card.id, at: card.lastInboundAt, kind: 'reply', title: 'Seller replied', detail: card.lastMessage })
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

/** Short-lived memo so the overview and the first feed page share one scope load. */
const memo = new Map()
async function scopeCards(client, params) {
  const key = JSON.stringify({ s: params.scope || 'active', q: params.q || '', m: params.market || '', p: params.property_type || '', t: params.temperature || '' })
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < 45_000) return hit.value
  const now = Date.now()
  const raw = await loadScope(client, params)
  const rows = await batchHydrateOpportunityProperties(client, raw)
  const ev = await loadEvidence(client, rows)
  let cards = rows.map((r) => shapeCard(r, ev, now))
  if (clean(params.temperature)) cards = cards.filter((c) => c.temperature === clean(params.temperature))
  const value = { cards, capped: raw.length >= SCOPE_CAP }
  memo.set(key, { at: Date.now(), value })
  if (memo.size > 40) memo.delete(memo.keys().next().value)
  return value
}

export async function getPipelineCommandOverview(params = {}, deps = {}) {
  const client = deps.supabase || defaultSupabase
  const { cards, capped } = await scopeCards(client, params)
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

  return {
    scope: clean(params.scope) || 'active',
    generatedAt: new Date().toISOString(),
    capped,
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
      ? client.from('message_events').select('id, direction, message_body, intent, created_at, delivery_status, campaign_id').or(`thread_key.eq.${thread},from_phone_number.eq.${thread},to_phone_number.eq.${thread}`).order('created_at', { ascending: true }).limit(200)
      : Promise.resolve({ data: [] }),
    client.from('seller_offers').select('offer_id, offer_version, direction, purchase_price, status, created_at, sent_at, accepted_at, accepted_price').eq('opportunity_id', id).order('created_at', { ascending: true }),
    client.from('closing_activity_events').select('event_type, detail, created_at, closing_case_id').ilike('closing_case_id', `%${id}%`).order('created_at', { ascending: true }).limit(100),
    card.propertyId
      ? client.from('property_acquisition_scores').select('aos_score, decision_tier, confidence, best_strategy, recommended_cash_offer, minimum_acceptable_offer, valuation_low, valuation_mid, valuation_high, expected_assignment_fee, computed_at').eq('property_id', card.propertyId).order('computed_at', { ascending: false }).limit(1)
      : Promise.resolve({ data: [] }),
    card.propertyId
      ? client.from('buyer_match_candidates').select('buyer_display_name, match_grade, match_score, buyer_response_status, selected, package_sent_at, suggested_dispo_price').eq('property_id', card.propertyId).order('match_score', { ascending: false }).limit(50)
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
  const buyers = buyersRes.data || []
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
