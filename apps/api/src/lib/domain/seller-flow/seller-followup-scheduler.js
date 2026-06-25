/**
 * seller-followup-scheduler.js
 *
 * Deterministic follow-up scheduling based on inbound seller intent.
 * Maps intent → suppression | nurture_days | reason.
 *
 * Rules (per spec):
 *   Permanent suppression: opt_out, wrong_person, hostile_or_legal, DNC
 *   not_interested          → nurture in 30 days
 *   maybe / conditional     → nurture in 14-30 days
 *   price_too_low / stalled → nurture in 7-21 days
 *   positive                → active workflow (no scheduled followup)
 */

import crypto from "node:crypto";

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { enqueueSendQueueItem } from "@/lib/supabase/sms-engine.js";
import { normalizePhone } from "@/lib/providers/textgrid.js";

const SUPPRESSED_INTENTS = new Set([
  "opt_out",
  "wrong_person",
  "wrong_person",
  "hostile_or_legal",
  "timing_complaint",
]);

const NURTURE_DAYS = {
  not_interested: 30,
  listed_or_unavailable: 45,
  tenant_or_occupancy: 21,
  condition_signal: 14,
  asking_price_value: 14,
  unclear: 7,
  conditional_interest: 21,
  maybe_depends_on_price: 21,
};

const ACTIVE_INTENTS = new Set([
  "ownership_confirmed",
  "asks_offer",
  "info_request",
  "positive_interest",
]);

/** Intents with no approved follow-up schedule yet — explicit safe hold state. */
const UNAPPROVED_FOLLOWUP_INTENTS = new Set(["condition_disclosed", "latent_interest"]);

function clean(value) {
  return String(value ?? "").trim();
}

function addDays(base, days) {
  const d = base instanceof Date ? new Date(base) : new Date(base || Date.now());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function buildFollowupDedupeKey(thread_key, intent) {
  return `seller_followup:${clean(thread_key)}:${clean(intent)}`;
}

function buildFollowupQueueKey(dedupe_key) {
  return `followup:${crypto.createHash("sha1").update(clean(dedupe_key)).digest("hex")}`;
}

/**
 * Referral-specific follow-up policy (shadow recommendations only).
 */
export function resolveReferralFollowUpPolicy({
  intent = null,
  thread_key = null,
  property_id = null,
  referrals = [],
} = {}) {
  if (intent !== "non_owner_referral") return null;

  return {
    source_respondent: {
      suppressed: false,
      followup_created: false,
      reason: "referral_source_no_property_nurture",
      property_scoped_only: true,
      global_suppression: false,
      acknowledgment_allowed: false,
      nurture_allowed: false,
      thread_key: thread_key || null,
      property_id: property_id || null,
    },
    referred_contacts: (referrals || []).map((referral) => ({
      name: referral.name || null,
      phone_e164: referral.phone_e164 || null,
      proposed_stage: "ownership_confirmation",
      automatic_send_allowed: false,
      review_required: true,
      shadow_only: true,
      dispatchable: false,
      dedupe_status: referral.dedupe_status || "new_or_unknown",
      provenance: {
        source_thread_key: thread_key || null,
        property_id: property_id || null,
      },
    })),
    shadow_only: true,
    dispatchable: false,
  };
}

/**
 * Decide whether and when to schedule a follow-up for a thread.
 */
export function resolveFollowUpPlan(intent, opts = {}) {
  const { thread_key, is_suppressed = false, property_scoped_only = false } = opts;

  if (intent === "non_owner_referral") {
    const referral_policy = resolveReferralFollowUpPolicy({
      intent,
      thread_key,
      property_id: opts.property_id,
      referrals: opts.referrals || [],
    });
    return {
      suppressed: false,
      followup_created: false,
      reason: referral_policy?.source_respondent?.reason || "referral_source_no_property_nurture",
      shadow_only: true,
      dispatchable: false,
      property_scoped_only: true,
      referral_policy,
    };
  }

  if (property_scoped_only && intent === "property_specific_non_owner") {
    return {
      suppressed: false,
      followup_created: false,
      reason: "property_scoped_non_owner_no_nurture",
      property_scoped_only: true,
    };
  }

  if (is_suppressed) {
    return { suppressed: true, followup_created: false, reason: "thread_already_suppressed" };
  }

  if (SUPPRESSED_INTENTS.has(intent)) {
    return { suppressed: true, followup_created: false, reason: `permanent_suppression:${intent}` };
  }

  if (ACTIVE_INTENTS.has(intent)) {
    return { suppressed: false, followup_created: false, reason: "active_workflow_no_nurture" };
  }

  if (UNAPPROVED_FOLLOWUP_INTENTS.has(intent)) {
    return {
      suppressed: false,
      followup_created: false,
      reason: "follow_up_policy_not_approved",
      follow_up_policy: "review_required_no_schedule",
      dispatchable: false,
      shadow_only: true,
    };
  }

  const days = NURTURE_DAYS[intent] ?? null;

  if (!days) {
    return { suppressed: false, followup_created: false, reason: `no_followup_rule_for_intent:${intent}` };
  }

  const scheduled_for = addDays(new Date(), days);

  return {
    suppressed: false,
    followup_created: true,
    scheduled_for,
    days,
    reason: `nurture_followup:${intent}`,
    thread_key: thread_key || null,
  };
}

/**
 * Writes a deferred nurture follow-up row through the canonical send-queue writer.
 * Message/template resolution happens later at send time.
 */
export async function scheduleFollowUp(intent, thread_key, context = {}, supabase = defaultSupabase) {
  const plan = resolveFollowUpPlan(intent, { thread_key, is_suppressed: context.is_suppressed });

  if (plan.suppressed || !plan.followup_created) {
    return { ok: false, skipped: true, ...plan };
  }

  const normalized_thread_key = normalizePhone(thread_key) || clean(thread_key);
  if (!normalized_thread_key) {
    return { ok: false, skipped: true, reason: "missing_thread_key" };
  }

  const to_phone_number = normalizePhone(normalized_thread_key);
  if (!to_phone_number) {
    return { ok: false, skipped: true, reason: "invalid_thread_key_phone" };
  }

  const dedupe_key = buildFollowupDedupeKey(normalized_thread_key, intent);
  const queue_key = buildFollowupQueueKey(dedupe_key);
  const scheduled_for = plan.scheduled_for;

  const result = await enqueueSendQueueItem(
    {
      queue_key,
      queue_id: queue_key,
      dedupe_key,
      thread_key: to_phone_number,
      to_phone_number,
      queue_status: "scheduled",
      type: "followup",
      scheduled_for,
      scheduled_for_utc: scheduled_for,
      scheduled_for_local: scheduled_for,
      message_type: "followup",
      use_case_template: `nurture_${intent}`,
      master_owner_id: clean(context.master_owner_id) || null,
      property_id: clean(context.property_id) || null,
      metadata: {
        deferred_message_resolution: true,
        source: clean(context.source) || "seller_followup_scheduler",
        intent,
        followup_reason: plan.reason,
        days_until_followup: plan.days,
        ...context,
      },
    },
    { supabase }
  );

  if (result?.reason === "phone_suppressed_21610") {
    return {
      ok: false,
      skipped: true,
      reason: "phone_suppressed_21610",
      thread_key: normalized_thread_key,
    };
  }

  if (result?.idempotent_replay) {
    return {
      ok: false,
      skipped: true,
      reason: "duplicate_followup_exists",
      thread_key: normalized_thread_key,
      queue_row_id: result.queue_row_id || null,
    };
  }

  if (!result?.ok) {
    return {
      ok: false,
      skipped: true,
      reason: result?.reason || "queue_insert_failed",
      error: result?.reason || "queue_insert_failed",
      thread_key: normalized_thread_key,
    };
  }

  return {
    ok: true,
    followup_created: true,
    scheduled_for,
    reason: plan.reason,
    thread_key: normalized_thread_key,
    queue_row_id: result.queue_row_id || null,
    queue_key: result.queue_key || queue_key,
    idempotent_replay: false,
  };
}