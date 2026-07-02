#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'https://ops.leadcommand.ai'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const resolveSecret = () => {
  if (process.env.VITE_OPS_DASHBOARD_SECRET) return process.env.VITE_OPS_DASHBOARD_SECRET
  if (process.env.OPS_DASHBOARD_SECRET) return process.env.OPS_DASHBOARD_SECRET
  try {
    const match = readFileSync(resolve(ROOT, '.env.local'), 'utf8').match(/^VITE_OPS_DASHBOARD_SECRET=(.+)$/m)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

const secret = resolveSecret()
const session = secret
  ? createHash('sha256').update(`ops-dashboard:${secret}`, 'utf8').digest('hex')
  : ''

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
if (session) {
  await context.addCookies([{
    name: 'ops_dashboard_session',
    value: session,
    domain: new URL(BASE).hostname,
    path: '/',
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
  }])
}

const page = await context.newPage()
const logs = []
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`))
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`))

const tileResponses = []
page.on('response', async (res) => {
  const url = res.url()
  if (url.includes('/api/internal/dashboard/ops/map/tiles/') || url.includes('/map/tiles/')) {
    const ct = res.headers()['content-type'] || ''
    let bodyPreview = ''
    try {
      const buf = await res.body()
      bodyPreview = `bytes=${buf.length}`
      if (ct.includes('json')) bodyPreview += ` ${buf.toString('utf8').slice(0, 120)}`
    } catch { /* ignore */ }
    tileResponses.push({ status: res.status(), ct, bodyPreview, url: url.slice(0, 120) })
  }
})

await page.addInitScript(() => {
  localStorage.setItem('nx.map.diagnostics.debug', '1')
  localStorage.setItem('nx.map.verification.mode', '1')
  localStorage.setItem('nexus.commandMap.sellerPinSettings.v3', JSON.stringify({
    sellerPins: true,
    notContacted: true,
    contacted: true,
    newReplies: true,
    positive: true,
    negotiating: true,
    hot: true,
    issues: true,
    blocked: true,
    queued: true,
    scheduled: true,
    ready: true,
    activeSending: true,
    sent: true,
    delivered: true,
    failedIssue: true,
  }))
})

console.log('Opening', `${BASE}/map?mapDiagnostics=1`)
await page.goto(`${BASE}/map?mapDiagnostics=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.nx-icm__canvas, region[aria-label="Map"]', { timeout: 120000 })

// NC proof property
await page.waitForFunction(() => Boolean(window.__nexusCommandMap), null, { timeout: 120000 })
await page.evaluate(() => new Promise((resolve) => {
  const map = window.__nexusCommandMap
  map.jumpTo({ center: [-77.966748, 35.645544], zoom: 14 })
  map.once('idle', resolve)
  setTimeout(resolve, 8000)
}))

await page.waitForTimeout(5000)

const report = await page.evaluate(() => {
  const map = window.__nexusCommandMap
  const diag = window.__nexusMapDiagnostics || null
  const layers = [
    'prop-tiles-icon', 'prop-tiles-hit', 'seller-pins-icon', 'seller-pins-hit',
    'command-pin-icon-raw', 'prop-univ-markers', 'seller-pins-ring',
  ]
  const layerState = {}
  for (const id of layers) {
    try {
      layerState[id] = {
        exists: Boolean(map.getLayer(id)),
        visibility: map.getLayer(id) ? map.getLayoutProperty(id, 'visibility') : null,
      }
    } catch (e) {
      layerState[id] = { error: String(e) }
    }
  }

  const icons = ['nexus-pin-sfr', 'nexus-pin-multi', 'nexus-pin-default', 'nexus-pin-apt']
  const iconState = Object.fromEntries(icons.map((id) => [id, map.hasImage(id)]))

  const sellerSource = map.getSource('seller-pins-source')
  let sellerFeatures = 0
  try {
    sellerFeatures = map.querySourceFeatures('seller-pins-source').length
  } catch { /* ignore */ }

  let tileFeatures = 0
  try {
    tileFeatures = map.querySourceFeatures('property-map-tiles', { sourceLayer: 'properties' }).length
  } catch { /* ignore */ }

  const rendered = {}
  for (const id of ['prop-tiles-icon', 'seller-pins-icon', 'command-pin-icon-raw']) {
    try {
      rendered[id] = map.queryRenderedFeatures(undefined, { layers: [id] }).length
    } catch {
      rendered[id] = -1
    }
  }

  return {
    zoom: map.getZoom(),
    center: map.getCenter(),
    diag,
    layerState,
    iconState,
    sellerFeatures,
    tileFeatures,
    rendered,
    styleLoaded: map.isStyleLoaded(),
  }
})

console.log('\n=== MAP PRODUCTION DIAGNOSTIC ===')
console.log(JSON.stringify(report, null, 2))
console.log('\n=== TILE HTTP RESPONSES ===')
console.log(JSON.stringify(tileResponses.slice(0, 12), null, 2))
console.log('\n=== CONSOLE (last 20) ===')
console.log(logs.slice(-20).join('\n'))

await page.screenshot({ path: resolve(ROOT, 'proof/map-production-diagnostic.png'), fullPage: false })
console.log('\nScreenshot:', resolve(ROOT, 'proof/map-production-diagnostic.png'))

await browser.close()