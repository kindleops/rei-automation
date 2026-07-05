import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { compileAndStoreMapFilterToken } from "@/lib/domain/map-filters/map-filter-route-service.js";
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
        { ok: false, error: "system_control_disabled", context: "map-filter-token" },
        { status: 423 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const started = Date.now();
    const result = await compileAndStoreMapFilterToken(request, body);

    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          route: "internal/dashboard/ops/map/filters/token",
          error: result.error,
          issues: result.issues,
          key: result.key,
        },
        { status: result.status || 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/filters/token",
      data: {
        filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
        registryVersion: MAP_FILTER_REGISTRY_VERSION,
        filterToken: result.token.filterToken,
        expiresAt: result.token.expiresAt,
        summary: result.token.summary,
        activeRuleCount: result.compiled.activeRuleCount,
        referencedFieldKeys: result.compiled.referencedFieldKeys,
        referencedEntities: result.compiled.referencedEntities,
        timing: {
          compileStoreMs: Date.now() - started,
        },
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/filters/token",
        error: "map_filter_token_failed",
        message: error?.message || "Unknown token error",
      },
      { status: 500 },
    );
  }
}