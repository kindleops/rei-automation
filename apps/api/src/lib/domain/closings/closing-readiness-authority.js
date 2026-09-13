// ─── closing-readiness-authority.js ─────────────────────────────────────────
// THE S9 gate. `prepared_to_close` means one thing:
//
//   this transaction has VERIFIED title/escrow, deposit, document and closing
//   conditions sufficient to proceed to actual closing.
//
// It does NOT mean: buyer agreement signed · title company selected · a title
// order was created · EMD promised · an EMD amount sits on an agreement · a
// closing date is populated · someone marked the deal "ready" · a calendar
// event exists.
//
// ARCHAEOLOGY (2026-09-13), and what it changes:
//
//   * `closing_cases` IS the closing orchestration object and is reused. Its
//     title fields are real but THIN: `title_route_status` is only
//     routed/title_route_unavailable, which is title-company SELECTION, and
//     `title_status` receives 'opened' from a closing event that carries
//     `requires_authoritative_source: true` — it has no autonomous trigger.
//     There is no title commitment, defect, lien or clear-to-close model at
//     all, so this module consumes an explicit readiness verdict built from
//     structured facts rather than pretending one exists.
//   * `wire_events` exists but cannot carry EMD receipt: its property_id,
//     buyer_id, closing_id and deal_revenue_id are `bigint` Podio item ids with
//     a `created_by_discord_user_id`, and it models revenue forecasting for a
//     Discord command centre. An unbindable deposit must never satisfy a
//     requirement. `emd_receipts` is the new canonical authority.
//   * Production: 53 title companies routed, 0 closing milestones, 0 activity
//     events, 0 wire events, 1 closing case (the voided $4,100 deal), 0
//     opportunities at prepared_to_close.
//
// THE INVARIANTS
//   emd_amount           != emd_received
//   emd_received         != emd_verified
//   title_company        != title_opened
//   title_opened         != title_clear
//   a populated field    != a satisfied requirement
//
// THIS MODULE WRITES NOTHING AND SENDS NOTHING.

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── EMD ────────────────────────────────────────────────────────────────────

export const EMD_RECEIPT_STATUS = Object.freeze({
  RECEIVED_UNVERIFIED: "received_unverified",
  VERIFIED: "verified",
  FAILED: "failed",
  REFUNDED: "refunded",
  DISPUTED: "disputed",
});

/** The aggregate deposit position for a deal, not one receipt's status. */
export const EMD_SATISFACTION = Object.freeze({
  NOT_REQUIRED: "not_required",
  MISSING: "missing",
  UNVERIFIED: "received_unverified",
  PARTIAL: "partial",
  SATISFIED: "satisfied",
  OVERFUNDED: "overfunded",
  WAIVED: "waived",
  FAILED: "failed",
});

export const VERIFICATION_METHODS = Object.freeze({
  MANUAL_OPERATOR: "manual_operator",
  TITLE_PROVIDER: "title_provider",
  BANK_FEED: "bank_feed",
  DOCUMENT_UPLOAD: "document_upload",
});

/**
 * Is this one deposit report actually verified?
 *
 * There is no bank feed and no escrow-provider webhook in this product, so the
 * only reachable path today is a named human. That is why an operator checkbox
 * is not enough on its own: a verifier, a method, an amount, a destination and
 * a chaseable evidence reference are all required, and the same constraint is
 * enforced by the database so it cannot be bypassed by a different caller.
 */
export function verifyEmdReceipt({
  receipt = null,
  requiredFields = true,
} = {}) {
  if (!receipt) return { verified: false, reason: "no_receipt" };

  const missing = [];
  if (!money(receipt.amount)) missing.push("amount");
  if (!clean(receipt.escrow_destination)) missing.push("escrow_destination");
  if (!iso(receipt.received_at)) missing.push("received_at");
  if (!clean(receipt.buyer_id)) missing.push("buyer_id");
  if (!clean(receipt.property_id)) missing.push("property_id");
  if (!clean(receipt.buyer_offer_id)) missing.push("buyer_offer_id");

  if (clean(receipt.status) !== EMD_RECEIPT_STATUS.VERIFIED) {
    return {
      verified: false,
      reason: "receipt_not_verified",
      status: clean(receipt.status) || null,
      missing_fields: missing,
    };
  }

  if (requiredFields) {
    if (!clean(receipt.verified_by)) missing.push("verified_by");
    if (!iso(receipt.verified_at)) missing.push("verified_at");
    if (!clean(receipt.verification_method)) missing.push("verification_method");
    // The thing that turns a claim into evidence someone else can check.
    if (!clean(receipt.evidence_reference)) missing.push("evidence_reference");
  }

  if (missing.length) {
    return { verified: false, reason: "verification_provenance_incomplete", missing_fields: missing };
  }
  return { verified: true, reason: "verified_with_provenance", amount: money(receipt.amount) };
}

/**
 * Does a receipt belong to THIS deal?
 *
 * A $5,000 deposit from Buyer A cannot satisfy Buyer B, and a deposit on
 * Property A cannot satisfy Property B. Multi-property buyers make this a real
 * hazard rather than a theoretical one.
 */
export function receiptBindsTo(receipt = {}, context = {}) {
  const mismatched = [];
  if (clean(receipt.opportunity_id) !== clean(context.opportunity_id)) mismatched.push("opportunity");
  if (clean(receipt.property_id) !== clean(context.property_id)) mismatched.push("property");
  if (clean(receipt.buyer_id) !== clean(context.buyer_id)) mismatched.push("buyer");
  if (clean(context.buyer_offer_id) && clean(receipt.buyer_offer_id) !== clean(context.buyer_offer_id)) {
    mismatched.push("buyer_offer");
  }
  return { bound: mismatched.length === 0, mismatched };
}

/**
 * Aggregate deposit position: required terms vs verified receipts.
 *
 * Discrepancies are never rounded away or ignored — `partial`, `overfunded`
 * and `mismatched` are distinct answers because they call for different human
 * action.
 */
export function resolveEmdSatisfaction({
  requiredAmount = null,
  waiver = null,
  receipts = [],
  context = {},
} = {}) {
  const required = money(requiredAmount);

  // A waiver is an authoritative transaction term, not an absence of evidence,
  // so it needs the same provenance a verification needs.
  if (waiver) {
    const ok = clean(waiver.waived_by) && iso(waiver.waived_at) && clean(waiver.reason);
    if (!ok) {
      return { status: EMD_SATISFACTION.MISSING, satisfied: false, reason: "waiver_provenance_incomplete", required_amount: required, verified_amount: 0 };
    }
    return {
      status: EMD_SATISFACTION.WAIVED, satisfied: true, reason: "emd_waived_by_terms",
      required_amount: required, verified_amount: 0,
      waiver: { waived_by: waiver.waived_by, waived_at: iso(waiver.waived_at), reason: waiver.reason },
    };
  }

  if (required === null) {
    return { status: EMD_SATISFACTION.NOT_REQUIRED, satisfied: true, reason: "no_emd_required", required_amount: null, verified_amount: 0 };
  }

  const all = Array.isArray(receipts) ? receipts : [];
  const bound = [];
  const unbound = [];
  for (const receipt of all) {
    const binding = receiptBindsTo(receipt, context);
    if (binding.bound) bound.push(receipt);
    else unbound.push({ receipt_id: receipt.receipt_id ?? null, mismatched: binding.mismatched });
  }

  const failed = bound.filter((r) => [EMD_RECEIPT_STATUS.FAILED, EMD_RECEIPT_STATUS.REFUNDED, EMD_RECEIPT_STATUS.DISPUTED].includes(clean(r.status)));
  const verified = bound.filter((r) => verifyEmdReceipt({ receipt: r }).verified);
  const unverified = bound.filter((r) => clean(r.status) === EMD_RECEIPT_STATUS.RECEIVED_UNVERIFIED);

  const verifiedAmount = verified.reduce((sum, r) => sum + (money(r.amount) ?? 0), 0);
  const base = {
    required_amount: required,
    verified_amount: verifiedAmount,
    unverified_count: unverified.length,
    ignored_unbound_receipts: unbound,
  };

  if (failed.length && verifiedAmount < required) {
    return { ...base, status: EMD_SATISFACTION.FAILED, satisfied: false, reason: "deposit_failed_or_refunded" };
  }
  if (verifiedAmount === 0) {
    // An unverified report is progress, not proof.
    return {
      ...base,
      status: unverified.length ? EMD_SATISFACTION.UNVERIFIED : EMD_SATISFACTION.MISSING,
      satisfied: false,
      reason: unverified.length ? "received_but_not_verified" : "no_verified_deposit",
    };
  }
  if (verifiedAmount < required) {
    return { ...base, status: EMD_SATISFACTION.PARTIAL, satisfied: false, reason: "verified_amount_below_requirement" };
  }
  if (verifiedAmount > required) {
    // Satisfied, but flagged rather than silently accepted — an overpayment is
    // a reconciliation question someone has to answer at settlement.
    return { ...base, status: EMD_SATISFACTION.OVERFUNDED, satisfied: true, reason: "verified_amount_above_requirement" };
  }
  return { ...base, status: EMD_SATISFACTION.SATISFIED, satisfied: true, reason: "verified_amount_matches_requirement" };
}

// ─── Title ──────────────────────────────────────────────────────────────────

export const TITLE_STATE = Object.freeze({
  NOT_SELECTED: "not_selected",
  COMPANY_SELECTED: "title_company_selected",
  ORDER_REQUESTED: "title_order_requested",
  OPENED: "title_opened",
  SEARCH_IN_PROGRESS: "title_search_in_progress",
  COMMITMENT_RECEIVED: "title_commitment_received",
  CLEAR: "title_clear",
  ISSUE: "title_issue",
  CANCELLED: "title_cancelled",
});

/** Explicit blockers. Never collapsed into a single "not_ready". */
export const CLOSING_HOLD_REASONS = Object.freeze({
  TITLE_NOT_OPENED: "title_not_opened",
  TITLE_NOT_CLEAR: "title_not_clear",
  TITLE_CANCELLED: "title_cancelled",
  UNRESOLVED_LIEN: "unresolved_lien",
  OWNERSHIP_DEFECT: "ownership_defect",
  PROBATE_UNRESOLVED: "probate_unresolved",
  PAYOFF_MISSING: "payoff_missing",
  TAX_DELINQUENCY_UNRESOLVED: "tax_delinquency_unresolved",
  HOA_UNRESOLVED: "hoa_unresolved",
  JUDGMENT_UNRESOLVED: "judgment_unresolved",
  MUNICIPAL_ISSUE: "municipal_issue",
  SIGNER_IDENTITY_MISMATCH: "signer_identity_mismatch",
  COMMITMENT_MISSING: "title_commitment_missing",
  EMD_NOT_SATISFIED: "emd_not_satisfied",
  DOCUMENT_MISSING: "required_document_missing",
  SELLER_CONTRACT_INVALID: "seller_contract_invalid",
  BUYER_COMMITMENT_INVALID: "buyer_commitment_invalid",
  CLOSING_DATE_MISSING: "confirmed_closing_date_missing",
  OPERATOR_HOLD: "operator_hold",
});

/**
 * Title readiness from structured facts.
 *
 * A named title company is selection, not opening — `title_company_name`
 * populated on a closing case says who we intend to use and nothing about
 * whether a file exists. Each stage is distinct because each blocks for a
 * different reason and needs different work to clear.
 */
export function resolveTitleReadiness({ closingCase = null, titleFacts = null } = {}) {
  const facts = titleFacts || {};
  const holds = [];

  if (clean(facts.title_state) === TITLE_STATE.CANCELLED) {
    return { state: TITLE_STATE.CANCELLED, ready: false, holds: [CLOSING_HOLD_REASONS.TITLE_CANCELLED] };
  }

  const companySelected = Boolean(clean(closingCase?.title_company_name) || clean(closingCase?.title_company_id));
  const opened = clean(facts.title_state) === TITLE_STATE.OPENED
    || clean(facts.title_state) === TITLE_STATE.SEARCH_IN_PROGRESS
    || clean(facts.title_state) === TITLE_STATE.COMMITMENT_RECEIVED
    || clean(facts.title_state) === TITLE_STATE.CLEAR
    || clean(closingCase?.title_status) === "opened";

  if (!opened) {
    holds.push(CLOSING_HOLD_REASONS.TITLE_NOT_OPENED);
    return {
      state: companySelected ? TITLE_STATE.COMPANY_SELECTED : TITLE_STATE.NOT_SELECTED,
      ready: false,
      holds,
    };
  }

  if (facts.commitment_received !== true) holds.push(CLOSING_HOLD_REASONS.COMMITMENT_MISSING);

  // Structured defects. Each is reported individually so an operator sees the
  // actual work rather than a verdict.
  const defectMap = [
    ["unresolved_liens", CLOSING_HOLD_REASONS.UNRESOLVED_LIEN],
    ["ownership_defect", CLOSING_HOLD_REASONS.OWNERSHIP_DEFECT],
    ["probate_unresolved", CLOSING_HOLD_REASONS.PROBATE_UNRESOLVED],
    ["payoff_missing", CLOSING_HOLD_REASONS.PAYOFF_MISSING],
    ["tax_delinquency_unresolved", CLOSING_HOLD_REASONS.TAX_DELINQUENCY_UNRESOLVED],
    ["hoa_unresolved", CLOSING_HOLD_REASONS.HOA_UNRESOLVED],
    ["judgment_unresolved", CLOSING_HOLD_REASONS.JUDGMENT_UNRESOLVED],
    ["municipal_issue", CLOSING_HOLD_REASONS.MUNICIPAL_ISSUE],
    ["signer_identity_mismatch", CLOSING_HOLD_REASONS.SIGNER_IDENTITY_MISMATCH],
  ];
  for (const [factKey, hold] of defectMap) {
    const value = facts[factKey];
    if (value === true || (Array.isArray(value) && value.length)) holds.push(hold);
  }

  if (facts.clear_to_close !== true && !holds.includes(CLOSING_HOLD_REASONS.COMMITMENT_MISSING)) {
    holds.push(CLOSING_HOLD_REASONS.TITLE_NOT_CLEAR);
  }

  if (holds.length) return { state: TITLE_STATE.ISSUE, ready: false, holds };
  return { state: TITLE_STATE.CLEAR, ready: true, holds: [] };
}

// ─── Strategy-aware requirements ────────────────────────────────────────────

/**
 * What each disposition structure must have before it can close. A double
 * close has two settlements and a funding question an assignment does not, and
 * forcing every strategy through assignment semantics would quietly approve a
 * deal missing half its requirements.
 */
export function resolveStrategyClosingRequirements(strategy) {
  const key = clean(strategy).toLowerCase() || "assignment";
  const base = ["seller_contract_fully_executed", "buyer_agreement_fully_executed", "title_clear"];
  switch (key) {
    case "assignment":
      return { strategy: key, supported: true, required_documents: [...base, "assignment_agreement"] };
    case "double_close":
      return {
        strategy: key, supported: true,
        required_documents: [...base, "buyer_purchase_agreement", "ab_settlement_statement", "bc_settlement_statement"],
        requires_funding_coordination: true,
      };
    case "novation":
      return { strategy: key, supported: true, required_documents: [...base, "novation_agreement", "seller_consent"] };
    default:
      return { strategy: key, supported: false, required_documents: [] };
  }
}

// ─── Closing date ───────────────────────────────────────────────────────────

/**
 * Four different dates are routinely conflated. S9 exposes the CONFIRMED one
 * and refuses to treat a populated target as a settlement appointment.
 */
export function resolveClosingDate({ buyerAgreement = null, closingCase = null, settlement = null } = {}) {
  return {
    contractual_closing_date: buyerAgreement?.closing_date ?? null,
    target_closing_date: closingCase?.scheduled_closing_date ?? null,
    scheduled_settlement_at: settlement?.scheduled_at ?? null,
    confirmed_closing_date: settlement?.confirmed === true ? (settlement.confirmed_date ?? settlement.scheduled_at ?? null) : null,
    confirmed: settlement?.confirmed === true,
  };
}

// ─── THE readiness authority ────────────────────────────────────────────────

export const READINESS_VERDICT = Object.freeze({
  READY: "ready",
  NOT_READY: "not_ready",
  BLOCKED: "blocked",
});

/**
 * One canonical verdict. S9 semantics live here and nowhere else — not in the
 * UI, not in a worker, not in a webhook.
 *
 * `not_ready` means work is outstanding. `blocked` means something is wrong
 * that will not clear by continuing — a title defect, a failed deposit, an
 * invalidated contract. Both refuse S9; they call for different responses.
 */
export function evaluateClosingReadiness({
  opportunity = null,
  sellerContract = null,
  buyerCommitment = null,
  buyerAgreement = null,
  closingCase = null,
  titleFacts = null,
  emdReceipts = [],
  emdWaiver = null,
  documents = null,
  settlement = null,
  holds = [],
  now = new Date(),
} = {}) {
  const reasons = [];
  const missing = [];
  const blockers = [];

  const strategy = clean(buyerAgreement?.strategy || buyerCommitment?.strategy) || "assignment";
  const requirements = resolveStrategyClosingRequirements(strategy);

  const verdict = (v, evidence = {}) => ({
    verdict: v,
    ready: v === READINESS_VERDICT.READY,
    reasons,
    missing_requirements: missing,
    blockers,
    strategy,
    evidence,
    evaluated_at: iso(now),
  });

  if (!requirements.supported) {
    blockers.push("unsupported_disposition_strategy");
    return verdict(READINESS_VERDICT.BLOCKED);
  }

  // ── Seller side still valid ──────────────────────────────────────────────
  if (clean(sellerContract?.contract_status) !== "fully_executed") {
    blockers.push(CLOSING_HOLD_REASONS.SELLER_CONTRACT_INVALID);
    reasons.push("seller_contract_not_fully_executed");
  }

  // ── Buyer side still valid ───────────────────────────────────────────────
  if (buyerCommitment?.committed !== true) {
    blockers.push(CLOSING_HOLD_REASONS.BUYER_COMMITMENT_INVALID);
    reasons.push("buyer_not_committed");
  }

  // ── Title ────────────────────────────────────────────────────────────────
  const title = resolveTitleReadiness({ closingCase, titleFacts });
  if (!title.ready) {
    for (const hold of title.holds) {
      // A missing commitment is outstanding work; a defect is a blocker.
      if (hold === CLOSING_HOLD_REASONS.TITLE_NOT_OPENED || hold === CLOSING_HOLD_REASONS.COMMITMENT_MISSING) missing.push(hold);
      else blockers.push(hold);
    }
    reasons.push(`title_state:${title.state}`);
  }

  // ── EMD ──────────────────────────────────────────────────────────────────
  const emd = resolveEmdSatisfaction({
    requiredAmount: buyerAgreement?.emd_terms ?? buyerCommitment?.emd_terms ?? null,
    waiver: emdWaiver,
    receipts: emdReceipts,
    context: {
      opportunity_id: clean(opportunity?.id),
      property_id: clean(opportunity?.primary_property_id),
      buyer_id: clean(buyerCommitment?.buyer_id ?? buyerAgreement?.buyer_id),
      buyer_offer_id: clean(buyerCommitment?.buyer_offer_id ?? buyerAgreement?.buyer_offer_id),
    },
  });
  if (!emd.satisfied) {
    if (emd.status === EMD_SATISFACTION.FAILED) blockers.push(CLOSING_HOLD_REASONS.EMD_NOT_SATISFIED);
    else missing.push(CLOSING_HOLD_REASONS.EMD_NOT_SATISFIED);
    reasons.push(`emd:${emd.status}`);
  }

  // ── Documents ────────────────────────────────────────────────────────────
  const provided = new Set((Array.isArray(documents?.complete) ? documents.complete : []).map(clean));
  const outstandingDocs = requirements.required_documents.filter((doc) => !provided.has(doc));
  if (outstandingDocs.length) {
    missing.push(CLOSING_HOLD_REASONS.DOCUMENT_MISSING);
    reasons.push(`documents_outstanding:${outstandingDocs.join(",")}`);
  }

  // ── Closing date ─────────────────────────────────────────────────────────
  const dates = resolveClosingDate({ buyerAgreement, closingCase, settlement });
  if (!dates.confirmed) {
    missing.push(CLOSING_HOLD_REASONS.CLOSING_DATE_MISSING);
    reasons.push("closing_date_not_confirmed");
  }

  // ── Explicit operator/legal holds ────────────────────────────────────────
  for (const hold of Array.isArray(holds) ? holds : []) {
    if (clean(hold)) blockers.push(clean(hold));
  }

  const evidence = {
    title: { state: title.state, holds: title.holds },
    emd,
    documents_outstanding: outstandingDocs,
    closing_date: dates,
    required_documents: requirements.required_documents,
  };

  if (blockers.length) return verdict(READINESS_VERDICT.BLOCKED, evidence);
  if (missing.length) return verdict(READINESS_VERDICT.NOT_READY, evidence);
  reasons.push("all_closing_conditions_satisfied");
  return verdict(READINESS_VERDICT.READY, evidence);
}

// ─── The S9 gate ────────────────────────────────────────────────────────────

const STAGE_ORDER = Object.freeze([
  "ownership_confirmation", "offer_interest", "asking_price", "property_condition",
  "offer", "formal_contract", "disposition", "under_contract", "prepared_to_close", "closed",
]);
const STAGE_RANK = new Map(STAGE_ORDER.map((s, i) => [s, i]));
const UNDER_CONTRACT_RANK = STAGE_RANK.get("under_contract");

/**
 * Only this may authorize S8 -> S9.
 *
 * A populated closing-case field is never sufficient: a `closing_date`, a
 * `title_company_name`, a `buyer_emd` amount, a `contract_status` or a
 * `disposition_status` are all inputs to a verdict, never a verdict.
 */
export function authorizePreparedToClose({
  opportunity = null,
  readiness = null,
} = {}) {
  const deny = (reason, evidence = {}) => ({ authorized: false, reason, evidence, stage: opportunity?.acquisition_stage ?? null });

  if (!opportunity?.id) return deny("no_opportunity");

  const rank = STAGE_RANK.get(clean(opportunity.acquisition_stage));
  if (!Number.isInteger(rank) || rank < UNDER_CONTRACT_RANK) {
    return deny("canonical_stage_below_under_contract", { canonical_stage: opportunity.acquisition_stage ?? null });
  }

  if (readiness?.verdict !== READINESS_VERDICT.READY) {
    return deny(readiness?.verdict === READINESS_VERDICT.BLOCKED ? "closing_blocked" : "closing_not_ready", {
      readiness_verdict: readiness?.verdict ?? null,
      missing_requirements: readiness?.missing_requirements ?? [],
      blockers: readiness?.blockers ?? [],
    });
  }

  return {
    authorized: true,
    reason: "closing_conditions_verified",
    /** The ONE thing that may set S9. */
    stage: "prepared_to_close",
    evidence: readiness.evidence,
    evaluated_at: readiness.evaluated_at,
  };
}

/**
 * A blocker appearing AFTER S9 does not rewind the stage — the transaction
 * really is under contract with verified conditions that have since changed.
 * It stops closing operations and records why.
 */
export function resolvePostReadinessBlocker({ currentStage = null, blockers = [] } = {}) {
  const list = (Array.isArray(blockers) ? blockers : []).filter(Boolean);
  if (!list.length) return { stage: currentStage, closing_readiness_status: READINESS_VERDICT.READY, operations_halted: false };
  return {
    stage: currentStage,
    stage_regressed: false,
    closing_readiness_status: READINESS_VERDICT.BLOCKED,
    operations_halted: true,
    blockers: list,
    /** No recovery workflow exists yet; this is the seam, not the fix. */
    recovery_workflow_implemented: false,
  };
}

// ─── S10 handoff ────────────────────────────────────────────────────────────

/**
 * Everything S10 consumes. Available only once S9 is authorized.
 *
 * Deliberately absent: net profit, final proceeds, final assignment profit.
 * Those require actual settlement numbers, and no estimate may become S10
 * financial truth.
 */
export function buildClosingHandoff({
  buyerCommitmentHandoff = null,
  authorization = null,
  closingCase = null,
  titleFacts = null,
  deadlines = null,
} = {}) {
  if (!authorization?.authorized) {
    return { ok: false, reason: authorization?.reason ?? "not_authorized", evidence: authorization?.evidence ?? null };
  }
  if (!buyerCommitmentHandoff?.ok) return { ok: false, reason: "buyer_commitment_handoff_unavailable" };

  const evidence = authorization.evidence || {};
  const known = money(closingCase?.closing_costs);

  return {
    ok: true,
    stage: "prepared_to_close",
    disposition_case_id: buyerCommitmentHandoff.disposition_case_id,
    acquisition_opportunity_id: buyerCommitmentHandoff.acquisition_opportunity_id,
    property_id: buyerCommitmentHandoff.property_id,
    strategy: evidence.emd ? buyerCommitmentHandoff.economics?.strategy ?? null : null,

    seller: buyerCommitmentHandoff.seller,
    buyer: buyerCommitmentHandoff.buyer,

    title: {
      closing_case_id: closingCase?.closing_case_id ?? null,
      title_company_name: closingCase?.title_company_name ?? null,
      title_company_key: closingCase?.title_company_key ?? null,
      title_state: evidence.title?.state ?? null,
      clear_to_close: titleFacts?.clear_to_close === true,
      blocking_issues: evidence.title?.holds ?? [],
    },

    emd: {
      required_amount: evidence.emd?.required_amount ?? null,
      verified_amount: evidence.emd?.verified_amount ?? 0,
      status: evidence.emd?.status ?? null,
      satisfied: evidence.emd?.satisfied === true,
      waiver: evidence.emd?.waiver ?? null,
    },

    documents: { required: evidence.required_documents ?? [], outstanding: evidence.documents_outstanding ?? [] },

    closing: {
      confirmed_closing_date: evidence.closing_date?.confirmed_closing_date ?? null,
      contractual_closing_date: evidence.closing_date?.contractual_closing_date ?? null,
      readiness_verdict: READINESS_VERDICT.READY,
      readiness_evaluated_at: authorization.evaluated_at,
      outstanding_blockers: [],
    },

    economics: {
      ...(buyerCommitmentHandoff.economics || {}),
      known_closing_costs: known,
      // Net stays unknown until actual settlement numbers exist. No estimate
      // may become S10 financial truth.
      net_proceeds: null,
      net_proceeds_reason: known === null ? "closing_costs_unknown" : "settlement_statement_not_final",
    },

    deadlines: {
      emd_due_date: closingCase?.emd_due_date ?? deadlines?.emd_due_date ?? null,
      inspection_deadline: closingCase?.inspection_deadline ?? deadlines?.inspection_deadline ?? null,
      cure_deadline: closingCase?.cure_deadline ?? deadlines?.cure_deadline ?? null,
      scheduled_closing_date: closingCase?.scheduled_closing_date ?? null,
    },
  };
}

export default evaluateClosingReadiness;
