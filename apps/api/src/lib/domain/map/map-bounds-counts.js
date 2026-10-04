/**
 * Viewport counts for /ops/map (unfiltered path).
 *
 * WHY THIS EXISTS (RC 8.4 visual QA, 2026-10-04): `counts_only` 500'd at 8 s on a
 * small Minneapolis bbox with a quiet database.
 *
 * 1. `get_map_bounds_property_count(double precision × 4, …)` compares the NUMERIC
 *    `properties.latitude/longitude` against float8 parameters. Postgres resolves
 *    that as `latitude::float8 >= $1`, so the bbox can never be an Index Cond: it
 *    scans the whole of `idx_properties_map_lens_cover` as a filter (280–310 ms
 *    warm, 8.3 s cold) instead of a range probe (1 ms, Index Only Scan, 0 heap
 *    fetches). Same class of bug as the 10-02 Radar "lens bbox numeric" fix.
 *    The count below is the identical predicate issued through PostgREST, whose
 *    literals take the column's type (numeric), so the index range is used.
 *
 * 2. `get_map_market_aggregates` ignores the bbox and aggregates the whole
 *    `properties` heap (~44K buffers, 2.7 s warm, > 8 s cold) on EVERY pan, only to
 *    produce `total_canonical`. PostgREST runs as `authenticator`
 *    (statement_timeout = 8s), so a cold read failed the whole counts response.
 *    It is viewport-independent, so one result is shared (single-flight + TTL)
 *    and a failure no longer fails the bbox count — `total_canonical` is reported
 *    as null (unavailable), never fabricated.
 *
 * Both functions take the Supabase client as an argument so they can be tested
 * without the network.
 */

export const MARKET_AGGREGATES_TTL_MS = 5 * 60 * 1000;

/**
 * Exact count of mapped properties inside the bbox (same predicate as
 * get_map_bounds_property_count).
 */
export async function countPropertiesInBounds(client, {
  lat_min,
  lat_max,
  lng_min,
  lng_max,
  markets = null,
  states = null,
}) {
  let query = client
    .from("properties")
    .select("property_id", { count: "exact", head: true })
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .gte("latitude", lat_min)
    .lte("latitude", lat_max)
    .gte("longitude", lng_min)
    .lte("longitude", lng_max);
  if (markets?.length) query = query.in("market", markets);
  if (states?.length) query = query.in("property_address_state", states);
  const { count, error } = await query;
  if (error) throw error;
  return Number(count ?? 0);
}

function aggregatesKey(markets, states) {
  const part = (list) => (list?.length ? [...list].sort().join("|") : "*");
  return `${part(markets)}::${part(states)}`;
}

/**
 * get_map_market_aggregates, shared across requests. Returns
 * `{ rows, error }` — never throws, so a slow canonical total cannot take the
 * viewport count down with it.
 */
export function createMarketAggregatesReader({
  ttlMs = MARKET_AGGREGATES_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const cache = new Map(); // key -> { at, rows }
  const inflight = new Map(); // key -> Promise<{rows, error}>

  return async function readMarketAggregates(client, { markets = null, states = null } = {}) {
    const key = aggregatesKey(markets, states);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return { rows: hit.rows, error: null, cached: true };
    if (inflight.has(key)) return inflight.get(key);

    const pending = (async () => {
      try {
        const { data, error } = await client.rpc("get_map_market_aggregates", {
          p_markets: markets,
          p_states: states,
        });
        if (error) return { rows: null, error, cached: false };
        const rows = data ?? [];
        cache.set(key, { at: now(), rows });
        return { rows, error: null, cached: false };
      } catch (error) {
        return { rows: null, error, cached: false };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
    return pending;
  };
}

export function sumMarketPropertyCount(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.reduce((sum, row) => sum + Number(row?.property_count || 0), 0);
}
