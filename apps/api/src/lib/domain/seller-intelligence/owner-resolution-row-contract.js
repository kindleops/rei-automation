/**
 * THE property_owner_resolution_v1 ROW CONTRACT, FOR THE name_exact BRANCH.
 *
 * Every column below was recovered from the 945 persisted
 * `name_exact` / `high_confidence` rows and then verified field-by-field
 * against all 945 at once: 945/945 on every field, and ZERO silent-wrong
 * individual_key selections. That parity run is what authorised writing.
 *
 * ── THE TWO OPERATIONAL COLUMNS ────────────────────────────────────────────
 *
 * `master_owner_id` and `operational_owner_name` are not computed. They are
 * reads of `public.properties` — the OPERATIONAL layer:
 *
 *     master_owner_id        = public.properties.master_owner_id   (945/945)
 *     operational_owner_name = public.properties.owner_name        (945/945)
 *
 * That matters more than it looks. All 169,790 historical projections belong
 * to properties present in `public.properties` — the count of historical rows
 * whose property is absent from it is exactly zero. The File-10 cohort is
 * absent from it by definition, so for these rows both columns are NULL and
 * `conflict_status` is `no_operational_assignment`.
 *
 * This is a row shape the original producer never emitted, and it is recorded
 * here rather than glossed: the state is within contract (488 of the 945
 * golden rows already carry `no_operational_assignment`, and the column is
 * nullable), but the combination is new, and a future reader deserves to know
 * that rather than discover it.
 *
 * ── PROVENANCE IS TRUTHFUL ─────────────────────────────────────────────────
 *
 * These rows were NOT produced by the 2026-08-07 one-shot producer, so they do
 * not carry its fingerprint. `source_manifest_sha256` is the sha256 of this
 * reconstruction's own manifest, and `as_of_date` is the File-10 observation
 * date (2026-08-31), not the historical 2026-07-18. `resolution_version`
 * stays `v1.0.0` because the SEMANTIC contract is unchanged and downstream
 * readers join on it.
 */

export const NAME_EXACT_ROW_CONTRACT = Object.freeze({
  resolution_version: 'v1.0.0',
  owner_resolution_status: 'high_confidence',
  match_method: 'name_exact',
  identity_confidence: 0.85,
  owner_role: 'primary_legal_owner',
  conflict_status_when_no_operational_record: 'no_operational_assignment',
  sub_owner_id: null,
  base_reason_code: 'OWNRES_NAME_EXACT',
  co_owner_reason_code: 'OWNRES_CO_OWNER_MATCHED',
});

/** Columns copied verbatim, with the source each was proven against. */
export const COLUMN_SOURCES = Object.freeze({
  deed_owner_name: 'seller.property.owner_1_name',
  matched_full_name: 'selected seller.owner.full_name',
  master_owner_id: 'public.properties.master_owner_id',
  operational_owner_name: 'public.properties.owner_name',
  // Includes the `unmatched_*` sentinels. Counting only real entities matched
  // 24/945; counting all of them matched 945/945, so the producer counted
  // everything it looked at, not everything it could use.
  candidate_count: 'count(distinct seller.source_row.record_entity_id), sentinels included',
});

export const GOLDEN_PARITY = Object.freeze({
  rows: 945,
  fields_at_full_parity: [
    'individual_key', 'co_owner_individual_key', 'candidate_count', 'master_owner_id',
    'conflict_status', 'matched_full_name', 'deed_owner_name', 'operational_owner_name',
    'owner_role', 'identity_confidence', 'reason_codes',
  ],
  silent_wrong_individual_key: 0,
});

/**
 * Build the row for one manifest entry.
 *
 * `operationalRow` is the `public.properties` row, or null when the property
 * has no operational counterpart — which is every File-10 row.
 */
export function buildResolutionRow(manifestEntry = {}, operationalRow = null, provenance = {}) {
  const hasCoOwner = Boolean(manifestEntry.co_owner_individual_key);
  const masterOwnerId = operationalRow?.master_owner_id ?? null;

  return {
    property_id: manifestEntry.property_id,
    resolution_version: NAME_EXACT_ROW_CONTRACT.resolution_version,
    as_of_date: provenance.as_of_date ?? null,
    built_at: provenance.built_at ?? null,
    source_manifest_sha256: provenance.source_manifest_sha256 ?? null,
    owner_resolution_status: NAME_EXACT_ROW_CONTRACT.owner_resolution_status,
    owner_role: NAME_EXACT_ROW_CONTRACT.owner_role,
    individual_key: manifestEntry.individual_key,
    sub_owner_id: null,
    master_owner_id: masterOwnerId,
    match_method: NAME_EXACT_ROW_CONTRACT.match_method,
    identity_confidence: NAME_EXACT_ROW_CONTRACT.identity_confidence,
    candidate_count: manifestEntry.candidate_count,
    co_owner_individual_key: manifestEntry.co_owner_individual_key ?? null,
    // Driven by master_owner_id presence — the relationship is 1:1 across all
    // 945 golden rows (457 consistent / 488 no_operational_assignment).
    conflict_status: masterOwnerId === null ? 'no_operational_assignment' : 'consistent',
    reason_codes: hasCoOwner
      ? [NAME_EXACT_ROW_CONTRACT.base_reason_code, NAME_EXACT_ROW_CONTRACT.co_owner_reason_code]
      : [NAME_EXACT_ROW_CONTRACT.base_reason_code],
    matched_full_name: manifestEntry.matched_full_name ?? null,
    deed_owner_name: manifestEntry.deed_owner_name ?? null,
    operational_owner_name: operationalRow?.owner_name ?? null,
  };
}

/**
 * The write guards (§9). Blast radius is the manifest; nothing is discovered
 * at run time.
 */
export function mayWriteRow(entry = {}, state = {}) {
  if (!state.in_manifest) return { allowed: false, refusal: 'not_in_manifest' };
  if (state.existing_resolution_row) return { allowed: false, refusal: 'already_resolved' };
  if (state.is_entity) return { allowed: false, refusal: 'entity_gate' };
  if (state.qualifying_candidate_count !== 1) return { allowed: false, refusal: 'not_exactly_one_candidate' };
  if (state.resolved_individual_key !== entry.individual_key) return { allowed: false, refusal: 'candidate_drift' };
  if (!state.name_still_matches) return { allowed: false, refusal: 'name_drift' };
  if (state.vendor_branch_now_applies) return { allowed: false, refusal: 'vendor_branch_precedence' };
  return { allowed: true, refusal: null };
}

/** Tables this pass is permitted to write. Exactly one. */
export const WRITABLE_TABLES = Object.freeze(['seller.property_owner_resolution_v1']);

export const FORBIDDEN_TABLES = Object.freeze([
  'seller.property_best_contact_v1',
  'seller.property_features_v1',
  'seller.property_scores_v1',
  'seller.property',
  'public.properties',
  'public.campaign_target_graph',
]);

/** Measured outcome of the certified run. */
export const BACKFILL_RESULT = Object.freeze({
  manifest_sha256: 'cfcfe9c8181db1840a98c744acd7966479efeb2d414ee91cf7ae94b3670a20c1',
  manifest_rows: 2962,
  inserted: 2962,
  with_co_owner: 214,
  refused: 0,
  total_before: 169790,
  total_after: 172752,
  rerun_inserted: 0,
  duplicates: 0,
});

export default {
  NAME_EXACT_ROW_CONTRACT,
  COLUMN_SOURCES,
  GOLDEN_PARITY,
  WRITABLE_TABLES,
  FORBIDDEN_TABLES,
  BACKFILL_RESULT,
  buildResolutionRow,
  mayWriteRow,
};
