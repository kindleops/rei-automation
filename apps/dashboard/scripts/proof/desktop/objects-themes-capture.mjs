import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * SENDER ROUTING 2.0 §E — universal objects in True Black + Red Ops
 * (READ ONLY). Every non-GET to /api or Supabase is aborted; nothing is
 * clicked that writes (no Send / Ownership Check / Launch).
 *
 *   node scripts/proof/desktop/objects-themes-capture.mjs --out=/tmp/x [--themes=true_black,red_ops] [--widths=1440,1920]
 *
 * Real production-shaped data through the local API (GET only). The subject is
 * a real property (3635 Emerson Ave N, Minneapolis — property 273312064).
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/r82'))
const THEMES = arg('themes', 'true_black,red_ops').split(',')
const PID = arg('pid', '273312064')
const WIDTHS = arg('widths', '1440,1920').split(',').map(Number)
await fs.mkdir(OUT, { recursive: true })
const log = { blockedWrites: [], errors: [], notes: [] }
const flush = () => fs.writeFile(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2))
const watchdog = setTimeout(async () => { console.log('WATCHDOG'); await fs.writeFile(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2)); process.exit(2) }, 600_000)
const browser = await chromium.launch()

async function open(theme, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } })
  await ctx.addInitScript((t) => {
    try {
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      sessionStorage.removeItem('lc.workspace.session.v1')
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => log.errors.push(`${theme}: ${String(e.message).slice(0, 200)}`))
  await page.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { log.blockedWrites.push(`${req.method()} ${u.pathname}`); return r.abort() }
    return r.continue()
  })
  return { ctx, page }
}
const shot = (page, name, clip) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) })
const mapReady = (page) => page.waitForFunction(() => { const m = window.__nxMap; return Boolean(m && m.isStyleLoaded && m.isStyleLoaded()) }, null, { timeout: 120000 })
const cam = (page) => page.evaluate(() => { const m = window.__nxMap; if (!m) return null; const c = m.getCenter(); return { lng: +c.lng.toFixed(4), lat: +c.lat.toFixed(4), z: +m.getZoom().toFixed(2) } })

for (const theme of THEMES) for (const w of WIDTHS) {
  const h = w >= 1920 ? 1080 : 900
  const { ctx, page } = await open(theme, w, h)
  const tag = `${theme}-${w}`
  await page.goto(`${BASE}/comp-intelligence?property_id=${PID}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.ciw-strip:not(.is-skeleton)', { timeout: 120000 }).catch(() => log.notes.push(`${tag}: comps strip not ready`))
  await page.waitForTimeout(3000)
  const row = page.locator('[data-comp-row]').first()
  if (await row.count()) {
    // the canonical object menu (right-click a comp row)
    await row.click({ button: 'right' })
    await page.waitForTimeout(700)
    await shot(page, `${tag}-01-object-menu`)
    log.notes.push({ tag, menu: await page.evaluate(() => { const m = document.querySelector('[role="menu"]'); if (!m) return null; const cs = getComputedStyle(m); return { bg: cs.backgroundColor, color: cs.color, border: cs.borderColor, items: [...m.querySelectorAll('[role="menuitem"]')].map((i) => ({ t: i.textContent?.trim(), c: getComputedStyle(i).color })) } }) })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    // the Universal Inspector (shift-click)
    await row.click({ modifiers: ['Shift'] })
    await page.waitForSelector('.lc-insp.uinsp', { timeout: 20000 }).catch(() => log.notes.push(`${tag}: inspector did not open`))
    await page.waitForTimeout(2500)
    await shot(page, `${tag}-02-inspector`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  } else log.notes.push(`${tag}: no comp rows`)
  // Show on Map -> the Map opens beside and focuses the property (focus treatment)
  await page.getByRole('button', { name: 'Open the subject and set in Map' }).click().catch(() => log.notes.push(`${tag}: no Show on Map button`))
  await mapReady(page).catch(() => log.notes.push(`${tag}: map not ready`))
  await page.waitForTimeout(8000)
  await shot(page, `${tag}-03-map-focus`)
  log.notes.push({ tag, cam: await cam(page) })
  await flush()
  await ctx.close()
}

await browser.close()
clearTimeout(watchdog)
log.threadStateWritesAttempted = log.blockedWrites.filter((x) => /thread-state|\/inbox\/threads\//.test(x))
await fs.writeFile(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2))
console.log(JSON.stringify(log, null, 2).slice(0, 5000))
