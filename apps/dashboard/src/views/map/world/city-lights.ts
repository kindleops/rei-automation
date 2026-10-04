/**
 * CITY LIGHTS — real night-time lights, only where it is actually night.
 *
 * Source: NASA Black Marble 2016 (VIIRS Day/Night Band, cloud-free annual
 * composite), served by NASA GIBS as public WMTS tiles:
 *   https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png
 * Verified 2026-10-03: HTTP 200 image/png 256×256, `access-control-allow-origin: *`,
 * tile matrix GoogleMapsCompatible_Level8 (zoom 0–8; z9 → 400). NASA imagery
 * is public domain / no use restrictions; GIBS asks for an acknowledgement,
 * carried on the source and in the legend.
 *
 * Masking without a GPU mask: each tile passes through the `nxlights://`
 * protocol, which keeps the lights (luminance → alpha, the dark land under
 * them dropped) and multiplies them by a per-pixel night factor from the same
 * NOAA ephemeris as the night polygons: 0 while the sun is above −4°, fading
 * in through civil/nautical twilight, full from −14°. The day side therefore
 * carries nothing at all. Every pixel's longitude comes from its own tile
 * column, so there is no antimeridian seam to get wrong.
 *
 * GIBS sends `no-store`, so decoded lights are kept in a small in-memory LRU:
 * a re-mask for a new sun instant costs only arithmetic, never a refetch.
 */
import maplibregl from 'maplibre-gl'
import { solarEphemeris } from './solar'

export const LIGHTS_PROTOCOL = 'nxlights'
export const LIGHTS_MAXZOOM = 8
export const LIGHTS_ATTRIBUTION = 'City lights: NASA Black Marble 2016 (VIIRS) via NASA GIBS'
/** The sun instant for the lights is quantised: the mask is re-drawn every 2 minutes (0.5° of sun). */
export const LIGHTS_BUCKET_MS = 2 * 60_000
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8'
const SIZE = 256
const RAD = Math.PI / 180

/** Night factor thresholds (solar altitude, degrees). */
export const LIGHTS_ON_ALT = -4
export const LIGHTS_FULL_ALT = -14

/**
 * [8.5] The NIGHT BASE: Black Marble itself (land, sea and lights) as the
 * night side's imagery under the satellite look — fades in from just after
 * sunset and is full by nautical dusk, so twilight blends day photo → night
 * photo instead of tinting the day photo.
 */
export const BASE_ON_ALT = -1
export const BASE_FULL_ALT = -11

export type LightsKind = 'lights' | 'base'
export const lightsTileUrl = (bucketMs: number, kind: LightsKind = 'lights') => `${LIGHTS_PROTOCOL}://{z}/{x}/{y}?t=${bucketMs}&k=${kind}`
export const lightsBucket = (ms: number) => Math.floor(ms / LIGHTS_BUCKET_MS) * LIGHTS_BUCKET_MS

/**
 * Per-pixel night factor (0 day … 1 night) for one web-mercator tile at an
 * instant. sin(alt) = sinφ·sinδ + cosφ·cosδ·cosH separates into a row term
 * and a column term, so a tile is one multiply-add per pixel.
 */
export function nightFactorTile(z: number, x: number, y: number, at: Date, size = SIZE, onAlt = LIGHTS_ON_ALT, fullAlt = LIGHTS_FULL_ALT): Float32Array {
  const { declination, eqTimeMin } = solarEphemeris(at)
  const dec = declination * RAD
  const sd = Math.sin(dec), cd = Math.cos(dec)
  const utcMin = (((at.valueOf() % 86400000) + 86400000) % 86400000) / 60000
  const n = 2 ** z
  const cosH = new Float32Array(size)
  for (let px = 0; px < size; px++) {
    const lng = ((x + (px + 0.5) / size) / n) * 360 - 180
    cosH[px] = Math.cos(((utcMin + eqTimeMin + 4 * lng) / 4 - 180) * RAD)
  }
  const lo = Math.sin(onAlt * RAD), hi = Math.sin(fullAlt * RAD)
  const out = new Float32Array(size * size)
  for (let py = 0; py < size; py++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (py + 0.5) / size)) / n)))
    const a = Math.sin(lat) * sd, b = Math.cos(lat) * cd
    const row = py * size
    for (let px = 0; px < size; px++) {
      const s = a + b * cosH[px]
      const t = Math.min(1, Math.max(0, (lo - s) / (lo - hi)))
      out[row + px] = t * t * (3 - 2 * t)
    }
  }
  return out
}

/**
 * Black Marble RGB → lights only. Land and sea under the lights are a dim
 * blue in the composite; they are dropped by a luminance ramp weighted to the
 * warm channels, and what remains is drawn sodium-warm → white at the cores.
 * Returns premultiplication-free RGBA with alpha = light strength (0–255).
 */
export function extractLights(rgba: Uint8ClampedArray): { data: Uint8ClampedArray; lit: boolean } {
  const out = new Uint8ClampedArray(rgba.length)
  let lit = false
  for (let i = 0; i < rgba.length; i += 4) {
    const L = (0.42 * rgba[i] + 0.46 * rgba[i + 1] + 0.12 * rgba[i + 2]) / 255
    const t = Math.min(1, Math.max(0, (L - 0.14) / 0.6))
    if (t <= 0) continue
    const k = Math.pow(t, 0.85)
    const w = k * k // whiter at the brightest cores
    out[i] = 255
    out[i + 1] = Math.round(190 + 60 * w)
    out[i + 2] = Math.round(112 + 128 * w)
    out[i + 3] = Math.round(235 * k) // cores never fully opaque: labels and land keep reading through
    lit = true
  }
  return { data: out, lit }
}

// ── the tile protocol ───────────────────────────────────────────────────────

/** Raw Black Marble RGBA (the night base) and, lazily, its lights-only form. */
type Decoded = { raw: Uint8ClampedArray; lights?: Uint8ClampedArray | null }
const LRU_MAX = 64
const cache = new Map<string, Promise<Decoded>>()

function decode(z: number, x: number, y: number, signal: AbortSignal): Promise<Decoded> {
  const key = `${z}/${x}/${y}`
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }
  const p = (async (): Promise<Decoded> => {
    const res = await fetch(`${GIBS}/${z}/${y}/${x}.png`, { signal, mode: 'cors', credentials: 'omit' })
    if (!res.ok) throw new Error(`Black Marble tile ${key}: HTTP ${res.status}`)
    const bmp = await createImageBitmap(await res.blob())
    const canvas = new OffscreenCanvas(SIZE, SIZE)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bmp, 0, 0, SIZE, SIZE)
    bmp.close?.()
    return { raw: ctx.getImageData(0, 0, SIZE, SIZE).data }
  })()
  p.catch(() => cache.delete(key))
  cache.set(key, p)
  while (cache.size > LRU_MAX) cache.delete(cache.keys().next().value as string)
  return p
}

// A fresh bitmap each time: the renderer owns what it is handed.
const emptyTile = () => createImageBitmap(new ImageData(SIZE, SIZE))

/** [dev] mask timings for the frame-cost proof. */
type LightsCost = { tiles: number; maskMs: number; maxMaskMs: number }
const cost: LightsCost = { tiles: 0, maskMs: 0, maxMaskMs: 0 }

let registered = false
export function registerCityLightsProtocol() {
  if (registered) return
  registered = true
  maplibregl.addProtocol(LIGHTS_PROTOCOL, async (params, abort) => {
    const m = /^nxlights:\/\/(\d+)\/(\d+)\/(\d+)\?t=(\d+)(?:&k=(lights|base))?/.exec(params.url)
    if (!m) throw new Error(`bad lights url ${params.url}`)
    const [z, x, y, t] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    const kind: LightsKind = m[5] === 'base' ? 'base' : 'lights'
    const decoded = await decode(z, x, y, abort.signal)
    if (kind === 'lights' && decoded.lights === undefined) {
      const { data, lit } = extractLights(decoded.raw)
      decoded.lights = lit ? data : null
    }
    const src = kind === 'base' ? decoded.raw : decoded.lights
    if (!src) return { data: await emptyTile() }
    const t0 = performance.now()
    const night = kind === 'base'
      ? nightFactorTile(z, x, y, new Date(t), SIZE, BASE_ON_ALT, BASE_FULL_ALT)
      : nightFactorTile(z, x, y, new Date(t))
    const px = new Uint8ClampedArray(src.length)
    let any = false
    for (let i = 0, j = 0; j < night.length; i += 4, j++) {
      const a = (kind === 'base' ? 255 : src[i + 3]) * night[j]
      if (a < 1) continue
      px[i] = src[i]; px[i + 1] = src[i + 1]; px[i + 2] = src[i + 2]; px[i + 3] = a
      any = true
    }
    if (import.meta.env.DEV) {
      const ms = performance.now() - t0
      cost.tiles++; cost.maskMs += ms; cost.maxMaskMs = Math.max(cost.maxMaskMs, ms)
      ;(window as unknown as { __nxLightsCost?: LightsCost & { avgMaskMs: number } }).__nxLightsCost = { ...cost, avgMaskMs: cost.maskMs / cost.tiles }
    }
    if (!any) return { data: await emptyTile() }
    return { data: await createImageBitmap(new ImageData(px, SIZE, SIZE)) }
  })
}
