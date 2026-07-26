// ─── resolve-seller-response-strategy.js ────────────────────────────────────
// Separates the BUSINESS decision from the WORDING.
//
//   conversation state → next-best action → response strategy
//
// The strategy names a template use case and the constraints that apply to it.
// It never produces freeform copy: the existing deterministic template
// registry + renderer remain solely responsible for wording, and every
// existing terminal gate (suppression, ceiling clamp, auto_reply_mode,
// fail-closed template selection) still runs downstream.
//
// Pure: no DB, no network, no rendering, no send.

import { ACQUISITION_OBJECTIVES } from "@/lib/domain/seller-flow/resolve-seller-next-best-action.js";
import { FACT_RESOLUTION } from "@/lib/domain/seller-flow/resolve-seller-conversation-state.js";

export const RESPONSE_STRATEGY_VERSION = "seller_response_strategy_v1";

/**
 * Objective → existing template use case.
 *
 * Every value here is an EXISTING use case already present in the template
 * catalog. Objectives with no safe existing family map to `null`, which routes
 * to the existing fail-closed review path rather than inventing an unvetted
 * auto-send. See the Phase 9 template audit for the families still missing.
 */
export const OBJECTIVE_TEMPLATE_USE_CASE = Object.freeze({
  [ACQUISITION_OBJECTIVES.VERIFY_OWNERSHIP]: "ownership_check",
  [ACQUISITION_OBJECTIVES.DISCOVER_INTEREST]: "consider_selling",
  [ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE]: "seller_asking_price",
  [ACQUISITION_OBJECTIVES.CLARIFY_ASKING_PRICE]: "asking_price_follow_up",
  [ACQUISITION_OBJECTIVES.DISCOVER_CONDITION]: "condition_probe",
  [ACQUISITION_OBJECTIVES.DISCOVER_OCCUPANCY]: "occupancy_probe",
  [ACQUISITION_OBJECTIVES.DISCOVER_TIMELINE]: "ask_timeline",
  [ACQUISITION_OBJECTIVES.DISCOVER_MOTIVATION]: "flexibility_probe",
  [ACQUISITION_OBJECTIVES.HANDLE_PRICE_OBJECTION]: "justify_price",
  [ACQUISITION_OBJECTIVES.NEGOTIATE]: "counter_offer",
  [ACQUISITION_OBJECTIVES.PREPARE_OFFER]: "offer_reveal_cash",
  [ACQUISITION_OBJECTIVES.CONTRACT_NEXT_STEP]: "contract_information_request",
  [ACQUISITION_OBJECTIVES.FOLLOW_UP_LATER]: "future_nurture",
  // No safe existing family — fail closed to review.
  [ACQUISITION_OBJECTIVES.CLARIFY_AUTHORITY]: null,
  [ACQUISITION_OBJECTIVES.CLARIFY_REQUIRED_SIGNER]: null,
  [ACQUISITION_OBJECTIVES.CLARIFY_IDENTITY]: null,
  [ACQUISITION_OBJECTIVES.HANDLE_AGENT_INVOLVEMENT]: null,
  [ACQUISITION_OBJECTIVES.HANDLE_TRUST_CONCERN]: null,
  [ACQUISITION_OBJECTIVES.HUMAN_REVIEW]: null,
  [ACQUISITION_OBJECTIVES.SUPPRESS]: null,
  [ACQUISITION_OBJECTIVES.NO_REPLY]: null,
});

/** Objectives whose outbound message is a question to the seller. */
const QUESTION_OBJECTIVES = new Set([
  ACQUISITION_OBJECTIVES.VERIFY_OWNERSHIP,
  ACQUISITION_OBJECTIVES.DISCOVER_INTEREST,
  ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE,
  ACQUISITION_OBJECTIVES.CLARIFY_ASKING_PRICE,
  ACQUISITION_OBJECTIVES.DISCOVER_CONDITION,
  ACQUISITION_OBJECTIVES.DISCOVER_OCCUPANCY,
  ACQUISITION_OBJECTIVES.DISCOVER_TIMELINE,
  ACQUISITION_OBJECTIVES.DISCOVER_MOTIVATION,
]);

/** Objectives permitted to state a monetary figure. */
const PRICE_MENTION_OBJECTIVES = new Set([
  ACQUISITION_OBJECTIVES.PREPARE_OFFER,
  ACQUISITION_OBJECTIVES.NEGOTIATE,
  ACQUISITION_OBJECTIVES.HANDLE_PRICE_OBJECTION,
]);

/**
 * Build a deterministic response strategy.
 *
 * @param {object} args
 * @param {object} args.conversation_state
 * @param {object} args.next_best_action
 * @param {object} [args.underwriting]  already-available ADE/underwriting context
 * @param {object} [args.ade_snapshot]
 */
export function resolveSellerResponseStrategy({
  conversation_state = null,
  next_best_action = null,
  underwriting = null,
  ade_snapshot = null,
} = {}) {
  const state = conversation_state;
  const nba = next_best_action;

  if (!state || !nba) {
    return Object.freeze({
      version: RESPONSE_STRATEGY_VERSION,
      objective: ACQUISITION_OBJECTIVES.HUMAN_REVIEW,
      response_family: null,
      template_use_case: null,
      requested_fact: null,
      question_allowed: false,
      offer_allowed: false,
      price_mention_allowed: false,
      required_acknowledgement: null,
      human_review_required: true,
      suppression_required: false,
      no_reply: true,
      prohibited_actions: ["queue_reply", "generate_offer", "generate_contract"],
      reason_code: "missing_inputs",
      acquisition_context: null,
    });
  }

  const objective = nba.objective;
  const suppression_required = Boolean(nba.suppression_required);
  const human_review_required = Boolean(nba.human_review_required);
  const mapped_use_case = OBJECTIVE_TEMPLATE_USE_CASE[objective] ?? null;

  // No template family ⇒ no automated reply. Existing fail-closed behaviour.
  const template_use_case =
    suppression_required || human_review_required ? null : mapped_use_case;
  const no_reply = suppression_required || !template_use_case;

  const offer_allowed = Boolean(
    nba.offer_allowed &&
      state.safety.offer_permission &&
      state.authority.offer_progression_allowed &&
      !suppression_required &&
      !human_review_required
  );

  const price_mention_allowed = Boolean(
    offer_allowed && PRICE_MENTION_OBJECTIVES.has(objective)
  );

  const question_allowed = Boolean(
    !no_reply && !human_review_required && QUESTION_OBJECTIVES.has(objective)
  );

  // Acknowledge what the seller just told us, so a follow-up question never
  // reads as if the message was ignored. Names a fact, never any wording.
  let required_acknowledgement = null;
  if (state.acquisition.asking_price?.resolution === FACT_RESOLUTION.KNOWN &&
      QUESTION_OBJECTIVES.has(objective) &&
      objective !== ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE) {
    required_acknowledgement = "asking_price";
  } else if (state.seller_requests_offer && question_allowed) {
    required_acknowledgement = "seller_requests_offer";
  } else if (state.authority.additional_signers_claimed?.length > 0) {
    required_acknowledgement = "additional_signer_required";
  }

  const prohibited_actions = [];
  if (!offer_allowed) prohibited_actions.push("generate_offer", "state_offer_amount");
  if (!state.safety.contract_progression_permission) prohibited_actions.push("generate_contract");
  if (no_reply) prohibited_actions.push("queue_reply");
  if (!state.identity.owner_confirmed) prohibited_actions.push("treat_as_confirmed_owner");
  if (!state.authority.can_execute_alone) prohibited_actions.push("assume_sole_signing_authority");
  if (state.authority.estate_context) prohibited_actions.push("assume_individual_estate_authority");

  // Acquisition context is exposed ONLY from already-available canonical
  // authority. No offer number is invented here. Non-numeric ADE values must
  // never leak NaN (which would stop the ?? fallback chain).
  const finiteOrNull = (value) => {
    const n = Number(value);
    // Cash offers must be finite and positive — never NaN / 0 / negative.
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const acquisition_context = {
    recommended_cash_offer:
      finiteOrNull(underwriting?.recommended_cash_offer) ??
      finiteOrNull(ade_snapshot?.recommended_cash_offer) ??
      finiteOrNull(state.negotiation.recommended_offer) ??
      null,
    max_allowable_offer:
      underwriting?.max_allowable_offer ?? state.negotiation.authorized_offer_ceiling ?? null,
    valuation_confidence:
      underwriting?.valuation_confidence ?? ade_snapshot?.valuation_confidence ?? null,
    repair_estimate: underwriting?.repair_estimate ?? ade_snapshot?.estimated_repairs ?? null,
    acquisition_tier: ade_snapshot?.acquisition_tier ?? null,
    seller_ask:
      state.acquisition.asking_price?.resolution === FACT_RESOLUTION.KNOWN
        ? state.acquisition.asking_price.value?.value ?? null
        : null,
  };

  return Object.freeze({
    version: RESPONSE_STRATEGY_VERSION,
    objective,
    response_family: template_use_case,
    template_use_case,
    requested_fact: nba.requested_fact || null,
    question_allowed,
    offer_allowed,
    price_mention_allowed,
    required_acknowledgement,
    human_review_required,
    suppression_required,
    no_reply,
    prohibited_actions: Object.freeze([...new Set(prohibited_actions)]),
    reason_code: nba.reason_code || null,
    authority_block_reason: nba.authority_block_reason || null,
    acquisition_context,
  });
}

export default resolveSellerResponseStrategy;
