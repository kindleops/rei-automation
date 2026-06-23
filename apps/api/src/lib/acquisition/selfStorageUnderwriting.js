/**
 * Acquisition Engine V3 — Item 5D §5–§7, §10: self-storage underwriting math.
 *
 * Pure, deterministic storage primitives:
 *   - revenue model: base rental + separated ancillary streams − vacancy −
 *     concessions − bad debt = effective gross revenue. Street/asking rent is
 *     NEVER presented as actual collected revenue.
 *   - expense model: facility-specific (drive-up vs climate, staffed vs unmanned)
 *     ACTUAL-first, otherwise LABELED modeled lines. No universal storage ratio.
 *   - NOI model: EGR − opex. Debt service / depreciation / income tax /
 *     acquisition cost / expansion capex EXCLUDED by construction.
 *   - cap-rate model: OBSERVED vs IMPLIED vs MODELED_MARKET kept separate. An
 *     OBSERVED cap requires a qualified sale + time-aligned observed NOI + exact
 *     storage compatibility + full lineage.
 *
 * Missing values are UNKNOWN, never zero.
 */

import { num, round, roundMoney, clamp } from './modelConstants.js';
import { EVIDENCE_BASIS, isKnown } from './incomeSnapshotContract.js';
import { computeNOI, capRateFromValue } from './incomeUnderwriting.js';
import {
  STORAGE_FACILITY_TYPE as FT,
  STORAGE_OPEX_ASSUMPTIONS,
  STORAGE_EXPENSE_CATEGORIES,
  STORAGE_ANCILLARY_ASSUMPTIONS,
  STORAGE_DEFAULT_CAP_RATE,
  STORAGE_CAP_RATE_BOUNDS,
  STORAGE_STABILIZED_OCCUPANCY,
} from './selfStorageConstants.js';

const val = (f) => (f && isKnown(f) ? num(f.value) : null);
const bool = (f) => (f && isKnown(f) ? f.value === true : null);

/* -------------------------------------------------------------------------- */
/* Revenue model (§5)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the storage revenue picture. Separates current-actual collected revenue
 * from street/market-derived potential; separates each ancillary stream; bridges
 * GPR → EGR with vacancy/concessions/bad-debt; never treats street rent as
 * collected revenue.
 */
export function buildStorageRevenue(contract) {
  const inv = contract.unit_inventory ?? {};
  const op = contract.operations ?? {};
  const inc = contract.income ?? {};

  const totalUnits = val(inv.total_units);
  const occUnits = val(inv.occupied_units);
  const nrsf = val(contract.physical.net_rentable_square_feet);
  const physOcc = val(op.physical_occupancy);
  const inPlace = val(op.average_in_place_rent);   // $/unit/month, ACTUAL
  const street = val(op.average_street_rent);       // $/unit/month, ASKING
  const market = val(op.average_market_rent);       // $/unit/month, comp-derived
  const occupancy = physOcc ?? (totalUnits && occUnits !== null ? round(occUnits / totalUnits, 4) : null);
  const occupiedCount = occUnits ?? (totalUnits !== null && occupancy !== null ? totalUnits * occupancy : null);

  const missing = [];
  const lineage = [];

  // ---- Current ACTUAL collected base rental revenue ----
  let currentBaseAnnual = val(inc.base_rental_income);
  let currentBasis = EVIDENCE_BASIS.ACTUAL;
  if (currentBaseAnnual !== null) {
    lineage.push('income.base_rental_income(actual)');
  } else if (inPlace !== null && occupiedCount !== null) {
    currentBaseAnnual = roundMoney(inPlace * occupiedCount * 12);
    currentBasis = EVIDENCE_BASIS.ACTUAL;
    lineage.push('avg_in_place_rent*occupied_units*12');
  } else {
    currentBasis = EVIDENCE_BASIS.UNKNOWN;
    missing.push('current_base_rental_income');
  }

  // ---- Gross POTENTIAL rental revenue (all units at street/market) ----
  // Street/asking and market are POTENTIAL only — never collected revenue.
  let potentialPerUnit = market ?? street ?? inPlace;
  let potentialBasis = market !== null ? EVIDENCE_BASIS.COMPARABLE_DERIVED
    : street !== null ? EVIDENCE_BASIS.LISTING_REPORTED
      : inPlace !== null ? EVIDENCE_BASIS.ACTUAL : EVIDENCE_BASIS.UNKNOWN;
  const gprAnnual = potentialPerUnit !== null && totalUnits !== null
    ? roundMoney(potentialPerUnit * totalUnits * 12) : null;
  if (gprAnnual === null) missing.push('gross_potential_revenue');
  else lineage.push(`gpr=${market !== null ? 'market' : street !== null ? 'street' : 'in_place'}_rent*total_units*12`);

  // ---- Separated ancillary income (never folded into base) ----
  const ancillary = buildAncillaryIncome(inc, occupiedCount);

  // ---- Bridge GPR → EGR ----
  const vacancyPct = occupancy !== null ? clamp(1 - occupancy, 0, 0.95) : null;
  const vacancyLoss = gprAnnual !== null && vacancyPct !== null ? roundMoney(gprAnnual * vacancyPct) : null;
  const concessions = val(op.concessions) ?? 0;
  const badDebt = val(op.bad_debt) ?? 0;

  // EGR uses collected base (current) when known, else potential less vacancy.
  const collectedBase = currentBaseAnnual !== null
    ? currentBaseAnnual
    : (gprAnnual !== null && vacancyLoss !== null ? gprAnnual - vacancyLoss : null);
  const egr = collectedBase !== null
    ? roundMoney(collectedBase + ancillary.total_ancillary_income - concessions - badDebt)
    : null;

  // ---- Per-area / per-unit metrics ----
  const occupiedSqft = nrsf !== null && occupancy !== null ? nrsf * occupancy : null;
  const lossToLeaseAnnual = market !== null && inPlace !== null && occupiedCount !== null
    ? roundMoney((market - inPlace) * occupiedCount * 12) : null;
  const economicOccupancy = gprAnnual && gprAnnual > 0 && collectedBase !== null
    ? round(collectedBase / gprAnnual, 4) : null;

  if (occupancy === null) missing.push('occupancy');
  if (nrsf === null) missing.push('net_rentable_square_feet');

  const incomeSupported = currentBaseAnnual !== null && currentBasis === EVIDENCE_BASIS.ACTUAL && occupancy !== null;

  return {
    current_actual_base_annual: currentBaseAnnual,
    current_base_basis: currentBasis,
    trailing_base_annual: val(inc.gross_potential_revenue) !== null ? null : null, // requires explicit T-12 input
    scheduled_gross_potential_annual: gprAnnual,
    gross_potential_basis: potentialBasis,
    ancillary,
    vacancy_pct: vacancyPct !== null ? round(vacancyPct, 4) : null,
    vacancy_loss_annual: vacancyLoss,
    concessions_annual: roundMoney(concessions),
    bad_debt_annual: roundMoney(badDebt),
    effective_gross_revenue_annual: egr,
    stabilized_gross_potential_annual: gprAnnual,
    stabilized_egr_annual: gprAnnual !== null
      ? roundMoney(gprAnnual * STORAGE_STABILIZED_OCCUPANCY + ancillary.total_ancillary_income - 0 - 0)
      : null,
    revenue_per_occupied_sqft: occupiedSqft && collectedBase !== null ? round(collectedBase / occupiedSqft, 2) : null,
    revenue_per_available_sqft: nrsf && collectedBase !== null ? round(collectedBase / nrsf, 2) : null,
    revenue_per_unit: totalUnits && collectedBase !== null ? roundMoney(collectedBase / totalUnits) : null,
    loss_to_lease_annual: lossToLeaseAnnual,
    economic_occupancy: economicOccupancy,
    physical_occupancy: occupancy,
    income_supported: incomeSupported,
    source_lineage: lineage,
    missing_inputs: [...new Set(missing)],
    // Explicit invariant flag for downstream/tests.
    street_rent_is_potential_only: true,
  };
}

/** Separate each ancillary income stream; model per-occupied-unit only if needed. */
function buildAncillaryIncome(inc, occupiedCount) {
  const streams = {};
  const knownLines = [];
  const modeledLines = [];
  const a = STORAGE_ANCILLARY_ASSUMPTIONS;
  const map = [
    ['tenant_insurance_income', a.tenant_insurance_per_occupied_unit],
    ['administration_fees', a.admin_fee_per_occupied_unit],
    ['late_fees', a.late_fee_per_occupied_unit],
    ['merchandise_income', a.merchandise_per_occupied_unit],
    ['truck_rental_income', 0],
    ['other_income', 0],
  ];
  let total = 0;
  for (const [key, perUnit] of map) {
    const actual = val(inc[key]);
    if (actual !== null) {
      streams[key] = { value: roundMoney(actual), basis: EVIDENCE_BASIS.ACTUAL };
      knownLines.push(key);
      total += actual;
    } else if (perUnit > 0 && occupiedCount !== null) {
      const modeled = roundMoney(perUnit * occupiedCount);
      streams[key] = { value: modeled, basis: EVIDENCE_BASIS.MARKET_MODELED, assumption: `${perUnit}/occupied_unit/yr` };
      modeledLines.push(key);
      total += modeled;
    } else {
      streams[key] = { value: null, basis: EVIDENCE_BASIS.UNKNOWN };
    }
  }
  return {
    streams,
    total_ancillary_income: roundMoney(total),
    ancillary_per_occupied_unit: occupiedCount ? roundMoney(total / occupiedCount) : null,
    known_lines: knownLines,
    modeled_lines: modeledLines,
  };
}

/* -------------------------------------------------------------------------- */
/* Expense model (§6)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Facility-specific operating-expense model. ACTUAL lines used where present;
 * absent lines MODELED from facility-type assumptions and labeled. Excludes debt
 * service / depreciation / income tax / capex by construction.
 */
export function buildStorageExpenses(contract, { facilityType = FT.UNKNOWN, egrAnnual = null, subjectValue = null } = {}) {
  const a = STORAGE_OPEX_ASSUMPTIONS[facilityType] ?? STORAGE_OPEX_ASSUMPTIONS.MIXED;
  const exp = contract.expenses ?? {};
  const nrsf = val(contract.physical.net_rentable_square_feet);
  const units = val(contract.unit_inventory.total_units);
  const egr = num(egrAnnual);
  const lines = {};
  const known = [];
  const assumed = [];
  const missing = [];

  const set = (key, actualField, modeled, label) => {
    const actual = val(actualField);
    if (actual !== null) {
      lines[key] = { value: roundMoney(actual), basis: EVIDENCE_BASIS.ACTUAL, source: actualField.source };
      known.push(key);
    } else if (modeled !== null) {
      lines[key] = { value: roundMoney(modeled), basis: EVIDENCE_BASIS.MARKET_MODELED, source: label };
      assumed.push(key);
    } else {
      lines[key] = { value: null, basis: EVIDENCE_BASIS.UNKNOWN, source: null };
      missing.push(key);
    }
  };

  const perNrsf = (rate) => (nrsf !== null ? nrsf * rate : null);
  const pctEgr = (rate) => (egr !== null ? egr * rate : null);

  set('taxes', exp.taxes, subjectValue !== null ? subjectValue * a.tax_rate_of_value : null, `assumed_${a.tax_rate_of_value}_of_value`);
  set('insurance', exp.insurance, perNrsf(a.insurance_per_nrsf), `assumed_${a.insurance_per_nrsf}/nrsf`);
  set('payroll', exp.payroll, perNrsf(a.payroll_per_nrsf), `assumed_${a.payroll_per_nrsf}/nrsf`);
  set('management', exp.management, pctEgr(a.management_pct), `assumed_${a.management_pct}_of_egr`);
  set('utilities', exp.utilities, perNrsf(a.utilities_per_nrsf), `assumed_${a.utilities_per_nrsf}/nrsf`);
  set('repairs', exp.repairs, perNrsf(a.repairs_per_nrsf), `assumed_${a.repairs_per_nrsf}/nrsf`);
  set('marketing', exp.marketing, pctEgr(a.marketing_pct), `assumed_${a.marketing_pct}_of_egr`);
  set('software', exp.software, perNrsf(a.software_per_nrsf), `assumed_${a.software_per_nrsf}/nrsf`);
  set('security', exp.security, perNrsf(a.security_per_nrsf), `assumed_${a.security_per_nrsf}/nrsf`);
  set('landscaping_snow', exp.landscaping_snow, perNrsf(a.landscaping_snow_per_nrsf), `assumed_${a.landscaping_snow_per_nrsf}/nrsf`);
  set('administrative', exp.administrative, pctEgr(a.admin_pct), `assumed_${a.admin_pct}_of_egr`);
  set('professional_fees', exp.professional_fees, egr !== null ? egr * 0.01 : null, 'assumed_0.01_of_egr');
  set('reserves', exp.reserves, perNrsf(a.reserves_per_nrsf), `assumed_${a.reserves_per_nrsf}/nrsf`);

  // An explicit actual total overrides the sum of lines.
  const explicitTotal = val(exp.total_operating_expenses);
  const lineSum = Object.values(lines).reduce((s, l) => s + (l.value ?? 0), 0);
  const total = explicitTotal !== null ? explicitTotal : roundMoney(lineSum);
  const actualTotal = Object.values(lines).filter((l) => l.basis === EVIDENCE_BASIS.ACTUAL).reduce((s, l) => s + (l.value ?? 0), 0);

  return {
    facility_type: facilityType,
    lines,
    total_operating_expenses: total,
    actual_operating_expenses: roundMoney(actualTotal),
    expense_ratio: egr && egr > 0 ? round(total / egr, 3) : null,
    expense_per_nrsf: nrsf ? round(total / nrsf, 2) : null,
    expense_per_unit: units ? roundMoney(total / units) : null,
    known_lines: known,
    assumed_lines: assumed,
    missing_lines: missing,
    confidence: clamp((known.length / STORAGE_EXPENSE_CATEGORIES.length) * 100 + 15, 0, 100),
    sensitivity: {
      // ±10% opex sensitivity on NOI is reported for transparency.
      opex_low: roundMoney(total * 0.9),
      opex_high: roundMoney(total * 1.1),
    },
    excludes: ['debt_service', 'depreciation', 'income_tax', 'acquisition_cost', 'expansion_capex'],
  };
}

/* -------------------------------------------------------------------------- */
/* NOI model (§7)                                                              */
/* -------------------------------------------------------------------------- */

/** Storage NOI from revenue + expenses. Reuses the canonical NOI bridge. */
export function buildStorageNOI({ revenue, expenses, contract }) {
  const nrsf = val(contract.physical.net_rentable_square_feet);
  const units = val(contract.unit_inventory.total_units);
  const opex = num(expenses?.total_operating_expenses);

  const egr = num(revenue?.effective_gross_revenue_annual);
  const current = egr !== null && opex !== null
    ? { effective_gross_revenue: egr, operating_expenses: opex, noi: roundMoney(egr - opex), excludes: expenses.excludes }
    : null;

  const stabilizedEgr = num(revenue?.stabilized_egr_annual);
  const stabilized = stabilizedEgr !== null && opex !== null
    ? computeNOI({ gprAnnual: stabilizedEgr, vacancyPct: 0, opexAnnual: opex })
    : null;

  const noi = current?.noi ?? null;
  const incomeSupported = Boolean(revenue?.income_supported) && current !== null;

  return {
    current_noi: current,
    stabilized_noi: stabilized ? { effective_gross_revenue: stabilizedEgr, operating_expenses: opex, noi: stabilized.noi } : null,
    trailing_noi: null, // requires explicit trailing inputs
    pro_forma_noi: stabilized ? stabilized.noi : null,
    noi_per_nrsf: noi !== null && nrsf ? round(noi / nrsf, 2) : null,
    noi_per_unit: noi !== null && units ? roundMoney(noi / units) : null,
    operating_expense_ratio: egr && egr > 0 && opex !== null ? round(opex / egr, 3) : null,
    noi_confidence: incomeSupported ? clamp((expenses?.confidence ?? 0) * 0.5 + 40, 0, 90) : 25,
    income_supported: incomeSupported,
    source_lineage: revenue?.source_lineage ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* Cap-rate model (§10)                                                        */
/* -------------------------------------------------------------------------- */

export const STORAGE_CAP_KIND = Object.freeze({
  OBSERVED: 'OBSERVED',
  IMPLIED: 'IMPLIED',
  MODELED_MARKET: 'MODELED_MARKET',
});

/**
 * Qualify an OBSERVED storage cap rate. Requires a qualified individual sale
 * price, a time-aligned observed NOI, exact self-storage asset compatibility,
 * and complete lineage. A modeled NOI can NEVER create an observed cap rate.
 */
export function qualifyObservedStorageCap(evidence = {}) {
  const price = num(evidence.sale_price);
  const noi = num(evidence.observed_noi);
  const reasons = [];
  if (price === null || price <= 0) reasons.push('no_qualified_sale_price');
  if (noi === null) reasons.push('no_time_aligned_observed_noi');
  if (evidence.noi_basis && evidence.noi_basis !== EVIDENCE_BASIS.ACTUAL && evidence.noi_basis !== EVIDENCE_BASIS.VERIFIED_DOCUMENT) {
    reasons.push('noi_not_observed');
  }
  if (evidence.exact_self_storage !== true) reasons.push('not_exact_self_storage');
  if (evidence.sale_date == null || evidence.noi_period == null) reasons.push('incomplete_time_lineage');
  if (reasons.length) return { kind: null, qualified: false, cap_rate: null, reasons };
  const cap = capRateFromValue(noi, price);
  if (cap === null || cap < STORAGE_CAP_RATE_BOUNDS.min || cap > STORAGE_CAP_RATE_BOUNDS.max) {
    return { kind: null, qualified: false, cap_rate: cap, reasons: ['cap_out_of_plausible_range'] };
  }
  return {
    kind: STORAGE_CAP_KIND.OBSERVED, qualified: true, cap_rate: round(cap, 4),
    sale_price: roundMoney(price), observed_noi: roundMoney(noi),
    sale_date: evidence.sale_date, noi_period: evidence.noi_period, reasons: [],
  };
}

/**
 * Resolve a storage cap rate keeping OBSERVED / IMPLIED / MODELED_MARKET
 * separate. Modeled market caps adjust for facility class, market size,
 * occupancy, economic occupancy, climate control, age, expansion potential,
 * revenue growth, buyer depth and transaction size. Never derives a market cap
 * from contaminated package consideration.
 */
export function buildStorageCapRate({
  facilityClass = 'UNKNOWN', observedEvidence = [], impliedNoi = null, impliedValue = null,
  occupancy = null, economicOccupancy = null, climateControlPct = null, yearBuilt = null,
  marketTier = 'SECONDARY', buyerDepth = 'MODERATE', hasExpansion = false,
} = {}) {
  const observed = (observedEvidence ?? [])
    .map((e) => qualifyObservedStorageCap(e))
    .filter((r) => r.qualified);

  const implied = impliedNoi !== null && impliedValue !== null
    ? { kind: STORAGE_CAP_KIND.IMPLIED, cap_rate: capRateFromValue(impliedNoi, impliedValue), qualified: false, note: 'implied_from_subject_noi_and_value_estimate' }
    : null;

  // ---- Modeled market cap (labeled) ----
  let modeled = STORAGE_DEFAULT_CAP_RATE[facilityClass] ?? STORAGE_DEFAULT_CAP_RATE.UNKNOWN;
  const adjustments = [];
  if (marketTier === 'PRIMARY') { modeled -= 0.005; adjustments.push('primary_market-50bps'); }
  if (marketTier === 'TERTIARY') { modeled += 0.01; adjustments.push('tertiary_market+100bps'); }
  if (occupancy !== null && occupancy < 0.80) { modeled += 0.0075; adjustments.push('low_occupancy+75bps'); }
  if (economicOccupancy !== null && occupancy !== null && occupancy - economicOccupancy >= 0.1) { modeled += 0.005; adjustments.push('economic_gap+50bps'); }
  if (climateControlPct !== null && climateControlPct >= 0.6) { modeled -= 0.0025; adjustments.push('climate_quality-25bps'); }
  if (yearBuilt !== null && (2026 - yearBuilt) > 30) { modeled += 0.005; adjustments.push('older_vintage+50bps'); }
  if (buyerDepth === 'DEEP') { modeled -= 0.0025; adjustments.push('deep_buyer_pool-25bps'); }
  if (buyerDepth === 'THIN') { modeled += 0.0075; adjustments.push('thin_buyer_pool+75bps'); }
  if (hasExpansion) { modeled -= 0.0025; adjustments.push('expansion_optionality-25bps'); }
  modeled = round(clamp(modeled, STORAGE_CAP_RATE_BOUNDS.min, STORAGE_CAP_RATE_BOUNDS.max), 4);

  // Selection: observed (qualified) dominates; else modeled market. Implied is
  // corroboration only and never the underwriting cap.
  let selected;
  if (observed.length >= 3) {
    const rates = observed.map((o) => o.cap_rate).sort((x, y) => x - y);
    selected = { kind: STORAGE_CAP_KIND.OBSERVED, cap_rate: round(rates[Math.floor((rates.length - 1) / 2)], 4), qualified: true, evidence_count: observed.length };
  } else {
    selected = { kind: STORAGE_CAP_KIND.MODELED_MARKET, cap_rate: modeled, qualified: false, evidence_count: observed.length };
  }

  return {
    observed, implied,
    modeled_market: { kind: STORAGE_CAP_KIND.MODELED_MARKET, cap_rate: modeled, adjustments, facility_class: facilityClass },
    selected,
  };
}
