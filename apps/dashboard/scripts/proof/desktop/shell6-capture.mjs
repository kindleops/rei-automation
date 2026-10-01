import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * DESKTOP SHELL 6.0 journey capture (READ ONLY — every non-GET to /api or
 * Supabase is aborted). Drives the real pointer: drags apps from the command
 * rail into the workspace, stacks, maximizes, opens the workspace selector,
 * closes a pane and runs a workspace command from ⌘K.
 *
 *   node scripts/proof/desktop/shell6-capture.mjs --theme=dark --size=1600x1000 --out=/tmp/shell6
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/shell6'))
const THEME = arg('theme', 'dark')
const [W, H] = arg('size', '1600x1000').split('x').map(Number)
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H }, serviceWorkers: 'block' })
await ctx.addInitScript((t) => {
  try {
    // a clean workspace once per run; a reload mid-run must restore, not reset
    if (!sessionStorage.getItem('__shell6_capture')) { sessionStorage.clear(); sessionStorage.setItem('__shell6_capture', '1') }
    localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
    const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    const p = JSON.parse(localStorage.getItem('nexus.desktop.shell') || '{}')
    localStorage.setItem('nexus.desktop.shell', JSON.stringify({ ...p, collapsed: false }))
  } catch { /* ignore */ }
}, THEME)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 220)))
await page.route('**/*', (r) => { const q = r.request(); const u = new URL(q.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return r.abort(); return r.continue() })
const dog = setTimeout(() => { console.log('WATCHDOG', JSON.stringify(errors)); process.exit(2) }, 540000)
const shot = (name) => page.screenshot({ path: path.join(OUT, `${THEME}-${W}-${name}.png`) })
const wait = (ms) => page.waitForTimeout(ms)

const paneRect = async (app) => page.evaluate((a) => {
  const panes = [...document.querySelectorAll('[data-ws-pane]')]
  const hit = panes.find((p) => p.getAttribute('aria-label') === a) ?? panes[0]
  const r = hit.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}, app)

async function dragRow(appId, to, opts = {}) {
  const row = page.locator(`.cr-row[data-app="${appId}"]`)
  const b = await row.boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 + 6, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 18 })
  await wait(350)
  if (opts.shot) await shot(opts.shot)
  await page.mouse.up()
  await wait(900)
}

await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180000 })
await page.waitForSelector('.cd', { timeout: 180000 })
await page.waitForSelector('[data-ws-pane]', { timeout: 180000 })
await wait(9000)
await shot('01-deck-rest')

// Deal Intelligence beside Inbox (right edge)
let r = await paneRect('Inbox')
await dragRow('deal-intelligence', { x: r.x + r.w - 40, y: r.y + r.h / 2 }, { shot: '02-drag-di-right' })
await wait(4000)
await shot('03-inbox-di')

// Map below Deal Intelligence
r = await paneRect('Deal Intelligence')
await dragRow('map', { x: r.x + r.w / 2, y: r.y + r.h - 30 }, { shot: '04-drag-map-below' })
await wait(5000)
await shot('05-three-panes')

// Comps into the Deal Intelligence stack (centre)
r = await paneRect('Deal Intelligence')
await dragRow('comp-intelligence', { x: r.x + r.w / 2, y: r.y + r.h / 2 }, { shot: '06-drag-comps-stack' })
await wait(4000)
await shot('07-stacked')

// maximize the map pane, then restore
const mapPane = page.locator('[data-ws-pane][aria-label="Map"]')
await mapPane.locator('button[aria-label="Maximize pane"]').click().catch(() => {})
await wait(1200)
await shot('08-map-maximized')
await mapPane.locator('button[aria-label="Restore layout"]').click().catch(() => {})
await wait(1200)

// the workspace selector
await page.locator('.cd-ws').click()
await wait(700)
await shot('09-workspace-selector')
await page.keyboard.press('Escape')
await wait(400)

// close the map: it resolves back toward the rail
await mapPane.locator('button[aria-label="Close Map"]').click().catch(() => {})
await wait(140)
await shot('10-closing')
await wait(1100)
await shot('11-closed')

// ⌘K — a workspace command
await page.keyboard.press('Meta+k')
await wait(500)
await page.keyboard.type('map beside', { delay: 25 })
await wait(1200)
await shot('12-command-map-beside')
await page.keyboard.press('Escape')

clearTimeout(dog)
console.log(JSON.stringify({ errors: errors.slice(0, 8) }))
await browser.close()
