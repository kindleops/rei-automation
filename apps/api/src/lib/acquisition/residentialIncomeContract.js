/**
 * Acquisition Engine V3 — Item 5B: normalized residential-income subject contract.
 *
 * A single, explicit, source-attributed snapshot of an income property's
 * physical, occupancy, rent and expense reality. Every field is a {value,
 * source, as_of, confidence, basis} record so downstream models can reason
 * about evidence quality and never confuse an assumption for a fact.
 *
 * CRITICAL RULE (mission Item 5B §1): a missing value is UNKNOWN, never zero.
 * `field(null, ...)` yields basis=UNKNOWN with value=null; a real zero (e.g. a
 * verified $0 of other income) must be passed explicitly as a number.
 *
 * Pure & deterministic — no I/O, no Date.now, no randomness.
 */

import { ASSET_FAMILIES, LANE_FAMILY, num, clean, lower } from './modelConstants.js';
import { classifyAssetLane } from './assetClassification.js';

/** How well-supported a field is. */
export const FIELD_BASIS = Object.freeze({
  KNOWN: 'KNOWN', // directly observed/verified
  INFERRED: 'INFERRED', // derived from other observed data
  ASSUMED: 'ASSUMED', // modeled from a labeled assumption
  UNKNOWN: 'UNKNOWN', // not available — NOT zero
});

/** Income families that this contract supports (Item 5B scope). */
export const INCOME_FAMILIES = Object.freeze([ASSET_FAMILIES.SMALL_MULTI, ASSET_FAMILIES.MULTIFAMILY]);

/** Construct a single attributed field. value === null ⇒ UNKNOWN. */
export function field(value, source = null, { as_of = null, confidence = null, basis = null } = {}) {
  const v = value === '' ? null : value;
  const known = v !== null && v !== undefined;
  return {
    value: known ? v : null,
    source: known ? source : null,
    as_of: known ? as_of : null,
    confidence: known ? (confidence ?? 50) : 0,
    basis: known ? (basis ?? FIELD_BASIS.KNOWN) : FIELD_BASIS.UNKNOWN,
  };
}

/** First non-null numeric among the listed subject keys. */
function pickNum(row, keys) {
  for (const k of keys) {
    const v = num(row[k]);
    if (v !== null) return { value: v, source: k };
  }
  return { value: null, source: null };
}

function pickStr(row, keys) {
  for (const k of keys) {
    const v = clean(row[k]);
    if (v) return { value: v, source: k };
  }
  return { value: null, source: null };
}

/** Map a free-text condition to a coarse, ordered class. */
export function normalizeCondition(raw) {
  const s = lower(raw);
  if (!s) return null;
  if (/(uninhabitable|teardown|shell|gut|distress|poor|severe)/.test(s)) return 'POOR';
  if (/(below average|dated|fair|needs work|deferred)/.test(s)) return 'FAIR';
  if (/(average|standard|typical|c\b)/.test(s)) return 'AVERAGE';
  if (/(good|updated|above average|b\b)/.test(s)) return 'GOOD';
  if (/(excellent|renovated|new|pristine|turnkey|a\b)/.test(s)) return 'EXCELLENT';
  return 'AVERAGE';
}

/** Map a renovation/rehab signal to a state. */
export function normalizeRenovationState(raw) {
  const s = lower(raw);
  if (!s) return null;
  if (/(full gut|full renovation|renovated|flip|turnkey|new construction)/.test(s)) return 'RENOVATED';
  if (/(partial|cosmetic|light|moderate)/.test(s)) return 'PARTIAL';
  if (/(none|original|unrenovated|as-is|as is)/.test(s)) return 'ORIGINAL';
  return null;
}

/**
 * Build the normalized residential-income subject contract.
 *
 * @param {object} subjectRow             raw subject property row
 * @param {object} [income]              optional structured income inputs:
 *   { rent_roll, market_rents, expenses, debt, unit_mix, occupancy, ... }
 * @returns {object} normalized contract (only meaningful for income families)
 */
export function buildResidentialIncomeSubject(subjectRow = {}, income = {}) {
  const classification = classifyAssetLane(subjectRow);
  const lane = classification.lane;
  const family = LANE_FAMILY[lane] ?? ASSET_FAMILIES.UNKNOWN;
  const isIncome = INCOME_FAMILIES.includes(family);

  const units = pickNum(subjectRow, ['units_count', 'unit_count', 'number_of_units']);
  const resUnits = pickNum(subjectRow, ['residential_units', 'residential_unit_count']);
  const commUnits = pickNum(subjectRow, ['commercial_units', 'commercial_unit_count']);
  const buildings = pickNum(subjectRow, ['building_count', 'number_of_buildings']);
  const rentable = pickNum(subjectRow, ['rentable_square_feet', 'net_rentable_sqft', 'building_square_feet', 'sqft']);
  const gba = pickNum(subjectRow, ['gross_building_area', 'building_square_feet', 'sqft']);
  const lot = pickNum(subjectRow, ['lot_size_sqft', 'lot_size', 'land_sqft']);
  const yearBuilt = pickNum(subjectRow, ['year_built']);
  const effYear = pickNum(subjectRow, ['effective_year_built']);
  const construction = pickStr(subjectRow, ['construction_type', 'construction']);
  const propClass = pickStr(subjectRow, ['property_class', 'building_class', 'asset_class']);
  const conditionRaw = pickStr(subjectRow, ['building_condition', 'condition']);
  const renoRaw = pickStr(subjectRow, ['renovation_level_classification', 'rehab_level', 'renovation_state']);
  const parking = pickNum(subjectRow, ['parking_spaces', 'parking_count']);
  const utilityResp = pickStr(subjectRow, ['utility_responsibility', 'utilities_paid_by']);
  const separateMeters = subjectRow.separate_meters;

  // Rent: prefer a verified rent roll, then property-level rent, then estimate.
  const rentRoll = Array.isArray(income.rent_roll) && income.rent_roll.length ? income.rent_roll : null;
  const rollGrossMonthly = rentRoll
    ? rentRoll.reduce((s, u) => s + (num(u.current_rent) ?? 0), 0)
    : null;
  const propertyRent = pickNum(subjectRow, ['monthly_rent']);
  const estimateRent = pickNum(subjectRow, ['rent_estimate']);

  const occupancy = num(income.occupancy) ?? pickNum(subjectRow, ['occupancy', 'occupancy_pct']).value;
  const marketRents = Array.isArray(income.market_rents) ? income.market_rents : null;
  const unitMix = Array.isArray(income.unit_mix) ? income.unit_mix : (rentRoll ? summarizeUnitMix(rentRoll) : null);

  const exp = income.expenses ?? {};
  const debt = income.debt ?? {};

  const noiKnown = pickNum(subjectRow, ['noi_estimate']);
  const capKnown = pickNum(subjectRow, ['cap_rate']);

  const contract = {
    lane,
    family,
    is_income_asset: isIncome,
    valuation_method: classification.method ?? null,
    asset_lane_confidence: classification.confidence,

    // ---- Physical ----
    unit_count: attr(units, 'subject', FIELD_BASIS.KNOWN),
    residential_units: attr(resUnits, 'subject', FIELD_BASIS.KNOWN),
    commercial_units: attr(commUnits, 'subject', FIELD_BASIS.KNOWN),
    building_count: attr(buildings, 'subject', FIELD_BASIS.KNOWN),
    rentable_square_feet: field(rentable.value, rentable.source, { basis: rentable.source === 'rentable_square_feet' || rentable.source === 'net_rentable_sqft' ? FIELD_BASIS.KNOWN : FIELD_BASIS.INFERRED }),
    gross_building_area: field(gba.value, gba.source, { basis: gba.source === 'gross_building_area' ? FIELD_BASIS.KNOWN : FIELD_BASIS.INFERRED }),
    lot_size_sqft: attr(lot, 'subject', FIELD_BASIS.KNOWN),
    year_built: attr(yearBuilt, 'subject', FIELD_BASIS.KNOWN),
    effective_year_built: field(effYear.value, effYear.source, { basis: effYear.value !== null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    construction: attr(construction, 'subject', FIELD_BASIS.KNOWN),
    building_class: attr(propClass, 'subject', FIELD_BASIS.KNOWN),
    condition: field(normalizeCondition(conditionRaw.value), conditionRaw.source, { basis: conditionRaw.value ? FIELD_BASIS.INFERRED : FIELD_BASIS.UNKNOWN }),
    renovation_state: field(normalizeRenovationState(renoRaw.value), renoRaw.source, { basis: renoRaw.value ? FIELD_BASIS.INFERRED : FIELD_BASIS.UNKNOWN }),
    parking_spaces: attr(parking, 'subject', FIELD_BASIS.KNOWN),
    utility_responsibility: attr(utilityResp, 'subject', FIELD_BASIS.KNOWN),
    separate_meters: field(typeof separateMeters === 'boolean' ? separateMeters : null, 'subject', { basis: typeof separateMeters === 'boolean' ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),

    // ---- Occupancy / mix ----
    occupancy: field(occupancy ?? null, occupancy != null ? (income.occupancy != null ? 'income_inputs' : 'subject') : null, { basis: occupancy != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    unit_mix: field(unitMix, unitMix ? (income.unit_mix ? 'income_inputs' : 'rent_roll') : null, { basis: unitMix ? (income.unit_mix ? FIELD_BASIS.KNOWN : FIELD_BASIS.INFERRED) : FIELD_BASIS.UNKNOWN }),
    rent_roll: field(rentRoll, rentRoll ? 'income_inputs' : null, { basis: rentRoll ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    market_rents: field(marketRents, marketRents ? 'income_inputs' : null, { basis: marketRents ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),

    // ---- Income (gross rent resolved with source lineage) ----
    current_gross_monthly_rent: resolveCurrentRent({ rollGrossMonthly, propertyRent, estimateRent }),
    concessions_annual: field(num(income.concessions), income.concessions != null ? 'income_inputs' : null, { basis: income.concessions != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    bad_debt_annual: field(num(income.bad_debt), income.bad_debt != null ? 'income_inputs' : null, { basis: income.bad_debt != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    other_income_annual: field(num(income.other_income), income.other_income != null ? 'income_inputs' : null, { basis: income.other_income != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),

    // ---- Expenses (actuals only; modeled values are produced by the expense model) ----
    taxes_annual: field(num(exp.taxes) ?? num(subjectRow.tax_amt), (exp.taxes != null || subjectRow.tax_amt != null) ? (exp.taxes != null ? 'income_inputs' : 'subject') : null, { basis: (exp.taxes != null || subjectRow.tax_amt != null) ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    insurance_annual: field(num(exp.insurance) ?? num(subjectRow.insurance_annual), (exp.insurance != null || subjectRow.insurance_annual != null) ? (exp.insurance != null ? 'income_inputs' : 'subject') : null, { basis: (exp.insurance != null || subjectRow.insurance_annual != null) ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    management_annual: actual(exp.management),
    maintenance_annual: actual(exp.maintenance),
    owner_paid_utilities_annual: actual(exp.utilities),
    payroll_annual: actual(exp.payroll),
    administration_annual: actual(exp.administration),
    replacement_reserves_annual: actual(exp.replacement_reserves),

    // ---- Subject-reported income anchors (corroboration inputs, not market) ----
    subject_cap_rate: field(capKnown.value, capKnown.source, { basis: capKnown.value !== null ? FIELD_BASIS.INFERRED : FIELD_BASIS.UNKNOWN }),
    subject_noi_estimate: field(noiKnown.value, noiKnown.source, { basis: noiKnown.value !== null ? FIELD_BASIS.INFERRED : FIELD_BASIS.UNKNOWN }),

    // ---- Current debt ----
    current_debt: buildDebtContract(debt, subjectRow),
  };

  contract.completeness = scoreCompleteness(contract);
  return contract;
}

/** Attribute a {value, source} pick into a field record. */
function attr(pick, sourceLabel, basis) {
  return field(pick.value, pick.value !== null ? (pick.source ?? sourceLabel) : null, {
    basis: pick.value !== null ? basis : FIELD_BASIS.UNKNOWN,
  });
}

/** An ACTUAL expense line: known iff explicitly provided, else unknown (not zero). */
function actual(value) {
  const v = num(value);
  return field(v, v !== null ? 'income_inputs' : null, { basis: v !== null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN });
}

/** Resolve current gross monthly rent by source priority with lineage. */
function resolveCurrentRent({ rollGrossMonthly, propertyRent, estimateRent }) {
  if (rollGrossMonthly !== null && rollGrossMonthly > 0) {
    return field(rollGrossMonthly, 'verified_rent_roll', { basis: FIELD_BASIS.KNOWN, confidence: 90 });
  }
  if (propertyRent.value !== null && propertyRent.value > 0) {
    return field(propertyRent.value, 'subject.monthly_rent', { basis: FIELD_BASIS.KNOWN, confidence: 65 });
  }
  if (estimateRent.value !== null && estimateRent.value > 0) {
    return field(estimateRent.value, 'subject.rent_estimate', { basis: FIELD_BASIS.ASSUMED, confidence: 35 });
  }
  return field(null);
}

/** Summarize a rent roll into a coarse unit mix (bed/bath buckets). */
export function summarizeUnitMix(rentRoll) {
  const buckets = new Map();
  for (const u of rentRoll) {
    const key = `${num(u.beds) ?? '?'}b/${num(u.baths) ?? '?'}ba`;
    const b = buckets.get(key) ?? { type: key, count: 0, avg_rent_sum: 0, rent_n: 0 };
    b.count += 1;
    const r = num(u.current_rent);
    if (r !== null) { b.avg_rent_sum += r; b.rent_n += 1; }
    buckets.set(key, b);
  }
  return [...buckets.values()].map((b) => ({
    type: b.type,
    count: b.count,
    avg_current_rent: b.rent_n ? Math.round(b.avg_rent_sum / b.rent_n) : null,
  }));
}

/** Current debt sub-contract (residential + commercial fields). */
function buildDebtContract(debt, subjectRow) {
  const balance = num(debt.balance) ?? num(subjectRow.total_loan_balance) ?? num(subjectRow.total_loan_amt);
  const payment = num(debt.monthly_payment) ?? num(subjectRow.total_loan_payment);
  const arrears = num(debt.arrears) ?? num(subjectRow.past_due_amount);
  return {
    balance: field(balance, balance !== null ? (debt.balance != null ? 'income_inputs' : 'subject') : null, { basis: balance !== null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    monthly_payment: field(payment, payment !== null ? (debt.monthly_payment != null ? 'income_inputs' : 'subject') : null, { basis: payment !== null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    interest_rate: field(num(debt.interest_rate), debt.interest_rate != null ? 'income_inputs' : null, { basis: debt.interest_rate != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    arrears: field(arrears, arrears !== null ? (debt.arrears != null ? 'income_inputs' : 'subject') : null, { basis: arrears !== null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    // Commercial-only debt attributes (distinct from residential subject-to).
    maturity_date: field(clean(debt.maturity_date) || null, debt.maturity_date ? 'income_inputs' : null, { basis: debt.maturity_date ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    balloon_months: field(num(debt.balloon_months), debt.balloon_months != null ? 'income_inputs' : null, { basis: debt.balloon_months != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    interest_only_months: field(num(debt.interest_only_months), debt.interest_only_months != null ? 'income_inputs' : null, { basis: debt.interest_only_months != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    recourse: field(typeof debt.recourse === 'boolean' ? debt.recourse : null, debt.recourse != null ? 'income_inputs' : null, { basis: debt.recourse != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    assumable: field(typeof debt.assumable === 'boolean' ? debt.assumable : null, debt.assumable != null ? 'income_inputs' : null, { basis: debt.assumable != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    rate_resets: field(typeof debt.rate_resets === 'boolean' ? debt.rate_resets : null, debt.rate_resets != null ? 'income_inputs' : null, { basis: debt.rate_resets != null ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
    covenants: field(Array.isArray(debt.covenants) && debt.covenants.length ? debt.covenants : null, debt.covenants ? 'income_inputs' : null, { basis: debt.covenants ? FIELD_BASIS.KNOWN : FIELD_BASIS.UNKNOWN }),
  };
}

/** Fraction (0..100) of the contract's material fields that are KNOWN/INFERRED. */
function scoreCompleteness(contract) {
  const material = [
    'unit_count', 'rentable_square_feet', 'year_built', 'condition', 'occupancy',
    'current_gross_monthly_rent', 'taxes_annual', 'insurance_annual', 'rent_roll',
  ];
  let known = 0;
  for (const k of material) {
    const f = contract[k];
    if (f && (f.basis === FIELD_BASIS.KNOWN || f.basis === FIELD_BASIS.INFERRED)) known += 1;
  }
  return Math.round((known / material.length) * 100);
}

/** List the UNKNOWN material fields (missing inputs), for explainability. */
export function missingInputs(contract) {
  const out = [];
  for (const [k, v] of Object.entries(contract)) {
    if (v && typeof v === 'object' && 'basis' in v && v.basis === FIELD_BASIS.UNKNOWN) out.push(k);
  }
  return out;
}
