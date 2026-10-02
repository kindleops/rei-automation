/**
 * IC8 CAMPAIGN CONTROLLER v0 -- the deterministic limits the controller is
 * clamped by (audit campaigns-and-runtime §1.4, the §211 matrix).
 *
 * The controller never re-implements a send-time guardrail: it cannot send,
 * so DNC / STOP / wrong-number / contact-window / sender-eligibility /
 * template-governance checks stay where they are (process-send-queue, the
 * planner, the feeder). What it needs is the NUMBERS and SETS those systems
 * enforce, so that no proposal can ask for more than they allow. They arrive
 * as an injected snapshot (`guardrails`); DEFAULT_DETERMINISTIC_LIMITS mirrors
 * production at 2026-10-01 for tests and the replay.
 *
 * Lifecycle legality is NOT mirrored: it calls the real, pure state machine
 * (campaign-state-machine.js), the same edge set the transition RPC enforces.
 */

import {
  CAMPAIGN_STATES,
  LIVE_CAMPAIGN_STATES,
  isTransitionAllowed,
  normalizeCampaignStatus,
} from "../../campaigns/campaign-state-machine.js";

export const GUARDRAILS_SCHEMA = "campaign_guardrails@1";

/** Canonical routes (audit §1.1 "Controller knobs -> canonical owner"). */
export const LIFECYCLE_ROUTE = "/api/cockpit/campaigns/{id}/lifecycle";
export const CAMPAIGN_PATCH_ROUTE = "/api/cockpit/campaigns/{id}";

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

export const DEFAULT_DETERMINISTIC_LIMITS = deepFreeze({
  schema: GUARDRAILS_SCHEMA,
  version: "prod-mirror-2026-10-01",
  source: "audit campaigns-and-runtime §1.1/§1.4 (queue-run-request.js:176-183, sms-engine.js evaluateContactWindow, textgrid_numbers.daily_limit, run-campaign-outbound-feeder.js)",
  /** #9 queue-run-request.js / queue-control-safety.js: at most 50 claims per minute run. */
  run_size_clamp: 50,
  /** #8 textgrid_numbers.daily_limit (all 16 numbers). */
  per_number_daily_limit: 800,
  /** #4 contact_window_v1_0800_2100_local_fail_closed, recipient (property) zone. */
  contact_window: { start: "08:00", end: "21:00" },
  /** resolveFeedLimit: asPositiveInteger(daily_cap, 0) -> 0/null = UNLIMITED. The controller's floor. */
  min_daily_cap: 1,
  /** SMS cost constant used by metrics (war-room-service.js SMS_COST_PER_MSG). */
  cost_per_send_usd: 0.0079,
  /**
   * PATCH fields the controller may ever write. Everything else is out of its
   * action space: status (lifecycle route only, rc-7.1 D9 rejects it),
   * batch_max/market_cap/per_sender_cap (they feed the shared global queue
   * rails, last writer wins), total_cap (operator intent), auto_* flags,
   * emergency_stop_at, targeting.
   */
  patch_fields_allowed: ["daily_cap", "contact_window_start", "contact_window_end"],
  /** Lifecycle actions the controller may ever propose. No activate/resume/schedule/complete/archive. */
  lifecycle_actions_allowed: ["pause"],
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function minutesOf(hhmm) {
  const match = HHMM.exec(String(hhmm ?? ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Validate an injected snapshot. Returns { ok, problems }. */
export function validateGuardrails(g) {
  const problems = [];
  if (!g || typeof g !== "object") return { ok: false, problems: ["guardrails missing"] };
  if (g.schema !== GUARDRAILS_SCHEMA) problems.push("schema");
  const posInt = (v) => Number.isInteger(v) && v > 0;
  if (!posInt(g.run_size_clamp) || g.run_size_clamp > 50) problems.push("run_size_clamp must be an integer in 1..50");
  if (!posInt(g.per_number_daily_limit)) problems.push("per_number_daily_limit");
  if (!posInt(g.min_daily_cap)) problems.push("min_daily_cap must be a positive integer (0 = unlimited in the feeder)");
  const start = minutesOf(g.contact_window?.start);
  const end = minutesOf(g.contact_window?.end);
  const floor = minutesOf(DEFAULT_DETERMINISTIC_LIMITS.contact_window.start);
  const ceiling = minutesOf(DEFAULT_DETERMINISTIC_LIMITS.contact_window.end);
  if (start === null || end === null || start >= end || start < floor || end > ceiling) {
    problems.push("contact_window must be HH:MM inside 08:00-21:00");
  }
  if (!(Number(g.cost_per_send_usd) > 0)) problems.push("cost_per_send_usd");
  const allowedPatch = new Set(DEFAULT_DETERMINISTIC_LIMITS.patch_fields_allowed);
  if (!Array.isArray(g.patch_fields_allowed) || g.patch_fields_allowed.some((f) => !allowedPatch.has(f))) {
    problems.push("patch_fields_allowed may only narrow the default set");
  }
  const allowedLifecycle = new Set(DEFAULT_DETERMINISTIC_LIMITS.lifecycle_actions_allowed);
  if (!Array.isArray(g.lifecycle_actions_allowed) || g.lifecycle_actions_allowed.some((a) => !allowedLifecycle.has(a))) {
    problems.push("lifecycle_actions_allowed may only narrow the default set");
  }
  return { ok: problems.length === 0, problems };
}

/** Lifecycle authority adapter: the real state machine, never a copy. */
export const lifecycleAuthority = Object.freeze({
  states: CAMPAIGN_STATES,
  isKnownStatus(raw) {
    const value = String(raw ?? "").trim().toLowerCase();
    return CAMPAIGN_STATES.includes(value) || normalizeCampaignStatus(value) !== "draft" || value === "draft";
  },
  normalize: normalizeCampaignStatus,
  isLive(raw) {
    return LIVE_CAMPAIGN_STATES.has(String(raw ?? "").trim().toLowerCase());
  },
  canPause(raw) {
    const from = normalizeCampaignStatus(raw);
    return from !== "paused" && isTransitionAllowed(from, "paused");
  },
});
