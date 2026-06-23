/**
 * Acquisition Engine V3 — Item 5E: retail & strip-center constants and labeled
 * assumptions.
 *
 * Retail is NOT generic commercial. These constants encode retail-specific
 * operating reality (single-tenant net-lease vs multi-tenant strip vs grocery-
 * anchored center; NNN reimbursement vs gross lease; tenant credit; co-tenancy /
 * anchor dependency; lease rollover) and are kept separate from the residential /
 * multifamily / self-storage assumptions so no universal expense ratio or cap
 * rate is applied across asset classes (mission §8, §13). Every modeled figure is
 * LABELED where used; none of these are observed facts.
 *
 * A retail business sale, goodwill, inventory, franchise value, or FF&E is NEVER
 * real-estate consideration (mission §18). Gas stations, car washes, auto-service
 * facilities and restaurant business sales are specialty uses that must NOT
 * silently enter generic retail pricing (mission §2).
 *
 * Pure data module — no I/O, no Date.now, no randomness.
 */

/**
 * Mission §2: explicit retail asset subtypes (the asset taxonomy). A generic
 * "retail" flag alone can NEVER establish a high-confidence subtype.
 */
export const RETAIL_SUBTYPE = Object.freeze({
  NEIGHBORHOOD_STRIP_CENTER: 'NEIGHBORHOOD_STRIP_CENTER',
  UNANCHORED_STRIP_CENTER: 'UNANCHORED_STRIP_CENTER',
  GROCERY_ANCHORED_CENTER: 'GROCERY_ANCHORED_CENTER',
  COMMUNITY_SHOPPING_CENTER: 'COMMUNITY_SHOPPING_CENTER',
  SINGLE_TENANT_NET_LEASE: 'SINGLE_TENANT_NET_LEASE',
  FREESTANDING_RETAIL: 'FREESTANDING_RETAIL',
  BIG_BOX_RETAIL: 'BIG_BOX_RETAIL',
  MULTI_TENANT_STOREFRONT: 'MULTI_TENANT_STOREFRONT',
  RETAIL_CONDOMINIUM: 'RETAIL_CONDOMINIUM',
  GROUND_LEASE: 'GROUND_LEASE',
  OWNER_OCCUPIED_RETAIL: 'OWNER_OCCUPIED_RETAIL',
  VACANT_RETAIL: 'VACANT_RETAIL',
  REDEVELOPMENT_RETAIL: 'REDEVELOPMENT_RETAIL',
  MIXED_USE_RETAIL: 'MIXED_USE_RETAIL',
  SPECIALTY_RETAIL_REVIEW: 'SPECIALTY_RETAIL_REVIEW',
  AMBIGUOUS_RETAIL: 'AMBIGUOUS_RETAIL',
  NOT_RETAIL: 'NOT_RETAIL',
});

/**
 * Mission §1 & §2: record-level classification — what KIND of record this is,
 * hardened against specialty / business-sale / mixed-use false positives. A gas
 * station, car wash, auto-service facility, dealership or restaurant business
 * sale must NOT silently enter generic retail pricing.
 */
export const RETAIL_RECORD_CLASS = Object.freeze({
  MULTI_TENANT_RETAIL_CENTER: 'MULTI_TENANT_RETAIL_CENTER',
  SINGLE_TENANT_RETAIL: 'SINGLE_TENANT_RETAIL',
  FREESTANDING_RETAIL: 'FREESTANDING_RETAIL',
  RETAIL_CONDOMINIUM: 'RETAIL_CONDOMINIUM',
  GROUND_LEASE_RETAIL: 'GROUND_LEASE_RETAIL',
  VACANT_RETAIL: 'VACANT_RETAIL',
  REDEVELOPMENT_RETAIL: 'REDEVELOPMENT_RETAIL',
  // ---- Specialty / non-generic-retail buckets (route to review / future lane) ----
  GAS_STATION_FUEL: 'GAS_STATION_FUEL',
  CAR_WASH: 'CAR_WASH',
  AUTO_SERVICE_REPAIR: 'AUTO_SERVICE_REPAIR',
  AUTO_DEALERSHIP: 'AUTO_DEALERSHIP',
  RESTAURANT_BUSINESS_SALE: 'RESTAURANT_BUSINESS_SALE',
  BUSINESS_OPPORTUNITY: 'BUSINESS_OPPORTUNITY',
  MIXED_USE_RETAIL_RESIDENTIAL: 'MIXED_USE_RETAIL_RESIDENTIAL',
  WAREHOUSE_SHOWROOM: 'WAREHOUSE_SHOWROOM',
  LAND_OR_DEVELOPMENT_SITE: 'LAND_OR_DEVELOPMENT_SITE',
  AMBIGUOUS_RETAIL: 'AMBIGUOUS_RETAIL',
  NOT_RETAIL: 'NOT_RETAIL',
});

/** Record classes that may be priced/underwritten as genuine retail real estate. */
export const PRICING_ELIGIBLE_RECORD_CLASSES = Object.freeze([
  RETAIL_RECORD_CLASS.MULTI_TENANT_RETAIL_CENTER,
  RETAIL_RECORD_CLASS.SINGLE_TENANT_RETAIL,
  RETAIL_RECORD_CLASS.FREESTANDING_RETAIL,
  RETAIL_RECORD_CLASS.GROUND_LEASE_RETAIL,
]);

/** Specialty record classes that route to review / a future specialty lane. */
export const SPECIALTY_RECORD_CLASSES = Object.freeze([
  RETAIL_RECORD_CLASS.GAS_STATION_FUEL,
  RETAIL_RECORD_CLASS.CAR_WASH,
  RETAIL_RECORD_CLASS.AUTO_SERVICE_REPAIR,
  RETAIL_RECORD_CLASS.AUTO_DEALERSHIP,
  RETAIL_RECORD_CLASS.RESTAURANT_BUSINESS_SALE,
  RETAIL_RECORD_CLASS.BUSINESS_OPPORTUNITY,
]);

/** Record classes that require an environmental review before pricing (§18). */
export const ENVIRONMENTAL_REVIEW_CLASSES = Object.freeze([
  RETAIL_RECORD_CLASS.GAS_STATION_FUEL,
  RETAIL_RECORD_CLASS.CAR_WASH,
  RETAIL_RECORD_CLASS.AUTO_SERVICE_REPAIR,
  RETAIL_RECORD_CLASS.AUTO_DEALERSHIP,
]);

/** Minimum classifier confidence to treat a record as genuine, priceable retail. */
export const GENUINE_RETAIL_MIN_CONFIDENCE = 60;

/** Item 5E §24: retail-model production-readiness states (ordered, coarse). */
export const RETAIL_READINESS = Object.freeze({
  ARCHITECTURE_VALIDATED: 'ARCHITECTURE_VALIDATED',
  DATA_MODEL_READY: 'DATA_MODEL_READY',
  DETERMINISTIC_FIXTURE_VALIDATED: 'DETERMINISTIC_FIXTURE_VALIDATED',
  LIVE_CLASSIFICATION_PARTIAL: 'LIVE_CLASSIFICATION_PARTIAL',
  LIVE_LEASE_DATA_UNAVAILABLE: 'LIVE_LEASE_DATA_UNAVAILABLE',
  LIVE_TRANSACTION_DATA_UNAVAILABLE: 'LIVE_TRANSACTION_DATA_UNAVAILABLE',
  LIVE_OPERATING_DATA_UNAVAILABLE: 'LIVE_OPERATING_DATA_UNAVAILABLE',
  PRODUCTION_PRICING_NOT_CALIBRATED: 'PRODUCTION_PRICING_NOT_CALIBRATED',
  SHADOW_SCENARIO_ONLY: 'SHADOW_SCENARIO_ONLY',
  PRODUCTION_SHADOW_READY: 'PRODUCTION_SHADOW_READY',
  AUTONOMOUS_READY: 'AUTONOMOUS_READY',
});

/** Mission §3: tenancy / operating structure of the subject. */
export const RETAIL_TENANCY = Object.freeze({
  SINGLE_TENANT: 'SINGLE_TENANT',
  MULTI_TENANT: 'MULTI_TENANT',
  OWNER_OCCUPIED: 'OWNER_OCCUPIED',
  VACANT: 'VACANT',
  UNKNOWN: 'UNKNOWN',
});

/** Mission §3: lifecycle/operational status, distinct from tenancy structure. */
export const RETAIL_OPERATIONAL_STATUS = Object.freeze({
  STABILIZED: 'STABILIZED',
  VALUE_ADD: 'VALUE_ADD',
  LEASE_UP: 'LEASE_UP',
  REDEVELOPMENT: 'REDEVELOPMENT',
  DARK: 'DARK', // tenant gone-dark but still paying rent
  VACANT: 'VACANT', // no income
  UNKNOWN: 'UNKNOWN',
});

/** Mission §4: lease structures. NNN is NEVER inferred from CAM alone. */
export const LEASE_TYPE = Object.freeze({
  ABSOLUTE_NET: 'ABSOLUTE_NET', // tenant pays everything incl. roof/structure
  TRIPLE_NET: 'TRIPLE_NET', // tenant pays taxes + insurance + CAM
  DOUBLE_NET: 'DOUBLE_NET', // tenant pays taxes + insurance
  SINGLE_NET: 'SINGLE_NET', // tenant pays taxes
  MODIFIED_GROSS: 'MODIFIED_GROSS',
  FULL_SERVICE_GROSS: 'FULL_SERVICE_GROSS',
  GROUND_LEASE: 'GROUND_LEASE',
  PERCENTAGE_RENT: 'PERCENTAGE_RENT',
  OWNER_OCCUPIED: 'OWNER_OCCUPIED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Landlord expense-recovery exposure by lease type — the fraction of recoverable
 * operating expenses the LANDLORD ultimately bears (leakage). Absolute/triple net
 * shift nearly all opex to the tenant; gross leases keep it with the landlord.
 * LABELED assumption; never assumes 100% NNN recovery (mission §8).
 */
export const LANDLORD_EXPENSE_EXPOSURE = Object.freeze({
  ABSOLUTE_NET: 0.0,
  TRIPLE_NET: 0.05, // structural/vacancy leakage even under NNN
  DOUBLE_NET: 0.25, // landlord retains CAM/management
  SINGLE_NET: 0.55,
  MODIFIED_GROSS: 0.7,
  FULL_SERVICE_GROSS: 1.0,
  GROUND_LEASE: 0.0,
  PERCENTAGE_RENT: 0.3,
  OWNER_OCCUPIED: 1.0,
  UNKNOWN: 0.6, // conservative: assume landlord exposure when unknown
});

/** Mission §5: tenant credit / guaranty classes. A brand name is NEVER a guaranty. */
export const TENANT_CREDIT_CLASS = Object.freeze({
  INVESTMENT_GRADE_NATIONAL: 'INVESTMENT_GRADE_NATIONAL',
  NATIONAL_CREDIT: 'NATIONAL_CREDIT',
  REGIONAL_CREDIT: 'REGIONAL_CREDIT',
  FRANCHISEE: 'FRANCHISEE',
  LOCAL_OPERATOR: 'LOCAL_OPERATOR',
  GOVERNMENT: 'GOVERNMENT',
  MEDICAL_OR_SERVICE: 'MEDICAL_OR_SERVICE',
  GROCERY_ANCHOR: 'GROCERY_ANCHOR',
  SHADOW_ANCHOR: 'SHADOW_ANCHOR',
  OWNER_OCCUPANT: 'OWNER_OCCUPANT',
  UNKNOWN: 'UNKNOWN',
});

/** Guaranty strength ordering (higher = stronger) — only when EVIDENCED. */
export const GUARANTY_STRENGTH = Object.freeze({
  CORPORATE_INVESTMENT_GRADE: 'CORPORATE_INVESTMENT_GRADE',
  CORPORATE: 'CORPORATE',
  FRANCHISEE_PERSONAL: 'FRANCHISEE_PERSONAL',
  PERSONAL: 'PERSONAL',
  LIMITED_OR_NONE: 'LIMITED_OR_NONE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Modeled market cap-rate defaults by subtype (LABELED MARKET_MODELED). Net-lease
 * investment-grade product trades tightest; unanchored local strip widest. NEVER
 * used to manufacture an OBSERVED cap rate.
 */
export const RETAIL_DEFAULT_CAP_RATE = Object.freeze({
  SINGLE_TENANT_NET_LEASE: 0.06,
  FREESTANDING_RETAIL: 0.07,
  BIG_BOX_RETAIL: 0.075,
  GROCERY_ANCHORED_CENTER: 0.068,
  COMMUNITY_SHOPPING_CENTER: 0.072,
  NEIGHBORHOOD_STRIP_CENTER: 0.078,
  UNANCHORED_STRIP_CENTER: 0.085,
  MULTI_TENANT_STOREFRONT: 0.08,
  RETAIL_CONDOMINIUM: 0.075,
  GROUND_LEASE: 0.05,
  MIXED_USE_RETAIL: 0.072,
  VACANT_RETAIL: 0.095,
  UNKNOWN: 0.08,
});

/** Tenant-credit cap-rate adjustment (bps, +widens / −tightens). */
export const CREDIT_CAP_ADJUSTMENT_BPS = Object.freeze({
  INVESTMENT_GRADE_NATIONAL: -75,
  NATIONAL_CREDIT: -40,
  REGIONAL_CREDIT: -10,
  GROCERY_ANCHOR: -25,
  GOVERNMENT: -30,
  FRANCHISEE: 25,
  MEDICAL_OR_SERVICE: 0,
  LOCAL_OPERATOR: 60,
  SHADOW_ANCHOR: 20,
  OWNER_OCCUPANT: 40,
  UNKNOWN: 50,
});

/** Cap-rate plausibility window for qualifying observed retail cap evidence. */
export const RETAIL_CAP_RATE_BOUNDS = Object.freeze({ min: 0.035, max: 0.15 });

/**
 * Retail operating-expense assumptions (LABELED). % lines are of EGR; per-GLA
 * lines are USD per gross-leasable-square-foot per year. Distinct from MF/storage:
 * retail centers carry CAM, parking-lot/landscaping, and material TI/LC capital.
 */
export const RETAIL_OPEX_ASSUMPTIONS = Object.freeze({
  property_tax_rate_of_value: 0.017,
  insurance_per_gla: 0.45,
  cam_per_gla: 1.85, // common-area maintenance (recoverable under NNN)
  repairs_per_gla: 0.55,
  utilities_common_per_gla: 0.35,
  landscaping_parking_per_gla: 0.30,
  management_pct: 0.04, // of EGR
  administrative_pct: 0.015,
  marketing_pct: 0.01,
  reserves_per_gla: 0.20,
  non_recoverable_per_gla: 0.25, // landlord-retained, never reimbursed
});

/** Ordered retail operating-expense line keys (drives known/assumed reporting). */
export const RETAIL_EXPENSE_CATEGORIES = Object.freeze([
  'property_taxes', 'insurance', 'cam', 'repairs_maintenance', 'common_utilities',
  'landscaping_parking', 'management', 'administrative', 'marketing',
  'professional_fees', 'non_recoverable', 'replacement_reserves',
]);

/**
 * Lease rollover / re-tenanting assumptions (LABELED). Applied per expiring or
 * vacant suite when re-tenanting. Costs reduce value and are never double-counted
 * with NOI normalization (mission §10, §17).
 */
export const RETAIL_ROLLOVER_ASSUMPTIONS = Object.freeze({
  downtime_months_inline: 8,
  downtime_months_anchor: 14,
  free_rent_months: 4,
  ti_per_gla_inline: 25, // tenant improvement $/GLA for inline space
  ti_per_gla_anchor: 45,
  leasing_commission_pct: 0.06, // of total lease value over term
  legal_marketing_per_suite: 4_000,
  renewal_probability_credit: 0.8,
  renewal_probability_local: 0.55,
  renewal_rent_factor: 0.97, // renewal rent vs market
  new_lease_rent_factor: 1.0,
});

/** Price-per-GLA plausibility window by subtype (qualifying comp sanity, USD/GLA). */
export const RETAIL_PPGLA_BOUNDS = Object.freeze({
  SINGLE_TENANT_NET_LEASE: { low: 150, high: 900 },
  FREESTANDING_RETAIL: { low: 90, high: 700 },
  BIG_BOX_RETAIL: { low: 40, high: 250 },
  GROCERY_ANCHORED_CENTER: { low: 80, high: 400 },
  COMMUNITY_SHOPPING_CENTER: { low: 70, high: 350 },
  NEIGHBORHOOD_STRIP_CENTER: { low: 90, high: 450 },
  UNANCHORED_STRIP_CENTER: { low: 70, high: 400 },
  MULTI_TENANT_STOREFRONT: { low: 80, high: 500 },
  RETAIL_CONDOMINIUM: { low: 120, high: 800 },
  GROUND_LEASE: { low: 40, high: 600 },
  UNKNOWN: { low: 40, high: 900 },
});

/**
 * Physical floor (sqft GLA): a multi-tenant retail CENTER below this is treated
 * as freestanding / single-tenant unless multi-suite evidence exists. A gate, not
 * a hard rejection.
 */
export const MULTI_TENANT_MIN_GLA_SQFT = 8_000;

/** Below this GLA a retail record is structurally implausible as a center. */
export const RETAIL_IMPLAUSIBLE_GLA_SQFT = 600;

/** Stabilized occupancy assumption for a retail center (labeled). */
export const RETAIL_STABILIZED_OCCUPANCY = 0.93;

/** Occupancy bands for operational classification (physical occupancy). */
export const RETAIL_OCCUPANCY_BANDS = Object.freeze({
  stabilized_min: 0.90,
  value_add_max: 0.89,
  lease_up_max: 0.60,
});

/** Mission §19: likely retail buyer archetypes. */
export const RETAIL_BUYER_ARCHETYPE = Object.freeze({
  LOCAL_RETAIL_INVESTOR: 'LOCAL_RETAIL_INVESTOR',
  REGIONAL_SHOPPING_CENTER_OPERATOR: 'REGIONAL_SHOPPING_CENTER_OPERATOR',
  PRIVATE_EQUITY_RETAIL_FUND: 'PRIVATE_EQUITY_RETAIL_FUND',
  REIT: 'REIT',
  NET_LEASE_INVESTOR: 'NET_LEASE_INVESTOR',
  EXCHANGE_1031_BUYER: 'EXCHANGE_1031_BUYER',
  OWNER_OCCUPANT: 'OWNER_OCCUPANT',
  REDEVELOPMENT_BUYER: 'REDEVELOPMENT_BUYER',
  DISTRESSED_BUYER: 'DISTRESSED_BUYER',
  GROUND_LEASE_INVESTOR: 'GROUND_LEASE_INVESTOR',
});

/** Retail marketed-disposition strategy id — a commercial brokered sale, NOT
 *  residential novation (mission §20). */
export const RETAIL_DISPOSITION_STRATEGY = 'RETAIL_MARKETED_DISPOSITION';

/** Retail commercial debt-takeover model — the SUBJECT_TO slot, but a DISTINCT
 *  commercial debt model (never labeled residential subject-to) (mission §20). */
export const RETAIL_DEBT_MODEL = 'COMMERCIAL_DEBT_TAKEOVER';

/** Concentration thresholds for tenant / category / anchor risk (mission §5, §11). */
export const RETAIL_CONCENTRATION = Object.freeze({
  single_tenant_high_share: 0.4, // one tenant > 40% of GLA → concentration risk
  top_five_high_share: 0.8,
  anchor_share: 0.3, // tenant ≥30% GLA treated as an anchor
});
