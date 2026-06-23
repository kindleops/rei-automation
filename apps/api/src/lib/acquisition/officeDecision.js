/**
 * Acquisition Engine V3 — Item 5F: office & medical-office analysis orchestrator.
 *
 * Runs ONLY for the OFFICE_GENERAL / OFFICE_MEDICAL lanes. Produces an additive
 * `office` analysis block (contract, record/tenancy/operational classification,
 * lease normalization, rent roll, revenue/expense/NOI/cap, rollover/TI/LC,
 * distress/obsolescence, medical specialization, owner-user value, comparables,
 * valuation, capital, business-value separation, market context, buyer-exit,
 * strategies, qualification and an explicit, strategy-specific execution-state
 * basis) WITHOUT altering the generic V2/residential flow — so non-office behavior
 * and the V2-disabled path stay byte-identical.
 *
 * General office and medical office remain DISTINCT asset subtypes with distinct
 * risk/operating/tenant/buildout/buyer behavior. Owner-user value is a SEPARATE
 * universe from investor value. All outbound and AUTO execution remain disabled.
 * Pure & deterministic.
 */

import { ASSET_LANES, EXECUTION_STATES as ES, STRATEGY_QUALIFICATION as SQ, num } from './modelConstants.js';
import { valueFromCap } from './incomeUnderwriting.js';
import {
  OFFICE_RECORD_CLASS as RC, OFFICE_READINESS as RD, SPECIAL_REVIEW_RECORD_CLASSES,
  OWNER_USER_RECORD_CLASSES, MEDICAL_SUBTYPES,
} from './officeConstants.js';
import { buildOfficeContract, officeMissingInputs } from './officeContract.js';
import { classifyOfficeRecord, classifyOfficeTenancy, classifyOfficeOperationalStatus } from './officeClassification.js';
import { recognizeLeaseType, classifyTenantCredit, classifyMedicalTenantCredit } from './officeLeaseModel.js';
import {
  buildOfficeRevenue, buildOfficeExpenses, buildOfficeNOI, buildOfficeRollover, buildOfficeCapRate, buildOfficeDistress,
} from './officeUnderwriting.js';
import { buildOfficeComparables, buildOfficeMarketContext } from './officeComps.js';
import {
  buildOfficeValuation, buildMedicalSpecialization, buildOwnerUserValue,
  buildOfficeCapital, buildBusinessValueSeparation,
} from './officeValuation.js';
import { buildOfficeBuyerExit } from './officeBuyerExit.js';
import {
  buildOfficeCashOffer, buildOfficeSellerFinance, buildOfficeCommercialDebt,
  buildOfficeDisposition, buildOwnerUserDisposition, qualifyOfficeStrategies, buildOfficeExecutionBasis,
} from './officeStrategies.js';

export function isOfficeLane(lane) {
  return lane === ASSET_LANES.OFFICE_GENERAL || lane === ASSET_LANES.OFFICE_MEDICAL;
}

export function buildOfficeAnalysis({
  subjectRow = {},
  office = {},
  officeComps = [],
  officeBuyers = [],
  capRateEvidence = [],
  market = {},
  competingVacancy = null,
  pipeline = null,
  repairInputs = {},
} = {}) {
  const contract = buildOfficeContract(subjectRow, office);
  if (!contract.is_office) return null;

  const isMedical = contract.is_medical;

  // ---- Record-class gate (§1, §2): genuine, pricing-eligible office, or special-
  // review / business-sale / converted-residential false positive? A binary office
  // flag alone is never sufficient. ----
  const ops = office.operations ?? {};
  const inc = office.income ?? {};
  const expIn = office.expenses ?? {};
  const hasOperatingData = Boolean(
    ops.physical_occupancy != null || ops.economic_occupancy != null ||
    inc.base_rental_income != null || inc.in_place_rent_psf != null ||
    expIn.total_operating_expenses != null || Object.keys(expIn).length > 0,
  );
  const hasLeaseData = Array.isArray(office.leases) && office.leases.length > 0;
  const recordClass = classifyOfficeRecord(
    {
      ...subjectRow,
      ...(office.rentable_building_area != null ? { rentable_building_area: office.rentable_building_area } : {}),
      ...(office.number_of_suites != null ? { number_of_suites: office.number_of_suites } : {}),
      ...(ops.physical_occupancy != null ? { physical_occupancy: ops.physical_occupancy } : {}),
    },
    { hasOperatingData, hasLeaseData },
  );

  // NOT_OFFICE routes away from the office engine entirely.
  if (recordClass.classification === RC.NOT_OFFICE) return null;
  const recordGated = !recordClass.underwriting_eligible;
  const isSpecialReview = SPECIAL_REVIEW_RECORD_CLASSES.includes(recordClass.classification);
  const isOwnerUserRecord = OWNER_USER_RECORD_CLASSES.includes(recordClass.classification);

  // ---- Tenancy + operational status ----
  const tenancy = classifyOfficeTenancy({ contract, rentRoll: contract.rent_roll, row: subjectRow });
  const opStatus = classifyOfficeOperationalStatus({ contract, rentRoll: contract.rent_roll, row: subjectRow });
  contract.identity.tenancy_structure = { value: tenancy.tenancy, basis: 'SYSTEM_INFERRED', confidence: tenancy.confidence, source: 'classifyOfficeTenancy' };
  contract.identity.operational_status = { value: opStatus.operational_status, basis: 'SYSTEM_INFERRED', confidence: opStatus.confidence, source: 'classifyOfficeOperationalStatus' };

  const subtype = contract.subtype;

  // ---- Dominant lease type + largest-tenant credit ----
  const leases = Array.isArray(office.leases) ? office.leases : [];
  const dominantLeaseType = resolveDominantLeaseType(leases, contract.rent_roll);
  const tenantCredit = resolveLargestTenantCredit(contract, isMedical);

  // ---- Comparables (income-independent) ----
  const comparables = buildOfficeComparables(officeComps, { subjectSubtype: subtype });

  // Rough comp-anchored value for the tax basis only (does not feed valuation).
  const rba = num(contract.physical.rentable_building_area?.value);
  const taxBasisValue = roughCompValue(comparables, subtype, rba);

  // ---- Income chain ----
  const revenue = buildOfficeRevenue(contract);
  const expenses = buildOfficeExpenses(contract, {
    egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: taxBasisValue, dominantLeaseType,
  });
  const noi = buildOfficeNOI({ revenue, expenses, contract });
  const rollover = buildOfficeRollover({ contract, revenue });

  const marketContext = buildOfficeMarketContext({ market, competingVacancy, pipeline });

  const capRate = buildOfficeCapRate({
    subtype,
    creditClass: tenantCredit?.credit_class ?? (isMedical ? 'UNKNOWN_MEDICAL' : 'UNKNOWN'),
    observedEvidence: capRateEvidence,
    impliedNoi: noi.current_noi?.noi ?? null,
    impliedValue: taxBasisValue,
    occupancy: revenue.physical_occupancy,
    waleYears: num(contract.rent_roll?.wale_years),
    dominantLeaseType,
    tenantConcentration: num(contract.rent_roll?.tenant_concentration),
    rolloverRiskScore: rollover.rollover_risk_score,
    marketTier: market.tier ?? 'SECONDARY',
    yearBuilt: num(contract.identity.year_built?.value),
    buyerDepth: officeBuyers.length >= 4 ? 'DEEP' : officeBuyers.length === 0 ? 'THIN' : 'MODERATE',
    wfhRisk: marketContext.wfh_risk_flag === true,
    subleaseOverhang: num(contract.operations?.sublease_vacancy?.value) > 0 || num(contract.rent_roll?.sublease_vacancy_rsf) > 0,
  });

  // ---- Distress / obsolescence (§11) ----
  const distress = buildOfficeDistress({ contract, revenue, rollover, marketContext });

  // ---- Ordinary-office support (basis for medical premium + owner-user value) ----
  const ordinaryOfficeSupport = computeOrdinaryOfficeSupport({ noi, capRate, comparables, subtype, rba });

  // ---- Medical specialization (§12) + owner-user value (§16) ----
  const medical = isMedical
    ? buildMedicalSpecialization({ contract, ordinaryOfficeSupport, tenantCredit, rollover })
    : null;
  const ownerUser = buildOwnerUserValue({
    contract, ordinaryOfficeSupport, comparables,
    hasOwnerUserDemand: office.owner_user_demand === true,
  });

  // ---- Valuation, capital, business value, buyer exit ----
  const valuation = buildOfficeValuation({
    contract, noi, revenue, capRate, comparables, rollover,
    operationalStatus: opStatus.operational_status, tenancy: tenancy.tenancy, ownerUser, medical, distress,
  });
  const capital = buildOfficeCapital(contract, { repairInputs });
  const businessValue = buildBusinessValueSeparation({ recordClass, office });
  const buyerExit = buildOfficeBuyerExit({
    valuation, comparables, buyers: officeBuyers, subtype,
    operationalStatus: opStatus.operational_status, isMedical,
  });

  // ---- Strategies ----
  const environmental = num(contract.identity.year_built?.value) !== null && (2026 - num(contract.identity.year_built.value)) > 35;
  const cash = buildOfficeCashOffer({
    buyerExit, capital, rollover, noi, operationalStatus: opStatus.operational_status, environmental,
    demand: buyerExit.buyer_demand_score, confidence: valuation.reconciliation.value_classification === 'QUALIFIED' ? 60 : 30,
  });
  const sellerFinance = buildOfficeSellerFinance({ valuation, noi, rollover, capitalRequired: capital.one_time_capital ?? 0 });
  const commercialDebt = buildOfficeCommercialDebt({ contract, noi });
  const disposition = buildOfficeDisposition({ valuation, buyerExit, cashRecommended: cash.recommended_cash_offer });
  const ownerUserDisposition = isOwnerUserRecord || ownerUser?.available
    ? buildOwnerUserDisposition({ ownerUser, buyerExit })
    : null;
  const strategies = { cash, seller_finance: sellerFinance, commercial_debt: commercialDebt, disposition, owner_user_disposition: ownerUserDisposition };

  // ---- Qualification (class-first). Special-review records are always gated. ----
  // Medical evidence: a medical subject must support medical use (an EARNED premium
  // or strong medical tenant), not merely be labeled medical.
  const medicalEvidenceOk = !isMedical || Boolean(medical?.medical_use_premium_earned) ||
    ['HEALTH_SYSTEM', 'HOSPITAL_AFFILIATE', 'NATIONAL_HEALTHCARE_OPERATOR'].includes(tenantCredit?.credit_class);
  const effectiveRecordGated = recordGated || isSpecialReview;
  const qualification = qualifyOfficeStrategies({
    classification: contract.classification, contract, valuation, noi, revenue, capRate, rollover,
    buyerExit, capital, strategies, recordGated: effectiveRecordGated, medicalEvidenceOk, liveFlagsEnabled: false,
  });

  // ---- Execution state + explicit basis (§22) ----
  const anyProvisional = qualification.ranked.some((r) => r.qualification_status === SQ.PROVISIONAL_SCENARIO);
  const executionState = effectiveRecordGated
    ? ES.DATA_REQUIRED
    : qualification.shadow_mode_ready
      ? ES.SHADOW_MODE_READY
      : anyProvisional ? ES.REVIEW_REQUIRED : ES.DATA_REQUIRED;

  const executionStateBasis = buildOfficeExecutionBasis({
    ranked: qualification.ranked, executionState, liveFlagsEnabled: false,
  });

  // ---- Production-readiness classification (§24) ----
  const productionReadiness = assessOfficeProductionReadiness({
    recordClass, contract, revenue, noi, capRate, comparables, buyerExit, marketContext, hasLeaseData, isMedical, medicalEvidenceOk,
  });

  return {
    lane: contract.lane,
    is_office: true,
    is_medical: isMedical,
    genuine_office: contract.genuine_office,
    subtype,
    building_class: contract.building_class,
    location: contract.location,
    height: contract.height,
    classification: contract.classification,
    record_class: recordClass,
    special_review: isSpecialReview,
    environmental_review_required: environmental,
    pricing_eligible: recordClass.pricing_eligible,
    investment_pricing_eligible: recordClass.investment_pricing_eligible,
    owner_user_pricing_eligible: recordClass.owner_user_pricing_eligible,
    underwriting_eligible: recordClass.underwriting_eligible,
    decision_gate: {
      record_gated: effectiveRecordGated,
      reason: effectiveRecordGated ? (isSpecialReview ? `special_review=${recordClass.classification}` : `record_class=${recordClass.classification}`) : null,
      routed_to_office_engine: true,
      specialized_lane_required: contract.classification?.specialized_lane_required ?? null,
    },
    production_readiness: productionReadiness,
    tenancy,
    operational_status: opStatus,
    dominant_lease_type: dominantLeaseType,
    tenant_credit: tenantCredit,
    contract,
    contract_completeness: contract.completeness,
    missing_inputs: officeMissingInputs(contract),
    rent_roll: contract.rent_roll,
    revenue,
    expenses,
    noi,
    cap_rate: capRate,
    rollover,
    distress,
    medical_specialization: medical,
    owner_user_value: ownerUser,
    ordinary_office_support: ordinaryOfficeSupport,
    business_value_separation: businessValue,
    comparables,
    valuation,
    capital,
    market_context: marketContext,
    buyer_exit: buyerExit,
    strategies,
    strategy_qualification: qualification,
    execution_state: executionState,
    execution_state_basis: executionStateBasis,
    // Explicit, repeated for consumers: no AUTO / outbound here.
    auto_execution_enabled: false,
    outbound_enabled: false,
  };
}

/** Resolve the dominant lease type by RSF from the rent roll, else UNKNOWN. */
function resolveDominantLeaseType(leases, rentRoll) {
  const normalized = Array.isArray(rentRoll?.leases) ? rentRoll.leases : null;
  if (!normalized || !normalized.length) {
    return leases.length ? recognizeLeaseType(leases[0]).lease_type : 'UNKNOWN';
  }
  const byType = new Map();
  for (const l of normalized) {
    if (l.is_coworking_license) continue; // licenses don't define the dominant lease type
    const t = l.lease_type ?? 'UNKNOWN';
    byType.set(t, (byType.get(t) ?? 0) + (l.rentable_square_feet ?? 1));
  }
  let best = 'UNKNOWN';
  let bestW = -1;
  for (const [t, w] of byType) { if (w > bestW) { bestW = w; best = t; } }
  return best;
}

/** Resolve the largest tenant's credit, else UNKNOWN. */
function resolveLargestTenantCredit(contract, isMedical) {
  const normalized = Array.isArray(contract.rent_roll?.leases) ? contract.rent_roll.leases : null;
  if (normalized && normalized.length) {
    const byRsf = [...normalized].sort((a, b) => (b.rentable_square_feet ?? 0) - (a.rentable_square_feet ?? 0));
    const top = byRsf[0];
    return isMedical
      ? classifyMedicalTenantCredit({ tenant_name: top.tenant_name, guaranty: top.guaranty })
      : classifyTenantCredit({ tenant_name: top.tenant_name, guaranty: top.guaranty, industry: top.industry });
  }
  return isMedical ? classifyMedicalTenantCredit({}) : classifyTenantCredit({});
}

function roughCompValue(comparables, subtype, rba) {
  if (rba === null) return null;
  const u = comparables?.universes ?? {};
  const all = Object.values(u).flat();
  const pprsf = all.map((c) => num(c.price_per_rsf)).filter((v) => v !== null && v > 0);
  if (!pprsf.length) return null;
  const s = [...pprsf].sort((x, y) => x - y);
  const med = s[Math.floor((s.length - 1) / 2)];
  return Math.round(med * rba);
}

/**
 * Ordinary-office support: a single value the medical-premium and owner-user models
 * anchor to. Prefers stabilized NOI / market cap, else qualified comp value, else
 * current NOI / market cap. NEVER includes any medical premium or owner-user
 * adjustment (those are derived FROM this).
 */
function computeOrdinaryOfficeSupport({ noi, capRate, comparables, subtype, rba }) {
  const marketCap = capRate?.modeled_market?.cap_rate ?? null;
  const stabilizedNoi = num(noi?.stabilized_noi?.noi);
  const currentNoi = num(noi?.current_noi?.noi);
  if (stabilizedNoi !== null && marketCap !== null) return valueFromCap(stabilizedNoi, marketCap);
  const compVal = roughCompValue(comparables, subtype, rba);
  if (compVal !== null) return compVal;
  if (currentNoi !== null && currentNoi > 0 && marketCap !== null) return valueFromCap(currentNoi, marketCap);
  return null;
}

/**
 * Production-readiness classification (§24). Reports the data-sufficiency ceiling
 * for THIS subject plus the exact blockers. Never labels the model production-
 * pricing calibrated without real qualified data; AUTONOMOUS_READY is never
 * returned while execution flags are disabled.
 */
export function assessOfficeProductionReadiness({ recordClass, contract, revenue, noi, capRate, comparables, buyerExit, marketContext, hasLeaseData, isMedical, medicalEvidenceOk }) {
  const classificationReliable = Boolean(recordClass?.underwriting_eligible);
  const hasRba = num(contract?.physical?.rentable_building_area?.value) !== null;
  const rbaModeledOnly = hasRba && contract.physical.rentable_building_area.basis === 'MARKET_MODELED';
  const hasSuites = num(contract?.physical?.suite_count?.value) !== null;
  const hasOccupancy = revenue?.physical_occupancy !== null && revenue?.physical_occupancy !== undefined;
  const hasRevenue = num(revenue?.current_contractual_base_annual) !== null && revenue?.current_base_basis === 'ACTUAL';
  const hasNoi = Boolean(noi?.income_supported);
  const hasCapEvidence = capRate?.selected?.kind === 'OBSERVED' && capRate.selected.qualified;
  const hasQualifiedSales = (comparables?.qualified_count ?? 0) >= 3;
  const hasBuyerIdentity = (buyerExit?.matched_buyer_count ?? 0) > 0;
  const hasMarketSupply = (marketContext?.supply_risk_status ?? 'UNAVAILABLE') !== 'UNAVAILABLE';
  const medicalSupported = !isMedical || medicalEvidenceOk;

  const blockers = {
    classification_reliability: classificationReliable ? null : `record_class=${recordClass?.classification} (confidence ${recordClass?.confidence})`,
    rentable_area: hasRba ? (rbaModeledOnly ? 'MODELED_FROM_GBA_ONLY' : null) : 'MISSING',
    suites: hasSuites ? null : 'MISSING',
    lease_data: hasLeaseData ? null : 'MISSING',
    occupancy: hasOccupancy ? null : 'MISSING',
    revenue: hasRevenue ? null : 'MISSING',
    noi: hasNoi ? null : 'NOT_INCOME_SUPPORTED',
    cap_rate_evidence: hasCapEvidence ? null : 'NO_OBSERVED_CAP',
    qualified_sales: hasQualifiedSales ? null : 'NONE',
    buyer_identity: hasBuyerIdentity ? null : 'NONE',
    market_supply_data: hasMarketSupply ? null : 'UNAVAILABLE',
    medical_use_evidence: medicalSupported ? null : 'INSUFFICIENT_MEDICAL_EVIDENCE',
  };

  const applicable = [RD.ARCHITECTURE_VALIDATED, RD.DATA_MODEL_READY, RD.DETERMINISTIC_FIXTURE_VALIDATED];
  if (!classificationReliable) applicable.push(RD.LIVE_CLASSIFICATION_PARTIAL);
  if (!hasLeaseData) applicable.push(RD.LIVE_LEASE_DATA_UNAVAILABLE);
  if (!hasQualifiedSales) applicable.push(RD.LIVE_TRANSACTION_DATA_UNAVAILABLE);
  if (!hasNoi) applicable.push(RD.LIVE_OPERATING_DATA_UNAVAILABLE);

  let status;
  if (!classificationReliable) {
    status = RD.LIVE_CLASSIFICATION_PARTIAL;
  } else if (hasNoi && hasCapEvidence && hasQualifiedSales && hasBuyerIdentity && medicalSupported) {
    status = RD.PRODUCTION_SHADOW_READY;
    applicable.push(RD.PRODUCTION_SHADOW_READY);
  } else if (hasQualifiedSales || hasNoi) {
    status = RD.SHADOW_SCENARIO_ONLY;
    applicable.push(RD.SHADOW_SCENARIO_ONLY);
  } else {
    status = RD.PRODUCTION_PRICING_NOT_CALIBRATED;
    applicable.push(RD.PRODUCTION_PRICING_NOT_CALIBRATED);
  }

  return {
    status,
    applicable_states: [...new Set(applicable)],
    autonomous_ready: false,
    blockers,
    active_blockers: Object.entries(blockers).filter(([, v]) => v !== null).map(([k, v]) => `${k}:${v}`),
  };
}
