import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * [8.3] BULK ARCHIVE capture (READ ONLY). Every non-GET to /api or Supabase is
 * aborted — EXCEPT POST /api/cockpit/archive/bulk, which is FULFILLED HERE with
 * a fixture (it never reaches the API), so the progress / partial-result / Undo
 * states can be shown without archiving anything.
 *
 *   node scripts/proof/desktop/r83-bulk-archive-capture.mjs --themes=dark,light --out=/tmp/r83
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/r83-bulk-archive'))
const THEMES = arg('themes', 'dark').split(',')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 900_000)
const bulkPosts = []

for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      localStorage.setItem('nexus.pipeline.desktop.mode', 'table')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', async (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if (u.pathname === '/api/cockpit/archive/bulk' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}')
      bulkPosts.push({ object_type: body.object_type, action: body.action, n: body.ids?.length })
      // fixture: the last id is blocked with queued sends, the rest archived
      const results = (body.ids || []).map((id, i, all) => (i === all.length - 1 && body.action === 'archive'
        ? { id, ok: false, outcome: 'blocked', reason: 'queued_sends', message: '2 sends are still queued to this seller. Cancel them in Queue first.', queued_sends: 2 }
        : { id, ok: true, outcome: body.action === 'archive' ? 'archived' : 'unarchived' }))
      await new Promise((res) => setTimeout(res, 900))
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, object_type: body.object_type, action: body.action, results }) })
    }
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.abort()
    return r.continue()
  })
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${theme}-${name}.png`) })

  /* INBOX */
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  const inboxOk = await page.waitForSelector('.ixl-row', { timeout: 120000 }).then(() => true).catch(() => false)
  if (inboxOk) {
    await page.waitForTimeout(1500)
    const rows = page.locator('.ixl-row')
    await rows.nth(0).hover()
    await page.locator('.ixl-row__check').nth(0).click()
    await page.locator('.ixl-row__check').nth(3).click({ modifiers: ['Shift'] })
    await page.mouse.move(W / 2, 40)
    await page.waitForTimeout(400)
    await shot('inbox-selected')
    await page.locator('.ixl-bulkbar button', { hasText: 'Archive' }).click()
    await page.waitForTimeout(700)
    await shot('inbox-confirm')
    // confirm → the fixture answers (never the API)
    await page.getByRole('button', { name: /^Archive \d+$/ }).last().click({ timeout: 5000 }).catch(() => console.log('note: confirm button not found'))
    await page.waitForTimeout(350)
    await shot('inbox-progress')
    await page.waitForTimeout(1600)
    await shot('inbox-result')
    await page.locator('.ixl-bulkbar button', { hasText: 'Why?' }).click().catch(() => {})
    await page.waitForTimeout(500)
    await shot('inbox-why')
    await page.keyboard.press('Escape')
  } else { console.log('inbox: no rows'); await shot('inbox-diag') }

  /* PIPELINE (table) */
  await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  const pipeOk = await page.waitForSelector('.pd2-table .lc-grid__row', { timeout: 120000 }).then(() => true).catch(() => false)
  if (pipeOk) {
    await page.waitForTimeout(1200)
    const checks = page.locator('.pd2-table .lc-grid__row .lc-grid__cell.is-check')
    await checks.nth(0).click()
    await checks.nth(2).click({ modifiers: ['Shift'] })
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await page.waitForTimeout(400)
    console.log('pipeline checks:', JSON.stringify(await page.$$eval('.pd2-table .lc-grid__row', (rs) => rs.slice(0, 5).map((r) => [r.getAttribute('aria-selected'), r.querySelector('.lc-check')?.getAttribute('aria-checked'), (r.textContent || '').slice(0, 24)]))))
    await shot('pipeline-selected')
    await page.locator('.pd2-bulkbar button', { hasText: 'Archive' }).click()
    await page.waitForTimeout(700)
    await shot('pipeline-confirm')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  } else console.log('pipeline: no table rows')

  /* CAMPAIGNS */
  await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  const campOk = await page.waitForSelector('.cc3-row', { timeout: 120000 }).then(() => true).catch(() => false)
  if (campOk) {
    await page.waitForTimeout(1200)
    await page.locator('.cc3-row').nth(0).hover()
    await page.locator('.cc3-row__check').nth(0).click()
    await page.locator('.cc3-row__check').nth(1).click()
    await page.mouse.move(W - 100, H / 2)
    await page.waitForTimeout(400)
    await shot('campaigns-selected')
  } else console.log('campaigns: no rows')

  console.log(theme, 'errors:', errors.length ? errors : 'none')
  await ctx.close()
}
console.log('bulk posts fulfilled by fixture (never sent):', JSON.stringify(bulkPosts))
clearTimeout(watchdog)
await browser.close()
