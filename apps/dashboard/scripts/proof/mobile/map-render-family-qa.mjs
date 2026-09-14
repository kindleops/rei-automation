/**
 * WHICH PROPERTY UNIVERSE IS AUTHORITATIVE?
 *
 * Two families can render generic property inventory:
 *
 *   prop-tiles-*   PostGIS MVT vector tiles. map-property-source.ts states the intent
 *                  plainly: "Zoom 9+ uses PostGIS MVT tiles — complete property
 *                  universe, no row caps".
 *   seller-pins-*  A bounded GeoJSON field, which the same file calls the "legacy
 *                  bounded GeoJSON path — diagnostics only when tiles are active".
 *
 * `applySellerPinRenderFamily` currently hides ALL_PROPERTY_TILE_LAYER_IDS whenever the
 * seller-pin field is active, which inverts that stated intent. This records what is
 * actually visible, per zoom, per state, so the conflict is documented in numbers
 * rather than argued from source comments.
 *
 * Reports per family: layer visibility, source features loaded, and rendered symbols.
 * Rendered count is the only one that answers "can the operator see it".
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const OUT = path.resolve(process.cwd(), '.screenshots/map-family', arg('label', 'run'))

/** Liberty Square, Miami — the dense market the pileups were reported in. */
const CENTER = [-80.215113, 25.833814]
const ZOOMS = [9, 10, 11, 12, 13, 14, 15, 16]

const FAMILIES = {
  mvtTiles: { icon: 'prop-tiles-icon', all: ['prop-tiles-hit', 'prop-tiles-halo', 'prop-tiles-glass', 'prop-tiles-ring', 'prop-tiles-pulse', 'prop-tiles-icon'], source: 'property-map-tiles', sourceLayer: 'properties' },
  sellerPins: { icon: 'seller-pins-icon', all: ['seller-pins-hit', 'seller-pins-ring', 'seller-pins-core', 'seller-pins-icon'], source: 'seller-pins-source' },
  sellerClusters: { icon: 'seller-pins-cluster-count', all: ['seller-pins-cluster-glow', 'seller-pins-cluster-core', 'seller-pins-cluster-count'], source: 'seller-pins-source' },
  commandRaw: { icon: 'command-pin-icon-raw', all: ['command-pin-core-raw', 'command-pin-icon-raw'], source: 'command-pins-raw' },
  commandClustered: { icon: 'command-pin-icon-clustered', all: ['command-pin-icon-clustered'], source: 'command-pins-clustered' },
  propUniverse: { icon: 'prop-univ-cluster-icon', all: ['prop-univ-cluster-icon', 'prop-univ-cluster-count', 'prop-univ-marker-hit'], source: 'inbox-property-universe' },
  marketAggregates: { icon: 'map-agg-cluster-count', all: ['map-agg-cluster-halo', 'map-agg-cluster-core', 'map-agg-cluster-count'], source: 'map-market-aggregates' },
  selectedStar: { icon: 'command-selected-star-layer', all: ['command-selected-star-layer'], source: 'command-selected-star' },
}

const PROBE = (families) => {
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
  if (!map) return { error: 'no visible map' }

  const out = { zoom: Number(map.getZoom().toFixed(2)), families: {} }
  for (const [name, def] of Object.entries(families)) {
    const present = def.all.filter((id) => map.getLayer(id))
    if (present.length === 0) { out.families[name] = { present: false }; continue }
    const visible = present.filter((id) => (map.getLayoutProperty(id, 'visibility') ?? 'visible') !== 'none')
    let rendered = 0
    try { rendered = map.queryRenderedFeatures(undefined, { layers: visible.length ? visible : present }).length } catch { rendered = -1 }
    let sourceFeatures = null
    try {
      sourceFeatures = map.querySourceFeatures(def.source, def.sourceLayer ? { sourceLayer: def.sourceLayer } : undefined).length
    } catch { sourceFeatures = null }
    out.families[name] = {
      present: true,
      layersVisible: visible.length,
      layersTotal: present.length,
      rendered,
      sourceFeatures,
    }
  }
  return out
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})
await fs.mkdir(OUT, { recursive: true })
const page = await context.newPage()

// Arrival flow: select a seller in the Inbox, open Map from the dock. This is the state
// the density complaint came from; a bare /map visit never turns the layers on at all.
await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
await page.waitForSelector('.nx-row25', { timeout: 120_000 })
await page.waitForTimeout(5000)
await (await page.$$('.nx-row25'))[0].click()
await page.waitForTimeout(3500)
await page.click('.nx-pinned-app-dock__handle')
await page.waitForTimeout(700)
await (await page.$('.nx-pinned-app-dock__track .nx-pinned-app-dock__app[aria-label="Map"]'))?.click()
await page.waitForFunction(() => Boolean(window.__nexusMaps?.length), null, { timeout: 60_000 })
await page.waitForTimeout(16_000)

const results = []
for (const zoom of ZOOMS) {
  await page.evaluate(({ center, z }) => {
    const maps = window.__nexusMaps ?? []
    let best = null; let bestArea = 0
    for (const m of maps) {
      const el = m.getContainer?.(); if (!el || !el.isConnected) continue
      const r = el.getBoundingClientRect()
      const area = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width
      if (area > bestArea) { bestArea = area; best = m }
    }
    best?.jumpTo({ center, zoom: z })
  }, { center: CENTER, z: zoom })

  // Settle: the family resolver runs off a debounced `moveend`, so the decision for a
  // new zoom is not made on the frame the camera lands.
  await page.waitForFunction(() => {
    const maps = window.__nexusMaps ?? []
    return maps.length > 0 && maps.every((m) => m.loaded() && m.areTilesLoaded())
  }, null, { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(4500)

  const probe = await page.evaluate(PROBE, FAMILIES)
  results.push({ requestedZoom: zoom, ...probe })
  await page.screenshot({ path: path.join(OUT, `z${zoom}.png`) })

  const fams = probe.families ?? {}
  const owner = Object.entries(fams)
    .filter(([name, f]) => f.present && f.rendered > 0 && name !== 'selectedStar')
    .map(([name, f]) => `${name}:${f.rendered}`)
  console.log(
    `z${String(zoom).padEnd(3)} actual=${String(probe.zoom).padEnd(6)} ` +
    `mvt(vis ${fams.mvtTiles?.layersVisible ?? '-'}/${fams.mvtTiles?.layersTotal ?? '-'} src ${fams.mvtTiles?.sourceFeatures ?? '-'} rend ${fams.mvtTiles?.rendered ?? '-'})  ` +
    `sellerPins(vis ${fams.sellerPins?.layersVisible ?? '-'} rend ${fams.sellerPins?.rendered ?? '-'})  ` +
    `star=${fams.selectedStar?.rendered ?? '-'}  ` +
    `OWNER=[${owner.join(' ') || 'none'}]`,
  )
}

await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
console.log(`\nscreenshots: ${OUT}`)
await browser.close()
