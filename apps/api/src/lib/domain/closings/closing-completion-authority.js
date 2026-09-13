// ─── closing-completion-authority.js ────────────────────────────────────────
// THE S10 gate. `closed` means exactly one thing:
//
//   the transaction actually completed.
//
// Not scheduled. Not ready. Not signed. Not expected. Not marked complete by an
// operator without evidence.
//
//   prepared_to_close       != closed
//   scheduled closing date  != closed
//   all documents signed    != closed
//   funds expected          != funds received
//   funds received          != funds disbursed
//   closing_status='closed' != closed
//
// ARCHAEOLOGY (2026-09-13):
//   * No settlement, funding, recording, disbursement, transaction or revenue
//     table exists in Supabase. The revenue modules
//     (create-deal-revenue-from-closed-closing.js, update-deal-revenue.js) and
//     maybe-mark-closed.js are Podio-native, and Podio is dead.
//   * `closing_cases` carries expected_gross_revenue, confirmed_gross_revenue,
//     net_revenue, funding_date and recording_date with ZERO writers between
//     them — they are mutable projections, not authority.
//   * NOTHING in the codebase advances
//     `acquisition_opportunities.acquisition_stage` to 'closed'. The 476 rows
//     there came from one 2026-06-21 backfill
//     (promotion_reason = backfill_from_universal_inbox_threads) with no
//     accepted seller offer, no buyer commitment and no closing case. They are
//     LEGACY IMPORTED LIFECYCLE STATUS, not V2 closing evidence, and this
//     authority is never run over them.
//   * `advance-closing-workflow.js` has a CLOSED step, but it writes the
//     CLOSING CASE stage only, and carries requires_authoritative_source: true
//     — it has no autonomous trigger.
//
// So S10 is unimplemented for the canonical lifecycle, and this builds it:
// `settlement_records` is the immutable per-leg authority, and every actual
// economic figure comes from there or stays null.
//
// THIS MODULE WRITES NOTHING AND SENDS NOTHING.

function clean(value) {
  return String(value ?? "").trim();
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(value) {
  const n = num(value);
  return n !== null && n >= 0 ? n : null;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const SETTLEMENT_STATUS = Object.freeze({
  PENDING: "pending",
  SETTLED: "settled",
  FAILED: "failed",
  REVERSED: "reversed",
});

/** A ladder, not a boolean. Initiation is not funding; receipt is not payout. */
export const FUNDING_STATUS = Object.freeze({
  EXPECTED: "expected",
  INITIATED: "initiated",
  RECEIVED: "received",
  VERIFIED: "verified",
  CLEARED: "cleared",
  DISBURSED: "disbursed",
  FAILED: "failed",
  REVERSED: "reversed",
});

const FUNDING_RANK = new Map([
  [FUNDING_STATUS.EXPECTED, 0], [FUNDING_STATUS.INITIATED, 1], [FUNDING_STATUS.RECEIVED, 2],
  [FUNDING_STATUS.VERIFIED, 3], [FUNDING_STATUS.CLEARED, 4], [FUNDING_STATUS.DISBURSED, 5],
]);

export const RECORDING_STATUS = Object.freeze({
  NOT_APPLICABLE: "not_applicable",
  PENDING: "pending",
  SUBMITTED: "submitted",
  RECORDED: "recorded",
  REJECTED: "rejected",
});

export const COMPLETION_VERDICT = Object.freeze({
  CLOSED: "closed",
  NOT_CLOSED: "not_closed",
  BLOCKED: "blocked",
});

export const COMPLETION_DENIALS = Object.freeze({
  UNSUPPORTED_STRATEGY: "unsupported_transaction_structure",
  READINESS_NOT_SATISFIED: "closing_readiness_not_satisfied",
  SELLER_CONTRACT_INVALID: "seller_contract_invalid",
  BUYER_COMMITMENT_INVALID: "buyer_commitment_invalid",
  NO_SETTLEMENT_RECORD: "no_settlement_record",
  LEG_NOT_SETTLED: "settlement_leg_not_settled",
  LEG_MISSING: "settlement_leg_missing",
  EVIDENCE_INCOMPLETE: "settlement_evidence_incomplete",
  BINDING_MISMATCH: "settlement_binds_other_transaction",
  FUNDING_NOT_COMPLETE: "funding_not_complete",
  FUNDING_FAILED: "funding_failed",
  RECORDING_PENDING: "recording_pending",
  RECORDING_REJECTED: "recording_rejected",
  STAGE_BELOW_PREPARED_TO_CLOSE: "canonical_stage_below_prepared_to_close",
});

/**
 * What completion means for each structure.
 *
 * `requires_disbursement` is the difference between "our buyer's money arrived"
 * and "the transaction settled": on an assignment we are paid out of the
 * closing, so the fee has to actually leave escrow. Recording applies where a
 * deed conveys — an assignment transfers our contractual position rather than
 * title, so the recording that matters is the one the closing itself produces
 * and is not ours to prove.
 */
export function resolveStrategyCompletionRequirements(strategy) {
  const key = clean(strategy).toLowerCase();
  switch (key) {
    case "assignment":
      return {
        strategy: key, supported: true,
        legs: ["single"],
        requires_disbursement: true,
        requires_recording: false,
        recording_reason: "assignment_conveys_contract_position_not_title",
      };
    case "double_close":
      return {
        strategy: key, supported: true,
        // Two settlements. Closing on one is closing on half a transaction.
        legs: ["a_to_b", "b_to_c"],
        requires_disbursement: true,
        requires_recording: true,
        recording_reason: "both_deeds_convey_title",
      };
    case "novation":
      return {
        strategy: key, supported: true,
        legs: ["single"],
        requires_disbursement: true,
        requires_recording: true,
        recording_reason: "novated_purchase_conveys_title",
      };
    default:
      return { strategy: key || null, supported: false, legs: [], requires_disbursement: false, requires_recording: false };
  }
}

/**
 * Is this settlement record real evidence?
 *
 * The same burden EMD verification carries: a named verifier, a timestamp, a
 * method, a provider and a chaseable reference. The database enforces the same
 * shape, so a different caller cannot route around it.
 */
export function verifySettlementEvidence(record = null) {
  if (!record) return { verified: false, reason: COMPLETION_DENIALS.NO_SETTLEMENT_RECORD, missing_fields: [] };

  const missing = [];
  if (!iso(record.closed_at)) missing.push("closed_at");
  if (!clean(record.closing_provider)) missing.push("closing_provider");
  if (!clean(record.verified_by)) missing.push("verified_by");
  if (!iso(record.verified_at)) missing.push("verified_at");
  if (!clean(record.verification_method)) missing.push("verification_method");
  if (!clean(record.evidence_reference)) missing.push("evidence_reference");

  if (clean(record.settlement_status) !== SETTLEMENT_STATUS.SETTLED) {
    return {
      verified: false,
      reason: clean(record.settlement_status) === SETTLEMENT_STATUS.FAILED
        ? COMPLETION_DENIALS.FUNDING_FAILED
        : COMPLETION_DENIALS.LEG_NOT_SETTLED,
      status: clean(record.settlement_status) || null,
      missing_fields: missing,
    };
  }
  if (missing.length) {
    return { verified: false, reason: COMPLETION_DENIALS.EVIDENCE_INCOMPLETE, missing_fields: missing };
  }
  return { verified: true, reason: "settlement_verified_with_provenance", closed_at: iso(record.closed_at) };
}

/** Does this settlement belong to THIS transaction? */
export function settlementBindsTo(record = {}, context = {}) {
  const mismatched = [];
  if (clean(record.opportunity_id) !== clean(context.opportunity_id)) mismatched.push("opportunity");
  if (clean(record.property_id) !== clean(context.property_id)) mismatched.push("property");
  if (clean(context.buyer_id) && clean(record.buyer_id) && clean(record.buyer_id) !== clean(context.buyer_id)) {
    mismatched.push("buyer");
  }
  if (clean(context.closing_case_id) && clean(record.closing_case_id) && clean(record.closing_case_id) !== clean(context.closing_case_id)) {
    mismatched.push("closing_case");
  }
  return { bound: mismatched.length === 0, mismatched };
}

/** Funding position for one leg, against what the structure requires. */
export function resolveFundingPosition(record = {}, { requiresDisbursement = true } = {}) {
  const status = clean(record.funding_status) || FUNDING_STATUS.EXPECTED;
  if (status === FUNDING_STATUS.FAILED || status === FUNDING_STATUS.REVERSED) {
    return { status, complete: false, failed: true, reason: COMPLETION_DENIALS.FUNDING_FAILED };
  }
  const rank = FUNDING_RANK.get(status) ?? 0;
  const requiredRank = requiresDisbursement
    ? FUNDING_RANK.get(FUNDING_STATUS.DISBURSED)
    : FUNDING_RANK.get(FUNDING_STATUS.VERIFIED);
  return {
    status,
    complete: rank >= requiredRank,
    failed: false,
    funded_amount: money(record.funded_amount),
    disbursed_amount: money(record.disbursed_amount),
    reason: rank >= requiredRank ? "funding_complete" : COMPLETION_DENIALS.FUNDING_NOT_COMPLETE,
  };
}

/** Recording position, honouring "not applicable" as a real answer. */
export function resolveRecordingPosition(record = {}, { requiresRecording = false } = {}) {
  const status = clean(record.recording_status) || RECORDING_STATUS.NOT_APPLICABLE;
  if (!requiresRecording) {
    return { status, complete: true, reason: "recording_not_required_for_structure" };
  }
  if (status === RECORDING_STATUS.REJECTED) {
    return { status, complete: false, reason: COMPLETION_DENIALS.RECORDING_REJECTED };
  }
  if (status !== RECORDING_STATUS.RECORDED) {
    return { status, complete: false, reason: COMPLETION_DENIALS.RECORDING_PENDING };
  }
  // A recorded status is only believable with the instrument that proves it.
  if (!clean(record.recording_instrument_id) || !iso(record.recorded_at)) {
    return { status, complete: false, reason: COMPLETION_DENIALS.EVIDENCE_INCOMPLETE, missing_fields: ["recording_instrument_id", "recorded_at"] };
  }
  return {
    status, complete: true, reason: "recorded",
    instrument_id: clean(record.recording_instrument_id),
    recorded_at: iso(record.recorded_at),
    jurisdiction: clean(record.recording_jurisdiction) || null,
  };
}

/**
 * THE completion authority. Only this may authorize S10.
 *
 * `not_closed` means outstanding work; `blocked` means something went wrong
 * (failed funding, rejected recording, an invalidated side of the deal). Both
 * refuse S10 and call for different responses.
 */
export function evaluateClosingCompletion({
  opportunity = null,
  closingReadiness = null,
  sellerContract = null,
  buyerCommitment = null,
  settlements = [],
  strategy = null,
  now = new Date(),
} = {}) {
  const missing = [];
  const blockers = [];
  const reasons = [];

  const requirements = resolveStrategyCompletionRequirements(
    strategy || buyerCommitment?.strategy || closingReadiness?.strategy,
  );

  const verdict = (v, evidence = {}, closedAt = null) => ({
    verdict: v,
    closed: v === COMPLETION_VERDICT.CLOSED,
    reasons,
    missing_requirements: missing,
    blockers,
    strategy: requirements.strategy,
    closed_at: closedAt,
    evidence,
    evaluated_at: iso(now),
  });

  if (!requirements.supported) {
    blockers.push(COMPLETION_DENIALS.UNSUPPORTED_STRATEGY);
    return verdict(COMPLETION_VERDICT.BLOCKED);
  }

  // S9 must actually have been satisfied — closing completion presupposes it.
  if (closingReadiness?.verdict !== "ready") {
    missing.push(COMPLETION_DENIALS.READINESS_NOT_SATISFIED);
    reasons.push(`readiness:${closingReadiness?.verdict ?? "absent"}`);
  }

  if (clean(sellerContract?.contract_status) !== "fully_executed") {
    blockers.push(COMPLETION_DENIALS.SELLER_CONTRACT_INVALID);
  }
  if (buyerCommitment?.committed !== true) {
    blockers.push(COMPLETION_DENIALS.BUYER_COMMITMENT_INVALID);
  }

  const context = {
    opportunity_id: clean(opportunity?.id),
    property_id: clean(opportunity?.primary_property_id),
    buyer_id: clean(buyerCommitment?.buyer_id),
    closing_case_id: clean(closingReadiness?.evidence?.closing_case_id),
  };

  const all = Array.isArray(settlements) ? settlements : [];
  const legEvidence = {};
  const closedAts = [];

  for (const leg of requirements.legs) {
    const record = all.find((r) => (clean(r.leg) || "single") === leg);
    if (!record) {
      missing.push(`${COMPLETION_DENIALS.LEG_MISSING}:${leg}`);
      legEvidence[leg] = { present: false };
      continue;
    }

    const binding = settlementBindsTo(record, context);
    if (!binding.bound) {
      blockers.push(COMPLETION_DENIALS.BINDING_MISMATCH);
      legEvidence[leg] = { present: true, bound: false, mismatched: binding.mismatched };
      continue;
    }

    const evidence = verifySettlementEvidence(record);
    const funding = resolveFundingPosition(record, { requiresDisbursement: requirements.requires_disbursement });
    const recording = resolveRecordingPosition(record, { requiresRecording: requirements.requires_recording });

    legEvidence[leg] = {
      present: true, bound: true,
      settlement_status: clean(record.settlement_status) || null,
      settlement_verified: evidence.verified,
      settlement_missing_fields: evidence.missing_fields ?? [],
      funding, recording,
      settlement_statement_reference: clean(record.settlement_statement_reference) || null,
      closed_at: iso(record.closed_at),
    };

    if (!evidence.verified) {
      if (evidence.reason === COMPLETION_DENIALS.FUNDING_FAILED) blockers.push(COMPLETION_DENIALS.FUNDING_FAILED);
      else missing.push(`${evidence.reason}:${leg}`);
      reasons.push(`${leg}:${evidence.reason}`);
      continue;
    }
    if (funding.failed) { blockers.push(COMPLETION_DENIALS.FUNDING_FAILED); reasons.push(`${leg}:funding_failed`); continue; }
    if (!funding.complete) { missing.push(`${COMPLETION_DENIALS.FUNDING_NOT_COMPLETE}:${leg}`); reasons.push(`${leg}:funding:${funding.status}`); continue; }
    if (!recording.complete) {
      if (recording.reason === COMPLETION_DENIALS.RECORDING_REJECTED) blockers.push(COMPLETION_DENIALS.RECORDING_REJECTED);
      else missing.push(`${recording.reason}:${leg}`);
      reasons.push(`${leg}:recording:${recording.status}`);
      continue;
    }
    closedAts.push(evidence.closed_at);
  }

  const evidence = { requirements, legs: legEvidence };

  if (blockers.length) return verdict(COMPLETION_VERDICT.BLOCKED, evidence);
  if (missing.length) return verdict(COMPLETION_VERDICT.NOT_CLOSED, evidence);

  // The transaction closed when its LAST required leg settled.
  const closedAt = closedAts.sort().slice(-1)[0] ?? null;
  reasons.push("all_settlement_evidence_verified");
  return verdict(COMPLETION_VERDICT.CLOSED, evidence, closedAt);
}

// ─── The S10 gate ───────────────────────────────────────────────────────────

const STAGE_ORDER = Object.freeze([
  "ownership_confirmation", "offer_interest", "asking_price", "property_condition",
  "offer", "formal_contract", "disposition", "under_contract", "prepared_to_close", "closed",
]);
const STAGE_RANK = new Map(STAGE_ORDER.map((s, i) => [s, i]));
const PREPARED_RANK = STAGE_RANK.get("prepared_to_close");

/**
 * Only this may authorize S9 -> S10.
 *
 * A generic field is never sufficient: `closing_status='closed'`, a passed
 * `scheduled_closing_date`, a populated `funding_status`, a populated recording
 * field, a populated `assignment_fee`, or an operator asserting completion
 * without evidence are all inputs to a verdict, never a verdict.
 */
export function authorizeClosed({ opportunity = null, completion = null } = {}) {
  const deny = (reason, evidence = {}) => ({ authorized: false, reason, evidence, stage: opportunity?.acquisition_stage ?? null });

  if (!opportunity?.id) return deny("no_opportunity");

  const rank = STAGE_RANK.get(clean(opportunity.acquisition_stage));
  if (!Number.isInteger(rank) || rank < PREPARED_RANK) {
    return deny(COMPLETION_DENIALS.STAGE_BELOW_PREPARED_TO_CLOSE, { canonical_stage: opportunity.acquisition_stage ?? null });
  }

  if (completion?.verdict !== COMPLETION_VERDICT.CLOSED) {
    return deny(completion?.verdict === COMPLETION_VERDICT.BLOCKED ? "closing_blocked" : "closing_not_complete", {
      completion_verdict: completion?.verdict ?? null,
      missing_requirements: completion?.missing_requirements ?? [],
      blockers: completion?.blockers ?? [],
    });
  }

  return {
    authorized: true,
    reason: "settlement_evidence_verified",
    /** Terminal. Nothing advances beyond it and nothing normal regresses it. */
    stage: "closed",
    terminal: true,
    closed_at: completion.closed_at,
    evidence: completion.evidence,
    evaluated_at: completion.evaluated_at,
  };
}

/**
 * Legacy `closed` rows are lifecycle STATUS, not V2 closing evidence.
 *
 * The 476 backfilled rows carry no accepted seller offer, no buyer commitment
 * and no closing case. Running the completion authority over them would either
 * fail (correctly) or, worse, invite someone to backfill evidence to make them
 * pass. This classifies instead, and the authority is never run over them.
 */
export function classifyLegacyClosedRow(row = {}) {
  const backfilled = clean(row.promotion_reason) === "backfill_from_universal_inbox_threads";
  const hasV2Evidence = Boolean(clean(row.accepted_offer_id) || clean(row.settlement_id) || clean(row.closing_case_id));
  if (hasV2Evidence) return { classification: "current_v2", v2_closing_evidence: true };
  if (backfilled) {
    return {
      classification: "legacy_imported",
      v2_closing_evidence: false,
      note: "lifecycle status imported 2026-06-21; not evidence that S10 authority was satisfied",
    };
  }
  return { classification: "unknown", v2_closing_evidence: false };
}

/**
 * Post-close corrections do not erase the close.
 *
 * A reversal after S10 is a new fact about a transaction that really did
 * complete, so the stage stays terminal and the exception is recorded
 * alongside it.
 */
export function resolvePostCloseException({ currentStage = null, exception = null, note = null } = {}) {
  if (!clean(exception)) {
    return { stage: currentStage, post_close_exception: null, stage_regressed: false };
  }
  return {
    stage: currentStage,
    stage_regressed: false,
    terminal: true,
    post_close_exception: clean(exception),
    post_close_exception_note: clean(note) || null,
    /** No post-close recovery workflow exists yet; this is the seam. */
    recovery_workflow_implemented: false,
  };
}

// ─── Economics ──────────────────────────────────────────────────────────────

/**
 * Estimated and actual, side by side, never merged.
 *
 * A missing actual stays null. Backfilling it from the estimate would turn a
 * forecast into a settlement fact, which is the single thing this separation
 * exists to prevent.
 */
export function resolveFinalEconomics({ estimated = null, settlements = [], strategy = null } = {}) {
  const requirements = resolveStrategyCompletionRequirements(strategy);
  const settled = (Array.isArray(settlements) ? settlements : [])
    .filter((r) => clean(r.settlement_status) === SETTLEMENT_STATUS.SETTLED);

  const sum = (field) => {
    const values = settled.map((r) => num(r[field])).filter((v) => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };

  const actual = {
    seller_acquisition_amount: sum("actual_seller_amount"),
    buyer_settlement_amount: sum("actual_buyer_amount"),
    assignment_fee: sum("actual_assignment_fee"),
    closing_costs: sum("actual_closing_costs"),
    other_costs: sum("actual_other_costs"),
    net_proceeds: sum("actual_net_proceeds"),
    settlement_statement_references: settled
      .map((r) => clean(r.settlement_statement_reference)).filter(Boolean),
  };

  // Only compute a net we can actually stand behind; otherwise leave it null
  // with the reason, exactly as S9 did.
  let netReason = null;
  if (actual.net_proceeds === null) {
    if (!settled.length) netReason = "no_settled_leg";
    else if (!actual.settlement_statement_references.length) netReason = "settlement_statement_not_provided";
    else netReason = "net_not_reported_on_settlement_statement";
  }

  return {
    strategy: requirements.strategy,
    estimated: {
      seller_acquisition_price: num(estimated?.seller_acquisition_price),
      buyer_price: num(estimated?.buyer_price),
      gross_spread: num(estimated?.gross_spread),
      known_closing_costs: num(estimated?.known_closing_costs),
    },
    actual,
    net_proceeds_reason: netReason,
    /** Proof that neither side was derived from the other. */
    actual_derived_from_estimate: false,
  };
}

// ─── Final transaction record ───────────────────────────────────────────────

/**
 * The answer to "why do we believe this closed?", and the frontend contract.
 *
 * Every claim traces to evidence a person can chase, and nothing here requires
 * reading a seller or buyer message.
 */
export function buildFinalTransactionRecord({
  closingHandoff = null,
  authorization = null,
  settlements = [],
  estimated = null,
} = {}) {
  if (!authorization?.authorized) {
    return { ok: false, reason: authorization?.reason ?? "not_authorized", evidence: authorization?.evidence ?? null };
  }
  if (!closingHandoff?.ok) return { ok: false, reason: "closing_handoff_unavailable" };

  const strategy = authorization.evidence?.requirements?.strategy ?? null;
  const legs = authorization.evidence?.legs ?? {};
  const settled = (Array.isArray(settlements) ? settlements : [])
    .filter((r) => clean(r.settlement_status) === SETTLEMENT_STATUS.SETTLED);
  const primary = settled[settled.length - 1] ?? null;

  return {
    ok: true,
    stage: "closed",
    terminal: true,
    closed_at: authorization.closed_at,
    strategy,

    disposition_case_id: closingHandoff.disposition_case_id,
    acquisition_opportunity_id: closingHandoff.acquisition_opportunity_id,
    property_id: closingHandoff.property_id,

    closing_provider: clean(primary?.closing_provider) || null,

    /** §29 — why we believe this closed, without interpreting any message. */
    why_we_believe_this_closed: {
      seller_contract: closingHandoff.seller?.seller_contract_execution ?? null,
      buyer_commitment: closingHandoff.buyer?.buyer_commitment_evidence ?? null,
      title_readiness: closingHandoff.title ?? null,
      emd: closingHandoff.emd ?? null,
      readiness_verdict: closingHandoff.closing?.readiness_verdict ?? null,
      readiness_evaluated_at: closingHandoff.closing?.readiness_evaluated_at ?? null,
      settlement_legs: legs,
      verification: {
        verified_by: clean(primary?.verified_by) || null,
        verified_at: iso(primary?.verified_at),
        verification_method: clean(primary?.verification_method) || null,
        evidence_reference: clean(primary?.evidence_reference) || null,
      },
    },

    funding: {
      status: clean(primary?.funding_status) || null,
      funded_amount: money(primary?.funded_amount),
      disbursed_amount: money(primary?.disbursed_amount),
    },

    recording: {
      required: authorization.evidence?.requirements?.requires_recording === true,
      status: clean(primary?.recording_status) || RECORDING_STATUS.NOT_APPLICABLE,
      instrument_id: clean(primary?.recording_instrument_id) || null,
      recorded_at: iso(primary?.recorded_at),
      jurisdiction: clean(primary?.recording_jurisdiction) || null,
    },

    settlement_evidence_status: settled.length === (authorization.evidence?.requirements?.legs?.length ?? 0)
      ? "complete" : "incomplete",

    economics: resolveFinalEconomics({ estimated, settlements, strategy }),

    /** §23 — downstream events this close ENABLES. None are emitted here. */
    downstream_events: {
      revenue_event: "pending_revenue_authority",
      buyer_history_update: "pending_buyer_intelligence_consumer",
      operator_notification: "not_sent",
      seller_closing_confirmation: "not_sent",
      campaign_suppression: "pending_consumer",
    },
  };
}

export default evaluateClosingCompletion;
