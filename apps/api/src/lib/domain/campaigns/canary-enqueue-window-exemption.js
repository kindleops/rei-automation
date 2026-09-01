// ─── canary-enqueue-window-exemption.js ─────────────────────────────────────
// PINNED INTERNAL-CANARY ENQUEUE CONTACT-WINDOW EXEMPTION
//
// The 08:00-21:00 contact window is a quiet-hours compliance control and is NOT
// modified by this module. WINDOW_START_HOUR / WINDOW_END_HOUR are untouched,
// and every ordinary campaign, every real seller, and every other internal test
// phone remains fully protected.
//
// This is one pinned exception, at ENQUEUE time only, for a single
// operator-controlled internal canary lane. It is modelled deliberately on the
// existing dispatch-time internal-proof-session mechanism: a long conjunction in
// which no single condition is sufficient, everything is exact-match, and every
// failure -- including parse errors, lookup failures and thrown exceptions --
// falls back to the NORMAL contact-window result.
//
// SEPARATION. This is not the dispatch bypass. internal-proof-session.js remains
// the only path that may bypass the SEND-time window, is pinned to a different
// lane entirely (+16128072000 / +16128060495 / b7c9a000-...), and is untouched
// here. An enqueue-time exemption does not make a row dispatchable: the row is
// still stamped campaign_mode=paused, the queue stays scoped_canary_only, and
// the emergency brake stays active.
//
// WHY REGISTRY MEMBERSHIP IS NOT ENOUGH. isInternalTestPhone() has three other
// members. Registry membership is necessary but never sufficient -- the campaign,
// target, recipient and sender must all match the pin, so no other internal test
// phone can inherit this exemption.
//
// WHY EXPLICIT PRESENCE IS REQUIRED FOR THE CONTROL-PLANE VALUES.
// normalizeCampaignMode(value, fallback = "paused") maps an EMPTY value to
// "paused". Checking only the normalized result would therefore read the ABSENCE
// of campaign_mode as proof of containment -- a fail-open. Each control-plane
// value must be explicitly present AND normalize to the contained value.

import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import {
  QUEUE_EXECUTION_MODES,
  normalizeQueueExecutionMode,
} from "@/lib/domain/queue/queue-execution-mode.js";
import { normalizeCampaignMode } from "@/lib/domain/queue/queue-control-safety.js";
import { ENQUEUE_SCOPE, normalizeRecipient } from "./canary-enqueue-authorization.js";

/** The exemption is pinned IN CODE, not delegated to request or DB content. */
export const CANARY_WINDOW_EXEMPTION_PIN = Object.freeze({
  campaign_id: "b299ddde-43ea-48b6-ac7b-c7e53688d49e",
  campaign_target_id: "618dc4d9-08e3-42b5-8c21-4d2aa9d586d9",
  recipient: "+13059807795",
  sender: "+14693131600",
});

export const CANARY_WINDOW_EXEMPTION_REASON = "contact_window_internal_canary_exemption";

export const EXEMPTION_DENIED = Object.freeze({
  NOT_PINNED_CAMPAIGN: "exemption_campaign_not_pinned",
  NOT_PINNED_TARGET: "exemption_target_not_pinned",
  NOT_PINNED_RECIPIENT: "exemption_recipient_not_pinned",
  NOT_PINNED_SENDER: "exemption_sender_not_pinned",
  NOT_INTERNAL_PHONE: "exemption_recipient_not_internal_registry",
  NOT_CANARY_CAMPAIGN: "exemption_campaign_not_internal_canary",
  CAMPAIGN_ACTIVATABLE: "exemption_campaign_missing_do_not_activate",
  CAMPAIGN_LIVE: "exemption_campaign_is_live",
  CAMPAIGN_MODE_NOT_PAUSED: "exemption_campaign_mode_not_paused",
  EXECUTION_MODE_NOT_SCOPED: "exemption_execution_mode_not_scoped_canary_only",
  EMERGENCY_BRAKE_INACTIVE: "exemption_emergency_brake_not_active",
  NO_AUTHORIZATION: "exemption_authorization_absent",
  AUTHORIZATION_WRONG_SCOPE: "exemption_authorization_wrong_scope",
  AUTHORIZATION_MISMATCH: "exemption_authorization_identity_mismatch",
  AUTHORIZATION_EXPIRED: "exemption_authorization_expired",
  AUTHORIZATION_CONSUMED: "exemption_authorization_consumed",
  ERROR: "exemption_evaluation_error",
});

const LIVE_CAMPAIGN_STATUSES = new Set(["active", "running", "live", "sending", "launched"]);

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * CHEAP LANE PREDICATE -- pure, no I/O, no side effects.
 *
 * Every caller that is not this exact target short-circuits here, so an
 * ordinary campaign target does no extra database work, resolves no extra
 * control-plane values, and reaches exactly the same contact-window denial it
 * reached before this module existed.
 */
export function canaryLanePinMatches({ target = null, recipient = "" } = {}) {
  const pin = CANARY_WINDOW_EXEMPTION_PIN;
  return (
    clean(target?.campaign_id) === pin.campaign_id &&
    clean(target?.id) === pin.campaign_target_id &&
    normalizeRecipient(recipient) === pin.recipient
  );
}

/**
 * May this ONE pinned internal canary enqueue outside the contact window?
 *
 * Returns { allowed: false, reason } for every non-matching or error case, so
 * the caller keeps the normal contact-window denial. Never throws.
 *
 * @param {object} args
 * @param {object} args.target          campaign_targets row
 * @param {object} args.campaign        campaigns row (status + metadata)
 * @param {string} args.recipient       resolved recipient
 * @param {string} args.sender          resolved sender phone
 * @param {object} args.authorization   an ALREADY-VALIDATED scoped enqueue authorization
 * @param {string} args.campaignMode    raw system_control campaign_mode
 * @param {string} args.executionMode   raw system_control queue_execution_mode
 * @param {string} args.emergencyStopAt raw system_control queue_emergency_stop_at
 * @param {string} args.now             ISO instant (real clock; never injected on the write path)
 */
export function evaluateCanaryEnqueueWindowExemption({
  target = null,
  campaign = null,
  recipient = "",
  sender = "",
  authorization = null,
  campaignMode = "",
  executionMode = "",
  emergencyStopAt = "",
  now = null,
} = {}) {
  try {
    const pin = CANARY_WINDOW_EXEMPTION_PIN;

    // ── exact lane pin ────────────────────────────────────────────────────
    if (clean(target?.campaign_id) !== pin.campaign_id) {
      return { allowed: false, reason: EXEMPTION_DENIED.NOT_PINNED_CAMPAIGN };
    }
    if (clean(target?.id) !== pin.campaign_target_id) {
      return { allowed: false, reason: EXEMPTION_DENIED.NOT_PINNED_TARGET };
    }
    if (normalizeRecipient(recipient) !== pin.recipient) {
      return { allowed: false, reason: EXEMPTION_DENIED.NOT_PINNED_RECIPIENT };
    }
    if (normalizeRecipient(sender) !== pin.sender) {
      return { allowed: false, reason: EXEMPTION_DENIED.NOT_PINNED_SENDER };
    }

    // Necessary but NEVER sufficient: the other registry members cannot reach
    // here because they fail the recipient pin above.
    if (!isInternalTestPhone(pin.recipient)) {
      return { allowed: false, reason: EXEMPTION_DENIED.NOT_INTERNAL_PHONE };
    }

    // ── campaign must be a non-live, non-activatable internal canary ──────
    const meta =
      campaign?.metadata && typeof campaign.metadata === "object" ? campaign.metadata : {};
    if (meta.internal_canary !== true) {
      return { allowed: false, reason: EXEMPTION_DENIED.NOT_CANARY_CAMPAIGN };
    }
    if (meta.do_not_activate !== true) {
      return { allowed: false, reason: EXEMPTION_DENIED.CAMPAIGN_ACTIVATABLE };
    }
    if (LIVE_CAMPAIGN_STATUSES.has(clean(campaign?.status).toLowerCase())) {
      return { allowed: false, reason: EXEMPTION_DENIED.CAMPAIGN_LIVE };
    }

    // ── control plane must still be fully contained ───────────────────────
    // Explicit presence required; see the header note on fail-open.
    const rawCampaignMode = clean(campaignMode);
    if (!rawCampaignMode || normalizeCampaignMode(rawCampaignMode) !== "paused") {
      return { allowed: false, reason: EXEMPTION_DENIED.CAMPAIGN_MODE_NOT_PAUSED };
    }
    const rawExecutionMode = clean(executionMode);
    if (
      !rawExecutionMode ||
      normalizeQueueExecutionMode(rawExecutionMode) !== QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY
    ) {
      return { allowed: false, reason: EXEMPTION_DENIED.EXECUTION_MODE_NOT_SCOPED };
    }
    // The brake must be ACTIVE. Its absence is not a pass.
    const brakeAt = new Date(clean(emergencyStopAt)).getTime();
    if (!clean(emergencyStopAt) || !Number.isFinite(brakeAt)) {
      return { allowed: false, reason: EXEMPTION_DENIED.EMERGENCY_BRAKE_INACTIVE };
    }

    // ── a live, exactly-matching scoped authorization ─────────────────────
    if (!authorization?.id) {
      return { allowed: false, reason: EXEMPTION_DENIED.NO_AUTHORIZATION };
    }
    if (clean(authorization?.metadata?.scope) !== ENQUEUE_SCOPE) {
      return { allowed: false, reason: EXEMPTION_DENIED.AUTHORIZATION_WRONG_SCOPE };
    }
    if (
      clean(authorization.campaign_id) !== pin.campaign_id ||
      clean(authorization?.metadata?.campaign_target_id) !== pin.campaign_target_id ||
      normalizeRecipient(authorization?.metadata?.recipient) !== pin.recipient
    ) {
      return { allowed: false, reason: EXEMPTION_DENIED.AUTHORIZATION_MISMATCH };
    }
    if (authorization.consumed_at) {
      return { allowed: false, reason: EXEMPTION_DENIED.AUTHORIZATION_CONSUMED };
    }
    const expiresAt = authorization.expires_at
      ? new Date(authorization.expires_at).getTime()
      : NaN;
    const nowMs = now ? new Date(now).getTime() : Date.now();
    if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs) || expiresAt <= nowMs) {
      return { allowed: false, reason: EXEMPTION_DENIED.AUTHORIZATION_EXPIRED };
    }

    return {
      allowed: true,
      reason: CANARY_WINDOW_EXEMPTION_REASON,
      pin,
      authorization_id: authorization.id,
      canary_run_id: clean(authorization.canary_run_id) || null,
    };
  } catch (error) {
    // Any unexpected shape denies; the normal contact window stands.
    return { allowed: false, reason: EXEMPTION_DENIED.ERROR, detail: clean(error?.message) };
  }
}

export default evaluateCanaryEnqueueWindowExemption;
