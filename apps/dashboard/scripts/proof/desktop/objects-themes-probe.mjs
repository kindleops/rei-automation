import { chromium } from 'playwright'
/** READ ONLY probe: computed selection tokens on a selected comp row per theme (non-GET aborted). */
const BASE = 'http://localhost:5173'
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 240_000)
const browser = await chromium.launch()
for (const theme of (process.argv[2] || 'red_ops,true_black').split(',')) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript((t) => { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t })) }, theme)
  const page = await ctx.newPage()
  await page.route('**/*', (r) => { const q = r.request(); const u = new URL(q.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return r.abort(); return r.continue() })
  await page.goto(`${BASE}/comp-intelligence?property_id=273312064`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('[data-comp-row]', { timeout: 120000 })
  await page.waitForTimeout(2000)
  await page.locator('[data-comp-row]').first().click({ button: 'right' })
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.locator('[data-comp-row]').first().click({ modifiers: ['Shift'] })
  await page.waitForTimeout(1500)
  const out = await page.evaluate(() => {
    const hits = []
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      const v = `${cs.boxShadow} | ${cs.outlineStyle !== 'none' ? cs.outlineColor : ''} | ${cs.borderTopColor}`
      if (/255, 18, 18|6, 182, 212/.test(v)) { const r = el.getBoundingClientRect(); if (r.width > 200 && r.x > 900) hits.push({ cls: String(el.className).slice(0, 80), tag: el.tagName, focus: document.activeElement === el, v: v.slice(0, 160), r: [r.x | 0, r.y | 0, r.width | 0, r.height | 0] }) }
    }
    const ae = document.activeElement; const acs = ae ? getComputedStyle(ae) : null
    return { focusRgb: getComputedStyle(document.documentElement).getPropertyValue('--lc-focus-rgb'), active: ae ? { cls: String(ae.className).slice(0, 80), shadow: acs.boxShadow, outline: `${acs.outlineStyle} ${acs.outlineColor} ${acs.outlineWidth}`, fv: ae.matches(':focus-visible') } : null, hits: hits.slice(0, 8) }
  })
  console.log(theme, JSON.stringify(out, null, 1))
  await ctx.close()
}
await browser.close(); clearTimeout(watchdog)
