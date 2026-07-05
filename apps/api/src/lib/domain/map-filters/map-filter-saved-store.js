import { supabase } from "@/lib/supabase/client.js";

import { compileMapFilter } from "./map-filter-compiler.js";

function clean(value) {
  return String(value ?? "").trim();
}

function rowToSavedFilter(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    permissionScope: row.permission_scope,
    name: row.name,
    description: row.description,
    expression: row.expression_json,
    summary: row.summary,
    isFavorite: row.is_favorite,
    isSystem: row.is_system,
    scope: row.scope,
    filterSchemaVersion: row.filter_schema_version,
    registryVersion: row.registry_version,
    activeRuleCount: row.active_rule_count,
    lastKnownPropertyCount: row.last_known_property_count == null ? null : Number(row.last_known_property_count),
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMapFilterSavedFilters(authScope) {
  const { data, error } = await supabase
    .from("map_filter_saved_filters")
    .select("*")
    .eq("organization_id", authScope.organizationId)
    .eq("permission_scope", authScope.permissionScope)
    .is("deleted_at", null)
    .order("is_favorite", { ascending: false })
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(rowToSavedFilter);
}

export async function createMapFilterSavedFilter({
  authScope,
  name,
  description = "",
  expression,
  scope = "personal",
  isFavorite = false,
  lastKnownPropertyCount = null,
}) {
  const compiled = compileMapFilter(expression);
  if (!compiled.ok) {
    return { ok: false, status: 400, error: "compile_failed", issues: compiled.errors };
  }

  const row = {
    organization_id: authScope.organizationId,
    created_by: authScope.createdBy,
    permission_scope: authScope.permissionScope,
    name: clean(name) || "Untitled filter",
    description: clean(description),
    expression_json: compiled.compiled.normalizedExpression,
    summary: compiled.compiled.summary,
    is_favorite: Boolean(isFavorite),
    is_system: false,
    scope: scope === "organization" ? "organization" : "personal",
    filter_schema_version: authScope.filterSchemaVersion,
    registry_version: authScope.registryVersion,
    active_rule_count: compiled.compiled.activeRuleCount,
    last_known_property_count: lastKnownPropertyCount,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("map_filter_saved_filters")
    .insert(row)
    .select("*")
    .single();

  if (error) throw error;
  return { ok: true, savedFilter: rowToSavedFilter(data) };
}

export async function updateMapFilterSavedFilter({
  authScope,
  id,
  patch,
}) {
  const updates = { updated_at: new Date().toISOString() };
  if (patch.name != null) updates.name = clean(patch.name) || "Untitled filter";
  if (patch.description != null) updates.description = clean(patch.description);
  if (patch.isFavorite != null) updates.is_favorite = Boolean(patch.isFavorite);
  if (patch.scope != null) updates.scope = patch.scope === "organization" ? "organization" : "personal";
  if (patch.lastKnownPropertyCount != null) updates.last_known_property_count = patch.lastKnownPropertyCount;

  if (patch.expression != null) {
    const compiled = compileMapFilter(patch.expression);
    if (!compiled.ok) {
      return { ok: false, status: 400, error: "compile_failed", issues: compiled.errors };
    }
    updates.expression_json = compiled.compiled.normalizedExpression;
    updates.summary = compiled.compiled.summary;
    updates.active_rule_count = compiled.compiled.activeRuleCount;
    updates.filter_schema_version = authScope.filterSchemaVersion;
    updates.registry_version = authScope.registryVersion;
  }

  const { data, error } = await supabase
    .from("map_filter_saved_filters")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", authScope.organizationId)
    .eq("permission_scope", authScope.permissionScope)
    .is("deleted_at", null)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, status: 404, error: "saved_filter_not_found" };
  return { ok: true, savedFilter: rowToSavedFilter(data) };
}

export async function duplicateMapFilterSavedFilter({ authScope, id }) {
  const { data: rows, error } = await supabase
    .from("map_filter_saved_filters")
    .select("*")
    .eq("id", id)
    .eq("organization_id", authScope.organizationId)
    .eq("permission_scope", authScope.permissionScope)
    .is("deleted_at", null)
    .limit(1);

  if (error) throw error;
  const source = rows?.[0];
  if (!source) return { ok: false, status: 404, error: "saved_filter_not_found" };

  return createMapFilterSavedFilter({
    authScope,
    name: `${source.name} (copy)`,
    description: source.description,
    expression: source.expression_json,
    scope: source.scope,
    isFavorite: false,
    lastKnownPropertyCount: source.last_known_property_count,
  });
}

export async function deleteMapFilterSavedFilter({ authScope, id }) {
  const { data, error } = await supabase
    .from("map_filter_saved_filters")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", authScope.organizationId)
    .eq("permission_scope", authScope.permissionScope)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, status: 404, error: "saved_filter_not_found" };
  return { ok: true };
}

export async function recordMapFilterSavedFilterUse({ authScope, id }) {
  const { data: row, error: loadError } = await supabase
    .from("map_filter_saved_filters")
    .select("use_count")
    .eq("id", id)
    .eq("organization_id", authScope.organizationId)
    .eq("permission_scope", authScope.permissionScope)
    .is("deleted_at", null)
    .single();
  if (loadError) throw loadError;
  const next = Number(row?.use_count || 0) + 1;
  const { error: updateError } = await supabase
    .from("map_filter_saved_filters")
    .update({
      use_count: next,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", authScope.organizationId);
  if (updateError) throw updateError;
  return { ok: true, useCount: next };
}