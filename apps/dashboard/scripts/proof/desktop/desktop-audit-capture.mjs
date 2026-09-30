import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * DESKTOP AUDIT — every app route at desktop widths (READ ONLY: non-GET /api aborted).
 *   node scripts/proof/desktop/desktop-audit-capture.mjs --width=1440 --theme=dark --routes=home,inbox
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const WIDTH = Number(arg('width', 1440))
const HEIGHT = Number(arg('height', 900))
const THEME = arg('theme', 'dark')
const OUT = path.resolve(arg('out', 'artifacts/desktop-audit'))
const ROUTES = arg('routes', 'home,inbox,email-command,deal-intelligence,entity-graph,comp-intelligence,buyer-match,pipeline,queue,campaign-command,workflow-studio,closing-desk,calendar,analytics,map').split(',')
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
await ctx.addInitScript((t) => { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
const blocked = []; const errors = []
page.on('pageerror', (e) => errors.push(`${page.url()} :: ${String(e.message).slice(0, 160)}`))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const R = {}
for (const route of ROUTES) {
  try {
    await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(route === 'map' ? 8000 : 3500)
    R[route] = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - innerWidth,
      title: document.querySelector('h1, h2')?.textContent?.trim().slice(0, 60) || null,
      mobileSurface: Boolean(document.querySelector('[class*="mobile"], [data-mobile]')),
    }))
    await page.screenshot({ path: `${OUT}/${THEME}-${WIDTH}-${route}.png` })
    console.log('shot', route, JSON.stringify(R[route]))
  } catch (e) { console.log('FAIL', route, String(e.message).slice(0, 120)) }
}
R.errors = errors; R.blocked = blocked
await fs.writeFile(`${OUT}/${THEME}-${WIDTH}-results.json`, JSON.stringify(R, null, 2))
await browser.close()
