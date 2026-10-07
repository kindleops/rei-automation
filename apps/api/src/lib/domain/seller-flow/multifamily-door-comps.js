// ─── multifamily-door-comps.js ───────────────────────────────────────────────
// SELLER CONVERSATION v3 (flag SELLER_CONVERSATION_V3): the real multifamily
// sales the per-door anchor is computed from (seller-conversation-v3.js
// computePerDoorAnchor). READ-ONLY: one subject lookup + one bounded comp query
// on v_recent_sold_comps (the investor buyer-comp pool Deal Intelligence uses),
// units >= 2, within the MF radius (a wider radius than SFR is OK — owner).
// Called only for a multifamily property whose checklist is complete.

const EARTH_MILES = 3958.8;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @returns {Promise<{ ok: boolean, reason?: string, comps: Array }>}
 *   comps carry distance_miles, units_count, sale_price, sale_date, sale_source.
 */
export async function loadMultifamilyDoorComps({
  supabase = null,
  propertyId = null,
  radiusMiles = 3,
  maxAgeMonths = 18,
  limit = 400,
  now = Date.now(),
} = {}) {
  if (!supabase || !propertyId) return { ok: false, reason: "missing_inputs", comps: [] };
  const { data: subject, error: subjectError } = await supabase
    .from("properties")
    .select("property_id,latitude,longitude,units_count")
    .eq("property_id", propertyId)
    .maybeSingle();
  if (subjectError) return { ok: false, reason: "subject_lookup_failed", comps: [] };
  const lat = num(subject?.latitude);
  const lng = num(subject?.longitude);
  if (lat == null || lng == null) return { ok: false, reason: "subject_coordinates_missing", comps: [] };
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const since = new Date((typeof now === "number" ? now : Date.parse(now)) - maxAgeMonths * 30.44 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("v_recent_sold_comps")
    .select("id,property_id,sale_price,sale_date,sale_source,units_count,latitude,longitude,normalized_asset_class")
    .gte("units_count", 2)
    .gte("latitude", lat - dLat)
    .lte("latitude", lat + dLat)
    .gte("longitude", lng - dLng)
    .lte("longitude", lng + dLng)
    .gte("sale_date", since)
    .limit(limit);
  if (error) return { ok: false, reason: "comp_query_failed", comps: [] };
  const comps = (Array.isArray(data) ? data : [])
    .filter((c) => String(c.property_id ?? "") !== String(propertyId))
    .map((c) => ({
      ...c,
      distance_miles: Math.round(haversineMiles(lat, lng, num(c.latitude), num(c.longitude)) * 100) / 100,
    }))
    .filter((c) => Number.isFinite(c.distance_miles) && c.distance_miles <= radiusMiles);
  return { ok: true, comps, subject_units: num(subject?.units_count) };
}

export default loadMultifamilyDoorComps;
