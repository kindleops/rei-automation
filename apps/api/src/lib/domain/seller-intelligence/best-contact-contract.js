/**
 * BEST-CONTACT SELECTION — RECONSTRUCTION ATTEMPTED, NOT ACHIEVED.
 *
 * This module exists so the next person does not spend a day rediscovering
 * that this rule cannot be recovered from the evidence available. It records
 * what IS known, every hypothesis tested with the score that disqualified it,
 * and the single measurement that ends the argument.
 *
 * ── WHAT WAS RECOVERED ─────────────────────────────────────────────────────
 *
 * The SHAPE of the projection is clear. `legal_*` columns carry contacts of
 * the legal owner or co-owner; `reach_*` widens to `related` persons.
 * `legal_phone` is always drawn from the owner/co-owner phone pool — 6,000 of
 * 6,000 sampled, no exceptions — so the LINKAGE is right.
 *
 * And selection does not filter suppressed phones: only 72% of selected
 * `legal_phone` values are currently non-DNC and non-encrypted, while
 * `legal_phone_callable` exists as a separate flag. The producer picks a
 * phone and then records whether it can be called. That is a real finding and
 * it corrected an earlier assumption here.
 *
 * `legal_callable_count` is the one part that IS pinned: distinct phone values
 * for owner + co-owner, excluding do_not_call AND is_encrypted — 14,949 of
 * 15,000 (99.66%).
 *
 * ── WHAT WAS NOT, AND WHY IT BLOCKS ────────────────────────────────────────
 *
 * WHICH phone gets chosen could not be determined. The hypothesis space below
 * was tested across pool definitions (owner-only, owner+co-owner, suppressed
 * included, suppressed excluded) and orderings (slot ascending, descending,
 * wireless-first, owner-first). The best was 93.1%.
 *
 * 93.1% is not a near miss, it is roughly 200 of the 2,962 target rows getting
 * the WRONG PHONE NUMBER for the right person — numbers that would then be
 * texted. §9 asks for zero silent-wrong, and refuses percentage thresholds,
 * for exactly this reason.
 *
 * The measurement that settles it: restrict to properties where the pool holds
 * EXACTLY ONE candidate, so there is nothing to choose. Production still
 * disagrees on 134 of 13,894 (1.0%). When a selector cannot be verified even
 * where no selection occurs, the pool definition itself is still wrong, and no
 * ordering rule layered on top can be trusted.
 *
 * A fail-closed subset was considered — write only the 509 target rows with a
 * single callable candidate — and rejected on the same evidence: those are
 * precisely the cases the single-candidate test shows are not reliable.
 */

/** Pinned: the callable-count pool. */
export const CALLABLE_COUNT_RULE = Object.freeze({
  pool: 'seller.owner_phone for individual_key + co_owner_individual_key',
  excludes: ['do_not_call', 'is_encrypted'],
  distinct_on: 'phone_value',
  parity: 0.9966,
  sample: 15000,
});

/** Selection does NOT exclude suppressed phones; callability is recorded separately. */
export const SUPPRESSION_INTERACTION = Object.freeze({
  selection_filters_suppressed: false,
  evidence: 'only 72% of selected legal_phone values are currently non-DNC and non-encrypted',
  callability_recorded_in: 'legal_phone_callable / reach_phone_callable',
  campaign_suppression_applied_in: 'campaign_eligible_v1 via contact_outreach_state',
});

/** Every ordering hypothesis tested, with the score that disqualified it. */
export const REJECTED_SELECTION_RULES = Object.freeze({
  wireless_first_then_slot_asc_filtered_pool: 0.931,
  wireless_first_then_slot_asc_unfiltered_pool: 0.748,
  wireless_first_then_slot_desc_filtered_pool: 0.757,
  owner_first_then_wireless_then_slot_asc: 0.930,
  slot_asc_only: 0.598,
  owner_first_then_slot_asc: 0.613,
  accepted: null,
});

/**
 * The disqualifying measurement. Where the pool holds one candidate there is
 * no selection to get wrong, so any residual is a pool-definition error.
 */
export const SINGLE_CANDIDATE_CONTROL = Object.freeze({
  single_candidate_properties: 13894,
  matched: 13760,
  silent_wrong: 134,
  interpretation: 'pool definition is still incomplete; ordering rules cannot be trusted on top of it',
});

/** Target population availability. Availability is NOT certification. */
export const TARGET_POPULATION = Object.freeze({
  rows: 2962,
  exactly_one_callable_phone: 509,
  multiple_callable_phones_ambiguous: 2452,
  all_phones_suppressed: 1,
  no_phone_at_all: 0,
  has_usable_email: 2659,
  no_usable_contact: 0,
  certified_deterministic_write_count: 0,
});

export const WRITE_VERDICT = Object.freeze({
  status: 'WRITE_BLOCKED',
  reason: 'phone selection rule not deterministically recoverable; zero-silent-wrong unattainable',
  rows_written: 0,
});

/**
 * Deliberately not exported: a selector. There is no certified selection
 * function to call, and shipping a 93%-accurate one behind a confident name is
 * how a wrong phone number reaches a real person.
 */
export default {
  CALLABLE_COUNT_RULE,
  SUPPRESSION_INTERACTION,
  REJECTED_SELECTION_RULES,
  SINGLE_CANDIDATE_CONTROL,
  TARGET_POPULATION,
  WRITE_VERDICT,
};
