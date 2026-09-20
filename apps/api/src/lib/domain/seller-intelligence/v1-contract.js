/**
 * SELLER INTELLIGENCE V1 — THE CONTRACT, RECONSTRUCTED FROM ITS OUTPUTS.
 *
 * The producer that wrote all 169,790 v1.0.0 projections in a single wave on
 * 2026-08-07 exists nowhere: not in this repo's history, not in the project
 * that owns the seller schema, not in any migration, not as a database
 * function. So the persisted rows ARE the specification, and this module is
 * what could be read back out of them.
 *
 * NOTHING HERE COMPUTES A SCORE. These are measured constants and a verified
 * composition, recorded so a future rebuild starts from evidence instead of
 * from a guess. No database connection, no vendor call, no write path.
 *
 * ── THE ROUTING QUESTION, SETTLED ──────────────────────────────────────────
 *
 * Every one of the 169,790 score rows is `provisional = true`, version
 * `v1.0.0-provisional`, and carries four restrictions verbatim, including
 * "not eligible for campaign routing". That reads alarming. It is not, and the
 * reason is structural rather than reassuring:
 *
 * `campaign_eligible_v1` references exactly three score columns in its WHERE
 * clause — `score_coverage`, `overall_data_confidence`, `identity_confidence`.
 * All three are byte-identical to the same-named columns in
 * `property_features_v1` on 169,790 of 169,790 rows: they are copied from the
 * FEATURE layer, which is plain `v1.0.0` and carries no restriction at all.
 * They measure how complete the data is, not how attractive the deal is, and
 * no weight touches them.
 *
 * `priority_score` and `priority_tier` — the uncalibrated, ordinal-default
 * weighted outputs the restrictions are actually about — appear only in the
 * SELECT list. They gate nothing. And downstream,
 * `campaign_target_graph.acquisition_score` equals
 * `public.properties.final_acquisition_score` on 169,797 of 169,797 rows while
 * matching V1's `priority_score` on 2, so the graph's ordering comes from the
 * legacy public column, not from here.
 *
 * `campaign_eligible_v1` also has no application consumer at all.
 *
 * So the restricted scores drive neither eligibility nor ordering. The warning
 * is accurate about the weights and irrelevant to routing.
 */

/** Verbatim, as persisted on all 169,790 rows. Not paraphrased. */
export const V1_SCORE_USAGE_RESTRICTIONS = Object.freeze([
  'uncalibrated: weights origin=ordinal_default',
  'not eligible for campaign routing',
  'not eligible for automated offers',
  'not eligible for production lead prioritization',
]);

export const V1_BUILD = Object.freeze({
  score_version: 'v1.0.0-provisional',
  feature_version: 'v1.0.0',
  resolution_version: 'v1.0.0',
  contact_version: 'v1.0.0',
  provisional: true,
  rows: 169790,
  built_wave_utc: '2026-08-07T00:00Z/01:00Z',
  as_of_date: '2026-07-18',
  source_manifest_sha256: 'e44887d04ac35d2e196bea4c3c6a48de7dc9a7f7175ffef7be1d08685d55b3fd',
  params_sha256: '79798d50a9cda73a4b8e9ff2d2bce91a6468cdb0ad8baafa7eb746127b83d9ab',
  reference_build_id: '4b05f368-bd9d-9566-723a-15ad9aaa115e',
  engine_tag: 'v1.0.0 ordinal_default',
});

/**
 * The three score columns `campaign_eligible_v1` actually gates on, extracted
 * from the view's own WHERE clause rather than assumed from names.
 */
export const ELIGIBILITY_GATING_SCORE_COLUMNS = Object.freeze([
  'score_coverage',
  'overall_data_confidence',
  'identity_confidence',
]);

/** Gating columns proven to be copied verbatim from `property_features_v1`. */
export const FEATURE_DERIVED_GATING_COLUMNS = Object.freeze([
  'score_coverage',
  'overall_data_confidence',
  'identity_confidence',
  'eligible_component_count',
]);

/** Weighted outputs the restrictions concern. None of these gate or order. */
export const NON_ROUTING_SCORE_COLUMNS = Object.freeze(['priority_score', 'priority_tier']);

/**
 * `identity_confidence` is not computed per property — it is a constant per
 * owner-resolution status. Measured across all 169,790 rows, min = max = mean
 * for every status, so these are exact.
 *
 * `unresolved` carries NULL rather than 0: no identity was established, which
 * is not the same as an identity with no confidence.
 */
export const IDENTITY_CONFIDENCE_BY_STATUS = Object.freeze({
  confirmed: 0.95,
  entity_owned: 0.90,
  high_confidence: 0.85,
  medium_confidence: 0.65,
  ambiguous: 0.35,
  conflicting_existing_assignment: 0.25,
  unresolved: null,
});

/** The statuses `campaign_eligible_v1` admits. */
export const ELIGIBLE_RESOLUTION_STATUSES = Object.freeze([
  'confirmed', 'high_confidence', 'medium_confidence',
]);

/** Thresholds, read from the view definition. */
export const ELIGIBILITY_THRESHOLDS = Object.freeze({
  score_coverage: 0.60,
  overall_data_confidence: 0.40,
  identity_confidence: 0.65,
});

/** Match methods, with the statuses each was observed producing. */
export const MATCH_METHODS = Object.freeze({
  name_exact_vendor: ['confirmed'],
  entity_flags: ['entity_owned'],
  name_partial_vendor: ['medium_confidence', 'conflicting_existing_assignment'],
  vendor_asserted: ['medium_confidence', 'conflicting_existing_assignment'],
  name_exact: ['high_confidence', 'medium_confidence', 'conflicting_existing_assignment'],
  // `ambiguous` and `unresolved` persist a NULL match_method — no method
  // succeeded, which the producer recorded as absence rather than a label.
});

/**
 * THE COMPOSITION, RECOVERED EXACTLY.
 *
 *     priority_score = M^0.4 · E^0.4 · F^0.2
 *
 * Verified against 50,000 rows carrying a non-zero M: max absolute error
 * 7.55e-6, mean 5.3e-10. That residual is the pillars being persisted rounded
 * to six decimals, not a modelling gap.
 *
 * It is multiplicative, not additive, and the data shows it: `priority_score`
 * is zero on exactly the 1,096 sampled rows where M is zero, and on no others.
 * No amount of equity or feasibility can compensate for absent motivation.
 */
export const PRIORITY_PILLAR_EXPONENTS = Object.freeze({ M: 0.4, E: 0.4, F: 0.2 });

export const PRIORITY_COMPOSITION_ACCURACY = Object.freeze({
  rows_verified: 50000,
  max_abs_error: 7.55e-6,
  mean_abs_error: 5.284e-10,
  residual_cause: 'pillars persisted at 6 decimal places',
});

/**
 * Recompute `priority_score` from the persisted pillars.
 *
 * Provided to let a rebuild check itself against the existing 169,790 rows,
 * not to score anything new: its inputs are outputs of the missing producer.
 */
export function composePriorityScore({ M, E, F } = {}) {
  const m = Number(M); const e = Number(E); const f = Number(F);
  if (![m, e, f].every(Number.isFinite)) return null;
  if (m < 0 || e < 0 || f < 0) return null;
  // Multiplicative: a zero pillar zeroes the score, and 0^0.4 is 0.
  if (m === 0 || e === 0 || f === 0) return 0;
  const { M: a, E: b, F: c } = PRIORITY_PILLAR_EXPONENTS;
  return Math.exp(a * Math.log(m) + b * Math.log(e) + c * Math.log(f));
}

/**
 * Does a restricted score column influence routing?
 *
 * The honest answer is per-column, and it is the whole point of the audit:
 * the confidence/coverage columns gate, the weighted columns do not.
 */
export function scoreColumnRoutingRole(column) {
  const name = String(column ?? '').trim();
  if (ELIGIBILITY_GATING_SCORE_COLUMNS.includes(name)) {
    return {
      gates_eligibility: true,
      affects_ordering: false,
      weight_dependent: false,
      note: 'copied verbatim from property_features_v1 (v1.0.0, unrestricted)',
    };
  }
  if (NON_ROUTING_SCORE_COLUMNS.includes(name)) {
    return {
      gates_eligibility: false,
      affects_ordering: false,
      weight_dependent: true,
      note: 'uncalibrated ordinal_default weights; selected but never gates, and the graph orders on public.properties.final_acquisition_score',
    };
  }
  return { gates_eligibility: false, affects_ordering: false, weight_dependent: null, note: 'not referenced by campaign_eligible_v1' };
}

/**
 * Reproducibility of each V1 layer, per §8/§14.
 *
 * `owner_hash_dependent` is the live blocker: the identity and contact layers
 * need the vendor household key that the 6,808 do not have.
 */
export const V1_REPRODUCIBILITY = Object.freeze({
  priority_composition: 'deterministic_recovered',
  identity_confidence: 'deterministic_recovered',
  owner_resolution_status: 'owner_hash_dependent',
  best_contact: 'owner_hash_dependent',
  component_and_pillar_weights: 'not_persisted_as_parameters',
  feature_families: 'mostly_derivable_from_db_facts',
  execution_metadata: 'historical_opaque',
});

export default {
  V1_SCORE_USAGE_RESTRICTIONS,
  V1_BUILD,
  ELIGIBILITY_GATING_SCORE_COLUMNS,
  FEATURE_DERIVED_GATING_COLUMNS,
  NON_ROUTING_SCORE_COLUMNS,
  IDENTITY_CONFIDENCE_BY_STATUS,
  ELIGIBLE_RESOLUTION_STATUSES,
  ELIGIBILITY_THRESHOLDS,
  MATCH_METHODS,
  PRIORITY_PILLAR_EXPONENTS,
  PRIORITY_COMPOSITION_ACCURACY,
  V1_REPRODUCIBILITY,
  composePriorityScore,
  scoreColumnRoutingRole,
};
