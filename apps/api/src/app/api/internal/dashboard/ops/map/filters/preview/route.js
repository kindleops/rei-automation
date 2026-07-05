import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { hasDatabaseUrl } from "@/lib/postgres/client.js";
import { previewMapFilterCounts } from "@/lib/domain/map-filters/map-filter-route-service.js";
import { MAP_FILTER_REGISTRY_VERSION, MAP_FILTER_SCHEMA_VERSION } from "@/lib/domain/map-filters/versions.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        { ok: false, error: "system_control_disabled", context: "map-filter-preview" },
        { status: 423 },
      );
    }

    if (!hasDatabaseUrl()) {
      return NextResponse.json(
        { ok: false, error: "database_url_missing", context: "map-filter-preview" },
        { status: 503 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const started = Date.now();
    const result = await previewMapFilterCounts(request, body);

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          route: "internal/dashboard/ops/map/filters/preview",
          error: result.error,
          phase: result.phase || null,
          issues: result.issues,
          key: result.key,
        },
        { status: result.status || 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/filters/preview",
      data: {
        filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
        registryVersion: MAP_FILTER_REGISTRY_VERSION,
        summary: result.compiled.summary,
        activeRuleCount: result.compiled.activeRuleCount,
        referencedFieldKeys: result.compiled.referencedFieldKeys,
        referencedEntities: result.compiled.referencedEntities,
        counts: result.counts,
        semantics: result.semantics,
        bounds: result.bounds,
        timing: {
          ...result.timing,
          routeMs: Date.now() - started,
        },
        meta: result.meta,
      },
    });
  } catch (error) {
    const code = error?.code || "map_filter_preview_failed";
    const status = String(code).endsWith("_timeout") ? 504 : 500;
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/filters/preview",
        error: code,
        phase: error?.phase || null,
        message: error?.message || "Unknown preview error",
      },
      { status },
    );
  }
}