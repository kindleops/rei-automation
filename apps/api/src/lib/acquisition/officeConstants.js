/**
 * Acquisition Engine V3 — Item 5F: office & medical-office constants and labeled
 * assumptions.
 *
 * Office is NOT generic commercial, and medical office is NOT ordinary office.
 * These constants encode office-specific operating reality (CBD vs suburban;
 * Class A/B/C; low/mid/high-rise; single vs multi-tenant; full-service-gross vs
 * NNN; rentable-vs-usable area and load factor; sublease + shadow vacancy; TI/LC
 * and downtime; work-from-home demand risk; medical buildout / specialized TI /
 * conversion cost) kept separate from the residential / multifamily / self-
 * storage / retail assumptions so no universal expense ratio or cap rate is
 * applied across asset classes (mission §8, §11, §13, §14). Every modeled figure
 * is LABELED where used; none of these are observed facts.
 *
 * Owner-user value is a SEPARATE universe from investor value (mission §16).
 * Coworking business revenue, medical-practice value, equipment, goodwill and
 * operating-company consideration are NEVER real-estate consideration (§18).
 * Laboratory / life-science / data-center / hospital uses are SPECIAL_REVIEW and
 * must not silently enter ordinary office pricing (§2).
 *
 * Pure data module — no I/O, no Date.now, no randomness.
 */

/**
 * Mission §2: explicit office asset subtypes (the asset taxonomy). A generic
 * "office" flag alone can NEVER establish a high-confidence subtype, medical use,
 * life-science, or data-center use.
 */
export const OFFICE_SUBTYPE = Object.freeze({
  // ---- General office ----
  CBD_CLASS_A_OFFICE: 'CBD_CLASS_A_OFFICE',
  CBD_CLASS_B_OFFICE: 'CBD_CLASS_B_OFFICE',
  CBD_CLASS_C_OFFICE: 'CBD_CLASS_C_OFFICE',
  SUBURBAN_CLASS_A_OFFICE: 'SUBURBAN_CLASS_A_OFFICE',
  SUBURBAN_CLASS_B_OFFICE: 'SUBURBAN_CLASS_B_OFFICE',
  SUBURBAN_CLASS_C_OFFICE: 'SUBURBAN_CLASS_C_OFFICE',
  LOW_RISE_OFFICE: 'LOW_RISE_OFFICE',
  MID_RISE_OFFICE: 'MID_RISE_OFFICE',
  HIGH_RISE_OFFICE: 'HIGH_RISE_OFFICE',
  SINGLE_TENANT_OFFICE: 'SINGLE_TENANT_OFFICE',
  MULTI_TENANT_OFFICE: 'MULTI_TENANT_OFFICE',
  OWNER_USER_OFFICE: 'OWNER_USER_OFFICE',
  OFFICE_CONDOMINIUM: 'OFFICE_CONDOMINIUM',
  GOVERNMENT_OFFICE: 'GOVERNMENT_OFFICE',
  CORPORATE_CAMPUS: 'CORPORATE_CAMPUS',
  CREATIVE_OFFICE: 'CREATIVE_OFFICE',
  VACANT_OFFICE: 'VACANT_OFFICE',
  OFFICE_REDEVELOPMENT: 'OFFICE_REDEVELOPMENT',
  // ---- Medical ----
  MEDICAL_OFFICE_BUILDING: 'MEDICAL_OFFICE_BUILDING',
  DENTAL_OFFICE: 'DENTAL_OFFICE',
  OUTPATIENT_CLINIC: 'OUTPATIENT_CLINIC',
  URGENT_CARE: 'URGENT_CARE',
  AMBULATORY_SURGERY_CENTER: 'AMBULATORY_SURGERY_CENTER',
  IMAGING_CENTER: 'IMAGING_CENTER',
  SPECIALTY_MEDICAL_OFFICE: 'SPECIALTY_MEDICAL_OFFICE',
  HOSPITAL_AFFILIATED_MOB: 'HOSPITAL_AFFILIATED_MOB',
  OWNER_USER_MEDICAL: 'OWNER_USER_MEDICAL',
  VACANT_MEDICAL_OFFICE: 'VACANT_MEDICAL_OFFICE',
  // ---- Special review ----
  LABORATORY_LIFE_SCIENCE: 'LABORATORY_LIFE_SCIENCE',
  DATA_CENTER: 'DATA_CENTER',
  COWORKING_BUSINESS: 'COWORKING_BUSINESS',
  CONVERTED_RESIDENTIAL_OFFICE: 'CONVERTED_RESIDENTIAL_OFFICE',
  MIXED_USE_OFFICE: 'MIXED_USE_OFFICE',
  AMBIGUOUS_OFFICE: 'AMBIGUOUS_OFFICE',
  NOT_OFFICE: 'NOT_OFFICE',
});

/** Subtypes that belong to the MEDICAL asset family (OFFICE_MEDICAL lane). */
export const MEDICAL_SUBTYPES = Object.freeze([
  OFFICE_SUBTYPE.MEDICAL_OFFICE_BUILDING,
  OFFICE_SUBTYPE.DENTAL_OFFICE,
  OFFICE_SUBTYPE.OUTPATIENT_CLINIC,
  OFFICE_SUBTYPE.URGENT_CARE,
  OFFICE_SUBTYPE.AMBULATORY_SURGERY_CENTER,
  OFFICE_SUBTYPE.IMAGING_CENTER,
  OFFICE_SUBTYPE.SPECIALTY_MEDICAL_OFFICE,
  OFFICE_SUBTYPE.HOSPITAL_AFFILIATED_MOB,
  OFFICE_SUBTYPE.OWNER_USER_MEDICAL,
  OFFICE_SUBTYPE.VACANT_MEDICAL_OFFICE,
]);

/**
 * Mission §1 & §2: record-level classification — what KIND of record this is,
 * hardened against specialty / business-sale / mixed-use / converted-residential
 * false positives. A data center, laboratory, life-science facility, hospital or
 * coworking OPERATING BUSINESS must NOT silently enter ordinary office pricing.
 */
export const OFFICE_RECORD_CLASS = Object.freeze({
  MULTI_TENANT_OFFICE: 'MULTI_TENANT_OFFICE',
  SINGLE_TENANT_OFFICE: 'SINGLE_TENANT_OFFICE',
  OWNER_USER_OFFICE: 'OWNER_USER_OFFICE',
  OFFICE_CONDOMINIUM: 'OFFICE_CONDOMINIUM',
  GOVERNMENT_OFFICE: 'GOVERNMENT_OFFICE',
  MEDICAL_OFFICE_BUILDING: 'MEDICAL_OFFICE_BUILDING',
  OWNER_USER_MEDICAL: 'OWNER_USER_MEDICAL',
  VACANT_OFFICE: 'VACANT_OFFICE',
  VACANT_MEDICAL_OFFICE: 'VACANT_MEDICAL_OFFICE',
  OFFICE_REDEVELOPMENT: 'OFFICE_REDEVELOPMENT',
  // ---- Special-review / non-ordinary-office buckets (route to review / future lane) ----
  LABORATORY_LIFE_SCIENCE: 'LABORATORY_LIFE_SCIENCE',
  DATA_CENTER: 'DATA_CENTER',
  HOSPITAL_FACILITY: 'HOSPITAL_FACILITY',
  COWORKING_BUSINESS: 'COWORKING_BUSINESS',
  CONVERTED_RESIDENTIAL_OFFICE: 'CONVERTED_RESIDENTIAL_OFFICE',
  MIXED_USE_OFFICE_RESIDENTIAL: 'MIXED_USE_OFFICE_RESIDENTIAL',
  AMBIGUOUS_OFFICE: 'AMBIGUOUS_OFFICE',
  NOT_OFFICE: 'NOT_OFFICE',
});

/** Record classes that may be priced/underwritten as genuine office real estate. */
export const PRICING_ELIGIBLE_RECORD_CLASSES = Object.freeze([
  OFFICE_RECORD_CLASS.MULTI_TENANT_OFFICE,
  OFFICE_RECORD_CLASS.SINGLE_TENANT_OFFICE,
  OFFICE_RECORD_CLASS.GOVERNMENT_OFFICE,
  OFFICE_RECORD_CLASS.MEDICAL_OFFICE_BUILDING,
]);

/** Record classes priced ONLY in the owner-user universe, never as investor exit. */
export const OWNER_USER_RECORD_CLASSES = Object.freeze([
  OFFICE_RECORD_CLASS.OWNER_USER_OFFICE,
  OFFICE_RECORD_CLASS.OWNER_USER_MEDICAL,
  OFFICE_RECORD_CLASS.OFFICE_CONDOMINIUM,
]);

/**
 * Special-review record classes that require a specialized lane and must NEVER be
 * priced as ordinary office without specialized review (mission §2).
 */
export const SPECIAL_REVIEW_RECORD_CLASSES = Object.freeze([
  OFFICE_RECORD_CLASS.LABORATORY_LIFE_SCIENCE,
  OFFICE_RECORD_CLASS.DATA_CENTER,
  OFFICE_RECORD_CLASS.HOSPITAL_FACILITY,
  OFFICE_RECORD_CLASS.COWORKING_BUSINESS,
]);

/** Minimum classifier confidence to treat a record as genuine, priceable office. */
export const GENUINE_OFFICE_MIN_CONFIDENCE = 60;

/** Item 5F §24: office-model production-readiness states (ordered, coarse). */
export const OFFICE_READINESS = Object.freeze({
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
export const OFFICE_TENANCY = Object.freeze({
  SINGLE_TENANT: 'SINGLE_TENANT',
  MULTI_TENANT: 'MULTI_TENANT',
  OWNER_OCCUPIED: 'OWNER_OCCUPIED',
  VACANT: 'VACANT',
  UNKNOWN: 'UNKNOWN',
});

/** Mission §3: lifecycle/operational status, distinct from tenancy structure. */
export const OFFICE_OPERATIONAL_STATUS = Object.freeze({
  STABILIZED: 'STABILIZED',
  VALUE_ADD: 'VALUE_ADD',
  LEASE_UP: 'LEASE_UP',
  REDEVELOPMENT: 'REDEVELOPMENT',
  VACANT: 'VACANT',
  UNKNOWN: 'UNKNOWN',
});

/** Office building class (a distinct dimension from subtype). */
export const OFFICE_CLASS = Object.freeze({
  CLASS_A: 'CLASS_A',
  CLASS_B: 'CLASS_B',
  CLASS_C: 'CLASS_C',
  UNKNOWN: 'UNKNOWN',
});

/** Office location/market position (a distinct dimension from subtype). */
export const OFFICE_LOCATION = Object.freeze({
  CBD: 'CBD',
  SUBURBAN: 'SUBURBAN',
  UNKNOWN: 'UNKNOWN',
});

/** Office building height tier (drives operating cost: elevators, systems). */
export const OFFICE_HEIGHT = Object.freeze({
  LOW_RISE: 'LOW_RISE',
  MID_RISE: 'MID_RISE',
  HIGH_RISE: 'HIGH_RISE',
  UNKNOWN: 'UNKNOWN',
});

/** Mission §4: office lease structures. NNN is NEVER inferred from one pass-through. */
export const LEASE_TYPE = Object.freeze({
  FULL_SERVICE_GROSS: 'FULL_SERVICE_GROSS',
  MODIFIED_GROSS: 'MODIFIED_GROSS',
  TRIPLE_NET: 'TRIPLE_NET',
  DOUBLE_NET: 'DOUBLE_NET',
  SINGLE_NET: 'SINGLE_NET',
  ABSOLUTE_NET: 'ABSOLUTE_NET',
  OWNER_OCCUPIED: 'OWNER_OCCUPIED',
  COWORKING_LICENSE: 'COWORKING_LICENSE', // NOT an ordinary long-term office lease
  GROUND_LEASE: 'GROUND_LEASE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Landlord expense-recovery exposure by lease type — the fraction of recoverable
 * operating expenses the LANDLORD ultimately bears (leakage). Full-service-gross
 * keeps nearly all opex with the landlord; absolute/triple net shift it to the
 * tenant. LABELED assumption; never assumes 100% NNN recovery (mission §8). A
 * coworking license behaves like a gross-plus-service arrangement (landlord/
 * operator bears opex) — and its service revenue is excluded entirely (§18).
 */
export const LANDLORD_EXPENSE_EXPOSURE = Object.freeze({
  FULL_SERVICE_GROSS: 1.0,
  MODIFIED_GROSS: 0.65, // tenant pays increases over a base year
  TRIPLE_NET: 0.05, // structural/vacancy leakage even under NNN
  DOUBLE_NET: 0.25,
  SINGLE_NET: 0.55,
  ABSOLUTE_NET: 0.0,
  OWNER_OCCUPIED: 1.0,
  COWORKING_LICENSE: 1.0,
  GROUND_LEASE: 0.0,
  UNKNOWN: 0.75, // conservative: full-service-gross is the office default
});

/** Mission §5: general-office tenant credit classes. A brand is NEVER a guaranty. */
export const TENANT_CREDIT_CLASS = Object.freeze({
  INVESTMENT_GRADE_CORPORATE: 'INVESTMENT_GRADE_CORPORATE',
  NATIONAL_CORPORATE: 'NATIONAL_CORPORATE',
  REGIONAL_CORPORATE: 'REGIONAL_CORPORATE',
  LOCAL_PROFESSIONAL: 'LOCAL_PROFESSIONAL',
  GOVERNMENT: 'GOVERNMENT',
  NONPROFIT: 'NONPROFIT',
  LAW_FIRM: 'LAW_FIRM',
  FINANCIAL_SERVICES: 'FINANCIAL_SERVICES',
  TECHNOLOGY: 'TECHNOLOGY',
  COWORKING_OPERATOR: 'COWORKING_OPERATOR',
  OWNER_OCCUPANT: 'OWNER_OCCUPANT',
  UNKNOWN: 'UNKNOWN',
});

/** Mission §5: medical-office tenant credit classes. */
export const MEDICAL_TENANT_CLASS = Object.freeze({
  HEALTH_SYSTEM: 'HEALTH_SYSTEM',
  HOSPITAL_AFFILIATE: 'HOSPITAL_AFFILIATE',
  NATIONAL_HEALTHCARE_OPERATOR: 'NATIONAL_HEALTHCARE_OPERATOR',
  PHYSICIAN_GROUP: 'PHYSICIAN_GROUP',
  DENTAL_GROUP: 'DENTAL_GROUP',
  IMAGING_OPERATOR: 'IMAGING_OPERATOR',
  SURGERY_CENTER_OPERATOR: 'SURGERY_CENTER_OPERATOR',
  URGENT_CARE_OPERATOR: 'URGENT_CARE_OPERATOR',
  INDIVIDUAL_PRACTICE: 'INDIVIDUAL_PRACTICE',
  MEDICAL_FRANCHISEE: 'MEDICAL_FRANCHISEE',
  UNKNOWN_MEDICAL: 'UNKNOWN_MEDICAL',
});

/** Guaranty strength ordering (higher = stronger) — only when EVIDENCED. */
export const GUARANTY_STRENGTH = Object.freeze({
  CORPORATE_INVESTMENT_GRADE: 'CORPORATE_INVESTMENT_GRADE',
  CORPORATE: 'CORPORATE',
  HEALTH_SYSTEM_CREDIT: 'HEALTH_SYSTEM_CREDIT',
  GROUP_PRACTICE: 'GROUP_PRACTICE',
  PERSONAL: 'PERSONAL',
  LIMITED_OR_NONE: 'LIMITED_OR_NONE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Modeled market cap-rate defaults by subtype (LABELED MARKET_MODELED). Medical
 * office and net-leased single-tenant trade tighter; commodity suburban Class C
 * and vacant office widest. NEVER used to manufacture an OBSERVED cap rate.
 */
export const OFFICE_DEFAULT_CAP_RATE = Object.freeze({
  CBD_CLASS_A_OFFICE: 0.07,
  CBD_CLASS_B_OFFICE: 0.085,
  CBD_CLASS_C_OFFICE: 0.10,
  SUBURBAN_CLASS_A_OFFICE: 0.075,
  SUBURBAN_CLASS_B_OFFICE: 0.085,
  SUBURBAN_CLASS_C_OFFICE: 0.095,
  LOW_RISE_OFFICE: 0.085,
  MID_RISE_OFFICE: 0.08,
  HIGH_RISE_OFFICE: 0.075,
  SINGLE_TENANT_OFFICE: 0.075,
  MULTI_TENANT_OFFICE: 0.085,
  CREATIVE_OFFICE: 0.07,
  GOVERNMENT_OFFICE: 0.07,
  CORPORATE_CAMPUS: 0.08,
  OFFICE_CONDOMINIUM: 0.085,
  VACANT_OFFICE: 0.11,
  OFFICE_REDEVELOPMENT: 0.12,
  // ---- Medical ----
  MEDICAL_OFFICE_BUILDING: 0.07,
  DENTAL_OFFICE: 0.075,
  OUTPATIENT_CLINIC: 0.07,
  URGENT_CARE: 0.068,
  AMBULATORY_SURGERY_CENTER: 0.072,
  IMAGING_CENTER: 0.072,
  SPECIALTY_MEDICAL_OFFICE: 0.073,
  HOSPITAL_AFFILIATED_MOB: 0.062,
  VACANT_MEDICAL_OFFICE: 0.10,
  UNKNOWN: 0.085,
});

/** Tenant-credit cap-rate adjustment (bps, +widens / −tightens). */
export const CREDIT_CAP_ADJUSTMENT_BPS = Object.freeze({
  INVESTMENT_GRADE_CORPORATE: -75,
  NATIONAL_CORPORATE: -45,
  REGIONAL_CORPORATE: -15,
  GOVERNMENT: -40,
  LAW_FIRM: -10,
  FINANCIAL_SERVICES: -10,
  TECHNOLOGY: 10, // higher downsizing/WFH exposure
  LOCAL_PROFESSIONAL: 40,
  NONPROFIT: 20,
  COWORKING_OPERATOR: 75, // durable-income risk
  OWNER_OCCUPANT: 30,
  UNKNOWN: 50,
  // ---- Medical ----
  HEALTH_SYSTEM: -75,
  HOSPITAL_AFFILIATE: -50,
  NATIONAL_HEALTHCARE_OPERATOR: -40,
  PHYSICIAN_GROUP: -10,
  DENTAL_GROUP: 0,
  IMAGING_OPERATOR: -5,
  SURGERY_CENTER_OPERATOR: -10,
  URGENT_CARE_OPERATOR: -5,
  INDIVIDUAL_PRACTICE: 45,
  MEDICAL_FRANCHISEE: 25,
  UNKNOWN_MEDICAL: 50,
});

/** Cap-rate plausibility window for qualifying observed office cap evidence. */
export const OFFICE_CAP_RATE_BOUNDS = Object.freeze({ min: 0.04, max: 0.16 });

/**
 * Office operating-expense assumptions (LABELED). % lines are of EGR; per-RSF
 * lines are USD per rentable-square-foot per year. Distinct from retail/MF/
 * storage: office carries janitorial, elevator, security, HVAC and (for full-
 * service) tenant-suite utilities. Medical intensity adds material maintenance.
 */
export const OFFICE_OPEX_ASSUMPTIONS = Object.freeze({
  property_tax_rate_of_value: 0.018,
  insurance_per_rsf: 0.55,
  utilities_per_rsf: 2.40,
  repairs_per_rsf: 1.05,
  hvac_per_rsf: 0.70,
  elevator_per_rsf: 0.18, // applied for mid/high-rise
  janitorial_per_rsf: 1.35,
  security_per_rsf: 0.55,
  landscaping_snow_per_rsf: 0.30,
  payroll_per_rsf: 0.80,
  management_pct: 0.04, // of EGR
  administrative_pct: 0.015,
  legal_accounting_pct: 0.01,
  marketing_pct: 0.005,
  parking_ops_per_space: 250, // per structured/covered space per year
  reserves_per_rsf: 0.25,
  medical_systems_per_rsf: 1.10, // additional medical-intensity maintenance
});

/** Ordered office operating-expense line keys (drives known/assumed reporting). */
export const OFFICE_EXPENSE_CATEGORIES = Object.freeze([
  'property_taxes', 'insurance', 'utilities', 'repairs_maintenance', 'hvac',
  'elevator', 'janitorial', 'security', 'landscaping_snow', 'payroll',
  'management', 'administrative', 'legal_accounting', 'marketing',
  'parking_operations', 'medical_systems', 'replacement_reserves',
]);

/**
 * Lease rollover / re-tenanting assumptions (LABELED). Office TI/LC and downtime
 * are materially higher than retail; medical TI is higher still (specialized
 * buildout) with greater relocation friction (longer expected retention). Costs
 * reduce value and are never double-counted with NOI normalization (§10, §17).
 */
export const OFFICE_ROLLOVER_ASSUMPTIONS = Object.freeze({
  downtime_months_office: 10,
  downtime_months_large_block: 16, // full-floor / large-block tenants
  downtime_months_medical: 8, // higher relocation friction → shorter vacancy
  free_rent_months: 6,
  ti_per_rsf_new_office: 45,
  ti_per_rsf_renewal_office: 20,
  ti_per_rsf_new_medical: 90, // specialized medical buildout
  ti_per_rsf_renewal_medical: 35,
  leasing_commission_pct: 0.06, // of total lease value over term
  legal_design_per_suite: 8_000,
  renewal_probability_credit: 0.78,
  renewal_probability_local: 0.55,
  renewal_probability_medical: 0.85, // relocation friction lifts retention
  renewal_rent_factor: 0.97,
  new_lease_rent_factor: 1.0,
});

/** Price-per-RSF plausibility window by subtype (qualifying comp sanity, USD/RSF). */
export const OFFICE_PPRSF_BOUNDS = Object.freeze({
  CBD_CLASS_A_OFFICE: { low: 150, high: 1200 },
  CBD_CLASS_B_OFFICE: { low: 80, high: 500 },
  CBD_CLASS_C_OFFICE: { low: 40, high: 300 },
  SUBURBAN_CLASS_A_OFFICE: { low: 120, high: 600 },
  SUBURBAN_CLASS_B_OFFICE: { low: 70, high: 350 },
  SUBURBAN_CLASS_C_OFFICE: { low: 35, high: 250 },
  LOW_RISE_OFFICE: { low: 60, high: 400 },
  MID_RISE_OFFICE: { low: 80, high: 500 },
  HIGH_RISE_OFFICE: { low: 120, high: 900 },
  SINGLE_TENANT_OFFICE: { low: 70, high: 500 },
  MULTI_TENANT_OFFICE: { low: 60, high: 450 },
  CREATIVE_OFFICE: { low: 120, high: 700 },
  OFFICE_CONDOMINIUM: { low: 120, high: 700 },
  GOVERNMENT_OFFICE: { low: 80, high: 450 },
  VACANT_OFFICE: { low: 25, high: 250 },
  // ---- Medical ----
  MEDICAL_OFFICE_BUILDING: { low: 120, high: 700 },
  DENTAL_OFFICE: { low: 130, high: 650 },
  OUTPATIENT_CLINIC: { low: 130, high: 700 },
  AMBULATORY_SURGERY_CENTER: { low: 180, high: 900 },
  IMAGING_CENTER: { low: 180, high: 900 },
  HOSPITAL_AFFILIATED_MOB: { low: 150, high: 800 },
  UNKNOWN: { low: 25, high: 1200 },
});

/** Below this RSF a multi-tenant office "building" is treated as a small/single-tenant asset. */
export const MULTI_TENANT_MIN_RSF = 10_000;

/** Below this RSF an office record is structurally implausible as a commercial office building. */
export const OFFICE_IMPLAUSIBLE_RSF = 800;

/** Stabilized occupancy assumption for an office building (labeled). */
export const OFFICE_STABILIZED_OCCUPANCY = 0.90;

/** Occupancy bands for operational classification (physical occupancy). */
export const OFFICE_OCCUPANCY_BANDS = Object.freeze({
  stabilized_min: 0.88,
  value_add_max: 0.87,
  lease_up_max: 0.60,
});

/**
 * Default rentable-to-usable load factor (common-area factor) when only one of
 * rentable/usable area is known. LABELED; multi-tenant buildings carry higher
 * load factors than single-tenant. Never fabricated as precision.
 */
export const DEFAULT_LOAD_FACTOR = Object.freeze({
  MULTI_TENANT: 1.15,
  SINGLE_TENANT: 1.05,
  UNKNOWN: 1.12,
});

/** Mission §19: likely general-office buyer archetypes. */
export const OFFICE_BUYER_ARCHETYPE = Object.freeze({
  LOCAL_OFFICE_INVESTOR: 'LOCAL_OFFICE_INVESTOR',
  REGIONAL_OFFICE_OPERATOR: 'REGIONAL_OFFICE_OPERATOR',
  PRIVATE_EQUITY_OFFICE_FUND: 'PRIVATE_EQUITY_OFFICE_FUND',
  OFFICE_REIT: 'OFFICE_REIT',
  OWNER_USER: 'OWNER_USER',
  GOVERNMENT_INSTITUTIONAL_USER: 'GOVERNMENT_INSTITUTIONAL_USER',
  REDEVELOPMENT_BUYER: 'REDEVELOPMENT_BUYER',
  DISTRESSED_BUYER: 'DISTRESSED_BUYER',
  OFFICE_CONDO_BUYER: 'OFFICE_CONDO_BUYER',
});

/** Mission §19: likely medical-office buyer archetypes. */
export const MEDICAL_BUYER_ARCHETYPE = Object.freeze({
  HEALTHCARE_REIT: 'HEALTHCARE_REIT',
  MEDICAL_OFFICE_OPERATOR: 'MEDICAL_OFFICE_OPERATOR',
  PRIVATE_EQUITY_HEALTHCARE_RE: 'PRIVATE_EQUITY_HEALTHCARE_RE',
  HEALTH_SYSTEM: 'HEALTH_SYSTEM',
  PHYSICIAN_GROUP: 'PHYSICIAN_GROUP',
  OWNER_USER_MEDICAL_BUYER: 'OWNER_USER_MEDICAL_BUYER',
  REGIONAL_INVESTOR: 'REGIONAL_INVESTOR',
  REDEVELOPMENT_BUYER: 'REDEVELOPMENT_BUYER',
});

/** Office marketed-disposition strategy id — a commercial brokered sale, NOT
 *  residential novation (mission §20). */
export const OFFICE_DISPOSITION_STRATEGY = 'OFFICE_MARKETED_DISPOSITION';

/** Owner-user disposition strategy id — evaluated only with real owner-user demand. */
export const OFFICE_OWNER_USER_DISPOSITION_STRATEGY = 'OFFICE_OWNER_USER_DISPOSITION';

/** Office commercial debt-takeover model — the SUBJECT_TO slot, but a DISTINCT
 *  commercial debt model (never labeled residential subject-to) (mission §20). */
export const OFFICE_DEBT_MODEL = 'COMMERCIAL_DEBT_TAKEOVER';

/** Concentration thresholds for tenant / industry risk (mission §5, §6). */
export const OFFICE_CONCENTRATION = Object.freeze({
  single_tenant_high_share: 0.4,
  top_five_high_share: 0.8,
  industry_high_share: 0.5,
});

/**
 * Medical-use premium/discount bounds vs ordinary-office support (mission §12,
 * §15). Medical value cannot exceed ordinary-office support without defensible
 * tenant/buildout evidence; the premium is capped and must be EARNED.
 */
export const MEDICAL_USE_PREMIUM = Object.freeze({
  max_premium_pct: 0.25, // above ordinary-office support, only when earned
  unsupported_premium_pct: 0.0, // no premium without tenant/buildout evidence
  conversion_cost_per_rsf: 35, // cost to convert medical → ordinary office (labeled)
  specialized_ti_per_rsf: 90, // replacement cost of medical buildout (labeled)
});

/**
 * Office distress / functional-obsolescence labeled factors (mission §11). Used
 * to flag and discount; never to capitalize occupied historical NOI against
 * contradicting vacancy/rollover evidence.
 */
export const OFFICE_OBSOLESCENCE = Object.freeze({
  wfh_demand_risk_discount: 0.08, // soft-demand discount when WFH risk is material
  inefficient_floorplate_discount: 0.05,
  outdated_systems_discount: 0.05,
  weak_parking_discount: 0.04,
  conversion_floor_factor: 0.45, // dark/conversion value floor vs stabilized
  demolition_per_rsf: 12,
  land_per_sqft_fallback: 10,
});
