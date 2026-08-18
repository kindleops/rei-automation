/**
 * Complete, ordered loading of the SMS template pool.
 *
 * WHY THIS EXISTS
 * `assignCampaignTargetTemplates` loaded its candidate pool with:
 *
 *     .from('sms_templates').select('*')
 *       .eq('is_active', true).eq('use_case', useCase).eq('stage_code', stageCode)
 *       .limit(5000)
 *
 * PostgREST enforces a server-side `max-rows` cap (1,000 on this project). A
 * client `.limit(5000)` does NOT defeat it — the request is silently clamped and
 * returns 1,000 rows with no error and no truncation signal.
 *
 * The default outbound pool (`ownership_check` / `S1`) holds 4,638 active
 * templates in production. Assignment therefore only ever saw the first ~22% of
 * it, and because the query carried no ORDER BY, *which* 1,000 rows came back
 * was left to the planner. That made the "deterministic" hash selection
 * deterministic over an unstable input — the worst of both worlds.
 *
 * Two independent fixes, both required:
 *   1. Page through with .range() so the whole pool loads.
 *   2. Order by a stable unique key so page boundaries cannot overlap or skip.
 *
 * Ordering is not cosmetic here. Keyset-free .range() pagination over an
 * unordered relation is unsound: without ORDER BY, Postgres may return rows in
 * a different order per page request, so the same row can appear on two pages
 * (duplicate) or on none (dropped).
 */

// Matches the PostgREST max-rows ceiling. Requesting exactly the cap keeps the
// page count minimal while guaranteeing no page is server-truncated below what
// we asked for — which is how we detect the final page.
export const TEMPLATE_PAGE_SIZE = 1000;

// Safety valve. 200 pages x 1,000 = 200k templates, far above any real catalog.
// A pool larger than this means something is wrong upstream, and we would
// rather stop than spin.
const MAX_PAGES = 200;

/**
 * `template_id` is the stable, unique, human-meaningful key for a template and
 * is what selection hashes against. Ordering by it makes both pagination and
 * downstream selection reproducible.
 */
export const TEMPLATE_ORDER_KEY = "template_id";

/**
 * Page through a filtered sms_templates query.
 *
 * @param {object} supabase   Supabase client.
 * @param {(query: any) => any} applyFilters
 *        Receives the base query and returns it with the caller's `.eq()` /
 *        `.in()` filters applied. Kept as a callback so the filter shape stays
 *        with the caller and this module owns only paging + ordering.
 * @returns {Promise<Array<object>>} every matching row, in template_id order.
 */
export async function fetchAllTemplates(supabase, applyFilters) {
  const rows = [];
  let page = 0;

  for (; page < MAX_PAGES; page += 1) {
    const from = page * TEMPLATE_PAGE_SIZE;
    const to = from + TEMPLATE_PAGE_SIZE - 1;

    const base = supabase.from("sms_templates").select("*");
    const filtered = applyFilters ? applyFilters(base) : base;

    const { data, error } = await filtered
      .order(TEMPLATE_ORDER_KEY, { ascending: true })
      .range(from, to);

    if (error) throw error;

    const batch = Array.isArray(data) ? data : [];
    rows.push(...batch);

    // A short page means the server had nothing more to give. An exactly-full
    // page is ambiguous, so we go round again and let the next page come back
    // empty. That costs one extra request on an exact multiple and is the only
    // way to terminate correctly without a separate count query.
    if (batch.length < TEMPLATE_PAGE_SIZE) break;
  }

  if (page >= MAX_PAGES) {
    throw new Error(
      `template pool exceeded ${MAX_PAGES * TEMPLATE_PAGE_SIZE} rows; refusing to page further`
    );
  }

  return rows;
}

/**
 * Load the active template pool for a (use_case, stage_code) pair — complete,
 * ordered, and never silently truncated.
 */
export async function loadTemplatePool(supabase, useCase, stageCode) {
  return fetchAllTemplates(supabase, (query) =>
    query.eq("is_active", true).eq("use_case", useCase).eq("stage_code", stageCode)
  );
}
