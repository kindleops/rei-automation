import { getPgPool, hasDatabaseUrl } from "@/lib/postgres/client.js";

import { MAP_FILTER_COUNT_SEMANTICS } from "./count-semantics.js";
import { MAP_FILTER_ERRORS } from "./map-filter-errors.js";
import { MAP_FILTER_LIMITS } from "./map-filter-limits.js";
import {
  buildMatchingPropertiesCte,
  buildOwnerCountFromMatchingSql,
  buildPropertyCountFromMatchingSql,
  buildProspectCountFromMatchingSql,
  buildPropertyEligibilitySql,
  hasEntityRules,
} from "./map-filter-predicate-sql.js";

function parseBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const lat_min = Number(bounds.lat_min);
  const lat_max = Number(bounds.lat_max);
  const lng_min = Number(bounds.lng_min);
  const lng_max = Number(bounds.lng_max);
  if (![lat_min, lat_max, lng_min, lng_max].every(Number.isFinite)) return null;
  return { lat_min, lat_max, lng_min, lng_max };
}

function mapQueryError(error, phase) {
  if (error?.code === "57014") {
    if (phase === "property") return MAP_FILTER_ERRORS.property_count_timeout;
    if (phase === "prospect") return MAP_FILTER_ERRORS.prospect_count_timeout;
    if (phase === "owner") return MAP_FILTER_ERRORS.owner_count_timeout;
    return MAP_FILTER_ERRORS.count_query_timeout;
  }
  return MAP_FILTER_ERRORS.count_query_failed;
}

export async function countMapFilterEntities(
  compiled,
  { bounds = null, includeProspects = true, includeOwners = true } = {},
) {
  if (!hasDatabaseUrl()) {
    throw new Error("database_url_missing");
  }

  const totalStarted = Date.now();
  const parsedBounds = parseBounds(bounds);
  const { sql: predicateSql, params } = buildPropertyEligibilitySql(
    compiled.compiledPredicateAst,
    compiled.params || [],
    { bounds: parsedBounds },
  );

  const matchingCte = buildMatchingPropertiesCte(predicateSql, parsedBounds, params.length);
  const allParams = [...params, ...matchingCte.extraParams];
  const timeoutMs = MAP_FILTER_LIMITS.countQueryTimeoutMs;

  const pool = getPgPool();
  const connStart = Date.now();
  const client = await pool.connect();
  const connectionMs = Date.now() - connStart;

  const timing = {
    connectionMs,
    propertyCountMs: 0,
    prospectCountMs: 0,
    ownerCountMs: 0,
    countQueryMs: 0,
    totalMs: 0,
  };

  try {
    await client.query(`SET statement_timeout = ${Math.trunc(timeoutMs)}`);
    await client.query("BEGIN");

    await client.query(
      `CREATE TEMP TABLE _map_filter_matching_properties ON COMMIT DROP AS ${matchingCte.sql}`,
      allParams,
    );

    let matchingProperties = 0;
    let matchingProspects = 0;
    let matchingMasterOwners = 0;

    try {
      const propStart = Date.now();
      const propertyRes = await client.query(buildPropertyCountFromMatchingSql().replace(
        "matching_properties",
        "_map_filter_matching_properties",
      ));
      timing.propertyCountMs = Date.now() - propStart;
      matchingProperties = Number(propertyRes.rows[0]?.count || 0);
    } catch (error) {
      const code = mapQueryError(error, "property");
      const err = new Error(code);
      err.code = code;
      err.phase = "property";
      throw err;
    }

    if (includeProspects) {
      try {
        const prStart = Date.now();
        const prospectSql = buildProspectCountFromMatchingSql()
          .replace(/matching_properties/g, "_map_filter_matching_properties");
        const prospectRes = await client.query(prospectSql);
        timing.prospectCountMs = Date.now() - prStart;
        matchingProspects = Number(prospectRes.rows[0]?.count || 0);
      } catch (error) {
        const code = mapQueryError(error, "prospect");
        const err = new Error(code);
        err.code = code;
        err.phase = "prospect";
        throw err;
      }
    }

    if (includeOwners) {
      try {
        const ownStart = Date.now();
        const ownerSql = buildOwnerCountFromMatchingSql()
          .replace(/matching_properties/g, "_map_filter_matching_properties");
        const ownerRes = await client.query(ownerSql);
        timing.ownerCountMs = Date.now() - ownStart;
        matchingMasterOwners = Number(ownerRes.rows[0]?.count || 0);
      } catch (error) {
        const code = mapQueryError(error, "owner");
        const err = new Error(code);
        err.code = code;
        err.phase = "owner";
        throw err;
      }
    }

    await client.query("COMMIT");

    timing.countQueryMs =
      timing.propertyCountMs + timing.prospectCountMs + timing.ownerCountMs;
    timing.totalMs = Date.now() - totalStarted;

    return {
      counts: {
        matchingProperties,
        matchingProspects,
        matchingMasterOwners,
        propertiesInBounds: parsedBounds ? matchingProperties : null,
        representedProperties: null,
      },
      semantics: MAP_FILTER_COUNT_SEMANTICS,
      timing,
      meta: {
        hasProspectRules: hasEntityRules(compiled.compiledPredicateAst, "prospect"),
        hasOwnerRules: hasEntityRules(compiled.compiledPredicateAst, "master_owner"),
        boundsApplied: Boolean(parsedBounds),
        usesProspectLinkBridge: true,
      },
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }
}