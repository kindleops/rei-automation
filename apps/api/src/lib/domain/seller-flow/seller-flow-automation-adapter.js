/**
 * seller-flow-automation-adapter.js
 *
 * Thin normalization adapter over the EXISTING seller-flow engine.
 *
 * The only job of this module is to take what classify.js + the seller-flow
 * orchestration already produced (classification contract, seller-flow
 * decision, deterministic stage transition) and normalize it into the
 * canonical automation lifecycle result consumed by the control plane.
 *
 * It must never classify, route, or decide anything on its own:
 *   - classification comes from classify.js (classificationSource: classify_js)
 *   - stage/status/temperature come from the seller-flow decision contract
 *   - stage numbering comes from the universal lead-state registry
 *
 * Unknown / unclear results are preserved and routed to human review.
 */

import {
  LIFECYCLE_STAGE_CODES,
  LIFECYCLE_STAGE_META,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { mapSellerFlowStageToUniversal } from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";

export const CLASSIFICATION_SOURCE_CLASSIFY_JS = "classify_js";

const UNCLEAR_INTENTS = new Set(["unclear", "unknown", ""]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function stageMeta(stage_code) {
  return LIFECYCLE_STAGE_META[stage_code] || null;
}

function deriveSuppressionAction(decision = null, contract = null) {
  const automation = decision?.automation_decision || contract?.automation_decision || null;
  if (contract?.opt_out_signal) return "opt_out";
  if (contract?.wrong_number_signal) return "wrong_number";
  if (automation?.should_suppress_contact) {
    return lower(automation.suppression_reason) || "suppress_contact";
  }
  if (decision?.contactability === "opted_out") return "opt_out";
  if (decision?.contactability === "wrong_number") return "wrong_number";
  if (decision?.contactability === "do_not_text") return "do_not_text";
  return null;
}

function deriveHumanReviewRequired({ decision = null, contract = null, replyIntent = "" } = {}) {
  if (decision?.review_required) return true;
  if (decision?.automation_decision?.should_mark_human_review) return true;
  if (contract?.ambiguity_review_required) return true;
  // Preserve unknown/unclear from the existing flow: never auto-resolve it.
  if (UNCLEAR_INTENTS.has(lower(replyIntent))) return true;
  return false;
}

function deriveStageSignals({ stage_code, contract = null, decision = null } = {}) {
  const facts = decision?.extracted_facts || contract?.extracted_facts || {};
  return {
    ownershipOutcome: contract?.ownership_signal || "unknown",
    interestOutcome: contract?.interest_signal || "unknown",
    askingPriceSignal: facts.asking_price ?? null,
    conditionSignal: facts.condition ?? null,
    offerSignal: facts.offer_response ?? null,
    contractSignal: facts.contract_response ?? null,
    dispoSignal: stage_code === LIFECYCLE_STAGE_CODES.DISPOSITION ? stage_code : null,
    buyerContractSignal: stage_code === LIFECYCLE_STAGE_CODES.UNDER_CONTRACT ? stage_code : null,
    escrowSignal: stage_code === LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE ? stage_code : null,
    closedSignal: stage_code === LIFECYCLE_STAGE_CODES.CLOSED ? stage_code : null,
  };
}

function deriveReasons({ decision = null, contract = null } = {}) {
  const reasons = [];
  if (decision?.reasoning_code) reasons.push(decision.reasoning_code);
  if (decision?.review_reason) reasons.push(decision.review_reason);
  if (decision?.block_reason) reasons.push(decision.block_reason);
  if (contract?.review_reason) reasons.push(contract.review_reason);
  const audit_reason = decision?.automation_decision?.audit_reason;
  if (audit_reason) reasons.push(audit_reason);
  return [...new Set(reasons.map(clean).filter(Boolean))];
}

/**
 * Normalize the existing seller-flow output into the canonical automation
 * lifecycle result. Pure function — no I/O, no classification.
 *
 * @param {object} args
 * @param {object} args.decision   seller_flow_decision_v1 from buildSellerFlowDecision
 * @param {object} args.contract   canonical classification contract (classify.js normalized)
 * @param {object} args.classification raw classify.js output (confidence/language fallback)
 */
export function normalizeSellerFlowAutomationResult({
  decision = null,
  contract = null,
  classification = null,
  inboundMessageId = null,
  outboundSource = null,
  threadKey = null,
  propertyId = null,
  masterOwnerId = null,
  prospectId = null,
  phoneId = null,
  canonicalE164 = null,
} = {}) {
  const stage_code = mapSellerFlowStageToUniversal(
    decision?.stage_after || decision?.stage_before || null
  );
  const meta = stageMeta(stage_code);
  const replyIntent = clean(contract?.normalized_intent) || "unclear";
  const humanReviewRequired = deriveHumanReviewRequired({ decision, contract, replyIntent });
  const suppressionAction = deriveSuppressionAction(decision, contract);

  return {
    classificationSource: CLASSIFICATION_SOURCE_CLASSIFY_JS,
    inboundMessageId: clean(inboundMessageId) || clean(contract?.message_id) || null,
    outboundSource: clean(outboundSource) || null,
    threadKey: clean(threadKey) || clean(contract?.thread_id) || null,
    propertyId: clean(propertyId) || clean(contract?.property_id) || null,
    masterOwnerId: clean(masterOwnerId) || null,
    prospectId: clean(prospectId) || clean(contract?.prospect_id) || null,
    phoneId: clean(phoneId) || null,
    canonicalE164: clean(canonicalE164) || clean(contract?.phone) || null,
    language: clean(contract?.language) || clean(classification?.language) || "English",

    sellerStage: stage_code || null,
    sellerStatus: decision?.operational_status || null,
    sellerTemperature: decision?.temperature || null,
    replyIntent,
    nextAction: decision?.next_action || decision?.immediate_next_action || null,

    stageNumber: meta?.number ?? null,
    stageName: meta?.label ?? null,

    ...deriveStageSignals({ stage_code, contract, decision }),

    recommendedTemplateUseCase: decision?.template_key || null,
    recommendedResponse: decision?.rendered_message || null,
    humanReviewRequired,
    suppressionAction,
    confidence:
      typeof contract?.confidence === "number"
        ? contract.confidence
        : typeof classification?.confidence === "number"
          ? classification.confidence
          : null,
    reasons: deriveReasons({ decision, contract }),
    auditMetadata: {
      decision_version: decision?.decision_version || null,
      stage_before: decision?.stage_before || null,
      stage_after: decision?.stage_after || null,
      execution_mode: decision?.execution_mode || null,
      change_source: decision?.change_source || null,
      queue_row_id: decision?.queue_row_id || null,
      follow_up_at: decision?.follow_up_at || null,
      persisted_at: decision?.persisted_at || null,
    },
  };
}

export default normalizeSellerFlowAutomationResult;
