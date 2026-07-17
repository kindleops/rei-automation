// ─── acquisition-brain/shadow-followup-planner.js ──────────────────────────
// Canonical stage-based follow-up planner (shadow only).
// Never enqueues, sends, or mutates stages.

import { createHash } from "node:crypto";
import { toJsonSafe } from "./fact-provenance-contract.js";
import { ACQUISITION_BRAIN_VERSION } from "./lifecycle-registry.js";
import {
  resolveShadowTimezone,
  evaluateContactWindowAt,
} from "./shadow-burst-timing.js";

export const SHADOW_FOLLOWUP_EVENT = "acquisition_brain_shadow_followup_plan";
export const FOLLOWUP_PLANNER_VERSION = "acquisition_brain_followup_planner_v1";

/**
 * Registry-driven follow-up policies (shadow contract).
 * Stage 1 ownership no-reply: 3 days after authoritative delivery.
 */
export const FOLLOWUP_POLICY_REGISTRY = Object.freeze({
  stage1_ownership_no_reply: {
    policy_id: "stage1_ownership_no_reply",
    stage: "ownership_check",
    stage_number: 1,
    triggering_outbound_use_cases: [
      "ownership_check",
      "first_touch",
      "stage1_ownership",
      "combined_first_touch",
    ],
    delivery_required: true,
    delay_ms: 3 * 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "ownership_check_followup",
    cancellation_conditions: [
      "inbound_reply",
      "stage_transition",
      "opt_out",
      "wrong_number",
      "sold_property",
      "never_owned",
      "terminal_provider_failure",
    ],
    contact_window_policy: "defer_to_next_open",
    terminal_conditions: ["opt_out", "wrong_number"],
    human_review_boundary: false,
    version: "v1",
  },
  stage2_interest_no_reply: {
    policy_id: "stage2_interest_no_reply",
    stage: "interest_proposal_confirmation",
    stage_number: 2,
    triggering_outbound_use_cases: ["consider_selling", "confirm_interest"],
    delivery_required: true,
    delay_ms: 2 * 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "consider_selling_followup",
    cancellation_conditions: [
      "inbound_reply",
      "stage_transition",
      "opt_out",
      "wrong_number",
    ],
    contact_window_policy: "defer_to_next_open",
    terminal_conditions: ["opt_out", "wrong_number"],
    human_review_boundary: false,
    version: "v1",
  },
  stage3_asking_price_no_reply: {
    policy_id: "stage3_asking_price_no_reply",
    stage: "asking_price",
    stage_number: 3,
    triggering_outbound_use_cases: ["seller_asking_price", "asking_price"],
    delivery_required: true,
    delay_ms: 2 * 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "seller_asking_price_followup",
    cancellation_conditions: [
      "inbound_reply",
      "stage_transition",
      "opt_out",
      "wrong_number",
    ],
    contact_window_policy: "defer_to_next_open",
    terminal_conditions: ["opt_out", "wrong_number"],
    human_review_boundary: false,
    version: "v1",
  },
  stage4_condition_no_reply: {
    policy_id: "stage4_condition_no_reply",
    stage: "property_condition",
    stage_number: 4,
    triggering_outbound_use_cases: ["condition_probe"],
    delivery_required: true,
    delay_ms: 2 * 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "condition_probe_followup",
    cancellation_conditions: [
      "inbound_reply",
      "stage_transition",
      "opt_out",
      "wrong_number",
    ],
    contact_window_policy: "defer_to_next_open",
    terminal_conditions: ["opt_out", "wrong_number"],
    human_review_boundary: false,
    version: "v1",
  },
  stage5_proposal_review: {
    policy_id: "stage5_proposal_review",
    stage: "proposal_review",
    stage_number: 5,
    triggering_outbound_use_cases: ["proposal_sent", "offer_presented"],
    delivery_required: true,
    delay_ms: 24 * 60 * 60_000,
    maximum_attempts: 2,
    template_use_case: "proposal_followup",
    cancellation_conditions: [
      "inbound_reply",
      "stage_transition",
      "opt_out",
      "wrong_number",
    ],
    contact_window_policy: "defer_to_next_open",
    terminal_conditions: ["opt_out", "wrong_number"],
    human_review_boundary: false,
    version: "v1",
  },
  stage6_contract_signature: {
    policy_id: "stage6_contract_signature",
    stage: "contract_signature",
    stage_number: 6,
    triggering_outbound_use_cases: ["contract_sent", "signature_request"],
    delivery_required: true,
    delay_ms: 24 * 60 * 60_000,
    maximum_attempts: 2,
    template_use_case: "contract_followup",
    cancellation_conditions: [
      "inbound_reply",
      "stage_transition",
      "opt_out",
      "wrong_number",
      "authority_unverified",
    ],
    contact_window_policy: "defer_to_next_open",
    terminal_conditions: ["opt_out", "wrong_number"],
    human_review_boundary: true,
    version: "v1",
  },
  stage7_10_event_reminder: {
    policy_id: "stage7_10_event_reminder",
    stage: "transaction",
    stage_number: 7,
    triggering_outbound_use_cases: ["transaction_event_reminder"],
    delivery_required: true,
    delay_ms: 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "transaction_reminder",
    cancellation_conditions: ["authoritative_event", "opt_out", "wrong_number"],
    contact_window_policy: "defer_to_next_open",
    terminal_conditions: ["opt_out", "wrong_number"],
    human_review_boundary: true,
    version: "v1",
    note: "Only for operational reminders; seller text never advances stages 7–10",
  },
});

function clean(value) {
  return String(value ?? "").trim();
}

function isCanonicalE164(thread) {
  const t = clean(thread);
  return t.startsWith("+") && t.length >= 11;
}

export function resolveFollowupPolicy({
  stage = null,
  outbound_use_case = null,
} = {}) {
  const uc = clean(outbound_use_case).toLowerCase();
  const stage_n = clean(stage).toLowerCase();
  for (const policy of Object.values(FOLLOWUP_POLICY_REGISTRY)) {
    if (
      policy.triggering_outbound_use_cases.some((u) => u.toLowerCase() === uc)
    ) {
      return policy;
    }
    if (
      policy.stage === stage_n ||
      String(policy.stage_number) === stage_n ||
      stage_n.includes(String(policy.stage_number))
    ) {
      // prefer use-case match; stage is secondary only if use case empty
      if (!uc) return policy;
    }
  }
  // Stage 1 first-touch heuristics
  if (
    /ownership|first.?touch|stage.?1|s1_/i.test(uc) ||
    /ownership/i.test(stage_n)
  ) {
    return FOLLOWUP_POLICY_REGISTRY.stage1_ownership_no_reply;
  }
  return null;
}

/**
 * Plan a shadow follow-up after authoritative delivery only.
 */
export function planShadowFollowup({
  thread_key = null,
  triggering_outbound_id = null,
  delivery_event_id = null,
  delivery_status = null,
  stage = null,
  outbound_use_case = null,
  delivered_at = null,
  timezone_context = null,
  active_followups = [],
  now = new Date(),
} = {}) {
  const t0 = Date.now();
  const thread = clean(thread_key);

  if (!isCanonicalE164(thread)) {
    return {
      ok: false,
      reason: "non_e164_or_archived_alias",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const status = clean(delivery_status).toLowerCase();
  if (status && !["delivered", "delivery", "dlvrd", "success"].includes(status)) {
    return {
      ok: false,
      reason: "delivery_not_authoritative",
      delivery_status: status,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }
  if (!delivery_event_id && !delivered_at) {
    return {
      ok: false,
      reason: "missing_delivery_event",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const policy = resolveFollowupPolicy({ stage, outbound_use_case });
  if (!policy) {
    return {
      ok: false,
      reason: "no_matching_policy",
      stage,
      outbound_use_case,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  // Exactly one active follow-up per thread/stage/policy
  const dedupe_collision = (active_followups || []).find(
    (f) =>
      f.policy_id === policy.policy_id &&
      f.thread_key === thread &&
      f.cancellation_state !== "cancelled" &&
      f.active !== false
  );
  if (dedupe_collision) {
    return {
      ok: false,
      reason: "active_followup_exists",
      existing_plan_id: dedupe_collision.plan_id || dedupe_collision.id,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const tz =
    timezone_context ||
    resolveShadowTimezone({ operational_fallback: "America/Chicago" });
  if (tz.resolution_failure_reason || !tz.timezone) {
    return {
      ok: false,
      reason: "timezone_unresolved",
      timezone_resolution: tz,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
      human_review_required: true,
    };
  }

  const base_ms = Date.parse(delivered_at || now);
  let scheduled_ms = base_ms + policy.delay_ms;
  const cw = evaluateContactWindowAt(scheduled_ms, tz.timezone);
  let contact_deferred = false;
  if (!cw.allowed && cw.next_eligible_at) {
    scheduled_ms = Date.parse(cw.next_eligible_at);
    contact_deferred = true;
  }

  const plan_id = createHash("sha256")
    .update(
      `${thread}:${policy.policy_id}:${clean(triggering_outbound_id)}:${clean(delivery_event_id)}`,
      "utf8"
    )
    .digest("hex")
    .slice(0, 24);

  const dedupe_key = `acquisition_brain_shadow_followup_plan:${thread}:${policy.policy_id}:${clean(delivery_event_id) || clean(triggering_outbound_id)}:${policy.version}`;

  const plan = {
    plan_id,
    thread_key: thread,
    triggering_outbound_id: clean(triggering_outbound_id) || null,
    delivery_event_id: clean(delivery_event_id) || null,
    stage: policy.stage,
    policy_id: policy.policy_id,
    policy_version: policy.version,
    scheduled_for: new Date(scheduled_ms).toISOString(),
    delay_ms: policy.delay_ms,
    timezone: tz.timezone,
    timezone_source: tz.source,
    template_use_case: policy.template_use_case,
    maximum_attempts: policy.maximum_attempts,
    cancellation_state: "active",
    cancellation_reason: null,
    cancellation_source_event: null,
    contact_window_deferred: contact_deferred,
    contact_window: cw,
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    planner_version: FOLLOWUP_PLANNER_VERSION,
    lifecycle_registry_version: ACQUISITION_BRAIN_VERSION,
    processing_duration_ms: Math.max(0, Date.now() - t0),
  };

  return {
    ok: true,
    plan: toJsonSafe(plan),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    event: {
      event_type: SHADOW_FOLLOWUP_EVENT,
      dedupe_key,
      conversation_thread_id: thread,
      payload: toJsonSafe(plan),
    },
  };
}

/**
 * Cancel a shadow follow-up plan (pure; no DB write).
 */
export function cancelShadowFollowup({
  plan = null,
  reason = null,
  source_event_id = null,
} = {}) {
  if (!plan) {
    return { ok: false, reason: "missing_plan" };
  }
  return {
    ok: true,
    plan: toJsonSafe({
      ...plan,
      cancellation_state: "cancelled",
      cancellation_reason: clean(reason) || "unspecified",
      cancellation_source_event: clean(source_event_id) || null,
      active: false,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    }),
  };
}

/**
 * Prove Stage 1 delivered first-touch would create one 3-day follow-up
 * and first inbound would cancel it (shadow only; no production write).
 */
export function proveStage1FollowupShadow({
  thread_key,
  outbound_id,
  delivery_event_id,
  delivered_at,
  inbound_event_id = null,
  inbound_at = null,
} = {}) {
  const created = planShadowFollowup({
    thread_key,
    triggering_outbound_id: outbound_id,
    delivery_event_id,
    delivery_status: "delivered",
    stage: "ownership_check",
    outbound_use_case: "ownership_check",
    delivered_at,
  });
  if (!created.ok) return { ok: false, created };

  let cancelled = null;
  if (inbound_event_id || inbound_at) {
    cancelled = cancelShadowFollowup({
      plan: created.plan,
      reason: "inbound_reply",
      source_event_id: inbound_event_id,
    });
  }

  return {
    ok: true,
    would_create_followup: true,
    followup_count: 1,
    delay_ms: created.plan.delay_ms,
    scheduled_for: created.plan.scheduled_for,
    cancelled_before_transport: Boolean(cancelled?.ok),
    cancellation_reason: cancelled?.plan?.cancellation_reason || null,
    may_enqueue: false,
    may_send: false,
    production_followup_created: false,
  };
}

export default {
  SHADOW_FOLLOWUP_EVENT,
  FOLLOWUP_PLANNER_VERSION,
  FOLLOWUP_POLICY_REGISTRY,
  resolveFollowupPolicy,
  planShadowFollowup,
  cancelShadowFollowup,
  proveStage1FollowupShadow,
};
