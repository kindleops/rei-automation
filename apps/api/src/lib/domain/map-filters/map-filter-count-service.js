import { getPgPool, hasDatabaseUrl } from "@/lib/postgres/client.js";

import { MAP_FILTER_COUNT_SEMANTICS } from "./count-semantics.js";
import { MAP_FILTER_ERRORS } from "./map-filter-errors.js";
import { MAP_FILTER_LIMITS } from "./map-filter-limits.js";
import {
  buildMatchingPropertiesCte,
  buildOwnerCountFromMatchingSql,
  buildPropertyCountFromMatchingSql,
  buildProspectCountFromMatchingSql,
  buildPhoneCountFromMatchingSql,
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
    if (phase === "phone") return MAP_FILTER_ERRORS.phone_count_timeout;
    return MAP_FILTER_ERRORS.count_query_timeout;
  }
  return MAP_FILTER_ERRORS.count_query_failed;
}

/**
 * Short-lived result cache. The universe buckets (All / Uncontacted / Contacted)
 * are re-clicked constantly, while their inputs (the campaign target graph) are
 * re-enriched once a day — so the same cohort is not recounted on every click.
 */
const COUNT_CACHE_TTL_MS = 120_000;
const COUNT_CACHE_MAX = 200;
const countCache = new Map();

export function mapFilterCountCacheKey(compiled, options = {}) {
  return JSON.stringify([
    compiled?.compiledPredicateAst ?? null,
    compiled?.params ?? [],
    parseBounds(options.bounds),
    options.includeProspects !== false,
    options.includeOwners !== false,
    options.includePhones !== false,
  ]);
}

export function clearMapFilterCountCache() {
  countCache.clear();
}

export async function countMapFilterEntities(compiled, options = {}, { now = Date.now, run = countMapFilterEntitiesUncached } = {}) {
  const key = mapFilterCountCacheKey(compiled, options);
  const hit = countCache.get(key);
  if (hit && now() - hit.at < COUNT_CACHE_TTL_MS) {
    return { ...hit.result, timing: { ...hit.result.timing, cacheHit: true, cacheAgeMs: now() - hit.at } };
  }
  const result = await run(compiled, options);
  const hasPhaseErrors = Object.keys(result?.meta?.phaseErrors || {}).length > 0;
  if (!hasPhaseErrors) {
    if (countCache.size >= COUNT_CACHE_MAX) countCache.delete(countCache.keys().next().value);
    countCache.set(key, { at: now(), result });
  }
  return { ...result, timing: { ...result.timing, cacheHit: false } };
}

export async function countMapFilterEntitiesUncached(
  compiled,
  { bounds = null, includeProspects = true, includeOwners = true, includePhones = true } = {},
  { getPool = getPgPool, hasDb = hasDatabaseUrl } = {},
) {
  if (!hasDb()) {
    throw new Error("database_url_missing");
  }

  const totalStarted = Date.now();
  const parsedBounds = parseBounds(bounds);
  const { sql: predicateSql, params } = buildPropertyEligibilitySql(
    compiled.compiledPredicateAst,
    compiled.params || [],
    { bounds: parsedBounds },
  );

  const matchingCte = buildMatchingPropertiesCte(predicateSql, parsedBounds, params.length, {
    requireGeo: Boolean(parsedBounds),
  });
  const allParams = [...params, ...matchingCte.extraParams];
  const timeoutMs = MAP_FILTER_LIMITS.countQueryTimeoutMs;

  const pool = getPool();
  const connStart = Date.now();
  const client = await pool.connect();
  const connectionMs = Date.now() - connStart;

  const timing = {
    connectionMs,
    propertyCountMs: 0,
    prospectCountMs: 0,
    ownerCountMs: 0,
    phoneCountMs: 0,
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

    const phaseErrors = {};
    let matchingProperties = 0;
    let matchingProspects = 0;
    let matchingMasterOwners = 0;
    let matchingPhones = 0;

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

    // Owners and phones are secondary: if one cannot be computed it is reported
    // as null ("—" in the UI), never as a fabricated 0, and the property count
    // still answers. Each runs inside a savepoint so a failure does not abort
    // the transaction.
    const secondaryCount = async (phase, sql) => {
      await client.query(`SAVEPOINT map_filter_${phase}`);
      try {
        const res = await client.query(sql.replace(/matching_properties/g, "_map_filter_matching_properties"));
        await client.query(`RELEASE SAVEPOINT map_filter_${phase}`);
        return Number(res.rows[0]?.count || 0);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT map_filter_${phase}`);
        phaseErrors[phase] = mapQueryError(error, phase);
        return null;
      }
    };

    if (includeOwners) {
      const ownStart = Date.now();
      matchingMasterOwners = await secondaryCount("owner", buildOwnerCountFromMatchingSql());
      timing.ownerCountMs = Date.now() - ownStart;
    } else {
      matchingMasterOwners = null;
    }

    if (includePhones) {
      const phStart = Date.now();
      matchingPhones = await secondaryCount("phone", buildPhoneCountFromMatchingSql());
      timing.phoneCountMs = Date.now() - phStart;
    } else {
      matchingPhones = null;
    }

    await client.query("COMMIT");

    timing.countQueryMs =
      timing.propertyCountMs + timing.prospectCountMs + timing.ownerCountMs + timing.phoneCountMs;
    timing.totalMs = Date.now() - totalStarted;

    return {
      counts: {
        matchingProperties,
        matchingProspects,
        matchingMasterOwners,
        matchingPhones,
        propertiesInBounds: parsedBounds ? matchingProperties : null,
        representedProperties: null,
      },
      semantics: MAP_FILTER_COUNT_SEMANTICS,
      timing,
      meta: {
        hasProspectRules: hasEntityRules(compiled.compiledPredicateAst, "prospect"),
        hasOwnerRules: hasEntityRules(compiled.compiledPredicateAst, "master_owner"),
        hasPhoneRules: hasEntityRules(compiled.compiledPredicateAst, "phone"),
        boundsApplied: Boolean(parsedBounds),
        usesProspectLinkBridge: true,
        usesPhoneLinkBridge: false,
        phoneSource: "campaign_target_graph.canonical_e164",
        touchSource: "campaign_target_graph.never_contacted",
        phaseErrors,
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