/**
 * In-process valuation event bus for Comp Intelligence → Acquisition Engine handoff.
 * Idempotent by input hash; does not trigger automated offers.
 */

const listeners = new Set();
const publishedHashes = new Map();

export const VALUATION_EVENT_VERSION = 'comp_intelligence.valuation.ready.v1';

export function subscribeValuationEvents(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishValuationReadyEvent(payload = {}) {
  const key = `${payload.property_id}:${payload.input_hash}`;
  const previous = publishedHashes.get(key);
  if (previous && previous.valuation_snapshot_id === payload.valuation_snapshot_id) {
    return { published: false, reason: 'duplicate_event', event: previous };
  }

  const event = {
    version: VALUATION_EVENT_VERSION,
    published_at: new Date().toISOString(),
    property_id: payload.property_id,
    opportunity_id: payload.opportunity_id ?? null,
    valuation_snapshot_id: payload.valuation_snapshot_id ?? null,
    model_version: payload.model_version,
    input_hash: payload.input_hash,
    arv: payload.arv,
    as_is_value: payload.as_is_value,
    repair_estimate: payload.repair_estimate,
    recommended_offer: payload.recommended_offer,
    maximum_offer: payload.maximum_offer,
    confidence: payload.confidence,
    strategy: payload.strategy ?? null,
    data_gaps: payload.data_gaps ?? [],
    included_comp_ids: payload.included_comp_ids ?? [],
    coordinate_source: payload.coordinate_source ?? null,
  };

  publishedHashes.set(key, event);
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error('[comp-intelligence] valuation event listener failed', err);
    }
  }

  return { published: true, event };
}

export function resetValuationEventsForTests() {
  listeners.clear();
  publishedHashes.clear();
}

export default { publishValuationReadyEvent, subscribeValuationEvents, resetValuationEventsForTests };