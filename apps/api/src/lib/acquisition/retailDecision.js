/**
 * Acquisition Engine V3 — Item 5E: retail & strip-center analysis orchestrator.
 *
 * Runs ONLY for the RETAIL_STRIP_CENTER / RETAIL_SINGLE_TENANT lanes. Produces an
 * additive `retail` analysis block (contract, record/tenancy/operational
 * classification, lease normalization, rent roll, revenue/expense/NOI/cap,
 * rollover, single-tenant + ground-lease models, co-tenancy/anchor risk,
 * comparables, valuation, capital, business-value separation, market context,
 * buyer-exit, strategies, qualification and an explicit, strategy-specific
 * execution-state basis) WITHOUT altering the generic V2/residential flow — so
 * non-retail behavior and the V2-disabled path stay byte-identical.
 *
 * All outbound and AUTO execution remain disabled. Pure & deterministic.
 */

import { ASSET_LANES, EXECUTION_STATES as ES, STRATEGY_QUALIFICATION as SQ, num, round } from './modelConstants.js';
import { RETAIL_RECORD_CLASS as RC, RETAIL_READINESS as RD, ENVIRONMENTAL_REVIEW_CLASSES, SPECIALTY_RECORD_CLASSES } from './retailConstants.js';
import { buildRetailContract, retailMissingInputs } from './retailContract.js';
import { classifyRetailRecord, classifyRetailTenancy, classifyRetailOperationalStatus } from './retailClassification.js';
import { recognizeLeaseType, classifyTenantCredit } from './retailLeaseModel.js';
import {
  buildRetailRevenue, buildRetailExpenses, buildRetailNOI, buildRetailRollover, buildRetailCapRate,
} from './retailUnderwriting.js';
import { buildRetailComparables, buildRetailMarketContext } from './retailComps.js';
import {
  buildRetailValuation, buildSingleTenantValue, buildGroundLeaseValue, buildAnchorRisk,
  buildRetailCapital, buildBusinessValueSeparation,
} from './retailValuation.js';
import { buildRetailBuyerExit } from './retailBuyerExit.js';
import {
  buildRetailCashOffer, buildRetailSellerFinance, buildRetailCommercialDebt,
  buildRetailDisposition, qualifyRetailStrategies, buildRetailExecutionBasis,
} from './retailStrategies.js';

export function isRetailLane(lane) {
  return lane === ASSET_LANES.RETAIL_STRIP_CENTER || lane === ASSET_LANES.RETAIL_SINGLE_TENANT;
}

export function buildRetailAnalysis({
  subjectRow = {},
  retail = {},
  retailComps = [],
  retailBuyers = [],
  capRateEvidence = [],
  market = {},
  competingCenters = null,
  pipeline = null,
  repairInputs = {},
} = {}) {
  const contract = buildRetailContract(subjectRow, retail);
  if (!contract.is_retail) return null;

  // ---- Record-class gate (§1, §2): genuine, pricing-eligible retail, or
  // specialty / business-sale / ambiguous false positive? A binary retail flag
  // alone is never sufficient. ----
  const ops = retail.operations ?? {};
  const inc = retail.income ?? {};
  const expIn = retail.expenses ?? {};
  const hasOperatingData = Boolean(
    ops.physical_occupancy != null || ops.economic_occupancy != null ||
    inc.base_rental_income != null || inc.in_place_rent_psf != null ||
    expIn.total_operating_expenses != null || Object.keys(expIn).length > 0,
  );
  const hasLeaseData = Array.isArray(retail.leases) && retail.leases.length > 0;
  const recordClass = classifyRetailRecord(
    {
      ...subjectRow,
      ...(retail.gross_leasable_area != null ? { gross_leasable_area: retail.gross_leasable_area } : {}),
      ...(retail.number_of_suites != null ? { number_of_suites: retail.number_of_suites } : {}),
      ...(ops.physical_occupancy != null ? { physical_occupancy: ops.physical_occupancy } : {}),
    },
    { hasOperatingData, hasLeaseData },
  );

  // NOT_RETAIL routes away from the retail engine entirely.
  if (recordClass.classification === RC.NOT_RETAIL) return null;
  const recordGated = !recordClass.underwriting_eligible;
  const isSpecialty = SPECIALTY_RECORD_CLASSES.includes(recordClass.classification);

  // ---- Tenancy + operational status ----
  const tenancy = classifyRetailTenancy({ contract, rentRoll: contract.rent_roll, row: subjectRow });
  const opStatus = classifyRetailOperationalStatus({ contract, rentRoll: contract.rent_roll, row: subjectRow });
  contract.identity.tenancy_structure = { value: tenancy.tenancy, basis: 'SYSTEM_INFERRED', confidence: tenancy.confidence, source: 'classifyRetailTenancy' };
  contract.identity.operational_status = { value: opStatus.operational_status, basis: 'SYSTEM_INFERRED', confidence: opStatus.confidence, source: 'classifyRetailOperationalStatus' };

  const subtype = contract.subtype;

  // ---- Dominant lease type + anchor tenant credit ----
  const leases = Array.isArray(retail.leases) ? retail.leases : [];
  const dominantLeaseType = resolveDominantLeaseType(leases, contract.rent_roll);
  const anchorTenantCredit = resolveAnchorCredit(leases, contract);

  // ---- Comparables (income-independent) ----
  const comparables = buildRetailComparables(retailComps, { subjectSubtype: subtype });

  // Rough comp-anchored value for the tax basis only (does not feed valuation).
  const gla = num(contract.physical.gross_leasable_area?.value);
  const taxBasisValue = roughCompValue(comparables, subtype, gla);

  // ---- Income chain ----
  const revenue = buildRetailRevenue(contract);
  const expenses = buildRetailExpenses(contract, {
    egrAnnual: revenue.effective_gross_revenue_annual, subjectValue: taxBasisValue, dominantLeaseType,
  });
  const noi = buildRetailNOI({ revenue, expenses, contract });
  const rollover = buildRetailRollover({ contract, revenue });

  const capRate = buildRetailCapRate({
    subtype,
    creditClass: anchorTenantCredit?.credit_class ?? 'UNKNOWN',
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
    buyerDepth: retailBuyers.length >= 4 ? 'DEEP' : retailBuyers.length === 0 ? 'THIN' : 'MODERATE',
  });

  // ---- Single-tenant + ground-lease + anchor models ----
  const firstLease = leases.length ? (contract.rent_roll?.leases?.[0] ?? null) : null;
  const singleTenant = buildSingleTenantValue({ contract, noi, capRate, tenantCredit: anchorTenantCredit, leaseTerms: firstLease });
  const groundLease = buildGroundLeaseValue({ contract });
  const anchorRisk = buildAnchorRisk({ contract, rentRoll: contract.rent_roll });
  const businessValue = buildBusinessValueSeparation({ recordClass, retail });

  // ---- Valuation, capital, market, buyer exit ----
  const valuation = buildRetailValuation({
    contract, noi, revenue, capRate, comparables, rollover,
    operationalStatus: opStatus.operational_status, tenancy: tenancy.tenancy, singleTenant, groundLease,
  });
  const capital = buildRetailCapital(contract, { repairInputs });
  const marketContext = buildRetailMarketContext({ market, competingCenters, pipeline });
  const buyerExit = buildRetailBuyerExit({
    valuation, comparables, buyers: retailBuyers, subtype, operationalStatus: opStatus.operational_status,
  });

  // ---- Strategies ----
  const environmental = recordClass.environmental_review_required || ENVIRONMENTAL_REVIEW_CLASSES.includes(recordClass.classification);
  const cash = buildRetailCashOffer({
    buyerExit, capital, rollover, noi, operationalStatus: opStatus.operational_status, environmental,
    demand: buyerExit.buyer_demand_score, confidence: valuation.reconciliation.value_classification === 'QUALIFIED' ? 60 : 30,
  });
  const sellerFinance = buildRetailSellerFinance({ valuation, noi, rollover, capitalRequired: capital.one_time_capital ?? 0 });
  const commercialDebt = buildRetailCommercialDebt({ contract, noi });
  const disposition = buildRetailDisposition({ valuation, buyerExit, cashRecommended: cash.recommended_cash_offer });
  const strategies = { cash, seller_finance: sellerFinance, commercial_debt: commercialDebt, disposition };

  // ---- Qualification (class-first). Specialty records are always gated. ----
  const effectiveRecordGated = recordGated || isSpecialty;
  const qualification = qualifyRetailStrategies({
    classification: contract.classification, contract, valuation, noi, revenue, capRate, rollover,
    buyerExit, capital, strategies, recordGated: effectiveRecordGated, liveFlagsEnabled: false,
  });

  // ---- Execution state + explicit basis (§22) ----
  const anyProvisional = qualification.ranked.some((r) => r.qualification_status === SQ.PROVISIONAL_SCENARIO);
  const executionState = effectiveRecordGated
    ? ES.DATA_REQUIRED
    : qualification.shadow_mode_ready
      ? ES.SHADOW_MODE_READY
      : anyProvisional ? ES.REVIEW_REQUIRED : ES.DATA_REQUIRED;

  const executionStateBasis = buildRetailExecutionBasis({
    ranked: qualification.ranked, executionState, liveFlagsEnabled: false,
  });

  // ---- Production-readiness classification (§24) ----
  const productionReadiness = assessRetailProductionReadiness({
    recordClass, contract, revenue, noi, capRate, comparables, buyerExit, marketContext, hasLeaseData,
  });

  return {
    lane: contract.lane,
    is_retail: true,
    genuine_retail: contract.genuine_retail,
    subtype,
    classification: contract.classification,
    record_class: recordClass,
    specialty: isSpecialty,
    environmental_review_required: environmental,
    pricing_eligible: recordClass.pricing_eligible,
    underwriting_eligible: recordClass.underwriting_eligible,
    decision_gate: {
      record_gated: effectiveRecordGated,
      reason: effectiveRecordGated ? (isSpecialty ? `specialty_record=${recordClass.classification}` : `record_class=${recordClass.classification}`) : null,
      routed_to_retail_engine: true,
      specialized_lane_required: contract.classification?.specialized_lane_required ?? null,
    },
    production_readiness: productionReadiness,
    tenancy,
    operational_status: opStatus,
    dominant_lease_type: dominantLeaseType,
    anchor_tenant_credit: anchorTenantCredit,
    contract,
    contract_completeness: contract.completeness,
    missing_inputs: retailMissingInputs(contract),
    rent_roll: contract.rent_roll,
    revenue,
    expenses,
    noi,
    cap_rate: capRate,
    rollover,
    single_tenant: singleTenant,
    ground_lease: groundLease,
    anchor_risk: anchorRisk,
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

/** Resolve the dominant lease type by GLA from the rent roll, else UNKNOWN. */
function resolveDominantLeaseType(leases, rentRoll) {
  const normalized = Array.isArray(rentRoll?.leases) ? rentRoll.leases : null;
  if (!normalized || !normalized.length) {
    return leases.length ? recognizeLeaseType(leases[0]).lease_type : 'UNKNOWN';
  }
  const byType = new Map();
  for (const l of normalized) {
    const t = l.lease_type ?? 'UNKNOWN';
    byType.set(t, (byType.get(t) ?? 0) + (l.leased_square_feet ?? 1));
  }
  let best = 'UNKNOWN';
  let bestW = -1;
  for (const [t, w] of byType) { if (w > bestW) { bestW = w; best = t; } }
  return best;
}

/** Resolve the anchor (largest) tenant's credit, else UNKNOWN. */
function resolveAnchorCredit(leases, contract) {
  const anchorName = contract.anchor?.anchor_tenant?.value;
  if (anchorName) return classifyTenantCredit({ tenant_name: anchorName, shadow_anchor: contract.anchor?.shadow_anchor?.value === true });
  const normalized = Array.isArray(contract.rent_roll?.leases) ? contract.rent_roll.leases : null;
  if (normalized && normalized.length) {
    const byGla = [...normalized].sort((a, b) => (b.leased_square_feet ?? 0) - (a.leased_square_feet ?? 0));
    const top = byGla[0];
    return classifyTenantCredit({ tenant_name: top.tenant_name, guaranty: top.guaranty });
  }
  return classifyTenantCredit({});
}

function roughCompValue(comparables, subtype, gla) {
  if (gla === null) return null;
  const u = comparables?.universes ?? {};
  const all = Object.values(u).flat();
  const ppgla = all.map((c) => num(c.price_per_gla)).filter((v) => v !== null && v > 0);
  if (!ppgla.length) return null;
  const s = [...ppgla].sort((x, y) => x - y);
  const med = s[Math.floor((s.length - 1) / 2)];
  return roundMoneySafe(med * gla);
}
function roundMoneySafe(v) { return v === null || v === undefined ? null : Math.round(v); }

/**
 * Production-readiness classification (§24). Reports the data-sufficiency ceiling
 * for THIS subject plus the exact blockers. Never labels the model production-
 * pricing calibrated without real qualified data; AUTONOMOUS_READY is never
 * returned while execution flags are disabled.
 */
export function assessRetailProductionReadiness({ recordClass, contract, revenue, noi, capRate, comparables, buyerExit, marketContext, hasLeaseData }) {
  const classificationReliable = Boolean(recordClass?.underwriting_eligible);
  const hasGla = num(contract?.physical?.gross_leasable_area?.value) !== null;
  const glaModeledOnly = hasGla && contract.physical.gross_leasable_area.basis === 'MARKET_MODELED';
  const hasSuites = num(contract?.physical?.number_of_suites?.value) !== null;
  const hasOccupancy = revenue?.physical_occupancy !== null && revenue?.physical_occupancy !== undefined;
  const hasRevenue = num(revenue?.current_contractual_base_annual) !== null && revenue?.current_base_basis === 'ACTUAL';
  const hasNoi = Boolean(noi?.income_supported);
  const hasCapEvidence = capRate?.selected?.kind === 'OBSERVED' && capRate.selected.qualified;
  const hasQualifiedSales = (comparables?.qualified_count ?? 0) >= 3;
  const hasBuyerIdentity = (buyerExit?.matched_buyer_count ?? 0) > 0;
  const hasMarketSupply = (marketContext?.supply_risk_status ?? 'UNAVAILABLE') !== 'UNAVAILABLE';

  const blockers = {
    classification_reliability: classificationReliable ? null : `record_class=${recordClass?.classification} (confidence ${recordClass?.confidence})`,
    gla: hasGla ? (glaModeledOnly ? 'MODELED_FROM_GBA_ONLY' : null) : 'MISSING',
    suites: hasSuites ? null : 'MISSING',
    lease_data: hasLeaseData ? null : 'MISSING',
    occupancy: hasOccupancy ? null : 'MISSING',
    revenue: hasRevenue ? null : 'MISSING',
    noi: hasNoi ? null : 'NOT_INCOME_SUPPORTED',
    cap_rate_evidence: hasCapEvidence ? null : 'NO_OBSERVED_CAP',
    qualified_sales: hasQualifiedSales ? null : 'NONE',
    buyer_identity: hasBuyerIdentity ? null : 'NONE',
    market_supply_data: hasMarketSupply ? null : 'UNAVAILABLE',
  };

  const applicable = [RD.ARCHITECTURE_VALIDATED, RD.DATA_MODEL_READY, RD.DETERMINISTIC_FIXTURE_VALIDATED];
  if (!classificationReliable) applicable.push(RD.LIVE_CLASSIFICATION_PARTIAL);
  if (!hasLeaseData) applicable.push(RD.LIVE_LEASE_DATA_UNAVAILABLE);
  if (!hasQualifiedSales) applicable.push(RD.LIVE_TRANSACTION_DATA_UNAVAILABLE);
  if (!hasNoi) applicable.push(RD.LIVE_OPERATING_DATA_UNAVAILABLE);

  let status;
  if (!classificationReliable) {
    status = RD.LIVE_CLASSIFICATION_PARTIAL;
  } else if (hasNoi && hasCapEvidence && hasQualifiedSales && hasBuyerIdentity) {
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
