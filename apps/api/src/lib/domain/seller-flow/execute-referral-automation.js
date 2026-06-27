import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import {
  buildSendQueueDedupeKey,
  insertSupabaseSendQueueRow,
} from "@/lib/supabase/sms-engine.js";
import {
  normalizeUsPhoneToE164,
  prepareRenderedSmsForQueue,
} from "@/lib/sms/sanitize.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import { info, warn } from "@/lib/logging/logger.js";
import { checkPhoneLevelCooldown } from "@/lib/domain/outreach/outreach-service.js";
import { checkInboundAutoReplySuppression } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { autoReplyModeAllowsQueue } from "@/lib/domain/seller-flow/auto-reply-mode.js";

const RECENT_CONTACT_DAYS = 14;
const REFERRAL_OWNERSHIP_USE_CASE = "ownership_check";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function canUseSupabase(client) {
  return Boolean(client) || hasSupabaseConfig();
}

/**
 * Determine whether an extracted referral is eligible for automatic Stage 1 outreach.
 */
export function evaluateReferralAutomationEligibility({
  relationship = null,
  referrals = [],
  ambiguous = false,
} = {}) {
  if (!relationship?.referral_detected) {
    return { eligible: false, review_required: false, reason: "no_referral_detected" };
  }

  if (ambiguous || relationship.ambiguous_pairing) {
    return { eligible: false, review_required: true, reason: "ambiguous_referral_pairing" };
  }

  const candidates = (Array.isArray(referrals) && referrals.length > 0)
    ? referrals
    : (relationship.referrals || []);
  if (candidates.length !== 1) {
    return {
      eligible: false,
      review_required: true,
      reason: candidates.length > 1 ? "multiple_referral_candidates" : "no_referral_candidate",
    };
  }

  const referral = candidates[0];
  if (referral.malformed || !referral.phone_e164) {
    return {
      eligible: false,
      review_required: true,
      reason: referral.malformed ? "malformed_referral_phone" : "referral_phone_missing",
    };
  }

  if (referral.dedupe_status === "already_known") {
    return { eligible: false, review_required: true, reason: "referral_already_known" };
  }

  if (relationship.should_suppress_contact || relationship.is_global_suppression) {
    return { eligible: false, review_required: true, reason: "source_suppressed" };
  }

  return {
    eligible: true,
    review_required: false,
    reason: "unambiguous_referral_with_phone",
    referral,
  };
}

async function findActiveSmsSuppression({ supabase, phoneNumber }) {
  const phone = normalizeUsPhoneToE164(phoneNumber) || clean(phoneNumber);
  if (!phone) return { suppressed: false, reason: null };

  const { data, error } = await supabase
    .from("message_events")
    .select("is_opt_out, opt_out_keyword, wrong_number, is_dnc")
    .or(`from_phone_number.eq.${phone},to_phone_number.eq.${phone}`)
    .or("is_opt_out.eq.true,wrong_number.eq.true,is_dnc.eq.true")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { suppressed: false, reason: null };
  if (!data) return { suppressed: false, reason: null };

  if (data.is_opt_out) return { suppressed: true, reason: "opt_out" };
  if (data.is_dnc) return { suppressed: true, reason: "dnc" };
  if (data.wrong_number) return { suppressed: true, reason: "wrong_number" };
  return { suppressed: false, reason: null };
}

async function findRecentReferralContact({ supabase, phoneNumber, propertyId }) {
  const phone = normalizeUsPhoneToE164(phoneNumber) || clean(phoneNumber);
  if (!phone) return { blocked: false, reason: null };

  const cutoff = new Date(Date.now() - RECENT_CONTACT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .from("send_queue")
    .select("id, created_at, queue_status")
    .eq("to_phone_number", phone)
    .gte("created_at", cutoff)
    .not("queue_status", "in", "(canceled,cancelled,failed)")
    .order("created_at", { ascending: false })
    .limit(1);

  if (propertyId) query = query.eq("property_id", propertyId);

  const { data, error } = await query.maybeSingle();
  if (error) return { blocked: false, reason: null };
  if (!data?.id) return { blocked: false, reason: null };
  return { blocked: true, reason: "recently_contacted", row_id: data.id };
}

async function selectReferralOwnershipTemplate({ supabase, context, language = "English" }) {
  const languages = language === "English" ? ["English"] : [language, "English"];
  const { data, error } = await supabase
    .from("sms_templates")
    .select("*")
    .eq("is_active", true)
    .eq("safe_for_auto_reply", true)
    .eq("use_case", REFERRAL_OWNERSHIP_USE_CASE)
    .in("language", languages)
    .order("priority_rank", { ascending: true, nullsFirst: false })
    .limit(20);

  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  const selected =
    rows.find((row) => lower(row.language) === lower(language)) ||
    rows.find((row) => lower(row.language) === "english") ||
    rows[0] ||
    null;
  if (!selected) return { ok: false, reason: "no_referral_ownership_template", template: null };
  return { ok: true, template: selected, reason: "referral_ownership_template_selected" };
}

function renderReferralTemplate({ template, context, referral, inboundTo }) {
  const seller_name = clean(referral?.name) || clean(context?.summary?.seller_first_name) || "there";
  const rendered = personalizeTemplate(template.template_body || template.message_body || "", {
    seller_first_name: seller_name.split(/\s+/)[0] || seller_name,
    seller_display_name: seller_name,
    owner_name: seller_name,
    property_address: clean(context?.summary?.property_address) || "",
    market: clean(context?.summary?.market) || clean(context?.summary?.market_name) || "",
    inbound_to: clean(inboundTo) || "",
  });
  const prepared = prepareRenderedSmsForQueue(rendered);
  if (!prepared.ok || !prepared.text) {
    return { ok: false, reason: prepared.reason || "template_render_failed", text: null };
  }
  return { ok: true, text: prepared.text, reason: "rendered" };
}

/**
 * Execute referral automation: link referred contact, queue Stage 1 ownership_check, or route to review.
 */
export async function executeReferralAutomation({
  supabaseClient = null,
  relationship = null,
  context = null,
  inboundTo = "",
  inboundEventId = null,
  referralId = null,
  execution_allowed = false,
  auto_reply_mode = "disabled",
  dry_run = false,
} = {}) {
  const referrals = relationship?.referrals || [];
  const eligibility = evaluateReferralAutomationEligibility({
    relationship,
    referrals,
    ambiguous: relationship?.ambiguous_pairing,
  });

  if (!eligibility.eligible) {
    return {
      ok: true,
      action: eligibility.review_required ? "review" : "skipped",
      reason: eligibility.reason,
      review_required: eligibility.review_required,
      queued: false,
      referral_id: referralId || null,
    };
  }

  if (!execution_allowed || !autoReplyModeAllowsQueue({ mode: auto_reply_mode }).allowed) {
    return {
      ok: true,
      action: "shadow_only",
      reason: "execution_gated",
      review_required: false,
      queued: false,
      referral_id: referralId || null,
      referral: eligibility.referral || null,
    };
  }

  if (!canUseSupabase(supabaseClient)) {
    return { ok: false, reason: "missing_supabase", queued: false };
  }

  const supabase = supabaseClient || getDefaultSupabaseClient();
  const referral = eligibility.referral;
  const referred_phone = normalizeUsPhoneToE164(referral.phone_e164);
  const property_id = clean(relationship.property_id);
  const master_owner_id = clean(relationship.master_owner_id);
  const source_thread_key = clean(relationship.source_thread_key) || clean(relationship.source_contact_phone);

  const sms_guard = await findActiveSmsSuppression({ supabase, phoneNumber: referred_phone });
  if (sms_guard.suppressed) {
    return {
      ok: true,
      action: "review",
      reason: sms_guard.reason || "referred_contact_suppressed",
      review_required: true,
      queued: false,
      referral_id: referralId || null,
    };
  }

  const inbound_guard = await checkInboundAutoReplySuppression({
    supabaseClient: supabase,
    phoneNumber: referred_phone,
    threadKey: referred_phone,
    ownerId: master_owner_id,
    context,
  });
  if (inbound_guard.suppressed) {
    return {
      ok: true,
      action: "review",
      reason: inbound_guard.reason || "referred_inbound_suppression",
      review_required: true,
      queued: false,
      referral_id: referralId || null,
    };
  }

  const phone_cooldown = await checkPhoneLevelCooldown(referred_phone, {
    supabase,
    phone_cooldown_days: RECENT_CONTACT_DAYS,
  });
  if (phone_cooldown.blocked) {
    return {
      ok: true,
      action: "review",
      reason: "recently_contacted",
      review_required: true,
      queued: false,
      referral_id: referralId || null,
    };
  }

  const recent_queue = await findRecentReferralContact({
    supabase,
    phoneNumber: referred_phone,
    propertyId: property_id,
  });
  if (recent_queue.blocked) {
    return {
      ok: true,
      action: "review",
      reason: recent_queue.reason || "recently_contacted",
      review_required: true,
      queued: false,
      referral_id: referralId || null,
    };
  }

  const template_result = await selectReferralOwnershipTemplate({
    supabase,
    context,
    language: clean(context?.summary?.language_preference) || "English",
  });
  if (!template_result.ok || !template_result.template) {
    return {
      ok: true,
      action: "review",
      reason: template_result.reason || "no_referral_ownership_template",
      review_required: true,
      queued: false,
      referral_id: referralId || null,
    };
  }

  const render_result = renderReferralTemplate({
    template: template_result.template,
    context,
    referral,
    inboundTo,
  });
  if (!render_result.ok || !render_result.text) {
    return {
      ok: true,
      action: "review",
      reason: render_result.reason || "template_render_failed",
      review_required: true,
      queued: false,
      referral_id: referralId || null,
    };
  }

  if (dry_run) {
    return {
      ok: true,
      action: "dry_run",
      reason: "referral_automation_dry_run",
      review_required: false,
      queued: false,
      referral_id: referralId || null,
      selected_template: template_result.template,
      rendered_message_text: render_result.text,
      child_thread_key: referred_phone,
    };
  }

  const dedupe_key = buildSendQueueDedupeKey({
    master_owner_id,
    property_id,
    to_phone_number: referred_phone,
    template_use_case: REFERRAL_OWNERSHIP_USE_CASE,
    touch_number: 0,
    campaign_session_id: clean(inboundEventId) || `referral:${source_thread_key}`,
  });

  const queue_result = await insertSupabaseSendQueueRow({
    dedupe_key,
    queue_status: "queued",
    scheduled_for: new Date().toISOString(),
    message_body: render_result.text,
    message_text: render_result.text,
    to_phone_number: referred_phone,
    from_phone_number: normalizeUsPhoneToE164(inboundTo) || clean(inboundTo),
    master_owner_id: master_owner_id || null,
    property_id: property_id || null,
    template_id: clean(template_result.template.template_id || template_result.template.id) || null,
    selected_template_id: clean(template_result.template.template_id || template_result.template.id) || null,
    current_stage: "S1",
    message_type: "First Touch",
    use_case_template: REFERRAL_OWNERSHIP_USE_CASE,
    thread_key: referred_phone,
    seller_first_name: clean(referral.name)?.split(/\s+/)[0] || null,
    seller_display_name: clean(referral.name) || null,
    type: "referral_outreach",
    source_event_id: clean(inboundEventId) || null,
    detected_intent: "non_owner_referral",
    stage_before: "referral_review",
    stage_after: "ownership_check",
    template_selected: REFERRAL_OWNERSHIP_USE_CASE,
    property_address: clean(context?.summary?.property_address) || null,
    metadata: {
      source: "referral_automation",
      action_type: "referral_stage_1_outreach",
      referral_source_thread_key: source_thread_key,
      referral_source_event_id: clean(relationship.source_event_id) || clean(inboundEventId) || null,
      referred_name: clean(referral.name) || null,
      referred_phone_e164: referred_phone,
      property_id,
      relationship_outcome: relationship.relationship_outcome || null,
      referral_id: referralId || null,
      never_merge_with_parent_timeline: true,
    },
  }, { supabase });

  if (!queue_result?.ok) {
    return {
      ok: true,
      action: "review",
      reason: queue_result?.reason || "referral_queue_insert_failed",
      review_required: true,
      queued: false,
      referral_id: referralId || null,
      queue_result,
    };
  }

  if (referralId) {
    try {
      await supabase
        .from("seller_contact_referrals")
        .update({
          review_status: "applied",
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: {
            applied_queue_row_id: queue_result.queue_row_id || queue_result.queue_item_id || null,
            automatic_send: true,
          },
        })
        .eq("id", referralId);
    } catch (error) {
      warn("[REFERRAL_AUTOMATION_REFERRAL_UPDATE_FAILED]", {
        referral_id: referralId,
        error: error?.message || "update_failed",
      });
    }
  }

  info("[REFERRAL_AUTOMATION_QUEUED]", {
    referred_phone_e164: referred_phone,
    property_id,
    source_thread_key,
    queue_row_id: queue_result.queue_row_id || null,
    template_use_case: REFERRAL_OWNERSHIP_USE_CASE,
  });

  return {
    ok: true,
    action: "queued",
    reason: "referral_stage_1_queued",
    review_required: false,
    queued: true,
    referral_id: referralId || null,
    child_thread_key: referred_phone,
    queue_row_id: queue_result.queue_row_id || queue_result.queue_item_id || null,
    selected_template: template_result.template,
    rendered_message_text: render_result.text,
  };
}

export default executeReferralAutomation;