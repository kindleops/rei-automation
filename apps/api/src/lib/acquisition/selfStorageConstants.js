/**
 * Acquisition Engine V3 — Item 5D: self-storage constants & labeled assumptions.
 *
 * Storage is NOT generic industrial / generic commercial. These constants encode
 * storage-specific operating reality (drive-up vs climate-controlled, staffed vs
 * unmanned, ancillary income streams, NRSF efficiency) and are kept separate from
 * the residential/MF assumptions so no universal expense ratio or cap rate is
 * applied across asset classes (mission §6, §10). All modeled figures are LABELED
 * where used; none of these are observed facts.
 *
 * Pure data module — no I/O, no Date.now, no randomness.
 */

/** Operational lifecycle classification of a storage facility (mission §3). */
export const STORAGE_OPERATIONAL_STATUS = Object.freeze({
  STABILIZED: 'STABILIZED',
  VALUE_ADD: 'VALUE_ADD',
  LEASE_UP: 'LEASE_UP',
  DISTRESSED: 'DISTRESSED',
  DEVELOPMENT: 'DEVELOPMENT',
  CONVERSION: 'CONVERSION',
  EXPANSION: 'EXPANSION',
  LAND_ONLY: 'LAND_ONLY',
  UNKNOWN: 'UNKNOWN',
});

/** Physical facility type — distinct from "is it a real facility at all". */
export const STORAGE_FACILITY_TYPE = Object.freeze({
  DRIVE_UP: 'DRIVE_UP', // single-story non-climate drive-up
  CLIMATE_CONTROLLED: 'CLIMATE_CONTROLLED', // multi-story / interior climate
  MIXED: 'MIXED', // mix of climate + drive-up
  VEHICLE_RV_BOAT: 'VEHICLE_RV_BOAT', // vehicle / RV / boat storage
  STORAGE_CONDO: 'STORAGE_CONDO', // individually-owned storage condominium
  PORTABLE_STORAGE_BUSINESS: 'PORTABLE_STORAGE_BUSINESS', // mobile/portable container business (not RE)
  UNKNOWN: 'UNKNOWN',
});

/** Coarse facility class (institutional quality, ordered A>B>C). */
export const STORAGE_FACILITY_CLASS = Object.freeze({
  A: 'A',
  B: 'B',
  C: 'C',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Physical-plausibility floor (mission §1 audit): a storage-flagged record below
 * this gross building area is treated as a SUSPECT facility (likely a garage,
 * storage condo, or land-use-coded parcel) and is NOT assumed to be an operating
 * multi-building facility. This is a gate, not a hard rejection.
 */
export const GENUINE_FACILITY_MIN_GBA_SQFT = 10_000;

/** Below this GBA a storage record is structurally implausible as a facility. */
export const FACILITY_IMPLAUSIBLE_GBA_SQFT = 3_000;

/**
 * NRSF efficiency (net rentable / gross building area) by facility type — a
 * LABELED MARKET_MODELED assumption used ONLY when NRSF is unknown but GBA is
 * known. Never overwrites an observed NRSF and never invents unit-mix precision.
 */
export const STORAGE_NRSF_EFFICIENCY = Object.freeze({
  DRIVE_UP: 0.90,
  CLIMATE_CONTROLLED: 0.72,
  MIXED: 0.80,
  VEHICLE_RV_BOAT: 0.95,
  UNKNOWN: 0.82,
});

/** Stabilized physical occupancy assumption for storage (labeled). */
export const STORAGE_STABILIZED_OCCUPANCY = 0.90;

/** Occupancy thresholds for operational classification (physical occupancy). */
export const STORAGE_OCCUPANCY_BANDS = Object.freeze({
  stabilized_min: 0.85,
  value_add_max: 0.84,
  lease_up_max: 0.70,
  distressed_max: 0.50,
});

/** Default lease-up duration (months) from C/O to stabilization (labeled). */
export const STORAGE_DEFAULT_LEASEUP_MONTHS = 36;

/**
 * Storage cap-rate defaults by facility class (labeled MARKET_MODELED). Storage
 * trades tighter than generic commercial for institutional A product and wider
 * for tertiary C product. NEVER used to manufacture an OBSERVED cap rate.
 */
export const STORAGE_DEFAULT_CAP_RATE = Object.freeze({
  A: 0.055,
  B: 0.065,
  C: 0.085,
  UNKNOWN: 0.075,
});

/** Cap-rate plausibility window for qualifying observed storage cap evidence. */
export const STORAGE_CAP_RATE_BOUNDS = Object.freeze({ min: 0.035, max: 0.14 });

/**
 * Storage operating-expense assumptions (LABELED). Distinct from MF: storage is
 * lightly staffed (or unmanned), management-intensive on marketing/software, and
 * carries gate/security and snow/landscaping by geography. % lines are of EGI;
 * per-NRSF lines are USD per net rentable square foot per year.
 */
export const STORAGE_OPEX_ASSUMPTIONS = Object.freeze({
  // Single-story drive-up, typically unmanned / kiosk.
  DRIVE_UP: {
    management_pct: 0.06, marketing_pct: 0.05, admin_pct: 0.02,
    payroll_per_nrsf: 0.40, insurance_per_nrsf: 0.18, utilities_per_nrsf: 0.20,
    repairs_per_nrsf: 0.35, software_per_nrsf: 0.10, security_per_nrsf: 0.12,
    landscaping_snow_per_nrsf: 0.10, reserves_per_nrsf: 0.15, tax_rate_of_value: 0.014,
  },
  // Multi-story / interior climate, usually staffed, higher utilities.
  CLIMATE_CONTROLLED: {
    management_pct: 0.06, marketing_pct: 0.055, admin_pct: 0.025,
    payroll_per_nrsf: 1.10, insurance_per_nrsf: 0.28, utilities_per_nrsf: 0.95,
    repairs_per_nrsf: 0.45, software_per_nrsf: 0.14, security_per_nrsf: 0.18,
    landscaping_snow_per_nrsf: 0.08, reserves_per_nrsf: 0.20, tax_rate_of_value: 0.016,
  },
  MIXED: {
    management_pct: 0.06, marketing_pct: 0.05, admin_pct: 0.022,
    payroll_per_nrsf: 0.75, insurance_per_nrsf: 0.23, utilities_per_nrsf: 0.55,
    repairs_per_nrsf: 0.40, software_per_nrsf: 0.12, security_per_nrsf: 0.15,
    landscaping_snow_per_nrsf: 0.09, reserves_per_nrsf: 0.18, tax_rate_of_value: 0.015,
  },
  VEHICLE_RV_BOAT: {
    management_pct: 0.05, marketing_pct: 0.04, admin_pct: 0.018,
    payroll_per_nrsf: 0.20, insurance_per_nrsf: 0.12, utilities_per_nrsf: 0.08,
    repairs_per_nrsf: 0.18, software_per_nrsf: 0.08, security_per_nrsf: 0.10,
    landscaping_snow_per_nrsf: 0.06, reserves_per_nrsf: 0.10, tax_rate_of_value: 0.013,
  },
});

/** Ordered storage operating-expense line keys (drives known/assumed reporting). */
export const STORAGE_EXPENSE_CATEGORIES = Object.freeze([
  'taxes', 'insurance', 'payroll', 'management', 'utilities', 'repairs',
  'marketing', 'software', 'security', 'landscaping_snow', 'administrative',
  'professional_fees', 'reserves',
]);

/**
 * Ancillary income assumptions per occupied unit per year (LABELED). Only used
 * when ancillary income is unknown AND a defensible occupied-unit count exists;
 * ancillary income is ALWAYS separated from base rental income.
 */
export const STORAGE_ANCILLARY_ASSUMPTIONS = Object.freeze({
  tenant_insurance_per_occupied_unit: 36, // ~$3/mo penetration-weighted
  admin_fee_per_occupied_unit: 18,
  late_fee_per_occupied_unit: 22,
  merchandise_per_occupied_unit: 6,
});

/** Price-per-NRSF plausibility window by class (qualifying comp sanity, USD/NRSF). */
export const STORAGE_PPNRSF_BOUNDS = Object.freeze({
  A: { low: 90, high: 320 },
  B: { low: 55, high: 180 },
  C: { low: 25, high: 110 },
  UNKNOWN: { low: 25, high: 320 },
});

/** Price-per-unit plausibility window (USD/unit). */
export const STORAGE_PPU_BOUNDS = Object.freeze({ low: 1_500, high: 18_000 });

/** Average storage unit size assumption (NRSF/unit) — aggregate scenario ONLY. */
export const STORAGE_AVG_UNIT_NRSF = 90;

/**
 * Expansion / development assumptions (LABELED). Used only when expansion or
 * conversion evidence exists; expansion value never adds to as-is value without
 * subtracting these costs and a risk discount (mission §12).
 */
export const STORAGE_DEVELOPMENT_ASSUMPTIONS = Object.freeze({
  hard_cost_per_buildable_nrsf: 55,
  site_work_pct_of_hard: 0.18,
  soft_cost_pct_of_hard: 0.15,
  financing_cost_pct_of_hard: 0.08,
  lease_up_months: 36,
  stabilized_occupancy: 0.90,
  buildable_far: 0.35, // buildable NRSF as fraction of expansion land area
  execution_risk_discount: 0.25, // applied to gross development spread
});

/** Likely storage buyer archetypes (mission §14). */
export const STORAGE_BUYER_ARCHETYPE = Object.freeze({
  LOCAL_OWNER_OPERATOR: 'LOCAL_OWNER_OPERATOR',
  REGIONAL_OPERATOR: 'REGIONAL_OPERATOR',
  INSTITUTIONAL_PLATFORM: 'INSTITUTIONAL_PLATFORM',
  REIT: 'REIT',
  PRIVATE_EQUITY: 'PRIVATE_EQUITY',
  VALUE_ADD_OPERATOR: 'VALUE_ADD_OPERATOR',
  DEVELOPER_CONVERTER: 'DEVELOPER_CONVERTER',
  DISTRESSED_BUYER: 'DISTRESSED_BUYER',
});

/** Storage marketed-disposition strategy id — NOT residential novation. */
export const STORAGE_DISPOSITION_STRATEGY = 'STORAGE_MARKETED_DISPOSITION';

/** Storage commercial debt-takeover strategy is the SUBJECT_TO slot, but a
 *  distinct commercial debt model (never labeled residential subject-to). */
export const STORAGE_DEBT_MODEL = 'COMMERCIAL_DEBT_TAKEOVER';
