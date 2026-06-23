/**
 * Acquisition Engine V3 — Item 5B: 5+ unit multifamily valuation (income asset).
 *
 * 5+ units are COMMERCIAL income assets: NOI/cap, price-per-unit, rentable-SF
 * economics, occupancy, expenses and buyer demand are primary. Residential ARV
 * may NOT be the dominant model. Size bands (5–20 / 21–99 / 100+) are isolated:
 * a six-unit cannot use a 200-unit property as a primary comp. Adjacent-band
 * fallback is explicit, size-adjusted, confidence-reduced, and non-autonomous.
 */

import {
  ASSET_FAMILIES,
  VALUATION_UNIVERSES as U,
  VALUE_CLASSIFICATION as VC,
  LIQUIDATION_FACTOR,
  num,
  round,
  roundMoney,
  clamp,
} from './modelConstants.js';
import { median } from './acquisitionMath.js';
import {
  buildOperatingStatement,
  resolveCapRate,
  sizeBand,
  valueFromCap,
  capRateFromValue,
  grm,
  egim,
  pricePerUnit,
  pricePerRentableSqft,
  breakEvenOccupancy,
  debtYield,
  dscr,
} from './incomeUnderwriting.js';

const BAND_ORDER = ['MF_5_20', 'MF_21_99', 'MF_100_PLUS'];

function adjacentBands(band) {
  const i = BAND_ORDER.indexOf(band);
  return [BAND_ORDER[i - 1], BAND_ORDER[i + 1]].filter(Boolean);
}

function mkValue(method, mid, { low = null, high = null, classification = VC.PROVISIONAL_SCENARIO, basis = 'ASSUMED', confidence = 30, inputs = {} } = {}) {
  if (mid === null || mid === undefined) {
    return { method, available: false, mid: null, low: null, high: null, value_classification: null, confidence: 0, inputs };
  }
  return {
    method, available: true,
    mid: roundMoney(mid), low: roundMoney(low ?? mid * 0.9), high: roundMoney(high ?? mid * 1.1),
    value_classification: classification, evidence_basis: basis, confidence: round(confidence, 0), inputs,
  };
}

/** Median PPU/PPSF/cap from a comp set (comps carry ppu/ppsf; cap if present). */
function compStats(comps) {
  const ppu = comps.map((c) => num(c.ppu)).filter((v) => v !== null && v > 0);
  const ppsf = comps.map((c) => num(c.ppsf)).filter((v) => v !== null && v > 0);
  const caps = comps.map((c) => num(c.raw?.cap_rate)).filter((v) => v !== null && v > 0.02 && v < 0.2);
  return {
    ppu_median: ppu.length ? median(ppu) : null,
    ppsf_median: ppsf.length ? median(ppsf) : null,
    cap_median: caps.length ? median(caps) : null,
    ppu_n: ppu.length, ppsf_n: ppsf.length, cap_n: caps.length,
  };
}

/** Is the comp an institutional-channel transaction? (entity heuristic) */
function isInstitutional(comp) {
  const u = comp.universe ?? comp.raw?.v3_universe_hint;
  if (u === U.INSTITUTIONAL_VALUE) return true;
  return /institution|reit|invitation|amherst|tricon|blackstone|pretium|progress residential/i.test(
    String(comp.raw?.owner_name ?? comp.raw?.buyer_name ?? ''),
  );
}

/**
 * @param {object} args
 * @param {object} args.contract   normalized income contract
 * @param {object[]} args.accepted qualified accepted comps
 * @param {object} args.universes  computed valuation universes
 * @param {string} args.lane       subject lane (MULTIFAMILY_5_20|21_99|100_PLUS)
 */
export function buildMultifamilyValuation({ contract, accepted = [], fallbackComps = [], universes = {}, lane }) {
  const subjectUnits = num(contract.unit_count?.value);
  const subjectSqft = num(contract.rentable_square_feet?.value);
  const family = ASSET_FAMILIES.MULTIFAMILY;
  const subjectBand = sizeBand(lane, subjectUnits);
  const adj = adjacentBands(subjectBand);

  // Same-band comps are primary (accepted, exact band). Adjacent-band evidence —
  // including REVIEW fallback-lane comps — is explicit fallback only.
  const accIncome = accepted.filter((a) => num(a.raw?.units_count) !== null && num(a.raw.units_count) >= 5);
  const sameBand = accIncome.filter((a) => sizeBand(null, num(a.raw.units_count)) === subjectBand);
  const adjPool = [
    ...accIncome.filter((a) => adj.includes(sizeBand(null, num(a.raw.units_count)))),
    ...fallbackComps.filter((a) => num(a.raw?.units_count) >= 5 && adj.includes(sizeBand(null, num(a.raw.units_count)))),
  ];
  const adjacentBand = adjPool;

  const haveSameBand = sameBand.length >= 3;
  const usingAdjacent = !haveSameBand && adjacentBand.length > 0;
  const compSet = haveSameBand ? sameBand : (usingAdjacent ? adjacentBand : sameBand);
  const bandPenalty = usingAdjacent ? 0.65 : 1;
  const stats = compStats(compSet);
  const instStats = compStats(compSet.filter(isInstitutional));

  // ---- Operating statement (NOI bridge; excludes debt/depr/tax/capex) ----
  const op = buildOperatingStatement(contract, { lane });
  const capEvidence = compSet
    .filter((c) => num(c.raw?.cap_rate) !== null)
    .map((c) => ({ cap_rate: num(c.raw.cap_rate), qualified: sizeBand(null, num(c.raw?.units_count)) === subjectBand }));
  const marketCap = resolveCapRate({ capEvidence, family });
  const observedCap = stats.cap_median ?? marketCap.cap_rate;

  const currentNoi = op.current_noi?.noi ?? null;
  const stabilizedNoi = op.stabilized_noi?.noi ?? null;
  // Pro forma = stabilized with a labeled upside (market rents fully achieved).
  const proFormaNoi = stabilizedNoi;
  const egi = op.current_noi?.effective_gross_income ?? null;

  // ---- Separate income-asset values ----
  const stabilizedValue = valueFromCap(stabilizedNoi, marketCap.cap_rate);
  const currentValue = valueFromCap(currentNoi, observedCap);
  const investorPpuValue = stats.ppu_median !== null && subjectUnits ? stats.ppu_median * subjectUnits : null;
  const institutionalPpuValue = instStats.ppu_median !== null && subjectUnits ? instStats.ppu_median * subjectUnits : null;
  const rsfValue = stats.ppsf_median !== null && subjectSqft ? stats.ppsf_median * subjectSqft : null;
  const compTxnVals = compSet.map((c) => num(c.consideration)).filter((v) => v !== null);
  const compTxnValue = compTxnVals.length ? median(compTxnVals) : null;
  const liqU = universes[U.LIQUIDATION_VALUE];
  const liqValue = liqU?.available ? liqU.mid : (currentValue !== null ? currentValue * LIQUIDATION_FACTOR : (stabilizedValue !== null ? stabilizedValue * LIQUIDATION_FACTOR : null));

  const incomeSupported = op.income_supported && marketCap.qualified;
  const incomeClass = incomeSupported ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO;

  const values = {
    stabilized_noi_market_cap: mkValue('STABILIZED_NOI_MARKET_CAP', stabilizedValue, {
      classification: incomeClass, basis: incomeSupported ? 'KNOWN' : 'ASSUMED',
      confidence: clamp((incomeSupported ? 65 : 35) * bandPenalty, 0, 100),
      inputs: { stabilized_noi: stabilizedNoi, market_cap: marketCap.cap_rate, cap_qualified: marketCap.qualified },
    }),
    current_noi_observed_cap: mkValue('CURRENT_NOI_OBSERVED_CAP', currentValue, {
      classification: op.income_supported ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO, basis: op.income_supported ? 'KNOWN' : 'ASSUMED',
      confidence: clamp((op.income_supported ? 60 : 30) * bandPenalty, 0, 100),
      inputs: { current_noi: currentNoi, observed_cap: observedCap },
    }),
    investor_ppu: mkValue('INVESTOR_PPU', investorPpuValue, {
      classification: haveSameBand && stats.ppu_n >= 3 ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO, basis: stats.ppu_n ? 'KNOWN' : 'ASSUMED',
      confidence: clamp((stats.ppu_n / 5) * 70 * bandPenalty, 0, 100),
      inputs: { ppu_median: stats.ppu_median, ppu_sample: stats.ppu_n, subject_units: subjectUnits },
    }),
    institutional_ppu: mkValue('INSTITUTIONAL_PPU', institutionalPpuValue, {
      classification: instStats.ppu_n >= 3 ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO, basis: instStats.ppu_n ? 'KNOWN' : 'ASSUMED',
      confidence: clamp((instStats.ppu_n / 4) * 65 * bandPenalty, 0, 100),
      inputs: { institutional_ppu_median: instStats.ppu_median, institutional_sample: instStats.ppu_n },
    }),
    rentable_sqft: mkValue('RENTABLE_SQFT', rsfValue, {
      classification: haveSameBand && stats.ppsf_n >= 3 ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO, basis: stats.ppsf_n ? 'KNOWN' : 'ASSUMED',
      confidence: clamp((stats.ppsf_n / 5) * 60 * bandPenalty, 0, 100),
      inputs: { ppsf_median: stats.ppsf_median, ppsf_sample: stats.ppsf_n, subject_rentable_sqft: subjectSqft },
    }),
    comparable_income_transactions: mkValue('COMPARABLE_INCOME_TRANSACTIONS', compTxnValue, {
      classification: haveSameBand ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO, basis: compTxnVals.length ? 'KNOWN' : 'ASSUMED',
      confidence: clamp((compTxnVals.length / 5) * 65 * bandPenalty, 0, 100),
      inputs: { comp_sample: compTxnVals.length, band: subjectBand },
    }),
    liquidation: mkValue('LIQUIDATION', liqValue, {
      classification: VC.PROVISIONAL_SCENARIO, basis: liqU?.available ? 'KNOWN' : 'INFERRED', confidence: liqU?.confidence ?? 30,
      inputs: { liquidation_factor: LIQUIDATION_FACTOR, derived: !liqU?.available },
    }),
  };

  // Debt-derived metrics (only when current debt inputs exist).
  const debt = contract.current_debt ?? {};
  const loanBalance = num(debt.balance?.value);
  const monthlyPayment = num(debt.monthly_payment?.value);
  const annualDebtService = monthlyPayment !== null ? monthlyPayment * 12 : null;

  return {
    lane,
    family,
    size_band: subjectBand,
    dominant_model: 'STABILIZED_NOI_MARKET_CAP',
    residential_arv_dominant: false, // ARV is never dominant for 5+ (mission §CORE)
    same_band_comp_count: sameBand.length,
    adjacent_band_comp_count: adjacentBand.length,
    size_band_fallback: {
      used: usingAdjacent,
      reason: usingAdjacent ? `only_${sameBand.length}_same_band_comps(<3)` : null,
      adjacent_bands: usingAdjacent ? adj : [],
      size_adjustment_applied: usingAdjacent,
      confidence_penalty: usingAdjacent ? 1 - bandPenalty : 0,
      autonomous_eligible: false,
    },
    operating_statement: op,
    noi: {
      current_noi: currentNoi,
      trailing_noi: num(contract.trailing_noi?.value) ?? null,
      stabilized_noi: stabilizedNoi,
      pro_forma_noi: proFormaNoi,
    },
    metrics: {
      current_cap_rate: capRateFromValue(currentNoi, currentValue),
      stabilized_cap_rate: capRateFromValue(stabilizedNoi, stabilizedValue),
      market_cap_rate: marketCap.cap_rate,
      grm: grm(currentValue ?? stabilizedValue, op.rent.current_gross_annual ?? op.rent.market_gross_annual),
      egim: egim(currentValue ?? stabilizedValue, egi),
      operating_expense_ratio: op.expenses.expense_ratio,
      price_per_unit: pricePerUnit(currentValue ?? stabilizedValue, subjectUnits),
      price_per_rentable_sqft: pricePerRentableSqft(currentValue ?? stabilizedValue, subjectSqft),
      break_even_occupancy: breakEvenOccupancy(op.expenses.total_operating_expenses, annualDebtService, op.rent.current_gross_annual ?? op.rent.market_gross_annual),
      debt_yield: debtYield(currentNoi, loanBalance),
      dscr: dscr(currentNoi, annualDebtService),
    },
    cap_rate_model: marketCap,
    values,
  };
}
