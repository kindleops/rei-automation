import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import { buildReferralDedupeKey } from "@/lib/domain/seller-flow/extract-seller-referral.js";
import { warn, info } from "@/lib/logging/logger.js";

function clean(value) {
  return String(value ?? "").trim();
}

function canUseSupabase(explicitClient = null) {
  return Boolean(explicitClient) || hasSupabaseConfig();
}

export async function persistInboundIntelligenceSnapshot({
  supabaseClient = null,
  intelligence_snapshot = null,
  provider_message_sid = null,
  message_event_id = null,
  dry_run = false,
} = {}) {
  if (!canUseSupabase(supabaseClient) || !intelligence_snapshot) {
    return { ok: false, reason: "missing_supabase_or_snapshot" };
  }

  if (dry_run) {
    return { ok: true, dry_run: true, reason: "dry_run_skip_persist" };
  }

  const supabase = supabaseClient || getDefaultSupabaseClient();
  const row = {
    source_event_id: clean(intelligence_snapshot.source_event_id) || clean(message_event_id) || null,
    provider_message_sid: clean(provider_message_sid) || null,
    source_thread_key: clean(intelligence_snapshot.source_thread_key) || null,
    canonical_intent: clean(intelligence_snapshot.canonical_intent) || null,
    universal_stage: clean(intelligence_snapshot.universal_stage) || null,
    granular_stage: clean(intelligence_snapshot.granular_stage) || null,
    safety_status: clean(intelligence_snapshot.safety_status) || null,
    identity_class: clean(intelligence_snapshot.identity_class) || null,
    relationship_outcome: clean(intelligence_snapshot.relationship_outcome) || null,
    execution_blocked_reason: clean(intelligence_snapshot.execution_blocked_reason) || null,
    human_review_status: clean(intelligence_snapshot.human_review_status) || null,
    referral_detected: Boolean(intelligence_snapshot.referral_detected),
    decision_version: clean(intelligence_snapshot.decision_version) || null,
    canonical_decision: intelligence_snapshot.canonical_decision || null,
    legacy_decision: intelligence_snapshot.legacy_decision || null,
    shadow_stage_engine: intelligence_snapshot.shadow_stage_engine || null,
    follow_up_recommendation: intelligence_snapshot.follow_up_recommendation || null,
    selected_template: intelligence_snapshot.selected_template || null,
    metadata: intelligence_snapshot,
    created_at: intelligence_snapshot.created_at || new Date().toISOString(),
  };

  try {
    const { data, error } = await supabase
      .from("inbound_intelligence_audit")
      .upsert(row, { onConflict: "source_event_id" })
      .select("id")
      .maybeSingle();

    if (error) throw error;

    info("[INBOUND_INTELLIGENCE_PERSISTED]", {
      source_event_id: row.source_event_id,
      audit_id: data?.id || null,
      canonical_intent: row.canonical_intent,
    });

    return { ok: true, audit_id: data?.id || null };
  } catch (error) {
    warn("[INBOUND_INTELLIGENCE_PERSIST_FAILED]", {
      source_event_id: row.source_event_id,
      error: error?.message || "persist_failed",
    });
    return { ok: false, reason: "persist_failed", error: error?.message || "persist_failed" };
  }
}

export async function persistSellerContactReferral({
  supabaseClient = null,
  referral = null,
  dry_run = false,
} = {}) {
  if (!referral?.referral_detected || !canUseSupabase(supabaseClient)) {
    return { ok: false, skipped: true, reason: "no_referral_or_supabase" };
  }

  if (dry_run) {
    return { ok: true, dry_run: true, reason: "dry_run_skip_referral_persist" };
  }

  const supabase = supabaseClient || getDefaultSupabaseClient();
  const dedupe_key = buildReferralDedupeKey({
    source_event_id: referral.source_event_id,
    referred_phone_e164: referral.referred_phone_e164,
    property_id: referral.property_id,
  });

  const row = {
    source_event_id: clean(referral.source_event_id) || null,
    source_thread_key: clean(referral.source_thread_key) || null,
    source_contact_phone: clean(referral.source_contact_phone) || null,
    property_id: clean(referral.property_id) || null,
    master_owner_id: clean(referral.master_owner_id) || null,
    referred_name: clean(referral.referred_name) || null,
    referred_phone_e164: clean(referral.referred_phone_e164) || null,
    relationship_claim: clean(referral.relationship_claim) || null,
    confidence: referral.confidence ?? null,
    extraction_method: clean(referral.extraction_method) || "deterministic_regex_v1",
    dedupe_status: "pending_review",
    review_status: "pending_review",
    metadata: {
      proposed_operations: referral.proposed_operations || [],
      relationship_outcome: referral.relationship_outcome || null,
      dedupe_key,
    },
    created_at: new Date().toISOString(),
  };

  try {
    const { data: existing } = await supabase
      .from("seller_contact_referrals")
      .select("id")
      .eq("source_event_id", row.source_event_id)
      .eq("referred_phone_e164", row.referred_phone_e164)
      .maybeSingle();

    if (existing?.id) {
      return { ok: true, idempotent: true, referral_id: existing.id };
    }

    const { data, error } = await supabase
      .from("seller_contact_referrals")
      .insert(row)
      .select("id")
      .maybeSingle();

    if (error) throw error;

    return { ok: true, referral_id: data?.id || null, idempotent: false };
  } catch (error) {
    warn("[SELLER_REFERRAL_PERSIST_FAILED]", {
      source_event_id: row.source_event_id,
      error: error?.message || "referral_persist_failed",
    });
    return { ok: false, reason: "referral_persist_failed", error: error?.message || "referral_persist_failed" };
  }
}

export function buildIntelligenceMessageEventPatch(intelligence_snapshot = null) {
  if (!intelligence_snapshot) return {};

  const decision = intelligence_snapshot.canonical_decision || {};
  const human_review_required = decision.should_mark_human_review === true;

  return {
    detected_intent: intelligence_snapshot.canonical_intent || null,
    current_stage: intelligence_snapshot.universal_stage || null,
    stage_after: intelligence_snapshot.granular_stage || null,
    classification_confidence: intelligence_snapshot.classification_confidence,
    safety_status: intelligence_snapshot.safety_status || null,
    auto_reply_status: intelligence_snapshot.automation_execution_status || "shadow_only",
    human_review_required,
    needs_human_review: human_review_required,
    automation_decision: decision,
    routing_allowed:
      decision.should_queue_reply === true &&
      intelligence_snapshot.automatic_send_allowed === true,
    metadata: {
      inbound_intelligence: intelligence_snapshot,
      identity_class: intelligence_snapshot.identity_class || null,
      relationship_outcome: intelligence_snapshot.relationship_outcome || null,
      relationship_claim: intelligence_snapshot.relationship_claim || null,
      suppression_scope: intelligence_snapshot.suppression_scope || "none",
      suppression_property_id: intelligence_snapshot.suppression_property_id || null,
      invalidate_phone_globally: Boolean(intelligence_snapshot.invalidate_phone_globally),
      invalidate_person_globally: Boolean(intelligence_snapshot.invalidate_person_globally),
      referral_detected: Boolean(intelligence_snapshot.referral_detected),
      referral: intelligence_snapshot.referral || null,
      follow_up_recommendation: intelligence_snapshot.follow_up_recommendation || null,
      shadow_stage_engine: intelligence_snapshot.shadow_stage_engine || null,
      execution_blocked_reason: intelligence_snapshot.execution_blocked_reason || null,
      decision_version: intelligence_snapshot.decision_version || null,
      selected_template: intelligence_snapshot.selected_template || null,
      recommended_use_case: intelligence_snapshot.recommended_use_case || null,
      automatic_send_allowed: Boolean(intelligence_snapshot.automatic_send_allowed),
      referred_contact_proposed_stage: intelligence_snapshot.referred_contact_proposed_stage || null,
    },
  };
}

export default persistInboundIntelligenceSnapshot;