/**
 * Canonical coordinate resolver — single precedence chain for Comp Intelligence,
 * Buyer Match, Map, and Acquisition Decision Engine.
 *
 * Does NOT mutate production coordinates.
 */

function clean(value) {
  return String(value ?? '').trim();
}

export function parseCoordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) < 0.0001) return null;
  return n;
}

export function isPlausibleLatLng(lat, lng) {
  if (lat === null || lng === null) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return true;
}

function detectReversed(lat, lng) {
  if (lat === null || lng === null) return { lat, lng, reversed: false };
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
    return { lat: lng, lng: lat, reversed: true };
  }
  return { lat, lng, reversed: false };
}

function pickFromObject(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = parseCoordinate(obj[key]);
    if (value !== null) return value;
  }
  return null;
}

function extractRawPayloadCoords(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return { lat: null, lng: null };
  const lat = pickFromObject(rawPayload, [
    'latitude',
    'lat',
    'parcel_latitude',
    'parcel_lat',
    'situs_latitude',
    'geo_latitude',
    'y',
  ]);
  const lng = pickFromObject(rawPayload, [
    'longitude',
    'lng',
    'lon',
    'long',
    'parcel_longitude',
    'parcel_lng',
    'situs_longitude',
    'geo_longitude',
    'x',
  ]);
  return { lat, lng };
}

const COORDINATE_PRECEDENCE = [
  {
    id: 'subject_property',
    confidence: 95,
    pick(sources) {
      const lat = parseCoordinate(sources.property?.latitude ?? sources.property?.lat);
      const lng = parseCoordinate(sources.property?.longitude ?? sources.property?.lng);
      return { lat, lng };
    },
  },
  {
    id: 'parcel_centroid',
    confidence: 88,
    pick(sources) {
      const lat = parseCoordinate(
        sources.property?.parcel_centroid_lat ??
          sources.property?.centroid_lat ??
          sources.parcel?.centroid_lat,
      );
      const lng = parseCoordinate(
        sources.property?.parcel_centroid_lng ??
          sources.property?.centroid_lng ??
          sources.parcel?.centroid_lng,
      );
      return { lat, lng };
    },
  },
  {
    id: 'enriched_property',
    confidence: 82,
    pick(sources) {
      const lat = parseCoordinate(
        sources.hydrated?.latitude ??
          sources.hydrated?.lat ??
          sources.enriched?.latitude ??
          sources.enriched?.lat,
      );
      const lng = parseCoordinate(
        sources.hydrated?.longitude ??
          sources.hydrated?.lng ??
          sources.enriched?.longitude ??
          sources.enriched?.lng,
      );
      return { lat, lng };
    },
  },
  {
    id: 'raw_payload',
    confidence: 75,
    pick(sources) {
      const raw =
        sources.property?.raw_payload_json ??
        sources.property?.raw_payload ??
        sources.hydrated?.raw_payload_json;
      return extractRawPayloadCoords(raw);
    },
  },
  {
    id: 'geocoded_address',
    confidence: 68,
    pick(sources) {
      const lat = parseCoordinate(sources.geocode?.latitude ?? sources.geocode?.lat);
      const lng = parseCoordinate(sources.geocode?.longitude ?? sources.geocode?.lng);
      return { lat, lng };
    },
  },
];

export function resolveCanonicalCoordinates(sources = {}, options = {}) {
  const resolvedAt = options.resolvedAt ?? new Date().toISOString();
  const attempts = [];

  for (const step of COORDINATE_PRECEDENCE) {
    const { lat: rawLat, lng: rawLng } = step.pick(sources);
    const { lat, lng, reversed } = detectReversed(rawLat, rawLng);
    attempts.push({
      source: step.id,
      lat,
      lng,
      reversed,
      valid: isPlausibleLatLng(lat, lng),
    });
    if (isPlausibleLatLng(lat, lng)) {
      return {
        latitude: lat,
        longitude: lng,
        lat,
        lng,
        coordinate_source: step.id,
        coordinate_confidence: reversed ? Math.max(40, step.confidence - 15) : step.confidence,
        coordinate_reversed: reversed,
        is_market_fallback: false,
        is_subject_resolved: true,
        resolved_at: resolvedAt,
        failure_reason: null,
        attempts,
      };
    }
  }

  const zip = clean(
    sources.property?.property_address_zip ??
      sources.property?.property_zip ??
      sources.hydrated?.property_address_zip ??
      sources.hydrated?.zip,
  );
  const market = clean(sources.property?.market ?? sources.hydrated?.market);

  return {
    latitude: null,
    longitude: null,
    lat: null,
    lng: null,
    coordinate_source: zip || market ? 'market_search_only' : 'unresolved',
    coordinate_confidence: zip || market ? 18 : 0,
    coordinate_reversed: false,
    is_market_fallback: Boolean(zip || market),
    is_subject_resolved: false,
    resolved_at: resolvedAt,
    failure_reason: zip || market
      ? 'Exact parcel coordinates unavailable; market-level search only'
      : 'No coordinates found in property, parcel, enriched, raw payload, or geocode sources',
    market_search_zip: zip || null,
    market_search_market: market || null,
    attempts,
  };
}

export default {
  parseCoordinate,
  isPlausibleLatLng,
  resolveCanonicalCoordinates,
};