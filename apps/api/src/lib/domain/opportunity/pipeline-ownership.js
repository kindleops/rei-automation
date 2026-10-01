/**
 * PIPELINE OWNERSHIP — who holds the next action, proven from evidence. Pure.
 *
 * The opportunity row says what the last inbound turn INTENDED
 * (`next_action` / `next_action_due`). Nothing clears that intent after the
 * send, and nothing executes from `next_action_due` (follow-ups are real
 * `send_queue` rows), so intent alone cannot say whether the machine still
 * owns the deal. This module reads what actually happened to the queued step
 * — the thread's own `send_queue` rows — and states ownership from that:
 *
 *   autopilot   the machine is acting now (reply in flight, held by send gates)
 *   scheduled   the machine owns a future-dated step (a real queue row)
 *   seller      we spoke last; the seller owes the next move
 *   external    S6–S9 parties (contract, buyer, title)
 *   needs_you   a human decision is required by policy (review holds,
 *               drafts held for review, an unanswered reply)
 *   blocked     the machine tried and failed, or cannot reach the seller
 *   dormant / closed_out / complete — outside the live pipeline
 *
 * Nothing here writes, sends, re-prices or moves a stage.
 */

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const ms = (v) => {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

export const SEND_SENT = Object.freeze(new Set(['sent', 'delivered']))
export const SEND_IN_FLIGHT = Object.freeze(new Set(['queued', 'pending', 'scheduled', 'processing']))
export const SEND_HELD = Object.freeze(new Set(['paused_operator_review', 'approval', 'paused_name_missing']))
export const SEND_GUARD = Object.freeze(new Set(['blocked_by_health_guard', 'blocked_sender_ineligible']))
export const SEND_FAILED = Object.freeze(new Set(['failed', 'failed_transport', 'expired']))
export const SEND_CANCELLED = Object.freeze(new Set(['cancelled', 'duplicate_blocked']))

/**
 * Rows that speak to a deal's own conversation. Campaign launches are a
 * different machine (outreach, not the reply loop); canary and certification
 * sends are fixtures. Auto-replies on campaign threads DO carry a
 * campaign_id, so the campaign column cannot be the filter.
 */
const CAMPAIGN_SEND_SOURCES = new Set(['campaign_launch_execution', 'enqueue_campaign_target_one'])
const FIXTURE_SEND_SOURCES = new Set(['internal_canary', 'inbox_lock_certification'])
export function isConversationSend(row) {
  const src = lower(row?.source)
  if (CAMPAIGN_SEND_SOURCES.has(src) || lower(row?.type) === 'campaign_launch') return false
  if (FIXTURE_SEND_SOURCES.has(src) || /certification|canary/.test(src)) return false
  return true
}

/** Rows an operator caused (manual replies, inbox bulk follow-ups). */
const HUMAN_SEND_SOURCES = new Set(['inbox', 'manual_inbox', 'inbox_bulk_follow_up', 'operator', 'dashboard'])
export function sendIsHuman(row) {
  if (HUMAN_SEND_SOURCES.has(lower(row?.source))) return true
  return /manual/.test(lower(row?.use_case_template)) || /manual/.test(lower(row?.message_type))
}

/**
 * Test fixtures that live in production tables. The property namespace is the
 * canonical marker (`canaryprop_…`); the address catches a fixture whose id
 * was re-keyed. Excluded from every live count, like synthetic history.
 */
export function isSyntheticOpportunity(opp) {
  const pid = lower(opp?.primary_property_id)
  if (pid.startsWith('canaryprop_') || pid.startsWith('canary_') || pid.startsWith('fixture_')) return true
  return /internal canary/i.test(clean(opp?.property_address_full))
}

/** A grace window for the queued step: the reply goes out ~60 s after the turn. */
export const STEP_GRACE_MS = 2 * 3_600_000

/**
 * What happened to the step a turn queued? Pure.
 *
 *   due     the turn's `next_action_due` (≈ when the inbound was processed;
 *           measured 2026-10-01: the turn's own queue row lands 0.3–6 s after it)
 *   anchor  the seller message that triggered the turn (message_events time).
 *           A row created before it answered an EARLIER message and does not
 *           count. inbox_thread_state.last_inbound_at is NOT this: it is a
 *           processing stamp a few seconds after the turn.
 *   rows    the thread's conversation send_queue rows
 *
 * Returns the outcome that matters most: anything delivered after the anchor
 * means the seller heard from us; else a live row means the step is still
 * the machine's; else the most telling failure.
 */
export function resolveQueuedStep({ due, anchor = null, rows = [], now = Date.now() } = {}) {
  const dueAt = ms(due)
  if (!dueAt) return { outcome: 'unknown', at: null, row: null }
  const anchorAt = ms(anchor)
  // From the triggering message on (a slow turn can queue its reply minutes
  // before it persists `due`); without one, a short window before `due`.
  const from = anchorAt && anchorAt <= dueAt + 60_000 ? anchorAt : dueAt - 30_000
  const after = rows
    .filter((r) => (ms(r.created_at) ?? 0) >= from)
    .sort((a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0))
  const sent = after.filter((r) => SEND_SENT.has(lower(r.queue_status)))
  if (sent.length) {
    const machine = sent.find((r) => !sendIsHuman(r))
    const row = machine || sent[0]
    return { outcome: machine ? 'sent' : 'sent_by_you', at: row.delivered_at || row.sent_at || row.created_at, row }
  }
  const live = after.filter((r) => SEND_IN_FLIGHT.has(lower(r.queue_status)))
  if (live.length) {
    const row = live[live.length - 1]
    const when = ms(row.scheduled_for_utc)
    if (when && when > now) return { outcome: 'scheduled', at: row.scheduled_for_utc, row }
    if (when && now - when > STEP_GRACE_MS) return { outcome: 'stuck', at: row.scheduled_for_utc, row }
    return { outcome: 'in_flight', at: row.scheduled_for_utc || row.created_at, row }
  }
  const held = after.filter((r) => SEND_HELD.has(lower(r.queue_status)))
  if (held.length) return { outcome: 'held', at: held[held.length - 1].created_at, row: held[held.length - 1] }
  const guard = after.filter((r) => SEND_GUARD.has(lower(r.queue_status)))
  if (guard.length) return { outcome: 'health_guard', at: guard[guard.length - 1].created_at, row: guard[guard.length - 1] }
  const failed = after.filter((r) => SEND_FAILED.has(lower(r.queue_status)))
  if (failed.length) return { outcome: 'failed', at: failed[failed.length - 1].created_at, row: failed[failed.length - 1] }
  const cancelled = after.filter((r) => SEND_CANCELLED.has(lower(r.queue_status)))
  if (cancelled.length) return { outcome: 'cancelled', at: cancelled[cancelled.length - 1].created_at, row: cancelled[cancelled.length - 1] }
  return { outcome: 'never_queued', at: null, row: null }
}

/**
 * The thread's queue picture, independent of any turn: the next live row (a
 * reply in flight or a scheduled follow-up) and a draft held for review that
 * nothing has gone out after. Pure.
 */
export function summarizeThreadQueue(rows = [], { lastOutboundAt = null, now = Date.now() } = {}) {
  const sorted = [...rows].sort((a, b) => (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0))
  const live = sorted.filter((r) => SEND_IN_FLIGHT.has(lower(r.queue_status)))
  const future = live.filter((r) => (ms(r.scheduled_for_utc) ?? 0) > now)
    .sort((a, b) => (ms(a.scheduled_for_utc) ?? 0) - (ms(b.scheduled_for_utc) ?? 0))
  const due = live.filter((r) => !((ms(r.scheduled_for_utc) ?? 0) > now))
  const nextRow = due[due.length - 1] || future[0] || null
  const lastOut = ms(lastOutboundAt) ?? 0
  const lastSentRow = [...sorted].reverse().find((r) => SEND_SENT.has(lower(r.queue_status))) || null
  const lastSentAt = Math.max(lastOut, ms(lastSentRow?.delivered_at || lastSentRow?.sent_at || lastSentRow?.created_at) ?? 0)
  const heldRow = [...sorted].reverse().find((r) => SEND_HELD.has(lower(r.queue_status))) || null
  const held = heldRow && (ms(heldRow.created_at) ?? 0) > lastSentAt ? heldRow : null
  // A touch is something that changed the conversation or still can: a send
  // that went out, a live row, a held draft. A failed or cancelled attempt is not.
  const touches = sorted.filter((r) => SEND_SENT.has(lower(r.queue_status)) || SEND_IN_FLIGHT.has(lower(r.queue_status)) || SEND_HELD.has(lower(r.queue_status)))
  return {
    next: nextRow ? {
      status: lower(nextRow.queue_status),
      at: nextRow.scheduled_for_utc || nextRow.created_at || null,
      useCase: clean(nextRow.use_case_template) || null,
      kind: lower(nextRow.type) === 'followup' || lower(nextRow.message_type) === 'followup' ? 'follow_up' : 'reply',
      by: sendIsHuman(nextRow) ? 'human' : 'system',
      future: (ms(nextRow.scheduled_for_utc) ?? 0) > now,
    } : null,
    held: held ? { at: held.created_at, useCase: clean(held.use_case_template) || null, by: sendIsHuman(held) ? 'human' : 'system' } : null,
    lastTouchAt: touches.length ? touches[touches.length - 1].created_at : null,
  }
}

/** Plain words for a queue use case (template key). */
export function useCaseLabel(useCase) {
  const u = lower(useCase)
  if (!u) return null
  const known = {
    condition_probe: 'condition question', safe_clarifier: 'clarifying question', justify_price: 'price justification',
    reengagement: 're-engagement', consider_selling: 'interest question', ownership_check: 'ownership check',
    seller_asking_price: 'asking-price question', asking_price_follow_up: 'asking-price follow-up',
    nurture_not_interested: '30-day nurture', manual_reply: 'manual reply', occupancy_probe: 'occupancy question',
  }
  return known[u] || u.replace(/_/g, ' ')
}

/** Lane → the ownership vocabulary. */
export function ownerOfLane(lane) {
  switch (lane?.key) {
    case 'system': return lane.reason === 'scheduled' ? 'scheduled' : 'autopilot'
    case 'seller': return 'seller'
    case 'external': return 'external'
    case 'operator': return 'needs_you'
    case 'blocked': return 'blocked'
    case 'dormant': return 'dormant'
    case 'complete': return 'complete'
    default: return 'closed_out'
  }
}

export const OWNER_ORDER = Object.freeze(['autopilot', 'scheduled', 'seller', 'external', 'needs_you', 'blocked'])
export const OWNER_LABEL = Object.freeze({
  autopilot: 'Autopilot', scheduled: 'Next action scheduled', seller: 'Waiting on seller', external: 'External',
  needs_you: 'Needs you', blocked: 'Blocked', dormant: 'Dormant', closed_out: 'Closed out', complete: 'Closed',
})

/**
 * What kind of rule holds a deal that a human or a failure owns — a fact
 * about the rule, never a verdict on it. Pure.
 */
export function holdClassOf(lane, { intent = null, updatedSource = null } = {}) {
  if (!lane || !['operator', 'blocked'].includes(lane.key)) return null
  const r = clean(lane.reason)
  if (lane.key === 'blocked') {
    if (r === 'suppressed' || r === 'contact_blocked') return 'contact'
    if (r === 'blocker') return 'blocker'
    return 'send_failure'
  }
  if (r === 'review_draft') return 'review_draft'
  if (r === 'unanswered_reply') return 'unanswered'
  if (r === 'hostile_or_legal_intent' || lower(intent) === 'hostile_or_legal') return 'safety'
  if (/relationship|authority|referral/.test(r)) return 'authority'
  if (r === 'missing_context' || r === 'conflicting_property') return 'context'
  if (r === 'human_review' && lower(updatedSource) === 'seller_execution_gap_recovery') return 'sweep'
  if (/unclear|ambiguous|low_confidence/.test(r) || lower(intent) === 'unclear') return 'classifier'
  return 'review'
}

export const HOLD_CLASS_LABEL = Object.freeze({
  safety: 'Safety hold', authority: 'Authority to sell', context: 'Missing context', classifier: 'Classifier unsure',
  sweep: 'Recovery sweep flag', review_draft: 'Draft held for review', unanswered: 'Reply not handled',
  send_failure: 'Send failed', contact: 'Contact blocked', blocker: 'Blocker', review: 'Review requested',
})

/* ── OFFERS: autonomy, from the engine's real authority ───────────────────
 * AUTONOMOUS        the valuation is spendable (AUTO_HARD/AUTO_RANGE with a
 *                   contamination defense) and the conversation is the
 *                   machine's — the negotiation may present the number itself
 * SYSTEM RESOLVING  not spendable, but the engine resolves it without a human:
 *                   S1–S4 keep qualifying (every seller turn from S3 re-runs
 *                   the valuation), a large gap keeps negotiating without a
 *                   number (discovery → probes → expectation reset → nurture)
 * EXCEPTION         only a human resolves it: an implausible engine number, a
 *                   held or failed conversation, the negotiation's own review
 *                   hand-off, a high-value large gap, or an S5+ offer step the
 *                   engine cannot price (offer_amount_unauthorized → review)
 * PARKED            not in a live conversation: nothing re-prices it (there is
 *                   no scheduled rescoring) — shown apart, never forced into
 *                   one of the three
 */
export const HIGH_VALUE_REVIEW_THRESHOLD = 750_000
export const VALUATION_STALE_DAYS = 30
const DAY = 86_400_000

/** Engine numbers far outside the property's own recorded value. Pure. */
export function offerPlausibility({ engineMid = null, recommended = null, recordedValue = null } = {}) {
  const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  const mid = pos(engineMid)
  const rec = pos(recommended)
  const recorded = pos(recordedValue)
  const engineValueOff = Boolean(mid && recorded && (mid > recorded * 3 || mid < recorded / 3))
  const reference = engineValueOff ? recorded : (mid ?? recorded)
  const recommendedOff = Boolean(rec && reference && rec > reference * 3)
  return { engineValueOff, recommendedOff, implausible: engineValueOff || recommendedOff, reference }
}

export function deriveOfferAutonomy({ card, readiness, negotiation = null, engine = null, now = Date.now() } = {}) {
  const lane = card?.lane || { key: 'seller' }
  const idx = card?.stageIndex ?? 0
  const value = engine?.mid || card?.money?.value || null
  const plaus = offerPlausibility({ engineMid: engine?.mid ?? null, recommended: engine?.recommended ?? null, recordedValue: card?.money?.value ?? null })
  const computedAt = ms(engine?.computedAt)
  const ageDays = computedAt ? Math.floor((now - computedAt) / DAY) : null
  const stale = ageDays !== null && ageDays > VALUATION_STALE_DAYS
  const zone = lower(negotiation?.negotiation_zone) || null
  const nsNext = lower(negotiation?.next_action) || null
  const base = { zone, valuationAgeDays: ageDays, stale, implausible: plaus.implausible }

  if (['dormant', 'closed_out', 'complete'].includes(lane.key)) {
    return {
      ...base,
      state: 'parked',
      cause: lane.key === 'dormant' ? 'dormant' : 'closed',
      label: lane.key === 'dormant' ? 'Not being worked' : 'Closed out',
      why: lane.key === 'dormant' ? 'No seller conversation in 30+ days — nothing re-prices this offer.' : 'The deal is closed out.',
      reprices: 'none',
    }
  }
  if (plaus.implausible) {
    return {
      ...base,
      state: 'exception',
      cause: 'implausible',
      label: 'Engine number implausible',
      why: plaus.engineValueOff
        ? 'The engine valuation is more than 3× away from the property’s recorded value — the comp set needs a human.'
        : 'The engine offer is more than 3× the property’s value — the comp set needs a human.',
      reprices: 'operator',
    }
  }
  if (lane.key === 'blocked' || lane.key === 'operator') {
    // The negotiation's own review hand-off reads through the lane while it is
    // pending (a later outbound supersedes it, and the lane says so).
    const handoff = lane.key === 'operator' && nsNext === 'human_review'
    return {
      ...base,
      state: 'exception',
      cause: handoff ? 'negotiation_review' : 'conversation_held',
      label: readiness?.spendable ? 'Authorized, but the conversation is stuck' : handoff ? 'Negotiation handed to you' : 'Conversation needs you',
      why: `${lane.label}${lane.detail ? ` — ${lane.detail}` : ''}${handoff && negotiation?.human_review_reason ? ` (${clean(negotiation.human_review_reason).replace(/_/g, ' ')})` : ''}.`,
      reprices: 'operator',
    }
  }
  if (readiness?.spendable) {
    return {
      ...base,
      state: 'autonomous',
      cause: 'authorized',
      label: 'Autonomous',
      why: `${readiness.tierLabel || 'Offer tier'} with a contamination defense — the negotiation may present the number without you.`,
      reprices: 'next_seller_reply',
    }
  }
  if (idx > 0 && idx <= 4) {
    return {
      ...base,
      state: 'resolving',
      cause: 'qualifying',
      label: 'System resolving',
      why: idx >= 3
        ? 'Still qualifying — every seller reply from S3 re-runs the valuation.'
        : 'Still qualifying — the valuation re-runs once the seller reaches S3.',
      reprices: 'next_seller_reply',
    }
  }
  if (zone === 'large_gap') {
    if (value && value >= HIGH_VALUE_REVIEW_THRESHOLD) {
      return {
        ...base,
        state: 'exception',
        cause: 'high_value_gap',
        label: 'High-value gap goes to you',
        why: `Large gap on a $${Math.round(value / 1000).toLocaleString('en-US')}K asset — policy routes large gaps at $750K+ to a human.`,
        reprices: 'operator',
      }
    }
    return {
      ...base,
      state: 'resolving',
      cause: 'large_gap',
      label: 'System resolving',
      why: 'Large gap — the autopilot keeps negotiating without a number (discovery, probes, an expectation reset, then nurture).',
      reprices: 'next_seller_reply',
    }
  }
  return {
    ...base,
    state: 'exception',
    cause: 'offer_step_unpriced',
    label: 'Offer step needs you',
    why: `The engine’s number isn’t authorized${readiness?.reason ? ` (${clean(readiness.reason).replace(/_/g, ' ')})` : ''} — the next offer step hands to a human.`,
    reprices: 'next_seller_reply',
  }
}

export const AUTONOMY_ORDER = Object.freeze(['autonomous', 'resolving', 'exception', 'parked'])
