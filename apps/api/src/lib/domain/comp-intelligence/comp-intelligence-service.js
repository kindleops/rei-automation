import { loadCanonicalSubjectProperty } from './canonical-subject-property.js';
import { discoverCompsForSubject } from './comp-discovery.js';
import {
  buildSnapshotPayload,
  buildValuationInputHash,
  computeValuationOutputs,
  deriveValuationState,
} from './valuation-pipeline.js';
import { projectCompIntelligenceV3Decision } from './comp-intelligence-v3-projection.js';

/**
 * Comp Intelligence pipeline — authoritative V3 decision projection + legacy V1 evidence.
 *
 * V3 projection is read-only (no score writes, no snapshot writes, no events).
 * Legacy V1 valuation is retained for compatibility only under legacy_valuation.
 */
export async function runCompIntelligencePipeline(propertyId, context = {}, options = {}, deps = {}) {
  const startedAt = Date.now();
  const persistSnapshots = options.persist === true && options.allowLegacyPersistence === true;

  const subjectResult = await loadCanonicalSubjectProperty(propertyId, context, deps);
  if (!subjectResult.ok) {
    return {
      ok: false,
      error: subjectResult.error,
      valuation_state: deriveValuationState({ subject: null }),
      queryMs: Date.now() - startedAt,
    };
  }

  const v3Projection = await projectCompIntelligenceV3Decision(
    propertyId,
    context,
    options,
    deps,
  );

  const discovery = await discoverCompsForSubject(subjectResult.subject, options, deps);
  const legacyValuation = computeValuationOutputs(subjectResult.subject, discovery);

  const valuationState = v3Projection.ok && v3Projection.valuation_state
    ? v3Projection.valuation_state
    : deriveValuationState({
        subject: subjectResult.subject,
        discovery,
        valuation: legacyValuation,
      });

  return {
    ok: true,
    subject: subjectResult.subject,
    discovery,
    decision_projection: v3Projection.ok ? v3Projection.decision_projection : null,
    transaction_evidence: v3Projection.ok ? v3Projection.transaction_evidence : [],
    qualification_summary: v3Projection.ok ? v3Projection.qualification_summary : null,
    projection_meta: v3Projection.ok
      ? v3Projection.projection_meta
      : { read_only: true, persisted: false, snapshot_write: false, event_publication: false },
    legacy_valuation: {
      model_version: legacyValuation.model_version,
      arv: legacyValuation.arv,
      as_is_value: legacyValuation.as_is_value,
      repair_estimate: legacyValuation.repair_estimate,
      confidence: legacyValuation.confidence,
      data_gaps: legacyValuation.data_gaps,
      warnings: legacyValuation.warnings,
      outputs: legacyValuation.outputs,
      supporting_comp_ids: legacyValuation.supporting_comp_ids,
      authoritative: false,
      label: 'Legacy V1 comp intelligence valuation — not authoritative',
    },
    valuation: legacyValuation,
    valuation_state: valuationState,
    snapshot: { persisted: false, reason: persistSnapshots ? 'legacy_persistence_disabled' : 'read_only_v3_projection' },
    input_hash: buildValuationInputHash(subjectResult.subject, discovery, legacyValuation),
    queryMs: Date.now() - startedAt,
  };
}

export default { runCompIntelligencePipeline };