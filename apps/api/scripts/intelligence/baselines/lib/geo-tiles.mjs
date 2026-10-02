/**
 * IC8 baselines: pure geometry for tiling the comps evidence RPC around the
 * first-touch properties (no I/O).
 *
 * comps_market_evidence(lat, lng, radius) returns the nearest <= 400 rows in a
 * circle plus total_in_radius. A square tile is read through its
 * circumscribed circle; a tile is complete when total_in_radius <= returned,
 * otherwise it is split into four. Rows are kept only inside their own tile
 * (half-open box), so overlapping circles never double count.
 */

export const MILES_PER_DEG_LAT = 68.5;

export function milesPerDegLng(lat) {
  return MILES_PER_DEG_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.05);
}

export function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

export function tileKey(t) {
  return `${round6(t.lat0)}:${round6(t.lng0)}:${round6(t.size)}`;
}

/** Circle (center, radius in miles, +2% margin) circumscribing a tile. */
export function tileCircle(t) {
  const lat = t.lat0 + t.size / 2;
  const lng = t.lng0 + t.size / 2;
  const halfLat = (t.size / 2) * MILES_PER_DEG_LAT;
  const halfLng = (t.size / 2) * milesPerDegLng(lat + (lat >= 0 ? t.size / 2 : -t.size / 2));
  return { lat, lng, radius: Math.sqrt(halfLat ** 2 + halfLng ** 2) * 1.02 };
}

export function inTile(t, lat, lng) {
  return lat >= t.lat0 && lat < t.lat0 + t.size && lng >= t.lng0 && lng < t.lng0 + t.size;
}

export function splitTile(t) {
  const h = t.size / 2;
  return [
    { lat0: t.lat0, lng0: t.lng0, size: h },
    { lat0: t.lat0 + h, lng0: t.lng0, size: h },
    { lat0: t.lat0, lng0: t.lng0 + h, size: h },
    { lat0: t.lat0 + h, lng0: t.lng0 + h, size: h },
  ];
}

/** Does a tile intersect the buffer box (bufferMiles) of any point? `index` from pointIndex(). */
export function tileNearPoints(t, index, bufferMiles) {
  const lat0 = t.lat0 - bufferMiles / MILES_PER_DEG_LAT;
  const lat1 = t.lat0 + t.size + bufferMiles / MILES_PER_DEG_LAT;
  const lngPad = bufferMiles / milesPerDegLng(t.lat0 + t.size / 2);
  const lng0 = t.lng0 - lngPad;
  const lng1 = t.lng0 + t.size + lngPad;
  for (const p of index.query(lat0, lat1, lng0, lng1)) {
    if (p.lat >= lat0 && p.lat < lat1 && p.lng >= lng0 && p.lng < lng1) return true;
  }
  return false;
}

/** Bucket index of points on a degree grid for range queries. */
export function pointIndex(points, cellDeg = 0.05) {
  const buckets = new Map();
  const key = (a, b) => `${a}:${b}`;
  for (const p of points) {
    const k = key(Math.floor(p.lat / cellDeg), Math.floor(p.lng / cellDeg));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  return {
    query(lat0, lat1, lng0, lng1) {
      const out = [];
      for (let a = Math.floor(lat0 / cellDeg); a <= Math.floor(lat1 / cellDeg); a += 1) {
        for (let b = Math.floor(lng0 / cellDeg); b <= Math.floor(lng1 / cellDeg); b += 1) {
          const list = buckets.get(key(a, b));
          if (list) out.push(...list);
        }
      }
      return out;
    },
  };
}

/** Coarse root tiles (aligned to a size grid) that intersect any point's buffer. */
export function rootTiles(points, { size = 0.12, bufferMiles = 2.5 } = {}) {
  const index = pointIndex(points);
  const keys = new Set();
  const out = [];
  for (const p of points) {
    const latPad = bufferMiles / MILES_PER_DEG_LAT;
    const lngPad = bufferMiles / milesPerDegLng(p.lat);
    for (let a = Math.floor((p.lat - latPad) / size); a <= Math.floor((p.lat + latPad) / size); a += 1) {
      for (let b = Math.floor((p.lng - lngPad) / size); b <= Math.floor((p.lng + lngPad) / size); b += 1) {
        const t = { lat0: round6(a * size), lng0: round6(b * size), size };
        const k = tileKey(t);
        if (keys.has(k) || !tileNearPoints(t, index, bufferMiles)) continue;
        keys.add(k);
        out.push(t);
      }
    }
  }
  return { tiles: out.sort((x, y) => x.lat0 - y.lat0 || x.lng0 - y.lng0), index };
}
