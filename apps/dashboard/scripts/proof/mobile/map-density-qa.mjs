/**
 * MARKER DENSITY PROOF.
 *
 * "The map is noisy" is not a measurement. This counts, per zoom band, how many
 * property markers are actually painted and how many of them physically overlap, so
 * the density system can be tuned against numbers rather than impressions.
 *
 * Counting is done through the MAP INSTANCE (queryRenderedFeatures), not the DOM:
 * markers are drawn to a WebGL canvas and have no elements to inspect. The map is
 * reached via a debug handle the map exposes in dev (see InboxCommandMap).
 *
 *   node scripts/proof/mobile/map-density-qa.mjs --label after
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const LABEL = arg('label', 'run')
const OUT = path.resolve(process.cwd(), '.screenshots/map-density', LABEL)

/** Miami Liberty Square — the dense market the pileups were observed in. */
const CENTER = [-80.215113, 25.833814]

const BANDS = [
  { id: 'national', zoom: 4 },
  { id: 'state', zoom: 7 },
  { id: 'metro', zoom: 10 },
  { id: 'district', zoom: 12 },
  { id: 'neighborhood', zoom: 14 },
  { id: 'street', zoom: 16 },
]

/**
 * Overlap is counted in SCREEN space against the painted icon size. Two markers whose
 * centres are closer than one icon width are, to the operator, one illegible blob.
 */
const MEASURE = (iconPx) => {
  /**
   * The VISIBLE map instance, resolved INSIDE the page function: page.evaluate
   * serialises only this function, so a helper defined in module scope is not in
   * scope here. More than one map can be mounted, and the hidden one reports every
   * layer as `visibility: none` with zero rendered features.
   */
  const maps = window.__nexusMaps ?? (window.__nexusMap ? [window.__nexusMap] : [])
  let map = null
  let bestArea = 0
  for (const candidate of maps) {
    const el = candidate.getContainer?.()
    if (!el || !el.isConnected) continue
    const r = el.getBoundingClientRect()
    const area = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width
    if (area > bestArea) { bestArea = area; map = candidate }
  }
  if (!map) return { error: 'no map handle' }
  const layers = ['prop-tiles-icon', 'seller-pins-icon'].filter((id) => map.getLayer(id))
  if (layers.length === 0) return { error: 'no marker layers' }

  const features = map.queryRenderedFeatures(undefined, { layers })
  const points = []
  for (const f of features) {
    const coords = f.geometry?.coordinates
    if (!Array.isArray(coords) || coords.length < 2) continue
    const p = map.project(coords)
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    points.push({ x: p.x, y: p.y, id: f.properties?.property_id ?? null })
  }

  // Pairwise within a grid bucket — O(n) rather than O(n^2), which matters at street
  // zoom where a naive pass would take longer than the frame budget it is measuring.
  const cell = Math.max(8, iconPx)
  const buckets = new Map()
  for (const pt of points) {
    const key = `${Math.floor(pt.x / cell)}:${Math.floor(pt.y / cell)}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(pt)
  }
  let overlapping = 0
  let worstCell = 0
  for (const bucket of buckets.values()) {
    worstCell = Math.max(worstCell, bucket.length)
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const dx = bucket[i].x - bucket[j].x
        const dy = bucket[i].y - bucket[j].y
        if (Math.hypot(dx, dy) < iconPx) overlapping += 1
      }
    }
  }

  return {
    rendered: points.length,
    overlappingPairs: overlapping,
    // The single densest icon-sized cell: the honest measure of "a pileup".
    worstCellCount: worstCell,
    zoom: Number(map.getZoom().toFixed(2)),
    // Diagnostics, so "0 rendered" can be attributed rather than guessed at.
    layerVisibility: Object.fromEntries(
      ['prop-tiles-icon', 'prop-tiles-glass', 'seller-pins-icon']
        .filter((id) => map.getLayer(id))
        .map((id) => [id, map.getLayoutProperty(id, 'visibility') ?? 'visible']),
    ),
    sourceLoaded: (() => { try { return map.isSourceLoaded('property-map-tiles') } catch { return null } })(),
    sourceFeatures: (() => {
      try {
        return map.querySourceFeatures('property-map-tiles', { sourceLayer: 'properties' }).length
      } catch { return null }
    })(),
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})
await fs.mkdir(OUT, { recursive: true })
const page = await context.newPage()

/**
 * Reached the way the operator reaches it: select a seller in the Inbox, then open Map
 * from the dock.
 *
 * A bare /map visit installs the property-tile layers with `visibility: none` and
 * nothing turns them on, so measuring that route reported zero markers at every zoom
 * and would have "proved" a density fix that had never run. The pileups were always in
 * the arrival flow.
 */
await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
// The dev API answers inbox queries in 10-20s under load; the shell mounts long before.
await page.waitForSelector('.nx-row25', { timeout: 120_000 })
await page.waitForTimeout(5000)
await (await page.$$('.nx-row25'))[0].click()
await page.waitForTimeout(3500)
await page.click('.nx-pinned-app-dock__handle')
await page.waitForTimeout(700)
await (await page.$('.nx-pinned-app-dock__track .nx-pinned-app-dock__app[aria-label="Map"]'))?.click()
await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 60_000 })
await page.waitForFunction(() => Boolean(window.__nexusMap), null, { timeout: 60_000 })
await page.waitForTimeout(16_000)

const results = []
for (const band of BANDS) {
  await page.evaluate(({ center, zoom }) => {
    const maps = window.__nexusMaps ?? (window.__nexusMap ? [window.__nexusMap] : [])
    let best = null; let bestArea = 0
    for (const m of maps) {
      const el = m.getContainer?.(); if (!el || !el.isConnected) continue
      const r = el.getBoundingClientRect()
      const area = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width
      if (area > bestArea) { bestArea = area; best = m }
    }
    best?.jumpTo({ center, zoom })
  }, { center: CENTER, zoom: band.zoom })
  // Tiles for a new zoom have to arrive before anything can be counted. `idle` is the
  // map's own signal that it has finished loading and rendering everything in view —
  // a fixed timeout under-counted high zooms, where far more tiles are requested.
  await page.waitForFunction(() => {
    const maps = window.__nexusMaps ?? (window.__nexusMap ? [window.__nexusMap] : [])
    return maps.length > 0 && maps.every((m) => m.loaded() && m.areTilesLoaded())
  }, null, { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const measured = await page.evaluate(MEASURE, 26)
  results.push({ band: band.id, requestedZoom: band.zoom, ...measured })
  await page.screenshot({ path: path.join(OUT, `${band.id}.png`) })
  console.log(
    `${band.id.padEnd(14)} z=${String(measured.zoom ?? band.zoom).padStart(5)} ` +
    `rendered=${String(measured.rendered ?? '—').padStart(4)} ` +
    `overlappingPairs=${String(measured.overlappingPairs ?? '—').padStart(5)} ` +
    `worstCell=${String(measured.worstCellCount ?? '—').padStart(3)}` +
    (measured.error ? `  ERROR ${measured.error}` : ''),
  )
}

await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
console.log(`\nscreenshots: ${OUT}`)
await browser.close()
