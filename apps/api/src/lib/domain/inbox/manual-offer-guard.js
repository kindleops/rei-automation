// ─── manual-offer-guard.js ──────────────────────────────────────────────────
// MANUAL OFFER AUTHORITY GUARD (P0 2026-10-16, Hartford $315K).
//
// WHY THIS EXISTS
//   The ceiling / MAO invariants exist only on AUTOMATED paths
//   (autonomy-invariants.js OFFER_EXCEEDS_CEILING, seller-autopilot-v2.js
//   OFFER_ABOVE_MAO, offerReadiness.js). A message typed in the inbox composer
//   goes through createInboxSendNowQueueRow, whose only warning codes are
//   compliance degradation, the provider blacklist pair and recent delivery
//   failures. Nothing compared a dollar figure in a manual body with the
//   engine's authorized ceiling or valuation, so "$315K" went out on a property
//   whose authorized ceiling was $126.1K.
//
// WHAT IT DOES
//   When the guard mode (system_control `manual_offer_guard_mode`) is
//   `enforce`, a manual body that names a dollar amount is checked against the
//   property's Decision Engine row (property_acquisition_scores). If the amount
//   exceeds the authorized ceiling (MAO), the valuation high, or the valuation
//   is too weak to support any number, the send is REFUSED unless the request
//   carries an explicit operator override { reason, approval_ref, operator_id }.
//   The override is recorded on the send_queue row and on the operator action.
//   `shadow` records the verdict and never refuses. Anything else (absent row,
//   `off`, unreadable value) is OFF: no read beyond the mode, no metadata, no
//   warning code, behaviour identical to the pre-guard path.
//
// WHAT IT IS NOT
//   • It never modifies a historical offer or queue row. It runs only on a new
//     manual action, before the queue insert.
//   • The generic `operator_override` / `force` booleans do NOT satisfy it.
//     Only a complete override object does.
//   • It does not parse seller text and never writes a price anywhere.

import { authoritativeMaxOffer, evaluateOfferReadiness, OFFER_READY_PROJECTION } from "@/lib/acquisition/offerReadiness.js";

export const MANUAL_OFFER_GUARD_VERSION = "manual_offer_guard_v1";
export const MANUAL_OFFER_GUARD_MODE_KEY = "manual_offer_guard_mode";
export const MANUAL_OFFER_GUARD_MODES = Object.freeze({ OFF: "off", SHADOW: "shadow", ENFORCE: "enforce" });

// Below this an amount is an EMD, a fee or a repair figure, never a purchase price.
export const MIN_OFFER_AMOUNT = 10_000;
// A valuation this weak cannot support ANY manual number without an override.
export const MIN_VALUATION_CONFIDENCE = 50;
export const MIN_OVERRIDE_REASON_LENGTH = 12;

export const MANUAL_OFFER_VIOLATIONS = Object.freeze({
  NO_PROPERTY: "no_property_context",
  SCORE_UNAVAILABLE: "decision_score_unavailable",
  NO_CEILING: "no_authorized_ceiling",
  EXCEEDS_CEILING: "exceeds_authorized_ceiling",
  EXCEEDS_VALUATION_HIGH: "exceeds_valuation_high",
  LOW_VALUATION_CONFIDENCE: "valuation_confidence_below_floor",
});

export const MANUAL_OFFER_REFUSAL_REASON = "manual_offer_exceeds_authority";
export const MANUAL_OFFER_OVERRIDE_WARNING = "manual_offer_override";
export const MANUAL_OFFER_SHADOW_WARNING = "manual_offer_exceeds_authority_shadow";

function clean(value) {
  return String(value ?? "").trim();
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function resolveManualOfferGuardMode(raw) {
  const v = clean(raw).toLowerCase();
  if (v === MANUAL_OFFER_GUARD_MODES.ENFORCE) return MANUAL_OFFER_GUARD_MODES.ENFORCE;
  if (v === MANUAL_OFFER_GUARD_MODES.SHADOW) return MANUAL_OFFER_GUARD_MODES.SHADOW;
  return MANUAL_OFFER_GUARD_MODES.OFF;
}

const SCALE = { k: 1_000, thousand: 1_000, m: 1_000_000, mm: 1_000_000, million: 1_000_000 };
// "$315K", "$315,000", "$ 315.5k", "$1.2M", "$315 thousand"
const DOLLAR_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?(k|m|mm|thousand|million)?\b/gi;
// "315k", "315 K", "1.2m" with no dollar sign
const SUFFIX_RE = /(?<![\w$.,])(\d{1,4})(?:\.(\d+))?\s?(k|m|thousand|million)\b/gi;
// "315,000" with no dollar sign (comma-grouped); a unit right after it is not money
const GROUPED_RE = /(?<![\w$.,])(\d{1,3}(?:,\d{3})+)(?:\.\d+)?(?!\s?(?:sq|sf|square|ft|feet|acre|mile|units?)\b)(?![\d,])/gi;

function toAmount(intPart, fracPart, scale) {
  const base = Number(`${String(intPart).replace(/,/g, "")}${fracPart ? `.${fracPart}` : ""}`);
  if (!Number.isFinite(base)) return null;
  const mult = scale ? SCALE[String(scale).toLowerCase()] || 1 : 1;
  return Math.round(base * mult);
}

/**
 * Every purchase-price-sized dollar amount in an OUTBOUND operator body.
 * Conservative by design: the guard compares the LARGEST amount, so naming the
 * seller's own ask ("you mentioned $380K") also needs an override. Pure.
 */
export function extractOutboundDollarAmounts(body = "") {
  const text = String(body ?? "");
  const found = [];
  for (const re of [DOLLAR_RE, SUFFIX_RE, GROUPED_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const amount = toAmount(m[1], re === GROUPED_RE ? null : m[2], re === GROUPED_RE ? null : m[3]);
      if (amount !== null && amount >= MIN_OFFER_AMOUNT) found.push(amount);
    }
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

/**
 * A complete explicit override, or the reason it is not one. The generic
 * operator_override / force booleans are never an override here.
 */
export function validateManualOfferOverride(raw = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "override_missing" };
  const reason = clean(raw.reason);
  const approval_ref = clean(raw.approval_ref);
  const operator_id = clean(raw.operator_id);
  const missing = [];
  if (reason.length < MIN_OVERRIDE_REASON_LENGTH) missing.push("reason");
  if (!approval_ref) missing.push("approval_ref");
  if (!operator_id) missing.push("operator_id");
  if (missing.length) return { ok: false, reason: "override_incomplete", missing };
  return { ok: true, override: { reason, approval_ref, operator_id } };
}

/** The Decision Engine bounds a manual amount is judged against. Pure. */
export function buildManualOfferBounds(score = null, { now = Date.now() } = {}) {
  if (!score) return null;
  const readiness = evaluateOfferReadiness(score, { now });
  return {
    authorized_ceiling: authoritativeMaxOffer(score),
    recommended_cash_offer: num(score.recommended_cash_offer),
    minimum_acceptable_offer: num(score.minimum_acceptable_offer),
    valuation_low: num(score.valuation_low),
    valuation_mid: num(score.valuation_mid),
    valuation_high: num(score.valuation_high),
    valuation_confidence: num(score.valuation_confidence),
    decision_tier: clean(score.decision_tier) || null,
    computed_at: score.computed_at ?? null,
    offer_ready: readiness.ready === true,
    offer_ready_reason: readiness.reason,
  };
}

/**
 * Judge the largest manual amount against the bounds. Pure.
 * @returns {{ max_amount:number|null, violations:string[] }}
 */
export function evaluateManualOfferAuthority({ amounts = [], bounds = null, property_id = null, score_error = null } = {}) {
  const V = MANUAL_OFFER_VIOLATIONS;
  const max_amount = amounts.length ? Math.max(...amounts) : null;
  if (max_amount === null) return { max_amount, violations: [] };
  if (!clean(property_id)) return { max_amount, violations: [V.NO_PROPERTY] };
  if (score_error || !bounds) return { max_amount, violations: [V.SCORE_UNAVAILABLE] };
  const violations = [];
  if (bounds.authorized_ceiling === null) violations.push(V.NO_CEILING);
  else if (max_amount > bounds.authorized_ceiling) violations.push(V.EXCEEDS_CEILING);
  if (bounds.valuation_high !== null && max_amount > bounds.valuation_high) violations.push(V.EXCEEDS_VALUATION_HIGH);
  if (bounds.valuation_confidence === null || bounds.valuation_confidence < MIN_VALUATION_CONFIDENCE) {
    violations.push(V.LOW_VALUATION_CONFIDENCE);
  }
  return { max_amount, violations };
}

const SCORE_SELECT = `${OFFER_READY_PROJECTION},minimum_acceptable_offer,valuation_low,valuation_high,valuation_confidence`;

export async function loadManualOfferScore({ property_id, supabase }) {
  const { data, error } = await supabase
    .from("property_acquisition_scores")
    .select(SCORE_SELECT)
    .eq("property_id", clean(property_id))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ...data,
    evidence: {
      offer_calculation: { effective_authorized_ceiling: data.mao ?? null },
      ...(data.evidence_mode ? { backfill: { evidence_mode: data.evidence_mode, monetary_authority: false } } : {}),
    },
  };
}

/**
 * Run the guard for one manual send. Never throws.
 *
 * decision:
 *   off             mode off: nothing recorded, nothing changes
 *   not_applicable  no purchase-price-sized amount in the body
 *   within_authority every amount is inside the bounds
 *   refused         enforce + violation + no complete override
 *   overridden      enforce + violation + complete override (recorded)
 *   shadow_flagged  shadow + violation (recorded, never refused)
 */
export async function runManualOfferGuard({
  input = {},
  normalized = {},
  supabase = null,
  getSystemValue = async () => null,
  loadScoreImpl = loadManualOfferScore,
  now = Date.now(),
} = {}) {
  let rawMode = null;
  try {
    rawMode = await getSystemValue(MANUAL_OFFER_GUARD_MODE_KEY);
  } catch {
    rawMode = null;
  }
  const mode = resolveManualOfferGuardMode(rawMode);
  if (mode === MANUAL_OFFER_GUARD_MODES.OFF) return { mode, decision: "off", record: null };

  const amounts = extractOutboundDollarAmounts(normalized.message_body ?? input.message_body);
  if (!amounts.length) return { mode, decision: "not_applicable", record: null };

  const property_id = clean(normalized.property_id || input.property_id) || null;
  let score = null;
  let score_error = null;
  if (property_id && supabase) {
    try {
      score = await loadScoreImpl({ property_id, supabase });
    } catch (error) {
      score_error = clean(error?.message) || "score_lookup_failed";
    }
  } else if (property_id) {
    score_error = "missing_supabase";
  }
  const bounds = buildManualOfferBounds(score, { now });
  const verdict = evaluateManualOfferAuthority({ amounts, bounds, property_id, score_error });

  const raw_override = input.offer_override ?? input.metadata?.offer_override ?? null;
  const override = validateManualOfferOverride(raw_override);

  const record = {
    version: MANUAL_OFFER_GUARD_VERSION,
    mode,
    evaluated_at: new Date(typeof now === "number" ? now : Date.parse(now)).toISOString(),
    property_id,
    amounts,
    max_amount: verdict.max_amount,
    violations: verdict.violations,
    bounds,
    score_error,
    override: override.ok ? override.override : null,
  };

  if (!verdict.violations.length) return { mode, decision: "within_authority", record: { ...record, decision: "within_authority" } };
  if (mode === MANUAL_OFFER_GUARD_MODES.SHADOW) {
    return { mode, decision: "shadow_flagged", record: { ...record, decision: "shadow_flagged" }, warning_code: MANUAL_OFFER_SHADOW_WARNING };
  }
  if (!override.ok) {
    return {
      mode,
      decision: "refused",
      record: { ...record, decision: "refused", override_rejection: override.reason, override_missing_fields: override.missing || [] },
      override_rejection: override.reason,
      override_missing_fields: override.missing || [],
    };
  }
  return { mode, decision: "overridden", record: { ...record, decision: "overridden" }, warning_code: MANUAL_OFFER_OVERRIDE_WARNING, override: override.override };
}

/**
 * Provenance a seller_offers writer must carry when it records an offer that
 * was SENT under an override (e.g. an operator-offer reconcile reading the
 * queue row). Pure; never rewrites an existing offer.
 */
export function manualOfferOverrideProvenance(queueMetadata = null) {
  const g = queueMetadata?.manual_offer_guard;
  if (!g || g.decision !== "overridden" || !g.override) return null;
  return {
    manual_offer_override: {
      version: g.version,
      reason: g.override.reason,
      approval_ref: g.override.approval_ref,
      operator_id: g.override.operator_id,
      max_amount: g.max_amount,
      violations: g.violations,
      authorized_ceiling: g.bounds?.authorized_ceiling ?? null,
      evaluated_at: g.evaluated_at,
    },
  };
}

export default runManualOfferGuard;
