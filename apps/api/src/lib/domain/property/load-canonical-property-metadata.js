/**
 * Canonical property metadata for the live seller path.
 *
 * WHY THIS EXISTS (2026-09-10)
 * `evaluateUnderwritingSufficiency` and `resolveNegotiationPolicy` both branch
 * on asset class, which is computed from property_type + unit_count. On the
 * live inbound path both arrived NULL: the Supabase outbound-pair context
 * summary never carried them, and the older Podio-backed summary that would
 * have read them depends on a `property_item` that no longer exists. So every
 * multifamily seller was classified SFR and the entire multifamily branch was
 * unreachable in production.
 *
 * The data was there the whole time: on the live Miami campaign
 * `properties.units_count` is populated for 794 of 802 targets, and
 * `send_queue.property_id` is populated on every row, so `propertyId` is
 * already in hand when an inbound is processed.
 *
 * AUTHORITY: the property record is canonical for property_type and
 * units_count. Seller conversation may CONFIRM or DISPUTE it -- captured
 * separately as `reported_units_count` with seller_reported provenance -- but
 * never silently overwrites it here.
 */

function clean(value) {
  return String(value ?? "").trim();
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const PROPERTY_METADATA_SOURCE = "property_record";

/**
 * Read the canonical property row. Never throws: a metadata miss must degrade
 * to today's behaviour (unknown class), never fail an inbound.
 *
 * @returns {Promise<{property_type: string|null, units_count: number|null,
 *   property_metadata_source: string, property_metadata_found: boolean}>}
 */
export async function loadCanonicalPropertyMetadata(supabase, propertyId, options = {}) {
  const empty = {
    property_type: null,
    units_count: null,
    property_metadata_source: null,
    property_metadata_found: false,
  };

  const id = clean(propertyId);
  if (!supabase || !id) return empty;

  try {
    const { data, error } = await supabase
      .from("properties")
      .select("property_type, units_count")
      .eq("property_id", id)
      .maybeSingle();

    if (error || !data) return empty;

    const units = num(data.units_count);
    return {
      property_type: clean(data.property_type) || null,
      // 0 is not a credible unit count; treat it as unknown rather than as a
      // number that would classify the property.
      units_count: units !== null && units >= 1 ? units : null,
      property_metadata_source: PROPERTY_METADATA_SOURCE,
      property_metadata_found: true,
    };
  } catch (err) {
    if (typeof options.onError === "function") {
      try {
        options.onError(err);
      } catch {
        // observability must never break the turn
      }
    }
    return empty;
  }
}

export default loadCanonicalPropertyMetadata;
