/**
 * MASTER FILTER REGRESSION.
 *
 * The contract this proves is a negative one: a Master Filter is a FILTER OVER the
 * canonical property universe, not a second architecture. So across enter / zoom /
 * change / select / clear / leave, the answer to "who is drawing generic inventory"
 * must never change — only how many features survive.
 *
 * Before the ownership collapse this was the only path that ever made the MVT tiles
 * visible, which meant applying a filter and clearing it left the map in two different
 * render states. That is the regression being guarded.
 *
 *   node scripts/proof/mobile/map-master-filter-qa.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
const OUT = path.resolve(process.cwd(), '.screenshots/map-master-filter', arg('label', 'run'))

const GENERIC = {
  mvtTiles:         { icon: 'prop-tiles-icon', all: ['prop-tiles-hit','prop-tiles-halo','prop-tiles-glass','prop-tiles-ring','prop-tiles-pulse','prop-tiles-icon'], source: 'property-map-tiles', sourceLayer: 'properties' },
  marketAggregates: { icon: 'map-agg-cluster-count', all: ['map-agg-cluster-halo','map-agg-cluster-core','map-agg-cluster-ring','map-agg-cluster-icon','map-agg-cluster-count'], source: 'map-market-aggregates' },
  sellerPins:       { icon: 'seller-pins-icon', all: ['seller-pins-hit','seller-pins-ring','seller-pins-core','seller-pins-icon'], source: 'seller-pins-source' },
  propUniverse:     { icon: 'prop-univ-markers', all: ['prop-univ-cluster-ring','prop-univ-marker-hit','prop-univ-markers'], source: 'inbox-property-universe' },
}

const PROBE = (families) => {
  const maps = window.__nexusMaps ?? []
  let map = null; let bestArea = 0
  for (const c of maps) {
    const el = c.getContainer?.(); if (!el || !el.isConnected) continue
    const r = el.getBoundingClientRect()
    const area = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width
    if (area > bestArea) { bestArea = area; map = c }
  }
  // NOT guarded on isStyleLoaded(): it reports false while tiles are still settling, so
  // guarding on it made every probe return 'style not ready'. Guard on what actually
  // throws — a style that has been torn down.
  if (!map) return { error: 'no visible map' }
  try { map.getLayer('prop-tiles-icon') } catch { return { error: 'style torn down' } }

  const out = {
    zoom: Number(map.getZoom().toFixed(2)),
    owner: window.__nexusInventoryOwner?.owner ?? null,
    reason: window.__nexusInventoryOwner?.reason ?? null,
    families: {},
  }
  for (const [name, def] of Object.entries(families)) {
    const present = def.all.filter((id) => map.getLayer(id))
    if (!present.length) { out.families[name] = { present: false }; continue }
    const visible = present.filter((id) => (map.getLayoutProperty(id, 'visibility') ?? 'visible') !== 'none')
    let rendered = 0
    if (visible.includes(def.icon)) {
      try { rendered = map.queryRenderedFeatures(undefined, { layers: [def.icon] }).length } catch { rendered = -1 }
    }
    let source = null
    try {
      source = map.querySourceFeatures(def.source, def.sourceLayer ? { sourceLayer: def.sourceLayer } : {}).length
    } catch { /* absent */ }
    out.families[name] = { present: true, layersVisible: visible.length, layersTotal: present.length, rendered, source }
  }
  out.genericOwners = Object.entries(out.families).filter(([, f]) => f.present && f.rendered > 0).map(([n]) => n)
  // The tile URL carries the filter token; this is how "same owner, different scope" is
  // distinguished from "different owner".
  try {
    const tiles = map.getStyle().sources['property-map-tiles']?.tiles?.[0] ?? ''
    out.tileUrlHasToken = /[?&]filter=/.test(tiles) || /token=/.test(tiles)
    out.tileUrl = tiles.slice(0, 160)
  } catch { out.tileUrlHasToken = null }
  return out
}

const settle = async (page, ms = 6000) => {
  await page.waitForFunction(() => {
    const maps = window.__nexusMaps ?? []
    return maps.length > 0 && maps.every((m) => m.loaded() && m.areTilesLoaded())
  }, null, { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(ms)
}

const jumpTo = async (page, zoom) => {
  await page.evaluate((z) => {
    const maps = window.__nexusMaps ?? []
    let best = null; let bestArea = 0
    for (const m of maps) {
      const el = m.getContainer?.(); if (!el || !el.isConnected) continue
      const r = el.getBoundingClientRect()
      const a = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width
      if (a > bestArea) { bestArea = a; best = m }
    }
    best?.jumpTo({ center: [-80.215113, 25.833814], zoom: z })
  }, zoom)
}

/**
 * Open the modal and apply a real Master Filter.
 *
 * Driven through the "Map Status" group's Property Universe select rather than the
 * Distress & Flags checkboxes: the flag options load asynchronously and render as
 * "Loading flag op…" for a while, so keying the proof off them makes it a test of that
 * fetch. The universe select is present the moment the modal opens.
 */
const openModal = async (page) => {
  await page.click('.nx-icm__mode-tab--filters')
  await page.waitForSelector('.nx-ifm-modal', { timeout: 15_000 })
  await page.waitForTimeout(1200)
}

const commitModal = async (page) => {
  const apply = await page.$('.nx-ifm-btn-primary')
  if (!apply) { await page.click('.nx-ifm-close').catch(() => {}); return false }
  await apply.click()
  await page.waitForSelector('.nx-ifm-modal', { state: 'detached', timeout: 15_000 }).catch(() => {})
  return true
}

/** Scope the universe to `value` ('uncontacted' | 'contacted' | 'all'). */
const applyUniverseFilter = async (page, value) => {
  await openModal(page)
  const rails = await page.$$('.nx-ifm-rail-item')
  if (rails.length) { await rails[0].click(); await page.waitForTimeout(800) }
  const select = await page.$('.nx-ifm-fields select')
  if (!select) { await page.click('.nx-ifm-close').catch(() => {}); return false }
  await select.selectOption(value)
  await page.waitForTimeout(1800)
  return commitModal(page)
}

/** Add a second rule so the token CHANGES rather than merely being set again. */
const addNumericRule = async (page) => {
  await openModal(page)
  const rails = await page.$$('.nx-ifm-rail-item')
  if (rails.length > 1) { await rails[1].click(); await page.waitForTimeout(900) }
  const mins = await page.$$('.nx-ifm-fields input[placeholder="Min"]')
  if (!mins.length) { await page.click('.nx-ifm-close').catch(() => {}); return false }
  await mins[0].fill('1')
  await page.waitForTimeout(1800)
  return commitModal(page)
}

const clearFilter = async (page) => {
  await openModal(page)
  await page.click('.nx-ifm-btn-ghost')
  await page.waitForTimeout(1200)
  await commitModal(page)
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

const steps = []
const record = async (label) => {
  const probe = await page.evaluate(PROBE, GENERIC).catch((e) => ({ error: String(e?.message ?? e) }))
  steps.push({ step: label, ...probe })
  await page.screenshot({ path: path.join(OUT, `${steps.length}-${label.replace(/\W+/g, '-')}.png`) })
  const m = probe.families?.mvtTiles ?? {}
  console.log(
    `${label.padEnd(22)} z=${String(probe.zoom ?? '-').padStart(5)} owner=${String(probe.owner ?? '-').padEnd(10)} ` +
    `generic=[${(probe.genericOwners ?? []).join(',') || 'none'}] mvt(vis ${m.layersVisible ?? '-'}/${m.layersTotal ?? '-'} src ${String(m.source ?? '-').padStart(5)} rend ${String(m.rendered ?? '-').padStart(4)}) ` +
    `token=${probe.tileUrlHasToken ?? '-'}`,
  )
}

await jumpTo(page, 12); await settle(page); await record('baseline')
const entered = await applyUniverseFilter(page, 'uncontacted'); await settle(page); await record(entered ? 'enter-filter' : 'enter-filter-SKIPPED')
await jumpTo(page, 10); await settle(page); await record('filtered-zoom-10')
await jumpTo(page, 14); await settle(page); await record('filtered-zoom-14')
const changed = await addNumericRule(page); await settle(page); await record(changed ? 'change-filter' : 'change-filter-SKIPPED')

// SELECT under a filter: the operator's subject must survive the filter's scope.
await page.evaluate(() => {
  const maps = window.__nexusMaps ?? []
  const m = maps.find((c) => c.getContainer?.()?.isConnected)
  if (!m) return
  const feats = m.queryRenderedFeatures(undefined, { layers: ['prop-tiles-icon'] })
  if (!feats.length) return
  const p = m.project(feats[0].geometry.coordinates)
  m.getCanvas().dispatchEvent(new MouseEvent('click', { clientX: p.x, clientY: p.y, bubbles: true }))
}).catch(() => {})
await settle(page, 4000); await record('select-under-filter')

await clearFilter(page); await settle(page); await record('clear-filter')

// LEAVE and return: the state the map is rebuilt into must match the state it left.
await page.click('.nx-pinned-app-dock__handle'); await page.waitForTimeout(600)
await (await page.$('.nx-pinned-app-dock__track .nx-pinned-app-dock__app[aria-label="Inbox"]'))?.click()
await page.waitForTimeout(4000)
await page.click('.nx-pinned-app-dock__handle'); await page.waitForTimeout(600)
await (await page.$('.nx-pinned-app-dock__track .nx-pinned-app-dock__app[aria-label="Map"]'))?.click()
await page.waitForFunction(() => Boolean(window.__nexusMaps?.length), null, { timeout: 60_000 })
await page.waitForTimeout(12_000)
await jumpTo(page, 12); await settle(page); await record('leave-and-return')

// ── Verdict ───────────────────────────────────────────────────────────────────
/**
 * Two questions, reported separately, because they fail for unrelated reasons.
 *
 * OWNERSHIP is what this phase owns: the same family must own the render at every step,
 * however many features the filter admits. A filter that legitimately matches nothing
 * still has an owner.
 *
 * DATA is the Master Filter feature working end to end. Here it does not: the filtered
 * tile route answers 500 `password authentication failed for user "postgres"`. Filtered
 * tiles are the one path that goes through a direct Postgres connection
 * (queryWithTimeout) instead of the supabase RPC the unfiltered path uses, so a stale
 * SUPABASE_DB_URL password takes out filtered tiles alone. Conflating that with an
 * ownership regression would be reporting a credential problem as a render problem.
 */
const ownershipFailures = []
const dataFailures = []

if (steps.some((s) => s.step.endsWith('SKIPPED'))) {
  ownershipFailures.push(`filter controls unreachable: ${steps.filter((s) => s.step.endsWith('SKIPPED')).map((s) => s.step).join(', ')}`)
}
if (!steps.some((s) => s.tileUrlHasToken === true)) {
  ownershipFailures.push('no step ever carried a filter token — the Master Filter was never applied')
}

for (const s of steps) {
  if (s.error) { ownershipFailures.push(`${s.step}: ${s.error}`); continue }
  const mvt = s.families?.mvtTiles ?? {}
  if (s.owner && s.zoom >= 9 && s.owner !== 'mvt') {
    ownershipFailures.push(`${s.step}: resolver said ${s.owner} at z${s.zoom}, expected mvt`)
  }
  if (mvt.present && mvt.layersVisible !== mvt.layersTotal) {
    ownershipFailures.push(`${s.step}: mvt ${mvt.layersVisible}/${mvt.layersTotal} layers visible`)
  }
  const competitors = (s.genericOwners ?? []).filter((n) => n !== 'mvtTiles')
  if (competitors.length > 0) {
    ownershipFailures.push(`${s.step}: competing generic families [${competitors.join(',')}]`)
  }
  if (s.tileUrlHasToken === true && (mvt.source ?? 0) === 0) {
    dataFailures.push(`${s.step}: filter token set but the tile source returned 0 features`)
  }
}

const baseline = steps.find((s) => s.step === 'baseline')
const returned = steps.find((s) => s.step === 'leave-and-return')
if (baseline && returned && baseline.owner !== returned.owner) {
  ownershipFailures.push(`leave/return changed owner: ${baseline.owner} -> ${returned.owner}`)
}

console.log('\n── VERDICT ──')
console.log(ownershipFailures.length === 0
  ? 'Master Filter render ownership: PASS (same owner across enter/zoom/change/select/clear/leave)'
  : `Master Filter render ownership: FAIL\n  ${ownershipFailures.join('\n  ')}`)
console.log(dataFailures.length === 0
  ? 'Master Filter scoped data: PASS'
  : `Master Filter scoped data: BLOCKED — filtered tile route unavailable\n  ${dataFailures.join('\n  ')}`)

const failures = [...ownershipFailures, ...dataFailures]
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ steps, failures }, null, 2))
console.log(`\nscreenshots: ${OUT}`)
await browser.close()
