import { buildPropertyEligibilitySql } from "./map-filter-predicate-sql.js";

function normalizeTokenRecord(tokenRecord) {
  if (!tokenRecord) return null;
  return {
    compiledPredicateAst: tokenRecord.compiledPredicateAst ?? tokenRecord.compiled_predicate_ast,
    params: tokenRecord.params ?? tokenRecord.filter_params ?? [],
    referencedEntities: tokenRecord.referencedEntities ?? tokenRecord.referenced_entities ?? [],
    referencedFieldKeys: tokenRecord.referencedFieldKeys ?? tokenRecord.referenced_field_keys ?? [],
    summary: tokenRecord.summary ?? "",
    activeRuleCount: tokenRecord.activeRuleCount ?? tokenRecord.active_rule_count ?? 0,
    registryVersion: tokenRecord.registryVersion ?? tokenRecord.registry_version,
    filterSchemaVersion: tokenRecord.filterSchemaVersion ?? tokenRecord.filter_schema_version,
  };
}

/**
 * Shared trusted property predicate for all map data sources.
 * Returns parameterized SQL fragment referencing alias `p`.
 */
export function buildAuthorizedMapPropertyPredicate(tokenRecord, { bounds = null } = {}) {
  const normalized = normalizeTokenRecord(tokenRecord);
  const { sql, params } = buildPropertyEligibilitySql(
    normalized.compiledPredicateAst,
    normalized.params,
    { bounds },
  );

  return {
    sqlFragment: sql,
    params,
    referencedEntities: normalized.referencedEntities,
    referencedFieldKeys: normalized.referencedFieldKeys,
    meta: {
      summary: normalized.summary,
      activeRuleCount: normalized.activeRuleCount,
      registryVersion: normalized.registryVersion,
      schemaVersion: normalized.filterSchemaVersion,
    },
  };
}

export function buildMapFilterCacheKey({
  publicToken,
  organizationId,
  permissionScope,
  schemaVersion,
  registryVersion,
  scope = {},
}) {
  return [
    publicToken,
    organizationId,
    permissionScope,
    schemaVersion,
    registryVersion,
    scope.zoom ?? "",
    scope.x ?? "",
    scope.y ?? "",
    scope.lat_min ?? "",
    scope.lat_max ?? "",
    scope.lng_min ?? "",
    scope.lng_max ?? "",
    scope.mode ?? "",
  ].join("|");
}