// P2-2 immutable comp/market snapshot adapter. Validates snapshot documents
// against the interface (SNAPSHOT_INTERFACE.md) and hands them to the feature
// engine. The engine NEVER reads mutable live views for historical scoring.
import { readFileSync } from 'node:fs';
import { toMs } from '../lib/timeSafety.mjs';

export const REQUIRED_FIELDS = [
  'id', 'subject_property_id', 'as_of', 'asset_class', 'cohort_rung', 'cohort_key', 'cohort_n',
  'selected_comp_ids', 'comp_eligibility', 'comp_exclusions', 'weighted_comp_score',
  'valuation_low', 'valuation_high', 'valuation_confidence',
  'sale_velocity', 'inventory_absorption', 'buyer_velocity', 'buyer_demand_confidence',
  'warnings', 'source_engine',
];

// v2 additions are optional (v1 docs stay valid) but, when present, must be
// self-consistent; when ABSENT on a v2 doc, the doc must carry the matching
// unavailable-warning (no silent gaps).
export const V2_FIELDS = ['renovated_spread', 'cohort_value_percentiles', 'subject_value_percentile',
  'repair_burden', 'rent_context', 'cohort_sufficiency'];

export function validateSnapshot(doc) {
  const missing = REQUIRED_FIELDS.filter((f) => !(f in doc));
  const errors = [];
  if (missing.length) errors.push(`missing fields: ${missing.join(', ')}`);
  if (doc.cohort_n !== undefined && doc.cohort_n < 12
      && !(doc.warnings ?? []).some((w) => /thin|insufficient|degraded/.test(w))) {
    errors.push('cohort_n below minimum (12) without self-reported degradation warning');
  }
  if (doc.valuation_low !== null && doc.valuation_high !== null && doc.valuation_low > doc.valuation_high) {
    errors.push('valuation_low > valuation_high');
  }
  if ((doc.snapshot_interface_version ?? 1) >= 2) {
    const v2missing = V2_FIELDS.filter((f) => !(f in doc));
    if (v2missing.length) errors.push(`v2 doc missing fields: ${v2missing.join(', ')}`);
    if (doc.rent_context === null && !(doc.warnings ?? []).some((w) => /rent_context_unavailable/.test(w))) {
      errors.push('null rent_context without unavailable-warning');
    }
    if (doc.renovated_spread === null && !(doc.warnings ?? []).some((w) => /renovated_spread/.test(w))) {
      errors.push('null renovated_spread without warning');
    }
  }
  return { valid: errors.length === 0, errors };
}

// A snapshot is usable for a scoring as-of only if it was computed at-or-before
// that as-of (immutability + time safety).
export function snapshotForAsOf(snapshots, propertyId, asOf) {
  const usable = snapshots
    .filter((s) => s.subject_property_id === propertyId && toMs(s.as_of) !== null && toMs(s.as_of) <= toMs(asOf))
    .sort((a, b) => toMs(b.as_of) - toMs(a.as_of));
  return usable[0] ?? null;
}

export function loadSnapshotFile(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const v = validateSnapshot(doc);
  if (!v.valid) throw new Error(`invalid comp snapshot ${path}: ${v.errors.join('; ')}`);
  return doc;
}
