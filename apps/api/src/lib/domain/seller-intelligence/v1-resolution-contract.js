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
 * THE NORMALISATION, PINNED EXACTLY — uppercase, strip everything non-alpha.
 *
 * Measured per branch, which is what resolved the earlier "~0.92% residual":
 * that figure conflated two branches with different contracts.
 *
 *   name_exact        977 /   977  = 100.000%   <- the branch the cohort uses
 *   name_exact_vendor 53,368 / 53,413 = 99.916%
 *
 * For `name_exact` there is NO residual and no further rule is needed: no
 * suffix stripping, no middle-initial handling, nothing. Adding a suffix rule
 * changes nothing on that branch (977/977 either way), so it is deliberately
 * absent rather than carried "just in case".
 *
 * The 45 `name_exact_vendor` exceptions are not normalisation failures. 33 are
 * generational suffixes (a "Sr." matched against a "Jr", so the producer was
 * clearly ignoring them) and the remaining 12 are genuinely different names —
 * "Dale R Irvin" against "Donald A Irvin". On that branch the VENDOR ASSERTION
 * is authoritative and the name never had to match, which is exactly why the
 * cohort cannot borrow it.
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
  sampled: 60000,
  entity_gate: { predicted: 17606, agreed_entity_owned: 17605 },
  name_exact_vendor: { predicted: 17800, correct: 17734, silent_wrong: 7 },
  vendor_asserted: { predicted: 10192, correct: 9493, silent_wrong: 9 },
  // The branch the cohort actually uses. Zero silent misassignments.
  name_exact: { predicted: 216, correct: 202, silent_wrong: 0 },
  refused_ambiguous: 12291,
  refused_unresolved: 1895,
  note: 'ties fail closed; no tie-break rule was accepted',
});

/**
 * WHY THERE IS NO TIE-BREAK.
 *
 * Among properties with several equally-qualifying candidates, the best signal
 * found was "most phones", at 92.2% — and a composite ordering
 * (phones, emails, key) did slightly worse at 91.26%. Recency explained 45%,
 * related-contact count 62%.
 *
 * None is deterministic, and ~8% silent misassignment is not a rounding error:
 * it is a wrong human attached to a property with no signal that anything went
 * wrong. So ties return `ambiguous` and pick nobody. A false unresolved costs a
 * lead; a false identity costs the wrong person a text message.
 */
export const REJECTED_TIEBREAKS = Object.freeze({
  max_phone_count: 0.922,
  phones_then_emails_then_key: 0.9126,
  related_contacts_count: 0.62,
  provider_updated_at: 0.45,
  accepted: null,
});

/**
 * File-10 dry run, all 6,808, read-only. Manifest md5 43002ec0e483680241a3ffb95d8760e6.
 */
export const FILE10_DRY_RUN = Object.freeze({
  total: 6808,
  high_confidence_name_exact: 2962,
  medium_confidence_vendor_asserted: 79,
  confirmed_name_exact_vendor: 66,
  ambiguous_tie_failed_closed: 60,
  unresolved_no_qualifying_branch: 3641,
  entity_owned: 0,
  safely_resolved: 3107,
  best_contact_derivable: 3104,
  callable_phone: 3071,
  manifest_md5: '43002ec0e483680241a3ffb95d8760e6',
});

export const RESOLUTION_REPRODUCIBILITY = Object.freeze({
  candidate_set: 'deterministic_recovered',       // record_entity_id, 100.000% recall
  branch_table: 'deterministic_recovered',        // method -> status/confidence, categorical
  candidate_selection: 'recovered_95pct_tiebreak_unsolved',
  vendor_branches: 'blocked_missing_vendor_assertion_fields',
  name_normalisation: 'exact_for_name_exact_branch',
  passthrough_fields: 'deterministic_recovered',
});

export default {
  RESOLUTION_BRANCHES,
  VENDOR_FREE_BRANCH,
  UNMATCHED_ENTITY_PREFIX,
  PASSTHROUGH_FIELDS,
  COHORT_VENDOR_FREE_REACH,
  RESOLUTION_PARITY,
  REJECTED_TIEBREAKS,
  FILE10_DRY_RUN,
  RESOLUTION_REPRODUCIBILITY,
  isRealEntityKey,
  normaliseOwnerName,
  isExactNameMatch,
  selectResolutionBranch,
};
