import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { supabase } from "@/lib/supabase/client.js";
import { decodeSupabaseBytea } from "@/lib/domain/map/decode-bytea.js";
import { decodePropertyMvtTile } from "@/lib/domain/map/decode-mvt-tile.js";
import { getCoveringTileCoords, isPointInBounds } from "@/lib/domain/map/tile-coords.js";
import {
  getFilteredBoundsPropertyCount,
  getFilteredMarketAggregates,
  getFilteredMapVectorTile,
} from "@/lib/domain/map-filters/map-filter-map-queries.js";
import {
  buildFilterResponseMeta,
  mapFilterHttpError,
  resolveMapFilterContext,
} from "@/lib/domain/map-filters/map-filter-runtime.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(request) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        { ok: false, error: "system_control_disabled", context: "dashboard-map-accounting" },
        { status: 423 },
      );
    }

    const { searchParams } = new URL(request.url);
    const lat_min = asNumber(searchParams.get("lat_min"), null);
    const lat_max = asNumber(searchParams.get("lat_max"), null);
    const lng_min = asNumber(searchParams.get("lng_min"), null);
    const lng_max = asNumber(searchParams.get("lng_max"), null);
    const zoom = asNumber(searchParams.get("zoom"), 12);

    if (lat_min === null || lat_max === null || lng_min === null || lng_max === null) {
      return NextResponse.json({ ok: false, error: "missing_bounds" }, { status: 400 });
    }

    const bounds = { lat_min, lat_max, lng_min, lng_max };
    const tileZoom = Math.max(9, Math.min(16, Math.floor(zoom)));

    const filterContext = await resolveMapFilterContext(request);
    if (filterContext.active && filterContext.error) {
      return mapFilterHttpError(filterContext.error);
    }
    const filterCompiled = filterContext.filter?.compiled ?? null;

    let canonicalCount;
    let marketRows;
    if (filterCompiled) {
      [canonicalCount, marketRows] = await Promise.all([
        getFilteredBoundsPropertyCount(filterCompiled, {
          lat_min,
          lat_max,
          lng_min,
          lng_max,
          markets: null,
          states: null,
        }),
        getFilteredMarketAggregates(filterCompiled, { markets: null, states: null }),
      ]);
    } else {
      const [countResult, marketResult] = await Promise.all([
        supabase.rpc("get_map_bounds_property_count", {
          p_lat_min: lat_min,
          p_lat_max: lat_max,
          p_lng_min: lng_min,
          p_lng_max: lng_max,
          p_markets: null,
          p_states: null,
        }),
        supabase.rpc("get_map_market_aggregates", { p_markets: null, p_states: null }),
      ]);
      if (countResult.error) throw countResult.error;
      if (marketResult.error) throw marketResult.error;
      canonicalCount = countResult.data;
      marketRows = marketResult.data;
    }

    const totalCanonical = (marketRows ?? []).reduce((sum, row) => sum + Number(row.property_count || 0), 0);
    const coveringTiles = getCoveringTileCoords(bounds, tileZoom);

    const seen = new Map();
    let decodedFeatureCount = 0;
    let duplicatePropertyIdCount = 0;
    const uniqueInBounds = new Set();

    for (const tile of coveringTiles) {
      let bytes;
      if (filterCompiled) {
        bytes = await getFilteredMapVectorTile(filterCompiled, tile);
      } else {
        const { data, error } = await supabase.rpc("get_property_map_vector_tile", tile);
        if (error) throw error;
        bytes = decodeSupabaseBytea(data);
      }
      const decoded = decodePropertyMvtTile(bytes, tile.z, tile.x, tile.y);
      decodedFeatureCount += decoded.length;

      for (const feature of decoded) {
        const id = feature.property_id;
        seen.set(id, (seen.get(id) ?? 0) + 1);
        if (feature.longitude == null || feature.latitude == null) continue;
        if (!isPointInBounds(feature.longitude, feature.latitude, bounds)) continue;
        uniqueInBounds.add(id);
      }
    }

    for (const count of seen.values()) {
      if (count > 1) duplicatePropertyIdCount += count - 1;
    }

    const canonicalTotalInBounds = Number(canonicalCount ?? 0);
    const uniqueTilePropertyIds = uniqueInBounds.size;
    const difference = canonicalTotalInBounds - uniqueTilePropertyIds;

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map/accounting",
      data: {
        bounds,
        zoom: tileZoom,
        total_canonical: totalCanonical,
        canonical_total_in_bounds: canonicalTotalInBounds,
        covering_tile_count: coveringTiles.length,
        decoded_feature_count: decodedFeatureCount,
        unique_tile_property_ids: uniqueTilePropertyIds,
        duplicate_property_id_count: duplicatePropertyIdCount,
        difference,
        edge_rule: (
          "unique_tile_property_ids filters decoded MVT coordinates to exact bounds; "
          + "duplicate_property_id_count is MVT buffer overlap across tiles; "
          + "difference should be 0 when all covering tiles are fetched"
        ),
        tile_backed: tileZoom >= 9,
        filter: buildFilterResponseMeta(filterContext, {
          zoom: tileZoom,
          lat_min,
          lat_max,
          lng_min,
          lng_max,
          mode: "accounting",
        }),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/accounting",
        error: "map_accounting_failed",
        message: error?.message || "Unknown map accounting error",
      },
      { status: 500 },
    );
  }
}