import { supabase } from "@/lib/supabase/client.js";

import {
  buildFilterTokenDigest,
  exposeFilterTokenDigest,
  verifyFilterTokenScope,
} from "./filter-scope.js";
import { MAP_FILTER_LIMITS } from "./map-filter-limits.js";

const L1_CACHE = new Map();
const L1_MAX = 200;

function clean(value) {
  return String(value ?? "").trim();
}

function cacheGet(digest) {
  const hit = L1_CACHE.get(digest);
  if (!hit) return null;
  if (new Date(hit.expires_at).getTime() < Date.now()) {
    L1_CACHE.delete(digest);
    return null;
  }
  return hit;
}

function cacheSet(record) {
  if (L1_CACHE.size >= L1_MAX) {
    const firstKey = L1_CACHE.keys().next().value;
    L1_CACHE.delete(firstKey);
  }
  L1_CACHE.set(record.filter_token_digest, record);
}

export async function upsertMapFilterToken({
  authScope,
  compiled,
  ttlHours = MAP_FILTER_LIMITS.tokenTtlHours,
}) {
  const filterTokenDigest = buildFilterTokenDigest({
    organizationId: authScope.organizationId,
    permissionScope: authScope.permissionScope,
    filterSchemaVersion: authScope.filterSchemaVersion,
    registryVersion: authScope.registryVersion,
    normalizedExpression: compiled.normalizedExpression,
  });
  const filterTokenExposed = exposeFilterTokenDigest(filterTokenDigest);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  const row = {
    filter_token_digest: filterTokenDigest,
    filter_token_exposed: filterTokenExposed,
    organization_id: authScope.organizationId,
    created_by: authScope.createdBy,
    permission_scope: authScope.permissionScope,
    filter_schema_version: authScope.filterSchemaVersion,
    registry_version: authScope.registryVersion,
    normalized_expression: compiled.normalizedExpression,
    compiled_predicate_ast: compiled.compiledPredicateAst,
    filter_params: compiled.params,
    referenced_field_keys: compiled.referencedFieldKeys,
    referenced_entities: compiled.referencedEntities,
    summary: compiled.summary,
    active_rule_count: compiled.activeRuleCount,
    expires_at: expiresAt,
    last_used_at: null,
  };

  const { error } = await supabase.from("map_filter_tokens").upsert(row, {
    onConflict: "filter_token_digest",
  });
  if (error) throw error;

  cacheSet(row);
  return {
    filterTokenDigest,
    filterToken: filterTokenExposed,
    expiresAt,
    summary: compiled.summary,
  };
}

export async function loadMapFilterToken(token, authScope) {
  const exposed = clean(token);
  if (!exposed) return { ok: false, error: "missing_token" };

  const { data: rows, error } = await supabase
    .from("map_filter_tokens")
    .select("*")
    .or(`filter_token_exposed.eq.${exposed},filter_token_digest.eq.${exposed}`)
    .limit(1);

  if (error) throw error;
  const row = rows?.[0];
  if (!row) return { ok: false, error: "token_not_found" };

  if (row.revoked_at) {
    return { ok: false, error: "token_revoked" };
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "token_expired" };
  }

  const record = {
    filter_token_digest: row.filter_token_digest,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    permissionScope: row.permission_scope,
    filterSchemaVersion: row.filter_schema_version,
    registryVersion: row.registry_version,
  };

  if (!verifyFilterTokenScope(record, authScope)) {
    return { ok: false, error: "token_scope_denied" };
  }

  cacheSet(row);

  void supabase
    .from("map_filter_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("filter_token_digest", row.filter_token_digest);

  return {
    ok: true,
    token: {
      filterTokenDigest: row.filter_token_digest,
      filterToken: row.filter_token_exposed,
      organizationId: row.organization_id,
      createdBy: row.created_by,
      permissionScope: row.permission_scope,
      filterSchemaVersion: row.filter_schema_version,
      registryVersion: row.registry_version,
      normalizedExpression: row.normalized_expression,
      compiledPredicateAst: row.compiled_predicate_ast,
      params: row.filter_params || [],
      referencedFieldKeys: row.referenced_field_keys || [],
      referencedEntities: row.referenced_entities || [],
      summary: row.summary,
      activeRuleCount: row.active_rule_count,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
    },
  };
}

export function compiledFromTokenRecord(tokenRecord) {
  return {
    version: tokenRecord.filterSchemaVersion,
    normalizedExpression: tokenRecord.normalizedExpression,
    compiledPredicateAst: tokenRecord.compiledPredicateAst,
    params: tokenRecord.params || [],
    summary: tokenRecord.summary,
    activeRuleCount: tokenRecord.activeRuleCount,
    referencedFieldKeys: tokenRecord.referencedFieldKeys,
    referencedEntities: tokenRecord.referencedEntities,
  };
}