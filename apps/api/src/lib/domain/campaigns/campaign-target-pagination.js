/**
 * Complete reads and authoritative counts for campaign target tables.
 *
 * WHY THIS EXISTS
 * PostgREST enforces a server-side `max-rows` ceiling (1000 on this project).
 * A client-side `.limit(100000)` does NOT raise it — the request is silently
 * clamped and you get 1000 rows with no error and no indication of truncation.
 * Measured against production on 2026-08-17:
 *
 *     GET /rest/v1/campaign_targets?select=campaign_id,target_status&limit=100000
 *       -> 1000 rows returned
 *     GET /rest/v1/campaign_targets?select=id   (Prefer: count=exact, Range: 0-0)
 *       -> content-range: 0-999/2359
 *
 * Every metric derived by counting rows client-side was therefore capped at
 * 1000 across ALL campaigns combined, which is why the campaign list under-
 * reported both target totals and ready counts once the table passed 1000 rows.
 *
 * Use `paginateRows` when you need the rows themselves, and `exactCount` when a
 * number is all you need — `count: 'exact', head: true` is not subject to
 * max-rows and costs one round trip instead of N.
 */

/** PostgREST page size. Must stay <= the server's max-rows or pages silently short. */
export const PAGE_SIZE = 1000

/** Hard stop so a pathological table cannot spin forever. 500k rows at 1000/page. */
const MAX_PAGES = 500

/**
 * Read every row matching a query, one page at a time.
 *
 * @param {(from: number, to: number) => PromiseLike<{ data: any[]|null, error: any }>} buildPage
 *        Builds and executes a query for the inclusive range [from, to].
 *        Must apply a deterministic `.order(...)` — without a stable sort,
 *        PostgREST may return overlapping or missing rows across pages.
 * @returns {Promise<any[]>} all rows
 */
export async function paginateRows(buildPage) {
  const rows = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE
    const { data, error } = await buildPage(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const batch = data || []
    rows.push(...batch)
    // A short page means we reached the end. A full page means "maybe more".
    if (batch.length < PAGE_SIZE) return rows
  }
  throw new Error(`paginateRows exceeded ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} rows)`)
}

/**
 * Authoritative row count, immune to max-rows.
 *
 * @param {(q: any) => any} applyFilters receives the base query, returns it filtered
 */
export async function exactCount(supabase, table, applyFilters = (q) => q) {
  const query = applyFilters(supabase.from(table).select('id', { count: 'exact', head: true }))
  const { count, error } = await query
  if (error) throw error
  return Number(count || 0)
}

/**
 * Read all campaign_targets rows for the given campaigns, complete and unclamped.
 * Ordered by id so pagination is stable.
 *
 * Single-campaign reads use `.eq()` rather than `.in([oneId])`. That is not
 * cosmetic: it preserves the exact filter shape the single-campaign callers
 * used before pagination was introduced. Widening every caller to `.in()`
 * silently changed the query surface and broke callers whose Supabase double
 * implements `eq` but not `in` — caught by campaign-send-pipeline's
 * "controlled hydration warns on brakes" test. `.eq()` is also the narrower
 * index match for the common case.
 */
export async function fetchAllCampaignTargets(supabase, campaignIds, columns) {
  const ids = (campaignIds || []).filter(Boolean)
  if (!ids.length) return []
  const applyScope = (query) => (ids.length === 1 ? query.eq('campaign_id', ids[0]) : query.in('campaign_id', ids))
  return paginateRows((from, to) =>
    applyScope(supabase.from('campaign_targets').select(columns))
      .order('id', { ascending: true })
      .range(from, to),
  )
}
