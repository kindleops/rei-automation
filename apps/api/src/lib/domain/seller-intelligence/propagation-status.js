/**
 * SELLER INTELLIGENCE PROPAGATION STATE — THE DETECTOR THAT WAS MISSING.
 *
 * WHY THIS EXISTS. On 2026-08-31 six DealMachine contact exports
 * (`DM_SELLER_CONTACT_EXPORTS_20260828`) wrote 6,808 new `seller.property`
 * rows. Not one of them acquired an owner resolution, a best contact, a feature
 * row or a score — and nothing anywhere noticed for three weeks. There was no
 * propagation pipeline to fail and, more to the point, nothing that could tell
 * you it hadn't run. This module is that second thing.
 *
 * IT DETECTS, IT DOES NOT PROPAGATE. Deliberately. The engine that produced the
 * existing 169,790 `v1.0.0` projections is not in this repository (see
 * `PROPAGATION_BLOCKED_NO_CANONICAL_ENGINE`), so anything here that claimed to
 * compute owner resolution or scores would be a SECOND, divergent algorithm
 * writing a foreign vocabulary into a shared table. Detection is the part that
 * is knowable from database state alone, so detection is the part that is built.
 *
 * NOT A HIGH-WATER MARK (§23). A `created_at > last_run` cursor would have
 * skipped the 6,808 forever the moment the cursor moved past them: a row that
 * failed once is older than the cursor for the rest of time. The predicate here
 * is therefore MISSING PROJECTION STATE — "which properties lack a row in a
 * downstream table" — which is self-healing by construction. Timestamps are
 * reporting detail, never the gate.
 *
 * READY IS NOT THE SAME AS INCOMPLETE. The cohort taught this: 6,808 rows are
 * incomplete, but they carry no `owner_hash`, which is the canonical
 * property→owner join key. Handing them to a resolver would not resolve them,
 * it would invent them. So an incomplete property is classified as READY only
 * when its canonical inputs are actually present, and as BLOCKED otherwise —
 * and blocked rows are reported as blocked, never quietly folded into a backlog
 * number that implies someone could just run the job again.
 */

/**
 * The owner-resolution outcomes for which a best-contact projection is built.
 *
 * MEASURED, NOT ASSUMED. Across all 169,790 resolved properties the persisted
 * data is categorical: `confirmed` 53,413/53,413, `high_confidence` 945/945 and
 * `medium_confidence` 40,081/40,081 all carry a best-contact row, while
 * `entity_owned` 0/48,135 and `unresolved` 0/5,358 carry none. These are also
 * exactly the three statuses `campaign_eligible_v1` admits.
 *
 * The rule is therefore a DESIGN, not a gap: you do not compute "the best way
 * to reach the owner" for a property whose owner is unresolved, ambiguous, or
 * an entity whose signing authority has not been established. Treating contact
 * as unconditional makes the detector report a 72,119-property backlog that
 * does not exist and that no runner could ever drain.
 */
export const CONTACT_PROJECTED_RESOLUTION_STATUSES = Object.freeze([
  'confirmed',
  'high_confidence',
  'medium_confidence',
]);

/**
 * The projection stages, in the dependency order the persisted schema implies:
 * `campaign_eligible_v1` joins resolution + best contact + scores, and
 * `property_best_contact_v1` carries `owner_resolution_status`, so contact is
 * downstream of resolution.
 *
 * `appliesTo` distinguishes a stage that is MISSING from one that is not
 * SUPPOSED to exist. Where applicability depends on an upstream result that has
 * not been computed yet, it returns `null` — undetermined — and the stage is
 * counted neither as satisfied nor as outstanding.
 *
 * `campaign_eligible_v1` is a VIEW and therefore has no stage of its own — it
 * becomes true on its own the moment its three inputs exist, which is exactly
 * why nothing may ever write to it.
 */
export const PROPAGATION_STAGES = Object.freeze([
  Object.freeze({ key: 'owner_resolution', table: 'seller.property_owner_resolution_v1', order: 1, appliesTo: () => true }),
  Object.freeze({
    key: 'best_contact',
    table: 'seller.property_best_contact_v1',
    order: 2,
    appliesTo: (row) => {
      if (!row.has_owner_resolution) return null; // upstream not computed yet
      const status = String(row.owner_resolution_status ?? '').trim();
      if (!status) return null;
      return CONTACT_PROJECTED_RESOLUTION_STATUSES.includes(status);
    },
  }),
  Object.freeze({ key: 'features', table: 'seller.property_features_v1', order: 3, appliesTo: () => true }),
  Object.freeze({ key: 'scores', table: 'seller.property_scores_v1', order: 4, appliesTo: () => true }),
]);

export const PROPAGATION_STAGE_KEYS = Object.freeze(PROPAGATION_STAGES.map((s) => s.key));

/**
 * The reason the 6,808 cannot simply be re-run, named so that a report can say
 * it out loud instead of showing an actionable-looking backlog.
 */
export const PROPAGATION_BLOCKED_NO_CANONICAL_ENGINE = 'canonical_engine_absent_from_repo';

export const PROPAGATION_STATE = Object.freeze({
  COMPLETE: 'complete',
  READY: 'ready',
  BLOCKED_NO_OWNER_LINK: 'blocked_missing_owner_link',
  BLOCKED_NO_OWNER_OF_RECORD: 'blocked_missing_owner_of_record',
});

const present = (value) => value !== null && value !== undefined && value !== false;

/**
 * Which stages does this property still lack?
 *
 * Returns them in dependency order, so the first entry is the one a runner
 * would have to satisfy first. A stage that does not apply — or whose
 * applicability is still undetermined because its upstream has not run — is not
 * "missing"; it is simply not owed.
 */
export function missingStages(row = {}) {
  return PROPAGATION_STAGES
    .filter((stage) => stage.appliesTo(row) === true && !present(row[`has_${stage.key}`]))
    .map((stage) => stage.key);
}

/**
 * Stages this property is not owed, with the reason — so a report can show that
 * an entity-owned property is finished rather than perpetually behind.
 */
export function inapplicableStages(row = {}) {
  return PROPAGATION_STAGES
    .filter((stage) => stage.appliesTo(row) === false)
    .map((stage) => stage.key);
}

/**
 * Classify one property's propagation state.
 *
 * `row` carries a `has_<stage>` boolean per stage plus the canonical input
 * facts (`owner_hash`, `owner_name`, `linked_owner_count`). No timestamps are
 * consulted: age is a reporting attribute, never a predicate (§23).
 */
export function classifyPropertyPropagation(row = {}) {
  const missing = missingStages(row);
  if (missing.length === 0) {
    return { state: PROPAGATION_STATE.COMPLETE, missing_stages: [], next_stage: null, blocked_reason: null };
  }

  const next = missing[0];

  /**
   * `owner_hash` is the vendor-supplied household key that the canonical
   * resolver joins on — measured at 98.9% recall of the persisted winner
   * against 20,000 processed rows, versus 82.9% for the `source_row_uid`
   * fallback. A property missing it has no canonical route to its owner, and
   * one-in-six wrong owner assignments is fabricated linkage, not a backfill.
   */
  if (!present(row.owner_hash) && !(Number(row.linked_owner_count) > 0)) {
    return {
      state: PROPAGATION_STATE.BLOCKED_NO_OWNER_LINK,
      missing_stages: missing,
      next_stage: next,
      blocked_reason: 'no_owner_hash_and_no_linked_owner',
    };
  }

  // A property with no owner of record cannot be resolved to one. This is a
  // truthful terminal state, not a queue entry.
  if (!present(row.owner_name)) {
    return {
      state: PROPAGATION_STATE.BLOCKED_NO_OWNER_OF_RECORD,
      missing_stages: missing,
      next_stage: next,
      blocked_reason: 'no_owner_of_record',
    };
  }

  return { state: PROPAGATION_STATE.READY, missing_stages: missing, next_stage: next, blocked_reason: null };
}

/**
 * The catch-up work set (§22/§23).
 *
 * Every property whose projections are incomplete, regardless of age, import
 * batch or how many times it has been attempted before. An old row that failed
 * in 2026 is as eligible as one that landed this morning — that property is the
 * whole point, and it is what a cursor-based catch-up gets wrong.
 *
 * BLOCKED rows are excluded from the work set but NOT from the report: they
 * need source repair, and a runner that kept retrying them would spin forever
 * while the operator saw a backlog that never drained.
 */
export function selectCatchUpWork(rows = []) {
  const classified = rows.map((row) => ({ row, verdict: classifyPropertyPropagation(row) }));
  return {
    ready: classified.filter((c) => c.verdict.state === PROPAGATION_STATE.READY).map((c) => c.row),
    blocked: classified
      .filter((c) => c.verdict.state.startsWith('blocked'))
      .map((c) => ({ property_id: c.row.property_id, reason: c.verdict.blocked_reason })),
    complete: classified.filter((c) => c.verdict.state === PROPAGATION_STATE.COMPLETE).length,
  };
}

/**
 * Assemble the operational report (§24).
 *
 * Every figure is a count of real rows. There is no health score: a single
 * number blended out of unrelated stages is precisely how 6,808 unpropagated
 * properties hide inside a reassuring 97%.
 */
export function buildPropagationReport(rows = [], { groupBy = null } = {}) {
  const stageAwaiting = Object.fromEntries(PROPAGATION_STAGE_KEYS.map((k) => [k, 0]));
  const stageNotOwed = Object.fromEntries(PROPAGATION_STAGE_KEYS.map((k) => [k, 0]));
  const byState = {};
  const blockedReasons = {};
  const groups = new Map();
  let oldestPending = null;

  for (const row of rows) {
    const verdict = classifyPropertyPropagation(row);
    byState[verdict.state] = (byState[verdict.state] ?? 0) + 1;
    for (const stage of verdict.missing_stages) stageAwaiting[stage] += 1;
    for (const stage of inapplicableStages(row)) stageNotOwed[stage] += 1;
    if (verdict.blocked_reason) {
      blockedReasons[verdict.blocked_reason] = (blockedReasons[verdict.blocked_reason] ?? 0) + 1;
    }
    if (verdict.state !== PROPAGATION_STATE.COMPLETE && row.first_observed_at) {
      if (oldestPending === null || row.first_observed_at < oldestPending) oldestPending = row.first_observed_at;
    }
    if (groupBy) {
      const key = row[groupBy] ?? 'unknown';
      const bucket = groups.get(key) ?? { key, total: 0, complete: 0, ready: 0, blocked: 0 };
      bucket.total += 1;
      if (verdict.state === PROPAGATION_STATE.COMPLETE) bucket.complete += 1;
      else if (verdict.state === PROPAGATION_STATE.READY) bucket.ready += 1;
      else bucket.blocked += 1;
      groups.set(key, bucket);
    }
  }

  return {
    total_seller_properties: rows.length,
    awaiting: stageAwaiting,
    // Reported beside `awaiting` on purpose: "48,135 entity-owned properties
    // are not owed a contact projection" is a different statement from "48,135
    // are behind", and only one of them is true.
    not_owed: stageNotOwed,
    by_state: byState,
    blocked_reasons: blockedReasons,
    oldest_pending_first_observed_at: oldestPending,
    campaign_eligibility_available: byState[PROPAGATION_STATE.COMPLETE] ?? 0,
    groups: groupBy ? [...groups.values()].sort((a, b) => b.total - a.total) : null,
  };
}

/**
 * The catch-up query, as SQL.
 *
 * Kept here rather than in the runner so the predicate that decides what gets
 * processed is the same text the tests reason about. `NOT EXISTS` against each
 * projection is the §23 requirement expressed directly: presence of downstream
 * state, never a timestamp cursor.
 *
 * PostgREST does not expose the `seller` schema, so this is executed over a
 * direct connection by the caller; nothing here opens one.
 */
export function buildCatchUpSql({ limit = 1000, propertyIds = null } = {}) {
  const stageProbes = PROPAGATION_STAGES
    .map((s) => `    exists (select 1 from ${s.table} t where t.property_id = p.property_id) as has_${s.key}`)
    .join(',\n');
  const idFilter = Array.isArray(propertyIds) && propertyIds.length > 0
    ? '  and p.property_id = any($1::text[])\n'
    : '';
  return `select
    p.property_id,
    p.owner_hash,
    p.owner_name,
    p.state,
    p.county_name,
    p.first_observed_at,
    (select count(*) from seller.owner o where o.owner_hash = p.owner_hash) as linked_owner_count,
    (select r.owner_resolution_status from seller.property_owner_resolution_v1 r
      where r.property_id = p.property_id) as owner_resolution_status,
${stageProbes}
  from seller.property p
  where true
${idFilter}  order by p.first_observed_at asc nulls last
  limit ${Number(limit)};`;
}

export default {
  PROPAGATION_STAGES,
  PROPAGATION_STAGE_KEYS,
  PROPAGATION_STATE,
  PROPAGATION_BLOCKED_NO_CANONICAL_ENGINE,
  CONTACT_PROJECTED_RESOLUTION_STATUSES,
  classifyPropertyPropagation,
  missingStages,
  inapplicableStages,
  selectCatchUpWork,
  buildPropagationReport,
  buildCatchUpSql,
};
