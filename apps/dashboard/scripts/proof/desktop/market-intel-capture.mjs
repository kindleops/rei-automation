import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * MARKET INTELLIGENCE V1 visual QA (brief §52), READ ONLY. DEFERRED: run only when
 * the lead schedules it (the owner is off the machine) and :5173 is up. Never
 * started from here. Every non-GET to /api or Supabase is aborted; nothing writes.
 * Composer / Map hand-offs are not clicked (the Map scene is opened by URL only).
 *
 *   node /Users/ryankindle/.claude/jobs/c39b0175/tmp/with-lock.mjs capture \
 *     node scripts/proof/desktop/market-intel-capture.mjs --themes=dark,light \
 *     --sizes=1440x900,1920x1080,3840x1600,5120x1440 --out=/Users/ryankindle/.claude/jobs/c39b0175/tmp/market-intel/shots
 *
 * Scenes (real prod data through the local API):
 *   1 Minneapolis overview · 2 Minneapolis ZIP rankings · 3 Dallas investor heat (Map tab)
 *   4 Dallas + Houston compare · 5 Texas screener · 6 MF price/unit · 7 Census dossier
 *   8 Investor surface · 9 ZIP inspector · 10 ultrawide command wall
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/market-intel'))
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const ONLY = arg('scenes', '')
const MI = '/market-intelligence'
const SCENES = [
  ['01-minneapolis-overview', `${MI}?geo=market:minneapolis-mn`],
  ['02-minneapolis-zip-rankings', `${MI}?geo=market:minneapolis-mn&tab=rankings&rl=zip&rm=investor_purchase_count`],
  ['03-dallas-investor-heat', `${MI}?geo=market:dallas-tx&tab=map&hm=investor_purchase_share`],
  ['04-dallas-houston-compare', `${MI}?tab=compare&cmp=market:dallas-tx,market:houston-tx`],
  ['05-texas-screener', `${MI}?geo=state:TX&tab=screener&sl=zip&sw=state:TX&sf=${encodeURIComponent(JSON.stringify([{ metric: 'sales_count', op: 'gte', value: 100 }, { metric: 'investor_purchase_share', op: 'gte', value: 0.15 }]))}`],
  ['06-mf-price-per-unit', `${MI}?geo=market:minneapolis-mn&tab=multifamily&asset=mf`],
  ['07-census-dossier', `${MI}?geo=zip:55411&tab=demographics`],
  ['08-investor-surface', `${MI}?geo=market:dallas-tx&tab=investors`],
  ['09-zip-inspector', `${MI}?geo=market:minneapolis-mn&tab=rankings&rl=zip`, 'inspect'],
  ['10-ultrawide-wall', `${MI}?geo=market:minneapolis-mn`],
].filter(([n]) => !ONLY || ONLY.split(',').some((o) => n.startsWith(o)))

await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 20 * 60_000)
for (const theme of THEMES) {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } })
    await ctx.addInitScript((t) => {
      try {
        localStorage.removeItem('nexus.desktop.split')
        localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
        const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      } catch { /* ignore */ }
    }, theme)
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
    await page.route('**/*', (r) => { const req = r.request(); const u = new URL(req.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.abort(); return r.continue() })
    for (const [name, route, mode] of SCENES) {
      if (name.startsWith('10') && W < 3000) continue
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await page.waitForSelector('.mi', { timeout: 90000 })
      // The first request may build the market index (honest progress); wait for real content.
      await page.waitForFunction(() => !document.querySelector('.mi-warming') && document.querySelector('.mi-hero, .mi-compare .mi-table, .mi-compare .lc-empty'), null, { timeout: 180000 }).catch(() => console.log(`note: ${name} still warming`))
      await page.waitForTimeout(1500)
      if (mode === 'inspect') {
        await page.locator('.mi-grid-host [role="row"]').nth(1).click().catch(() => console.log('note: no row to inspect'))
        await page.waitForSelector('.mi-side .mi-insp', { timeout: 30000 }).catch(() => {})
        await page.waitForTimeout(900)
      }
      await page.screenshot({ path: path.join(OUT, `${theme}-${W}x${H}-${name}.png`) })
      console.log('shot', theme, `${W}x${H}`, name)
    }
    if (errors.length) console.log('page errors:', errors)
    await ctx.close()
  }
}
clearTimeout(watchdog)
await browser.close()
