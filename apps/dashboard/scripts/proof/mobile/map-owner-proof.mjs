/**
 * GENERIC-INVENTORY OWNERSHIP PROOF.
 *
 * Answers three questions with numbers, twice, from cold:
 *
 *   1. OWNERSHIP    At each zoom, how many families are painting generic inventory?
 *                   The answer has to be exactly one. The operational overlay
 *                   (command pins = conversations) is counted separately: it is allowed
 *                   to be on, it is not allowed to be the property universe.
 *   2. DENSITY      source -> admitted -> rendered. `source` is what arrived in the tile,
 *                   `admitted` is what survives the density filter, `rendered` is what
 *                   MapLibre actually painted after collision. Reporting only the last
 *                   of the three makes a filter bug and a collision bug look identical.
 *   3. DETERMINISM  Two fresh browser contexts, same camera. A run that reports 6/6 tile
 *                   layers at z11 and then 0/6 on the next pass is the failure this
 *                   whole phase exists to eliminate, so it is asserted, not eyeballed.
 *
 *   node scripts/proof/mobile/map-owner-proof.mjs --runs 2
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

/**
 * Progress goes to a file as well as stdout. Node block-buffers stdout when it is not a
 * TTY, so a run that takes twenty minutes shows nothing at all until it exits — which
 * makes a hang and a slow pass look identical while you are waiting on it.
 */
const LOG = '/tmp/map-owner-proof.log'
try { fsSync.writeFileSync(LOG, '') } catch { /* best effort */ }
const say = (line) => {
  console.log(line)
  try { fsSync.appendFileSync(LOG, `${line}\n`) } catch { /* best effort */ }
}

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const RUNS = Number(arg('runs', '2'))
const OUT = path.resolve(process.cwd(), '.screenshots/map-owner', arg('label', 'run'))

/** Liberty Square, Miami — the dense market every pileup was reported in. */
const CENTER = [-80.215113, 25.833814]
const ZOOMS = [9, 10, 11, 12, 13, 14, 15, 16]
/** Screenshot labels the report refers to, mapped to the zoom that shows them. */
const NAMED_ZOOMS = { 10: 'metro', 13: 'neighborhood', 16: 'street' }

/**
 * `generic` families claim to draw the property universe — exactly one may be on.
 * `overlay` families draw the operator's own work and are counted, not policed.
 */
const FAMILIES = {
  mvtTiles:         { kind: 'generic', icon: 'prop-tiles-icon', all: ['prop-tiles-hit','prop-tiles-halo','prop-tiles-glass','prop-tiles-ring','prop-tiles-pulse','prop-tiles-icon'], source: 'property-map-tiles', sourceLayer: 'properties' },
  marketAggregates: { kind: 'generic', icon: 'map-agg-cluster-count', all: ['map-agg-cluster-halo','map-agg-cluster-core','map-agg-cluster-ring','map-agg-cluster-icon','map-agg-cluster-count'], source: 'map-market-aggregates' },
  sellerPins:       { kind: 'generic', icon: 'seller-pins-icon', all: ['seller-pins-hit','seller-pins-ring','seller-pins-core','seller-pins-icon','seller-pins-cluster-glow','seller-pins-cluster-core','seller-pins-cluster-count'], source: 'seller-pins-source' },
  propUniverse:     { kind: 'generic', icon: 'prop-univ-markers', all: ['prop-univ-cluster-ring','prop-univ-cluster-core','prop-univ-cluster-icon','prop-univ-cluster-count','prop-univ-marker-hit','prop-univ-markers'], source: 'inbox-property-universe' },
  commandRaw:       { kind: 'overlay', icon: 'command-pin-icon-raw', all: ['command-pin-core-raw','command-pin-icon-raw'], source: 'command-pins-raw' },
  commandClustered: { kind: 'overlay', icon: 'command-pin-icon-clustered', all: ['command-pin-icon-clustered'], source: 'command-pins-clustered' },
  selectedStar:     { kind: 'subject', icon: 'command-selected-star-layer', all: ['command-selected-star-layer'], source: 'command-selected-star' },
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
  try { map.getLayer('prop-tiles-icon') } catch { return { error: 'style torn down' } }

  const owner = window.__nexusInventoryOwner
    ? { owner: window.__nexusInventoryOwner.owner, reason: window.__nexusInventoryOwner.reason, appliedLayers: window.__nexusInventoryOwner.appliedLayers }
    : null

  const out = { zoom: Number(map.getZoom().toFixed(2)), owner, families: {} }
  for (const [name, def] of Object.entries(families)) {
    const present = def.all.filter((id) => map.getLayer(id))
    if (present.length === 0) { out.families[name] = { present: false, kind: def.kind }; continue }
    const visible = present.filter((id) => (map.getLayoutProperty(id, 'visibility') ?? 'visible') !== 'none')

    // RENDERED: what the operator can actually see, after filter AND collision.
    let rendered = 0
    let distinctRendered = 0
    const renderableIcons = visible.includes(def.icon) ? [def.icon] : []
    if (renderableIcons.length > 0) {
      try {
        const feats = map.queryRenderedFeatures(undefined, { layers: renderableIcons })
        rendered = feats.length
        distinctRendered = new Set(feats.map((f) => f.properties?.property_id ?? f.id)).size
      } catch { rendered = -1 }
    }

    /**
     * SOURCE: properties present in the tile data IN VIEW, before any filter.
     * ADMITTED: how many of those the density filter lets through.
     *
     * Both are counted IN THE VIEWPORT, by projecting each feature and discarding
     * anything off-canvas. A bare querySourceFeatures count is not a per-zoom figure at
     * all: it reports MapLibre's whole tile cache, including parent tiles retained from
     * previous zooms, so it depends on where the camera has been rather than where it
     * is. That produced a run reporting an identical 4,808 at z13, z14, z15 and z16
     * while a second run at the same cameras reported 3,240 / 1,711 / 418 / 110 — a
     * difference entirely in the measurement, not in the render.
     */
    const inView = (feats) => {
      const w = map.getCanvas().clientWidth
      const h = map.getCanvas().clientHeight
      let n = 0
      for (const f of feats) {
        const c = f.geometry?.coordinates
        if (!Array.isArray(c) || c.length < 2) continue
        const p = map.project(c)
        if (p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) n += 1
      }
      return n
    }
    let source = null
    let admitted = null
    try {
      const opts = def.sourceLayer ? { sourceLayer: def.sourceLayer } : {}
      source = inView(map.querySourceFeatures(def.source, opts))
      const filter = map.getLayer(def.icon) ? map.getFilter(def.icon) : null
      admitted = filter
        ? inView(map.querySourceFeatures(def.source, { ...opts, filter }))
        : source
    } catch { /* source absent in this state */ }

    out.families[name] = { present: true, kind: def.kind, layersVisible: visible.length, layersTotal: present.length, source, admitted, rendered, distinctRendered }
  }

  const paintingGeneric = Object.entries(out.families)
    .filter(([, f]) => f.present && f.kind === 'generic' && f.rendered > 0)
    .map(([n]) => n)
  out.genericOwners = paintingGeneric
  out.genericOwnerCount = paintingGeneric.length
  return out
}

const arrive = async (page) => {
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
}

const browser = await chromium.launch()
await fs.mkdir(OUT, { recursive: true })
const runs = []

for (let run = 1; run <= RUNS; run += 1) {
  // A FRESH CONTEXT per run, not just a reload: the non-determinism being hunted came
  // from arrival ordering, and a warm cache hides exactly that.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await arrive(page)

  const rows = []
  for (const zoom of ZOOMS) {
    /**
     * Move the camera, and make sure it stayed moved.
     *
     * `map.stop()` first: arrival flies the map to the selected property, and a jumpTo
     * issued while that easing is still in flight is simply overridden by it. That cost
     * a whole certification run — the z9 row was measured at z13 because the first jump
     * of the run never took, and every later zoom was fine because nothing was animating
     * by then. Retried rather than asserted once, since the fly-out has no fixed length.
     */
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const landed = await page.evaluate(({ center, z }) => {
        const maps = window.__nexusMaps ?? []
        let best = null; let bestArea = 0
        for (const m of maps) {
          const el = m.getContainer?.(); if (!el || !el.isConnected) continue
          const r = el.getBoundingClientRect()
          const area = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width
          if (area > bestArea) { bestArea = area; best = m }
        }
        if (!best) return false
        best.stop()
        best.jumpTo({ center, zoom: z })
        return Math.abs(best.getZoom() - z) < 0.01
      }, { center: CENTER, z: zoom })
      if (landed) break
      await page.waitForTimeout(1500)
    }

    /**
     * FIRST: wait for the camera to actually BE at the requested zoom.
     *
     * Without this the run is not measuring what it says it is. The arrival flow leaves
     * the map at roughly z13 on the selected property, so a first jumpTo(9) that had not
     * taken effect yet left the tile count already stable at z13 — the settle below
     * passed instantly and the z9 row was recorded from a z13 camera. One certification
     * run reported z9 source 15,319 and the next 3,227 for that reason, and the
     * determinism check compared the two and passed, because it only compared owner and
     * layer counts.
     */
    await page.waitForFunction((z) => {
      const maps = window.__nexusMaps ?? []
      const m = maps.find((c) => c.getContainer?.()?.isConnected)
      return Boolean(m) && Math.abs(m.getZoom() - z) < 0.01
    }, zoom, { timeout: 30_000 }).catch(() => {})

    // Stability is measured fresh per zoom; a counter carried over from the previous
    // camera would satisfy the stable-count test before any new tile had arrived.
    await page.evaluate(() => { delete window.__nexusTileSettle; delete window.__nexusPlacementSettle })

    await page.waitForFunction(() => {
      const maps = window.__nexusMaps ?? []
      return maps.length > 0 && maps.every((m) => m.loaded() && m.areTilesLoaded())
    }, null, { timeout: 45_000 }).catch(() => {})

    /**
     * Then wait for the tile source to stop GROWING. `areTilesLoaded()` goes true for the
     * tiles requested so far, and more are requested as the camera settles, so sampling
     * on that alone measures network progress rather than the data — which is exactly why
     * two runs reported 3,623 and 15,319 source features for the same camera.
     */
    await page.waitForFunction(() => {
      const maps = window.__nexusMaps ?? []
      const m = maps.find((c) => c.getContainer?.()?.isConnected)
      if (!m) return false
      let count = -1
      try { count = m.querySourceFeatures('property-map-tiles', { sourceLayer: 'properties' }).length } catch { return false }
      const prev = window.__nexusTileSettle
      window.__nexusTileSettle = { count, stable: prev && prev.count === count ? prev.stable + 1 : 0 }
      /**
       * Stable AND non-empty. A cache still holding only retained parent tiles is
       * perfectly stable, so stability alone would happily certify a view whose own
       * tiles never arrived.
       */
      return count > 0 && window.__nexusTileSettle.stable >= 3
    }, null, { timeout: 60_000, polling: 1200 }).catch(() => {})
    /**
     * Finally, wait for the PLACEMENT to settle, not just the data.
     *
     * Symbol collision runs asynchronously after tiles land, so queryRenderedFeatures
     * can report a mid-placement snapshot. Two runs with identical source and identical
     * admitted counts reported 2 and 6 rendered at z16 for exactly this reason — the
     * render agreed, the moment of sampling did not.
     */
    await page.waitForFunction(() => {
      const maps = window.__nexusMaps ?? []
      const m = maps.find((c) => c.getContainer?.()?.isConnected)
      if (!m || !m.getLayer('prop-tiles-icon')) return false
      let n = -1
      try { n = m.queryRenderedFeatures(undefined, { layers: ['prop-tiles-icon'] }).length } catch { return false }
      const prev = window.__nexusPlacementSettle
      window.__nexusPlacementSettle = { n, stable: prev && prev.n === n ? prev.stable + 1 : 0 }
      return window.__nexusPlacementSettle.stable >= 3
    }, null, { timeout: 30_000, polling: 700 }).catch(() => {})
    await page.waitForTimeout(1500)

    const probe = await page.evaluate(PROBE, FAMILIES).catch((error) => ({ error: String(error?.message ?? error) }))
    rows.push({ requestedZoom: zoom, ...probe })
    if (NAMED_ZOOMS[zoom]) await page.screenshot({ path: path.join(OUT, `run${run}-${NAMED_ZOOMS[zoom]}-z${zoom}.png`) })

    const m = probe.families?.mvtTiles ?? {}
    const c = probe.families?.commandRaw ?? {}
    say(
      `run${run} z${String(zoom).padEnd(2)} owner=${String(probe.owner?.owner ?? '-').padEnd(10)} ` +
      `generic=[${(probe.genericOwners ?? []).join(',') || 'none'}] ` +
      `mvt(vis ${m.layersVisible ?? '-'}/${m.layersTotal ?? '-'} src ${String(m.source ?? '-').padStart(5)} adm ${String(m.admitted ?? '-').padStart(5)} rend ${String(m.rendered ?? '-').padStart(4)} uniq ${String(m.distinctRendered ?? '-').padStart(4)}) ` +
      `overlay(rend ${c.rendered ?? '-'}) star=${probe.families?.selectedStar?.rendered ?? '-'}`,
    )
  }
  runs.push(rows)
  await context.close()
}

// ── Determinism: compare every run against run 1, per zoom ────────────────────
const diffs = []
for (let r = 1; r < runs.length; r += 1) {
  for (let i = 0; i < runs[0].length; i += 1) {
    const a = runs[0][i]; const b = runs[r][i]
    if (!a || !b) continue
    const am = a.families?.mvtTiles ?? {}; const bm = b.families?.mvtTiles ?? {}
    // The camera has to have been in the same place, or nothing below compares anything.
    if (a.zoom !== b.zoom) diffs.push(`z${a.requestedZoom}: sampled at different cameras, ${a.zoom} vs ${b.zoom}`)
    if (a.owner?.owner !== b.owner?.owner) diffs.push(`z${a.requestedZoom}: owner ${a.owner?.owner} vs ${b.owner?.owner}`)
    if (am.layersVisible !== bm.layersVisible) diffs.push(`z${a.requestedZoom}: mvt layersVisible ${am.layersVisible} vs ${bm.layersVisible}`)
    if ((a.genericOwners ?? []).join(',') !== (b.genericOwners ?? []).join(',')) diffs.push(`z${a.requestedZoom}: generic owners [${a.genericOwners}] vs [${b.genericOwners}]`)
    // source and admitted are pure functions of the tile payload and the filter, so they
    // must match EXACTLY — that is the determinism claim this phase actually makes.
    if (am.source !== bm.source) diffs.push(`z${a.requestedZoom}: source ${am.source} vs ${bm.source}`)
    if (am.admitted !== bm.admitted) diffs.push(`z${a.requestedZoom}: admitted ${am.admitted} vs ${bm.admitted}`)
    /**
     * `rendered` is allowed a small tolerance and nothing more. It is the output of
     * symbol collision, which depends on the order tiles were placed in, so ±2 between
     * runs is placement noise rather than a different decision. A larger gap means the
     * filter or the owner moved, which the checks above would not always catch.
     */
    if (Math.abs((am.rendered ?? 0) - (bm.rendered ?? 0)) > 2) {
      diffs.push(`z${a.requestedZoom}: rendered ${am.rendered} vs ${bm.rendered}`)
    }
  }
}

const multiOwner = runs.flat().filter((r) => (r.genericOwnerCount ?? 0) !== 1)
say('\n── VERDICT ──')
say(`exactly-one-generic-family: ${multiOwner.length === 0 ? 'PASS' : `FAIL (${multiOwner.map((r) => `z${r.requestedZoom}=${r.genericOwnerCount}`).join(' ')})`}`)
say(`determinism across ${RUNS} fresh runs: ${diffs.length === 0 ? 'PASS' : `FAIL\n  ${diffs.join('\n  ')}`}`)

await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ runs, diffs }, null, 2))
console.log(`\nscreenshots: ${OUT}`)
await browser.close()
