// ─── seller-situation/codec.js ──────────────────────────────────────────────
// Slim storage (§7). One row per property in the PROPOSED table
// public.seller_situation_scores. Evidence is stored as compact tuples
// [code, points, component_index, source_index, value?]; component / provenance / source
// table+field are normalized into the static registries below (mirrored in the
// PROPOSED reference table seller_situation_evidence_sources), so a row never
// repeats them. Measured ≈ 0.6–1.2 KB/row (vs ≈ 92 KB/row in
// property_acquisition_scores, 90% of which is comp evidence).

import { FACT_FIELDS, COMPONENTS, SCORE_VERSION, INPUT_MODEL_VERSION } from './model.js';

/** Stable, append-only. NEVER reorder: stored rows reference the index. */
export const SOURCE_REGISTRY = Object.freeze([
  'unknown.unknown',
  'properties.property_flags_text',
  ...FACT_FIELDS.flatMap(([, fField, pField]) => [
    fField ? `seller.property_features_v1.${fField}` : null,
    pField ? `properties.${pField}` : null,
  ]).filter(Boolean),
  'properties.owner_location',
  'properties.is_foreclosure',
  'properties.is_pre_foreclosure',
  'properties.is_hot_preforeclosure',
  'properties.is_hot_pre_foreclosure',
  'seller.property_features_v1.own_absentee_class',
].filter((v, i, a) => a.indexOf(v) === i));

const SOURCE_INDEX = new Map(SOURCE_REGISTRY.map((s, i) => [s, i]));

export function sourceIndex(table, field) {
  return SOURCE_INDEX.get(`${table}.${field}`) ?? 0;
}

export function decodeSource(index) {
  const s = SOURCE_REGISTRY[index] ?? 'unknown.unknown';
  const cut = s.lastIndexOf('.');
  return { source_table: s.slice(0, cut), source_field: s.slice(cut + 1) };
}

const PROVENANCE_BY_SOURCE = (() => {
  const m = new Map([['properties.property_flags_text', 'vendor_flag']]);
  for (const [, fField, pField, provenance] of FACT_FIELDS) {
    if (fField) m.set(`seller.property_features_v1.${fField}`, provenance);
    if (pField) m.set(`properties.${pField}`, provenance === 'public_record' ? 'vendor_record' : provenance);
  }
  return m;
})();

/** Encode a scoreSellerSituation result into a slim DB row. */
export function encodeSellerSituationRow(result, { runId = null, featuresAsOf = null } = {}) {
  const c = result.components || {};
  return {
    property_id: result.property_id,
    score_version: result.score_version,
    input_model_version: result.input_model_version,
    weights_version: result.weights_version ?? null,
    scored_at: result.scored_at,
    forced_sale_pressure: c.forced_sale_pressure,
    landlord_fatigue: c.landlord_fatigue,
    equity_unlock: c.equity_unlock,
    property_burden: c.property_burden,
    tax_pain: c.tax_pain,
    debt_pressure: c.debt_pressure,
    sell_p90: result.sell_probability?.d90 ?? null,
    sell_p180: result.sell_probability?.d180 ?? null,
    sell_p365: result.sell_probability?.d365 ?? null,
    seller_situation: result.seller_situation,
    conversation_angle: result.conversation_angle,
    opportunity_tier: result.opportunity_tier,
    tier_reasons: result.tier_reasons,
    evidence: (result.evidence || []).map((e) => {
      const tuple = [e.code, e.points, COMPONENTS.indexOf(e.component), sourceIndex(e.source_table, e.source_field)];
      if (e.value !== true && e.value !== null && e.value !== undefined) tuple.push(e.value);
      return tuple;
    }),
    coverage: result.coverage?.ratio ?? null,
    missing_fields: result.coverage?.missing ?? [],
    confidence: result.confidence,
    features_as_of: featuresAsOf,
    legacy_final_acquisition_score: result.legacy_shadow?.final_acquisition_score ?? null,
    run_id: runId,
  };
}

/** Rebuild the full evidence list (for Inspector / why-targeted) from a slim row. */
export function decodeEvidence(row) {
  return (row?.evidence || []).map(([code, points, componentIdx, idx, value]) => {
    const src = decodeSource(idx);
    return {
      code,
      points,
      component: COMPONENTS[componentIdx] ?? null,
      ...src,
      value: value === undefined ? true : value,
      provenance: PROVENANCE_BY_SOURCE.get(`${src.source_table}.${src.source_field}`) ?? 'vendor_record',
    };
  });
}

export function rowBytes(row) {
  return Buffer.byteLength(JSON.stringify(row), 'utf8');
}

/** Column → SQL type (matches PROPOSED_20261007071100_seller_situation_scores.sql). */
export const ROW_COLUMN_TYPES = Object.freeze({
  property_id: 'text', score_version: 'text', input_model_version: 'text', weights_version: 'text', scored_at: 'timestamptz',
  forced_sale_pressure: 'smallint', landlord_fatigue: 'smallint', equity_unlock: 'smallint', property_burden: 'smallint',
  tax_pain: 'smallint', debt_pressure: 'smallint', sell_p90: 'smallint', sell_p180: 'smallint', sell_p365: 'smallint',
  seller_situation: 'text', conversation_angle: 'text', opportunity_tier: 'text', tier_reasons: 'text[]', evidence: 'jsonb',
  coverage: 'numeric', missing_fields: 'text[]', confidence: 'numeric', features_as_of: 'date',
  legacy_final_acquisition_score: 'numeric', run_id: 'text',
});

export const ROW_COLUMNS = Object.freeze([
  'property_id', 'score_version', 'input_model_version', 'weights_version', 'scored_at',
  ...COMPONENTS, 'sell_p90', 'sell_p180', 'sell_p365', 'seller_situation', 'conversation_angle',
  'opportunity_tier', 'tier_reasons', 'evidence', 'coverage', 'missing_fields', 'confidence',
  'features_as_of', 'legacy_final_acquisition_score', 'run_id',
]);

export { SCORE_VERSION, INPUT_MODEL_VERSION };
