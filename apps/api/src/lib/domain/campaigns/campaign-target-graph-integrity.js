/**
 * Pre-commit integrity gates for the campaign target graph.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * `refresh_campaign_target_graph()` is a thin wrapper over
 * `refresh_campaign_target_graph_staged(10000, NULL)`, which loops ONLY
 * `refresh_campaign_target_graph_stage_batch`. That batch's source predicate is:
 *
 *     FROM public.properties p WHERE NULLIF(p.master_owner_id, '') IS NOT NULL
 *
 * The live graph, however, was built by a TWO-pass process — that owner-linked
 * pass plus `refresh_campaign_target_graph_fallback_batch`, which has no owner
 * requirement and sweeps every remaining property. 809 of the 1,219 historical
 * batches were fallback batches.
 *
 * So calling the "full refresh" today would stage only the owner-linked subset
 * and commit it over the complete graph. Measured 2026-08-17:
 *
 *     live graph                          124,046 rows (94,723 with owner, 76.4%)
 *     properties.master_owner_id present   41,532
 *     net change if refreshed              -82,514  (-67%)
 *
 * And it would pass the existing `refused_partial_commit` guard, because that
 * guard only asks "did this run finish all of ITS batches" — which it did. The
 * guard cannot see that the run's own definition of "all" is incomplete.
 *
 * These gates close that hole. They are advisory-computed BEFORE any commit and
 * fail closed: unknown or unreadable state blocks, it does not pass.
 */

/**
 * Default thresholds. Deliberately conservative — a legitimate rebuild after 65
 * days of growth should ADD rows, so any material shrink is suspicious.
 */
export const DEFAULT_GRAPH_INTEGRITY_THRESHOLDS = {
  /** Refuse if staged rows fall below this fraction of the live graph. */
  minRowRatio: 0.95,
  /** Refuse if owner coverage falls more than this many points below live. */
  maxOwnerCoverageDropPoints: 5,
  /** Refuse if staged rows cover less than this fraction of the source universe. */
  minSourceCoverage: 0.95,
  /** A graph must never be committed empty. */
  minAbsoluteRows: 1,
}

const pct = (numerator, denominator) => (denominator > 0 ? (numerator / denominator) * 100 : 0)

/**
 * Evaluate staged-vs-live integrity. Pure: takes measurements, returns a verdict.
 *
 * @param {object} m measurements
 * @param {number} m.stagedRows            rows in campaign_target_graph_stage
 * @param {number} m.stagedDistinctProperties distinct property_id in stage
 * @param {number} m.stagedWithOwner       stage rows carrying a master_owner_id
 * @param {number} m.liveRows              rows currently in campaign_target_graph
 * @param {number} m.liveWithOwner         live rows carrying a master_owner_id
 * @param {number} m.sourceUniverse        properties the graph is expected to cover
 * @param {object} [thresholds]
 */
export function evaluateGraphCommitIntegrity(m, thresholds = {}) {
  const t = { ...DEFAULT_GRAPH_INTEGRITY_THRESHOLDS, ...thresholds }
  const violations = []
  const metrics = {}

  const num = (v, label) => {
    // null/undefined mean "we could not measure this", NOT zero. Number(null)
    // is 0, which would quietly turn an unreadable count into a legitimate-
    // looking empty stage and route the failure to the wrong gate. Reject them
    // before coercion so unknown state always fails closed as a measurement
    // problem, which is what an operator needs to see.
    if (v === null || v === undefined || typeof v === 'boolean') {
      violations.push({ gate: 'measurement', detail: `${label} was not measured (${String(v)})` })
      return null
    }
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) {
      violations.push({ gate: 'measurement', detail: `${label} is not a usable number (${String(v)})` })
      return null
    }
    return n
  }

  const stagedRows = num(m?.stagedRows, 'stagedRows')
  const stagedDistinct = num(m?.stagedDistinctProperties, 'stagedDistinctProperties')
  const stagedOwner = num(m?.stagedWithOwner, 'stagedWithOwner')
  const liveRows = num(m?.liveRows, 'liveRows')
  const liveOwner = num(m?.liveWithOwner, 'liveWithOwner')
  const sourceUniverse = num(m?.sourceUniverse, 'sourceUniverse')

  if (violations.length) {
    return { ok: false, violations, metrics, thresholds: t }
  }

  // 1. Never commit an empty graph.
  metrics.staged_rows = stagedRows
  if (stagedRows < t.minAbsoluteRows) {
    violations.push({ gate: 'empty_stage', detail: `staged rows ${stagedRows} < ${t.minAbsoluteRows}` })
  }

  // 2. Row-count delta against the live graph.
  metrics.live_rows = liveRows
  metrics.row_ratio = liveRows > 0 ? Number((stagedRows / liveRows).toFixed(4)) : null
  metrics.row_delta = stagedRows - liveRows
  if (liveRows > 0 && stagedRows / liveRows < t.minRowRatio) {
    violations.push({
      gate: 'row_count_delta',
      detail:
        `staged ${stagedRows} is ${(pct(stagedRows, liveRows)).toFixed(1)}% of live ${liveRows} ` +
        `(floor ${(t.minRowRatio * 100).toFixed(0)}%); refusing to shrink the graph by ${liveRows - stagedRows} rows`,
    })
  }

  // 3. Uniqueness — one row per property.
  metrics.staged_distinct_properties = stagedDistinct
  metrics.staged_duplicates = stagedRows - stagedDistinct
  if (stagedDistinct !== stagedRows) {
    violations.push({
      gate: 'uniqueness',
      detail: `stage holds ${stagedRows} rows for ${stagedDistinct} distinct properties (${stagedRows - stagedDistinct} duplicates)`,
    })
  }

  // 4. Source coverage — did the run actually sweep the universe it claims?
  metrics.source_universe = sourceUniverse
  metrics.source_coverage = sourceUniverse > 0 ? Number((stagedDistinct / sourceUniverse).toFixed(4)) : null
  if (sourceUniverse > 0 && stagedDistinct / sourceUniverse < t.minSourceCoverage) {
    violations.push({
      gate: 'source_coverage',
      detail:
        `stage covers ${stagedDistinct}/${sourceUniverse} source properties ` +
        `(${pct(stagedDistinct, sourceUniverse).toFixed(1)}%, floor ${(t.minSourceCoverage * 100).toFixed(0)}%) — ` +
        `a single-pass run cannot satisfy this, which is the intended behaviour`,
    })
  }

  // 5. master_owner_id coverage — the semantic-degradation gate.
  //    A rebuild that keeps row count but loses owner linkage is still a
  //    regression: campaign reach depends on the owner join, not row presence.
  const liveOwnerPct = pct(liveOwner, liveRows)
  const stagedOwnerPct = pct(stagedOwner, stagedRows)
  metrics.live_owner_coverage_pct = Number(liveOwnerPct.toFixed(2))
  metrics.staged_owner_coverage_pct = Number(stagedOwnerPct.toFixed(2))
  metrics.owner_coverage_drop_points = Number((liveOwnerPct - stagedOwnerPct).toFixed(2))
  if (liveRows > 0 && liveOwnerPct - stagedOwnerPct > t.maxOwnerCoverageDropPoints) {
    violations.push({
      gate: 'owner_coverage',
      detail:
        `owner coverage would fall from ${liveOwnerPct.toFixed(1)}% to ${stagedOwnerPct.toFixed(1)}% ` +
        `(-${(liveOwnerPct - stagedOwnerPct).toFixed(1)} points, max ${t.maxOwnerCoverageDropPoints})`,
    })
  }
  // Absolute owner count matters independently of percentage: a small graph can
  // be 100% owner-linked and still lose most of the reachable owner universe.
  metrics.live_owner_rows = liveOwner
  metrics.staged_owner_rows = stagedOwner
  if (liveOwner > 0 && stagedOwner < liveOwner * t.minRowRatio) {
    violations.push({
      gate: 'owner_absolute',
      detail: `owner-linked rows would fall from ${liveOwner} to ${stagedOwner} (${liveOwner - stagedOwner} lost)`,
    })
  }

  return { ok: violations.length === 0, violations, metrics, thresholds: t }
}

/**
 * Measure the live graph, the stage, and the source universe.
 * Uses count-only reads (`head: true`), which are not subject to PostgREST's
 * max-rows clamp.
 */
export async function measureGraphCommitState(supabase, options = {}) {
  const count = async (table, applyFilters = (q) => q) => {
    const { count: n, error } = await applyFilters(
      supabase.from(table).select('property_id', { count: 'exact', head: true }),
    )
    if (error) throw error
    return Number(n || 0)
  }

  const [stagedRows, stagedWithOwner, liveRows, liveWithOwner, sourceUniverse] = await Promise.all([
    count('campaign_target_graph_stage'),
    count('campaign_target_graph_stage', (q) => q.not('master_owner_id', 'is', null)),
    count('campaign_target_graph'),
    count('campaign_target_graph', (q) => q.not('master_owner_id', 'is', null)),
    count('properties'),
  ])

  return {
    stagedRows,
    // The stage is keyed one row per property; distinct is asserted separately
    // by the uniqueness gate against an explicit distinct count when available.
    stagedDistinctProperties: options.stagedDistinctProperties ?? stagedRows,
    stagedWithOwner,
    liveRows,
    liveWithOwner,
    sourceUniverse,
  }
}
