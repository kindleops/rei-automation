/**
 * Acquisition Engine V3 — Item 5C: canonical property income snapshot contract.
 *
 * A single, source-traceable, property-level income snapshot that can support
 * residential income (2–4 + 5–20 / 21–99 / 100+) today and future commercial
 * lanes (self-storage / retail / office / industrial / MHP / hospitality)
 * WITHOUT changing shape. Every scalar carries field-level provenance so the
 * engine can reason about evidence quality and never confuse an assumption,
 * a provider estimate, or an asking rent for a verified actual.
 *
 * CRITICAL RULE: a missing value is UNKNOWN, never zero. Pass a real number only
 * when the value is genuinely observed (a verified $0 of other income, etc.).
 *
 * Pure & deterministic — no I/O, no Date.now, no randomness. This module defines
 * the contract + provenance primitives only; loaders/normalization live in
 * incomeSnapshotLoader.js and source ranking in incomeSourcePriority.js.
 */

/** Evidence basis for a provenance-bearing field, strongest → weakest. */
export const EVIDENCE_BASIS = Object.freeze({
  MANUAL_OVERRIDE: 'MANUAL_OVERRIDE', // explicit human correction — authoritative
  VERIFIED_DOCUMENT: 'VERIFIED_DOCUMENT', // closing/financials/rent roll/lease docs
  ACTUAL: 'ACTUAL', // current PM/accounting record
  OWNER_REPORTED: 'OWNER_REPORTED', // owner statement confirmed in conversation
  LISTING_REPORTED: 'LISTING_REPORTED', // listing / MLS-derived
  PROVIDER_REPORTED: 'PROVIDER_REPORTED', // third-party data provider
  COMPARABLE_DERIVED: 'COMPARABLE_DERIVED', // qualified comparable evidence
  MARKET_MODELED: 'MARKET_MODELED', // market-level modeled assumption
  SYSTEM_INFERRED: 'SYSTEM_INFERRED', // derived from other observed data
  UNKNOWN: 'UNKNOWN', // not available — NOT zero
});

/**
 * Deterministic field-level source priority (mission §3). Lower index wins.
 * A higher-priority basis beats a newer record of lower reliability — the
 * engine never blindly picks the latest source.
 */
export const BASIS_PRIORITY = Object.freeze([
  EVIDENCE_BASIS.MANUAL_OVERRIDE,
  EVIDENCE_BASIS.VERIFIED_DOCUMENT,
  EVIDENCE_BASIS.ACTUAL,
  EVIDENCE_BASIS.OWNER_REPORTED,
  EVIDENCE_BASIS.LISTING_REPORTED,
  EVIDENCE_BASIS.PROVIDER_REPORTED,
  EVIDENCE_BASIS.COMPARABLE_DERIVED,
  EVIDENCE_BASIS.MARKET_MODELED,
  EVIDENCE_BASIS.SYSTEM_INFERRED,
  EVIDENCE_BASIS.UNKNOWN,
]);

/** Default confidence (0..100) by basis when a source does not supply one. */
export const BASIS_CONFIDENCE = Object.freeze({
  MANUAL_OVERRIDE: 95,
  VERIFIED_DOCUMENT: 92,
  ACTUAL: 85,
  OWNER_REPORTED: 60,
  LISTING_REPORTED: 50,
  PROVIDER_REPORTED: 45,
  COMPARABLE_DERIVED: 55,
  MARKET_MODELED: 30,
  SYSTEM_INFERRED: 25,
  UNKNOWN: 0,
});

export const VALIDATION_STATUS = Object.freeze({
  VALID: 'VALID',
  UNVALIDATED: 'UNVALIDATED',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  STALE: 'STALE',
});

export const CONFLICT_STATUS = Object.freeze({
  NONE: 'NONE',
  MINOR: 'MINOR',
  MATERIAL: 'MATERIAL',
});

/** Rank index of a basis (higher reliability = lower number). */
export function basisRank(basis) {
  const i = BASIS_PRIORITY.indexOf(basis);
  return i === -1 ? BASIS_PRIORITY.length : i;
}

/**
 * Build a provenance-bearing field. value == null/undefined/'' ⇒ UNKNOWN.
 * @param {*} value
 * @param {object} [p] provenance
 */
export function provField(value, p = {}) {
  const v = value === '' ? null : value;
  const known = v !== null && v !== undefined;
  const basis = known ? (p.basis ?? EVIDENCE_BASIS.UNKNOWN) : EVIDENCE_BASIS.UNKNOWN;
  return {
    value: known ? v : null,
    source: known ? (p.source ?? null) : null,
    source_record_id: known ? (p.source_record_id ?? null) : null,
    observed_at: known ? (p.observed_at ?? null) : null,
    effective_date: known ? (p.effective_date ?? null) : null,
    confidence: known ? (p.confidence ?? BASIS_CONFIDENCE[basis] ?? 0) : 0,
    basis,
    extraction_method: known ? (p.extraction_method ?? null) : null,
    validation_status: known ? (p.validation_status ?? VALIDATION_STATUS.UNVALIDATED) : VALIDATION_STATUS.UNVALIDATED,
    conflict_status: p.conflict_status ?? CONFLICT_STATUS.NONE,
  };
}

/** An UNKNOWN field (the explicit "not available, not zero" sentinel). */
export function unknownField() {
  return provField(null);
}

/** True iff a field carries a real observed value. */
export function isKnown(f) {
  return Boolean(f && f.value !== null && f.value !== undefined && f.basis !== EVIDENCE_BASIS.UNKNOWN);
}

/** The ordered scalar field groups of the canonical snapshot. */
export const SNAPSHOT_FIELD_GROUPS = Object.freeze({
  units_occupancy: [
    'total_units', 'rentable_units', 'occupied_units', 'vacant_units', 'occupancy_rate',
    'economic_occupancy_rate', 'rentable_square_feet', 'occupied_square_feet',
  ],
  rent_income: [
    'actual_monthly_base_rent', 'scheduled_monthly_rent', 'market_monthly_rent', 'other_income',
    'concessions', 'bad_debt', 'vacancy_loss', 'gross_potential_income', 'effective_gross_income',
    'trailing_3_month_income', 'trailing_12_month_income',
  ],
  operating_expenses: [
    'property_taxes', 'insurance', 'management', 'repairs_maintenance', 'owner_paid_utilities',
    'payroll', 'administrative', 'landscaping_snow', 'pest_service_contracts', 'turnover',
    'replacement_reserves', 'other_operating_expenses', 'total_operating_expenses',
  ],
  performance: [
    'actual_noi', 'trailing_noi', 'stabilized_noi', 'pro_forma_noi', 'operating_expense_ratio',
    'grm', 'egim', 'implied_cap_rate', 'break_even_occupancy',
  ],
  debt: [
    'loan_balance', 'monthly_principal_interest', 'taxes_and_insurance_payment',
    'total_monthly_debt_service', 'interest_rate', 'amortization_months', 'maturity', 'balloon',
    'arrears', 'debt_type', 'recourse', 'assumability', 'rate_reset', 'interest_only_period',
  ],
});

/** All scalar field names across groups. */
export const SNAPSHOT_SCALAR_FIELDS = Object.freeze(
  Object.values(SNAPSHOT_FIELD_GROUPS).flat(),
);

/**
 * Construct an empty canonical snapshot — all scalars UNKNOWN. Identity is set
 * from the args; `unit_mix` is a structured list (not a scalar provField).
 */
export function emptyIncomeSnapshot({ propertyId = null, lane = null, asOf = null, sourceVersion = null, engineVersion = null } = {}) {
  const snap = {
    // ---- Identity ----
    property_id: propertyId,
    canonical_asset_lane: lane,
    snapshot_id: null, // assigned only on (future) persistence
    as_of: asOf,
    source_version: sourceVersion,
    engine_version: engineVersion,
    // ---- Structured (non-scalar) ----
    unit_mix: unknownField(),
  };
  for (const f of SNAPSHOT_SCALAR_FIELDS) snap[f] = unknownField();
  return snap;
}
