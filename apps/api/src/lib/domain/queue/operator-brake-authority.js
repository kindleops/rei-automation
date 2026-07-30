/**
 * operator-brake-authority.js
 *
 * Operator brakes outrank campaign state.
 *
 * The campaign rails sync (buildProductionQueueRailsPatch) runs from two
 * independent 5-minute crons (campaigns/feed, campaigns/activate-due). Before
 * this module it wrote the global execution posture on every tick, so any
 * operator stop was silently undone within one cron cycle: writing
 * queue_execution_mode='normal' re-armed unrestricted dispatch and
 * queue_emergency_stop_at='' cleared the emergency brake.
 *
 * PR #12 fixed the same class of bug for auto_reply_mode by deleting one key
 * from one object literal. That is exemption-shaped, not architecture-shaped:
 * nothing stopped the next key from being (re)introduced. This module inverts
 * the default — operator-owned keys are denied to autonomous campaign writers
 * by construction, at the patch builder AND at the system_control write seam.
 *
 * A campaign may still REQUEST a desired operating posture; the request is
 * returned for logging/observability and never persisted as authority.
 */

/**
 * Keys that encode the global outbound execution posture. Only the explicit
 * operator control plane (/api/cockpit/queue/control) may write these.
 */
export const OPERATOR_OWNED_SYSTEM_KEYS = Object.freeze([
  "queue_execution_mode",
  "queue_emergency_stop_at",
  "queue_processor_mode",
  "queue_runner_enabled",
  "queue_auto_send_enabled",
  "outbound_sms_enabled",
]);

/**
 * Companion keys written by rearmEmergencyStopAfterOneSend() in the operator
 * control plane. They are part of the same atomic stop posture, so allowing
 * campaign automation to write them would still partially clear an operator
 * stop (campaign_mode back to live_limited, feeder re-enabled).
 */
export const OPERATOR_STOP_COMPANION_KEYS = Object.freeze([
  "campaign_mode",
  "queue_auto_enqueue_enabled",
]);

/**
 * Full denylist for autonomous (non-operator) system_control writers.
 */
export const CAMPAIGN_FORBIDDEN_SYSTEM_KEYS = Object.freeze([
  ...OPERATOR_OWNED_SYSTEM_KEYS,
  ...OPERATOR_STOP_COMPANION_KEYS,
]);

const FORBIDDEN = new Set(CAMPAIGN_FORBIDDEN_SYSTEM_KEYS);

/** Write authorities recognised at the system_control seam. */
export const SYSTEM_CONTROL_AUTHORITIES = Object.freeze({
  /** Explicit human/control-plane action. May write anything. */
  OPERATOR: "operator",
  /** Cron/campaign automation. May never write operator-owned keys. */
  CAMPAIGN_AUTOMATION: "campaign_automation",
});

function cleanKey(value) {
  return String(value ?? "").trim();
}

export function isOperatorOwnedSystemKey(key) {
  return FORBIDDEN.has(cleanKey(key));
}

/**
 * Remove operator-owned keys from a patch produced by autonomous automation.
 *
 * @returns {{ patch: object, removed: string[] }} filtered patch + dropped keys
 */
export function stripOperatorOwnedSystemKeys(patch = {}) {
  const kept = {};
  const removed = [];
  for (const [rawKey, value] of Object.entries(patch || {})) {
    const key = cleanKey(rawKey);
    if (!key) continue;
    if (FORBIDDEN.has(key)) {
      removed.push(key);
      continue;
    }
    kept[rawKey] = value;
  }
  return { patch: kept, removed };
}

/**
 * Fail-closed assertion for code paths that must never carry operator keys.
 * Throws rather than silently dropping, so a regression surfaces in tests.
 */
export function assertNoOperatorOwnedSystemKeys(patch = {}, context = "campaign_automation") {
  const { removed } = stripOperatorOwnedSystemKeys(patch);
  if (removed.length > 0) {
    const error = new Error("operator_owned_system_key_write_blocked");
    error.code = "operator_owned_system_key_write_blocked";
    error.context = context;
    error.keys = removed;
    throw error;
  }
  return true;
}

/**
 * A campaign's desired operating posture. Advisory only: returned to callers
 * for logging and operator surfacing, never written to system_control.
 */
export function describeCampaignRequestedPosture(campaign = {}) {
  return Object.freeze({
    requested_queue_execution_mode: "normal",
    requested_campaign_mode: "live_limited",
    requested_outbound_sms_enabled: true,
    authoritative: false,
    note: "advisory_only_operator_brakes_outrank_campaign_state",
    campaign_id: campaign?.id ?? null,
  });
}
