// ─── classifier-calibration.js ─────────────────────────────────────────────
// Taxonomy, stratified family split, metrics, authority allowlist (narrow only).
// classify.js remains sole classifier. No LLM.

import { createHash } from "node:crypto";

export const CALIBRATION_MANIFEST_VERSION =
  "acquisition_brain_classifier_calibration_v1";

export const MIN_HELD_OUT_FAMILIES = 20;
export const MIN_HELD_OUT_PERMUTATIONS = 50;

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
 * Production intent labels (classify.js) → stage buckets for calibration.
 * sold/never_owned route as wrong_number in production (suppression).
 */
export const INTENT_TAXONOMY = Object.freeze({
  ownership_confirmed: {
    stage: 1,
    outcome: "owner_confirmed",
    automatable_candidate: true,
  },
  wrong_number: {
    stage: 1,
    outcome: "identity_disconnect_terminal",
    terminal: true,
    includes_sold_never_owned_routing: true,
  },
  tenant_occupied: { stage: 1, outcome: "tenant" },
  not_interested: { stage: 2, outcome: "not_interested" },
  asks_offer: {
    stage: 2,
    outcome: "seller_requests_proposal",
    automatable_candidate: true,
  },
  seller_interested: { stage: 2, outcome: "proposal_interest" },
  latent_interest: { stage: 2, outcome: "conditional_interest" },
  need_time: { stage: 2, outcome: "follow_up_later" },
  who_is_this: { stage: 2, outcome: "trust_or_identity" },
  asking_price_provided: {
    stage: 3,
    outcome: "asking_price_value",
    automatable_candidate: true,
  },
  condition_disclosed: { stage: 4, outcome: "condition" },
  opt_out: { stage: 0, outcome: "opt_out", terminal: true },
  hostile_or_legal: { stage: 0, outcome: "hostile_legal", review: true },
  callback_requested: { stage: 2, outcome: "callback" },
  info_request: { stage: 2, outcome: "info_request" },
  acknowledgement: { stage: 0, outcome: "acknowledgement" },
  unclear: { stage: 0, outcome: "unclear", review: true },
});

/**
 * Authority allowlist: empty until held-out support + precision gates met.
 * Populated only with narrow rule families that independently pass.
 */
export const AUTHORITY_INTENT_ALLOWLIST = Object.freeze([]);

export const TAXONOMY_CORRECTIONS = Object.freeze([
  {
    type: "production_routing",
    note: "sold_property and never_owned gold labels map to wrong_number in production classify.js for suppression continuity",
  },
  {
    type: "multi_label",
    note: "asking_price_provided outranks ownership_confirmed when both present (INTENT_PRIORITY)",
  },
  {
    type: "authority_role",
    note: "property manager / agent / family owner are not sole ownership_confirmed",
  },
]);

export function isAuthorityEligibleIntent(
  intent,
  allowlist = AUTHORITY_INTENT_ALLOWLIST
) {
  return allowlist.includes(String(intent || ""));
}

/**
 * Stratified family split by intent, deterministic.
 * ~20% held_out per intent when enough families exist.
 */
export function buildStratifiedSplitManifest(seeds = [], language = "en") {
  const by_intent = new Map();
  for (const s of seeds) {
    const intent = s.expected_primary_intent || "unclear";
    if (!by_intent.has(intent)) by_intent.set(intent, []);
    by_intent.get(intent).push(s.family);
  }

  const entries = [];
  for (const [intent, families] of by_intent.entries()) {
    const sorted = [...new Set(families)].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      const family = sorted[i];
      // First family held_out if >=5 families; else every 5th; need spread
      const hex = createHash("sha256")
        .update(`${language}:${intent}:${family}`, "utf8")
        .digest("hex");
      const n = parseInt(hex.slice(0, 8), 16);
      const split =
        sorted.length >= 5
          ? n % 5 === 0
            ? "held_out"
            : "development"
          : "development"; // insufficient for held-out authority
      entries.push({
        family_id: family,
        language,
        canonical_primary_intent: intent,
        secondary_intents: [],
        lifecycle_stage: INTENT_TAXONOMY[intent]?.stage ?? null,
        split,
        deterministic_split_reason:
          sorted.length < 5
            ? "insufficient_families_for_held_out"
            : "hash_mod5_zero_held_out",
        corpus_version: "acquisition_brain_corpus_v1",
        calibration_version: CALIBRATION_MANIFEST_VERSION,
      });
    }
  }
  return {
    version: CALIBRATION_MANIFEST_VERSION,
    language,
    entries,
  };
}

export function splitSeedFamily(family, language = "en") {
  const hex = createHash("sha256")
    .update(`${language}:${family}`, "utf8")
    .digest("hex");
  const n = parseInt(hex.slice(0, 8), 16);
  return {
    family,
    language,
    split: n % 5 === 0 ? "held_out" : "development",
    bucket: n % 5,
  };
}

export function buildConfusionMatrix(pairs = []) {
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

export function computeMacroF1(pairs = []) {
  const labels = [
    ...new Set(pairs.flatMap((p) => [p.expected, p.actual]).filter(Boolean)),
  ];
  let sum_f1 = 0;
  let n = 0;
  const per = {};
  for (const label of labels) {
    let tp = 0,
      fp = 0,
      fn = 0;
    for (const p of pairs) {
      if (p.actual === label && p.expected === label) tp += 1;
      else if (p.actual === label && p.expected !== label) fp += 1;
      else if (p.actual !== label && p.expected === label) fn += 1;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 =
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    per[label] = { precision, recall, f1, tp, fp, fn };
    sum_f1 += f1;
    n += 1;
  }
  return { macro_f1: n ? sum_f1 / n : 0, per_label: per };
}

export function evaluateIntentSupport(manifest, intent) {
  const held = manifest.entries.filter(
    (e) => e.canonical_primary_intent === intent && e.split === "held_out"
  );
  const families = held.length;
  return {
    intent,
    held_out_families: families,
    minimum_families: MIN_HELD_OUT_FAMILIES,
    status:
      families >= MIN_HELD_OUT_FAMILIES
        ? "sufficient_families"
        : "insufficient_calibration_data",
    authority_eligible: false, // require metrics pass separately
  };
}

/**
 * Decide allowlist entries only when all gates pass.
 * Returns empty list when support insufficient.
 */
export function proposeAuthorityAllowlist({
  language,
  intent_metrics = {},
} = {}) {
  const candidates = ["ownership_confirmed", "asks_offer", "asking_price_provided"];
  const allowed = [];
  for (const intent of candidates) {
    const m = intent_metrics[intent];
    if (!m) continue;
    if (m.held_out_families < MIN_HELD_OUT_FAMILIES) continue;
    if (m.held_out_permutations < MIN_HELD_OUT_PERMUTATIONS) continue;
    if ((m.precision ?? 0) < HELD_OUT_GATES.precision_min) continue;
    if ((m.recall ?? 0) < HELD_OUT_GATES.recall_min) continue;
    if ((m.opt_out_confusion ?? 0) > 0) continue;
    if ((m.wrong_number_confusion ?? 0) > 0) continue;
    allowed.push({
      intent,
      language,
      rule_families: m.rule_families || ["default"],
      held_out_precision: m.precision,
      held_out_recall: m.recall,
      support_families: m.held_out_families,
      calibration_version: CALIBRATION_MANIFEST_VERSION,
    });
  }
  return allowed;
}

export default {
  CALIBRATION_MANIFEST_VERSION,
  MIN_HELD_OUT_FAMILIES,
  MIN_HELD_OUT_PERMUTATIONS,
  HELD_OUT_GATES,
  INTENT_TAXONOMY,
  AUTHORITY_INTENT_ALLOWLIST,
  TAXONOMY_CORRECTIONS,
  isAuthorityEligibleIntent,
  buildStratifiedSplitManifest,
  splitSeedFamily,
  buildConfusionMatrix,
  computeMacroF1,
  evaluateIntentSupport,
  proposeAuthorityAllowlist,
};
