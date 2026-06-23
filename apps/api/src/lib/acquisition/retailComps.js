/**
 * Acquisition Engine V3 — Item 5E §12: retail comparable transactions + market
 * context.
 *
 * Comp rules (mission §12):
 *   - EXACT compatible retail only. Office / warehouse / industrial flex / gas
 *     station (without specialty normalization) / restaurant business value /
 *     land-as-stabilized / mixed-use-as-pure-retail are REJECTED, never
 *     substituted.
 *   - Comps are bucketed into separate retail universes (neighborhood strip /
 *     unanchored strip / grocery anchored / community center / single-tenant net
 *     lease / freestanding / big box / retail condo / ground lease / vacant-value-
 *     add / redevelopment).
 *   - Portfolio / package consideration without per-parcel allocation is DEMAND-
 *     ONLY — it can signal buyer appetite but contributes no pricing.
 *
 * Pure & deterministic.
 */

import { num, clean, lower, round, roundMoney } from './modelConstants.js';
import { classifyRetailAsset } from './retailClassification.js';
import { RETAIL_SUBTYPE as ST, RETAIL_PPGLA_BOUNDS } from './retailConstants.js';

export const RETAIL_COMP_UNIVERSE = Object.freeze({
  NEIGHBORHOOD_STRIP: 'neighborhood_strip',
  UNANCHORED_STRIP: 'unanchored_strip',
  GROCERY_ANCHORED: 'grocery_anchored',
  COMMUNITY_CENTER: 'community_center',
  SINGLE_TENANT_NET_LEASE: 'single_tenant_net_lease',
  FREESTANDING: 'freestanding',
  BIG_BOX: 'big_box',
  RETAIL_CONDO: 'retail_condo',
  GROUND_LEASE: 'ground_lease',
  VACANT_VALUE_ADD: 'vacant_value_add',
  REDEVELOPMENT: 'redevelopment',
  PORTFOLIO_DEMAND_ONLY: 'portfolio_demand_only',
});

/** Non-retail asset types that must NEVER substitute for a retail comp. */
const NON_RETAIL_RE = /(office|medical office|\bmob\b|warehouse|distribution|logistics|industrial|\bflex\b|apartment|multifamily|self.?storage|mini.?storage|hotel|motel|hospitality|mobile home)/;
const SPECIALTY_RE = /(gas station|fuel|car ?wash|auto (repair|service|body)|dealership|business opportunity|franchise (for sale|resale))/;

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

/** Map a comp subtype to its comp universe. */
function compUniverse(subtype, row) {
  const status = lower(row.operational_status);
  const occ = num(row.occupancy);
  if (/redevelop|teardown/.test(status)) return RETAIL_COMP_UNIVERSE.REDEVELOPMENT;
  if ((occ !== null && (occ > 1 ? occ / 100 : occ) <= 0.02) || row.is_vacant === true) return RETAIL_COMP_UNIVERSE.VACANT_VALUE_ADD;
  switch (subtype) {
    case ST.GROCERY_ANCHORED_CENTER: return RETAIL_COMP_UNIVERSE.GROCERY_ANCHORED;
    case ST.COMMUNITY_SHOPPING_CENTER: return RETAIL_COMP_UNIVERSE.COMMUNITY_CENTER;
    case ST.NEIGHBORHOOD_STRIP_CENTER: return RETAIL_COMP_UNIVERSE.NEIGHBORHOOD_STRIP;
    case ST.UNANCHORED_STRIP_CENTER: return RETAIL_COMP_UNIVERSE.UNANCHORED_STRIP;
    case ST.SINGLE_TENANT_NET_LEASE: return RETAIL_COMP_UNIVERSE.SINGLE_TENANT_NET_LEASE;
    case ST.FREESTANDING_RETAIL: return RETAIL_COMP_UNIVERSE.FREESTANDING;
    case ST.BIG_BOX_RETAIL: return RETAIL_COMP_UNIVERSE.BIG_BOX;
    case ST.RETAIL_CONDOMINIUM: return RETAIL_COMP_UNIVERSE.RETAIL_CONDO;
    case ST.GROUND_LEASE: return RETAIL_COMP_UNIVERSE.GROUND_LEASE;
    default: return RETAIL_COMP_UNIVERSE.UNANCHORED_STRIP;
  }
}

/** Subtypes considered compatible with the subject subtype (exact + tight neighbors). */
const SUBTYPE_COMPATIBLE = Object.freeze({
  [ST.NEIGHBORHOOD_STRIP_CENTER]: new Set([ST.NEIGHBORHOOD_STRIP_CENTER, ST.UNANCHORED_STRIP_CENTER, ST.MULTI_TENANT_STOREFRONT]),
  [ST.UNANCHORED_STRIP_CENTER]: new Set([ST.UNANCHORED_STRIP_CENTER, ST.NEIGHBORHOOD_STRIP_CENTER, ST.MULTI_TENANT_STOREFRONT]),
  [ST.GROCERY_ANCHORED_CENTER]: new Set([ST.GROCERY_ANCHORED_CENTER, ST.COMMUNITY_SHOPPING_CENTER]),
  [ST.COMMUNITY_SHOPPING_CENTER]: new Set([ST.COMMUNITY_SHOPPING_CENTER, ST.GROCERY_ANCHORED_CENTER]),
  [ST.SINGLE_TENANT_NET_LEASE]: new Set([ST.SINGLE_TENANT_NET_LEASE, ST.FREESTANDING_RETAIL]),
  [ST.FREESTANDING_RETAIL]: new Set([ST.FREESTANDING_RETAIL, ST.SINGLE_TENANT_NET_LEASE]),
  [ST.BIG_BOX_RETAIL]: new Set([ST.BIG_BOX_RETAIL]),
  [ST.RETAIL_CONDOMINIUM]: new Set([ST.RETAIL_CONDOMINIUM, ST.MULTI_TENANT_STOREFRONT]),
  [ST.GROUND_LEASE]: new Set([ST.GROUND_LEASE]),
  [ST.MULTI_TENANT_STOREFRONT]: new Set([ST.MULTI_TENANT_STOREFRONT, ST.NEIGHBORHOOD_STRIP_CENTER, ST.UNANCHORED_STRIP_CENTER]),
});

/**
 * Qualify a single candidate retail transaction against the subject subtype.
 * @returns {{ qualified, reason, universe, demand_only, comp }}
 */
export function qualifyRetailComp(row = {}, { subjectSubtype = ST.AMBIGUOUS_RETAIL } = {}) {
  const blobText = lower([row.property_type, row.normalized_asset_class, row.asset_class, row.asset_subtype, row.commercial_property_type].filter(Boolean).join(' '));

  // Reject non-retail asset types outright (no substitution).
  if (NON_RETAIL_RE.test(blobText)) {
    return { qualified: false, demand_only: false, universe: null, reason: 'non_retail_asset_rejected', comp: null };
  }
  if (SPECIALTY_RE.test(blobText)) {
    return { qualified: false, demand_only: false, universe: null, reason: 'specialty_use_rejected_without_normalization', comp: null };
  }

  const cls = classifyRetailAsset(row);
  if (!cls.is_retail) {
    return { qualified: false, demand_only: false, universe: null, reason: 'not_retail', comp: null };
  }

  // Package / portfolio → DEMAND-ONLY (no pricing contribution).
  if (isPackage(row)) {
    return {
      qualified: false, demand_only: true, universe: RETAIL_COMP_UNIVERSE.PORTFOLIO_DEMAND_ONLY,
      reason: 'portfolio_package_demand_only',
      comp: { buyer: clean(row.buyer_name) || null, state: clean(row.property_address_state ?? row.property_state) || null, sale_date: row.sale_date ?? null, demand_only: true },
    };
  }

  const price = salePrice(row);
  if (price === null || price <= 0) {
    return { qualified: false, demand_only: false, universe: null, reason: 'no_qualified_individual_price', comp: null };
  }

  // Subtype compatibility — exact + tight neighbor only.
  const compat = SUBTYPE_COMPATIBLE[subjectSubtype];
  if (compat && !compat.has(cls.subtype)) {
    return { qualified: false, demand_only: false, universe: null, reason: `subtype_mismatch_${lower(cls.subtype)}_vs_${lower(subjectSubtype)}`, comp: null };
  }

  const gla = num(row.gross_leasable_area) ?? num(row.building_square_feet) ?? num(row.sqft) ?? null;
  const ppgla = gla && gla > 0 ? round(price / gla, 2) : null;
  const bounds = RETAIL_PPGLA_BOUNDS[subjectSubtype] ?? RETAIL_PPGLA_BOUNDS.UNKNOWN;
  if (ppgla !== null && (ppgla < bounds.low * 0.4 || ppgla > bounds.high * 2)) {
    return { qualified: false, demand_only: false, universe: null, reason: `ppgla_${ppgla}_out_of_range`, comp: null };
  }

  const universe = compUniverse(cls.subtype, row);
  return {
    qualified: true, demand_only: false, universe, reason: 'qualified_retail_sale',
    comp: {
      subtype: cls.subtype,
      universe,
      sale_price: roundMoney(price),
      gla: gla !== null ? roundMoney(gla) : null,
      price_per_gla: ppgla,
      occupancy: num(row.occupancy) ?? null,
      cap_rate: num(row.cap_rate) ?? null,
      noi: num(row.noi) ?? null,
      tenant_credit: clean(row.tenant_credit) || null,
      wale_years: num(row.wale_years) ?? null,
      year_built: num(row.year_built) ?? null,
      state: clean(row.property_address_state ?? row.property_state) || null,
      sale_date: row.sale_date ?? null,
      buyer: clean(row.buyer_name) || null,
      transaction_channel: clean(row.transaction_channel ?? row.last_sale_doc_type) || null,
    },
  };
}

/**
 * Build the bucketed comparable universes from raw candidates.
 * @returns universes keyed by RETAIL_COMP_UNIVERSE, plus rejected + demand_only.
 */
export function buildRetailComparables(candidates = [], { subjectSubtype = ST.AMBIGUOUS_RETAIL } = {}) {
  const universes = {};
  for (const u of Object.values(RETAIL_COMP_UNIVERSE)) if (u !== RETAIL_COMP_UNIVERSE.PORTFOLIO_DEMAND_ONLY) universes[u] = [];
  const demandOnly = [];
  const rejected = [];

  for (const row of candidates ?? []) {
    const r = qualifyRetailComp(row, { subjectSubtype });
    if (r.qualified) {
      (universes[r.universe] ?? universes[RETAIL_COMP_UNIVERSE.UNANCHORED_STRIP]).push(r.comp);
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
/* Market / demand context (§12, §19)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Retail demand CONTEXT only. Retail demand is never inferred from Census alone;
 * supply (competing centers / construction pipeline) is reported UNAVAILABLE
 * unless explicitly provided. No protected-class composition is used.
 */
export function buildRetailMarketContext({ market = {}, competingCenters = null, pipeline = null } = {}) {
  const factors = [];
  const missing = [];
  let score = null;

  const add = (key, value, weight) => {
    const v = num(value);
    if (v === null) { missing.push(key); return; }
    factors.push({ factor: key, value: v, weight });
  };
  add('population_growth', market.population_growth, 0.2);
  add('household_growth', market.household_growth, 0.2);
  add('median_income', market.median_income_growth ?? market.median_income, 0.15);
  add('retail_sales_growth', market.retail_sales_growth, 0.15);
  add('traffic_count', market.traffic_count, 0.15);
  add('daytime_population', market.daytime_population, 0.15);

  if (factors.length >= 3) {
    const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
    const blended = factors.reduce((s, f) => s + clampGrowth(f.value) * f.weight, 0) / totalWeight;
    score = round(clampScore(50 + blended * 50), 0);
  }

  const supplyKnown = competingCenters !== null || pipeline !== null;
  return {
    demand_context_score: score,
    demand_context_basis: factors.map((f) => f.factor),
    growth_support: score === null ? 'UNKNOWN' : score >= 60 ? 'SUPPORTIVE' : score >= 45 ? 'NEUTRAL' : 'SOFT',
    supply_risk_status: supplyKnown ? supplyRisk(competingCenters, pipeline) : 'UNAVAILABLE',
    competing_center_count: competingCenters !== null ? num(competingCenters) : null,
    construction_pipeline: pipeline !== null ? num(pipeline) : null,
    market_stability: score === null ? 'UNKNOWN' : (score >= 50 ? 'STABLE' : 'WATCH'),
    confidence: score === null ? 10 : clampScore(30 + factors.length * 8),
    source_vintage: market.vintage ?? null,
    missing_factors: missing,
    note: supplyKnown ? null : 'Competing-center / construction-pipeline supply data unavailable — not fabricated.',
  };
}

function supplyRisk(centers, pipeline) {
  const c = num(centers) ?? 0;
  const p = num(pipeline) ?? 0;
  if (p > 0 || c >= 8) return 'ELEVATED';
  if (c >= 4) return 'MODERATE';
  return 'LOW';
}
function clampGrowth(v) { return Math.max(-1, Math.min(1, v / 5)); }
function clampScore(v) { return Math.max(0, Math.min(100, v)); }
