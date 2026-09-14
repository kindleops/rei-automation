/**
 * THE SUBJECT IS THE GOLD STAR, AND ONLY THE GOLD STAR.
 *
 * When a property is selected its marker becomes a gold star that REPLACES the house
 * glyph. Every family that could also draw that same property has to stand down, or the
 * star stacks on top of a pin and the subject reads as two markers.
 *
 * The knockout is done with FILTERS, so this is a clean measurement: a layer that
 * excludes the subject simply does not return it from queryRenderedFeatures. An earlier
 * cut of this harness tried to read opacity expressions instead, which cannot decide the
 * question — queryRenderedFeatures reports geometry irrespective of paint, and the tile
 * icon's opacity is floored at 0.96 by the theme pass, so no opacity knockout there could
 * ever have worked.
 *
 * Two layers are SUPPOSED to still return the subject and are asserted to: `prop-tiles-hit`
 * and `command-pin-core-raw` are the invisible tap targets that keep the operator's own
 * subject touchable underneath its star. A knockout that also removed those would make the
 * one thing they care about the one thing they cannot tap.
 *
 *   node scripts/proof/mobile/map-subject-knockout-qa.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const OUT = path.resolve(process.cwd(), '.screenshots/map-knockout', arg('label', 'run'))
const LOG = '/tmp/map-knockout-qa.log'
try { fsSync.writeFileSync(LOG, '') } catch { /* best effort */ }
const say = (l) => { console.log(l); try { fsSync.appendFileSync(LOG, `${l}\n`) } catch { /* noop */ } }

/** Everything that can draw a property marker, minus the star itself. */
const BODY_LAYERS = [
  'prop-tiles-icon', 'prop-tiles-halo', 'prop-tiles-glass', 'prop-tiles-ring', 'prop-tiles-pulse',
  'seller-pins-icon', 'seller-pins-core', 'seller-pins-ring', 'seller-pins-glow', 'seller-pins-pulse',
  'command-pin-icon-raw', 'command-pin-glow-raw', 'command-pin-pulse-raw',
  'command-pin-unread-ring-raw', 'command-pin-offer-ring-raw', 'command-pin-contract-ring-raw',
  'command-pin-warning-badge-raw',
  'prop-univ-markers',
]

/** Invisible, and required to keep returning the subject so it stays tappable. */
const HIT_LAYERS = ['prop-tiles-hit', 'command-pin-core-raw']

const PROBE = ({ bodyLayers, hitLayers }) => {
  const maps = window.__nexusMaps ?? []
  let map = null; let bestArea = 0
  for (const c of maps) {
    const el = c.getContainer?.(); if (!el || !el.isConnected) continue
    const r = el.getBoundingClientRect()
    const a = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width
    if (a > bestArea) { bestArea = a; map = c }
  }
  if (!map) return { error: 'no visible map' }

  // The subject is whatever the star is drawn on — read it from the star source itself
  // rather than from React state, so this measures what is PAINTED, not what is intended.
  let selectedId = null
  let starCount = 0
  try {
    const stars = map.queryRenderedFeatures(undefined, { layers: ['command-selected-star-layer'] })
    starCount = stars.length
    selectedId = String(stars[0]?.properties?.property_id ?? stars[0]?.properties?.propertyId ?? '') || null
  } catch { /* layer absent */ }
  if (!selectedId) return { error: 'no star painted — nothing selected', starCount }

  const offenders = []
  for (const layerId of bodyLayers) {
    if (!map.getLayer(layerId)) continue
    if ((map.getLayoutProperty(layerId, 'visibility') ?? 'visible') === 'none') continue
    let feats = []
    try { feats = map.queryRenderedFeatures(undefined, { layers: [layerId] }) } catch { continue }
    const hits = feats.filter((f) => {
      const id = String(f.properties?.property_id ?? f.properties?.propertyId ?? '')
      return id && id === selectedId
    })
    if (hits.length > 0) offenders.push({ layerId, count: hits.length })
  }

  // The other half of the contract: the subject must remain reachable by touch.
  const tappable = []
  for (const layerId of hitLayers) {
    if (!map.getLayer(layerId)) continue
    if ((map.getLayoutProperty(layerId, 'visibility') ?? 'visible') === 'none') continue
    let feats = []
    try { feats = map.queryRenderedFeatures(undefined, { layers: [layerId] }) } catch { continue }
    if (feats.some((f) => String(f.properties?.property_id ?? f.properties?.propertyId ?? '') === selectedId)) {
      tappable.push(layerId)
    }
  }
  return { zoom: Number(map.getZoom().toFixed(2)), selectedId, starCount, offenders, tappable }
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await fs.mkdir(OUT, { recursive: true })
const page = await context.newPage()

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
for (const zoom of [10, 13, 16]) {
  await page.evaluate((z) => {
    const maps = window.__nexusMaps ?? []
    const m = maps.find((c) => c.getContainer?.()?.isConnected)
    // Centre ON the subject so the star is guaranteed to be in frame at every zoom.
    const star = m?.getSource?.('command-selected-star')?._data?.features?.[0]
    m?.jumpTo({ center: star?.geometry?.coordinates ?? [-80.215113, 25.833814], zoom: z })
  }, zoom)
  await page.waitForFunction(() => {
    const maps = window.__nexusMaps ?? []
    return maps.length > 0 && maps.every((m) => m.loaded() && m.areTilesLoaded())
  }, null, { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(4000)

  const probe = await page.evaluate(PROBE, { bodyLayers: BODY_LAYERS, hitLayers: HIT_LAYERS }).catch((e) => ({ error: String(e?.message ?? e) }))
  results.push({ requestedZoom: zoom, ...probe })
  await page.screenshot({ path: path.join(OUT, `z${zoom}.png`) })
  say(
    `z${String(zoom).padEnd(2)} star=${probe.starCount ?? '-'} subject=${probe.selectedId ?? '-'} ` +
    `stacked=[${(probe.offenders ?? []).map((o) => `${o.layerId}:${o.count}`).join(' ') || 'none'}] ` +
    `tappable=[${(probe.tappable ?? []).join(' ') || 'NONE'}]` +
    (probe.error ? `  ${probe.error}` : ''),
  )
}

const failures = results.filter((r) => r.error || (r.offenders ?? []).length > 0 || (r.tappable ?? []).length === 0)
say('\n── VERDICT ──')
say(failures.length === 0
  ? 'subject renders as the gold star alone: PASS'
  : `subject knockout: FAIL\n  ${failures.map((f) => `z${f.requestedZoom}: ${f.error ?? ((f.offenders ?? []).length ? `stacked ${f.offenders.map((o) => o.layerId).join(', ')}` : 'subject not tappable in any hit layer')}`).join('\n  ')}`)

await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
say(`screenshots: ${OUT}`)
await browser.close()
