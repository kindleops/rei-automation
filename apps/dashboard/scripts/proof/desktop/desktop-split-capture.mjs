import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * SPLIT WORKSPACE proof (READ ONLY). Opens apps beside the main pane through the
 * sidebar's own split buttons, then resizes with a divider.
 *   node scripts/proof/desktop/desktop-split-capture.mjs --width=1440 --height=900
 *   node scripts/proof/desktop/desktop-split-capture.mjs --width=5120 --height=1440 --scale=0.5
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const W = Number(arg('width', 1440)); const H = Number(arg('height', 900)); const SCALE = Number(arg('scale', 1))
const OUT = path.resolve(arg('out', 'artifacts/desktop-split'))
const APPS = arg('apps', 'Map,Pipeline,Deal Intelligence').split(',')
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE })
await ctx.addInitScript(() => { localStorage.removeItem('nexus.desktop.split'); localStorage.setItem('nexus.desktop.ultrawide.seeded', '1'); const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: 'dark' })) })
const page = await ctx.newPage()
const errors = []; const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const tag = `${W}x${H}`
await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.dsk-side', { timeout: 60000 })
await page.waitForTimeout(4000)
for (const label of APPS) {
  const item = page.locator('.dsk-side__item', { hasText: label }).first()
  await item.hover(); await page.waitForTimeout(250)
  await item.locator('.dsk-side__split').click()
  await page.waitForTimeout(3500)
}
await page.waitForTimeout(6000)
await page.screenshot({ path: `${OUT}/${tag}-split-${APPS.length + 1}.png` })
const info = await page.evaluate(() => ({
  panes: [...document.querySelectorAll('.dsk-pane')].map((p) => ({ label: p.getAttribute('aria-label'), w: Math.round(p.getBoundingClientRect().width), focused: p.classList.contains('is-focused') })),
  errorsShown: [...document.querySelectorAll('.dsk-pane')].map((p) => (p.textContent || '').includes('crashed')),
}))
console.log(JSON.stringify(info))
// drag the first divider to the right (inbox grows)
const div = page.locator('.dsk-divider').first()
if (await div.count()) {
  const b = await div.boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down()
  await page.mouse.move(b.x + 400, b.y + b.height / 2, { steps: 10 }); await page.mouse.up()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/${tag}-resized.png` })
  console.log('after drag', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.dsk-pane')].map((p) => Math.round(p.getBoundingClientRect().width)))))
}
console.log(JSON.stringify({ errors, blocked }))
await browser.close()
