/**
 * THE ACQUISITION OPERATIONAL VIEW.
 *
 * A presentation read model over canonical backend authority. It is NOT a second
 * database model and it computes no acquisition truth of its own — its entire job is
 * to make Inbox, Pipeline, Map, Entity Graph, Property and Deal Intelligence answer
 * "what stage / status / temperature / economics is this?" with the SAME answer and
 * the same provenance.
 *
 * ── Why a read model at all ───────────────────────────────────────────────────
 * Each surface currently reaches into a differently-shaped payload and picks its own
 * field. Pipeline reads `pipeline_stage || acquisition_stage`; the inbox thread state
 * reads `lifecycle_stage`; the map reads `seller_stage`. When those disagree the
 * operator sees one deal at three stages and has no way to know which is real.
 *
 * ── The rules this model enforces ─────────────────────────────────────────────
 *
 *  STAGE       `acquisition_opportunities.acquisition_stage` is canonical.
 *              `inbox_thread_state.lifecycle_stage` is a PROJECTION and may never
 *              lead it. A thread stage is carried here only as `projected_stage`, for
 *              display as a divergence signal — never as the stage.
 *
 *  ECONOMICS   `property_acquisition_scores` is the current Decision Engine output.
 *              Absence means the engine has NOT RUN — an actionable state, not
 *              "unavailable" — and never licenses reaching for a legacy column.
 *              `properties.cash_offer` and `properties.final_acquisition_score` are
 *              Podio-era imports; they may appear ONLY under `legacy`, which is typed
 *              so it cannot be mistaken for current authority.
 *
 *  SELLER      `seller_offers` is seller-offer authority.
 *  BUYER       `buyer_offers` is buyer-offer/selection/commitment authority.
 *              A `buyer_match_candidates` row is INTELLIGENCE. It is never a
 *              selection, a commitment, or under-contract.
 *
 * Every field that can be absent is `null`, and every derived field carries a
 * provenance tag, so a surface can render "not run" differently from "zero" and can
 * say where a number came from. Fabrication requires effort here; honesty is the
 * default.
 */

import {
  LIFECYCLE_STAGE_META,
  LIFECYCLE_STAGE_ORDER,
  LEAD_TEMPERATURE_META,
  OPERATIONAL_STATUS_META,
  type LeadTemperatureCode,
  type LifecycleStageCode,
  type OperationalStatusCode,
} from '../lead-state/universal-lead-state-registry'

type AnyRecord = Record<string, unknown>

/* ── primitives ─────────────────────────────────────────────────────────────── */

const str = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

const code = (value: unknown): string | null => str(value)?.toLowerCase().replace(/[\s-]+/g, '_') ?? null

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).replace(/[,$\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

const iso = (value: unknown): string | null => {
  const text = str(value)
  if (!text) return null
  return Number.isFinite(new Date(text).getTime()) ? text : null
}

/* ── provenance ─────────────────────────────────────────────────────────────── */

/**
 * Where a displayed value came from. `legacy_podio` exists so a legacy number can be
 * SHOWN (history is real) while being impossible to confuse with current authority.
 */
export type Provenance =
  | 'acquisition_opportunities'
  | 'property_acquisition_scores'
  | 'seller_offers'
  | 'buyer_offers'
  | 'buyer_match_candidates'
  | 'inbox_thread_state'
  | 'campaign'
  | 'contact'
  | 'legacy_podio'
  | 'absent'

export interface Sourced<T> {
  value: T | null
  source: Provenance
}

/** An absent value reports `absent`, so "we have no number" never looks like a source. */
const sourced = <T>(value: T | null, source: Provenance): Sourced<T> => ({
  value,
  source: value === null ? 'absent' : source,
})

/* ── decision engine ────────────────────────────────────────────────────────── */

/**
 * Five states, not two.
 *
 * `never_run` is the normal state for a property the acquisition flow has not reached
 * yet, and it is ACTIONABLE (run the engine). Collapsing it into "unavailable" is what
 * historically pushed surfaces toward a legacy column to show *something*.
 */
export type DecisionEngineState = 'never_run' | 'current' | 'stale' | 'running' | 'failed'

export interface DecisionEngineStatus {
  state: DecisionEngineState
  /** When the current output was computed. Null unless state is `current` or `stale`. */
  computed_at: string | null
  run_id: string | null
  /** What the operator can do about it, when there is something. */
  action: 'run_decision_engine' | 'recompute_decision_engine' | null
  failure_reason: string | null
}

/* ── economics ──────────────────────────────────────────────────────────────── */

export interface AcquisitionEconomics {
  /** Present ONLY when the engine has current output. */
  recommended_offer: Sourced<number>
  minimum_acceptable_offer: Sourced<number>
  /**
   * The authorized ceiling. Deliberately NOT investor_ceiling_mid — the engine
   * publishes that as the buyer-behaviour leg and flags it non-authoritative when the
   * buyer sample cannot support it.
   */
  authorized_ceiling: Sourced<number>
  investor_ceiling_mid: Sourced<number>
  expected_assignment_fee: Sourced<number>
  confidence: Sourced<number>
  decision_tier: Sourced<string>
  strategy: Sourced<string>
  /** Asking price is a seller-stated number, not engine output. */
  seller_asking_price: Sourced<number>
}

/**
 * Podio-era import columns. Typed separately and named unmistakably so they can be
 * rendered as history and can never occupy a "current offer" or "AI confidence" slot.
 */
export interface LegacyAcquisitionValues {
  cash_offer: number | null
  acquisition_score: number | null
  provenance: 'podio_import_not_current_authority'
}

/* ── communication ──────────────────────────────────────────────────────────── */

export type CommunicationChannel = 'sms' | 'email' | 'none'

export interface CommunicationAvailability {
  sms: boolean
  email: boolean
  /** Why a channel is unavailable, when the payload says. Suppression is not a guess. */
  sms_blocked_reason: string | null
  email_blocked_reason: string | null
  channels: CommunicationChannel[]
}

/* ── the view ───────────────────────────────────────────────────────────────── */

export interface AcquisitionOperationalView {
  property_id: string | null
  opportunity_id: string | null
  thread_key: string | null

  contact_name: string | null
  contact_phone: string | null
  contact_email: string | null
  property_address: string | null

  /** CANONICAL. acquisition_opportunities.acquisition_stage. Null = not staged. */
  stage: LifecycleStageCode | null
  stage_label: string | null
  stage_number: number | null
  stage_entered_at: string | null
  /**
   * The thread's lifecycle projection. Carried for divergence display ONLY — never
   * promoted to `stage`. Populated even when it agrees, so a surface can show that it
   * agrees rather than assuming.
   */
  projected_stage: LifecycleStageCode | null
  /** True when the projection disagrees with canonical authority. A signal, not an error. */
  stage_projection_diverges: boolean

  operational_status: OperationalStatusCode | null
  operational_status_label: string | null

  temperature: LeadTemperatureCode | null
  temperature_label: string | null
  /** Absent when nothing scored it. `unscored` is a real value; null is "no field". */
  temperature_source: Provenance

  automation_state: string | null
  automation_hold_reason: string | null
  suppression_state: string | null
  is_suppressed: boolean

  next_objective: string | null
  next_action: string | null
  next_action_due: string | null
  review_required: boolean

  last_inbound_at: string | null
  last_outbound_at: string | null
  last_activity_at: string | null

  decision_engine: DecisionEngineStatus
  economics: AcquisitionEconomics
  legacy: LegacyAcquisitionValues

  /** seller_offers authority. Null when no seller offer exists. */
  seller_offer_state: Sourced<string>
  /**
   * buyer_offers authority. A buyer_match_candidates row NEVER populates this —
   * matched is not selected, selected is not committed.
   */
  buyer_offer_state: Sourced<string>
  /** Intelligence only. Safe to show as "N candidates", never as a commitment. */
  buyer_match_candidate_count: number | null

  campaign_name: string | null
  campaign_state: string | null

  communication: CommunicationAvailability
}

/* ── input ──────────────────────────────────────────────────────────────────── */

/**
 * The sources are passed SEPARATELY and named for their table, rather than as one
 * merged blob. A merged blob is exactly how `lifecycle_stage` and `acquisition_stage`
 * end up in the same object and the wrong one wins a `||` chain.
 */
export interface AcquisitionViewSources {
  /** acquisition_opportunities row (canonical stage + operational state). */
  opportunity?: AnyRecord | null
  /** inbox_thread_state / canonical inbox row (projection + communication facts). */
  thread?: AnyRecord | null
  /** properties row. Legacy economics live here and are quarantined. */
  property?: AnyRecord | null
  /** property_acquisition_scores row — the current Decision Engine output. */
  decision?: AnyRecord | null
  /** seller_offers row. */
  sellerOffer?: AnyRecord | null
  /** buyer_offers row. */
  buyerOffer?: AnyRecord | null
  /** buyer_match_candidates — intelligence only. */
  buyerMatchCandidates?: unknown[] | number | null
}

const isStageCode = (value: string | null): value is LifecycleStageCode =>
  Boolean(value) && (LIFECYCLE_STAGE_ORDER as readonly string[]).includes(value as string)

const isStatusCode = (value: string | null): value is OperationalStatusCode =>
  Boolean(value) && value !== null && value in OPERATIONAL_STATUS_META

const isTemperatureCode = (value: string | null): value is LeadTemperatureCode =>
  Boolean(value) && value !== null && value in LEAD_TEMPERATURE_META

/**
 * Decision Engine status.
 *
 * The engine is "current" only when it produced a recommended offer. A row that exists
 * with no offer is a FAILED or partial run, not a current decision — treating it as
 * current is how a $0 offer reaches the screen looking authoritative.
 */
function resolveDecisionEngine(
  decision: AnyRecord | null | undefined,
  opportunity: AnyRecord | null | undefined,
): DecisionEngineStatus {
  const runId = str(decision?.acquisition_engine_run_id) ?? str(opportunity?.acquisition_engine_run_id)
  const explicit = code(decision?.engine_state ?? decision?.status)

  if (explicit === 'running' || code(opportunity?.acquisition_engine_state) === 'running') {
    return { state: 'running', computed_at: null, run_id: runId, action: null, failure_reason: null }
  }

  if (explicit === 'failed' || explicit === 'error') {
    return {
      state: 'failed',
      computed_at: null,
      run_id: runId,
      action: 'recompute_decision_engine',
      failure_reason: str(decision?.failure_reason ?? decision?.error) ?? null,
    }
  }

  const offer = num(decision?.recommended_cash_offer)
  const hasCurrent = offer !== null && offer > 0
  if (!hasCurrent) {
    return {
      state: 'never_run',
      computed_at: null,
      run_id: runId,
      action: 'run_decision_engine',
      failure_reason: null,
    }
  }

  // Only the backend knows what invalidates a run. A frontend age heuristic would be
  // inventing a staleness rule, so `stale` is reported only when it is stated.
  const staleFlag = decision?.requires_recompute === true || decision?.is_stale === true
  return {
    state: staleFlag ? 'stale' : 'current',
    computed_at: iso(decision?.computed_at ?? decision?.updated_at),
    run_id: runId,
    action: staleFlag ? 'recompute_decision_engine' : null,
    failure_reason: null,
  }
}

function resolveEconomics(
  decision: AnyRecord | null | undefined,
  property: AnyRecord | null | undefined,
  engine: DecisionEngineStatus,
): AcquisitionEconomics {
  // FAIL CLOSED. Unless the engine has usable output, every economics slot is absent.
  // There is deliberately no fallback branch here: the absence of one is the point.
  const usable = engine.state === 'current' || engine.state === 'stale'
  const ceiling = ((decision?.evidence as AnyRecord | null)?.offer_calculation ?? {}) as AnyRecord

  return {
    recommended_offer: sourced(usable ? num(decision?.recommended_cash_offer) : null, 'property_acquisition_scores'),
    minimum_acceptable_offer: sourced(usable ? num(decision?.minimum_acceptable_offer) : null, 'property_acquisition_scores'),
    authorized_ceiling: sourced(
      usable
        ? num(ceiling.effective_authorized_ceiling) ?? num(ceiling.valuation_based_ceiling)
        : null,
      'property_acquisition_scores',
    ),
    investor_ceiling_mid: sourced(usable ? num(decision?.investor_ceiling_mid) : null, 'property_acquisition_scores'),
    expected_assignment_fee: sourced(usable ? num(decision?.expected_assignment_fee) : null, 'property_acquisition_scores'),
    confidence: sourced(usable ? num(decision?.confidence) : null, 'property_acquisition_scores'),
    decision_tier: sourced(usable ? str(decision?.decision_tier) : null, 'property_acquisition_scores'),
    strategy: sourced(usable ? str(decision?.best_strategy) : null, 'property_acquisition_scores'),
    // Seller-stated, so it survives the engine having no output.
    seller_asking_price: sourced(num(property?.list_price ?? property?.asking_price), 'contact'),
  }
}

function resolveCommunication(
  thread: AnyRecord | null | undefined,
  opportunity: AnyRecord | null | undefined,
): CommunicationAvailability {
  const suppressed = Boolean(
    thread?.is_suppressed ?? thread?.suppressed ?? opportunity?.is_suppressed,
  )
  const contactability = code(thread?.contactability ?? opportunity?.contactability)
  const blockedCodes = new Set(['opted_out', 'dnc', 'provider_blacklisted', 'invalid_number', 'do_not_text'])
  const smsBlocked = suppressed || (contactability !== null && blockedCodes.has(contactability))

  const phone = str(thread?.phone ?? thread?.thread_key ?? opportunity?.phone)
  const email = str(thread?.email ?? opportunity?.email ?? opportunity?.contact_email)

  const sms = Boolean(phone) && !smsBlocked
  // Email eligibility is a backend decision (email_suppression + identity routing).
  // The view reports only what it was told; a mere address is not eligibility.
  const emailEligible = Boolean(email) && thread?.email_suppressed !== true

  const channels: CommunicationChannel[] = []
  if (sms) channels.push('sms')
  if (emailEligible) channels.push('email')
  if (channels.length === 0) channels.push('none')

  return {
    sms,
    email: emailEligible,
    sms_blocked_reason: smsBlocked
      ? str(thread?.suppression_reason ?? thread?.suppression_status) ?? contactability ?? 'suppressed'
      : null,
    email_blocked_reason: !emailEligible && email ? 'email_suppressed' : !email ? 'no_email_address' : null,
    channels,
  }
}

/**
 * Build the view. Every source is optional: a surface that only holds a thread still
 * gets a usable view, with the canonical fields honestly absent rather than guessed.
 */
export function buildAcquisitionOperationalView(
  sources: AcquisitionViewSources,
): AcquisitionOperationalView {
  const { opportunity, thread, property, decision, sellerOffer, buyerOffer } = sources

  // CANONICAL STAGE. Read from acquisition_opportunities and nowhere else. There is no
  // `|| thread.lifecycle_stage` here, and there must never be one: that `||` is exactly
  // how a projection starts leading its own authority.
  const canonicalStage = code(opportunity?.acquisition_stage)
  const stage = isStageCode(canonicalStage) ? canonicalStage : null

  const projected = code(thread?.lifecycle_stage ?? thread?.seller_stage ?? thread?.conversation_stage)
  const projectedStage = isStageCode(projected) ? projected : null

  const statusCode = code(opportunity?.universal_status ?? thread?.operational_status)
  const operationalStatus = isStatusCode(statusCode) ? statusCode : null

  const temperatureCode = code(opportunity?.temperature ?? thread?.lead_temperature)
  const temperature = isTemperatureCode(temperatureCode) ? temperatureCode : null

  const engine = resolveDecisionEngine(decision, opportunity)

  const candidates = sources.buyerMatchCandidates
  const candidateCount = Array.isArray(candidates)
    ? candidates.length
    : typeof candidates === 'number'
      ? candidates
      : null

  return {
    property_id: str(opportunity?.property_id ?? thread?.property_id ?? property?.id),
    opportunity_id: str(opportunity?.id ?? opportunity?.opportunity_id ?? thread?.opportunity_id),
    thread_key: str(thread?.thread_key ?? opportunity?.thread_key),

    contact_name: str(thread?.seller_display_name ?? thread?.owner_name ?? opportunity?.seller_display_name),
    contact_phone: str(thread?.phone ?? thread?.thread_key),
    contact_email: str(thread?.email ?? opportunity?.contact_email),
    property_address: str(
      opportunity?.property_address_full ?? thread?.property_address_full ?? property?.property_address_full,
    ),

    stage,
    stage_label: stage ? LIFECYCLE_STAGE_META[stage].label : null,
    stage_number: stage ? LIFECYCLE_STAGE_META[stage].number : null,
    stage_entered_at: iso(opportunity?.stage_entered_at),
    projected_stage: projectedStage,
    stage_projection_diverges: Boolean(stage && projectedStage && stage !== projectedStage),

    operational_status: operationalStatus,
    operational_status_label: operationalStatus ? OPERATIONAL_STATUS_META[operationalStatus].label : null,

    temperature,
    temperature_label: temperature ? LEAD_TEMPERATURE_META[temperature].label : null,
    temperature_source: temperature === null
      ? 'absent'
      : code(opportunity?.temperature) ? 'acquisition_opportunities' : 'inbox_thread_state',

    automation_state: str(opportunity?.automation_state ?? thread?.automation_state),
    automation_hold_reason: str(opportunity?.blocker ?? thread?.automation_hold_reason),
    suppression_state: str(thread?.suppression_status ?? opportunity?.suppression_state),
    is_suppressed: Boolean(thread?.is_suppressed ?? opportunity?.is_suppressed),

    next_objective: str(opportunity?.next_objective ?? thread?.next_objective),
    next_action: str(opportunity?.next_action ?? thread?.next_action),
    next_action_due: iso(opportunity?.next_action_due ?? thread?.follow_up_at),
    review_required: Boolean(opportunity?.needs_review ?? thread?.needs_review),

    last_inbound_at: iso(thread?.last_inbound_at ?? opportunity?.last_inbound_at),
    last_outbound_at: iso(thread?.last_outbound_at ?? opportunity?.last_outbound_at),
    last_activity_at: iso(opportunity?.last_activity_at ?? thread?.latest_message_at),

    decision_engine: engine,
    economics: resolveEconomics(decision, property, engine),
    legacy: {
      cash_offer: num(property?.cash_offer),
      acquisition_score: num(property?.final_acquisition_score),
      provenance: 'podio_import_not_current_authority',
    },

    seller_offer_state: sourced(str(sellerOffer?.status ?? sellerOffer?.offer_state), 'seller_offers'),
    buyer_offer_state: sourced(str(buyerOffer?.status ?? buyerOffer?.commitment_state), 'buyer_offers'),
    buyer_match_candidate_count: candidateCount,

    campaign_name: str(opportunity?.campaign_name ?? thread?.campaign_name),
    campaign_state: str(opportunity?.campaign_state ?? thread?.campaign_status),

    communication: resolveCommunication(thread, opportunity),
  }
}

/**
 * Display helper: what should a surface render for stage?
 *
 * Returns the label plus whether it is safe to present as authoritative. A surface
 * with no canonical stage should show "Not staged" — not S1, and not the projection.
 */
export function presentStage(view: AcquisitionOperationalView): {
  label: string
  authoritative: boolean
  note: string | null
} {
  if (view.stage) {
    return {
      label: view.stage_label as string,
      authoritative: true,
      note: view.stage_projection_diverges && view.projected_stage
        ? `Thread projection reads ${LIFECYCLE_STAGE_META[view.projected_stage].label}`
        : null,
    }
  }
  return {
    label: 'Not staged',
    authoritative: false,
    note: view.projected_stage
      ? `Only a thread projection exists (${LIFECYCLE_STAGE_META[view.projected_stage].label})`
      : null,
  }
}

/** Display helper for economics, so no surface has to re-derive the fail-closed rule. */
export function presentEconomics(view: AcquisitionOperationalView): {
  offer: number | null
  label: string
  actionable: boolean
  action: DecisionEngineStatus['action']
} {
  const { decision_engine: engine, economics } = view
  if (engine.state === 'current' || engine.state === 'stale') {
    return {
      offer: economics.recommended_offer.value,
      label: engine.state === 'stale' ? 'Recompute required' : 'Current decision',
      actionable: engine.state === 'stale',
      action: engine.action,
    }
  }
  return {
    offer: null,
    label: engine.state === 'running'
      ? 'Decision engine running'
      : engine.state === 'failed'
        ? 'Decision engine failed'
        : 'Decision engine not run',
    actionable: engine.action !== null,
    action: engine.action,
  }
}
