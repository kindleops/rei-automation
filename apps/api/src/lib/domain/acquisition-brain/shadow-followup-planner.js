// ─── acquisition-brain/shadow-followup-planner.js ──────────────────────────
// Canonical stage-based follow-up state machine (shadow only).
// Never enqueues, sends, or mutates stages.

import { createHash } from "node:crypto";
import { toJsonSafe } from "./fact-provenance-contract.js";
import {
  ACQUISITION_BRAIN_VERSION,
  ACQUISITION_LIFECYCLE_STAGES as S,
  STAGE_NUMBERS,
  LIFECYCLE_STAGE_ALIASES,
  normalizeLifecycleStage,
} from "./lifecycle-registry.js";
import {
  resolveShadowTimezone,
  evaluateContactWindowAt,
} from "./shadow-burst-timing.js";

export const SHADOW_FOLLOWUP_EVENT = "acquisition_brain_shadow_followup_plan";
export const SHADOW_FOLLOWUP_CANCELLED_EVENT =
  "acquisition_brain_shadow_followup_cancelled";
export const SHADOW_FOLLOWUP_COMPLETED_EVENT =
  "acquisition_brain_shadow_followup_completed";
export const FOLLOWUP_PLANNER_VERSION = "acquisition_brain_followup_planner_v2";

/** Canonical plan states */
export const FOLLOWUP_PLAN_STATES = Object.freeze({
  INELIGIBLE: "ineligible",
  ELIGIBLE: "eligible",
  PLANNED: "planned",
  ACTIVE: "active",
  CANCELLED: "cancelled",
  SUPERSEDED: "superseded",
  COMPLETED: "completed",
  EXPIRED: "expired",
  BLOCKED: "blocked",
  HUMAN_REVIEW: "human_review",
});

export const CANCELLATION_REASONS = Object.freeze({
  INBOUND_REPLY_RECEIVED: "inbound_reply_received",
  LIFECYCLE_STAGE_ADVANCED: "lifecycle_stage_advanced",
  OPT_OUT: "opt_out",
  WRONG_NUMBER: "wrong_number",
  OWNERSHIP_DENIED: "ownership_denied",
  NEVER_OWNED: "never_owned",
  SOLD_PROPERTY: "sold_property",
  TERMINAL_PROVIDER_FAILURE: "terminal_provider_failure",
  AUTHORITY_UNVERIFIED: "authority_unverified",
  AUTHORITATIVE_TRANSACTION_EVENT: "authoritative_transaction_event",
  SUPERSEDED_BY_NEW_POLICY: "superseded_by_new_policy",
  HUMAN_OVERRIDE: "human_override",
});

/**
 * Exact stage number → canonical stage. No substring matching.
 * "stage10" / "10" / "s10" → closed; never stage 1.
 */
export const STAGE_NUMBER_TO_CANONICAL = Object.freeze({
  1: S.OWNERSHIP_CHECK,
  2: S.INTEREST_PROPOSAL_CONFIRMATION,
  3: S.ASKING_PRICE,
  4: S.PROPERTY_CONDITION,
  5: S.ACTUAL_PROPOSAL,
  6: S.FORMAL_CONTRACT,
  7: S.DISPOSITION,
  8: S.UNDER_CONTRACT_WITH_BUYER,
  9: S.ESCROW,
  10: S.CLOSED,
});

/**
 * Documented aliases → canonical stage (exact key match only).
 * interest_proposal is accepted as alias for interest_proposal_confirmation.
 */
export const FOLLOWUP_STAGE_ALIASES = Object.freeze({
  ...LIFECYCLE_STAGE_ALIASES,
  interest_proposal: S.INTEREST_PROPOSAL_CONFIRMATION,
  proposal_review: S.ACTUAL_PROPOSAL,
  contract_signature: S.FORMAL_CONTRACT,
  under_contract: S.UNDER_CONTRACT_WITH_BUYER,
  stage_1: S.OWNERSHIP_CHECK,
  stage_2: S.INTEREST_PROPOSAL_CONFIRMATION,
  stage_3: S.ASKING_PRICE,
  stage_4: S.PROPERTY_CONDITION,
  stage_5: S.ACTUAL_PROPOSAL,
  stage_6: S.FORMAL_CONTRACT,
  stage_7: S.DISPOSITION,
  stage_8: S.UNDER_CONTRACT_WITH_BUYER,
  stage_9: S.ESCROW,
  stage_10: S.CLOSED,
  stage1: S.OWNERSHIP_CHECK,
  stage2: S.INTEREST_PROPOSAL_CONFIRMATION,
  stage3: S.ASKING_PRICE,
  stage4: S.PROPERTY_CONDITION,
  stage5: S.ACTUAL_PROPOSAL,
  stage6: S.FORMAL_CONTRACT,
  stage7: S.DISPOSITION,
  stage8: S.UNDER_CONTRACT_WITH_BUYER,
  stage9: S.ESCROW,
  stage10: S.CLOSED,
  "1": S.OWNERSHIP_CHECK,
  "2": S.INTEREST_PROPOSAL_CONFIRMATION,
  "3": S.ASKING_PRICE,
  "4": S.PROPERTY_CONDITION,
  "5": S.ACTUAL_PROPOSAL,
  "6": S.FORMAL_CONTRACT,
  "7": S.DISPOSITION,
  "8": S.UNDER_CONTRACT_WITH_BUYER,
  "9": S.ESCROW,
  "10": S.CLOSED,
});

function clean(value) {
  return String(value ?? "").trim();
}

function isCanonicalE164(thread) {
  const t = clean(thread);
  return t.startsWith("+") && t.length >= 11;
}

/**
 * Exact stage resolution — no substring includes().
 */
export function resolveCanonicalFollowupStage(stage_input = null) {
  if (stage_input == null || stage_input === "") {
    return { ok: false, stage: null, reason: "missing_stage" };
  }
  const raw = clean(stage_input);
  const lower = raw.toLowerCase();

  // Exact canonical id
  if (Object.values(S).includes(lower)) {
    return {
      ok: true,
      stage: lower,
      stage_number: STAGE_NUMBERS[lower],
      source: "canonical",
    };
  }

  // Exact alias map only
  if (FOLLOWUP_STAGE_ALIASES[lower]) {
    const stage = FOLLOWUP_STAGE_ALIASES[lower];
    return {
      ok: true,
      stage,
      stage_number: STAGE_NUMBERS[stage],
      source: "alias",
    };
  }

  // Exact numeric only (not "stage10".includes("1"))
  if (/^\d{1,2}$/.test(lower)) {
    const n = Number(lower);
    if (STAGE_NUMBER_TO_CANONICAL[n]) {
      return {
        ok: true,
        stage: STAGE_NUMBER_TO_CANONICAL[n],
        stage_number: n,
        source: "stage_number",
      };
    }
  }

  // Prefer lifecycle normalizer if it returns exact known stage
  try {
    const norm = normalizeLifecycleStage?.(raw);
    if (norm && Object.values(S).includes(norm)) {
      return {
        ok: true,
        stage: norm,
        stage_number: STAGE_NUMBERS[norm],
        source: "lifecycle_normalize",
      };
    }
  } catch {
    /* ignore */
  }

  return { ok: false, stage: null, reason: "no_matching_policy", input: raw };
}

/**
 * Canonical delivery-status mapper.
 * Only explicit delivered mapping is authoritative.
 */
export function normalizeDeliveryStatus(raw_status = null, evidence = {}) {
  const raw = clean(raw_status).toLowerCase();
  const sid = clean(evidence.provider_sid || evidence.sid || evidence.provider_message_id);
  const delivered_at_raw = evidence.delivered_at || null;
  const delivered_at_ms = delivered_at_raw ? Date.parse(delivered_at_raw) : NaN;
  const delivered_at_valid = Number.isFinite(delivered_at_ms);

  const NON_AUTHORITATIVE = new Set([
    "queued",
    "accepted",
    "sent",
    "submitted",
    "pending",
    "unknown",
    "success", // without canonical delivered mapping
    "ok",
    "200",
    "failed",
    "undelivered",
    "rejected",
    "",
  ]);

  const DELIVERED_ALIASES = new Set([
    "delivered",
    "dlvrd",
    "delivery_confirmed",
    "carrier_delivered",
  ]);

  if (!raw || NON_AUTHORITATIVE.has(raw) || raw === "success") {
    return {
      raw_status: raw_status ?? null,
      normalized_status: raw || "missing",
      authoritative: false,
      evidence_source: evidence.evidence_source || null,
      provider_sid: sid || null,
      delivered_at: null,
      reason:
        !raw
          ? "missing_delivery_status"
          : raw === "success"
            ? "success_without_delivered_mapping"
            : `status_not_authoritative:${raw || "empty"}`,
    };
  }

  if (!DELIVERED_ALIASES.has(raw)) {
    return {
      raw_status: raw_status ?? null,
      normalized_status: raw,
      authoritative: false,
      evidence_source: evidence.evidence_source || null,
      provider_sid: sid || null,
      delivered_at: null,
      reason: `status_not_authoritative:${raw}`,
    };
  }

  if (!sid) {
    return {
      raw_status: raw_status ?? null,
      normalized_status: "delivered",
      authoritative: false,
      evidence_source: evidence.evidence_source || null,
      provider_sid: null,
      delivered_at: null,
      reason: "missing_provider_sid",
    };
  }

  if (!delivered_at_raw || !delivered_at_valid) {
    return {
      raw_status: raw_status ?? null,
      normalized_status: "delivered",
      authoritative: false,
      evidence_source: evidence.evidence_source || null,
      provider_sid: sid,
      delivered_at: null,
      reason: !delivered_at_raw ? "missing_delivered_at" : "invalid_delivered_at",
    };
  }

  return {
    raw_status: raw_status ?? null,
    normalized_status: "delivered",
    authoritative: true,
    evidence_source: evidence.evidence_source || "provider_delivery",
    provider_sid: sid,
    delivered_at: new Date(delivered_at_ms).toISOString(),
    reason: "authoritative_delivered",
  };
}

/**
 * Policy registry aligned with Stage 1–10 lifecycle.
 * Stages 7–10: event-driven, disabled by default, require authoritative txn event.
 */
export const FOLLOWUP_POLICY_REGISTRY = Object.freeze({
  stage1_ownership_no_reply: {
    policy_id: "stage1_ownership_no_reply",
    stage: S.OWNERSHIP_CHECK,
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
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: false,
    enabled: true,
    human_review_boundary: false,
    version: "v2",
  },
  stage2_interest_no_reply: {
    policy_id: "stage2_interest_no_reply",
    stage: S.INTEREST_PROPOSAL_CONFIRMATION,
    stage_number: 2,
    triggering_outbound_use_cases: [
      "consider_selling",
      "confirm_interest",
      "interest_proposal",
    ],
    delivery_required: true,
    delay_ms: 2 * 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "consider_selling_followup",
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: false,
    enabled: true,
    human_review_boundary: false,
    version: "v2",
  },
  stage3_asking_price_no_reply: {
    policy_id: "stage3_asking_price_no_reply",
    stage: S.ASKING_PRICE,
    stage_number: 3,
    triggering_outbound_use_cases: ["seller_asking_price", "asking_price"],
    delivery_required: true,
    delay_ms: 2 * 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "seller_asking_price_followup",
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: false,
    enabled: true,
    human_review_boundary: false,
    version: "v2",
  },
  stage4_condition_no_reply: {
    policy_id: "stage4_condition_no_reply",
    stage: S.PROPERTY_CONDITION,
    stage_number: 4,
    triggering_outbound_use_cases: ["condition_probe", "property_condition"],
    delivery_required: true,
    delay_ms: 2 * 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "condition_probe_followup",
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: false,
    enabled: true,
    human_review_boundary: false,
    version: "v2",
  },
  stage5_proposal_review: {
    policy_id: "stage5_proposal_review",
    stage: S.ACTUAL_PROPOSAL,
    stage_number: 5,
    triggering_outbound_use_cases: [
      "proposal_sent",
      "offer_presented",
      "actual_proposal",
    ],
    delivery_required: true,
    delay_ms: 24 * 60 * 60_000,
    maximum_attempts: 2,
    template_use_case: "proposal_followup",
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: false,
    enabled: true,
    human_review_boundary: false,
    version: "v2",
  },
  stage6_contract_signature: {
    policy_id: "stage6_contract_signature",
    stage: S.FORMAL_CONTRACT,
    stage_number: 6,
    triggering_outbound_use_cases: [
      "contract_sent",
      "signature_request",
      "formal_contract",
    ],
    delivery_required: true,
    delay_ms: 24 * 60 * 60_000,
    maximum_attempts: 2,
    template_use_case: "contract_followup",
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: false,
    enabled: true,
    human_review_boundary: true,
    version: "v2",
  },
  stage7_disposition_ops: {
    policy_id: "stage7_disposition_ops",
    stage: S.DISPOSITION,
    stage_number: 7,
    triggering_outbound_use_cases: ["disposition_ops_reminder"],
    delivery_required: false,
    delay_ms: 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "disposition_reminder",
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: true,
    enabled: false,
    human_review_boundary: true,
    version: "v2",
  },
  stage8_buyer_contract_ops: {
    policy_id: "stage8_buyer_contract_ops",
    stage: S.UNDER_CONTRACT_WITH_BUYER,
    stage_number: 8,
    triggering_outbound_use_cases: ["buyer_contract_ops_reminder"],
    delivery_required: false,
    delay_ms: 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "buyer_contract_reminder",
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: true,
    enabled: false,
    human_review_boundary: true,
    version: "v2",
  },
  stage9_escrow_ops: {
    policy_id: "stage9_escrow_ops",
    stage: S.ESCROW,
    stage_number: 9,
    triggering_outbound_use_cases: ["escrow_ops_reminder"],
    delivery_required: false,
    delay_ms: 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "escrow_reminder",
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: true,
    enabled: false,
    human_review_boundary: true,
    version: "v2",
  },
  stage10_closing_ops: {
    policy_id: "stage10_closing_ops",
    stage: S.CLOSED,
    stage_number: 10,
    triggering_outbound_use_cases: ["closing_ops_reminder"],
    delivery_required: false,
    delay_ms: 24 * 60 * 60_000,
    maximum_attempts: 1,
    template_use_case: "closing_reminder",
    cancellation_conditions: Object.values(CANCELLATION_REASONS),
    contact_window_policy: "defer_to_next_open",
    requires_authoritative_transaction_event: true,
    enabled: false,
    human_review_boundary: true,
    version: "v2",
  },
});

export function resolveFollowupPolicy({
  stage = null,
  outbound_use_case = null,
} = {}) {
  const uc = clean(outbound_use_case).toLowerCase();

  // Prefer exact use-case match
  if (uc) {
    for (const policy of Object.values(FOLLOWUP_POLICY_REGISTRY)) {
      if (
        policy.triggering_outbound_use_cases.some((u) => u.toLowerCase() === uc)
      ) {
        return { ok: true, policy, match: "use_case" };
      }
    }
  }

  const stage_res = resolveCanonicalFollowupStage(stage);
  if (!stage_res.ok) {
    return { ok: false, policy: null, reason: "no_matching_policy" };
  }

  for (const policy of Object.values(FOLLOWUP_POLICY_REGISTRY)) {
    if (policy.stage === stage_res.stage) {
      return { ok: true, policy, match: "stage", stage: stage_res };
    }
  }

  return { ok: false, policy: null, reason: "no_matching_policy" };
}

function isActivePlan(plan) {
  if (!plan) return false;
  const st = clean(plan.state || plan.cancellation_state || plan.plan_state);
  if (
    [
      FOLLOWUP_PLAN_STATES.CANCELLED,
      FOLLOWUP_PLAN_STATES.COMPLETED,
      FOLLOWUP_PLAN_STATES.EXPIRED,
      FOLLOWUP_PLAN_STATES.BLOCKED,
      FOLLOWUP_PLAN_STATES.SUPERSEDED,
      FOLLOWUP_PLAN_STATES.INELIGIBLE,
    ].includes(st)
  ) {
    return false;
  }
  if (plan.active === false) return false;
  if (st === "cancelled") return false;
  return (
    st === FOLLOWUP_PLAN_STATES.ACTIVE ||
    st === FOLLOWUP_PLAN_STATES.PLANNED ||
    st === FOLLOWUP_PLAN_STATES.ELIGIBLE ||
    plan.cancellation_state === "active" ||
    (!plan.cancellation_state && plan.plan_id)
  );
}

function planDedupeKey({
  thread,
  policy_id,
  triggering_outbound_id,
  delivery_event_id,
  policy_version,
}) {
  return `followup:${thread}:${policy_id}:${clean(triggering_outbound_id)}:${clean(delivery_event_id)}:${policy_version}`;
}

function cancelDedupeKey({ plan_id, cancellation_source_event_id }) {
  return `followup_cancel:${clean(plan_id)}:${clean(cancellation_source_event_id)}:${FOLLOWUP_PLANNER_VERSION}`;
}

function buildTransition({
  previous_state,
  next_state,
  reason_code,
  source_event_id,
  source_timestamp,
  thread,
  triggering_outbound_id,
  delivery_event_id,
  policy,
}) {
  return {
    previous_state,
    next_state,
    reason_code,
    source_event_id: clean(source_event_id) || null,
    source_timestamp: source_timestamp || new Date().toISOString(),
    planner_version: FOLLOWUP_PLANNER_VERSION,
    policy_version: policy?.version || null,
    canonical_thread: thread,
    triggering_outbound_id: clean(triggering_outbound_id) || null,
    authoritative_delivery_id: clean(delivery_event_id) || null,
  };
}

/**
 * Plan a shadow follow-up after authoritative delivery only.
 */
export function planShadowFollowup({
  thread_key = null,
  triggering_outbound_id = null,
  delivery_event_id = null,
  delivery_status = null,
  delivered_at = null,
  provider_sid = null,
  stage = null,
  outbound_use_case = null,
  template_use_case = null,
  template_id = null,
  template_version = null,
  automation_provenance = null,
  authoritative_transaction_event = null,
  timezone_context = null,
  active_followups = [],
  now = new Date(),
  evidence_source = "provider_delivery",
} = {}) {
  const t0 = Date.now();
  const thread = clean(thread_key);

  if (!isCanonicalE164(thread)) {
    return {
      ok: false,
      state: FOLLOWUP_PLAN_STATES.INELIGIBLE,
      reason: "non_e164_or_archived_alias",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const delivery = normalizeDeliveryStatus(delivery_status, {
    provider_sid: provider_sid || delivery_event_id,
    delivered_at,
    evidence_source,
  });

  // Stages 7–10 path: may not require SMS delivery but require txn event + enabled policy
  const use_case =
    clean(outbound_use_case) ||
    clean(template_use_case) ||
    clean(automation_provenance?.template_use_case) ||
    null;

  const policy_res = resolveFollowupPolicy({
    stage,
    outbound_use_case: use_case,
  });
  if (!policy_res.ok || !policy_res.policy) {
    return {
      ok: false,
      state: FOLLOWUP_PLAN_STATES.INELIGIBLE,
      reason: "no_matching_policy",
      stage,
      outbound_use_case: use_case,
      delivery,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }
  const policy = policy_res.policy;

  if (!policy.enabled) {
    return {
      ok: false,
      state: FOLLOWUP_PLAN_STATES.INELIGIBLE,
      reason: "policy_disabled",
      policy_id: policy.policy_id,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  if (policy.requires_authoritative_transaction_event) {
    if (!authoritative_transaction_event) {
      return {
        ok: false,
        state: FOLLOWUP_PLAN_STATES.INELIGIBLE,
        reason: "authoritative_transaction_event_required",
        policy_id: policy.policy_id,
        may_enqueue: false,
        may_send: false,
        may_mutate_stages: false,
      };
    }
  } else {
    // Stages 1–6: authoritative delivery required
    if (!delivery.authoritative) {
      return {
        ok: false,
        state: FOLLOWUP_PLAN_STATES.INELIGIBLE,
        reason: delivery.reason || "delivery_not_authoritative",
        delivery,
        may_enqueue: false,
        may_send: false,
        may_mutate_stages: false,
      };
    }
    if (!clean(delivery_event_id) && !clean(provider_sid)) {
      return {
        ok: false,
        state: FOLLOWUP_PLAN_STATES.INELIGIBLE,
        reason: "missing_delivery_event_id",
        may_enqueue: false,
        may_send: false,
        may_mutate_stages: false,
      };
    }
    if (!use_case) {
      return {
        ok: false,
        state: FOLLOWUP_PLAN_STATES.INELIGIBLE,
        reason: "missing_use_case",
        may_enqueue: false,
        may_send: false,
        may_mutate_stages: false,
      };
    }
  }

  // One active per thread + stage + policy
  const existing_active = (active_followups || []).filter(
    (f) =>
      isActivePlan(f) &&
      f.policy_id === policy.policy_id &&
      clean(f.thread_key) === thread
  );

  const same_delivery = existing_active.find(
    (f) =>
      clean(f.delivery_event_id) === clean(delivery_event_id) ||
      clean(f.triggering_outbound_id) === clean(triggering_outbound_id)
  );
  if (same_delivery) {
    return {
      ok: true,
      state: same_delivery.state || FOLLOWUP_PLAN_STATES.ACTIVE,
      reason: "duplicate_delivery_idempotent",
      plan: same_delivery,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
      active_count: existing_active.length,
    };
  }

  // Supersede older active for same policy when newer outbound
  const superseded = [];
  for (const prev of existing_active) {
    if (
      clean(prev.triggering_outbound_id) !== clean(triggering_outbound_id) ||
      prev.policy_version !== policy.version
    ) {
      superseded.push({
        existing_plan: prev,
        reason: CANCELLATION_REASONS.SUPERSEDED_BY_NEW_POLICY,
      });
    }
  }

  const tz =
    timezone_context ||
    resolveShadowTimezone({ operational_fallback: "America/Chicago" });
  if (tz.resolution_failure_reason || !tz.timezone) {
    return {
      ok: false,
      state: FOLLOWUP_PLAN_STATES.BLOCKED,
      reason: "timezone_unresolved",
      timezone_resolution: tz,
      human_review_required: true,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const base_iso = delivery.delivered_at || delivered_at;
  const base_ms = Date.parse(base_iso || now);
  if (!Number.isFinite(base_ms)) {
    return {
      ok: false,
      state: FOLLOWUP_PLAN_STATES.INELIGIBLE,
      reason: "invalid_delivered_at",
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    };
  }

  const raw_scheduled_ms = base_ms + policy.delay_ms;
  const raw_scheduled_for = new Date(raw_scheduled_ms).toISOString();
  const cw = evaluateContactWindowAt(raw_scheduled_ms, tz.timezone);
  let final_ms = raw_scheduled_ms;
  let contact_deferred = false;
  if (!cw.allowed && cw.next_eligible_at) {
    final_ms = Date.parse(cw.next_eligible_at);
    contact_deferred = true;
  }

  const plan_id = createHash("sha256")
    .update(
      `${thread}:${policy.policy_id}:${clean(triggering_outbound_id)}:${clean(delivery_event_id)}:${policy.version}`,
      "utf8"
    )
    .digest("hex")
    .slice(0, 24);

  const transition = buildTransition({
    previous_state: FOLLOWUP_PLAN_STATES.ELIGIBLE,
    next_state: FOLLOWUP_PLAN_STATES.ACTIVE,
    reason_code: "planned_after_authoritative_delivery",
    source_event_id: delivery_event_id,
    source_timestamp: delivery.delivered_at,
    thread,
    triggering_outbound_id,
    delivery_event_id,
    policy,
  });

  const plan = {
    plan_id,
    state: FOLLOWUP_PLAN_STATES.ACTIVE,
    thread_key: thread,
    triggering_outbound_id: clean(triggering_outbound_id) || null,
    delivery_event_id: clean(delivery_event_id) || null,
    provider_sid: delivery.provider_sid,
    delivery,
    stage: policy.stage,
    stage_number: policy.stage_number,
    policy_id: policy.policy_id,
    policy_version: policy.version,
    outbound_use_case: use_case,
    template_use_case: clean(template_use_case) || policy.template_use_case,
    template_id: clean(template_id) || null,
    template_version: clean(template_version) || null,
    raw_scheduled_for,
    scheduled_for: new Date(final_ms).toISOString(),
    final_scheduled_for: new Date(final_ms).toISOString(),
    delay_ms: policy.delay_ms,
    timezone: tz.timezone,
    timezone_source: tz.source,
    timezone_confidence: tz.confidence,
    contact_window_deferred: contact_deferred,
    contact_window: cw,
    cancellation_state: "active",
    cancellation_reason: null,
    cancellation_source_event: null,
    transition,
    superseded_plans: superseded.map((s) => ({
      plan_id: s.existing_plan.plan_id,
      reason: s.reason,
    })),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
    active: true,
    planner_version: FOLLOWUP_PLANNER_VERSION,
    lifecycle_registry_version: ACQUISITION_BRAIN_VERSION,
    processing_duration_ms: Math.max(0, Date.now() - t0),
  };

  const dedupe_key = planDedupeKey({
    thread,
    policy_id: policy.policy_id,
    triggering_outbound_id,
    delivery_event_id,
    policy_version: policy.version,
  });

  const active_count_after = 1; // new plan is sole active after supersession of priors

  return {
    ok: true,
    state: FOLLOWUP_PLAN_STATES.ACTIVE,
    plan: toJsonSafe(plan),
    supersession: {
      existing_plans: existing_active,
      new_candidate: plan,
      decision: superseded.length ? "supersede_prior" : "create_first",
      resulting_active_count: active_count_after,
    },
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
 * Cancel a shadow follow-up plan (pure). Never reactivates terminal plans.
 */
export function cancelShadowFollowup({
  plan = null,
  reason = null,
  source_event_id = null,
  source_timestamp = null,
} = {}) {
  if (!plan) {
    return { ok: false, reason: "missing_plan", fabricated: false };
  }
  if (!isActivePlan(plan)) {
    return {
      ok: false,
      reason: "plan_not_active",
      fabricated: false,
      plan_state: plan.state || plan.cancellation_state,
    };
  }

  const reason_code = clean(reason) || "unspecified";
  const transition = buildTransition({
    previous_state: plan.state || FOLLOWUP_PLAN_STATES.ACTIVE,
    next_state: FOLLOWUP_PLAN_STATES.CANCELLED,
    reason_code,
    source_event_id,
    source_timestamp,
    thread: plan.thread_key,
    triggering_outbound_id: plan.triggering_outbound_id,
    delivery_event_id: plan.delivery_event_id,
    policy: { version: plan.policy_version },
  });

  const cancelled = {
    ...plan,
    state: FOLLOWUP_PLAN_STATES.CANCELLED,
    cancellation_state: "cancelled",
    cancellation_reason: reason_code,
    cancellation_source_event: clean(source_event_id) || null,
    active: false,
    transition,
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
  };

  const dedupe_key = cancelDedupeKey({
    plan_id: plan.plan_id,
    cancellation_source_event_id: source_event_id,
  });

  return {
    ok: true,
    plan: toJsonSafe(cancelled),
    event: {
      event_type: SHADOW_FOLLOWUP_CANCELLED_EVENT,
      dedupe_key,
      conversation_thread_id: plan.thread_key,
      payload: toJsonSafe(cancelled),
    },
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
  };
}

/**
 * Evaluate cancellations for inbound / compliance / stage events.
 */
export function evaluateFollowupCancellations({
  active_plans = [],
  reason = null,
  source_event_id = null,
  source_timestamp = null,
} = {}) {
  const results = [];
  for (const plan of active_plans || []) {
    if (!isActivePlan(plan)) continue;
    const c = cancelShadowFollowup({
      plan,
      reason,
      source_event_id,
      source_timestamp,
    });
    if (c.ok) results.push(c);
  }
  return {
    ok: true,
    cancelled_count: results.length,
    cancellations: results,
    may_enqueue: false,
    may_send: false,
  };
}

/**
 * Stage 1 canary proof helper (no production write).
 */
export function proveStage1FollowupShadow({
  thread_key,
  outbound_id,
  delivery_event_id,
  delivered_at,
  provider_sid = null,
  inbound_event_id = null,
  inbound_at = null,
  outbound_use_case = "ownership_check",
} = {}) {
  const created = planShadowFollowup({
    thread_key,
    triggering_outbound_id: outbound_id,
    delivery_event_id,
    delivery_status: "delivered",
    delivered_at,
    provider_sid: provider_sid || delivery_event_id,
    stage: S.OWNERSHIP_CHECK,
    outbound_use_case,
    template_use_case: "ownership_check",
  });
  if (!created.ok) return { ok: false, created };

  let cancelled = null;
  if (inbound_event_id || inbound_at) {
    cancelled = cancelShadowFollowup({
      plan: created.plan,
      reason: CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
      source_event_id: inbound_event_id,
      source_timestamp: inbound_at,
    });
  }

  // Second inbound — no fabricated cancel on already-cancelled plan
  let second = null;
  if (cancelled?.ok) {
    second = cancelShadowFollowup({
      plan: cancelled.plan,
      reason: CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
      source_event_id: `${inbound_event_id}-2`,
    });
  }

  return {
    ok: true,
    would_create_followup: true,
    followup_count: 1,
    delay_ms: created.plan.delay_ms,
    scheduled_for: created.plan.final_scheduled_for,
    cancelled_before_transport: Boolean(cancelled?.ok),
    cancellation_reason: cancelled?.plan?.cancellation_reason || null,
    second_inbound_no_duplicate: second?.ok === false,
    may_enqueue: false,
    may_send: false,
    production_followup_created: false,
  };
}

export async function emitShadowFollowupEvent(result, deps = {}) {
  const emit = deps.emitAutomationEvent;
  if (typeof emit !== "function" || !result?.event) {
    return { ok: false, reason: "emit_unavailable" };
  }
  try {
    const out = await emit(
      {
        event_type: result.event.event_type,
        dedupe_key: result.event.dedupe_key,
        source: "acquisition_brain_shadow",
        conversation_thread_id: result.event.conversation_thread_id,
        payload: result.event.payload,
      },
      deps.supabase
        ? { supabase: deps.supabase, supabaseClient: deps.supabase }
        : {}
    );
    return { ok: true, event: out };
  } catch (error) {
    return { ok: false, reason: error?.message || "emit_failed" };
  }
}

/**
 * Live delivery path: plan after authoritative delivery (shadow emit only).
 */
export async function evaluateAndEmitShadowFollowupAfterDelivery({
  thread_key = null,
  triggering_outbound_id = null,
  delivery_event_id = null,
  delivery_status = null,
  delivered_at = null,
  provider_sid = null,
  stage = null,
  outbound_use_case = null,
  template_use_case = null,
  template_id = null,
  automation_provenance = null,
  timezone_context = null,
  active_followups = [],
  supabase = null,
  emitAutomationEvent = null,
  emit = true,
} = {}) {
  const t0 = Date.now();
  const evaluation = planShadowFollowup({
    thread_key,
    triggering_outbound_id,
    delivery_event_id,
    delivery_status,
    delivered_at,
    provider_sid,
    stage,
    outbound_use_case,
    template_use_case,
    template_id,
    automation_provenance,
    timezone_context,
    active_followups,
  });

  let emit_result = { ok: false, skipped: true };
  if (emit && evaluation.ok && evaluation.event && typeof emitAutomationEvent === "function") {
    try {
      emit_result = await emitShadowFollowupEvent(evaluation, {
        emitAutomationEvent,
        supabase,
      });
      // Emit supersession cancellations
      for (const s of evaluation.plan?.superseded_plans || []) {
        const prior = (active_followups || []).find((p) => p.plan_id === s.plan_id);
        if (prior && isActivePlan(prior)) {
          const c = cancelShadowFollowup({
            plan: prior,
            reason: CANCELLATION_REASONS.SUPERSEDED_BY_NEW_POLICY,
            source_event_id: delivery_event_id,
          });
          if (c.ok) {
            await emitShadowFollowupEvent(c, { emitAutomationEvent, supabase });
          }
        }
      }
    } catch (error) {
      emit_result = { ok: false, reason: error?.message || "emit_failed" };
    }
  }

  return {
    ...evaluation,
    emit: emit_result,
    total_duration_ms: Math.max(0, Date.now() - t0),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
  };
}

/**
 * Live cancellation path after inbound / compliance.
 */
export async function evaluateAndEmitShadowFollowupCancellations({
  thread_key = null,
  reason = CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
  source_event_id = null,
  source_timestamp = null,
  active_plans = [],
  supabase = null,
  emitAutomationEvent = null,
  emit = true,
  load_active = true,
} = {}) {
  const t0 = Date.now();
  let plans = active_plans || [];

  if (load_active && supabase?.from && isCanonicalE164(thread_key) && !plans.length) {
    try {
      const { data } = await supabase
        .from("automation_events")
        .select("id,payload,dedupe_key,created_at")
        .eq("event_type", SHADOW_FOLLOWUP_EVENT)
        .eq("conversation_thread_id", clean(thread_key))
        .order("created_at", { ascending: false })
        .limit(20);
      plans = (data || [])
        .map((r) => ({ ...r.payload, _event_id: r.id }))
        .filter(isActivePlan);
    } catch {
      /* fail open */
    }
  }

  const evaluation = evaluateFollowupCancellations({
    active_plans: plans,
    reason,
    source_event_id,
    source_timestamp,
  });

  const emits = [];
  if (emit && typeof emitAutomationEvent === "function") {
    for (const c of evaluation.cancellations || []) {
      try {
        emits.push(
          await emitShadowFollowupEvent(c, { emitAutomationEvent, supabase })
        );
      } catch (error) {
        emits.push({ ok: false, reason: error?.message || "emit_failed" });
      }
    }
  }

  return {
    ...evaluation,
    emits,
    total_duration_ms: Math.max(0, Date.now() - t0),
    may_enqueue: false,
    may_send: false,
    may_mutate_stages: false,
  };
}

export default {
  SHADOW_FOLLOWUP_EVENT,
  SHADOW_FOLLOWUP_CANCELLED_EVENT,
  SHADOW_FOLLOWUP_COMPLETED_EVENT,
  FOLLOWUP_PLANNER_VERSION,
  FOLLOWUP_PLAN_STATES,
  CANCELLATION_REASONS,
  FOLLOWUP_POLICY_REGISTRY,
  FOLLOWUP_STAGE_ALIASES,
  STAGE_NUMBER_TO_CANONICAL,
  resolveCanonicalFollowupStage,
  normalizeDeliveryStatus,
  resolveFollowupPolicy,
  planShadowFollowup,
  cancelShadowFollowup,
  evaluateFollowupCancellations,
  proveStage1FollowupShadow,
  emitShadowFollowupEvent,
  evaluateAndEmitShadowFollowupAfterDelivery,
  evaluateAndEmitShadowFollowupCancellations,
};
