import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * BROWSER 1.0 capture + measurements (READ ONLY — every non-GET to /api or
 * Supabase is aborted; nothing is ever clicked that sends, launches or runs
 * an Ownership Check). Third-party pages are only LOADED (GET) in iframes.
 *
 *   node scripts/proof/desktop/browser-1-capture.mjs --out=/tmp/browser --themes=dark,light --pid=273312064
 *   --scenes=core|themes|wide|perf  (comma list)
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/browser'))
const THEMES = arg('themes', 'dark').split(',')
const PID = arg('pid', '273312064')
const LABEL = arg('label', '3635 Emerson Ave N')
const SCENES = new Set(arg('scenes', 'core').split(','))
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 840_000)
const browser = await chromium.launch(arg('isolation', '') === 'on' ? { ignoreDefaultArgs: ['--disable-site-isolation-trials'], args: ['--site-per-process'] } : {})
const log = { blocked: [], errors: [], notes: [], perf: {} }

const intent = (q) => `/browser?${new URLSearchParams({ ...q, n: `cap${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` })}`

async function open(theme, size = '1440x900') {
  const [W, H] = size.split('x').map(Number)
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript((t) => {
    try {
      if (!sessionStorage.getItem('__lcb_capture')) { sessionStorage.clear(); sessionStorage.setItem('__lcb_capture', '1') }
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      for (const k of Object.keys(localStorage)) if (k.startsWith('lc.browser.')) localStorage.removeItem(k)
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => log.errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', (r) => { const req = r.request(); const u = new URL(req.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { log.blocked.push(`${req.method()} ${u.pathname}`); return r.abort() } return r.continue() })
  // popups (window.open from Open externally) are never followed
  ctx.on('page', (p) => { if (p !== page) { log.notes.push(`popup → ${p.url()}`); p.close().catch(() => {}) } })
  return { ctx, page, W, H }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })
const go = async (page, p, sel = '.lcb') => { await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await page.waitForSelector(sel, { timeout: 120000 }) }
const deck = async (page, q, pick = 0) => { await page.keyboard.press('Meta+k'); await page.waitForTimeout(500); await page.keyboard.type(q, { delay: 20 }); await page.waitForTimeout(1300); for (let i = 0; i < pick; i++) await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForTimeout(2200) }
const tabs = (page) => page.evaluate(() => [...document.querySelectorAll('.lcb-tab')].map((t) => t.textContent.trim()))

for (const theme of THEMES) {
  if (SCENES.has('core')) {
    const { ctx, page } = await open(theme)
    // 1 start surface (no subject)
    const t0 = Date.now()
    await go(page, '/browser', '.lcb-start')
    log.perf[`${theme}.startup_ms`] = Date.now() - t0
    await page.waitForTimeout(800)
    await shot(page, `${theme}-1440-01-start`)
    // 2 research launch plane for a real property
    await go(page, intent({ do: 'research', kind: 'property', id: PID, label: LABEL }), '.lcb-launch__group')
    await page.waitForTimeout(1500)
    await shot(page, `${theme}-1440-02-research`)
    // 3 embedded official page (GIS — proven EMBEDS)
    await go(page, intent({ do: 'dest', type: 'GIS', kind: 'property', id: PID, label: LABEL }), '.lcb')
    await page.waitForSelector('.lcb-frame', { timeout: 30000 }).catch(() => log.notes.push('no frame for GIS'))
    await page.waitForTimeout(7000)
    await shot(page, `${theme}-1440-03-embedded`)
    // 4 external-required (Zillow: frame-blocked)
    await go(page, intent({ do: 'dest', type: 'ZILLOW', kind: 'property', id: PID, label: LABEL }), '.lcb')
    await page.waitForTimeout(2500)
    await shot(page, `${theme}-1440-04-external`)
    log.notes.push({ theme, tabs: await tabs(page) })
    // 5 multiple tabs + tab menu (more)
    await page.locator('.lcb-bar [aria-label="More"]').click()
    await page.waitForTimeout(500)
    await shot(page, `${theme}-1440-05-tabs-more`)
    await page.keyboard.press('Escape')
    // invalid input + http insecure
    await page.locator('.lcb-addr__input').click()
    await page.keyboard.type('javascript:alert(1)')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    await shot(page, `${theme}-1440-06-invalid`)
    // 7 the object menu Research submenu (Comps row)
    await go(page, `/comp-intelligence?property_id=${PID}`, '[data-ws-pane]')
    const row = page.locator('[data-comp-row]').first()
    await row.waitFor({ timeout: 60000 }).catch(() => log.notes.push('no comp rows'))
    if (await row.count()) {
      await row.click({ button: 'right' })
      await page.waitForTimeout(600)
      await page.locator('[role="menuitem"]', { hasText: 'Research' }).first().hover()
      await page.waitForTimeout(800)
      await shot(page, `${theme}-1440-07-object-research-menu`)
      // Research this comp → Browser beside, comps keep their pane
      await page.locator('[role="menuitem"]', { hasText: /Research this comp|^Research$/ }).last().click()
      await page.waitForSelector('.lcb', { timeout: 30000 }).catch(() => log.notes.push('browser did not open beside comps'))
      await page.waitForTimeout(3000)
      await shot(page, `${theme}-1440-08-comps-browser`)
    }
    // 9 DI | Browser
    await go(page, `/deal-intelligence?property_id=${PID}`, '[data-ws-pane]')
    await page.waitForTimeout(6000)
    await deck(page, 'browser beside')
    await page.waitForSelector('.lcb', { timeout: 30000 }).catch(() => log.notes.push('browser beside DI failed'))
    await page.waitForTimeout(1500)
    // the operator selects the property (the same linked-context write a row click makes)
    await page.evaluate((pid) => {
      const loc = { propertyId: pid, threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: '3635 Emerson Ave N', setAt: Date.now() }
      sessionStorage.setItem('nexus:property-locator:v1', JSON.stringify(loc))
      window.dispatchEvent(new CustomEvent('nexus:property-locator', { detail: loc }))
    }, PID)
    await page.waitForTimeout(800)
    await deck(page, 'research current property')
    await page.waitForTimeout(2500)
    await shot(page, `${theme}-1440-09-di-browser`)
    log.notes.push({ theme, panes: await page.evaluate(() => [...document.querySelectorAll('[data-ws-pane]')].map((p) => p.getAttribute('aria-label'))) })
    // 10 Map | Browser (linked offer on a new selection)
    await go(page, '/map', '[data-ws-pane]')
    await page.waitForTimeout(5000)
    await deck(page, 'browser beside')
    await page.waitForSelector('.lcb-start', { timeout: 60000 }).catch(() => log.notes.push('browser beside map slow'))
    await page.waitForTimeout(1500)
    await page.evaluate((pid) => {
      const loc = { propertyId: pid, threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: '3601 Emerson Ave N', setAt: Date.now() }
      window.dispatchEvent(new CustomEvent('nexus:property-locator', { detail: loc }))
    }, 'capture-other-property')
    await page.waitForTimeout(1200)
    await shot(page, `${theme}-1440-10-map-browser-offer`)
    await ctx.close()
  }

  if (SCENES.has('di')) {
    // DI | Browser on a Hennepin property with an APN: assessor + tax as parcel deep links
    const { ctx, page } = await open(theme)
    await go(page, `/deal-intelligence?property_id=${PID}`, '[data-ws-pane]')
    await page.waitForTimeout(6000)
    await deck(page, 'browser beside')
    await page.waitForSelector('.lcb', { timeout: 60000 })
    await page.evaluate((pid) => {
      const loc = { propertyId: pid, threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: '3635 Emerson Ave N', setAt: Date.now() }
      sessionStorage.setItem('nexus:property-locator:v1', JSON.stringify(loc))
      window.dispatchEvent(new CustomEvent('nexus:property-locator', { detail: loc }))
    }, PID)
    await page.waitForTimeout(800)
    await deck(page, 'research current property')
    await page.waitForSelector('.lcb-launch__group', { timeout: 60000 })
    await page.waitForTimeout(1500)
    log.notes.push({ rows: await page.evaluate(() => [...document.querySelectorAll('.lcb-launch__row')].slice(0, 3).map((r) => ({ text: r.textContent.trim().slice(0, 110), href: r.querySelector('button')?.getAttribute('title') }))) })
    await shot(page, `${theme}-1440-09b-di-browser-apn`)
    await ctx.close()
  }

  if (SCENES.has('themes')) {
    const { ctx, page } = await open(theme)
    await go(page, intent({ do: 'research', kind: 'property', id: PID, label: LABEL }), '.lcb-launch__group')
    await page.waitForTimeout(1500)
    await shot(page, `${theme}-1440-research`)
    await go(page, intent({ do: 'dest', type: 'ZILLOW', kind: 'property', id: PID, label: LABEL }), '.lcb-state')
    await page.waitForTimeout(1200)
    await shot(page, `${theme}-1440-external`)
    await ctx.close()
  }

  if (SCENES.has('wide')) {
    for (const size of ['1280x800', '1920x1080', '5120x1440']) {
      const { ctx, page } = await open(theme, size)
      await go(page, intent({ do: 'research', kind: 'property', id: PID, label: LABEL }), '.lcb-launch__group')
      await page.waitForTimeout(1500)
      await shot(page, `${theme}-${size}-research`)
      await ctx.close()
    }
  }

  if (SCENES.has('perf')) {
    const { ctx, page } = await open(theme)
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Performance.enable')
    const heap = async () => { const m = await cdp.send('Performance.getMetrics'); const g = (n) => m.metrics.find((x) => x.name === n)?.value ?? 0; return { heapMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), nodes: g('Nodes'), frames: g('Frames') } }
    const fps = () => page.evaluate(() => new Promise((res) => { let f = 0; const s = performance.now(); const tick = () => { f++; if (performance.now() - s < 3000) requestAnimationFrame(tick); else res(+(f / ((performance.now() - s) / 1000)).toFixed(1)) }; requestAnimationFrame(tick) }))
    await go(page, intent({ do: 'research', kind: 'property', id: PID, label: LABEL }), '.lcb-launch__group')
    await page.waitForTimeout(2500)
    log.perf.tabs_0 = await heap()
    log.perf.shell_fps_no_frames = await fps()
    // 1 / 5 / 10 tabs of an embeddable official page, opened through the UI (one session)
    let n = 0
    for (const target of [1, 5, 10]) {
      while (n < target) {
        if (n > 0) { await page.locator('.lcb-tabs__new').click(); await page.waitForSelector('.lcb-launch__group', { timeout: 30000 }) }
        const t = Date.now()
        await page.locator('.lcb-launch__btn', { hasText: 'Property Map' }).first().click()
        await page.waitForSelector('.lcb-surface:not([hidden]) .lcb-frame', { timeout: 30000 })
        if (n === 0) log.perf.first_frame_mount_ms = Date.now() - t
        await page.waitForTimeout(3000)
        n++
      }
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
      log.perf[`tabs_${target}`] = { ...(await heap()), tabs: (await tabs(page)).length, mountedFrames: await page.locator('.lcb-frame').count() }
    }
    // tab switch latency (click → active tab painted)
    const switches = []
    const ids = await page.locator('.lcb-tab').count()
    for (let i = 0; i < Math.min(ids, 10); i++) {
      const t = Date.now()
      await page.locator('.lcb-tab').nth(i).click()
      await page.waitForFunction((k) => document.querySelectorAll('.lcb-tab')[k]?.classList.contains('is-active'), i)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      switches.push(Date.now() - t)
    }
    log.perf.tab_switch_ms = switches
    // shell FPS while a framed page is live (main-frame rAF count over 3s)
    log.perf.shell_fps_10_tabs = await fps()
    // Rail / Deck responsiveness with Browser open: ⌘K opens the Deck
    const d0 = Date.now()
    await page.keyboard.press('Meta+k')
    await page.waitForSelector('[role="combobox"], .dcb input, input[aria-label*="Search"]', { timeout: 5000 }).catch(() => {})
    log.perf.deck_open_ms = Date.now() - d0
    await page.keyboard.press('Escape')
    // workspace drag with Browser open: drag Map from the rail beside, measuring frames
    const railMap = page.locator('.cr-row', { hasText: 'Map' }).first()
    if (await railMap.count()) {
      const b = await railMap.boundingBox()
      const before = (await heap()).frames
      const t = Date.now()
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
      await page.mouse.down()
      for (let i = 0; i < 40; i++) { await page.mouse.move(b.x + 40 + i * 25, b.y + 200 + i * 6); await page.waitForTimeout(16) }
      await page.screenshot({ path: path.join(OUT, `${theme}-perf-drag.png`) })
      await page.keyboard.press('Escape')
      await page.mouse.up()
      const dt = (Date.now() - t) / 1000
      log.perf.drag_fps = +(((await heap()).frames - before) / dt).toFixed(1)
    }
    await ctx.close()
  }
}
clearTimeout(watchdog)
await browser.close()
await fs.writeFile(path.join(OUT, 'capture-log.json'), JSON.stringify(log, null, 2))
console.log(JSON.stringify(log, null, 2))
