import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * NOTIFICATION CENTER 2.0 — confirms inside the plane (READ ONLY: every non-GET to /api or Supabase is
 * recorded, then ABORTED — the POST is proven to fire, nothing is written).
 *   Alerts & Signals → a disarmed rule → Arm → the LCConfirm → "Arm rule"
 *   expect: the plane stays open, POST /api/cockpit/signals/rules is sent (and aborted here)
 *   plus: Esc inside the confirm closes the confirm only; a press on the scrim never closes the plane
 *   node scripts/proof/desktop/notification-plane-confirm-capture.mjs --out=/tmp/ncp-confirm
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const OUT = path.resolve(arg('out', 'artifacts/notification-plane-confirm'))
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 300_000)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript(() => { try { localStorage.setItem('nexus.desktop.ultrawide.seeded', '1') } catch { /* ignore */ } })
const page = await ctx.newPage()
const attempted = []
await page.route('**/*', (r) => {
  const q = r.request(); const u = new URL(q.url())
  if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) { attempted.push({ method: q.method(), path: u.pathname, body: q.postData() }); return r.abort() }
  return r.continue()
})
const result = {}
await page.goto('http://localhost:5173/pipeline', { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.cd-machine', { timeout: 120000 })
await page.waitForTimeout(2000)
await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click()
await page.waitForSelector('.ncp', { timeout: 30000 })
await page.locator('.ncp button[aria-label="Alerts & Signals"]').click()
await page.waitForSelector('.ncp-set .lcsig-rule', { timeout: 90000 })
const armBtn = page.locator('.ncp .lcsig-rule:not(.is-armed) .lcsig-rule__arm').first()
result.disarmed_rules = await page.locator('.ncp .lcsig-rule:not(.is-armed)').count()
result.rule = await page.locator('.ncp .lcsig-rule:not(.is-armed) .lcsig-rule__name').first().innerText()

// 1. Esc inside the confirm: the confirm closes, the plane stays
await armBtn.click(); await page.waitForSelector('.lc-dialog', { timeout: 10000 })
await page.keyboard.press('Escape'); await page.waitForTimeout(400)
result.esc_dialog_closed = !(await page.locator('.lc-dialog').count())
result.esc_plane_open = (await page.locator('.ncp-set').count()) > 0
// 2. a press on the scrim: whatever the confirm does with it (it is modal), the plane under it stays
await armBtn.click(); await page.waitForSelector('.lc-dialog', { timeout: 10000 })
await page.mouse.click(200, 450); await page.waitForTimeout(400)
result.scrim_dialog_still_open = (await page.locator('.lc-dialog').count()) > 0
result.scrim_plane_open = (await page.locator('.ncp-set').count()) > 0
if (result.scrim_dialog_still_open) { await page.keyboard.press('Escape'); await page.waitForTimeout(400) }
// 3. confirm: the plane stays and the POST fires
await armBtn.click(); await page.waitForSelector('.lc-dialog', { timeout: 10000 })
await page.screenshot({ path: path.join(OUT, 'confirm-open.png') })
await page.locator('.lc-dialog button', { hasText: /^Arm rule$/ }).click()
await page.waitForTimeout(1200)
await page.screenshot({ path: path.join(OUT, 'after-confirm.png') })
result.confirm_plane_open = (await page.locator('.ncp-set').count()) > 0
result.post_fired = attempted.filter((a) => a.path === '/api/cockpit/signals/rules')
result.dialog_error_shown = await page.locator('.lc-dialog__error').innerText().catch(() => null) // the guard aborted it, so the confirm reports it — as it would a real failure
result.all_attempted_writes = attempted.map((a) => `${a.method} ${a.path}`)
console.log(JSON.stringify(result, null, 1))
clearTimeout(watchdog)
await browser.close()
