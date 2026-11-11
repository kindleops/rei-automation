// ─── internal-send-preflight.js ─────────────────────────────────────────────
// The runtime-brake preflight shared by the internal send routes
// (outbound/send-now, outbound/direct-send, queue/seed-test).
//
// Before the send-authorization fix (2026-11-11) these routes called
// evaluateQueueCreationRuntimeBrakes with `failClosed: false` and read the
// brakes through the 30s-cached, error-swallowing getSystemValue. So an absent
// campaign_mode meant "no opinion", a Supabase error meant "no emergency stop",
// and global_send_shutdown_at was never consulted at all.
//
// Now:
//   * global_send_shutdown_at active                 -> global_send_shutdown_active
//   * queue_emergency_stop_at active (or unreadable) -> queue_emergency_stop_active
//   * campaign_mode absent / paused                  -> campaign_paused
//   * campaign_mode not live_limited                 -> campaign_not_live_limited
//   * no reader, or the reader throws                -> control_plane_unreadable
// All are HTTP 423. Downstream authorities (processSendQueue's canonical
// authority, the textgrid last hop) still apply; this is the first gate, not
// the only one.

import { evaluateQueueCreationRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import {
  GLOBAL_SEND_SHUTDOWN_KEY,
  isGlobalSendShutdownActive,
} from "@/lib/domain/queue/manual-send-authority.js";

function denial(reason, message, action, diagnostics = {}) {
  return {
    ok: false,
    status: 423,
    action,
    error: reason === "control_plane_unreadable" ? reason : "runtime_brake_active",
    reason,
    message,
    diagnostics,
  };
}

/**
 * @param {{ getSystemValue?: Function, action?: string }} args
 * @returns {Promise<object>} never throws
 */
export async function evaluateInternalSendPreflight({ getSystemValue = null, action = "internal_send" } = {}) {
  if (typeof getSystemValue !== "function") {
    return denial(
      "control_plane_unreadable",
      "No control-plane reader was supplied; the send cannot be authorized.",
      action
    );
  }

  let global_shutdown_at;
  let emergency_stop_at;
  let campaign_mode;
  try {
    [global_shutdown_at, emergency_stop_at, campaign_mode] = await Promise.all([
      getSystemValue(GLOBAL_SEND_SHUTDOWN_KEY),
      getSystemValue("queue_emergency_stop_at"),
      getSystemValue("campaign_mode"),
    ]);
  } catch (error) {
    return denial(
      "control_plane_unreadable",
      "Control-plane read failed; the send cannot be authorized.",
      action,
      { detail: String(error?.message ?? "read_failed") }
    );
  }

  if (isGlobalSendShutdownActive(global_shutdown_at)) {
    return denial(
      "global_send_shutdown_active",
      "Global send shutdown is active; every outbound send is blocked.",
      action,
      { global_send_shutdown_at: String(global_shutdown_at ?? "").trim() || null }
    );
  }

  return evaluateQueueCreationRuntimeBrakes(
    { campaign_mode, queue_emergency_stop_at: emergency_stop_at },
    { action, failClosed: true }
  );
}

export default evaluateInternalSendPreflight;
