import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { parseAdvancedFiltersParam } from "@/lib/domain/inbox/inbox-advanced-filters.js";
import { queryMapFilterOptions } from "@/lib/domain/map-filters/map-filter-options-service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        { ok: false, error: "system_control_disabled", context: "map-filter-options" },
        { status: 423 },
      );
    }

    const { searchParams } = new URL(request.url);
    const field = searchParams.get("field");
    if (!field) {
      return NextResponse.json(
        { ok: false, error: "field_required", route: "internal/dashboard/ops/map/filters/options" },
        { status: 400 },
      );
    }

    const entries = Object.fromEntries(searchParams.entries());
    const filters = parseAdvancedFiltersParam(entries);
    const search = searchParams.get("search") || "";
    const result = await queryMapFilterOptions({ field, filters, search });

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/filters/options",
      data: result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/filters/options",
        error: "map_filter_options_failed",
        message: error?.message || "Unknown map filter options error",
      },
      { status: 500 },
    );
  }
}