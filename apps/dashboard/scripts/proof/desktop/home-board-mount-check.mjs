import { chromium } from 'playwright'
/**
 * HOME 2.0 regression check (READ ONLY): every widget body mounts and fetches on first
 * paint, at 3800×1000 (ultrawide) and 1440×900. Every non-GET to /api and Supabase is
 * aborted. Exit 1 when any widget stays an empty offscreen placeholder or no widget
 * data request fires.
 *   node scripts/proof/desktop/home-board-mount-check.mjs [--out=/tmp/x]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const OUT = arg('out', '')
/** --server-op=<throwaway id>: stamp it on /home/layouts (as the Worker does) so server persistence is live, the production path */
const SERVER_OP = arg('server-op', '')
// reads only widgets make (the shell's own polls — queue health, notifications, telemetry — do not count)
const WIDGET_READS = /\/api\/cockpit\/(inbox|metrics\/ops|campaigns|pipeline|closing-desk|calendar|workflow-studio|email|signals|home\/(metrics|map-activity)|analytics)/
const browser = await chromium.launch()
const wd = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 240_000)
let failed = false
for (const [W, H] of [[3800, 1000], [1440, 900]]) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  // --io=silent: an IntersectionObserver that never delivers an entry (what the owner's Chrome did) —
  // widget bodies must still mount and fetch on first paint
  if (arg('io', '') === 'silent') await ctx.addInitScript(() => { window.IntersectionObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } } })
  const page = await ctx.newPage()
  const reads = []; const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  page.on('request', (q) => { const u = new URL(q.url()); if (q.method() === 'GET' && WIDGET_READS.test(u.pathname)) reads.push(u.pathname) })
  await page.route('**/*', (r) => { const q = r.request(); const u = new URL(q.url()); if (SERVER_OP && u.pathname === '/api/cockpit/home/layouts') return r.continue({ headers: { ...q.headers(), 'x-ops-user-id': SERVER_OP } }); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return r.abort(); return r.continue() })
  await page.goto(`${arg('base', 'http://localhost:5173')}/home`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.hb .hb-w', { timeout: 90000 })
  await page.waitForTimeout(5000)
  if (process.argv.includes('--reload')) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.hb .hb-w', { timeout: 90000 }); await page.waitForTimeout(5000) }
  const m = await page.evaluate(() => [...document.querySelectorAll('.hb-w')].map((w) => ({
    title: w.querySelector('.hb-w__title')?.textContent,
    offscreen: Boolean(w.querySelector('.hb-offscreen')),
    body: (w.querySelector('.hb-w__content')?.textContent || '').trim().length,
    skeleton: Boolean(w.querySelector('.lc-skeleton')),
    rect: (() => { const r = w.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })(),
  })))
  if (OUT) await page.screenshot({ path: `${OUT}/mount-${W}.png` })
  const empty = m.filter((x) => x.offscreen || (!x.body && !x.skeleton))
  const ok = m.length > 0 && empty.length === 0 && reads.length > 0
  if (!ok) failed = true
  console.log(JSON.stringify({ W, H, ok, widgets: m.length, empty: empty.map((x) => x.title), widgetReads: [...new Set(reads)].length, errors, detail: m }))
  await ctx.close()
}
clearTimeout(wd)
await browser.close()
process.exit(failed ? 1 : 0)
