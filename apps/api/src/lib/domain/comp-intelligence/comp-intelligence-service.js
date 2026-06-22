import { loadCanonicalSubjectProperty } from './canonical-subject-property.js';
import { discoverCompsForSubject } from './comp-discovery.js';
import {
  buildSnapshotPayload,
  buildValuationInputHash,
  computeValuationOutputs,
  deriveValuationState,
  persistValuationSnapshotIfChanged,
} from './valuation-pipeline.js';
import { publishValuationReadyEvent } from './valuation-events.js';

export async function runCompIntelligencePipeline(propertyId, context = {}, options = {}, deps = {}) {
  const startedAt = Date.now();

  const subjectResult = await loadCanonicalSubjectProperty(propertyId, context, deps);
  if (!subjectResult.ok) {
    return {
      ok: false,
      error: subjectResult.error,
      valuation_state: deriveValuationState({ subject: null }),
      queryMs: Date.now() - startedAt,
    };
  }

  const discovery = await discoverCompsForSubject(subjectResult.subject, options, deps);
  const valuation = computeValuationOutputs(subjectResult.subject, discovery);
  const valuationState = deriveValuationState({
    subject: subjectResult.subject,
    discovery,
    valuation,
  });

  let snapshotResult = { persisted: false, reason: 'not_ready' };
  let inputHash = null;

  if (
    valuation.arv &&
    (valuationState.state === 'ready' || valuationState.state === 'ready_with_limitations')
  ) {
    inputHash = buildValuationInputHash(subjectResult.subject, discovery, valuation);
    const snapshot = buildSnapshotPayload({
      subjectContract: subjectResult.subject,
      discovery,
      valuation,
      masterOwnerId: context.masterOwnerId ?? context.master_owner_id ?? null,
      valuationType: options.valuationType ?? 'residential_arv',
    });
    snapshotResult = await persistValuationSnapshotIfChanged(snapshot, inputHash, deps);

    if (snapshotResult.persisted || snapshotResult.snapshot_id) {
      publishValuationReadyEvent({
        property_id: propertyId,
        opportunity_id: subjectResult.subject.opportunity_id?.value ?? null,
        valuation_snapshot_id: snapshotResult.snapshot_id ?? null,
        model_version: valuation.model_version,
        input_hash: inputHash,
        arv: valuation.arv,
        as_is_value: valuation.as_is_value,
        repair_estimate: valuation.repair_estimate,
        recommended_offer: valuation.outputs?.target_offer?.value ?? null,
        maximum_offer: valuation.outputs?.max_allowable_offer?.value ?? null,
        confidence: valuation.confidence,
        data_gaps: valuation.data_gaps,
        included_comp_ids: valuation.supporting_comp_ids,
        coordinate_source: subjectResult.subject.coordinate_source,
      });
    }
  }

  return {
    ok: true,
    subject: subjectResult.subject,
    discovery,
    valuation,
    valuation_state: valuationState,
    snapshot: snapshotResult,
    input_hash: inputHash,
    queryMs: Date.now() - startedAt,
  };
}

export default { runCompIntelligencePipeline };