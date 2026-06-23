/**
 * Acquisition Engine V3 — Item 5F §3 & §6: canonical office subject contract +
 * deterministic rent-roll normalization.
 *
 * Layered ON TOP of the canonical income-snapshot provenance primitives
 * (incomeSnapshotContract.js) so every office field carries value, source, source
 * record, date, confidence, evidence basis, validation, conflict and freshness. A
 * missing value is UNKNOWN, never zero. Suite-level precision is NEVER fabricated
 * from a building-level total (mission §6). Rentable vs usable area + load factor
 * are tracked distinctly, and physical / leased / economic occupancy stay
 * separate. Medical buildout / specialized-systems fields are exposed for the
 * medical lane (mission §3).
 *
 * Pure & deterministic — no I/O, no Date.now, no randomness.
 */

import { num, clean, round, roundMoney } from './modelConstants.js';
import {
  EVIDENCE_BASIS, VALIDATION_STATUS, provField, unknownField, isKnown,
} from './incomeSnapshotContract.js';
import { classifyOfficeAsset } from './officeClassification.js';
import { normalizeLease, classifyTenantCredit, classifyMedicalTenantCredit } from './officeLeaseModel.js';
import {
  OFFICE_CONCENTRATION as CONC, OFFICE_STABILIZED_OCCUPANCY, DEFAULT_LOAD_FACTOR, MEDICAL_SUBTYPES,
} from './officeConstants.js';

/** Shorthand: a KNOWN provField from an explicit input. */
function known(value, source, basis = EVIDENCE_BASIS.ACTUAL, extra = {}) {
  const v = num(value);
  if (v === null && typeof value !== 'boolean' && !clean(value)) return unknownField();
  return provField(typeof value === 'boolean' ? value : (v ?? value), {
    basis, source, validation_status: VALIDATION_STATUS.UNVALIDATED, ...extra,
  });
}

function pickField(row, keys, basis = EVIDENCE_BASIS.PROVIDER_REPORTED) {
  for (const k of keys) {
    const v = num(row[k]);
    if (v !== null) return provField(v, { basis, source: `properties.${k}`, source_record_id: row.property_id ?? row.id ?? null });
  }
  return unknownField();
}

function pickStrField(row, keys, basis = EVIDENCE_BASIS.PROVIDER_REPORTED) {
  for (const k of keys) {
    const v = clean(row[k]);
    if (v) return provField(v, { basis, source: `properties.${k}`, source_record_id: row.property_id ?? row.id ?? null });
  }
  return unknownField();
}

function occField(value, source) {
  const v = num(value);
  if (v === null) return unknownField();
  return provField(v > 1 ? round(v / 100, 4) : round(v, 4), { basis: EVIDENCE_BASIS.OWNER_REPORTED, source, confidence: 55 });
}

function actualMoney(value, source) {
  const v = num(value);
  return v === null ? unknownField() : provField(roundMoney(v), { basis: EVIDENCE_BASIS.ACTUAL, source });
}

/**
 * Build the canonical office subject contract.
 *
 * @param {object} row      raw subject property row
 * @param {object} [office] structured office inputs (overrides row):
 *   { leases, operations, income, expenses, medical, debt, ... }
 */
export function buildOfficeContract(row = {}, office = {}) {
  const cls = classifyOfficeAsset(row);
  const ops = office.operations ?? {};
  const income = office.income ?? {};
  const exp = office.expenses ?? {};
  const med = office.medical ?? {};
  const debt = office.debt ?? {};
  const isMedical = cls.is_medical || MEDICAL_SUBTYPES.includes(cls.subtype);

  // ---- Physical size: rentable building area observed, else gross building area (labeled) ----
  const gbaField = pickField(row, ['gross_building_area', 'building_square_feet', 'sqft']);
  let rbaField = office.rentable_building_area != null
    ? known(office.rentable_building_area, 'office_inputs.rentable_building_area', EVIDENCE_BASIS.VERIFIED_DOCUMENT)
    : pickField(row, ['rentable_building_area', 'net_rentable_area', 'rentable_square_feet']);
  if (!isKnown(rbaField) && isKnown(gbaField)) {
    // RBA modeled from GBA at a labeled efficiency (office RBA ≈ 0.92 of GBA).
    rbaField = provField(roundMoney(num(gbaField.value) * 0.92), {
      basis: EVIDENCE_BASIS.MARKET_MODELED, confidence: 30,
      source: 'modeled_rba=0.92*gba', validation_status: VALIDATION_STATUS.UNVALIDATED,
    });
  }

  // Usable area + load factor.
  let usableField = office.usable_area != null ? known(office.usable_area, 'office_inputs.usable_area', EVIDENCE_BASIS.VERIFIED_DOCUMENT) : pickField(row, ['usable_area', 'usable_square_feet']);
  let loadFactor = num(office.load_factor) ?? num(row.load_factor);
  if (loadFactor === null && isKnown(rbaField) && isKnown(usableField) && num(usableField.value) > 0) {
    loadFactor = round(num(rbaField.value) / num(usableField.value), 3);
  }
  const loadFactorField = loadFactor !== null
    ? provField(loadFactor, { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, source: 'rba/usable', confidence: 45 })
    : provField(cls.subtype && cls.subtype.includes('SINGLE_TENANT') ? DEFAULT_LOAD_FACTOR.SINGLE_TENANT : DEFAULT_LOAD_FACTOR.MULTI_TENANT, { basis: EVIDENCE_BASIS.MARKET_MODELED, source: 'default_load_factor', confidence: 20 });
  if (!isKnown(usableField) && isKnown(rbaField) && loadFactor) {
    usableField = provField(roundMoney(num(rbaField.value) / loadFactor), { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, source: 'rba/load_factor', confidence: 25 });
  }

  const rentRoll = buildRentRoll(row, { ...office, _isMedical: isMedical });

  const contract = {
    lane: cls.lane,
    is_office: cls.is_office,
    genuine_office: cls.genuine_office,
    is_medical: isMedical,
    subtype: cls.subtype,
    building_class: cls.class,
    location: cls.location,
    height: cls.height,
    classification: cls,

    identity: {
      property_id: row.property_id ?? row.id ?? null,
      canonical_asset_lane: cls.lane,
      office_subtype: provField(cls.subtype, { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, confidence: cls.confidence, source: 'officeClassification' }),
      building_class: provField(cls.class, { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, confidence: cls.confidence, source: 'officeClassification' }),
      tenancy_structure: unknownField(), // resolved by classifyOfficeTenancy
      operational_status: unknownField(), // resolved by classifyOfficeOperationalStatus
      owner_occupied: typeof row.owner_occupied === 'boolean' ? known(row.owner_occupied, 'properties.owner_occupied') : unknownField(),
      year_built: pickField(row, ['year_built']),
      renovation_year: pickField(row, ['renovation_year', 'year_renovated']),
      condition: pickStrField(row, ['condition', 'property_condition']),
      zoning: pickStrField(row, ['zoning']),
      redevelopment_potential: typeof office.redevelopment_potential === 'boolean' ? known(office.redevelopment_potential, 'office_inputs.redevelopment_potential') : unknownField(),
    },

    physical: {
      gross_building_area: gbaField,
      rentable_building_area: rbaField,
      usable_area: usableField,
      load_factor: loadFactorField,
      land_area: pickField(row, ['lot_square_feet', 'land_sqft', 'lot_size_sqft']),
      number_of_buildings: pickField(row, ['number_of_buildings', 'building_count']),
      floor_count: office.floor_count != null ? known(office.floor_count, 'office_inputs.floor_count') : pickField(row, ['floor_count', 'number_of_floors', 'stories']),
      suite_count: office.number_of_suites != null ? known(office.number_of_suites, 'office_inputs.number_of_suites') : pickField(row, ['number_of_suites', 'suite_count']),
      floor_plate_sqft: office.floor_plate_sqft != null ? known(office.floor_plate_sqft, 'office_inputs.floor_plate_sqft') : unknownField(),
      ceiling_height: office.ceiling_height != null ? known(office.ceiling_height, 'office_inputs.ceiling_height') : unknownField(),
      elevator_count: office.elevator_count != null ? known(office.elevator_count, 'office_inputs.elevator_count') : pickField(row, ['elevator_count']),
      hvac_configuration: pickStrField(office, ['hvac_configuration']),
      building_systems: pickStrField(office, ['building_systems']),
      generator_redundancy: typeof office.generator_redundancy === 'boolean' ? known(office.generator_redundancy, 'office_inputs.generator_redundancy') : unknownField(),
      parking_spaces: office.parking_spaces != null ? known(office.parking_spaces, 'office_inputs.parking_spaces') : pickField(row, ['parking_spaces', 'parking_count']),
      parking_ratio: office.parking_ratio != null ? known(office.parking_ratio, 'office_inputs.parking_ratio') : unknownField(),
      covered_parking: typeof office.covered_parking === 'boolean' ? known(office.covered_parking, 'office_inputs.covered_parking') : unknownField(),
      structured_parking: typeof office.structured_parking === 'boolean' ? known(office.structured_parking, 'office_inputs.structured_parking') : unknownField(),
      structured_parking_spaces: office.structured_parking_spaces != null ? known(office.structured_parking_spaces, 'office_inputs.structured_parking_spaces') : unknownField(),
      transit_access: pickStrField(office, ['transit_access']),
      frontage_visibility: pickStrField(office, ['frontage', 'visibility']),
      signage: pickStrField(office, ['signage']),
    },

    rent_roll: rentRoll,

    operations: {
      physical_occupancy: occField(ops.physical_occupancy ?? rentRoll.physical_occupancy, ops.physical_occupancy != null ? 'operations.physical_occupancy' : 'rent_roll.physical_occupancy'),
      economic_occupancy: occField(ops.economic_occupancy ?? rentRoll.economic_occupancy, 'operations.economic_occupancy'),
      leased_occupancy: occField(ops.leased_occupancy ?? rentRoll.leased_occupancy, 'operations.leased_occupancy'),
      direct_vacancy: ops.direct_vacancy != null ? known(ops.direct_vacancy, 'operations.direct_vacancy') : unknownField(),
      sublease_vacancy: ops.sublease_vacancy != null ? known(ops.sublease_vacancy, 'operations.sublease_vacancy') : unknownField(),
      shadow_vacancy: ops.shadow_vacancy != null ? known(ops.shadow_vacancy, 'operations.shadow_vacancy') : unknownField(),
      in_place_rent_psf: income.in_place_rent_psf != null ? known(income.in_place_rent_psf, 'income.in_place_rent_psf', EVIDENCE_BASIS.ACTUAL) : (rentRoll.in_place_rent_psf != null ? provField(rentRoll.in_place_rent_psf, { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, source: 'rent_roll', confidence: 50 }) : unknownField()),
      market_rent_psf: income.market_rent_psf != null ? known(income.market_rent_psf, 'income.market_rent_psf', EVIDENCE_BASIS.COMPARABLE_DERIVED) : unknownField(),
      effective_rent_psf: income.effective_rent_psf != null ? known(income.effective_rent_psf, 'income.effective_rent_psf') : unknownField(),
      concessions: income.concessions != null ? known(income.concessions, 'income.concessions') : unknownField(),
      bad_debt: income.bad_debt != null ? known(income.bad_debt, 'income.bad_debt') : unknownField(),
    },

    income: {
      base_rental_income: actualMoney(income.base_rental_income, 'income.base_rental_income'),
      expense_reimbursement_income: actualMoney(income.expense_reimbursement_income ?? income.reimbursement_income, 'income.expense_reimbursement_income'),
      parking_income: actualMoney(income.parking_income, 'income.parking_income'),
      signage_income: actualMoney(income.signage_income, 'income.signage_income'),
      conference_amenity_income: actualMoney(income.conference_amenity_income, 'income.conference_amenity_income'),
      other_income: actualMoney(income.other_income, 'income.other_income'),
      gross_potential_revenue: actualMoney(income.gross_potential_revenue, 'income.gross_potential_revenue'),
      effective_gross_revenue: actualMoney(income.effective_gross_revenue, 'income.effective_gross_revenue'),
      // Coworking SERVICE revenue is captured separately and EXCLUDED from RE income (§18).
      coworking_service_revenue: actualMoney(income.coworking_service_revenue, 'income.coworking_service_revenue'),
    },

    expenses: {
      property_taxes: actualMoney(exp.property_taxes ?? row.tax_amt, exp.property_taxes != null ? 'expenses.property_taxes' : 'properties.tax_amt'),
      insurance: actualMoney(exp.insurance, 'expenses.insurance'),
      utilities: actualMoney(exp.utilities, 'expenses.utilities'),
      repairs_maintenance: actualMoney(exp.repairs_maintenance ?? exp.repairs, 'expenses.repairs_maintenance'),
      hvac: actualMoney(exp.hvac, 'expenses.hvac'),
      elevator: actualMoney(exp.elevator, 'expenses.elevator'),
      janitorial: actualMoney(exp.janitorial, 'expenses.janitorial'),
      security: actualMoney(exp.security, 'expenses.security'),
      landscaping_snow: actualMoney(exp.landscaping_snow, 'expenses.landscaping_snow'),
      payroll: actualMoney(exp.payroll, 'expenses.payroll'),
      management: actualMoney(exp.management, 'expenses.management'),
      administrative: actualMoney(exp.administrative, 'expenses.administrative'),
      legal_accounting: actualMoney(exp.legal_accounting, 'expenses.legal_accounting'),
      marketing: actualMoney(exp.marketing, 'expenses.marketing'),
      parking_operations: actualMoney(exp.parking_operations, 'expenses.parking_operations'),
      medical_systems: actualMoney(exp.medical_systems, 'expenses.medical_systems'),
      replacement_reserves: actualMoney(exp.replacement_reserves ?? exp.reserves, 'expenses.replacement_reserves'),
      total_operating_expenses: actualMoney(exp.total_operating_expenses, 'expenses.total_operating_expenses'),
    },

    medical: isMedical ? {
      medical_buildout_pct: med.medical_buildout_pct != null ? known(med.medical_buildout_pct, 'medical.medical_buildout_pct') : unknownField(),
      plumbing_density: pickStrField(med, ['plumbing_density']),
      specialized_electrical: typeof med.specialized_electrical === 'boolean' ? known(med.specialized_electrical, 'medical.specialized_electrical') : unknownField(),
      backup_power: typeof med.backup_power === 'boolean' ? known(med.backup_power, 'medical.backup_power') : unknownField(),
      gas_systems: typeof med.gas_systems === 'boolean' ? known(med.gas_systems, 'medical.gas_systems') : unknownField(),
      imaging_shielding: typeof med.imaging_shielding === 'boolean' ? known(med.imaging_shielding, 'medical.imaging_shielding') : unknownField(),
      surgery_infrastructure: typeof med.surgery_infrastructure === 'boolean' ? known(med.surgery_infrastructure, 'medical.surgery_infrastructure') : unknownField(),
      ada_accessibility: typeof med.ada_accessibility === 'boolean' ? known(med.ada_accessibility, 'medical.ada_accessibility') : unknownField(),
      parking_demand: pickStrField(med, ['parking_demand']),
      patient_access: pickStrField(med, ['patient_access', 'ambulance_access']),
      hospital_affiliation: pickStrField(med, ['hospital_affiliation']),
      referral_network_dependency: typeof med.referral_network_dependency === 'boolean' ? known(med.referral_network_dependency, 'medical.referral_network_dependency') : unknownField(),
      licensing_dependency: pickStrField(med, ['licensing_dependency', 'certificate_of_need']),
      specialized_ti_replacement_cost: med.specialized_ti_replacement_cost != null ? known(med.specialized_ti_replacement_cost, 'medical.specialized_ti_replacement_cost') : unknownField(),
      conversion_cost_to_office: med.conversion_cost_to_office != null ? known(med.conversion_cost_to_office, 'medical.conversion_cost_to_office') : unknownField(),
    } : null,

    debt: buildOfficeDebt(debt, row),
  };

  contract.completeness = scoreCompleteness(contract);
  return contract;
}

/** Commercial debt sub-contract (mission §20: distinct commercial debt). */
function buildOfficeDebt(debt = {}, row = {}) {
  const f = (v, source, basis = EVIDENCE_BASIS.OWNER_REPORTED) => (num(v) === null && typeof v !== 'boolean' && !clean(v) ? unknownField() : provField(typeof v === 'boolean' ? v : (num(v) ?? v), { basis, source }));
  return {
    loan_balance: f(debt.balance ?? row.total_loan_balance, debt.balance != null ? 'debt.balance' : 'properties.total_loan_balance'),
    monthly_payment: f(debt.monthly_payment ?? row.total_loan_payment, debt.monthly_payment != null ? 'debt.monthly_payment' : 'properties.total_loan_payment'),
    interest_rate: f(debt.interest_rate, 'debt.interest_rate'),
    maturity_date: f(debt.maturity_date, 'debt.maturity_date'),
    balloon_months: f(debt.balloon_months, 'debt.balloon_months'),
    interest_only_months: f(debt.interest_only_months, 'debt.interest_only_months'),
    amortization_months: f(debt.amortization_months, 'debt.amortization_months'),
    assumable: f(debt.assumable, 'debt.assumable'),
    recourse: f(debt.recourse, 'debt.recourse'),
    rate_resets: f(debt.rate_resets, 'debt.rate_resets'),
    covenants: Array.isArray(debt.covenants) && debt.covenants.length ? provField(debt.covenants, { basis: EVIDENCE_BASIS.OWNER_REPORTED, source: 'debt.covenants' }) : unknownField(),
  };
}

/* -------------------------------------------------------------------------- */
/* Rent-roll normalization (§6)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Normalize the office rent roll by suite/tenant. With a real lease list, returns
 * rentable/occupied area, physical/leased/economic occupancy, annualized base
 * rent, reimbursements, in-place vs market rent/RSF, loss to lease, tenant &
 * top-five concentration, industry concentration, rollover-by-year, WALE/WALT,
 * weighted escalation, near-term rollover, sublease vacancy and unknown-credit
 * exposure. With ONLY building-level totals it returns a BUILDING_LEVEL summary
 * and does NOT synthesize per-suite precision.
 */
export function buildRentRoll(row = {}, office = {}) {
  const leases = Array.isArray(office.leases) ? office.leases : null;
  const rba = num(office.rentable_building_area) ?? num(row.rentable_building_area) ?? num(row.building_square_feet);
  const marketRentPsf = num(office.operations?.market_rent_psf ?? office.income?.market_rent_psf);
  const isMedical = office._isMedical === true;
  const tenancyHint = (num(office.number_of_suites) ?? num(row.number_of_suites) ?? 0) >= 2 ? 'MULTI_TENANT' : 'SINGLE_TENANT';

  if (!leases || !leases.length) {
    return {
      basis: 'BUILDING_LEVEL',
      leases: null,
      total_suites: num(office.number_of_suites) ?? num(row.number_of_suites),
      total_rentable_area: rba !== null ? roundMoney(rba) : null,
      occupied_area: null,
      vacant_area: null,
      physical_occupancy: null,
      leased_occupancy: null,
      economic_occupancy: null,
      annualized_base_rent: null,
      reimbursement_income: null,
      in_place_rent_psf: null,
      market_rent_psf: marketRentPsf,
      loss_to_lease_annual: null,
      tenant_concentration: null,
      top_five_share: null,
      industry_concentration: null,
      unknown_credit_share: null,
      wale_years: null,
      walt_years: null,
      weighted_escalation: null,
      rollover_by_year: null,
      near_term_rollover_12m_rsf: null,
      sublease_vacancy_rsf: num(office.operations?.sublease_vacancy),
      confidence: 15,
      missing: ['lease_list', 'suite_level_rents', 'lease_expirations'],
      note: 'Building-level only — suite-level rent-roll precision is unknown and not synthesized.',
    };
  }

  const normalized = leases.map((l) => normalizeLease(l, { asOfYear: 2026, marketRentPerRsf: marketRentPsf, isMedical, tenancy: tenancyHint }));
  // Coworking-license rows are occupancy but NOT durable lease income.
  const occupied = normalized.filter((l) => (l.annual_base_rent ?? 0) > 0 || l.is_coworking_license || l.tenant_name);
  const incomeLeases = normalized.filter((l) => (l.annual_base_rent ?? 0) > 0);
  const occupiedRsf = sumNums(occupied.map((l) => l.rentable_square_feet));
  const totalRsf = rba ?? sumNums(normalized.map((l) => l.rentable_square_feet));
  const vacantRsf = totalRsf !== null && occupiedRsf !== null ? Math.max(0, roundMoney(totalRsf - occupiedRsf)) : null;
  const physicalOccupancy = totalRsf && occupiedRsf !== null ? round(occupiedRsf / totalRsf, 4) : null;
  // Leased occupancy includes signed-but-not-occupied; absent that input it equals physical.
  const leasedRsf = sumNums(normalized.filter((l) => l.tenant_name).map((l) => l.rentable_square_feet));
  const leasedOccupancy = totalRsf && leasedRsf !== null ? round(leasedRsf / totalRsf, 4) : physicalOccupancy;

  const annualizedBaseRent = sumNums(incomeLeases.map((l) => l.annual_base_rent));
  const reimbursementIncome = sumNums(occupied.map((l) => l.reimbursement_structure?.annual_reimbursement_income));
  const inPlaceRentPsf = (() => {
    const rsfForRent = sumNums(incomeLeases.map((l) => l.rentable_square_feet));
    return rsfForRent && annualizedBaseRent !== null ? round(annualizedBaseRent / rsfForRent, 2) : null;
  })();
  const lossToLease = marketRentPsf !== null && occupiedRsf !== null && inPlaceRentPsf !== null
    ? roundMoney((marketRentPsf - inPlaceRentPsf) * occupiedRsf) : null;

  // Tenant concentration: largest tenant share of RSF, top-five share.
  const byRsf = [...occupied].filter((l) => (l.rentable_square_feet ?? 0) > 0).sort((a, b) => (b.rentable_square_feet ?? 0) - (a.rentable_square_feet ?? 0));
  const tenantConcentration = byRsf.length && totalRsf ? round((byRsf[0].rentable_square_feet ?? 0) / totalRsf, 4) : null;
  const topFiveShare = byRsf.length && totalRsf ? round(sumNums(byRsf.slice(0, 5).map((l) => l.rentable_square_feet)) / totalRsf, 4) : null;

  // Industry concentration (largest industry share of occupied RSF).
  const industryConcentration = computeIndustryConcentration(occupied, totalRsf);

  // Credit roster + unknown-credit exposure.
  const credit = occupied.map((l) => ({
    tenant: l.tenant_name,
    ...(isMedical ? classifyMedicalTenantCredit({ tenant_name: l.tenant_name, guaranty: l.guaranty }) : classifyTenantCredit({ tenant_name: l.tenant_name, guaranty: l.guaranty, industry: l.industry })),
  }));
  const unknownCreditRsf = sumNums(occupied.filter((l, i) => {
    const cc = credit[i]?.credit_class ?? 'UNKNOWN';
    return cc === 'UNKNOWN' || cc === 'UNKNOWN_MEDICAL' || cc === 'LOCAL_PROFESSIONAL' || cc === 'INDIVIDUAL_PRACTICE';
  }).map((l) => l.rentable_square_feet));
  const unknownCreditShare = unknownCreditRsf !== null && totalRsf ? round(unknownCreditRsf / totalRsf, 4) : null;

  // WALE / WALT (by RSF and by base rent).
  const wale = weightedAvg(incomeLeases.map((l) => [l.remaining_term_years, l.rentable_square_feet]));
  const walt = weightedAvg(incomeLeases.map((l) => [l.remaining_term_years, l.annual_base_rent]));
  const weightedEscalation = weightedAvg(incomeLeases.map((l) => [l.annual_escalation_pct, l.annual_base_rent]));

  // Rollover by year.
  const rolloverByYear = {};
  for (const l of incomeLeases) {
    const yr = l.remaining_term_years;
    if (yr === null) continue;
    const bucket = yr <= 1 ? '0-1' : yr <= 2 ? '1-2' : yr <= 3 ? '2-3' : yr <= 5 ? '3-5' : '5+';
    rolloverByYear[bucket] = roundMoney((rolloverByYear[bucket] ?? 0) + (l.rentable_square_feet ?? 0));
  }
  const nearTerm12mRsf = sumNums(incomeLeases.filter((l) => l.remaining_term_years !== null && l.remaining_term_years <= 1).map((l) => l.rentable_square_feet));

  const missing = [];
  if (marketRentPsf === null) missing.push('market_rent_psf');
  if (normalized.some((l) => l.missing_inputs.includes('lease_expiration_or_remaining_term'))) missing.push('lease_expirations');

  return {
    basis: 'LEASE_LEVEL',
    leases: normalized,
    credit,
    total_suites: normalized.length,
    occupied_suites: occupied.length,
    vacant_suites: normalized.length - occupied.length,
    coworking_license_count: normalized.filter((l) => l.is_coworking_license).length,
    total_rentable_area: totalRsf !== null ? roundMoney(totalRsf) : null,
    occupied_area: occupiedRsf !== null ? roundMoney(occupiedRsf) : null,
    vacant_area: vacantRsf,
    physical_occupancy: physicalOccupancy,
    leased_occupancy: leasedOccupancy,
    economic_occupancy: num(office.operations?.economic_occupancy),
    annualized_base_rent: annualizedBaseRent,
    reimbursement_income: reimbursementIncome,
    in_place_rent_psf: inPlaceRentPsf,
    market_rent_psf: marketRentPsf,
    loss_to_lease_annual: lossToLease,
    tenant_concentration: tenantConcentration,
    tenant_concentration_high: tenantConcentration !== null && tenantConcentration >= CONC.single_tenant_high_share,
    top_five_share: topFiveShare,
    industry_concentration: industryConcentration,
    industry_concentration_high: industryConcentration?.share !== undefined && industryConcentration.share !== null && industryConcentration.share >= CONC.industry_high_share,
    unknown_credit_share: unknownCreditShare,
    wale_years: wale,
    walt_years: walt,
    weighted_escalation: weightedEscalation,
    rollover_by_year: rolloverByYear,
    near_term_rollover_12m_rsf: nearTerm12mRsf,
    sublease_vacancy_rsf: num(office.operations?.sublease_vacancy),
    confidence: 70,
    missing: [...new Set(missing)],
  };
}

function computeIndustryConcentration(occupied, totalRsf) {
  const byIndustry = new Map();
  let withIndustry = 0;
  for (const l of occupied) {
    if (!l.industry) continue;
    withIndustry += 1;
    byIndustry.set(l.industry, (byIndustry.get(l.industry) ?? 0) + (l.rentable_square_feet ?? 0));
  }
  if (!withIndustry || !totalRsf) return { industry: null, share: null, note: 'industry_unknown' };
  let topIndustry = null;
  let topRsf = -1;
  for (const [ind, rsf] of byIndustry) { if (rsf > topRsf) { topRsf = rsf; topIndustry = ind; } }
  return { industry: topIndustry, share: round(topRsf / totalRsf, 4) };
}

function sumNums(arr) {
  const present = (arr ?? []).filter((v) => v !== null && v !== undefined);
  return present.length ? present.reduce((s, v) => s + v, 0) : null;
}

function weightedAvg(pairs) {
  let wsum = 0;
  let weight = 0;
  for (const [v, w] of pairs) {
    if (v === null || v === undefined || w === null || w === undefined) continue;
    wsum += v * w;
    weight += w;
  }
  return weight > 0 ? round(wsum / weight, 2) : null;
}

/** Fraction (0..100) of material office fields that carry real evidence. */
function scoreCompleteness(contract) {
  const material = [
    contract.physical.rentable_building_area, contract.physical.suite_count,
    contract.physical.floor_count, contract.physical.parking_spaces,
    contract.operations.physical_occupancy, contract.operations.in_place_rent_psf,
    contract.income.base_rental_income, contract.expenses.total_operating_expenses,
    contract.physical.gross_building_area, contract.identity.year_built,
  ];
  const knownCount = material.filter((f) => isKnown(f)).length;
  return Math.round((knownCount / material.length) * 100);
}

/** List the UNKNOWN material fields for explainability. */
export function officeMissingInputs(contract) {
  const out = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v && typeof v === 'object' && 'basis' in v) {
        if (!isKnown(v)) out.push(`${prefix}${k}`);
      }
    }
  };
  walk(contract.physical, 'physical.');
  walk(contract.operations, 'operations.');
  walk(contract.income, 'income.');
  walk(contract.expenses, 'expenses.');
  if (contract.medical) walk(contract.medical, 'medical.');
  return out;
}

export { OFFICE_STABILIZED_OCCUPANCY };
