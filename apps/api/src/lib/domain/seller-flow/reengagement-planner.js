// ─── reengagement-planner.js ─────────────────────────────────────────────────
// G3: deterministic re-enrollment after a dispatched follow-up got no inbound
// within its policy window. PURE decision layer — no I/O, no clock reads, no
// queue writes. The gap-recovery sweeper (#8 in recover-seller-execution-gaps)
// gathers the evidence, this module decides, and the EXISTING canonical writer
// (seller-followup-scheduler.scheduleFollowUp → enqueueSendQueueItem) persists.
//
// Authority model (unchanged, this module adds none):
//   • followup_automation_mode remains the sole scheduling authority — when it
//     denies, the planner is inert (candidate evaluation still runs first so
//     dry_run telemetry shows exactly what live mode would have done, the same
//     ordering delivery-triggered-followup.js uses).
//   • queue_execution_mode still gates dispatch downstream; a scheduled row is
//     never a send.
//   • Every stop condition is checked BEFORE scheduling and fails closed with
//     an explicit reason string, so proof runs can assert exactly why a thread
//     was or was not re-enrolled.

import {
  BLOCKING_CONTACTABILITY,
  lifecycleStageNumber,
  normalizeContactability,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import {
  REENGAGEMENT_POLICY,
  REENGAGEMENT_POLICY_VERSION,
  resolveFollowUpPolicyForStage,
  resolveReengagementWave,
} from "@/lib/domain/seller-flow/followup-policy-registry.js";
import {
  ACTIVE_INTENTS,
  NURTURE_DAYS,
  STAGE_NO_REPLY_FOLLOWUP_INTENT,
  SUPPRESSED_INTENTS,
  UNAPPROVED_FOLLOWUP_INTENTS,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";

export const REENGAGEMENT_PLANNER_VERSION = "reengagement_planner_v1";

/** Modes that may create send_queue rows (mirrors delivery-triggered-followup). */
const SCHEDULING_MODES = new Set([
  "internal_only",
  "canary_market",
  "canary_sender",
  "canary_stage",
  "live_limited",
  "full_live",
]);

/**
 * Thread dispositions that terminate automated outreach. not_interested is
 * deliberately NOT here: it is a temporary rejection with an approved nurture
 * cadence (see the intent ontology's semantic contract).
 */
const TERMINAL_DISPOSITIONS = new Set([
  "wrong_person",
  "wrong_number",
  "sold",
  "duplicate",
  "unqualified",
]);

// Registry blocking codes plus the legacy literal some historical rows carry.
const BLOCKED_CONTACTABILITY = new Set([...BLOCKING_CONTACTABILITY, "wrong_number"]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asMs(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function deny(reason, extra = {}) {
  return {
    eligible: false,
    would_schedule: false,
    reason,
    planner_version: REENGAGEMENT_PLANNER_VERSION,
    policy_version: REENGAGEMENT_POLICY_VERSION,
    ...extra,
  };
}

/**
 * Decide whether a thread is re-enrolled for its next follow-up attempt.
 *
 * @param {object} args
 * @param {string|number} args.now                       evaluation instant (ISO or ms)
 * @param {{mode: string, source?: string}} args.mode    resolved followup_automation_mode
 * @param {boolean} args.is_internal_phone               thread phone is a registered internal test phone
 * @param {object} args.thread   inbox_thread_state guards:
 *   { is_suppressed, contactability_status, lifecycle_stage, disposition, last_inbound_at, is_archived }
 * @param {object} args.last_followup   the thread's latest dispatched follow-up row:
 *   { intent, sent_at, followup_use_case, queue_row_id }
 * @param {number} args.prior_automated_followups  non-cancelled automated follow-up rows (lifetime)
 * @param {boolean} args.pending_followup_exists   any unsent/non-terminal queue row on the thread
 * @param {boolean} args.terms_accepted            negotiation_state.terms_accepted
 */
export function resolveReengagementDecision({
  now = null,
  mode = null,
  is_internal_phone = false,
  thread = {},
  last_followup = {},
  prior_automated_followups = 0,
  pending_followup_exists = false,
  terms_accepted = false,
} = {}) {
  const now_ms = typeof now === "number" ? now : asMs(now);
  if (!Number.isFinite(now_ms)) return deny("invalid_now");

  const resolved_mode = lower(mode?.mode ?? mode);

  // ── Candidate evaluation (stop conditions, fail-closed) ──────────────────
  const candidate = evaluateCandidate({
    now_ms,
    thread,
    last_followup,
    prior_automated_followups,
    pending_followup_exists,
    terms_accepted,
  });

  // ── Activation gate (mode is the sole scheduling authority) ──────────────
  if (!resolved_mode || resolved_mode === "disabled") {
    return deny("followup_automation_disabled", {
      mode: resolved_mode || "disabled",
      would_schedule: candidate.eligible,
      candidate_reason: candidate.reason,
    });
  }
  if (resolved_mode === "dry_run") {
    return deny("reengagement_dry_run", {
      mode: resolved_mode,
      would_schedule: candidate.eligible,
      candidate_reason: candidate.reason,
      ...(candidate.eligible ? pickPlanFields(candidate) : {}),
    });
  }
  if (!SCHEDULING_MODES.has(resolved_mode)) {
    return deny("followup_automation_disabled", {
      mode: resolved_mode,
      would_schedule: candidate.eligible,
      candidate_reason: candidate.reason,
    });
  }
  if (resolved_mode === "internal_only" && !is_internal_phone) {
    return deny("reengagement_internal_only_blocked", {
      mode: resolved_mode,
      would_schedule: candidate.eligible,
      candidate_reason: candidate.reason,
    });
  }

  if (!candidate.eligible) {
    return deny(candidate.reason, { mode: resolved_mode, ...candidate.extra });
  }

  return {
    eligible: true,
    would_schedule: true,
    mode: resolved_mode,
    planner_version: REENGAGEMENT_PLANNER_VERSION,
    policy_version: REENGAGEMENT_POLICY_VERSION,
    ...pickPlanFields(candidate),
  };
}

function pickPlanFields(candidate) {
  return {
    reason: candidate.reason,
    intent: candidate.intent,
    wave: candidate.wave,
    attempt: candidate.attempt,
    window_days: candidate.window_days,
    scheduled_for: candidate.scheduled_for,
    stage: candidate.stage,
    followup_use_case: candidate.followup_use_case,
  };
}

function evaluateCandidate({
  now_ms,
  thread,
  last_followup,
  prior_automated_followups,
  pending_followup_exists,
  terms_accepted,
}) {
  // 1. The trigger must be a genuinely dispatched follow-up.
  const sent_ms = asMs(last_followup?.sent_at);
  if (!sent_ms) return { eligible: false, reason: "last_followup_not_dispatched" };

  const intent = lower(last_followup?.intent) || "unclear";

  // 2. Hard suppression / contactability / archive — always outrank re-enrollment.
  if (thread?.is_suppressed === true) return { eligible: false, reason: "thread_suppressed" };
  if (thread?.is_archived === true) return { eligible: false, reason: "thread_archived" };
  const contactability_raw = lower(thread?.contactability_status);
  if (
    BLOCKED_CONTACTABILITY.has(contactability_raw) ||
    (contactability_raw && BLOCKING_CONTACTABILITY.has(normalizeContactability(contactability_raw)))
  ) {
    return { eligible: false, reason: `contact_blocked:${contactability_raw}` };
  }

  // 3. Terminal disposition on the thread (wrong number/person, sold, …).
  const disposition = lower(thread?.disposition);
  if (TERMINAL_DISPOSITIONS.has(disposition)) {
    return { eligible: false, reason: `terminal_disposition:${disposition}` };
  }

  // 4. Intent-layer suppression: a follow-up lane that is itself suppressed,
  //    unapproved, or an active workflow never re-enrolls.
  if (SUPPRESSED_INTENTS.has(intent)) {
    return { eligible: false, reason: `permanent_suppression:${intent}` };
  }
  if (UNAPPROVED_FOLLOWUP_INTENTS.has(intent)) {
    return { eligible: false, reason: "follow_up_policy_not_approved" };
  }
  if (ACTIVE_INTENTS.has(intent)) {
    return { eligible: false, reason: "active_workflow_no_nurture" };
  }

  // 5. Stage ceiling: never at/past S6, never closed. Contract and operational
  //    stages progress through events, not nudge texts.
  const stage_number = lifecycleStageNumber(thread?.lifecycle_stage) || 1;
  if (stage_number > REENGAGEMENT_POLICY.max_lifecycle_stage_number) {
    return { eligible: false, reason: `stage_beyond_automation:${clean(thread?.lifecycle_stage)}` };
  }

  // 6. Accepted terms: the thread has a deal in motion — humans own it.
  if (terms_accepted === true) return { eligible: false, reason: "negotiation_terms_accepted" };

  // 7. The seller replied after the follow-up: not a no-response thread.
  const last_inbound_ms = asMs(thread?.last_inbound_at);
  if (last_inbound_ms && last_inbound_ms > sent_ms) {
    return { eligible: false, reason: "seller_replied_after_followup" };
  }

  // 8. A pending/scheduled queue row already covers this thread.
  if (pending_followup_exists === true) {
    return { eligible: false, reason: "duplicate_pending_followup" };
  }

  // 9. Attempt caps + wave resolution from the policy registry.
  const wave = resolveReengagementWave({
    stage: thread?.lifecycle_stage,
    prior_automated_followups,
  });
  if (!wave.eligible) return { eligible: false, reason: wave.reason };

  // 10. Window authority: stage lane re-uses the stage no-reply delay, nurture
  //     lanes their intent cadence, long-cycle waves the registry wave cadence.
  const { stage } = resolveFollowUpPolicyForStage(thread?.lifecycle_stage);
  let window_days;
  if (wave.wave === "nurture") {
    window_days = REENGAGEMENT_POLICY.nurture_wave_days;
  } else if (intent === STAGE_NO_REPLY_FOLLOWUP_INTENT) {
    window_days = wave.window_days;
  } else {
    window_days = NURTURE_DAYS[intent] ?? null;
  }
  if (!Number.isFinite(Number(window_days)) || Number(window_days) <= 0) {
    return { eligible: false, reason: `reengagement_window_missing:${intent}` };
  }

  // 11. Stage lane needs the outbound's real use case for send-time template
  //     resolution — without it the deferred resolver would fail the row.
  const followup_use_case =
    intent === STAGE_NO_REPLY_FOLLOWUP_INTENT ? clean(last_followup?.followup_use_case) : null;
  if (intent === STAGE_NO_REPLY_FOLLOWUP_INTENT && !followup_use_case) {
    return { eligible: false, reason: "stage_followup_use_case_missing" };
  }

  // 12. The no-response window must have elapsed.
  const eligible_at_ms = sent_ms + Number(window_days) * DAY_MS;
  if (now_ms < eligible_at_ms) {
    return {
      eligible: false,
      reason: "reengagement_window_not_elapsed",
      extra: { next_eligible_at: new Date(eligible_at_ms).toISOString() },
    };
  }

  return {
    eligible: true,
    reason:
      wave.wave === "nurture"
        ? `reengagement_nurture_wave_attempt_${wave.attempt}`
        : `followup_no_response_attempt_${wave.attempt}`,
    intent,
    wave: wave.wave,
    attempt: wave.attempt,
    window_days: Number(window_days),
    // The window already elapsed, so the next attempt is due now; contact-time
    // rules (windows, pacing) are enforced downstream at dispatch, as for every
    // other queue row.
    scheduled_for: new Date(now_ms).toISOString(),
    stage,
    followup_use_case,
  };
}

export default resolveReengagementDecision;
