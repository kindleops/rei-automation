/**
 * Acquisition Engine V3 — model constants.
 *
 * Pure constants + a few tiny numeric helpers shared by the V3 modules.
 * No I/O, no Date.now, no randomness — deterministic by construction.
 *
 * See docs/backend/acquisition_engine_v3_audit.md for the evidence behind
 * these thresholds (the $332.5M Austin duplex and $30.19M Caldwell anomalies).
 */

export const ENGINE_VERSION = 'acq-v3';
export const FORMULA_VERSION = 'v3.0.0-stage1-anomaly-defense';

/* -------------------------------------------------------------------------- */
/* Canonical asset lanes (mission §1)                                          */
/* -------------------------------------------------------------------------- */

export const ASSET_LANES = Object.freeze({
  SFR: 'SFR',
  CONDO: 'CONDO',
  TOWNHOME: 'TOWNHOME',
  DUPLEX: 'DUPLEX',
  TRIPLEX: 'TRIPLEX',
  FOURPLEX: 'FOURPLEX',
  MULTIFAMILY_5_20: 'MULTIFAMILY_5_20',
  MULTIFAMILY_21_99: 'MULTIFAMILY_21_99',
  MULTIFAMILY_100_PLUS: 'MULTIFAMILY_100_PLUS',
  SELF_STORAGE: 'SELF_STORAGE',
  RETAIL_SINGLE_TENANT: 'RETAIL_SINGLE_TENANT',
  RETAIL_STRIP_CENTER: 'RETAIL_STRIP_CENTER',
  OFFICE_GENERAL: 'OFFICE_GENERAL',
  OFFICE_MEDICAL: 'OFFICE_MEDICAL',
  INDUSTRIAL_WAREHOUSE: 'INDUSTRIAL_WAREHOUSE',
  INDUSTRIAL_FLEX: 'INDUSTRIAL_FLEX',
  HOSPITALITY: 'HOSPITALITY',
  MOBILE_HOME_PARK: 'MOBILE_HOME_PARK',
  LAND_RESIDENTIAL: 'LAND_RESIDENTIAL',
  LAND_COMMERCIAL: 'LAND_COMMERCIAL',
  LAND_AGRICULTURAL: 'LAND_AGRICULTURAL',
  MIXED_USE: 'MIXED_USE',
  SPECIAL_PURPOSE: 'SPECIAL_PURPOSE',
  PORTFOLIO: 'PORTFOLIO',
  UNKNOWN: 'UNKNOWN',
});

export const ASSET_FAMILIES = Object.freeze({
  RESIDENTIAL_SINGLE: 'RESIDENTIAL_SINGLE', // SFR / CONDO / TOWNHOME
  SMALL_MULTI: 'SMALL_MULTI', // duplex / triplex / fourplex
  MULTIFAMILY: 'MULTIFAMILY', // 5+ units, income asset
  COMMERCIAL: 'COMMERCIAL',
  LAND: 'LAND',
  SPECIAL: 'SPECIAL',
  UNKNOWN: 'UNKNOWN',
});

export const LANE_FAMILY = Object.freeze({
  SFR: ASSET_FAMILIES.RESIDENTIAL_SINGLE,
  CONDO: ASSET_FAMILIES.RESIDENTIAL_SINGLE,
  TOWNHOME: ASSET_FAMILIES.RESIDENTIAL_SINGLE,
  DUPLEX: ASSET_FAMILIES.SMALL_MULTI,
  TRIPLEX: ASSET_FAMILIES.SMALL_MULTI,
  FOURPLEX: ASSET_FAMILIES.SMALL_MULTI,
  MULTIFAMILY_5_20: ASSET_FAMILIES.MULTIFAMILY,
  MULTIFAMILY_21_99: ASSET_FAMILIES.MULTIFAMILY,
  MULTIFAMILY_100_PLUS: ASSET_FAMILIES.MULTIFAMILY,
  SELF_STORAGE: ASSET_FAMILIES.COMMERCIAL,
  RETAIL_SINGLE_TENANT: ASSET_FAMILIES.COMMERCIAL,
  RETAIL_STRIP_CENTER: ASSET_FAMILIES.COMMERCIAL,
  OFFICE_GENERAL: ASSET_FAMILIES.COMMERCIAL,
  OFFICE_MEDICAL: ASSET_FAMILIES.COMMERCIAL,
  INDUSTRIAL_WAREHOUSE: ASSET_FAMILIES.COMMERCIAL,
  INDUSTRIAL_FLEX: ASSET_FAMILIES.COMMERCIAL,
  HOSPITALITY: ASSET_FAMILIES.COMMERCIAL,
  MOBILE_HOME_PARK: ASSET_FAMILIES.COMMERCIAL,
  LAND_RESIDENTIAL: ASSET_FAMILIES.LAND,
  LAND_COMMERCIAL: ASSET_FAMILIES.LAND,
  LAND_AGRICULTURAL: ASSET_FAMILIES.LAND,
  MIXED_USE: ASSET_FAMILIES.COMMERCIAL,
  SPECIAL_PURPOSE: ASSET_FAMILIES.SPECIAL,
  PORTFOLIO: ASSET_FAMILIES.SPECIAL,
  UNKNOWN: ASSET_FAMILIES.UNKNOWN,
});

/** Primary valuation methodology per lane (mission §11). */
export const VALUATION_METHOD = Object.freeze({
  SALES_COMPARISON: 'SALES_COMPARISON',
  SMALL_MULTI: 'SMALL_MULTI', // PPU/PPSF + GRM corroboration
  INCOME: 'INCOME', // NOI / cap rate primary
  LAND: 'LAND', // price per acre / buildable sqft
  SPECIAL: 'SPECIAL',
  NONE: 'NONE',
});

export const LANE_METHOD = Object.freeze({
  SFR: VALUATION_METHOD.SALES_COMPARISON,
  CONDO: VALUATION_METHOD.SALES_COMPARISON,
  TOWNHOME: VALUATION_METHOD.SALES_COMPARISON,
  DUPLEX: VALUATION_METHOD.SMALL_MULTI,
  TRIPLEX: VALUATION_METHOD.SMALL_MULTI,
  FOURPLEX: VALUATION_METHOD.SMALL_MULTI,
  MULTIFAMILY_5_20: VALUATION_METHOD.INCOME,
  MULTIFAMILY_21_99: VALUATION_METHOD.INCOME,
  MULTIFAMILY_100_PLUS: VALUATION_METHOD.INCOME,
  SELF_STORAGE: VALUATION_METHOD.INCOME,
  RETAIL_SINGLE_TENANT: VALUATION_METHOD.INCOME,
  RETAIL_STRIP_CENTER: VALUATION_METHOD.INCOME,
  OFFICE_GENERAL: VALUATION_METHOD.INCOME,
  OFFICE_MEDICAL: VALUATION_METHOD.INCOME,
  INDUSTRIAL_WAREHOUSE: VALUATION_METHOD.INCOME,
  INDUSTRIAL_FLEX: VALUATION_METHOD.INCOME,
  HOSPITALITY: VALUATION_METHOD.INCOME,
  MOBILE_HOME_PARK: VALUATION_METHOD.INCOME,
  LAND_RESIDENTIAL: VALUATION_METHOD.LAND,
  LAND_COMMERCIAL: VALUATION_METHOD.LAND,
  LAND_AGRICULTURAL: VALUATION_METHOD.LAND,
  MIXED_USE: VALUATION_METHOD.INCOME,
  SPECIAL_PURPOSE: VALUATION_METHOD.SPECIAL,
  PORTFOLIO: VALUATION_METHOD.SPECIAL,
  UNKNOWN: VALUATION_METHOD.NONE,
});

/**
 * Compatibility fallbacks for comp eligibility (mission §1, §7).
 * Primary eligibility ALWAYS requires an exact lane match. These are the only
 * permitted fallbacks, each carrying a confidence penalty applied downstream.
 * Crucially: DUPLEX/TRIPLEX/FOURPLEX are NOT compatible with MULTIFAMILY_5+,
 * and condo/townhome do NOT fall back to SFR by default.
 */
export const LANE_FALLBACKS = Object.freeze({
  SFR: [],
  CONDO: [ASSET_LANES.TOWNHOME],
  TOWNHOME: [ASSET_LANES.CONDO],
  DUPLEX: [ASSET_LANES.TRIPLEX],
  TRIPLEX: [ASSET_LANES.DUPLEX, ASSET_LANES.FOURPLEX],
  FOURPLEX: [ASSET_LANES.TRIPLEX],
  MULTIFAMILY_5_20: [ASSET_LANES.MULTIFAMILY_21_99],
  MULTIFAMILY_21_99: [ASSET_LANES.MULTIFAMILY_5_20, ASSET_LANES.MULTIFAMILY_100_PLUS],
  MULTIFAMILY_100_PLUS: [ASSET_LANES.MULTIFAMILY_21_99],
  OFFICE_MEDICAL: [ASSET_LANES.OFFICE_GENERAL],
  INDUSTRIAL_FLEX: [ASSET_LANES.INDUSTRIAL_WAREHOUSE],
  LAND_RESIDENTIAL: [ASSET_LANES.LAND_COMMERCIAL],
  LAND_COMMERCIAL: [ASSET_LANES.LAND_RESIDENTIAL],
});

/* -------------------------------------------------------------------------- */
/* Plausibility bounds (independent of comps — mission §4)                     */
/* -------------------------------------------------------------------------- */

/** Per-family price-per-building-sqft sane bounds (USD/sqft). null = skip. */
export const FAMILY_PPSF_BOUNDS = Object.freeze({
  RESIDENTIAL_SINGLE: { min: 15, max: 2_000 },
  SMALL_MULTI: { min: 15, max: 1_500 },
  MULTIFAMILY: { min: 20, max: 1_200 },
  COMMERCIAL: { min: 8, max: 3_000 },
  LAND: null,
  SPECIAL: null,
  UNKNOWN: null,
});

/** Per-family price-per-unit sane bounds (USD/unit) for multi-unit assets. */
export const FAMILY_PPU_BOUNDS = Object.freeze({
  SMALL_MULTI: { min: 20_000, max: 5_000_000 },
  MULTIFAMILY: { min: 20_000, max: 5_000_000 },
});

/**
 * Absolute per-asset price ceilings (USD). Deliberately generous — these exist
 * only to catch package/sentinel considerations broadcast onto small assets,
 * not to value anything. A duplex never trades for $332.5M; an SFR never for
 * $1.03B. Above this for the lane ⇒ quarantine.
 */
export const LANE_PRICE_CEILING_USD = Object.freeze({
  SFR: 30_000_000,
  CONDO: 25_000_000,
  TOWNHOME: 25_000_000,
  DUPLEX: 8_000_000,
  TRIPLEX: 10_000_000,
  FOURPLEX: 12_000_000,
  MULTIFAMILY_5_20: 60_000_000,
  MULTIFAMILY_21_99: 300_000_000,
  MULTIFAMILY_100_PLUS: 2_000_000_000,
  SELF_STORAGE: 200_000_000,
  RETAIL_SINGLE_TENANT: 100_000_000,
  RETAIL_STRIP_CENTER: 300_000_000,
  OFFICE_GENERAL: 500_000_000,
  OFFICE_MEDICAL: 500_000_000,
  INDUSTRIAL_WAREHOUSE: 500_000_000,
  INDUSTRIAL_FLEX: 300_000_000,
  HOSPITALITY: 1_000_000_000,
  MOBILE_HOME_PARK: 200_000_000,
  LAND_RESIDENTIAL: 100_000_000,
  LAND_COMMERCIAL: 300_000_000,
  LAND_AGRICULTURAL: 200_000_000,
  MIXED_USE: 300_000_000,
  SPECIAL_PURPOSE: 100_000_000,
  PORTFOLIO: 5_000_000_000,
  UNKNOWN: 30_000_000,
});

/** A single comp this many× above the subject anchor is implausible as a comp. */
export const COMP_ANCHOR_MAX_MULTIPLE = 4;
/** A single comp this much below the subject anchor is implausible. */
export const COMP_ANCHOR_MIN_MULTIPLE = 0.15;
/** Hard fail: any valuation/offer more than this × a defensible range (mission §23). */
export const VALUATION_ANCHOR_HARD_MULTIPLE = 10;
/** Consideration at/below this is treated as nominal (mission §4). */
export const NOMINAL_PRICE_MAX_USD = 5_000;
/** A single comp may not control more than this share of a valuation (mission §23). */
export const MAX_SINGLE_COMP_VALUATION_SHARE = 0.45;

/* -------------------------------------------------------------------------- */
/* Transaction clustering & package detection (mission §2)                     */
/* -------------------------------------------------------------------------- */

/** Bucket considerations to the nearest dollar (kills float cents noise). */
export const MONEY_BUCKET_USD = 1;
/** One consideration spanning ≥ this many distinct parcels ⇒ package signal. */
export const PACKAGE_MIN_PARCELS = 4;
/** ...across ≥ this many distinct ZIPs ⇒ strong package signal. */
export const PACKAGE_MIN_ZIPS = 2;
/** package_sale_probability at/above this quarantines the per-parcel price. */
export const PACKAGE_QUARANTINE_PROBABILITY = 0.5;

/* -------------------------------------------------------------------------- */
/* Transaction channels (mission §3)                                           */
/* -------------------------------------------------------------------------- */

export const TX_CHANNELS = Object.freeze({
  MLS_ARM_LENGTH: 'MLS_ARM_LENGTH',
  OFF_MARKET_ARM_LENGTH: 'OFF_MARKET_ARM_LENGTH',
  INVESTOR_OFF_MARKET: 'INVESTOR_OFF_MARKET',
  INSTITUTIONAL_SINGLE_ASSET: 'INSTITUTIONAL_SINGLE_ASSET',
  INSTITUTIONAL_PORTFOLIO: 'INSTITUTIONAL_PORTFOLIO',
  BUILDER_DEVELOPMENT: 'BUILDER_DEVELOPMENT',
  AUCTION: 'AUCTION',
  FORECLOSURE: 'FORECLOSURE',
  REO: 'REO',
  TAX_SALE: 'TAX_SALE',
  RELATED_PARTY: 'RELATED_PARTY',
  FAMILY_TRANSFER: 'FAMILY_TRANSFER',
  NOMINAL_TRANSFER: 'NOMINAL_TRANSFER',
  DEED_CORRECTION: 'DEED_CORRECTION',
  REFINANCE_OR_NON_SALE: 'REFINANCE_OR_NON_SALE',
  NEIGHBOR_ASSEMBLAGE: 'NEIGHBOR_ASSEMBLAGE',
  PUBLIC_RECORD_UNVERIFIED: 'PUBLIC_RECORD_UNVERIFIED',
  UNKNOWN: 'UNKNOWN',
});

/* -------------------------------------------------------------------------- */
/* Transaction qualification statuses (mission §4)                             */
/* -------------------------------------------------------------------------- */

export const QUALIFICATION_STATUS = Object.freeze({
  ACCEPT: 'ACCEPT',
  REVIEW: 'REVIEW',
  QUARANTINE: 'QUARANTINE',
  EXCLUDE: 'EXCLUDE',
});

/** Status severity ordering (higher = more severe). */
export const STATUS_SEVERITY = Object.freeze({
  ACCEPT: 0,
  REVIEW: 1,
  QUARANTINE: 2,
  EXCLUDE: 3,
});

/* -------------------------------------------------------------------------- */
/* Execution gates (mission §24) — minimums for autonomous readiness           */
/* -------------------------------------------------------------------------- */

export const EXECUTION = Object.freeze({
  MIN_INDEPENDENT_COMPS: 3,
  MIN_EFFECTIVE_SAMPLE_SIZE: 3,
  MIN_INVESTOR_VALUATION_CONFIDENCE: 60,
  MIN_BUYER_EXIT_CONFIDENCE: 55,
  MIN_REPAIR_CONFIDENCE: 50,
  MAX_MODEL_DISAGREEMENT: 35,
  MIN_EXECUTION_CONFIDENCE: 70,
});

export const EXECUTION_STATES = Object.freeze({
  NON_EXECUTABLE: 'NON_EXECUTABLE',
  DATA_REQUIRED: 'DATA_REQUIRED',
  ANOMALY_QUARANTINE: 'ANOMALY_QUARANTINE',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  SHADOW_MODE_READY: 'SHADOW_MODE_READY',
  AUTO_RANGE_READY: 'AUTO_RANGE_READY',
  AUTO_OFFER_READY: 'AUTO_OFFER_READY',
  AUTO_CREATIVE_READY: 'AUTO_CREATIVE_READY',
});

/* -------------------------------------------------------------------------- */
/* Feature flags (mission §24) — all unsafe defaults FALSE                      */
/* -------------------------------------------------------------------------- */

export const FEATURE_FLAGS = Object.freeze({
  ACQUISITION_ENGINE_V3_ENABLED: false,
  ACQUISITION_ENGINE_V3_SHADOW_MODE: true,
  ACQUISITION_ENGINE_V3_ALLOW_PERSIST: false,
  ACQUISITION_ENGINE_V3_ALLOW_QUEUE_PRIORITY: false,
  ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER: false,
  ACQUISITION_ENGINE_V3_ALLOW_AUTO_CREATIVE: false,
});

/** Read a V3 flag from env, falling back to the safe default above. */
export function readFeatureFlag(name, env = process.env) {
  const fallback = FEATURE_FLAGS[name];
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === '') return Boolean(fallback);
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return Boolean(fallback);
}

/* -------------------------------------------------------------------------- */
/* Tiny numeric helpers (deterministic)                                        */
/* -------------------------------------------------------------------------- */

export function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

export function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function clean(value) {
  return String(value ?? '').trim();
}

export function clamp(value, min = 0, max = 100) {
  const n = num(value, min);
  return Math.min(max, Math.max(min, n));
}

export function round(value, places = 0) {
  const n = num(value);
  if (n === null) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function roundMoney(value) {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

/* -------------------------------------------------------------------------- */
/* Item 4 — valuation universes, offer economics, creative finance             */
/* -------------------------------------------------------------------------- */

export const VALUATION_UNIVERSES = Object.freeze({
  LOCAL_INVESTOR_VALUE: 'LOCAL_INVESTOR_VALUE',
  INSTITUTIONAL_VALUE: 'INSTITUTIONAL_VALUE',
  RETAIL_MLS_VALUE: 'RETAIL_MLS_VALUE',
  PUBLIC_RECORD_ARM_LENGTH_VALUE: 'PUBLIC_RECORD_ARM_LENGTH_VALUE',
  INCOME_VALUE: 'INCOME_VALUE',
  LIQUIDATION_VALUE: 'LIQUIDATION_VALUE',
  SUBJECT_ANCHOR_SCENARIO: 'SUBJECT_ANCHOR_SCENARIO',
});

/** How a value should be read downstream (mission: never label anchor as market). */
export const VALUE_CLASSIFICATION = Object.freeze({
  QUALIFIED: 'QUALIFIED', // transaction-supported
  PROVISIONAL_SCENARIO: 'PROVISIONAL_SCENARIO', // derived/limited evidence
  SUBJECT_ANCHOR_SCENARIO: 'SUBJECT_ANCHOR_SCENARIO', // AVM/assessed only — NOT market
});

export const STRATEGIES = Object.freeze({
  CASH: 'CASH',
  NOVATION: 'NOVATION',
  SUBJECT_TO: 'SUBJECT_TO',
  SELLER_FINANCE: 'SELLER_FINANCE',
  LEASE_OPTION: 'LEASE_OPTION', // reserved interface
  NO_OFFER: 'NO_OFFER',
});

/** Reliability factors are all bounded to [floor, 1]; product is the weight. */
export const RELIABILITY_FLOOR = 0.05;

/** When investor evidence is absent, investor value may be derived from retail
 * at this lane-family discount — labeled PROVISIONAL_SCENARIO, never QUALIFIED. */
export const INVESTOR_DISCOUNT_FROM_RETAIL = Object.freeze({
  RESIDENTIAL_SINGLE: 0.82,
  SMALL_MULTI: 0.80,
  MULTIFAMILY: 0.85,
  COMMERCIAL: 0.80,
  LAND: 0.70,
  SPECIAL: 0.75,
  UNKNOWN: 0.80,
});

export const LIQUIDATION_FACTOR = 0.80; // of conservative investor exit

/** Buyer-side cost stack for the cash-offer bridge (fractions of buyer exit). */
export const OFFER_COSTS = Object.freeze({
  buyer_closing_pct: 0.02,
  buyer_holding_pct: 0.03,
  buyer_disposition_pct: 0.05,
  contingency_pct: 0.03,
});

/** Dynamic assignment/acquisition margin (fraction of buyer exit) by family. */
export const MARGIN_BASE_PCT = Object.freeze({
  RESIDENTIAL_SINGLE: 0.10,
  SMALL_MULTI: 0.11,
  MULTIFAMILY: 0.06,
  COMMERCIAL: 0.07,
  LAND: 0.15,
  SPECIAL: 0.10,
  UNKNOWN: 0.10,
});
export const MARGIN_MIN_USD = 8_000;
export const MARGIN_MAX_PCT = 0.30;

export const NOVATION = Object.freeze({
  agent_commission_pct: 0.055,
  seller_closing_pct: 0.015,
  prep_allowance_pct: 0.01,
  holding_reserve_pct: 0.01,
  company_fee_pct: 0.05, // target company net as fraction of expected sale
  min_retail_effective_sample: 3,
  min_retail_confidence: 55,
  max_days_to_sale: 150,
  min_seller_net_advantage_pct: 0.06, // novation seller net must beat cash by >=6%
});

export const SUBJECT_TO = Object.freeze({
  target_dscr: 1.2,
  min_stressed_dscr: 1.0,
  vacancy_pct: 0.06,
  management_pct: 0.08,
  maintenance_pct: 0.05,
  reserve_pct: 0.05,
  stress_rent_drop: 0.10,
  stress_expense_increase: 0.15,
});

export const SELLER_FINANCE = Object.freeze({
  target_dscr: 1.25,
  target_cash_on_cash: 0.08,
  default_rate: 0.06,
  default_amortization_months: 360,
  default_balloon_months: 60,
  min_down_pct: 0.05,
  max_down_pct: 0.25,
});

/** Cap-rate defaults for the income corroboration model (labeled assumptions). */
export const DEFAULT_CAP_RATE = Object.freeze({
  SMALL_MULTI: 0.07,
  MULTIFAMILY: 0.06,
  COMMERCIAL: 0.075,
  UNKNOWN: 0.07,
});

/** Model-disagreement above this (0..100) caps confidence / blocks autonomy. */
export const MODEL_DISAGREEMENT_CONF_CAP = 35;

/* -------------------------------------------------------------------------- */
/* Item 4.5 — strategy qualification states                                    */
/* -------------------------------------------------------------------------- */

export const STRATEGY_QUALIFICATION = Object.freeze({
  EXECUTABLE: 'EXECUTABLE', // all inputs/invariants/gates pass AND exec flag on
  UNDERWRITTEN_SHADOW: 'UNDERWRITTEN_SHADOW', // economics qualified, exec flag off / shadow
  PROVISIONAL_SCENARIO: 'PROVISIONAL_SCENARIO', // illustrative economics, labeled assumptions
  DATA_REQUIRED: 'DATA_REQUIRED', // essential inputs unavailable
  DISQUALIFIED: 'DISQUALIFIED', // economics / constraints / stress make it unsuitable
});

/** Class ordering for ranking: higher = better. */
export const QUALIFICATION_CLASS_RANK = Object.freeze({
  EXECUTABLE: 5,
  UNDERWRITTEN_SHADOW: 4,
  PROVISIONAL_SCENARIO: 2,
  DATA_REQUIRED: 1,
  DISQUALIFIED: 0,
});

/** Statuses that may be selected as the primary strategy. */
export const PRIMARY_ELIGIBLE_STATUSES = Object.freeze([
  'EXECUTABLE',
  'UNDERWRITTEN_SHADOW',
  'PROVISIONAL_SCENARIO',
]);

/** Execution states that permit authorized (non-scenario) offer fields. */
export const EXECUTABLE_EXECUTION_STATES = Object.freeze([
  'SHADOW_MODE_READY',
  'AUTO_RANGE_READY',
  'AUTO_OFFER_READY',
  'AUTO_CREATIVE_READY',
]);

/* -------------------------------------------------------------------------- */
/* Item 5B §0 — strategy-/lane-specific execution depth gates                   */
/* -------------------------------------------------------------------------- */

/**
 * Wholesale-cash depth gate by asset family. Evidence-based: thin residential
 * resale markets still need >=4 independent investor-compatible transactions
 * (investor + institutional single-asset + qualified public-record) to
 * authorize a shadow cash offer; a 3-transaction set may pass ONLY via the
 * strict exception below. Smaller-market families allow a lower preferred count;
 * income lanes additionally require income corroboration (income model).
 */
export const WHOLESALE_DEPTH_GATES = Object.freeze({
  RESIDENTIAL_SINGLE: { preferred: 4, exception_min: 3 },
  SMALL_MULTI: { preferred: 3, exception_min: 3 },
  MULTIFAMILY: { preferred: 3, exception_min: 3 },
  COMMERCIAL: { preferred: 3, exception_min: 2 },
  LAND: { preferred: 3, exception_min: 2 },
  SPECIAL: { preferred: 4, exception_min: 3 },
  UNKNOWN: { preferred: 4, exception_min: 3 },
});

/** Strict corroboration required for a 3-transaction wholesale exception. */
export const WHOLESALE_EXCEPTION = Object.freeze({
  max_disagreement: 30, // strictly below the ordinary cap (35)
  min_median_similarity: 70,
  max_dispersion: 0.15,
  min_public_corroboration: 1, // >=1 qualified public-record corroborating txn
});

/** Retail-resale ESS required for a novation-led shadow result. */
export const NOVATION_DEPTH_MIN = 4;

/** Final-confidence ceiling by the DOMINANT model's independent depth, so a high
 * total candidate count can never lend confidence a thin dominant model lacks. */
export function dominantDepthConfidenceCap(ess) {
  const n = num(ess, 0);
  if (n >= 6) return 100;
  if (n >= 5) return 92;
  if (n >= 4) return 85;
  if (n >= 3) return 72;
  if (n >= 2) return 58;
  if (n >= 1) return 42;
  return 25;
}
