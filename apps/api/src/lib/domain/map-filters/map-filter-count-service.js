import { hasDatabaseUrl, queryWithTimeout } from "@/lib/postgres/client.js";

import { MAP_FILTER_COUNT_SEMANTICS } from "./count-semantics.js";
import { MAP_FILTER_LIMITS } from "./map-filter-limits.js";
import {
  buildOwnerCountSql,
  buildPropertyCountSql,
  buildPropertyEligibilitySql,
  buildProspectCountSql,
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

export async function countMapFilterEntities(compiled, { bounds = null } = {}) {
  if (!hasDatabaseUrl()) {
    throw new Error("database_url_missing");
  }

  const started = Date.now();
  const parsedBounds = parseBounds(bounds);
  const { sql: predicateSql, params } = buildPropertyEligibilitySql(
    compiled.compiledPredicateAst,
    compiled.params || [],
    { bounds: parsedBounds },
  );

  const propertyQuery = buildPropertyCountSql(predicateSql, parsedBounds);
  const allParams = [...params, ...propertyQuery.extraParams];

  const prospectQuery = buildProspectCountSql(predicateSql);
  const ownerSql = buildOwnerCountSql(predicateSql);

  const [propertyRes, prospectRes, ownerRes] = await Promise.all([
    queryWithTimeout(propertyQuery.sql, allParams, MAP_FILTER_LIMITS.countQueryTimeoutMs),
    queryWithTimeout(prospectQuery.sql, params, MAP_FILTER_LIMITS.countQueryTimeoutMs),
    queryWithTimeout(ownerSql, params, MAP_FILTER_LIMITS.countQueryTimeoutMs),
  ]);

  const matchingProperties = Number(propertyRes.rows[0]?.count || 0);
  const matchingProspects = Number(prospectRes.rows[0]?.count || 0);
  const matchingMasterOwners = Number(ownerRes.rows[0]?.count || 0);

  return {
    counts: {
      matchingProperties,
      matchingProspects,
      matchingMasterOwners,
      propertiesInBounds: parsedBounds ? matchingProperties : null,
      representedProperties: null,
    },
    semantics: MAP_FILTER_COUNT_SEMANTICS,
    timing: {
      countQueryMs: Date.now() - started,
    },
    meta: {
      hasProspectRules: hasEntityRules(compiled.compiledPredicateAst, "prospect"),
      hasOwnerRules: hasEntityRules(compiled.compiledPredicateAst, "master_owner"),
      boundsApplied: Boolean(parsedBounds),
    },
  };
}