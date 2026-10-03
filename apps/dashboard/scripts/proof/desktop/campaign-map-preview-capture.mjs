import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * CAMPAIGN MAP PREVIEW capture (READ ONLY, real data).
 *
 * Opens the Composer with real markets (URL intake), clicks the Composer's own
 * "Map beside" (workspace openApp — the Map opens in Campaign Preview Mode),
 * waits for the eligible cohort's geography (part=geo, a GET) and photographs
 * the Map pane. Guard: every non-GET to /api or Supabase is ABORTED except
 * POST /rest/v1/rpc/get_* (the Map's stable read RPCs). Nothing is saved,
 * prepared or launched; Launch / Send / Approve / Ownership Check are never
 * clicked. The "filtered" case re-publishes the bound preview with one more
 * filter clause through the dev module (the server still computes it).
 *
 *   node scripts/proof/desktop/campaign-map-preview-capture.mjs --out=/tmp/cmp --cases=minneapolis,dallas-houston
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/campaign-map-preview'))
await fs.mkdir(OUT, { recursive: true })

const DAY = '2026-10-03T18:30:00Z' // 13:30 CDT — daylight over Minneapolis
const NIGHT = '2026-10-04T04:30:00Z' // 23:30 CDT
const CASES = {
  minneapolis: { markets: ['Minneapolis, MN'], theme: 'dark', sizes: ['1440x900', '1920x1080', '3840x1600', '5120x1440'] },
  'dallas-houston': { markets: ['Dallas, TX', 'Houston, TX'], theme: 'dark', sizes: ['1440x900'] },
  'three-markets': { markets: ['Minneapolis, MN', 'Dallas, TX', 'Jacksonville, FL'], theme: 'dark', sizes: ['1920x1080'] },
  dense: { markets: ['Houston, TX', 'Dallas, TX', 'Minneapolis, MN', 'Jacksonville, FL'], theme: 'dark', sizes: ['1440x900'] },
  filtered: { markets: ['Minneapolis, MN'], theme: 'dark', sizes: ['1440x900'], extra: { field_key: 'properties.tax_delinquent', operator: 'is_true', value: '', domain: 'properties', category: 'Financial' } },
  day: { markets: ['Minneapolis, MN'], theme: 'dark', sizes: ['1440x900'], sun: DAY, living: true },
  night: { markets: ['Minneapolis, MN'], theme: 'dark', sizes: ['1440x900'], sun: NIGHT, living: true },
  light: { markets: ['Minneapolis, MN'], theme: 'light', sizes: ['1440x900'] },
  'true-black': { markets: ['Minneapolis, MN'], theme: 'true_black', sizes: ['1440x900'] },
  'red-ops': { markets: ['Minneapolis, MN'], theme: 'red_ops', sizes: ['1440x900'] },
  manual: { markets: ['Minneapolis, MN'], theme: 'dark', sizes: ['1440x900'], drag: true },
}
const pick = arg('cases', Object.keys(CASES).join(',')).split(',')

const browser = await chromium.launch()
const watchdog = setTimeout(async () => { console.log('WATCHDOG'); await browser.close().catch(() => {}); process.exit(2) }, 2_400_000)
const blocked = []
const report = []
for (const name of pick) {
  const c = CASES[name]
  if (!c) { console.log('unknown case', name); continue }
  for (const size of c.sizes) {
    const [W, H] = size.split('x').map(Number)
    const ctx = await browser.newContext({ viewport: { width: W, height: H } })
    await ctx.addInitScript(([theme, living]) => {
      try {
        localStorage.removeItem('nexus.desktop.split')
        localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
        localStorage.removeItem('lc.campaignComposer')
        sessionStorage.removeItem('lc.workspace.session.v1')
        sessionStorage.removeItem('lc.map.campaignPreview.follow.v1')
        const s = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...s, nexusTheme: theme }))
        const lv = JSON.parse(localStorage.getItem('nexus.map.living') || '{}')
        localStorage.setItem('nexus.map.living', JSON.stringify({ ...lv, enabled: true, daylight: Boolean(living), sun: living ? 'dynamic' : (lv.sun ?? 'ambient') }))
      } catch { /* ignore */ }
    }, [c.theme, Boolean(c.living)])
    const page = await ctx.newPage()
    const errors = []
    const geoCalls = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 240)))
    page.on('request', (req) => { if (req.url().includes('part=geo')) geoCalls.push(Date.now()) })
    await page.route('**/*', (r) => {
      const req = r.request()
      const u = new URL(req.url())
      const isApi = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
      if (!isApi || ['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.continue()
      if (req.method() === 'POST' && /\/rest\/v1\/rpc\/get_/.test(u.pathname)) return r.continue()
      blocked.push(`${req.method()} ${u.pathname}`)
      return r.abort()
    })
    const tag = `${name}-${c.theme}-${size}`
    const q = new URLSearchParams({ compose: '1', market: c.markets.join('|') })
    if (c.sun) q.set('sun_at', c.sun)
    const t0 = Date.now()
    await page.goto(`${BASE}/campaign-command?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.addStyleTag({ content: '[data-testid="dev-runtime-banner"]{display:none!important}' }).catch(() => {})
    await page.waitForSelector('.ccz', { timeout: 120000 })
    // Map beside, through the Composer's own control
    await page.locator('.ccz-head__meta button', { hasText: 'Map beside' }).click()
    const tBeside = Date.now()
    await page.waitForSelector('.lc-cpv', { timeout: 120000 }).catch(() => console.log(tag, 'note: no preview console'))
    await page.waitForSelector('.lc-cpv__counts', { timeout: 300000 }).catch(() => console.log(tag, 'note: counts never landed'))
    const tCounts = Date.now()
    await page.waitForTimeout(3500) // the framing flight + tiles
    if (c.extra) {
      const before = await page.evaluate(() => document.querySelector('.lc-cpv__counts')?.textContent ?? '')
      await page.evaluate(async (extra) => {
        const m = await import('/src/domain/campaign-preview/campaign-preview-context.ts')
        const key = m.latestCampaignPreviewKey()
        const ctxNow = m.getCampaignPreview(key)
        if (!ctxNow) return
        const filters = { ...ctxNow.spec.filters, properties: [...(ctxNow.spec.filters.properties ?? []), extra] }
        const spec = { ...ctxNow.spec, filters }
        m.publishCampaignPreview({ ...ctxNow, spec, specKey: m.previewSpecKey(spec) })
      }, c.extra)
      await page.waitForFunction((b) => {
        const t = document.querySelector('.lc-cpv__counts')?.textContent ?? ''
        return t && t !== b && !document.querySelector('.lc-cpv.is-updating')
      }, before, { timeout: 240000 }).catch(() => console.log(tag, 'note: filtered counts did not change'))
      await page.waitForTimeout(2000)
    }
    if (c.drag) {
      const box = await page.locator('canvas.maplibregl-canvas').last().boundingBox().catch(() => null)
      if (box) {
        await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.45, { steps: 12 })
        await page.mouse.up()
        await page.waitForTimeout(1500)
      }
    }
    await page.screenshot({ path: path.join(OUT, `${tag}.png`) })
    const cpv = page.locator('.lc-cpv')
    if (await cpv.count()) await cpv.screenshot({ path: path.join(OUT, `${tag}-console.png`) }).catch(() => {})
    const metrics = await page.evaluate(() => {
      const m = window.__nxMap
      let layer = null
      try {
        const src = m?.getSource('lc-campaign-preview')
        layer = { dot: Boolean(m?.getLayer('lc-cp-dot')), cluster: Boolean(m?.getLayer('lc-cp-cluster')), rendered: m ? m.queryRenderedFeatures({ layers: ['lc-cp-dot', 'lc-cp-cluster'].filter((id) => m.getLayer(id)) }).length : null, hasSource: Boolean(src) }
      } catch { /* ignore */ }
      return {
        title: document.querySelector('.lc-cpv__title h2')?.textContent ?? null,
        counts: document.querySelector('.lc-cpv__counts')?.getAttribute('aria-label') ?? null,
        markets: [...document.querySelectorAll('.lc-cpv__market')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
        follow: document.querySelector('.lc-cpv')?.getAttribute('data-cp-follow') ?? null,
        manual: document.querySelector('[data-cp-manual]')?.textContent ?? null,
        foot: [...document.querySelectorAll('.lc-cpv__foot, .lc-cpv__note')].map((n) => n.textContent),
        zoom: m ? Math.round(m.getZoom() * 100) / 100 : null,
        composerEligible: document.querySelector('.ccz-dock__count b')?.textContent ?? null,
        layer,
      }
    })
    const row = { tag, ms_to_counts_after_beside: tCounts - tBeside, ms_total: Date.now() - t0, geo_requests: geoCalls.length, errors: errors.slice(0, 3), ...metrics }
    report.push(row)
    console.log(JSON.stringify(row))
    await ctx.close()
  }
}
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, blocked }, null, 2))
console.log('BLOCKED', blocked.length, [...new Set(blocked)].slice(0, 12))
clearTimeout(watchdog)
await browser.close()
