import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * ACQUISITION OS (A2) capture — Composer quality report, Seller Screener,
 * Discovery, Seller Intelligence. READ ONLY: every non-GET to /api or Supabase
 * is aborted, EXCEPT the screener POST (a read whose body is the expression),
 * which is FULFILLED from the fixture and never reaches the network. The five
 * intelligence endpoints are fulfilled from fixtures (offline extract,
 * 2026-10-07) with `fixture: true`, which the UI labels "FIXTURE".
 *
 *   node scripts/proof/desktop/acq-os-a2-capture.mjs --fixtures=<dir> --out=<dir> --themes=dark,light --size=1440x900
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/acq-os-a2'))
const FIX = path.resolve(arg('fixtures', '/Users/ryankindle/.claude/jobs/c39b0175/tmp/acq-os/A2/fixtures'))
const THEMES = arg('themes', 'dark').split(',')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
await fs.mkdir(OUT, { recursive: true })
const load = async (f) => ({ ...JSON.parse(await fs.readFile(path.join(FIX, f), 'utf8')), fixture: true })
const fixtures = {
  catalog: await load('screener-catalog.json'),
  result: await load('screener-result.json'),
  discovery: await load('discovery-tx.json'),
  why: await load('why-targeted.json'),
  quality: await load('quality-campaign-a.json'),
}
const json = (r, body) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

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
  await page.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    const p = u.pathname
    if (p.endsWith('/api/cockpit/campaigns/screener')) return json(r, req.method() === 'POST' ? fixtures.result : fixtures.catalog)
    if (p.endsWith('/api/cockpit/campaigns/discovery')) return json(r, fixtures.discovery)
    if (p.endsWith('/api/cockpit/campaigns/why-targeted')) {
      const ids = u.searchParams.getAll('property_id')
      const props = fixtures.why.properties.filter((x) => ids.includes(x.property_id))
      return json(r, { ...fixtures.why, properties: props.length ? props : fixtures.why.properties.slice(0, 1).map((x) => ({ ...x, property_id: ids[0] ?? x.property_id })) })
    }
    if (p.endsWith('/api/cockpit/campaigns/composer') && u.searchParams.get('part') === 'quality') return json(r, fixtures.quality)
    if ((p.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.abort()
    return r.continue()
  })
  const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 420_000)
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${theme}-${W}-${name}.png`) })
  await page.goto(`${BASE}/campaign-command?compose=1&market=${encodeURIComponent('Dallas, TX')}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.ccz', { timeout: 120000 })
  // the quality report waits for the whole-cohort count (a real GET), then reads the fixture
  await page.waitForSelector('.aqi-qr', { timeout: 300000 }).catch(() => console.log('note: quality report not shown'))
  const qr = page.locator('.aqi-composer')
  if (await qr.count()) {
    await qr.scrollIntoViewIfNeeded()
    await page.waitForTimeout(800)
    await qr.screenshot({ path: path.join(OUT, `${theme}-${W}-composer-quality.png`) })
    // why-targeted example → Seller Intelligence sheet
    await page.locator('.aqi-ex__head').first().click()
    await page.waitForSelector('.aqi-sheet .aqi-si__head', { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(700)
    await shot('seller-intelligence')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    // Screener
    await page.getByRole('button', { name: 'Open Seller Screener' }).click()
    await page.waitForSelector('.aqi-builder .aqi-cond', { timeout: 30000 })
    await page.getByRole('button', { name: 'Screen sellers' }).click()
    await page.waitForSelector('.aqi-kpis', { timeout: 30000 })
    await page.waitForTimeout(700)
    await shot('screener-results')
    await page.locator('.aqi-seller').first().click()
    await page.waitForSelector('.aqi-inspector .aqi-si__head', { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(700)
    await shot('screener-inspector')
    await page.getByRole('tab', { name: /Discovery/ }).click()
    await page.waitForSelector('.aqi-zipc', { timeout: 30000 })
    await page.waitForTimeout(600)
    await shot('discovery')
  }
  clearTimeout(watchdog)
  console.log(JSON.stringify({ theme, errors: errors.slice(0, 5) }))
  await ctx.close()
}
await browser.close()
