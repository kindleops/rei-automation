/**
 * Acquisition Engine V3 — Item 5E §3 & §6: canonical retail subject contract +
 * deterministic rent-roll normalization.
 *
 * Layered ON TOP of the canonical income-snapshot provenance primitives
 * (incomeSnapshotContract.js) so every retail field carries value, source, source
 * record, date, confidence, evidence basis, validation, conflict and freshness. A
 * missing value is UNKNOWN, never zero. Suite-level precision is NEVER fabricated
 * from a building-level total (mission §6).
 *
 * Pure & deterministic — no I/O, no Date.now, no randomness.
 */

import { num, clean, round, roundMoney } from './modelConstants.js';
import {
  EVIDENCE_BASIS, VALIDATION_STATUS, provField, unknownField, isKnown,
} from './incomeSnapshotContract.js';
import { classifyRetailAsset } from './retailClassification.js';
import { normalizeLease, classifyTenantCredit } from './retailLeaseModel.js';
import { RETAIL_CONCENTRATION as CONC, RETAIL_STABILIZED_OCCUPANCY } from './retailConstants.js';

/** Shorthand: a KNOWN provField from an explicit input. */
function known(value, source, basis = EVIDENCE_BASIS.ACTUAL, extra = {}) {
  const v = num(value);
  if (v === null && typeof value !== 'boolean' && !clean(value)) return unknownField();
  return provField(typeof value === 'boolean' ? value : (v ?? value), {
    basis, source, validation_status: VALIDATION_STATUS.UNVALIDATED, ...extra,
  });
}

/** First present numeric among keys → provField with that key as source. */
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
 * Build the canonical retail subject contract.
 *
 * @param {object} row       raw subject property row
 * @param {object} [retail]  structured retail inputs (overrides row):
 *   { leases, operations, income, expenses, anchor, ground_lease, debt, ... }
 */
export function buildRetailContract(row = {}, retail = {}) {
  const cls = classifyRetailAsset(row);
  const ops = retail.operations ?? {};
  const income = retail.income ?? {};
  const exp = retail.expenses ?? {};
  const anchor = retail.anchor ?? {};
  const gl = retail.ground_lease ?? {};
  const debt = retail.debt ?? {};

  // ---- Physical size: GLA observed, else building area (labeled) ----
  const gbaField = pickField(row, ['gross_building_area', 'building_square_feet', 'sqft']);
  let glaField = retail.gross_leasable_area != null
    ? known(retail.gross_leasable_area, 'retail_inputs.gross_leasable_area', EVIDENCE_BASIS.VERIFIED_DOCUMENT)
    : pickField(row, ['gross_leasable_area', 'net_rentable_area', 'leasable_square_feet']);
  if (!isKnown(glaField) && isKnown(gbaField)) {
    // GLA modeled from GBA at a labeled efficiency (retail GLA ≈ 0.95 of GBA).
    glaField = provField(roundMoney(num(gbaField.value) * 0.95), {
      basis: EVIDENCE_BASIS.MARKET_MODELED, confidence: 30,
      source: 'modeled_gla=0.95*gba', validation_status: VALIDATION_STATUS.UNVALIDATED,
    });
  }

  const rentRoll = buildRentRoll(row, retail);

  const contract = {
    lane: cls.lane,
    is_retail: cls.is_retail,
    genuine_retail: cls.genuine_retail,
    subtype: cls.subtype,
    classification: cls,

    identity: {
      property_id: row.property_id ?? row.id ?? null,
      canonical_asset_lane: cls.lane,
      retail_subtype: provField(cls.subtype, { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, confidence: cls.confidence, source: 'retailClassification' }),
      center_type: pickStrField(row, ['center_type']),
      tenancy_structure: unknownField(), // resolved by classifyRetailTenancy
      operational_status: unknownField(), // resolved by classifyRetailOperationalStatus
      owner_occupied: typeof row.owner_occupied === 'boolean' ? known(row.owner_occupied, 'properties.owner_occupied') : unknownField(),
      year_built: pickField(row, ['year_built']),
      renovation_year: pickField(row, ['renovation_year', 'year_renovated']),
      condition: pickStrField(row, ['condition', 'property_condition']),
      zoning: pickStrField(row, ['zoning']),
      redevelopment_potential: typeof retail.redevelopment_potential === 'boolean' ? known(retail.redevelopment_potential, 'retail_inputs.redevelopment_potential') : unknownField(),
    },

    physical: {
      gross_building_area: gbaField,
      gross_leasable_area: glaField,
      net_rentable_area: retail.net_rentable_area != null ? known(retail.net_rentable_area, 'retail_inputs.net_rentable_area', EVIDENCE_BASIS.VERIFIED_DOCUMENT) : pickField(row, ['net_rentable_area']),
      land_area: pickField(row, ['lot_square_feet', 'land_sqft', 'lot_size_sqft']),
      number_of_buildings: pickField(row, ['number_of_buildings', 'building_count']),
      number_of_suites: retail.number_of_suites != null ? known(retail.number_of_suites, 'retail_inputs.number_of_suites') : pickField(row, ['number_of_suites', 'suite_count', 'strip_center_units']),
      parking_spaces: pickField(row, ['parking_spaces', 'parking_count']),
      parking_ratio: retail.parking_ratio != null ? known(retail.parking_ratio, 'retail_inputs.parking_ratio') : unknownField(),
      frontage: retail.frontage != null ? known(retail.frontage, 'retail_inputs.frontage') : unknownField(),
      visibility: pickStrField(row, ['visibility']),
      access_points: retail.access_points != null ? known(retail.access_points, 'retail_inputs.access_points') : unknownField(),
      signalized_access: typeof retail.signalized_access === 'boolean' ? known(retail.signalized_access, 'retail_inputs.signalized_access') : unknownField(),
      pylon_signage: typeof retail.pylon_signage === 'boolean' ? known(retail.pylon_signage, 'retail_inputs.pylon_signage') : unknownField(),
      drive_through: typeof retail.drive_through === 'boolean' ? known(retail.drive_through, 'retail_inputs.drive_through') : unknownField(),
      loading_areas: retail.loading_areas != null ? known(retail.loading_areas, 'retail_inputs.loading_areas') : unknownField(),
    },

    rent_roll: rentRoll,

    operations: {
      physical_occupancy: occField(ops.physical_occupancy ?? rentRoll.physical_occupancy, ops.physical_occupancy != null ? 'operations.physical_occupancy' : 'rent_roll.physical_occupancy'),
      economic_occupancy: occField(ops.economic_occupancy ?? rentRoll.economic_occupancy, 'operations.economic_occupancy'),
      in_place_rent_psf: income.in_place_rent_psf != null ? known(income.in_place_rent_psf, 'income.in_place_rent_psf', EVIDENCE_BASIS.ACTUAL) : (rentRoll.in_place_rent_psf != null ? provField(rentRoll.in_place_rent_psf, { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, source: 'rent_roll', confidence: 50 }) : unknownField()),
      market_rent_psf: income.market_rent_psf != null ? known(income.market_rent_psf, 'income.market_rent_psf', EVIDENCE_BASIS.COMPARABLE_DERIVED) : unknownField(),
      delinquency: ops.delinquency != null ? known(ops.delinquency, 'operations.delinquency') : unknownField(),
      bad_debt: income.bad_debt != null ? known(income.bad_debt, 'income.bad_debt') : unknownField(),
      concessions: income.concessions != null ? known(income.concessions, 'income.concessions') : unknownField(),
      dark_gla: ops.dark_gla != null ? known(ops.dark_gla, 'operations.dark_gla') : unknownField(),
      cam_reconciliation_status: pickStrField(ops, ['cam_reconciliation_status']),
    },

    income: {
      base_rental_income: actualMoney(income.base_rental_income, 'income.base_rental_income'),
      cam_reimbursement_income: actualMoney(income.cam_reimbursement_income, 'income.cam_reimbursement_income'),
      tax_reimbursement_income: actualMoney(income.tax_reimbursement_income, 'income.tax_reimbursement_income'),
      insurance_reimbursement_income: actualMoney(income.insurance_reimbursement_income, 'income.insurance_reimbursement_income'),
      percentage_rent_income: actualMoney(income.percentage_rent_income, 'income.percentage_rent_income'),
      other_income: actualMoney(income.other_income, 'income.other_income'),
      gross_potential_revenue: actualMoney(income.gross_potential_revenue, 'income.gross_potential_revenue'),
      effective_gross_revenue: actualMoney(income.effective_gross_revenue, 'income.effective_gross_revenue'),
    },

    expenses: {
      property_taxes: actualMoney(exp.property_taxes ?? row.tax_amt, exp.property_taxes != null ? 'expenses.property_taxes' : 'properties.tax_amt'),
      insurance: actualMoney(exp.insurance, 'expenses.insurance'),
      cam: actualMoney(exp.cam, 'expenses.cam'),
      repairs_maintenance: actualMoney(exp.repairs_maintenance ?? exp.repairs, 'expenses.repairs_maintenance'),
      common_utilities: actualMoney(exp.common_utilities ?? exp.utilities, 'expenses.common_utilities'),
      landscaping_parking: actualMoney(exp.landscaping_parking, 'expenses.landscaping_parking'),
      management: actualMoney(exp.management, 'expenses.management'),
      administrative: actualMoney(exp.administrative, 'expenses.administrative'),
      marketing: actualMoney(exp.marketing, 'expenses.marketing'),
      professional_fees: actualMoney(exp.professional_fees, 'expenses.professional_fees'),
      non_recoverable: actualMoney(exp.non_recoverable, 'expenses.non_recoverable'),
      replacement_reserves: actualMoney(exp.replacement_reserves ?? exp.reserves, 'expenses.replacement_reserves'),
      total_operating_expenses: actualMoney(exp.total_operating_expenses, 'expenses.total_operating_expenses'),
    },

    anchor: {
      anchor_tenant: pickStrField(anchor, ['anchor_tenant', 'name']),
      anchor_owned_on_parcel: typeof anchor.owned_on_parcel === 'boolean' ? known(anchor.owned_on_parcel, 'anchor.owned_on_parcel') : unknownField(),
      anchor_lease_expiration: anchor.lease_expiration != null ? known(anchor.lease_expiration, 'anchor.lease_expiration') : unknownField(),
      shadow_anchor: typeof anchor.shadow_anchor === 'boolean' ? known(anchor.shadow_anchor, 'anchor.shadow_anchor') : unknownField(),
      co_tenancy_clauses: typeof anchor.co_tenancy === 'boolean' ? known(anchor.co_tenancy, 'anchor.co_tenancy') : unknownField(),
      kick_out_rights: typeof anchor.kick_out === 'boolean' ? known(anchor.kick_out, 'anchor.kick_out') : unknownField(),
    },

    ground_lease: {
      is_ground_lease: typeof gl.is_ground_lease === 'boolean' ? known(gl.is_ground_lease, 'ground_lease.is_ground_lease') : unknownField(),
      ground_rent_annual: gl.ground_rent_annual != null ? known(gl.ground_rent_annual, 'ground_lease.ground_rent_annual') : unknownField(),
      ground_lease_term_years: gl.term_years != null ? known(gl.term_years, 'ground_lease.term_years') : unknownField(),
      ground_escalation_pct: gl.escalation_pct != null ? known(gl.escalation_pct, 'ground_lease.escalation_pct') : unknownField(),
      subordinated: typeof gl.subordinated === 'boolean' ? known(gl.subordinated, 'ground_lease.subordinated') : unknownField(),
      reversion_year: gl.reversion_year != null ? known(gl.reversion_year, 'ground_lease.reversion_year') : unknownField(),
    },

    debt: buildRetailDebt(debt, row),
  };

  contract.completeness = scoreCompleteness(contract);
  return contract;
}

/** Commercial debt sub-contract (mission §20: distinct commercial debt). */
function buildRetailDebt(debt = {}, row = {}) {
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
 * Normalize the rent roll by suite/tenant. With a real lease list, returns
 * occupied/vacant GLA, physical/economic occupancy, annualized base rent,
 * reimbursements, in-place vs market rent/SF, loss to lease, tenant & top-five
 * concentration, rollover-by-year, WALE/WALT, weighted escalation, near-term
 * rollover and dark-space exposure. With ONLY building-level totals it returns a
 * BUILDING_LEVEL summary and does NOT synthesize per-suite precision.
 */
export function buildRentRoll(row = {}, retail = {}) {
  const leases = Array.isArray(retail.leases) ? retail.leases : null;
  const gla = num(retail.gross_leasable_area) ?? num(row.gross_leasable_area) ?? num(row.building_square_feet);
  const marketRentPsf = num(retail.operations?.market_rent_psf ?? retail.income?.market_rent_psf);

  if (!leases || !leases.length) {
    return {
      basis: 'BUILDING_LEVEL',
      leases: null,
      total_suites: num(retail.number_of_suites) ?? num(row.number_of_suites) ?? num(row.strip_center_units),
      total_gla: gla !== null ? roundMoney(gla) : null,
      occupied_gla: null,
      vacant_gla: null,
      physical_occupancy: null,
      economic_occupancy: null,
      annualized_base_rent: null,
      reimbursement_income: null,
      in_place_rent_psf: null,
      market_rent_psf: marketRentPsf,
      loss_to_lease_annual: null,
      tenant_concentration: null,
      top_five_share: null,
      wale_years: null,
      walt_years: null,
      weighted_escalation: null,
      rollover_by_year: null,
      near_term_rollover_12m_gla: null,
      dark_gla: num(retail.operations?.dark_gla),
      confidence: 15,
      missing: ['lease_list', 'suite_level_rents', 'lease_expirations'],
      note: 'Building-level only — suite-level rent-roll precision is unknown and not synthesized.',
    };
  }

  const normalized = leases.map((l) => normalizeLease(l, { asOfYear: 2026, marketRentPerSf: marketRentPsf }));
  const occupied = normalized.filter((l) => (l.annual_base_rent ?? 0) > 0 || l.tenant_name);
  const occupiedGla = sumNums(occupied.map((l) => l.leased_square_feet));
  const totalGla = gla ?? sumNums(normalized.map((l) => l.leased_square_feet));
  const vacantGla = totalGla !== null && occupiedGla !== null ? Math.max(0, roundMoney(totalGla - occupiedGla)) : null;
  const physicalOccupancy = totalGla && occupiedGla !== null ? round(occupiedGla / totalGla, 4) : null;

  const annualizedBaseRent = sumNums(occupied.map((l) => l.annual_base_rent));
  const reimbursementIncome = sumNums(occupied.map((l) => l.reimbursement_structure?.annual_reimbursement_income));
  const inPlaceRentPsf = occupiedGla && annualizedBaseRent !== null ? round(annualizedBaseRent / occupiedGla, 2) : null;
  const lossToLease = marketRentPsf !== null && occupiedGla !== null && inPlaceRentPsf !== null
    ? roundMoney((marketRentPsf - inPlaceRentPsf) * occupiedGla) : null;

  // Tenant concentration: largest tenant share of GLA, top-five share.
  const byGla = [...occupied].filter((l) => (l.leased_square_feet ?? 0) > 0).sort((a, b) => (b.leased_square_feet ?? 0) - (a.leased_square_feet ?? 0));
  const tenantConcentration = byGla.length && totalGla ? round((byGla[0].leased_square_feet ?? 0) / totalGla, 4) : null;
  const topFiveShare = byGla.length && totalGla ? round(sumNums(byGla.slice(0, 5).map((l) => l.leased_square_feet)) / totalGla, 4) : null;

  // WALE / WALT (by GLA and by base rent).
  const wale = weightedAvg(occupied.map((l) => [l.remaining_term_years, l.leased_square_feet]));
  const walt = weightedAvg(occupied.map((l) => [l.remaining_term_years, l.annual_base_rent]));
  const weightedEscalation = weightedAvg(occupied.map((l) => [l.annual_escalation_pct, l.annual_base_rent]));

  // Rollover by year.
  const rolloverByYear = {};
  for (const l of occupied) {
    const yr = l.remaining_term_years;
    if (yr === null) continue;
    const bucket = yr <= 1 ? '0-1' : yr <= 2 ? '1-2' : yr <= 3 ? '2-3' : yr <= 5 ? '3-5' : '5+';
    rolloverByYear[bucket] = roundMoney((rolloverByYear[bucket] ?? 0) + (l.leased_square_feet ?? 0));
  }
  const nearTerm12mGla = sumNums(occupied.filter((l) => l.remaining_term_years !== null && l.remaining_term_years <= 1).map((l) => l.leased_square_feet));
  const darkGla = num(retail.operations?.dark_gla) ?? sumNums(occupied.filter((l) => l.tenant_name && l.gone_dark === true).map((l) => l.leased_square_feet));

  const missing = [];
  if (marketRentPsf === null) missing.push('market_rent_psf');
  if (normalized.some((l) => l.missing_inputs.includes('lease_expiration_or_remaining_term'))) missing.push('lease_expirations');

  return {
    basis: 'LEASE_LEVEL',
    leases: normalized,
    credit: occupied.map((l) => ({ tenant: l.tenant_name, ...classifyTenantCredit({ tenant_name: l.tenant_name, guaranty: l.guaranty }) })),
    total_suites: normalized.length,
    occupied_suites: occupied.length,
    vacant_suites: normalized.length - occupied.length,
    total_gla: totalGla !== null ? roundMoney(totalGla) : null,
    occupied_gla: occupiedGla !== null ? roundMoney(occupiedGla) : null,
    vacant_gla: vacantGla,
    physical_occupancy: physicalOccupancy,
    economic_occupancy: num(retail.operations?.economic_occupancy),
    annualized_base_rent: annualizedBaseRent,
    reimbursement_income: reimbursementIncome,
    in_place_rent_psf: inPlaceRentPsf,
    market_rent_psf: marketRentPsf,
    loss_to_lease_annual: lossToLease,
    tenant_concentration: tenantConcentration,
    tenant_concentration_high: tenantConcentration !== null && tenantConcentration >= CONC.single_tenant_high_share,
    top_five_share: topFiveShare,
    wale_years: wale,
    walt_years: walt,
    weighted_escalation: weightedEscalation,
    rollover_by_year: rolloverByYear,
    near_term_rollover_12m_gla: nearTerm12mGla,
    dark_gla: darkGla,
    confidence: 70,
    missing: [...new Set(missing)],
  };
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

/** Fraction (0..100) of material retail fields that carry real evidence. */
function scoreCompleteness(contract) {
  const material = [
    contract.physical.gross_leasable_area, contract.physical.number_of_suites,
    contract.operations.physical_occupancy, contract.operations.in_place_rent_psf,
    contract.income.base_rental_income, contract.expenses.total_operating_expenses,
    contract.physical.gross_building_area, contract.identity.year_built,
  ];
  const knownCount = material.filter((f) => isKnown(f)).length;
  return Math.round((knownCount / material.length) * 100);
}

/** List the UNKNOWN material fields for explainability. */
export function retailMissingInputs(contract) {
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
  return out;
}

export { RETAIL_STABILIZED_OCCUPANCY };
