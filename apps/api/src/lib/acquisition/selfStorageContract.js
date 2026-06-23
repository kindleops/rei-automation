/**
 * Acquisition Engine V3 — Item 5D §2 & §4: canonical self-storage subject
 * contract + deterministic unit-mix normalization.
 *
 * Layered ON TOP of the canonical income-snapshot provenance primitives
 * (incomeSnapshotContract.js) so every storage field carries value, source,
 * source record, date, confidence, evidence basis, validation, conflict and
 * freshness. A missing value is UNKNOWN, never zero. NRSF is never fabricated
 * with false precision; when only GBA is known it is MODELED and labeled.
 *
 * Pure & deterministic — no I/O, no Date.now, no randomness.
 */

import { num, clean, round, roundMoney } from './modelConstants.js';
import {
  EVIDENCE_BASIS, VALIDATION_STATUS, provField, unknownField, isKnown,
} from './incomeSnapshotContract.js';
import {
  STORAGE_FACILITY_TYPE as FT,
  STORAGE_NRSF_EFFICIENCY,
} from './selfStorageConstants.js';
import {
  classifySelfStorageFacility,
  classifyStorageFacilityClass,
} from './selfStorageClassification.js';

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

/**
 * Build the canonical self-storage subject contract.
 *
 * @param {object} row              raw subject property row
 * @param {object} [storage]        structured storage inputs (overrides row):
 *   { unit_roll, unit_mix, operations, income, expenses, development, debt, ... }
 * @returns {object} storage contract (sections: identity/physical/unit_inventory/
 *   operations/income/expenses/development/debt) + unit_mix normalization.
 */
export function buildSelfStorageContract(row = {}, storage = {}) {
  const cls = classifySelfStorageFacility(row);
  const facilityClass = classifyStorageFacilityClass(row);
  const ops = storage.operations ?? {};
  const income = storage.income ?? {};
  const exp = storage.expenses ?? {};
  const dev = storage.development ?? {};
  const debt = storage.debt ?? {};

  // ---- Physical size: NRSF observed, else MODELED from GBA (labeled) ----
  const gbaField = pickField(row, ['gross_building_area', 'building_square_feet', 'sqft']);
  let nrsfField = storage.net_rentable_square_feet != null
    ? known(storage.net_rentable_square_feet, 'storage_inputs.net_rentable_square_feet', EVIDENCE_BASIS.VERIFIED_DOCUMENT)
    : pickField(row, ['net_rentable_square_feet', 'rentable_square_feet']);
  if (!isKnown(nrsfField) && isKnown(gbaField)) {
    const eff = STORAGE_NRSF_EFFICIENCY[cls.facility_type] ?? STORAGE_NRSF_EFFICIENCY.UNKNOWN;
    nrsfField = provField(roundMoney(num(gbaField.value) * eff), {
      basis: EVIDENCE_BASIS.MARKET_MODELED, confidence: 30,
      source: `modeled_nrsf=${eff}*gba`, validation_status: VALIDATION_STATUS.UNVALIDATED,
    });
  }

  const contract = {
    lane: cls.lane,
    is_self_storage: cls.is_self_storage,
    genuine_facility: cls.genuine_facility,
    classification: cls,

    identity: {
      property_id: row.property_id ?? row.id ?? null,
      canonical_asset_lane: cls.lane,
      facility_type: provField(cls.facility_type, { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, confidence: cls.confidence, source: 'selfStorageClassification' }),
      operational_status: unknownField(), // resolved by classifyStorageOperationalStatus
      facility_class: provField(facilityClass, { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, confidence: 30, source: 'facility_class_heuristic' }),
      number_of_buildings: pickField(row, ['number_of_buildings', 'building_count']),
      year_built: pickField(row, ['year_built']),
      expansion_years: storage.expansion_years ? provField(storage.expansion_years, { basis: EVIDENCE_BASIS.OWNER_REPORTED, source: 'storage_inputs.expansion_years' }) : unknownField(),
    },

    physical: {
      gross_building_square_feet: gbaField,
      net_rentable_square_feet: nrsfField,
      land_area: pickField(row, ['lot_square_feet', 'land_sqft', 'lot_size_sqft']),
      improved_area: storage.improved_area != null ? known(storage.improved_area, 'storage_inputs.improved_area') : unknownField(),
      expansion_area: dev.expansion_area != null ? known(dev.expansion_area, 'development.expansion_area') : unknownField(),
      paved_area: storage.paved_area != null ? known(storage.paved_area, 'storage_inputs.paved_area') : unknownField(),
      number_of_floors: pickField(row, ['number_of_floors', 'stories']),
      elevator_service: typeof storage.elevator_service === 'boolean' ? known(storage.elevator_service, 'storage_inputs.elevator_service') : unknownField(),
      drive_up_access: typeof storage.drive_up_access === 'boolean' ? known(storage.drive_up_access, 'storage_inputs.drive_up_access') : unknownField(),
      climate_control_percentage: ops.climate_control_percentage != null ? known(ops.climate_control_percentage, 'operations.climate_control_percentage') : unknownField(),
      office_area: storage.office_area != null ? known(storage.office_area, 'storage_inputs.office_area') : unknownField(),
      manager_unit: typeof storage.manager_unit === 'boolean' ? known(storage.manager_unit, 'storage_inputs.manager_unit') : unknownField(),
      frontage: storage.frontage != null ? known(storage.frontage, 'storage_inputs.frontage') : unknownField(),
      visibility: pickStrField(row, ['visibility']),
      ingress_egress: pickStrField(row, ['ingress_egress', 'access']),
      security_features: storage.security_features ? provField(storage.security_features, { basis: EVIDENCE_BASIS.OWNER_REPORTED, source: 'storage_inputs.security_features' }) : unknownField(),
      gate_access: typeof storage.gate_access === 'boolean' ? known(storage.gate_access, 'storage_inputs.gate_access') : unknownField(),
      fire_suppression: typeof storage.fire_suppression === 'boolean' ? known(storage.fire_suppression, 'storage_inputs.fire_suppression') : unknownField(),
    },

    unit_inventory: buildUnitInventory(row, storage),

    operations: {
      physical_occupancy: occField(ops.physical_occupancy, 'operations.physical_occupancy'),
      economic_occupancy: occField(ops.economic_occupancy, 'operations.economic_occupancy'),
      average_in_place_rent: income.average_in_place_rent != null ? known(income.average_in_place_rent, 'income.average_in_place_rent', EVIDENCE_BASIS.ACTUAL) : unknownField(),
      average_street_rent: income.average_street_rent != null ? known(income.average_street_rent, 'income.average_street_rent', EVIDENCE_BASIS.LISTING_REPORTED) : unknownField(),
      average_market_rent: income.average_market_rent != null ? known(income.average_market_rent, 'income.average_market_rent', EVIDENCE_BASIS.COMPARABLE_DERIVED) : unknownField(),
      rent_per_occupied_square_foot: unknownField(), // derived in revenue model
      rent_per_available_square_foot: unknownField(),
      concessions: income.concessions != null ? known(income.concessions, 'income.concessions') : unknownField(),
      bad_debt: income.bad_debt != null ? known(income.bad_debt, 'income.bad_debt') : unknownField(),
      delinquency: ops.delinquency != null ? known(ops.delinquency, 'operations.delinquency') : unknownField(),
      tenant_turnover: ops.tenant_turnover != null ? known(ops.tenant_turnover, 'operations.tenant_turnover') : unknownField(),
      tenant_duration: ops.tenant_duration != null ? known(ops.tenant_duration, 'operations.tenant_duration') : unknownField(),
      autopay_penetration: ops.autopay_penetration != null ? known(ops.autopay_penetration, 'operations.autopay_penetration') : unknownField(),
    },

    income: {
      base_rental_income: actualMoney(income.base_rental_income, 'income.base_rental_income'),
      tenant_insurance_income: actualMoney(income.tenant_insurance_income, 'income.tenant_insurance_income'),
      administration_fees: actualMoney(income.administration_fees, 'income.administration_fees'),
      late_fees: actualMoney(income.late_fees, 'income.late_fees'),
      merchandise_income: actualMoney(income.merchandise_income, 'income.merchandise_income'),
      truck_rental_income: actualMoney(income.truck_rental_income, 'income.truck_rental_income'),
      other_income: actualMoney(income.other_income, 'income.other_income'),
      gross_potential_revenue: actualMoney(income.gross_potential_revenue, 'income.gross_potential_revenue'),
      effective_gross_revenue: actualMoney(income.effective_gross_revenue, 'income.effective_gross_revenue'),
    },

    expenses: {
      taxes: actualMoney(exp.taxes ?? row.tax_amt, exp.taxes != null ? 'expenses.taxes' : 'properties.tax_amt'),
      insurance: actualMoney(exp.insurance, 'expenses.insurance'),
      payroll: actualMoney(exp.payroll, 'expenses.payroll'),
      management: actualMoney(exp.management, 'expenses.management'),
      utilities: actualMoney(exp.utilities, 'expenses.utilities'),
      repairs: actualMoney(exp.repairs, 'expenses.repairs'),
      marketing: actualMoney(exp.marketing ?? exp.advertising, 'expenses.marketing'),
      software: actualMoney(exp.software, 'expenses.software'),
      security: actualMoney(exp.security, 'expenses.security'),
      landscaping_snow: actualMoney(exp.landscaping_snow, 'expenses.landscaping_snow'),
      professional_fees: actualMoney(exp.professional_fees, 'expenses.professional_fees'),
      administrative: actualMoney(exp.administrative, 'expenses.administrative'),
      reserves: actualMoney(exp.reserves, 'expenses.reserves'),
      total_operating_expenses: actualMoney(exp.total_operating_expenses, 'expenses.total_operating_expenses'),
    },

    development: {
      expansion_capacity_units: dev.expansion_capacity_units != null ? known(dev.expansion_capacity_units, 'development.expansion_capacity_units') : unknownField(),
      expansion_capacity_nrsf: dev.expansion_capacity_nrsf != null ? known(dev.expansion_capacity_nrsf, 'development.expansion_capacity_nrsf') : unknownField(),
      expansion_cost: dev.expansion_cost != null ? known(dev.expansion_cost, 'development.expansion_cost') : unknownField(),
      expansion_timeline: dev.expansion_timeline != null ? known(dev.expansion_timeline, 'development.expansion_timeline') : unknownField(),
      entitlement_status: pickStrField(row, ['entitlement_status']),
      zoning_status: pickStrField(row, ['zoning']),
      lease_up_period: dev.lease_up_period != null ? known(dev.lease_up_period, 'development.lease_up_period') : unknownField(),
      stabilized_occupancy: dev.stabilized_occupancy != null ? known(dev.stabilized_occupancy, 'development.stabilized_occupancy') : unknownField(),
      stabilized_revenue: dev.stabilized_revenue != null ? known(dev.stabilized_revenue, 'development.stabilized_revenue') : unknownField(),
    },

    debt: buildStorageDebt(debt, row),
  };

  contract.completeness = scoreCompleteness(contract);
  return contract;
}

/** Occupancy field: stored as a fraction 0..1; never coerces missing to 0. */
function occField(value, source) {
  const v = num(value);
  if (v === null) return unknownField();
  return provField(v > 1 ? round(v / 100, 4) : round(v, 4), { basis: EVIDENCE_BASIS.OWNER_REPORTED, source, confidence: 55 });
}

/** A money line that is KNOWN only when explicitly provided (else UNKNOWN, not 0). */
function actualMoney(value, source) {
  const v = num(value);
  return v === null ? unknownField() : provField(roundMoney(v), { basis: EVIDENCE_BASIS.ACTUAL, source });
}

/** Commercial debt sub-contract (mission §2: canonical commercial debt). */
function buildStorageDebt(debt = {}, row = {}) {
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
/* Unit inventory + mix normalization (§4)                                     */
/* -------------------------------------------------------------------------- */

function buildUnitInventory(row, storage) {
  const u = storage.unit_inventory ?? {};
  const totalUnits = num(u.total_units) ?? num(storage.total_units) ?? num(row.storage_units);
  const mix = normalizeUnitMix({
    unitRoll: storage.unit_roll,
    unitMix: storage.unit_mix ?? u.unit_mix,
    totalUnits,
    totalNrsf: num(storage.net_rentable_square_feet) ?? num(row.net_rentable_square_feet) ?? num(row.rentable_square_feet),
  });
  return {
    total_units: totalUnits === null ? unknownField() : known(totalUnits, 'unit_inventory.total_units'),
    rentable_units: u.rentable_units != null ? known(u.rentable_units, 'unit_inventory.rentable_units') : unknownField(),
    occupied_units: u.occupied_units != null ? known(u.occupied_units, 'unit_inventory.occupied_units') : unknownField(),
    vacant_units: u.vacant_units != null ? known(u.vacant_units, 'unit_inventory.vacant_units') : unknownField(),
    units_out_of_service: u.units_out_of_service != null ? known(u.units_out_of_service, 'unit_inventory.units_out_of_service') : unknownField(),
    climate_controlled_units: u.climate_controlled_units != null ? known(u.climate_controlled_units, 'unit_inventory.climate_controlled_units') : unknownField(),
    drive_up_units: u.drive_up_units != null ? known(u.drive_up_units, 'unit_inventory.drive_up_units') : unknownField(),
    interior_units: u.interior_units != null ? known(u.interior_units, 'unit_inventory.interior_units') : unknownField(),
    vehicle_units: u.vehicle_units != null ? known(u.vehicle_units, 'unit_inventory.vehicle_units') : unknownField(),
    rv_units: u.rv_units != null ? known(u.rv_units, 'unit_inventory.rv_units') : unknownField(),
    boat_units: u.boat_units != null ? known(u.boat_units, 'unit_inventory.boat_units') : unknownField(),
    lockers: u.lockers != null ? known(u.lockers, 'unit_inventory.lockers') : unknownField(),
    premium_units: u.premium_units != null ? known(u.premium_units, 'unit_inventory.premium_units') : unknownField(),
    unit_mix: mix.basis === 'AGGREGATE' || mix.basis === 'NONE'
      ? provField(mix, { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, confidence: 20, source: mix.source })
      : provField(mix, { basis: EVIDENCE_BASIS.VERIFIED_DOCUMENT, confidence: 70, source: mix.source }),
  };
}

/**
 * Deterministic unit-mix normalization. With a real unit roll or explicit mix,
 * returns per-category units/NRSF/occupancy/revenue/rent and a market-rent gap.
 * With ONLY total units + total NRSF, returns an AGGREGATE scenario (average
 * size only) — it does NOT invent per-unit-mix precision.
 */
export function normalizeUnitMix({ unitRoll = null, unitMix = null, totalUnits = null, totalNrsf = null } = {}) {
  if (Array.isArray(unitRoll) && unitRoll.length) {
    const buckets = new Map();
    for (const raw of unitRoll) {
      const cat = unitCategoryKey(raw);
      const b = buckets.get(cat.key) ?? {
        category: cat.key, climate: cat.climate, access: cat.access, vehicle: cat.vehicle,
        units: 0, nrsf: 0, occupied: 0, in_place_sum: 0, in_place_n: 0,
        street_sum: 0, street_n: 0, market_sum: 0, market_n: 0, occ_revenue: 0,
      };
      b.units += 1;
      const sf = num(raw.rentable_square_feet) ?? unitSizeToSqft(raw.unit_size ?? raw.size);
      if (sf !== null) b.nrsf += sf;
      const occupied = raw.occupied === true || /occupied|rented/i.test(clean(raw.status));
      if (occupied) b.occupied += 1;
      const ip = num(raw.in_place_rent ?? raw.current_rent);
      if (ip !== null) { b.in_place_sum += ip; b.in_place_n += 1; if (occupied) b.occ_revenue += ip; }
      const st = num(raw.street_rent);
      if (st !== null) { b.street_sum += st; b.street_n += 1; }
      const mk = num(raw.market_rent);
      if (mk !== null) { b.market_sum += mk; b.market_n += 1; }
      buckets.set(cat.key, b);
    }
    const categories = [...buckets.values()].map((b) => {
      const inPlace = b.in_place_n ? roundMoney(b.in_place_sum / b.in_place_n) : null;
      const street = b.street_n ? roundMoney(b.street_sum / b.street_n) : null;
      const market = b.market_n ? roundMoney(b.market_sum / b.market_n) : null;
      const gap = market !== null && inPlace !== null ? roundMoney(market - inPlace) : null;
      return {
        category: b.category, climate: b.climate, access: b.access, vehicle: b.vehicle,
        units: b.units, nrsf: b.nrsf ? roundMoney(b.nrsf) : null,
        occupied_units: b.occupied, occupancy: b.units ? round(b.occupied / b.units, 4) : null,
        monthly_occupied_revenue: roundMoney(b.occ_revenue),
        avg_in_place_rent: inPlace, avg_street_rent: street, avg_market_rent: market,
        market_rent_gap: gap,
      };
    });
    const totUnits = categories.reduce((s, c) => s + c.units, 0);
    const totNrsf = categories.reduce((s, c) => s + (c.nrsf ?? 0), 0);
    const totOcc = categories.reduce((s, c) => s + c.occupied_units, 0);
    const revenueOpportunity = categories.reduce(
      (s, c) => s + (c.market_rent_gap !== null ? c.market_rent_gap * c.occupied_units : 0), 0);
    return {
      basis: 'UNIT_ROLL', source: 'unit_roll',
      categories,
      total_units: totUnits, total_nrsf: totNrsf ? roundMoney(totNrsf) : null,
      occupied_units: totOcc, physical_occupancy: totUnits ? round(totOcc / totUnits, 4) : null,
      monthly_revenue_opportunity: roundMoney(revenueOpportunity),
      confidence: 75, missing: [],
    };
  }

  if (Array.isArray(unitMix) && unitMix.length) {
    // Explicit mix summary: trust counts/NRSF as provided, do not re-derive.
    const categories = unitMix.map((m) => ({
      category: clean(m.category) || unitCategoryKey(m).key,
      units: num(m.units) ?? null, nrsf: num(m.nrsf) ?? null,
      occupied_units: num(m.occupied_units),
      occupancy: num(m.occupancy) ?? (num(m.units) && num(m.occupied_units) != null ? round(num(m.occupied_units) / num(m.units), 4) : null),
      avg_in_place_rent: num(m.avg_in_place_rent), avg_street_rent: num(m.avg_street_rent),
      avg_market_rent: num(m.avg_market_rent),
      market_rent_gap: num(m.avg_market_rent) !== null && num(m.avg_in_place_rent) !== null ? roundMoney(num(m.avg_market_rent) - num(m.avg_in_place_rent)) : null,
    }));
    return {
      basis: 'UNIT_MIX_SUMMARY', source: 'unit_mix',
      categories,
      total_units: categories.reduce((s, c) => s + (c.units ?? 0), 0) || totalUnits,
      total_nrsf: categories.reduce((s, c) => s + (c.nrsf ?? 0), 0) || totalNrsf,
      confidence: 60, missing: [],
    };
  }

  // Only totals known → AGGREGATE scenario; average size ONLY, no invented mix.
  if (totalUnits !== null && totalNrsf !== null && totalUnits > 0) {
    return {
      basis: 'AGGREGATE', source: 'totals_only',
      categories: null,
      total_units: totalUnits, total_nrsf: roundMoney(totalNrsf),
      average_unit_nrsf: round(totalNrsf / totalUnits, 1),
      confidence: 25,
      missing: ['unit_mix', 'unit_dimensions', 'category_occupancy', 'category_rents'],
      note: 'Aggregate scenario only — unit-mix precision is unknown and not synthesized.',
    };
  }

  return {
    basis: 'NONE', source: null, categories: null,
    total_units: totalUnits, total_nrsf: totalNrsf !== null ? roundMoney(totalNrsf) : null,
    confidence: 0,
    missing: ['total_units', 'net_rentable_square_feet', 'unit_mix'],
    note: 'Insufficient inventory data to normalize unit mix.',
  };
}

/** Derive a normalized unit category key + attributes from a roll entry. */
function unitCategoryKey(raw = {}) {
  const size = clean(raw.unit_size ?? raw.size) || dimsToLabel(raw);
  const climate = raw.climate_controlled === true || /climate/i.test(clean(raw.climate ?? raw.type));
  const vehicle = /rv|boat|vehicle|parking/i.test(clean(raw.type ?? raw.access ?? raw.category));
  const access = raw.drive_up === true || /drive.?up/i.test(clean(raw.access ?? raw.type))
    ? 'DRIVE_UP'
    : (raw.interior === true || /interior/i.test(clean(raw.access ?? raw.type)) ? 'INTERIOR' : 'UNKNOWN');
  const climateLabel = vehicle ? 'VEHICLE' : climate ? 'CLIMATE' : 'NON_CLIMATE';
  return { key: `${size || '?'}|${climateLabel}|${access}`, climate, access, vehicle };
}

function dimsToLabel(raw) {
  const w = num(raw.width); const d = num(raw.depth ?? raw.length);
  return w !== null && d !== null ? `${w}x${d}` : '';
}

/** "10x10" → 100 sqft; bare number → itself. Returns null when unparseable. */
function unitSizeToSqft(size) {
  if (size == null) return null;
  const s = String(size).toLowerCase().replace(/\s/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/);
  if (m) return round(parseFloat(m[1]) * parseFloat(m[2]), 1);
  const n = num(size);
  return n;
}

/** Fraction (0..100) of material storage fields that carry real evidence. */
function scoreCompleteness(contract) {
  const material = [
    contract.physical.net_rentable_square_feet, contract.unit_inventory.total_units,
    contract.operations.physical_occupancy, contract.operations.average_in_place_rent,
    contract.income.base_rental_income, contract.expenses.total_operating_expenses,
    contract.physical.gross_building_square_feet, contract.identity.year_built,
  ];
  const known = material.filter((f) => isKnown(f)).length;
  return Math.round((known / material.length) * 100);
}

/** List the UNKNOWN material fields for explainability. */
export function storageMissingInputs(contract) {
  const out = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v && typeof v === 'object' && 'basis' in v) {
        if (!isKnown(v)) out.push(`${prefix}${k}`);
      }
    }
  };
  walk(contract.physical, 'physical.');
  walk(contract.unit_inventory, 'unit_inventory.');
  walk(contract.operations, 'operations.');
  walk(contract.income, 'income.');
  walk(contract.expenses, 'expenses.');
  return out;
}
