import {
  LIFECYCLE_STAGE_META,
  LIFECYCLE_STAGE_ORDER,
  type LifecycleStageCode,
} from '../lead-state/universal-lead-state-registry'

/**
 * What the operator has to know about an opportunity at a glance, derived from
 * the canonical opportunity row and nothing else.
 *
 * Every value here is a READ of durable state on `acquisition_opportunities`.
 * Nothing is inferred by a model, nothing is computed from message text, and
 * no field is invented when the row is silent — a missing fact renders as
 * nothing rather than a guess.
 */

const clean = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

const key = (value: unknown): string => clean(value).toLowerCase().replace(/[\s-]+/g, '_')

// ───────────────────────────────────────────────────────────────────────────
// STAGE
// ───────────────────────────────────────────────────────────────────────────

const STAGE_CODES = new Set<string>(LIFECYCLE_STAGE_ORDER)

export type PipelineStageBadge = {
  code: LifecycleStageCode
  number: number
  short: string
  label: string
}

/**
 * The opportunity's acquisition stage, or null.
 *
 * Reads `acquisition_stage` only. Deliberately NOT via
 * normalizeLifecycleStage, which coerces an unrecognised or empty value to
 * `ownership_confirmation` — that coercion is what made the lead command sheet
 * print "S1 Ownership Check" for an S4 opportunity.
 */
export function resolveOpportunityStage(row: Record<string, unknown> | null | undefined): PipelineStageBadge | null {
  if (!row) return null
  const code = key(row.acquisition_stage)
  if (!code || !STAGE_CODES.has(code)) return null
  const meta = LIFECYCLE_STAGE_META[code as LifecycleStageCode]
  if (!meta) return null
  return {
    code: code as LifecycleStageCode,
    number: meta.number,
    short: `S${meta.number}`,
    label: `S${meta.number} ${meta.label}`,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// DISPOSITION
// ───────────────────────────────────────────────────────────────────────────

export type PipelineDisposition = {
  label: string
  tone: 'suppressed' | 'dead' | 'attention' | 'waiting' | 'cold' | 'active'
  /** True when outreach is blocked and no stage move may bypass it. */
  suppressed: boolean
}

/**
 * The operator-facing disposition.
 *
 * Ordered by what overrides what, which is the whole point:
 *   suppression  beats everything (DNC/blocked contact)
 *   dead         beats status
 *   needs_review beats a normal reply
 *   then the universal status bucket
 *
 * Suppression is detected from THREE independent signals because the data uses
 * all three: `opportunity_status = 'suppressed'` (156 rows),
 * `automation_state = 'cancelled'`, and `next_action =
 * 'no_action_contact_blocked'` — the last of which appears on rows whose
 * opportunity_status is still `active`, so reading only the status would miss
 * them.
 */
export function resolveOpportunityDisposition(
  row: Record<string, unknown> | null | undefined,
): PipelineDisposition | null {
  if (!row) return null
  const status = key(row.opportunity_status)
  const universal = key(row.universal_status)
  const convo = key(row.conversation_state)
  const automation = key(row.automation_state)
  const nextAction = key(row.next_action)

  const blocked = nextAction === 'no_action_contact_blocked'
  if (status === 'suppressed' || blocked) {
    return { label: blocked ? 'No outreach' : 'Suppressed', tone: 'suppressed', suppressed: true }
  }
  if (status === 'dead') return { label: 'Dead', tone: 'dead', suppressed: false }
  if (status === 'archived') return { label: 'Archived', tone: 'dead', suppressed: false }

  if (universal === 'needs_review' || convo === 'needs_review') {
    return { label: 'Needs review', tone: 'attention', suppressed: false }
  }
  if (universal === 'waiting' || convo === 'awaiting_response') {
    return { label: 'Waiting', tone: 'waiting', suppressed: false }
  }
  if (universal === 'cold') return { label: 'Cold', tone: 'cold', suppressed: false }
  if (universal === 'follow_up') return { label: 'Follow-up', tone: 'waiting', suppressed: false }
  if (convo === 'seller_replied') return { label: 'Seller replied', tone: 'attention', suppressed: false }
  if (automation === 'cancelled') return { label: 'Automation stopped', tone: 'cold', suppressed: false }
  if (universal === 'priority') return { label: 'Priority', tone: 'attention', suppressed: false }
  return null
}

// ───────────────────────────────────────────────────────────────────────────
// NEXT ACTION
// ───────────────────────────────────────────────────────────────────────────

/**
 * Human labels for the `next_action` values actually present in the data.
 * An unmapped value is humanised rather than dropped, so a new backend action
 * shows up as itself instead of disappearing.
 */
const NEXT_ACTION_LABELS: Record<string, string> = {
  send_message_now: 'Reply now',
  human_review: 'Needs human review',
  schedule_follow_up: 'Schedule follow-up',
  no_action_contact_blocked: 'No outreach — contact blocked',
  future_seller_followup: 'Future follow-up',
  future_seller_followup_tenant_timing: 'Future follow-up · tenant timing',
  run_decision_engine: 'Run Decision Engine',
  prepare_offer: 'Prepare offer',
  review_counter: 'Review counter',
}

export type PipelineNextAction = {
  label: string
  /** ISO string when the action is scheduled; null when it is due now or unscheduled. */
  dueAt: string | null
  /** True when this is derived from state rather than read from next_action. */
  derived: boolean
}

/**
 * What happens next.
 *
 * `next_action` is NULL on 130 of 264 active opportunities, so a card that
 * only printed that column said nothing about half the pipeline. Where the
 * column is silent the label is DERIVED from durable state — a seller who has
 * replied on an active opportunity needs a reply — and flagged as derived.
 *
 * This is a read of canonical state, not a recommendation: no model, no
 * message-text analysis, and nothing is offered for a suppressed opportunity
 * beyond the fact that outreach is blocked.
 */
export function resolveOpportunityNextAction(
  row: Record<string, unknown> | null | undefined,
): PipelineNextAction | null {
  if (!row) return null
  const raw = key(row.next_action)
  const dueRaw = clean(row.next_action_due)
  const dueAt = dueRaw || null

  if (raw) {
    const label = NEXT_ACTION_LABELS[raw]
      ?? raw.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
    return { label, dueAt, derived: false }
  }

  const disposition = resolveOpportunityDisposition(row)
  if (disposition?.suppressed) {
    return { label: 'No outreach — suppressed', dueAt: null, derived: true }
  }
  const status = key(row.opportunity_status)
  if (status === 'dead' || status === 'archived') return null

  const convo = key(row.conversation_state)
  const universal = key(row.universal_status)
  if (convo === 'needs_review' || universal === 'needs_review') {
    return { label: 'Needs human review', dueAt, derived: true }
  }
  if (convo === 'seller_replied') return { label: 'Reply needed', dueAt, derived: true }
  if (universal === 'waiting') return { label: 'Waiting for seller', dueAt, derived: true }
  if (universal === 'cold') return { label: 'Re-engage or close', dueAt, derived: true }
  return null
}

// ───────────────────────────────────────────────────────────────────────────
// AUTOMATION
// ───────────────────────────────────────────────────────────────────────────

export type PipelineAutomation = {
  label: string
  tone: 'active' | 'paused' | 'cancelled' | 'idle'
}

/**
 * Automation truth, compactly.
 *
 * Production currently reports `automation_state` of `inactive` or `cancelled`
 * and `workflow_state` of `not_enrolled` on every opportunity — consistent with
 * the gated send posture. Rendering "Active" anywhere would be a lie, so the
 * labels track the real values.
 */
export function resolveOpportunityAutomation(
  row: Record<string, unknown> | null | undefined,
): PipelineAutomation | null {
  if (!row) return null
  const state = key(row.automation_state)
  const workflow = key(row.workflow_state)

  if (state === 'cancelled') return { label: 'Automation stopped', tone: 'cancelled' }
  if (state === 'paused') return { label: 'Automation paused', tone: 'paused' }
  if (state === 'active' || state === 'running') {
    return { label: workflow && workflow !== 'not_enrolled' ? `Automation · ${workflow.replace(/_/g, ' ')}` : 'Automation active', tone: 'active' }
  }
  if (state === 'inactive') return { label: 'Automation off', tone: 'idle' }
  return null
}

// ───────────────────────────────────────────────────────────────────────────
// OFFER / DEAL STATE
// ───────────────────────────────────────────────────────────────────────────

export type PipelineOfferState = { label: string } | null

/**
 * Execution state, read from the opportunity's own offer columns.
 *
 * Economics are NOT computed here — `property_acquisition_scores` remains the
 * Decision Engine authority, and legacy property score columns are not offer
 * truth.
 */
export function resolveOpportunityOfferState(
  row: Record<string, unknown> | null | undefined,
): PipelineOfferState {
  if (!row) return null
  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  if (clean(row.accepted_offer_id)) return { label: 'Offer accepted' }
  const counter = num(row.seller_counter)
  if (counter) return { label: 'Counter received' }
  if (clean(row.active_offer_id)) return { label: 'Offer sent' }
  if (num(row.current_offer)) return { label: 'Offer sent' }
  if (num(row.recommended_offer)) return { label: 'Offer ready' }
  if (num(row.asking_price)) return { label: 'Asking price known' }
  return null
}
