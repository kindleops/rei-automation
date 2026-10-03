import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * NOTIFICATION CENTER 2.0 — look capture (READ ONLY: every non-GET to /api or Supabase is recorded and
 * ABORTED — swipes, bulk actions and Clear all are exercised up to the request, nothing is written).
 *   node scripts/proof/desktop/notification-plane-look-capture.mjs --out=/tmp/ncp-look \
 *     --themes=dark,light,true_black,red_ops --sizes=1440x900,1920x1080 [--interactions=1]
 * interactions: hover, keyboard cursor, a revealed swipe tray, multi-select + bulk bar, the Clear all confirm.
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const OUT = path.resolve(arg('out', 'artifacts/notification-plane-look'))
const THEMES = arg('themes', 'dark,light,true_black,red_ops').split(',')
const SIZES = arg('sizes', '1440x900,1920x1080').split(',').map((s) => s.split('x').map(Number))
const INTERACT = arg('interactions', '0') === '1'
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 3_000_000)
const browser = await chromium.launch()
const report = []
for (const theme of THEMES) {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } })
    await ctx.addInitScript((t) => { try { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t })); localStorage.setItem('nexus.desktop.ultrawide.seeded', '1') } catch { /* ignore */ } }, theme)
    const page = await ctx.newPage()
    const writes = []
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)))
    await page.route('**/*', (r) => { const q = r.request(); const u = new URL(q.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) { writes.push(`${q.method()} ${u.pathname} ${q.postData() || ''}`.slice(0, 160)); return r.abort() } return r.continue() })
    await page.goto('http://localhost:5173/pipeline', { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('.cd-machine', { timeout: 120000 }); await page.waitForTimeout(2500)
    await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click()
    await page.waitForSelector('.ncp .ncs, .ncp .lc-empty', { timeout: 300000 })
    await page.waitForFunction(() => !document.querySelector('.ncp__sync'), null, { timeout: 120000 }).catch(() => null)
    await page.mouse.move(10, H - 10); await page.waitForTimeout(700)
    const shot = (n) => page.screenshot({ path: path.join(OUT, `${theme}-${W}-${n}.png`) })
    await shot('needs-you')
    const lens = async (label) => { await page.locator('.ncp__lenses button', { hasText: label }).first().click(); await page.waitForTimeout(500) }
    await lens('Resolved'); await shot('resolved')
    await lens('System'); await shot('system')
    await lens('Needs you')
    const r = { theme, size: `${W}x${H}`, rows: await page.locator('.ncp .ncs').count() }
    if (INTERACT && W === SIZES[0][0]) {
      const row = page.locator('.ncp .ncs').nth(1)
      await row.hover(); await page.waitForTimeout(300); await shot('hover')
      // swipe left (pointer drag) → the right tray stays revealed
      const b = await row.locator('.ncs__slide').boundingBox()
      await page.mouse.move(b.x + b.width * 0.7, b.y + b.height / 2); await page.mouse.down()
      for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width * 0.7 - i * 11, b.y + b.height / 2)
      await page.mouse.up(); await page.waitForTimeout(500); await shot('swipe-tray')
      r.trayOpen = await page.locator('.ncp .ncs.is-swiped-end').count()
      await page.keyboard.press('Escape').catch(() => null); await page.waitForTimeout(200)
      if (!(await page.locator('.ncp').count())) { await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click(); await page.waitForSelector('.ncp .ncs') }
      // multi-select: checkbox on the first, shift-checkbox on the third → bulk bar
      await page.locator('.ncp .ncs').nth(0).locator('.ncs__check').click({ force: true })
      await page.locator('.ncp .ncs').nth(2).locator('.ncs__check').click({ force: true, modifiers: ['Shift'] })
      await page.waitForTimeout(400); await shot('multi-select')
      r.selected = await page.locator('.ncp .ncs.is-selected').count()
      await page.locator('.ncp .lc-bulk button', { hasText: /^Resolve/ }).first().click().catch(() => null)
      await page.waitForTimeout(900); await shot('bulk-resolved-undo')
      // Clear all → the confirm (cancel it)
      await page.locator('.ncp button', { hasText: /^Clear all/ }).first().click().catch(() => null)
      await page.waitForTimeout(500); await shot('clear-all-confirm')
      r.confirmText = await page.locator('.lc-dialog').innerText().catch(() => null)
      await page.keyboard.press('Escape'); await page.waitForTimeout(300)
      r.planeStillOpen = (await page.locator('.ncp').count()) > 0
    }
    r.writes = writes; r.errors = errors
    report.push(r)
    await ctx.close()
  }
}
clearTimeout(watchdog)
console.log(JSON.stringify(report, null, 1))
await browser.close()
