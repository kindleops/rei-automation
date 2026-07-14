import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import {
  buildSendQueueDedupeKey,
  insertSupabaseSendQueueRow,
} from "@/lib/supabase/sms-engine.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import {
  normalizeUsPhoneToE164,
  prepareRenderedSmsForQueue,
} from "@/lib/sms/sanitize.js";
import { info, warn } from "@/lib/logging/logger.js";
import { evaluateQueueCreationRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import {
  autoReplyModeAllowsQueue,
  normalizeAutoReplyMode,
} from "@/lib/domain/seller-flow/auto-reply-mode.js";
import { getSystemValue } from "@/lib/system-control.js";
import { ensureInboundCoverage } from "@/lib/domain/seller-flow/coverage-net/ensure-inbound-coverage.js";
import { normalizeCanonicalIntent } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";
import { resolveContactIdentityClass } from "@/lib/domain/inbox/contact-identity.js";
import { automationDecisionToLegacyPlan } from "@/lib/domain/seller-flow/inbound-decision-adapters.js";
import { resolveThreadLanguage } from "@/lib/domain/seller-flow/resolve-thread-language.js";
import { buildOutboundTemplateAttribution } from "@/lib/domain/templates/outbound-attribution.js";
import { resolveOwnershipProbeDisinterestTransition } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import {
  cancelSupabasePendingOutbound,
  CANCELLATION_POLICIES,
} from "@/lib/domain/queue/cancel-supabase-pending-outbound.js";

const DEFAULT_DUPLICATE_WINDOW_MINUTES = 10;
const ACTIVE_AUTO_REPLY_STATUSES = new Set([
  "queued",
  "pending",
  "approved",
  "ready",
  "scheduled",
  "processing",
  "sending",
]);
const HIGH_RISK_OBJECTIONS = new Set(["financial_distress", "probate", "divorce"]);
const REVIEW_ONLY_OBJECTIONS = new Set(["wants_proof_of_funds", "property_correction"]);

const ROUTE_PROFILES = Object.freeze({
  ownership_confirmed: {
    route_hint: "consider_selling",
    allowed_template_stages: ["consider_selling", "stage_2_consider_selling"],
    template_use_case_candidates: ["consider_selling"],
    next_action: "queue_auto_reply",
  },
  seller_interested: {
    route_hint: "seller_asking_price",
    allowed_template_stages: ["seller_asking_price", "stage_3_seller_asking_price"],
    template_use_case_candidates: ["seller_asking_price", "asking_price"],
    next_action: "queue_auto_reply",
  },
  latent_interest: {
    route_hint: "seller_asking_price",
    allowed_template_stages: ["seller_asking_price", "stage_3_seller_asking_price"],
    template_use_case_candidates: ["seller_asking_price", "asking_price"],
    next_action: "queue_auto_reply",
  },
  asks_offer: {
    route_hint: "ask_seller_price_or_basic_condition",
    allowed_template_stages: ["seller_asking_price", "condition_probe", "price_discovery"],
    template_use_case_candidates: [
      "seller_asking_price",
      "price_high_condition_probe",
      "ask_condition_clarifier",
      "creative_probe",
    ],
    next_action: "queue_auto_reply",
  },
  asking_price_provided: {
    route_hint: "price_response",
    allowed_template_stages: [
      "price_works_confirm_basics",
      "price_high_condition_probe",
      "creative_probe",
    ],
    template_use_case_candidates: [
      "price_works_confirm_basics",
      "price_high_condition_probe",
      "creative_probe",
    ],
    next_action: "queue_auto_reply",
  },
  tenant_occupied: {
    route_hint: "rental_underwriting",
    allowed_template_stages: [
      "rental_underwriting_units",
      "rental_underwriting_rents",
      "tenant_probe",
    ],
    template_use_case_candidates: [
      "tenant_probe",
      "mf_confirm_units",
      "mf_occupancy",
      "mf_rents",
      "ask_condition_clarifier",
    ],
    next_action: "queue_auto_reply",
  },
  condition_disclosed: {
    route_hint: "condition_followup",
    allowed_template_stages: ["condition_probe", "repairs_followup"],
    template_use_case_candidates: [
      "price_high_condition_probe",
      "ask_condition_clarifier",
      "creative_probe",
    ],
    next_action: "queue_auto_reply",
  },
  need_time: {
    route_hint: "soft_followup",
    allowed_template_stages: ["soft_followup", "future_followup"],
    template_use_case_candidates: [
      "consider_selling_follow_up",
      "asking_price_follow_up",
      "reengagement",
    ],
    next_action: "schedule_later_followup",
  },
  who_is_this: {
    route_hint: "identity_response",
    allowed_template_stages: ["identity_response", "who_is_this"],
    template_use_case_candidates: ["who_is_this", "how_got_number"],
    next_action: "queue_auto_reply",
  },
  info_request: {
    route_hint: "info_request",
    allowed_template_stages: ["info_source_explanation", "identity_response", "who_is_this"],
    template_use_case_candidates: ["who_is_this", "info_source_explanation", "how_got_number"],
    next_action: "queue_auto_reply",
  },
  callback_requested: {
    route_hint: "text_only_redirect",
    allowed_template_stages: ["text_only_redirect", "sms_only_response"],
    template_use_case_candidates: ["text_only_redirect", "sms_only_response"],
    next_action: "queue_auto_reply",
  },
  needs_call: {
    route_hint: "text_only_redirect",
    allowed_template_stages: ["text_only_redirect", "sms_only_response"],
    template_use_case_candidates: ["text_only_redirect", "sms_only_response"],
    next_action: "queue_auto_reply",
  },
  needs_email: {
    route_hint: "text_only_redirect",
    allowed_template_stages: ["text_only_redirect", "sms_only_response"],
    template_use_case_candidates: ["text_only_redirect", "sms_only_response"],
    next_action: "queue_auto_reply",
  },
  not_interested: {
    route_hint: "soft_close_or_suppress",
    allowed_template_stages: ["not_interested_soft_close"],
    template_use_case_candidates: ["not_interested_soft_close"],
    next_action: "do_not_reply",
  },
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function uniq(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeList(value) {
  return asArray(value)
    .map((entry) => lower(entry))
    .filter(Boolean);
}

function toTimestamp(value) {
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function buildAuditReason(reason = "unknown") {
  return clean(reason) || "unknown";
}

function canUseSupabase(explicitClient = null) {
  return Boolean(explicitClient) || hasSupabaseConfig();
}

function hasUsableContext({
  threadKey,
  propertyId,
  prospectId,
  ownerId,
  phoneId,
  conversationBrain,
  latestThreadContext,
} = {}) {
  if (!clean(threadKey)) return false;

  return Boolean(
    clean(propertyId) ||
      clean(prospectId) ||
      clean(ownerId) ||
      clean(phoneId) ||
      clean(conversationBrain?.item_id) ||
      clean(latestThreadContext?.ids?.property_id) ||
      clean(latestThreadContext?.ids?.master_owner_id) ||
      clean(latestThreadContext?.ids?.phone_item_id)
  );
}

function resolveRouteProfile(classification = {}) {
  const primary_intent = clean(classification.primary_intent) || "unclear";
  const objection = clean(classification.objection) || null;

  if (primary_intent === "callback_requested") return ROUTE_PROFILES.callback_requested;
  if (objection === "needs_call") return ROUTE_PROFILES.needs_call;
  if (objection === "needs_email") return ROUTE_PROFILES.needs_email;

  return ROUTE_PROFILES[primary_intent] || null;
}

function buildDecisionResult({
  should_queue_reply = false,
  should_suppress_contact = false,
  should_mark_human_review = false,
  reply_mode = "none",
  suppression_reason = null,
  human_review_reason = null,
  route_hint = null,
  stage_hint = null,
  allowed_template_stages = [],
  next_action = "none",
  audit_reason = "none",
} = {}) {
  return {
    should_queue_reply: Boolean(should_queue_reply),
    should_suppress_contact: Boolean(should_suppress_contact),
    should_mark_human_review: Boolean(should_mark_human_review),
    reply_mode,
    suppression_reason: suppression_reason || null,
    human_review_reason: human_review_reason || null,
    route_hint: route_hint || null,
    stage_hint: stage_hint || null,
    allowed_template_stages: uniq(allowed_template_stages),
    next_action,
    audit_reason: buildAuditReason(audit_reason),
  };
}

function computeInboundAutomationDecisionRaw({
  message,
  threadKey,
  propertyId,
  prospectId,
  ownerId,
  phoneId,
  classification,
  conversationBrain,
  latestThreadContext,
} = {}) {
  // Normalize through the canonical aliaser so vocabulary drift cannot defeat
  // suppression: wrong_person ≡ wrong_number, opt-out synonyms ≡ opt_out, etc.
  // No-op for already-canonical classifier output (the live case).
  const primary_intent = normalizeCanonicalIntent(classification?.primary_intent);
  const objection = clean(classification?.objection) || null;
  const compliance_flag = clean(classification?.compliance_flag) || null;
  const confidence =
    typeof classification?.confidence === "number" ? classification.confidence : 0;
  const automation_decision = classification?.automation_decision || {};
  const route_profile = resolveRouteProfile(classification);
  const route_hint = route_profile?.route_hint || null;
  const allowed_template_stages = route_profile?.allowed_template_stages || [];
  const stage_hint = clean(classification?.stage_hint) || null;
  const usable_context = hasUsableContext({
    threadKey,
    propertyId,
    prospectId,
    ownerId,
    phoneId,
    conversationBrain,
    latestThreadContext,
  });

  if (!classification || typeof classification !== "object") {
    return buildDecisionResult({
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: "missing_classification",
      stage_hint,
      next_action: "mark_human_review",
      audit_reason: "missing_classification",
    });
  }

  if (!usable_context) {
    return buildDecisionResult({
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: "missing_context",
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "mark_human_review",
      audit_reason: "missing_context",
    });
  }

  if (
    compliance_flag === "stop_texting" ||
    primary_intent === "opt_out" ||
    automation_decision?.should_suppress_contact === true ||
    automation_decision?.suppression_action === "opt_out"
  ) {
    return buildDecisionResult({
      should_suppress_contact: true,
      reply_mode: "none",
      suppression_reason: "opt_out",
      next_action: "suppress_contact",
      audit_reason: "opt_out",
    });
  }

  if (primary_intent === "wrong_number") {
    return buildDecisionResult({
      should_suppress_contact: true,
      reply_mode: "none",
      suppression_reason: "wrong_number",
      next_action: "archive_wrong_number",
      audit_reason: "wrong_number",
    });
  }

  if (
    primary_intent === "hostile_or_legal" ||
    (automation_decision?.human_review_required === true &&
      automation_decision?.auto_reply_allowed !== true)
  ) {
    const human_review_reason =
      primary_intent === "hostile_or_legal"
        ? "hostile_or_legal"
        : primary_intent === "unclear" && confidence < 0.82
          ? "unclear_low_confidence"
          : "automation_review_required";

    return buildDecisionResult({
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason,
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "mark_human_review",
      audit_reason: human_review_reason,
    });
  }

  if (
    primary_intent === "reaction_only" ||
    primary_intent === "property_correction" ||
    primary_intent === "unclear" ||
    primary_intent === "acknowledgement"
  ) {
    const human_review_reason =
      primary_intent === "property_correction"
        ? "property_correction"
        : primary_intent === "unclear" && confidence < 0.82
          ? "unclear_low_confidence"
          : "ambiguous_intent";

    return buildDecisionResult({
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason,
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "mark_human_review",
      audit_reason: human_review_reason,
    });
  }

  if (REVIEW_ONLY_OBJECTIONS.has(objection)) {
    return buildDecisionResult({
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: objection,
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "mark_human_review",
      audit_reason: objection,
    });
  }

  if (HIGH_RISK_OBJECTIONS.has(objection) && confidence < 0.9) {
    return buildDecisionResult({
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: `${objection}_low_confidence`,
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "mark_human_review",
      audit_reason: `${objection}_low_confidence`,
    });
  }

  if (primary_intent === "not_interested") {
    return buildDecisionResult({
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "do_not_reply",
      audit_reason: "not_interested",
    });
  }

  if (primary_intent === "need_time") {
    const auto_reply_allowed = confidence >= 0.85;
    return buildDecisionResult({
      should_queue_reply: auto_reply_allowed,
      should_mark_human_review: !auto_reply_allowed,
      reply_mode: auto_reply_allowed ? "auto" : "manual_review",
      human_review_reason: auto_reply_allowed ? null : "need_time_low_confidence",
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: auto_reply_allowed ? "schedule_later_followup" : "mark_human_review",
      audit_reason: auto_reply_allowed ? "need_time" : "need_time_low_confidence",
    });
  }

  if (primary_intent === "who_is_this" || primary_intent === "info_request") {
    const auto_reply_allowed = confidence >= 0.75;
    return buildDecisionResult({
      should_queue_reply: auto_reply_allowed,
      should_mark_human_review: !auto_reply_allowed,
      reply_mode: auto_reply_allowed ? "auto" : "manual_review",
      human_review_reason: auto_reply_allowed ? null : `${primary_intent}_low_confidence`,
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: auto_reply_allowed ? "queue_auto_reply" : "mark_human_review",
      audit_reason: auto_reply_allowed ? primary_intent : `${primary_intent}_low_confidence`,
    });
  }

  if (
    [
      "ownership_confirmed",
      "seller_interested",
      "latent_interest",
      "asks_offer",
      "asking_price_provided",
      "tenant_occupied",
      "condition_disclosed",
      "callback_requested",
      "info_request",
    ].includes(primary_intent) ||
    objection === "needs_call" ||
    objection === "needs_email"
  ) {
    const auto_reply_allowed =
      automation_decision?.auto_reply_allowed === true &&
      compliance_flag !== "stop_texting" &&
      primary_intent !== "hostile_or_legal";

    const resolved_profile =
      primary_intent === "callback_requested" ? ROUTE_PROFILES.callback_requested :
      objection === "needs_call" ? ROUTE_PROFILES.needs_call :
      objection === "needs_email" ? ROUTE_PROFILES.needs_email :
      route_profile;

    return buildDecisionResult({
      should_queue_reply: auto_reply_allowed,
      should_mark_human_review: !auto_reply_allowed,
      reply_mode: auto_reply_allowed ? "auto" : "manual_review",
      human_review_reason: auto_reply_allowed ? null : "confidence_or_policy_block",
      route_hint: resolved_profile?.route_hint || route_hint,
      stage_hint,
      allowed_template_stages: resolved_profile?.allowed_template_stages || allowed_template_stages,
      next_action: auto_reply_allowed ? resolved_profile?.next_action || "queue_auto_reply" : "mark_human_review",
      audit_reason: auto_reply_allowed ? primary_intent : "confidence_or_policy_block",
    });
  }

  return buildDecisionResult({
    should_mark_human_review: true,
    reply_mode: "manual_review",
    human_review_reason: "unhandled_classification",
    route_hint,
    stage_hint,
    allowed_template_stages,
    next_action: "mark_human_review",
    audit_reason: "unhandled_classification",
  });
}

/**
 * Public decision entry point. Computes the raw deterministic decision, then runs
 * it through the Stages 1–6 coverage net so the returned decision ALWAYS carries:
 * canonical_intent, contact_identity, safety_status, reply_disposition, an owned
 * exception workflow + SLA (when human/suppress), a stage-aware safe fallback
 * (when ambiguous), a guaranteed scheduled_next_action, and a coverage_state.
 *
 * The net is additive: it never changes should_queue_reply / should_suppress_contact
 * / reply_mode / next_action / suppression_reason, so no new automated sends are
 * introduced — only owned-workflow + fallback metadata are attached.
 */
function applyOwnershipProbeOverlay(decision = {}, args = {}) {
  const ownership_probe = resolveOwnershipProbeDisinterestTransition({
    classification: args.classification || {},
    messageEvent: {
      message_body: args.message,
      direction: "inbound",
    },
    existingState: {
      conversation_stage:
        args.latestThreadContext?.summary?.conversation_stage ||
        args.classification?.stage_hint ||
        null,
      seller_stage: args.latestThreadContext?.summary?.seller_stage || null,
      ownership_status: args.latestThreadContext?.summary?.ownership_status || null,
    },
  });

  if (!ownership_probe) return decision;

  return {
    ...decision,
    should_queue_reply: false,
    should_suppress_contact: false,
    should_mark_human_review: false,
    reply_mode: "none",
    route_hint: "consider_selling",
    stage_hint: "consider_selling",
    allowed_template_stages: ["consider_selling", "consider_selling_follow_up"],
    next_action: "schedule_later_followup",
    audit_reason: "s1_not_for_sale_advance_with_followup",
    ownership_status: ownership_probe.ownership_status,
    ownership_inference_reason: ownership_probe.ownership_inference_reason,
    disposition: ownership_probe.disposition,
    lead_temperature: ownership_probe.lead_temperature,
    follow_up_at: ownership_probe.follow_up_at,
    operational_status: ownership_probe.operational_status,
  };
}

export function applyInboundAutomationDecision(args = {}) {
  const raw = applyOwnershipProbeOverlay(computeInboundAutomationDecisionRaw(args), args);
  const classification = args.classification || {};
  const stage =
    clean(classification.stage_hint) ||
    clean(args.latestThreadContext?.summary?.conversation_stage) ||
    clean(args.conversationBrain?.conversation_stage) ||
    null;
  const contact_identity = resolveContactIdentityClass({
    detected_intent: classification.primary_intent || classification.detected_intent || null,
    master_owner_id: args.ownerId || args.latestThreadContext?.ids?.master_owner_id || null,
    prospect_id: args.prospectId || args.latestThreadContext?.ids?.prospect_id || null,
    property_id: args.propertyId || args.latestThreadContext?.ids?.property_id || null,
    conversation_stage: stage,
    metadata: classification.metadata || {},
  });
  return ensureInboundCoverage(raw, { stage, contact_identity, classification });
}

function templateCandidateSet(decision = {}, classification = {}) {
  const primary_intent = clean(classification.primary_intent) || "unclear";
  const objection = clean(classification.objection) || null;

  if (primary_intent === "callback_requested") {
    return ROUTE_PROFILES.callback_requested.template_use_case_candidates;
  }
  if (objection === "needs_call") {
    return ROUTE_PROFILES.needs_call.template_use_case_candidates;
  }
  if (objection === "needs_email") {
    return ROUTE_PROFILES.needs_email.template_use_case_candidates;
  }

  return routeProfileCandidates(decision.route_hint, primary_intent);
}

function routeProfileCandidates(route_hint = null, primary_intent = null) {
  if (primary_intent && ROUTE_PROFILES[primary_intent]?.template_use_case_candidates) {
    return ROUTE_PROFILES[primary_intent].template_use_case_candidates;
  }

  const profile = Object.values(ROUTE_PROFILES).find((candidate) => candidate.route_hint === route_hint);
  return profile?.template_use_case_candidates || [];
}

function normalizeTemplateMatchValues(row = {}) {
  return uniq([
    lower(row.use_case),
    lower(row.stage_code),
    lower(row.stage_label),
    lower(row.template_name),
  ]);
}

function derivePropertyTypeScope(context = null) {
  return clean(
    context?.summary?.property_type ||
      context?.summary?.property_type_scope ||
      context?.property_type ||
      context?.property_type_scope ||
      context?.items?.property_item?.property_type_scope
  ) || null;
}

function derivePropertyGroup(property_type_scope = null) {
  const normalized = lower(property_type_scope);
  if (!normalized) return null;
  if (normalized.includes("vacant") || normalized.includes("land")) return "land";
  if (normalized.includes("duplex")) return "duplex";
  if (normalized.includes("triplex")) return "triplex";
  if (normalized.includes("fourplex") || normalized.includes("quad")) return "fourplex";
  if (
    normalized.includes("multi") ||
    normalized.includes("apartment") ||
    normalized.includes("5+")
  ) {
    return "small_multifamily";
  }
  if (
    normalized.includes("single") ||
    normalized.includes("sfr") ||
    normalized.includes("house") ||
    normalized.includes("home")
  ) {
    return "sfr";
  }
  if (normalized.includes("residential")) return "residential";
  return null;
}

function isResidentialPropertyGroup(group = null) {
  return [
    "sfr",
    "duplex",
    "triplex",
    "fourplex",
    "small_multifamily",
    "residential",
  ].includes(lower(group));
}

function isBroadResidentialScope(scope = null) {
  const normalized = lower(scope);
  return (
    normalized === "any" ||
    normalized === "residential" ||
    normalized === "any residential" ||
    normalized.includes("any residential")
  );
}

function isTemplatePropertyCompatible(row = {}, property_type_scope = null) {
  const requested_scope = lower(property_type_scope);
  const template_scope = lower(row.property_type_scope);
  const property_group = derivePropertyGroup(property_type_scope);

  if (requested_scope && template_scope && template_scope !== requested_scope) {
    const template_group = derivePropertyGroup(template_scope);
    const broad_residential_match =
      isBroadResidentialScope(template_scope) && isResidentialPropertyGroup(property_group);
    const precise_group_match =
      template_group &&
      property_group &&
      (template_group === property_group ||
        (template_group === "residential" && isResidentialPropertyGroup(property_group)));

    if (!broad_residential_match && !precise_group_match) {
      return false;
    }
  }

  const allowed = normalizeList(row.allowed_property_groups);
  const prohibited = normalizeList(row.prohibited_property_groups);

  if (
    property_group &&
    allowed.length > 0 &&
    !allowed.includes(property_group) &&
    !(property_group === "residential" && allowed.some(isResidentialPropertyGroup))
  ) {
    return false;
  }

  if (property_group && prohibited.includes(property_group)) {
    return false;
  }

  return true;
}

function compareTemplateRank(left = {}, right = {}) {
  const left_success = Number.isFinite(Number(left.success_rate)) ? Number(left.success_rate) : -1;
  const right_success = Number.isFinite(Number(right.success_rate)) ? Number(right.success_rate) : -1;
  if (left_success !== right_success) return right_success - left_success;

  const left_usage = Number.isFinite(Number(left.usage_count)) ? Number(left.usage_count) : -1;
  const right_usage = Number.isFinite(Number(right.usage_count)) ? Number(right.usage_count) : -1;
  if (left_usage !== right_usage) return right_usage - left_usage;

  const left_updated = toTimestamp(left.updated_at) ?? -1;
  const right_updated = toTimestamp(right.updated_at) ?? -1;
  return right_updated - left_updated;
}

// §12 negotiation use cases that may auto-reply from the local registry when
// no sms_templates row exists yet. Deliberately excludes first-touch/cold
// outbound use cases — this fallback can never widen cold outreach.
const LOCAL_NEGOTIATION_AUTO_REPLY_USE_CASES = new Set([
  "condition_probe",
  "occupancy_probe",
  "repair_clarification",
  "flexibility_probe",
  "best_price_request",
  "expectation_reset",
  "comp_anchor",
  "repair_anchor",
  "initial_offer",
  "conditional_offer",
  "counter_offer",
  "final_offer",
  "accept_terms",
  "novation_probe",
  "seller_finance_probe",
  "future_nurture",
  "contract_information_request",
]);

async function selectLocalNegotiationTemplate(allowed_matches = [], { strategy = null } = {}) {
  try {
    const { LOCAL_TEMPLATE_CANDIDATES, verifyLocalAutoReplyApproval, isLocalTemplateFallbackKilled } =
      await import("@/lib/domain/templates/local-template-registry.js");
    // Immediate kill switch: fallback can be revoked globally without a deploy.
    if (isLocalTemplateFallbackKilled()) return null;
    for (const row of LOCAL_TEMPLATE_CANDIDATES) {
      if (!LOCAL_NEGOTIATION_AUTO_REPLY_USE_CASES.has(lower(row.use_case))) continue;
      if (!allowed_matches.includes(lower(row.use_case))) continue;
      if (lower(row.active) !== "yes") continue;
      // A local template is auto-sendable only with a verified approval record:
      // pinned content hash, approved environment, allowed strategy, no kill.
      const verification = verifyLocalAutoReplyApproval(row, { strategy });
      if (!verification.approved) continue;
      return {
        template_id: row.item_id,
        use_case: row.use_case,
        // Canonical lifecycle stage from the approval record (S4/S5/S6) —
        // never the template use case.
        stage_code: verification.approval.stage_code,
        language: row.language || "English",
        template_body: row.text,
        safe_for_auto_reply: true,
        source: "local_registry",
        approval: {
          approval_status: verification.approval.approval_status,
          approval_version: verification.approval.approval_version,
          content_hash: verification.approval.content_hash,
          allowed_strategies: [...verification.approval.allowed_strategies],
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function selectSafeAutoReplyTemplate({
  supabaseClient = null,
  classification = null,
  decision = null,
  context = null,
  threadKey = null,
  inboundEventId = null,
} = {}) {
  if (!canUseSupabase(supabaseClient)) {
    return { ok: false, reason: "missing_supabase", template: null };
  }

  const supabase = supabaseClient || getDefaultSupabaseClient();
  // Language continuity (activation spec): an established thread/prospect
  // language always wins over per-message detection so one terse "ok" in a
  // Spanish conversation can never flip the reply to English. Unknown (fresh
  // thread, no signal anywhere) keeps today's English default for template
  // search but is recorded on the result so review surfaces can see it.
  const language_resolution = resolveThreadLanguage({
    threadLanguage:
      context?.automation_decision?.classification?.language ||
      context?.summary?.language ||
      null,
    prospectLanguagePreference:
      context?.seller_owner_intelligence?.contact_identity?.language ||
      context?.summary?.language_preference ||
      null,
    explicitInboundLanguage: classification?.explicit_language || null,
    detectedLanguage: classification?.language || null,
    messageText:
      context?.automation_decision?.inbound_detection?.latest_inbound_text || "",
  });
  const language = language_resolution.is_unknown
    ? "English"
    : language_resolution.language;
  const languages = language === "English" ? ["English"] : [language, "English"];
  // Lifecycle-resolver authority (see executeInboundAutomationDecision): a
  // required use case restricts matching to EXACTLY that use case so the
  // intent profile's candidates cannot leak a stage-earlier question back in.
  const required_use_case = lower(clean(decision?.required_template_use_case));
  const allowed_matches = required_use_case
    ? [required_use_case]
    : uniq([
        ...asArray(decision?.allowed_template_stages).map(lower),
        lower(decision?.route_hint),
        ...templateCandidateSet(decision, classification).map(lower),
      ]);
  const property_type_scope = derivePropertyTypeScope(context);

  if (!supabase || allowed_matches.length === 0) {
    return {
      ok: false,
      reason: allowed_matches.length === 0 ? "no_template_route_candidates" : "missing_supabase",
      template: null,
    };
  }

  try {
    const { data, error } = await supabase
      .from("sms_templates")
      .select("*")
      .eq("is_active", true)
      .eq("safe_for_auto_reply", true)
      .in("language", languages)
      .limit(100);

    if (error) throw error;

    const candidates = (Array.isArray(data) ? data : [])
      .filter((row) => {
        const matches = normalizeTemplateMatchValues(row);
        return matches.some((value) => allowed_matches.includes(value));
      })
      .filter((row) => {
        const reply_mode = lower(row.reply_mode);
        return !reply_mode || reply_mode === "auto" || reply_mode === "auto_reply";
      })
      .filter((row) => isTemplatePropertyCompatible(row, property_type_scope))
      .sort(compareTemplateRank);

    const requested_language = lower(language);
    const exact_language_match =
      candidates.find((row) => lower(row.language) === requested_language) || null;

    // Language continuity: a non-English thread must never be answered with
    // an English template. Missing language template ⇒ fail closed to review.
    if (!exact_language_match && requested_language !== "english") {
      return {
        ok: false,
        reason: "language_template_missing",
        human_review_required: true,
        language,
        language_resolution,
        template: null,
      };
    }

    let selected =
      exact_language_match ||
      candidates.find((row) => lower(row.language) === "english") ||
      candidates[0] ||
      null;

    // Negotiation strategies fall back to the canonical local registry so a
    // deterministic strategy is never silently downgraded to review just
    // because the DB catalog lags the strategy vocabulary. DB-approved
    // templates always take precedence; the fallback requires a verified
    // approval record and is audited below.
    if (!selected) {
      selected = await selectLocalNegotiationTemplate(allowed_matches, {
        strategy: decision?.negotiation_strategy || null,
      });
      if (selected) {
        try {
          const { emitAutomationEvent } = await import(
            "@/lib/domain/automation/automation-events.js"
          );
          await emitAutomationEvent(
            {
              event_type: "LOCAL_TEMPLATE_FALLBACK_USED",
              source: "seller_inbound_orchestrator",
              dedupe_key: `local-template-fallback:${inboundEventId || threadKey || ""}:${selected.template_id}`,
              conversation_thread_id: clean(threadKey) || null,
              payload: {
                template_id: selected.template_id,
                use_case: selected.use_case,
                stage_code: selected.stage_code,
                approval_version: selected.approval?.approval_version ?? null,
                content_hash: selected.approval?.content_hash ?? null,
                strategy: decision?.negotiation_strategy || null,
                inbound_event_id: inboundEventId || null,
              },
            },
            supabase ? { supabaseClient: supabase } : {}
          );
        } catch {
          // Audit emission is observability — never blocks template selection.
        }
      }
    }

    if (!selected) {
      return { ok: false, reason: "no_safe_template", template: null };
    }

    info("[AUTO_REPLY_TEMPLATE_SELECTED]", {
      route_hint: decision?.route_hint || null,
      primary_intent: classification?.primary_intent || null,
      template_id: selected.template_id || selected.id || null,
      use_case: selected.use_case || null,
      stage_code: selected.stage_code || null,
      language: selected.language || null,
    });

    return {
      ok: true,
      reason: "template_selected",
      language_resolution,
      template: selected,
    };
  } catch (error) {
    warn("[AUTO_REPLY_NO_SAFE_TEMPLATE]", {
      route_hint: decision?.route_hint || null,
      primary_intent: classification?.primary_intent || null,
      error: error?.message || "template_lookup_failed",
    });
    return {
      ok: false,
      reason: "template_lookup_failed",
      error: error?.message || "template_lookup_failed",
      template: null,
    };
  }
}

function formatUsd(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : null;
}

function buildPersonalizationContext({
  message = "",
  inboundFrom = "",
  inboundTo = "",
  classification = null,
  context = null,
  dealAuthority = null,
} = {}) {
  const price_mentioned = classification?.seller_state?.price_mentioned ?? null;
  const formatted_price = formatUsd(price_mentioned);
  // Monetary offer values may ONLY come from persisted ADE authority — never
  // from the seller's own mentioned price. With no authority the placeholder
  // stays empty and the render fails closed (no send, human review).
  // A strategy-authorized amount (already ceiling-bounded by the router) takes
  // precedence over the bare recommended offer; any amount above the persisted
  // ceiling is discarded so the render fails closed instead of over-offering.
  const ceiling = Number(dealAuthority?.authorized_offer_ceiling);
  const pickAuthorized = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (Number.isFinite(ceiling) && ceiling > 0 && amount > ceiling) return null;
    return amount;
  };
  const authorized_offer = formatUsd(
    pickAuthorized(dealAuthority?.authorized_offer_amount) ??
      pickAuthorized(dealAuthority?.recommended_offer)
  );

  return {
    message_body: clean(message) || null,
    phone_e164: clean(inboundFrom) || null,
    to_phone_e164: clean(inboundTo) || null,
    first_name:
      clean(context?.summary?.seller_first_name) ||
      clean(context?.summary?.owner_first_name) ||
      null,
    seller_first_name:
      clean(context?.summary?.seller_first_name) ||
      clean(context?.summary?.owner_first_name) ||
      null,
    owner_name: clean(context?.summary?.owner_name) || null,
    seller_display_name: clean(context?.summary?.owner_name) || null,
    agent_name: clean(context?.summary?.agent_name) || null,
    property_address: clean(context?.summary?.property_address) || null,
    property_city: clean(context?.summary?.property_city) || null,
    city: clean(context?.summary?.property_city) || null,
    market_name: clean(context?.summary?.market_name || context?.summary?.market) || null,
    property_type:
      clean(context?.summary?.property_type_scope || context?.summary?.property_type) || null,
    asking_price: formatted_price,
    offer_price: authorized_offer,
    smart_cash_offer_display: authorized_offer,
    // Comp statements render ONLY the exact policy-authorized sentence — the
    // template/renderer never composes its own comp claim (spec §10).
    comp_anchor_statement: clean(dealAuthority?.comp_anchor_statement) || null,
  };
}

function renderSafeTemplate({
  template = null,
  message = "",
  inboundFrom = "",
  inboundTo = "",
  classification = null,
  context = null,
  dealAuthority = null,
} = {}) {
  if (!clean(template?.template_body)) {
    return { ok: false, reason: "template_body_missing", rendered_message_text: null };
  }

  const rendered = personalizeTemplate(
    template.template_body,
    buildPersonalizationContext({
      message,
      inboundFrom,
      inboundTo,
      classification,
      context,
      dealAuthority,
    })
  );

  if (!rendered.ok) {
    return {
      ok: false,
      reason: rendered.reason || "template_render_failed",
      missing: rendered.missing || [],
      rendered_message_text: null,
    };
  }

  const prepared = prepareRenderedSmsForQueue({
    rendered_message_text: rendered.text,
    template_id: template.template_id || template.id || null,
    template_source: "sms_templates",
  });

  if (!prepared.ok || !clean(prepared.text)) {
    return {
      ok: false,
      reason: prepared.reason || "rendered_sms_invalid",
      diagnostics: prepared.diagnostics || null,
      rendered_message_text: null,
    };
  }

  return {
    ok: true,
    rendered_message_text: prepared.text,
    placeholders_used: rendered.placeholders_used || [],
  };
}

export async function findRecentInboundAutoReplyDuplicate({
  supabaseClient = null,
  threadKey = "",
  sourceEventId = null,
  windowMinutes = DEFAULT_DUPLICATE_WINDOW_MINUTES,
} = {}) {
  if (!canUseSupabase(supabaseClient)) {
    return { duplicate: false, reason: "missing_supabase" };
  }

  const supabase = supabaseClient || getDefaultSupabaseClient();
  if (!supabase || !clean(threadKey)) {
    return { duplicate: false, reason: "missing_supabase_or_thread" };
  }

  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  try {
    if (clean(sourceEventId)) {
      const { data: source_duplicate, error: source_error } = await supabase
        .from("send_queue")
        .select("id, queue_status, created_at")
        .eq("source_event_id", sourceEventId)
        .in("queue_status", [...ACTIVE_AUTO_REPLY_STATUSES])
        .limit(1);

      if (source_error) throw source_error;
      if (Array.isArray(source_duplicate) && source_duplicate.length > 0) {
        return {
          duplicate: true,
          reason: "duplicate_source_event",
          row: source_duplicate[0],
        };
      }
    }

    const { data, error } = await supabase
      .from("send_queue")
      .select("id, queue_status, created_at, type")
      .eq("thread_key", threadKey)
      .eq("type", "auto_reply")
      .in("queue_status", [...ACTIVE_AUTO_REPLY_STATUSES])
      .gte("created_at", since)
      .limit(5);

    if (error) throw error;

    const duplicate_row = (Array.isArray(data) ? data : [])[0] || null;
    if (!duplicate_row) {
      return { duplicate: false, reason: "no_recent_duplicate" };
    }

    return {
      duplicate: true,
      reason: "recent_thread_duplicate",
      row: duplicate_row,
    };
  } catch (error) {
    warn("[AUTO_REPLY_DUPLICATE_SUPPRESSED]", {
      thread_key: threadKey,
      source_event_id: sourceEventId || null,
      error: error?.message || "duplicate_lookup_failed",
    });
    return {
      duplicate: false,
      reason: "duplicate_lookup_failed",
      error: error?.message || "duplicate_lookup_failed",
    };
  }
}

export async function applyInboundSuppression({
  supabaseClient = null,
  phoneNumber = "",
  phoneId = null,
  reason = "opt_out",
  threadKey = "",
  dryRun = false,
} = {}) {
  if (!canUseSupabase(supabaseClient)) {
    return { ok: false, reason: "missing_supabase_or_phone" };
  }

  const supabase = supabaseClient || getDefaultSupabaseClient();
  const normalized_phone = normalizeUsPhoneToE164(phoneNumber) || clean(phoneNumber);

  if (!supabase || !normalized_phone) {
    return { ok: false, reason: "missing_supabase_or_phone" };
  }

  if (dryRun) {
    return { ok: true, dry_run: true, reason, phone_number: normalized_phone };
  }

  try {
    if (reason === "wrong_number") {
      let query = supabase.from("phones").update({
        phone_contact_status: "wrong_number",
        wrong_number_at: new Date().toISOString(),
        wrong_number_source_thread_key: clean(threadKey) || normalized_phone,
      });

      if (clean(phoneId)) {
        query = query.eq("id", phoneId);
      } else {
        query = query.eq("canonical_e164", normalized_phone);
      }

      const { error } = await query;
      if (error) throw error;
    } else {
      const { error } = await supabase.from("sms_suppression_list").insert({
        phone_number: normalized_phone,
        suppression_reason: reason,
        is_active: true,
        suppressed_at: new Date().toISOString(),
      });
      if (error) throw error;
    }

    info("[AUTO_REPLY_SUPPRESSION_APPLIED]", {
      phone_number: normalized_phone,
      phone_id: phoneId || null,
      suppression_reason: reason,
    });

    return { ok: true, reason, phone_number: normalized_phone };
  } catch (error) {
    warn("[AUTO_REPLY_SUPPRESSION_APPLIED]", {
      phone_number: normalized_phone,
      phone_id: phoneId || null,
      suppression_reason: reason,
      error: error?.message || "suppression_failed",
    });
    return {
      ok: false,
      reason: "suppression_failed",
      error: error?.message || "suppression_failed",
    };
  }
}

function contextHasActiveSuppression(context = null) {
  const summary = context?.summary || {};
  const suppression_status = lower(summary.suppression_status || summary.suppressionStatus);
  const suppression_type = lower(summary.suppression_type || summary.suppressionReason);
  const phone_status = lower(
    summary.phone_contact_status ||
      summary.contact_status ||
      context?.items?.phone_item?.phone_contact_status
  );

  if (suppression_status === "suppressed") {
    return { suppressed: true, reason: suppression_type || "context_suppressed" };
  }

  if (
    summary.is_dnc === true ||
    summary.opt_out === true ||
    summary.do_not_call === true ||
    summary.dnc === true ||
    ["opt_out", "opted_out", "dnc", "do_not_call", "suppressed"].includes(phone_status)
  ) {
    return { suppressed: true, reason: "context_dnc" };
  }

  return { suppressed: false, reason: null };
}

function isMissingColumnError(error = null) {
  return error?.code === "42703" || /column .* does not exist/i.test(clean(error?.message));
}

async function findActiveSmsSuppression({ supabase, phoneNumber = "" } = {}) {
  const normalized_phone = normalizeUsPhoneToE164(phoneNumber) || clean(phoneNumber);
  if (!supabase || !normalized_phone) return { suppressed: false, reason: null };

  let last_error = null;
  for (const column of ["phone_e164", "phone_number"]) {
    try {
      const { data, error } = await supabase
        .from("sms_suppression_list")
        .select("id, suppression_reason, suppression_type, is_active, suppressed_at, created_at")
        .eq(column, normalized_phone)
        .eq("is_active", true)
        .limit(1);

      if (error) {
        if (isMissingColumnError(error)) {
          last_error = error;
          continue;
        }
        throw error;
      }

      const row = Array.isArray(data) ? data[0] : null;
      if (row) {
        return {
          suppressed: true,
          reason: clean(row.suppression_type || row.suppression_reason) || "sms_suppression_list",
          row,
        };
      }
    } catch (error) {
      if (isMissingColumnError(error)) {
        last_error = error;
        continue;
      }
      return {
        suppressed: true,
        reason: "suppression_lookup_failed",
        error: error?.message || "suppression_lookup_failed",
      };
    }
  }

  if (last_error) {
    return { suppressed: false, reason: "suppression_columns_unavailable" };
  }

  return { suppressed: false, reason: null };
}

async function findActiveOutreachSuppression({
  supabase,
  ownerId = null,
  phoneNumber = "",
} = {}) {
  const normalized_phone = normalizeUsPhoneToE164(phoneNumber) || clean(phoneNumber);
  if (!supabase || !clean(ownerId) || !normalized_phone) {
    return { suppressed: false, reason: null };
  }

  try {
    const { data, error } = await supabase
      .from("contact_outreach_state")
      .select("id, suppression_until, suppression_reason, touch_count, last_sms_at")
      .eq("podio_master_owner_id", ownerId)
      .eq("to_phone_number", normalized_phone)
      .limit(1);

    if (error) {
      if (isMissingColumnError(error)) return { suppressed: false, reason: null };
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : null;
    const until = row?.suppression_until ? new Date(row.suppression_until) : null;
    if (until && !Number.isNaN(until.getTime()) && until > new Date()) {
      return {
        suppressed: true,
        reason: clean(row.suppression_reason) || "contact_outreach_suppression",
        row,
      };
    }
  } catch (error) {
    return {
      suppressed: true,
      reason: "outreach_suppression_lookup_failed",
      error: error?.message || "outreach_suppression_lookup_failed",
    };
  }

  return { suppressed: false, reason: null };
}

export async function checkInboundAutoReplySuppression({
  supabaseClient = null,
  phoneNumber = "",
  threadKey = "",
  ownerId = null,
  context = null,
} = {}) {
  const context_result = contextHasActiveSuppression(context);
  if (context_result.suppressed) return context_result;

  if (!canUseSupabase(supabaseClient)) {
    return { suppressed: false, reason: "missing_supabase" };
  }

  const supabase = supabaseClient || getDefaultSupabaseClient();
  const phone = clean(phoneNumber) || clean(threadKey);
  const sms_suppression = await findActiveSmsSuppression({ supabase, phoneNumber: phone });
  if (sms_suppression.suppressed) return sms_suppression;

  const outreach_suppression = await findActiveOutreachSuppression({
    supabase,
    ownerId,
    phoneNumber: phone,
  });
  if (outreach_suppression.suppressed) return outreach_suppression;

  return { suppressed: false, reason: null };
}

export async function executeInboundAutomationDecision({
  message,
  threadKey,
  propertyId,
  prospectId,
  ownerId,
  phoneId,
  classification,
  conversationBrain = null,
  latestThreadContext = null,
  context = null,
  inboundFrom = "",
  inboundTo = "",
  inboundEventId = null,
  enableQueueInsert = false,
  applySuppression = true,
  dryRun = true,
  autoReplyMode = null,
  proofRun = false,
  scheduleDelaySeconds = 0,
  timezoneOverride = null,
  contactWindowOverride = null,
  dealAuthority = null,
  strategyDirective = null,
  transitionDirective = null,
  now = new Date().toISOString(),
  supabaseClient = null,
  getSystemValue: getSystemValueImpl = null,
} = {}) {
  const supabase = supabaseClient || getDefaultSupabaseClient();
  const effective_auto_reply_mode = normalizeAutoReplyMode(
    autoReplyMode,
    dryRun ? "dry_run" : enableQueueInsert ? "live_limited" : "disabled"
  );
  const queue_permission = autoReplyModeAllowsQueue({
    mode: effective_auto_reply_mode,
    inboundFrom,
    threadKey,
  });
  let base_decision = applyInboundAutomationDecision({
    message,
    threadKey,
    propertyId,
    prospectId,
    ownerId,
    phoneId,
    classification,
    conversationBrain,
    latestThreadContext,
  });

  // Deterministic negotiation strategy directive (spec §7/§12): the router's
  // template selection overrides the intent-profile route at S5+. Suppression
  // and opt-out handling above/below always win — the directive never
  // reactivates a suppressed contact, and a review-tier strategy blocks
  // queueing outright.
  const strategy_directive_applied = Boolean(
    strategyDirective &&
      typeof strategyDirective === "object" &&
      !base_decision.should_suppress_contact &&
      (strategyDirective.review_required || clean(strategyDirective.template_use_case))
  );
  if (strategyDirective && typeof strategyDirective === "object" && !base_decision.should_suppress_contact) {
    if (strategyDirective.review_required) {
      base_decision = {
        ...base_decision,
        should_queue_reply: false,
        should_mark_human_review: true,
        reply_mode: "manual_review",
        human_review_reason: strategyDirective.review_reason || "negotiation_strategy_review",
        audit_reason: strategyDirective.reason_code || "negotiation_strategy_review",
      };
    } else if (clean(strategyDirective.template_use_case)) {
      base_decision = {
        ...base_decision,
        route_hint: clean(strategyDirective.template_use_case),
        allowed_template_stages: uniq([
          clean(strategyDirective.template_use_case),
          ...asArray(strategyDirective.allowed_template_use_cases).map(clean),
        ]).filter(Boolean),
        negotiation_strategy: strategyDirective.strategy || null,
        audit_reason: strategyDirective.reason_code || base_decision.audit_reason,
      };
    }
  }

  // Canonical lifecycle template authority: when the stage resolver ADVANCED
  // the lifecycle, its required_template_use_case is the next outstanding
  // question and overrides the intent-profile route — the profile only sees
  // the intent, never the extracted facts, so a Spanish "owner + price" reply
  // would otherwise get the S2 interest question instead of the S4 condition
  // probe. The S5+ strategy directive keeps precedence, suppression always
  // wins, and lateral intents (who_is_this, callbacks) never advance so they
  // keep conversational routing. Selection treats this as strict authority:
  // no matching language template ⇒ the existing fail-closed review path,
  // never a profile fallback.
  if (
    !strategy_directive_applied &&
    transitionDirective &&
    typeof transitionDirective === "object" &&
    clean(transitionDirective.required_template_use_case) &&
    !base_decision.should_suppress_contact &&
    base_decision.should_queue_reply
  ) {
    const required_use_case = clean(transitionDirective.required_template_use_case);
    base_decision = {
      ...base_decision,
      route_hint: required_use_case,
      allowed_template_stages: [required_use_case],
      required_template_use_case: required_use_case,
      template_authority: "lifecycle_resolver",
      template_authority_reason: transitionDirective.reasoning_code || null,
    };
  }

  info("[AUTO_REPLY_DECISION]", {
    thread_key: threadKey || null,
    auto_reply_mode: effective_auto_reply_mode,
    auto_reply_mode_queue_allowed: queue_permission.allowed,
    internal_test_phone: queue_permission.internal_test_phone,
    primary_intent: classification?.primary_intent || null,
    objection: classification?.objection || null,
    confidence: classification?.confidence ?? null,
    route_hint: base_decision.route_hint || null,
    should_queue_reply: base_decision.should_queue_reply,
    should_suppress_contact: base_decision.should_suppress_contact,
    should_mark_human_review: base_decision.should_mark_human_review,
    audit_reason: base_decision.audit_reason,
  });

  if (effective_auto_reply_mode === "disabled") {
    const disabled_decision = {
      ...base_decision,
      should_queue_reply: false,
      reply_mode: base_decision.reply_mode || "none",
      execution_blocked_reason: "auto_reply_mode_disabled",
      audit_reason: base_decision.audit_reason || "auto_reply_disabled",
    };

    return {
      ok: true,
      automation_decision: disabled_decision,
      selected_template: null,
      rendered_message_text: null,
      queued: false,
      queue_item_id: null,
      queue_row_id: null,
      queue_result: null,
      suppression_applied: false,
      duplicate_suppressed: false,
      dry_run: true,
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      execution_blocked_reason: "auto_reply_mode_disabled",
      audit_reason: disabled_decision.audit_reason,
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: "auto_reply_mode_disabled",
        plan: automationDecisionToLegacyPlan({
          decision: disabled_decision,
          classification,
        }),
        brain_stage: disabled_decision.route_hint || disabled_decision.stage_hint || null,
        automation_decision: disabled_decision,
      },
    };
  }

  if (base_decision.should_suppress_contact) {
    const suppression_reason = base_decision.suppression_reason || "opt_out";
    const suppression_result = applySuppression
      ? await applyInboundSuppression({
          supabaseClient: supabase,
          phoneNumber: inboundFrom || threadKey,
          phoneId,
          reason: suppression_reason,
          threadKey,
          dryRun,
        })
      : { ok: false, skipped: true, reason: "suppression_disabled" };

    let queue_cancellation = { ok: true, cancelled: 0, reason: "not_attempted" };
    if (!dryRun && supabase) {
      queue_cancellation = await cancelSupabasePendingOutbound(
        {
          thread_key: threadKey || inboundFrom,
          to_phone_number: inboundFrom || threadKey,
          phone_id: phoneId,
          prospect_id: prospectId,
          master_owner_id: ownerId,
          property_id: propertyId,
          policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
          reason: "inbound_compliance_suppression",
          suppression_reason,
          inbound_event_id: inboundEventId,
          cancelled_by: "inbound_automation_decision",
        },
        { supabase }
      );
    }

    return {
      ok: true,
      automation_decision: base_decision,
      selected_template: null,
      rendered_message_text: null,
      queued: false,
      queue_item_id: null,
      queue_row_id: null,
      queue_result: null,
      suppression_applied: Boolean(suppression_result?.ok),
      queue_cancellation,
      duplicate_suppressed: false,
      dry_run: Boolean(dryRun),
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: base_decision.audit_reason,
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: base_decision.audit_reason,
        plan: automationDecisionToLegacyPlan({
          decision: base_decision,
          classification,
        }),
        brain_stage: null,
      },
    };
  }

  if (!base_decision.should_queue_reply) {
    warn("[AUTO_REPLY_BLOCKED]", {
      thread_key: threadKey || null,
      primary_intent: classification?.primary_intent || null,
      audit_reason: base_decision.audit_reason,
      human_review_reason: base_decision.human_review_reason || null,
    });

    return {
      ok: true,
      automation_decision: base_decision,
      selected_template: null,
      rendered_message_text: null,
      queued: false,
      queue_item_id: null,
      queue_row_id: null,
      queue_result: null,
      suppression_applied: false,
      duplicate_suppressed: false,
      dry_run: Boolean(dryRun),
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: base_decision.audit_reason,
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: base_decision.audit_reason,
        plan: automationDecisionToLegacyPlan({
          decision: base_decision,
          classification,
        }),
        brain_stage: null,
      },
    };
  }

  const active_suppression =
    proofRun && queue_permission.internal_test_phone
      ? { suppressed: false, reason: "proof_internal_test_phone" }
      : await checkInboundAutoReplySuppression({
          supabaseClient: supabase,
          phoneNumber: inboundFrom || threadKey,
          threadKey,
          ownerId,
          context: context || latestThreadContext,
        });

  if (active_suppression.suppressed) {
    const suppression_decision = {
      ...base_decision,
      should_queue_reply: false,
      should_suppress_contact: true,
      should_mark_human_review: false,
      reply_mode: "none",
      suppression_reason: active_suppression.reason || "suppressed",
      audit_reason: active_suppression.reason || "suppressed",
    };

    warn("[AUTO_REPLY_BLOCKED]", {
      thread_key: threadKey || null,
      primary_intent: classification?.primary_intent || null,
      audit_reason: suppression_decision.audit_reason,
      suppression_source: active_suppression.reason || null,
    });

    return {
      ok: true,
      automation_decision: suppression_decision,
      selected_template: null,
      rendered_message_text: null,
      queued: false,
      queue_item_id: null,
      queue_row_id: null,
      queue_result: null,
      suppression_applied: false,
      duplicate_suppressed: false,
      dry_run: Boolean(dryRun),
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: suppression_decision.audit_reason,
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: suppression_decision.audit_reason,
        plan: automationDecisionToLegacyPlan({
          decision: suppression_decision,
          classification,
        }),
        brain_stage: null,
      },
    };
  }

  const duplicate = await findRecentInboundAutoReplyDuplicate({
    supabaseClient: supabase,
    threadKey: clean(threadKey) || clean(inboundFrom),
    sourceEventId: inboundEventId,
  });

  if (duplicate.duplicate) {
    const duplicate_decision = {
      ...base_decision,
      should_queue_reply: false,
      should_mark_human_review: false,
      reply_mode: "none",
      audit_reason: duplicate.reason,
    };

    warn("[AUTO_REPLY_DUPLICATE_SUPPRESSED]", {
      thread_key: threadKey || null,
      primary_intent: classification?.primary_intent || null,
      duplicate_reason: duplicate.reason,
      duplicate_row_id: duplicate?.row?.id || null,
    });

    return {
      ok: true,
      automation_decision: duplicate_decision,
      selected_template: null,
      rendered_message_text: null,
      queued: false,
      queue_item_id: duplicate?.row?.id || null,
      queue_row_id: duplicate?.row?.id || null,
      queue_result: null,
      suppression_applied: false,
      duplicate_suppressed: true,
      dry_run: Boolean(dryRun),
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: duplicate.reason,
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: duplicate.reason,
        plan: automationDecisionToLegacyPlan({
          decision: duplicate_decision,
          classification,
        }),
        brain_stage: null,
      },
    };
  }

  const template_result = await selectSafeAutoReplyTemplate({
    supabaseClient: supabase,
    classification,
    decision: base_decision,
    context: context || latestThreadContext,
    threadKey,
    inboundEventId,
  });

  if (!template_result.ok || !template_result.template) {
    const no_template_decision = {
      ...base_decision,
      should_queue_reply: false,
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: "no_safe_template",
      audit_reason: "no_safe_template",
    };

    warn("[AUTO_REPLY_NO_SAFE_TEMPLATE]", {
      thread_key: threadKey || null,
      primary_intent: classification?.primary_intent || null,
      route_hint: base_decision.route_hint || null,
      reason: template_result.reason,
    });

    return {
      ok: true,
      automation_decision: no_template_decision,
      selected_template: null,
      rendered_message_text: null,
      queued: false,
      queue_item_id: null,
      queue_row_id: null,
      queue_result: null,
      suppression_applied: false,
      duplicate_suppressed: false,
      dry_run: Boolean(dryRun),
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: "no_safe_template",
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: "no_safe_template",
        plan: automationDecisionToLegacyPlan({
          decision: no_template_decision,
          classification,
        }),
        brain_stage: null,
      },
    };
  }

  const render_result = renderSafeTemplate({
    template: template_result.template,
    message,
    inboundFrom,
    inboundTo,
    classification,
    context: context || latestThreadContext,
    dealAuthority,
  });

  if (!render_result.ok) {
    const render_failed_decision = {
      ...base_decision,
      should_queue_reply: false,
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: "template_render_failed",
      audit_reason: "template_render_failed",
    };

    warn("[AUTO_REPLY_BLOCKED]", {
      thread_key: threadKey || null,
      primary_intent: classification?.primary_intent || null,
      reason: render_result.reason,
      missing: render_result.missing || [],
    });

    return {
      ok: true,
      automation_decision: render_failed_decision,
      selected_template: template_result.template,
      rendered_message_text: null,
      queued: false,
      queue_item_id: null,
      queue_row_id: null,
      queue_result: null,
      suppression_applied: false,
      duplicate_suppressed: false,
      dry_run: Boolean(dryRun),
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: "template_render_failed",
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: "template_render_failed",
        plan: automationDecisionToLegacyPlan({
          decision: render_failed_decision,
          classification,
          selectedTemplate: template_result.template,
        }),
        brain_stage: clean(template_result.template.use_case) || null,
      },
    };
  }

  const selected_template = template_result.template;
  const rendered_message_text = render_result.rendered_message_text;
  const selected_use_case =
    clean(selected_template.use_case) ||
    routeProfileCandidates(base_decision.route_hint, classification?.primary_intent)[0] ||
    null;
  const scheduled_for = new Date(
    new Date(now).getTime() + Math.max(Number(scheduleDelaySeconds) || 0, 0) * 1000
  ).toISOString();
  const timezone_label =
    clean(timezoneOverride) ||
    clean(context?.summary?.timezone) ||
    clean(context?.summary?.market_timezone) ||
    clean(context?.summary?.timezone_label) ||
    clean(process.env.DEFAULT_CONTACT_TIMEZONE) ||
    "America/Chicago";
  const contact_window =
    clean(contactWindowOverride) ||
    clean(context?.summary?.contact_window) ||
    clean(context?.summary?.market_contact_window) ||
    null;

  const legacy_plan = automationDecisionToLegacyPlan({
    decision: base_decision,
    classification,
    selectedTemplate: selected_template,
    renderedMessageText: rendered_message_text,
  });

  if (!enableQueueInsert || dryRun || !queue_permission.allowed) {
    const preview_reason =
      !queue_permission.allowed && effective_auto_reply_mode !== "dry_run"
        ? queue_permission.reason
        : "dry_run_preview";
    const preview_decision =
      preview_reason === "dry_run_preview"
        ? base_decision
        : {
            ...base_decision,
            should_queue_reply: false,
            should_mark_human_review: false,
            reply_mode: "none",
            audit_reason: preview_reason,
          };
    return {
      ok: true,
      automation_decision: preview_decision,
      selected_template,
      rendered_message_text,
      queued: false,
      queue_item_id: null,
      queue_row_id: null,
      queue_result: null,
      suppression_applied: false,
      duplicate_suppressed: false,
      dry_run: true,
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: preview_decision.audit_reason,
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: preview_reason,
        plan:
          preview_decision === base_decision
            ? legacy_plan
            : automationDecisionToLegacyPlan({
                decision: preview_decision,
                classification,
                selectedTemplate: selected_template,
                renderedMessageText: rendered_message_text,
              }),
        brain_stage: selected_use_case,
        rendered_text: rendered_message_text,
        template_id: clean(selected_template.template_id || selected_template.id) || null,
        preview_result: {
          rendered_message_text,
          template_id: clean(selected_template.template_id || selected_template.id) || null,
          selected_template_source: "sms_templates",
        },
      },
    };
  }

  const normalized_to_phone = normalizeUsPhoneToE164(inboundFrom) || clean(inboundFrom);
  const normalized_from_phone = normalizeUsPhoneToE164(inboundTo) || clean(inboundTo);
  const queue_key = [
    "inbound_auto_reply",
    clean(inboundEventId) || String(Date.now()),
    clean(selected_template.template_id || selected_template.id) || "no-template",
    clean(threadKey) || normalized_to_phone,
  ].join(":");

  const get_system_value =
    getSystemValueImpl || (hasSupabaseConfig() ? getSystemValue : async () => null);
  const runtime_brake = evaluateQueueCreationRuntimeBrakes(
    {
      campaign_mode: await get_system_value("campaign_mode"),
      queue_emergency_stop_at: await get_system_value("queue_emergency_stop_at"),
    },
    { action: "inbound_auto_reply_queue_create", failClosed: false }
  );
  if (!runtime_brake.ok) {
    const blocked_decision = {
      ...base_decision,
      should_queue_reply: false,
      should_mark_human_review: false,
      reply_mode: "none",
      audit_reason: runtime_brake.reason,
    };

    return {
      ok: true,
      automation_decision: blocked_decision,
      selected_template,
      rendered_message_text,
      queued: false,
      queue_item_id: null,
      queue_row_id: null,
      queue_result: {
        ok: false,
        status: 423,
        reason: runtime_brake.reason,
        error: runtime_brake.error,
        diagnostics: runtime_brake.diagnostics,
      },
      suppression_applied: false,
      duplicate_suppressed: false,
      dry_run: true,
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: blocked_decision.audit_reason,
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: blocked_decision.audit_reason,
        plan: automationDecisionToLegacyPlan({
          decision: blocked_decision,
          classification,
          selectedTemplate: selected_template,
          renderedMessageText: rendered_message_text,
        }),
        brain_stage: selected_use_case,
        rendered_text: rendered_message_text,
        template_id: clean(selected_template.template_id || selected_template.id) || null,
      },
    };
  }

  const queue_result = await insertSupabaseSendQueueRow({
    queue_key,
    queue_id: queue_key,
    dedupe_key: buildSendQueueDedupeKey({
      master_owner_id: ownerId,
      property_id: propertyId,
      to_phone_number: normalized_to_phone,
      template_use_case: selected_use_case,
      touch_number: 0,
      campaign_session_id: clean(inboundEventId) || clean(threadKey) || "inbound_auto_reply",
    }),
    queue_status: proofRun ? "proof" : "queued",
    scheduled_for,
    scheduled_for_utc: scheduled_for,
    scheduled_for_local: scheduled_for,
    timezone: timezone_label,
    contact_window,
    send_priority: 5,
    retry_count: 0,
    max_retries: 3,
    message_body: rendered_message_text,
    message_text: rendered_message_text,
    to_phone_number: normalized_to_phone,
    from_phone_number: normalized_from_phone,
    master_owner_id: ownerId || null,
    prospect_id: prospectId || null,
    property_id: propertyId || null,
    phone_number_id: phoneId || null,
    textgrid_number_id: context?.ids?.textgrid_number_id || null,
    template_id: clean(selected_template.template_id || selected_template.id) || null,
    selected_template_id: clean(selected_template.template_id || selected_template.id) || null,
    template_key: clean(selected_template.template_id || selected_template.id) || selected_use_case || null,
    current_stage: clean(selected_template.stage_code) || null,
    message_type: "Follow-Up",
    use_case_template: selected_use_case,
    character_count: rendered_message_text.length,
    thread_key: clean(threadKey) || normalized_to_phone,
    seller_first_name:
      clean(context?.summary?.seller_first_name) ||
      clean(context?.summary?.owner_first_name) ||
      null,
    seller_display_name:
      clean(context?.summary?.owner_name) ||
      clean(context?.summary?.seller_display_name) ||
      null,
    campaign_id: clean(context?.summary?.campaign_id) || null,
    template_source: "sms_templates",
    rendered_message: rendered_message_text,
    priority: base_decision.route_hint === "soft_followup" ? "medium" : "normal",
    risk: classification?.automation_decision?.risk_level || "low",
    sms_eligible: proofRun ? false : true,
    routing_allowed: proofRun ? false : true,
    safety_status: proofRun ? "proof" : "allowed",
    type: "auto_reply",
    source_event_id: inboundEventId || null,
    inbound_message_id: clean(inboundEventId) || null,
    detected_intent: classification?.primary_intent || null,
    stage_before: clean(classification?.stage_hint) || null,
    stage_after: clean(selected_template.stage_code || selected_use_case) || null,
    template_selected: selected_use_case,
    market:
      clean(context?.summary?.market) ||
      clean(context?.summary?.market_name) ||
      null,
    language: clean(selected_template.language) || clean(classification?.language) || "English",
    property_address: clean(context?.summary?.property_address) || null,
    property_type:
      clean(context?.summary?.property_type_scope || context?.summary?.property_type) || null,
    metadata: {
      source: "auto_reply",
      action_type: "autopilot_inbound_reply",
      auto_reply_mode: effective_auto_reply_mode,
      internal_test_phone: queue_permission.internal_test_phone,
      proof: Boolean(proofRun),
      no_send: Boolean(proofRun),
      classification_snapshot: classification,
      automation_decision_snapshot: base_decision,
      selected_template_snapshot: {
        id: selected_template.id || null,
        template_id: selected_template.template_id || null,
        use_case: selected_template.use_case || null,
        stage_code: selected_template.stage_code || null,
        language: selected_template.language || null,
      },
      // Canonical outbound attribution (Mission 5): one deterministic block on
      // every automated send. Promoted to first-class columns by the proposed
      // template attribution migration; lives in metadata until then.
      automation_provenance: buildOutboundTemplateAttribution({
        template: selected_template,
        stage: clean(selected_template.stage_code) || selected_use_case,
        classifiedOutcome: normalizeCanonicalIntent(classification?.primary_intent),
        language: clean(selected_template.language) || clean(classification?.language) || "English",
        experiment: null,
        touchNumber: 0,
        parentOutboundEventId: null,
        automationOrigin: "autopilot_inbound_reply",
      }),
      route_hint: base_decision.route_hint || null,
      allowed_template_stages: base_decision.allowed_template_stages || [],
      property_id: propertyId || null,
      owner_id: ownerId || null,
      prospect_id: prospectId || null,
      phone_id: phoneId || null,
      thread_key: clean(threadKey) || normalized_to_phone,
      inbound_message_event_id: inboundEventId || null,
    },
  }, {
    supabase,
  });

  if (!queue_result?.ok) {
    const blocked_decision = {
      ...base_decision,
      should_queue_reply: false,
      should_mark_human_review: queue_result?.reason !== "duplicate_blocked",
      reply_mode: queue_result?.reason === "duplicate_blocked" ? "none" : "manual_review",
      human_review_reason:
        queue_result?.reason === "duplicate_blocked" ? null : "queue_insert_failed",
      audit_reason: queue_result?.reason || "queue_insert_failed",
    };

    warn("[AUTO_REPLY_BLOCKED]", {
      thread_key: threadKey || null,
      queue_reason: queue_result?.reason || "queue_insert_failed",
      queue_row_id: queue_result?.queue_row_id || null,
    });

    return {
      ok: true,
      automation_decision: blocked_decision,
      selected_template,
      rendered_message_text,
      queued: false,
      queue_item_id: queue_result?.queue_item_id || null,
      queue_row_id: queue_result?.queue_row_id || null,
      queue_result,
      suppression_applied: false,
      duplicate_suppressed: queue_result?.reason === "duplicate_blocked",
      dry_run: false,
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: blocked_decision.audit_reason,
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: blocked_decision.audit_reason,
        plan: automationDecisionToLegacyPlan({
          decision: blocked_decision,
          classification,
          selectedTemplate: selected_template,
          renderedMessageText: rendered_message_text,
          queueResult: queue_result,
        }),
        brain_stage: selected_use_case,
        rendered_text: rendered_message_text,
        template_id: clean(selected_template.template_id || selected_template.id) || null,
        queue_result,
      },
    };
  }

  info("[AUTO_REPLY_QUEUED]", {
    thread_key: threadKey || null,
    primary_intent: classification?.primary_intent || null,
    template_id: clean(selected_template.template_id || selected_template.id) || null,
    queue_item_id: queue_result.queue_item_id || null,
  });

  return {
    ok: true,
    automation_decision: base_decision,
    selected_template,
    rendered_message_text,
    queued: true,
    queue_item_id: queue_result.queue_item_id || null,
    queue_row_id: queue_result.queue_row_id || null,
    queue_result,
    suppression_applied: false,
    duplicate_suppressed: false,
    dry_run: false,
    auto_reply_mode: effective_auto_reply_mode,
    queue_permission,
    audit_reason: base_decision.audit_reason,
    seller_stage_reply: {
      ok: true,
      queued: true,
      handled: true,
      reason: "auto_reply_queued",
      plan: automationDecisionToLegacyPlan({
        decision: base_decision,
        classification,
        selectedTemplate: selected_template,
        renderedMessageText: rendered_message_text,
        queueResult: queue_result,
      }),
      brain_stage: selected_use_case,
      rendered_text: rendered_message_text,
      template_id: clean(selected_template.template_id || selected_template.id) || null,
      queue_row_id: queue_result.queue_row_id || null,
      queue_result,
    },
  };
}

export default applyInboundAutomationDecision;
