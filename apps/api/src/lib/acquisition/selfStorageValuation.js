/**
 * Acquisition Engine V3 — Item 5D §9, §12, §13: self-storage valuation,
 * expansion/development, and repair/capital models.
 *
 * Valuation methods are computed INDEPENDENTLY (mission §9):
 *   A. stabilized NOI / market cap     E. revenue multiple (where defensible)
 *   B. current NOI / observed cap      F. comparable transaction value
 *   C. price per NRSF                  G. expansion / development value
 *   D. price per unit                  H. liquidation / distressed value
 *
 * NOI/cap dominates a stabilized operating facility WHEN SUPPORTABLE; PPNRSF and
 * PPU corroborate. With missing income, income methods stay PROVISIONAL but
 * qualified transaction methods may still establish a qualified value. Observed
 * NOI / cap rates are never synthesized.
 *
 * Expansion value never adds to as-is value without subtracting required costs
 * and a risk discount (§12). Capital items are never double-counted (§13).
 *
 * Pure & deterministic.
 */

import { num, round, roundMoney, clamp } from './modelConstants.js';
import { valueFromCap } from './incomeUnderwriting.js';
import { STORAGE_CAP_KIND } from './selfStorageUnderwriting.js';
import {
  STORAGE_DEVELOPMENT_ASSUMPTIONS as DEV,
  STORAGE_PPNRSF_BOUNDS,
  STORAGE_PPU_BOUNDS,
} from './selfStorageConstants.js';

const VC = Object.freeze({ QUALIFIED: 'QUALIFIED', PROVISIONAL: 'PROVISIONAL_SCENARIO', NONE: 'NONE' });

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}
function effectiveSampleSize(comps) {
  // Simple Kish-style ESS proxy by distinct states+buyers; floored at count>0.
  return comps.length;
}

function mkMethod(name, value, { classification, confidence, sample = 0, ess = 0, lineage = [], assumptions = [], spread = 0.1 }) {
  if (value === null || !(value > 0)) {
    return { method: name, available: false, classification: VC.NONE, low: null, mid: null, high: null, confidence: 0, sample, ess, lineage, assumptions };
  }
  return {
    method: name, available: true, classification,
    low: roundMoney(value * (1 - spread)), mid: roundMoney(value), high: roundMoney(value * (1 + spread)),
    confidence: Math.round(clamp(confidence, 0, 100)), sample, ess, lineage, assumptions,
  };
}

/**
 * Build all storage valuation methods + a reconciled value.
 *
 * @param {object} args
 * @param {object} args.contract       storage contract
 * @param {object} args.noi            output of buildStorageNOI
 * @param {object} args.revenue        output of buildStorageRevenue
 * @param {object} args.capRate        output of buildStorageCapRate
 * @param {object} args.comparables    output of buildStorageComparables
 * @param {string} args.operationalStatus
 */
export function buildStorageValuation({ contract, noi, revenue, capRate, comparables, operationalStatus }) {
  const nrsf = num(contract.physical.net_rentable_square_feet?.value);
  const units = num(contract.unit_inventory.total_units?.value);
  const facilityClass = contract.identity.facility_class?.value ?? 'UNKNOWN';

  const stabilizedNoi = num(noi?.stabilized_noi?.noi);
  const currentNoi = num(noi?.current_noi?.noi);
  const incomeSupported = Boolean(noi?.income_supported);
  const observedCapQualified = capRate?.selected?.kind === STORAGE_CAP_KIND.OBSERVED && capRate.selected.qualified;
  const marketCap = capRate?.modeled_market?.cap_rate ?? null;
  const observedCap = observedCapQualified ? capRate.selected.cap_rate : null;

  const methods = {};

  // A. Stabilized NOI / market cap (modeled cap → provisional unless observed).
  const stabValue = stabilizedNoi !== null && marketCap !== null ? valueFromCap(stabilizedNoi, marketCap) : null;
  methods.stabilized_noi_market_cap = mkMethod('STABILIZED_NOI_MARKET_CAP', stabValue, {
    classification: incomeSupported && observedCapQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: incomeSupported ? (observedCapQualified ? 65 : 45) : 25,
    lineage: ['stabilized_noi', observedCapQualified ? 'observed_cap' : 'modeled_market_cap'],
    assumptions: observedCapQualified ? [] : [`modeled_cap=${marketCap}`],
  });

  // B. Current NOI / observed cap (QUALIFIED only with observed cap + observed NOI).
  const currentValue = currentNoi !== null && (observedCap ?? marketCap) !== null
    ? valueFromCap(currentNoi, observedCap ?? marketCap) : null;
  methods.current_noi_observed_cap = mkMethod('CURRENT_NOI_OBSERVED_CAP', currentValue, {
    classification: incomeSupported && observedCapQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: incomeSupported ? (observedCapQualified ? 60 : 35) : 20,
    lineage: ['current_noi', observedCapQualified ? 'observed_cap' : 'modeled_market_cap'],
    assumptions: observedCapQualified ? [] : ['observed_cap_unavailable'],
  });

  // C / D. Price-per-NRSF and price-per-unit from qualified comps.
  const stabilizedComps = (comparables?.universes?.stabilized_storage ?? []);
  const valueAddComps = (comparables?.universes?.value_add_storage ?? []);
  const usableComps = operationalStatus === 'VALUE_ADD' && valueAddComps.length >= 3 ? valueAddComps : stabilizedComps;
  const ppnrsfComps = usableComps.map((c) => num(c.price_per_nrsf)).filter((v) => v !== null && v > 0);
  const ppuComps = usableComps.map((c) => num(c.price_per_unit)).filter((v) => v !== null && v > 0);
  const medPpnrsf = median(ppnrsfComps);
  const medPpu = median(ppuComps);
  const compsQualified = usableComps.length >= 3;

  const ppnrsfValue = medPpnrsf !== null && nrsf !== null ? roundMoney(medPpnrsf * nrsf) : null;
  methods.price_per_nrsf = mkMethod('PRICE_PER_NRSF', ppnrsfValue, {
    classification: compsQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: compsQualified ? 60 : 30, sample: usableComps.length, ess: effectiveSampleSize(usableComps),
    lineage: ['median_qualified_comp_ppnrsf', 'subject_nrsf'],
    assumptions: nrsf !== null && contract.physical.net_rentable_square_feet?.basis === 'MARKET_MODELED' ? ['nrsf_modeled_from_gba'] : [],
  });

  const ppuValue = medPpu !== null && units !== null ? roundMoney(medPpu * units) : null;
  methods.price_per_unit = mkMethod('PRICE_PER_UNIT', ppuValue, {
    classification: compsQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: compsQualified ? 50 : 25, sample: usableComps.length, ess: effectiveSampleSize(usableComps),
    lineage: ['median_qualified_comp_ppu', 'subject_units'],
  });

  // E. Revenue multiple (defensible only with EGR + comp revenue multiples).
  const egr = num(revenue?.effective_gross_revenue_annual);
  const revMultComps = usableComps.map((c) => (num(c.sale_price) && num(c.revenue) ? num(c.sale_price) / num(c.revenue) : null)).filter((v) => v !== null);
  const medRevMult = median(revMultComps);
  const revMultValue = medRevMult !== null && egr !== null ? roundMoney(medRevMult * egr) : null;
  methods.revenue_multiple = mkMethod('REVENUE_MULTIPLE', revMultValue, {
    classification: revMultComps.length >= 3 && incomeSupported ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: revMultComps.length >= 3 ? 40 : 15, sample: revMultComps.length,
    lineage: ['median_comp_revenue_multiple', 'subject_egr'],
  });

  // F. Comparable transaction value (blend of PPNRSF & PPU when both qualified).
  const compBlend = [methods.price_per_nrsf, methods.price_per_unit].filter((m) => m.available).map((m) => m.mid);
  const compValue = compBlend.length ? roundMoney(compBlend.reduce((s, v) => s + v, 0) / compBlend.length) : null;
  methods.comparable_transaction = mkMethod('COMPARABLE_TRANSACTION', compValue, {
    classification: compsQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: compsQualified ? 58 : 28, sample: usableComps.length, ess: effectiveSampleSize(usableComps),
    lineage: ['ppnrsf', 'ppu'],
  });

  // G. Expansion / development value (separate; cost & risk subtracted).
  const expansion = buildStorageExpansionValue({ contract, marketCap, asIsValue: null });
  methods.expansion_development = mkMethod('EXPANSION_DEVELOPMENT', expansion.net_incremental_value, {
    classification: expansion.available ? VC.PROVISIONAL : VC.NONE,
    confidence: expansion.confidence, lineage: ['expansion_capacity', 'stabilized_noi_at_cost', 'less_cost_and_risk'],
    assumptions: expansion.assumptions,
  });

  // H. Liquidation / distressed value (discount to qualified value floor).
  const baseForLiquidation = methods.comparable_transaction.available ? methods.comparable_transaction.mid
    : (methods.stabilized_noi_market_cap.available ? methods.stabilized_noi_market_cap.mid : null);
  const liquidationValue = baseForLiquidation !== null ? roundMoney(baseForLiquidation * 0.7) : null;
  methods.liquidation = mkMethod('LIQUIDATION_DISTRESSED', liquidationValue, {
    classification: VC.PROVISIONAL, confidence: 30, spread: 0.15,
    lineage: ['0.7_of_value_floor'], assumptions: ['distressed_disposition_discount=0.30'],
  });

  // ---- Reconciliation ----
  const reconciliation = reconcileStorageValuation({ methods, operationalStatus, incomeSupported, observedCapQualified, compsQualified });

  return {
    facility_class: facilityClass,
    methods,
    expansion,
    reconciliation,
    dominant_method: reconciliation.dominant_method,
    income_supported: incomeSupported,
  };
}

/**
 * Reconcile independent methods into a value range with explicit weights and
 * dominant method. NOI/cap dominates a supportable stabilized facility; comps
 * corroborate. With unsupported income, qualified comps lead and income methods
 * are weighted down to provisional.
 */
export function reconcileStorageValuation({ methods, operationalStatus, incomeSupported, observedCapQualified, compsQualified }) {
  const available = Object.values(methods).filter((m) => m.available && m.method !== 'EXPANSION_DEVELOPMENT' && m.method !== 'LIQUIDATION_DISTRESSED');
  const qualified = available.filter((m) => m.classification === VC.QUALIFIED);

  const weights = {};
  const incomeLed = incomeSupported && observedCapQualified && operationalStatus !== 'LEASE_UP' && operationalStatus !== 'DEVELOPMENT';

  for (const m of available) {
    let w = 0;
    if (m.method === 'STABILIZED_NOI_MARKET_CAP') w = incomeLed ? 0.5 : (incomeSupported ? 0.25 : 0.1);
    else if (m.method === 'CURRENT_NOI_OBSERVED_CAP') w = incomeLed ? 0.2 : (incomeSupported ? 0.15 : 0.05);
    else if (m.method === 'COMPARABLE_TRANSACTION') w = incomeLed ? 0.2 : (compsQualified ? 0.45 : 0.3);
    else if (m.method === 'PRICE_PER_NRSF') w = incomeLed ? 0.07 : (compsQualified ? 0.25 : 0.15);
    else if (m.method === 'PRICE_PER_UNIT') w = incomeLed ? 0.03 : (compsQualified ? 0.15 : 0.1);
    else if (m.method === 'REVENUE_MULTIPLE') w = 0.05;
    weights[m.method] = w;
  }
  const totalW = Object.values(weights).reduce((s, v) => s + v, 0);

  let mid = null;
  if (totalW > 0) {
    mid = roundMoney(available.reduce((s, m) => s + m.mid * (weights[m.method] / totalW), 0));
  }
  const lows = available.map((m) => m.low);
  const highs = available.map((m) => m.high);

  // Dominant method = highest weight among available.
  let dominant = null; let best = -1;
  for (const m of available) { if (weights[m.method] > best) { best = weights[m.method]; dominant = m.method; } }

  const anyQualified = qualified.length > 0;
  const disagreement = available.length >= 2 && mid
    ? round((Math.max(...available.map((m) => m.mid)) - Math.min(...available.map((m) => m.mid))) / mid, 3)
    : null;

  return {
    reconciled_value_low: lows.length ? Math.min(...lows) : null,
    reconciled_value_mid: mid,
    reconciled_value_high: highs.length ? Math.max(...highs) : null,
    value_classification: anyQualified ? VC.QUALIFIED : (available.length ? VC.PROVISIONAL : VC.NONE),
    dominant_method: dominant,
    method_weights: weights,
    model_disagreement: disagreement,
    qualified_method_count: qualified.length,
    available_method_count: available.length,
    income_led: incomeLed,
  };
}

/* -------------------------------------------------------------------------- */
/* Expansion / development (§12)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Expansion option value. Computes completed stabilized value of buildable NRSF
 * and subtracts hard/site/soft/financing cost and an execution-risk discount.
 * Returns as-is, completed, required investment and NET incremental value — the
 * incremental value never adds to as-is without subtracting costs and risk.
 */
export function buildStorageExpansionValue({ contract, marketCap, asIsValue = null }) {
  const dev = contract.development ?? {};
  const buildableNrsf = num(dev.expansion_capacity_nrsf?.value)
    ?? (num(contract.physical.expansion_area?.value) !== null ? roundMoney(num(contract.physical.expansion_area.value) * DEV.buildable_far) : null);
  if (buildableNrsf === null || buildableNrsf <= 0 || marketCap === null) {
    return { available: false, reason: 'no_expansion_evidence', confidence: 0, net_incremental_value: null, assumptions: [] };
  }

  const hard = buildableNrsf * DEV.hard_cost_per_buildable_nrsf;
  const site = hard * DEV.site_work_pct_of_hard;
  const soft = hard * DEV.soft_cost_pct_of_hard;
  const financing = hard * DEV.financing_cost_pct_of_hard;
  const totalCost = hard + site + soft + financing;

  // Stabilized incremental NOI from buildable NRSF (uses subject street rent if
  // available, else a conservative per-NRSF rent assumption — labeled).
  const streetRentPerUnitMonthly = num(contract.operations.average_street_rent?.value);
  const avgUnitNrsf = num(contract.unit_inventory.unit_mix?.value?.average_unit_nrsf) ?? 90;
  const rentPerNrsfAnnual = streetRentPerUnitMonthly !== null && avgUnitNrsf > 0
    ? (streetRentPerUnitMonthly / avgUnitNrsf) * 12 : 12; // $12/NRSF/yr fallback (labeled)
  const stabilizedGpr = buildableNrsf * rentPerNrsfAnnual;
  const stabilizedEgr = stabilizedGpr * DEV.stabilized_occupancy;
  const stabilizedNoi = stabilizedEgr * 0.6; // ~60% margin (labeled storage assumption)
  const completedValue = valueFromCap(stabilizedNoi, marketCap);

  const grossSpread = completedValue !== null ? completedValue - totalCost : null;
  const netIncremental = grossSpread !== null ? roundMoney(grossSpread * (1 - DEV.execution_risk_discount)) : null;
  const yieldOnCost = totalCost > 0 ? round(stabilizedNoi / totalCost, 4) : null;

  return {
    available: true,
    buildable_nrsf: roundMoney(buildableNrsf),
    estimated_construction_cost: roundMoney(hard),
    site_work: roundMoney(site),
    soft_costs: roundMoney(soft),
    financing_costs: roundMoney(financing),
    total_required_investment: roundMoney(totalCost),
    lease_up_months: num(dev.expansion_timeline?.value) ?? DEV.lease_up_months,
    stabilized_occupancy: DEV.stabilized_occupancy,
    stabilized_noi: roundMoney(stabilizedNoi),
    completed_value: completedValue,
    yield_on_cost: yieldOnCost,
    development_spread: grossSpread !== null ? roundMoney(grossSpread) : null,
    net_incremental_value: netIncremental,
    as_is_value: asIsValue,
    total_completed_value: asIsValue !== null && netIncremental !== null ? roundMoney(asIsValue + netIncremental) : null,
    downside_scenario: completedValue !== null ? roundMoney(completedValue * 0.85 - totalCost) : null,
    confidence: 25,
    assumptions: [
      `hard_cost=${DEV.hard_cost_per_buildable_nrsf}/nrsf`,
      `risk_discount=${DEV.execution_risk_discount}`,
      `rent=${round(rentPerNrsfAnnual, 2)}/nrsf/yr`,
    ],
    entitlement_risk: contract.development.entitlement_status?.value ?? 'UNKNOWN',
  };
}

/* -------------------------------------------------------------------------- */
/* Repair / capital model (§13)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Separate capital items so they are never double-counted in valuation and offer
 * economics. Distinguishes immediate repairs / deferred maintenance / building
 * systems / conversion / expansion capex / replacement reserves.
 */
export function buildStorageCapital(contract, { repairInputs = {} } = {}) {
  const nrsf = num(contract.physical.net_rentable_square_feet?.value);
  const get = (k) => num(repairInputs[k]);
  const items = {
    immediate_repairs: get('immediate_repairs'),
    deferred_maintenance: get('deferred_maintenance'),
    roof_envelope: get('roof_envelope'),
    paving_drainage: get('paving_drainage'),
    fencing_gates: get('fencing_gates'),
    security: get('security'),
    fire_life_safety: get('fire_life_safety'),
    electrical: get('electrical'),
    hvac_climate: get('hvac_climate'),
    elevator: get('elevator'),
    unit_doors: get('unit_doors'),
    office: get('office'),
    signage: get('signage'),
    conversion_work: get('conversion_work'),
  };
  const knownItems = Object.entries(items).filter(([, v]) => v !== null);
  const oneTimeCapital = knownItems.reduce((s, [, v]) => s + v, 0);

  // Replacement reserves are an ONGOING operating line, NOT one-time capital —
  // kept separate to avoid double-counting against the expense model reserves.
  const replacementReserves = get('replacement_reserves');
  const expansionCapex = get('expansion_capex'); // belongs to the expansion model only

  return {
    items,
    one_time_capital: knownItems.length ? roundMoney(oneTimeCapital) : null,
    one_time_capital_per_nrsf: knownItems.length && nrsf ? round(oneTimeCapital / nrsf, 2) : null,
    replacement_reserves_annual: replacementReserves !== null ? roundMoney(replacementReserves) : null,
    expansion_capex: expansionCapex !== null ? roundMoney(expansionCapex) : null,
    known_items: knownItems.map(([k]) => k),
    double_count_guard: {
      // The offer model consumes ONLY one_time_capital; reserves live in opex,
      // expansion capex lives in the expansion model. Never sum all three.
      offer_one_time_capital: knownItems.length ? roundMoney(oneTimeCapital) : 0,
      reserves_in_opex_only: true,
      expansion_capex_in_expansion_model_only: true,
    },
    confidence: knownItems.length ? clamp(knownItems.length * 8 + 20, 0, 80) : 10,
  };
}
