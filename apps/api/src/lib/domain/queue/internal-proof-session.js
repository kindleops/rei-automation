// ─── internal-proof-session.js ───────────────────────────────────────────────
// Bounded internal-canary proof session: the ONLY path that may bypass the
// send-time contact window, and only for the exact internal canary traffic the
// operator pinned in system_control. Structurally incapable of matching a real
// seller row:
//
//   * the session itself is invalid unless its recipient is in the internal
//     test phone registry — a session pointing at a real seller never loads;
//   * the queue row must equal the pinned recipient, sender, and campaign, and
//     carry the internal-canary metadata stamp;
//   * the dispatch must be a validated scoped-canary execution (single-use
//     authorization already checked at the route and enforced atomically by
//     queue_atomic_claim_send_row) with a single-row manifest (max_rows = 1);
//   * queue_execution_mode must be scoped_canary_only at evaluation time
//     (fresh read — a mid-run operator stop kills the bypass);
//   * the session carries a hard expiration and a bounded maximum length.
//
// No single condition is sufficient. Every failure — including parse errors,
// clock anomalies, and thrown exceptions — denies the bypass and leaves the
// normal contact-window deferral in force.

import { getSystemValue } from "@/lib/system-control.js";
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import {
  QUEUE_EXECUTION_MODES,
  normalizeQueueExecutionMode,
} from "@/lib/domain/queue/queue-execution-mode.js";

export const INTERNAL_PROOF_SESSION_KEY = "internal_proof_session";

// Hard cap on total session length. A session whose expires_at is further than
// this past its created_at is invalid in its entirety, so a fat-fingered or
// tampered expiration cannot produce a long-lived bypass.
export const INTERNAL_PROOF_SESSION_MAX_MINUTES = 240;

function clean(value) {
  return String(value ?? "").trim();
}

function toTimestamp(value) {
  const parsed = new Date(clean(value)).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeE164(value) {
  const raw = clean(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? raw : null;
}

function metadataObject(row = {}) {
  const metadata = row?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

/**
 * Strict fail-closed parse of the operator-written session value.
 * Returns { ok: true, session } only when every structural requirement holds.
 */
export function parseInternalProofSession(raw, now = new Date()) {
  let value = raw;
  if (typeof value === "string") {
    if (!clean(value)) return { ok: false, reason: "session_not_configured" };
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, reason: "session_invalid_json" };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "session_not_configured" };
  }

  const session_id = clean(value.session_id);
  const campaign_id = clean(value.campaign_id);
  const queue_row_id = clean(value.queue_row_id);
  const recipient = normalizeE164(value.recipient);
  const sender = normalizeE164(value.sender);
  const created_ts = toTimestamp(value.created_at);
  const expires_ts = toTimestamp(value.expires_at);
  const now_ts = toTimestamp(now) ?? Date.now();

  if (!session_id) return { ok: false, reason: "session_id_required" };
  if (!campaign_id) return { ok: false, reason: "session_campaign_id_required" };
  if (!queue_row_id) return { ok: false, reason: "session_queue_row_id_required" };
  if (!recipient) return { ok: false, reason: "session_recipient_required" };
  if (!sender) return { ok: false, reason: "session_sender_required" };
  if (!isInternalTestPhone(recipient)) return { ok: false, reason: "session_recipient_not_internal" };
  if (created_ts === null) return { ok: false, reason: "session_created_at_invalid" };
  if (expires_ts === null) return { ok: false, reason: "session_expires_at_invalid" };
  if (expires_ts <= now_ts) return { ok: false, reason: "session_expired" };
  if (created_ts > now_ts + 5 * 60_000) return { ok: false, reason: "session_created_in_future" };
  if (expires_ts - created_ts > INTERNAL_PROOF_SESSION_MAX_MINUTES * 60_000) {
    return { ok: false, reason: "session_exceeds_max_length" };
  }

  return {
    ok: true,
    session: {
      session_id,
      campaign_id,
      queue_row_id,
      recipient,
      sender,
      created_at: new Date(created_ts).toISOString(),
      expires_at: new Date(expires_ts).toISOString(),
      allow_thread_auto_replies: value.allow_thread_auto_replies === true,
    },
  };
}

export async function loadActiveInternalProofSession(deps = {}) {
  const get_system_value = deps.getSystemValue || getSystemValue;
  const now = deps.now || new Date();
  let raw;
  try {
    raw = await get_system_value(INTERNAL_PROOF_SESSION_KEY, deps);
  } catch {
    return { active: false, reason: "session_lookup_failed" };
  }
  const parsed = parseInternalProofSession(raw, now);
  if (!parsed.ok) return { active: false, reason: parsed.reason };
  return { active: true, session: parsed.session };
}

/**
 * Full-conjunction contact-window bypass evaluation for one queue row.
 * deps must carry the scoped-canary execution context forwarded by
 * runScopedCampaignCanary: scoped_canary, authorization_validated,
 * canary_run_id, scoped_canary_max_rows, scoped_canary_requested_ids.
 */
export async function evaluateInternalProofContactWindowBypass(queue_row, deps = {}) {
  try {
    const row_id = clean(queue_row?.id);
    if (!row_id) return { allowed: false, reason: "missing_queue_row_id" };

    // Scoped-canary execution context — dispatch outside a validated
    // single-use-authorized scoped canary can never bypass.
    if (deps.scoped_canary !== true) {
      return { allowed: false, reason: "not_scoped_canary_dispatch" };
    }
    if (deps.authorization_validated !== true) {
      return { allowed: false, reason: "authorization_not_validated" };
    }
    if (!clean(deps.canary_run_id)) {
      return { allowed: false, reason: "canary_run_id_required" };
    }
    if (deps.scoped_canary_max_rows !== 1) {
      return { allowed: false, reason: "max_rows_must_be_one" };
    }
    const requested_ids = Array.isArray(deps.scoped_canary_requested_ids)
      ? deps.scoped_canary_requested_ids.map((value) => clean(value)).filter(Boolean)
      : [];
    if (requested_ids.length !== 1 || requested_ids[0] !== row_id) {
      return { allowed: false, reason: "request_manifest_not_single_row" };
    }

    // Fresh execution-mode read: the bypass dies the moment an operator stops
    // the queue, even mid-run.
    const get_system_value = deps.getSystemValue || getSystemValue;
    const raw_mode = await get_system_value("queue_execution_mode", deps);
    if (normalizeQueueExecutionMode(raw_mode) !== QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY) {
      return { allowed: false, reason: "queue_execution_mode_not_scoped_canary_only" };
    }

    const session_state = await loadActiveInternalProofSession(deps);
    if (!session_state.active) {
      return { allowed: false, reason: session_state.reason || "session_not_active" };
    }
    const session = session_state.session;

    const to_phone = normalizeE164(queue_row.to_phone_number);
    const from_phone = normalizeE164(queue_row.from_phone_number);
    const campaign_id = clean(queue_row.campaign_id);
    const metadata = metadataObject(queue_row);

    if (!to_phone || to_phone !== session.recipient) {
      return { allowed: false, reason: "recipient_mismatch" };
    }
    if (!isInternalTestPhone(to_phone)) {
      return { allowed: false, reason: "recipient_not_internal" };
    }
    if (!from_phone || from_phone !== session.sender) {
      return { allowed: false, reason: "sender_mismatch" };
    }
    if (!campaign_id || campaign_id !== session.campaign_id) {
      return { allowed: false, reason: "campaign_mismatch" };
    }
    if (metadata.internal_canary !== true) {
      return { allowed: false, reason: "internal_canary_stamp_missing" };
    }

    if (row_id === session.queue_row_id) {
      // Primary pinned canary row: must additionally carry the internal-canary
      // origin stamp written when the row was created.
      const origin =
        clean(metadata.origin_surface).toLowerCase() ||
        clean(metadata.source).toLowerCase();
      if (origin !== "internal_canary") {
        return { allowed: false, reason: "origin_surface_not_internal_canary" };
      }
      return {
        allowed: true,
        leg: "primary_canary_row",
        session_id: session.session_id,
        expires_at: session.expires_at,
      };
    }

    // Auto-reply leg: only replies on the exact pinned internal thread, only
    // while the session explicitly allows them, and only rows that provably
    // answer a persisted inbound message.
    if (session.allow_thread_auto_replies !== true) {
      return { allowed: false, reason: "thread_auto_replies_not_allowed" };
    }
    const inbound_linkage =
      clean(queue_row.inbound_message_id) ||
      clean(metadata.inbound_message_id) ||
      clean(metadata.source_event_id) ||
      clean(metadata.reply_to_message_event_id);
    if (!inbound_linkage) {
      return { allowed: false, reason: "auto_reply_missing_inbound_linkage" };
    }
    return {
      allowed: true,
      leg: "internal_thread_auto_reply",
      session_id: session.session_id,
      expires_at: session.expires_at,
    };
  } catch (error) {
    return { allowed: false, reason: `bypass_evaluation_error:${error?.message || "unknown"}` };
  }
}

export default evaluateInternalProofContactWindowBypass;
