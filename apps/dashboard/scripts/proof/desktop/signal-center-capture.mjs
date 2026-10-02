import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * SIGNAL CENTER capture (READ ONLY): every non-GET to /api or Supabase is
 * aborted (no watch, acknowledge, resolve or arm can be written). Opens the
 * Notifications app → Signals lens (Signals / Watches / Rules), then the
 * Universal Inspector for real production subjects to show the Watch action.
 *   node scripts/proof/desktop/signal-center-capture.mjs --out=/tmp/sig --themes=dark,light \
 *     --refs='seller:+12039942149,campaign:<uuid>'
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/signal-center'))
const THEMES = arg('themes', 'dark').split(',')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
const REFS = arg('refs', '').split(',').filter(Boolean).map((s) => { const i = s.indexOf(':'); return { type: s.slice(0, i), id: s.slice(i + 1) } })
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 540_000)
const browser = await chromium.launch()
const report = []
for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript((t) => { try { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t })) } catch { /* ignore */ } }, theme)
  const page = await ctx.newPage()
  const errors = []
  const blocked = []
  const reads = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  page.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/cockpit/signals')) reads.push(`${r.status()} ${u.pathname}`) })
  await page.route('**/*', (r) => { const req = r.request(); const u = new URL(req.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return r.abort() } return r.continue() })
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.cd-machine', { timeout: 120000 })
  await page.waitForTimeout(1500)
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${theme}-${W}-${name}.png`) })

  await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click()
  await page.waitForSelector('.lcnc-panel', { timeout: 30000 })
  await page.waitForTimeout(800)
  await page.locator('.lcnc-modebar [data-seg="signals"]').click()
  await page.waitForFunction(() => { const p = document.querySelector('.lcsig'); return p && !p.querySelector('.lc-skeleton') }, null, { timeout: 120000 }).catch(() => console.log('note: signals still loading'))
  // a cold dev compile can outlast the first read: use the panel's own retry once
  if (await page.locator('.lcsig .lc-error button').count()) {
    await page.locator('.lcsig .lc-error button').first().click()
    await page.waitForFunction(() => { const p = document.querySelector('.lcsig'); return p && p.querySelector('.lcsig-tabs') }, null, { timeout: 120000 }).catch(() => console.log('note: retry did not load'))
  }
  await page.waitForTimeout(700)
  await shot('signals')
  const text = await page.locator('.lcsig').innerText().catch(() => '')
  for (const tab of ['Watches', 'Rules']) {
    await page.locator('.lcsig-tabs [role="tab"]', { hasText: tab }).first().click()
    await page.waitForTimeout(600)
    await shot(tab.toLowerCase())
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  for (const ref of REFS) {
    await page.evaluate((r) => window.__lcInspect(r, { replace: true }), ref)
    await page.waitForTimeout(400)
    await page.waitForFunction(() => { const p = document.querySelector('.uinsp'); return p && !p.querySelector('.lc-skeleton') }, null, { timeout: 150000 }).catch(() => {})
    await page.waitForTimeout(900)
    const foot = await page.locator('.uinsp__foot').innerText().catch(() => '')
    report.push({ theme, ref, watch_visible: /Watch/.test(foot) })
    await shot(`inspector-${ref.type}`)
  }
  report.push({ theme, undefinedText: /undefined|NaN|\[object/.test(text), errors: errors.slice(0, 5), blocked, reads: [...new Set(reads)] })
  await ctx.close()
}
clearTimeout(watchdog)
console.log(JSON.stringify(report, null, 1))
await browser.close()
