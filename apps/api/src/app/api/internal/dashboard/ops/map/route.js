import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { supabase } from "@/lib/supabase/client.js";
import { normalizeMapAssetType } from "@/lib/domain/map/map-asset-type.js";
import { deriveMapMarkerState } from "@/lib/domain/map/map-marker-state.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function zoomToMode(zoom) {
  if (zoom >= 13) return "markers";
  return "clusters";
}

// Fields needed to compute asset type + marker state classifications.
// Kept lean for cluster mode to reduce payload.
const CLUSTER_FIELDS = [
  "property_id",
  "latitude",
  "longitude",
  "market",
  "property_address_city",
  "property_address_state",
  "property_address_zip",
  "property_type",
  "units_count",
  "multifamily_units",
  "commercial_units",
  "storage_units",
  "strip_center_units",
  "asset_class",
  "normalized_asset_class",
  "asset_type",
  "property_group",
  "property_subtype",
  "asset_subclass",
  "normalized_asset_subclass",
  "deal_list_label",
  "deal_list_type",
  "deal_list_normalized",
  "source_list_label",
  "source_list_type",
  "list_label",
  "list_type",
  "commercial_category",
  "commercial_subcategory",
  "property_use",
  "land_use",
  "building_class",
  "contact_status",
  "activity_status",
  "final_acquisition_score",
  "structured_motivation_score",
  "deal_strength_score",
  "mls_sold_price",
  "mls_sold_date",
].join(",");

// Extra fields added only for high-zoom individual marker mode.
const MARKER_EXTRA_FIELDS = [
  "property_address_full",
  "owner_name",
  "owner_display_name",
  "owner_type",
  "estimated_value",
  "equity_amount",
  "equity_percent",
  "sale_price",
  "saleprice",
  "mls_sold_price",
  "mls_sold_date",
  "market_status_label",
  "mls_market_status",
  "building_square_feet",
  "total_bedrooms",
  "total_baths",
  "year_built",
  "lot_acreage",
  "cash_offer",
  "estimated_repair_cost",
  "sms_eligible",
  "streetview_image",
  "satellite_image",
  "seller_tags_json",
  "property_flags_json",
  "is_corporate_owner",
  "out_of_state_owner",
  "highlighted",
].join(",");

// ─── GeoJSON feature builder ──────────────────────────────────────────────────

function toFeature(row, mode) {
  const assetType = normalizeMapAssetType(row);
  const markerState = deriveMapMarkerState(row);

  const baseProps = {
    property_id: row.property_id,
    assetType,
    markerState,
    acquisitionScore: Number(row.final_acquisition_score) || 0,
    motivationScore: Number(row.structured_motivation_score) || 0,
    market: row.market ?? null,
    city: row.property_address_city ?? null,
    state: row.property_address_state ?? null,
    zip: row.property_address_zip ?? null,
    propertyType: row.property_type ?? null,
    units: Math.max(Number(row.units_count) || 0, Number(row.multifamily_units) || 0),
    contactStatus: row.contact_status ?? null,
    activityStatus: row.activity_status ?? null,
  };

  const markerProps =
    mode === "markers"
      ? {
          address: row.property_address_full ?? null,
          ownerName: row.owner_name ?? row.owner_display_name ?? null,
          ownerType: row.owner_type ?? null,
          estimatedValue: Number(row.estimated_value) || null,
          equityAmount: Number(row.equity_amount) || null,
          equityPercent: Number(row.equity_percent) || null,
          salePrice: Number(row.sale_price ?? row.saleprice) || null,
          mlsSoldPrice: Number(row.mls_sold_price) || null,
          mlsSoldDate: row.mls_sold_date ?? null,
          marketStatusLabel: row.market_status_label ?? null,
          mlsMarketStatus: row.mls_market_status ?? null,
          buildingSqft: Number(row.building_square_feet) || null,
          bedrooms: Number(row.total_bedrooms) || null,
          baths: Number(row.total_baths) || null,
          yearBuilt: Number(row.year_built) || null,
          lotAcres: Number(row.lot_acreage) || null,
          cashOffer: Number(row.cash_offer) || null,
          repairCost: Number(row.estimated_repair_cost) || null,
          smsEligible: row.sms_eligible ?? null,
          streetviewImage: row.streetview_image ?? null,
          satelliteImage: row.satellite_image ?? null,
          sellerTags: row.seller_tags_json ?? null,
          propertyFlags: row.property_flags_json ?? null,
          isCorporateOwner: row.is_corporate_owner ?? null,
          outOfStateOwner: row.out_of_state_owner ?? null,
          highlighted: row.highlighted ?? null,
        }
      : {};

  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [Number(row.longitude), Number(row.latitude)],
    },
    properties: { ...baseProps, ...markerProps },
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request) {
  try {
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        {
          ok: false,
          error: "system_control_disabled",
          flag_key: "dashboard_live_enabled",
          context: "dashboard-map-route",
        },
        { status: 423 }
      );
    }

    const { searchParams } = new URL(request.url);

    const lat_min = asNumber(searchParams.get("lat_min"), null);
    const lat_max = asNumber(searchParams.get("lat_max"), null);
    const lng_min = asNumber(searchParams.get("lng_min"), null);
    const lng_max = asNumber(searchParams.get("lng_max"), null);
    const zoom = asNumber(searchParams.get("zoom"), 8);
    const mode = zoomToMode(zoom);

    // Zoom-aware limits: tight at low zoom to avoid huge payloads,
    // larger at mid zoom for client-side clustering, capped at street level.
    const defaultLimit = mode === "markers" ? 500 : zoom >= 9 ? 2500 : 1500;
    const maxLimit = mode === "markers" ? 500 : 3000;
    const limit = asLimit(searchParams.get("limit"), defaultLimit, maxLimit);

    // Optional layer/filter params
    const marketsFilter = searchParams.get("markets") ?? "";
    const statesFilter = searchParams.get("states") ?? "";

    const selectFields =
      mode === "markers"
        ? `${CLUSTER_FIELDS},${MARKER_EXTRA_FIELDS}`
        : CLUSTER_FIELDS;

    let query = supabase
      .from("properties")
      .select(selectFields)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      // Prioritize highest-value properties when the limit clips results.
      .order("final_acquisition_score", { ascending: false, nullsFirst: false })
      .limit(limit);

    // Bounding box — only apply if all four coords are present
    if (lat_min !== null) query = query.gte("latitude", lat_min);
    if (lat_max !== null) query = query.lte("latitude", lat_max);
    if (lng_min !== null) query = query.gte("longitude", lng_min);
    if (lng_max !== null) query = query.lte("longitude", lng_max);

    // Optional market/state filters
    if (marketsFilter) {
      const markets = marketsFilter.split(",").map((s) => s.trim()).filter(Boolean);
      if (markets.length) query = query.in("market", markets);
    }
    if (statesFilter) {
      const states = statesFilter.split(",").map((s) => s.trim()).filter(Boolean);
      if (states.length) query = query.in("property_address_state", states);
    }

    const { data: rows, error } = await query;
    if (error) throw error;

    const features = (rows ?? []).map((row) => toFeature(row, mode));

    // Aggregate counts from returned features
    const byAssetType = {};
    const byState = {};
    const byMarkerState = {};
    for (const f of features) {
      const { assetType, markerState, state } = f.properties;
      byAssetType[assetType] = (byAssetType[assetType] ?? 0) + 1;
      byMarkerState[markerState] = (byMarkerState[markerState] ?? 0) + 1;
      if (state) byState[state] = (byState[state] ?? 0) + 1;
    }

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map",
      data: {
        generated_at: new Date().toISOString(),
        zoom,
        mode,
        bounds: { lat_min, lat_max, lng_min, lng_max },
        features,
        counts: {
          returned: features.length,
          clipped: features.length >= limit,
          by_asset_type: byAssetType,
          by_marker_state: byMarkerState,
          by_state: byState,
        },
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "internal/dashboard/ops/map",
        error: "ops_dashboard_map_failed",
        message: error?.message || "Unknown dashboard map error",
      },
      { status: 500 }
    );
  }
}
