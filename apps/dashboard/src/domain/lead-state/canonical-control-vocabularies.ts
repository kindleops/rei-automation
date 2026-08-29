/**
 * Canonical Deal Desk control vocabularies — strict, non-coercing.
 *
 * Audit background (docs/audits/DEAL_DESK_FRONTEND_RUNTIME_AUDIT.md):
 *   DD-002 — `SellerStage` (23 values) ∩ `LIFECYCLE_STAGE_ORDER` (10 values) = ∅, and
 *   `normalizeLifecycleStage` silently returns `'ownership_confirmation'` for anything it
 *   cannot map (`universal-lead-state-registry.ts:297`). Five `mf_*` values, including
 *   `mf_suppressed`, fall through to that default — so a *suppression* value is persisted
 *   as a *lifecycle stage*, and the operator is shown a stage the seller never reached.
 *
 * This module is the mutation-path vocabulary. It differs from
 * `universal-lead-state-registry.ts` in exactly one way, and it is the important way:
 *
 *   **It never guesses.** An unrecognised value resolves to an explicit
 *   `{ ok: false, reason }` result, never to a valid-but-unrelated default.
 *
 * The registry's lenient `normalize*` helpers remain in use on *read* paths, where
 * coercing a legacy row into something displayable is reasonable. They must not be used
 * to decide what to persist.
 *
 * Dimension separation is enforced structurally: suppression, contactability, inbox
 * bucket, delivery status and reply intent are **not** stages, statuses or temperatures,
 * and are rejected by the resolvers for those dimensions rather than mapped into them.
 *
 * Pure and dependency-free — testable under `node --test`.
 */

import {
  LEAD_TEMPERATURE_ORDER,
  LIFECYCLE_STAGE_ORDER,
  OPERATIONAL_STATUS_ORDER,
  type LeadTemperatureCode,
  type LifecycleStageCode,
  type OperationalStatusCode,
} from './universal-lead-state-registry'

// ── result type ──────────────────────────────────────────────────────────────

export type VocabularyRejectionReason =
  /** Empty / null / undefined input. */
  | 'empty'
  /** The value belongs to a different dimension (e.g. a suppression value for a stage). */
  | 'wrong_dimension'
  /** Recognisably legacy, but with no defined mapping — must be remapped before editing. */
  | 'unmapped_legacy'
  /** Not recognised at all. */
  | 'unknown'

export type VocabularyResolution<T> =
  | { ok: true; value: T; viaAlias: boolean }
  | { ok: false; reason: VocabularyRejectionReason; input: string; dimension: string }

const asKey = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase().replace(/[\s\-/]+/g, '_')

/**
 * Own-property alias lookup.
 *
 * A bare `MAP[key]` truthiness test reaches the prototype chain: `Object.freeze` does not
 * detach `Object.prototype`, so `MAP['constructor']` returns the `Object` **function** and
 * `MAP['__proto__']` returns an **object** — both truthy. Every resolver would then return
 * `{ ok: true, value }` typed as a canonical string code while actually holding a
 * function, and that value would reach the write path.
 *
 * Verified before fixing: all four resolvers leaked on `constructor` and `__proto__`.
 */
const lookupAlias = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined

/**
 * Belt-and-braces: an alias must resolve into its dimension's canonical set. Guarantees a
 * non-string can never escape even if a future map gains a bad entry.
 */
const acceptAlias = <T extends string>(
  dimension: string,
  input: string,
  canonical: ReadonlySet<string>,
  candidate: T | undefined,
): VocabularyResolution<T> | null => {
  if (candidate === undefined) return null
  if (typeof candidate !== 'string' || !canonical.has(candidate)) {
    return reject<T>(dimension, input, 'unknown')
  }
  return { ok: true, value: candidate, viaAlias: true }
}

const reject = <T>(
  dimension: string,
  input: string,
  reason: VocabularyRejectionReason,
): VocabularyResolution<T> => ({ ok: false, reason, input, dimension })

// ── cross-dimension guards ───────────────────────────────────────────────────

/**
 * Values that describe *contactability / suppression*, never a lifecycle position.
 * `mf_suppressed` and `dead_suppressed` live here — under the lenient registry they
 * became `ownership_confirmation` and `closed` respectively. Both are wrong: suppression
 * says whether we may contact someone, not how far the deal progressed.
 */
export const SUPPRESSION_VOCABULARY = new Set([
  'suppressed', 'mf_suppressed', 'dead_suppressed', 'dnc', 'opted_out', 'opt_out',
  'do_not_text', 'do_not_call', 'provider_blacklisted', 'invalid_number', 'unsubscribed',
])

/** Inbox bucket names. Routing/triage, not operational status. */
export const INBOX_BUCKET_VOCABULARY = new Set([
  'priority', 'new_replies', 'needs_review', 'follow_up', 'follow_up_due', 'waiting',
  'waiting_on_seller_bucket', 'cold', 'cold_no_response', 'dead', 'suppressed_bucket',
  'all_messages', 'all_conversations', 'automated', 'negotiating', 'unassigned',
])

/** Message delivery states. Never a lead temperature. */
export const DELIVERY_VOCABULARY = new Set([
  'delivered', 'sent', 'queued', 'failed', 'undelivered', 'bounced', 'pending', 'accepted',
])

// ── lifecycle stage ──────────────────────────────────────────────────────────

const CANONICAL_STAGES = new Set<string>(LIFECYCLE_STAGE_ORDER)

/**
 * Explicit legacy → canonical stage mappings. Every entry is a deliberate decision, not a
 * heuristic. A legacy value absent from this table is rejected as `unmapped_legacy`, not
 * guessed at.
 */
export const LEGACY_STAGE_MAP: Readonly<Record<string, LifecycleStageCode>> = Object.freeze({
  ownership_check: 'ownership_confirmation',
  ownership: 'ownership_confirmation',
  identity_question: 'ownership_confirmation',
  mf_ownership_check: 'ownership_confirmation',
  interest_probe: 'offer_interest',
  interest: 'offer_interest',
  consider_selling: 'offer_interest',
  seller_response: 'offer_interest',
  interest_qualification: 'offer_interest',
  mf_interested: 'offer_interest',
  price_discovery: 'asking_price',
  pricing: 'asking_price',
  mf_asking_price_requested: 'asking_price',
  condition_details: 'property_condition',
  mf_underwriting_needed: 'property_condition',
  offer_reveal: 'offer',
  negotiation: 'offer',
  mf_offer_needed: 'offer',
  mf_offer_sent: 'offer',
  mf_negotiation: 'offer',
  contract_path: 'formal_contract',
  mf_contract_requested: 'formal_contract',
  clear_to_close: 'prepared_to_close',
  mf_dead: 'closed',
  dead: 'closed',
})

/**
 * Multifamily data-gathering stages with **no** canonical equivalent. The canonical
 * ladder has no "units confirmed" or "rent roll requested" position, so mapping them
 * anywhere is a fabrication. They are recognised (so the operator gets an actionable
 * message) but never silently converted.
 */
export const UNMAPPED_LEGACY_STAGES = new Set([
  'mf_units_confirmed', 'mf_occupancy_requested', 'mf_rent_roll_requested',
  'mf_gross_rents_requested',
])

/**
 * Resolution precedence, and why it is this order:
 *   1. canonical value                → accept
 *   2. **suppression guard**          → reject, and this one is absolute. It is the
 *                                       DD-002 invariant and no explicit mapping may
 *                                       override it.
 *   3. explicit legacy mapping        → accept. A declared mapping is a deliberate
 *                                       decision and outranks the generic guards below,
 *                                       which are only a net for undeclared values.
 *                                       (`dead` is a legitimate legacy stage meaning
 *                                       `closed`, even though `dead` is also a bucket
 *                                       name.)
 *   4. other dimension guards         → reject
 *   5. known-but-unmappable legacy    → reject with an actionable reason
 *   6. anything else                  → reject as unknown
 */
export const resolveLifecycleStageForWrite = (
  value: unknown,
): VocabularyResolution<LifecycleStageCode> => {
  const key = asKey(value)
  if (!key) return reject('lifecycle_stage', key, 'empty')
  if (CANONICAL_STAGES.has(key)) return { ok: true, value: key as LifecycleStageCode, viaAlias: false }
  // Absolute: a suppression value must never become a stage (DD-002).
  if (SUPPRESSION_VOCABULARY.has(key)) return reject('lifecycle_stage', key, 'wrong_dimension')
  const stageAlias = acceptAlias('lifecycle_stage', key, CANONICAL_STAGES, lookupAlias(LEGACY_STAGE_MAP, key))
  if (stageAlias) return stageAlias
  if (UNMAPPED_LEGACY_STAGES.has(key)) return reject('lifecycle_stage', key, 'unmapped_legacy')
  if (INBOX_BUCKET_VOCABULARY.has(key)) return reject('lifecycle_stage', key, 'wrong_dimension')
  return reject('lifecycle_stage', key, 'unknown')
}

// ── operational status ───────────────────────────────────────────────────────

const CANONICAL_STATUSES = new Set<string>(OPERATIONAL_STATUS_ORDER)

/**
 * Explicit legacy → canonical status mappings.
 *
 * Deliberately absent: `suppressed` and `closed`. The old
 * `INBOX_STATUS_TO_OPERATIONAL` map collapsed **both** onto `paused`, destroying the
 * distinction between "we chose to pause" and "we may not contact this person".
 * Suppression is a contactability fact and must be written to
 * `contactability_status`, not smuggled through operational status.
 */
export const LEGACY_STATUS_MAP: Readonly<Record<string, OperationalStatusCode>> = Object.freeze({
  new_reply: 'new_reply',
  needs_review: 'needs_review',
  ai_draft_ready: 'needs_review',
  queued: 'scheduled',
  waiting: 'waiting_on_seller',
  active: 'active_communication',
  in_conversation: 'active_communication',
  snoozed: 'snoozed',
  paused: 'paused',
})

export const resolveOperationalStatusForWrite = (
  value: unknown,
): VocabularyResolution<OperationalStatusCode> => {
  // Same precedence as the stage resolver: canonical, then the absolute suppression
  // guard, then explicit legacy mappings, then the generic dimension nets.
  // (`queued` is a declared legacy status meaning `scheduled`, even though `queued` is
  // also a delivery state.)
  const key = asKey(value)
  if (!key) return reject('operational_status', key, 'empty')
  if (CANONICAL_STATUSES.has(key)) return { ok: true, value: key as OperationalStatusCode, viaAlias: false }
  if (SUPPRESSION_VOCABULARY.has(key)) return reject('operational_status', key, 'wrong_dimension')
  // `closed` is a lifecycle stage, not a status — reject rather than collapse to `paused`.
  if (key === 'closed') return reject('operational_status', key, 'wrong_dimension')
  const statusAlias = acceptAlias('operational_status', key, CANONICAL_STATUSES, lookupAlias(LEGACY_STATUS_MAP, key))
  if (statusAlias) return statusAlias
  if (DELIVERY_VOCABULARY.has(key)) return reject('operational_status', key, 'wrong_dimension')
  return reject('operational_status', key, 'unknown')
}

// ── lead temperature ─────────────────────────────────────────────────────────

const CANONICAL_TEMPERATURES = new Set<string>(LEAD_TEMPERATURE_ORDER)

export const LEGACY_TEMPERATURE_MAP: Readonly<Record<string, LeadTemperatureCode>> = Object.freeze({
  urgent: 'hot',
  high: 'warm',
  normal: 'unscored',
  medium: 'warm',
  low: 'cold',
  none: 'unscored',
  unknown: 'unscored',
})

/** Ordering for comparison/sorting. Higher means hotter. */
export const TEMPERATURE_RANK: Readonly<Record<LeadTemperatureCode, number>> = Object.freeze({
  unscored: 0, cold: 1, warm: 2, hot: 3,
})

export const resolveLeadTemperatureForWrite = (
  value: unknown,
): VocabularyResolution<LeadTemperatureCode> => {
  const key = asKey(value)
  if (!key) return reject('lead_temperature', key, 'empty')
  if (DELIVERY_VOCABULARY.has(key)) return reject('lead_temperature', key, 'wrong_dimension')
  if (SUPPRESSION_VOCABULARY.has(key)) return reject('lead_temperature', key, 'wrong_dimension')
  if (CANONICAL_TEMPERATURES.has(key)) return { ok: true, value: key as LeadTemperatureCode, viaAlias: false }
  const tempAlias = acceptAlias('lead_temperature', key, CANONICAL_TEMPERATURES, lookupAlias(LEGACY_TEMPERATURE_MAP, key))
  if (tempAlias) return tempAlias
  return reject('lead_temperature', key, 'unknown')
}

// ── automation mode ──────────────────────────────────────────────────────────

/**
 * Automation vocabulary.
 *
 * **No canonical automation registry existed before this lane** — `autopilot_mode` was
 * only ever a passthrough key in `normalizePatchToCanonical`'s allowlist, never
 * validated, and (per the N.2 schema contract) never actually persisted by
 * `buildRowPatch`. These values are therefore defined here for the first time and are
 * deliberately minimal: only states the backend can meaningfully act on.
 */
export const AUTOMATION_MODE_ORDER = [
  'active',
  'paused',
  'human_controlled',
  'review_required',
  'disabled',
  'completed',
] as const

export type AutomationModeCode = (typeof AUTOMATION_MODE_ORDER)[number]

const CANONICAL_AUTOMATION_MODES = new Set<string>(AUTOMATION_MODE_ORDER)

export const AUTOMATION_MODE_META: Readonly<Record<AutomationModeCode, {
  label: string
  /** Can automation send on this thread while in this mode? */
  sends: boolean
  /** Is this a mode an operator may select directly? */
  operatorSelectable: boolean
}>> = Object.freeze({
  active: { label: 'Autopilot On', sends: true, operatorSelectable: true },
  paused: { label: 'Paused', sends: false, operatorSelectable: true },
  human_controlled: { label: 'Manual Only', sends: false, operatorSelectable: true },
  review_required: { label: 'Review Required', sends: false, operatorSelectable: false },
  disabled: { label: 'Disabled', sends: false, operatorSelectable: false },
  completed: { label: 'Completed', sends: false, operatorSelectable: false },
})

export const LEGACY_AUTOMATION_MAP: Readonly<Record<string, AutomationModeCode>> = Object.freeze({
  autopilot_on: 'active',
  autopilot: 'active',
  on: 'active',
  auto: 'active',
  running: 'active',
  autopilot_paused: 'paused',
  pause: 'paused',
  manual_only: 'human_controlled',
  manual: 'human_controlled',
  human: 'human_controlled',
  off: 'disabled',
  inactive: 'disabled',
  done: 'completed',
  finished: 'completed',
})

/**
 * Resolve an automation mode for a **system/automation** write. Accepts every canonical
 * mode, including ones an operator may not choose directly.
 */
export const resolveAutomationModeForWrite = (
  value: unknown,
): VocabularyResolution<AutomationModeCode> => {
  const key = asKey(value)
  if (!key) return reject('automation_mode', key, 'empty')
  if (SUPPRESSION_VOCABULARY.has(key)) return reject('automation_mode', key, 'wrong_dimension')
  if (CANONICAL_AUTOMATION_MODES.has(key)) return { ok: true, value: key as AutomationModeCode, viaAlias: false }
  const autoAlias = acceptAlias('automation_mode', key, CANONICAL_AUTOMATION_MODES, lookupAlias(LEGACY_AUTOMATION_MAP, key))
  if (autoAlias) return autoAlias
  return reject('automation_mode', key, 'unknown')
}

/**
 * Resolve an automation mode for an **operator-initiated** write.
 *
 * `operatorSelectable` was declared on the metadata but never enforced, so nothing stopped
 * an operator-facing control from persisting `review_required`, `disabled` or `completed` —
 * modes the system sets as a consequence of its own state, not choices a human makes. Use
 * this at every operator control; use `resolveAutomationModeForWrite` for system writers.
 */
export const resolveOperatorAutomationMode = (
  value: unknown,
): VocabularyResolution<AutomationModeCode> => {
  const resolved = resolveAutomationModeForWrite(value)
  if (!resolved.ok) return resolved
  if (!AUTOMATION_MODE_META[resolved.value].operatorSelectable) {
    return reject('automation_mode', asKey(value), 'wrong_dimension')
  }
  return resolved
}

/** The modes an operator control may offer. */
export const OPERATOR_SELECTABLE_AUTOMATION_MODES: readonly AutomationModeCode[] =
  AUTOMATION_MODE_ORDER.filter((mode) => AUTOMATION_MODE_META[mode].operatorSelectable)

// ── operator-facing messages ─────────────────────────────────────────────────

/**
 * Localised reason for a rejected value. Deliberately actionable and free of internal
 * identifiers — the operator sees what to do, not a stack trace.
 */
export const describeVocabularyRejection = (
  rejection: Extract<VocabularyResolution<unknown>, { ok: false }>,
): string => {
  switch (rejection.reason) {
    case 'empty':
      return 'No value was selected.'
    case 'wrong_dimension':
      return `"${rejection.input}" is not a ${rejection.dimension.replace(/_/g, ' ')} value. ` +
        'Suppression, inbox bucket and delivery states are tracked separately.'
    case 'unmapped_legacy':
      return `"${rejection.input}" is a legacy value with no current equivalent. ` +
        'It must be remapped before this control can be edited.'
    case 'unknown':
    default:
      return `"${rejection.input}" is not a recognised ${rejection.dimension.replace(/_/g, ' ')} value.`
  }
}
