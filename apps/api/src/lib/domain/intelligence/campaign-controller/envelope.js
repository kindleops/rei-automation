/**
 * IC8 CAMPAIGN CONTROLLER v0 -- operator policy envelope (brief: campaign
 * autonomy; §43) -- schema, defaults and validator.
 *
 * The envelope is what the operator lets a controller do. It can only TIGHTEN
 * what the deterministic system already enforces (guardrails.js): a window
 * wider than 08:00-21:00, a sender utilisation above 100% of the per-number
 * limit, an exploration share above 0, an unknown field (e.g. batch_max) or a
 * wildcard allowlist is invalid -- and an invalid envelope makes the
 * controller hold every campaign (fail closed).
 *
 * Default values and where each comes from:
 *   markets            Dallas, Minneapolis: the only markets with a sendable
 *                      local sender at 2026-10-01 (audit §1.1 Q18)
 *   cohorts            the cohort kinds that have sent: map_area,
 *                      entity_graph, saved_filter
 *   strategies         ownership_check (S1): every campaign that ever sent
 *   max_opt_out_rate   0.025  operator's own rotation-control max_opt_out_rate (2.5)
 *   min_delivery_rate  0.75   operator's rotation-control min_delivery_rate (75-80)
 *   max_wrong_person   0.05   operator's rotation-control max_wrong_number_rate (5)
 *   max_filtering      0.20   audit §1.3 worked example (no operator value exists)
 *   per-campaign max   750    today's default campaign daily_cap
 *   evidence           30 sends for any rate (shrinkRates low_support); 500
 *                      sends + 5 qualified to scale (audit §1.3 power: ~5,000
 *                      sends/arm to detect an engaged-rate lift)
 *   min_qualified_rate 0.004  the S1 strict-qualified history (41 / 10,666)
 *   penalties          ranking weights in qualified-reply units; PLACEHOLDERS
 *                      pending owner sign-off, never used to pause anything
 */

import { DEFAULT_DETERMINISTIC_LIMITS, minutesOf } from "./guardrails.js";
import { hashObject } from "../util/hash.js";

export const ENVELOPE_SCHEMA = "campaign_envelope@1";
export const ENVELOPE_MODES = Object.freeze(["manual", "assisted", "autonomous"]);

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

export const DEFAULT_ENVELOPE = deepFreeze({
  schema: ENVELOPE_SCHEMA,
  version: "default-2026-10-01",
  mode: "manual",
  markets: { allowed: ["Dallas, TX", "Minneapolis, MN"] },
  cohorts: { allowed: ["map_area", "entity_graph", "saved_filter"] },
  strategies: { approved: ["ownership_check"] },
  templates: { approved_ids: null },
  senders: { approved_ids: null, max_utilisation: 0.8 },
  contact_window: { start: "08:00", end: "21:00" },
  volume: {
    max_daily_total: 1000,
    max_daily_per_campaign: 750,
    max_concurrent_campaigns: 4,
    max_step_up_ratio: 1.25,
    throttle_ratio: 0.5,
  },
  budget: { max_daily_spend_usd: 10 },
  evidence: {
    min_sends_for_rate: 30,
    min_sends_for_scale: 500,
    min_qualified_for_scale: 5,
    min_reply_threads_for_quality: 20,
    min_resolved_share: 0.8,
    credible_level: 0.9,
    max_state_age_hours: 30,
  },
  safety: {
    max_opt_out_rate: 0.025,
    max_carrier_filtering_rate: 0.2,
    min_delivery_rate: 0.75,
    max_wrong_person_rate: 0.05,
    max_negative_reply_share: 0.6,
    max_open_review_holds: 25,
  },
  scale: { min_qualified_rate: 0.004 },
  penalties: { opt_out: 0.1, carrier_filtered: 0.01, wrong_person: 0.05 },
  exploration_share: 0,
});

const SHAPE = {
  schema: "string",
  version: "string",
  mode: "string",
  markets: { allowed: "list" },
  cohorts: { allowed: "list" },
  strategies: { approved: "list" },
  templates: { approved_ids: "list_or_null" },
  senders: { approved_ids: "list_or_null", max_utilisation: "number" },
  contact_window: { start: "string", end: "string" },
  volume: { max_daily_total: "int", max_daily_per_campaign: "int", max_concurrent_campaigns: "int", max_step_up_ratio: "number", throttle_ratio: "number" },
  budget: { max_daily_spend_usd: "number" },
  evidence: {
    min_sends_for_rate: "int",
    min_sends_for_scale: "int",
    min_qualified_for_scale: "int",
    min_reply_threads_for_quality: "int",
    min_resolved_share: "number",
    credible_level: "number",
    max_state_age_hours: "number",
  },
  safety: {
    max_opt_out_rate: "number",
    max_carrier_filtering_rate: "number",
    min_delivery_rate: "number",
    max_wrong_person_rate: "number",
    max_negative_reply_share: "number",
    max_open_review_holds: "int",
  },
  scale: { min_qualified_rate: "number" },
  penalties: { opt_out: "number", carrier_filtered: "number", wrong_person: "number" },
  exploration_share: "number",
};

function checkShape(value, shape, path, problems) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${path || "envelope"} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(key in shape)) problems.push(`${path}${key}: unknown field (an envelope cannot add knobs)`);
  }
  for (const [key, type] of Object.entries(shape)) {
    const v = value[key];
    const at = `${path}${key}`;
    if (typeof type === "object") checkShape(v, type, `${at}.`, problems);
    else if (type === "string" && (typeof v !== "string" || !v.trim())) problems.push(`${at}: string required`);
    else if (type === "number" && !(typeof v === "number" && Number.isFinite(v))) problems.push(`${at}: number required`);
    else if (type === "int" && !(Number.isInteger(v) && v > 0)) problems.push(`${at}: positive integer required`);
    else if (type === "list" && !(Array.isArray(v) && v.length && v.every((s) => typeof s === "string" && s.trim() && s !== "*"))) {
      problems.push(`${at}: non-empty explicit list required (no wildcard)`);
    } else if (type === "list_or_null" && v !== null && !(Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() && s !== "*"))) {
      problems.push(`${at}: null or an explicit list`);
    }
  }
}

const inOpen01 = (v) => typeof v === "number" && v > 0 && v < 1;

/**
 * Validate an envelope against the schema AND the deterministic limits.
 * Returns { ok, problems, hash }. Never throws.
 */
export function validateEnvelope(envelope, guardrails = DEFAULT_DETERMINISTIC_LIMITS) {
  const problems = [];
  checkShape(envelope, SHAPE, "", problems);
  if (problems.length) return { ok: false, problems, hash: null };
  const e = envelope;
  if (e.schema !== ENVELOPE_SCHEMA) problems.push("schema");
  if (!ENVELOPE_MODES.includes(e.mode)) problems.push(`mode must be one of ${ENVELOPE_MODES.join("/")}`);
  // tighten-only against the deterministic system
  const start = minutesOf(e.contact_window.start);
  const end = minutesOf(e.contact_window.end);
  const gStart = minutesOf(guardrails?.contact_window?.start);
  const gEnd = minutesOf(guardrails?.contact_window?.end);
  if (start === null || end === null || start >= end) problems.push("contact_window must be HH:MM with start < end");
  else if (gStart === null || gEnd === null || start < gStart || end > gEnd) problems.push("contact_window cannot be wider than the deterministic window");
  if (!(e.senders.max_utilisation > 0 && e.senders.max_utilisation <= 1)) problems.push("senders.max_utilisation must be in (0, 1]: it scales the per-number daily limit down, never up");
  if (e.exploration_share !== 0) problems.push("exploration_share must be 0 in the shadow phase");
  for (const key of ["max_opt_out_rate", "max_carrier_filtering_rate", "min_delivery_rate", "max_wrong_person_rate", "max_negative_reply_share"]) {
    if (!inOpen01(e.safety[key])) problems.push(`safety.${key} must be in (0, 1)`);
  }
  if (!inOpen01(e.scale.min_qualified_rate)) problems.push("scale.min_qualified_rate must be in (0, 1)");
  if (!inOpen01(e.evidence.min_resolved_share)) problems.push("evidence.min_resolved_share must be in (0, 1)");
  if (!(e.evidence.credible_level >= 0.5 && e.evidence.credible_level <= 0.99)) problems.push("evidence.credible_level must be in [0.5, 0.99]");
  if (!(e.evidence.max_state_age_hours > 0 && e.evidence.max_state_age_hours <= 72)) problems.push("evidence.max_state_age_hours must be in (0, 72]");
  if (e.evidence.min_sends_for_scale < e.evidence.min_sends_for_rate) problems.push("evidence.min_sends_for_scale must be >= min_sends_for_rate");
  if (!(e.volume.max_step_up_ratio > 1 && e.volume.max_step_up_ratio <= 2)) problems.push("volume.max_step_up_ratio must be in (1, 2]");
  if (!inOpen01(e.volume.throttle_ratio)) problems.push("volume.throttle_ratio must be in (0, 1)");
  if (e.volume.max_daily_per_campaign > e.volume.max_daily_total) problems.push("volume.max_daily_per_campaign cannot exceed max_daily_total");
  if (guardrails?.min_daily_cap && e.volume.max_daily_per_campaign < guardrails.min_daily_cap) problems.push("volume.max_daily_per_campaign below the deterministic min_daily_cap");
  if (!(e.budget.max_daily_spend_usd > 0)) problems.push("budget.max_daily_spend_usd must be > 0");
  for (const [key, w] of Object.entries(e.penalties)) if (!(w >= 0)) problems.push(`penalties.${key} must be >= 0`);
  return { ok: problems.length === 0, problems, hash: problems.length ? null : hashObject(e) };
}

/** Deep-merge overrides onto the defaults (arrays replace). For tests and the replay. */
export function buildEnvelope(overrides = {}, base = DEFAULT_ENVELOPE) {
  const merge = (a, b) => {
    if (b === undefined) return a;
    if (b === null || typeof b !== "object" || Array.isArray(b) || a === null || typeof a !== "object" || Array.isArray(a)) return b;
    const out = { ...a };
    for (const key of Object.keys(b)) out[key] = merge(a[key], b[key]);
    return out;
  };
  return merge(JSON.parse(JSON.stringify(base)), overrides);
}
