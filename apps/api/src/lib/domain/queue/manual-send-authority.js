// ─── manual-send-authority.js ───────────────────────────────────────────────
// The runtime authority for an AUTHENTICATED HUMAN manual SMS.
//
// WHY A SEPARATE AUTHORITY. Production had one brake for everything:
// queue_emergency_stop_at stopped campaign/queue automation AND every operator
// reply typed in the Inbox composer (HTTP 423 queue_emergency_stop_active).
// The only thing that let a manual send through was an adapter-level excuse
// keyed on request metadata (source === "manual_inbox",
// manual_operator_send === true) -- a string any caller could write. That is
// not authority, and it is gone.
//
// THE CONTROL MODEL (four controls, all server-side system_control keys):
//   1. Autonomous AI messaging      -> ai_conversation_send_policy / kill switch   (untouched)
//   2. Campaign + queue automation  -> queue_emergency_stop_at, queue_processor_mode,
//                                      queue_execution_mode, campaign modes      (untouched)
//   3. Authenticated manual SMS     -> THIS MODULE: manual_send_mode + a server-side
//                                      operator principal
//   4. True global shutdown         -> global_send_shutdown_at, read HERE and by the
//                                      canonical authority, so one key stops everything
//
// WHAT COUNTS AS AN OPERATOR. The principal is built SERVER-SIDE by the route's
// auth layer (ensureMutationAuth -> requireOpsDashboardAuth) from the verified
// shared-secret session and the Worker-stamped x-ops-user-id. It is passed as a
// separate argument, never inside the request payload. Nothing in the body
// (source, send_source, manual_operator_send, metadata.*, operator_email) is
// consulted, so nothing in the body can manufacture one.
//
// FAIL CLOSED, ALWAYS.
//   * no / invalid principal             -> manual_send_requires_authenticated_operator
//   * global_send_shutdown_at active      -> global_send_shutdown_active
//   * manual_send_mode !== "enabled"     -> manual_send_disabled  (absent = off)
//   * the control-plane read throws       -> control_plane_unreadable
//   * no control-plane reader supplied    -> control_plane_unreadable
//
// This authority does NOT read queue_emergency_stop_at, queue_processor_mode or
// queue_execution_mode: an operator answering a seller is not campaign
// automation, and stopping automation must not silence the human.
//
// Every compliance gate (opt-out, suppression, property holds, paused/quarantined
// threads, sender eligibility, duplicate prevention) is evaluated elsewhere and
// is untouched by this verdict. Authority to send is not permission to contact.

import { clean, isEmergencyStopActive } from "@/lib/domain/queue/queue-control-safety.js";

export const MANUAL_SEND_AUTHORITY_VERSION = "manual_send_authority_v1";
export const MANUAL_SEND_AUTHORITY = "manual_operator";

export const GLOBAL_SEND_SHUTDOWN_KEY = "global_send_shutdown_at";
export const MANUAL_SEND_MODE_KEY = "manual_send_mode";
export const MANUAL_SEND_MODE_ENABLED = "enabled";
export const MANUAL_SEND_MODE_DISABLED = "disabled";

/** Control-plane keys this authority reads. Both are required. */
export const MANUAL_SEND_CONTROL_KEYS = Object.freeze([
  GLOBAL_SEND_SHUTDOWN_KEY,
  MANUAL_SEND_MODE_KEY,
]);

/**
 * Verdicts this module actually issued. A verdict-shaped object built anywhere
 * else is not a verdict: transport asks `isManualSendAuthorityVerdict()` and a
 * hand-rolled `{ ok: true, authority: "manual_operator" }` is refused.
 */
const ISSUED_VERDICTS = new WeakSet();

/** Same truthiness rule as the queue emergency stop: any value other than a clear marker is active. */
export function isGlobalSendShutdownActive(value) {
  return isEmergencyStopActive(value);
}

/** `enabled` exactly (after trim). Absent, blank, `disabled`, or anything else is off. */
export function normalizeManualSendMode(value) {
  return clean(value).toLowerCase() === MANUAL_SEND_MODE_ENABLED
    ? MANUAL_SEND_MODE_ENABLED
    : MANUAL_SEND_MODE_DISABLED;
}

/**
 * A principal the server-side auth layer produced. Shape is deliberately
 * narrow: the verified session (`authenticated: true`), how it was presented
 * (`via`), and which auth layer vouched for it (`auth_source`). `id`/`email`
 * are provenance for the audit trail and are never required to be present,
 * because the ops-dashboard auth layer verifies a session, not a mailbox.
 */
export function isAuthenticatedOperatorPrincipal(operator) {
  if (!operator || typeof operator !== "object" || Array.isArray(operator)) return false;
  if (operator.authenticated !== true) return false;
  if (!clean(operator.auth_source)) return false;
  if (!clean(operator.via)) return false;
  return true;
}

export function isManualSendAuthorityVerdict(verdict) {
  return Boolean(
    verdict &&
      typeof verdict === "object" &&
      ISSUED_VERDICTS.has(verdict) &&
      verdict.ok === true &&
      verdict.authority === MANUAL_SEND_AUTHORITY
  );
}

function denial(reason, message, extra = {}) {
  return {
    ok: false,
    status: 423,
    reason,
    error: reason,
    message,
    authority: MANUAL_SEND_AUTHORITY,
    authority_version: MANUAL_SEND_AUTHORITY_VERSION,
    sent: false,
    skipped: true,
    ...extra,
  };
}

/**
 * Evaluate whether an authenticated operator may send a manual SMS right now.
 *
 * @param {object} args
 * @param {Function} args.getSystemValue  async (key) => value. REQUIRED.
 * @param {object}   args.operator        server-side principal. REQUIRED.
 * @param {string}  [args.action]         label carried into diagnostics
 * @returns {Promise<object>} verdict; never throws
 */
export async function evaluateManualSendAuthority({
  getSystemValue = null,
  operator = null,
  action = "manual_send",
} = {}) {
  if (!isAuthenticatedOperatorPrincipal(operator)) {
    return denial(
      "manual_send_requires_authenticated_operator",
      "A manual send requires an authenticated operator session; none was established by the server.",
      { action }
    );
  }

  if (typeof getSystemValue !== "function") {
    return denial(
      "control_plane_unreadable",
      "No control-plane reader was supplied; manual send authority cannot be established.",
      { action }
    );
  }

  let shutdown_at;
  let manual_mode;
  try {
    [shutdown_at, manual_mode] = await Promise.all([
      getSystemValue(GLOBAL_SEND_SHUTDOWN_KEY),
      getSystemValue(MANUAL_SEND_MODE_KEY),
    ]);
  } catch (error) {
    return denial(
      "control_plane_unreadable",
      "Control-plane read failed; manual send authority cannot be established.",
      { action, detail: String(error?.message ?? "read_failed") }
    );
  }

  if (isGlobalSendShutdownActive(shutdown_at)) {
    return denial(
      "global_send_shutdown_active",
      "Global send shutdown is active; every outbound send is blocked, manual included.",
      { action, diagnostics: { global_send_shutdown_at: clean(shutdown_at) || null } }
    );
  }

  if (clean(manual_mode) !== MANUAL_SEND_MODE_ENABLED) {
    return denial(
      "manual_send_disabled",
      "manual_send_mode is not enabled; operator manual sends are off.",
      { action, diagnostics: { manual_send_mode: clean(manual_mode) || null } }
    );
  }

  const verdict = Object.freeze({
    ok: true,
    status: 200,
    action,
    authority: MANUAL_SEND_AUTHORITY,
    authority_version: MANUAL_SEND_AUTHORITY_VERSION,
    operator: Object.freeze({
      id: clean(operator.id) || null,
      email: clean(operator.email) || null,
      auth_source: clean(operator.auth_source),
      via: clean(operator.via),
    }),
    diagnostics: Object.freeze({
      manual_send_mode: MANUAL_SEND_MODE_ENABLED,
      global_send_shutdown_at: null,
    }),
  });
  ISSUED_VERDICTS.add(verdict);
  return verdict;
}

/** The slice of a verdict that is safe and useful to persist on a send. */
export function describeSendAuthorityForMetadata(verdict) {
  if (!verdict || typeof verdict !== "object" || verdict.ok !== true) return null;
  return {
    send_authority: clean(verdict.authority) || null,
    send_authority_version: clean(verdict.authority_version) || null,
    ...(verdict.authority === MANUAL_SEND_AUTHORITY
      ? { operator_id: clean(verdict.operator?.id) || null, operator_auth_source: clean(verdict.operator?.auth_source) || null }
      : {}),
  };
}

export default evaluateManualSendAuthority;
