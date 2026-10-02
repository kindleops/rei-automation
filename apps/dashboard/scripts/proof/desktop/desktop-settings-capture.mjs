import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * DESKTOP SETTINGS — page proof (READ ONLY: non-GET /api aborted).
 *   node scripts/proof/desktop/desktop-settings-capture.mjs --theme=dark --width=1440
 * Captures every section, the page inside a split pane, and checks the ways in
 * (sidebar row, ⌘,, profile footer, search) plus that ⌘V is no longer cancelled
 * inside a field.
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const WIDTH = Number(arg('width', 1440))
const HEIGHT = Number(arg('height', 900))
const THEME = arg('theme', 'dark')
const OUT = path.resolve(arg('out', 'artifacts/desktop-settings'))
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
await ctx.addInitScript((t) => {
  if (sessionStorage.getItem('proof.seeded')) return
  sessionStorage.setItem('proof.seeded', '1')
  const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
  localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
  localStorage.removeItem('nexus.desktop.shell')
  localStorage.removeItem('nexus.desktop.split')
}, THEME)
const page = await ctx.newPage()
const errors = []; const blocked = []
page.on('pageerror', (e) => errors.push(`${page.url()} :: ${String(e.message).slice(0, 180)}`))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const tag = `${THEME}-${WIDTH}`
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${tag}-${name}.png` }); console.log('shot', name) }
const R = {}

await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.dsk-bd', { timeout: 90000 })
await page.waitForTimeout(2500)

// ⌘V inside a field must reach the field (it used to be cancelled globally).
R.pasteDefaultPrevented = await page.evaluate(() => {
  const input = document.querySelector('.dsk-cmd__field input')
  input?.focus()
  const ev = new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true })
  input?.dispatchEvent(ev)
  input?.blur()
  return ev.defaultPrevented
})
await page.keyboard.press('Escape')
await page.mouse.click(WIDTH - 40, HEIGHT - 20)
await page.waitForTimeout(300)

// ⌘, opens Settings.
await page.keyboard.press('Meta+Comma')
await page.waitForSelector('.st', { timeout: 60000 })
R.cmdCommaPath = new URL(page.url()).pathname
await page.waitForTimeout(1200)
R.sidebarSettingsActive = await page.locator('.dsk-side__settings.is-active').count()

const sections = await page.locator('.st-nav__item').allTextContents()
R.sections = sections
for (let i = 0; i < sections.length; i++) {
  await page.locator('.st-nav__item').nth(i).click()
  await page.waitForTimeout(700)
  await shot(`s${i}-${sections[i].toLowerCase().replace(/[^a-z]+/g, '-')}`)
}
R.overflowX = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)

// Profile footer → All settings.
await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.dsk-side', { timeout: 60000 })
await page.waitForTimeout(1500)
await page.locator('.dsk-top__profile').click()
await page.waitForTimeout(600)
await shot('profile')
await page.locator('.dsk-prof__all').click()
await page.waitForSelector('.st', { timeout: 30000 })
R.profileAllSettingsPath = new URL(page.url()).pathname

// Search finds it.
await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.dsk-side', { timeout: 60000 })
await page.waitForTimeout(1200)
await page.locator('.dsk-cmd__field input').click()
await page.keyboard.type('settings', { delay: 30 })
await page.waitForTimeout(1800)
R.searchHasSettings = await page.locator('.dsk-cmd__item', { hasText: 'Open Settings' }).count()
await page.keyboard.press('Escape'); await page.keyboard.press('Escape')

// Settings in a narrow split pane beside the Map.
await page.evaluate(() => {
  localStorage.setItem('nexus.desktop.split', JSON.stringify({ panes: [{ id: 'p1', path: '/settings' }], sizes: [0.62, 0.38], focused: 'p1' }))
})
await page.goto(`${BASE}/map`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.dsk-side', { timeout: 60000 })
await page.waitForTimeout(5000)
R.paneSettings = await page.locator('.dsk-pane .st').count()
await shot('split-pane')

R.errors = errors; R.blocked = blocked
await fs.writeFile(`${OUT}/${tag}-results.json`, JSON.stringify(R, null, 2))
console.log(JSON.stringify(R, null, 1))
await browser.close()
