/** COMMAND WALL — viewport snapping for cached context layers (0.1° grid, 0.5 zoom steps). */
export const VIEWPORT_STEP = 0.1

export function snapViewport(bboxRaw, zoomRaw) {
  const b = String(bboxRaw || '').split(',').map(Number)
  const z = Number(zoomRaw)
  if (b.length !== 4 || b.some((v) => !Number.isFinite(v)) || !Number.isFinite(z)) return null
  const [w, s, e, n] = b
  if (!(w < e && s < n)) return null
  const snapped = [Math.floor(w / VIEWPORT_STEP) * VIEWPORT_STEP, Math.floor(s / VIEWPORT_STEP) * VIEWPORT_STEP, Math.ceil(e / VIEWPORT_STEP) * VIEWPORT_STEP, Math.ceil(n / VIEWPORT_STEP) * VIEWPORT_STEP].map((v) => Math.round(v * 10) / 10)
  return { bbox: snapped.join(','), zoom: Math.round(Math.min(16, Math.max(2, z)) * 2) / 2 }
}

