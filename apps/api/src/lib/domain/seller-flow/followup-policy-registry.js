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

export default FOLLOWUP_POLICY_BY_STAGE;
