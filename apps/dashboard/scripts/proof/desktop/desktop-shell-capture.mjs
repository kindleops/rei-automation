import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * DESKTOP COMMAND CENTER — shell proof (READ ONLY: non-GET /api aborted).
 *   node scripts/proof/desktop/desktop-shell-capture.mjs --theme=dark --width=1440
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const WIDTH = Number(arg('width', 1440))
const HEIGHT = Number(arg('height', 900))
const THEME = arg('theme', 'dark')
const OUT = path.resolve(arg('out', 'artifacts/desktop-shell'))
const ROUTES = arg('routes', 'home,inbox,pipeline').split(',')
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
await ctx.addInitScript((t) => { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t })); localStorage.removeItem('nexus.desktop.shell') }, THEME)
const page = await ctx.newPage()
const errors = []; const blocked = []
page.on('pageerror', (e) => errors.push(`${page.url()} :: ${String(e.message).slice(0, 180)}`))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const tag = `${THEME}-${WIDTH}`
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); console.log('shot', name) }
const R = {}
for (const route of ROUTES) {
  await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.dsk-side', { timeout: 60000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(3000)
  R[route] = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth - innerWidth, side: Boolean(document.querySelector('.dsk-side')), active: document.querySelector('.dsk-side__item.is-active')?.textContent || null, phoneDock: getComputedStyle(document.querySelector('.nx-mobile-command-dock') || document.body).display }))
  await shot(route)
}
// command search
await page.locator('.dsk-cmd__field input').click()
await page.keyboard.type('minneapolis', { delay: 40 })
await page.waitForTimeout(2500)
await shot('search')
R.searchRows = await page.locator('.dsk-cmd__item').count()
await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
// queue + profile
await page.locator('.dsk-top__btn--queue').click(); await page.waitForTimeout(900); await shot('queue')
await page.keyboard.press('Escape')
await page.locator('.dsk-top__profile').click(); await page.waitForTimeout(900); await shot('profile')
await page.keyboard.press('Escape')
// collapse
await page.locator('.dsk-side').hover(); await page.locator('.dsk-side__fold').click(); await page.waitForTimeout(800)
await page.locator('.dsk-side__item').nth(2).hover(); await page.waitForTimeout(400)
await shot('collapsed')
R.errors = errors; R.blocked = blocked
await fs.writeFile(`${OUT}/${tag}-results.json`, JSON.stringify(R, null, 2))
console.log(JSON.stringify(R, null, 1))
await browser.close()
