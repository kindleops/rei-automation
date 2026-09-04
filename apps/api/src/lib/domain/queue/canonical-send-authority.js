// ─── canonical-send-authority.js ────────────────────────────────────────────
// THE single runtime authority that must authorize any seller-visible send.
//
// INVARIANT
//   NO SELLER-VISIBLE MESSAGE MAY BE SENT UNLESS THE SAME CANONICAL RUNTIME
//   AUTHORITY THAT PROTECTS NORMAL QUEUE EXECUTION AUTHORIZES IT.
//
// THE DEFECT THIS CLOSES. Two manual paths reached the provider without that
// authority:
//
//   1. executeManualInboxSendNow (cockpit map_command / inbox CTA) called
//      evaluateQueueCreationRuntimeBrakes, recorded the blocked verdict as
//      METADATA (`bypassed_runtime_brake`, `bypassed_queue_emergency_stop`) and
//      then proceeded to claim the row and call the provider anyway. The brake
//      was observed, labelled, and ignored.
//   2. processSendQueueItem evaluated brakes with `failClosed: false`, so an
//      ABSENT or unreadable queue_processor_mode resolved to "no opinion" and
//      the send proceeded. Neither path consulted queue_execution_mode at all,
//      so `scoped_canary_only` did not restrain unrestricted manual dispatch.
//
// THIS IS NOT A SECOND SAFETY IMPLEMENTATION. It composes the two existing
// canonical authorities and adds nothing of its own:
//   * evaluateQueueSendRuntimeBrakes  - emergency stop + queue_processor_mode
//   * evaluateUnrestrictedDispatchGate - queue_execution_mode
// The only new behaviour is that both are now REQUIRED, and read failures are
// denials rather than permissions.
//
// FAIL CLOSED, ALWAYS. An absent, malformed, or unreadable control value denies:
//   * queue_processor_mode absent  -> normalizes to "off"          -> DENY
//   * queue_execution_mode absent  -> normalizes to "stopped"      -> DENY
//   * the control-plane read throws -> control_plane_unreadable    -> DENY
// A caller can never obtain authority by supplying nothing.
//
// SCOPED CANARY. `scopedCanary: true` does not mean "skip safety". It means the
// bounded scoped-canary authorization architecture is the authority for this
// dispatch (a token-bearing, expiring, one-time authorization that separately
// requires queue_execution_mode === scoped_canary_only). That path is evaluated
// by its own canonical gate and must not be double-judged here.

import {
  evaluateQueueSendRuntimeBrakes,
} from "@/lib/domain/queue/queue-control-safety.js";
import {
  evaluateUnrestrictedDispatchGate,
} from "@/lib/domain/queue/queue-execution-mode.js";

export const CANONICAL_SEND_AUTHORITY_VERSION = "canonical_send_authority_v1";

/** Control-plane keys this authority reads. Order is irrelevant; all are required. */
export const REQUIRED_CONTROL_KEYS = Object.freeze([
  "queue_processor_mode",
  "queue_emergency_stop_at",
  "queue_execution_mode",
]);

function denial(reason, message, extra = {}) {
  return {
    ok: false,
    status: 423,
    reason,
    error: reason,
    message,
    authority_version: CANONICAL_SEND_AUTHORITY_VERSION,
    sent: false,
    skipped: true,
    ...extra,
  };
}

/**
 * Evaluate whether a seller-visible send may proceed.
 *
 * @param {object} args
 * @param {Function} args.getSystemValue  async (key) => value. REQUIRED.
 * @param {string}  [args.action]         label carried into diagnostics
 * @param {boolean} [args.scopedCanary]   the scoped-canary architecture is the authority
 * @returns {Promise<{ok:boolean, reason?:string, ...}>} never throws
 */
export async function evaluateCanonicalSendAuthority({
  getSystemValue = null,
  action = "canonical_send",
  scopedCanary = false,
} = {}) {
  if (scopedCanary === true) {
    return {
      ok: true,
      action,
      authority: "scoped_canary_authorization",
      authority_version: CANONICAL_SEND_AUTHORITY_VERSION,
    };
  }

  if (typeof getSystemValue !== "function") {
    // No way to read the control plane is not a licence to send.
    return denial(
      "control_plane_unreadable",
      "No control-plane reader was supplied; send authority cannot be established.",
      { action }
    );
  }

  let processor_mode;
  let emergency_stop_at;
  let execution_mode;
  try {
    [processor_mode, emergency_stop_at, execution_mode] = await Promise.all([
      getSystemValue("queue_processor_mode"),
      getSystemValue("queue_emergency_stop_at"),
      getSystemValue("queue_execution_mode"),
    ]);
  } catch (error) {
    return denial(
      "control_plane_unreadable",
      "Control-plane read failed; send authority cannot be established.",
      { action, detail: String(error?.message ?? "read_failed") }
    );
  }

  // 1. Emergency stop + queue_processor_mode. failClosed:true so an ABSENT
  //    processor mode denies instead of being treated as "no opinion".
  const brakes = evaluateQueueSendRuntimeBrakes(
    { queue_processor_mode: processor_mode, queue_emergency_stop_at: emergency_stop_at },
    { action, failClosed: true }
  );
  if (!brakes.ok) {
    return {
      ...brakes,
      ok: false,
      sent: false,
      skipped: true,
      authority_version: CANONICAL_SEND_AUTHORITY_VERSION,
    };
  }

  // 2. queue_execution_mode. An unrestricted send requires `normal`;
  //    `scoped_canary_only` and `stopped` both deny, and an absent/unknown
  //    value normalizes to `stopped`.
  const gate = evaluateUnrestrictedDispatchGate(execution_mode, { action });
  if (!gate.ok) {
    return {
      ...gate,
      ok: false,
      sent: false,
      skipped: true,
      authority_version: CANONICAL_SEND_AUTHORITY_VERSION,
    };
  }

  return {
    ok: true,
    action,
    authority: "canonical_runtime",
    authority_version: CANONICAL_SEND_AUTHORITY_VERSION,
    queue_execution_mode: gate.mode,
    diagnostics: brakes.diagnostics,
  };
}

export default evaluateCanonicalSendAuthority;
