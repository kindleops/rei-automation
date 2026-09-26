/**
 * Failed property tiles come back.
 *
 * MapLibre never re-requests a tile that errored: one 500 (the tile RPC hitting
 * a statement timeout while the database is busy) left a permanent hole of
 * missing properties until a full reload — "zooming in doesn't show all
 * properties". Each failed tile is retried with backoff (1.5s → 4s → 9s → 20s),
 * and the budget resets once it loads.
 */
import type maplibregl from 'maplibre-gl'

const DELAYS = [1500, 4000, 9000, 20000]

export function installTileRetry(map: maplibregl.Map, sourceIds: ReadonlyArray<string>): () => void {
  const attempts = new Map<string, number>()
  const timers = new Set<number>()
  const onError = (e: { sourceId?: string; tile?: { tileID?: { canonical?: { x: number; y: number; z: number } } } }) => {
    if (!e?.sourceId || !sourceIds.includes(e.sourceId)) return
    const c = e.tile?.tileID?.canonical
    if (!c) return
    const key = `${e.sourceId}/${c.z}/${c.x}/${c.y}`
    const n = attempts.get(key) ?? 0
    if (n >= DELAYS.length) return
    attempts.set(key, n + 1)
    const t = window.setTimeout(() => {
      timers.delete(t)
      try {
        if (!map.style || !map.getSource(e.sourceId!)) return
        // Only if the tile is still wanted at this zoom.
        if (Math.abs(Math.floor(map.getZoom()) - c.z) > 2) return
        map.refreshTiles(e.sourceId!, [{ x: c.x, y: c.y, z: c.z }])
      } catch { /* map replaced */ }
    }, DELAYS[n])
    timers.add(t)
  }
  const onData = (e: { sourceId?: string; tile?: { tileID?: { canonical?: { x: number; y: number; z: number } } }; isSourceLoaded?: boolean }) => {
    const c = e?.tile?.tileID?.canonical
    if (!c || !e.sourceId || !sourceIds.includes(e.sourceId)) return
    attempts.delete(`${e.sourceId}/${c.z}/${c.x}/${c.y}`)
  }
  map.on('error', onError as never)
  map.on('sourcedata', onData as never)
  return () => {
    map.off('error', onError as never)
    map.off('sourcedata', onData as never)
    for (const t of timers) window.clearTimeout(t)
  }
}
