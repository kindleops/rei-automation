export function isValidCoord(lat: number | null | undefined, lng: number | null | undefined): boolean {
  if (lat == null || lng == null) return false
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return false
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

export function makeRadiusGeoJson(center: [number, number], radiusMiles: number) {
  const coords: [number, number][] = []
  for (let i = 0; i < 64; i += 1) {
    const angle = (i / 64) * 2 * Math.PI
    coords.push([
      center[0] + (radiusMiles / (69 * Math.cos((center[1] * Math.PI) / 180))) * Math.sin(angle),
      center[1] + (radiusMiles / 69) * Math.cos(angle),
    ])
  }
  coords.push(coords[0])
  return {
    type: 'Feature' as const,
    geometry: { type: 'Polygon' as const, coordinates: [coords] },
    properties: {},
  }
}

export function fmtCurrency(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

export function fmtK(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return 'SOLD'
  return `$${Math.round(n / 1000)}k`
}