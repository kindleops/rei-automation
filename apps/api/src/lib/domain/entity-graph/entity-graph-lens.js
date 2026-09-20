/**
 * THE UNIVERSE LENS, ASSEMBLED FROM REAL DISTRIBUTIONS.
 *
 * Every number here comes from `entity_graph_lens_aggregate`, a GROUP BY over
 * `public.properties` (grain: one row per property_id, 169,802 rows). Nothing
 * is estimated, sampled, cached-and-stale, or synthesised.
 *
 * FAST vs DEEP. The client fetches twice: `fast` for the dimensions that sit on
 * indexed, fully-populated columns, then `deep` for the rest. That split exists
 * so the lens is interactive immediately instead of waiting on its slowest
 * facet — it is a latency decision, not a truth decision, and both parts are
 * equally real.
 *
 * COVERAGE IS REPORTED, NOT HIDDEN. Dimensions differ enormously in coverage:
 * state and property type are on 100% of rows, market on 73%, owner type on
 * 24%. A bucket set whose denominator is smaller than the scope carries
 * `covered` and `coverage_note` so the UI can say "of the 41,530 properties
 * with a known owner" rather than implying a share of everything. §12 forbids
 * implying additive totals across dimensions that do not add up; this is how
 * that promise is kept.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const clean = (value) => String(value ?? '').trim()

/**
 * The dimensions the lens can render, and which pass they belong to.
 *
 * Deliberately NOT here: `normalized_asset_class` (0% populated — offering it
 * would be an always-empty control) and anything demographic, which the
 * canonical property record does not carry.
 */
const DIMENSIONS = Object.freeze([
  { key: 'state', label: 'State', filterKey: 'state', part: 'fast', limit: 40 },
  { key: 'property_type', label: 'Property type', filterKey: 'asset_type', part: 'fast', limit: 20 },
  { key: 'market', label: 'Market', filterKey: 'market', part: 'fast', limit: 40 },
  { key: 'county', label: 'County', filterKey: 'county', part: 'deep', limit: 40 },
  { key: 'city', label: 'City', filterKey: 'city', part: 'deep', limit: 40 },
  { key: 'owner_type', label: 'Owner type', filterKey: 'owner_type', part: 'deep', limit: 20 },
])

/**
 * The lens describes the PROPERTY universe. Asking for it while standing in the
 * owners or contacts tab would produce counts that look like that tab's
 * population and are not — so those tabs get an explicitly unsupported lens
 * rather than a plausible wrong one.
 */
const LENS_SUPPORTED_TABS = new Set(['properties', '', 'universe']);

export async function buildEntityGraphLens(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const part = clean(params.part) === 'deep' ? 'deep' : 'fast'
  const tab = clean(params.tab).toLowerCase()

  const filters = {
    p_state: clean(params.state) || null,
    p_market: clean(params.market) || null,
    p_city: clean(params.city) || null,
    p_county: clean(params.county) || null,
    p_property_type: clean(params.property_type) || null,
    p_owner_type: clean(params.owner_type) || null,
  }

  const scope = buildScopeLabel(filters)

  if (tab && !LENS_SUPPORTED_TABS.has(tab)) {
    return {
      scope,
      part,
      total: null,
      unsupported_tab: tab,
      headline: [],
      dimensions: [],
    }
  }

  const wanted = DIMENSIONS.filter((dimension) => dimension.part === part)

  const results = await Promise.all(
    wanted.map(async (dimension) => {
      const { data, error } = await supabase.rpc('entity_graph_lens_aggregate', {
        p_dimension: dimension.key,
        ...filters,
        p_limit: dimension.limit,
      })
      if (error) throw error
      return { dimension, rows: Array.isArray(data) ? data : [] }
    }),
  )

  // Scope total is identical across dimensions (same WHERE clause), so any
  // dimension that returned rows can supply it.
  const scopeTotal = results.reduce(
    (found, entry) => (found === null && entry.rows.length > 0 ? Number(entry.rows[0].scope_total) : found),
    null,
  )

  const dimensions = results.map(({ dimension, rows }) => {
    const covered = rows.length > 0 ? Number(rows[0].covered_total) : 0
    const total = rows.length > 0 ? Number(rows[0].scope_total) : (scopeTotal ?? 0)

    return {
      key: dimension.key,
      label: dimension.label,
      filterKey: dimension.filterKey,
      covered,
      /**
       * Stated whenever the denominator is not the whole scope. The UI can
       * render it verbatim; an operator reading "24% of the scope" is being
       * told the truth rather than shown a chart that quietly omits 76%.
       */
      coverage_note: total > 0 && covered < total
        ? `${covered.toLocaleString()} of ${total.toLocaleString()} in scope carry a ${dimension.label.toLowerCase()}`
        : null,
      buckets: rows.map((row) => ({
        key: clean(row.bucket_key),
        label: clean(row.bucket_label) || clean(row.bucket_key),
        /**
         * `value` is the client's declared field name, and it is load-bearing:
         * the chart treats a bucket without a numeric `value` as NOT YET
         * COUNTED and renders "Counting state…" forever. Emitting `count`
         * instead produced exactly that — a lens holding correct data that
         * displayed as permanently pending.
         *
         * Its contract is also explicit that null means "not counted", never a
         * guess, so a real zero must be a real zero.
         */
        value: Number(row.bucket_count),
        // Share of the COVERED population, which is the only denominator these
        // buckets actually sum to.
        share: covered > 0 ? Number(row.bucket_count) / covered : null,
      })),
    }
  })

  return {
    scope,
    part,
    total: scopeTotal,
    headline: scopeTotal === null ? [] : [
      { key: 'properties', label: 'Properties', value: scopeTotal },
    ],
    dimensions,
  }
}

function buildScopeLabel(filters) {
  const parts = [
    filters.p_state,
    filters.p_market,
    filters.p_county,
    filters.p_city,
    filters.p_property_type,
    filters.p_owner_type,
  ].filter(Boolean)
  return parts.length === 0 ? 'Universe' : parts.join(' · ')
}

export default buildEntityGraphLens
