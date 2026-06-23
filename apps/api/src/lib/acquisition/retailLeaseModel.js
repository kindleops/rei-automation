/**
 * Acquisition Engine V3 — Item 5E §4 & §5: retail lease normalization + tenant
 * credit / guaranty classification.
 *
 * Lease normalization (§4): recognize the lease structure WITHOUT inferring NNN
 * merely because a CAM reimbursement exists; compute per-lease base rent, rent/SF,
 * escalations, remaining term, reimbursement structure, landlord expense exposure,
 * TI/LC exposure, effective rent, expiration risk and rollover cost. Return the
 * EXACT missing lease inputs.
 *
 * Tenant credit (§5): resolve a tenant into a credit class and a guaranty strength
 * WITHOUT equating a nationally-known brand with a corporate-guaranteed lease, and
 * WITHOUT inventing an external credit rating. Distinguish corporate / franchisee /
 * guarantor / parent / local operating entity.
 *
 * Missing values are UNKNOWN, never zero. Pure & deterministic.
 */

import { num, clean, lower, round, roundMoney } from './modelConstants.js';
import {
  LEASE_TYPE as LT,
  LANDLORD_EXPENSE_EXPOSURE,
  TENANT_CREDIT_CLASS as TC,
  GUARANTY_STRENGTH as GS,
  RETAIL_ROLLOVER_ASSUMPTIONS as ROLL,
} from './retailConstants.js';

/* -------------------------------------------------------------------------- */
/* Lease type recognition (§4)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Recognize the lease structure from explicit fields ONLY. Critically, NNN is
 * never inferred from the presence of a CAM reimbursement alone — an explicit
 * lease-type label or a full taxes+insurance+CAM reimbursement set is required.
 */
export function recognizeLeaseType(lease = {}) {
  const explicit = lower(lease.lease_type ?? lease.lease_structure);
  const reasons = [];
  if (explicit) {
    const map = {
      'absolute net': LT.ABSOLUTE_NET, 'absolute nnn': LT.ABSOLUTE_NET, 'bondable': LT.ABSOLUTE_NET,
      'triple net': LT.TRIPLE_NET, 'nnn': LT.TRIPLE_NET,
      'double net': LT.DOUBLE_NET, 'nn': LT.DOUBLE_NET,
      'single net': LT.SINGLE_NET, 'n': LT.SINGLE_NET,
      'modified gross': LT.MODIFIED_GROSS, 'mod gross': LT.MODIFIED_GROSS,
      'full service': LT.FULL_SERVICE_GROSS, 'full service gross': LT.FULL_SERVICE_GROSS, 'gross': LT.FULL_SERVICE_GROSS,
      'ground lease': LT.GROUND_LEASE, 'ground': LT.GROUND_LEASE,
      'percentage': LT.PERCENTAGE_RENT, 'percentage rent': LT.PERCENTAGE_RENT,
      'owner occupied': LT.OWNER_OCCUPIED,
    };
    for (const [k, v] of Object.entries(map)) {
      if (explicit.includes(k)) { reasons.push(`explicit_lease_type=${k}`); return { lease_type: v, confidence: 80, reasons }; }
    }
  }

  // Structured reimbursement evidence — requires the FULL set for NNN.
  const taxReimb = reimbursed(lease.tax_reimbursement ?? lease.reimburses_taxes);
  const insReimb = reimbursed(lease.insurance_reimbursement ?? lease.reimburses_insurance);
  const camReimb = reimbursed(lease.cam_reimbursement ?? lease.reimburses_cam);
  const structuralTenant = lease.tenant_pays_structure === true || lease.tenant_pays_roof === true;

  if (taxReimb && insReimb && camReimb && structuralTenant) { reasons.push('full_net_plus_structure'); return { lease_type: LT.ABSOLUTE_NET, confidence: 65, reasons }; }
  if (taxReimb && insReimb && camReimb) { reasons.push('taxes_insurance_cam_reimbursed'); return { lease_type: LT.TRIPLE_NET, confidence: 60, reasons }; }
  if (taxReimb && insReimb && !camReimb) { reasons.push('taxes_insurance_reimbursed_no_cam'); return { lease_type: LT.DOUBLE_NET, confidence: 55, reasons }; }
  if (taxReimb && !insReimb && !camReimb) { reasons.push('taxes_only_reimbursed'); return { lease_type: LT.SINGLE_NET, confidence: 50, reasons }; }
  if (camReimb && !taxReimb && !insReimb) {
    // CAM-only reimbursement is MODIFIED_GROSS — NOT NNN (mission §4 invariant).
    reasons.push('cam_only_not_nnn');
    return { lease_type: LT.MODIFIED_GROSS, confidence: 45, reasons };
  }
  if (num(lease.percentage_rent_rate) !== null) { reasons.push('percentage_rent_present'); return { lease_type: LT.PERCENTAGE_RENT, confidence: 45, reasons }; }

  reasons.push('insufficient_lease_structure_evidence');
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
 * Normalize a single lease. Returns base rent, rent/SF, escalations, remaining
 * term, reimbursement structure, landlord exposure, TI/LC exposure, effective
 * rent, expiration risk and rollover cost — plus the EXACT missing inputs.
 *
 * @param {object} lease  raw lease record
 * @param {object} [ctx]  { asOfYear, marketRentPerSf }
 */
export function normalizeLease(lease = {}, { asOfYear = 2026, marketRentPerSf = null } = {}) {
  const missing = [];
  const sf = num(lease.leased_square_feet ?? lease.suite_sqft ?? lease.gla);
  if (sf === null) missing.push('leased_square_feet');

  const { lease_type, confidence: ltConfidence, reasons: ltReasons } = recognizeLeaseType(lease);
  const landlordExposure = LANDLORD_EXPENSE_EXPOSURE[lease_type] ?? LANDLORD_EXPENSE_EXPOSURE.UNKNOWN;

  // Base rent: explicit annual, else monthly*12, else rent/SF*SF.
  let baseAnnual = num(lease.annual_base_rent);
  let rentBasis = 'annual_base_rent';
  if (baseAnnual === null && num(lease.monthly_base_rent) !== null) { baseAnnual = roundMoney(num(lease.monthly_base_rent) * 12); rentBasis = 'monthly_base_rent*12'; }
  if (baseAnnual === null && num(lease.base_rent_per_sf) !== null && sf !== null) { baseAnnual = roundMoney(num(lease.base_rent_per_sf) * sf); rentBasis = 'base_rent_per_sf*sf'; }
  if (baseAnnual === null) { rentBasis = null; missing.push('base_rent'); }

  const rentPerSf = baseAnnual !== null && sf ? round(baseAnnual / sf, 2) : null;

  // Remaining term from explicit expiration or remaining-months.
  const expYear = leaseExpYear(lease);
  let remainingTermYears = num(lease.remaining_term_years);
  if (remainingTermYears === null && num(lease.remaining_term_months) !== null) remainingTermYears = round(num(lease.remaining_term_months) / 12, 2);
  if (remainingTermYears === null && expYear !== null) remainingTermYears = Math.max(0, round(expYear - asOfYear, 2));
  if (remainingTermYears === null) missing.push('lease_expiration_or_remaining_term');

  // Escalations.
  const escalationPct = num(lease.annual_escalation_pct) ?? num(lease.escalation_rate);
  if (escalationPct === null && !Array.isArray(lease.escalation_schedule)) missing.push('escalation_schedule');

  // Reimbursement structure (explicit only).
  const reimbursement = {
    taxes: reimbursed(lease.tax_reimbursement ?? lease.reimburses_taxes),
    insurance: reimbursed(lease.insurance_reimbursement ?? lease.reimburses_insurance),
    cam: reimbursed(lease.cam_reimbursement ?? lease.reimburses_cam),
    annual_reimbursement_income: num(lease.annual_reimbursement_income),
  };

  // TI / LC exposure (landlord) at next rollover.
  const anchor = sf !== null && sf >= 15_000;
  const tiPerSf = anchor ? ROLL.ti_per_gla_anchor : ROLL.ti_per_gla_inline;
  const tiExposure = sf !== null ? roundMoney(tiPerSf * sf) : null;
  const lcExposure = baseAnnual !== null && remainingTermYears !== null
    ? roundMoney(baseAnnual * Math.max(1, remainingTermYears) * ROLL.leasing_commission_pct)
    : null;

  // Effective rent = base less amortized free rent + TI over the term.
  const freeRentCost = baseAnnual !== null ? (baseAnnual / 12) * ROLL.free_rent_months : null;
  const effectiveAnnual = baseAnnual !== null && remainingTermYears !== null && remainingTermYears > 0
    ? roundMoney(baseAnnual - ((freeRentCost ?? 0) + (tiExposure ?? 0)) / Math.max(1, remainingTermYears))
    : baseAnnual;

  // Expiration risk band.
  let expirationRisk = 'UNKNOWN';
  if (remainingTermYears !== null) {
    if (remainingTermYears <= 1) expirationRisk = 'NEAR_TERM';
    else if (remainingTermYears <= 3) expirationRisk = 'MEDIUM_TERM';
    else expirationRisk = 'LONG_TERM';
  }

  // Rollover cost (landlord) if the suite turns over.
  const downtimeMonths = anchor ? ROLL.downtime_months_anchor : ROLL.downtime_months_inline;
  const downtimeLoss = baseAnnual !== null ? roundMoney((baseAnnual / 12) * downtimeMonths) : null;
  const rolloverCost = sum([tiExposure, lcExposure, downtimeLoss, ROLL.legal_marketing_per_suite, freeRentCost !== null ? roundMoney(freeRentCost) : null]);

  // Loss-to-lease vs market.
  const lossToLeasePerSf = marketRentPerSf !== null && rentPerSf !== null ? round(marketRentPerSf - rentPerSf, 2) : null;

  return {
    tenant_name: clean(lease.tenant_name) || null,
    suite: clean(lease.suite ?? lease.suite_number) || null,
    leased_square_feet: sf,
    lease_type,
    lease_type_confidence: ltConfidence,
    lease_type_reasons: ltReasons,
    annual_base_rent: baseAnnual,
    rent_basis: rentBasis,
    base_rent_per_sf: rentPerSf,
    market_rent_per_sf: marketRentPerSf,
    loss_to_lease_per_sf: lossToLeasePerSf,
    annual_escalation_pct: escalationPct,
    has_escalation_schedule: Array.isArray(lease.escalation_schedule) && lease.escalation_schedule.length > 0,
    renewal_options: num(lease.renewal_options) ?? (Array.isArray(lease.renewal_options) ? lease.renewal_options.length : null),
    termination_options: lease.termination_option === true || num(lease.termination_options) > 0,
    percentage_rent_rate: num(lease.percentage_rent_rate),
    lease_commencement: lease.lease_commencement ?? null,
    lease_expiration: lease.lease_expiration ?? (expYear !== null ? `${expYear}` : null),
    remaining_term_years: remainingTermYears,
    reimbursement_structure: reimbursement,
    landlord_expense_exposure: landlordExposure,
    ti_exposure: tiExposure,
    lc_exposure: lcExposure,
    effective_annual_rent: effectiveAnnual,
    expiration_risk: expirationRisk,
    is_anchor_size: anchor,
    rollover_downtime_months: downtimeMonths,
    rollover_cost: rolloverCost,
    co_tenancy_clause: lease.co_tenancy === true || lease.co_tenancy_clause === true,
    exclusive_use: clean(lease.exclusive_use) || null,
    security_deposit: num(lease.security_deposit),
    guaranty: clean(lease.guaranty ?? lease.guaranty_type) || null,
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

const INVESTMENT_GRADE = /\b(walmart|target|home depot|lowe'?s|costco|cvs|walgreens|mcdonald'?s|starbucks|fedex|ups store|chase|wells fargo|bank of america|kroger|publix|aldi)\b/;
const NATIONAL_BRAND = /\b(dollar general|dollar tree|family dollar|autozone|o'?reilly|advance auto|tractor supply|petsmart|petco|ross|tj ?maxx|marshalls|burlington|ulta|five below|chipotle|panera|chick.?fil.?a|taco bell|wendy'?s|subway|dunkin|7.?eleven|circle k)\b/;
const GROCERY = /\b(grocery|supermarket|kroger|publix|albertsons|safeway|heb|h-?e-?b|whole foods|sprouts|wholefoods|food ?lion|winn.?dixie)\b/;
const GOVERNMENT = /\b(usps|post office|dmv|social security|county|state of|federal|municipal|library|wic)\b/;
const MEDICAL = /\b(dental|dentist|clinic|medical|urgent care|physical therapy|chiropractic|veterinary|vet clinic|optometry|dialysis)\b/;

/**
 * Resolve a tenant into a credit class + guaranty strength. A nationally-known
 * brand does NOT by itself establish a corporate guaranty: a franchisee or local
 * operating entity behind a brand sign is classified by the GUARANTY evidence, not
 * the brand. No external credit rating is invented.
 */
export function classifyTenantCredit(tenant = {}) {
  const name = lower(tenant.tenant_name ?? tenant.name);
  const reasons = [];
  const isFranchisee = tenant.is_franchisee === true || /franchis/i.test(clean(tenant.operating_entity ?? tenant.entity_type ?? tenant.lease_signer));
  const guarantyEvidence = lower(tenant.guaranty ?? tenant.guaranty_type);
  const corporateGuaranty = /corporate|parent|investment.?grade/i.test(guarantyEvidence) || tenant.corporate_guaranty === true;
  const personalGuaranty = /personal|individual/i.test(guarantyEvidence) || tenant.personal_guaranty === true;

  // ---- Guaranty strength (evidence-driven; brand is NOT guaranty) ----
  let guarantyStrength = GS.UNKNOWN;
  if (corporateGuaranty && INVESTMENT_GRADE.test(name)) guarantyStrength = GS.CORPORATE_INVESTMENT_GRADE;
  else if (corporateGuaranty) guarantyStrength = GS.CORPORATE;
  else if (isFranchisee && personalGuaranty) guarantyStrength = GS.FRANCHISEE_PERSONAL;
  else if (personalGuaranty) guarantyStrength = GS.PERSONAL;
  else if (guarantyEvidence) guarantyStrength = GS.LIMITED_OR_NONE;

  // ---- Credit class ----
  let creditClass = TC.UNKNOWN;
  if (tenant.owner_occupant === true) { creditClass = TC.OWNER_OCCUPANT; reasons.push('owner_occupant'); }
  else if (GOVERNMENT.test(name)) { creditClass = TC.GOVERNMENT; reasons.push('government_tenant'); }
  else if (GROCERY.test(name)) { creditClass = TC.GROCERY_ANCHOR; reasons.push('grocery_anchor'); }
  else if (MEDICAL.test(name)) { creditClass = TC.MEDICAL_OR_SERVICE; reasons.push('medical_or_service'); }
  else if (isFranchisee) { creditClass = TC.FRANCHISEE; reasons.push('franchisee_operating_entity_behind_brand'); }
  else if (corporateGuaranty && INVESTMENT_GRADE.test(name)) { creditClass = TC.INVESTMENT_GRADE_NATIONAL; reasons.push('corporate_guaranty_investment_grade_brand'); }
  else if (INVESTMENT_GRADE.test(name) || NATIONAL_BRAND.test(name)) {
    // Brand present but guaranty NOT evidenced as corporate → NATIONAL_CREDIT at
    // most, never INVESTMENT_GRADE. Brand alone is not a corporate guaranty.
    creditClass = TC.NATIONAL_CREDIT; reasons.push('national_brand_without_corporate_guaranty_evidence');
  } else if (/\b(regional|llc|inc|corp|group|holdings)\b/.test(name) && (num(tenant.locations) ?? 0) >= 5) {
    creditClass = TC.REGIONAL_CREDIT; reasons.push('regional_operator');
  } else if (name) { creditClass = TC.LOCAL_OPERATOR; reasons.push('local_operator'); }

  // Shadow anchor: a draw NOT on the subject parcel (mission §11) — never owned.
  if (tenant.shadow_anchor === true) { creditClass = TC.SHADOW_ANCHOR; reasons.push('shadow_anchor_not_on_subject_parcel'); }

  let confidence = 25;
  if (corporateGuaranty || personalGuaranty) confidence += 25;
  if (creditClass !== TC.UNKNOWN) confidence += 15;
  if (guarantyStrength === GS.UNKNOWN) confidence = Math.min(confidence, 45);

  return {
    credit_class: creditClass,
    guaranty_strength: guarantyStrength,
    is_franchisee: isFranchisee,
    corporate_tenant: corporateGuaranty,
    parent_company: clean(tenant.parent_company) || null,
    local_operating_entity: clean(tenant.operating_entity ?? tenant.lease_signer) || null,
    brand_name: clean(tenant.tenant_name ?? tenant.name) || null,
    lease_dependency: creditClass === TC.GROCERY_ANCHOR || (num(tenant.gla_share) ?? 0) >= 0.3 ? 'ANCHOR' : 'INLINE',
    external_rating_invented: false,
    confidence: Math.round(Math.min(90, confidence)),
    reasons,
  };
}
