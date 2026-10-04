/**
 * The card's imagery must not depend on hydration.
 *
 * Property-tile and lens features carry only `property_id` + lens metrics, no
 * latitude/longitude columns, so a card whose detail hydration failed or timed out
 * (RC 8.4 QA: anon 401 / permission denied on the browser reads) had no
 * coordinates at all, and Street View / satellite resolved to nothing. The click
 * geometry IS the property's mapped position (properties.latitude/longitude), so it
 * is seeded into the record when the record has no finite coordinates of its own.
 * Hydrated coordinates always win; nothing is invented.
 *
 * Memoised per feature object so the record identity is stable across renders.
 */
const seeded = new WeakMap<object, Record<string, unknown>>()

const finite = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return false
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n) > 0.001
}

export function withCardCoordinates<T extends Record<string, unknown>>(
  record: T,
  coordinates: readonly [number, number] | null | undefined,
): T {
  if (!record || !coordinates) return record
  const hasLat = finite(record.latitude) || finite(record.lat) || finite(record.property_lat)
  const hasLng = finite(record.longitude) || finite(record.lng) || finite(record.property_lng)
  if (hasLat && hasLng) return record
  const [lng, lat] = coordinates
  if (!finite(lat) || !finite(lng)) return record
  const cached = seeded.get(record)
  if (cached && cached.latitude === lat && cached.longitude === lng) return cached as T
  const next = { ...record, latitude: lat, longitude: lng }
  seeded.set(record, next)
  return next as T
}
