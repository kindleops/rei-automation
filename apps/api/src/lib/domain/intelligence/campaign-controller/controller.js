/**
 * IC8 CAMPAIGN PORTFOLIO CONTROLLER v0 -- SHADOW ONLY (brief §41-50, §210-211;
 * phase 10 prototype; architecture §9, §11 "CC").
 *
 * proposeCampaignActions(dayState, options) is PURE and deterministic: the same
 * state, envelope, guardrails, `now` and gates always give byte-identical
 * output. It returns a ranked list of PROPOSALS, each one canonical API call
 * (lifecycle pause, or a PATCH of daily_cap / contact window) or a hold. It
 * executes nothing; there is no action path in this phase.
 *
 * Order of evaluation per live campaign (first match decides the primary
 * proposal; everything evaluated is kept as evidence):
 *   1. fail closed: invalid envelope/guardrails, stale/missing/out-of-range
 *      inputs, unknown status, unresolved time zone  -> hold
 *   2. not live                                       -> hold (v0 never starts anything)
 *   3. §45 STOP (credible breach)                     -> pause (lifecycle route)
 *   4. envelope policy (market / cohort / strategy)   -> pause
 *   5. no eligible audience                           -> hold
 *   6. §45 THROTTLE (posterior-mean breach)           -> daily_cap x throttle_ratio
 *   7. uncapped or above the envelope cap             -> daily_cap = envelope max
 *   8. §46 SCALE (all conditions)                     -> daily_cap up one step
 *   9. otherwise                                      -> hold (with the scale blockers)
 * then a portfolio pass (max concurrent campaigns, total volume / budget,
 * market sender capacity) ranks campaigns by expected qualified replies minus
 * documented penalties and trims the lowest-ranked first. Exploration = 0.
 *
 * Inputs (all counts are point-in-time: events observed before as_of):
 *   dayState = {
 *     as_of,                                   ISO decision time
 *     campaigns: [{
 *       campaign_id, status, market (PROPERTY market), cohort, strategy, timezone,
 *       caps: { daily_cap, contact_window_start, contact_window_end },
 *       metrics: { as_of, recent: Counts|null, rolling: Counts, lifetime: Counts },
 *       audience: { as_of, eligible_remaining } | null,
 *       templates: [{ template_id, sends, filtered, governance_paused, blocked }] | null,
 *       review: { open_holds } | null,
 *     }],
 *     senders_by_market: { [market]: { sendable, degraded } } | null,
 *   }
 *   Counts = { sends, delivered, failed, filtered, reply_threads, opt_outs,
 *              wrong_person, qualified, engaged?, hostile? }
 * No identity fields (names, phones, emails) are read or accepted.
 */

import { IC8_DECISION_NAMESPACE, hashObject, uuidV5 } from "../util/hash.js";
import { HOUR_MS, toIso, toMs } from "../util/time.js";
import { assertReasonCodes } from "./reason-codes.js";
import { DEFAULT_DETERMINISTIC_LIMITS, lifecycleAuthority, minutesOf, validateGuardrails } from "./guardrails.js";
import { DEFAULT_ENVELOPE, validateEnvelope } from "./envelope.js";
import { DECISION_TYPE_OF, actionSpaceViolations, buildApiCall } from "./action-space.js";
import { clearlyHealthy, severityOf, shrinkByCampaign, shrinkByTemplate } from "./rates.js";

export const CONTROLLER_VERSION = "campaign_controller_v0@1";
/** Phase 10: there is no executor. This constant is the only switch and it is false. */
export const PHASE_ALLOWS_EXECUTION = false;
export const COUNT_KEYS = Object.freeze(["sends", "delivered", "failed", "filtered", "reply_threads", "opt_outs", "wrong_person", "qualified"]);
const OPTIONAL_COUNT_KEYS = Object.freeze(["engaged", "hostile"]);
const IDENTITY_FIELD_RE = /(^|_)(name|phone|email|first_name|last_name|to_phone_number|from_phone_number|thread_key)$/i;

const SAFETY = Object.freeze([
  { key: "carrier_filtering", limit: "max_carrier_filtering_rate", dir: "max", stop: "STOP_CARRIER_FILTERING_SPIKE", throttle: "THROTTLE_CARRIER_FILTERING", num: (c) => c.filtered, den: (c) => c.sends, minKey: "min_sends_for_rate" },
  { key: "opt_out", limit: "max_opt_out_rate", dir: "max", stop: "STOP_OPT_OUT_RISE", throttle: "THROTTLE_OPT_OUT", num: (c) => c.opt_outs, den: (c) => c.sends, minKey: "min_sends_for_rate" },
  { key: "delivery", limit: "min_delivery_rate", dir: "min", stop: "STOP_DELIVERY_COLLAPSE", throttle: "THROTTLE_DELIVERY_DEGRADED", num: (c) => c.delivered, den: (c) => c.delivered + c.failed, minKey: "min_sends_for_rate" },
  { key: "wrong_person", limit: "max_wrong_person_rate", dir: "max", stop: "STOP_REPLY_QUALITY_COLLAPSE", throttle: "THROTTLE_REPLY_QUALITY", num: (c) => c.wrong_person, den: (c) => c.sends, minKey: "min_sends_for_rate" },
  {
    key: "negative_reply_share",
    limit: "max_negative_reply_share",
    dir: "max",
    stop: "STOP_REPLY_QUALITY_COLLAPSE",
    throttle: "THROTTLE_REPLY_QUALITY",
    num: (c) => Math.min(c.reply_threads, c.opt_outs + c.wrong_person + (c.hostile || 0)),
    den: (c) => c.reply_threads,
    minKey: "min_reply_threads_for_quality",
  },
]);
const WINDOWS = Object.freeze(["recent", "rolling"]);
const SEVERITY_RANK = { stop: 0, policy_pause: 1, throttle: 2, policy_caps: 3, window: 4, scale: 5, hold: 6 };

const round = (x, digits = 6) => (Number.isFinite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : null);
const isPosInt = (v) => Number.isInteger(v) && v > 0;

export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim() || !tz.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function countsProblems(counts, label) {
  if (!counts || typeof counts !== "object") return [`${label}:missing`];
  const problems = [];
  for (const key of COUNT_KEYS) if (!(Number.isInteger(counts[key]) && counts[key] >= 0)) problems.push(`${label}.${key}`);
  for (const key of OPTIONAL_COUNT_KEYS) if (counts[key] !== undefined && !(Number.isInteger(counts[key]) && counts[key] >= 0)) problems.push(`${label}.${key}`);
  if (problems.length) return problems;
  for (const key of ["delivered", "failed", "filtered", "reply_threads"]) if (counts[key] > counts.sends) problems.push(`${label}.${key}>sends`);
  for (const key of ["opt_outs", "wrong_person", "qualified", ...OPTIONAL_COUNT_KEYS]) {
    if ((counts[key] || 0) > counts.reply_threads) problems.push(`${label}.${key}>reply_threads`);
  }
  return problems;
}

/** Fail-closed input check for one campaign. Returns { codes, problems }. */
function inputProblems(c, nowMs, envelope) {
  const codes = new Set();
  const problems = [];
  const maxAgeMs = envelope.evidence.max_state_age_hours * HOUR_MS;
  if (!c || typeof c !== "object" || !c.campaign_id) return { codes: ["INPUT_MISSING"], problems: ["campaign_id"] };
  for (const key of Object.keys(c)) if (IDENTITY_FIELD_RE.test(key)) problems.push(`identity field ${key} is not an accepted input`);
  if (problems.length) codes.add("INPUT_OUT_OF_RANGE");
  const status = String(c.status ?? "").trim().toLowerCase();
  if (!status || !lifecycleAuthority.isKnownStatus(status)) codes.add("CAMPAIGN_STATUS_UNKNOWN");
  if (!isValidTimeZone(c.timezone)) codes.add("TIMEZONE_UNRESOLVED");
  if (!c.market || typeof c.market !== "string") {
    codes.add("INPUT_MISSING");
    problems.push("market");
  }
  const m = c.metrics;
  if (!m || typeof m !== "object") {
    codes.add("INPUT_MISSING");
    problems.push("metrics");
  } else {
    const asOf = toMs(m.as_of);
    if (asOf === null) {
      codes.add("INPUT_MISSING");
      problems.push("metrics.as_of");
    } else if (asOf > nowMs) {
      codes.add("INPUT_OUT_OF_RANGE");
      problems.push("metrics.as_of in the future");
    } else if (nowMs - asOf > maxAgeMs) {
      codes.add("INPUT_STALE");
      problems.push("metrics.as_of");
    }
    for (const label of ["rolling", "lifetime"]) {
      const p = countsProblems(m[label], label);
      if (p.length) {
        codes.add(p.some((x) => x.endsWith(":missing")) ? "INPUT_MISSING" : "INPUT_OUT_OF_RANGE");
        problems.push(...p);
      }
    }
    if (m.recent !== null && m.recent !== undefined) {
      const p = countsProblems(m.recent, "recent");
      if (p.length) {
        codes.add("INPUT_OUT_OF_RANGE");
        problems.push(...p);
      }
    }
  }
  const caps = c.caps;
  if (!caps || typeof caps !== "object") {
    codes.add("INPUT_MISSING");
    problems.push("caps");
  } else if (caps.daily_cap !== null && caps.daily_cap !== undefined && !(Number.isInteger(caps.daily_cap) && caps.daily_cap >= 0)) {
    codes.add("INPUT_OUT_OF_RANGE");
    problems.push("caps.daily_cap");
  }
  if (c.audience) {
    const a = c.audience;
    if (!(Number.isInteger(a.eligible_remaining) && a.eligible_remaining >= 0)) {
      codes.add("INPUT_OUT_OF_RANGE");
      problems.push("audience.eligible_remaining");
    } else if (toMs(a.as_of) === null || nowMs - toMs(a.as_of) > maxAgeMs) {
      // a stale audience is unknown audience: it blocks scale, it does not hold
      problems.push("audience.stale");
    }
  }
  return { codes: [...codes].sort(), problems };
}

function windowCounts(c, window) {
  const counts = c.metrics?.[window];
  return counts && typeof counts === "object" ? counts : null;
}

/** Shrunk rate maps for every safety metric x window, and qualified on lifetime. */
function portfolioRates(evaluable, envelope) {
  const level = envelope.evidence.credible_level;
  const rates = {};
  for (const spec of SAFETY) {
    for (const window of WINDOWS) {
      const rows = [];
      for (const c of evaluable) {
        const counts = windowCounts(c, window);
        if (!counts) continue;
        const trials = spec.den(counts);
        if (trials > 0) rows.push({ market: c.market, campaign: c.campaign_id, successes: spec.num(counts), trials });
      }
      rates[`${spec.key}:${window}`] = shrinkByCampaign(rows, { level });
    }
  }
  const qRows = evaluable.filter((c) => c.metrics.lifetime.sends > 0).map((c) => ({ market: c.market, campaign: c.campaign_id, successes: c.metrics.lifetime.qualified, trials: c.metrics.lifetime.sends }));
  rates["qualified:lifetime"] = shrinkByCampaign(qRows, { level });
  for (const key of ["opt_out", "carrier_filtering", "wrong_person"]) {
    const spec = SAFETY.find((s) => s.key === key);
    const rows = evaluable.filter((c) => c.metrics.lifetime.sends > 0).map((c) => ({ market: c.market, campaign: c.campaign_id, successes: spec.num(c.metrics.lifetime), trials: c.metrics.lifetime.sends }));
    rates[`${key}:lifetime`] = shrinkByCampaign(rows, { level });
  }
  const tRows = [];
  for (const c of evaluable) {
    for (const t of Array.isArray(c.templates) ? c.templates : []) {
      if (Number.isInteger(t.sends) && t.sends > 0) tRows.push({ market: c.market, campaign: c.campaign_id, template: String(t.template_id), successes: t.filtered || 0, trials: t.sends });
    }
  }
  rates.templates = shrinkByTemplate(tRows, { level });
  return rates;
}

const pickRate = (r) => (r ? { raw: round(r.raw), mean: round(r.mean), lower: round(r.lower), upper: round(r.upper), trials: r.trials, successes: r.successes, level: r.level } : null);

function evaluateConditions(c, rates, ctx) {
  const { envelope } = ctx;
  const conditions = [];
  for (const spec of SAFETY) {
    for (const window of WINDOWS) {
      const counts = windowCounts(c, window);
      if (!counts) continue;
      const trials = spec.den(counts);
      const minTrials = envelope.evidence[spec.minKey];
      if (spec.key === "delivery" && counts.sends >= envelope.evidence.min_sends_for_rate) {
        const coverage = counts.sends ? (counts.delivered + counts.failed) / counts.sends : 0;
        if (coverage < envelope.evidence.min_resolved_share) {
          conditions.push({ condition: spec.key, window, severity: "not_evaluable", code: "DELIVERY_TELEMETRY_INCOMPLETE", coverage: round(coverage) });
          continue;
        }
      }
      if (trials < minTrials) {
        conditions.push({ condition: spec.key, window, severity: "not_evaluable", code: "INSUFFICIENT_EVIDENCE", trials });
        continue;
      }
      const rate = rates[`${spec.key}:${window}`].get(c.campaign_id);
      const limit = envelope.safety[spec.limit];
      const severity = severityOf(rate, limit, spec.dir);
      conditions.push({ condition: spec.key, window, severity, limit, rate: pickRate(rate), code: severity === "stop" ? spec.stop : severity === "throttle" ? spec.throttle : null });
    }
  }
  // template failure (market -> campaign -> template shrinkage on filtering)
  if (Array.isArray(c.templates)) {
    const active = c.templates.filter((t) => Number.isInteger(t.sends) && t.sends > 0);
    const failing = [];
    for (const t of active) {
      const rate = rates.templates.get(`${c.campaign_id}|${t.template_id}`);
      const governed = t.governance_paused === true || t.blocked === true;
      const filteringBreach = t.sends >= envelope.evidence.min_sends_for_rate && rate && rate.lower > envelope.safety.max_carrier_filtering_rate;
      if (governed || filteringBreach) failing.push({ template_id: String(t.template_id), governed, filtering: pickRate(rate) });
    }
    if (active.length) {
      const severity = failing.length === 0 ? "ok" : failing.length === active.length ? "stop" : "throttle";
      conditions.push({ condition: "template_failure", window: "recent", severity, failing, active: active.length, code: severity === "stop" ? "STOP_TEMPLATE_FAILURE" : severity === "throttle" ? "THROTTLE_TEMPLATE_FAILURE" : null });
    }
  } else {
    conditions.push({ condition: "template_failure", severity: "not_evaluable", code: null });
  }
  // sender degradation (fleet state for the campaign's PROPERTY market)
  const fleet = ctx.senders?.[c.market];
  if (fleet && Number.isInteger(fleet.sendable) && fleet.sendable >= 0) {
    const degraded = Number.isInteger(fleet.degraded) && fleet.degraded >= 0 ? fleet.degraded : 0;
    const total = fleet.sendable + degraded;
    const severity = fleet.sendable === 0 ? "stop" : degraded / total >= 0.5 ? "throttle" : "ok";
    conditions.push({ condition: "sender_degradation", severity, sendable: fleet.sendable, degraded, code: severity === "stop" ? "STOP_SENDER_DEGRADATION" : severity === "throttle" ? "THROTTLE_SENDER_DEGRADATION" : null });
  } else {
    conditions.push({ condition: "sender_degradation", severity: "not_evaluable", code: null });
  }
  // human-review burden (real review holds only; P7 placeholders excluded upstream)
  if (c.review && Number.isInteger(c.review.open_holds) && c.review.open_holds >= 0) {
    const max = envelope.safety.max_open_review_holds;
    const severity = c.review.open_holds >= 2 * max ? "stop" : c.review.open_holds >= max ? "throttle" : "ok";
    conditions.push({ condition: "human_review_burden", severity, open_holds: c.review.open_holds, limit: max, code: severity === "stop" ? "STOP_HUMAN_REVIEW_BURDEN" : severity === "throttle" ? "THROTTLE_HUMAN_REVIEW_BURDEN" : null });
  } else {
    conditions.push({ condition: "human_review_burden", severity: "not_evaluable", code: null });
  }
  return conditions;
}

function senderCapacity(c, ctx) {
  const fleet = ctx.senders?.[c.market];
  if (!fleet || !Number.isInteger(fleet.sendable) || fleet.sendable < 0) return null;
  return Math.floor(fleet.sendable * ctx.guardrails.per_number_daily_limit * ctx.envelope.senders.max_utilisation);
}

/** Expected daily volume under a cap: bounded by audience and capacity when known. */
function projectedVolume(cap, c, capacity) {
  let v = cap;
  if (Number.isFinite(capacity)) v = Math.min(v, capacity);
  const audience = c.audience?.eligible_remaining;
  if (Number.isInteger(audience)) v = Math.min(v, audience);
  return Math.max(0, v);
}

function expectedComponents(deltaSends, c, rates, envelope) {
  const q = rates["qualified:lifetime"].get(c.campaign_id);
  const oo = rates["opt_out:lifetime"].get(c.campaign_id);
  const cf = rates["carrier_filtering:lifetime"].get(c.campaign_id);
  const wp = rates["wrong_person:lifetime"].get(c.campaign_id);
  const scaled = (r) => {
    if (!r) return null;
    const a = deltaSends * r.lower;
    const b = deltaSends * r.upper;
    return { mean: round(deltaSends * r.mean, 3), lower: round(Math.min(a, b), 3), upper: round(Math.max(a, b), 3) };
  };
  const w = envelope.penalties;
  const evPerSend = q && oo && cf && wp ? q.mean - w.opt_out * oo.mean - w.carrier_filtered * cf.mean - w.wrong_person * wp.mean : null;
  const evLow = q && oo && cf && wp ? q.lower - w.opt_out * oo.upper - w.carrier_filtered * cf.upper - w.wrong_person * wp.upper : null;
  const evHigh = q && oo && cf && wp ? q.upper - w.opt_out * oo.lower - w.carrier_filtered * cf.lower - w.wrong_person * wp.lower : null;
  const net = evPerSend === null ? null : {
    mean: round(deltaSends * evPerSend, 3),
    lower: round(Math.min(deltaSends * evLow, deltaSends * evHigh), 3),
    upper: round(Math.max(deltaSends * evLow, deltaSends * evHigh), 3),
    interval: "bound_combination_not_joint",
  };
  return {
    sends_delta: deltaSends,
    credible_level: envelope.evidence.credible_level,
    qualified_replies: scaled(q),
    opt_outs: scaled(oo),
    carrier_filtered: scaled(cf),
    wrong_person: scaled(wp),
    net_value: net,
    penalty_weights: { ...w },
    ev_per_send: round(evPerSend),
    basis: "lifetime shrunk rates x volume change; logged-outcome rates, not a counterfactual estimate",
  };
}

function capOf(c) {
  return isPosInt(c.caps?.daily_cap) ? c.caps.daily_cap : null;
}

/** Build one campaign's primary proposal (before the portfolio pass). */
function decideCampaign(c, rates, ctx) {
  const { envelope, guardrails } = ctx;
  const conditions = evaluateConditions(c, rates, ctx);
  const capacity = senderCapacity(c, ctx);
  const current = capOf(c);
  const effective = current ?? envelope.volume.max_daily_per_campaign;
  const base = { conditions, capacity, current_cap: current };
  const stopCodes = [...new Set(conditions.filter((x) => x.severity === "stop").map((x) => x.code))].sort();
  const throttleCodes = [...new Set(conditions.filter((x) => x.severity === "throttle").map((x) => x.code))].sort();

  if (stopCodes.length) return { ...base, kind: "stop", action: "pause", codes: stopCodes };
  // daily_cap 0 is the operator's "send nothing" (campaign-caps.js). capOf()
  // reads it as uncapped, which would propose raising it to the envelope max
  // and so undo the operator's stop. Never raise or reshape a zero cap.
  if (c.caps?.daily_cap === 0) return { ...base, kind: "hold", action: "hold", codes: ["OPERATOR_CAP_ZERO"] };
  const policy = [];
  if (!envelope.markets.allowed.includes(c.market)) policy.push("POLICY_MARKET_NOT_ALLOWED");
  if (!envelope.cohorts.allowed.includes(String(c.cohort ?? ""))) policy.push("POLICY_COHORT_NOT_ALLOWED");
  if (!envelope.strategies.approved.includes(String(c.strategy ?? ""))) policy.push("POLICY_STRATEGY_NOT_APPROVED");
  if (policy.length) return { ...base, kind: "policy_pause", action: "pause", codes: policy };
  if (c.audience && c.audience.eligible_remaining === 0) return { ...base, kind: "hold", action: "hold", codes: ["NO_ELIGIBLE_AUDIENCE"] };

  if (throttleCodes.length) {
    const target = Math.floor(effective * envelope.volume.throttle_ratio);
    if (target < guardrails.min_daily_cap) return { ...base, kind: "stop", action: "pause", codes: [...throttleCodes, "CLAMP_MIN_DAILY_CAP"] };
    const clamps = [];
    let to = Math.min(target, envelope.volume.max_daily_per_campaign);
    if (Number.isFinite(capacity) && capacity >= guardrails.min_daily_cap && to > capacity) {
      to = capacity;
      clamps.push("CLAMP_SENDER_CAPACITY");
    }
    return { ...base, kind: "throttle", action: "set_daily_cap", to: { daily_cap: to }, codes: [...throttleCodes, ...clamps] };
  }

  if (current === null || current > envelope.volume.max_daily_per_campaign) {
    const codes = ["POLICY_DAILY_VOLUME_LIMIT", "CLAMP_ENVELOPE_CAMPAIGN_MAX"];
    if (current === null) codes.push("SCALE_BLOCKED_UNCAPPED");
    let to = envelope.volume.max_daily_per_campaign;
    if (Number.isFinite(capacity) && capacity >= guardrails.min_daily_cap && to > capacity) {
      to = capacity;
      codes.push("CLAMP_SENDER_CAPACITY");
    }
    return { ...base, kind: "policy_caps", action: "set_daily_cap", to: { daily_cap: to }, codes };
  }

  // §46 scale: ALL conditions, never on raw reply rate
  const blockers = [];
  const life = c.metrics.lifetime;
  const q = rates["qualified:lifetime"].get(c.campaign_id);
  if (life.sends < envelope.evidence.min_sends_for_scale || life.qualified < envelope.evidence.min_qualified_for_scale) blockers.push("SCALE_BLOCKED_EVIDENCE");
  else if (!q || q.lower < envelope.scale.min_qualified_rate) blockers.push("SCALE_BLOCKED_QUALIFIED_RATE");
  const healthKeys = ["carrier_filtering", "opt_out", "delivery", "wrong_person"];
  const healthy = healthKeys.every((key) => {
    const spec = SAFETY.find((s) => s.key === key);
    const cond = conditions.find((x) => x.condition === key && x.window === "rolling");
    if (!cond || cond.severity !== "ok") return false;
    return clearlyHealthy(rates[`${key}:rolling`].get(c.campaign_id), envelope.safety[spec.limit], spec.dir);
  });
  const others = conditions.filter((x) => ["template_failure", "sender_degradation", "human_review_burden"].includes(x.condition));
  if (!healthy || others.some((x) => x.severity !== "ok")) blockers.push("SCALE_BLOCKED_HEALTH");
  if (conditions.some((x) => x.code === "DELIVERY_TELEMETRY_INCOMPLETE")) blockers.push("DELIVERY_TELEMETRY_INCOMPLETE");
  const audience = c.audience && toMs(c.audience.as_of) !== null && ctx.nowMs - toMs(c.audience.as_of) <= envelope.evidence.max_state_age_hours * HOUR_MS ? c.audience.eligible_remaining : null;
  if (!Number.isFinite(capacity) || capacity <= current) blockers.push("SCALE_BLOCKED_CAPACITY");
  if (audience === null || audience <= current) blockers.push("SCALE_BLOCKED_AUDIENCE");
  if (blockers.length) return { ...base, kind: "hold", action: "hold", codes: ["HOLD_STEADY", ...[...new Set(blockers)].sort()] };

  const clamps = [];
  let to = Math.floor(current * envelope.volume.max_step_up_ratio);
  if (to <= current) to = current + 1;
  clamps.push("CLAMP_STEP");
  if (to > envelope.volume.max_daily_per_campaign) {
    to = envelope.volume.max_daily_per_campaign;
    clamps.push("CLAMP_ENVELOPE_CAMPAIGN_MAX");
  }
  if (to > capacity) {
    to = capacity;
    clamps.push("CLAMP_SENDER_CAPACITY");
  }
  if (to > audience) {
    to = audience;
    clamps.push("CLAMP_AUDIENCE");
  }
  if (to <= current) return { ...base, kind: "hold", action: "hold", codes: ["HOLD_STEADY", ...clamps] };
  return { ...base, kind: "scale", action: "set_daily_cap", to: { daily_cap: to }, codes: ["SCALE_ALL_CONDITIONS_MET", ...clamps] };
}

function windowProposal(c, envelope) {
  const s = minutesOf(c.caps?.contact_window_start);
  const e = minutesOf(c.caps?.contact_window_end);
  const es = minutesOf(envelope.contact_window.start);
  const ee = minutesOf(envelope.contact_window.end);
  // A blank/invalid campaign window is narrowed to the envelope window too.
  if (s !== null && e !== null && s >= es && e <= ee && s < e) return null;
  const toStart = s !== null && s >= es && s < ee ? c.caps.contact_window_start : envelope.contact_window.start;
  const toEnd = e !== null && e <= ee && e > es ? c.caps.contact_window_end : envelope.contact_window.end;
  if (minutesOf(toStart) >= minutesOf(toEnd)) return { contact_window_start: envelope.contact_window.start, contact_window_end: envelope.contact_window.end };
  return { contact_window_start: toStart, contact_window_end: toEnd };
}

/** Autonomy gates: would_execute is informational; nothing executes in phase 10. */
function gateOf(action, gates, envelope) {
  const blockedBy = [];
  if (gates.killSwitch.paused) blockedBy.push("KILL_SWITCH_PAUSED");
  if (!gates.autonomyEnabled) blockedBy.push("AUTONOMY_DISABLED");
  if (envelope && envelope.mode !== "autonomous") blockedBy.push("MODE_NOT_AUTONOMOUS");
  const wouldExecute = action !== "hold" && blockedBy.length === 0;
  if (!PHASE_ALLOWS_EXECUTION) blockedBy.push("SHADOW_PHASE_NO_ACTION_PATH");
  return { would_execute: wouldExecute, execution_blocked_by: blockedBy, executed: false, execution_path: null };
}

function finalizeProposal(c, decision, ctx, extra = {}) {
  const { envelope, guardrails, rates, gates } = ctx;
  const current = capOf(c);
  const from = {
    status: c?.status ?? null,
    daily_cap: c?.caps?.daily_cap ?? null,
    contact_window_start: c?.caps?.contact_window_start ?? null,
    contact_window_end: c?.caps?.contact_window_end ?? null,
  };
  let to = { ...from };
  if (decision.action === "pause") to = { ...from, status: "paused" };
  if (decision.action === "set_daily_cap") to = { ...from, daily_cap: decision.to.daily_cap };
  if (decision.action === "narrow_contact_window") to = { ...from, ...decision.to };
  const codes = assertReasonCodes([...decision.codes]);
  let proposal = {
    campaign_id: c?.campaign_id ?? null,
    action: decision.action,
    decision_type: DECISION_TYPE_OF[decision.action],
    kind: decision.kind,
    api_call: buildApiCall(decision.action, c?.campaign_id, decision.to || {}, codes[0]),
    from,
    to,
    why: codes,
    limits: { capacity: decision.capacity ?? null, envelope_max_daily_per_campaign: envelope?.volume?.max_daily_per_campaign ?? null, min_daily_cap: guardrails?.min_daily_cap ?? null },
    evidence: { conditions: decision.conditions || [], ...(decision.evidence || {}), input_problems: decision.problems || [] },
    ...extra,
  };
  if (rates && c?.metrics && decision.action !== "narrow_contact_window" && envelope) {
    const fromVol = current === null && decision.kind === "hold" ? 0 : projectedVolume(current ?? envelope.volume.max_daily_per_campaign, c, decision.capacity);
    const toVol = decision.action === "pause" ? 0 : decision.action === "set_daily_cap" ? projectedVolume(decision.to.daily_cap, c, decision.capacity) : fromVol;
    proposal.expected = expectedComponents(toVol - fromVol, c, rates, envelope);
  } else {
    proposal.expected = null;
  }
  proposal.actual = null;
  if (guardrails && envelope && proposal.action !== "hold") {
    const violations = actionSpaceViolations(proposal, { guardrails, envelope, lifecycle: lifecycleAuthority, campaign: c });
    if (violations.length) {
      const fallbackCodes = decision.action === "pause" && !lifecycleAuthority.canPause(c?.status) ? ["ALREADY_PAUSED_OR_ILLEGAL_EDGE", ...codes] : ["GUARDRAIL_REJECTED", ...codes];
      proposal = {
        ...proposal,
        action: "hold",
        decision_type: DECISION_TYPE_OF.hold,
        kind: "hold",
        api_call: null,
        to: { ...from },
        why: assertReasonCodes([...new Set(fallbackCodes)]),
        rejected: { action: decision.action, violations },
        expected: proposal.expected ? { ...proposal.expected, sends_delta: 0, note: "rejected candidate; no change" } : null,
      };
    }
  }
  Object.assign(proposal, gateOf(proposal.action, gates, envelope));
  return proposal;
}

function holdAll(campaigns, codes, ctx, problems = []) {
  return (Array.isArray(campaigns) ? campaigns : []).map((c) => finalizeProposal(c || {}, { action: "hold", kind: "hold", codes, problems }, { ...ctx, rates: null }));
}

/**
 * The controller. Pure.
 *   options: { envelope, guardrails, now (ISO/ms, required), killSwitch: {paused, reason},
 *              autonomyEnabled (default false) }
 */
export function proposeCampaignActions(dayState, options = {}) {
  const envelope = options.envelope ?? DEFAULT_ENVELOPE;
  const guardrails = options.guardrails ?? DEFAULT_DETERMINISTIC_LIMITS;
  const nowMs = toMs(options.now);
  const gates = {
    killSwitch: options.killSwitch && typeof options.killSwitch.paused === "boolean" ? options.killSwitch : { paused: true, reason: "not_provided" },
    autonomyEnabled: options.autonomyEnabled === true,
  };
  const envelopeCheck = validateEnvelope(envelope, guardrails);
  const guardrailCheck = validateGuardrails(guardrails);
  const header = {
    controller_version: CONTROLLER_VERSION,
    mode: "shadow",
    exploration_share: 0,
    as_of: toIso(dayState?.as_of),
    now: toIso(nowMs),
    envelope: { version: envelope?.version ?? null, hash: envelopeCheck.hash, valid: envelopeCheck.ok, problems: envelopeCheck.problems },
    guardrails: { version: guardrails?.version ?? null, valid: guardrailCheck.ok, problems: guardrailCheck.problems },
    gates: { kill_switch_paused: gates.killSwitch.paused, kill_switch_reason: gates.killSwitch.reason ?? null, autonomy_enabled: gates.autonomyEnabled, phase_allows_execution: PHASE_ALLOWS_EXECUTION },
  };
  const campaigns = Array.isArray(dayState?.campaigns) ? dayState.campaigns : [];
  const baseCtx = { envelope: envelopeCheck.ok ? envelope : null, guardrails: guardrailCheck.ok ? guardrails : null, gates, nowMs };
  let proposals;
  if (!guardrailCheck.ok) proposals = holdAll(campaigns, ["GUARDRAILS_INVALID"], baseCtx, guardrailCheck.problems);
  else if (!envelopeCheck.ok) proposals = holdAll(campaigns, ["ENVELOPE_INVALID"], { ...baseCtx, envelope: null }, envelopeCheck.problems);
  else if (nowMs === null || toMs(dayState?.as_of) === null || !Array.isArray(dayState?.campaigns)) proposals = holdAll(campaigns, ["INPUT_MISSING"], baseCtx, ["now/as_of/campaigns"]);
  else if (nowMs - toMs(dayState.as_of) > envelope.evidence.max_state_age_hours * HOUR_MS) proposals = holdAll(campaigns, ["INPUT_STALE"], baseCtx, ["as_of"]);
  else proposals = decidePortfolio(campaigns, dayState, { ...baseCtx, envelope, guardrails });
  proposals.sort(compareProposals);
  proposals.forEach((p, i) => {
    p.rank = i + 1;
    p.policy = { controller_version: CONTROLLER_VERSION, envelope_version: header.envelope.version, envelope_hash: header.envelope.hash, guardrails_version: header.guardrails.version };
    p.proposal_id = uuidV5(`campaign_controller:${hashObject({ c: p.campaign_id, a: p.action, to: p.to, w: p.why, as_of: header.as_of, e: header.envelope.hash })}`, IC8_DECISION_NAMESPACE);
  });
  return { ...header, proposals };
}

function compareProposals(a, b) {
  const ra = SEVERITY_RANK[a.kind] ?? 9;
  const rb = SEVERITY_RANK[b.kind] ?? 9;
  if (ra !== rb) return ra - rb;
  const na = Math.abs(a.expected?.net_value?.mean ?? 0);
  const nb = Math.abs(b.expected?.net_value?.mean ?? 0);
  if (na !== nb) return nb - na;
  const ca = String(a.campaign_id ?? "");
  const cb = String(b.campaign_id ?? "");
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.action < b.action ? -1 : a.action > b.action ? 1 : 0;
}

function decidePortfolio(campaigns, dayState, ctx) {
  const { envelope, guardrails, nowMs } = ctx;
  const out = [];
  const evaluable = [];
  const seen = new Set();
  for (const c of [...campaigns].sort((a, b) => String(a?.campaign_id).localeCompare(String(b?.campaign_id)))) {
    const { codes, problems } = inputProblems(c, nowMs, envelope);
    if (c?.campaign_id && seen.has(c.campaign_id)) {
      out.push(finalizeProposal(c, { action: "hold", kind: "hold", codes: ["INPUT_OUT_OF_RANGE"], problems: ["duplicate campaign_id"] }, { ...ctx, rates: null }));
      continue;
    }
    seen.add(c?.campaign_id);
    if (codes.length) {
      out.push(finalizeProposal(c || {}, { action: "hold", kind: "hold", codes, problems }, { ...ctx, rates: null }));
      continue;
    }
    if (!lifecycleAuthority.isLive(c.status)) {
      out.push(finalizeProposal(c, { action: "hold", kind: "hold", codes: ["NOT_LIVE_NO_ACTION"] }, { ...ctx, rates: null }));
      continue;
    }
    evaluable.push(c);
  }
  const rates = portfolioRates(evaluable, envelope);
  const fullCtx = { ...ctx, rates, senders: dayState.senders_by_market || null };
  const decisions = evaluable.map((c) => ({ c, d: decideCampaign(c, rates, fullCtx) }));
  const evOf = (c) => expectedComponents(1, c, rates, envelope).ev_per_send ?? -Infinity;
  const byEvAsc = (x, y) => evOf(x.c) - evOf(y.c) || String(x.c.campaign_id).localeCompare(String(y.c.campaign_id));

  // max concurrent: pause the lowest-ranked live campaigns beyond the limit
  const running = decisions.filter((x) => x.d.action !== "pause").sort(byEvAsc);
  const excess = running.length - envelope.volume.max_concurrent_campaigns;
  for (let i = 0; i < excess; i += 1) {
    const x = running[i];
    x.d = { ...x.d, kind: "policy_pause", action: "pause", to: undefined, codes: ["POLICY_MAX_CONCURRENT_REACHED"] };
  }

  // planned volume; scale-ups are granted last, best first
  const planned = new Map();
  for (const x of decisions) {
    if (x.d.action === "pause") continue;
    const cap = x.d.kind === "scale" ? capOf(x.c) : x.d.action === "set_daily_cap" ? x.d.to.daily_cap : capOf(x.c) ?? envelope.volume.max_daily_per_campaign;
    planned.set(x.c.campaign_id, cap);
  }
  const limit = Math.min(envelope.volume.max_daily_total, Math.floor(envelope.budget.max_daily_spend_usd / guardrails.cost_per_send_usd));
  const sum = () => [...planned.values()].reduce((a, b) => a + b, 0);
  // trim lowest-ranked first when the committed plan already exceeds the total/budget
  let over = sum() - limit;
  for (const x of decisions.filter((y) => planned.has(y.c.campaign_id)).sort(byEvAsc)) {
    if (over <= 0) break;
    const cur = planned.get(x.c.campaign_id);
    const next = Math.max(guardrails.min_daily_cap, cur - over);
    if (next >= cur) continue;
    over -= cur - next;
    planned.set(x.c.campaign_id, next);
    x.d = { ...x.d, kind: x.d.kind === "throttle" ? "throttle" : "policy_caps", action: "set_daily_cap", to: { daily_cap: next }, codes: [...new Set([...(x.d.kind === "scale" || x.d.kind === "hold" ? [] : x.d.codes), "POLICY_DAILY_VOLUME_LIMIT", "CLAMP_ENVELOPE_TOTAL_MAX"])] };
  }
  // market sender capacity: Σ planned caps per market <= capacity
  const byMarket = new Map();
  for (const x of decisions) if (planned.has(x.c.campaign_id)) byMarket.set(x.c.market, [...(byMarket.get(x.c.market) || []), x]);
  for (const [, list] of byMarket) {
    const capacity = senderCapacity(list[0].c, fullCtx);
    if (!Number.isFinite(capacity) || capacity < guardrails.min_daily_cap) continue;
    let marketOver = list.reduce((a, x) => a + planned.get(x.c.campaign_id), 0) - capacity;
    for (const x of [...list].sort(byEvAsc)) {
      if (marketOver <= 0) break;
      const cur = planned.get(x.c.campaign_id);
      const next = Math.max(guardrails.min_daily_cap, cur - marketOver);
      if (next >= cur) continue;
      marketOver -= cur - next;
      planned.set(x.c.campaign_id, next);
      x.d = { ...x.d, kind: x.d.kind === "throttle" ? "throttle" : "policy_caps", action: "set_daily_cap", to: { daily_cap: next }, codes: [...new Set([...(x.d.kind === "scale" || x.d.kind === "hold" ? [] : x.d.codes), "CLAMP_SENDER_CAPACITY"])] };
    }
  }
  // grant scale-ups best-first within the remaining total headroom
  for (const x of decisions.filter((y) => y.d.kind === "scale").sort((a, b) => -byEvAsc(a, b))) {
    const cur = planned.get(x.c.campaign_id);
    const headroom = limit - sum();
    const marketList = byMarket.get(x.c.market) || [];
    const capacity = senderCapacity(x.c, fullCtx);
    const marketHeadroom = Number.isFinite(capacity) ? capacity - marketList.reduce((a, y) => a + planned.get(y.c.campaign_id), 0) : 0;
    const grant = Math.min(x.d.to.daily_cap - cur, headroom, marketHeadroom);
    if (grant <= 0) {
      x.d = { ...x.d, kind: "hold", action: "hold", to: undefined, codes: ["HOLD_STEADY", headroom <= 0 ? "CLAMP_ENVELOPE_TOTAL_MAX" : "CLAMP_SENDER_CAPACITY"] };
      continue;
    }
    if (grant < x.d.to.daily_cap - cur) x.d = { ...x.d, to: { daily_cap: cur + grant }, codes: [...x.d.codes, headroom < marketHeadroom ? "CLAMP_ENVELOPE_TOTAL_MAX" : "CLAMP_SENDER_CAPACITY"] };
    planned.set(x.c.campaign_id, cur + grant);
  }
  for (const x of decisions) {
    out.push(finalizeProposal(x.c, x.d, fullCtx));
    if (x.d.action !== "pause") {
      const narrowed = windowProposal(x.c, envelope);
      if (narrowed) out.push(finalizeProposal(x.c, { action: "narrow_contact_window", kind: "window", to: narrowed, codes: ["POLICY_CONTACT_WINDOW"], conditions: [] }, { ...fullCtx, rates: null }));
    }
  }
  return out;
}

/** Fail-closed read of the autonomy kill switch. Absent / error / timeout / anything but "false" = paused. */
export async function readAutonomyKillSwitch(readSystemValue, { timeoutMs = 250 } = {}) {
  if (typeof readSystemValue !== "function") return { paused: true, reason: "reader_unavailable" };
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => readSystemValue("intelligence_autonomy_paused")),
      new Promise((resolve) => {
        // bounded and cleared in finally; not unref'd so a hung reader still resolves as "paused"
        timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
      }),
    ]);
    if (value && value.__timeout) return { paused: true, reason: "reader_timeout" };
    if (value === null || value === undefined) return { paused: true, reason: "absent" };
    return String(value).trim().toLowerCase() === "false" ? { paused: false, reason: "explicit_false" } : { paused: true, reason: "set" };
  } catch {
    return { paused: true, reason: "reader_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Shadow wrapper: reads the kill switch through the injected reader, then calls the pure controller. */
export async function runShadowController(dayState, { readSystemValue, autonomyEnabled = false, envelope, guardrails, now } = {}) {
  const killSwitch = await readAutonomyKillSwitch(readSystemValue);
  return proposeCampaignActions(dayState, { envelope, guardrails, now, killSwitch, autonomyEnabled });
}

/** Journal-row shape (architecture §2.5 / §5) as a plain object. Nothing is written. */
export function toJournalRows(result) {
  return result.proposals.map((p) => ({
    decision_id: p.proposal_id,
    idempotency_key: `campaign_controller:${p.campaign_id}:${result.as_of}:${p.action}`,
    decided_at: result.now,
    decision_type: p.decision_type,
    mode: "shadow",
    context: { campaign_id: p.campaign_id },
    policy_version: CONTROLLER_VERSION,
    versions: { envelope: result.envelope.version, envelope_hash: result.envelope.hash, guardrails: result.guardrails.version },
    candidates: [{ action: p.action, allowed: !p.rejected, blocked_by: p.rejected ? p.rejected.violations : [], score: p.expected?.net_value?.mean ?? null }],
    chosen_action: p.action,
    confidence: null,
    guardrails: { execution_blocked_by: p.execution_blocked_by, limits: p.limits },
    reason_codes: p.why,
    experiment: { exploration_share: 0 },
    action_ref: null,
  }));
}
