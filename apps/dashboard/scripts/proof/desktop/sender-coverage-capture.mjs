import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * SENDER COVERAGE capture (Sender Routing 2.0) — READ ONLY. Every non-GET to
 * /api or Supabase is aborted (the route-edit preview/save POSTs never leave).
 *   node scripts/proof/desktop/sender-coverage-capture.mjs --themes=dark,true_black --size=1440x900 --out=/tmp/sc
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/sender-coverage'))
const THEMES = arg('themes', 'dark').split(',')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 420_000)
const browser = await chromium.launch()
for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  const blocked = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', (r) => {
    const req = r.request(); const u = new URL(req.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return r.abort() }
    return r.continue()
  })
  await page.goto(`${BASE}/queue`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.locator('.qx-rail__tab', { hasText: 'Senders' }).first().click({ timeout: 120000 })
  const ready = await page.waitForSelector('.sc-head, .sc .lc-error', { timeout: 240000 }).then(() => true, () => false)
  if (!ready) {
    await page.screenshot({ path: path.join(OUT, `${theme}-${W}-not-ready.png`) })
    console.log(theme, 'panel not ready; errors:', errors, 'html:', (await page.locator('.sc').first().innerHTML().catch(() => 'no .sc')).slice(0, 200))
    await ctx.close()
    continue
  }
  await page.waitForTimeout(1500)
  const panel = page.locator('.sc').first()
  await panel.screenshot({ path: path.join(OUT, `${theme}-${W}-panel.png`) })
  await page.screenshot({ path: path.join(OUT, `${theme}-${W}-full.png`) })
  // filter: uncovered
  const unc = page.locator('.sc-toolbar').getByRole('radio', { name: 'Uncovered' })
  if (await unc.count()) { await unc.click(); await page.waitForTimeout(500); await panel.screenshot({ path: path.join(OUT, `${theme}-${W}-uncovered.png`) }) }
  // editor (read only: preview/save POSTs are aborted by the guard)
  const edit = page.locator('.sc-row:not(.sc-row--head)').first().getByRole('button', { name: 'Edit' })
  if (await edit.count()) {
    await edit.click(); await page.waitForTimeout(700)
    await page.screenshot({ path: path.join(OUT, `${theme}-${W}-editor.png`) })
    await page.keyboard.press('Escape')
  }
  console.log(theme, 'errors:', errors.length ? errors : 'none', 'aborted writes:', blocked.length ? blocked : 'none')
  await ctx.close()
}
await browser.close()
clearTimeout(watchdog)
