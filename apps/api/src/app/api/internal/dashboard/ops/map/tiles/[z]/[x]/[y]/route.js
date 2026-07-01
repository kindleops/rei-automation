import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { supabase } from "@/lib/supabase/client.js";
import { decodeSupabaseBytea } from "@/lib/domain/map/decode-bytea.js";

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

    if (z < 9 || z > 16) {
      return new NextResponse(null, { status: 204 });
    }

    const { data, error } = await supabase.rpc("get_property_map_vector_tile", { z, x, y });
    if (error) throw error;

    const bytes = decodeSupabaseBytea(data);

    if (!bytes.length) {
      return new NextResponse(new Uint8Array(0), {
        status: 204,
        headers: { "Content-Type": "application/vnd.mapbox-vector-tile" },
      });
    }

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.mapbox-vector-tile",
        "Cache-Control": "public, max-age=120",
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