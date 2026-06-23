/**
 * Acquisition Engine V3 — Item 5F §4 & §5: office lease normalization + tenant
 * credit / guaranty classification (general office + medical office).
 *
 * Lease normalization (§4): recognize the office lease structure (full-service-
 * gross / modified-gross / NNN family / owner-occupied / coworking license /
 * ground lease) WITHOUT treating a coworking membership/license as an ordinary
 * long-term office lease; compute rentable vs usable square feet + load factor,
 * base rent, rent/RSF and rent/USF, escalations, free rent, remaining term,
 * options, reimbursements, landlord expense exposure, TI/LC exposure, downtime,
 * effective rent and expiration risk. Medical leases additionally expose
 * specialized-buildout ownership, restoration obligation, equipment ownership,
 * assignment restriction, regulatory/licensing dependency, hospital affiliation
 * and relocation friction. Return the EXACT missing lease inputs.
 *
 * Tenant credit (§5): resolve a tenant into a credit class + guaranty strength
 * WITHOUT equating a brand with a corporate guaranty, hospital proximity with
 * health-system credit, or physician use with long-term stability. No external
 * credit rating is invented.
 *
 * Missing values are UNKNOWN, never zero. Pure & deterministic.
 */

import { num, clean, lower, round, roundMoney } from './modelConstants.js';
import {
  LEASE_TYPE as LT,
  LANDLORD_EXPENSE_EXPOSURE,
  TENANT_CREDIT_CLASS as TC,
  MEDICAL_TENANT_CLASS as MTC,
  GUARANTY_STRENGTH as GS,
  OFFICE_ROLLOVER_ASSUMPTIONS as ROLL,
  DEFAULT_LOAD_FACTOR,
} from './officeConstants.js';

/* -------------------------------------------------------------------------- */
/* Lease type recognition (§4)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Recognize the office lease structure from explicit fields ONLY. A coworking
 * membership/license is recognized as COWORKING_LICENSE — NOT an ordinary lease.
 * NNN is never inferred from a single pass-through; the full reimbursement set or
 * an explicit label is required.
 */
export function recognizeLeaseType(lease = {}) {
  const explicit = lower(lease.lease_type ?? lease.lease_structure);
  const reasons = [];
  if (lease.is_coworking_license === true || /coworking|membership|license agreement|hot ?desk|day pass/.test(explicit)) {
    reasons.push('coworking_license_not_ordinary_lease');
    return { lease_type: LT.COWORKING_LICENSE, confidence: 75, reasons };
  }
  if (explicit) {
    // Order matters: more-specific phrases must be tested before the bare 'gross'
    // alias, so "modified gross" is never mis-recognized as full-service-gross.
    const map = {
      'modified gross': LT.MODIFIED_GROSS, 'mod gross': LT.MODIFIED_GROSS, 'industrial gross': LT.MODIFIED_GROSS, 'base year': LT.MODIFIED_GROSS,
      'full service gross': LT.FULL_SERVICE_GROSS, 'full service': LT.FULL_SERVICE_GROSS, 'full-service': LT.FULL_SERVICE_GROSS, 'fsg': LT.FULL_SERVICE_GROSS,
      'absolute net': LT.ABSOLUTE_NET, 'absolute nnn': LT.ABSOLUTE_NET, 'bondable': LT.ABSOLUTE_NET,
      'triple net': LT.TRIPLE_NET, 'nnn': LT.TRIPLE_NET,
      'double net': LT.DOUBLE_NET, 'nn': LT.DOUBLE_NET,
      'single net': LT.SINGLE_NET,
      'ground lease': LT.GROUND_LEASE, 'ground': LT.GROUND_LEASE,
      'owner occupied': LT.OWNER_OCCUPIED,
      'gross': LT.FULL_SERVICE_GROSS,
    };
    for (const [k, v] of Object.entries(map)) {
      if (explicit.includes(k)) { reasons.push(`explicit_lease_type=${k}`); return { lease_type: v, confidence: 80, reasons }; }
    }
  }

  // Structured reimbursement evidence — requires the FULL set for NNN.
  const taxReimb = reimbursed(lease.tax_reimbursement ?? lease.reimburses_taxes);
  const insReimb = reimbursed(lease.insurance_reimbursement ?? lease.reimburses_insurance);
  const camReimb = reimbursed(lease.cam_reimbursement ?? lease.opex_reimbursement ?? lease.reimburses_cam);
  const structuralTenant = lease.tenant_pays_structure === true || lease.tenant_pays_roof === true;
  const baseYearStop = lease.base_year_stop === true || num(lease.base_year) !== null;

  if (taxReimb && insReimb && camReimb && structuralTenant) { reasons.push('full_net_plus_structure'); return { lease_type: LT.ABSOLUTE_NET, confidence: 65, reasons }; }
  if (taxReimb && insReimb && camReimb) { reasons.push('taxes_insurance_opex_reimbursed'); return { lease_type: LT.TRIPLE_NET, confidence: 60, reasons }; }
  if (taxReimb && insReimb && !camReimb) { reasons.push('taxes_insurance_reimbursed_no_opex'); return { lease_type: LT.DOUBLE_NET, confidence: 55, reasons }; }
  if (taxReimb && !insReimb && !camReimb) { reasons.push('taxes_only_reimbursed'); return { lease_type: LT.SINGLE_NET, confidence: 50, reasons }; }
  if (baseYearStop) {
    // Base-year expense stop is MODIFIED_GROSS — landlord retains base opex (§4 invariant).
    reasons.push('base_year_stop_modified_gross');
    return { lease_type: LT.MODIFIED_GROSS, confidence: 50, reasons };
  }

  reasons.push('insufficient_lease_structure_evidence_default_full_service_gross');
  return { lease_type: LT.UNKNOWN, confidence: 15, reasons };
}

function reimbursed(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const n = num(v);
  if (n !== null) return n > 0;
  return /yes|true|full|pro.?rata/i.test(clean(v));
}

/* -------------------------------------------------------------------------- */
/* Per-lease normalization (§4)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a single office lease. Returns rentable/usable SF + load factor, base
 * rent, rent/RSF, rent/USF, escalations, free rent, remaining term, options,
 * reimbursement structure, landlord exposure, TI/LC exposure, downtime, effective
 * rent, expiration risk and rollover cost — plus the EXACT missing inputs. Medical
 * leases additionally expose specialized-buildout / restoration / regulatory
 * fields. A coworking license is flagged and never treated as durable lease income.
 *
 * @param {object} lease  raw lease record
 * @param {object} [ctx]  { asOfYear, marketRentPerRsf, isMedical, tenancy }
 */
export function normalizeLease(lease = {}, { asOfYear = 2026, marketRentPerRsf = null, isMedical = false, tenancy = 'MULTI_TENANT' } = {}) {
  const missing = [];

  // Rentable vs usable area + load factor (never fabricated).
  const rsf = num(lease.leased_square_feet ?? lease.rentable_square_feet ?? lease.rsf ?? lease.suite_sqft);
  let usf = num(lease.usable_square_feet ?? lease.usf);
  let loadFactor = num(lease.load_factor);
  if (loadFactor === null && rsf !== null && usf !== null && usf > 0) loadFactor = round(rsf / usf, 3);
  if (loadFactor === null) {
    loadFactor = tenancy === 'SINGLE_TENANT' ? DEFAULT_LOAD_FACTOR.SINGLE_TENANT
      : tenancy === 'MULTI_TENANT' ? DEFAULT_LOAD_FACTOR.MULTI_TENANT : DEFAULT_LOAD_FACTOR.UNKNOWN;
    missing.push('load_factor');
  }
  if (usf === null && rsf !== null && loadFactor > 0) usf = roundMoney(rsf / loadFactor);
  if (rsf === null) missing.push('rentable_square_feet');

  const { lease_type, confidence: ltConfidence, reasons: ltReasons } = recognizeLeaseType({ ...lease, is_coworking_license: lease.is_coworking_license });
  const isCoworking = lease_type === LT.COWORKING_LICENSE;
  const landlordExposure = LANDLORD_EXPENSE_EXPOSURE[lease_type] ?? LANDLORD_EXPENSE_EXPOSURE.UNKNOWN;

  // Base rent: explicit annual, else monthly*12, else rent/RSF*RSF.
  let baseAnnual = num(lease.annual_base_rent);
  let rentBasis = 'annual_base_rent';
  if (baseAnnual === null && num(lease.monthly_base_rent) !== null) { baseAnnual = roundMoney(num(lease.monthly_base_rent) * 12); rentBasis = 'monthly_base_rent*12'; }
  if (baseAnnual === null && num(lease.base_rent_per_rsf ?? lease.base_rent_per_sf) !== null && rsf !== null) {
    baseAnnual = roundMoney(num(lease.base_rent_per_rsf ?? lease.base_rent_per_sf) * rsf); rentBasis = 'base_rent_per_rsf*rsf';
  }
  if (baseAnnual === null) { rentBasis = null; missing.push('base_rent'); }

  const rentPerRsf = baseAnnual !== null && rsf ? round(baseAnnual / rsf, 2) : null;
  const rentPerUsf = baseAnnual !== null && usf ? round(baseAnnual / usf, 2) : null;

  // Remaining term.
  const expYear = leaseExpYear(lease);
  let remainingTermYears = num(lease.remaining_term_years);
  if (remainingTermYears === null && num(lease.remaining_term_months) !== null) remainingTermYears = round(num(lease.remaining_term_months) / 12, 2);
  if (remainingTermYears === null && expYear !== null) remainingTermYears = Math.max(0, round(expYear - asOfYear, 2));
  if (remainingTermYears === null && !isCoworking) missing.push('lease_expiration_or_remaining_term');

  // Escalations + free rent.
  const escalationPct = num(lease.annual_escalation_pct) ?? num(lease.escalation_rate);
  if (escalationPct === null && !Array.isArray(lease.escalation_schedule)) missing.push('escalation_schedule');
  const freeRentMonths = num(lease.free_rent_months) ?? ROLL.free_rent_months;

  // Reimbursement structure (explicit only).
  const reimbursement = {
    taxes: reimbursed(lease.tax_reimbursement ?? lease.reimburses_taxes),
    insurance: reimbursed(lease.insurance_reimbursement ?? lease.reimburses_insurance),
    opex: reimbursed(lease.cam_reimbursement ?? lease.opex_reimbursement ?? lease.reimburses_cam),
    base_year: num(lease.base_year),
    annual_reimbursement_income: num(lease.annual_reimbursement_income),
  };

  // TI / LC exposure (landlord) at next rollover. Medical TI is materially higher.
  const newTiPerRsf = isMedical ? ROLL.ti_per_rsf_new_medical : ROLL.ti_per_rsf_new_office;
  const tiExposure = rsf !== null ? roundMoney(newTiPerRsf * rsf) : null;
  const lcExposure = baseAnnual !== null && remainingTermYears !== null
    ? roundMoney(baseAnnual * Math.max(1, remainingTermYears) * ROLL.leasing_commission_pct)
    : null;

  // Downtime. Large blocks take longer; medical relocation friction shortens it.
  const largeBlock = rsf !== null && rsf >= 20_000;
  const downtimeMonths = isMedical ? ROLL.downtime_months_medical
    : largeBlock ? ROLL.downtime_months_large_block : ROLL.downtime_months_office;
  const downtimeLoss = baseAnnual !== null ? roundMoney((baseAnnual / 12) * downtimeMonths) : null;

  // Free-rent cost + effective rent = base less amortized (free rent + TI) over term.
  const freeRentCost = baseAnnual !== null ? roundMoney((baseAnnual / 12) * freeRentMonths) : null;
  const effectiveAnnual = baseAnnual !== null && remainingTermYears !== null && remainingTermYears > 0
    ? roundMoney(baseAnnual - ((freeRentCost ?? 0) + (tiExposure ?? 0)) / Math.max(1, remainingTermYears))
    : baseAnnual;

  // Expiration risk band.
  let expirationRisk = 'UNKNOWN';
  if (remainingTermYears !== null) {
    if (remainingTermYears <= 1) expirationRisk = 'NEAR_TERM';
    else if (remainingTermYears <= 3) expirationRisk = 'MEDIUM_TERM';
    else expirationRisk = 'LONG_TERM';
  } else if (isCoworking) {
    expirationRisk = 'LICENSE_NO_DURABLE_TERM';
  }

  const rolloverCost = sum([tiExposure, lcExposure, downtimeLoss, ROLL.legal_design_per_suite, freeRentCost]);
  const lossToLeasePerRsf = marketRentPerRsf !== null && rentPerRsf !== null ? round(marketRentPerRsf - rentPerRsf, 2) : null;

  // ---- Medical lease additions (§4) ----
  const medical = isMedical ? {
    specialized_buildout_owner: clean(lease.specialized_buildout_owner ?? lease.buildout_owner) || null,
    restoration_obligation: lease.restoration_obligation === true,
    equipment_ownership: clean(lease.equipment_ownership) || null,
    assignment_restricted: lease.assignment_restricted === true,
    regulatory_licensing_dependency: clean(lease.regulatory_dependency ?? lease.licensing_dependency) || null,
    hospital_affiliation: clean(lease.hospital_affiliation) || null,
    relocation_friction: lease.relocation_friction ?? 'HIGH', // specialized buildout → high friction
  } : null;

  return {
    tenant_name: clean(lease.tenant_name) || null,
    suite: clean(lease.suite ?? lease.suite_number) || null,
    floor: num(lease.floor),
    rentable_square_feet: rsf,
    usable_square_feet: usf,
    load_factor: round(loadFactor, 3),
    leased_square_feet: rsf, // canonical alias for shared rent-roll math
    lease_type,
    is_coworking_license: isCoworking,
    lease_type_confidence: ltConfidence,
    lease_type_reasons: ltReasons,
    annual_base_rent: isCoworking ? null : baseAnnual, // license fees are not durable lease income
    coworking_license_fee_annual: isCoworking ? baseAnnual : null,
    rent_basis: rentBasis,
    base_rent_per_rsf: rentPerRsf,
    base_rent_per_usf: rentPerUsf,
    market_rent_per_rsf: marketRentPerRsf,
    loss_to_lease_per_rsf: lossToLeasePerRsf,
    annual_escalation_pct: escalationPct,
    has_escalation_schedule: Array.isArray(lease.escalation_schedule) && lease.escalation_schedule.length > 0,
    free_rent_months: freeRentMonths,
    renewal_options: Array.isArray(lease.renewal_options) ? lease.renewal_options.length : num(lease.renewal_options),
    termination_options: lease.termination_option === true || num(lease.termination_options) > 0,
    expansion_rights: lease.expansion_rights === true,
    contraction_rights: lease.contraction_rights === true,
    lease_commencement: lease.lease_commencement ?? null,
    lease_expiration: lease.lease_expiration ?? (expYear !== null ? `${expYear}` : null),
    remaining_term_years: remainingTermYears,
    reimbursement_structure: reimbursement,
    landlord_expense_exposure: landlordExposure,
    ti_exposure: tiExposure,
    lc_exposure: lcExposure,
    effective_annual_rent: effectiveAnnual,
    expiration_risk: expirationRisk,
    is_large_block: largeBlock,
    rollover_downtime_months: downtimeMonths,
    rollover_cost: rolloverCost,
    security_deposit: num(lease.security_deposit),
    guaranty: clean(lease.guaranty ?? lease.guaranty_type) || null,
    industry: clean(lease.industry) || null,
    medical: medical,
    missing_inputs: [...new Set(missing)],
  };
}

function leaseExpYear(lease) {
  const raw = clean(lease.lease_expiration ?? lease.expiration_date ?? lease.lease_end);
  if (!raw) return null;
  const m = raw.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

function sum(arr) {
  const present = arr.filter((v) => v !== null && v !== undefined);
  if (!present.length) return null;
  return roundMoney(present.reduce((s, v) => s + v, 0));
}

/* -------------------------------------------------------------------------- */
/* Tenant credit / guaranty classification (§5)                                */
/* -------------------------------------------------------------------------- */

const INVESTMENT_GRADE = /\b(microsoft|google|alphabet|apple|amazon|meta|jpmorgan|chase|wells fargo|bank of america|citibank|goldman sachs|morgan stanley|deloitte|ernst|pwc|kpmg|accenture|ibm|oracle|salesforce|at&t|verizon)\b/;
const NATIONAL_CORP = /\b(regus|wework|industrious|fidelity|charles schwab|state farm|allstate|prudential|metlife|cigna|aetna|unitedhealth|cvs health)\b/;
const LAW_FIRM = /\b(law (firm|offices|group)|llp|attorneys?|legal (services|group)|& associates)\b/;
const FINANCIAL = /\b(financial|wealth management|investment|capital|advisors?|insurance|accounting|cpa|tax services|bank)\b/;
const TECH = /\b(technolog|software|\bsaas\b|\bit services\b|data|cyber|cloud|labs?\b|systems)\b/;
const GOVERNMENT = /\b(gsa|state of|county of|city of|federal|municipal|department of|\bdmv\b|social security|courthouse|public)\b/;
const NONPROFIT = /\b(nonprofit|non-profit|foundation|\b501c\b|charit|ministry|church|association)\b/;
const COWORKING = /\b(coworking|wework|regus|industrious|spaces|shared (office|workspace)|executive suites)\b/;

const HEALTH_SYSTEM = /\b(health system|healthcare system|medical center|kaiser|cleveland clinic|mayo|ascension|hca healthcare|commonspirit|providence health|tenet health|advent health)\b/;
const NATIONAL_HEALTHCARE = /\b(davita|fresenius|labcorp|quest diagnostics|us oncology|radiology partners|aspen dental|heartland dental|concentra|carbon health|onemedical|one medical)\b/;
const SURGERY = /\b(surgery center|surgical|ambulatory surgery|\basc\b)\b/;
const IMAGING = /\b(imaging|radiolog|mri|diagnostic imaging|simon med|rayus)\b/;
const URGENT = /\b(urgent care|walk.?in clinic|immediate care)\b/;
const DENTAL = /\b(dental|dentist|orthodont|endodont|periodont|oral surgery)\b/;
const PHYSICIAN = /\b(physician|medical group|clinic|associates? in (medicine|health)|family medicine|internal medicine|practice)\b/;

/**
 * Resolve an OFFICE tenant into a credit class + guaranty strength. A brand does
 * NOT by itself establish a corporate guaranty. A coworking OPERATOR is a single
 * occupancy whose income depends on its own members — never durable office income.
 */
export function classifyTenantCredit(tenant = {}) {
  const name = lower(tenant.tenant_name ?? tenant.name);
  const reasons = [];
  const guarantyEvidence = lower(tenant.guaranty ?? tenant.guaranty_type);
  const corporateGuaranty = /corporate|parent|investment.?grade/i.test(guarantyEvidence) || tenant.corporate_guaranty === true;
  const personalGuaranty = /personal|individual/i.test(guarantyEvidence) || tenant.personal_guaranty === true;

  let guarantyStrength = GS.UNKNOWN;
  if (corporateGuaranty && INVESTMENT_GRADE.test(name)) guarantyStrength = GS.CORPORATE_INVESTMENT_GRADE;
  else if (corporateGuaranty) guarantyStrength = GS.CORPORATE;
  else if (personalGuaranty) guarantyStrength = GS.PERSONAL;
  else if (guarantyEvidence) guarantyStrength = GS.LIMITED_OR_NONE;

  let creditClass = TC.UNKNOWN;
  if (tenant.owner_occupant === true) { creditClass = TC.OWNER_OCCUPANT; reasons.push('owner_occupant'); }
  else if (COWORKING.test(name)) { creditClass = TC.COWORKING_OPERATOR; reasons.push('coworking_operator_income_not_durable'); }
  else if (GOVERNMENT.test(name)) { creditClass = TC.GOVERNMENT; reasons.push('government_tenant'); }
  else if (NONPROFIT.test(name)) { creditClass = TC.NONPROFIT; reasons.push('nonprofit_tenant'); }
  else if (LAW_FIRM.test(name)) { creditClass = TC.LAW_FIRM; reasons.push('law_firm'); }
  else if (corporateGuaranty && INVESTMENT_GRADE.test(name)) { creditClass = TC.INVESTMENT_GRADE_CORPORATE; reasons.push('corporate_guaranty_investment_grade'); }
  else if (INVESTMENT_GRADE.test(name) || NATIONAL_CORP.test(name)) {
    // Brand present but guaranty NOT evidenced as corporate → NATIONAL_CORPORATE at
    // most, never INVESTMENT_GRADE. Brand alone is not a corporate guaranty.
    creditClass = TC.NATIONAL_CORPORATE; reasons.push('national_brand_without_corporate_guaranty_evidence');
  } else if (FINANCIAL.test(name)) { creditClass = TC.FINANCIAL_SERVICES; reasons.push('financial_services'); }
  else if (TECH.test(name)) { creditClass = TC.TECHNOLOGY; reasons.push('technology'); }
  else if (/\b(regional|llc|inc|corp|group|holdings)\b/.test(name) && (num(tenant.locations) ?? 0) >= 5) {
    creditClass = TC.REGIONAL_CORPORATE; reasons.push('regional_operator');
  } else if (name) { creditClass = TC.LOCAL_PROFESSIONAL; reasons.push('local_professional'); }

  let confidence = 25;
  if (corporateGuaranty || personalGuaranty) confidence += 25;
  if (creditClass !== TC.UNKNOWN) confidence += 15;
  if (guarantyStrength === GS.UNKNOWN) confidence = Math.min(confidence, 45);

  return {
    credit_class: creditClass,
    guaranty_strength: guarantyStrength,
    corporate_tenant: corporateGuaranty,
    parent_company: clean(tenant.parent_company) || null,
    local_operating_entity: clean(tenant.operating_entity ?? tenant.lease_signer) || null,
    brand_name: clean(tenant.tenant_name ?? tenant.name) || null,
    industry: clean(tenant.industry) || null,
    is_coworking_operator: creditClass === TC.COWORKING_OPERATOR,
    durable_office_income: creditClass !== TC.COWORKING_OPERATOR, // coworking income is not durable
    external_rating_invented: false,
    confidence: Math.round(Math.min(90, confidence)),
    reasons,
  };
}

/**
 * Resolve a MEDICAL tenant into a medical credit class + guaranty strength.
 * Hospital PROXIMITY does NOT prove health-system credit; physician USE does NOT
 * prove long-term stability. Health-system credit requires an evidenced health-
 * system tenant or guaranty, not a building label or an on-campus location.
 */
export function classifyMedicalTenantCredit(tenant = {}) {
  const name = lower(tenant.tenant_name ?? tenant.name);
  const reasons = [];
  const guarantyEvidence = lower(tenant.guaranty ?? tenant.guaranty_type);
  const healthSystemGuaranty = /health system|corporate|parent/i.test(guarantyEvidence) || tenant.health_system_guaranty === true;
  const personalGuaranty = /personal|individual/i.test(guarantyEvidence) || tenant.personal_guaranty === true;
  // Affiliation/proximity is NOT credit unless the tenant IS the health system or
  // the lease is health-system guaranteed.
  const onCampus = tenant.on_hospital_campus === true || tenant.hospital_proximity === true;

  let guarantyStrength = GS.UNKNOWN;
  if (healthSystemGuaranty && HEALTH_SYSTEM.test(name)) guarantyStrength = GS.HEALTH_SYSTEM_CREDIT;
  else if (healthSystemGuaranty) guarantyStrength = GS.CORPORATE;
  else if (tenant.group_practice === true || PHYSICIAN.test(name)) guarantyStrength = personalGuaranty ? GS.PERSONAL : GS.GROUP_PRACTICE;
  else if (personalGuaranty) guarantyStrength = GS.PERSONAL;
  else if (guarantyEvidence) guarantyStrength = GS.LIMITED_OR_NONE;

  let creditClass = MTC.UNKNOWN_MEDICAL;
  if (HEALTH_SYSTEM.test(name) && (healthSystemGuaranty || tenant.is_health_system === true)) { creditClass = MTC.HEALTH_SYSTEM; reasons.push('evidenced_health_system_tenant'); }
  else if (tenant.hospital_affiliate === true && healthSystemGuaranty) { creditClass = MTC.HOSPITAL_AFFILIATE; reasons.push('hospital_affiliate_with_guaranty'); }
  else if (NATIONAL_HEALTHCARE.test(name)) { creditClass = MTC.NATIONAL_HEALTHCARE_OPERATOR; reasons.push('national_healthcare_operator'); }
  else if (SURGERY.test(name)) { creditClass = MTC.SURGERY_CENTER_OPERATOR; reasons.push('surgery_center_operator'); }
  else if (IMAGING.test(name)) { creditClass = MTC.IMAGING_OPERATOR; reasons.push('imaging_operator'); }
  else if (URGENT.test(name)) { creditClass = MTC.URGENT_CARE_OPERATOR; reasons.push('urgent_care_operator'); }
  else if (DENTAL.test(name)) { creditClass = tenant.group_practice === true ? MTC.DENTAL_GROUP : MTC.INDIVIDUAL_PRACTICE; reasons.push('dental'); }
  else if (tenant.is_franchisee === true) { creditClass = MTC.MEDICAL_FRANCHISEE; reasons.push('medical_franchisee'); }
  else if (tenant.group_practice === true || /medical group|physicians?|associates/.test(name)) { creditClass = MTC.PHYSICIAN_GROUP; reasons.push('physician_group'); }
  else if (PHYSICIAN.test(name) || name) { creditClass = MTC.INDIVIDUAL_PRACTICE; reasons.push('individual_practice'); }

  // Explicit guard: on-campus / proximity is recorded but does NOT upgrade credit.
  if (onCampus && creditClass !== MTC.HEALTH_SYSTEM && creditClass !== MTC.HOSPITAL_AFFILIATE) {
    reasons.push('hospital_proximity_present_but_not_credit');
  }

  let confidence = 25;
  if (healthSystemGuaranty || personalGuaranty) confidence += 25;
  if (creditClass !== MTC.UNKNOWN_MEDICAL) confidence += 15;
  if (guarantyStrength === GS.UNKNOWN) confidence = Math.min(confidence, 45);

  return {
    is_medical: true,
    credit_class: creditClass,
    guaranty_strength: guarantyStrength,
    health_system_credit: creditClass === MTC.HEALTH_SYSTEM,
    hospital_proximity: onCampus,
    proximity_proves_credit: false, // explicit invariant
    physician_use_proves_stability: false, // explicit invariant
    parent_company: clean(tenant.parent_company) || null,
    brand_name: clean(tenant.tenant_name ?? tenant.name) || null,
    external_rating_invented: false,
    confidence: Math.round(Math.min(90, confidence)),
    reasons,
  };
}
