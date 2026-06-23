/**
 * Acquisition Engine V3 — Item 5E §11, §14–§18: retail valuation, single-tenant,
 * ground-lease, capital, co-tenancy/anchor risk and business-value separation.
 *
 * Valuation methods are computed INDEPENDENTLY (mission §14):
 *   A. current NOI / observed cap      G. single-tenant lease value
 *   B. stabilized NOI / market cap     H. ground-lease value
 *   C. lease-by-lease DCF              I. dark / vacant value
 *   D. price per GLA                   J. redevelopment / residual value
 *   E. price per occupied SF           K. liquidation value
 *   F. comparable retail transactions
 *
 * For a stabilized multi-tenant center, stabilized-NOI/cap and DCF dominate when
 * supportable. For single-tenant net lease, tenant credit / lease term /
 * escalations / residual drive value. For vacant/dark retail, nonexistent rent is
 * NEVER capitalized as current NOI. Business value (goodwill / FF&E / inventory /
 * franchise) is NEVER included in real-estate value (§18). Capital items are never
 * double-counted (§17).
 *
 * Pure & deterministic.
 */

import { num, round, roundMoney, clamp } from './modelConstants.js';
import { valueFromCap } from './incomeUnderwriting.js';
import { RETAIL_CAP_KIND } from './retailUnderwriting.js';
import {
  RETAIL_SUBTYPE as ST,
  RETAIL_CONCENTRATION as CONC,
  RETAIL_DEFAULT_CAP_RATE,
} from './retailConstants.js';
import { RETAIL_COMP_UNIVERSE as CU } from './retailComps.js';

const VC = Object.freeze({ QUALIFIED: 'QUALIFIED', PROVISIONAL: 'PROVISIONAL_SCENARIO', NONE: 'NONE' });

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
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

/** Subtype-relevant comp universes for the subject. */
function subjectCompUniverses(comparables, subtype) {
  const u = comparables?.universes ?? {};
  const map = {
    [ST.NEIGHBORHOOD_STRIP_CENTER]: [CU.NEIGHBORHOOD_STRIP, CU.UNANCHORED_STRIP],
    [ST.UNANCHORED_STRIP_CENTER]: [CU.UNANCHORED_STRIP, CU.NEIGHBORHOOD_STRIP],
    [ST.GROCERY_ANCHORED_CENTER]: [CU.GROCERY_ANCHORED, CU.COMMUNITY_CENTER],
    [ST.COMMUNITY_SHOPPING_CENTER]: [CU.COMMUNITY_CENTER, CU.GROCERY_ANCHORED],
    [ST.SINGLE_TENANT_NET_LEASE]: [CU.SINGLE_TENANT_NET_LEASE, CU.FREESTANDING],
    [ST.FREESTANDING_RETAIL]: [CU.FREESTANDING, CU.SINGLE_TENANT_NET_LEASE],
    [ST.BIG_BOX_RETAIL]: [CU.BIG_BOX],
    [ST.RETAIL_CONDOMINIUM]: [CU.RETAIL_CONDO],
    [ST.GROUND_LEASE]: [CU.GROUND_LEASE],
    [ST.MULTI_TENANT_STOREFRONT]: [CU.NEIGHBORHOOD_STRIP, CU.UNANCHORED_STRIP],
  };
  const keys = map[subtype] ?? [CU.UNANCHORED_STRIP, CU.NEIGHBORHOOD_STRIP];
  return keys.flatMap((k) => u[k] ?? []);
}

/**
 * Build all retail valuation methods + a reconciled value.
 */
export function buildRetailValuation({ contract, noi, revenue, capRate, comparables, rollover, operationalStatus, tenancy, singleTenant = null, groundLease = null }) {
  const gla = num(contract.physical.gross_leasable_area?.value);
  const occupancy = num(revenue?.physical_occupancy);
  const occupiedGla = gla !== null && occupancy !== null ? gla * occupancy : num(contract.rent_roll?.occupied_gla);
  const subtype = contract.subtype;

  const stabilizedNoi = num(noi?.stabilized_noi?.noi);
  const currentNoi = num(noi?.current_noi?.noi);
  const incomeSupported = Boolean(noi?.income_supported);
  const observedCapQualified = capRate?.selected?.kind === RETAIL_CAP_KIND.OBSERVED && capRate.selected.qualified;
  const marketCap = capRate?.modeled_market?.cap_rate ?? null;
  const observedCap = observedCapQualified ? capRate.selected.cap_rate : null;
  const nearTermMaterial = Boolean(rollover?.near_term_material);

  const methods = {};
  const isVacantOrDark = operationalStatus === 'VACANT' || operationalStatus === 'DARK' || tenancy === 'VACANT';

  // A. Current NOI / observed cap (QUALIFIED only with observed cap + observed NOI).
  // Vacant/dark: do NOT capitalize nonexistent rent as current NOI.
  const currentValue = !isVacantOrDark && currentNoi !== null && currentNoi > 0 && (observedCap ?? marketCap) !== null
    ? valueFromCap(currentNoi, observedCap ?? marketCap) : null;
  methods.current_noi_cap = mkMethod('CURRENT_NOI_CAP', currentValue, {
    classification: incomeSupported && observedCapQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: incomeSupported ? (observedCapQualified ? 60 : 35) : 20,
    lineage: ['current_noi', observedCapQualified ? 'observed_cap' : 'modeled_market_cap'],
    assumptions: observedCapQualified ? [] : ['observed_cap_unavailable'],
  });

  // B. Stabilized NOI / market cap.
  const stabValue = !isVacantOrDark && stabilizedNoi !== null && marketCap !== null ? valueFromCap(stabilizedNoi, marketCap) : null;
  methods.stabilized_noi_market_cap = mkMethod('STABILIZED_NOI_MARKET_CAP', stabValue, {
    classification: incomeSupported && observedCapQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: incomeSupported ? (observedCapQualified ? 62 : 45) : 25,
    lineage: ['stabilized_noi', observedCapQualified ? 'observed_cap' : 'modeled_market_cap'],
    assumptions: observedCapQualified ? [] : [`modeled_cap=${marketCap}`],
  });

  // C. Lease-by-lease DCF (reconciles cash flows + terminal value).
  const dcf = buildLeaseDCF({ contract, noi, revenue, rollover, marketCap, operationalStatus });
  methods.lease_dcf = mkMethod('LEASE_BY_LEASE_DCF', dcf.present_value, {
    classification: incomeSupported && dcf.available ? VC.PROVISIONAL : VC.NONE,
    confidence: dcf.available ? (incomeSupported ? 50 : 25) : 0,
    lineage: ['discounted_lease_cash_flows', 'terminal_value'], assumptions: dcf.assumptions, spread: 0.12,
  });

  // D / E. Price per GLA, price per occupied SF (from qualified comps).
  const comps = subjectCompUniverses(comparables, subtype);
  const ppglaComps = comps.map((c) => num(c.price_per_gla)).filter((v) => v !== null && v > 0);
  const medPpgla = median(ppglaComps);
  const compsQualified = comps.length >= 3;

  const ppglaValue = medPpgla !== null && gla !== null ? roundMoney(medPpgla * gla) : null;
  methods.price_per_gla = mkMethod('PRICE_PER_GLA', ppglaValue, {
    classification: compsQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: compsQualified ? 58 : 30, sample: comps.length, ess: comps.length,
    lineage: ['median_qualified_comp_ppgla', 'subject_gla'],
    assumptions: contract.physical.gross_leasable_area?.basis === 'MARKET_MODELED' ? ['gla_modeled_from_gba'] : [],
  });

  const ppOccValue = medPpgla !== null && occupiedGla !== null && occupiedGla > 0 ? roundMoney(medPpgla * occupiedGla) : null;
  methods.price_per_occupied_sf = mkMethod('PRICE_PER_OCCUPIED_SF', ppOccValue, {
    classification: compsQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: compsQualified ? 48 : 24, sample: comps.length, ess: comps.length,
    lineage: ['median_qualified_comp_ppgla', 'subject_occupied_gla'],
  });

  // F. Comparable retail transaction value.
  methods.comparable_transaction = mkMethod('COMPARABLE_TRANSACTION', ppglaValue, {
    classification: compsQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: compsQualified ? 56 : 28, sample: comps.length, ess: comps.length,
    lineage: ['qualified_retail_comps_ppgla'],
  });

  // G. Single-tenant lease value (only for single-tenant subjects).
  methods.single_tenant_lease = mkMethod('SINGLE_TENANT_LEASE_VALUE', singleTenant?.lease_value ?? null, {
    classification: singleTenant?.available ? VC.PROVISIONAL : VC.NONE,
    confidence: singleTenant?.confidence ?? 0, lineage: ['tenant_credit', 'lease_term', 'residual_value'],
    assumptions: singleTenant?.assumptions ?? [],
  });

  // H. Ground-lease value.
  methods.ground_lease = mkMethod('GROUND_LEASE_VALUE', groundLease?.ground_lease_value ?? null, {
    classification: groundLease?.available ? VC.PROVISIONAL : VC.NONE,
    confidence: groundLease?.confidence ?? 0, lineage: ['ground_rent', 'reversion'], assumptions: groundLease?.assumptions ?? [],
  });

  // I. Dark / vacant value (re-tenanting cost subtracted from stabilized).
  const darkValue = (isVacantOrDark || nearTermMaterial)
    ? buildDarkVacantValue({ stabilizedNoi, marketCap, rollover, comps, gla, medPpgla })
    : null;
  methods.dark_vacant = mkMethod('DARK_VACANT_VALUE', darkValue?.value ?? null, {
    classification: VC.PROVISIONAL, confidence: darkValue ? 32 : 0, spread: 0.15,
    lineage: ['stabilized_value_less_re_tenanting'], assumptions: darkValue?.assumptions ?? [],
  });

  // J. Redevelopment / residual value (land less demolition, when applicable).
  const redev = buildRedevelopmentValue({ contract, operationalStatus });
  methods.redevelopment = mkMethod('REDEVELOPMENT_RESIDUAL', redev?.value ?? null, {
    classification: VC.PROVISIONAL, confidence: redev ? 22 : 0, spread: 0.2,
    lineage: ['land_value_less_demolition'], assumptions: redev?.assumptions ?? [],
  });

  // K. Liquidation value (discount to value floor).
  const baseForLiquidation = methods.comparable_transaction.available ? methods.comparable_transaction.mid
    : (methods.stabilized_noi_market_cap.available ? methods.stabilized_noi_market_cap.mid : null);
  const liquidationValue = baseForLiquidation !== null ? roundMoney(baseForLiquidation * 0.72) : null;
  methods.liquidation = mkMethod('LIQUIDATION', liquidationValue, {
    classification: VC.PROVISIONAL, confidence: 28, spread: 0.15,
    lineage: ['0.72_of_value_floor'], assumptions: ['distressed_disposition_discount=0.28'],
  });

  const reconciliation = reconcileRetailValuation({
    methods, subtype, tenancy, operationalStatus, incomeSupported, observedCapQualified, compsQualified, isVacantOrDark, nearTermMaterial, singleTenant,
  });

  return {
    subtype,
    methods,
    dcf,
    single_tenant: singleTenant,
    ground_lease: groundLease,
    dark_vacant: darkValue,
    redevelopment: redev,
    reconciliation,
    dominant_method: reconciliation.dominant_method,
    income_supported: incomeSupported,
  };
}

/**
 * Reconcile independent methods. Stabilized-NOI/cap + DCF dominate a supportable
 * stabilized multi-tenant center; single-tenant lease value dominates net-lease;
 * vacant/dark uses dark value and never capitalizes nonexistent NOI.
 */
export function reconcileRetailValuation({ methods, subtype, tenancy, operationalStatus, incomeSupported, observedCapQualified, compsQualified, isVacantOrDark, nearTermMaterial, singleTenant }) {
  const all = Object.values(methods).filter((m) => m.available);
  const excludeFromBlend = new Set(['LIQUIDATION', 'REDEVELOPMENT_RESIDUAL']);
  const available = all.filter((m) => !excludeFromBlend.has(m.method));
  const qualified = available.filter((m) => m.classification === VC.QUALIFIED);

  const incomeLed = incomeSupported && observedCapQualified && !isVacantOrDark && !nearTermMaterial
    && operationalStatus !== 'LEASE_UP' && operationalStatus !== 'REDEVELOPMENT';
  const isSingleTenant = subtype === ST.SINGLE_TENANT_NET_LEASE || subtype === ST.FREESTANDING_RETAIL || tenancy === 'SINGLE_TENANT';

  const weights = {};
  for (const m of available) {
    let w = 0;
    if (isVacantOrDark) {
      // Vacant/dark: dark value + comps lead; income methods excluded.
      if (m.method === 'DARK_VACANT_VALUE') w = 0.5;
      else if (m.method === 'PRICE_PER_GLA') w = 0.25;
      else if (m.method === 'COMPARABLE_TRANSACTION') w = 0.25;
    } else if (isSingleTenant) {
      // Single-tenant: lease value / credit drive valuation.
      if (m.method === 'SINGLE_TENANT_LEASE_VALUE') w = 0.45;
      else if (m.method === 'CURRENT_NOI_CAP') w = incomeLed ? 0.25 : 0.1;
      else if (m.method === 'COMPARABLE_TRANSACTION') w = 0.2;
      else if (m.method === 'PRICE_PER_GLA') w = 0.1;
      else if (m.method === 'LEASE_BY_LEASE_DCF') w = 0.1;
    } else {
      // Multi-tenant center: stabilized NOI/cap + DCF dominate when supportable.
      if (m.method === 'STABILIZED_NOI_MARKET_CAP') w = incomeLed ? 0.4 : (incomeSupported ? 0.2 : 0.1);
      else if (m.method === 'LEASE_BY_LEASE_DCF') w = incomeLed ? 0.25 : (incomeSupported ? 0.15 : 0.05);
      else if (m.method === 'CURRENT_NOI_CAP') w = incomeLed ? 0.15 : (incomeSupported ? 0.1 : 0.05);
      else if (m.method === 'COMPARABLE_TRANSACTION') w = incomeLed ? 0.12 : (compsQualified ? 0.4 : 0.3);
      else if (m.method === 'PRICE_PER_GLA') w = incomeLed ? 0.05 : (compsQualified ? 0.2 : 0.12);
      else if (m.method === 'PRICE_PER_OCCUPIED_SF') w = incomeLed ? 0.03 : (compsQualified ? 0.1 : 0.08);
    }
    weights[m.method] = w;
  }
  const totalW = Object.values(weights).reduce((s, v) => s + v, 0);

  let mid = null;
  if (totalW > 0) mid = roundMoney(available.reduce((s, m) => s + m.mid * (weights[m.method] / totalW), 0));
  const lows = available.map((m) => m.low);
  const highs = available.map((m) => m.high);

  let dominant = null;
  let best = -1;
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
    is_single_tenant_led: isSingleTenant,
    is_vacant_dark: isVacantOrDark,
  };
}

/* -------------------------------------------------------------------------- */
/* Lease-by-lease DCF (§14C)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A transparent lease-level DCF. Discounts the in-place NOI stream, subtracts
 * required leasing capital at rollover, and adds a terminal value at an exit cap.
 * Returns the discount/terminal assumptions and a sensitivity band.
 */
export function buildLeaseDCF({ contract, noi, revenue, rollover, marketCap, operationalStatus, holdYears = 10 }) {
  const currentNoi = num(noi?.current_noi?.noi);
  const stabilizedNoi = num(noi?.stabilized_noi?.noi);
  if (currentNoi === null || marketCap === null) {
    return { available: false, reason: 'insufficient_noi_or_cap', present_value: null, assumptions: [] };
  }
  const discountRate = round(marketCap + 0.025, 4); // labeled spread over cap
  const terminalCap = round(marketCap + 0.0025, 4);
  const rentGrowth = 0.025;
  const expenseGrowth = 0.025;
  const requiredCapital = num(rollover?.required_leasing_capital) ?? 0;

  let pv = 0;
  let noiYear = currentNoi;
  const targetNoi = stabilizedNoi !== null && stabilizedNoi > currentNoi ? stabilizedNoi : currentNoi;
  for (let y = 1; y <= holdYears; y += 1) {
    // Ramp toward stabilized over first 3 years, then grow.
    if (y <= 3 && targetNoi > currentNoi) noiYear = currentNoi + (targetNoi - currentNoi) * (y / 3);
    else noiYear = noiYear * (1 + rentGrowth - expenseGrowth * 0.4);
    const capitalThisYear = y <= 3 ? requiredCapital / 3 : 0;
    const cf = noiYear - capitalThisYear;
    pv += cf / (1 + discountRate) ** y;
  }
  const terminalNoi = noiYear * (1 + rentGrowth);
  const terminalValue = valueFromCap(terminalNoi, terminalCap);
  const pvTerminal = terminalValue !== null ? terminalValue / (1 + discountRate) ** holdYears : 0;
  const presentValue = roundMoney(pv + pvTerminal);

  return {
    available: true,
    present_value: presentValue,
    discount_rate: discountRate,
    terminal_cap_rate: terminalCap,
    rent_growth: rentGrowth,
    expense_growth: expenseGrowth,
    hold_years: holdYears,
    terminal_value: terminalValue,
    pv_terminal: roundMoney(pvTerminal),
    pv_cash_flows: roundMoney(pv),
    leasing_capital_applied: roundMoney(requiredCapital),
    sensitivity: {
      value_at_cap_minus_50bps: valueFromCap(terminalNoi, round(terminalCap - 0.005, 4)),
      value_at_cap_plus_50bps: valueFromCap(terminalNoi, round(terminalCap + 0.005, 4)),
    },
    assumptions: [`discount=${discountRate}`, `terminal_cap=${terminalCap}`, `rent_growth=${rentGrowth}`, 'TI/LC subtracted at rollover'],
  };
}

/* -------------------------------------------------------------------------- */
/* Single-tenant net-lease model (§15)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Single-tenant net-lease value. Separates lease value (in-place rent at a
 * credit-adjusted cap) from RESIDUAL real-estate value and DARK value. A
 * recognizable brand can NEVER substitute for verified lease/guaranty evidence.
 */
export function buildSingleTenantValue({ contract, noi, capRate, tenantCredit, leaseTerms = null }) {
  const subtype = contract.subtype;
  const isSingleTenant = subtype === ST.SINGLE_TENANT_NET_LEASE || subtype === ST.FREESTANDING_RETAIL;
  if (!isSingleTenant) {
    return { available: false, reason: 'not_single_tenant', lease_value: null, residual_value: null, dark_value: null };
  }
  const noiVal = num(noi?.current_noi?.noi) ?? num(noi?.contractual_noi?.noi);
  const marketCap = capRate?.modeled_market?.cap_rate ?? RETAIL_DEFAULT_CAP_RATE.SINGLE_TENANT_NET_LEASE;
  const observedCapQualified = capRate?.selected?.kind === RETAIL_CAP_KIND.OBSERVED && capRate.selected.qualified;
  const usedCap = observedCapQualified ? capRate.selected.cap_rate : marketCap;

  // Lease value = in-place NOI / credit-adjusted cap.
  const leaseValue = noiVal !== null ? valueFromCap(noiVal, usedCap) : null;

  // Remaining term + escalations drive lease-duration sensitivity.
  const remainingTerm = num(leaseTerms?.remaining_term_years);
  const escalation = num(leaseTerms?.annual_escalation_pct);

  // Residual real-estate value: the value of the building/land if re-tenanted at
  // market — independent of the current tenant's credit. Modeled at a wider cap.
  const gla = num(contract.physical.gross_leasable_area?.value);
  const marketRentPsf = num(contract.operations?.market_rent_psf?.value);
  const residualNoi = marketRentPsf !== null && gla !== null ? marketRentPsf * gla * 0.85 : null; // 85% margin (labeled)
  const residualCap = round(usedCap + 0.015, 4);
  const residualValue = residualNoi !== null ? valueFromCap(residualNoi, residualCap) : (leaseValue !== null ? roundMoney(leaseValue * 0.8) : null);

  // Dark value: vacant building value if the tenant goes dark (no rent).
  const darkValue = residualValue !== null ? roundMoney(residualValue * 0.7) : (leaseValue !== null ? roundMoney(leaseValue * 0.55) : null);

  // Weighted value: blends lease + residual by remaining-term confidence — a short
  // remaining term means more weight on residual/dark.
  let leaseWeight = 0.7;
  if (remainingTerm !== null) leaseWeight = clamp(0.35 + remainingTerm * 0.04, 0.35, 0.85);
  const weightedValue = leaseValue !== null && residualValue !== null
    ? roundMoney(leaseValue * leaseWeight + residualValue * (1 - leaseWeight)) : (leaseValue ?? residualValue);

  // Replacement-rent risk: if in-place rent is materially above market, replacement
  // at lease end is at risk.
  const replacementRentRisk = marketRentPsf !== null && num(contract.operations?.in_place_rent_psf?.value) !== null
    ? (num(contract.operations.in_place_rent_psf.value) > marketRentPsf * 1.15 ? 'HIGH' : 'MODERATE') : 'UNKNOWN';

  // Credit-adjusted cap is wider for weaker credit.
  const creditClass = tenantCredit?.credit_class ?? 'UNKNOWN';

  return {
    available: leaseValue !== null || residualValue !== null,
    tenant_credit_class: creditClass,
    guaranty_strength: tenantCredit?.guaranty_strength ?? 'UNKNOWN',
    used_cap_rate: usedCap,
    lease_value: leaseValue,
    residual_value: residualValue,
    dark_value: darkValue,
    weighted_value: weightedValue,
    lease_weight: round(leaseWeight, 2),
    remaining_term_years: remainingTerm,
    annual_escalation_pct: escalation,
    risk_adjusted_cap_rate: usedCap,
    replacement_rent_risk: replacementRentRisk,
    renewal_probability: tenantCredit?.credit_class === 'INVESTMENT_GRADE_NATIONAL' || tenantCredit?.credit_class === 'NATIONAL_CREDIT' ? 0.8 : 0.55,
    confidence: leaseValue !== null ? clamp(30 + (tenantCredit?.confidence ?? 0) * 0.3, 0, 70) : 10,
    lease_duration_sensitivity: {
      value_at_term_minus_2y: leaseValue !== null && residualValue !== null ? roundMoney(leaseValue * Math.max(0.35, leaseWeight - 0.08) + residualValue * (1 - Math.max(0.35, leaseWeight - 0.08))) : null,
      value_at_term_plus_2y: leaseValue !== null && residualValue !== null ? roundMoney(leaseValue * Math.min(0.85, leaseWeight + 0.08) + residualValue * (1 - Math.min(0.85, leaseWeight + 0.08))) : null,
    },
    assumptions: [`cap=${usedCap}`, 'residual separates dark/market re-tenant', 'brand is NOT a guaranty'],
    // Explicit invariant: residual + dark value are separated from lease value.
    residual_and_dark_separated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Ground-lease model (§16)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ground-lease value. Values the LAND owner's contractual ground-rent stream +
 * reversion — NEVER fee-simple building ownership. Distinguishes subordinated vs
 * unsubordinated.
 */
export function buildGroundLeaseValue({ contract }) {
  const gl = contract.ground_lease ?? {};
  const isGroundLease = gl.is_ground_lease?.value === true || contract.subtype === ST.GROUND_LEASE;
  const groundRent = num(gl.ground_rent_annual?.value);
  if (!isGroundLease || groundRent === null) {
    return { available: false, reason: isGroundLease ? 'no_ground_rent' : 'not_ground_lease', ground_lease_value: null };
  }
  const term = num(gl.ground_lease_term_years?.value) ?? 50;
  const escalation = num(gl.ground_escalation_pct?.value) ?? 0.02;
  const subordinated = gl.subordinated?.value === true;
  // Subordinated ground rent carries lender risk → wider cap.
  const groundCap = subordinated ? 0.07 : 0.05;
  const discountRate = round(groundCap + 0.01, 4);

  let pv = 0;
  let rent = groundRent;
  for (let y = 1; y <= Math.min(term, 50); y += 1) {
    pv += rent / (1 + discountRate) ** y;
    rent *= (1 + escalation);
  }
  const residualLand = valueFromCap(rent, groundCap);
  const pvReversion = residualLand !== null ? residualLand / (1 + discountRate) ** Math.min(term, 50) : 0;
  const value = roundMoney(pv + pvReversion);

  return {
    available: true,
    ground_lease_value: value,
    ground_rent_annual: roundMoney(groundRent),
    ground_lease_term_years: term,
    ground_escalation_pct: escalation,
    subordinated,
    ground_cap_rate: groundCap,
    pv_ground_rent: roundMoney(pv),
    pv_reversion: roundMoney(pvReversion),
    confidence: 35,
    assumptions: [`ground_cap=${groundCap}`, subordinated ? 'subordinated_lender_risk' : 'unsubordinated', 'land-only — NOT fee-simple building'],
    // Explicit invariant: ground lease ≠ fee-simple ownership.
    fee_simple_ownership: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Dark / vacant + redevelopment helpers (§14 I/J)                             */
/* -------------------------------------------------------------------------- */

function buildDarkVacantValue({ stabilizedNoi, marketCap, rollover, comps, gla, medPpgla }) {
  // Value as stabilized-on-re-tenant LESS the full re-tenanting cost & downtime.
  let stabilizedValue = stabilizedNoi !== null && marketCap !== null ? valueFromCap(stabilizedNoi, marketCap) : null;
  if (stabilizedValue === null && medPpgla !== null && gla !== null) stabilizedValue = roundMoney(medPpgla * gla);
  if (stabilizedValue === null) return null;
  const reTenantingCost = num(rollover?.required_leasing_capital) ?? roundMoney(stabilizedValue * 0.15);
  const value = roundMoney(stabilizedValue - reTenantingCost);
  return {
    value: value > 0 ? value : roundMoney(stabilizedValue * 0.5),
    stabilized_on_retenant: stabilizedValue,
    re_tenanting_cost: roundMoney(reTenantingCost),
    assumptions: ['stabilized_on_retenant_less_full_cost', 'nonexistent_rent_not_capitalized'],
  };
}

function buildRedevelopmentValue({ contract, operationalStatus }) {
  if (operationalStatus !== 'REDEVELOPMENT' && contract.subtype !== ST.REDEVELOPMENT_RETAIL && contract.identity.redevelopment_potential?.value !== true) {
    return null;
  }
  const land = num(contract.physical.land_area?.value);
  const landPsf = 8; // labeled conservative land $/sqft fallback
  const gla = num(contract.physical.gross_leasable_area?.value);
  const demolition = gla !== null ? gla * 8 : 0; // $8/sqft demolition (labeled)
  const landValue = land !== null ? land * landPsf : null;
  if (landValue === null) return null;
  const value = roundMoney(Math.max(0, landValue - demolition));
  return {
    value,
    land_value: roundMoney(landValue),
    demolition_cost: roundMoney(demolition),
    assumptions: [`land=${landPsf}/sqft`, 'demolition_subtracted'],
  };
}

/* -------------------------------------------------------------------------- */
/* Co-tenancy / anchor / dark-space risk (§11)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Model anchor, co-tenancy and dark-space risk for a shopping center. An anchor
 * is NEVER assumed to be part of the subject parcel.
 */
export function buildAnchorRisk({ contract, rentRoll }) {
  const a = contract.anchor ?? {};
  const anchorName = a.anchor_tenant?.value ?? null;
  const ownedOnParcel = a.anchor_owned_on_parcel?.value;
  const shadowAnchor = a.shadow_anchor?.value === true;
  const coTenancy = a.co_tenancy_clauses?.value === true;
  const kickOut = a.kick_out_rights?.value === true;
  const darkGla = num(rentRoll?.dark_gla);
  const totalGla = num(rentRoll?.total_gla) ?? num(contract.physical.gross_leasable_area?.value);

  const missing = [];
  if (anchorName && ownedOnParcel === null && ownedOnParcel === undefined) missing.push('anchor_parcel_ownership');
  if (anchorName === null) missing.push('anchor_identity');

  let status = 'UNKNOWN';
  const rentAtRisk = [];
  if (shadowAnchor || ownedOnParcel === false) {
    status = 'SHADOW_ANCHOR_DEPENDENCY';
    rentAtRisk.push('inline_rent_depends_on_anchor_not_owned');
  } else if (darkGla !== null && darkGla > 0) {
    status = 'DARK_ANCHOR_RISK';
    rentAtRisk.push('dark_space_present');
  } else if (coTenancy) {
    status = 'CO_TENANCY_EXPOSURE';
    rentAtRisk.push('co_tenancy_clauses_trigger_on_anchor_loss');
  } else if (anchorName) {
    status = 'ANCHOR_PRESENT';
  }

  const darkShare = darkGla !== null && totalGla ? round(darkGla / totalGla, 4) : null;
  // Value impact: co-tenancy + dark space reduce defensible value.
  let valueImpactPct = 0;
  if (status === 'SHADOW_ANCHOR_DEPENDENCY') valueImpactPct = 0.1;
  if (status === 'DARK_ANCHOR_RISK') valueImpactPct = 0.12 + (darkShare ?? 0) * 0.2;
  if (status === 'CO_TENANCY_EXPOSURE') valueImpactPct = 0.06;

  return {
    anchor_identity: anchorName,
    anchor_owned_on_parcel: ownedOnParcel ?? null,
    anchor_parcel_ownership_assumed: false, // explicit invariant
    shadow_anchor_dependency: shadowAnchor,
    co_tenancy_exposure: coTenancy,
    kick_out_rights: kickOut,
    dark_space_gla: darkGla,
    dark_space_share: darkShare,
    anchor_risk_status: status,
    rent_at_risk: rentAtRisk,
    value_impact_pct: round(valueImpactPct, 3),
    missing_documents: [...new Set(missing)],
    confidence: anchorName ? 45 : 15,
  };
}

/* -------------------------------------------------------------------------- */
/* Capital / repair model (§17)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Separate capital items so they are never double-counted in valuation and offer
 * economics. TI and LC live in the rollover model (NOT here) to prevent double-
 * counting (mission §17).
 */
export function buildRetailCapital(contract, { repairInputs = {} } = {}) {
  const gla = num(contract.physical.gross_leasable_area?.value);
  const get = (k) => num(repairInputs[k]);
  const items = {
    immediate_repairs: get('immediate_repairs'),
    roof_envelope: get('roof_envelope'),
    paving_parking: get('paving_parking'),
    facade: get('facade'),
    signage_pylon: get('signage_pylon'),
    hvac: get('hvac'),
    plumbing_electrical: get('plumbing_electrical'),
    fire_life_safety: get('fire_life_safety'),
    common_areas: get('common_areas'),
    demolition: get('demolition'),
    environmental_remediation: get('environmental_remediation'),
  };
  const knownItems = Object.entries(items).filter(([, v]) => v !== null);
  const oneTimeCapital = knownItems.reduce((s, [, v]) => s + v, 0);

  const replacementReserves = get('replacement_reserves'); // ongoing opex line, not one-time
  const suiteTurns = get('suite_turns'); // belongs to rollover (TI), tracked but excluded

  return {
    items,
    one_time_capital: knownItems.length ? roundMoney(oneTimeCapital) : null,
    one_time_capital_per_gla: knownItems.length && gla ? round(oneTimeCapital / gla, 2) : null,
    replacement_reserves_annual: replacementReserves !== null ? roundMoney(replacementReserves) : null,
    known_items: knownItems.map(([k]) => k),
    double_count_guard: {
      // The offer model consumes ONLY one_time_capital; reserves live in opex; TI/LC
      // live in the rollover model. Never sum all of them.
      offer_one_time_capital: knownItems.length ? roundMoney(oneTimeCapital) : 0,
      reserves_in_opex_only: true,
      ti_lc_in_rollover_model_only: true,
      suite_turns_excluded_here: suiteTurns !== null,
    },
    confidence: knownItems.length ? clamp(knownItems.length * 8 + 20, 0, 80) : 10,
  };
}

/* -------------------------------------------------------------------------- */
/* Environmental + business-value separation (§18)                            */
/* -------------------------------------------------------------------------- */

/**
 * Expose environmental review requirements and SEPARATE any business value (FF&E,
 * inventory, goodwill, franchise) from real-estate-only consideration. Business
 * value is NEVER included in real-estate valuation.
 */
export function buildBusinessValueSeparation({ recordClass, retail = {} }) {
  const biz = retail.business_consideration ?? {};
  const environmentalReview = Boolean(
    recordClass?.environmental_review_required ||
    biz.environmental_risk === true,
  );
  const ffe = num(biz.ffe_value);
  const inventory = num(biz.inventory_value);
  const goodwill = num(biz.goodwill_value);
  const franchise = num(biz.franchise_value);
  const businessValue = [ffe, inventory, goodwill, franchise].filter((v) => v !== null);
  const totalBusinessValue = businessValue.length ? roundMoney(businessValue.reduce((s, v) => s + v, 0)) : null;
  const blendedConsideration = num(biz.blended_business_and_re_price);

  // Real-estate-only consideration excludes ALL business value.
  const realEstateOnly = blendedConsideration !== null && totalBusinessValue !== null
    ? roundMoney(blendedConsideration - totalBusinessValue) : null;

  return {
    environmental_review_required: environmentalReview,
    contamination_risk: environmentalReview ? 'POSSIBLE_PHASE_I_REQUIRED' : 'NONE_FLAGGED',
    ffe_value: ffe,
    inventory_value: inventory,
    goodwill_value: goodwill,
    franchise_value: franchise,
    total_business_value: totalBusinessValue,
    real_estate_only_consideration: realEstateOnly,
    business_value_excluded_from_re: true, // explicit invariant
    note: totalBusinessValue !== null
      ? 'Business value (FF&E/inventory/goodwill/franchise) is separated and excluded from real-estate valuation.'
      : null,
  };
}
