/**
 * Geometry helpers for the IC8 comp micro-market challenger: haversine
 * distance, a ~1 km square grid (H3 is not installed in production, so cells
 * are a plain lat/lng grid with a per-market longitude step), and a bucketed
 * point index for radius queries. Pure and deterministic.
 */

export const KM_PER_MILE = 1.609344;
const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_DEG_LAT = 111.32;

export function haversineKm(aLat, aLng, bLat, bLng) {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLng = (bLng - aLng) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function haversineMiles(aLat, aLng, bLat, bLng) {
  return haversineKm(aLat, aLng, bLat, bLng) / KM_PER_MILE;
}

/**
 * Square grid of `cellKm` cells. The longitude step is fixed from `refLat`
 * (the market's reference latitude), so cell ids are stable for a market.
 */
export function makeGrid({ refLat, cellKm = 1 }) {
  const dLat = cellKm / KM_PER_DEG_LAT;
  const dLng = cellKm / (KM_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180));
  const key = (ix, iy) => `${ix}:${iy}`;
  return Object.freeze({
    cellKm,
    refLat,
    dLat,
    dLng,
    key,
    cellOf(lat, lng) {
      const ix = Math.floor(lng / dLng);
      const iy = Math.floor(lat / dLat);
      return { ix, iy, key: key(ix, iy) };
    },
    parse(cellKey) {
      const [ix, iy] = cellKey.split(':').map(Number);
      return { ix, iy };
    },
    center(ix, iy) {
      return { lat: (iy + 0.5) * dLat, lng: (ix + 0.5) * dLng };
    },
  });
}

/** Chebyshev (king-move) distance between two cells. */
export function cellChebyshev(a, b) {
  return Math.max(Math.abs(a.ix - b.ix), Math.abs(a.iy - b.iy));
}

/**
 * Bucketed point index over records with { lat, lng }. Query returns
 * [{ item, km }] within a radius, sorted by distance then by `idOf(item)`.
 */
export class PointIndex {
  constructor(items, { refLat, bucketKm = 2, idOf = (item) => item.id } = {}) {
    this.grid = makeGrid({ refLat, cellKm: bucketKm });
    this.buckets = new Map();
    this.idOf = idOf;
    for (const item of items) {
      if (!Number.isFinite(item?.lat) || !Number.isFinite(item?.lng)) continue;
      const { key } = this.grid.cellOf(item.lat, item.lng);
      if (!this.buckets.has(key)) this.buckets.set(key, []);
      this.buckets.get(key).push(item);
    }
  }

  queryKm(lat, lng, radiusKm, filter = null) {
    const center = this.grid.cellOf(lat, lng);
    const span = Math.ceil(radiusKm / this.grid.cellKm) + 1;
    const out = [];
    for (let dx = -span; dx <= span; dx += 1) {
      for (let dy = -span; dy <= span; dy += 1) {
        const bucket = this.buckets.get(this.grid.key(center.ix + dx, center.iy + dy));
        if (!bucket) continue;
        for (const item of bucket) {
          if (filter && !filter(item)) continue;
          const km = haversineKm(lat, lng, item.lat, item.lng);
          if (km <= radiusKm) out.push({ item, km });
        }
      }
    }
    out.sort((a, b) => a.km - b.km || String(this.idOf(a.item)).localeCompare(String(this.idOf(b.item))));
    return out;
  }

  queryMiles(lat, lng, radiusMiles, filter = null) {
    return this.queryKm(lat, lng, radiusMiles * KM_PER_MILE, filter);
  }
}
