/**
 * Acquisition Engine V3 — Item 5D §8 & §11: storage comparable transactions +
 * market/demand context.
 *
 * Comp rules (mission §8):
 *   - EXACT self-storage only. Generic warehouse / industrial flex / parking /
 *     mobile-home parks / storage condos (vs operating facility) / land are
 *     REJECTED, never substituted.
 *   - Portfolio / package consideration without per-parcel allocation is
 *     DEMAND-ONLY — it can signal buyer appetite but contributes no pricing.
 *   - Comps are bucketed into separate universes (stabilized / value-add /
 *     lease-up / distressed / development-conversion / institutional single-asset
 *     / portfolio demand-only).
 *
 * Market intelligence (mission §11): Census / market data used only as CONTEXT;
 * storage demand is never inferred from Census alone; competitor / pipeline data
 * is reported UNAVAILABLE rather than fabricated. No protected-class composition.
 *
 * Pure & deterministic.
 */

import { num, clean, lower, round, roundMoney } from './modelConstants.js';
import { classifySelfStorageFacility } from './selfStorageClassification.js';
import {
  STORAGE_OPERATIONAL_STATUS as OS,
  STORAGE_PPNRSF_BOUNDS,
  STORAGE_PPU_BOUNDS,
} from './selfStorageConstants.js';

export const STORAGE_COMP_UNIVERSE = Object.freeze({
  STABILIZED: 'stabilized_storage',
  VALUE_ADD: 'value_add_storage',
  LEASE_UP: 'lease_up_storage',
  DISTRESSED: 'distressed_storage',
  DEVELOPMENT: 'development_conversion_storage',
  INSTITUTIONAL_SINGLE: 'institutional_single_asset',
  PORTFOLIO_DEMAND_ONLY: 'portfolio_demand_only',
});

const WAREHOUSE_RE = /(warehouse|distribution|logistics|industrial|flex|parking|mobile home|manufactured)/;

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

/**
 * Qualify a single candidate storage transaction.
 * @returns {{ qualified, reason, universe, demand_only, comp }}
 */
export function qualifyStorageComp(row = {}, { subjectFacilityClass = 'UNKNOWN' } = {}) {
  const blobText = lower([row.property_type, row.normalized_asset_class, row.asset_class, row.asset_subtype, row.commercial_property_type].filter(Boolean).join(' '));
  const cls = classifySelfStorageFacility(row);

  // Exact self-storage only — reject generic warehouse/industrial/etc.
  if (!cls.is_self_storage) {
    return { qualified: false, demand_only: false, universe: null, reason: 'not_self_storage', comp: null };
  }
  if (WAREHOUSE_RE.test(blobText) && !/storage/.test(blobText)) {
    return { qualified: false, demand_only: false, universe: null, reason: 'generic_warehouse_industrial_rejected', comp: null };
  }
  if (cls.facility_type === 'STORAGE_CONDO' || cls.facility_type === 'PORTABLE_STORAGE_BUSINESS') {
    return { qualified: false, demand_only: false, universe: null, reason: `incompatible_${lower(cls.facility_type)}`, comp: null };
  }

  const price = salePrice(row);
  const nrsf = num(row.net_rentable_square_feet) ?? num(row.building_square_feet) ?? num(row.sqft) ?? null;
  const units = num(row.units_count) ?? num(row.storage_units) ?? null;

  // Package / portfolio → DEMAND-ONLY (no pricing contribution).
  if (isPackage(row)) {
    return {
      qualified: false, demand_only: true, universe: STORAGE_COMP_UNIVERSE.PORTFOLIO_DEMAND_ONLY,
      reason: 'portfolio_package_demand_only',
      comp: { buyer: clean(row.buyer_name) || null, state: clean(row.property_address_state ?? row.property_state) || null, sale_date: row.sale_date ?? null, demand_only: true },
    };
  }

  if (price === null || price <= 0) {
    return { qualified: false, demand_only: false, universe: null, reason: 'no_qualified_individual_price', comp: null };
  }

  // Plausibility sanity (price-per-NRSF / per-unit).
  const ppnrsf = nrsf && nrsf > 0 ? round(price / nrsf, 2) : null;
  const ppu = units && units > 0 ? roundMoney(price / units) : null;
  const bounds = STORAGE_PPNRSF_BOUNDS[subjectFacilityClass] ?? STORAGE_PPNRSF_BOUNDS.UNKNOWN;
  if (ppnrsf !== null && (ppnrsf < bounds.low * 0.4 || ppnrsf > bounds.high * 2)) {
    return { qualified: false, demand_only: false, universe: null, reason: `ppnrsf_${ppnrsf}_out_of_range`, comp: null };
  }

  const universe = compUniverse(row);
  return {
    qualified: true, demand_only: false, universe, reason: 'qualified_self_storage_sale',
    comp: {
      facility_type: cls.facility_type,
      operational_status: universe,
      sale_price: roundMoney(price),
      nrsf: nrsf !== null ? roundMoney(nrsf) : null,
      units,
      price_per_nrsf: ppnrsf,
      price_per_unit: ppu,
      occupancy: num(row.occupancy) ?? null,
      climate_control_pct: num(row.climate_control_percentage) ?? null,
      year_built: num(row.year_built) ?? null,
      state: clean(row.property_address_state ?? row.property_state) || null,
      sale_date: row.sale_date ?? null,
      buyer: clean(row.buyer_name) || null,
      transaction_channel: clean(row.transaction_channel ?? row.last_sale_doc_type) || null,
    },
  };
}

function compUniverse(row) {
  const occ = num(row.occupancy);
  const status = lower(row.operational_status);
  if (/develop|construction|conversion/.test(status) || row.under_construction === true) return STORAGE_COMP_UNIVERSE.DEVELOPMENT;
  if (/distress|reo|foreclos/.test(status)) return STORAGE_COMP_UNIVERSE.DISTRESSED;
  if (/lease.?up/.test(status)) return STORAGE_COMP_UNIVERSE.LEASE_UP;
  const price = salePrice(row);
  if (price !== null && price >= 10_000_000) return STORAGE_COMP_UNIVERSE.INSTITUTIONAL_SINGLE;
  if (occ !== null) {
    const o = occ > 1 ? occ / 100 : occ;
    if (o < 0.85) return STORAGE_COMP_UNIVERSE.VALUE_ADD;
    return STORAGE_COMP_UNIVERSE.STABILIZED;
  }
  return STORAGE_COMP_UNIVERSE.STABILIZED;
}

/**
 * Build the bucketed comparable universes from raw candidates.
 * @returns universes keyed by STORAGE_COMP_UNIVERSE, plus rejected + demand_only.
 */
export function buildStorageComparables(candidates = [], { subjectFacilityClass = 'UNKNOWN' } = {}) {
  const universes = {
    [STORAGE_COMP_UNIVERSE.STABILIZED]: [],
    [STORAGE_COMP_UNIVERSE.VALUE_ADD]: [],
    [STORAGE_COMP_UNIVERSE.LEASE_UP]: [],
    [STORAGE_COMP_UNIVERSE.DISTRESSED]: [],
    [STORAGE_COMP_UNIVERSE.DEVELOPMENT]: [],
    [STORAGE_COMP_UNIVERSE.INSTITUTIONAL_SINGLE]: [],
  };
  const demandOnly = [];
  const rejected = [];

  for (const row of candidates ?? []) {
    const r = qualifyStorageComp(row, { subjectFacilityClass });
    if (r.qualified) {
      (universes[r.universe] ?? universes[STORAGE_COMP_UNIVERSE.STABILIZED]).push(r.comp);
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
  };
}

/* -------------------------------------------------------------------------- */
/* Market / demand intelligence (§11)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Demand CONTEXT only. Storage demand is never inferred from Census alone, and
 * supply (competitors / construction pipeline) is reported UNAVAILABLE unless
 * explicitly provided. No protected-class composition is used.
 */
export function buildStorageMarketContext({ market = {}, competitors = null, pipeline = null } = {}) {
  const factors = [];
  const missing = [];
  let score = null;

  const add = (key, value, weight) => {
    const v = num(value);
    if (v === null) { missing.push(key); return; }
    factors.push({ factor: key, value: v, weight });
  };
  add('household_growth', market.household_growth, 0.25);
  add('population_growth', market.population_growth, 0.2);
  add('renter_growth', market.renter_growth, 0.15);
  add('housing_turnover', market.housing_turnover, 0.1);
  add('multifamily_development', market.multifamily_development, 0.1);
  add('median_income', market.median_income, 0.1);
  add('business_formation', market.business_formation, 0.1);

  if (factors.length >= 3) {
    // Normalized weighted blend of available growth factors (context, not truth).
    const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
    const blended = factors.reduce((s, f) => s + clampGrowth(f.value) * f.weight, 0) / totalWeight;
    score = round(clampScore(50 + blended * 50), 0);
  }

  const supplyKnown = competitors !== null || pipeline !== null;
  return {
    demand_context_score: score,
    demand_context_basis: factors.map((f) => f.factor),
    growth_support: score === null ? 'UNKNOWN' : score >= 60 ? 'SUPPORTIVE' : score >= 45 ? 'NEUTRAL' : 'SOFT',
    supply_risk_status: supplyKnown
      ? supplyRisk(competitors, pipeline)
      : 'UNAVAILABLE',
    competitor_count: competitors !== null ? num(competitors) : null,
    construction_pipeline: pipeline !== null ? num(pipeline) : null,
    market_stability: score === null ? 'UNKNOWN' : (score >= 50 ? 'STABLE' : 'WATCH'),
    confidence: score === null ? 10 : clampScore(30 + factors.length * 8),
    source_vintage: market.vintage ?? null,
    missing_factors: missing,
    note: supplyKnown ? null : 'Competitor / construction-pipeline supply data unavailable — not fabricated.',
  };
}

function supplyRisk(competitors, pipeline) {
  const c = num(competitors) ?? 0;
  const p = num(pipeline) ?? 0;
  if (p > 0 || c >= 8) return 'ELEVATED';
  if (c >= 4) return 'MODERATE';
  return 'LOW';
}
function clampGrowth(v) { return Math.max(-1, Math.min(1, v / 5)); } // % → [-1,1]
function clampScore(v) { return Math.max(0, Math.min(100, v)); }
