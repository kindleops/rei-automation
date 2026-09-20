/**
 * V1 OWNER-RESOLUTION CONTRACT, RECONSTRUCTED FROM 169,790 PERSISTED ROWS.
 *
 * ── A CORRECTION THAT CHANGES THE PROGRAM ──────────────────────────────────
 *
 * Two earlier passes concluded that `seller.property.owner_hash` is the
 * canonical property→owner link and that the 6,808 were therefore blocked on a
 * vendor re-export. That was wrong, and the evidence that overturned it came
 * from the 93 rows nobody had looked at: properties from the registered Files
 * 1-9 that carry NULL owner_hash. All 93 were projected successfully anyway,
 * and 48 of them reached an `individual_key` and a best contact.
 *
 * They did it through `seller.source_row.record_entity_id`, which stores the
 * person key directly — 48/48 of those, and on a 30,000-row sample of the
 * general population the persisted `individual_key` is among a property's
 * `record_entity_id` values **100.000% of the time, with zero exceptions**.
 *
 * `owner_hash` is a HOUSEHOLD key. `record_entity_id` is the PERSON key, and
 * the person key is what resolution actually needs. All 6,808 have one.
 *
 * ── WHAT IS STILL MISSING, AND IT IS NOT THE LINK ──────────────────────────
 *
 * File 10 omitted the vendor's ownership-ASSERTION fields:
 * `matches_property_owner` is NULL on 11,742 of 11,992 cohort owner identities
 * (97.9%), and `matching_type` likewise. Three of the four resolution branches
 * require that assertion, so those three are unreachable for the cohort.
 *
 * The fourth does not. That is the whole opportunity.
 */

/**
 * The branch table, read off production. Counts are from a 40,000-row sample;
 * the pattern is categorical, not statistical.
 *
 *   vendor assertion present (matches_property_owner = true):
 *     + exact name   -> name_exact_vendor    -> confirmed         (100% true, 99.95% name-exact)
 *     + partial name -> name_partial_vendor  -> medium_confidence (100% true)
 *     + no name      -> vendor_asserted      -> medium_confidence (100% true)
 *
 *   vendor assertion absent (matches_property_owner IS NULL):
 *     + exact name   -> name_exact           -> HIGH_CONFIDENCE   (0% true, 100% name-exact)
 *
 * The last row is the one that matters: `name_exact` reaches
 * `high_confidence` with NO vendor field at all — 304/304 sampled winners had
 * a NULL assertion and an exact name match. It is exactly the evidence the
 * 6,808 still have.
 */
export const RESOLUTION_BRANCHES = Object.freeze([
  Object.freeze({
    match_method: 'name_exact_vendor',
    status: 'confirmed',
    identity_confidence: 0.95,
    requires_vendor_assertion: true,
    requires_exact_name: true,
  }),
  Object.freeze({
    match_method: 'name_partial_vendor',
    status: 'medium_confidence',
    identity_confidence: 0.65,
    requires_vendor_assertion: true,
    requires_exact_name: false,
  }),
  Object.freeze({
    match_method: 'vendor_asserted',
    status: 'medium_confidence',
    identity_confidence: 0.65,
    requires_vendor_assertion: true,
    requires_exact_name: false,
  }),
  Object.freeze({
    match_method: 'name_exact',
    status: 'high_confidence',
    identity_confidence: 0.85,
    requires_vendor_assertion: false,
    requires_exact_name: true,
  }),
]);

/** The only branch reachable without vendor assertion fields. */
export const VENDOR_FREE_BRANCH = 'name_exact';

/**
 * Candidate owners for a property come from its source rows' person keys.
 * `unmatched_*` sentinels are not identities and are excluded — they encode a
 * failed match, not a person.
 */
export const UNMATCHED_ENTITY_PREFIX = 'unmatched';

export function isRealEntityKey(recordEntityId) {
  const v = String(recordEntityId ?? '').trim();
  return v !== '' && !v.startsWith(UNMATCHED_ENTITY_PREFIX);
}

/**
 * Name comparison, normalised the way the persisted data implies.
 *
 * Raw equality of the winner's `full_name` against `owner_1_name` holds on
 * 99.08% of `name_exact_vendor` rows; stripping non-alphabetic characters and
 * casing closes most of the remainder, which is punctuation and middle
 * initials. The residual is NOT claimed to be solved — see
 * RESOLUTION_REPRODUCIBILITY.name_normalisation.
 */
export function normaliseOwnerName(name) {
  return String(name ?? '').replace(/[^A-Za-z]/g, '').toUpperCase();
}

export function isExactNameMatch(candidateFullName, propertyOwner1Name) {
  const a = normaliseOwnerName(candidateFullName);
  const b = normaliseOwnerName(propertyOwner1Name);
  return a !== '' && a === b;
}

/**
 * Which branch does this candidate set support?
 *
 * Returns the branch and the winning candidate, or an explicit refusal. It
 * never picks between two equally-matching candidates: on the cohort that
 * situation is 32 properties, and a coin-flip there assigns the wrong owner
 * silently.
 */
export function selectResolutionBranch(property = {}, candidates = []) {
  const usable = candidates.filter((c) => isRealEntityKey(c.individual_key));
  if (usable.length === 0) {
    return { status: 'unresolved', match_method: null, individual_key: null, reason: 'no_candidates' };
  }

  const asserted = usable.filter((c) => c.matches_property_owner === true
    && c.likely_renting !== true);
  const nameMatched = usable.filter((c) => isExactNameMatch(c.full_name, property.owner_1_name));

  const assertedExact = asserted.filter((c) => isExactNameMatch(c.full_name, property.owner_1_name));
  if (assertedExact.length === 1) return branch('name_exact_vendor', assertedExact[0]);
  if (assertedExact.length > 1) return ambiguous('multiple_vendor_exact');

  // Vendor-free branch. Reachable by the 6,808; this is the one that matters.
  const vendorFreeExact = nameMatched.filter((c) => c.matches_property_owner !== true);
  if (asserted.length === 0 && vendorFreeExact.length === 1) {
    return branch('name_exact', vendorFreeExact[0]);
  }
  if (asserted.length === 0 && vendorFreeExact.length > 1) return ambiguous('multiple_name_exact');

  if (asserted.length === 1) return branch('vendor_asserted', asserted[0]);
  if (asserted.length > 1) return ambiguous('multiple_vendor_asserted');

  return { status: 'ambiguous', match_method: null, individual_key: null, reason: 'no_qualifying_candidate' };
}

function branch(matchMethod, candidate) {
  const spec = RESOLUTION_BRANCHES.find((b) => b.match_method === matchMethod);
  return {
    status: spec.status,
    match_method: matchMethod,
    identity_confidence: spec.identity_confidence,
    individual_key: candidate.individual_key,
    matched_full_name: candidate.full_name ?? null,
    reason: null,
  };
}

function ambiguous(reason) {
  // Production records ambiguity as status `ambiguous` with a NULL
  // match_method — absence of a method, not a label for one.
  return { status: 'ambiguous', match_method: null, individual_key: null, reason };
}

/**
 * Fields proven to be straight copies, so a rebuild must not recompute them.
 *   deed_owner_name   = seller.property.owner_1_name   (5,000/5,000)
 *   matched_full_name = winning owner's full_name      (5,000/5,000)
 */
export const PASSTHROUGH_FIELDS = Object.freeze({
  deed_owner_name: 'seller.property.owner_1_name',
  matched_full_name: 'selected seller.owner.full_name',
});

/**
 * Measured cohort reach for the vendor-free branch: 3,067 of 6,808 properties
 * (45.05%) have a normalised exact name match, of which 3,035 are unique.
 */
export const COHORT_VENDOR_FREE_REACH = Object.freeze({
  cohort: 6808,
  name_matchable: 3067,
  unique_name_match: 3035,
  ambiguous_name_match: 32,
  no_name_match: 3741,
});

/**
 * MEASURED PARITY of `selectResolutionBranch` against persisted production,
 * 12,000 rows. Recorded because the first version of this rule scored 1/12,000
 * and looked catastrophic — the fault was the parity harness counting duplicate
 * (source_row x owner) join rows instead of DISTINCT candidates, which inflated
 * every candidate count past 1 and forced "ambiguous". Corrected:
 */
export const RESOLUTION_PARITY = Object.freeze({
  sampled: 12000,
  name_exact_vendor: { n: 9664, method_and_key_pct: 95.47, predicted_ambiguous: 432 },
  vendor_asserted: { n: 2316, method_pct: 99.01, method_and_key_pct: 87.09 },
  name_exact: { n: 20, method_and_key_pct: 95.00 },
  unrecovered: 'tie-break among multiple qualifying candidates',
});

export const RESOLUTION_REPRODUCIBILITY = Object.freeze({
  candidate_set: 'deterministic_recovered',       // record_entity_id, 100.000% recall
  branch_table: 'deterministic_recovered',        // method -> status/confidence, categorical
  candidate_selection: 'recovered_95pct_tiebreak_unsolved',
  vendor_branches: 'blocked_missing_vendor_assertion_fields',
  name_normalisation: 'approximate_0_92pct_residual',
  passthrough_fields: 'deterministic_recovered',
});

export default {
  RESOLUTION_BRANCHES,
  VENDOR_FREE_BRANCH,
  UNMATCHED_ENTITY_PREFIX,
  PASSTHROUGH_FIELDS,
  COHORT_VENDOR_FREE_REACH,
  RESOLUTION_PARITY,
  RESOLUTION_REPRODUCIBILITY,
  isRealEntityKey,
  normaliseOwnerName,
  isExactNameMatch,
  selectResolutionBranch,
};
