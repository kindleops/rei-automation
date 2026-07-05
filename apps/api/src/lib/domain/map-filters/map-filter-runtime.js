import { NextResponse } from "next/server";

import { hasDatabaseUrl } from "@/lib/postgres/client.js";

import { buildMapFilterCacheKey } from "./map-filter-property-predicate.js";
import { resolveAuthorizedMapFilterToken } from "./map-filter-token-resolver.js";

function clean(value) {
  return String(value ?? "").trim();
}

export function getMapFilterParam(request) {
  const { searchParams } = new URL(request.url);
  return clean(searchParams.get("filter") || searchParams.get("filterToken") || searchParams.get("token"));
}

export async function resolveMapFilterContext(request) {
  const publicToken = getMapFilterParam(request);
  if (!publicToken) {
    return { active: false, filter: null };
  }

  if (!hasDatabaseUrl()) {
    const err = new Error("database_url_missing");
    err.code = "database_url_missing";
    err.status = 503;
    return { active: true, error: err };
  }

  try {
    const resolved = await resolveAuthorizedMapFilterToken(request, publicToken);
    return { active: true, filter: resolved };
  } catch (error) {
    return { active: true, error };
  }
}

export function mapFilterHttpError(error) {
  const code = error?.code || "map_filter_token_failed";
  const status = Number(error?.status) || 500;
  return NextResponse.json(
    {
      ok: false,
      error: code,
      filter_error: code,
      message: error?.message || code,
    },
    { status },
  );
}

export function buildFilterResponseMeta(filterContext, scope = {}) {
  if (!filterContext?.active || !filterContext.filter) return null;
  const { authScope, publicToken, token } = filterContext.filter;
  return {
    filterToken: publicToken,
    filterSummary: token.summary,
    activeRuleCount: token.activeRuleCount,
    registryVersion: token.registryVersion,
    filterSchemaVersion: token.filterSchemaVersion,
    cacheKey: buildMapFilterCacheKey({
      publicToken,
      organizationId: authScope.organizationId,
      permissionScope: authScope.permissionScope,
      schemaVersion: token.filterSchemaVersion,
      registryVersion: token.registryVersion,
      scope,
    }),
  };
}

export function filteredCacheHeaders(filterMeta) {
  if (!filterMeta) {
    return { "Cache-Control": "public, max-age=120" };
  }
  return {
    "Cache-Control": "private, max-age=60",
    "X-Map-Filter-Cache-Key": filterMeta.cacheKey,
  };
}