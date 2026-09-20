/**
 * OWNER_HASH REHYDRATION — THE WRITE CONTRACT, PREPARED BUT NOT EXERCISED.
 *
 * WHAT THIS IS FOR. The 6,808 net-new properties carry `owner_hash = NULL`
 * because File 10 arrived as a DealMachine UI contact export, which omits the
 * vendor's household key. The key is recoverable from the vendor's own property
 * payload — proven, not assumed:
 *
 *     POST https://api.dealmachine.com/v2/parcel-card-7f3a9c/
 *     { token, type: "match_property", property_id }
 *
 * A controlled sample returned, for three properties whose canonical hash is
 * already stored, a byte-identical `owner_hash` — 3/3 exact, no fuzzy
 * comparison — and for every request the returned `property_id`, address and
 * APN matched what was asked for. That is what makes the vendor authoritative
 * here and the 157 household-inferred guesses unnecessary.
 *
 * WHY IT IS NOT A BACKFILL YET. The vendor hard-blocks this endpoint after a
 * few dozen calls: 26 × HTTP 200 followed by 15 × HTTP 403 returned within a
 * single second, and a fresh login does not clear it. Coverage is therefore
 * partial, and a partial cohort must not be written as though it were whole.
 *
 * THIS MODULE VALIDATES; IT DOES NOT CONNECT. It holds the conditions every
 * repair must satisfy and the audit record every repair must carry. It issues
 * no HTTP request and opens no database connection, so it cannot write by
 * accident — a caller has to take its verdict and act on it deliberately.
 */

/** Truthful provenance. The value did NOT come from the original contact export. */
export const REHYDRATION_REASON = 'file10_identity_rehydration';

/** A vendor owner_hash is 64 lowercase hex characters, as every stored one is. */
const OWNER_HASH_RE = /^[0-9a-f]{64}$/;

export const REHYDRATION_VERDICT = Object.freeze({
  WRITE: 'write_allowed',
  SKIP_NOT_IN_MANIFEST: 'refused_not_in_manifest',
  SKIP_ALREADY_SET: 'refused_owner_hash_already_set',
  SKIP_IDENTITY_MISMATCH: 'refused_identity_mismatch',
  SKIP_NO_HASH: 'refused_vendor_returned_no_hash',
  SKIP_MALFORMED: 'refused_malformed_owner_hash',
});

/**
 * Decide whether one recovered value may be written.
 *
 * Every condition is a refusal, never a warning: a wrong household key silently
 * reassigns a property's owner, and there is no downstream check that would
 * notice.
 *
 * @param row      current DB state: { property_id, owner_hash }
 * @param recovered vendor response: { requested_property_id, returned_property_id, owner_hash }
 * @param manifest  Set of the exact property_ids this run is permitted to touch
 */
export function evaluateRehydration(row = {}, recovered = {}, manifest = new Set()) {
  const propertyId = String(row.property_id ?? '').trim();

  // The manifest is the blast radius. Nothing outside the 6,808 is touchable,
  // so a bug that widened the query cannot widen the write.
  if (!manifest.has(propertyId)) {
    return { verdict: REHYDRATION_VERDICT.SKIP_NOT_IN_MANIFEST, property_id: propertyId, owner_hash: null };
  }

  // Repair means filling a hole. An existing key is canonical and is never
  // second-guessed by a later fetch.
  if (row.owner_hash !== null && row.owner_hash !== undefined && String(row.owner_hash).trim() !== '') {
    return { verdict: REHYDRATION_VERDICT.SKIP_ALREADY_SET, property_id: propertyId, owner_hash: null };
  }

  // The vendor must have answered about the property we asked about.
  const requested = String(recovered.requested_property_id ?? propertyId).trim();
  const returned = String(recovered.returned_property_id ?? '').trim();
  if (!returned || returned !== requested || requested !== propertyId) {
    return { verdict: REHYDRATION_VERDICT.SKIP_IDENTITY_MISMATCH, property_id: propertyId, owner_hash: null };
  }

  const hash = String(recovered.owner_hash ?? '').trim();
  if (!hash) {
    return { verdict: REHYDRATION_VERDICT.SKIP_NO_HASH, property_id: propertyId, owner_hash: null };
  }
  if (!OWNER_HASH_RE.test(hash)) {
    return { verdict: REHYDRATION_VERDICT.SKIP_MALFORMED, property_id: propertyId, owner_hash: null };
  }

  return { verdict: REHYDRATION_VERDICT.WRITE, property_id: propertyId, owner_hash: hash };
}

/**
 * The audit record for a repair (§13).
 *
 * `old_value` is recorded as an explicit null rather than omitted: the claim
 * being made is "this was empty and we filled it", and that is only checkable
 * later if the emptiness was written down.
 */
export function buildRehydrationAudit(verdictRow = {}, context = {}) {
  if (verdictRow.verdict !== REHYDRATION_VERDICT.WRITE) return null;
  return {
    property_id: verdictRow.property_id,
    old_owner_hash: null,
    new_owner_hash: verdictRow.owner_hash,
    reason: REHYDRATION_REASON,
    recovery_run_id: context.run_id ?? null,
    recovered_at: context.recovered_at ?? null,
    vendor_source: context.vendor_source ?? 'dealmachine:/v2/parcel-card-7f3a9c/',
    producer_path: context.producer_path ?? 'DM-Scraper/scraper2.py:fetch_property_detail',
  };
}

/**
 * The narrow UPDATE. One property, one column.
 *
 * `owner_hash is null` is repeated in the WHERE clause even though the caller
 * already checked it: between evaluation and execution another writer could
 * have set it, and the database is the only place that race can be settled.
 */
export function buildRehydrationUpdateSql() {
  return `update seller.property
     set owner_hash = $2
   where property_id = $1
     and owner_hash is null;`;
}

/**
 * Summarise a rehydration plan. `writes_executed` is always 0 here — this
 * module plans, and something else would have to execute.
 */
export function summariseRehydrationPlan(verdicts = []) {
  const counts = {};
  for (const v of verdicts) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
  return {
    total: verdicts.length,
    eligible_to_write: counts[REHYDRATION_VERDICT.WRITE] ?? 0,
    refusals: Object.fromEntries(
      Object.entries(counts).filter(([k]) => k !== REHYDRATION_VERDICT.WRITE),
    ),
    writes_executed: 0,
  };
}

export default {
  REHYDRATION_REASON,
  REHYDRATION_VERDICT,
  evaluateRehydration,
  buildRehydrationAudit,
  buildRehydrationUpdateSql,
  summariseRehydrationPlan,
};
