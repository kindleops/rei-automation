import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { supabase } from "@/lib/supabase/client.js";
import { decodeSupabaseBytea } from "@/lib/domain/map/decode-bytea.js";
import { getFilteredMapVectorTile } from "@/lib/domain/map-filters/map-filter-map-queries.js";
import {
  buildFilterResponseMeta,
  filteredCacheHeaders,
  mapFilterHttpError,
  resolveMapFilterContext,
} from "@/lib/domain/map-filters/map-filter-runtime.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseTileParam(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid_${name}`);
  }
  return parsed;
}

export async function GET(request, { params }) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        { ok: false, error: "system_control_disabled", context: "dashboard-map-tiles" },
        { status: 423 },
      );
    }

    const z = parseTileParam(params.z, "z");
    const x = parseTileParam(params.x, "x");
    const y = parseTileParam(params.y, "y");

    const emptyTileHeaders = {
      "Content-Type": "application/vnd.mapbox-vector-tile",
      "Cache-Control": "public, max-age=120",
    };
    const emptyTile = () => new NextResponse(new Uint8Array(0), { status: 200, headers: emptyTileHeaders });

    if (z < 9 || z > 16) {
      return emptyTile();
    }

    const filterContext = await resolveMapFilterContext(request);
    if (filterContext.active && filterContext.error) {
      return mapFilterHttpError(filterContext.error);
    }

    let bytes;
    const filterMeta = buildFilterResponseMeta(filterContext, { zoom: z, x, y, mode: "tile" });

    if (filterContext.filter?.compiled) {
      bytes = await getFilteredMapVectorTile(filterContext.filter.compiled, { z, x, y });
    } else {
      const { data, error } = await supabase.rpc("get_property_map_vector_tile", { z, x, y });
      if (error) throw error;
      bytes = decodeSupabaseBytea(data);
    }

    if (!bytes.length) {
      return emptyTile();
    }

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.mapbox-vector-tile",
        ...filteredCacheHeaders(filterMeta),
        ...(filterMeta ? { "X-Map-Filter-Token": filterMeta.filterToken } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map/tiles",
        error: "map_tile_failed",
        message: error?.message || "Unknown map tile error",
      },
      { status: 500 },
    );
  }
}