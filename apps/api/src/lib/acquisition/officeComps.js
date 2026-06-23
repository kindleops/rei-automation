/**
 * Acquisition Engine V3 — Item 5F §13: office comparable transactions + market
 * context.
 *
 * Comp rules (mission §13):
 *   - EXACT compatible office only, and MEDICAL office comps are kept in a separate
 *     universe from general office. Retail / industrial / flex / warehouse / mixed-
 *     use-without-allocation / operating-business value / land-as-stabilized /
 *     medical-equipment-or-business value are REJECTED, never substituted.
 *   - Comps are bucketed into separate office universes (CBD A/B/C, suburban A/B/C,
 *     low/mid/high-rise, single tenant, multi-tenant, owner-user, office condo,
 *     government, vacant value-add, medical, dental/clinic, hospital-affiliated MOB,
 *     redevelopment, special-review life science / data center).
 *   - Portfolio / package consideration without per-parcel allocation is DEMAND-
 *     ONLY — it can signal buyer appetite but contributes no pricing.
 *
 * Pure & deterministic.
 */

import { num, clean, lower, round, roundMoney } from './modelConstants.js';
import { classifyOfficeAsset } from './officeClassification.js';
import { OFFICE_SUBTYPE as ST, OFFICE_PPRSF_BOUNDS, MEDICAL_SUBTYPES } from './officeConstants.js';

export const OFFICE_COMP_UNIVERSE = Object.freeze({
  CBD_CLASS_A: 'cbd_class_a',
  CBD_CLASS_B: 'cbd_class_b',
  CBD_CLASS_C: 'cbd_class_c',
  SUBURBAN_CLASS_A: 'suburban_class_a',
  SUBURBAN_CLASS_B: 'suburban_class_b',
  SUBURBAN_CLASS_C: 'suburban_class_c',
  LOW_RISE: 'low_rise',
  MID_RISE: 'mid_rise',
  HIGH_RISE: 'high_rise',
  SINGLE_TENANT: 'single_tenant',
  MULTI_TENANT: 'multi_tenant',
  OWNER_USER: 'owner_user',
  OFFICE_CONDO: 'office_condo',
  GOVERNMENT: 'government',
  VACANT_VALUE_ADD: 'vacant_value_add',
  MEDICAL_OFFICE: 'medical_office',
  DENTAL_CLINIC: 'dental_clinic',
  HOSPITAL_AFFILIATED_MOB: 'hospital_affiliated_mob',
  REDEVELOPMENT: 'redevelopment',
  SPECIAL_REVIEW_LIFE_SCIENCE_DATA_CENTER: 'special_review_life_science_data_center',
  PORTFOLIO_DEMAND_ONLY: 'portfolio_demand_only',
});

/** Non-office asset types that must NEVER substitute for an office comp. */
const NON_OFFICE_RE = /(strip (mall|center)|shopping center|retail center|freestanding retail|storefront|warehouse|distribution|logistics|industrial|\bflex\b|apartment|multifamily|self.?storage|mini.?storage|hotel|motel|hospitality|mobile home|gas station)/;
const SPECIALTY_RE = /(business opportunity|franchise (for sale|resale)|operating business|medical (practice|equipment) (for sale|sale))/;
const SPECIAL_REVIEW_RE = /(laborator|life ?science|life-science|biotech|data ?center|colocation|hospital|inpatient)/;

function salePrice(row) {
  return num(row.sale_price) ?? num(row.saleprice) ?? num(row.mls_sold_price) ?? num(row.purchase_price) ?? null;
}

function isPackage(row) {
  const parcels = num(row.parcel_count) ?? num(row.parcels) ?? null;
  const portfolio = row.is_portfolio === true || row.portfolio === true ||
    /portfolio|package|multi.?property/i.test(clean(row.transaction_type ?? row.notes));
  const unallocated = row.price_is_allocated === false || (portfolio && num(row.allocated_price) === null);
  return Boolean((parcels !== null && parcels >= 2) || portfolio || unallocated);
}

/** Map a comp classification to its comp universe. */
function compUniverse(cls, row) {
  const status = lower(row.operational_status);
  const occ = num(row.occupancy);
  if (/redevelop|teardown/.test(status)) return OFFICE_COMP_UNIVERSE.REDEVELOPMENT;
  if ((occ !== null && (occ > 1 ? occ / 100 : occ) <= 0.02) || row.is_vacant === true) return OFFICE_COMP_UNIVERSE.VACANT_VALUE_ADD;
  if (cls.specialized_lane_required) return OFFICE_COMP_UNIVERSE.SPECIAL_REVIEW_LIFE_SCIENCE_DATA_CENTER;
  if (cls.is_medical) {
    switch (cls.subtype) {
      case ST.DENTAL_OFFICE: case ST.OUTPATIENT_CLINIC: case ST.URGENT_CARE: return OFFICE_COMP_UNIVERSE.DENTAL_CLINIC;
      case ST.HOSPITAL_AFFILIATED_MOB: return OFFICE_COMP_UNIVERSE.HOSPITAL_AFFILIATED_MOB;
      default: return OFFICE_COMP_UNIVERSE.MEDICAL_OFFICE;
    }
  }
  switch (cls.subtype) {
    case ST.CBD_CLASS_A_OFFICE: return OFFICE_COMP_UNIVERSE.CBD_CLASS_A;
    case ST.CBD_CLASS_B_OFFICE: return OFFICE_COMP_UNIVERSE.CBD_CLASS_B;
    case ST.CBD_CLASS_C_OFFICE: return OFFICE_COMP_UNIVERSE.CBD_CLASS_C;
    case ST.SUBURBAN_CLASS_A_OFFICE: return OFFICE_COMP_UNIVERSE.SUBURBAN_CLASS_A;
    case ST.SUBURBAN_CLASS_B_OFFICE: return OFFICE_COMP_UNIVERSE.SUBURBAN_CLASS_B;
    case ST.SUBURBAN_CLASS_C_OFFICE: return OFFICE_COMP_UNIVERSE.SUBURBAN_CLASS_C;
    case ST.HIGH_RISE_OFFICE: return OFFICE_COMP_UNIVERSE.HIGH_RISE;
    case ST.MID_RISE_OFFICE: return OFFICE_COMP_UNIVERSE.MID_RISE;
    case ST.LOW_RISE_OFFICE: return OFFICE_COMP_UNIVERSE.LOW_RISE;
    case ST.SINGLE_TENANT_OFFICE: return OFFICE_COMP_UNIVERSE.SINGLE_TENANT;
    case ST.OWNER_USER_OFFICE: return OFFICE_COMP_UNIVERSE.OWNER_USER;
    case ST.OFFICE_CONDOMINIUM: return OFFICE_COMP_UNIVERSE.OFFICE_CONDO;
    case ST.GOVERNMENT_OFFICE: return OFFICE_COMP_UNIVERSE.GOVERNMENT;
    default: return OFFICE_COMP_UNIVERSE.MULTI_TENANT;
  }
}

/** Subtypes considered compatible with the subject subtype (exact + tight neighbors). */
const SUBTYPE_COMPATIBLE = Object.freeze({
  [ST.CBD_CLASS_A_OFFICE]: new Set([ST.CBD_CLASS_A_OFFICE, ST.HIGH_RISE_OFFICE]),
  [ST.CBD_CLASS_B_OFFICE]: new Set([ST.CBD_CLASS_B_OFFICE, ST.CBD_CLASS_C_OFFICE, ST.MID_RISE_OFFICE]),
  [ST.CBD_CLASS_C_OFFICE]: new Set([ST.CBD_CLASS_C_OFFICE, ST.CBD_CLASS_B_OFFICE]),
  [ST.SUBURBAN_CLASS_A_OFFICE]: new Set([ST.SUBURBAN_CLASS_A_OFFICE, ST.LOW_RISE_OFFICE, ST.MID_RISE_OFFICE]),
  [ST.SUBURBAN_CLASS_B_OFFICE]: new Set([ST.SUBURBAN_CLASS_B_OFFICE, ST.SUBURBAN_CLASS_C_OFFICE, ST.LOW_RISE_OFFICE, ST.MULTI_TENANT_OFFICE]),
  [ST.SUBURBAN_CLASS_C_OFFICE]: new Set([ST.SUBURBAN_CLASS_C_OFFICE, ST.SUBURBAN_CLASS_B_OFFICE]),
  [ST.LOW_RISE_OFFICE]: new Set([ST.LOW_RISE_OFFICE, ST.SUBURBAN_CLASS_B_OFFICE, ST.MULTI_TENANT_OFFICE]),
  [ST.MID_RISE_OFFICE]: new Set([ST.MID_RISE_OFFICE, ST.SUBURBAN_CLASS_A_OFFICE, ST.CBD_CLASS_B_OFFICE]),
  [ST.HIGH_RISE_OFFICE]: new Set([ST.HIGH_RISE_OFFICE, ST.CBD_CLASS_A_OFFICE]),
  [ST.SINGLE_TENANT_OFFICE]: new Set([ST.SINGLE_TENANT_OFFICE, ST.OWNER_USER_OFFICE]),
  [ST.MULTI_TENANT_OFFICE]: new Set([ST.MULTI_TENANT_OFFICE, ST.LOW_RISE_OFFICE, ST.SUBURBAN_CLASS_B_OFFICE]),
  [ST.OWNER_USER_OFFICE]: new Set([ST.OWNER_USER_OFFICE, ST.SINGLE_TENANT_OFFICE, ST.OFFICE_CONDOMINIUM]),
  [ST.OFFICE_CONDOMINIUM]: new Set([ST.OFFICE_CONDOMINIUM, ST.OWNER_USER_OFFICE]),
  [ST.GOVERNMENT_OFFICE]: new Set([ST.GOVERNMENT_OFFICE, ST.SINGLE_TENANT_OFFICE]),
  // ---- Medical: kept separate; never compatible with general office ----
  [ST.MEDICAL_OFFICE_BUILDING]: new Set([ST.MEDICAL_OFFICE_BUILDING, ST.OUTPATIENT_CLINIC, ST.SPECIALTY_MEDICAL_OFFICE]),
  [ST.DENTAL_OFFICE]: new Set([ST.DENTAL_OFFICE, ST.OUTPATIENT_CLINIC, ST.MEDICAL_OFFICE_BUILDING]),
  [ST.OUTPATIENT_CLINIC]: new Set([ST.OUTPATIENT_CLINIC, ST.MEDICAL_OFFICE_BUILDING, ST.URGENT_CARE]),
  [ST.URGENT_CARE]: new Set([ST.URGENT_CARE, ST.OUTPATIENT_CLINIC, ST.MEDICAL_OFFICE_BUILDING]),
  [ST.AMBULATORY_SURGERY_CENTER]: new Set([ST.AMBULATORY_SURGERY_CENTER, ST.SPECIALTY_MEDICAL_OFFICE]),
  [ST.IMAGING_CENTER]: new Set([ST.IMAGING_CENTER, ST.SPECIALTY_MEDICAL_OFFICE]),
  [ST.HOSPITAL_AFFILIATED_MOB]: new Set([ST.HOSPITAL_AFFILIATED_MOB, ST.MEDICAL_OFFICE_BUILDING]),
  [ST.SPECIALTY_MEDICAL_OFFICE]: new Set([ST.SPECIALTY_MEDICAL_OFFICE, ST.MEDICAL_OFFICE_BUILDING]),
});

/**
 * Qualify a single candidate office transaction against the subject subtype.
 * @returns {{ qualified, reason, universe, demand_only, comp }}
 */
export function qualifyOfficeComp(row = {}, { subjectSubtype = ST.AMBIGUOUS_OFFICE } = {}) {
  const blobText = lower([row.property_type, row.normalized_asset_class, row.asset_class, row.asset_subtype, row.commercial_property_type, row.building_class].filter(Boolean).join(' '));
  const subjectMedical = MEDICAL_SUBTYPES.includes(subjectSubtype);

  // Reject non-office asset types outright (no substitution).
  if (NON_OFFICE_RE.test(blobText)) {
    return { qualified: false, demand_only: false, universe: null, reason: 'non_office_asset_rejected', comp: null };
  }
  if (SPECIALTY_RE.test(blobText)) {
    return { qualified: false, demand_only: false, universe: null, reason: 'business_or_equipment_value_rejected', comp: null };
  }

  const cls = classifyOfficeAsset(row);
  if (!cls.is_office) {
    return { qualified: false, demand_only: false, universe: null, reason: 'not_office', comp: null };
  }

  // Special-review uses (life science / data center / hospital) are isolated, never
  // substituted for ordinary office pricing.
  if (cls.specialized_lane_required || SPECIAL_REVIEW_RE.test(blobText)) {
    return { qualified: false, demand_only: false, universe: OFFICE_COMP_UNIVERSE.SPECIAL_REVIEW_LIFE_SCIENCE_DATA_CENTER, reason: 'special_review_use_isolated', comp: null };
  }

  // Package / portfolio → DEMAND-ONLY (no pricing contribution).
  if (isPackage(row)) {
    return {
      qualified: false, demand_only: true, universe: OFFICE_COMP_UNIVERSE.PORTFOLIO_DEMAND_ONLY,
      reason: 'portfolio_package_demand_only',
      comp: { buyer: clean(row.buyer_name) || null, state: clean(row.property_address_state ?? row.property_state) || null, sale_date: row.sale_date ?? null, demand_only: true },
    };
  }

  const price = salePrice(row);
  if (price === null || price <= 0) {
    return { qualified: false, demand_only: false, universe: null, reason: 'no_qualified_individual_price', comp: null };
  }

  // Medical/general isolation: never cross the medical boundary.
  if (subjectMedical !== cls.is_medical) {
    return { qualified: false, demand_only: false, universe: null, reason: cls.is_medical ? 'medical_comp_for_general_subject_rejected' : 'general_comp_for_medical_subject_rejected', comp: null };
  }

  // Subtype compatibility — exact + tight neighbor only.
  const compat = SUBTYPE_COMPATIBLE[subjectSubtype];
  if (compat && !compat.has(cls.subtype)) {
    return { qualified: false, demand_only: false, universe: null, reason: `subtype_mismatch_${lower(cls.subtype)}_vs_${lower(subjectSubtype)}`, comp: null };
  }

  const rsf = num(row.rentable_building_area) ?? num(row.net_rentable_area) ?? num(row.building_square_feet) ?? num(row.sqft) ?? null;
  const pprsf = rsf && rsf > 0 ? round(price / rsf, 2) : null;
  const bounds = OFFICE_PPRSF_BOUNDS[subjectSubtype] ?? OFFICE_PPRSF_BOUNDS.UNKNOWN;
  if (pprsf !== null && (pprsf < bounds.low * 0.4 || pprsf > bounds.high * 2)) {
    return { qualified: false, demand_only: false, universe: null, reason: `pprsf_${pprsf}_out_of_range`, comp: null };
  }

  const universe = compUniverse(cls, row);
  return {
    qualified: true, demand_only: false, universe, reason: 'qualified_office_sale',
    comp: {
      subtype: cls.subtype,
      is_medical: cls.is_medical,
      universe,
      sale_price: roundMoney(price),
      rsf: rsf !== null ? roundMoney(rsf) : null,
      price_per_rsf: pprsf,
      occupancy: num(row.occupancy) ?? null,
      cap_rate: num(row.cap_rate) ?? null,
      noi: num(row.noi) ?? null,
      tenant_credit: clean(row.tenant_credit) || null,
      wale_years: num(row.wale_years) ?? null,
      year_built: num(row.year_built) ?? null,
      building_class: cls.class,
      state: clean(row.property_address_state ?? row.property_state) || null,
      sale_date: row.sale_date ?? null,
      buyer: clean(row.buyer_name) || null,
      transaction_channel: clean(row.transaction_channel ?? row.last_sale_doc_type) || null,
    },
  };
}

/**
 * Build the bucketed comparable universes from raw candidates.
 * @returns universes keyed by OFFICE_COMP_UNIVERSE, plus rejected + demand_only.
 */
export function buildOfficeComparables(candidates = [], { subjectSubtype = ST.AMBIGUOUS_OFFICE } = {}) {
  const universes = {};
  for (const u of Object.values(OFFICE_COMP_UNIVERSE)) if (u !== OFFICE_COMP_UNIVERSE.PORTFOLIO_DEMAND_ONLY) universes[u] = [];
  const demandOnly = [];
  const rejected = [];

  for (const row of candidates ?? []) {
    const r = qualifyOfficeComp(row, { subjectSubtype });
    if (r.qualified) {
      (universes[r.universe] ?? universes[OFFICE_COMP_UNIVERSE.MULTI_TENANT]).push(r.comp);
    } else if (r.demand_only) {
      demandOnly.push(r.comp);
    } else {
      rejected.push({ reason: r.reason });
    }
  }

  const qualifiedCount = Object.values(universes).reduce((s, u) => s + u.length, 0);
  return {
    universes,
    demand_only: demandOnly,
    rejected,
    qualified_count: qualifiedCount,
    demand_only_count: demandOnly.length,
    rejected_count: rejected.length,
    package_rate: (qualifiedCount + demandOnly.length) > 0 ? round(demandOnly.length / (qualifiedCount + demandOnly.length), 3) : null,
    // Explicit invariant: portfolio/package is demand-only, never priced.
    portfolio_pricing_excluded: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Market / demand context (§13)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Office demand CONTEXT only. Office demand is driven by employment / office-using
 * jobs / WFH adoption; supply (competing vacancy / construction pipeline) is
 * reported UNAVAILABLE unless explicitly provided. No protected-class composition.
 */
export function buildOfficeMarketContext({ market = {}, competingVacancy = null, pipeline = null } = {}) {
  const factors = [];
  const missing = [];
  let score = null;

  const add = (key, value, weight) => {
    const v = num(value);
    if (v === null) { missing.push(key); return; }
    factors.push({ factor: key, value: v, weight });
  };
  add('employment_growth', market.employment_growth, 0.25);
  add('office_using_jobs_growth', market.office_using_jobs_growth, 0.25);
  add('population_growth', market.population_growth, 0.15);
  add('wage_growth', market.wage_growth ?? market.median_income_growth, 0.15);
  add('return_to_office_rate', market.return_to_office_rate, 0.2);

  if (factors.length >= 3) {
    const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
    const blended = factors.reduce((s, f) => s + clampGrowth(f.value) * f.weight, 0) / totalWeight;
    score = round(clampScore(50 + blended * 50), 0);
  }

  const supplyKnown = competingVacancy !== null || pipeline !== null;
  return {
    demand_context_score: score,
    demand_context_basis: factors.map((f) => f.factor),
    growth_support: score === null ? 'UNKNOWN' : score >= 60 ? 'SUPPORTIVE' : score >= 45 ? 'NEUTRAL' : 'SOFT',
    supply_risk_status: supplyKnown ? supplyRisk(competingVacancy, pipeline) : 'UNAVAILABLE',
    competing_vacancy_rate: competingVacancy !== null ? num(competingVacancy) : null,
    construction_pipeline: pipeline !== null ? num(pipeline) : null,
    wfh_risk_flag: market.return_to_office_rate != null && num(market.return_to_office_rate) < 50,
    market_stability: score === null ? 'UNKNOWN' : (score >= 50 ? 'STABLE' : 'WATCH'),
    confidence: score === null ? 10 : clampScore(30 + factors.length * 8),
    source_vintage: market.vintage ?? null,
    missing_factors: missing,
    note: supplyKnown ? null : 'Competing-vacancy / construction-pipeline supply data unavailable — not fabricated.',
  };
}

function supplyRisk(vacancy, pipeline) {
  const v = num(vacancy) ?? 0;
  const p = num(pipeline) ?? 0;
  if (p > 0 || v >= 0.2) return 'ELEVATED';
  if (v >= 0.12) return 'MODERATE';
  return 'LOW';
}
function clampGrowth(v) { return Math.max(-1, Math.min(1, v / 5)); }
function clampScore(v) { return Math.max(0, Math.min(100, v)); }
