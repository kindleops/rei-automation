import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * DESKTOP INBOX — list + open conversation proof (READ ONLY: non-GET /api aborted,
 * so opening a thread cannot mark it read or send anything).
 *   node scripts/proof/desktop/desktop-inbox-capture.mjs --theme=dark --width=1440
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const WIDTH = Number(arg('width', 1440))
const HEIGHT = Number(arg('height', 900))
const THEME = arg('theme', 'dark')
const OUT = path.resolve(arg('out', 'artifacts/desktop-inbox'))
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
await ctx.addInitScript((t) => {
  if (sessionStorage.getItem('proof.seeded')) return
  sessionStorage.setItem('proof.seeded', '1')
  const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
  localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
  localStorage.removeItem('nexus.desktop.split')
  localStorage.removeItem('nexus.desktop.shell')
}, THEME)
const page = await ctx.newPage()
const errors = []; const blocked = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const tag = `${THEME}-${WIDTH}`
const R = {}
await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.dsk-side', { timeout: 90000 })
const t0 = Date.now()
await page.waitForSelector('.nx-row25', { timeout: 300000 }).catch(() => {})
R.listMs = Date.now() - t0
await page.waitForTimeout(1500)
R.rows = await page.locator('.nx-row25').count()
await page.screenshot({ path: `${OUT}/${tag}-list.png` })
if (R.rows) {
  await page.locator('.nx-row25').first().click()
  await page.waitForSelector('.nx-msg__bubble, .nx-composer', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(2500)
  R.bubbles = await page.locator('.nx-msg__bubble').count()
  R.selectedRows = await page.locator('.nx-row25.is-selected').count()
  R.layout = await page.evaluate(() => {
    const box = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height), disp: getComputedStyle(el).display } }
    return { list: box('.nx-workspace-pane.is-view-thread'), conv: box('.nx-workspace-pane.is-view-sms_thread'), composer: box('.nx-composer-dock'), overflowX: document.documentElement.scrollWidth - innerWidth }
  })
  await page.screenshot({ path: `${OUT}/${tag}-thread.png` })
  await page.locator('.nx-composer-dock__input-wrap textarea').first().click().catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/${tag}-composer-focus.png`, clip: { x: Math.max(0, WIDTH - 1000), y: HEIGHT - 260, width: Math.min(1000, WIDTH), height: 260 } })
}
R.errors = errors; R.blocked = blocked
await fs.writeFile(`${OUT}/${tag}-results.json`, JSON.stringify(R, null, 2))
console.log(JSON.stringify(R, null, 1))
await browser.close()
