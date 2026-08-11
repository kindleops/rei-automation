// ─── followup-policy-registry.js ─────────────────────────────────────────────
// ONE configurable follow-up policy registry keyed by canonical lifecycle
// stage (activation spec Mission 8) — no scattered timers. Two distinct
// layers cooperate:
//
//   • Intent layer (seller-followup-scheduler.js NURTURE_DAYS): how long to
//     wait after a disengaging reply. Unchanged.
//   • Stage layer (this registry): whether the thread's CURRENT lifecycle
//     stage permits automated no-reply follow-ups at all, how many total
//     automated follow-up touches the stage tolerates, and the default
//     no-reply delay for delivery-confirmed scheduling.
//
// Retries (technical delivery failures) are a different system (queue
// retry/reconcile crons) and are intentionally not represented here.

import {
  LIFECYCLE_STAGE_CODES,
  normalizeLifecycleStage,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";

export const FOLLOWUP_POLICY_REGISTRY_VERSION = "followup_policy_registry_v1";

const C = LIFECYCLE_STAGE_CODES;

/**
 * Stage follow-up policies. `max_automated_followups` counts non-cancelled
 * automated follow-up rows ever created for the thread — a hard ceiling so a
 * conversation can never be drip-nudged forever. `no_reply_delay_days` is the
 * default wait after a provider-confirmed delivered outbound with no reply.
 */
export const FOLLOWUP_POLICY_BY_STAGE = Object.freeze({
  [C.OWNERSHIP_CONFIRMATION]: Object.freeze({
    enabled: true,
    no_reply_delay_days: 3,
    max_automated_followups: 3,
    requires_delivery_confirmation: true,
  }),
  [C.OFFER_INTEREST]: Object.freeze({
    enabled: true,
    no_reply_delay_days: 3,
    max_automated_followups: 3,
    requires_delivery_confirmation: true,
  }),
  [C.ASKING_PRICE]: Object.freeze({
    enabled: true,
    no_reply_delay_days: 4,
    max_automated_followups: 3,
    requires_delivery_confirmation: true,
  }),
  [C.PROPERTY_CONDITION]: Object.freeze({
    enabled: true,
    no_reply_delay_days: 4,
    max_automated_followups: 3,
    requires_delivery_confirmation: true,
  }),
  [C.OFFER]: Object.freeze({
    enabled: true,
    no_reply_delay_days: 2,
    max_automated_followups: 2,
    requires_delivery_confirmation: true,
  }),
  [C.FORMAL_CONTRACT]: Object.freeze({
    enabled: true,
    no_reply_delay_days: 2,
    max_automated_followups: 2,
    requires_delivery_confirmation: true,
  }),
  // Operational stages: automated seller follow-ups are off. Progress comes
  // from contract/dispo/escrow/closing events, not nudge texts.
  [C.UNDER_CONTRACT]: Object.freeze({ enabled: false, no_reply_delay_days: null, max_automated_followups: 0, requires_delivery_confirmation: true }),
  [C.DISPOSITION]: Object.freeze({ enabled: false, no_reply_delay_days: null, max_automated_followups: 0, requires_delivery_confirmation: true }),
  [C.PREPARED_TO_CLOSE]: Object.freeze({ enabled: false, no_reply_delay_days: null, max_automated_followups: 0, requires_delivery_confirmation: true }),
  [C.CLOSED]: Object.freeze({ enabled: false, no_reply_delay_days: null, max_automated_followups: 0, requires_delivery_confirmation: true }),
});

/**
 * Resolve the follow-up policy for a thread's current lifecycle stage.
 * Unknown/null stages resolve to the S1 policy (a thread that has never been
 * staged is by definition in the first milestone).
 */
export function resolveFollowUpPolicyForStage(stage) {
  const code = normalizeLifecycleStage(stage);
  return {
    stage: code,
    policy: FOLLOWUP_POLICY_BY_STAGE[code] || FOLLOWUP_POLICY_BY_STAGE[C.OWNERSHIP_CONFIRMATION],
    registry_version: FOLLOWUP_POLICY_REGISTRY_VERSION,
  };
}

// ─── Re-engagement layer (G3) ───────────────────────────────────────────────
// Deterministic re-enrollment after a dispatched follow-up gets no inbound
// within its policy window. Two wave kinds share ONE lifetime ledger (the
// count of non-cancelled automated follow-up rows on the thread):
//
//   • stage waves — attempts 2..max_automated_followups for the thread's
//     CURRENT stage, re-using the stage registry's no_reply_delay_days as the
//     no-response window after each dispatched follow-up;
//   • nurture waves — after stage attempts are exhausted, long-cycle waves
//     every `nurture_wave_days`, at most `max_nurture_waves` of them.
//
// `max_total_automated_followups` is the absolute lifetime ceiling across both
// kinds — no configuration mistake may drip-nudge a silent seller forever.
// Values are deliberately conservative; loosening them is an operator
// decision, recorded here, never inline in a sweeper.
export const REENGAGEMENT_POLICY_VERSION = "reengagement_policy_v1";

export const REENGAGEMENT_POLICY = Object.freeze({
  // Long-term nurture cadence once a stage's attempt budget is spent.
  nurture_wave_days: 45,
  // Nurture waves allowed after stage attempts (not in addition to the total cap).
  max_nurture_waves: 2,
  // Absolute lifetime ceiling of non-cancelled automated follow-up rows/thread.
  max_total_automated_followups: 5,
  // Re-engagement never runs at or past S6: contract and operational stages
  // progress through contract/dispo/closing events, not nudge texts.
  max_lifecycle_stage_number: 5,
});

/**
 * Resolve the re-engagement wave for a thread given how many automated
 * follow-ups already exist (non-cancelled, lifetime) and the thread's current
 * stage policy. Pure; fail-closed: anything unresolvable returns eligible:false.
 *
 * @returns {{ eligible: boolean, wave: "stage"|"nurture"|null, reason: string,
 *             attempt: number|null, window_days: number|null }}
 */
export function resolveReengagementWave({ stage, prior_automated_followups } = {}) {
  const prior = Number(prior_automated_followups);
  if (!Number.isFinite(prior) || prior < 1) {
    // Re-engagement only follows an already-dispatched follow-up.
    return { eligible: false, wave: null, reason: "no_prior_followup_dispatched", attempt: null, window_days: null };
  }

  const { stage: stage_code, policy } = resolveFollowUpPolicyForStage(stage);
  if (!policy.enabled) {
    return { eligible: false, wave: null, reason: `followup_policy_disabled_for_stage:${stage_code}`, attempt: null, window_days: null };
  }

  const attempt = prior + 1; // the row this wave would create
  if (attempt > REENGAGEMENT_POLICY.max_total_automated_followups) {
    return {
      eligible: false,
      wave: null,
      reason: `reengagement_total_cap_reached:${prior}/${REENGAGEMENT_POLICY.max_total_automated_followups}`,
      attempt: null,
      window_days: null,
    };
  }

  const stage_cap = Number(policy.max_automated_followups) || 0;
  if (prior < stage_cap) {
    const window_days = Number(policy.no_reply_delay_days);
    if (!Number.isFinite(window_days) || window_days <= 0) {
      return { eligible: false, wave: null, reason: `stage_no_reply_window_missing:${stage_code}`, attempt: null, window_days: null };
    }
    return { eligible: true, wave: "stage", reason: `stage_wave_attempt_${attempt}`, attempt, window_days };
  }

  const nurture_waves_used = prior - stage_cap;
  if (nurture_waves_used >= REENGAGEMENT_POLICY.max_nurture_waves) {
    return {
      eligible: false,
      wave: null,
      reason: `reengagement_nurture_waves_exhausted:${nurture_waves_used}/${REENGAGEMENT_POLICY.max_nurture_waves}`,
      attempt: null,
      window_days: null,
    };
  }
  return {
    eligible: true,
    wave: "nurture",
    reason: `nurture_wave_attempt_${attempt}`,
    attempt,
    window_days: REENGAGEMENT_POLICY.nurture_wave_days,
  };
}

export default FOLLOWUP_POLICY_BY_STAGE;
