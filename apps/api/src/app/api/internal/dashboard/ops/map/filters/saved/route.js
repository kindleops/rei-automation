import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { resolveMapFilterAuthScope } from "@/lib/domain/map-filters/filter-scope.js";
import {
  createMapFilterSavedFilter,
  listMapFilterSavedFilters,
} from "@/lib/domain/map-filters/map-filter-saved-store.js";
import { MAP_FILTER_REGISTRY_VERSION, MAP_FILTER_SCHEMA_VERSION } from "@/lib/domain/map-filters/versions.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        { ok: false, error: "system_control_disabled", context: "map-filter-saved-list" },
        { status: 423 },
      );
    }

    const authScope = resolveMapFilterAuthScope(request);
    const savedFilters = await listMapFilterSavedFilters(authScope);

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/filters/saved",
      data: {
        filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
        registryVersion: MAP_FILTER_REGISTRY_VERSION,
        savedFilters,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/filters/saved",
        error: "map_filter_saved_list_failed",
        message: error?.message || "Unknown saved filter list error",
      },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        { ok: false, error: "system_control_disabled", context: "map-filter-saved-create" },
        { status: 423 },
      );
    }

    const body = await request.json();
    const authScope = resolveMapFilterAuthScope(request);
    const result = await createMapFilterSavedFilter({
      authScope,
      name: body.name,
      description: body.description,
      expression: body.expression,
      scope: body.scope,
      isFavorite: body.isFavorite,
      lastKnownPropertyCount: body.lastKnownPropertyCount,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          route: "internal/dashboard/ops/map/filters/saved",
          error: result.error,
          issues: result.issues,
        },
        { status: result.status || 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/filters/saved",
      data: {
        filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
        registryVersion: MAP_FILTER_REGISTRY_VERSION,
        savedFilter: result.savedFilter,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/filters/saved",
        error: "map_filter_saved_create_failed",
        message: error?.message || "Unknown saved filter create error",
      },
      { status: 500 },
    );
  }
}