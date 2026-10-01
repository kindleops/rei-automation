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

// Canonical intent names — must match CANONICAL_INTENTS in
// coverage-net/canonical-intent-aliases.js, the single reconciled vocabulary
// for Stages 1-6 (that module's own comment documents a past incident where
// divergent per-file vocabularies silently missed live classifier intents).
// normalizeClassificationContract() always folds wrong_person -> wrong_number
// before this scheduler ever sees an intent, so "wrong_person" alone would
// never match a real inbound reply; property_specific_non_owner covers both
// "not the owner" and "never owned" claims (see PROPERTY_SCOPED_CLAIMS in
// resolve-inbound-relationship.js), and former_owner_respondent covers "sold
// the property" claims.
const SUPPRESSED_INTENTS = new Set([
  "opt_out",
  "wrong_number",
  "wrong_person",
  "property_specific_non_owner",
  "former_owner_respondent",
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

/**
 * Stage-layer no-reply follow-up marker (followup-policy-registry.js). This is
 * an OUTBOUND-PURPOSE plan — "the delivered stage question got no reply" —
 * never a seller intent: nothing about the seller is asserted before they
 * respond. Cadence comes from the stage registry via opts.stage_no_reply_days;
 * the follow-up row is attributed to the outbound's actual template use case
 * (e.g. ownership_check), not a nurture bucket.
 */
export const STAGE_NO_REPLY_FOLLOWUP_INTENT = "stage_no_reply";

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

// Mirrors uq_send_queue_active_dedupe_key: a row in one of these statuses
// (and not yet sent) is a LIVE follow-up; anything else is a finished cycle.
const LIVE_FOLLOWUP_STATUSES = new Set([
  "queued", "ready", "runnable", "scheduled", "pending", "paused",
  "paused_after_hours", "processing", "approved", "approval", "held", "sending",
]);

function isLiveFollowUpRow(row) {
  if (!row || typeof row !== "object") return true; // unknown ⇒ treat as live (never double-schedule)
  if (row.sent_at) return false;
  const status = clean(row.queue_status).toLowerCase();
  if (!status) return true;
  return LIVE_FOLLOWUP_STATUSES.has(status);
}

/**
 * The cycle discriminator for a follow-up whose base key already belongs to a
 * finished cycle: the inbound that asked for it, else the UTC day. Same inbound
 * (or same day) replays stay idempotent.
 */
function followUpCycleId(context = {}, now = new Date()) {
  return (
    clean(context.inbound_message_event_id) ||
    clean(context.source_inbound_event_id) ||
    clean(context.inbound_event_id) ||
    now.toISOString().slice(0, 10)
  );
}

async function findLiveFollowUpRow(supabase, to_phone_number, use_case_template) {
  try {
    let query = supabase
      .from("send_queue")
      .select("id,queue_status,sent_at,dedupe_key")
      .eq("thread_key", to_phone_number)
      .eq("use_case_template", use_case_template)
      .in("queue_status", [...LIVE_FOLLOWUP_STATUSES]);
    if (typeof query.limit === "function") query = query.limit(5);
    const { data, error } = await query;
    if (error) return { error };
    const live = (Array.isArray(data) ? data : []).find((row) => !row.sent_at) || null;
    return { row: live };
  } catch (error) {
    return { error };
  }
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

  if (intent === STAGE_NO_REPLY_FOLLOWUP_INTENT) {
    const days = Number(opts.stage_no_reply_days);
    const stage = clean(opts.stage);
    if (!Number.isFinite(days) || days <= 0 || !stage) {
      // No stage-policy authority ⇒ fail closed; never borrow a nurture rule.
      return { suppressed: false, followup_created: false, reason: "stage_no_reply_policy_missing" };
    }
    return {
      suppressed: false,
      followup_created: true,
      scheduled_for: addDays(new Date(), days),
      days,
      reason: `stage_no_reply_followup:${stage}`,
      thread_key: thread_key || null,
    };
  }

  if (SUPPRESSED_INTENTS.has(intent)) {
    // SCOPE SPLIT (V2-1 §7). Every intent here suppresses follow-up, but they
    // do not all mean the same thing about the PROPERTY.
    //
    // `property_specific_non_owner` / `former_owner_respondent` say: this
    // CONTACT is wrong for this property. They previously returned the same
    // bare `permanent_suppression` as an opt-out, and with no waterfall behind
    // it the property simply stopped — indistinguishable, in the data, from a
    // deliberate compliance termination. The suppression of the pair is
    // correct and is kept; what is added is the statement that the property
    // itself is NOT finished and is awaiting contact resolution.
    //
    // Opt-out / DNC / hostility remain channel-compliance outcomes and are
    // deliberately NOT routed into contact resolution here: "STOP" must never
    // become a trigger to cycle the remaining numbers.
    const CONTACT_SCOPED_INTENTS = new Set([
      "property_specific_non_owner",
      "former_owner_respondent",
      "wrong_number",
      "wrong_person",
    ]);

    // The `permanent_suppression:` reason string is UNCHANGED on purpose.
    // three-layer-decision-contract.js and shadow-comparison-contract.js both
    // classify by substring-matching it, and a live test asserts it. Rewording
    // it would silently reclassify every suppression in those consumers, so
    // the scope split is carried by explicit new FIELDS instead — additive,
    // and invisible to anything still reading only the string.
    if (CONTACT_SCOPED_INTENTS.has(intent)) {
      return {
        suppressed: true,
        followup_created: false,
        reason: `permanent_suppression:${intent}`,
        suppression_scope: "contact_property_pair",
        property_opportunity_terminated: false,
        property_contact_state: "contact_resolution_pending",
        contact_resolution_required: true,
      };
    }

    return {
      suppressed: true,
      followup_created: false,
      reason: `permanent_suppression:${intent}`,
      suppression_scope: "channel_compliance",
      property_opportunity_terminated: false,
      contact_resolution_required: false,
    };
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
  const plan = resolveFollowUpPlan(intent, {
    thread_key,
    is_suppressed: context.is_suppressed,
    stage_no_reply_days: context.stage_no_reply_days,
    stage: context.stage,
  });

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

  const base_dedupe_key = buildFollowupDedupeKey(normalized_thread_key, intent);
  const scheduled_for = plan.scheduled_for;
  const use_case_template =
    intent === STAGE_NO_REPLY_FOLLOWUP_INTENT
      ? clean(context.followup_use_case) || "stage_no_reply"
      : `nurture_${intent}`;

  const enqueueWithKey = (dedupe_key) => {
    const queue_key = buildFollowupQueueKey(dedupe_key);
    return enqueueSendQueueItem(
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
      // Stage-layer no-reply follow-ups are attributed to the OUTBOUND's real
      // use case (e.g. ownership_check) so KPI/template rollups never see a
      // fabricated nurture bucket for a seller who simply hasn't replied yet.
      use_case_template,
      master_owner_id: clean(context.master_owner_id) || null,
      property_id: clean(context.property_id) || null,
      // Agent identity so deferred resolution can render agent-identifying
      // templates (e.g. the S1 ownership check) at send time.
      agent_name: clean(context.agent_name) || null,
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
  };

  let dedupe_key = base_dedupe_key;
  let queue_key = buildFollowupQueueKey(dedupe_key);
  let result = await enqueueWithKey(dedupe_key);

  // The base key is permanent (send_queue.queue_key is unique across ALL
  // statuses), so once a thread's first "not interested" follow-up was sent
  // or cancelled, every later "not interested" replayed onto that dead row
  // and was reported as duplicate_followup_exists: no thread in production
  // ever got a second nurture follow-up. A finished cycle is not a duplicate;
  // only a LIVE follow-up of the same kind is.
  if (result?.idempotent_replay && !isLiveFollowUpRow(result.raw)) {
    const live = await findLiveFollowUpRow(supabase, to_phone_number, use_case_template);
    if (live.error) {
      return {
        ok: false,
        skipped: true,
        reason: "followup_live_check_failed",
        thread_key: normalized_thread_key,
      };
    }
    if (live.row) {
      return {
        ok: false,
        skipped: true,
        reason: "duplicate_followup_exists",
        thread_key: normalized_thread_key,
        queue_row_id: live.row.id || null,
      };
    }
    dedupe_key = `${base_dedupe_key}:cycle:${followUpCycleId(context)}`;
    queue_key = buildFollowupQueueKey(dedupe_key);
    result = await enqueueWithKey(dedupe_key);
  }

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

/**
 * Inbound takeover: cancel pending no-reply follow-ups for a thread the
 * moment a seller reply arrives, so stale nurtures never fire after a live
 * conversation resumed. Same terminal semantics as the gap-recovery sweeper
 * (queue_status=cancelled + skip_reason), just synchronous.
 */
/** Pending auto-replies cancelled because a newer inbound superseded them. */
export const SUPERSEDED_BY_NEWER_INBOUND = "superseded_by_newer_inbound";

export async function cancelPendingFollowUpsForThread({
  thread_key,
  inbound_event_id = null,
  inbound_received_at = null,
  reason = "cancelled_followup_on_inbound_reply",
  now = new Date().toISOString(),
  keep_nurture_follow_ups = false,
  supabase = defaultSupabase,
} = {}) {
  const normalized_thread_key = normalizePhone(thread_key) || clean(thread_key);
  if (!normalized_thread_key || !supabase) {
    return { ok: false, cancelled: 0, reason: "missing_thread_key_or_client" };
  }

  const { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } = await import(
    "@/lib/domain/queue/cancel-supabase-pending-outbound.js"
  );

  return cancelSupabasePendingOutbound(
    {
      thread_key: normalized_thread_key,
      policy: CANCELLATION_POLICIES.INBOUND_TAKEOVER,
      reason,
      inbound_event_id,
      inbound_received_at,
      cancelled_by: "inbound_takeover",
      now,
      keep_nurture_follow_ups: keep_nurture_follow_ups === true,
    },
    { supabase }
  );
}