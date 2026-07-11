// ─── resolve-seller-stage-transition.js ─────────────────────────────────────
// Canonical deterministic stage-transition resolver for the S1–S10 seller
// lifecycle. The classifier/LLM layer supplies intents, extracted facts,
// sentiment and confidence; ONLY this resolver decides lifecycle state.
//
// Invariants:
//   • Stage is the next unresolved lifecycle milestone.
//   • Stage advancement is monotonic — stage_after is never below stage_before.
//   • A single message may advance multiple stages when it resolves multiple
//     milestones (e.g. price + condition in one reply).
//   • Status, disposition, temperature and contactability move independently
//     of lifecycle stage and never regress it.
//   • Exactly one next_action is returned for every resolution.
//
// This module is pure (no I/O) so every transition is unit-testable.

import {
  LIFECYCLE_STAGE_CODES,
  LIFECYCLE_STAGE_ORDER,
  LEAD_TEMPERATURE_CODES,
  OPERATIONAL_STATUS_CODES,
  DISPOSITION_CODES,
  CONTACTABILITY_CODES,
  normalizeLifecycleStage,
  normalizeLeadTemperature,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { ACQUISITION_LIFECYCLE_EVENTS } from "@/lib/domain/seller-flow/acquisition-lifecycle-events.js";

export const TRANSITION_RESOLVER_VERSION = "seller_stage_transition_v1";

/** Canonical next-action vocabulary (spec §9 — exactly one per state change). */
export const NEXT_ACTIONS = Object.freeze({
  SEND_MESSAGE_NOW: "send_message_now",
  WAIT_FOR_SELLER: "wait_for_seller",
  SCHEDULE_FOLLOW_UP: "schedule_follow_up",
  EXECUTE_ADE: "execute_ade",
  GENERATE_OFFER: "generate_offer",
  NEGOTIATE: "negotiate",
  GENERATE_CONTRACT: "generate_contract",
  AWAIT_SIGNATURE: "await_signature",
  START_DISPOSITION: "start_disposition",
  RESOLVE_CLOSING_BLOCKER: "resolve_closing_blocker",
  CLOSE: "close",
  HUMAN_REVIEW: "human_review",
  NO_ACTION_CONTACT_BLOCKED: "no_action_contact_blocked",
});

export const ADE_ACTIONS = Object.freeze({
  NONE: "none",
  RUN_PRELIMINARY: "run_preliminary",
  RUN_FULL: "run_full",
  RERUN_MATERIAL_FACTS: "rerun_material_facts",
});

const STAGE_INDEX = new Map(LIFECYCLE_STAGE_ORDER.map((code, i) => [code, i]));
const TEMP_RANK = { unscored: 0, cold: 1, warm: 2, hot: 3 };

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stageIdx(code) {
  return STAGE_INDEX.get(normalizeLifecycleStage(code)) ?? 0;
}

function stageAt(idx) {
  return LIFECYCLE_STAGE_ORDER[Math.min(Math.max(idx, 0), LIFECYCLE_STAGE_ORDER.length - 1)];
}

function stageShort(code) {
  return `S${stageIdx(code) + 1}`;
}

function addDaysIso(now, days) {
  const d = new Date(now || Date.now());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// ─── Fact model ──────────────────────────────────────────────────────────────

const POSITIVE_OWNERSHIP = new Set(["confirmed", "inferred", "likely", "yes", "owner", "authorized_representative", "co_owner", "executor"]);
const NEGATIVE_OWNERSHIP = new Set(["not_owner", "wrong_number", "wrong_person", "former_owner", "tenant", "denied"]);
const POSITIVE_INTEREST = new Set(["interested", "conditional", "depends_on_price", "make_offer", "asks_offer", "yes", "future"]);

export function normalizeAskingPriceFact(input, { sourceMessageId = null, confidence = null, now = null } = {}) {
  if (input == null) return null;
  if (typeof input === "number" || typeof input === "string") {
    const value = numberOrNull(input);
    if (!value || value <= 0) return null;
    return {
      value,
      currency: "USD",
      price_type: "exact",
      confidence: confidence ?? null,
      source_message_id: sourceMessageId || null,
      extracted_text: null,
      captured_at: now || new Date().toISOString(),
    };
  }
  const value = numberOrNull(input.value ?? input.amount);
  if (!value || value <= 0) return null;
  return {
    value,
    currency: clean(input.currency) || "USD",
    price_type: lower(input.price_type) || "exact",
    confidence: input.confidence ?? confidence ?? null,
    source_message_id: input.source_message_id || sourceMessageId || null,
    extracted_text: clean(input.extracted_text || input.raw) || null,
    captured_at: input.captured_at || now || new Date().toISOString(),
  };
}

/** Merge persisted facts with newly extracted facts (new wins, price keeps provenance). */
export function mergeSellerFacts(known = {}, extracted = {}, meta = {}) {
  const merged = { ...(known || {}) };
  const facts = extracted || {};

  for (const [key, value] of Object.entries(facts)) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "asking_price") continue; // handled below with provenance
    merged[key] = value;
  }

  const newPrice = normalizeAskingPriceFact(facts.asking_price, meta);
  if (newPrice) merged.asking_price = newPrice;
  else if (known?.asking_price) merged.asking_price = normalizeAskingPriceFact(known.asking_price, meta) || known.asking_price;

  return merged;
}

export function hasMinimumConditionFacts(facts = {}) {
  const occupancy = lower(facts.occupancy_status || facts.occupancy);
  const conditionKnown = Boolean(
    clean(facts.condition_level) ||
      clean(facts.rehab_level) ||
      clean(facts.condition_summary) ||
      clean(facts.repairs_summary) ||
      facts.repairs_needed === false ||
      facts.condition_disclosed === true
  );
  return Boolean(occupancy && occupancy !== "unknown" && conditionKnown);
}

function ownershipResolved(facts = {}) {
  return POSITIVE_OWNERSHIP.has(lower(facts.ownership_status));
}

function interestResolved(facts = {}) {
  if (POSITIVE_INTEREST.has(lower(facts.interest || facts.seller_intent))) return true;
  // A price or an offer request implies interest.
  if (facts.asking_price?.value > 0) return true;
  if (facts.wants_offer === true || facts.make_me_an_offer === true) return true;
  return false;
}

function priceResolved(facts = {}, ade = null) {
  if (facts.asking_price?.value > 0) return true;
  // "Make me an offer": S3 resolves without a number only when ADE has
  // sufficient facts to price the deal.
  if ((facts.wants_offer === true || facts.make_me_an_offer === true) && ade?.sufficient_facts === true) {
    return true;
  }
  return false;
}

function conditionResolved(facts = {}, ade = null) {
  if (hasMinimumConditionFacts(facts)) return true;
  if (ade?.underwriting_ready === true) return true;
  return false;
}

/**
 * Milestone resolution table — milestone i (0-based stage index) is resolved
 * when the fact predicate holds. Stage = first unresolved milestone.
 */
function firstUnresolvedIdx(facts = {}, {
  ade = null,
  negotiation = null,
  contract = null,
  disposition = null,
  closing = null,
} = {}) {
  const checks = [
    () => ownershipResolved(facts),                                      // S1
    () => interestResolved(facts),                                       // S2
    () => priceResolved(facts, ade),                                     // S3
    () => conditionResolved(facts, ade),                                 // S4
    () => negotiation?.terms_accepted === true,                          // S5
    () => contract?.executed === true || contract?.signed === true,      // S6
    () => disposition?.started === true,                                 // S7
    () => disposition?.buyer_selected === true,                          // S8
    () => closing?.ready === true,                                       // S9
    () => closing?.closed === true,                                      // S10
  ];
  for (let i = 0; i < checks.length; i += 1) {
    if (!checks[i]()) return i;
  }
  return checks.length - 1; // everything resolved → closed
}

// ─── Blocking / terminal intents ─────────────────────────────────────────────

const BLOCKING_INTENTS = Object.freeze({
  opt_out: {
    contactability: CONTACTABILITY_CODES.OPTED_OUT,
    operational_status: OPERATIONAL_STATUS_CODES.PAUSED,
    next_action: NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED,
    cancel_followups: true,
    reasoning_code: "HOLD_OPT_OUT_SUPPRESS",
    workflow_event: "AUTOMATION_BLOCKED",
  },
  wrong_number: {
    contactability: CONTACTABILITY_CODES.INVALID_NUMBER,
    disposition: DISPOSITION_CODES.WRONG_NUMBER,
    operational_status: OPERATIONAL_STATUS_CODES.PAUSED,
    next_action: NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED,
    cancel_followups: true,
    evaluate_alternate_contact: true,
    reasoning_code: "HOLD_WRONG_NUMBER_BLOCK_PHONE",
    workflow_event: "AUTOMATION_BLOCKED",
  },
  wrong_person: {
    contactability: CONTACTABILITY_CODES.DO_NOT_TEXT,
    disposition: DISPOSITION_CODES.WRONG_PERSON,
    operational_status: OPERATIONAL_STATUS_CODES.PAUSED,
    next_action: NEXT_ACTIONS.NO_ACTION_CONTACT_BLOCKED,
    cancel_followups: true,
    evaluate_alternate_contact: true,
    reasoning_code: "HOLD_WRONG_PERSON_BLOCK_CONTACT",
    workflow_event: "AUTOMATION_BLOCKED",
  },
  hostile_or_legal: {
    contactability: CONTACTABILITY_CODES.DO_NOT_TEXT,
    operational_status: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
    next_action: NEXT_ACTIONS.HUMAN_REVIEW,
    cancel_followups: true,
    review_required: true,
    review_reason: "hostile_or_legal",
    reasoning_code: "HOLD_HOSTILE_LEGAL_REVIEW",
    workflow_event: "AUTOMATION_NEEDS_REVIEW",
  },
});

/** Nurture windows (days) by disengaging intent. */
const NURTURE_DAYS = Object.freeze({
  not_interested: 30,
  listed_or_unavailable: 45,
  need_time: 30,
  tenant_occupied: 21,
});

// ─── Stage → outstanding-question policy (positive path) ────────────────────

const STAGE_PROMPTS = Object.freeze({
  [LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION]: {
    template_use_case: "ownership_check",
    next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.OFFER_INTEREST]: {
    template_use_case: "consider_selling",
    next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.ASKING_PRICE]: {
    template_use_case: "seller_asking_price",
    next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION]: {
    template_use_case: "condition_probe",
    next_action: NEXT_ACTIONS.SEND_MESSAGE_NOW,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.OFFER]: {
    template_use_case: "offer_reveal_cash",
    next_action: NEXT_ACTIONS.GENERATE_OFFER,
    workflow_event: "OFFER_NEGOTIATION_OPENED",
  },
  [LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT]: {
    template_use_case: "asks_contract",
    next_action: NEXT_ACTIONS.GENERATE_CONTRACT,
    workflow_event: "READY_FOR_CONTRACT",
  },
  [LIFECYCLE_STAGE_CODES.UNDER_CONTRACT]: {
    template_use_case: "close_handoff",
    next_action: NEXT_ACTIONS.START_DISPOSITION,
    workflow_event: "READY_FOR_DISPOSITION",
  },
  [LIFECYCLE_STAGE_CODES.DISPOSITION]: {
    template_use_case: null,
    next_action: NEXT_ACTIONS.START_DISPOSITION,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE]: {
    template_use_case: null,
    next_action: NEXT_ACTIONS.RESOLVE_CLOSING_BLOCKER,
    workflow_event: null,
  },
  [LIFECYCLE_STAGE_CODES.CLOSED]: {
    template_use_case: null,
    next_action: NEXT_ACTIONS.CLOSE,
    workflow_event: null,
  },
});

function bumpTemperature(current, floor) {
  const cur = normalizeLeadTemperature(current, LEAD_TEMPERATURE_CODES.UNSCORED);
  return TEMP_RANK[floor] > TEMP_RANK[cur] ? floor : cur;
}

function advancementEvents(fromIdx, toIdx, facts, intent) {
  const events = [];
  const E = ACQUISITION_LIFECYCLE_EVENTS;
  if (intent === "ownership_confirmed" || (toIdx >= 1 && fromIdx < 1)) events.push(E.OWNER_CONFIRMED);
  if (toIdx >= 2 && fromIdx < 2) events.push(E.OFFER_INTEREST_CONFIRMED);
  if (facts.asking_price?.value > 0 && toIdx >= 3 && fromIdx < 4) events.push(E.SELLER_ASKING_PRICE_CAPTURED);
  if (toIdx >= 4 && fromIdx < 4) events.push(E.READY_FOR_OFFER_REVEAL);
  if (intent === "condition_disclosed" || facts.condition_disclosed === true) events.push(E.CONDITION_FACT_CAPTURED);
  if (toIdx >= 5 && fromIdx < 5) events.push(E.SELLER_ACCEPTED_OFFER, E.READY_FOR_CONTRACT);
  if (toIdx >= 6 && fromIdx < 6) events.push(E.CONTRACT_SIGNED, E.READY_FOR_DISPOSITION);
  return [...new Set(events)];
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Deterministically resolve the lifecycle transition for one inbound event
 * (or recovery evaluation). Pure function — persistence happens in callers.
 */
export function resolveSellerStageTransition({
  stage_before = null,
  known_facts = {},
  new_facts = {},
  intent = "unclear",
  classification_confidence = null,
  current_temperature = null,
  current_disposition = null,
  contactability = CONTACTABILITY_CODES.CONTACTABLE,
  automation_mode = "disabled",
  ade_result = null,
  negotiation_state = null,
  contract_state = null,
  disposition_state = null,
  closing_readiness = null,
  closing_evidence = null,
  engine_decision = null,
  source_message_id = null,
  temperature_signal = null,
  now = new Date().toISOString(),
} = {}) {
  const beforeCode = normalizeLifecycleStage(stage_before);
  const beforeIdx = stageIdx(beforeCode);
  const intentKey = lower(intent) || "unclear";

  const facts = mergeSellerFacts(known_facts, new_facts, {
    sourceMessageId: source_message_id,
    confidence: classification_confidence,
    now,
  });

  const base = {
    resolver_version: TRANSITION_RESOLVER_VERSION,
    stage_before: beforeCode,
    stage_before_number: beforeIdx + 1,
    facts_patch: facts,
    automation_mode,
    resolved_at: now,
    // Explainability: deterministic component scores + reason codes from the
    // temperature signal model travel with every resolution (audit + Studio).
    temperature_signal: temperature_signal || null,
  };

  // ── 1. Blocking intents: state changes without lifecycle movement ────────
  const blocking = BLOCKING_INTENTS[intentKey];
  if (blocking) {
    return {
      ...base,
      stage_after: beforeCode,
      stage_after_number: beforeIdx + 1,
      advanced: false,
      stages_advanced: 0,
      operational_status: blocking.operational_status,
      lead_temperature: normalizeLeadTemperature(current_temperature, LEAD_TEMPERATURE_CODES.UNSCORED),
      disposition: blocking.disposition || current_disposition || null,
      contactability_patch: { contactability_status: blocking.contactability },
      ownership_patch: intentKey === "wrong_number" || intentKey === "wrong_person"
        ? { ownership_status: "not_owner" }
        : null,
      next_action: blocking.next_action,
      next_action_due_at: null,
      required_template_use_case: null,
      ade_action: ADE_ACTIONS.NONE,
      review_required: Boolean(blocking.review_required),
      review_reason: blocking.review_reason || null,
      reasoning_code: blocking.reasoning_code,
      workflow_event_types: [blocking.workflow_event].filter(Boolean),
      follow_up: { create: false, cancel: Boolean(blocking.cancel_followups), replace: false, days: null, due_at: null },
      evaluate_alternate_contact: Boolean(blocking.evaluate_alternate_contact),
    };
  }

  // ── 2. Disengaging intents: nurture without stage regression ─────────────
  // A tenant-occupancy disclosure that ARRIVES WITH a price (or an existing
  // captured price) is engagement — occupancy is an underwriting fact, not a
  // brush-off. Only a bare "tenants live there" reply nurtures.
  const tenantDisclosureWithPrice =
    intentKey === "tenant_occupied" &&
    (Boolean(normalizeAskingPriceFact(new_facts?.asking_price)?.value) || facts.asking_price?.value > 0);
  if (NURTURE_DAYS[intentKey] != null && !tenantDisclosureWithPrice) {
    // "Not for sale" at S1 implies ownership — advance to S2 and nurture there.
    if (intentKey === "not_interested" && beforeIdx === 0) {
      facts.ownership_status = facts.ownership_status || "inferred";
    }
    const unresolved = firstUnresolvedIdx(facts, {
      ade: ade_result, negotiation: negotiation_state, contract: contract_state,
      disposition: disposition_state, closing: mergeClosing(closing_readiness, closing_evidence),
    });
    const afterIdx = Math.max(beforeIdx, Math.min(unresolved, 1));
    const days = NURTURE_DAYS[intentKey];
    const dueAt = addDaysIso(now, days);
    return {
      ...base,
      stage_after: stageAt(afterIdx),
      stage_after_number: afterIdx + 1,
      advanced: afterIdx > beforeIdx,
      stages_advanced: afterIdx - beforeIdx,
      operational_status: OPERATIONAL_STATUS_CODES.SCHEDULED,
      lead_temperature: intentKey === "not_interested"
        ? LEAD_TEMPERATURE_CODES.COLD
        : normalizeLeadTemperature(current_temperature, LEAD_TEMPERATURE_CODES.COLD),
      disposition: intentKey === "not_interested" ? DISPOSITION_CODES.NOT_INTERESTED : current_disposition || null,
      contactability_patch: null,
      ownership_patch: facts.ownership_status ? { ownership_status: facts.ownership_status } : null,
      next_action: NEXT_ACTIONS.SCHEDULE_FOLLOW_UP,
      next_action_due_at: dueAt,
      required_template_use_case: intentKey === "not_interested" ? "consider_selling_follow_up" : "not_ready",
      ade_action: ADE_ACTIONS.NONE,
      review_required: false,
      review_reason: null,
      reasoning_code: `${stageShort(beforeCode)}_${intentKey.toUpperCase()}_NURTURE_${days}D`,
      workflow_event_types: [
        intentKey === "not_interested"
          ? ACQUISITION_LIFECYCLE_EVENTS.SELLER_NOT_INTERESTED
          : ACQUISITION_LIFECYCLE_EVENTS.DEAL_NURTURE_TRIGGERED,
      ],
      follow_up: { create: true, cancel: false, replace: true, days, due_at: dueAt },
      evaluate_alternate_contact: false,
    };
  }

  // ── 3. Positive / neutral path: fact implications + milestone scan ───────
  if (intentKey === "ownership_confirmed") facts.ownership_status = "confirmed";
  if (intentKey === "seller_interested" || intentKey === "latent_interest") {
    facts.interest = facts.interest || "interested";
  }
  if (intentKey === "asks_offer") facts.wants_offer = true;
  if (intentKey === "condition_disclosed") facts.condition_disclosed = true;
  if (intentKey === "tenant_occupied") {
    facts.occupancy_status = facts.occupancy_status || "tenant_occupied";
  }

  // Engaged facts imply upstream milestones unless explicitly negative.
  const negativeOwnership = NEGATIVE_OWNERSHIP.has(lower(facts.ownership_status));
  if (!negativeOwnership) {
    if ((interestResolved(facts) || facts.asking_price?.value > 0) && !ownershipResolved(facts)) {
      facts.ownership_status = "inferred";
    }
  }

  const closing = mergeClosing(closing_readiness, closing_evidence);
  const unresolvedIdx = firstUnresolvedIdx(facts, {
    ade: ade_result,
    negotiation: negotiation_state,
    contract: contract_state,
    disposition: disposition_state,
    closing,
  });
  const afterIdx = Math.max(beforeIdx, unresolvedIdx);
  const afterCode = stageAt(afterIdx);

  // Temperature floor by engagement depth, then by the explainable signal
  // model's floor (which never exceeds what explicit language allows — the
  // negative-intent paths above never reach here).
  let temperature = normalizeLeadTemperature(current_temperature, LEAD_TEMPERATURE_CODES.UNSCORED);
  if (afterIdx >= 4 || negotiation_state?.terms_accepted || intentKey === "asks_offer") {
    temperature = bumpTemperature(temperature, LEAD_TEMPERATURE_CODES.HOT);
  } else if (afterIdx >= 2 || interestResolved(facts)) {
    temperature = bumpTemperature(temperature, LEAD_TEMPERATURE_CODES.WARM);
  }
  if (temperature_signal?.temperature_floor) {
    temperature = bumpTemperature(temperature, temperature_signal.temperature_floor);
  }

  const prompt = STAGE_PROMPTS[afterCode] || STAGE_PROMPTS[LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION];

  // ADE action: preliminary when price lands, full at S5, rerun on new
  // material facts while negotiating.
  let adeAction = ADE_ACTIONS.NONE;
  const priceJustCaptured = Boolean(normalizeAskingPriceFact(new_facts?.asking_price)?.value);
  const materialFactArrived = priceJustCaptured || intentKey === "condition_disclosed" || intentKey === "tenant_occupied";
  if (afterIdx === 4) {
    adeAction = ade_result ? (materialFactArrived ? ADE_ACTIONS.RERUN_MATERIAL_FACTS : ADE_ACTIONS.NONE) : ADE_ACTIONS.RUN_FULL;
  } else if (priceJustCaptured || (afterIdx === 3 && facts.asking_price?.value > 0)) {
    adeAction = ADE_ACTIONS.RUN_PRELIMINARY;
  }

  // Next action from the unresolved milestone; engine decisions refine S5/S6.
  let nextAction = prompt.next_action;
  let templateUseCase = prompt.template_use_case;
  // "Make me an offer": never re-ask the price the seller declined to give —
  // ask the highest-value missing underwriting question and let ADE decide.
  if (afterCode === LIFECYCLE_STAGE_CODES.ASKING_PRICE && facts.wants_offer === true) {
    templateUseCase = "condition_probe";
    if (!ade_result) adeAction = ADE_ACTIONS.RUN_PRELIMINARY;
  }
  if (afterIdx === 4) {
    const engineAction = lower(engine_decision?.acquisition_action);
    if (engineAction === "generate_contract") nextAction = NEXT_ACTIONS.GENERATE_CONTRACT;
    else if (negotiation_state?.offers_made > 0 || engineAction.includes("negotiat") || engineAction.includes("justify") || engineAction.includes("narrow")) {
      nextAction = NEXT_ACTIONS.NEGOTIATE;
      templateUseCase = engine_decision?.template_use_case || templateUseCase;
    } else if (!ade_result) {
      nextAction = NEXT_ACTIONS.EXECUTE_ADE;
    }
  }
  if (afterIdx === 5 && contract_state?.sent === true && !contract_state?.signed) {
    nextAction = NEXT_ACTIONS.AWAIT_SIGNATURE;
    templateUseCase = "signature_reminder";
  }

  // Low-confidence or unclear input never advances silently — review instead.
  const confidence = typeof classification_confidence === "number" ? classification_confidence : null;
  const ambiguous = intentKey === "unclear" || intentKey === "reaction_only" || intentKey === "acknowledgement";
  const lowConfidence = confidence !== null && confidence < 0.7 && afterIdx > beforeIdx;
  // External lifecycle evidence (contract/disposition/closing state, accepted
  // terms) makes an otherwise ambiguous evaluation deterministic — recovery
  // and event-driven re-evaluations run with intent "unclear" by design.
  const externalEvidence = Boolean(
    contract_state || disposition_state || closing_readiness || closing_evidence ||
      negotiation_state?.terms_accepted === true
  );
  if (ambiguous && afterIdx === beforeIdx && !materialFactArrived && !externalEvidence) {
    return {
      ...base,
      stage_after: beforeCode,
      stage_after_number: beforeIdx + 1,
      advanced: false,
      stages_advanced: 0,
      operational_status: OPERATIONAL_STATUS_CODES.NEEDS_REVIEW,
      lead_temperature: temperature,
      disposition: current_disposition || null,
      contactability_patch: null,
      ownership_patch: null,
      next_action: NEXT_ACTIONS.HUMAN_REVIEW,
      next_action_due_at: null,
      required_template_use_case: null,
      ade_action: ADE_ACTIONS.NONE,
      review_required: true,
      review_reason: "ambiguous_intent",
      reasoning_code: `${stageShort(beforeCode)}_AMBIGUOUS_HOLD_REVIEW`,
      workflow_event_types: [],
      follow_up: { create: false, cancel: false, replace: false, days: null, due_at: null },
      evaluate_alternate_contact: false,
    };
  }

  const reviewRequired = lowConfidence;
  const reasoning = afterIdx > beforeIdx
    ? `${stageShort(beforeCode)}_TO_${stageShort(afterCode)}_${intentKey.toUpperCase()}`
    : `${stageShort(beforeCode)}_HOLD_${intentKey.toUpperCase()}`;

  return {
    ...base,
    stage_after: afterCode,
    stage_after_number: afterIdx + 1,
    advanced: afterIdx > beforeIdx,
    stages_advanced: afterIdx - beforeIdx,
    operational_status: OPERATIONAL_STATUS_CODES.ACTIVE_COMMUNICATION,
    lead_temperature: temperature,
    disposition: interestResolved(facts) ? DISPOSITION_CODES.INTERESTED : current_disposition || null,
    contactability_patch: null,
    ownership_patch: facts.ownership_status ? { ownership_status: facts.ownership_status } : null,
    next_action: reviewRequired ? NEXT_ACTIONS.HUMAN_REVIEW : nextAction,
    next_action_due_at: now,
    required_template_use_case: templateUseCase,
    ade_action: adeAction,
    review_required: reviewRequired,
    review_reason: reviewRequired ? "low_confidence_advancement" : null,
    reasoning_code: reasoning,
    workflow_event_types: advancementEvents(beforeIdx, afterIdx, facts, intentKey),
    follow_up: {
      create: false,
      cancel: true, // a reply always cancels stale reply-pending follow-ups
      replace: afterIdx > beforeIdx,
      days: null,
      due_at: null,
    },
    evaluate_alternate_contact: false,
  };
}

function mergeClosing(readiness, evidence) {
  if (!readiness && !evidence) return null;
  return {
    ready: readiness?.ready === true,
    closed: evidence?.closed === true || Boolean(evidence?.closed_at),
  };
}

export default resolveSellerStageTransition;
