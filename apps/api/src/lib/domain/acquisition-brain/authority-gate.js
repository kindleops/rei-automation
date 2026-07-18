// ─── acquisition-brain/authority-gate.js ───────────────────────────────────
// Fail-closed authority contract (default: internal_shadow).
// Never activates transport without explicit mode + full evidence + calibration.
// Once Brain is selected as writer, never falls back to legacy enqueue.

import { createHash } from "node:crypto";
import {
  STAGE_NUMBERS,
  normalizeLifecycleStage,
  ACQUISITION_LIFECYCLE_STAGES as S,
} from "./lifecycle-registry.js";

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
  BLOCKED: "blocked",
});

export const REASON_CLASS = Object.freeze({
  TERMINAL_NO_ACTION: "TERMINAL_NO_ACTION",
  HUMAN_REVIEW: "HUMAN_REVIEW",
  BLOCKED: "BLOCKED",
  LEGACY_ELIGIBLE: "LEGACY_ELIGIBLE",
  BRAIN_ELIGIBLE: "BRAIN_ELIGIBLE",
});

export const AUTHORITY_GATE_VERSION = "acquisition_brain_authority_gate_v2";
export const SHADOW_AUTHORITY_EVENT =
  "acquisition_brain_shadow_authority_decision";
export const CLASSIFIER_CALIBRATION_VERSION =
  "acquisition_brain_classifier_calibration_v0_none";

/** No intent is authority-eligible until PR I proves held-out precision. */
export const AUTHORITY_ELIGIBLE_INTENTS = Object.freeze([]);

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

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Strict E.164 validation. Caller booleans cannot override.
 * E.164: + then 8–15 digits total after + (country+subscriber), common practical bound.
 */
export function validateCanonicalE164(thread_key) {
  const raw = String(thread_key ?? "");
  const t = raw.trim();
  if (!t) {
    return {
      ok: false,
      canonical_e164_valid: false,
      reason: "missing_thread",
      normalized: null,
    };
  }
  if (t !== raw) {
    return {
      ok: false,
      canonical_e164_valid: false,
      reason: "leading_or_trailing_whitespace",
      normalized: null,
    };
  }
  if (/\s/.test(t)) {
    return {
      ok: false,
      canonical_e164_valid: false,
      reason: "spaces_not_allowed",
      normalized: null,
    };
  }
  if (!t.startsWith("+")) {
    return {
      ok: false,
      canonical_e164_valid: false,
      reason: "missing_plus_or_local_alias",
      normalized: null,
      archived_alias: !t.startsWith("+"),
    };
  }
  // Reject multiple plus or non-digit after +
  if (!/^\+[1-9]\d{7,14}$/.test(t)) {
    return {
      ok: false,
      canonical_e164_valid: false,
      reason: "malformed_e164",
      normalized: null,
    };
  }
  return {
    ok: true,
    canonical_e164_valid: true,
    reason: "valid_e164",
    normalized: t,
    archived_alias: false,
  };
}

function normalizeMode(raw) {
  const m = clean(raw).toLowerCase();
  if (Object.values(ACQUISITION_BRAIN_MODES).includes(m)) return m;
  return DEFAULT_ACQUISITION_BRAIN_MODE;
}

/**
 * Resolve one consistent canonical stage from stage string and/or number.
 * Disagreement → conflict.
 */
export function resolveCanonicalStageEvidence({
  lifecycle_stage = null,
  stage_number = null,
} = {}) {
  const from_label = normalizeLifecycleStage(lifecycle_stage, null);
  let from_num = null;
  if (stage_number != null && stage_number !== "") {
    const n = Number(stage_number);
    if (Number.isInteger(n) && n >= 1 && n <= 10) {
      from_num = n;
    } else {
      return {
        ok: false,
        reason: "unknown_stage_number",
        stage: null,
        stage_number: null,
        conflict: true,
      };
    }
  }

  if (from_label && from_num != null) {
    const expected = STAGE_NUMBERS[from_label];
    if (expected !== from_num) {
      return {
        ok: false,
        reason: "stage_conflict",
        stage: from_label,
        stage_number: from_num,
        expected_stage_number: expected,
        conflict: true,
      };
    }
    return {
      ok: true,
      stage: from_label,
      stage_number: from_num,
      conflict: false,
      reason: "consistent",
    };
  }

  if (from_label) {
    return {
      ok: true,
      stage: from_label,
      stage_number: STAGE_NUMBERS[from_label],
      conflict: false,
      reason: "from_label",
    };
  }

  if (from_num != null) {
    const stage = Object.keys(STAGE_NUMBERS).find(
      (k) => STAGE_NUMBERS[k] === from_num
    );
    if (!stage) {
      return {
        ok: false,
        reason: "unknown_stage_number",
        stage: null,
        stage_number: from_num,
        conflict: false,
      };
    }
    return {
      ok: true,
      stage,
      stage_number: from_num,
      conflict: false,
      reason: "from_number",
    };
  }

  return {
    ok: false,
    reason: "missing_stage",
    stage: null,
    stage_number: null,
    conflict: false,
  };
}

/**
 * Classifier calibration — all intents default ineligible until PR I.
 */
export function evaluateClassifierCalibration({
  primary_intent = null,
  language = null,
  classifier_version = null,
  calibration_version = null,
  calibration_registry = null,
} = {}) {
  const registry = calibration_registry || {
    version: CLASSIFIER_CALIBRATION_VERSION,
    authority_eligible_intents: AUTHORITY_ELIGIBLE_INTENTS,
    languages_approved: [],
  };

  const status = {
    classifier_calibration_status: "uncalibrated",
    intent_authority_eligible: false,
    classifier_version: classifier_version || "classify.js",
    calibration_version: calibration_version || registry.version,
    primary_intent: clean(primary_intent) || null,
    language: language || null,
    reasons: [],
  };

  if (
    status.calibration_version !== registry.version &&
    status.calibration_version !== CLASSIFIER_CALIBRATION_VERSION
  ) {
    status.classifier_calibration_status = "stale";
    status.reasons.push("stale_calibration_version");
  }

  const lang = clean(language).toLowerCase();
  if (
    lang &&
    lang !== "english" &&
    lang !== "en" &&
    !(registry.languages_approved || []).includes(lang) &&
    !(registry.languages_approved || []).includes("es")
  ) {
    // Spanish / other without approved calibration
    if (lang.startsWith("es") || lang === "spanish") {
      status.reasons.push("spanish_calibration_missing");
    } else {
      status.reasons.push("language_calibration_missing");
    }
  }

  const intent = clean(primary_intent);
  const allow = registry.authority_eligible_intents || [];
  if (!intent || !allow.includes(intent)) {
    status.intent_authority_eligible = false;
    status.reasons.push("intent_not_authority_eligible");
    if (status.classifier_calibration_status === "uncalibrated") {
      status.reasons.push("missing_calibration");
    }
  } else {
    status.intent_authority_eligible = true;
    status.classifier_calibration_status = "calibrated";
  }

  // v0: always treat as uncalibrated for authority
  if (registry.version === CLASSIFIER_CALIBRATION_VERSION) {
    status.intent_authority_eligible = false;
    status.classifier_calibration_status = "uncalibrated";
    if (!status.reasons.includes("missing_calibration")) {
      status.reasons.push("missing_calibration");
    }
  }

  return status;
}

function validateTemplateEvidence(tpl) {
  if (!tpl || typeof tpl !== "object") {
    return { ok: false, reasons: ["template_evidence_missing"] };
  }
  const reasons = [];
  if (!clean(tpl.template_id)) reasons.push("template_id_missing");
  if (!clean(tpl.template_version)) reasons.push("template_version_missing");
  if (!clean(tpl.use_case)) reasons.push("template_use_case_missing");
  if (tpl.active !== true) reasons.push("template_inactive");
  if (tpl.placeholder_validation !== true) reasons.push("placeholders_unvalidated");
  if (tpl.prohibited_term_validation !== true) {
    reasons.push("prohibited_terms_unvalidated");
  }
  return { ok: reasons.length === 0, reasons, evidence: tpl };
}

function validateSuppressionEvidence(sup) {
  if (!sup || typeof sup !== "object") {
    return { ok: false, reasons: ["suppression_evidence_missing"] };
  }
  const reasons = [];
  if (sup.clear !== true) reasons.push("suppression_active");
  if (sup.error_state) reasons.push("suppression_lookup_error");
  return { ok: reasons.length === 0, reasons, evidence: sup };
}

function validateContactWindowEvidence(cw) {
  if (!cw || typeof cw !== "object") {
    return { ok: false, reasons: ["contact_window_evidence_missing"] };
  }
  const reasons = [];
  if (!clean(cw.timezone)) reasons.push("timezone_missing");
  if (!clean(cw.final_planned_send_at) && cw.allowed !== true && cw.deferred !== true) {
    reasons.push("contact_window_invalid");
  }
  if (cw.allowed !== true && cw.deferred !== true) {
    reasons.push("contact_window_invalid");
  }
  return { ok: reasons.length === 0, reasons, evidence: cw };
}

function validateBurstEvidence(burst) {
  if (!burst || typeof burst !== "object") {
    return { ok: false, reasons: ["burst_evidence_missing"] };
  }
  const reasons = [];
  if (!clean(burst.burst_id)) reasons.push("burst_id_missing");
  if (burst.status !== "final_shadow" && burst.plan_status !== "final_shadow") {
    reasons.push("burst_not_final");
  }
  if (burst.provisional === true || burst.status === "collecting") {
    reasons.push("provisional_burst_blocked");
  }
  if (burst.superseded === true) reasons.push("stale_burst_blocked");
  return { ok: reasons.length === 0, reasons, evidence: burst };
}

function validateNbaEvidence(nba) {
  if (!nba || typeof nba !== "object") {
    return { ok: false, reasons: ["nba_evidence_missing"] };
  }
  const reasons = [];
  if (!clean(nba.action)) reasons.push("missing_canonical_nba");
  return { ok: reasons.length === 0, reasons, evidence: nba };
}

function validateHealthEvidence(health) {
  if (!health || typeof health !== "object") {
    return {
      ok: false,
      reasons: ["health_evidence_missing"],
    };
  }
  const reasons = [];
  if (health.emergency_stop === true) reasons.push("emergency_stop");
  if (health.queue_healthy === false) reasons.push("queue_unhealthy");
  if (health.provider_healthy === false) reasons.push("provider_unhealthy");
  if (health.observability_healthy === false) reasons.push("observability_unhealthy");
  if (health.stale === true) reasons.push("stale_health_evidence");
  const max_age_ms = health.max_age_ms ?? 15 * 60_000;
  if (health.checked_at) {
    const age = Date.parse(health.as_of || Date.now()) - Date.parse(health.checked_at);
    if (Number.isFinite(age) && age > max_age_ms) {
      reasons.push("stale_health_evidence");
    }
  } else {
    reasons.push("health_checked_at_missing");
  }
  return { ok: reasons.length === 0, reasons, evidence: health };
}

export async function resolveAcquisitionBrainMode({
  explicit_mode = null,
  getSystemValue = null,
} = {}) {
  if (explicit_mode != null) {
    return { mode: normalizeMode(explicit_mode), source: "explicit" };
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
  return { mode: DEFAULT_ACQUISITION_BRAIN_MODE, source: "default" };
}

/**
 * Full eligibility evaluation with structured evidence.
 */
export function evaluateBrainAuthorityEligibility(input = {}) {
  const mode_n = normalizeMode(input.mode);
  const reasons = [];
  const reason_classes = [];

  // Identity — never trust caller e164_identity alone
  const e164 = validateCanonicalE164(input.thread_key);
  if (!e164.ok) {
    reasons.push(e164.reason || "non_e164_identity");
    if (e164.archived_alias) reasons.push("archived_alias");
  }
  if (input.canonical_thread_resolution_status !== "resolved") {
    reasons.push("canonical_resolution_not_resolved");
  }
  if (input.archived_alias === true) reasons.push("archived_alias");
  if (
    input.resolved_inbound_identity &&
    e164.normalized &&
    clean(input.resolved_inbound_identity) !== e164.normalized
  ) {
    reasons.push("canonical_identity_mismatch");
  }

  // Stage consistency
  const stage_ev = resolveCanonicalStageEvidence({
    lifecycle_stage: input.lifecycle_stage,
    stage_number: input.stage_number,
  });
  if (!stage_ev.ok) {
    reasons.push(stage_ev.reason || "stage_invalid");
    if (stage_ev.conflict) reasons.push("stage_conflict");
  } else if (stage_ev.stage_number > 3) {
    reasons.push("stage_not_1_3");
  }

  // Mode
  if (mode_n !== ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE) {
    reasons.push("mode_not_internal_authoritative");
  }
  if (!input.is_internal_canary) reasons.push("not_internal_canary");
  if (input.is_public_seller !== false) reasons.push("public_seller");

  // Calibration — default all intents ineligible
  const calib = evaluateClassifierCalibration({
    primary_intent: input.primary_intent,
    language: input.language,
    classifier_version: input.classifier_version,
    calibration_version: input.calibration_version,
    calibration_registry: input.calibration_registry,
  });
  if (!calib.intent_authority_eligible) {
    reasons.push(...calib.reasons);
  }

  // Structured evidence
  const tpl = validateTemplateEvidence(input.template_evidence);
  if (!tpl.ok) reasons.push(...tpl.reasons);
  const sup = validateSuppressionEvidence(input.suppression_evidence);
  if (!sup.ok) reasons.push(...sup.reasons);
  const cw = validateContactWindowEvidence(input.contact_window_evidence);
  if (!cw.ok) reasons.push(...cw.reasons);
  const burst = validateBurstEvidence(input.burst_evidence);
  if (!burst.ok) reasons.push(...burst.reasons);
  const nba = validateNbaEvidence(input.nba_evidence);
  if (!nba.ok) reasons.push(...nba.reasons);
  const health = validateHealthEvidence(
    input.health_evidence || {
      emergency_stop: input.emergency_stop === true,
      queue_healthy: input.queue_healthy !== false,
      provider_healthy: input.provider_healthy !== false,
      observability_healthy: input.observability_healthy !== false,
      checked_at: input.health_checked_at || null,
      as_of: input.as_of,
      stale: input.health_stale === true,
    }
  );
  if (!health.ok) reasons.push(...health.reasons);

  if (input.material_conflict) reasons.push("material_conflict");
  if (input.human_review_required) reasons.push("human_review_required");
  if (input.existing_active_queue_intent) reasons.push("active_queue_intent_exists");
  if (input.opt_out) reasons.push("opt_out");
  if (input.wrong_number) reasons.push("wrong_number");
  if (input.never_owned) reasons.push("never_owned");
  if (input.sold_property) reasons.push("sold_property");
  if (input.ownership_denied) reasons.push("ownership_denied");
  if (input.brain_plan_ok === false) reasons.push("brain_plan_unavailable");

  const unique_reasons = [...new Set(reasons)];

  // Classify reasons
  const terminal_set = new Set([
    "opt_out",
    "wrong_number",
    "never_owned",
    "sold_property",
    "ownership_denied",
  ]);
  const blocked_set = new Set([
    "suppression_active",
    "emergency_stop",
    "queue_unhealthy",
    "provider_unhealthy",
    "active_queue_intent_exists",
    "contact_window_invalid",
    "provisional_burst_blocked",
    "stale_burst_blocked",
    "burst_not_final",
    "missing_canonical_nba",
    "stage_not_1_3",
    "public_seller",
    "not_internal_canary",
    "mode_not_internal_authoritative",
  ]);
  const human_set = new Set([
    "material_conflict",
    "human_review_required",
    "missing_calibration",
    "stale_calibration_version",
    "intent_not_authority_eligible",
    "spanish_calibration_missing",
    "language_calibration_missing",
    "stage_conflict",
    "canonical_identity_mismatch",
    "brain_plan_unavailable",
    "template_unavailable",
    "template_id_missing",
    "template_inactive",
    "observability_unhealthy",
    "stale_health_evidence",
  ]);

  for (const r of unique_reasons) {
    if (terminal_set.has(r)) reason_classes.push(REASON_CLASS.TERMINAL_NO_ACTION);
    else if (blocked_set.has(r)) reason_classes.push(REASON_CLASS.BLOCKED);
    else if (human_set.has(r)) reason_classes.push(REASON_CLASS.HUMAN_REVIEW);
  }

  const eligible = unique_reasons.length === 0;
  if (eligible) reason_classes.push(REASON_CLASS.BRAIN_ELIGIBLE);

  return {
    eligible,
    mode: mode_n,
    reasons: unique_reasons,
    reason_classes: [...new Set(reason_classes)],
    e164,
    stage: stage_ev,
    calibration: calib,
    template: tpl,
    suppression: sup,
    contact_window: cw,
    burst,
    nba,
    health,
    gate_version: AUTHORITY_GATE_VERSION,
  };
}

/**
 * Single-writer resolution. Fail-closed under internal_authoritative.
 */
export function resolveAuthorityWriter({
  mode = DEFAULT_ACQUISITION_BRAIN_MODE,
  eligibility = null,
  opt_out = false,
  wrong_number = false,
  never_owned = false,
  sold_property = false,
  ownership_denied = false,
  brain_plan_ok = false,
  brain_failure = false,
  brain_selected_for_inbound = false,
} = {}) {
  const mode_n = normalizeMode(mode);

  // Terminal
  if (opt_out || wrong_number || never_owned || sold_property || ownership_denied) {
    return {
      writer: AUTHORITY_WRITERS.NO_ACTION,
      reason_class: REASON_CLASS.TERMINAL_NO_ACTION,
      reason: opt_out
        ? "opt_out"
        : wrong_number
          ? "wrong_number"
          : never_owned
            ? "never_owned"
            : sold_property
              ? "sold_property"
              : "ownership_denied",
      legacy_may_enqueue: false,
      brain_may_enqueue: false,
      may_suppress_legacy: false,
    };
  }

  // Shadow: legacy remains authoritative
  if (mode_n === ACQUISITION_BRAIN_MODES.INTERNAL_SHADOW) {
    return {
      writer: AUTHORITY_WRITERS.LEGACY,
      reason_class: REASON_CLASS.LEGACY_ELIGIBLE,
      reason: "internal_shadow",
      legacy_may_enqueue: true,
      brain_may_enqueue: false,
      brain_shadow_observe: true,
      may_suppress_legacy: false,
    };
  }

  // Once Brain path is selected for this inbound, never legacy-fallback
  const brain_path =
    mode_n === ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE ||
    brain_selected_for_inbound;

  if (brain_path) {
    if (eligibility?.eligible && brain_plan_ok && !brain_failure) {
      return {
        writer: AUTHORITY_WRITERS.ACQUISITION_BRAIN,
        reason_class: REASON_CLASS.BRAIN_ELIGIBLE,
        reason: "internal_authoritative_eligible",
        legacy_may_enqueue: false,
        brain_may_enqueue: true,
        max_queue_intents: 1,
        may_suppress_legacy: true,
        authority_selected: true,
      };
    }

    const reasons = eligibility?.reasons || [];
    const terminal = reasons.some((r) =>
      ["opt_out", "wrong_number", "never_owned", "sold_property", "ownership_denied"].includes(r)
    );
    if (terminal) {
      return {
        writer: AUTHORITY_WRITERS.NO_ACTION,
        reason_class: REASON_CLASS.TERMINAL_NO_ACTION,
        reason: reasons[0] || "terminal",
        legacy_may_enqueue: false,
        brain_may_enqueue: false,
        may_suppress_legacy: false,
        authority_selected: true,
      };
    }

    const blocked = (eligibility?.reason_classes || []).includes(REASON_CLASS.BLOCKED);
    if (blocked || brain_failure) {
      return {
        writer: blocked ? AUTHORITY_WRITERS.BLOCKED : AUTHORITY_WRITERS.HUMAN_REVIEW,
        reason_class: blocked ? REASON_CLASS.BLOCKED : REASON_CLASS.HUMAN_REVIEW,
        reason: brain_failure
          ? "brain_failure_no_legacy_fallback"
          : reasons[0] || "blocked_no_legacy_fallback",
        legacy_may_enqueue: false,
        brain_may_enqueue: false,
        may_suppress_legacy: false,
        authority_selected: true,
      };
    }

    return {
      writer: AUTHORITY_WRITERS.HUMAN_REVIEW,
      reason_class: REASON_CLASS.HUMAN_REVIEW,
      reason: reasons[0] || "eligibility_failed_no_legacy_fallback",
      legacy_may_enqueue: false,
      brain_may_enqueue: false,
      may_suppress_legacy: false,
      authority_selected: true,
    };
  }

  return {
    writer: AUTHORITY_WRITERS.LEGACY,
    reason_class: REASON_CLASS.LEGACY_ELIGIBLE,
    reason: "outside_brain_authority_scope",
    legacy_may_enqueue: true,
    brain_may_enqueue: false,
    may_suppress_legacy: false,
  };
}

/**
 * Fail-closed queue intent builder.
 */
export function buildBrainQueueIntent(input = {}) {
  const decision = input.authority_decision;
  if (!decision || decision.writer !== AUTHORITY_WRITERS.ACQUISITION_BRAIN) {
    return {
      ok: false,
      reason: "authority_not_acquisition_brain",
      queue_intent: null,
    };
  }
  if (normalizeMode(decision.mode || input.control_plane_mode) !==
    ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE) {
    return {
      ok: false,
      reason: "mode_not_internal_authoritative",
      queue_intent: null,
    };
  }
  if (!decision.authority_decision_id && !input.authority_decision_id) {
    return {
      ok: false,
      reason: "missing_authority_decision_id",
      queue_intent: null,
    };
  }

  const e164 = validateCanonicalE164(input.thread_key);
  if (!e164.ok) {
    return { ok: false, reason: e164.reason, queue_intent: null };
  }
  if (!input.is_internal_canary) {
    return { ok: false, reason: "not_internal_canary", queue_intent: null };
  }
  if (!Array.isArray(input.inbound_event_ids) || !input.inbound_event_ids.length) {
    return { ok: false, reason: "missing_inbound_event_ids", queue_intent: null };
  }
  if (!clean(input.burst_id) || !clean(input.burst_content_hash)) {
    return { ok: false, reason: "missing_burst_identity", queue_intent: null };
  }
  if (!clean(input.nba) || !clean(input.lifecycle_stage)) {
    return { ok: false, reason: "missing_nba_or_stage", queue_intent: null };
  }
  if (!clean(input.template_id) || !clean(input.template_version)) {
    return { ok: false, reason: "missing_template", queue_intent: null };
  }
  if (!clean(input.planned_send_at)) {
    return { ok: false, reason: "missing_planned_send_at", queue_intent: null };
  }

  const ordered_ids = [...input.inbound_event_ids].map(clean).filter(Boolean).sort();
  const authority_decision_id =
    clean(input.authority_decision_id || decision.authority_decision_id);

  const hash_payload = [
    e164.normalized,
    ordered_ids.join(","),
    clean(input.burst_id),
    clean(input.burst_content_hash),
    clean(input.burst_version || ""),
    clean(input.nba),
    clean(input.template_id),
    clean(input.template_version),
    clean(input.planned_send_at),
    authority_decision_id,
    ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    AUTHORITY_GATE_VERSION,
  ].join("|");

  const idempotency_key = createHash("sha256")
    .update(hash_payload, "utf8")
    .digest("hex")
    .slice(0, 48);

  const queue_intent = {
    idempotency_key,
    authority_decision_id,
    canonical_e164_thread: e164.normalized,
    source_inbound_event_ids: ordered_ids,
    source_burst_id: clean(input.burst_id),
    source_burst_content_hash: clean(input.burst_content_hash),
    source_burst_version: clean(input.burst_version) || null,
    lifecycle_stage: clean(input.lifecycle_stage),
    nba: clean(input.nba),
    template_id: clean(input.template_id),
    template_version: clean(input.template_version),
    template_use_case: clean(input.template_use_case) || null,
    timing_policy: clean(input.timing_policy) || null,
    planned_send_at: clean(input.planned_send_at),
    timezone: clean(input.timezone) || null,
    timezone_source: clean(input.timezone_source) || null,
    suppression_decision: input.suppression_decision || null,
    classifier_version: input.classifier_version || null,
    calibration_version: input.calibration_version || CLASSIFIER_CALIBRATION_VERSION,
    control_plane_mode: ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
    internal_canary_marker: true,
    component_versions: {
      authority_gate: AUTHORITY_GATE_VERSION,
      ...(input.component_versions || {}),
    },
    observability_trace_id: clean(input.observability_trace_id) || null,
    may_call_provider_directly: false,
    transport: "compliant_queue_processor_only",
  };

  return { ok: true, queue_intent, reason: null };
}

export function computeQueueIntentPreviewHash(input = {}) {
  const built = buildBrainQueueIntent(input);
  if (!built.ok) return null;
  return built.queue_intent.idempotency_key;
}

/**
 * Rollback recommendation — does not mutate production mode.
 */
export function resolveRollbackAction({
  trigger = null,
  current_mode = DEFAULT_ACQUISITION_BRAIN_MODE,
  scope = "thread",
  thread_key = null,
  source_event = null,
  as_of = null,
} = {}) {
  const t = clean(trigger);
  let recommended = ACQUISITION_BRAIN_MODES.INTERNAL_SHADOW;
  if (
    t === "opt_out_violation" ||
    t === "wrong_number_violation" ||
    t === "incorrect_stage_jump"
  ) {
    recommended = "human_review";
  }
  return {
    detected_trigger: t || "unspecified",
    current_mode: normalizeMode(current_mode),
    recommended_mode: recommended,
    transport_blocked_immediately: true,
    scope,
    thread_key: thread_key || null,
    reason: t || "unspecified",
    source_event: source_event || null,
    timestamp: as_of || "1970-01-01T00:00:00.000Z",
    operator_acknowledgement_required: true,
    rollback_event_type: "acquisition_brain_authority_rollback_recommended",
    may_send: false,
    production_mode_mutated: false,
  };
}

/**
 * Pure evaluate + shadow event payload (no enqueue).
 */
export function evaluateShadowAuthorityDecision(input = {}) {
  const t0 = input.processing_started_ms != null ? input.processing_started_ms : 0;
  const mode_n = normalizeMode(input.mode);
  const eligibility = evaluateBrainAuthorityEligibility(input);
  const writer = resolveAuthorityWriter({
    mode: mode_n,
    eligibility,
    opt_out: input.opt_out,
    wrong_number: input.wrong_number,
    never_owned: input.never_owned,
    sold_property: input.sold_property,
    ownership_denied: input.ownership_denied,
    brain_plan_ok: input.brain_plan_ok !== false,
    brain_failure: input.brain_failure === true,
    brain_selected_for_inbound:
      mode_n === ACQUISITION_BRAIN_MODES.INTERNAL_AUTHORITATIVE,
  });

  const authority_decision_id = createHash("sha256")
    .update(
      [
        clean(input.thread_key),
        (input.inbound_event_ids || []).join(","),
        mode_n,
        writer.writer,
        (eligibility.reasons || []).join(","),
        AUTHORITY_GATE_VERSION,
      ].join("|"),
      "utf8"
    )
    .digest("hex")
    .slice(0, 24);

  const decision = {
    authority_decision_id,
    thread_key: eligibility.e164?.normalized || clean(input.thread_key),
    inbound_event_ids: input.inbound_event_ids || [],
    current_mode: mode_n,
    proposed_writer: writer.writer,
    writer_reason: writer.reason,
    reason_class: writer.reason_class,
    eligibility: {
      eligible: eligibility.eligible,
      reasons: eligibility.reasons,
      reason_classes: eligibility.reason_classes,
    },
    classifier_calibration: eligibility.calibration,
    stage_evidence: eligibility.stage,
    template_evidence: eligibility.template,
    suppression_evidence: eligibility.suppression,
    contact_window_evidence: eligibility.contact_window,
    burst_evidence: eligibility.burst,
    nba_evidence: eligibility.nba,
    health_evidence: eligibility.health,
    e164: eligibility.e164,
    queue_intent_preview_hash: null,
    may_enqueue: false,
    may_send: false,
    may_suppress_legacy: false, // shadow: never suppress legacy in this PR
    legacy_remains_authoritative: true,
    component_versions: {
      authority_gate: AUTHORITY_GATE_VERSION,
      calibration: CLASSIFIER_CALIBRATION_VERSION,
    },
    processing_duration_ms:
      input.processing_started_ms != null
        ? Math.max(0, Date.now() - input.processing_started_ms)
        : 0,
  };

  // Preview hash only if would be eligible (normally never under v0 calibration)
  if (writer.writer === AUTHORITY_WRITERS.ACQUISITION_BRAIN) {
    const preview = buildBrainQueueIntent({
      ...input,
      authority_decision: {
        writer: AUTHORITY_WRITERS.ACQUISITION_BRAIN,
        mode: mode_n,
        authority_decision_id,
      },
      authority_decision_id,
      is_internal_canary: true,
    });
    decision.queue_intent_preview_hash = preview.ok
      ? preview.queue_intent.idempotency_key
      : null;
  }

  if (t0 === 0) decision.processing_duration_ms = 0;

  const dedupe_key = `acquisition_brain_shadow_authority:${authority_decision_id}:${AUTHORITY_GATE_VERSION}`;

  return {
    ok: true,
    decision,
    may_enqueue: false,
    may_send: false,
    may_suppress_legacy: false,
    event: {
      event_type: SHADOW_AUTHORITY_EVENT,
      dedupe_key,
      conversation_thread_id: decision.thread_key,
      payload: decision,
    },
  };
}

export async function emitShadowAuthorityDecision(result, deps = {}) {
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

export default {
  ACQUISITION_BRAIN_MODE_KEY,
  ACQUISITION_BRAIN_MODES,
  DEFAULT_ACQUISITION_BRAIN_MODE,
  AUTHORITY_WRITERS,
  REASON_CLASS,
  AUTHORITY_GATE_VERSION,
  SHADOW_AUTHORITY_EVENT,
  CLASSIFIER_CALIBRATION_VERSION,
  AUTHORITY_ELIGIBLE_INTENTS,
  ROLLBACK_TRIGGERS,
  validateCanonicalE164,
  resolveCanonicalStageEvidence,
  evaluateClassifierCalibration,
  resolveAcquisitionBrainMode,
  evaluateBrainAuthorityEligibility,
  resolveAuthorityWriter,
  buildBrainQueueIntent,
  computeQueueIntentPreviewHash,
  resolveRollbackAction,
  evaluateShadowAuthorityDecision,
  emitShadowAuthorityDecision,
};
