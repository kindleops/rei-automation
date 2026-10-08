import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import {
  buildSendQueueDedupeKey,
  insertSupabaseSendQueueRow,
} from "@/lib/supabase/sms-engine.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import {
  isSellerAutopilotV2Enabled,
  isReplyLanguageEnabled,
  parseEnabledLanguages,
  V2_LANGUAGES_KEY,
} from "@/lib/domain/seller-flow/seller-autopilot-v2.js";
import { QUOTE_TYPES, buildNegotiationQuote, quoteTypeFor, recordNegotiationQuote } from "@/lib/domain/seller-flow/negotiation-quotes.js";
import {
  persistActiveOffer as persistActiveOfferDefault,
  bindOfferToQueueRow as bindOfferToQueueRowDefault,
  MONETARY_OFFER_USE_CASES,
} from "@/lib/domain/seller-flow/seller-offer-authority.js";
import {
  normalizeUsPhoneToE164,
  prepareRenderedSmsForQueue,
} from "@/lib/sms/sanitize.js";
import { carriesDispositionDisclosure } from "@/lib/domain/classification/classify.js";
import { info, warn } from "@/lib/logging/logger.js";
import { evaluateQueueCreationRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import {
  autoReplyModeAllowsQueue,
  normalizeAutoReplyMode,
  resolveAutoReplyScopeConfig,
} from "@/lib/domain/seller-flow/auto-reply-mode.js";
import { getSystemValue } from "@/lib/system-control.js";
import { isBareNoAutoClarifierEnabled } from "@/lib/domain/seller-flow/bare-no-clarifier-gate.js";
import { ensureInboundCoverage } from "@/lib/domain/seller-flow/coverage-net/ensure-inbound-coverage.js";
import {
  buildSafeFallback,
  uncertaintyTypeForReason,
} from "@/lib/domain/seller-flow/coverage-net/safe-fallback.js";
import { normalizeCanonicalIntent } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";
// SELLER CONVERSATION v3 (flags SELLER_CONVERSATION_V3 + SELLER_AUTOPILOT_V2,
// default OFF): a planned terminal (archive / nurture / wait) is no reply AND
// no human review; compliance suppression above it always wins.
import { applySellerConversationV3TerminalDecision } from "@/lib/domain/seller-flow/seller-conversation-v3.js";
import { resolveContactIdentityClass } from "@/lib/domain/inbox/contact-identity.js";
import { automationDecisionToLegacyPlan } from "@/lib/domain/seller-flow/inbound-decision-adapters.js";
import { resolveThreadLanguage } from "@/lib/domain/seller-flow/resolve-thread-language.js";
import { templateCatalogLanguageName } from "@/lib/sms/language_aliases.js";
import { buildOutboundTemplateAttribution } from "@/lib/domain/templates/outbound-attribution.js";
import { resolveOwnershipProbeDisinterestTransition } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import {
  cancelSupabasePendingOutbound,
  CANCELLATION_POLICIES,
} from "@/lib/domain/queue/cancel-supabase-pending-outbound.js";

const DEFAULT_DUPLICATE_WINDOW_MINUTES = 10;
/** Upper bound on active+safe template rows read per language pair (see selectSafeAutoReplyTemplate). */
export const TEMPLATE_CANDIDATE_BOUND = 10000;
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
export const REVIEW_ONLY_OBJECTIONS = new Set(["wants_proof_of_funds", "property_correction"]);
// Legal/authority intents (classify.js legal tier): always a human lane.
const LEGAL_AUTHORITY_REVIEW_INTENTS = new Set([
  "title_issue",
  "lien_tax_issue",
  "bankruptcy_disclosed",
  "trust_ownership",
  "llc_corporation",
]);

export const ROUTE_PROFILES = Object.freeze({
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
  // "1 million dollars" on a $182K house (2026-10-06): one light reality
  // check, same stage. No safe price_reality_check template -> review.
  asking_price_implausible: {
    route_hint: "price_reality_check",
    allowed_template_stages: ["price_reality_check"],
    template_use_case_candidates: ["price_reality_check"],
    next_action: "queue_auto_reply",
  },
  latent_interest: {
    route_hint: "seller_asking_price",
    allowed_template_stages: ["seller_asking_price", "stage_3_seller_asking_price"],
    template_use_case_candidates: ["seller_asking_price", "asking_price"],
    next_action: "queue_auto_reply",
  },
  // GOING TO MARKET (future listing, not yet listed). Operator rule 2026-09-10:
  // this is NOT already_listed. The seller has decided to sell, named a
  // timeline, and has no agent yet, which is the best moment to offer an
  // off-market close. already_listed routes to a passive "circle back if the
  // listing doesn't work" message; that is the wrong reply for someone who has
  // not listed. Falls back to the price ask if the off-market template is
  // unavailable, so this can never dead-end.
  going_to_market: {
    route_hint: "off_market_alternative",
    allowed_template_stages: ["going_to_market", "off_market_alternative"],
    template_use_case_candidates: [
      "going_to_market",
      "seller_asking_price",
    ],
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
  // Operator flow: seller has no number -> "I can run some numbers. What
  // condition is the property in?" Never a decline, never a 30 day deferral.
  asking_price_absent: {
    route_hint: "ask_seller_price_or_basic_condition",
    allowed_template_stages: ["condition_probe", "price_high_condition_probe", "ask_condition_clarifier"],
    template_use_case_candidates: [
      "condition_probe",
      "occupancy_probe",
      "price_high_condition_probe",
      "ask_condition_clarifier",
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
    // The IMMEDIATE reply to "not now" acknowledges and leaves the door open;
    // the check-back is the scheduled later follow-up (next_action below).
    // This listed consider_selling_follow_up / asking_price_follow_up /
    // reengagement, and on 2026-09-30 "Not at this time." was answered "Just so
    // I understood the number right, what price would work for you on the
    // property?" (see isTimingDeferralTurn).
    template_use_case_candidates: ["future_nurture"],
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
  // Voicemail reference/ask routes like a callback: acknowledge by SMS, a
  // human handles the phone leg.
  voicemail_call_request: {
    route_hint: "text_only_redirect",
    allowed_template_stages: ["text_only_redirect", "sms_only_response"],
    template_use_case_candidates: ["text_only_redirect", "sms_only_response"],
    next_action: "queue_auto_reply",
  },
  // Email preference is an email lane (ontology contract), routed through the
  // same SMS acknowledgement templates until an email leg exists.
  requests_email: {
    route_hint: "text_only_redirect",
    allowed_template_stages: ["text_only_redirect", "sms_only_response"],
    template_use_case_candidates: ["text_only_redirect", "sms_only_response"],
    next_action: "queue_auto_reply",
  },
  // Explicit language-switch request: no stage restriction — the template
  // selector's language-continuity layer (resolveThreadLanguage + the
  // language fail-closed rule) picks the right-language template for the
  // thread's current stage, or fails closed to human review when none exists.
  language_switch: {
    route_hint: "language_continuity",
    allowed_template_stages: [],
    template_use_case_candidates: [],
    next_action: "queue_auto_reply",
  },
  // LATENT CATALOG BUG, fixed without changing behaviour. The only candidate
  // use case was "not_interested_soft_close", which does not exist in
  // sms_templates -- the real use case is "not_interested" (3 active English
  // templates, already safe_for_auto_reply). Template selection could therefore
  // never have found anything for a decline even if a reply were permitted.
  //
  // next_action stays do_not_reply. Actually SENDING the courteous close that
  // operator item 5 asks for additionally requires moving not_interested off the
  // REVIEW safety tier in seller-flow-safety-policy.js, which is what makes
  // resolveV2ReplyWithhold suppress it downstream. That is a safety-posture
  // change across the whole seller flow and is deliberately NOT bundled here.
  not_interested: {
    route_hint: "soft_close_or_suppress",
    allowed_template_stages: ["not_interested", "not_interested_soft_close", "future_nurture"],
    template_use_case_candidates: ["not_interested", "not_interested_soft_close", "future_nurture"],
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
  compound_opportunity = null,
  context_resolution = null,
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
    // Compound-message payload: positive second-clause intents and extracted
    // address candidates that survived a leading negative intent. Persisted
    // in decision snapshots so review lanes see the full message meaning.
    compound_opportunity: compound_opportunity || null,
    // §6 identity provenance (status / confidence / evidence / repair) when the
    // orchestrator resolved context for this turn; null for legacy callers.
    context_resolution: context_resolution || null,
  };
}

// Positive second-clause intents that must survive a leading negative intent
// ("not for sale, but what would you pay for 456 Oak Ave?"). A message whose
// first clause is negative and whose remainder carries one of these — or a
// street-address candidate — is a compound opportunity, never a bare decline.
const COMPOUND_POSITIVE_INTENTS = new Set([
  "seller_interested",
  "latent_interest",
  "asks_offer",
  "asking_price_provided",
]);

function resolveCompoundOpportunitySignal(classification = {}) {
  const matched = Array.isArray(classification.matched_intents)
    ? classification.matched_intents
    : [];
  const secondary = Array.isArray(classification.secondary_intents)
    ? classification.secondary_intents
    : [];
  const positive_intents = [...new Set([...matched, ...secondary])].filter((intent) =>
    COMPOUND_POSITIVE_INTENTS.has(intent)
  );
  const address_signals = Array.isArray(classification.address_signals)
    ? classification.address_signals
    : [];
  const high_confidence_addresses = address_signals.filter(
    (candidate) => candidate?.confidence === "high"
  );
  const low_confidence_addresses = address_signals.filter(
    (candidate) => candidate?.confidence === "low"
  );
  // A suffix-bearing address stands on its own; a bare "<number> <word>" pair
  // only counts alongside an explicit positive intent, so noise can never
  // divert a clean decline into the opportunity lane.
  const has_alternate_address =
    high_confidence_addresses.length > 0 ||
    (low_confidence_addresses.length > 0 && positive_intents.length > 0);
  return {
    positive_intents,
    address_candidates: address_signals,
    has_positive_signal: positive_intents.length > 0,
    has_alternate_address,
    is_compound_opportunity: positive_intents.length > 0 || has_alternate_address,
  };
}

function computeInboundAutomationDecisionRaw({
  // §6 ContextResolutionResult (status / confidence / evidence); the wrapper
  // passes its args straight through, so this arrives from applyInboundAutomationDecision(args).
  contextResolution = null,
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
    // §6: a GENUINELY AMBIGUOUS resolution (two contexts, no authority to pick)
    // is not "missing context" -- it routes to the owned
    // conflicting_property_identity workflow, never the generic clarifier.
    const ambiguous = contextResolution?.status === "ambiguous";
    const reason = ambiguous ? "conflicting_property" : "missing_context";
    return buildDecisionResult({
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: reason,
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "mark_human_review",
      audit_reason: reason,
      context_resolution: contextResolution || null,
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

  // Property sold — terminal for the seller×property PAIRING only. The
  // contact is never suppressed: a former owner of one property is a
  // legitimate seller of others ("I sold 123 Main, but I own 456 Oak").
  if (primary_intent === "sold_property" || primary_intent === "former_owner_respondent") {
    const compound = resolveCompoundOpportunitySignal(classification);
    if (compound.is_compound_opportunity) {
      return buildDecisionResult({
        should_mark_human_review: true,
        reply_mode: "manual_review",
        human_review_reason: "sold_with_new_opportunity",
        route_hint,
        stage_hint,
        allowed_template_stages,
        next_action: "mark_human_review",
        audit_reason: "sold_with_new_opportunity",
        compound_opportunity: compound,
      });
    }
    return buildDecisionResult({
      should_suppress_contact: false,
      reply_mode: "none",
      next_action: "disposition_property_sold",
      audit_reason: "property_sold",
    });
  }

  if (primary_intent === "wrong_number") {
    // "Wrong person, but 456 Oak Street might be for sale" — an explicit
    // seller signal or extracted address must reach a human, not vanish
    // behind the archive. A bare wrong-number still archives at phone scope.
    const compound = resolveCompoundOpportunitySignal(classification);
    if (compound.is_compound_opportunity) {
      return buildDecisionResult({
        should_mark_human_review: true,
        reply_mode: "manual_review",
        human_review_reason: "wrong_person_with_seller_signal",
        route_hint,
        stage_hint,
        allowed_template_stages,
        next_action: "mark_human_review",
        audit_reason: "wrong_person_with_seller_signal",
        compound_opportunity: compound,
      });
    }
    return buildDecisionResult({
      should_suppress_contact: true,
      reply_mode: "none",
      suppression_reason: "wrong_number",
      next_action: "archive_wrong_number",
      audit_reason: "wrong_number",
    });
  }

  // Legal/authority disclosures (ontology legal_financial lane): title
  // problems, liens/back taxes, bankruptcy, trust-held or entity-held
  // ownership. Authority/payoff verification is a human lane BEFORE any offer
  // conversation — precise reason preserved for audit; never suppression.
  if (LEGAL_AUTHORITY_REVIEW_INTENTS.has(primary_intent)) {
    return buildDecisionResult({
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: primary_intent,
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "mark_human_review",
      audit_reason: primary_intent,
    });
  }

  // Round 9 (owner 2026-10-07): hostility with no legal threat and no opt-out
  // language ("Suck a dick", "FU!", "👹", trolling) is a QUIET ARCHIVE: no
  // reply, nothing suppressed, never a review item. The classifier sets
  // quiet_archive only for those rule families; a legal threat keeps review.
  if (
    (primary_intent === "hostile_or_legal" || primary_intent === "hostile_or_troll") &&
    automation_decision?.quiet_archive === true &&
    automation_decision?.human_review_required === false
  ) {
    return buildDecisionResult({
      should_mark_human_review: false,
      reply_mode: "none",
      route_hint,
      stage_hint,
      allowed_template_stages,
      // A concrete terminal action (not a bare "none"), so the coverage net
      // records no_reply_action_coverage instead of forcing a review. Never
      // "do_not_reply": that schedules a nurture, and hostility gets none.
      next_action: "close_quietly",
      audit_reason: "hostile_quiet_archive",
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

  // A polite close ("Thanks", "OK, thank you very much") or a retracted
  // tapback: the classifier already decided no reply and no review. Nothing
  // goes to a person's queue for it (round 8).
  const closing_kind = clean(automation_decision?.reply_kind);
  if (
    (primary_intent === "acknowledgement" || primary_intent === "reaction_only") &&
    (closing_kind === "polite_close" || closing_kind === "reaction_removed") &&
    automation_decision?.human_review_required === false
  ) {
    return buildDecisionResult({
      should_mark_human_review: false,
      reply_mode: "none",
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "none",
      audit_reason: closing_kind,
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
    const compound = resolveCompoundOpportunitySignal(classification);
    // "That house isn't for sale, but I might sell 123 Oak Street" — the
    // second clause names a DIFFERENT property. Extraction + review, never a
    // silent decline: the decline applies to the campaign property only.
    if (compound.has_alternate_address) {
      return buildDecisionResult({
        should_mark_human_review: true,
        reply_mode: "manual_review",
        human_review_reason: "new_property_opportunity",
        route_hint,
        stage_hint,
        allowed_template_stages,
        next_action: "mark_human_review",
        audit_reason: "new_property_opportunity",
        compound_opportunity: compound,
      });
    }
    // "Not for sale. But what would you pay?" — same property, the seller
    // invited an offer conversation. The decline clause must not erase the
    // question: route as asks_offer when the classification is confident;
    // execution-time mode/scope/window gates still apply downstream.
    if (compound.positive_intents.includes("asks_offer")) {
      const auto_reply_allowed = confidence >= 0.85 && compliance_flag !== "stop_texting";
      const asks_offer_profile = ROUTE_PROFILES.asks_offer;
      return buildDecisionResult({
        should_queue_reply: auto_reply_allowed,
        should_mark_human_review: !auto_reply_allowed,
        reply_mode: auto_reply_allowed ? "auto" : "manual_review",
        human_review_reason: auto_reply_allowed ? null : "declined_but_asks_offer",
        route_hint: asks_offer_profile.route_hint,
        stage_hint,
        allowed_template_stages: asks_offer_profile.allowed_template_stages,
        next_action: auto_reply_allowed ? "queue_auto_reply" : "mark_human_review",
        audit_reason: "declined_but_asks_offer",
        compound_opportunity: compound,
      });
    }
    return buildDecisionResult({
      route_hint,
      stage_hint,
      allowed_template_stages,
      next_action: "do_not_reply",
      audit_reason: "not_interested",
      compound_opportunity: compound.is_compound_opportunity ? compound : null,
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
      // One light reality-check question (ROUTE_PROFILES.asking_price_implausible).
      "asking_price_implausible",
      "tenant_occupied",
      "condition_disclosed",
      "callback_requested",
      "voicemail_call_request",
      "requests_email",
      "language_switch",
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
      primary_intent === "voicemail_call_request" ? ROUTE_PROFILES.voicemail_call_request :
      primary_intent === "requests_email" ? ROUTE_PROFILES.requests_email :
      primary_intent === "language_switch" ? ROUTE_PROFILES.language_switch :
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
  // A compound message ("not for sale, but what would you pay for 456 Oak?")
  // must never be flattened to the silent advance-with-followup outcome —
  // the base decision already routed the positive clause (reply or review).
  // This overlay only applies to a PURE property-specific decline.
  const compound = resolveCompoundOpportunitySignal(args.classification || {});
  if (compound.is_compound_opportunity) return decision;
  // Owner decision 2026-10-06: a bare "No"/"Nope" to the OWNERSHIP question
  // gets the ONE connection clarifier the classifier authorized; it is not a
  // property decline to park for 30 days.
  if (
    clean(args.classification?.automation_decision?.clarification_use_case) === "ownership_connection_clarifier"
  ) {
    return decision;
  }

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
  // REAL lifecycle stage first. classification.stage_hint is a legacy TOPIC
  // label from detectStageHint(), which returns "Offer" for ANY message
  // mentioning "offer", "price", "number" or "how much". It used to win here, so
  // a seller asking us for a number was recorded as being AT the offer stage and
  // received copy that assumed we had already made one. It is now the last
  // resort, and resolveStageBucket() will not promote a topic label to a late
  // bucket even when it does get used.
  const stage =
    clean(args.latestThreadContext?.summary?.conversation_stage) ||
    clean(args.conversationBrain?.conversation_stage) ||
    clean(classification.stage_hint) ||
    null;
  const contact_identity = resolveContactIdentityClass({
    detected_intent: classification.primary_intent || classification.detected_intent || null,
    master_owner_id: args.ownerId || args.latestThreadContext?.ids?.master_owner_id || null,
    prospect_id: args.prospectId || args.latestThreadContext?.ids?.prospect_id || null,
    property_id: args.propertyId || args.latestThreadContext?.ids?.property_id || null,
    conversation_stage: stage,
    metadata: classification.metadata || {},
  });
  return applySuppressionCandidateHold(
    applySellerConversationV3TerminalDecision(
      ensureInboundCoverage(raw, { stage, contact_identity, classification }),
      classification,
    ),
    classification,
  );
}

/**
 * Round 10 (owner 2026-10-08): a repeated demand to stop contacting without an
 * explicit revocation phrase (classify.js rule repeat_no_contact_frustration)
 * is a SUPPRESSION CANDIDATE. It is applied LAST so no overlay (ownership
 * probe nurture, coverage fallback, v3 terminal) can turn it into a reply, a
 * nurture or a quiet archive. An explicit opt-out (should_suppress_contact)
 * always wins -- that is the canonical suppression path.
 */
export function isSuppressionCandidateClassification(classification = {}) {
  const decision = classification?.automation_decision || {};
  if (clean(classification?.compliance_flag) === "stop_texting") return false;
  if (clean(classification?.primary_intent) === "opt_out") return false;
  return (
    decision.suppression_candidate === true ||
    (Array.isArray(classification?.matched_rule_ids) &&
      classification.matched_rule_ids.includes("repeat_no_contact_frustration"))
  );
}

function applySuppressionCandidateHold(decision = {}, classification = {}) {
  if (!decision || decision.should_suppress_contact) return decision;
  if (!isSuppressionCandidateClassification(classification)) return decision;
  return {
    ...decision,
    should_queue_reply: false,
    should_suppress_contact: false,
    should_mark_human_review: true,
    reply_mode: "manual_review",
    human_review_reason: "suppression_candidate",
    next_action: "hold_suppression_candidate",
    audit_reason: "suppression_candidate",
    suppression_candidate: true,
    hold_pending_sends: true,
  };
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
  // Round 9 (2026-10-07: "no speako aspanish" to a Spanish ownership text):
  // a language switch / refusal is answered with the SAME question in the
  // language the seller can read -- the question it answered, when known.
  if (primary_intent === "language_switch" && clean(classification.context_use_case)) {
    return [clean(classification.context_use_case)];
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
export const LOCAL_NEGOTIATION_AUTO_REPLY_USE_CASES = new Set([
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
  // Closing lane: the seller conversation continues autonomously THROUGH
  // closing rather than stopping at signature.
  "request_signer_email",
  "contract_sent_notice",
  "contract_signed_confirmation",
  "title_opened_update",
  "closing_scheduled_update",
]);

async function selectLocalNegotiationTemplate(allowed_matches = [], { strategy = null, excludePlaceholders = [], excludeTemplateIds = [] } = {}) {
  const excluded = new Set(asArray(excludePlaceholders).map((v) => clean(v)).filter(Boolean));
  const excluded_ids = new Set(asArray(excludeTemplateIds).map((v) => clean(v)).filter(Boolean));
  try {
    const { LOCAL_TEMPLATE_CANDIDATES, verifyLocalAutoReplyApproval, isLocalTemplateFallbackKilled } =
      await import("@/lib/domain/templates/local-template-registry.js");
    // Immediate kill switch: fallback can be revoked globally without a deploy.
    if (isLocalTemplateFallbackKilled()) return null;
    for (const row of LOCAL_TEMPLATE_CANDIDATES) {
      if (!LOCAL_NEGOTIATION_AUTO_REPLY_USE_CASES.has(lower(row.use_case))) continue;
      if (!allowed_matches.includes(lower(row.use_case))) continue;
      if (lower(row.active) !== "yes") continue;
      if (excluded.size > 0 && templatePlaceholders(row.text).some((name) => excluded.has(name))) continue;
      if (excluded_ids.has(clean(row.item_id))) continue;
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

// ── Stage-aware safe-fallback clarifier (audit item 2) ─────────────────────
// The coverage net has always PREPARED a stage-aware clarifier for ambiguous
// messages (coverage-net/safe-fallback.js) but nothing dispatched it, so every
// unclear/reaction/acknowledgement turn dead-ended in human review. This gate
// converts ONLY the safe-ambiguous subset into a clarifier send. Fail-closed:
// - fires only for review decisions with the ambiguous reasons below;
// - fires only for the ambiguous intents (unclear / reaction_only /
//   acknowledgement) — legal, probate/distress, price-objection, referral,
//   property-correction and every other protected review lane keeps review;
// - never fires on suppression, opt-out/compliance, or a suppressive
//   classifier decision;
// - the executor's suppression lookup, duplicate dedup, render safety, mode /
//   allowlist / cutoff authority, and queue-time contact-window gates all still
//   run downstream, exactly as for any other auto-reply.
const CLARIFIER_REVIEW_REASONS = new Set([
  "unclear_low_confidence",
  "ambiguous_intent",
  "ambiguous_context",
  "automation_review_required",
]);
// Intents eligible for the safe clarifier when the intent-specific reply path
// has ALREADY declined (see the guards in resolveSafeFallbackClarifierDispatch:
// this never overrides a real reply, it only replaces SILENCE).
//
// Widened 2026-09-09. Previously only unclear/reaction_only/acknowledgement,
// which meant a seller whose intent WAS understood but scored below the 0.82
// autonomy gate got nothing at all -- a bare "Yes" to an ownership question
// scores 0.72 in some thread contexts, so a genuine owner confirming ownership
// was answered on one thread and ignored on the next. At 10k messages/day that
// is the difference between an auto-responder and a lottery.
//
// Deliberately EXCLUDED, and they must stay excluded: opt_out and wrong_number
// (compliance silence), sold_property, hostile_or_legal, and the distress
// lanes (title_issue, lien_tax_issue, bankruptcy_disclosed) -- those need a
// human, and a cheerful clarifier would be the wrong answer, not a late one.
export const CLARIFIER_INTENTS = new Set([
  "unclear",
  "reaction_only",
  "acknowledgement",
  "ownership_confirmed",
  "seller_interested",
  "latent_interest",
  "asks_offer",
  "asking_price_provided",
  "asking_price_implausible",
  // ANTI-SILENCE: every routed intent must ALSO have clarifier backup, so
  // losing its route can never strand it. coverage-graph-audit enforces this
  // and caught both of these arriving with a route and no backup.
  "asking_price_absent",
  "going_to_market",
  "condition_disclosed",
  "tenant_occupied",
  "need_time",
  "who_is_this",
  "info_request",
  "callback_requested",
  "voicemail_call_request",
  "requests_email",
  "property_correction",
  "language_switch",
  "trust_ownership",
  "llc_corporation",
]);

// The clarifier used to be capped at 4 words on the theory that a longer
// unparsed message ("we closed on it in March") hides a disposition-relevant
// disclosure that deserves a human. In production that theory produced
// SILENCE, not review: nobody reads the review lane in real time, so a seller
// writing one ordinary sentence got nothing back. "I call u but u not
// answering di phone" (9 words) is the case that proved it.
//
// The cap is now a sanity bound, not a policy. Containment for genuinely
// sensitive content does not come from message length -- it comes from the
// guards below, which are unchanged: compliance_flag, any active suppression,
// high-risk and review-only objections (probate, distress, divorce), emoji-only
// messages, and the CLARIFIER_INTENTS allowlist that keeps opt-out,
// wrong-number, sold-property, hostility and the distress lanes out entirely.
// Past this length a message is a narrative, and a clarifying question really
// would be the wrong response.
const CLARIFIER_MAX_MESSAGE_WORDS = 60;

/**
 * HARD INVARIANT — the classifier's own automation verdict binds.
 *
 * When the classifier says auto_reply_allowed=false OR human_review_required=
 * true, no automatic seller-response may be queued. Production, 2026-09-25:
 * "Do you want to tour the house? We can meet at it." classified unclear
 * (confidence 0.6, auto_reply_allowed=false, human_review_required=true), the
 * decision correctly routed to review — and the safe-fallback clarifier then
 * converted that review into `safe_clarifier_intent_asking_price` ("Got it. Do
 * you have a ballpark number in mind for it?"). Only the sender-health guard
 * stopped it. No documented exception authorizes overriding a classifier
 * human-review verdict, so none is honoured here. The one documented exception
 * to auto_reply_allowed=false is an immediate-send negotiation strategy
 * directive (send_authority = negotiation_strategy_directive): a proactive
 * send (e.g. OCCUPANCY_DISCOVERY after "yes I own it") the intent alone would
 * not call for.
 */
export function classifierForbidsAutoReply(classification = null) {
  const authority = classification?.automation_decision;
  if (!authority || typeof authority !== "object") return { forbidden: false, reason: null };
  if (authority.human_review_required === true) return { forbidden: true, reason: "classifier_human_review_required" };
  if (authority.auto_reply_allowed === false) return { forbidden: true, reason: "classifier_auto_reply_not_allowed" };
  return { forbidden: false, reason: null };
}

export function resolveSafeFallbackClarifierDispatch({
  decision = null,
  classification = null,
  stage = null,
  message = null,
} = {}) {
  if (!decision || decision.should_queue_reply) return null;
  // The clarifier replaces silence only where the classifier permits a reply;
  // it never overrides a classifier human-review verdict.
  if (classifierForbidsAutoReply(classification).forbidden) return null;
  if (decision.should_mark_human_review !== true) return null;
  if (decision.should_suppress_contact) return null;

  // 7.2 EMOJI CONFIRMATION (2026-10-01). The classifier itself authorized ONE
  // confirmation question for an emoji-only likely yes / likely no to a known
  // question: its automation_decision says reply_kind=clarification and names
  // the sms_templates use case. The copy is an sms_templates row -- never code
  // -- so the send carries a real template_id; a language without a row fails
  // closed to review in selectSafeAutoReplyTemplate. The stage does not move.
  // Any other pure-emoji message stays review (the guard below).
  const emoji_clarification_use_case =
    classification?.automation_decision?.reply_kind === "clarification"
      ? lower(clean(classification.automation_decision.clarification_use_case))
      : "";
  if (emoji_clarification_use_case) {
    if (classification?.compliance_flag) return null;
    if (lower(classification?.primary_intent) !== "unclear") return null;
    const emoji_reason = lower(decision.human_review_reason || decision.audit_reason || "");
    if (!CLARIFIER_REVIEW_REASONS.has(emoji_reason)) return null;
    return {
      template_use_case: emoji_clarification_use_case,
      uncertainty_type: "emoji_confirmation",
      stage_bucket: classification?.emoji_interpretation?.answers?.stage_bucket || null,
      strategy: classification?.emoji_interpretation?.clarification?.strategy || null,
      suggested_text: null,
    };
  }

  const message_text = clean(message);
  const message_words = message_text.split(/\s+/).filter(Boolean).length;
  if (message_words === 0 || message_words > CLARIFIER_MAX_MESSAGE_WORDS) {
    return null;
  }
  // Pure-emoji / symbol-only messages carry sentiment the deterministic
  // classifier cannot read (a middle-finger emoji classifies reaction_only) —
  // review, never a cheerful clarifier. 👍/👎 still context-bind upstream as
  // yes/no before this gate is ever reached.
  if (!/[\p{L}\p{N}]/u.test(message_text)) {
    return null;
  }
  // A disposition-relevant disclosure gets a HUMAN, never a clarifying
  // question. "We closed on it in March" parses as `unclear` because the
  // classifier under-detected it, and answering that with "are you open to a
  // proposal?" is the wrong reply, not a late one. This is the real test that
  // the old 4-word cap was standing in for; it reuses the canonical
  // sold/transferred and wrong-number matchers from the intent resolver.
  if (carriesDispositionDisclosure(message_text)) {
    return null;
  }

  const intent = lower(
    classification?.primary_intent || classification?.detected_intent || ""
  );
  if (!CLARIFIER_INTENTS.has(intent)) return null;
  if (classification?.compliance_flag) return null;
  if (
    classification?.automation_decision &&
    classification.automation_decision.suppression_action !== "none"
  ) {
    return null;
  }
  // Protected-lane objections: probate / financial-distress / divorce and the
  // review-only objections demand a HUMAN even when the primary intent parsed
  // as unclear ("still going through probate" → unclear + probate objection).
  // The clarifier must never convert those reviews.
  const objection = lower(classification?.objection || "");
  if (
    objection &&
    (HIGH_RISK_OBJECTIONS.has(objection) || REVIEW_ONLY_OBJECTIONS.has(objection))
  ) {
    return null;
  }

  const reason = lower(decision.human_review_reason || decision.audit_reason || "");
  if (!CLARIFIER_REVIEW_REASONS.has(reason)) return null;

  const fallback = buildSafeFallback({
    stage,
    uncertainty_type: uncertaintyTypeForReason(reason, intent),
  });
  if (!clean(fallback?.suggested_text)) return null;

  return {
    suggested_text: fallback.suggested_text,
    uncertainty_type: fallback.uncertainty_type,
    stage_bucket: fallback.stage_bucket,
  };
}

// ── A decline is never answered with an interest probe (2026-09-30) ─────────
// "Yes and I'm not interested in selling it" (+14697324317) selected and
// rendered consider_selling -- "Thanks for confirming. Would you consider a
// proposal for the property?". Two things combined:
//   1. the S1 not-for-sale overlay (applyOwnershipProbeOverlay) stamps
//      route_hint/allowed_template_stages = consider_selling(+_follow_up). That
//      is LIFECYCLE metadata -- the thread advances to S2 and a nurture
//      follow-up is scheduled -- not a reply route, yet it was unioned into
//      the immediate-reply candidates next to the not_interested profile;
//   2. every catalog row ties on success_rate/usage_count/updated_at, so the
//      winner was whichever row Postgres returned first.
// On a pure decline turn the only use cases an immediate reply may carry are
// the decline profile's own (soft close / future nurture). This only NARROWS
// selection -- it can make a turn fail closed (no template), never send.
// Deliberately NOT a pure decline, and left to their own authority:
//   - the compound "not for sale, but what would you pay?" route
//     (declined_but_asks_offer): the seller asked for a number;
//   - a negotiation-strategy turn (S5+): the strategy router owns its template.
export const DECLINE_SAFE_REPLY_USE_CASES = Object.freeze(
  ROUTE_PROFILES.not_interested.template_use_case_candidates.map((use_case) => lower(use_case))
);

export function isPureDeclineTurn({ classification = null, decision = null } = {}) {
  const intent = normalizeCanonicalIntent(
    classification?.primary_intent || classification?.detected_intent || null
  );
  if (intent !== "not_interested") return false;
  if (
    clean(decision?.negotiation_strategy) ||
    decision?.send_authority === "negotiation_strategy_directive"
  ) {
    return false;
  }
  if (
    lower(decision?.audit_reason) === "declined_but_asks_offer" ||
    lower(decision?.route_hint) === lower(ROUTE_PROFILES.asks_offer.route_hint)
  ) {
    return false;
  }
  return true;
}

// A timing deferral ("Not at this time.", "Maybe next year") is a soft no for
// the immediate reply: only an acknowledgment may go out (future nurture, or
// the decline profile's soft close). Same narrowing-only contract as the pure
// decline above; negotiation-strategy turns keep their own authority.
export const TIMING_SAFE_REPLY_USE_CASES = Object.freeze(
  uniq(["future_nurture", ...DECLINE_SAFE_REPLY_USE_CASES])
);

export function isTimingDeferralTurn({ classification = null, decision = null } = {}) {
  const intent = normalizeCanonicalIntent(
    classification?.primary_intent || classification?.detected_intent || null
  );
  if (intent !== "need_time") return false;
  if (
    clean(decision?.negotiation_strategy) ||
    decision?.send_authority === "negotiation_strategy_directive"
  ) {
    return false;
  }
  return true;
}

// Templates whose wording presumes the seller already gave a number ("Just so
// I understood the number right, what price would work for you?"). They may
// only answer a message that actually carries one.
export const NUMBER_PRESUMING_USE_CASES = Object.freeze(["asking_price_follow_up"]);

export function inboundCarriesNumber(text = "") {
  const value = String(text || "").toLowerCase();
  if (/\d/.test(value)) return true;
  return /\b(hundred|thousand|million|mil|grand|k)\b/.test(value);
}

export async function selectSafeAutoReplyTemplate({
  supabaseClient = null,
  classification = null,
  decision = null,
  context = null,
  threadKey = null,
  inboundEventId = null,
  // Placeholders that cannot be filled for this thread: templates using them
  // are skipped so a variant without them (or none) is chosen instead.
  excludePlaceholders = [],
  // Templates already sent on this thread: a repeat would be duplicate_blocked
  // (or, worse, the identical text twice), so they are skipped.
  excludeTemplateIds = [],
} = {}) {
  if (!canUseSupabase(supabaseClient)) {
    return { ok: false, reason: "missing_supabase", template: null };
  }
  const excluded_template_ids = new Set(asArray(excludeTemplateIds).map((v) => clean(v)).filter(Boolean));
  const excluded_placeholders = new Set(asArray(excludePlaceholders).map((v) => clean(v)).filter(Boolean));
  const usesExcludedPlaceholder = (body) =>
    excluded_placeholders.size > 0 && templatePlaceholders(body).some((name) => excluded_placeholders.has(name));

  const supabase = supabaseClient || getDefaultSupabaseClient();
  // Language continuity (activation spec): an established thread/prospect
  // language always wins over per-message detection so one terse "ok" in a
  // Spanish conversation can never flip the reply to English. Unknown (fresh
  // thread, no signal anywhere) keeps today's English default for template
  // search but is recorded on the result so review surfaces can see it.
  // OWNER RULE (2026-10-05): the reply is written in the language the SELLER
  // replied in. When the classifier derived the language from the seller's own
  // text (this reply, or their most recent identifiable one -- never a tapback),
  // it outranks the stored thread language; otherwise ("ok", "👍", no seller
  // text yet) the continuity chain below decides exactly as before.
  const seller_language_sources = new Set(["seller_reply", "seller_history", "language_switch_request"]);
  const seller_language =
    seller_language_sources.has(clean(classification?.reply_language_source)) &&
    clean(classification?.language)
      ? clean(classification.language)
      : null;
  const language_resolution = resolveThreadLanguage({
    threadLanguage:
      seller_language ||
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
  // sms_templates labels (Hindi is stored as "Indian (Hindi or Other)").
  const language = language_resolution.is_unknown
    ? "English"
    : templateCatalogLanguageName(language_resolution.language) || language_resolution.language;
  const languages = language === "English" ? ["English"] : [language, "English"];

  // Safe-fallback clarifier dispatch: the decision carries the coverage-net's
  // prepared stage-aware clarifier. Same idiom as the local negotiation
  // registry fallback below — a code-authored, PR-reviewed body instead of a
  // DB row. Language stays fail-closed: clarifier texts are English (the
  // `language` uncertainty text is bilingual), so a non-English thread keeps
  // the review path rather than receiving an English clarifier.
  const clarifier = decision?.clarifier_dispatch;
  if (clean(clarifier?.suggested_text)) {
    if (language !== "English" && clarifier.uncertainty_type !== "language") {
      return { ok: false, reason: "clarifier_language_unavailable", template: null };
    }
    const clarifier_template = {
      template_id: `safe_clarifier_${clarifier.uncertainty_type}_${clarifier.stage_bucket}`,
      use_case: "safe_clarifier",
      stage_code: null,
      language: "English",
      template_body: clarifier.suggested_text,
      safe_for_auto_reply: true,
      reply_mode: "auto",
      template_name: "Stage-aware safe clarifier (coverage-net)",
    };
    info("[AUTO_REPLY_TEMPLATE_SELECTED]", {
      route_hint: decision?.route_hint || null,
      primary_intent: classification?.primary_intent || null,
      template_id: clarifier_template.template_id,
      use_case: clarifier_template.use_case,
      stage_code: null,
      language: clarifier_template.language,
    });
    return {
      ok: true,
      reason: "safe_fallback_clarifier",
      language_resolution,
      template: clarifier_template,
    };
  }
  // Lifecycle-resolver authority (see executeInboundAutomationDecision): a
  // required use case restricts matching to EXACTLY that use case so the
  // intent profile's candidates cannot leak a stage-earlier question back in.
  const required_use_case = lower(clean(decision?.required_template_use_case));
  // SELLER AUTOPILOT V2 (flag-only): an exact, ordered preference list. Set
  // only by the v2 directive; absent ⇒ this function is unchanged.
  const v2_preference = asArray(decision?.v2_template_preference).map((v) => lower(clean(v))).filter(Boolean);
  const route_matches = v2_preference.length
    ? v2_preference
    : required_use_case
    ? [required_use_case]
    : uniq([
        ...asArray(decision?.allowed_template_stages).map(lower),
        lower(decision?.route_hint),
        ...templateCandidateSet(decision, classification).map(lower),
      ]);
  // Pure decline / timing deferral: intersect with the safe profile (see
  // DECLINE_SAFE_REPLY_USE_CASES / TIMING_SAFE_REPLY_USE_CASES). A required use
  // case outside it is dropped too, so this fails closed.
  const decline_turn = isPureDeclineTurn({ classification, decision });
  const timing_turn = !decline_turn && isTimingDeferralTurn({ classification, decision });
  const safe_use_cases = decline_turn
    ? DECLINE_SAFE_REPLY_USE_CASES
    : timing_turn
      ? TIMING_SAFE_REPLY_USE_CASES
      : null;
  const allowed_matches = safe_use_cases
    ? route_matches.filter((value) => safe_use_cases.includes(value))
    : route_matches;
  const property_type_scope = derivePropertyTypeScope(context);
  const latest_inbound_text =
    context?.automation_decision?.inbound_detection?.latest_inbound_text ||
    classification?.message_text ||
    classification?.normalized_text ||
    "";

  if (!supabase || allowed_matches.length === 0) {
    return {
      ok: false,
      reason:
        allowed_matches.length === 0
          ? decline_turn && route_matches.length > 0
            ? "decline_turn_no_decline_safe_route"
            : timing_turn && route_matches.length > 0
              ? "timing_turn_no_timing_safe_route"
              : "no_template_route_candidates"
          : "missing_supabase",
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
      // DEFECT FIX (2026-10-06): this was .limit(100). Today's pool is 85
      // active+safe rows across EN+ES, so approving one more language's rows
      // would have SILENTLY truncated the candidates (row order, not rank,
      // deciding which templates exist). The bound is now far above the whole
      // active catalog (~9K rows, all languages) and hitting it is an alarm,
      // never a silent cut.
      .limit(TEMPLATE_CANDIDATE_BOUND);

    if (error) throw error;
    if (Array.isArray(data) && data.length >= TEMPLATE_CANDIDATE_BOUND) {
      warn("[AUTO_REPLY_TEMPLATE_POOL_AT_BOUND]", { bound: TEMPLATE_CANDIDATE_BOUND, languages });
    }

    const candidates = (Array.isArray(data) ? data : [])
      .filter((row) => {
        const matches = normalizeTemplateMatchValues(row);
        return matches.some((value) => allowed_matches.includes(value));
      })
      // Rows also match on stage_code/stage_label/template_name; on a decline
      // or timing turn the row's own use case must be in the safe profile too.
      .filter((row) => !safe_use_cases || safe_use_cases.includes(lower(row.use_case)))
      // "Just so I understood the number right..." only answers a number.
      .filter(
        (row) =>
          !NUMBER_PRESUMING_USE_CASES.includes(lower(row.use_case)) ||
          inboundCarriesNumber(latest_inbound_text)
      )
      .filter((row) => {
        const reply_mode = lower(row.reply_mode);
        return !reply_mode || reply_mode === "auto" || reply_mode === "auto_reply";
      })
      .filter((row) => isTemplatePropertyCompatible(row, property_type_scope))
      .filter((row) => !usesExcludedPlaceholder(row.template_body))
      .filter((row) => !excluded_template_ids.has(clean(row.template_id)) && !excluded_template_ids.has(clean(row.id)))
      .sort(compareTemplateRank);

    const requested_language = lower(language);
    // v2: the first preferred use case that has a row in the seller's language
    // wins (an approved fallback only when the preferred copy does not exist).
    const v2_preferred_match = v2_preference.length
      ? v2_preference
          .map((use_case) =>
            candidates.find((row) => lower(row.language) === requested_language && lower(row.use_case) === use_case)
          )
          .find(Boolean) || null
      : null;
    const exact_language_match = v2_preference.length
      ? v2_preferred_match
      : candidates.find((row) => lower(row.language) === requested_language) || null;

    // Language continuity: a non-English thread must never be answered with
    // an English template. Missing language template ⇒ fail closed to review.
    if (!exact_language_match && requested_language !== "english") {
      const wanted_use_case = required_use_case || lower(decision?.route_hint) || allowed_matches[0] || "reply";
      return {
        ok: false,
        reason: "language_template_missing",
        detail: `no active ${language} template for ${wanted_use_case}`,
        human_review_required: true,
        language,
        language_resolution,
        template: null,
      };
    }

    // v2 never falls back to an off-preference row or to the code-only local
    // registry (owner rule: every sent copy is an sms_templates row).
    let selected = v2_preference.length
      ? exact_language_match
      : exact_language_match ||
        candidates.find((row) => lower(row.language) === "english") ||
        candidates[0] ||
        null;

    // Negotiation strategies fall back to the canonical local registry so a
    // deterministic strategy is never silently downgraded to review just
    // because the DB catalog lags the strategy vocabulary. DB-approved
    // templates always take precedence; the fallback requires a verified
    // approval record and is audited below.
    // The local registry is English-only: never answer a non-English seller
    // with it (owner rule: never send English to a non-English replier).
    if (!selected && requested_language !== "english") {
      const wanted_use_case = required_use_case || lower(decision?.route_hint) || allowed_matches[0] || "reply";
      return {
        ok: false,
        reason: "language_template_missing",
        detail: `no active ${language} template for ${wanted_use_case}`,
        human_review_required: true,
        language,
        language_resolution,
        template: null,
      };
    }
    if (!selected && !v2_preference.length) {
      selected = await selectLocalNegotiationTemplate(allowed_matches, {
        strategy: decision?.negotiation_strategy || null,
        excludePlaceholders: [...excluded_placeholders],
        excludeTemplateIds: [...excluded_template_ids],
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
  // ONE resolver for both the persisted offer and the rendered token, so the
  // valuation-spendability gate cannot be satisfied on one path and bypassed on
  // the other. A non-offer-authoritative valuation yields an empty token, and
  // the render then fails closed on the missing placeholder.
  const authorized_offer = formatUsd(resolveAuthorizedOfferAmount(dealAuthority));

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

// ── Reply-address hydration (2026-10-05 hotfix) ────────────────────────────
// Campaign threads created by campaign_launch_execution carry the property
// address ONLY in send_queue.metadata (target_snapshot / candidate_snapshot /
// campaign_target_metadata); send_queue.property_address is NULL, so the
// context summary had no address and every reply template with
// {{property_address}} failed to render. Yanli Mu ("199k sale", 15:36) and
// Frank L Hutchinson III ("1 million for the property", 16:44) gave a price
// and got no reply (template_render_failed on local-template:condition_probe).
//
// Canonical order: the thread's property_id -> properties.property_address
// (street form -- the same text the opener used), else the opener queue row
// (column, then metadata snapshots), else campaign_targets. A full
// "street, city, state zip" value is cut to its street line so the reply reads
// like the opener did.
function streetLine(value) {
  const text = clean(value);
  if (!text) return null;
  const head = clean(text.split(",")[0]);
  return head || null;
}

function phoneVariantsForThread(e164) {
  const digits = String(e164 ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!ten) return [];
  return [...new Set([String(e164), `+1${ten}`, `1${ten}`, ten].filter(Boolean))];
}

function addressFromQueueRow(row = {}) {
  const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return (
    streetLine(row?.property_address) ||
    streetLine(meta.property_address) ||
    streetLine(meta.target_snapshot?.property_address) ||
    streetLine(meta.candidate_snapshot?.property_address) ||
    streetLine(meta.candidate_snapshot?.property_address_full) ||
    streetLine(meta.campaign_target_metadata?.property_address) ||
    streetLine(meta.campaign_target_metadata?.property_address_full) ||
    null
  );
}

/**
 * Returns `context` with summary.property_address filled from the canonical
 * sources when it is empty. Never throws; never invents an address.
 */
export async function hydrateReplyAddressContext({
  supabase = null,
  context = null,
  propertyId = null,
  threadKey = null,
} = {}) {
  const base = context && typeof context === "object" ? context : {};
  if (clean(base?.summary?.property_address)) return base;
  if (!supabase || typeof supabase.from !== "function") return base;

  const property_id = clean(propertyId) || clean(base?.ids?.property_id) || null;
  const withAddress = (address, source) => ({
    ...base,
    summary: { ...(base.summary || {}), property_address: address, property_address_source: source },
  });

  // 1. properties (canonical)
  if (property_id) {
    try {
      const { data } = await supabase
        .from("properties")
        .select("property_id,property_address,property_address_full")
        .eq("property_id", property_id)
        .limit(1);
      const row = Array.isArray(data) ? data[0] : data;
      const address = streetLine(row?.property_address) || streetLine(row?.property_address_full);
      if (address) return withAddress(address, "properties");
    } catch {
      // fall through to the next source
    }
  }

  // 2. the opener queue row(s) on this thread
  let campaign_target_id = null;
  const phones = phoneVariantsForThread(threadKey);
  if (phones.length) {
    try {
      let query = supabase
        .from("send_queue")
        .select("id,property_id,property_address,metadata,created_at")
        .in("to_phone_number", phones);
      if (property_id) query = query.eq("property_id", property_id);
      const { data } = await query.order("created_at", { ascending: false }).limit(10);
      for (const row of Array.isArray(data) ? data : []) {
        const address = addressFromQueueRow(row);
        if (address) return withAddress(address, "send_queue");
        campaign_target_id = campaign_target_id || clean(row?.metadata?.campaign_target_id) || null;
      }
    } catch {
      // fall through
    }
  }

  // 3. campaign_targets
  if (campaign_target_id || property_id) {
    try {
      let query = supabase.from("campaign_targets").select("id,property_id,property_address");
      query = campaign_target_id ? query.eq("id", campaign_target_id) : query.eq("property_id", property_id);
      const { data } = await query.limit(1);
      const row = Array.isArray(data) ? data[0] : data;
      const address = streetLine(row?.property_address);
      if (address) return withAddress(address, "campaign_targets");
    } catch {
      // nothing else to try
    }
  }
  return base;
}

// ── Repeat-intent guard (2026-10-06 hotfix) ────────────────────────────────
// +17276319579: "1 million dollars" -> condition probe (delivered); "Great. 1
// million dollars" -> the SAME condition probe -> duplicate_blocked -> silence.
// The thread's recent outbound tells us what we already said.
const REPEAT_LOOKBACK_STATUSES = ["queued", "scheduled", "pending", "processing", "sending", "sent", "delivered"];

export async function loadRecentThreadOutbound({ supabase = null, threadKey = null, limit = 20 } = {}) {
  const phones = phoneVariantsForThread(threadKey);
  if (!phones.length || !supabase || typeof supabase.from !== "function") return [];
  try {
    const { data, error } = await supabase
      .from("send_queue")
      .select("id,template_id,message_body,message_type,source,queue_status,created_at")
      .in("to_phone_number", phones)
      .in("queue_status", REPEAT_LOOKBACK_STATUSES)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    // Only the CURRENT conversation cycle: everything since the latest
    // campaign first touch (message_type NULL / ownership). A fresh S1 opener
    // starts a new cycle in which re-asking the S2 question is correct.
    const rows = [...data].sort((a, b) => String(b?.created_at || "").localeCompare(String(a?.created_at || "")));
    const cycle = [];
    for (const row of rows) {
      cycle.push(row);
      const type = lower(row?.message_type);
      if (!type || type.includes("ownership") || lower(row?.source) === "campaign") break;
    }
    return cycle;
  } catch {
    return [];
  }
}

// When the chosen reply was already sent and the same use case has no unsent
// variant, these approved use cases say the same thing another way
// (2026-10-06 round 6: a second "who are you?" after our who_is_this reply).
const REPEAT_REPHRASE_USE_CASES = Object.freeze({
  who_is_this: ["info_source_explanation"],
  how_got_number: ["info_source_explanation"],
  seller_asking_price: ["asking_price_follow_up"],
  consider_selling: ["consider_selling_follow_up"],
});

function normalizeBodyForRepeat(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Would sending this template / text repeat something already sent on the thread? */
export function isRepeatOfRecentOutbound({ template = null, renderedText = "", recent = [] } = {}) {
  const template_id = clean(template?.template_id) || clean(template?.id) || null;
  const body = normalizeBodyForRepeat(renderedText);
  return asArray(recent).some(
    (row) =>
      (template_id && clean(row?.template_id) === template_id) ||
      (body && normalizeBodyForRepeat(row?.message_body) === body)
  );
}

/** Placeholder names a template body uses ({{ name }}). */
function templatePlaceholders(body = "") {
  return [...String(body || "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
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

// Claims automation may never volunteer in generated wording. Deterministic
// templates are pre-approved so this list guards ONLY the natural-response
// path; a match falls back to the template text.
const NATURAL_REPLY_PROHIBITED_CLAIMS = [
  "guaranteed",
  "guarantee",
  "no fees ever",
  "licensed agent",
  "licensed realtor",
  "attorney",
  "legal advice",
  "we will close in",
  "highest offer",
  "above market",
];

/**
 * Natural-response wording layer (natural-response-engine.js). Env-gated and
 * DEFAULT OFF. NATURAL_REPLY_ENGINE modes:
 *   disabled/unset  — nothing runs (production default);
 *   shadow          — generate + validate + persist an audit event, but the
 *                     deterministic template ALWAYS ships;
 *   internal_proof  — substitution only when the reply recipient is an
 *                     internal test phone (internal-phones.js); every other
 *                     recipient behaves as shadow;
 *   enabled         — full substitution.
 * Every policy, compliance, and state decision above this point is untouched:
 * the engine may only re-word the already-approved deterministic template
 * text, the generated candidate must survive the engine's policy validator
 * AND the same SMS queue guard the template passed, and any failure keeps the
 * template text byte-identical.
 */
async function maybeGenerateNaturalReply({
  decision = null,
  classification = null,
  context = null,
  deterministicText = "",
  useCase = null,
  templateId = null,
  modelCall = null,
  inboundFrom = "",
  threadKey = "",
  inboundEventId = null,
  supabaseClient = null,
} = {}) {
  let engine_mode = null;
  try {
    const {
      generateConstrainedReply,
      buildModelCallFromEnv,
      resolveNaturalReplyMode,
      resolveNaturalReplyTimeoutMs,
      NATURAL_REPLY_MODES,
    } = await import("@/lib/domain/seller-flow/natural-response-engine.js");

    const resolved_mode = resolveNaturalReplyMode(process.env);
    engine_mode = resolved_mode.mode;
    if (engine_mode === NATURAL_REPLY_MODES.DISABLED) {
      return { applied: false, reason: "disabled", audit: null };
    }

    const call = modelCall || buildModelCallFromEnv();
    if (!call) return { applied: false, reason: "no_model_configured", audit: null };

    // internal_proof substitutes only for the internal test registry; any
    // other recipient downgrades to shadow evaluation.
    let substitution_allowed = engine_mode === NATURAL_REPLY_MODES.ENABLED;
    let shadow_reason = engine_mode === NATURAL_REPLY_MODES.SHADOW ? "shadow_mode" : null;
    if (engine_mode === NATURAL_REPLY_MODES.INTERNAL_PROOF) {
      const { isInternalTestPhone } = await import("@/lib/config/internal-phones.js");
      const recipient = clean(inboundFrom) || clean(threadKey);
      if (isInternalTestPhone(recipient)) {
        substitution_allowed = true;
      } else {
        shadow_reason = "internal_proof_recipient_not_internal";
      }
    }

    const precedence = decision?.latest_intent_precedence || null;
    // Live shape nests turns under recent.recent_events; older callers may
    // pass an array directly.
    const recent_rows = Array.isArray(context?.recent)
      ? context.recent
      : asArray(context?.recent?.recent_events);
    const history = recent_rows
      .map((row) => ({
        direction: lower(row?.direction) === "outbound" ? "outbound" : "inbound",
        text: clean(row?.message_body || row?.body || row?.text),
      }))
      .filter((turn) => turn.text);
    const allowed_facts = { our_role: "local homebuyer" };
    const property_address = clean(context?.summary?.property_address);
    if (property_address) allowed_facts.property_address = property_address;
    const seller_first_name = clean(
      context?.summary?.seller_first_name || context?.summary?.first_name
    );
    if (seller_first_name) allowed_facts.seller_first_name = seller_first_name;

    const language = clean(classification?.language) || "English";
    // Wiring completeness: the engine's suppression hard-gate and question
    // validators are live inputs, not dead code. Suppression mirrors the
    // decision's own verdict (defense-in-depth — a suppressed decision never
    // reaches template render in the first place); open questions and the
    // next question come from the thread summary when the memory layer has
    // recorded them.
    const unanswered_questions = asArray(
      context?.summary?.unanswered_seller_questions || context?.summary?.open_questions
    )
      .map(clean)
      .filter(Boolean);
    const result = await generateConstrainedReply({
      objective: clean(useCase) || clean(decision?.route_hint) || "reply",
      deterministicText,
      allowedFacts: allowed_facts,
      prohibitedClaims: NATURAL_REPLY_PROHIBITED_CLAIMS,
      unansweredSellerQuestions: unanswered_questions,
      nextQuestion:
        clean(decision?.next_question) || clean(context?.summary?.next_question) || null,
      conversationHistory: history,
      stage: decision?.lifecycle_stage || null,
      status: decision?.operational_status || null,
      temperature: decision?.lead_temperature || null,
      sellerTone: clean(classification?.emotion) || null,
      language,
      languageConfidence: Number(
        classification?.language_confidence ?? (lower(language) === "english" ? 1 : 0)
      ),
      maxLength: 320,
      reEngagement:
        precedence?.state_patch?.contextual_reply_required === true ||
        precedence?.re_engagement_detected === true,
      suppression: {
        active: decision?.should_suppress_contact === true,
        reason: clean(decision?.suppression_reason) || null,
      },
      modelCall: call,
      timeoutMs: resolveNaturalReplyTimeoutMs(process.env),
    });

    const audit = {
      source: result.source,
      fallback_reason: result.fallback_reason || null,
      engine_version: result.engine_version,
      model: result.model || null,
      confidence: result.confidence ?? null,
      facts_used: result.facts_used || [],
      mode: engine_mode,
      model_latency_ms: result.audit?.model_latency_ms ?? null,
      model_usage: result.audit?.model_usage ?? null,
      model_attempts: result.audit?.model_attempts ?? null,
      model_allowlist_fallback: result.audit?.model_allowlist_fallback === true,
    };

    // Observability: every generation outcome persists one automation event
    // (never raw seller text; the generated text only when it actually ships
    // as the outbound message). Emission failures never block the reply path.
    async function persistNaturalReplyAudit(event_type, extra_payload = {}) {
      try {
        const { emitAutomationEvent } = await import(
          "@/lib/domain/automation/automation-events.js"
        );
        await emitAutomationEvent(
          {
            event_type,
            source: "natural_response_engine",
            dedupe_key: `natural-reply:${inboundEventId || threadKey || ""}:${event_type}`,
            conversation_thread_id: clean(threadKey) || null,
            payload: {
              mode: engine_mode,
              source: audit.source,
              fallback_reason: audit.fallback_reason,
              engine_version: audit.engine_version,
              model: audit.model,
              confidence: audit.confidence,
              facts_used: audit.facts_used,
              model_latency_ms: audit.model_latency_ms,
              model_usage: audit.model_usage,
              model_attempts: audit.model_attempts,
              model_allowlist_fallback: audit.model_allowlist_fallback,
              inbound_event_id: inboundEventId || null,
              use_case: clean(useCase) || null,
              template_id: templateId || null,
              ...extra_payload,
            },
          },
          supabaseClient ? { supabaseClient } : {}
        );
      } catch {
        // Audit emission is observability — never blocks the wording layer.
      }
    }

    if (result.source !== "generated" || !clean(result.response_text)) {
      audit.fallback_reason = result.fallback_reason || "fallback";
      await persistNaturalReplyAudit("NATURAL_REPLY_FALLBACK");
      return { applied: false, reason: result.fallback_reason || "fallback", audit };
    }

    const prepared = prepareRenderedSmsForQueue({
      rendered_message_text: result.response_text,
      template_id: templateId,
      template_source: "natural_response_engine",
    });
    if (!prepared.ok || !clean(prepared.text)) {
      const guard_audit = {
        ...audit,
        source: "deterministic_fallback",
        fallback_reason: prepared.reason || "sms_guard_rejected",
      };
      await persistNaturalReplyAudit("NATURAL_REPLY_FALLBACK", {
        source: "deterministic_fallback",
        fallback_reason: guard_audit.fallback_reason,
      });
      return {
        applied: false,
        reason: prepared.reason || "sms_guard_rejected",
        audit: guard_audit,
      };
    }

    if (!substitution_allowed) {
      // Shadow evaluation: a valid candidate existed, but this mode (or a
      // non-internal recipient under internal_proof) never substitutes.
      const shadow_audit = {
        ...audit,
        shadow_reason,
        would_apply: true,
      };
      await persistNaturalReplyAudit("NATURAL_REPLY_SHADOW_EVALUATED", {
        shadow_reason,
        would_apply: true,
      });
      return { applied: false, reason: shadow_reason || "shadow_mode", audit: shadow_audit };
    }

    await persistNaturalReplyAudit("NATURAL_REPLY_APPLIED", {
      applied_text: prepared.text,
      applied_text_length: prepared.text.length,
    });
    return { applied: true, text: prepared.text, audit };
  } catch (error) {
    warn("[NATURAL_REPLY_ENGINE_ERROR]", { message: error?.message || "unknown" });
    return { applied: false, reason: "engine_exception", audit: null };
  }
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
  // Owner the wrong-number fact belongs to (7.2: wrong person is scoped to
  // the owner<->phone relationship, never the number for every owner).
  ownerId = null,
  reason = "opt_out",
  threadKey = "",
  dryRun = false,
  // Test seam for record-phone-suppression.js ({ sleep, alert, maxAttempts }).
  suppressionDeps = null,
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
      // RELATIONSHIP-SCOPED (7.2, 2026-10-01). This updated every phones row
      // carrying the number -- i.e. marked it wrong for EVERY owner who lists it
      // -- and, when a phoneId was supplied, filtered on `id`, a column phones
      // does not have (its key is phone_id), so that branch always errored.
      // The fact is "this number is not <owner>'s": scope it to the owner, and
      // refuse rather than widen when the owner is unknown (the thread's own
      // disposition and contact_property_resolution still record it).
      void phoneId;
      if (!clean(ownerId)) {
        return { ok: false, reason: "wrong_number_owner_scope_missing", phone_number: normalized_phone };
      }
      const { error } = await supabase
        .from("phones")
        .update({
          phone_contact_status: "wrong_number",
          wrong_number_at: new Date().toISOString(),
          wrong_number_source_thread_key: clean(threadKey) || normalized_phone,
        })
        .eq("canonical_e164", normalized_phone)
        .eq("master_owner_id", clean(ownerId));
      if (error) throw error;
    } else {
      // DURABLE COMPLIANCE WRITE (repaired 2026-09-09; fail-closed 2026-10-06).
      //
      // One writer for every phone-level opt-out: record-phone-suppression.js.
      // It upserts the phone-scoped sms_suppression_list row campaign
      // eligibility reads (phone_e164, sender NULL, NULLS NOT DISTINCT unique
      // index), retries, and when every attempt fails it writes a durable
      // automation_suppressions block and raises a critical alert. Before
      // this, a failed upsert was caught below, logged with warn() and
      // dropped: 2 of 72 opt-outs since 2026-09-25 left no list row.
      const { recordPhoneSuppression } = await import(
        "@/lib/domain/compliance/record-phone-suppression.js"
      );
      const recorded = await recordPhoneSuppression(
        {
          supabase,
          phone: normalized_phone,
          reason,
          source: "inbound_opt_out",
          threadKey,
        },
        suppressionDeps || {}
      );
      if (!recorded.ok) {
        warn("[AUTO_REPLY_SUPPRESSION_FAILED_CLOSED]", {
          phone_number: normalized_phone,
          suppression_reason: reason,
          error: recorded.error || recorded.reason,
          fallback_block: recorded.fallback_block === true,
        });
        return { ...recorded, reason: "suppression_failed" };
      }
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

/** Reasons outreach-service writes when WE sent something: a re-marketing
 *  throttle, never a permission signal. See findActiveOutreachSuppression. */
const OUTBOUND_CADENCE_SUPPRESSION_REASONS = new Set(["recent_outbound", "recent_contact"]);

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
      const reason = clean(row.suppression_reason) || "contact_outreach_suppression";
      // OUTBOUND CADENCE IS NOT A REPLY BLOCK. outreach-service stamps every
      // outbound we send with suppression_until = +45 days and
      // suppression_reason = 'recent_outbound' (default label 'recent_contact').
      // That throttles RE-MARKETING to a seller. It was being read here as a
      // reason not to ANSWER the seller -- so every reply to a first touch was
      // dispositioned no_reply_required for 45 days (2026-09-08: 4 of the first
      // 7 replies, including an ownership confirmation; still firing 3 hours
      // later). A seller who texts us has opted INTO a reply. Only a
      // non-cadence outreach block (any other reason) still suppresses.
      if (OUTBOUND_CADENCE_SUPPRESSION_REASONS.has(reason)) {
        return {
          suppressed: false,
          reason: null,
          cadence_suppression_ignored_for_reply: reason,
          row,
        };
      }
      return { suppressed: true, reason, row };
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


// The SAME authority resolution the {{offer_price}} token uses (ceiling-bounded,
// strategy-authorized amount preferred over the bare recommendation). Keeping
// one resolver is what guarantees the persisted offer equals the sent amount.
export function resolveAuthorizedOfferAmount(dealAuthority = null) {
  // HARD GATE (proven production defect): a valuation the engine itself labelled
  // REVIEW_REQUIRED / low-confidence must never authorize money, no matter what
  // number it produced. The ceiling alone cannot catch this — a contaminated
  // valuation derives its own ceiling and therefore validates itself. Callers
  // that build dealAuthority MUST set offer_authoritative; its absence is
  // treated as not-authoritative so the gate fails closed.
  if (dealAuthority?.offer_authoritative !== true) return null;

  // DEFENSE IN DEPTH (mission: "never authorize an amount above the independent
  // monetary ceiling"). A missing ceiling previously SKIPPED the clamp entirely
  // and returned the raw recommendation -- fail-open. An independent ceiling is
  // now mandatory: absent or non-positive means no authority at all.
  const ceiling = Number(dealAuthority?.authorized_offer_ceiling);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
  const pick = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (amount > ceiling) return null;
    return amount;
  };
  return pick(dealAuthority?.authorized_offer_amount) ?? pick(dealAuthority?.recommended_offer);
}
export async function executeInboundAutomationDecision({
  opportunityId = null,
  // Seller Autopilot v2 quote log writer (injectable for tests); see negotiation-quotes.js.
  negotiationQuoteImpl = null,
  persistActiveOfferImpl = persistActiveOfferDefault,
  bindOfferToQueueRowImpl = bindOfferToQueueRowDefault,
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
  inboundReceivedAt = null,
  contextResolution = null,
  enableQueueInsert = false,
  applySuppression = true,
  dryRun = true,
  // Compliance is NOT a reply decision. `dryRun` here means "do not queue an
  // outbound", and the caller sets it true whenever no live reply is being
  // queued -- which is ALWAYS the case for an opt-out, since an opt-out
  // suppresses the reply by definition. Honouring it for the suppression write
  // meant a seller could text STOP and nothing durable was ever recorded.
  // complianceDryRun carries the caller's real "may I write to production"
  // flag; when omitted it defaults to dryRun so every existing caller and test
  // double keeps today's behaviour.
  complianceDryRun = null,
  autoReplyMode = null,
  proofRun = false,
  scheduleDelaySeconds = 0,
  timezoneOverride = null,
  contactWindowOverride = null,
  dealAuthority = null,
  strategyDirective = null,
  transitionDirective = null,
  effectiveStageBefore = null,
  // ONE BRAIN, TWO TRANSPORTS. Every decision above is channel-free; only the
  // last step differs. channel='email' hands the rendered reply to Email
  // Command (emailReplyImpl → email_queue) instead of send_queue, and lets
  // Email Command answer the suppression question for the email address
  // (channelSuppressionCheck). Default 'sms' leaves this function unchanged.
  channel = "sms",
  emailReplyImpl = null,
  channelSuppressionCheck = null,
  now = new Date().toISOString(),
  supabaseClient = null,
  getSystemValue: getSystemValueImpl = null,
  naturalReplyModelCall = null,
  renderFailureNotifyImpl = null,
  // Round 10: BARE_NO_AUTO_CLARIFIER double gate (env ceiling + system_control
  // bare_no_auto_clarifier). Injectable for tests: async () => boolean.
  bareNoAutoClarifierGate = null,
} = {}) {
  const supabase = supabaseClient || getDefaultSupabaseClient();
  const effective_auto_reply_mode = normalizeAutoReplyMode(
    autoReplyMode,
    dryRun ? "dry_run" : enableQueueInsert ? "live_limited" : "disabled"
  );
  const auto_reply_scope_config =
    effective_auto_reply_mode === "live_limited"
      ? await resolveAutoReplyScopeConfig({ getSystemValue: getSystemValueImpl })
      : { cutoffAt: null, threadAllowlist: null };

  const queue_permission = autoReplyModeAllowsQueue({
    mode: effective_auto_reply_mode,
    inboundFrom,
    threadKey,
    // Deliberately no `|| now` fallback: an unknown arrival time must fail
    // closed under live_limited rather than inherit the current timestamp and
    // sail past the cutoff.
    inboundReceivedAt,
    cutoffAt: auto_reply_scope_config.cutoffAt,
    threadAllowlist: auto_reply_scope_config.threadAllowlist,
  });
  let base_decision = applyInboundAutomationDecision({
    contextResolution,
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

  // Latest-intent precedence is evaluated for EVERY inbound (pure, no I/O) so
  // supersession and re-engagement are visible on the decision even when a
  // later gate (policy block, mode disabled) ends processing early. The
  // suppression-aware refinement below overwrites this when the thread has
  // active suppression rows.
  try {
    const { resolveLatestIntentPrecedence, resolvePriorThreadState } = await import(
      "@/lib/domain/seller-flow/latest-intent-precedence.js"
    );
    // The live path nests prior state under latestThreadContext.summary — the
    // shared extractor is the only reader so both call sites see the same
    // disposition/last_intent/automation state and staleness verdict.
    const { prior_state, message_is_stale } = resolvePriorThreadState({
      latestThreadContext,
      context,
      inboundReceivedAt,
    });
    base_decision.latest_intent_precedence = resolveLatestIntentPrecedence({
      classification,
      message_body: message,
      prior_state,
      active_suppressions: [],
      message_is_stale,
    });
  } catch {
    base_decision.latest_intent_precedence = null;
  }

  // ── SUPPRESSION CANDIDATE (round 10, owner 2026-10-08) ────────────────────
  // A repeated demand to stop contacting with no explicit revocation phrase:
  // no outbound on this turn, every pending send for the thread is held
  // (cancelled through the canonical cancellation, compliance_terminal policy,
  // thread scope), and the thread goes to the operator lane for a person to
  // confirm the suppression. Runs BEFORE every directive / clarifier / mode
  // gate so nothing downstream can queue a reply. An explicit opt-out never
  // reaches here (should_suppress_contact is decided by the opt-out branch).
  if (base_decision.next_action === "hold_suppression_candidate" && !base_decision.should_suppress_contact) {
    const compliance_dry_run = complianceDryRun == null ? dryRun : Boolean(complianceDryRun);
    let queue_cancellation = { ok: true, cancelled: 0, reason: "not_attempted" };
    if (!compliance_dry_run && supabase) {
      try {
        queue_cancellation = await cancelSupabasePendingOutbound(
          {
            thread_key: threadKey || inboundFrom,
            to_phone_number: inboundFrom || threadKey,
            phone_id: phoneId,
            policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
            reason: "suppression_candidate_hold",
            suppression_reason: "suppression_candidate",
            inbound_event_id: inboundEventId,
            inbound_received_at: inboundReceivedAt || null,
            cancelled_by: "inbound_suppression_candidate",
          },
          { supabase }
        );
      } catch (candidate_cancel_error) {
        queue_cancellation = { ok: false, cancelled: 0, reason: candidate_cancel_error?.message || "cancel_failed" };
        warn("inbound.suppression_candidate_hold_failed", {
          thread_key: threadKey || inboundFrom,
          error: candidate_cancel_error?.message || "unknown_error",
        });
      }
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
      suppression_applied: false,
      suppression_candidate: true,
      queue_cancellation,
      duplicate_suppressed: false,
      dry_run: Boolean(dryRun),
      auto_reply_mode: effective_auto_reply_mode,
      queue_permission,
      audit_reason: "suppression_candidate",
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: "suppression_candidate",
        plan: automationDecisionToLegacyPlan({ decision: base_decision, classification }),
        brain_stage: null,
      },
    };
  }

  // ── BARE "NO" AUTO CLARIFIER GATE (round 10, owner 2026-10-08) ────────────
  // Until contextual behaviour is validated, an ambiguous bare "No" to the
  // ownership question gets NO automatic clarifier -- even when the clarifier
  // row is active. Flag BARE_NO_AUTO_CLARIFIER (env ceiling AND
  // system_control.bare_no_auto_clarifier; default OFF). OFF: hold, no
  // outbound, quiet (non-alerting Unclear) lane, no review. Runs before the
  // directives so no v2/v3 plan can send it either.
  if (
    !base_decision.should_suppress_contact &&
    clean(classification?.automation_decision?.clarification_use_case) === "ownership_connection_clarifier"
  ) {
    let clarifier_on = false;
    try {
      clarifier_on =
        typeof bareNoAutoClarifierGate === "function"
          ? (await bareNoAutoClarifierGate()) === true
          : (await isBareNoAutoClarifierEnabled()).enabled === true;
    } catch {
      clarifier_on = false;
    }
    if (!clarifier_on) {
      const hold_decision = {
        ...base_decision,
        should_queue_reply: false,
        should_mark_human_review: false,
        reply_mode: "none",
        human_review_reason: null,
        next_action: "hold_ownership_clarifier",
        audit_reason: "bare_no_auto_clarifier_off",
      };
      return {
        ok: true,
        automation_decision: hold_decision,
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
        audit_reason: "bare_no_auto_clarifier_off",
        seller_stage_reply: {
          ok: true,
          queued: false,
          handled: true,
          reason: "bare_no_auto_clarifier_off",
          plan: automationDecisionToLegacyPlan({ decision: hold_decision, classification }),
          brain_stage: null,
        },
      };
    }
  }

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
        ...(strategyDirective.v2_plan ? { seller_autopilot_v2: strategyDirective.v2_plan } : {}),
      };
    } else if (clean(strategyDirective.template_use_case)) {
      // A non-review strategy directive selected a concrete outbound template
      // (e.g. OCCUPANCY_DISCOVERY -> occupancy_probe). For an immediate-send
      // action this is an autonomous SEND, so it must AUTHORIZE the queue —
      // otherwise should_queue_reply keeps the base intent value (false once
      // ownership is already confirmed) and the send is silently dropped at the
      // `!should_queue_reply` guard below, before the template selector runs.
      // Review strategies are handled in the branch above; schedule_follow_up
      // (FUTURE_NURTURE) intentionally defers to the follow-up scheduler and is
      // NOT queued as an immediate reply here. Suppression/opt-out never reach
      // this block (guarded by !should_suppress_contact), and every downstream
      // gate (creation brake, auto_reply_mode scope, fail-closed template
      // selection, V2 safety withhold) still applies.
      const strategy_is_immediate_send = [
        "send_message_now",
        "generate_offer",
        "collect_contract_facts",
      ].includes(clean(strategyDirective.next_action));
      base_decision = {
        ...base_decision,
        route_hint: clean(strategyDirective.template_use_case),
        allowed_template_stages: uniq([
          clean(strategyDirective.template_use_case),
          ...asArray(strategyDirective.allowed_template_use_cases).map(clean),
        ]).filter(Boolean),
        negotiation_strategy: strategyDirective.strategy || null,
        audit_reason: strategyDirective.reason_code || base_decision.audit_reason,
        // SELLER AUTOPILOT V2 (flag SELLER_AUTOPILOT_V2; only that layer sets
        // template_preference): an EXACT ordered template preference, so the
        // intent profile's candidates cannot leak a different question in, and
        // the plan (incl. any number + its evidence) rides on the decision
        // snapshot stamped onto the send_queue row.
        ...(asArray(strategyDirective.template_preference).length
          ? {
              v2_template_preference: asArray(strategyDirective.template_preference).map(clean).filter(Boolean),
              template_authority: "seller_autopilot_v2",
              seller_autopilot_v2: strategyDirective.v2_plan || null,
            }
          : {}),
        ...(strategy_is_immediate_send
          ? {
              should_queue_reply: true,
              should_mark_human_review: false,
              reply_mode: "auto",
              next_action: "queue_auto_reply",
              // The documented exception to the classifier-verdict invariant
              // (see classifierForbidsAutoReply): a proactive strategy send the
              // intent itself doesn't call for. It may proceed past
              // auto_reply_allowed=false — never past human_review_required.
              send_authority: "negotiation_strategy_directive",
            }
          : {}),
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
    // See complianceDryRun in the parameter list: suppressing a seller who
    // asked us to stop, and cancelling anything already queued to them, are
    // compliance actions. They must not be gated on whether we happen to be
    // sending a reply on this turn.
    const compliance_dry_run =
      complianceDryRun == null ? dryRun : Boolean(complianceDryRun);
    const suppression_result = applySuppression
      ? await applyInboundSuppression({
          supabaseClient: supabase,
          phoneNumber: inboundFrom || threadKey,
          phoneId,
          ownerId,
          reason: suppression_reason,
          threadKey,
          dryRun: compliance_dry_run,
        })
      : { ok: false, skipped: true, reason: "suppression_disabled" };

    let queue_cancellation = { ok: true, cancelled: 0, reason: "not_attempted" };
    if (!compliance_dry_run && supabase) {
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

  // Sold-property pairing closure (closure pass 2026-08-26): the property is
  // factually gone, so pending CAMPAIGN touches for THAT property are
  // cancelled (property_disposition scope). The CONTACT is never suppressed;
  // campaign touches for the owner's other properties survive. Deliberate
  // no-reply outcome with the durable property_sold reason.
  if (
    base_decision.next_action === "disposition_property_sold" &&
    !dryRun &&
    supabase &&
    propertyId
  ) {
    try {
      await cancelSupabasePendingOutbound(
        {
          thread_key: threadKey || inboundFrom,
          to_phone_number: inboundFrom || threadKey,
          property_id: propertyId,
          policy: CANCELLATION_POLICIES.PROPERTY_DISPOSITION,
          reason: "property_sold",
          inbound_event_id: inboundEventId,
          inbound_received_at: inboundReceivedAt || null,
          cancelled_by: "inbound_automation_decision_sold",
        },
        { supabase }
      );
    } catch (sold_cancel_error) {
      warn("inbound.sold_property_cancel_failed", {
        thread_key: threadKey || inboundFrom,
        error: sold_cancel_error?.message || "unknown_error",
      });
    }
  }

  // Stage-aware safe-fallback clarifier: convert the safe-ambiguous review
  // subset into a prepared clarifier send (see
  // resolveSafeFallbackClarifierDispatch — every protected review lane and
  // every suppression path is excluded there; the suppression lookup,
  // duplicate dedup, render guards and mode/allowlist authority below still
  // apply to the clarifier exactly as to any auto-reply).
  if (!base_decision.should_queue_reply) {
    const clarifier_dispatch = resolveSafeFallbackClarifierDispatch({
      decision: base_decision,
      classification,
      message,
      stage:
        // Persisted lifecycle stage first (PR #84 made it authoritative);
        // the classifier's message-content stage_hint defaults to "Ownership"
        // on terse messages and would pin the clarifier to its S1 column.
        transitionDirective?.stage_after ||
        effectiveStageBefore ||
        base_decision.stage_hint ||
        classification?.stage_hint ||
        null,
    });
    if (clarifier_dispatch) {
      info("[AUTO_REPLY_SAFE_CLARIFIER]", {
        thread_key: threadKey || null,
        primary_intent: classification?.primary_intent || null,
        uncertainty_type: clarifier_dispatch.uncertainty_type,
        stage_bucket: clarifier_dispatch.stage_bucket,
        prior_review_reason:
          base_decision.human_review_reason || base_decision.audit_reason || null,
      });
      base_decision = {
        ...base_decision,
        should_queue_reply: true,
        should_mark_human_review: false,
        reply_mode: "auto_clarifier",
        human_review_reason: null,
        next_action: "send_safe_clarifier",
        route_hint: "safe_clarifier",
        // An emoji confirmation names its sms_templates use case; the
        // code-authored clarifier (suggested_text) keeps the legacy path.
        allowed_template_stages: clarifier_dispatch.template_use_case
          ? [clarifier_dispatch.template_use_case]
          : ["safe_clarifier"],
        required_template_use_case: clarifier_dispatch.template_use_case || null,
        audit_reason: "safe_fallback_clarifier",
        clarifier_dispatch,
      };
    }
  }

  // Final gate for the invariant above: whichever path set should_queue_reply,
  // a classifier that forbids an auto-reply wins. The row is never created.
  {
    const authority = classifierForbidsAutoReply(classification);
    const directive_exception =
      base_decision.send_authority === "negotiation_strategy_directive" &&
      authority.reason === "classifier_auto_reply_not_allowed";
    if (base_decision.should_queue_reply && authority.forbidden && !directive_exception) {
      warn("[AUTO_REPLY_INVARIANT_BLOCK]", {
        thread_key: threadKey || null,
        primary_intent: classification?.primary_intent || null,
        attempted_reply_mode: base_decision.reply_mode || null,
        attempted_next_action: base_decision.next_action || null,
        reason: authority.reason,
      });
      base_decision = {
        ...base_decision,
        should_queue_reply: false,
        should_mark_human_review: true,
        reply_mode: "manual_review",
        next_action: "mark_human_review",
        route_hint: base_decision.route_hint === "safe_clarifier" ? null : base_decision.route_hint,
        clarifier_dispatch: null,
        human_review_reason: base_decision.human_review_reason || authority.reason,
        audit_reason: authority.reason,
      };
    }
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
      : channel === "email" && typeof channelSuppressionCheck === "function"
        ? await channelSuppressionCheck({ threadKey, ownerId, propertyId, classification })
        : await checkInboundAutoReplySuppression({
          supabaseClient: supabase,
          phoneNumber: inboundFrom || threadKey,
          threadKey,
          ownerId,
          context: context || latestThreadContext,
        });

  let precedence_reopened = false;
  if (active_suppression.suppressed) {
    // Latest-intent precedence: the newest clear positive intent may supersede
    // SOFT suppression (not_interested / no_response / nurture). Binding
    // opt-outs and anything unrecognized stay in force and route to a human.
    const { resolveLatestIntentPrecedence, resolvePriorThreadState, releaseSoftSuppressions } =
      await import("@/lib/domain/seller-flow/latest-intent-precedence.js");
    const { prior_state, message_is_stale } = resolvePriorThreadState({
      latestThreadContext,
      context,
      inboundReceivedAt,
    });
    let precedence = resolveLatestIntentPrecedence({
      classification,
      message_body: message,
      prior_state,
      active_suppressions: [
        active_suppression.row || { suppression_reason: active_suppression.reason },
      ],
      message_is_stale,
    });

    if (precedence.supersedes_prior_state && precedence.clear_soft_suppression && !dryRun) {
      const release = await releaseSoftSuppressions(
        {
          supabase,
          phone_number: inboundFrom || threadKey,
          decision: precedence,
          thread_key: threadKey,
          message_event_id: inboundEventId,
        },
        { info, warn }
      );
      if (!release.ok) {
        // Fail safe: if the release did not land (including a zero-row
        // update), the thread stays suppressed and no reopen patch survives.
        precedence = {
          ...precedence,
          supersedes_prior_state: false,
          clear_soft_suppression: false,
          state_patch: null,
          reason_codes: [...precedence.reason_codes, "soft_release_failed_fail_safe"],
        };
      }
    }

    base_decision.latest_intent_precedence = precedence;

    if (precedence.supersedes_prior_state) {
      precedence_reopened = true;
      info("[LATEST_INTENT_REENGAGEMENT_REOPENED]", {
        thread_key: threadKey || null,
        primary_intent: classification?.primary_intent || null,
        evidence: precedence.evidence,
        reason_codes: precedence.reason_codes,
        version: precedence.version,
      });
    }
  }

  if (active_suppression.suppressed && !precedence_reopened) {
    const precedence = base_decision.latest_intent_precedence || null;
    const suppression_decision = {
      ...base_decision,
      should_queue_reply: false,
      should_suppress_contact: true,
      should_mark_human_review: precedence?.blocked_by_binding_suppression === true,
      reply_mode: "none",
      suppression_reason: active_suppression.reason || "suppressed",
      audit_reason:
        precedence?.blocked_by_binding_suppression === true
          ? "seller_initiated_after_stop"
          : active_suppression.reason || "suppressed",
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

  // Fill the property address from the canonical sources before any template
  // is chosen or rendered (see hydrateReplyAddressContext).
  const reply_context = await hydrateReplyAddressContext({
    supabase,
    context: context || latestThreadContext,
    propertyId,
    threadKey,
  });
  let template_result = await selectSafeAutoReplyTemplate({
    supabaseClient: supabase,
    classification,
    decision: base_decision,
    context: reply_context,
    threadKey,
    inboundEventId,
  });

  if (!template_result.ok || !template_result.template) {
    // Round 9 (owner 2026-10-07, "zero S1/S2 review"): a bare "No" to the
    // ownership question whose ONE clarifier has no active safe row is NOT a
    // review item. Deterministic outcome: no reply, no review; the thread rests
    // in the non-alerting Unclear lane with reason
    // ownership_clarifier_template_inactive until the clarifier row is
    // activated (or LC_BARE_NO_OWNERSHIP_MODE=non_owner closes it).
    const bare_no_clarifier =
      clean(classification?.automation_decision?.clarification_use_case) === "ownership_connection_clarifier";
    const no_template_decision = bare_no_clarifier
      ? {
          ...base_decision,
          should_queue_reply: false,
          should_mark_human_review: false,
          reply_mode: "none",
          human_review_reason: null,
          next_action: "hold_ownership_clarifier",
          audit_reason: "ownership_clarifier_template_inactive",
          ...(template_result.detail ? { human_review_detail: template_result.detail } : {}),
        }
      : {
      ...base_decision,
      should_queue_reply: false,
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason:
        template_result.reason === "language_template_missing" ? "language_template_missing" : "no_safe_template",
      audit_reason: "no_safe_template",
      ...(template_result.detail ? { human_review_detail: template_result.detail } : {}),
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

  // ── PER-LANGUAGE ENABLEMENT (flag SELLER_AUTOPILOT_V2) ────────────────────
  // A language whose copy has not been natively reviewed and switched on in
  // system_control[seller_autopilot_v2_languages] (default English,Spanish)
  // goes to a human, whatever its templates say.
  if (isSellerAutopilotV2Enabled()) {
    const read_value = getSystemValueImpl || (hasSupabaseConfig() ? getSystemValue : async () => null);
    let raw_languages = null;
    try {
      raw_languages = await read_value(V2_LANGUAGES_KEY);
    } catch {
      raw_languages = null;
    }
    const enabled_languages = parseEnabledLanguages(raw_languages);
    const reply_language = clean(template_result.template.language) || clean(classification?.language) || "English";
    if (!isReplyLanguageEnabled(reply_language, enabled_languages)) {
      const language_decision = {
        ...base_decision,
        should_queue_reply: false,
        should_mark_human_review: true,
        reply_mode: "manual_review",
        human_review_reason: `v2_language_not_enabled:${reply_language}`,
        audit_reason: "v2_language_not_enabled",
        enabled_languages,
      };
      return {
        ok: true,
        automation_decision: language_decision,
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
        audit_reason: "v2_language_not_enabled",
      };
    }
  }

  let render_result = renderSafeTemplate({
    template: template_result.template,
    message,
    inboundFrom,
    inboundTo,
    classification,
    context: reply_context,
    dealAuthority,
  });

  // A required variable is still empty: choose an approved variant that does
  // not use it (DB catalog, then the approved local registry). Never send an
  // unrendered {{...}} -- personalizeTemplate fails closed and the queue
  // preparation rejects leftover braces.
  if (!render_result.ok && asArray(render_result.missing).length > 0) {
    const retry = await selectSafeAutoReplyTemplate({
      supabaseClient: supabase,
      classification,
      decision: base_decision,
      context: reply_context,
      threadKey,
      inboundEventId,
      excludePlaceholders: render_result.missing,
    });
    if (retry.ok && retry.template) {
      const retry_render = renderSafeTemplate({
        template: retry.template,
        message,
        inboundFrom,
        inboundTo,
        classification,
        context: reply_context,
        dealAuthority,
      });
      if (retry_render.ok) {
        template_result = retry;
        render_result = retry_render;
      }
    }
  }

  if (render_result.ok && /\{\{|\}\}/.test(String(render_result.rendered_message_text || ""))) {
    render_result = { ok: false, reason: "unrendered_placeholder", missing: [], rendered_message_text: null };
  }

  // REPEAT INTENT: never send the same template / identical text twice on a
  // thread, and never fall silent because of it. Next-best: an approved
  // variant of the same question; else review (repeat_intent_no_alternative)
  // with an operator alert.
  let repeat_guard = null;
  if (render_result.ok && template_result.template) {
    const recent_outbound = await loadRecentThreadOutbound({ supabase, threadKey });
    if (
      isRepeatOfRecentOutbound({
        template: template_result.template,
        renderedText: render_result.rendered_message_text,
        recent: recent_outbound,
      })
    ) {
      const already_sent_ids = recent_outbound.map((row) => clean(row?.template_id)).filter(Boolean);
      const variant = await selectSafeAutoReplyTemplate({
        supabaseClient: supabase,
        classification,
        decision: base_decision,
        context: reply_context,
        threadKey,
        inboundEventId,
        excludeTemplateIds: [
          ...already_sent_ids,
          clean(template_result.template.template_id) || clean(template_result.template.id),
        ].filter(Boolean),
      });
      let variant_choice = variant;
      if (!(variant.ok && variant.template)) {
        for (const alt of REPEAT_REPHRASE_USE_CASES[lower(template_result.template.use_case)] || []) {
          const rephrase = await selectSafeAutoReplyTemplate({
            supabaseClient: supabase,
            classification,
            decision: { ...base_decision, required_template_use_case: alt },
            context: reply_context,
            threadKey,
            inboundEventId,
            excludeTemplateIds: already_sent_ids,
          });
          if (rephrase.ok && rephrase.template) {
            variant_choice = rephrase;
            break;
          }
        }
      }
      let variant_render = null;
      if (variant_choice.ok && variant_choice.template) {
        variant_render = renderSafeTemplate({
          template: variant_choice.template,
          message,
          inboundFrom,
          inboundTo,
          classification,
          context: reply_context,
          dealAuthority,
        });
      }
      if (
        variant_render?.ok &&
        !/\{\{|\}\}/.test(String(variant_render.rendered_message_text || "")) &&
        !isRepeatOfRecentOutbound({ template: variant_choice.template, renderedText: variant_render.rendered_message_text, recent: recent_outbound })
      ) {
        repeat_guard = {
          outcome: "variant",
          repeated_template_id: clean(template_result.template.template_id) || null,
          variant_template_id: clean(variant_choice.template.template_id) || clean(variant_choice.template.id) || null,
        };
        template_result = variant_choice;
        render_result = variant_render;
      } else {
        repeat_guard = {
          outcome: "no_alternative",
          repeated_template_id: clean(template_result.template.template_id) || null,
        };
        render_result = {
          ok: false,
          reason: "repeat_intent_no_alternative",
          missing: [],
          rendered_message_text: null,
        };
      }
    }
  }

  if (!render_result.ok) {
    const failure_reason =
      render_result.reason === "repeat_intent_no_alternative" ? "repeat_intent_no_alternative" : "template_render_failed";
    // Never silently dropped: the operator is alerted (inbox_auto_reply_blocked)
    // and the decision stays human-review. Observability only -- a failed
    // alert never changes the decision. Skipped on dry runs.
    if (!dryRun) {
      try {
        const notify =
          renderFailureNotifyImpl ||
          (await import("@/lib/domain/notifications/notification-emitter.js")).emitNotificationFromBusinessEvent;
        await notify({
          eventType: "inbox_auto_reply_blocked",
          severity: "warning",
          title:
            failure_reason === "repeat_intent_no_alternative"
              ? `Auto-reply not sent (would repeat what we already sent, no alternative) — ${clean(threadKey) || "thread"}`
              : `Auto-reply not sent (template could not render) — ${clean(threadKey) || "thread"}`,
          description: `Seller replied (${clean(classification?.primary_intent) || "unknown intent"}) but template ${
            clean(template_result.template?.template_id) || "?"
          } could not render: ${render_result.reason || "template_render_failed"}${
            asArray(render_result.missing).length ? ` (missing ${asArray(render_result.missing).join(", ")})` : ""
          }. Reply manually.`,
          titleVars: { thread_key: clean(threadKey) || "" },
          sourceEntityType: "thread",
          sourceEntityId: clean(threadKey) || clean(inboundEventId) || "thread",
          propertyId: clean(propertyId) || null,
          templateId: clean(template_result.template?.template_id) || null,
          deduplicationKey: `auto_reply_render_failed:${clean(inboundEventId) || clean(threadKey) || ""}`,
          metrics: {
            reason: render_result.reason || "template_render_failed",
            missing: asArray(render_result.missing),
            primary_intent: clean(classification?.primary_intent) || null,
          },
          group: false,
        });
      } catch {
        // alerting must never block the decision
      }
    }

    const render_failed_decision = {
      ...base_decision,
      should_queue_reply: false,
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: failure_reason,
      audit_reason: failure_reason,
      ...(repeat_guard ? { repeat_guard } : {}),
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
      audit_reason: failure_reason,
      seller_stage_reply: {
        ok: true,
        queued: false,
        handled: true,
        reason: failure_reason,
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
  const selected_use_case =
    clean(selected_template.use_case) ||
    routeProfileCandidates(base_decision.route_hint, classification?.primary_intent)[0] ||
    null;
  // Wording layer: may only substitute validated generated text for the
  // approved template rendering; decisions above are already final.
  const natural_reply = await maybeGenerateNaturalReply({
    decision: base_decision,
    classification,
    context: reply_context,
    deterministicText: render_result.rendered_message_text,
    useCase: selected_use_case,
    templateId: selected_template.template_id || selected_template.id || null,
    modelCall: naturalReplyModelCall,
    inboundFrom,
    threadKey,
    inboundEventId,
    supabaseClient: supabase,
  });
  const rendered_message_text = natural_reply.applied
    ? natural_reply.text
    : render_result.rendered_message_text;
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
      natural_reply: natural_reply.audit,
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
      natural_reply: natural_reply.audit,
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

  // ── OFFER TERM AUTHORITY: persist the offer BEFORE the send ────────────────
  // Invariant: the amount in the seller's SMS must equal the amount in the
  // persisted active offer. Previously the money was rendered into the body and
  // enqueued here, while the only durable write happened later in
  // persistSellerTransitionArtifacts inside a warn-only try/catch — so a failure
  // there left the seller holding $X with nothing recording that $X was the
  // active offer. The offer is now a PRECONDITION: if it cannot be persisted,
  // the monetary message is not queued.
  let persisted_offer = null;
  if (MONETARY_OFFER_USE_CASES.has(lower(selected_use_case))) {
    const offer_price = resolveAuthorizedOfferAmount(dealAuthority);
    const offer_result = offer_price
      ? await persistActiveOfferImpl({
          opportunity_id: opportunityId,
          property_id: propertyId,
          thread_key: threadKey || inboundFrom,
          master_owner_id: ownerId,
          purchase_price: offer_price,
          offer_type: lower(selected_use_case),
          direction: "outbound",
          recommended_offer: dealAuthority?.recommended_offer ?? null,
          authorized_ceiling: dealAuthority?.authorized_offer_ceiling ?? null,
          strategy: strategyDirective?.strategy || null,
          source_message_event_id: clean(inboundEventId) || null,
          // OFFER-VERSION FREEZE: bind this version to the immutable ADE run and
          // the margin policy that produced it. Without these the offer could not
          // prove which valuation it came from, and a later recomputation would
          // leave no evidence of divergence.
          ade_snapshot_id: dealAuthority?.ade_snapshot_id ?? null,
          valuation_mid: dealAuthority?.valuation_mid ?? null,
          metadata: dealAuthority?.margin_policy
            ? {
                margin_policy_version: dealAuthority.margin_policy.policy_version ?? null,
                minimum_margin: dealAuthority.margin_policy.minimum_margin ?? null,
                target_margin: dealAuthority.margin_policy.target_margin ?? null,
                protected_margin: dealAuthority.margin_policy.protected_margin ?? null,
                max_available_margin: dealAuthority.margin_policy.max_available_margin ?? null,
                margin_pct: dealAuthority.margin_policy.margin_pct ?? null,
              }
            : {},
          // closing/EMD terms are applied inside persistActiveOffer from
          // SELLER_OFFER_POLICY_V1; they are deliberately not fabricated here.
          supabase,
        })
      : { ok: false, reason: "offer_amount_unauthorized" };

    if (!offer_result?.ok) {
      warn("[OFFER_AUTHORITY_BLOCKED_SEND]", {
        thread_key: threadKey || inboundFrom,
        use_case: selected_use_case,
        reason: offer_result?.reason || "offer_persist_failed",
      });
      const blocked_decision = {
        ...base_decision,
        should_queue_reply: false,
        should_mark_human_review: true,
        reply_mode: "none",
        audit_reason: offer_result?.reason || "offer_persist_failed",
      };
      return {
        ok: true,
        automation_decision: blocked_decision,
        selected_template,
        rendered_message_text,
        natural_reply: natural_reply.audit,
        queued: false,
        queue_item_id: null,
        queue_row_id: null,
        queue_result: {
          ok: false,
          status: 409,
          reason: offer_result?.reason || "offer_persist_failed",
        },
        suppression_applied: false,
        duplicate_suppressed: false,
        dry_run: Boolean(dryRun),
        auto_reply_mode: effective_auto_reply_mode,
        queue_permission,
        audit_reason: blocked_decision.audit_reason,
      };
    }
    persisted_offer = offer_result;
  }

  // ── NEGOTIATION QUOTE LOG (flag SELLER_AUTOPILOT_V2) ──────────────────────
  // Every number we are about to put to a seller is persisted with its
  // evidence BEFORE the send, as an ANCHOR or a FORMAL OFFER (never an anchor
  // as the active offer). A monetary quote that cannot be logged is not sent;
  // this also closes the legacy comp_anchor path, which rendered {{offer_price}}
  // with no record at all. "Confirm basics" records the ask, carries no number,
  // and is never blocked by the log.
  let negotiation_quote = null;
  if (isSellerAutopilotV2Enabled()) {
    const quote_type = quoteTypeFor({ use_case: selected_use_case, template_body: selected_template.template_body });
    if (quote_type) {
      const v2_plan = base_decision.seller_autopilot_v2 || null;
      const mon = v2_plan?.monetary || null;
      const auth = v2_plan?.authority || null;
      const confirm = quote_type === QUOTE_TYPES.CONFIRM_BASICS;
      let quote_error = null;
      let row = null;
      try {
        row = buildNegotiationQuote({
          quote_key: `${clean(inboundEventId) || clean(threadKey) || "thread"}:${clean(selected_template.template_id || selected_template.id) || selected_use_case}`,
          quote_type,
          amount: confirm ? null : resolveAuthorizedOfferAmount(dealAuthority),
          max_offer: confirm ? auth?.mao ?? null : mon?.ceiling ?? dealAuthority?.authorized_offer_ceiling ?? null,
          recommended_offer: mon?.offer_version?.recommended_offer ?? auth?.offer ?? dealAuthority?.recommended_offer ?? null,
          engine_version: mon?.offer_version?.engine_version ?? auth?.engine_version ?? null,
          score_snapshot_id: mon?.offer_version?.snapshot_id ?? auth?.snapshot_id ?? dealAuthority?.ade_snapshot_id ?? null,
          score_computed_at: mon?.offer_version?.computed_at ?? auth?.computed_at ?? null,
          decision_tier: mon?.offer_version?.decision_tier ?? auth?.decision_tier ?? null,
          rule_branch: mon?.rule || v2_plan?.price_branch || (lower(selected_use_case) === "comp_anchor" ? "legacy_comp_anchor" : lower(selected_use_case)),
          comp_ids: mon?.comp_ids || [],
          comp_prices: mon?.comp_prices || [],
          asking_price: v2_plan?.asking_price ?? null,
          language: clean(selected_template.language) || clean(classification?.language) || null,
          template_id: clean(selected_template.template_id || selected_template.id) || null,
          use_case: selected_use_case,
          send_queue_key: queue_key,
          inbound_message_event_id: clean(inboundEventId) || null,
          thread_key: clean(threadKey) || clean(inboundFrom),
          property_id: clean(propertyId) || null,
          master_owner_id: clean(ownerId) || null,
          opportunity_id: clean(opportunityId) || null,
          seller_offer_id: clean(persisted_offer?.offer?.offer_id || persisted_offer?.offer_id || persisted_offer?.offer?.id) || null,
          evidence: { plan: v2_plan ? { reasoning_code: v2_plan.reasoning_code, price_branch: v2_plan.price_branch, v2_stage: v2_plan.v2_stage } : null, monetary: mon, comp_anchor_statement: clean(dealAuthority?.comp_anchor_statement) || null },
          quoted_at: now,
        });
      } catch (error) {
        quote_error = error?.message || "negotiation_quote_invalid";
      }
      const written = row ? await (negotiationQuoteImpl || recordNegotiationQuote)(supabase, row) : { ok: false, reason: quote_error };
      negotiation_quote = { ...(row || {}), write: written };
      if (!written?.ok && !confirm) {
        warn("[NEGOTIATION_QUOTE_BLOCKED_SEND]", { thread_key: threadKey || inboundFrom, use_case: selected_use_case, reason: written?.reason || quote_error });
        const blocked_decision = {
          ...base_decision,
          should_queue_reply: false,
          should_mark_human_review: true,
          reply_mode: "none",
          human_review_reason: "negotiation_quote_log_failed",
          audit_reason: "negotiation_quote_log_failed",
        };
        return {
          ok: true,
          automation_decision: blocked_decision,
          selected_template,
          rendered_message_text,
          queued: false,
          queue_item_id: null,
          queue_row_id: null,
          queue_result: { ok: false, status: 409, reason: written?.reason || quote_error || "negotiation_quote_log_failed" },
          negotiation_quote,
          suppression_applied: false,
          duplicate_suppressed: false,
          dry_run: Boolean(dryRun),
          auto_reply_mode: effective_auto_reply_mode,
          queue_permission,
          audit_reason: "negotiation_quote_log_failed",
        };
      }
    }
  }

  const email_channel = channel === "email" && typeof emailReplyImpl === "function";
  const queue_result = email_channel
    ? await emailReplyImpl({
        rendered_message_text,
        selected_template,
        selected_use_case,
        scheduled_for,
        queue_key,
        inbound_event_id: inboundEventId,
        owner_id: ownerId,
        property_id: propertyId,
        prospect_id: prospectId,
        classification,
        decision: base_decision,
        offer: persisted_offer,
        language: clean(selected_template.language) || clean(classification?.language) || "English",
      })
    : await insertSupabaseSendQueueRow({
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
      // IDENTITY ANCHOR so a FAILED send can be re-dispatched with an
      // alternate body (2026-09-09). resolveQueueRowIdentity refuses any row
      // whose action it cannot name ('queue_row_identity_underivable'), and an
      // auto-reply row carried no anchor at all -- so when TextGrid's content
      // filter blocked a live reply, the template rotation that exists for
      // exactly that failure class never ran and the seller was left with
      // silence. One inbound produces one auto-reply decision, so the inbound
      // event id is a stable, replay-safe anchor; it is also what
      // autonomy-invariants already falls back to when reconstructing which
      // inbound a row answers.
      decision_id: clean(inboundEventId) || `autoreply:${clean(threadKey) || "unknown"}`,
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
      // Binds this exact SMS to the persisted active offer it advertises. The
      // body's amount and offer_price are the same resolved authority value, so
      // the queued message and the offer record can never disagree.
      offer_id: persisted_offer?.offer_id || null,
      offer_version: persisted_offer?.offer_version ?? null,
      offer_price: persisted_offer?.purchase_price ?? null,
      offer_terms_hash: persisted_offer?.terms_hash || null,
    },
  }, {
    supabase,
  });

  // Close the loop: the offer now points at the exact queue row carrying it.
  // The offer back-pointer names a send_queue row; an email reply lives in email_queue.
  if (persisted_offer?.offer_id && queue_result?.ok && !email_channel) {
    try {
      await bindOfferToQueueRowImpl({
        offer_id: persisted_offer.offer_id,
        send_queue_row_id: queue_result.queue_row_id || queue_result.id || null,
        supabase,
      });
    } catch (bind_error) {
      // The offer is already durable; a missing back-pointer is an audit gap,
      // not a reason to un-send a queued message.
      warn("[OFFER_QUEUE_BIND_SKIPPED]", {
        offer_id: persisted_offer.offer_id,
        error: bind_error?.message || "bind_failed",
      });
    }
  }

  if (!queue_result?.ok) {
    // duplicate_blocked used to end the turn silently (reply_mode "none", no
    // review): the seller's message went unanswered. It is now a review with
    // repeat_intent_no_alternative and an operator alert.
    const duplicate = queue_result?.reason === "duplicate_blocked";
    const blocked_decision = {
      ...base_decision,
      should_queue_reply: false,
      should_mark_human_review: true,
      reply_mode: "manual_review",
      human_review_reason: duplicate ? "repeat_intent_no_alternative" : "queue_insert_failed",
      audit_reason: queue_result?.reason || "queue_insert_failed",
    };
    if (duplicate) {
      try {
        const notify =
          renderFailureNotifyImpl ||
          (await import("@/lib/domain/notifications/notification-emitter.js")).emitNotificationFromBusinessEvent;
        await notify({
          eventType: "inbox_auto_reply_blocked",
          severity: "warning",
          title: `Auto-reply not sent (duplicate of what we already sent) — ${clean(threadKey) || "thread"}`,
          description: `Seller replied (${clean(classification?.primary_intent) || "unknown intent"}); the chosen reply ${
            clean(selected_template?.template_id) || "?"
          } was already sent on this thread. Reply manually.`,
          titleVars: { thread_key: clean(threadKey) || "" },
          sourceEntityType: "thread",
          sourceEntityId: clean(threadKey) || clean(inboundEventId) || "thread",
          propertyId: clean(propertyId) || null,
          templateId: clean(selected_template?.template_id) || null,
          deduplicationKey: `auto_reply_duplicate_blocked:${clean(inboundEventId) || clean(threadKey) || ""}`,
          metrics: { reason: "duplicate_blocked", primary_intent: clean(classification?.primary_intent) || null },
          group: false,
        });
      } catch {
        // alerting must never block the decision
      }
    }

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
      natural_reply: natural_reply.audit,
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
    natural_reply: natural_reply.audit,
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
