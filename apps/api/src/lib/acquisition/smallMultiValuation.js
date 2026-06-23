/**
 * Acquisition Engine V3 — Item 5B: 2–4 unit (DUPLEX/TRIPLEX/FOURPLEX) valuation.
 *
 * 2–4 units are RESIDENTIAL investment assets: exact unit-count comparable sales
 * are Tier 1; investor PPU/PPSF matter; GRM and NOI/cap corroborate; owner-
 * occupant/retail demand may support novation. Each value below is computed
 * INDEPENDENTLY and labeled; cross-unit fallback is explicit, adjustment-
 * supported, confidence-reduced, and never autonomously executable.
 */

import {
  ASSET_FAMILIES,
  ASSET_LANES,
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
  valueFromCap,
  grm,
  pricePerUnit,
  pricePerRentableSqft,
} from './incomeUnderwriting.js';

const SMALL_MULTI_LANES = new Set([ASSET_LANES.DUPLEX, ASSET_LANES.TRIPLEX, ASSET_LANES.FOURPLEX]);

/** Default market GRM by lane when no comp-derived GRM exists (LABELED). */
const DEFAULT_MARKET_GRM = Object.freeze({ DUPLEX: 9.5, TRIPLEX: 9.0, FOURPLEX: 8.5 });

/** Tier-1 exact-unit comps required before cross-unit fallback is permitted. */
const MIN_EXACT_COMPS = 3;

function mkValue(method, mid, { low = null, high = null, classification = VC.PROVISIONAL_SCENARIO, basis = 'ASSUMED', inputs = {}, confidence = 30, tier = null } = {}) {
  if (mid === null || mid === undefined) {
    return { method, available: false, mid: null, low: null, high: null, value_classification: null, confidence: 0, inputs };
  }
  return {
    method,
    available: true,
    mid: roundMoney(mid),
    low: roundMoney(low ?? mid * 0.92),
    high: roundMoney(high ?? mid * 1.08),
    value_classification: classification,
    evidence_basis: basis,
    confidence: round(confidence, 0),
    comp_tier: tier,
    inputs,
  };
}

/** Adjust a comp consideration to the subject by sqft + unit scaling (±40%). */
function adjustToSubject(consideration, comp, subjectUnits, subjectSqft) {
  const cu = num(comp.raw?.units_count);
  const csqft = num(comp.raw?.building_square_feet) ?? num(comp.raw?.sqft);
  const candidates = [];
  if (csqft && subjectSqft) candidates.push(consideration * (subjectSqft / csqft));
  if (cu && subjectUnits) candidates.push(consideration * (subjectUnits / cu));
  if (!candidates.length) candidates.push(consideration);
  const blended = candidates.reduce((s, v) => s + v, 0) / candidates.length;
  return clamp(blended, consideration * 0.6, consideration * 1.6);
}

/**
 * @param {object} args
 * @param {object} args.contract        normalized income contract
 * @param {object[]} args.accepted      qualified accepted comps
 * @param {object} args.universes       computed valuation universes
 * @param {string} args.lane            subject lane
 */
export function buildSmallMultiValuation({ contract, accepted = [], fallbackComps = [], universes = {}, lane }) {
  const subjectUnits = num(contract.unit_count?.value);
  const subjectSqft = num(contract.rentable_square_feet?.value);
  const family = ASSET_FAMILIES.SMALL_MULTI;

  const smallMultiComps = accepted.filter((a) => SMALL_MULTI_LANES.has(a.comp_lane));
  const exact = smallMultiComps.filter((a) => subjectUnits !== null && num(a.raw?.units_count) === subjectUnits);
  // Cross-unit fallback = accepted different-unit comps + REVIEW fallback-lane comps.
  const fallbackSmallMulti = fallbackComps.filter(
    (a) => SMALL_MULTI_LANES.has(a.comp_lane) && subjectUnits !== null && num(a.raw?.units_count) !== subjectUnits,
  );
  const crossUnit = [
    ...smallMultiComps.filter((a) => subjectUnits !== null && num(a.raw?.units_count) !== null && num(a.raw?.units_count) !== subjectUnits),
    ...fallbackSmallMulti,
  ];

  const haveExact = exact.length >= MIN_EXACT_COMPS;
  // Primary comp set: exact-unit (Tier 1). Cross-unit fallback only when exact
  // is inadequate — explicit, adjusted, confidence-reduced, non-autonomous.
  const usingFallback = !haveExact && crossUnit.length > 0;
  const compSet = haveExact ? exact : (usingFallback ? crossUnit : exact);
  const tier = haveExact ? 'TIER_1_EXACT_UNIT' : (usingFallback ? 'FALLBACK_CROSS_UNIT' : 'INSUFFICIENT');
  const fallbackPenalty = usingFallback ? 0.7 : 1;

  // ---- 1. Direct adjusted comparable value ----
  const adjustedVals = compSet
    .filter((c) => num(c.consideration) !== null)
    .map((c) => adjustToSubject(num(c.consideration), c, subjectUnits, subjectSqft));
  const directMid = adjustedVals.length ? median(adjustedVals) : null;
  const directConf = clamp((adjustedVals.length / 5) * 80 * fallbackPenalty + (haveExact ? 20 : 0), 0, 100);

  // ---- 2. Investor PPU value ----
  const ppus = compSet.map((c) => num(c.ppu)).filter((v) => v !== null && v > 0);
  const ppuMedian = ppus.length ? median(ppus) : null;
  const ppuMid = ppuMedian !== null && subjectUnits ? ppuMedian * subjectUnits : null;

  // ---- 3. Investor PPSF value ----
  const ppsfs = compSet.map((c) => num(c.ppsf)).filter((v) => v !== null && v > 0);
  const ppsfMedian = ppsfs.length ? median(ppsfs) : null;
  const ppsfMid = ppsfMedian !== null && subjectSqft ? ppsfMedian * subjectSqft : null;

  // ---- Operating statement (rent + expense + NOI) ----
  const op = buildOperatingStatement(contract, { lane });
  const cap = resolveCapRate({ capEvidence: [], family, subjectCapRate: num(contract.subject_cap_rate?.value) });

  // ---- 4. GRM value (corroboration) ----
  const grossAnnual = op.rent.market_gross_annual ?? op.rent.current_gross_annual;
  const marketGrm = DEFAULT_MARKET_GRM[lane] ?? 9.0;
  const grmMid = grossAnnual !== null ? grossAnnual * marketGrm : null;

  // ---- 5/6. Current & stabilized NOI/cap value ----
  const currentNoi = op.current_noi?.noi ?? null;
  const stabilizedNoi = op.stabilized_noi?.noi ?? null;
  const currentNoiValue = valueFromCap(currentNoi, cap.cap_rate);
  const stabilizedNoiValue = valueFromCap(stabilizedNoi, cap.cap_rate);

  // ---- 7. Retail / owner-occupant value ----
  const retailU = universes[U.RETAIL_MLS_VALUE];
  const retailMid = retailU?.available ? retailU.mid : null;

  // ---- 8. Liquidation value ----
  const liqU = universes[U.LIQUIDATION_VALUE];
  const liqMid = liqU?.available ? liqU.mid : (directMid !== null ? directMid * LIQUIDATION_FACTOR : null);

  const incomeClass = op.income_supported ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO;

  const values = {
    direct_adjusted_comparable: mkValue('DIRECT_ADJUSTED_COMPARABLE', directMid, {
      classification: haveExact ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO,
      basis: haveExact ? 'KNOWN' : 'INFERRED',
      confidence: directConf, tier,
      inputs: { exact_comp_count: exact.length, cross_unit_comp_count: crossUnit.length, adjusted_sample: adjustedVals.length },
    }),
    investor_ppu: mkValue('INVESTOR_PPU', ppuMid, {
      classification: haveExact && ppus.length >= 3 ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO,
      basis: ppus.length ? 'KNOWN' : 'ASSUMED',
      confidence: clamp((ppus.length / 5) * 75 * fallbackPenalty, 0, 100),
      tier, inputs: { ppu_median: ppuMedian, subject_units: subjectUnits, ppu_sample: ppus.length },
    }),
    investor_ppsf: mkValue('INVESTOR_PPSF', ppsfMid, {
      classification: haveExact && ppsfs.length >= 3 ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO,
      basis: ppsfs.length ? 'KNOWN' : 'ASSUMED',
      confidence: clamp((ppsfs.length / 5) * 70 * fallbackPenalty, 0, 100),
      tier, inputs: { ppsf_median: ppsfMedian, subject_rentable_sqft: subjectSqft, ppsf_sample: ppsfs.length },
    }),
    grm: mkValue('GRM', grmMid, {
      classification: VC.PROVISIONAL_SCENARIO, basis: 'ASSUMED', confidence: op.income_supported ? 45 : 25,
      inputs: { market_grm: marketGrm, gross_annual_rent: grossAnnual, note: 'corroboration_only' },
    }),
    current_noi_cap: mkValue('CURRENT_NOI_CAP', currentNoiValue, {
      classification: incomeClass, basis: op.income_supported ? 'KNOWN' : 'ASSUMED',
      confidence: op.income_supported ? 55 : 30,
      inputs: { current_noi: currentNoi, cap_rate: cap.cap_rate, cap_basis: cap.basis },
    }),
    stabilized_noi_cap: mkValue('STABILIZED_NOI_CAP', stabilizedNoiValue, {
      classification: VC.PROVISIONAL_SCENARIO, basis: 'ASSUMED', confidence: op.income_supported ? 40 : 25,
      inputs: { stabilized_noi: stabilizedNoi, cap_rate: cap.cap_rate },
    }),
    retail_owner_occupant: mkValue('RETAIL_OWNER_OCCUPANT', retailMid, {
      classification: retailU?.available ? VC.QUALIFIED : VC.PROVISIONAL_SCENARIO, basis: retailU?.available ? 'KNOWN' : 'ASSUMED',
      confidence: retailU?.confidence ?? 0, inputs: { retail_universe_available: Boolean(retailU?.available) },
    }),
    liquidation: mkValue('LIQUIDATION', liqMid, {
      classification: VC.PROVISIONAL_SCENARIO, basis: liqU?.available ? 'KNOWN' : 'INFERRED', confidence: liqU?.confidence ?? 30,
      inputs: { liquidation_factor: LIQUIDATION_FACTOR, derived: !liqU?.available },
    }),
  };

  return {
    lane,
    family,
    dominant_model: 'DIRECT_ADJUSTED_COMPARABLE',
    comp_tier: tier,
    exact_unit_comp_count: exact.length,
    cross_unit_comp_count: crossUnit.length,
    cross_unit_fallback: {
      used: usingFallback,
      reason: usingFallback ? `only_${exact.length}_exact_unit_comps(<${MIN_EXACT_COMPS})` : null,
      adjustment_applied: usingFallback ? 'sqft_and_unit_scaling' : null,
      confidence_penalty: usingFallback ? 1 - fallbackPenalty : 0,
      autonomous_eligible: false,
    },
    operating_statement: op,
    cap_rate_model: cap,
    values,
    ppu_ppsf_grm: {
      ppu_median: ppuMedian,
      ppsf_median: ppsfMedian,
      implied_grm: grm(directMid, grossAnnual),
      subject_ppu: pricePerUnit(directMid, subjectUnits),
      subject_ppsf: pricePerRentableSqft(directMid, subjectSqft),
    },
  };
}
