import { hasSupabaseConfig, supabase } from "@/lib/supabase/client.js";
import { warn } from "@/lib/logging/logger.js";
import crypto from "crypto";
import {
  resolveSafetyTier,
  SELLER_FLOW_SAFETY_POLICY,
  SELLER_FLOW_SAFETY_TIERS,
} from "./seller-flow-safety-policy.js";
import { SELLER_FLOW_STAGES } from "./canonical-seller-flow.js";

// Phase 8: only these intents qualify for live auto-reply
const AUTO_REPLY_WHITELIST = new Set([
  'ownership_confirmed',
  'positive_interest',
  'asks_offer',       // price_request
  'info_request',
  'conditional_interest',
]);

const STAGE_CODES = {
  ownership_check: "S1",
  info_source_explanation: "S1B",
  who_is_this: "S1B",
  consider_selling: "S2",
  asking_price: "S3",
  price_works_confirm_basics: "S4A",
  confirm_basics: "S4A",
  price_high_condition_probe: "S4B",
  condition_probe: "S4B",
  creative_probe: "S4C",
  offer_reveal_cash: "S5A",
  close_handoff: "S6",
  stop_or_opt_out: "STOP",
  wrong_person: "WRONG",
  not_interested: "DEAD",
  listed_or_unavailable: "LISTED",
  tenant_or_occupancy: "TENANT",
  hostile_or_legal: "LEGAL",
  unclear_clarifier: "UNCLEAR",
  manual_review: "REVIEW",
};

const LEGACY_STAGE_ALIASES = Object.freeze({
  [SELLER_FLOW_STAGES.PRICE_WORKS_CONFIRM_BASICS]: "confirm_basics",
  [SELLER_FLOW_STAGES.PRICE_HIGH_CONDITION_PROBE]: "condition_probe",
  [SELLER_FLOW_STAGES.WHO_IS_THIS]: "info_source_explanation",
});

function normalizeCurrentStage(stage = null) {
  const value = String(stage ?? "").trim().toLowerCase();
  if (!value) return null;
  if (["ownership confirmation", "ownership_check", "s1"].includes(value)) {
    return SELLER_FLOW_STAGES.OWNERSHIP_CHECK;
  }
  if (value === "confirm_basics") return SELLER_FLOW_STAGES.PRICE_WORKS_CONFIRM_BASICS;
  if (value === "condition_probe") return SELLER_FLOW_STAGES.PRICE_HIGH_CONDITION_PROBE;
  return value;
}

function mapTerminalStage(intent, template = null) {
  if (intent === "opt_out") return SELLER_FLOW_STAGES.STOP_OR_OPT_OUT;
  if (intent === "wrong_person") return SELLER_FLOW_STAGES.WRONG_PERSON;
  if (intent === "not_interested") return SELLER_FLOW_STAGES.NOT_INTERESTED;
  if (intent === "hostile_or_legal") return "hostile_or_legal";
  if (template && template !== SELLER_FLOW_STAGES.TERMINAL) return template;
  return "manual_review";
}

function toLegacyStageName(stage, intent = null) {
  if (stage === SELLER_FLOW_STAGES.TERMINAL) return mapTerminalStage(intent);
  return LEGACY_STAGE_ALIASES[stage] || stage;
}

export function normalizeSellerInboundIntent(input) {
  const text = String(input?.message_body || "").toLowerCase().trim();
  const classification = input?.classification || {};
  
  if (!text) return "unclear";

  const isMatch = (words) => words.some((w) => text.includes(w));
  const includesWholeWord = (word) => new RegExp(`(^|\\s)${word}(\\s|$)`, "i").test(text);

  const isOwnershipAffirmation = () => {
    if (
      isMatch([
        "yes it is",
        "that is mine",
        "i own it",
        "i still own",
        "still have it",
        "correct",
        "es mía",
        "es mia",
        "todavía lo tengo",
        "sigo teniendo",
        "aún lo tengo",
        "aun lo tengo",
      ])
    ) {
      return true;
    }

    // Use /\b/ boundary so "sí," (with comma) still matches
    const startsWithSi = /^s[ií]\b/i.test(text);

    return (
      includesWholeWord("yes") ||
      text === "i do" ||
      startsWithSi ||
      includesWholeWord("sí") ||
      includesWholeWord("si")
    );
  };

  if (
    isMatch([
      "texting someone at",
      "late night",
      "bad business practice",
      "do not work with you",
      "i will not work with you",
      "too late to text",
    ])
  ) {
    return "timing_complaint";
  }

  if (isMatch(["stop", "unsubscribe", "remove me", "take me off", "no me contactes", "elimíname", "borrar de lista"]) || classification.compliance_flag === "stop_texting") {
    return "opt_out";
  }

  if (isMatch(["wrong number", "not me", "no soy", "no es mio", "this is not", "you have the wrong number"]) || classification.source === "wrong_number") {
    return "wrong_person";
  }

  if (isMatch(["sue", "attorney", "lawyer", "report", "fcc", "harassment", "fuck", "bitch", "shit"]) || classification.compliance_flag === "litigator") {
    return "hostile_or_legal";
  }

  if (isMatch(["not interested", "no thanks", "not for sale", "no vendo", "no estoy interesado"])) {
    return "not_interested";
  }

  if (isMatch(["listed", "realtor", "agent", "under contract", "already sold"])) {
    return "listed_or_unavailable";
  }

  if (isMatch(["tenant", "occupied", "renter", "lease", "tenants"])) {
    return "tenant_or_occupancy";
  }

  if (isOwnershipAffirmation()) {
    return "ownership_confirmed";
  }

  if (
    isMatch([
      "who is this", "who are you", "who's this", "whos this",
      "how did you get my info", "where did you get my number",
      "what address", "which address", "what property", "which property",
      "property address", "where is the property",
      "como encontraste mi información", "quién eres", "quien eres",
    ]) ||
    classification.source === "how_got_number" ||
    classification.primary_intent === "info_request"
  ) {
    return "info_request";
  }

  if (isMatch(["maybe", "depends", "possibly", "if the price", "would consider", "might sell",
               "tal vez", "quizás", "quizas", "depende", "posiblemente"])) {
    return "conditional_interest";
  }

  // Price/offer logic
  if (/\b\d{2,3}k\b|\$\d+,\d+|\d{5,}/.test(text)) {
    return "asking_price_value";
  }

  if (isMatch(["what is your offer", "how much", "cuanto", "cuánto", "offer?"]) || classification.source === "asks_offer") {
    return "asks_offer";
  }

  // Condition
  if (isMatch(["repairs", "needs work", "roof", "plumbing", "fire", "vacant"]) && !text.includes("surgery")) {
    return "condition_signal";
  }

  if (text.length < 15 && text.split(" ").length <= 3 && !classification.source) {
    return "unclear";
  }

  return classification.source || "unclear";
}

export function resolveNextSellerStage(input) {
  const intent = normalizeSellerInboundIntent(input);
  const current_stage = normalizeCurrentStage(
    input?.current_stage || input?.conversation_context?.summary?.conversation_stage || null
  );

  if (intent === "opt_out") return SELLER_FLOW_STAGES.STOP_OR_OPT_OUT;
  if (intent === "wrong_person") return SELLER_FLOW_STAGES.WRONG_PERSON;
  if (intent === "not_interested") return SELLER_FLOW_STAGES.NOT_INTERESTED;
  if (intent === "hostile_or_legal" || intent === "timing_complaint") return "hostile_or_legal";
  if (intent === "listed_or_unavailable") return "listed_or_unavailable";
  if (intent === "tenant_or_occupancy") return "tenant_or_occupancy";
  if (intent === "unclear") return "unclear_clarifier";

  const stage_policy = current_stage && SELLER_FLOW_SAFETY_POLICY[current_stage]?.[intent];
  if (stage_policy?.next_stage) {
    return toLegacyStageName(stage_policy.next_stage, intent);
  }

  const global_policy = SELLER_FLOW_SAFETY_POLICY.global?.[intent];
  if (global_policy?.next_stage) {
    return toLegacyStageName(global_policy.next_stage, intent);
  }

  if (intent === "ownership_confirmed") return SELLER_FLOW_STAGES.CONSIDER_SELLING;
  if (intent === "info_request") {
    return current_stage === SELLER_FLOW_STAGES.OWNERSHIP_CHECK
      ? "info_source_explanation"
      : "manual_review";
  }
  if (intent === "asks_offer") return SELLER_FLOW_STAGES.ASKING_PRICE;
  if (intent === "asking_price_value") return "confirm_basics";
  if (intent === "condition_signal") return "condition_probe";

  return "manual_review";
}

export function resolveAutoReplyUseCase(input) {
  const intent = normalizeSellerInboundIntent(input);
  const current_stage = normalizeCurrentStage(
    input?.current_stage || input?.conversation_context?.summary?.conversation_stage || null
  );

  if (intent === "hostile_or_legal" || intent === "timing_complaint") return null;

  const stage_policy = current_stage && SELLER_FLOW_SAFETY_POLICY[current_stage]?.[intent];
  if (stage_policy?.template) {
    if (stage_policy.template === SELLER_FLOW_STAGES.TERMINAL) {
      return mapTerminalStage(intent, stage_policy.template);
    }
    return toLegacyStageName(stage_policy.template, intent);
  }

  const global_policy = SELLER_FLOW_SAFETY_POLICY.global?.[intent];
  if (global_policy?.template === null) return null;
  if (global_policy?.template) {
    if (global_policy.template === SELLER_FLOW_STAGES.TERMINAL) {
      return mapTerminalStage(intent, global_policy.template);
    }
    return toLegacyStageName(global_policy.template, intent);
  }

  const next_stage = resolveNextSellerStage(input);
  if (next_stage === SELLER_FLOW_STAGES.STOP_OR_OPT_OUT) return "stop_or_opt_out";
  if (next_stage === SELLER_FLOW_STAGES.WRONG_PERSON) return "wrong_person";
  if (next_stage === SELLER_FLOW_STAGES.NOT_INTERESTED) return "not_interested";
  if (next_stage === "listed_or_unavailable") return "listed_or_unavailable";
  if (next_stage === "tenant_or_occupancy") return "tenant_or_occupancy";
  if (next_stage === "unclear_clarifier") return "unclear_clarifier";
  if (next_stage === "manual_review") return null;
  return next_stage;
}

export function shouldSuppressSellerAutoReply(input) {
  const intent = normalizeSellerInboundIntent(input);
  const next_stage = resolveNextSellerStage(input);
  const confidence = input?.classification?.confidence ?? 1;
  const automation_state = input?.conversation_context?.summary?.automation_state || "running";
  
  if (!input.auto_reply_enabled && !input.force_queue_reply) return { suppress: true, reason: "auto_reply_disabled" };
  
  if (automation_state === "paused" || automation_state === "manual") return { suppress: true, reason: "manual_pause" };
  if (confidence < 0.90) return { suppress: true, reason: "confidence_too_low" };
  if (intent === "hostile_or_legal") return { suppress: true, reason: "hostile_or_legal_intent" };
  if (intent === "timing_complaint") return { suppress: true, reason: "timing_complaint_manual_review" };
  if (intent === "opt_out" && input.system_only) return { suppress: false, reason: null };
  if (intent === "opt_out" && !input.system_only) return { suppress: true, reason: "opt_out_intent_no_marketing" };
  // not_interested → no immediate reply; follow-up scheduler sends 30-day nurture
  if (intent === "not_interested") return { suppress: true, reason: "not_interested_nurture_only" };
  // Phase 8 whitelist: only these intents qualify for live auto-reply
  if (!AUTO_REPLY_WHITELIST.has(intent)) return { suppress: true, reason: `not_in_auto_reply_whitelist:${intent}` };

  if (next_stage === "manual_review") return { suppress: true, reason: "requires_manual_review" };
  
  return { suppress: false, reason: null };
}

async function checkDuplicateReply(input) {
  if (!supabase) return false;
  
  const source_event_id = input.inbound_event?.item_id || input.inbound_event?.id || null;
  const message_id = input.inbound_event?.provider_message_id || input.inbound_event?.message_id || null;
  const body = input.message_body || "";
  const from = input.inbound_event?.inbound_from || input.inbound_event?.from || "";
  const to = input.inbound_event?.inbound_to || input.inbound_event?.to || "";

  if (source_event_id || message_id) {
    let query = supabase.from("message_events").select("id").eq("direction", "outbound").limit(1);
    
    if (source_event_id) {
       query = query.eq("metadata->>source_event_id", source_event_id);
    } else {
       query = query.eq("metadata->>source_inbound_message_id", message_id);
    }
    
    const { data } = await query;
    if (data && data.length > 0) return true;
  }
  
  // Fallback hash check
  const tenMinsAgo = new Date(Date.now() - 10 * 60000).toISOString();
  const hash = crypto.createHash('sha256').update(`${from}:${to}:${body}`).digest('hex');
  
  const { data: hashData } = await supabase.from("message_events")
    .select("id")
    .eq("direction", "outbound")
    .eq("metadata->>inbound_hash", hash)
    .gte("created_at", tenMinsAgo)
    .limit(1);
    
  if (hashData && hashData.length > 0) return true;
  
  return false;
}

export async function resolveSellerAutoReplyPlan(input = {}) {
  const intent = normalizeSellerInboundIntent(input);
  const next_stage = resolveNextSellerStage(input);
  const selected_use_case = resolveAutoReplyUseCase(input);
  const suppression = shouldSuppressSellerAutoReply(input);
  const selected_stage_code = selected_use_case ? STAGE_CODES[next_stage] || null : null;
  const current_stage = input?.current_stage || input?.conversation_context?.summary?.conversation_stage || null;
  const selected_language = input?.classification?.language || input?.conversation_context?.summary?.language_preference || "English";

  const priority_map = {
    opt_out: 1,
    wrong_person: 2,
    hostile_or_legal: 3,
    not_interested: 4,
    listed_or_unavailable: 5,
    tenant_or_occupancy: 6,
    ownership_confirmed: 7,
    info_request: 8,
    asks_offer: 9,
    asking_price_value: 9,
    condition_signal: 10,
    unclear: 11
  };
  const priority = priority_map[intent] || 11;

  let should_queue_reply = !suppression.suppress;
  let suppression_reason = suppression.reason;
  let reply_mode = suppression.suppress ? "suppress" : "auto_queue";
  let fallback_reply = null;
  let selected_template_id = null;
  
  let is_duplicate = false;
  if (should_queue_reply) {
    is_duplicate = await checkDuplicateReply(input);
    if (is_duplicate) {
      should_queue_reply = false;
      suppression_reason = "duplicate_reply_blocked";
      reply_mode = "suppress";
    }
  }

  if (should_queue_reply && selected_use_case) {
    if (process.env.NODE_ENV === "test" && !hasSupabaseConfig()) {
      fallback_reply = `test-mode:${selected_use_case}`;
      selected_template_id = `test-${selected_use_case}`;
      reply_mode = "auto_queue";
    } else {
    // Query sms_templates directly — no RPC dependency.
    // Priority: exact use_case + language match, then English fallback.
    try {
      const { data: candidates, error: tmplErr } = await supabase
        .from("sms_templates")
        .select("id,template_id,template_body,use_case,language,is_active,safe_for_auto_reply,stage_code,stage_label")
        .eq("is_active", true)
        .eq("use_case", selected_use_case)
        .in("language", [selected_language, "English"])
        .order("language", { ascending: false }) // prefer exact language match
        .limit(20);

      if (tmplErr) throw tmplErr;

      const eligible = (candidates || []).filter(
        (t) => t.safe_for_auto_reply !== false // null is treated as eligible until column is backfilled
      );

      // Prefer exact language; English is acceptable fallback
      const bestTemplate =
        eligible.find((t) => t.language === selected_language) ||
        (selected_language !== "English" ? eligible.find((t) => t.language === "English") : null);

      if (!bestTemplate || !bestTemplate.template_body?.trim()) {
        should_queue_reply = false;
        suppression_reason = "no_template_for_intent_and_language";
        reply_mode = "manual_review";
      } else {
        fallback_reply = bestTemplate.template_body.trim();
        selected_template_id = bestTemplate.template_id || bestTemplate.id || null;
        reply_mode = "auto_queue";
        if (typeof process !== "undefined" && process.env.NODE_ENV !== "test") {
          // eslint-disable-next-line no-console
          console.log("[auto_reply_plan] template_selected", {
            template_id: selected_template_id,
            use_case: selected_use_case,
            language: bestTemplate.language,
            intent,
          });
        }
      }
    } catch (e) {
      warn("auto_reply_plan.template_check_failed", { error: e.message });
      should_queue_reply = false;
      suppression_reason = "template_lookup_error";
      reply_mode = "manual_review";
    }
    }
  }
  
  if (intent === "opt_out" && input.system_only) {
      should_queue_reply = true;
      reply_mode = "system_only";
      suppression_reason = null;
  }

  if (next_stage === "manual_review") reply_mode = "manual_review";

  const result = {
    ok: true,
    should_queue_reply,
    suppression_reason,
    inbound_intent: intent,
    current_stage,
    next_stage,
    selected_use_case,
    selected_stage_code,
    selected_language,
    selected_template_id,
    fallback_reply,
    priority,
    reply_mode,
    reason: suppression_reason || "plan_resolved",
    safety: {
      opt_out: intent === "opt_out",
      wrong_number: intent === "wrong_person",
      hostile_or_legal: intent === "hostile_or_legal",
      not_interested: intent === "not_interested",
      listed_or_unavailable: intent === "listed_or_unavailable",
      tenant_or_occupancy: intent === "tenant_or_occupancy",
      duplicate_reply_blocked: is_duplicate,
      context_verified: Boolean(input.conversation_context?.found),
      missing_context: !input.conversation_context?.found,
      missing_template_context: false
    },
    diagnostics: {
        timestamp: new Date().toISOString()
    }
  };

  // Add safety tier resolution
  result.safety_tier = resolveSafetyTier(result, input.auto_reply_enabled);
  result.auto_send_eligible = result.safety_tier === SELLER_FLOW_SAFETY_TIERS.AUTO_SEND;

  return result;
}
