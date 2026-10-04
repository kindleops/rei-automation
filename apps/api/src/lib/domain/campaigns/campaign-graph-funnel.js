/**
 * THE AUDIENCE FUNNEL IN ONE STATEMENT.
 *
 * Reach's funnel (matched → reachable → SMS-eligible → clean → covered →
 * queue-eligible, plus the exclusion buckets) used to be fifteen separate
 * `count: exact` HEAD requests over campaign_target_graph, fired at once. Each
 * statement is ~0.1–0.3 s in Postgres, but fifteen of them queue on the
 * PostgREST pool beside the build-simulation page read, so the funnel phase
 * measured ~4.5 s for a single market.
 *
 * This module counts every bucket with ONE scan:
 *   SELECT count(*) FILTER (WHERE <bucket>) ... FROM campaign_target_graph WHERE <audience>
 * through the PROPOSED rpc `campaign_target_graph_funnel_counts`
 * (PROPOSED_20261004010000). There is no second copy of the audience logic:
 * the predicate is RECORDED by running the very same builder code
 * (applyCampaignGraphFilters and each bucket's `extra`) against a recorder,
 * then sent as data ({op, column, value}). Anything the recorder can't express
 * exactly (ilike, or(), imatch, not-in, a drawn area) returns null and the
 * caller keeps the per-bucket counts — same numbers, just more round trips.
 *
 * Until the rpc exists the call 404s (PGRST202); that is remembered for a few
 * minutes so the fallback costs nothing extra.
 */

export const GRAPH_FUNNEL_RPC = 'campaign_target_graph_funnel_counts'

const SAFE_COLUMN = /^[a-z_][a-z0-9_]{0,62}$/
const COMPARISON_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'])
const MISSING_RPC_TTL_MS = 5 * 60 * 1000
let missingUntil = 0

const isScalar = (value) => (typeof value === 'string')
  || (typeof value === 'boolean')
  || (typeof value === 'number' && Number.isFinite(value))

/**
 * Run `apply(builder)` against a recorder and return the AND-ed predicate as
 * data, or null when any call has no exact translation.
 */
export function recordGraphPredicate(apply) {
  const calls = []
  const recorder = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined
      return (...args) => {
        calls.push([String(prop), ...args])
        return recorder
      }
    },
  })
  apply(recorder)
  const predicate = []
  for (const [method, column, a, b] of calls) {
    if (typeof column !== 'string' || !SAFE_COLUMN.test(column)) return null
    if (COMPARISON_OPS.has(method)) {
      if (!isScalar(a)) return null
      predicate.push({ op: method, column, value: a })
    } else if (method === 'in') {
      if (!Array.isArray(a) || !a.length || !a.every(isScalar)) return null
      predicate.push({ op: 'in', column, values: a })
    } else if (method === 'is') {
      if (a !== null) return null
      predicate.push({ op: 'is_null', column })
    } else if (method === 'not') {
      if (a !== 'is' || b !== null) return null
      predicate.push({ op: 'not_null', column })
    } else {
      return null
    }
  }
  return predicate
}

/**
 * The funnel counts in one statement, or null (caller falls back) when the
 * predicate can't be expressed, the rpc is absent or the call fails.
 * buckets: [{ key, apply(builder) }] — each bucket's own extra predicate.
 */
export async function readGraphFunnelCounts({ supabase, base, buckets = [], now = Date.now() } = {}) {
  if (!supabase || typeof supabase.rpc !== 'function') return null
  if (now < missingUntil) return null
  const basePredicate = recordGraphPredicate(base)
  if (!basePredicate) return null
  const bucketPredicates = {}
  for (const bucket of buckets) {
    const predicate = recordGraphPredicate(bucket.apply)
    if (!predicate) return null
    bucketPredicates[bucket.key] = predicate
  }
  const { data, error } = await supabase.rpc(GRAPH_FUNNEL_RPC, { p_base: basePredicate, p_buckets: bucketPredicates })
  if (error) {
    const message = String(error.message || '').toLowerCase()
    if (error.code === 'PGRST202' || message.includes('could not find the function')) missingUntil = now + MISSING_RPC_TTL_MS
    return null
  }
  const counts = data && typeof data === 'object' && !Array.isArray(data) ? data : null
  if (!counts) return null
  const out = {}
  for (const bucket of buckets) {
    const value = Number(counts[bucket.key])
    if (!Number.isFinite(value)) return null
    out[bucket.key] = value
  }
  return out
}

/** Test seam. */
export function _resetGraphFunnelRpcState() { missingUntil = 0 }
