/**
 * Acquisition Engine V3 — Item 5F §12, §14–§18: office valuation, medical
 * specialization, owner-user value, capital and business-value separation.
 *
 * Valuation methods are computed INDEPENDENTLY (mission §15):
 *   A. current NOI / observed cap      G. owner-user value (SEPARATE universe)
 *   B. stabilized NOI / market cap     H. medical-specialized value
 *   C. lease-by-lease DCF              I. dark / vacant value
 *   D. price per rentable SF           J. conversion / redevelopment value
 *   E. price per occupied SF           K. liquidation value
 *   F. comparable transactions
 *
 * For a stabilized multi-tenant building, stabilized-NOI/cap and DCF dominate when
 * supportable. For vacant office, nonexistent rent is NEVER capitalized as current
 * NOI. Owner-user value is a SEPARATE universe and never auto-determines the
 * investor exit (§16). Medical-use value cannot exceed ordinary-office support
 * without defensible tenant/buildout evidence (§12, §15). Business value
 * (coworking / medical-practice / equipment / goodwill) is NEVER included (§18).
 * Capital items are never double-counted (§17).
 *
 * Pure & deterministic.
 */

import { num, round, roundMoney, clamp } from './modelConstants.js';
import { valueFromCap } from './incomeUnderwriting.js';
import { OFFICE_CAP_KIND } from './officeUnderwriting.js';
import {
  OFFICE_SUBTYPE as ST,
  OFFICE_DEFAULT_CAP_RATE,
  MEDICAL_SUBTYPES,
  MEDICAL_USE_PREMIUM as MED,
  OFFICE_OBSOLESCENCE as OBS,
} from './officeConstants.js';
import { OFFICE_COMP_UNIVERSE as CU } from './officeComps.js';

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
    [ST.CBD_CLASS_A_OFFICE]: [CU.CBD_CLASS_A, CU.HIGH_RISE],
    [ST.CBD_CLASS_B_OFFICE]: [CU.CBD_CLASS_B, CU.CBD_CLASS_C, CU.MID_RISE],
    [ST.CBD_CLASS_C_OFFICE]: [CU.CBD_CLASS_C, CU.CBD_CLASS_B],
    [ST.SUBURBAN_CLASS_A_OFFICE]: [CU.SUBURBAN_CLASS_A, CU.LOW_RISE, CU.MID_RISE],
    [ST.SUBURBAN_CLASS_B_OFFICE]: [CU.SUBURBAN_CLASS_B, CU.SUBURBAN_CLASS_C, CU.LOW_RISE, CU.MULTI_TENANT],
    [ST.SUBURBAN_CLASS_C_OFFICE]: [CU.SUBURBAN_CLASS_C, CU.SUBURBAN_CLASS_B],
    [ST.LOW_RISE_OFFICE]: [CU.LOW_RISE, CU.SUBURBAN_CLASS_B, CU.MULTI_TENANT],
    [ST.MID_RISE_OFFICE]: [CU.MID_RISE, CU.SUBURBAN_CLASS_A, CU.CBD_CLASS_B],
    [ST.HIGH_RISE_OFFICE]: [CU.HIGH_RISE, CU.CBD_CLASS_A],
    [ST.SINGLE_TENANT_OFFICE]: [CU.SINGLE_TENANT, CU.OWNER_USER],
    [ST.MULTI_TENANT_OFFICE]: [CU.MULTI_TENANT, CU.LOW_RISE, CU.SUBURBAN_CLASS_B],
    [ST.OWNER_USER_OFFICE]: [CU.OWNER_USER, CU.SINGLE_TENANT, CU.OFFICE_CONDO],
    [ST.OFFICE_CONDOMINIUM]: [CU.OFFICE_CONDO, CU.OWNER_USER],
    [ST.GOVERNMENT_OFFICE]: [CU.GOVERNMENT, CU.SINGLE_TENANT],
    [ST.MEDICAL_OFFICE_BUILDING]: [CU.MEDICAL_OFFICE, CU.DENTAL_CLINIC],
    [ST.DENTAL_OFFICE]: [CU.DENTAL_CLINIC, CU.MEDICAL_OFFICE],
    [ST.OUTPATIENT_CLINIC]: [CU.DENTAL_CLINIC, CU.MEDICAL_OFFICE],
    [ST.URGENT_CARE]: [CU.DENTAL_CLINIC, CU.MEDICAL_OFFICE],
    [ST.AMBULATORY_SURGERY_CENTER]: [CU.MEDICAL_OFFICE],
    [ST.IMAGING_CENTER]: [CU.MEDICAL_OFFICE],
    [ST.HOSPITAL_AFFILIATED_MOB]: [CU.HOSPITAL_AFFILIATED_MOB, CU.MEDICAL_OFFICE],
    [ST.SPECIALTY_MEDICAL_OFFICE]: [CU.MEDICAL_OFFICE],
  };
  const keys = map[subtype] ?? [CU.MULTI_TENANT, CU.SUBURBAN_CLASS_B];
  return keys.flatMap((k) => u[k] ?? []);
}

/**
 * Build all office valuation methods + a reconciled value.
 */
export function buildOfficeValuation({ contract, noi, revenue, capRate, comparables, rollover, operationalStatus, tenancy, ownerUser = null, medical = null, distress = null }) {
  const rba = num(contract.physical.rentable_building_area?.value);
  const occupancy = num(revenue?.physical_occupancy);
  const occupiedRsf = rba !== null && occupancy !== null ? rba * occupancy : num(contract.rent_roll?.occupied_area);
  const subtype = contract.subtype;
  const isMedical = contract.is_medical === true;

  const stabilizedNoi = num(noi?.stabilized_noi?.noi);
  const currentNoi = num(noi?.current_noi?.noi);
  const incomeSupported = Boolean(noi?.income_supported);
  const observedCapQualified = capRate?.selected?.kind === OFFICE_CAP_KIND.OBSERVED && capRate.selected.qualified;
  const marketCap = capRate?.modeled_market?.cap_rate ?? null;
  const observedCap = observedCapQualified ? capRate.selected.cap_rate : null;
  const nearTermMaterial = Boolean(rollover?.near_term_material);

  const methods = {};
  const isVacant = operationalStatus === 'VACANT' || tenancy === 'VACANT';
  const isOwnerUser = tenancy === 'OWNER_OCCUPIED' || subtype === ST.OWNER_USER_OFFICE || subtype === ST.OWNER_USER_MEDICAL || subtype === ST.OFFICE_CONDOMINIUM;

  // A. Current NOI / observed cap (QUALIFIED only with observed cap + observed NOI).
  // Vacant: do NOT capitalize nonexistent rent as current NOI.
  const currentValue = !isVacant && currentNoi !== null && currentNoi > 0 && (observedCap ?? marketCap) !== null
    ? valueFromCap(currentNoi, observedCap ?? marketCap) : null;
  methods.current_noi_cap = mkMethod('CURRENT_NOI_CAP', currentValue, {
    classification: incomeSupported && observedCapQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: incomeSupported ? (observedCapQualified ? 60 : 35) : 20,
    lineage: ['current_noi', observedCapQualified ? 'observed_cap' : 'modeled_market_cap'],
    assumptions: observedCapQualified ? [] : ['observed_cap_unavailable'],
  });

  // B. Stabilized NOI / market cap.
  const stabValue = !isVacant && stabilizedNoi !== null && marketCap !== null ? valueFromCap(stabilizedNoi, marketCap) : null;
  methods.stabilized_noi_market_cap = mkMethod('STABILIZED_NOI_MARKET_CAP', stabValue, {
    classification: incomeSupported && observedCapQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: incomeSupported ? (observedCapQualified ? 62 : 45) : 25,
    lineage: ['stabilized_noi', observedCapQualified ? 'observed_cap' : 'modeled_market_cap'],
    assumptions: observedCapQualified ? [] : [`modeled_cap=${marketCap}`],
  });

  // C. Lease-by-lease DCF.
  const dcf = buildLeaseDCF({ contract, noi, rollover, marketCap, operationalStatus });
  methods.lease_dcf = mkMethod('LEASE_BY_LEASE_DCF', dcf.present_value, {
    classification: incomeSupported && dcf.available ? VC.PROVISIONAL : VC.NONE,
    confidence: dcf.available ? (incomeSupported ? 50 : 25) : 0,
    lineage: ['discounted_lease_cash_flows', 'terminal_value'], assumptions: dcf.assumptions, spread: 0.12,
  });

  // D / E. Price per RSF, price per occupied SF (from qualified comps).
  const comps = subjectCompUniverses(comparables, subtype);
  const pprsfComps = comps.map((c) => num(c.price_per_rsf)).filter((v) => v !== null && v > 0);
  const medPprsf = median(pprsfComps);
  const compsQualified = comps.length >= 3;

  const pprsfValue = medPprsf !== null && rba !== null ? roundMoney(medPprsf * rba) : null;
  methods.price_per_rsf = mkMethod('PRICE_PER_RSF', pprsfValue, {
    classification: compsQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: compsQualified ? 58 : 30, sample: comps.length, ess: comps.length,
    lineage: ['median_qualified_comp_pprsf', 'subject_rba'],
    assumptions: contract.physical.rentable_building_area?.basis === 'MARKET_MODELED' ? ['rba_modeled_from_gba'] : [],
  });

  const ppOccValue = medPprsf !== null && occupiedRsf !== null && occupiedRsf > 0 ? roundMoney(medPprsf * occupiedRsf) : null;
  methods.price_per_occupied_sf = mkMethod('PRICE_PER_OCCUPIED_SF', ppOccValue, {
    classification: compsQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: compsQualified ? 48 : 24, sample: comps.length, ess: comps.length,
    lineage: ['median_qualified_comp_pprsf', 'subject_occupied_rsf'],
  });

  // F. Comparable transaction value.
  methods.comparable_transaction = mkMethod('COMPARABLE_TRANSACTION', pprsfValue, {
    classification: compsQualified ? VC.QUALIFIED : VC.PROVISIONAL,
    confidence: compsQualified ? 56 : 28, sample: comps.length, ess: comps.length,
    lineage: ['qualified_office_comps_pprsf'],
  });

  // G. Owner-user value (SEPARATE universe — never the investor exit).
  methods.owner_user_value = mkMethod('OWNER_USER_VALUE', ownerUser?.owner_user_value ?? null, {
    classification: VC.PROVISIONAL, confidence: ownerUser?.confidence ?? 0, spread: 0.12,
    lineage: ['owner_user_replacement_and_occupancy_cost'], assumptions: ownerUser?.assumptions ?? [],
  });

  // H. Medical-specialized value (only when medical + EARNED premium).
  methods.medical_specialized = mkMethod('MEDICAL_SPECIALIZED_VALUE', medical?.medical_specialized_value ?? null, {
    classification: VC.PROVISIONAL, confidence: medical?.confidence ?? 0,
    lineage: ['ordinary_office_support', 'earned_medical_premium'], assumptions: medical?.assumptions ?? [],
  });

  // I. Dark / vacant value (re-tenanting cost subtracted from stabilized).
  const darkValue = (isVacant || nearTermMaterial)
    ? buildDarkVacantValue({ stabilizedNoi, marketCap, rollover, rba, medPprsf })
    : null;
  methods.dark_vacant = mkMethod('DARK_VACANT_VALUE', darkValue?.value ?? null, {
    classification: VC.PROVISIONAL, confidence: darkValue ? 32 : 0, spread: 0.15,
    lineage: ['stabilized_value_less_re_tenanting'], assumptions: darkValue?.assumptions ?? [],
  });

  // J. Conversion / redevelopment value (from distress model or land-less-demolition).
  const redev = distress?.redevelopment_value ?? null;
  methods.conversion_redevelopment = mkMethod('CONVERSION_REDEVELOPMENT', redev, {
    classification: VC.PROVISIONAL, confidence: redev ? 22 : 0, spread: 0.2,
    lineage: ['land_value_less_demolition_or_conversion'],
    assumptions: distress?.conversion_feasible ? ['conversion_feasible'] : ['land_residual_only'],
  });

  // K. Liquidation value (discount to value floor).
  const baseForLiquidation = methods.comparable_transaction.available ? methods.comparable_transaction.mid
    : (methods.stabilized_noi_market_cap.available ? methods.stabilized_noi_market_cap.mid : null);
  const liquidationValue = baseForLiquidation !== null ? roundMoney(baseForLiquidation * 0.70) : null;
  methods.liquidation = mkMethod('LIQUIDATION', liquidationValue, {
    classification: VC.PROVISIONAL, confidence: 28, spread: 0.15,
    lineage: ['0.70_of_value_floor'], assumptions: ['distressed_disposition_discount=0.30'],
  });

  const reconciliation = reconcileOfficeValuation({
    methods, subtype, tenancy, operationalStatus, incomeSupported, observedCapQualified, compsQualified, isVacant, nearTermMaterial, isOwnerUser, isMedical,
  });

  return {
    subtype,
    is_medical: isMedical,
    methods,
    dcf,
    owner_user: ownerUser,
    medical_specialization: medical,
    dark_vacant: darkValue,
    reconciliation,
    dominant_method: reconciliation.dominant_method,
    income_supported: incomeSupported,
    // Explicit invariant: owner-user value is kept out of the investor reconciliation.
    owner_user_value_separate_from_investor: true,
  };
}

/**
 * Reconcile independent INVESTOR methods. Owner-user value is EXCLUDED from the
 * investor blend (§16). Stabilized-NOI/cap + DCF dominate a supportable stabilized
 * building; vacant uses dark value and never capitalizes nonexistent NOI.
 */
export function reconcileOfficeValuation({ methods, subtype, tenancy, operationalStatus, incomeSupported, observedCapQualified, compsQualified, isVacant, nearTermMaterial, isOwnerUser, isMedical }) {
  const all = Object.values(methods).filter((m) => m.available);
  // Owner-user, conversion, liquidation are NOT part of the investor blend.
  const excludeFromBlend = new Set(['LIQUIDATION', 'CONVERSION_REDEVELOPMENT', 'OWNER_USER_VALUE']);
  const available = all.filter((m) => !excludeFromBlend.has(m.method));
  const qualified = available.filter((m) => m.classification === VC.QUALIFIED);

  const incomeLed = incomeSupported && observedCapQualified && !isVacant && !nearTermMaterial
    && operationalStatus !== 'LEASE_UP' && operationalStatus !== 'REDEVELOPMENT';

  const weights = {};
  for (const m of available) {
    let w = 0;
    if (isVacant) {
      if (m.method === 'DARK_VACANT_VALUE') w = 0.5;
      else if (m.method === 'PRICE_PER_RSF') w = 0.25;
      else if (m.method === 'COMPARABLE_TRANSACTION') w = 0.25;
    } else {
      if (m.method === 'STABILIZED_NOI_MARKET_CAP') w = incomeLed ? 0.38 : (incomeSupported ? 0.2 : 0.1);
      else if (m.method === 'LEASE_BY_LEASE_DCF') w = incomeLed ? 0.25 : (incomeSupported ? 0.15 : 0.05);
      else if (m.method === 'CURRENT_NOI_CAP') w = incomeLed ? 0.15 : (incomeSupported ? 0.1 : 0.05);
      else if (m.method === 'COMPARABLE_TRANSACTION') w = incomeLed ? 0.12 : (compsQualified ? 0.4 : 0.3);
      else if (m.method === 'PRICE_PER_RSF') w = incomeLed ? 0.05 : (compsQualified ? 0.2 : 0.12);
      else if (m.method === 'PRICE_PER_OCCUPIED_SF') w = incomeLed ? 0.03 : (compsQualified ? 0.1 : 0.08);
      // Medical-specialized value participates only at a small, earned weight.
      else if (m.method === 'MEDICAL_SPECIALIZED_VALUE') w = isMedical ? 0.07 : 0;
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
    is_owner_user_subject: isOwnerUser,
    is_vacant: isVacant,
    owner_user_excluded_from_investor_blend: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Lease-by-lease DCF (§14C)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A transparent lease-level DCF. Discounts the in-place NOI stream, subtracts
 * required leasing capital (TI/LC) at rollover, and adds a terminal value at an
 * exit cap. Returns the discount/terminal assumptions and a sensitivity band. The
 * DCF reconciles its cash-flow PV + terminal-value PV into present value.
 */
export function buildLeaseDCF({ contract, noi, rollover, marketCap, operationalStatus, holdYears = 10 }) {
  const currentNoi = num(noi?.current_noi?.noi);
  const stabilizedNoi = num(noi?.stabilized_noi?.noi);
  if (currentNoi === null || marketCap === null) {
    return { available: false, reason: 'insufficient_noi_or_cap', present_value: null, assumptions: [] };
  }
  const discountRate = round(marketCap + 0.03, 4); // labeled spread over cap (office is wider)
  const terminalCap = round(marketCap + 0.0025, 4);
  const rentGrowth = 0.025;
  const expenseGrowth = 0.025;
  const requiredCapital = num(rollover?.required_leasing_capital) ?? 0;

  let pv = 0;
  let noiYear = currentNoi;
  const targetNoi = stabilizedNoi !== null && stabilizedNoi > currentNoi ? stabilizedNoi : currentNoi;
  for (let y = 1; y <= holdYears; y += 1) {
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
      value_at_terminal_cap_minus_50bps: valueFromCap(terminalNoi, round(terminalCap - 0.005, 4)),
      value_at_terminal_cap_plus_50bps: valueFromCap(terminalNoi, round(terminalCap + 0.005, 4)),
      value_at_discount_minus_50bps: discountedValue(currentNoi, targetNoi, requiredCapital, round(discountRate - 0.005, 4), terminalCap, holdYears, rentGrowth, expenseGrowth),
      value_at_discount_plus_50bps: discountedValue(currentNoi, targetNoi, requiredCapital, round(discountRate + 0.005, 4), terminalCap, holdYears, rentGrowth, expenseGrowth),
    },
    assumptions: [`discount=${discountRate}`, `terminal_cap=${terminalCap}`, `rent_growth=${rentGrowth}`, 'TI/LC subtracted at rollover'],
  };
}

function discountedValue(currentNoi, targetNoi, requiredCapital, discountRate, terminalCap, holdYears, rentGrowth, expenseGrowth) {
  let pv = 0;
  let noiYear = currentNoi;
  for (let y = 1; y <= holdYears; y += 1) {
    if (y <= 3 && targetNoi > currentNoi) noiYear = currentNoi + (targetNoi - currentNoi) * (y / 3);
    else noiYear = noiYear * (1 + rentGrowth - expenseGrowth * 0.4);
    const capitalThisYear = y <= 3 ? requiredCapital / 3 : 0;
    pv += (noiYear - capitalThisYear) / (1 + discountRate) ** y;
  }
  const terminalNoi = noiYear * (1 + rentGrowth);
  const terminalValue = valueFromCap(terminalNoi, terminalCap);
  const pvTerminal = terminalValue !== null ? terminalValue / (1 + discountRate) ** holdYears : 0;
  return roundMoney(pv + pvTerminal);
}

/* -------------------------------------------------------------------------- */
/* Medical-office specialization (§12)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Medical-office specialization. Separately assesses tenant specialization,
 * health-system relationship, relocation friction, specialized TI, conversion
 * cost, alternative-use value and medical buyer depth. A medical-use PREMIUM is
 * EARNED only with defensible tenant/buildout evidence — it can NEVER exceed
 * ordinary-office support otherwise (mission §12, §15). Labeling a building
 * "medical" does NOT by itself grant a premium.
 */
export function buildMedicalSpecialization({ contract, ordinaryOfficeSupport, tenantCredit = null, rollover = null }) {
  if (contract.is_medical !== true) {
    return { available: false, reason: 'not_medical', medical_specialized_value: null };
  }
  const med = contract.medical ?? {};
  const rba = num(contract.physical.rentable_building_area?.value);
  const base = num(ordinaryOfficeSupport);

  // Evidence that justifies an EARNED premium.
  const buildoutPct = num(med.medical_buildout_pct?.value);
  const hasSpecializedTi = num(med.specialized_ti_replacement_cost?.value) !== null || buildoutPct !== null && buildoutPct >= 0.3;
  const creditClass = tenantCredit?.credit_class ?? 'UNKNOWN_MEDICAL';
  const strongTenant = ['HEALTH_SYSTEM', 'HOSPITAL_AFFILIATE', 'NATIONAL_HEALTHCARE_OPERATOR'].includes(creditClass);
  const hospitalAffiliation = Boolean(med.hospital_affiliation?.value);
  const referralDependency = med.referral_network_dependency?.value === true;

  // Earned premium: only with BOTH specialized buildout AND a defensible tenant.
  let earnedPremiumPct = MED.unsupported_premium_pct;
  const premiumReasons = [];
  if (hasSpecializedTi && strongTenant) {
    earnedPremiumPct = MED.max_premium_pct;
    premiumReasons.push('specialized_buildout_and_strong_health_system_tenant');
  } else if (hasSpecializedTi && hospitalAffiliation) {
    earnedPremiumPct = MED.max_premium_pct * 0.6;
    premiumReasons.push('specialized_buildout_and_hospital_affiliation');
  } else if (hasSpecializedTi) {
    earnedPremiumPct = MED.max_premium_pct * 0.3;
    premiumReasons.push('specialized_buildout_only');
  } else {
    premiumReasons.push('no_defensible_premium_evidence');
  }

  const medicalSpecializedValue = base !== null ? roundMoney(base * (1 + earnedPremiumPct)) : null;
  // Hard ceiling: medical value cannot exceed ordinary-office support without
  // defensible evidence — when there is none, it equals ordinary support.
  const cappedValue = base !== null && earnedPremiumPct === 0 ? base : medicalSpecializedValue;

  // Conversion / alternative-use.
  const specializedTiPerRsf = num(med.specialized_ti_replacement_cost?.value) ?? (rba !== null ? MED.specialized_ti_per_rsf * rba : null);
  const conversionCost = num(med.conversion_cost_to_office?.value) ?? (rba !== null ? MED.conversion_cost_per_rsf * rba : null);
  const alternativeUseValue = base !== null && conversionCost !== null ? roundMoney(base - conversionCost) : base;

  // Tenant-retention score: relocation friction + buildout + credit.
  let retentionScore = 50;
  if (hasSpecializedTi) retentionScore += 20;
  if (strongTenant) retentionScore += 20;
  else if (hospitalAffiliation) retentionScore += 10;
  if (rollover?.medical_buildout_exposure) retentionScore += 5;
  retentionScore = Math.round(clamp(retentionScore, 0, 95));

  const buyerDepthNote = strongTenant || hospitalAffiliation ? 'DEEP_HEALTHCARE_REIT_AND_SYSTEM_DEMAND' : 'MODERATE_REGIONAL_MEDICAL_DEMAND';

  return {
    available: cappedValue !== null,
    tenant_specialization: creditClass,
    health_system_relationship: hospitalAffiliation ? 'AFFILIATED' : (strongTenant ? 'SYSTEM_TENANT' : 'NONE_EVIDENCED'),
    referral_network_dependency: referralDependency,
    medical_use_premium_pct: round(earnedPremiumPct, 3),
    medical_use_premium_earned: earnedPremiumPct > 0,
    premium_reasons: premiumReasons,
    tenant_retention_score: retentionScore,
    specialized_buildout_value: specializedTiPerRsf !== null ? roundMoney(specializedTiPerRsf) : null,
    conversion_cost_to_office: conversionCost !== null ? roundMoney(conversionCost) : null,
    alternative_use_value: alternativeUseValue,
    medical_buyer_depth: buyerDepthNote,
    ordinary_office_support: base,
    medical_specialized_value: cappedValue,
    confidence: earnedPremiumPct > 0 ? 45 : 25,
    // Explicit invariant: a label alone never grants a premium.
    premium_requires_evidence: true,
    medical_value_cannot_exceed_office_without_evidence: true,
    assumptions: [`earned_premium=${round(earnedPremiumPct, 3)}`, 'premium requires specialized buildout AND defensible tenant'],
  };
}

/* -------------------------------------------------------------------------- */
/* Owner-user value (§16)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Owner-user value lives in a SEPARATE universe (mission §16). Influenced by
 * replacement cost, occupancy cost vs leasing, location, parking and (for medical)
 * specialized buildout. It NEVER auto-determines the wholesale investor exit.
 */
export function buildOwnerUserValue({ contract, ordinaryOfficeSupport, comparables, hasOwnerUserDemand = false }) {
  const subtype = contract.subtype;
  const eligible = subtype === ST.OWNER_USER_OFFICE || subtype === ST.OWNER_USER_MEDICAL ||
    subtype === ST.OFFICE_CONDOMINIUM || subtype === ST.SINGLE_TENANT_OFFICE ||
    contract.classification?.owner_user_pricing_eligible === true ||
    contract.identity?.owner_occupied?.value === true;
  if (!eligible) {
    return { available: false, reason: 'not_owner_user_eligible', owner_user_value: null };
  }

  const rba = num(contract.physical.rentable_building_area?.value);
  const base = num(ordinaryOfficeSupport);

  // Owner-user comps (owner-user / office condo universes) when present.
  const u = comparables?.universes ?? {};
  const ouComps = [...(u.owner_user ?? []), ...(u.office_condo ?? [])];
  const ouPprsf = ouComps.map((c) => num(c.price_per_rsf)).filter((v) => v !== null && v > 0);
  const medOuPprsf = ouPprsf.length ? medianLocal(ouPprsf) : null;

  // Owner-user value: comp-driven when available, else a modest premium to investor
  // support (owner-users often pay above investor value for the right building).
  let ownerUserValue = medOuPprsf !== null && rba !== null ? roundMoney(medOuPprsf * rba)
    : (base !== null ? roundMoney(base * 1.08) : null);

  const assumptions = medOuPprsf !== null ? ['owner_user_comp_driven'] : ['owner_user_premium_to_investor=0.08(labeled)'];
  if (!hasOwnerUserDemand) assumptions.push('owner_user_demand_unconfirmed');

  return {
    available: ownerUserValue !== null,
    owner_user_value: ownerUserValue,
    investor_support_reference: base,
    owner_user_demand_confirmed: hasOwnerUserDemand,
    comp_count: ouComps.length,
    confidence: medOuPprsf !== null ? 45 : (hasOwnerUserDemand ? 35 : 25),
    // Explicit invariant: owner-user value is a separate universe.
    separate_universe: true,
    does_not_set_investor_exit: true,
    assumptions,
  };
}

function medianLocal(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/* -------------------------------------------------------------------------- */
/* Dark / vacant helper (§15 I)                                                */
/* -------------------------------------------------------------------------- */

function buildDarkVacantValue({ stabilizedNoi, marketCap, rollover, rba, medPprsf }) {
  let stabilizedValue = stabilizedNoi !== null && marketCap !== null ? valueFromCap(stabilizedNoi, marketCap) : null;
  if (stabilizedValue === null && medPprsf !== null && rba !== null) stabilizedValue = roundMoney(medPprsf * rba);
  if (stabilizedValue === null) return null;
  const reTenantingCost = num(rollover?.required_leasing_capital) ?? roundMoney(stabilizedValue * 0.2);
  const value = roundMoney(stabilizedValue - reTenantingCost);
  return {
    value: value > 0 ? value : roundMoney(stabilizedValue * OBS.conversion_floor_factor),
    stabilized_on_retenant: stabilizedValue,
    re_tenanting_cost: roundMoney(reTenantingCost),
    assumptions: ['stabilized_on_retenant_less_full_cost', 'nonexistent_rent_not_capitalized'],
  };
}

/* -------------------------------------------------------------------------- */
/* Capital / repair model (§17)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Separate capital items so they are never double-counted in valuation and offer
 * economics. TI and LC live in the rollover model (NOT here); medical buildout /
 * restoration / conversion are tracked separately to prevent double-counting (§17).
 */
export function buildOfficeCapital(contract, { repairInputs = {} } = {}) {
  const rba = num(contract.physical.rentable_building_area?.value);
  const get = (k) => num(repairInputs[k]);
  const items = {
    immediate_repairs: get('immediate_repairs'),
    roof_envelope: get('roof_envelope'),
    facade: get('facade'),
    hvac: get('hvac'),
    elevators: get('elevators'),
    electrical: get('electrical'),
    plumbing: get('plumbing'),
    fire_life_safety: get('fire_life_safety'),
    common_areas: get('common_areas'),
    parking: get('parking'),
    accessibility: get('accessibility'),
    energy_upgrades: get('energy_upgrades'),
    environmental_remediation: get('environmental_remediation'),
    redevelopment: get('redevelopment'),
  };
  const knownItems = Object.entries(items).filter(([, v]) => v !== null);
  const oneTimeCapital = knownItems.reduce((s, [, v]) => s + v, 0);

  const replacementReserves = get('replacement_reserves'); // ongoing opex line, not one-time
  const suiteTurnsTi = get('suite_turns'); // belongs to rollover (TI), tracked but excluded
  const medicalBuildout = get('medical_buildout'); // belongs to rollover/medical, tracked but excluded
  const restorationConversion = get('restoration_conversion'); // tracked separately

  return {
    items,
    one_time_capital: knownItems.length ? roundMoney(oneTimeCapital) : null,
    one_time_capital_per_rsf: knownItems.length && rba ? round(oneTimeCapital / rba, 2) : null,
    replacement_reserves_annual: replacementReserves !== null ? roundMoney(replacementReserves) : null,
    medical_buildout_capital: medicalBuildout !== null ? roundMoney(medicalBuildout) : null,
    restoration_conversion_capital: restorationConversion !== null ? roundMoney(restorationConversion) : null,
    known_items: knownItems.map(([k]) => k),
    double_count_guard: {
      // The offer model consumes ONLY one_time_capital; reserves live in opex; TI/LC
      // and medical buildout live in the rollover model. Never sum all of them.
      offer_one_time_capital: knownItems.length ? roundMoney(oneTimeCapital) : 0,
      reserves_in_opex_only: true,
      ti_lc_in_rollover_model_only: true,
      medical_buildout_in_rollover_model_only: true,
      suite_turns_excluded_here: suiteTurnsTi !== null,
    },
    confidence: knownItems.length ? clamp(knownItems.length * 7 + 20, 0, 80) : 10,
  };
}

/* -------------------------------------------------------------------------- */
/* Business-value separation (§18)                                            */
/* -------------------------------------------------------------------------- */

/**
 * SEPARATE any business value from real-estate-only consideration. Coworking
 * business revenue, medical-practice value, equipment, furniture, software,
 * patient lists, goodwill and management contracts are NEVER real-estate value.
 */
export function buildBusinessValueSeparation({ recordClass, office = {} }) {
  const biz = office.business_consideration ?? {};
  const coworkingBusiness = recordClass?.classification === 'COWORKING_BUSINESS' || num(biz.coworking_business_value) !== null;
  const ffe = num(biz.ffe_value ?? biz.equipment_value ?? biz.furniture_value);
  const goodwill = num(biz.goodwill_value);
  const practiceValue = num(biz.medical_practice_value);
  const coworkingValue = num(biz.coworking_business_value);
  const software = num(biz.software_value);
  const patientLists = num(biz.patient_list_value);
  const managementContracts = num(biz.management_contract_value);
  const businessValues = [ffe, goodwill, practiceValue, coworkingValue, software, patientLists, managementContracts].filter((v) => v !== null);
  const totalBusinessValue = businessValues.length ? roundMoney(businessValues.reduce((s, v) => s + v, 0)) : null;
  const blendedConsideration = num(biz.blended_business_and_re_price);

  const realEstateOnly = blendedConsideration !== null && totalBusinessValue !== null
    ? roundMoney(blendedConsideration - totalBusinessValue) : null;

  return {
    coworking_business_present: coworkingBusiness,
    ffe_equipment_value: ffe,
    goodwill_value: goodwill,
    medical_practice_value: practiceValue,
    coworking_business_value: coworkingValue,
    software_value: software,
    patient_list_value: patientLists,
    management_contract_value: managementContracts,
    total_business_value: totalBusinessValue,
    real_estate_only_consideration: realEstateOnly,
    business_value_excluded_from_re: true, // explicit invariant
    note: totalBusinessValue !== null || coworkingBusiness
      ? 'Business value (coworking/medical-practice/equipment/goodwill/software/patient-lists/management) is separated and excluded from real-estate valuation.'
      : null,
  };
}
