// ─── negotiation-policy.js ───────────────────────────────────────────────────
// Deterministic, configurable negotiation policy for the S3–S6 loop:
//
//   • gap metrics (spec §5) — every persisted distance between seller position
//     and acquisition authority
//   • negotiation zones (spec §6) — within_authority / near_gap / moderate_gap /
//     large_gap / insufficient_confidence, with thresholds configurable by
//     asset class, market, value band and liquidity (never one global number)
//   • concession ladder (spec §13) — bounded, persisted, movement requires a
//     reason; ceiling is final
//   • underwriting sufficiency (spec §4) — deterministic minimum facts by asset
//     type before S4 may advance to S5
//   • closing-term policy (spec §11) — asset-specific timing language; never a
//     universal seven-day promise, provider-safe phrasing keys only
//
// Pure module: no I/O, no AI. All monetary authority referenced here is the
// persisted ADE snapshot; this module never invents an amount.

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════
// ASSET CLASSES + VALUE BANDS
// ═══════════════════════════════════════════════════════════════════════════

export const ASSET_CLASSES = Object.freeze({
  SFR: "sfr",
  SMALL_MULTIFAMILY: "multi_2_4",
  LARGE_MULTIFAMILY: "multi_5_plus",
  LAND: "land",
  COMMERCIAL: "commercial",
  MOBILE_HOME: "mobile_home",
});

const ASSET_CLASS_ALIASES = Object.freeze({
  sfr: ASSET_CLASSES.SFR,
  single_family: ASSET_CLASSES.SFR,
  "single family": ASSET_CLASSES.SFR,
  house: ASSET_CLASSES.SFR,
  condo: ASSET_CLASSES.SFR,
  townhouse: ASSET_CLASSES.SFR,
  townhome: ASSET_CLASSES.SFR,
  duplex: ASSET_CLASSES.SMALL_MULTIFAMILY,
  triplex: ASSET_CLASSES.SMALL_MULTIFAMILY,
  fourplex: ASSET_CLASSES.SMALL_MULTIFAMILY,
  quadplex: ASSET_CLASSES.SMALL_MULTIFAMILY,
  multi_2_4: ASSET_CLASSES.SMALL_MULTIFAMILY,
  multifamily: ASSET_CLASSES.LARGE_MULTIFAMILY,
  apartment: ASSET_CLASSES.LARGE_MULTIFAMILY,
  multi_5_plus: ASSET_CLASSES.LARGE_MULTIFAMILY,
  land: ASSET_CLASSES.LAND,
  lot: ASSET_CLASSES.LAND,
  vacant_land: ASSET_CLASSES.LAND,
  acreage: ASSET_CLASSES.LAND,
  commercial: ASSET_CLASSES.COMMERCIAL,
  retail: ASSET_CLASSES.COMMERCIAL,
  office: ASSET_CLASSES.COMMERCIAL,
  industrial: ASSET_CLASSES.COMMERCIAL,
  self_storage: ASSET_CLASSES.COMMERCIAL,
  mobile_home: ASSET_CLASSES.MOBILE_HOME,
  manufactured: ASSET_CLASSES.MOBILE_HOME,
});

export function normalizeAssetClass(input, { unitCount = null } = {}) {
  const units = num(unitCount);
  if (units !== null) {
    if (units >= 5) return ASSET_CLASSES.LARGE_MULTIFAMILY;
    if (units >= 2) return ASSET_CLASSES.SMALL_MULTIFAMILY;
  }
  const key = lower(input).replace(/[\s-]+/g, "_");
  if (ASSET_CLASS_ALIASES[key]) return ASSET_CLASS_ALIASES[key];
  for (const [alias, cls] of Object.entries(ASSET_CLASS_ALIASES)) {
    if (key && key.includes(alias)) return cls;
  }
  return ASSET_CLASSES.SFR;
}

export function resolveValueBand(referenceValue) {
  const v = num(referenceValue);
  if (v === null) return "unknown";
  if (v < 100_000) return "under_100k";
  if (v < 250_000) return "100k_250k";
  if (v < 500_000) return "250k_500k";
  return "over_500k";
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONE POLICY (spec §6) — configurable thresholds, never one global number
// ═══════════════════════════════════════════════════════════════════════════

export const NEGOTIATION_ZONES = Object.freeze({
  WITHIN_AUTHORITY: "within_authority",
  NEAR_GAP: "near_gap",
  MODERATE_GAP: "moderate_gap",
  LARGE_GAP: "large_gap",
  INSUFFICIENT_CONFIDENCE: "insufficient_confidence",
});

/**
 * Base thresholds expressed as the seller ask relative to the authorized
 * ceiling. near: ask <= ceiling * near_factor; moderate: <= moderate_factor;
 * beyond that the gap is large (alternate-strategy territory).
 */
const BASE_ZONE_FACTORS = Object.freeze({
  [ASSET_CLASSES.SFR]: { near_factor: 1.1, moderate_factor: 1.35 },
  [ASSET_CLASSES.SMALL_MULTIFAMILY]: { near_factor: 1.12, moderate_factor: 1.4 },
  [ASSET_CLASSES.LARGE_MULTIFAMILY]: { near_factor: 1.15, moderate_factor: 1.45 },
  [ASSET_CLASSES.LAND]: { near_factor: 1.2, moderate_factor: 1.6 },
  [ASSET_CLASSES.COMMERCIAL]: { near_factor: 1.15, moderate_factor: 1.45 },
  [ASSET_CLASSES.MOBILE_HOME]: { near_factor: 1.15, moderate_factor: 1.5 },
});

/** Higher-value assets get tighter percentage bands (same dollars matter more). */
const VALUE_BAND_ADJUSTMENTS = Object.freeze({
  under_100k: { near_delta: +0.05, moderate_delta: +0.1 },
  "100k_250k": { near_delta: 0, moderate_delta: 0 },
  "250k_500k": { near_delta: -0.02, moderate_delta: -0.05 },
  over_500k: { near_delta: -0.04, moderate_delta: -0.1 },
  unknown: { near_delta: 0, moderate_delta: 0 },
});

const MIN_CONFIDENCE_FOR_OFFER = 0.45;

/**
 * Resolve the deterministic negotiation policy for one deal.
 * `overrides` allows market-level configuration without code changes
 * (persisted config may be layered in by callers).
 */
export function resolveNegotiationPolicy({
  asset_class = null,
  property_type = null,
  unit_count = null,
  market = null,
  reference_value = null,
  liquidity_score = null,
  overrides = null,
} = {}) {
  const assetClass = normalizeAssetClass(asset_class || property_type, { unitCount: unit_count });
  const valueBand = resolveValueBand(reference_value);
  const base = BASE_ZONE_FACTORS[assetClass] || BASE_ZONE_FACTORS[ASSET_CLASSES.SFR];
  const adj = VALUE_BAND_ADJUSTMENTS[valueBand] || VALUE_BAND_ADJUSTMENTS.unknown;

  // Thin markets warrant tighter automated bands — less confidence the spread
  // survives resale.
  const liquidity = num(liquidity_score);
  const liquidityDelta = liquidity !== null && liquidity < 30 ? -0.05 : 0;

  const policy = {
    asset_class: assetClass,
    value_band: valueBand,
    market: lower(market) || null,
    near_gap_ceiling_factor: round2(Math.max(1.02, base.near_factor + adj.near_delta + liquidityDelta)),
    moderate_gap_ceiling_factor: round2(Math.max(1.1, base.moderate_factor + adj.moderate_delta + liquidityDelta)),
    min_valuation_confidence: MIN_CONFIDENCE_FOR_OFFER,
    // §6 within-authority: default OFF — protect the favorable deal instead of
    // automatically squeezing another concession.
    single_concession_probe_enabled: false,
    // §13 concession ladder
    concession: {
      max_monetary_turns: 3,
      // Each automated concession may move at most this share of the
      // remaining floor→ceiling authority.
      max_step_share_of_remaining: 0.5,
      // Seller must have moved at least this % of their own ask, or a new
      // material fact must exist, before we authorize another monetary move.
      min_seller_move_pct: 2,
      require_reason_for_concession: true,
    },
    // §20/§6 high-value assets route large gaps to a human instead of drip.
    human_review_value_threshold: 750_000,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };

  return policy;
}

// ═══════════════════════════════════════════════════════════════════════════
// GAP METRICS (spec §5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the full persisted gap-metric set. Every input is optional; each
 * metric is null when its inputs are unknown — metrics are never fabricated.
 */
export function computeNegotiationGapMetrics({
  current_ask = null,
  initial_ask = null,
  recommended_offer = null,
  latest_offer = null,
  initial_offer = null,
  authorized_offer_floor = null,
  authorized_offer_ceiling = null,
  arv = null,
  repair_estimate = null,
  valuation_confidence = null,
  comp_confidence = null,
} = {}) {
  const ask = num(current_ask);
  const firstAsk = num(initial_ask) ?? ask;
  const recommended = num(recommended_offer);
  const latest = num(latest_offer) ?? num(initial_offer) ?? recommended;
  const first = num(initial_offer) ?? recommended;
  const ceiling = num(authorized_offer_ceiling) ?? recommended;
  const floor = num(authorized_offer_floor);
  const arvValue = num(arv);
  const repairs = num(repair_estimate);

  const absolute_gap = ask !== null && recommended !== null ? ask - recommended : null;
  const gap_pct_of_ask = absolute_gap !== null && ask > 0 ? round2((absolute_gap / ask) * 100) : null;
  const gap_pct_of_arv = absolute_gap !== null && arvValue > 0 ? round2((absolute_gap / arvValue) * 100) : null;
  const gap_pct_of_ceiling =
    ask !== null && ceiling > 0 ? round2(((ask - ceiling) / ceiling) * 100) : null;

  const seller_concession_amount =
    firstAsk !== null && ask !== null && firstAsk > ask ? firstAsk - ask : 0;
  const seller_concession_pct =
    seller_concession_amount > 0 && firstAsk > 0
      ? round2((seller_concession_amount / firstAsk) * 100)
      : 0;

  const our_concession_amount =
    first !== null && latest !== null && latest > first ? latest - first : 0;
  const remaining_authorized_movement =
    ceiling !== null && latest !== null ? Math.max(0, ceiling - latest) : null;

  const expected_spread =
    arvValue !== null && ask !== null
      ? arvValue - (repairs ?? 0) - ask
      : null;

  const price_to_comp_variance =
    arvValue > 0 && ask !== null ? round2(((ask - arvValue) / arvValue) * 100) : null;
  const price_to_condition_variance =
    repairs !== null && arvValue > 0 ? round2((repairs / arvValue) * 100) : null;

  const confidences = [num(valuation_confidence), num(comp_confidence)].filter((v) => v !== null);
  const deal_confidence = confidences.length
    ? round2(confidences.reduce((sum, v) => sum + v, 0) / confidences.length)
    : null;

  return {
    absolute_gap,
    gap_pct_of_ask,
    gap_pct_of_arv,
    gap_pct_of_ceiling,
    seller_concession_amount,
    seller_concession_pct,
    our_concession_amount,
    remaining_authorized_movement,
    price_to_comp_variance,
    price_to_condition_variance,
    expected_spread,
    deal_confidence,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONE CLASSIFICATION (spec §6)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Classify the deal into exactly one deterministic negotiation zone.
 * A usable ask + persisted authority is required for any monetary zone; a
 * missing or low-confidence valuation always resolves INSUFFICIENT_CONFIDENCE
 * (never a fabricated offer).
 */
export function classifyNegotiationZone({
  current_ask = null,
  recommended_offer = null,
  authorized_offer_ceiling = null,
  valuation_confidence = null,
  asking_price_confidence = null,
  policy = null,
} = {}) {
  const p = policy || resolveNegotiationPolicy({});
  const ask = num(current_ask);
  const recommended = num(recommended_offer);
  const ceiling = num(authorized_offer_ceiling) ?? recommended;
  const confidence = num(valuation_confidence);
  const askConfidence = num(asking_price_confidence);

  if (
    recommended === null ||
    ceiling === null ||
    (confidence !== null && confidence < p.min_valuation_confidence)
  ) {
    return {
      zone: NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE,
      reason_code:
        recommended === null || ceiling === null
          ? "NO_PERSISTED_AUTHORITY"
          : "VALUATION_CONFIDENCE_BELOW_POLICY",
    };
  }

  if (ask === null) {
    return { zone: NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE, reason_code: "NO_CURRENT_ASK" };
  }

  // A low-confidence monetary extraction must clarify, not drive an offer (§3).
  if (askConfidence !== null && askConfidence < 0.5) {
    return { zone: NEGOTIATION_ZONES.INSUFFICIENT_CONFIDENCE, reason_code: "ASK_EXTRACTION_LOW_CONFIDENCE" };
  }

  if (ask <= ceiling) {
    return { zone: NEGOTIATION_ZONES.WITHIN_AUTHORITY, reason_code: "ASK_AT_OR_BELOW_CEILING" };
  }
  if (ask <= ceiling * p.near_gap_ceiling_factor) {
    return { zone: NEGOTIATION_ZONES.NEAR_GAP, reason_code: "ASK_WITHIN_NEAR_FACTOR" };
  }
  if (ask <= ceiling * p.moderate_gap_ceiling_factor) {
    return { zone: NEGOTIATION_ZONES.MODERATE_GAP, reason_code: "ASK_WITHIN_MODERATE_FACTOR" };
  }
  return { zone: NEGOTIATION_ZONES.LARGE_GAP, reason_code: "ASK_BEYOND_MODERATE_FACTOR" };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONCESSION LADDER (spec §13)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decide whether another automated monetary move is permitted and, if so, the
 * maximum authorized amount. Never exceeds the ceiling; never moves without a
 * qualifying reason; never auto-raises after a bare rejection.
 */
export function evaluateConcession({
  negotiation_state = null,
  policy = null,
  new_material_fact = false,
  seller_moved_amount = 0,
  improved_terms = false,
} = {}) {
  const p = policy || resolveNegotiationPolicy({});
  const state = negotiation_state || {};
  const ceiling = num(state.authorized_offer_ceiling);
  const latest = num(state.latest_offer) ?? num(state.initial_offer);
  const ask = num(state.current_asking_price ?? state.current_ask);
  const turns = Array.isArray(state.offers_made) ? state.offers_made.length : num(state.offers_made) ?? 0;

  if (ceiling === null || latest === null) {
    return { allowed: false, reason_code: "NO_PERSISTED_AUTHORITY", amount: null, is_final: false };
  }
  if (latest >= ceiling) {
    return { allowed: false, reason_code: "CEILING_REACHED", amount: null, is_final: true };
  }
  if (turns >= p.concession.max_monetary_turns) {
    return { allowed: false, reason_code: "MAX_MONETARY_TURNS_REACHED", amount: null, is_final: true };
  }

  const askMoves = num(state.initial_asking_price ?? state.initial_ask);
  const sellerMovePct =
    seller_moved_amount > 0 && askMoves > 0 ? (seller_moved_amount / askMoves) * 100 : 0;
  const qualifies =
    Boolean(new_material_fact) ||
    Boolean(improved_terms) ||
    sellerMovePct >= p.concession.min_seller_move_pct;

  if (p.concession.require_reason_for_concession && !qualifies) {
    return { allowed: false, reason_code: "NO_QUALIFYING_MOVEMENT_OR_FACT", amount: null, is_final: false };
  }

  const remaining = ceiling - latest;
  const step = Math.max(500, Math.round(remaining * p.concession.max_step_share_of_remaining));
  let amount = Math.min(ceiling, latest + step);
  // Never offer more than the seller is asking (§6 within-authority guard).
  if (ask !== null && amount > ask) amount = ask;
  const is_final = amount >= ceiling;

  return {
    allowed: amount > latest,
    reason_code: qualifies ? "CONCESSION_AUTHORIZED" : "NO_MOVEMENT_REQUIRED",
    amount: amount > latest ? amount : null,
    is_final,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// UNDERWRITING SUFFICIENCY (spec §4)
// ═══════════════════════════════════════════════════════════════════════════

const CONDITION_FACT_KEYS = ["condition_level", "rehab_level", "condition_summary", "repairs_summary"];

/**
 * Deterministic minimum underwriting requirements by asset type. When reliable
 * internal data already covers a requirement (ADE valuation confidence, comp
 * count), the seller is not forced through unnecessary questions.
 */
export function evaluateUnderwritingSufficiency({
  asset_class = null,
  property_type = null,
  unit_count = null,
  facts = {},
  ade_snapshot = null,
  policy = null,
} = {}) {
  const assetClass = normalizeAssetClass(asset_class || property_type, { unitCount: unit_count });
  const p = policy || resolveNegotiationPolicy({ asset_class: assetClass });
  const missing = [];

  const askKnown = num(facts?.asking_price?.value ?? facts?.asking_price) !== null;
  if (!askKnown && facts?.wants_offer !== true) missing.push("asking_price");

  const valuationConfidence = num(ade_snapshot?.valuation_confidence);
  const compCount = num(ade_snapshot?.comp_count) ?? 0;
  const valuationReliable =
    valuationConfidence !== null && valuationConfidence >= p.min_valuation_confidence && compCount >= 3;

  const occupancy = lower(facts?.occupancy_status || facts?.occupancy);
  const occupancyKnown = Boolean(occupancy && occupancy !== "unknown");
  const conditionKnown =
    CONDITION_FACT_KEYS.some((key) => String(facts?.[key] ?? "").trim()) ||
    facts?.repairs_needed === false ||
    facts?.condition_disclosed === true;

  switch (assetClass) {
    case ASSET_CLASSES.LAND:
      // Land has no interior condition; valuation confidence carries it.
      if (!valuationReliable) missing.push("valuation_confidence");
      break;
    case ASSET_CLASSES.LARGE_MULTIFAMILY:
      if (!occupancyKnown) missing.push("occupancy_status");
      if (!num(facts?.unit_count ?? unit_count)) missing.push("unit_count");
      if (!facts?.rents_summary && !facts?.rent_roll_known) missing.push("rents_summary");
      if (!valuationReliable && !conditionKnown) missing.push("condition_summary");
      break;
    case ASSET_CLASSES.SMALL_MULTIFAMILY:
      if (!occupancyKnown) missing.push("occupancy_status");
      if (!num(facts?.unit_count ?? unit_count)) missing.push("unit_count");
      if (!conditionKnown && !valuationReliable) missing.push("condition_summary");
      break;
    case ASSET_CLASSES.COMMERCIAL:
      // Commercial always needs human-grade underwriting review.
      missing.push("commercial_review");
      break;
    default:
      // SFR / mobile home: occupancy plus condition, unless the internal
      // valuation is already reliable enough to price without them.
      if (!valuationReliable) {
        if (!occupancyKnown) missing.push("occupancy_status");
        if (!conditionKnown) missing.push("condition_summary");
      }
      break;
  }

  return {
    asset_class: assetClass,
    sufficient: missing.length === 0,
    missing_facts: missing,
    valuation_reliable: valuationReliable,
    // The highest-value question to ask next, when facts are still needed.
    next_discovery:
      missing.find((m) => m === "occupancy_status") ||
      missing.find((m) => m !== "asking_price") ||
      null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLOSING-TERM POLICY (spec §11)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Provider-safe closing-language policy by asset class and deal flags.
 * Timing commitments are keys, not promises — templates may only use language
 * mapped from the returned keys, and nothing here authorizes a calendar-day
 * guarantee.
 */
export function resolveClosingTermPolicy({
  asset_class = null,
  property_type = null,
  unit_count = null,
  occupancy = null,
  title_flags = null,
  probate = false,
  structured_terms = false,
} = {}) {
  const assetClass = normalizeAssetClass(asset_class || property_type, { unitCount: unit_count });
  const tenantOccupied = lower(occupancy).includes("tenant");
  const titleIssue = Boolean(title_flags && (title_flags.issue || title_flags.lien || title_flags.dispute));

  let timing_commitment = "title_ready"; // close once title requirements are complete
  const language_keys = ["purchase_directly", "purchase_as_is", "no_repairs_before_closing", "handle_customary_closing_costs"];

  if (probate || titleIssue) {
    timing_commitment = "title_resolution_dependent";
  } else if (structured_terms) {
    timing_commitment = "terms_dependent";
  } else if (tenantOccupied) {
    timing_commitment = "tenant_coordination_dependent";
  } else if (assetClass === ASSET_CLASSES.LARGE_MULTIFAMILY || assetClass === ASSET_CLASSES.COMMERCIAL) {
    timing_commitment = "diligence_dependent";
  } else if (assetClass === ASSET_CLASSES.LAND) {
    timing_commitment = "title_ready";
  }

  language_keys.push("work_around_seller_timing");

  return {
    asset_class: assetClass,
    timing_commitment,
    language_keys,
    // Explicitly prohibited claims for automated sends.
    prohibited_claims: ["seven_day_close", "guaranteed_close_date", "cash_wording_repetition"],
  };
}

export default {
  ASSET_CLASSES,
  NEGOTIATION_ZONES,
  normalizeAssetClass,
  resolveValueBand,
  resolveNegotiationPolicy,
  computeNegotiationGapMetrics,
  classifyNegotiationZone,
  evaluateConcession,
  evaluateUnderwritingSufficiency,
  resolveClosingTermPolicy,
};
