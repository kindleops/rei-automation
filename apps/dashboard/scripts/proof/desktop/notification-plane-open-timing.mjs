import { chromium } from 'playwright'
/**
 * NOTIFICATION CENTER 2.0 — in-page open timing (READ ONLY; non-GET /api + Supabase aborted).
 * Measured inside the page (performance.now): bell click → plane mounted → first story painted.
 *   cold   fresh tab, no session cache · warm  reopen · cache  after reload (session cache)
 */
const BASE = 'http://localhost:5173'
const BELL = 'button.cd-btn[aria-label^="Notifications"]'
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 600_000)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript(() => {
  try { localStorage.setItem('nexus.desktop.ultrawide.seeded', '1') } catch { /* ignore */ }
  window.__ncp = { runs: [] }
  document.addEventListener('click', (e) => {
    if (!e.target?.closest?.('button.cd-btn[aria-label^="Notifications"]')) return
    const run = { click: performance.now(), plane: null, story: null }
    window.__ncp.runs.push(run)
    const check = () => {
      const p = document.querySelector('.ncp')
      if (p && run.plane === null) run.plane = performance.now() - run.click
      if (p && run.story === null && (p.querySelector('.ncs') || p.querySelector('.lc-empty'))) run.story = performance.now() - run.click
      if (run.story === null) requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  }, true)
})
const page = await ctx.newPage()
await page.route('**/*', (r) => {
  const req = r.request(); const u = new URL(req.url())
  if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.abort()
  return r.continue()
})
const badge = () => page.locator(`${BELL} .cd-btn__count`).innerText().catch(() => '')
const openClose = async (label) => {
  await page.locator(BELL).first().click()
  await page.waitForFunction(() => { const r = window.__ncp.runs.at(-1); return r && r.story !== null }, null, { timeout: 180000 }).catch(() => null)
  const r = await page.evaluate(() => window.__ncp.runs.at(-1))
  const b = await badge()
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  return { label, plane_ms: Math.round(r.plane), first_story_ms: r.story === null ? null : Math.round(r.story), badge: b }
}
const out = []
await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.cd-machine', { timeout: 120000 })
await page.waitForTimeout(2500) // the route has settled
out.push(await openClose('cold'))
await page.waitForTimeout(1000)
for (let i = 0; i < 3; i++) out.push(await openClose(`warm${i + 1}`))
await page.waitForTimeout(1000)
const cached = await page.evaluate(() => { const c = sessionStorage.getItem('lc.notifications.stories.v1'); if (!c) return null; const j = JSON.parse(c); return { stories: j.stories.length, badge: j.counts?.badge } })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.cd-machine', { timeout: 120000 })
const badgeAtBoot = await badge()
await page.waitForTimeout(2500)
out.push(await openClose('cache'))
out.push(await openClose('cache-warm'))
console.log(JSON.stringify({ cached, badgeAtBoot, runs: out }, null, 1))
clearTimeout(watchdog)
await browser.close()
