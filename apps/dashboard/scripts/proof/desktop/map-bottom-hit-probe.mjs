/**
 * Static hit-test probe for the desktop Map's bottom chrome (legend strip).
 * Loads the REAL map stylesheets into a hand-built `.mx.is-desk` DOM (no app,
 * no network, no dev server) and reports, for each probe point, which element
 * receives the pointer: the map canvas, or a piece of chrome.
 *
 *   node scripts/proof/desktop/map-bottom-hit-probe.mjs [--w=1440] [--h=830] [--lens=stage|value]
 */
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d
const W = Number(arg('w', '1440'))
const H = Number(arg('h', '830'))
const LENS = arg('lens', 'stage')
const src = resolve(new URL('../../../src', import.meta.url).pathname)
const css = ['views/map/mobile/map-mobile.css', 'views/map/map-desktop.css', 'views/map/desktop/map-desk.css', 'views/map/desktop/context/map-context.css']
  .map((p) => `<link rel="stylesheet" href="${pathToFileURL(join(src, p)).href}">`).join('\n')

const stageBody = `
  <div class="mxd-legend__stages">${['Uncontacted', 'Ownership check', 'Talking', 'Negotiating', 'Hot', 'Follow-up'].map((l) => `<span><i></i>${l}</span>`).join('')}</div>
  <p class="mxd-legend__src"><span>Ring = stage · worked and hot properties glow</span></p>`
const valueBody = `
  <div class="mxd-legend__ramp"><span class="mxd-legend__end">≤ $50K</span><div class="mxd-legend__bar"><i></i></div><span class="mxd-legend__end">$900K+</span></div>
  <div class="mxd-legend__look"><div class="mxd-seg is-xs"><button class="mxd-seg__tab is-on">Dots</button><button class="mxd-seg__tab">Surface</button><button class="mxd-seg__tab">Areas</button></div></div>
  <p class="mxd-legend__src"><span>12,402 cells</span><span>click the colour to read it</span></p>`
const sun = `
  <div class="mxd-legend__sun" data-legend="sun"><span class="mxd-legend__sun-end">Day</span><span class="mxd-legend__sun-ramp"><i></i></span><span class="mxd-legend__sun-end">Night</span>
  <span class="mxd-legend__bound-src">Sun’s real position · now</span><span class="mxd-legend__sun-attr">City lights: NASA Black Marble 2016 (VIIRS) via NASA GIBS</span></div>`

const html = `<!doctype html><html class="is-desktop-modern" data-nexus-theme="dark"><head><meta charset="utf-8">${css}
<style>html,body{margin:0;height:100%;background:#111}#pane{position:relative;width:${W}px;height:${H}px;overflow:hidden}#canvas{position:absolute;inset:0;background:#223}</style></head>
<body><div id="pane"><div id="canvas" data-probe="canvas"></div>
<div class="mx is-desk">
  <div class="mxd-cards">
    <section class="mxd-legend ${LENS === 'value' ? 'is-value' : 'is-stage'}" data-map-card="legend">
      <button class="mxd-legend__chip mxd-l2"><span>Legend</span></button>
      <div class="mxd-legend__panel mxd-l2">
        <button class="mxd-legend__pick"><span class="mxd-legend__swatch"></span><strong>Acquisition Radar</strong></button>
        <div class="mxd-legend__body">${LENS === 'value' ? valueBody : stageBody}${sun}</div>
        <button class="mxd-icon-btn is-xs mxd-legend__fold">v</button>
      </div>
    </section>
  </div>
  <div class="mxd-stack"><div class="mxd-stack__search" style="height:32px"></div>
    <div class="mxd-stack__row"><div class="mxd-stack__lens"><button class="mxd-lens mxd-l2" style="width:420px;height:32px">lens</button></div>
      <button class="mxd-capsule mxd-l2" style="width:520px">filters</button><button class="mxd-capsule mxd-l2" style="width:520px">comps</button></div></div>
  <div class="mxd-zoom mxd-l2"><button class="mxd-tool">+</button><button class="mxd-tool">-</button></div>
  <div class="mx-overlay-host"></div>
</div></div></body></html>`

const dir = mkdtempSync(join(tmpdir(), 'mxprobe-'))
const file = join(dir, 'probe.html')
writeFileSync(file, html)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: W, height: H } })
await page.goto(pathToFileURL(file).href)
await page.waitForTimeout(700)
const out = await page.evaluate(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }
  const panel = document.querySelector('.mxd-legend__panel')
  const body = document.querySelector('.mxd-legend__body')
  // the union of what is actually drawn inside the panel (text runs, swatches, buttons)
  const leaves = [...panel.querySelectorAll('*')].filter((e) => e.children.length === 0 || e.tagName === 'BUTTON')
  let ink = null
  for (const e of leaves) { const b = e.getBoundingClientRect(); if (!b.width || !b.height) continue; ink = ink ? [Math.min(ink[0], b.left), Math.min(ink[1], b.top), Math.max(ink[2], b.right), Math.max(ink[3], b.bottom)] : [b.left, b.top, b.right, b.bottom] }
  const hit = (x, y) => { const t = document.elementFromPoint(x, y); return t?.dataset?.probe === 'canvas' ? 'canvas' : `${t?.tagName}.${String(t?.className).split(' ')[0]}` }
  if (!ink) return { compact: true, legend: r(document.querySelector('.mxd-legend')) }
  const pb = panel.getBoundingClientRect()
  const probes = {}
  for (const [k, x, y] of [
    ['right of ink, mid-panel', Math.round(ink[2] + 40), Math.round((pb.top + pb.bottom) / 2)],
    ['just above panel', Math.round(pb.left + 40), Math.round(pb.top - 4)],
    ['just right of panel', Math.round(pb.right + 6), Math.round(pb.bottom - 10)],
    ['inside ink', Math.round(pb.left + 20), Math.round(pb.top + 14)],
  ]) probes[k] = { x, y, hit: hit(x, y) }
  // the command stack: a wrapped pill row spans the stack's max-width; its empty tail must be map
  const row = document.querySelector('.mxd-stack__row')
  const caps = [...row.children].map((c) => c.getBoundingClientRect())
  const last = caps[caps.length - 1]
  probes['stack row tail'] = { x: Math.round(last.right + 30), y: Math.round(last.top + last.height / 2), hit: hit(last.right + 30, last.top + last.height / 2), row: r(row) }
  return { cards: r(document.querySelector(".mxd-cards")), legend: r(document.querySelector(".mxd-legend")), panel: r(panel), body: r(body), ink: ink && ink.map(Math.round), probes }
})
console.log(JSON.stringify({ W, H, LENS, ...out }))
await browser.close()
// contract: outside the visible glass the map canvas receives the pointer; inside it, the chrome does
const want = { 'right of ink, mid-panel': 'canvas', 'just above panel': 'canvas', 'just right of panel': 'canvas', 'stack row tail': 'canvas' }
const bad = out.compact ? [] : Object.entries(want).filter(([k, v]) => out.probes[k] && (out.probes[k].row && out.probes[k].x >= W ? false : out.probes[k].hit !== v))
if (!out.compact && out.probes['inside ink'].hit === 'canvas') bad.push(['inside ink', 'chrome'])
if (bad.length) { console.error('FAIL', JSON.stringify(bad)); process.exit(1) }
console.log('PASS')
