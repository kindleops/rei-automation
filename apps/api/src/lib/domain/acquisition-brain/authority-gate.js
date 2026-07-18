// ─── acquisition-brain/authority-gate.js ───────────────────────────────────
// Gated internal Stage 1–3 authority adapter.
// DEFAULT: internal_shadow — never activates transport without explicit mode.
// Brain never calls TextGrid directly; may create at most one queue intent
// via the existing compliant queue processor when fully eligible.

export const ACQUISITION_BRAIN_MODE_KEY = "acquisition_brain_mode";

export const ACQUISITION_BRAIN_MODES = Object.freeze({
  INTERNAL_SHADOW: "internal_shadow",
  INTERNAL_AUTHORITATIVE: "internal_authoritative",
  PUBLIC_LIMITED: "public_limited",
});

export const DEFAULT_ACQUISITION_BRAIN_MODE =
  ACQUISITION_BRAIN_MODES.INTERNAL_SHADOW;

export const AUTHORITY_WRITERS = Object.freeze({
  LEGACY: "legacy",
  ACQUISITION_BRAIN: "acquisition_brain",
  HUMAN_REVIEW: "human_review",
  NO_ACTION: "no_action",
});

export const AUTHORITY_GATE_VERSION = "acquisition_brain_authority_gate_v1";

const STAGE_1_3 = new Set([
  "ownership_check",
  "interest_proposal_confirmation",
  "asking_price",
  "s1",
  "s2",
  "s3",
  "1",
  "2",
  "3",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function isCanonicalE164(thread) {
  const t = clean(thread);
  return t.startsWith("+") && t.length >= 11;
}

function normalizeMode(raw) {
  const m = clean(raw).toLowerCase();
  if (Object.values(ACQUISITION_BRAIN_MODES).includes(m)) return m;
  return DEFAULT_ACQUISITION_BRAIN_MODE;
}

/**
 * Resolve control-plane mode. Default is always internal_shadow.
 * Does not read production unless getSystemValue provided.
 */
export async function resolveAcquisitionBrainMode({
  explicit_mode = null,
  getSystemValue = null,
} = {}) {
  if (explicit_mode != null) {
    return {
      mode: normalizeMode(explicit_mode),
      source: "explicit",
    };
  }
  if (typeof getSystemValue === "function") {
    try {
      const v = await getSystemValue(ACQUISITION_BRAIN_MODE_KEY);
      if (v != null && clean(v)) {
        return { mode: normalizeMode(v), source: "system_control" };
      }
    } catch {
      /* default */
    }
  }
  return {
    mode: DEFAULT_ACQUISITION_BRAIN_MODE,
    source: "default",
  };
}

/**
 * Eligibility for internal Brain authority (Stage 1–3 canary only).
 * All conditions must be true. Default mode fails closed to shadow.
 */
export function evaluateBrainAuthorityEligibility({
  mode = DEFAULT_ACQUISITION_BRAIN_MODE,
  thread_key = null,
  is_internal_canary = false,
  is_public_seller = true,
  lifecycle_stage = null,
  classification_confidence = 0,
  confidence_threshold = 0.82,
  material_conflict = false,
  human_review_required = false,
  template_exists = false,
  template_active = false,
  suppression_clear = false,
  contact_window_ok = false,
  contact_window_deferred = false,
  e164_identity = false,
  final_burst_plan = false,
  canonical_nba = false,
  existing_active_queue_intent = false,
  emergency_stop = false,
  opt_out = false,
  wrong_number = false,
  stage_number = null,
} = {}) {
  const reasons = [];
  const mode_n = normalizeMode(mode);

  if (mode_n !== ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE) {
    reasons.push("mode_not_internal_authoritative");
  }
  if (!is_internal_canary) reasons.push("not_internal_canary");
  if (is_public_seller) reasons.push("public_seller");
  if (!isCanonicalE164(thread_key) && !e164_identity) {
    reasons.push("non_e164_identity");
  }
  const stage = clean(lifecycle_stage).toLowerCase();
  const sn = stage_number != null ? Number(stage_number) : null;
  const stage_ok =
    STAGE_1_3.has(stage) || (sn != null && sn >= 1 && sn <= 3);
  if (!stage_ok) reasons.push("stage_not_1_3");
  if (Number(classification_confidence) < confidence_threshold) {
    reasons.push("confidence_below_threshold");
  }
  if (material_conflict) reasons.push("material_conflict");
  if (human_review_required) reasons.push("human_review_required");
  if (!template_exists || !template_active) reasons.push("template_unavailable");
  if (!suppression_clear) reasons.push("suppression_active");
  if (!contact_window_ok && !contact_window_deferred) {
    reasons.push("contact_window_invalid");
  }
  if (!final_burst_plan) reasons.push("missing_final_burst_plan");
  if (!canonical_nba) reasons.push("missing_canonical_nba");
  if (existing_active_queue_intent) reasons.push("active_queue_intent_exists");
  if (emergency_stop) reasons.push("emergency_stop");
  if (opt_out) reasons.push("opt_out");
  if (wrong_number) reasons.push("wrong_number");

  const eligible = reasons.length === 0;
  return {
    eligible,
    mode: mode_n,
    reasons,
    gate_version: AUTHORITY_GATE_VERSION,
  };
}

/**
 * Single-writer authority resolution for one inbound.
 * Exactly one of: legacy | acquisition_brain | human_review | no_action
 */
export function resolveAuthorityWriter({
  mode = DEFAULT_ACQUISITION_BRAIN_MODE,
  eligibility = null,
  opt_out = false,
  wrong_number = false,
  human_review_required = false,
  brain_plan_ok = false,
  brain_failure = false,
} = {}) {
  if (opt_out || wrong_number) {
    return {
      writer: AUTHORITY_WRITERS.NO_ACTION,
      reason: opt_out ? "opt_out" : "wrong_number",
      legacy_may_enqueue: false,
      brain_may_enqueue: false,
    };
  }

  const mode_n = normalizeMode(mode);
  if (mode_n === ACQUISITION_BRAIN_MODES.INTERNAL_SHADOW) {
    return {
      writer: AUTHORITY_WRITERS.LEGACY,
      reason: "internal_shadow",
      legacy_may_enqueue: true, // legacy remains authoritative in shadow
      brain_may_enqueue: false,
      brain_shadow_observe: true,
    };
  }

  if (human_review_required) {
    return {
      writer: AUTHORITY_WRITERS.HUMAN_REVIEW,
      reason: "human_review_required",
      legacy_may_enqueue: false,
      brain_may_enqueue: false,
    };
  }

  if (
    mode_n === ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE &&
    eligibility?.eligible &&
    brain_plan_ok &&
    !brain_failure
  ) {
    return {
      writer: AUTHORITY_WRITERS.ACQUISITION_BRAIN,
      reason: "internal_authoritative_eligible",
      legacy_may_enqueue: false, // single writer: suppress legacy enqueue
      brain_may_enqueue: true,
      max_queue_intents: 1,
    };
  }

  // Brain selected path failed — do NOT fall back to legacy double enqueue
  if (
    mode_n === ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE &&
    (brain_failure || (eligibility?.eligible && !brain_plan_ok))
  ) {
    return {
      writer: AUTHORITY_WRITERS.HUMAN_REVIEW,
      reason: brain_failure
        ? "brain_failure_no_legacy_fallback"
        : "brain_plan_unavailable_no_legacy_fallback",
      legacy_may_enqueue: false,
      brain_may_enqueue: false,
    };
  }

  return {
    writer: AUTHORITY_WRITERS.LEGACY,
    reason: "fallback_legacy_not_authoritative_mode",
    legacy_may_enqueue: true,
    brain_may_enqueue: false,
  };
}

/**
 * Canonical queue-intent contract (Brain path). Never calls TextGrid.
 */
export function buildBrainQueueIntent({
  thread_key,
  inbound_event_ids = [],
  burst_id = null,
  burst_version = null,
  lifecycle_stage = null,
  nba = null,
  template_id = null,
  template_version = null,
  template_use_case = null,
  timing_policy = null,
  planned_send_at = null,
  timezone = null,
  timezone_source = null,
  suppression_decision = null,
  authority_decision = null,
  confidence = null,
  control_plane_mode = DEFAULT_ACQUISITION_BRAIN_MODE,
  internal_canary = false,
  observability_trace_id = null,
  component_versions = {},
} = {}) {
  const thread = clean(thread_key);
  const idempotency_key = [
    "brain_qi",
    thread,
    clean(burst_id) || "no_burst",
    clean(burst_version) || "v0",
    clean(nba) || "no_nba",
    clean(template_id) || "no_tpl",
    clean(planned_send_at) || "no_time",
  ].join(":");

  return {
    idempotency_key,
    canonical_e164_thread: thread,
    source_inbound_event_ids: inbound_event_ids,
    source_burst_id: burst_id,
    source_burst_version: burst_version,
    lifecycle_stage,
    nba,
    template_id,
    template_version,
    template_use_case,
    timing_policy,
    planned_send_at,
    timezone,
    timezone_source,
    suppression_decision,
    authority_decision,
    confidence,
    control_plane_mode: normalizeMode(control_plane_mode),
    internal_canary_marker: Boolean(internal_canary),
    component_versions: {
      authority_gate: AUTHORITY_GATE_VERSION,
      ...component_versions,
    },
    observability_trace_id,
    may_call_provider_directly: false,
    transport: "compliant_queue_processor_only",
  };
}

export const ROLLBACK_TRIGGERS = Object.freeze([
  "duplicate_queue_intent",
  "duplicate_provider_attempt",
  "opt_out_violation",
  "wrong_number_violation",
  "incorrect_stage_jump",
  "unresolved_template",
  "canonical_identity_mismatch",
  "contact_window_violation",
  "observability_failure",
  "queue_backlog_threshold",
  "processor_health_failure",
]);

/**
 * On rollback trigger: return to shadow or human_review — never unsafe transport.
 */
export function resolveRollbackAction(trigger) {
  const t = clean(trigger);
  if (!ROLLBACK_TRIGGERS.includes(t) && t) {
    return {
      action: "internal_shadow",
      reason: "unknown_trigger_fail_safe",
      may_send: false,
    };
  }
  if (
    t === "opt_out_violation" ||
    t === "wrong_number_violation" ||
    t === "incorrect_stage_jump"
  ) {
    return { action: "human_review", reason: t, may_send: false };
  }
  return { action: "internal_shadow", reason: t || "unspecified", may_send: false };
}

export default {
  ACQUISITION_BRAIN_MODE_KEY,
  ACQUISITION_BRAIN_MODES,
  DEFAULT_ACQUISITION_BRAIN_MODE,
  AUTHORITY_WRITERS,
  AUTHORITY_GATE_VERSION,
  ROLLBACK_TRIGGERS,
  resolveAcquisitionBrainMode,
  evaluateBrainAuthorityEligibility,
  resolveAuthorityWriter,
  buildBrainQueueIntent,
  resolveRollbackAction,
};
