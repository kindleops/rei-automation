import { chromium } from 'playwright'
// Read-only proof of the Campaign builder's Market selector at phone widths.
// Every non-GET API call is aborted; nothing is typed into the campaign name.
// Only the Market option search box receives text (a GET query, no draft write).
const OUT = process.env.SHOT_DIR || '/tmp'
const WIDTHS = [375, 390, 393, 430]
const RAW_CITIES = ['Diamond Bar', 'Essex', 'Florida City', 'Hacienda Heights', 'Harbor City', 'Loxahatchee', 'Minnetonka', 'Ontario', 'Paramount', 'Rancho Cordova', 'Seagoville', 'Sun City West', 'Venice', 'Walnut', 'Wayzata']

const b = await chromium.launch()
for (const width of WIDTHS) {
  const ctx = await b.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const p = await ctx.newPage()
  await p.route('**/api/**', (route) => (['GET', 'OPTIONS'].includes(route.request().method()) ? route.continue() : route.abort()))
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
  const optionPayloads = []
  p.on('response', async (res) => {
    if (!res.url().includes('/api/cockpit/campaigns/options') || !res.url().includes('properties.market')) return
    try { optionPayloads.push(await res.json()) } catch {}
  })

  await p.goto('http://localhost:5173/campaign-command', { waitUntil: 'domcontentloaded', timeout: 180000 })
  await p.waitForSelector('[aria-label="New campaign"]', { timeout: 120000 })
  await p.locator('[aria-label="New campaign"]').click()
  await p.waitForSelector('.cbb-cat__head', { timeout: 60000 }); await p.waitForTimeout(1200)
  await p.locator('.cbb-cat__head').first().click(); await p.waitForTimeout(1200)
  await p.locator('.cmp-suggested-chip', { hasText: /^\+ Market$/ }).first().click()
  await p.waitForFunction(() => document.querySelectorAll('.cmp-filter-value-cell select option').length > 3, null, { timeout: 60000 })
  await p.waitForTimeout(600)

  const read = () => p.evaluate(() => {
    const select = document.querySelector('.cmp-filter-value-cell select')
    const opts = [...(select?.options || [])].map((o) => o.textContent.trim()).filter((t) => t && !/Loading|No values/.test(t))
    const r = select?.getBoundingClientRect()
    return {
      options: opts,
      selectBox: r ? { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) } : null,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
  const all = await read()
  await p.screenshot({ path: `${OUT}/market-selector-${width}.png` })

  const input = p.locator('.cmp-option-search input').first()
  await input.fill('Diamond Bar'); await p.waitForTimeout(2500)
  const diamond = await read()
  await input.fill('Wayzata'); await p.waitForTimeout(2500)
  const wayzata = await read()
  await p.screenshot({ path: `${OUT}/market-selector-${width}-search.png` })

  const payload = optionPayloads.find((x) => Array.isArray(x?.options) && x.options.length > 3)
  const apiIds = payload ? payload.options.map((o) => o.market_id) : []
  console.log(JSON.stringify({
    width,
    option_count: all.options.length,
    first: all.options.slice(0, 4),
    raw_city_options: all.options.filter((t) => RAW_CITIES.some((c) => t.startsWith(c))),
    api_market_ids_present: apiIds.length > 0 && apiIds.every(Boolean),
    api_distinct_ids: new Set(apiIds).size,
    search_diamond_bar: diamond.options,
    search_wayzata: wayzata.options,
    select_box: all.selectBox,
    overflow_x: all.overflowX,
    page_errors: errs,
  }))
  await ctx.close()
}
await b.close()
