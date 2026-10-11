import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * LIQUID-GLASS PASS capture (FIXTURES ONLY, NO PRODUCTION CONTACT).
 *
 * Every request off the dev server's own origin, and every /api/* request, is
 * answered in the page: the platform-event envelope from a synthetic fixture
 * (redacted identities: "Seller A.", "1200 Sample Ave"), everything else a 503.
 * Nothing is clicked that writes. Campaign Command runs on its ?demo=1 fixtures.
 * Run against a dev server started with a dead backend/Supabase target, e.g.
 *
 *   VITE_BACKEND_API_URL=http://127.0.0.1:9 VITE_SUPABASE_URL=http://127.0.0.1:9 npx vite --port 5391
 *   node scripts/proof/desktop/glass-pass-capture.mjs --base=http://localhost:5391 --phase=before --out=/tmp/glass-pass-shots
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5391')
const OUT = path.resolve(arg('out', '/tmp/glass-pass-shots'))
const PHASE = arg('phase', 'after')
const THEMES = arg('themes', 'dark,light').split(',')
const ONLY = arg('only', '')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
await fs.mkdir(OUT, { recursive: true })
const origin = new URL(BASE)

/* ── synthetic platform events (one seller thread, redacted) ─────────────── */
const NOW = Date.now()
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString()
const SELLER = { type: 'seller', id: 'thr_fixture_1', label: 'Seller A.' }
const PROP = { type: 'property', id: 'prop_fixture_1', label: '1200 Sample Ave' }
const CAMP = { type: 'campaign', id: 'camp_fixture_1', label: 'Fixture SFR · Wave 2' }
const ev = (i, minAgo, source_system, event_type, severity, summary, actor, details = null, refs = [SELLER, PROP]) => ({
  event_id: `evt_fixture_${i}`, occurred_at: at(minAgo), source_system, event_type, severity, actor, entity_refs: refs, summary, details,
  deep_link: null, provenance: { table: 'fixture', row_id: `row_${i}`, adapter: 'fixture' }, property_id: PROP.id, thread_key: SELLER.id, campaign_id: CAMP.id,
})
const AUTO = { kind: 'automation', label: 'Autopilot' }
const SYS = { kind: 'system' }
const SEL = { kind: 'seller', label: 'Seller A.' }
const EVENTS = [
  ev(1, 4, 'inbox', 'seller.replied', 'attention', 'Seller A. replied · asking $182,000', SEL, { body: 'I would take 182 for it, needs a roof.' }),
  ev(2, 11, 'deal', 'offer.created', 'info', 'Offer drafted · $151,000 as-is', AUTO, { amount: 151000 }),
  ev(3, 19, 'pipeline', 'stage.advanced', 'info', 'Stage advanced · Negotiating', AUTO, null),
  ev(4, 27, 'queue', 'message.delivered', 'info', 'Follow-up delivered', SYS, null),
  ev(5, 28, 'queue', 'message.sent', 'info', 'Follow-up sent · S3 asking price', AUTO, null),
  ev(6, 42, 'workflow', 'workflow.run_started', 'info', 'Seller autopilot run started', AUTO, null),
  ev(7, 66, 'inbox', 'seller.replied', 'info', 'Seller A. replied · interested', SEL, { body: 'Yes, what would you offer?' }),
  ev(8, 120, 'queue', 'message.delivered', 'info', 'First touch delivered', SYS, null),
  ev(9, 122, 'campaign', 'campaign.batch_sent', 'info', 'Batch sent · 48 sellers', AUTO, null, [CAMP]),
  ev(10, 125, 'queue', 'message.sent', 'info', 'First touch sent', AUTO, null, [SELLER, PROP, CAMP]),
  ev(11, 300, 'notification', 'alert.raised', 'warning', 'Sender pool cooling · Dallas', SYS, null, [CAMP]),
  ev(12, 900, 'campaign', 'campaign.launched', 'info', 'Campaign launched', { kind: 'operator', label: 'Operator' }, null, [CAMP]),
]
const SOURCES = Object.fromEntries(['messages', 'campaign_sends', 'workflow', 'lead_state', 'pipeline', 'campaigns', 'closing', 'notifications'].map((k) => [k, { ok: true, freshness_at: at(2), systems: [], table: k, read: true }]))
const envelope = (url) => {
  const q = url.searchParams
  let events = EVENTS
  const types = q.get('types')
  if (types) events = events.filter((e) => types.split(',').includes(e.event_type))
  const subject = q.get('subject_type') ? { type: q.get('subject_type'), id: q.get('subject_id'), label: 'Seller A.' } : null
  return { ok: true, events, next_cursor: null, sources: SOURCES, degraded: [], generated_at: new Date().toISOString(), subject, window: { since: q.get('since') ?? at(10080), until: q.get('until') ?? at(0) } }
}

/* calendar: the API's own scenario fixture (apps/api/scripts/gen-calendar-demo.mjs), person names redacted */
const CAL_FILE = arg('calendar', '')
let CAL = null
if (CAL_FILE) {
  let raw = await fs.readFile(CAL_FILE, 'utf8')
  const names = [...new Set([...raw.matchAll(/"(?:subtitle|title|label)":"([A-Z][a-z]+ [A-Z][a-z]+)"/g)].map((m) => m[1]))].filter((n) => !/^(Open|Needs|Ready|Buyer|Closing|Seller|Title|Daily|Follow)/.test(n))
  names.forEach((n, i) => { raw = raw.split(n).join(`Seller ${String.fromCharCode(65 + (i % 26))}.`) })
  raw = raw.replace(/\b\d{2,6} [A-Z][a-z]+(?: [A-Z][a-z]+)? (?:Ave|St|Rd|Dr|Ln|Blvd|Way|Ct|Pl|Ter|Pkwy)\b(?: [NSEW]{1,2}\b)?/g, '1200 Sample Ave')
  CAL = JSON.parse(raw)
}

const browser = await chromium.launch()
const dog = setTimeout(async () => { console.log('WATCHDOG'); await browser.close().catch(() => {}); process.exit(2) }, 360_000)
for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const blocked = []
  await ctx.route('**/*', (r) => {
    const req = r.request(); const u = new URL(req.url())
    const own = u.host === origin.host && !u.pathname.startsWith('/api/')
    if (own || /fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) return r.continue()
    if (CAL && req.method() === 'GET' && u.pathname === '/api/cockpit/calendar/timeline') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: CAL }) })
    if (req.method() === 'GET' && u.pathname === '/api/cockpit/platform/events') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope(u)) })
    if (req.method() !== 'GET') blocked.push(`${req.method()} ${u.pathname}`)
    return r.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"offline_fixture"}' })
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(theme, 'pageerror', String(e.message).slice(0, 160)))
  const shot = async (name) => { const f = path.join(OUT, `${PHASE}-${theme}-${name}.png`); await page.screenshot({ path: f }); console.log('shot', path.basename(f)) }
  const go = async (p) => { await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await page.addStyleTag({ content: '[data-testid="dev-runtime-banner"],.dev-runtime-diagnostics{display:none!important}' }).catch(() => {}) }
  const want = (k) => !ONLY || ONLY.split(',').includes(k)

  // 1 · Campaign Command (demo fixtures) — the campaigns inspector ("Campaign brief")
  if (want('campaign')) {
    await go('/campaign-command?demo=1')
    await page.waitForSelector('.cc3-insp, .cc3-body', { timeout: 90000 }).catch(() => console.log('note: no cc3'))
    await page.waitForTimeout(2500)
    // the inspector toggle is view state only (no request)
    if (!(await page.locator('.cc3-insp').count())) {
      await page.getByRole('button', { name: 'Show inspector' }).click().catch(() => console.log('note: no inspector toggle'))
      await page.waitForTimeout(1500)
    }
    await shot('campaign-inspector')
  }

  // 2 · Live Activity dropdown (the reference) + 3 · its Replay (Time Machine), over the demo war room
  if (want('feed')) {
    if (!want('campaign')) { await go('/campaign-command?demo=1'); await page.waitForTimeout(3000) }
    await page.locator('.cd-machine').click()
    await page.waitForSelector('.mf-row', { timeout: 60000 })
    await page.waitForTimeout(900)
    await shot('live-activity-dropdown')
    const row = page.locator('.mf-row').first()
    await row.hover()
    await row.getByRole('button', { name: 'Replay' }).click()
    await page.waitForSelector('.tm .tm-node', { timeout: 60000 })
    await page.waitForTimeout(1200)
    await page.mouse.move(5, H - 5)
    await shot('replay')
    await page.keyboard.press('Escape'); await page.waitForTimeout(500)
  }

  // 4 · Intelligence Brief plane, 5 · Universal inspector (seller) — over the demo war room
  if (want('brief')) {
    if (!want('campaign') && !want('feed')) { await go('/campaign-command?demo=1'); await page.waitForTimeout(3000) }
    await page.evaluate(async () => { const m = await import('/src/modules/brief/brief-store.ts'); m.openBrief() })
    await page.waitForSelector('.bf-plane', { timeout: 30000 })
    await page.waitForTimeout(2500)
    await shot('intelligence-brief')
    await page.evaluate(async () => { const m = await import('/src/modules/brief/brief-store.ts'); m.closeBrief() })
    await page.waitForTimeout(500)
    await page.evaluate(async () => { const m = await import('/src/modules/desktop/inspector/inspector-store.ts'); m.openInspector({ type: 'campaign', id: 'camp_fixture_1', label: 'Fixture SFR · Wave 2' }) })
    await page.waitForSelector('.uinsp', { timeout: 30000 }).catch(() => console.log('note: no uinsp'))
    await page.waitForTimeout(2000)
    await shot('universal-inspector')
  }

  // 6 · Deal Intelligence with no subject — the inspector shell over the empty room
  if (want('deal')) {
    await go('/deal-intelligence')
    await page.waitForTimeout(5000)
    await shot('deal-intelligence')
  }
  // 7 · Campaign inspector DOCKED (wide screen: the dock variant, menu-grade fill)
  if (want('campaign-dock')) {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await go('/campaign-command?demo=1')
    await page.waitForSelector('.cc3-insp', { timeout: 60000 }).catch(() => console.log('note: no docked cc3 inspector'))
    await page.waitForTimeout(2500)
    await shot('campaign-inspector-docked')
    await page.setViewportSize({ width: W, height: H })
  }
  if (blocked.length) console.log(theme, 'non-GET answered offline:', [...new Set(blocked)].slice(0, 12))
  await ctx.close()

  // 8 · Calendar temporal brief (own context: the clock is pinned to the fixture's "now")
  if (CAL && want('calendar')) {
    const c2 = await browser.newContext({ viewport: { width: W, height: H } })
    await c2.addInitScript((t) => { try { localStorage.setItem('nexus-settings', JSON.stringify({ nexusTheme: t })) } catch { /* ignore */ } }, theme)
    await c2.route('**/*', (r) => {
      const req = r.request(); const u = new URL(req.url())
      if (u.host === origin.host && !u.pathname.startsWith('/api/')) return r.continue()
      if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) return r.continue()
      if (req.method() === 'GET' && u.pathname === '/api/cockpit/calendar/timeline') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: CAL }) })
      return r.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"offline_fixture"}' })
    })
    const p2 = await c2.newPage()
    await p2.clock.setFixedTime(new Date(CAL.range.now))
    await p2.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await p2.waitForSelector('.tcc-brief', { timeout: 90000 }).catch(() => console.log('note: no tcc-brief'))
    await p2.waitForTimeout(2500)
    await p2.screenshot({ path: path.join(OUT, `${PHASE}-${theme}-calendar-brief.png`) }); console.log('shot', `${PHASE}-${theme}-calendar-brief.png`)
    await c2.close()
  }
}
clearTimeout(dog)
await browser.close()
