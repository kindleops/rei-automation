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
/** --seed=all: a board with every first-party widget type (the app instruments included) */
const SEED = arg('seed', '')
const ALL = [
  ['home.brief', 8, 3], ['home.focus', 4, 6], ['inbox.replies', 4, 5], ['pipeline.flow', 4, 5], ['campaign.engine', 4, 5], ['map.pulse', 4, 4],
  ['deal.decisions', 4, 5], ['comps.recent', 4, 5], ['buyers.matches', 4, 5], ['entity.network', 4, 5], ['queue.desk', 4, 5], ['browser.recent', 4, 4],
  ['closing.desk', 4, 4], ['workflow.runs', 4, 4], ['email.command', 4, 4], ['calendar.agenda', 4, 4], ['signals.center', 4, 3], ['machine.feed', 4, 5], ['analytics.metric', 4, 3],
]
function seedLayout() {
  let x = 0, y = 0, rowH = 0
  const widgets = ALL.map(([type, w, h], i) => {
    if (x + w > 12) { x = 0; y += rowH; rowH = 0 }
    const cell = { x, y, w, h }
    x += w; rowH = Math.max(rowH, h)
    return { id: `w_mount${String(i).padStart(3, '0')}`, type, ownerApp: 'home', size: 'medium', geometry: { standard: cell }, config: {}, configVersion: 1, context: { mode: 'global', subject: null }, refreshMs: null, locked: false, stack: null }
  })
  return { id: 'l_mountall', name: 'Mount check — all widgets', isDefault: true, profile: 'desktop', schemaVersion: 1, revision: 1, preset: null, widgets, primaryFamily: 'standard', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
}
// reads only widgets make (the shell's own polls — queue health, notifications, telemetry — do not count)
const WIDGET_READS = /\/api\/cockpit\/(home\/instruments|inbox|metrics\/ops|campaigns|pipeline|closing-desk|calendar|workflow-studio|email|signals|home\/(metrics|map-activity)|analytics)/
const browser = await chromium.launch()
const wd = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 480_000)
let failed = false
for (const [W, H] of (arg('sizes', '3800x1000,1440x900')).split(',').map((x) => x.split('x').map(Number))) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  // --io=silent: an IntersectionObserver that never delivers an entry (what the owner's Chrome did) —
  // widget bodies must still mount and fetch on first paint
  if (arg('io', '') === 'silent') await ctx.addInitScript(() => { window.IntersectionObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } } })
  // one Home pane (the shell otherwise seeds a multi-app ultrawide workspace on first run)
  await ctx.addInitScript(() => { try { localStorage.setItem('nexus.desktop.ultrawide.seeded', '1'); localStorage.removeItem('nexus.desktop.split') } catch { /* ignore */ } })
  if (SEED === 'all') await ctx.addInitScript((l) => { localStorage.setItem('lc.home.board.v1:local', JSON.stringify({ v: 1, activeId: l.id, layouts: [l], synced: [] })) }, seedLayout())
  const page = await ctx.newPage()
  const reads = []; const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  const timings = []
  page.on('request', (q) => { const u = new URL(q.url()); if (q.method() === 'GET' && WIDGET_READS.test(u.pathname)) reads.push(u.pathname + (u.pathname.endsWith('instruments') ? `?${u.searchParams.get('kind')}` : '')) })
  page.on('requestfinished', (q) => { const u = new URL(q.url()); if (u.pathname.endsWith('/home/instruments')) timings.push(`${u.searchParams.get('kind')}:${Math.round(q.timing().responseEnd)}ms`) })
  await page.route('**/*', (r) => { const q = r.request(); const u = new URL(q.url()); if (SERVER_OP && u.pathname === '/api/cockpit/home/layouts') return r.continue({ headers: { ...q.headers(), 'x-ops-user-id': SERVER_OP } }); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return r.abort(); return r.continue() })
  await page.goto(`${arg('base', 'http://localhost:5173')}/home`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.hb .hb-w', { timeout: 90000 })
  await page.waitForTimeout(5000)
  if (process.argv.includes('--reload')) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.hb .hb-w', { timeout: 90000 }); await page.waitForTimeout(5000) }
  if (SEED === 'all') {
    for (let i = 0; i < 6; i += 1) { await page.evaluate(() => { const r = document.querySelector('.hb-scroll'); if (r) r.scrollTop += r.clientHeight * 0.8 }); await page.waitForTimeout(1500) }
    await page.waitForTimeout(4000)
  }
  const m = await page.evaluate(() => [...document.querySelectorAll('.hb-w')].map((w) => ({
    title: w.querySelector('.hb-w__title')?.textContent,
    offscreen: Boolean(w.querySelector('.hb-offscreen')),
    body: (w.querySelector('.hb-w__content')?.textContent || '').trim().length,
    skeleton: Boolean(w.querySelector('.lc-skeleton')),
    rect: (() => { const r = w.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })(),
  })))
  if (OUT) {
    // --settle=<ms>: let the reads land, then capture the top of the board
    const settleMs = Number(arg('settle', '0'))
    if (settleMs) { await page.waitForFunction(() => document.querySelectorAll('.hb .lc-skeleton').length <= 2, null, { timeout: settleMs }).catch(() => {}); await page.evaluate(() => { const r = document.querySelector('.hb-scroll'); if (r) r.scrollTop = 0 }); await page.waitForTimeout(800) }
    await page.screenshot({ path: `${OUT}/mount-${W}.png` })
  }
  const empty = m.filter((x) => x.offscreen || (!x.body && !x.skeleton))
  const ok = m.length > 0 && empty.length === 0 && reads.length > 0
  if (!ok) failed = true
  console.log(JSON.stringify({ W, H, ok, instruments: [...new Set(reads.filter((r) => r.includes('instruments')))], timings, widgets: m.length, empty: empty.map((x) => x.title), widgetReads: [...new Set(reads)].length, errors, detail: m }))
  await ctx.close()
}
clearTimeout(wd)
await browser.close()
process.exit(failed ? 1 : 0)
