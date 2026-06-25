// ─── stage-aware-clarifier.js ────────────────────────────────────────────
// Consolidation Pass 1, Goal 2: a STAGE-AWARE template clarifier resolver.
//
// The legacy template path (resolve-seller-auto-reply-plan.js) mapped every
// ambiguous reply to a single generic `unclear_clarifier` regardless of stage.
// This resolver considers stage + canonical intent + identity + confidence and
// returns a structured decision. It NEVER regresses the stage and preserves
// no-send behavior for compliance / hostile / wrong-number / terminal.
//
// Pure + additive. Content comes from the stage × uncertainty safe-fallback
// matrix, so the clarifier is store-independent and cannot create a coverage hole.

import { normalizeCanonicalIntent } from "./canonical-intent-aliases.js";
import { buildSafeFallback, uncertaintyTypeForReason } from "./safe-fallback.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

const BUCKET_TO_CODE = Object.freeze({
  ownership: "S1",
  consider_selling: "S2",
  asking_price: "S3",
  condition: "S4",
  offer: "S5",
  negotiation_close: "S6",
});

const CODE_ORDINAL = Object.freeze({ S1: 1, S2: 2, S3: 3, S4: 4, S5: 5, S6: 6 });

const NO_SEND = Object.freeze({
  opt_out: { no_send_reason: "opt_out_no_marketing", use_case: null, stage_code: "STOP", human_review_required: false },
  wrong_number: { no_send_reason: "wrong_number_suppressed", use_case: "wrong_person", stage_code: "WRONG", human_review_required: false },
  hostile_or_legal: { no_send_reason: "hostile_or_legal_hold", use_case: null, stage_code: "LEGAL", human_review_required: true },
  not_interested: { no_send_reason: "not_interested_nurture_only", use_case: "not_interested", stage_code: "DEAD", human_review_required: false },
});

const ROUTED_INTENTS = new Set([
  "ownership_confirmed",
  "seller_interested",
  "latent_interest",
  "asks_offer",
  "asking_price_provided",
  "condition_disclosed",
  "tenant_occupied",
  "who_is_this",
  "info_request",
  "callback_requested",
  "need_time",
]);

const CONFIDENCE_FLOOR = 0.9;

export function resolveStageAwareClarifier({
  stage = null,
  canonical_intent = null,
  identity_class = "unknown",
  confidence = 1,
  safe_for_auto_reply = true,
  reply_mode = null,
} = {}) {
  const intent = normalizeCanonicalIntent(canonical_intent);
  const identity = lower(identity_class) || "unknown";

  if (NO_SEND[intent]) {
    const ns = NO_SEND[intent];
    return {
      is_clarifier: false,
      selected_use_case: ns.use_case,
      fallback_use_case: null,
      selected_stage_code: ns.stage_code,
      template_selection_reason: `no_send:${intent}`,
      clarifier_text: null,
      fallback_path: "no_send",
      human_review_required: ns.human_review_required,
      no_send_reason: ns.no_send_reason,
    };
  }

  if (ROUTED_INTENTS.has(intent) && confidence >= CONFIDENCE_FLOOR) {
    return {
      is_clarifier: false,
      selected_use_case: null,
      fallback_use_case: null,
      selected_stage_code: null,
      template_selection_reason: `routed:${intent}`,
      clarifier_text: null,
      fallback_path: "deterministic_routing",
      human_review_required: false,
      no_send_reason: null,
    };
  }

  let uncertainty_type;
  if (identity === "wrong_person" || identity === "wrong_number") {
    uncertainty_type = "identity";
  } else if (identity === "renter_occupant") {
    uncertainty_type = "identity";
  } else if (intent === "property_correction") {
    uncertainty_type = "identity";
  } else {
    uncertainty_type = uncertaintyTypeForReason(intent, intent);
  }

  const fallback = buildSafeFallback({ stage, uncertainty_type });
  const stage_code = BUCKET_TO_CODE[fallback.stage_bucket] || "S1";

  const selected_use_case = `unclear_clarifier_${lower(stage_code)}`;
  const fallback_use_case = "unclear_clarifier";

  const low_confidence = confidence < CONFIDENCE_FLOOR;
  const human_review_required =
    low_confidence || identity === "unknown" || safe_for_auto_reply === false;

  return {
    is_clarifier: true,
    selected_use_case,
    fallback_use_case,
    selected_stage_code: stage_code,
    template_selection_reason: `stage_aware_clarifier:${stage_code}:${uncertainty_type}`,
    clarifier_text: fallback.suggested_text,
    fallback_path: "stage_scoped_template_then_safe_fallback_text",
    human_review_required,
    no_send_reason: null,
  };
}

export function stageCodeOrdinal(code = null) {
  return CODE_ORDINAL[clean(code).toUpperCase()] || 0;
}

export default { resolveStageAwareClarifier, stageCodeOrdinal };
