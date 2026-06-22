/**
 * Acquisition Engine V3 — Item 5C: canonical income snapshot construction
 * (mission §15). Pure normalization + source ranking + conflict/freshness +
 * conversation reconciliation → one canonical snapshot.
 *
 * READ-ONLY and pure: it consumes ALREADY-FETCHED rows (a property row, rent
 * records, cap transactions, conversation facts, a market-rent prior) and emits
 * a snapshot. It performs NO database I/O and NO persistence — production
 * persistence stays disabled until a later pass.
 */

import {
  ENGINE_VERSION,
  num,
  round,
  roundMoney,
} from './modelConstants.js';
import {
  emptyIncomeSnapshot,
  provField,
  isKnown,
  EVIDENCE_BASIS,
  SNAPSHOT_SCALAR_FIELDS,
  CONFLICT_STATUS,
} from './incomeSnapshotContract.js';
import { selectField } from './incomeSourcePriority.js';
import { normalizeConversationFact, reconcileConversationFact } from './incomeConversationFacts.js';
import { buildIncomeCompleteness } from './incomeCompleteness.js';

/**
 * Normalize a `properties` row into per-field source candidates. Reflects the
 * Item 5C audit reality: tax ~99% present (PROVIDER_REPORTED), debt numeric but
 * a `0` balance is ambiguous free-and-clear (flagged, confidence-reduced), and
 * rent/NOI/cap/occupancy are absent (→ no candidates → UNKNOWN, never zero).
 */
export function normalizePropertyRow(row = {}, { observedAt = null } = {}) {
  if (!row || typeof row !== 'object') return {};
  const candidates = {};
  const add = (field, value, prov) => {
    if (value === null || value === undefined || value === '') return;
    (candidates[field] ??= []).push({ value, observed_at: observedAt, ...prov });
  };

  add('total_units', num(row.units_count), { basis: EVIDENCE_BASIS.PROVIDER_REPORTED, source: 'properties.units_count', source_record_id: row.property_id ?? row.id, data_type: 'default' });
  add('rentable_square_feet', num(row.building_square_feet) ?? num(row.sqft), { basis: EVIDENCE_BASIS.PROVIDER_REPORTED, source: 'properties.building_square_feet', source_record_id: row.property_id ?? row.id, data_type: 'default' });

  // Property taxes — public-record provider data (good coverage).
  add('property_taxes', num(row.tax_amt) ?? num(row.tax_amount), { basis: EVIDENCE_BASIS.PROVIDER_REPORTED, source: 'properties.tax_amt', source_record_id: row.property_id ?? row.id, data_type: 'taxes' });

  // Debt: provider-reported. A 0 balance is ambiguous (free-and-clear vs
  // missing) → keep the value but reduce confidence and never elevate to ACTUAL.
  const bal = num(row.total_loan_balance);
  if (bal !== null) {
    add('loan_balance', bal, {
      basis: EVIDENCE_BASIS.PROVIDER_REPORTED, source: 'properties.total_loan_balance', source_record_id: row.property_id ?? row.id,
      data_type: 'debt_balance', confidence: bal === 0 ? 30 : 45, extraction_method: bal === 0 ? 'provider_zero_balance_ambiguous_free_and_clear' : 'provider',
    });
  }
  const pmt = num(row.total_loan_payment);
  if (pmt !== null && pmt > 0) {
    // Audit flagged payment reliability as low (implausible payment/balance ratio).
    add('total_monthly_debt_service', pmt, { basis: EVIDENCE_BASIS.PROVIDER_REPORTED, source: 'properties.total_loan_payment', source_record_id: row.property_id ?? row.id, data_type: 'loan_payment', confidence: 35 });
  }
  // NOTE: monthly_rent / rent_estimate / noi_estimate / cap_rate / occupancy are
  // absent in production (0% coverage) → intentionally no candidates added.
  return candidates;
}

/** Merge two candidate maps (e.g. property row + comp-derived). */
export function mergeCandidateMaps(...maps) {
  const out = {};
  for (const m of maps) {
    if (!m) continue;
    for (const [k, list] of Object.entries(m)) {
      (out[k] ??= []).push(...list);
    }
  }
  return out;
}

/** Derive performance fields from known income/value inputs (SYSTEM_INFERRED). */
function derivePerformance(snap) {
  const egi = num(snap.effective_gross_income?.value);
  const noi = num(snap.actual_noi?.value);
  const grossAnnual = num(snap.actual_monthly_base_rent?.value) !== null ? num(snap.actual_monthly_base_rent.value) * 12 : null;
  const value = num(snap._value_basis);

  if (egi !== null && num(snap.total_operating_expenses?.value) !== null && !isKnown(snap.actual_noi)) {
    snap.actual_noi = provField(roundMoney(egi - num(snap.total_operating_expenses.value)), { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, source: 'egi_minus_opex', confidence: 40 });
  }
  if (value !== null && noi !== null && !isKnown(snap.implied_cap_rate)) {
    snap.implied_cap_rate = provField(round(noi / value, 4), { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, source: 'noi_over_value', confidence: 30 });
  }
  if (value !== null && grossAnnual && !isKnown(snap.grm)) {
    snap.grm = provField(round(value / grossAnnual, 2), { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, source: 'value_over_gross', confidence: 30 });
  }
  if (egi !== null && num(snap.total_operating_expenses?.value) !== null && egi > 0 && !isKnown(snap.operating_expense_ratio)) {
    snap.operating_expense_ratio = provField(round(num(snap.total_operating_expenses.value) / egi, 3), { basis: EVIDENCE_BASIS.SYSTEM_INFERRED, source: 'opex_over_egi', confidence: 35 });
  }
  delete snap._value_basis;
}

/**
 * Build the canonical income snapshot.
 *
 * @param {object} args
 * @param {string} args.propertyId
 * @param {string} args.lane             canonical asset lane
 * @param {object} args.candidateMap     { field: [candidate,...] } (from normalizers)
 * @param {object[]} [args.conversationFacts] extracted conversation facts
 * @param {object[]} [args.unitMix]      structured unit mix (optional)
 * @param {number} [args.valueBasis]     engine value used for implied cap/GRM
 * @param {Date}   [args.now]
 */
export function buildCanonicalIncomeSnapshot({
  propertyId = null, lane = null, asOf = null, candidateMap = {}, conversationFacts = [],
  unitMix = null, valueBasis = null, aux = {}, now = new Date(), sourceVersion = 'item5c.v1',
} = {}) {
  const snap = emptyIncomeSnapshot({ propertyId, lane, asOf: asOf ?? now.toISOString(), sourceVersion, engineVersion: ENGINE_VERSION });
  const conflicts = [];

  // 1. Select each scalar field from its candidates by deterministic priority.
  for (const field of SNAPSHOT_SCALAR_FIELDS) {
    const cands = candidateMap[field];
    if (!cands || !cands.length) continue;
    const dataType = cands[0]?.data_type ?? 'default';
    const sel = selectField(cands, { dataType, now });
    snap[field] = {
      value: sel.value, source: sel.source, source_record_id: sel.source_record_id, observed_at: sel.observed_at,
      effective_date: sel.effective_date, confidence: sel.confidence, basis: sel.basis,
      extraction_method: sel.extraction_method, validation_status: sel.validation_status, conflict_status: sel.conflict_status,
    };
    if (sel.conflict && sel.conflict !== CONFLICT_STATUS.NONE) {
      conflicts.push({ field, severity: sel.conflict, variance: sel.variance, selected: sel.value, selected_basis: sel.basis, rejected: sel.rejected, reason: sel.reason });
    }
  }

  // 2. Apply conversation-derived facts (never overwrite more-reliable data).
  for (const fact of conversationFacts) {
    const norm = normalizeConversationFact(fact);
    if (!norm.snapshot_field) continue;
    const rec = reconcileConversationFact(norm, snap[norm.snapshot_field]);
    if (rec.action === 'APPLY') {
      snap[norm.snapshot_field] = { ...norm.field, conflict_status: rec.conflict };
    } else if (rec.action === 'CONFLICT' || rec.conflict !== CONFLICT_STATUS.NONE) {
      conflicts.push({ field: norm.snapshot_field, severity: rec.conflict, source: 'conversation', existing_basis: rec.existing_basis, reason: rec.reason, action: rec.action });
      if (snap[norm.snapshot_field]) snap[norm.snapshot_field].conflict_status = rec.conflict;
    }
  }

  // 3. Occupancy/vacancy and EGI derivations from known rent + units.
  if (unitMix) snap.unit_mix = provField(unitMix, { basis: EVIDENCE_BASIS.PROVIDER_REPORTED, source: 'unit_mix', confidence: 50 });
  snap._value_basis = num(valueBasis);
  derivePerformance(snap);

  // 4. Completeness + material-conflict summary.
  const completeness = buildIncomeCompleteness(snap, aux);
  const materialConflictFields = conflicts.filter((c) => c.severity === CONFLICT_STATUS.MATERIAL).map((c) => c.field);

  return {
    snapshot: snap,
    conflicts,
    material_conflict_fields: materialConflictFields,
    has_material_conflict: materialConflictFields.length > 0,
    // A material conflict in any decision-critical field blocks an underwritten
    // status — the snapshot cannot back authorization until it is resolved.
    max_underwritable: materialConflictFields.length === 0,
    completeness,
    source_version: sourceVersion,
    engine_version: ENGINE_VERSION,
  };
}
