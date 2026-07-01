import { NextResponse } from "next/server";

import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { supabase } from "@/lib/supabase/client.js";
import { normalizeMapAssetType } from "@/lib/domain/map/map-asset-type.js";
import { deriveMapMarkerState } from "@/lib/domain/map/map-marker-state.js";
import { resolveCanonicalMapMarkerKey, drainUnmappedPropertyTypes } from "@/lib/domain/map/canonical-map-marker-key.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

/** Zoom band → server fetch mode (not client pagination). */
function zoomToFetchMode(zoom) {
  if (zoom < 6) return "national";
  if (zoom < 9) return "metro";
  if (zoom < 13.5) return "city";
  return "street";
}

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

function toPropertyFeature(row, fetchMode) {
  const assetType = normalizeMapAssetType(row);
  const markerState = deriveMapMarkerState(row);
  const markerKey = resolveCanonicalMapMarkerKey(row, assetType);

  const baseProps = {
    property_id: row.property_id,
    assetType,
    marker_key: markerKey,
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
    fetchMode === "street"
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

function marketAggregateToFeature(row) {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [Number(row.centroid_lng), Number(row.centroid_lat)],
    },
    properties: {
      aggregate_type: "market",
      market: row.market,
      state: row.state_code,
      property_count: Number(row.property_count),
      point_count: Number(row.property_count),
      uncontacted_count: Number(row.uncontacted_count ?? 0),
      hot_count: Number(row.hot_count ?? 0),
      new_reply_count: Number(row.new_reply_count ?? 0),
      contacted_count: Number(row.contacted_count ?? 0),
    },
  };
}

function spatialClusterToFeature(row) {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [Number(row.centroid_lng), Number(row.centroid_lat)],
    },
    properties: {
      aggregate_type: "spatial",
      cluster_key: row.cluster_key,
      market: row.market,
      property_count: Number(row.property_count),
      point_count: Number(row.property_count),
      uncontacted_count: Number(row.uncontacted_count ?? 0),
      hot_count: Number(row.hot_count ?? 0),
      new_reply_count: Number(row.new_reply_count ?? 0),
    },
  };
}

function propertyLimitForMode(fetchMode, zoom) {
  if (fetchMode === "street") return 8000;
  if (fetchMode === "city") return zoom >= 11.5 ? 6000 : 4000;
  return 3000;
}

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
    const fetchMode = zoomToFetchMode(zoom);

    const marketsFilter = searchParams.get("markets") ?? "";
    const statesFilter = searchParams.get("states") ?? "";
    const markets = marketsFilter ? marketsFilter.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const states = statesFilter ? statesFilter.split(",").map((s) => s.trim()).filter(Boolean) : null;

    // ── SOURCE A: National market aggregates (zoom 0–5.99) ─────────────────
    if (fetchMode === "national") {
      const { data: rows, error } = await supabase.rpc("get_map_market_aggregates", {
        p_markets: markets,
        p_states: states,
      });
      if (error) throw error;

      const features = (rows ?? []).map(marketAggregateToFeature);
      const totalCanonical = features.reduce((sum, f) => sum + (f.properties.property_count || 0), 0);

      return NextResponse.json({
        ok: true,
        route: "internal/dashboard/ops/map",
        data: {
          generated_at: new Date().toISOString(),
          zoom,
          mode: "national",
          source: "canonical_market_aggregates",
          bounds: { lat_min, lat_max, lng_min, lng_max },
          features,
          counts: {
            returned: features.length,
            total_canonical: totalCanonical,
            clipped: false,
            pagination_boundary: null,
          },
        },
      });
    }

    // ── SOURCE A: Metro spatial clusters (zoom 6–8.99) ─────────────────────
    if (fetchMode === "metro") {
      if (lat_min === null || lat_max === null || lng_min === null || lng_max === null) {
        return NextResponse.json({ ok: false, error: "missing_bounds_for_metro" }, { status: 400 });
      }

      const gridDegrees = zoom < 7 ? 0.6 : zoom < 8 ? 0.35 : 0.2;
      const [{ data: clusters, error: clusterError }, { data: exactCount, error: countError }] = await Promise.all([
        supabase.rpc("get_map_spatial_clusters", {
          p_lat_min: lat_min,
          p_lat_max: lat_max,
          p_lng_min: lng_min,
          p_lng_max: lng_max,
          p_grid_degrees: gridDegrees,
        }),
        supabase.rpc("get_map_bounds_property_count", {
          p_lat_min: lat_min,
          p_lat_max: lat_max,
          p_lng_min: lng_min,
          p_lng_max: lng_max,
          p_markets: markets,
          p_states: states,
        }),
      ]);
      if (clusterError) throw clusterError;
      if (countError) throw countError;

      const features = (clusters ?? []).map(spatialClusterToFeature);
      const clusterSum = features.reduce((sum, f) => sum + (f.properties.property_count || 0), 0);

      return NextResponse.json({
        ok: true,
        route: "internal/dashboard/ops/map",
        data: {
          generated_at: new Date().toISOString(),
          zoom,
          mode: "metro",
          source: "canonical_spatial_clusters",
          bounds: { lat_min, lat_max, lng_min, lng_max },
          features,
          counts: {
            returned: features.length,
            total_in_bounds: Number(exactCount ?? 0),
            cluster_sum: clusterSum,
            clipped: false,
            pagination_boundary: null,
          },
        },
      });
    }

    // ── SOURCE B: Property-level (zoom 9+) — tile-backed; GeoJSON sample optional ─
    if (lat_min === null || lat_max === null || lng_min === null || lng_max === null) {
      return NextResponse.json({ ok: false, error: "missing_bounds_for_properties" }, { status: 400 });
    }

    const countsOnly = searchParams.get("counts_only") === "true";
    const maxLimit = propertyLimitForMode(fetchMode, zoom);
    const limit = asLimit(searchParams.get("limit"), maxLimit, maxLimit);

    if (countsOnly) {
      const [{ data: exactCount, error: countError }, { data: marketRows, error: marketError }] = await Promise.all([
        supabase.rpc("get_map_bounds_property_count", {
          p_lat_min: lat_min,
          p_lat_max: lat_max,
          p_lng_min: lng_min,
          p_lng_max: lng_max,
          p_markets: markets,
          p_states: states,
        }),
        supabase.rpc("get_map_market_aggregates", {
          p_markets: markets,
          p_states: states,
        }),
      ]);
      if (countError) throw countError;
      if (marketError) throw marketError;
      const totalCanonical = (marketRows ?? []).reduce((sum, row) => sum + Number(row.property_count || 0), 0);

      return NextResponse.json({
        ok: true,
        route: "internal/dashboard/ops/map",
        data: {
          generated_at: new Date().toISOString(),
          zoom,
          mode: fetchMode,
          source: "canonical_property_tiles",
          bounds: { lat_min, lat_max, lng_min, lng_max },
          features: [],
          counts: {
            returned: 0,
            total_canonical: totalCanonical,
            total_in_bounds: Number(exactCount ?? 0),
            clipped: false,
            pagination_boundary: null,
            tile_backed: true,
          },
        },
      });
    }

    const selectFields =
      fetchMode === "street"
        ? `${CLUSTER_FIELDS},${MARKER_EXTRA_FIELDS}`
        : CLUSTER_FIELDS;

    const [{ data: exactCount, error: countError }, queryResult] = await Promise.all([
      supabase.rpc("get_map_bounds_property_count", {
        p_lat_min: lat_min,
        p_lat_max: lat_max,
        p_lng_min: lng_min,
        p_lng_max: lng_max,
        p_markets: markets,
        p_states: states,
      }),
      (() => {
        let query = supabase
          .from("properties")
          .select(selectFields)
          .not("latitude", "is", null)
          .not("longitude", "is", null)
          .gte("latitude", lat_min)
          .lte("latitude", lat_max)
          .gte("longitude", lng_min)
          .lte("longitude", lng_max)
          .order("final_acquisition_score", { ascending: false, nullsFirst: false })
          .limit(limit);
        if (markets?.length) query = query.in("market", markets);
        if (states?.length) query = query.in("property_address_state", states);
        return query;
      })(),
    ]);

    if (countError) throw countError;
    const { data: rows, error } = queryResult;
    if (error) throw error;

    const features = (rows ?? []).map((row) => toPropertyFeature(row, fetchMode));
    const unmappedTypes = drainUnmappedPropertyTypes();

    const byAssetType = {};
    const byMarkerKey = {};
    const byMarkerState = {};
    for (const f of features) {
      const { assetType, marker_key: markerKey, markerState } = f.properties;
      byAssetType[assetType] = (byAssetType[assetType] ?? 0) + 1;
      byMarkerKey[markerKey] = (byMarkerKey[markerKey] ?? 0) + 1;
      byMarkerState[markerState] = (byMarkerState[markerState] ?? 0) + 1;
    }

    return NextResponse.json({
      ok: true,
      route: "internal/dashboard/ops/map",
      data: {
        generated_at: new Date().toISOString(),
        zoom,
        mode: fetchMode,
        source: "canonical_properties_table",
        bounds: { lat_min, lat_max, lng_min, lng_max },
        features,
        counts: {
          returned: features.length,
          total_in_bounds: Number(exactCount ?? 0),
          clipped: features.length >= limit && Number(exactCount ?? 0) > features.length,
          pagination_boundary: `properties.limit=${limit} (previous bug: hard cap 500 markers / 3000 clusters)`,
          by_asset_type: byAssetType,
          by_marker_key: byMarkerKey,
          by_marker_state: byMarkerState,
          unmapped_property_types: unmappedTypes,
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