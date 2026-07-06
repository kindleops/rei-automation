import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import {
  assertRegistryIntegrity,
  getClientMapFilterRegistry,
} from "@/lib/domain/map-filters/active-field-registry.js";
import { getClientOperatorMapFilterRegistry } from "@/lib/domain/map-filters/operator-filter-catalog.js";
import { MAP_FILTER_COUNT_SEMANTICS } from "@/lib/domain/map-filters/count-semantics.js";
import { RELATIONSHIP_MATCH_SEMANTICS } from "@/lib/domain/map-filters/relationship-semantics.js";
import { REMOVED_PLACEHOLDER_PRESETS } from "@/lib/domain/map-filters/removed-placeholders.js";
import { MAP_FILTER_SCHEMA_VERSION } from "@/lib/domain/map-filters/versions.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        { ok: false, error: "system_control_disabled", context: "map-filter-registry" },
        { status: 423 },
      );
    }

    const integrityErrors = assertRegistryIntegrity();
    if (integrityErrors.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "registry_integrity_failed",
          issues: integrityErrors,
        },
        { status: 500 },
      );
    }

    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") || "";
    const catalog = (searchParams.get("catalog") || "operator").toLowerCase();

    const registry = getClientMapFilterRegistry();
    const operatorCatalog = catalog === "operator"
      ? getClientOperatorMapFilterRegistry({ query: q })
      : null;
    const fields = operatorCatalog?.fields ?? registry.fields;

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/filters/registry",
      data: {
        filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
        registryVersion: registry.registryVersion,
        generatedAt: registry.generatedAt,
        catalog: operatorCatalog?.catalog || "full",
        activeFieldCount: fields.length,
        registryFieldCount: operatorCatalog?.registryFieldCount ?? registry.activeFieldCount,
        tableBaselines: registry.tableBaselines,
        countSemantics: MAP_FILTER_COUNT_SEMANTICS,
        relationshipSemantics: RELATIONSHIP_MATCH_SEMANTICS,
        removedPlaceholderPresets: REMOVED_PLACEHOLDER_PRESETS,
        aliases: registry.aliases,
        partialCoverageFields: operatorCatalog?.partialCoverageFields ?? registry.partialCoverageFields,
        excludedEmptyFieldCount: registry.excludedEmptyFieldCount,
        excludedSensitiveFieldCount: registry.excludedSensitiveFieldCount,
        fieldsByEntity: operatorCatalog?.fieldsByEntity ?? registry.fieldsByEntity,
        fieldsByCategory: operatorCatalog?.fieldsByCategory ?? registry.fieldsByCategory,
        fields,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/filters/registry",
        error: "map_filter_registry_failed",
        message: error?.message || "Unknown registry error",
      },
      { status: 500 },
    );
  }
}