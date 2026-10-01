import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * MACHINE FEED + TIME MACHINE capture (READ ONLY). Every non-GET to /api or
 * Supabase is aborted; nothing is clicked that writes. Real data only.
 *
 *   node scripts/proof/desktop/machine-feed-capture.mjs --themes=dark,light --out=/tmp/p7-feed
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/machine-feed'))
const THEMES = arg('themes', 'dark').split(',')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 420_000)
const browser = await chromium.launch()
for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript((t) => {
    try {
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', (r) => { const req = r.request(); const u = new URL(req.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.abort(); return r.continue() })
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${theme}-${W}-${name}.png`) })
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.cd-machine', { timeout: 90000 })
  await page.waitForTimeout(1500)
  // 1 · feed open (live tail)
  await page.locator('.cd-machine').click()
  await page.waitForSelector('.mf-row, .lc-empty, .lc-error', { timeout: 120000 })
  await page.waitForTimeout(800)
  await shot('feed-open')
  // 2 · feed filtered: attention and above, last 7 days
  await page.locator('.mf-filters [role="radiogroup"], .mf-filters .lc-seg').first().getByText('Attention', { exact: true }).click().catch(() => console.log('note: severity control not found'))
  await page.locator('.mf-filters').getByText('7d', { exact: true }).click().catch(() => console.log('note: window control not found'))
  await page.waitForSelector('.mf-row, .lc-empty', { timeout: 120000 })
  await page.waitForTimeout(900)
  await shot('feed-filtered')
  // reset to everything for 7 days and replay the newest seller with a reply
  await page.locator('.mf-filters').getByText('All', { exact: true }).click().catch(() => {})
  await page.waitForTimeout(400)
  await page.waitForSelector('.mf-row', { timeout: 120000 })
  const row = page.locator('.mf-row', { has: page.locator('.mf-row__sum', { hasText: 'replied' }) }).first()
  await row.hover()
  await row.getByRole('button', { name: 'Replay' }).click()
  await page.waitForSelector('.tm .tm-node, .tm .lc-empty, .tm .lc-error', { timeout: 120000 })
  await page.waitForTimeout(1000)
  await shot('time-machine')
  // step back twice (read-only navigation) to show causal links on the selected event
  await page.getByRole('button', { name: 'Previous event' }).click().catch(() => {})
  await page.getByRole('button', { name: 'Previous event' }).click().catch(() => {})
  await page.waitForTimeout(500)
  await shot('time-machine-step')
  if (errors.length) console.log(theme, 'page errors:', errors.slice(0, 5))
  await ctx.close()
}
await browser.close()
clearTimeout(watchdog)
console.log('done', OUT)
