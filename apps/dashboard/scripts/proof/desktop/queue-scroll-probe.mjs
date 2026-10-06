import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * RC 8.4.3 QUEUE SCROLL PROBE (READ ONLY). Serves the labeled R8.3 queue
 * fixture for the page read (no operator session headless), aborts every
 * non-GET to /api or Supabase, never clicks anything that writes. For each
 * section x size it logs the ancestor chain of the grid scroller (height /
 * overflow / scroll extents), then wheels over the grid and over the page and
 * reports whether anything actually scrolled.
 *
 *   node scripts/proof/desktop/queue-scroll-probe.mjs --base=http://localhost:5199 \
 *     --sizes=1440x900,1920x1080,5120x1440 --out=/tmp/q [--phone] [--sections=queue,events]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/queue-scroll'))
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const SECTIONS = arg('sections', 'queue').split(',')
const THEME = arg('theme', 'dark')
const TAG = arg('tag', '')
const PHONE = process.argv.includes('--phone')
const CHAIN = process.argv.includes('--chain')
const FIXTURE = await fs.readFile(new URL('./fixtures/r83-queue-page.json', import.meta.url), 'utf8')
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG: probe exceeded 600 s'); process.exit(2) }, 600_000)

for (const [W, H] of SIZES) {
  const ctx = await browser.newContext(PHONE
    ? { viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
    : { viewport: { width: W, height: H }, deviceScaleFactor: W > 3000 ? 0.5 : 1 })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, THEME)
  const page = await ctx.newPage()
  const blocked = []
  await page.route('**/*', (r) => {
    const req = r.request(); const u = new URL(req.url()); const m = req.method()
    const guarded = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
    if (m === 'GET' && u.pathname === '/api/cockpit/queue/page') return r.fulfill({ status: 200, contentType: 'application/json', body: FIXTURE })
    if (!guarded || ['GET', 'HEAD', 'OPTIONS'].includes(m)) return r.continue()
    blocked.push(`${m} ${u.hostname}${u.pathname}`)
    return r.abort()
  })
  for (const section of SECTIONS) {
    const tag = `queue-${section}-${W}x${H}${PHONE ? '-phone' : ''}${TAG ? `-${TAG}` : ''}`
    await page.goto(`${BASE}/queue`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('.qdk, .occ-root, .qx-root', { timeout: 120000 }).catch(() => console.log(tag, 'note: root missing'))
    await page.waitForTimeout(7000)
    if (section !== 'queue') {
      // tabs only switch the read-only view
      await page.getByRole('tab', { name: new RegExp(section.slice(0, 5), 'i') }).first().click().catch((e) => console.log(tag, 'tab failed', String(e).slice(0, 100)))
      await page.waitForTimeout(2500)
    }
    const report = await page.evaluate((chain) => {
      const describe = (el) => {
        const cs = getComputedStyle(el)
        return {
          el: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.')}`,
          h: Math.round(el.getBoundingClientRect().height), ch: el.clientHeight, sh: el.scrollHeight, cw: el.clientWidth, sw: el.scrollWidth,
          ov: `${cs.overflowX}/${cs.overflowY}`, osb: cs.overscrollBehaviorY, disp: cs.display,
        }
      }
      const scrollables = [...document.querySelectorAll('*')].filter((el) => {
        const cs = getComputedStyle(el)
        return (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1)
      }).map(describe)
      const clipped = [...document.querySelectorAll('*')].filter((el) => {
        const cs = getComputedStyle(el)
        return /(hidden|clip)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200
      }).map(describe).slice(0, 12)
      const scroller = document.querySelector('.lc-grid__scroller')
      const ancestors = []
      if (chain) for (let el = scroller; el; el = el.parentElement) ancestors.push(describe(el))
      return { scrollables, clipped, ancestors, doc: { sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight } }
    }, CHAIN)
    // Wheel over the rows table (or the section body): first down (vertical),
    // then sideways (horizontal). Report every element that actually moved.
    const snap = () => page.evaluate(() => {
      const out = {}
      document.querySelectorAll('*').forEach((el, i) => { if (el.scrollTop || el.scrollLeft) out[`${i}:${el.className && String(el.className).split(' ')[0]}`] = [el.scrollTop, el.scrollLeft] })
      return out
    })
    const box = await page.evaluate(() => {
      const el = document.querySelector('.lc-grid__scroller') || document.querySelector('.qdk-main--section') || document.querySelector('.qdk') || document.querySelector('.qx-root, .occ-root')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const vis = { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, window.innerHeight) }
      return { x: r.left + Math.min(r.width / 2, 400), y: (vis.top + vis.bottom) / 2, which: String(el.className).split(' ')[0] }
    })
    let wheel = 'no target'
    if (box) {
      await page.mouse.move(box.x, box.y)
      await page.mouse.wheel(0, 1); await page.waitForTimeout(300)
      const s0 = await snap()
      await page.mouse.wheel(0, 500); await page.waitForTimeout(700)
      const s1 = await snap()
      await page.mouse.wheel(500, 0); await page.waitForTimeout(400)
      const s2 = await snap()
      // keep wheeling down past the table's end: the desk must take over
      for (let i = 0; i < 12; i += 1) { await page.mouse.wheel(0, 800); await page.waitForTimeout(120) }
      const s3 = await snap()
      const moved = (a, b) => Object.keys(b).filter((k) => JSON.stringify(a[k] ?? [0, 0]) !== JSON.stringify(b[k]))
      wheel = { over: box.which, vertical: moved(s0, s1), horizontal: moved(s1, s2), chained: moved(s2, s3), end: s3 }
    }
    await page.screenshot({ path: path.join(OUT, `${tag}.png`) })
    console.log(JSON.stringify({ tag, wheel, ...report }))
  }
  console.log(JSON.stringify({ size: `${W}x${H}`, blockedWrites: blocked }))
  await ctx.close()
}
clearTimeout(watchdog)
await browser.close()
