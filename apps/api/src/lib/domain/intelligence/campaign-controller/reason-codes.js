/**
 * IC8 CAMPAIGN CONTROLLER v0 -- reason-code registry (architecture §5.1).
 *
 * Every proposal explains itself ONLY with codes from this registry plus
 * numeric evidence. No free-text rationale. An unknown code is a programming
 * error and throws (tests assert every emitted code is registered).
 *
 * kind:
 *   hold      no change (fail-closed, not live, nothing to do)
 *   stop      a §45 stop condition -> pause through the lifecycle route
 *   throttle  a §45 throttle condition -> lower daily_cap through PATCH
 *   policy    the operator envelope forbids the current state
 *   scale     §46 scale-up (all conditions met) or why scale was refused
 *   clamp     a limit that bounded a proposed value
 *   gate      why a proposal would not execute (kill switch, mode, phase)
 */

const R = (kind, summary) => Object.freeze({ kind, summary });

export const CONTROLLER_REASON_CODES = Object.freeze({
  // fail-closed holds
  INPUT_MISSING: R("hold", "a required input is absent"),
  INPUT_STALE: R("hold", "the state is older than the envelope's max_state_age_hours"),
  INPUT_OUT_OF_RANGE: R("hold", "a count/rate/value is impossible (negative, delivered > sent, ...)"),
  ENVELOPE_INVALID: R("hold", "the operator envelope failed validation"),
  GUARDRAILS_INVALID: R("hold", "the deterministic-limits snapshot failed validation"),
  CAMPAIGN_STATUS_UNKNOWN: R("hold", "the campaign status is not a lifecycle state"),
  TIMEZONE_UNRESOLVED: R("hold", "the campaign/recipient zone is blank or invalid (never defaulted)"),
  NOT_LIVE_NO_ACTION: R("hold", "the campaign is not live; v0 never starts, resumes or activates"),
  NO_ELIGIBLE_AUDIENCE: R("hold", "no eligible audience remains; nothing to allocate (feeder completes cohorts itself)"),
  HOLD_STEADY: R("hold", "healthy, but the evidence does not justify a change"),
  INSUFFICIENT_EVIDENCE: R("hold", "too few sends to evaluate a rate"),
  DELIVERY_TELEMETRY_INCOMPLETE: R("hold", "too many sends lack a delivery or failure receipt to judge delivery"),
  GUARDRAIL_REJECTED: R("hold", "a candidate proposal violated a deterministic limit and was replaced by hold"),
  ALREADY_PAUSED_OR_ILLEGAL_EDGE: R("hold", "pause is not a legal lifecycle edge from the current status"),
  // §45 stop / throttle
  STOP_DELIVERY_COLLAPSE: R("stop", "delivery rate credibly below min_delivery_rate"),
  THROTTLE_DELIVERY_DEGRADED: R("throttle", "delivery rate below min_delivery_rate (posterior mean)"),
  STOP_CARRIER_FILTERING_SPIKE: R("stop", "carrier-filtering rate credibly above max_carrier_filtering_rate"),
  THROTTLE_CARRIER_FILTERING: R("throttle", "carrier-filtering rate above the max (posterior mean)"),
  STOP_OPT_OUT_RISE: R("stop", "opt-out rate credibly above max_opt_out_rate"),
  THROTTLE_OPT_OUT: R("throttle", "opt-out rate above the max (posterior mean)"),
  STOP_TEMPLATE_FAILURE: R("stop", "every template the campaign is sending is failing or paused/blocked"),
  THROTTLE_TEMPLATE_FAILURE: R("throttle", "some templates are failing or paused/blocked"),
  STOP_SENDER_DEGRADATION: R("stop", "no healthy sender remains in the campaign's market"),
  THROTTLE_SENDER_DEGRADATION: R("throttle", "at least half of the market's senders are degraded"),
  STOP_REPLY_QUALITY_COLLAPSE: R("stop", "wrong-person rate or negative-reply share credibly above the max"),
  THROTTLE_REPLY_QUALITY: R("throttle", "wrong-person rate or negative-reply share above the max (posterior mean)"),
  STOP_HUMAN_REVIEW_BURDEN: R("stop", "open real review holds >= 2x max_open_review_holds"),
  THROTTLE_HUMAN_REVIEW_BURDEN: R("throttle", "open real review holds >= max_open_review_holds"),
  // envelope policy
  POLICY_MARKET_NOT_ALLOWED: R("policy", "the campaign's (property) market is outside the envelope"),
  POLICY_COHORT_NOT_ALLOWED: R("policy", "the campaign's cohort is outside the envelope"),
  POLICY_STRATEGY_NOT_APPROVED: R("policy", "the campaign's strategy/use case is not approved"),
  POLICY_MAX_CONCURRENT_REACHED: R("policy", "more live campaigns than max_concurrent_campaigns"),
  POLICY_DAILY_VOLUME_LIMIT: R("policy", "daily caps exceed the envelope's per-campaign / total / budget volume"),
  POLICY_CONTACT_WINDOW: R("policy", "the campaign's contact window is wider than the envelope's"),
  // §46 scale
  SCALE_ALL_CONDITIONS_MET: R("scale", "healthy delivery, strong shrunk qualified-reply rate, low opt-out, capacity and audience"),
  SCALE_BLOCKED_EVIDENCE: R("scale", "below min_sends_for_scale / min_qualified_for_scale"),
  SCALE_BLOCKED_QUALIFIED_RATE: R("scale", "qualified-reply lower bound below min_qualified_rate"),
  SCALE_BLOCKED_HEALTH: R("scale", "a delivery/filtering/opt-out/quality bound is not clearly healthy"),
  SCALE_BLOCKED_CAPACITY: R("scale", "no sender capacity above the current cap (or capacity unknown)"),
  SCALE_BLOCKED_AUDIENCE: R("scale", "no audience above the current cap (or audience unknown)"),
  SCALE_BLOCKED_UNCAPPED: R("scale", "current daily_cap is null/0 (unlimited in the feeder); clamp first"),
  // clamps
  CLAMP_ENVELOPE_CAMPAIGN_MAX: R("clamp", "bounded by envelope max_daily_per_campaign"),
  CLAMP_ENVELOPE_TOTAL_MAX: R("clamp", "bounded by envelope max_daily_total / budget"),
  CLAMP_SENDER_CAPACITY: R("clamp", "bounded by sendable senders x per-number limit x utilisation"),
  CLAMP_AUDIENCE: R("clamp", "bounded by remaining eligible audience"),
  CLAMP_STEP: R("clamp", "bounded by the envelope's max step per decision"),
  CLAMP_MIN_DAILY_CAP: R("clamp", "a throttle below min_daily_cap becomes a pause (daily_cap 0 means UNLIMITED in the feeder)"),
  // gates
  KILL_SWITCH_PAUSED: R("gate", "system_control.intelligence_autonomy_paused is absent, unreadable or not exactly false"),
  AUTONOMY_DISABLED: R("gate", "CAMPAIGN_AUTONOMY_ENABLED double gate is off"),
  MODE_NOT_AUTONOMOUS: R("gate", "envelope mode is manual/assisted"),
  SHADOW_PHASE_NO_ACTION_PATH: R("gate", "phase 10 shadow: no executor exists; nothing is ever executed"),
});

export function isReasonCode(code) {
  return Object.prototype.hasOwnProperty.call(CONTROLLER_REASON_CODES, code);
}

export function assertReasonCodes(codes) {
  for (const code of codes) {
    if (!isReasonCode(code)) throw new Error(`unregistered campaign-controller reason code: ${code}`);
  }
  return codes;
}
