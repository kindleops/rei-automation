import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { getRegistryField } from "@/lib/domain/map-filters/active-field-registry.js";
import {
  getMapFilterPreset,
  getMapFilterPresets,
  validatePresetCatalog,
} from "@/lib/domain/map-filters/map-filter-presets.js";
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
        { ok: false, error: "system_control_disabled", context: "map-filter-presets" },
        { status: 423 },
      );
    }

    const presetErrors = validatePresetCatalog((fieldKey) => getRegistryField(fieldKey));
    if (presetErrors.length > 0) {
      return NextResponse.json(
        { ok: false, error: "preset_catalog_invalid", issues: presetErrors },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(request.url);
    const presetKey = searchParams.get("key");
    if (presetKey) {
      const preset = getMapFilterPreset(presetKey);
      if (!preset) {
        return NextResponse.json({ ok: false, error: "preset_not_found", key: presetKey }, { status: 404 });
      }
      return NextResponse.json({
        ok: true,
        route: "internal/dashboard/ops/map/filters/presets",
        data: {
          filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
          registryVersion: MAP_FILTER_REGISTRY_VERSION,
          preset,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/filters/presets",
      data: {
        filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
        registryVersion: MAP_FILTER_REGISTRY_VERSION,
        presets: getMapFilterPresets(),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/filters/presets",
        error: "map_filter_presets_failed",
        message: error?.message || "Unknown presets error",
      },
      { status: 500 },
    );
  }
}