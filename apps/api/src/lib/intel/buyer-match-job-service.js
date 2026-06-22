/**
 * Idempotent buyer-match background job contract.
 * Prevents duplicate concurrent jobs for the same property/model/data version.
 */

export const BUYER_MATCH_MODEL_VERSION = 'buyer_match_v2.1';
export const BUYER_MATCH_DATA_VERSION = '2026-06-22';

const TERMINAL_STATES = new Set(['completed', 'completed_with_limitations', 'blocked', 'failed']);
const ACTIVE_STATES = new Set([
  'pending',
  'resolving_subject',
  'loading_buyers',
  'building_purchase_graph',
  'inferring_buy_boxes',
  'scoring',
]);

export function buildIdempotencyKey({
  property_id,
  model_version = BUYER_MATCH_MODEL_VERSION,
  data_version = BUYER_MATCH_DATA_VERSION,
  valuation_snapshot_id = null,
}) {
  return [property_id, model_version, data_version, valuation_snapshot_id || 'no_valuation'].join(':');
}

export async function findActiveBuyerMatchJob(supabase, { property_id, idempotency_key }) {
  let query = supabase
    .from('buyer_match_runs')
    .select('*')
    .eq('property_id', property_id)
    .order('created_at', { ascending: false })
    .limit(5);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  const active = rows.find((row) => {
    const snapshot = row.selected_property_snapshot ?? {};
    const key = snapshot.idempotency_key;
    const status = row.run_status ?? row.status;
    return key === idempotency_key && ACTIVE_STATES.has(status);
  });
  return active ?? null;
}

export async function findFreshBuyerMatchResult(supabase, { property_id, idempotency_key, maxAgeMs = 6 * 60 * 60 * 1000 }) {
  const { data, error } = await supabase
    .from('buyer_match_runs')
    .select('*')
    .eq('property_id', property_id)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw error;

  const cutoff = Date.now() - maxAgeMs;
  return (data ?? []).find((row) => {
    const snapshot = row.selected_property_snapshot ?? {};
    const key = snapshot.idempotency_key;
    const status = row.run_status ?? row.status;
    const created = new Date(row.created_at).getTime();
    return (
      key === idempotency_key &&
      TERMINAL_STATES.has(status) &&
      status !== 'failed' &&
      created >= cutoff
    );
  }) ?? null;
}

export function jobSnapshotFromSubject(subject, extras = {}) {
  return {
    property_id: subject.property_id,
    address: subject.address,
    idempotency_key: extras.idempotency_key,
    model_version: extras.model_version ?? BUYER_MATCH_MODEL_VERSION,
    data_version: extras.data_version ?? BUYER_MATCH_DATA_VERSION,
    valuation_snapshot_id: extras.valuation_snapshot_id ?? null,
    coordinate_source: subject.coordinate_source ?? null,
    coordinate_confidence: subject.coordinate_confidence ?? null,
    normalized_filters: {
      zip: subject.zip,
      market: subject.market,
      state: subject.state,
      county: subject.county,
      asset_class: subject.asset_class,
      lat: subject.lat,
      lng: subject.lng,
      radius_miles: subject.radius_miles,
      estimated_value: subject.estimated_value,
      arv: subject.arv,
    },
    fallback_level: extras.fallback_level ?? null,
    rollup_level: extras.rollup_level ?? null,
    liquidity_score: extras.liquidity_score ?? null,
    confidence: extras.confidence ?? null,
    top_buyer_count: extras.top_buyer_count ?? 0,
    source_event: extras.source_event ?? 'property_selected',
    requested_at: new Date().toISOString(),
    ...extras,
  };
}