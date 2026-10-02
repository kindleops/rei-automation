/**
 * IC8 CAMPAIGN CONTROLLER v0 -- the closed action space.
 *
 * A proposal is DATA describing one canonical API call. It is never executed:
 * there is no executor, no HTTP client and no database client anywhere in
 * campaign-controller/ (a test scans the sources).
 *
 *   hold                  no call (no change)
 *   pause                 POST /api/cockpit/campaigns/{id}/lifecycle {action:'pause', reason}
 *   set_daily_cap         PATCH /api/cockpit/campaigns/{id} {daily_cap}   (throttle or scale)
 *   narrow_contact_window PATCH /api/cockpit/campaigns/{id} {contact_window_start, contact_window_end}
 *
 * Status changes go ONLY through the lifecycle route (rc-7.1 D9 makes PATCH
 * reject `status`). The controller never activates, resumes, schedules,
 * completes or archives; never touches batch_max/market_cap/per_sender_cap
 * (shared global queue rails), total_cap, auto_* flags, targeting, templates,
 * senders, recipients or offers.
 */

import { CAMPAIGN_PATCH_ROUTE, LIFECYCLE_ROUTE, minutesOf } from "./guardrails.js";

export const ACTIONS = Object.freeze(["hold", "pause", "set_daily_cap", "narrow_contact_window"]);

/** Decision types (architecture §5.2). */
export const DECISION_TYPE_OF = Object.freeze({
  hold: "campaign_scale",
  pause: "campaign_pause",
  set_daily_cap: "campaign_scale",
  narrow_contact_window: "campaign_scale",
});

const path = (template, campaignId) => template.replace("{id}", encodeURIComponent(String(campaignId)));

export function buildApiCall(action, campaignId, to = {}, reasonCode = null) {
  switch (action) {
    case "hold":
      return null;
    case "pause":
      return Object.freeze({
        method: "POST",
        path: path(LIFECYCLE_ROUTE, campaignId),
        body: Object.freeze({ action: "pause", reason: `ic8_controller_shadow:${reasonCode || "unspecified"}` }),
      });
    case "set_daily_cap":
      return Object.freeze({ method: "PATCH", path: path(CAMPAIGN_PATCH_ROUTE, campaignId), body: Object.freeze({ daily_cap: to.daily_cap }) });
    case "narrow_contact_window":
      return Object.freeze({
        method: "PATCH",
        path: path(CAMPAIGN_PATCH_ROUTE, campaignId),
        body: Object.freeze({ contact_window_start: to.contact_window_start, contact_window_end: to.contact_window_end }),
      });
    default:
      throw new Error(`action outside the controller action space: ${action}`);
  }
}

/**
 * Check one proposal against the action space and the deterministic limits.
 * Returns a list of violations (empty = admissible). Pure.
 *   ctx: { guardrails, envelope, lifecycle (lifecycleAuthority), campaign }
 */
export function actionSpaceViolations(proposal, { guardrails, envelope, lifecycle, campaign }) {
  const v = [];
  if (!ACTIONS.includes(proposal?.action)) return [`action ${proposal?.action} not in action space`];
  const call = proposal.api_call;
  if (proposal.action === "hold") {
    if (call !== null) v.push("hold must carry no api call");
    return v;
  }
  if (!call || typeof call !== "object") return ["non-hold proposal without api call"];
  const id = campaign?.campaign_id;
  if (proposal.action === "pause") {
    if (call.method !== "POST" || call.path !== path(LIFECYCLE_ROUTE, id)) v.push("pause must use the lifecycle route");
    const keys = Object.keys(call.body || {});
    if (keys.join(",") !== "action,reason" || call.body.action !== "pause") v.push("pause body must be exactly {action:'pause', reason}");
    if (!guardrails.lifecycle_actions_allowed.includes("pause")) v.push("pause not allowed by guardrails");
    if (!lifecycle.canPause(campaign?.status)) v.push(`illegal lifecycle edge ${campaign?.status} -> paused`);
    return v;
  }
  if (call.method !== "PATCH" || call.path !== path(CAMPAIGN_PATCH_ROUTE, id)) v.push("caps change must use PATCH /api/cockpit/campaigns/{id}");
  const body = call.body || {};
  for (const key of Object.keys(body)) {
    if (!guardrails.patch_fields_allowed.includes(key)) v.push(`PATCH field ${key} outside the controller's caps fields`);
  }
  if ("status" in body) v.push("status is never patched (lifecycle route only)");
  if (proposal.action === "set_daily_cap") {
    const cap = body.daily_cap;
    if (Object.keys(body).join(",") !== "daily_cap") v.push("set_daily_cap writes daily_cap only");
    if (!Number.isInteger(cap) || cap < guardrails.min_daily_cap) v.push(`daily_cap ${cap} below min ${guardrails.min_daily_cap} (0/null = UNLIMITED in the feeder)`);
    if (Number.isInteger(cap) && cap > envelope.volume.max_daily_per_campaign) v.push(`daily_cap ${cap} above envelope max_daily_per_campaign`);
    if (Number.isInteger(cap) && Number.isFinite(proposal.limits?.capacity) && cap > proposal.limits.capacity) v.push(`daily_cap ${cap} above sender capacity ${proposal.limits.capacity}`);
  }
  if (proposal.action === "narrow_contact_window") {
    const s = minutesOf(body.contact_window_start);
    const e = minutesOf(body.contact_window_end);
    const gs = minutesOf(guardrails.contact_window.start);
    const ge = minutesOf(guardrails.contact_window.end);
    const es = minutesOf(envelope.contact_window.start);
    const ee = minutesOf(envelope.contact_window.end);
    if (s === null || e === null || s >= e) v.push("window must be HH:MM with start < end");
    else if (s < gs || e > ge || s < es || e > ee) v.push("window outside the deterministic or envelope window");
  }
  return v;
}
