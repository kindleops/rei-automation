// ─── classifier-calibration.js ─────────────────────────────────────────────
// Taxonomy, held-out split contract, and authority-intent allowlist scaffolding.
// classify.js remains sole classifier. No LLM. Default allowlist empty until
// held-out metrics meet gates.

import { createHash } from "node:crypto";

export const CALIBRATION_MANIFEST_VERSION =
  "acquisition_brain_classifier_calibration_v1_scaffold";

/**
 * Canonical label map: classify.js primary_intent → stage outcome buckets.
 */
export const INTENT_TAXONOMY = Object.freeze({
  // Stage 1 outcomes
  ownership_confirmed: { stage: 1, outcome: "owner_confirmed", automatable_candidate: true },
  wrong_number: { stage: 1, outcome: "wrong_number", terminal: true },
  never_owned: { stage: 1, outcome: "never_owned", terminal: true },
  // classify may emit ownership denial variants under not_interested or unclear
  not_interested: { stage: 2, outcome: "not_interested" },
  tenant_occupied: { stage: 1, outcome: "tenant" },
  // Stage 2
  asks_offer: { stage: 2, outcome: "seller_requests_proposal", automatable_candidate: true },
  latent_interest: { stage: 2, outcome: "conditional_interest" },
  need_time: { stage: 2, outcome: "follow_up_later" },
  who_is_this: { stage: 2, outcome: "trust_or_identity" },
  // Stage 3
  asking_price_provided: { stage: 3, outcome: "asking_price_value", automatable_candidate: true },
  // Shared / compliance
  opt_out: { stage: 0, outcome: "opt_out", terminal: true },
  hostile_or_legal: { stage: 0, outcome: "hostile_legal", review: true },
  condition_disclosed: { stage: 4, outcome: "condition" },
  callback_requested: { stage: 2, outcome: "callback" },
  info_request: { stage: 2, outcome: "info_request" },
  unclear: { stage: 0, outcome: "unclear", review: true },
  seller_interested: { stage: 2, outcome: "proposal_interest" },
});

/** Default: no intent authority-eligible until held-out proof. */
export const AUTHORITY_INTENT_ALLOWLIST = Object.freeze([]);

export const HELD_OUT_GATES = Object.freeze({
  precision_min: 0.99,
  recall_min: 0.95,
  opt_out_confusion: 0,
  wrong_number_confusion: 0,
  never_owned_sold_confusion: 0,
  english_macro_f1_min: 0.9,
  spanish_macro_f1_min: 0.85,
  stage1_accuracy_min: 0.95,
  stage2_accuracy_min: 0.9,
  stage3_price_accuracy_min: 0.95,
});

/**
 * Deterministic family-level split: hash(family) % 5 === 0 → held_out else dev.
 */
export function splitSeedFamily(family, language = "en") {
  const hex = createHash("sha256")
    .update(`${language}:${family}`, "utf8")
    .digest("hex");
  const n = parseInt(hex.slice(0, 8), 16);
  const bucket = n % 5;
  return {
    family,
    language,
    split: bucket === 0 ? "held_out" : "development",
    bucket,
  };
}

export function buildConfusionMatrix(pairs = []) {
  // pairs: { expected, actual }[]
  const matrix = {};
  let correct = 0;
  for (const { expected, actual } of pairs) {
    const e = String(expected || "null");
    const a = String(actual || "null");
    matrix[e] = matrix[e] || {};
    matrix[e][a] = (matrix[e][a] || 0) + 1;
    if (e === a) correct += 1;
  }
  return {
    matrix,
    n: pairs.length,
    accuracy: pairs.length ? correct / pairs.length : 0,
  };
}

/**
 * Remediation notes: do not inflate accuracy by remapping wrong classifications.
 * Record taxonomy aliases that are legitimate label mismatches.
 */
export const TAXONOMY_CORRECTIONS = Object.freeze([
  {
    type: "alias",
    note: "seller_interested may map to Stage 2 interest; document separately from ownership_confirmed",
  },
  {
    type: "multi_label",
    note: "Multi-fact messages force one primary; secondary intents must be scored separately",
  },
  {
    type: "spanish",
    note: "Spanish normalization gaps require dedicated held-out family set",
  },
]);

export function isAuthorityEligibleIntent(intent, allowlist = AUTHORITY_INTENT_ALLOWLIST) {
  return allowlist.includes(String(intent || ""));
}

export default {
  CALIBRATION_MANIFEST_VERSION,
  INTENT_TAXONOMY,
  AUTHORITY_INTENT_ALLOWLIST,
  HELD_OUT_GATES,
  TAXONOMY_CORRECTIONS,
  splitSeedFamily,
  buildConfusionMatrix,
  isAuthorityEligibleIntent,
};
