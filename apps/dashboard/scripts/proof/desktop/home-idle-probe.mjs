import { chromium } from 'playwright'
/** READ ONLY idle-frame probe: Home vs another app, same machine, same moment. */
const browser = await chromium.launch()
const wd = setTimeout(() => process.exit(2), 240_000)
for (const route of ['/pipeline', '/home', '/pipeline', '/home']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.route('**/*', (r) => { const q = r.request(); const u = new URL(q.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return r.abort(); return r.continue() })
  await page.goto(`http://localhost:5173${route}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(15000)
  const f = await page.evaluate(() => new Promise((res) => { const f = []; let last = performance.now(); const tick = (t) => { f.push(t - last); last = t; if (f.length < 40) requestAnimationFrame(tick); else res(f.slice(2)) }; requestAnimationFrame(tick) }))
  const s = [...f].sort((a, b) => a - b)
  const longTasks = await page.evaluate(() => new Promise((res) => { let n = 0, t = 0; const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) { n += 1; t += e.duration } }); o.observe({ entryTypes: ['longtask'] }); setTimeout(() => { o.disconnect(); res({ n, ms: Math.round(t) }) }, 3000) }))
  console.log(route, 'p50', Math.round(s[Math.floor(s.length / 2)]), 'p95', Math.round(s[Math.floor(s.length * 0.95)]), 'longtasks/3s', JSON.stringify(longTasks))
  await ctx.close()
}
clearTimeout(wd)
await browser.close()
