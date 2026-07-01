/** WebMercator tile indices for a lng/lat bounds box at integer zoom. */

export function getCoveringTileCoords(bounds, zoom) {
  const z = Math.max(0, Math.min(22, Math.floor(Number(zoom))))
  const n = 2 ** z
  const lonToTile = (lng) => Math.floor(((Number(lng) + 180) / 360) * n)
  const latToTile = (lat) => {
    const rad = (Number(lat) * Math.PI) / 180
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
  }
  const xMin = Math.max(0, lonToTile(bounds.lng_min))
  const xMax = Math.min(n - 1, lonToTile(bounds.lng_max))
  const yMin = Math.max(0, latToTile(bounds.lat_max))
  const yMax = Math.min(n - 1, latToTile(bounds.lat_min))
  const tiles = []
  for (let x = xMin; x <= xMax; x += 1) {
    for (let y = yMin; y <= yMax; y += 1) {
      tiles.push({ z, x, y })
    }
  }
  return tiles
}

export function isPointInBounds(lng, lat, bounds, epsilon = 1e-9) {
  return (
    Number(lng) >= Number(bounds.lng_min) - epsilon
    && Number(lng) <= Number(bounds.lng_max) + epsilon
    && Number(lat) >= Number(bounds.lat_min) - epsilon
    && Number(lat) <= Number(bounds.lat_max) + epsilon
  )
}