import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { resolveMapFilterAuthScope } from "@/lib/domain/map-filters/filter-scope.js";
import {
  deleteMapFilterSavedFilter,
  duplicateMapFilterSavedFilter,
  recordMapFilterSavedFilterUse,
  updateMapFilterSavedFilter,
} from "@/lib/domain/map-filters/map-filter-saved-store.js";
import { MAP_FILTER_REGISTRY_VERSION, MAP_FILTER_SCHEMA_VERSION } from "@/lib/domain/map-filters/versions.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request, { params }) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        { ok: false, error: "system_control_disabled", context: "map-filter-saved-update" },
        { status: 423 },
      );
    }

    const body = await request.json();
    const authScope = resolveMapFilterAuthScope(request);
    const id = params.id;

    if (body.action === "duplicate") {
      const result = await duplicateMapFilterSavedFilter({ authScope, id });
      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error }, { status: result.status || 404 });
      }
      return NextResponse.json({
        ok: true,
        route: "internal/dashboard/ops/map/filters/saved/[id]",
        data: { savedFilter: result.savedFilter },
      });
    }

    if (body.action === "record_use") {
      await recordMapFilterSavedFilterUse({ authScope, id });
      return NextResponse.json({ ok: true, route: "internal/dashboard/ops/map/filters/saved/[id]" });
    }

    const result = await updateMapFilterSavedFilter({
      authScope,
      id,
      patch: {
        name: body.name,
        description: body.description,
        isFavorite: body.isFavorite,
        scope: body.scope,
        expression: body.expression,
        lastKnownPropertyCount: body.lastKnownPropertyCount,
      },
    });

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error, issues: result.issues },
        { status: result.status || 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/filters/saved/[id]",
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
        route: "internal/dashboard/ops/map/filters/saved/[id]",
        error: "map_filter_saved_update_failed",
        message: error?.message || "Unknown saved filter update error",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request, { params }) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        { ok: false, error: "system_control_disabled", context: "map-filter-saved-delete" },
        { status: 423 },
      );
    }

    const authScope = resolveMapFilterAuthScope(request);
    const result = await deleteMapFilterSavedFilter({ authScope, id: params.id });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status || 404 });
    }

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/filters/saved/[id]",
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/filters/saved/[id]",
        error: "map_filter_saved_delete_failed",
        message: error?.message || "Unknown saved filter delete error",
      },
      { status: 500 },
    );
  }
}