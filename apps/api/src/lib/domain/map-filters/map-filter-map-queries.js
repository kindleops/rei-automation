import { queryWithTimeout } from "@/lib/postgres/client.js";

import { MAP_FILTER_LIMITS } from "./map-filter-limits.js";
import {
  buildMatchingPropertiesCte,
  buildPropertyEligibilitySql,
} from "./map-filter-predicate-sql.js";

const QUERY_TIMEOUT_MS = MAP_FILTER_LIMITS.countQueryTimeoutMs;
const MVT_TILE_COORD_PARAM_COUNT = 3;

/** Renumber $1..$N placeholders after leading tile coordinate params ($1-$3). */
function offsetSqlParamPlaceholders(sql, offset) {
  if (!offset) return sql;
  return String(sql).replace(/\$(\d+)/g, (_, index) => `$${Number(index) + offset}`);
}

function buildCompiledPredicate(compiled) {
  return buildPropertyEligibilitySql(
    compiled.compiledPredicateAst,
    compiled.params || [],
  );
}

function appendMarketStateFilters({ markets, states }, params, startIndex) {
  let clause = "";
  let nextIndex = startIndex;
  if (markets?.length) {
    clause += ` AND p.market = ANY($${nextIndex})`;
    params.push(markets);
    nextIndex += 1;
  }
  if (states?.length) {
    clause += ` AND p.property_address_state = ANY($${nextIndex})`;
    params.push(states);
    nextIndex += 1;
  }
  return { clause, params, nextIndex };
}

function matchingCteSql(compiled, bounds = null, { requireGeo = true } = {}) {
  const { sql: predicateSql, params } = buildCompiledPredicate(compiled);
  const matchingCte = buildMatchingPropertiesCte(predicateSql, bounds, params.length, { requireGeo });
  return {
    predicateParams: params,
    extraParams: matchingCte.extraParams,
    allParams: [...params, ...matchingCte.extraParams],
    sql: matchingCte.sql,
  };
}

export async function getFilteredMarketAggregates(compiled, { markets = null, states = null } = {}) {
  const cte = matchingCteSql(compiled);
  const params = [...cte.allParams];
  const marketState = appendMarketStateFilters({ markets, states }, params, params.length + 1);

  const sql = `
    WITH matching_properties AS MATERIALIZED (
      ${cte.sql}
    )
    SELECT
      COALESCE(NULLIF(TRIM(p.market), ''), 'Unknown') AS market,
      MAX(NULLIF(TRIM(p.property_address_state), '')) AS state_code,
      COUNT(*)::bigint AS property_count,
      AVG(p.latitude::double precision) AS centroid_lat,
      AVG(p.longitude::double precision) AS centroid_lng,
      COUNT(*) FILTER (WHERE COALESCE(p.contact_status, 'uncontacted') IN ('uncontacted', 'not_contacted', ''))::bigint AS uncontacted_count,
      COUNT(*) FILTER (WHERE COALESCE(p.contact_status, '') NOT IN ('uncontacted', 'not_contacted', ''))::bigint AS contacted_count,
      COUNT(*) FILTER (WHERE COALESCE(p.activity_status, '') ILIKE '%hot%')::bigint AS hot_count,
      COUNT(*) FILTER (WHERE COALESCE(p.activity_status, '') ILIKE '%reply%')::bigint AS new_reply_count
    FROM public.properties p
    INNER JOIN matching_properties mp ON mp.property_id = p.property_id
    WHERE p.latitude IS NOT NULL
      AND p.longitude IS NOT NULL
      ${marketState.clause}
    GROUP BY COALESCE(NULLIF(TRIM(p.market), ''), 'Unknown')
    HAVING COUNT(*) > 0
    ORDER BY property_count DESC
  `;

  const { rows } = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return rows;
}

export async function getFilteredSpatialClusters(
  compiled,
  { lat_min, lat_max, lng_min, lng_max, gridDegrees },
) {
  const bounds = { lat_min, lat_max, lng_min, lng_max };
  const cte = matchingCteSql(compiled, bounds);

  const sql = `
    WITH matching_properties AS MATERIALIZED (
      ${cte.sql}
    ),
    grid AS (
      SELECT
        p.*,
        FLOOR(p.latitude::numeric / $${cte.allParams.length + 1}) AS grid_lat,
        FLOOR(p.longitude::numeric / $${cte.allParams.length + 1}) AS grid_lng
      FROM public.properties p
      INNER JOIN matching_properties mp ON mp.property_id = p.property_id
      WHERE p.latitude IS NOT NULL
        AND p.longitude IS NOT NULL
    )
    SELECT
      grid_lat::text || ':' || grid_lng::text AS cluster_key,
      COUNT(*)::bigint AS property_count,
      AVG(latitude::double precision) AS centroid_lat,
      AVG(longitude::double precision) AS centroid_lng,
      MODE() WITHIN GROUP (ORDER BY market) AS market,
      COUNT(*) FILTER (WHERE COALESCE(contact_status, 'uncontacted') IN ('uncontacted', 'not_contacted', ''))::bigint AS uncontacted_count,
      COUNT(*) FILTER (WHERE COALESCE(activity_status, '') ILIKE '%hot%')::bigint AS hot_count,
      COUNT(*) FILTER (WHERE COALESCE(activity_status, '') ILIKE '%reply%')::bigint AS new_reply_count
    FROM grid
    GROUP BY grid_lat, grid_lng
    HAVING COUNT(*) > 0
  `;

  const params = [...cte.allParams, gridDegrees];
  const { rows } = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return rows;
}

export async function getFilteredBoundsPropertyCount(
  compiled,
  { lat_min, lat_max, lng_min, lng_max, markets = null, states = null },
) {
  const bounds = { lat_min, lat_max, lng_min, lng_max };
  const cte = matchingCteSql(compiled, bounds);
  const params = [...cte.allParams];
  const marketState = appendMarketStateFilters({ markets, states }, params, params.length + 1);

  const sql = `
    WITH matching_properties AS MATERIALIZED (
      ${cte.sql}
    )
    SELECT COUNT(*)::bigint AS property_count
    FROM public.properties p
    INNER JOIN matching_properties mp ON mp.property_id = p.property_id
    WHERE p.latitude IS NOT NULL
      AND p.longitude IS NOT NULL
      ${marketState.clause}
  `;

  const { rows } = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return Number(rows[0]?.property_count ?? 0);
}

export async function getFilteredMapProperties(
  compiled,
  {
    lat_min,
    lat_max,
    lng_min,
    lng_max,
    markets = null,
    states = null,
    limit,
    selectFields,
  },
) {
  const bounds = { lat_min, lat_max, lng_min, lng_max };
  const cte = matchingCteSql(compiled, bounds);
  const params = [...cte.allParams];
  const marketState = appendMarketStateFilters({ markets, states }, params, params.length + 1);
  const limitIndex = marketState.nextIndex;
  params.push(limit);

  const sql = `
    WITH matching_properties AS MATERIALIZED (
      ${cte.sql}
    )
    SELECT ${selectFields}
    FROM public.properties p
    INNER JOIN matching_properties mp ON mp.property_id = p.property_id
    WHERE p.latitude IS NOT NULL
      AND p.longitude IS NOT NULL
      ${marketState.clause}
    ORDER BY p.final_acquisition_score DESC NULLS LAST
    LIMIT $${limitIndex}
  `;

  const { rows } = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return rows;
}

export async function getFilteredMapVectorTile(compiled, { z, x, y }) {
  const cte = matchingCteSql(compiled);
  const matchingSql = offsetSqlParamPlaceholders(cte.sql, MVT_TILE_COORD_PARAM_COUNT);

  const sql = `
    WITH tile_bounds AS (
      SELECT ST_TileEnvelope($1::int, $2::int, $3::int) AS geom_3857
    ),
    matching_properties AS MATERIALIZED (
      ${matchingSql}
    ),
    mvt_source AS (
      SELECT
        p.property_id::text AS property_id,
        public.resolve_property_marker_key_sql(
          p.property_type,
          p.asset_type,
          p.units_count,
          p.multifamily_units
        ) AS marker_key,
        COALESCE(NULLIF(TRIM(p.market), ''), 'Unknown') AS market,
        COALESCE(p.contact_status, 'uncontacted') AS contact_status,
        COALESCE(p.activity_status, '') AS activity_status,
        COALESCE(p.final_acquisition_score, 0)::integer AS acquisition_score,
        ST_AsMVTGeom(
          ST_Transform(
            ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326),
            3857
          ),
          tb.geom_3857,
          4096,
          64,
          true
        ) AS geom
      FROM public.properties p
      CROSS JOIN tile_bounds tb
      INNER JOIN matching_properties mp ON mp.property_id = p.property_id
      WHERE p.latitude IS NOT NULL
        AND p.longitude IS NOT NULL
        AND ST_Intersects(
          ST_Transform(
            ST_SetSRID(ST_MakePoint(p.longitude::double precision, p.latitude::double precision), 4326),
            3857
          ),
          tb.geom_3857
        )
    )
    SELECT ST_AsMVT(mvt_source, 'properties', 4096, 'geom') AS mvt
    FROM mvt_source
    WHERE geom IS NOT NULL
  `;

  const params = [z, x, y, ...cte.allParams];
  const { rows } = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  const mvt = rows[0]?.mvt;
  if (!mvt) return Buffer.alloc(0);
  return Buffer.isBuffer(mvt) ? mvt : Buffer.from(mvt);
}