import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * COMP INTELLIGENCE 5.0 capture (READ ONLY). Every non-GET to /api or Supabase
 * is aborted, so no click here can write. Include / exclude only change the
 * browser-session operator set.
 *
 *   node scripts/proof/desktop/comp-intelligence-capture.mjs \
 *     --out=/tmp/ci --themes=dark,light --sizes=1440x900 --subject=273448158 \
 *     --scenes=evidence,valuation,compare,market,model,operator,excluded,inspector
 *
 * --before=1 captures whatever /comp-intelligence renders today (no .ciw wait).
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/comp-intelligence'))
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const SUBJECT = arg('subject', '273448158')
const SCENES = arg('scenes', 'evidence').split(',')
const BEFORE = arg('before', '') === '1'
const TAG = arg('tag', '')
const ROUTE = arg('route', `/comp-intelligence?property_id=${SUBJECT}`)
await fs.mkdir(OUT, { recursive: true })

const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 25 * 60_000)
const browser = await chromium.launch()
const results = []
for (const theme of THEMES) {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
    await ctx.addInitScript((t) => {
      try {
        localStorage.removeItem('nexus.desktop.split')
        localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
        const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
        for (const k of Object.keys(sessionStorage)) if (k.startsWith('lc.comps.operator')) sessionStorage.removeItem(k)
      } catch { /* ignore */ }
    }, theme)
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 220)))
    // fan-out proof: every Street View image request the page makes
    let streetview = 0
    page.on('request', (q) => { if (q.url().includes('/maps/api/streetview')) streetview += 1 })
    await page.route('**/*', (r) => {
      const req = r.request()
      const u = new URL(req.url())
      if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.abort()
      return r.continue()
    })
    const name = (scene) => path.join(OUT, `${TAG ? `${TAG}-` : ''}${theme}-${W}-${scene}.png`)
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
    if (BEFORE) {
      await page.waitForFunction(() => !document.querySelector('.cev-boot') && (document.querySelector('.cev') || document.querySelector('.ci-workspace')), null, { timeout: 240_000 }).catch(() => console.log('before: still loading'))
      await page.waitForTimeout(5000)
      await page.screenshot({ path: name('before') })
      results.push({ theme, W, scene: 'before', errors: errors.slice(0, 4) })
      await ctx.close()
      continue
    }
    await page.waitForSelector('.ciw', { timeout: 180_000 })
    if (SCENES.includes('loading')) {
      await page.waitForTimeout(600)
      await page.screenshot({ path: name('loading') })
    }
    await page.waitForFunction(() => document.querySelector('.ciw')?.getAttribute('data-state') !== 'resolving', null, { timeout: 240_000 }).catch(() => console.log('still resolving'))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await page.evaluate(() => document.querySelector('.ciw')?.getAttribute('data-state'))
      if (state !== 'error') break
      await page.screenshot({ path: name('error') })
      console.log('error state captured; retrying')
      await page.locator('.ciw .lc-error button').first().click().catch(() => {})
      await page.waitForFunction(() => document.querySelector('.ciw')?.getAttribute('data-state') === 'ready', null, { timeout: 300_000 }).catch(() => console.log('retry did not resolve'))
    }
    await page.waitForFunction(() => document.querySelector('.ciw-map')?.getAttribute('data-map') === 'ready', null, { timeout: 60_000 }).catch(() => console.log('map not ready'))
    await page.waitForTimeout(2500)
    const tab = async (label) => { await page.locator('.ciw-plane [role="tab"]', { hasText: label }).first().click(); await page.waitForTimeout(900) }
    for (const scene of SCENES) {
      if (scene === 'loading') continue
      try {
        if (scene === 'evidence') { await tab('Evidence') }
        else if (scene === 'valuation') { await tab('Valuation') }
        else if (scene === 'compare') { await tab('Compare') }
        else if (scene === 'market') { await tab('Market') }
        else if (scene === 'model') { await tab('Model') }
        else if (scene === 'excluded') { await tab('Evidence'); await page.locator('[data-section="excluded"] .ciw-sec__head').first().click(); await page.waitForTimeout(500); await page.locator('[data-section="excluded"]').first().scrollIntoViewIfNeeded() }
        else if (scene === 'operator') {
          await tab('Evidence')
          const rows = page.locator('[data-section="set"] [data-comp-row]')
          await rows.nth(0).hover(); await page.waitForTimeout(250)
          await rows.nth(0).locator('[data-act="exclude"]').click(); await page.waitForTimeout(900)
          const cand = page.locator('[data-section="candidates"] [data-comp-row]')
          await cand.nth(0).hover(); await page.waitForTimeout(250)
          await cand.nth(0).locator('[data-act="include"]').click(); await page.waitForTimeout(1200)
        } else if (scene === 'operator-valuation') { await tab('Valuation') }
        else if (scene === 'inspector') { await tab('Evidence'); await page.locator('[data-section="set"] [data-comp-row]').nth(1).click(); await page.waitForTimeout(1200) }
        else if (scene === 'hover') {
          await page.locator('[data-section="set"] [data-comp-row]').nth(2).hover(); await page.waitForTimeout(700)
        } else if (scene === 'saletype') {
          await tab('Evidence')
          await page.locator('.ciw-saletype[data-type="investor"]').first().click({ timeout: 8000 }); await page.waitForTimeout(900)
          await page.locator('[data-section="candidates"]').first().scrollIntoViewIfNeeded(); await page.waitForTimeout(1500)
        } else if (scene === 'strict') { await tab('Evidence'); await page.locator('[data-preset="strict"]').click(); await page.waitForTimeout(900) }
        else if (scene === 'mode-ppsf') { await page.locator('.ciw-maplens [data-seg="ppsf"]').click(); await page.waitForTimeout(1200) }
        else if (scene === 'mode-recency') { await page.locator('.ciw-maplens [data-seg="recency"]').click(); await page.waitForTimeout(1200) }
        await page.screenshot({ path: name(scene) })
        results.push({ theme, W, scene, streetviewSoFar: streetview, rows: await page.locator('[data-comp-row]').count() })
      } catch (e) {
        results.push({ theme, W, scene, failed: String(e.message).slice(0, 200) })
      }
    }
    results.push({ theme, W, errors: errors.slice(0, 6) })
    await ctx.close()
  }
}
await browser.close()
clearTimeout(watchdog)
console.log(JSON.stringify(results, null, 1))
