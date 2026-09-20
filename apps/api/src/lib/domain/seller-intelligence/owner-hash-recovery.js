/**
 * OWNER_HASH RECOVERY — READ-ONLY FORENSICS.
 *
 * WHAT owner_hash IS, PROVEN. It is a DealMachine-supplied field, not anything
 * we compute. The scraper that produced every registered import reads it
 * straight off the vendor's property payload:
 *
 *     # DM-Scraper/scraper2.py:495
 *     "owner_hash": prop.get("owner_hash"),
 *
 * It is a vendor HOUSEHOLD key, not a person key — a single hash spans owners
 * named Williams, Johnson and Rowan on one property — which is why it cannot be
 * reconstructed from names, addresses, or any composite of them. §14 forbids
 * inventing a replacement under the same field name, and this module has no
 * code path that could.
 *
 * WHY THE 6,808 LACK IT. They arrived on 2026-08-31 via six
 * `dealmachine-contacts-*.csv` UI exports (folder
 * `DM_SELLER_CONTACT_EXPORTS_20260828`), a different export shape from the
 * scraper's own sheets. That export carried no `owner_hash`: of the 4,978
 * File-10 owner identities that hold one, ALL 4,978 values also occur on a
 * property imported in Files 1-9, and ZERO are unique to File 10. Every hash
 * present is inherited, none supplied.
 *
 * WHAT THIS MODULE DOES. Recovers a property's owner_hash ONLY by reading a
 * value some other row already stores — never by deriving one. It is a lookup,
 * and it refuses whenever the lookup is not unambiguous.
 *
 * WHAT IT DOES NOT DO. It does not write. There is no upsert here, no SQL
 * builder that mutates, and no caller can make it mutate. Recovery feeds a
 * report; a human decides what to do with it.
 *
 * ITS MEASURED LIMITS, STATED UP FRONT. Against the 2,554-property overlap
 * cohort — properties present in BOTH File 10 and the earlier processed
 * population, so ground truth exists — this method scored:
 *
 *     exact unambiguous match   2,442 / 2,475   98.67% recall
 *     unambiguous but WRONG        11           0.45% SILENT error
 *     ambiguous (refused)          10
 *     nothing recovered            12
 *
 * The 11 are the important number. They are confidently wrong with no
 * ambiguity signal, so nothing at write time could catch them. And across the
 * actual 6,808 the method reaches only 157 properties (2.31%) — the rest have
 * no stored hash anywhere in the database. This is a marginal repair for a
 * small subset, not a backfill, and the caller is told so rather than left to
 * infer it from a coverage number.
 */

/** Where the 6,808 came from. Used to scope forensics, never to special-case. */
export const FILE10_SOURCE_FOLDER = 'DM_SELLER_CONTACT_EXPORTS_20260828';

/** Measured on the overlap cohort; see the header. */
export const RECOVERY_MEASURED = Object.freeze({
  overlap_evaluated: 2475,
  exact_unambiguous: 2442,
  unambiguous_wrong: 11,
  ambiguous_refused: 10,
  unrecovered: 12,
  cohort_reachable: 157,
  cohort_total: 6808,
});

export const RECOVERY_OUTCOME = Object.freeze({
  RECOVERED: 'recovered_stored_key',
  AMBIGUOUS: 'refused_ambiguous',
  ABSENT: 'refused_no_stored_key',
});

/**
 * Recover one property's owner_hash from stored vendor keys.
 *
 * `candidateHashes` are owner_hash values already persisted on owner rows
 * reachable from this property's source rows. Nothing is computed from names.
 *
 * Ambiguity is refused rather than broken by a tiebreak: picking the most
 * common or the first would manufacture confidence the evidence does not
 * support, and a wrong household key silently reassigns a property's owner.
 */
export function recoverOwnerHash(candidateHashes = []) {
  const distinct = [...new Set(
    (candidateHashes || []).map((h) => String(h ?? '').trim()).filter(Boolean),
  )];

  if (distinct.length === 0) {
    return { outcome: RECOVERY_OUTCOME.ABSENT, owner_hash: null, candidate_count: 0 };
  }
  if (distinct.length > 1) {
    return { outcome: RECOVERY_OUTCOME.AMBIGUOUS, owner_hash: null, candidate_count: distinct.length };
  }
  return { outcome: RECOVERY_OUTCOME.RECOVERED, owner_hash: distinct[0], candidate_count: 1 };
}

/**
 * Summarise a recovery sweep, including the residual error this method is known
 * to carry. A coverage figure on its own reads as an endorsement; the expected
 * silent-error count is what makes it a decision.
 */
export function summariseRecovery(results = []) {
  const counts = { recovered: 0, ambiguous: 0, absent: 0 };
  for (const r of results) {
    if (r.outcome === RECOVERY_OUTCOME.RECOVERED) counts.recovered += 1;
    else if (r.outcome === RECOVERY_OUTCOME.AMBIGUOUS) counts.ambiguous += 1;
    else counts.absent += 1;
  }
  const rate = RECOVERY_MEASURED.unambiguous_wrong
    / (RECOVERY_MEASURED.exact_unambiguous + RECOVERY_MEASURED.unambiguous_wrong);
  return {
    ...counts,
    total: results.length,
    measured_silent_error_rate: rate,
    expected_silent_errors: Math.round(counts.recovered * rate),
    writes_performed: 0,
  };
}

/**
 * The read-only forensic query: what stored owner_hash values are reachable for
 * each property, via its source rows.
 *
 * Read-only is a property of the text, not a promise: it is a single SELECT.
 */
export function buildOwnerHashRecoverySql({ limit = 10000, sourceFolder = FILE10_SOURCE_FOLDER } = {}) {
  return `select
    p.property_id,
    p.owner_hash as current_owner_hash,
    array_remove(array_agg(distinct o.owner_hash), null) as candidate_hashes
  from seller.property p
  join seller.source_row sr on sr.property_id = p.property_id
   and sr.source_folder = ${quote(sourceFolder)}
  left join seller.owner o on o.winning_source_row_uid = sr.source_row_uid
  where p.owner_hash is null
  group by p.property_id, p.owner_hash
  limit ${Number(limit)};`;
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export default {
  FILE10_SOURCE_FOLDER,
  RECOVERY_MEASURED,
  RECOVERY_OUTCOME,
  recoverOwnerHash,
  summariseRecovery,
  buildOwnerHashRecoverySql,
};
