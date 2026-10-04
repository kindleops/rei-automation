import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * RC 8.4 VISUAL PASS (READ ONLY). One step per run (--step=), serialized via the capture lock.
 * Guard: every non-GET to /api or Supabase is ABORTED and logged, except POST /rest/v1/rpc/get_*
 * (the Map's STABLE read RPCs). Never clicks Send / Launch / Approve / Arm / Ownership Check or
 * any confirm. Records every maps.googleapis.com / GIBS response status and console errors.
 *
 *   node scripts/proof/desktop/rc84-visual-capture.mjs --step=home --theme=dark --size=1440x900 --out=/tmp/x
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/rc84-visual'))
const STEP = arg('step', 'home')
const THEME = arg('theme', 'dark')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
const SUN_AT = arg('at', '2026-10-04T02:30:00Z') // 21:30 CDT / 22:30 EDT: US East + Central at night
await fs.mkdir(OUT, { recursive: true })
const tag = `${STEP}-${THEME}-${W}`
const log = { step: STEP, theme: THEME, size: `${W}x${H}`, at: new Date().toISOString(), notes: [], blockedWrites: [], apiErrors: [], google: [], gibs: { ok: 0, fail: [] }, consoleErrors: [], pageErrors: [] }
const GPU = arg('gpu', '') === '1'
const browser = await chromium.launch(GPU ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] } : {})
const dog = setTimeout(async () => { log.watchdog = true; await fs.writeFile(path.join(OUT, `${tag}.json`), JSON.stringify(log, null, 2)); await browser.close().catch(() => {}); process.exit(2) }, Number(arg('watchdog', '420000')))
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: W > 3000 ? 0.5 : 1 })
const living = arg('living', '')
// --settings=<json>: merged into THIS throwaway profile's nexus-settings only (never the owner's)
const EXTRA = JSON.parse(arg('settings', '{}'))
await ctx.addInitScript(([t, lv, extra]) => {
  try {
    localStorage.removeItem('nexus.desktop.split')
    localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
    const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
    const merged = { ...c, nexusTheme: t }
    for (const [k, v] of Object.entries(extra)) merged[k] = v && typeof v === 'object' ? { ...(c[k] || {}), ...v } : v
    localStorage.setItem('nexus-settings', JSON.stringify(merged))
    if (lv) {
      const cur = JSON.parse(localStorage.getItem('nexus.map.living') || '{}')
      localStorage.setItem('nexus.map.living', JSON.stringify({ ...cur, enabled: true, daylight: true, sun: 'dynamic', cityLights: true, sunLook: lv }))
    }
  } catch { /* ignore */ }
}, [THEME, living, EXTRA])
let page = null
ctx.on('page', (x) => { if (page && x !== page) x.close().catch(() => {}) })
page = await ctx.newPage()
page.on('pageerror', (e) => log.pageErrors.push(String(e.message).slice(0, 220)))
page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text().slice(0, 220)) })
await page.route('**/*', (r) => {
  const req = r.request(); const u = new URL(req.url())
  const guarded = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
  if (!guarded || ['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.continue()
  if (req.method() === 'POST' && /\/rest\/v1\/rpc\/get_/.test(u.pathname)) return r.continue()
  log.blockedWrites.push(`${req.method()} ${u.pathname}`)
  return r.abort()
})
log.hosts = {}
page.on('response', (res) => {
  const u = new URL(res.url())
  { const k = `${u.hostname} ${res.status()}`; log.hosts[k] = (log.hosts[k] || 0) + 1 }
  if (u.pathname.startsWith('/api/') && res.status() >= 400) log.apiErrors.push(`${res.status()} ${u.pathname}`)
  if (/maps\.googleapis\.com|maps\.gstatic\.com|googleusercontent/.test(u.hostname)) log.google.push({ s: res.status(), p: `${u.hostname}${u.pathname}`, key: (u.searchParams.get('key') || '').slice(0, 8) })
  if (/gibs\.earthdata\.nasa\.gov/.test(u.hostname)) { if (res.status() < 400) log.gibs.ok += 1; else log.gibs.fail.push(`${res.status()} ${u.pathname.slice(-60)}`) }
})
page.on('requestfailed', (q) => { const u = new URL(q.url()); if (/maps\.googleapis|gibs\./.test(u.hostname)) log.google.push({ s: 'FAILED', p: `${u.hostname}${u.pathname}`, err: q.failure()?.errorText }) })

const wait = (ms) => page.waitForTimeout(ms)
const shot = async (n) => { const f = path.join(OUT, `${tag}-${n}.png`); await page.screenshot({ path: f }); log.notes.push(`shot ${path.basename(f)}`) }
const go = async (p) => { await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await page.addStyleTag({ content: '[data-testid="dev-runtime-banner"]{display:none!important}' }).catch(() => {}) }
const note = (s) => { log.notes.push(s); console.log(s) }
const text = (sel, n = 600) => page.evaluate(([s, k]) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').slice(0, k), [sel, n])
const imgs = (sel) => page.evaluate((s) => [...document.querySelectorAll(`${s} img`)].map((i) => ({ src: i.currentSrc.replace(/key=[^&]+/, 'key=…').slice(0, 140), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth })), sel)
const jump = async (c, z, ms = 7000) => { await page.evaluate(([cc, zz]) => window.__nxMap?.jumpTo({ center: cc, zoom: zz, pitch: 0, bearing: 0 }), [c, z]); await wait(ms) }

const frames = (ms, panPx) => page.evaluate(async ([dur, px]) => {
  const m = window.__nxMap
  const d = []; let last = performance.now(); const end = last + dur
  await new Promise((res) => { const f = (t) => { d.push(t - last); last = t; if (px && m) m.panBy([px, 0], { animate: false }); if (t < end) requestAnimationFrame(f); else res() }; requestAnimationFrame(f) })
  d.shift(); d.sort((a, b) => a - b)
  const q = (p) => +d[Math.min(d.length - 1, Math.floor(p * d.length))].toFixed(1)
  return { frames: d.length, fps: +(d.length / (dur / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +d[d.length - 1].toFixed(1), long: d.filter((x) => x > 50).length }
}, [ms, panPx])
const idle = (to = 30000) => page.evaluate((t) => new Promise((res) => { const m = window.__nxMap; if (!m) return res(-1); const s = performance.now(); if (m.areTilesLoaded?.() && !m.isMoving()) { m.once('idle', () => res(+(performance.now() - s).toFixed(0))); m.triggerRepaint(); } else m.once('idle', () => res(+(performance.now() - s).toFixed(0))); setTimeout(() => res(`>${t}`), t) }), to)

const steps = {
  async home() {
    await go('/home')
    await page.waitForSelector('.hb .hb-w', { timeout: 120000 })
    await page.waitForFunction(() => document.querySelectorAll('.hb .lc-skeleton').length <= 1, null, { timeout: 45000 }).catch(() => note('skeletons still present at 45s'))
    await wait(3000)
    const m = await page.evaluate(() => [...document.querySelectorAll('.hb-w')].map((w) => ({ title: w.querySelector('.hb-w__title')?.textContent, offscreen: Boolean(w.querySelector('.hb-offscreen')), body: (w.querySelector('.hb-w__content')?.textContent || '').trim().slice(0, 90), skeleton: Boolean(w.querySelector('.lc-skeleton')) })))
    log.widgets = m
    note(`widgets=${m.length} empty=${m.filter((x) => x.offscreen || (!x.body && !x.skeleton)).map((x) => x.title).join('|') || 'none'} skeleton=${m.filter((x) => x.skeleton).map((x) => x.title).join('|') || 'none'}`)
    await shot('top')
    await page.evaluate(() => { const r = document.querySelector('.hb-scroll'); if (r) r.scrollTop += r.clientHeight * 0.85 }); await wait(4000)
    await shot('scrolled')
  },
  async nc() {
    await go('/pipeline')
    await page.waitForSelector('.cd-machine', { timeout: 120000 }); await wait(2500)
    await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click()
    await page.waitForSelector('.ncp .ncs, .ncp .lc-empty', { timeout: 180000 })
    await page.waitForFunction(() => !document.querySelector('.ncp__sync'), null, { timeout: 60000 }).catch(() => null)
    await page.mouse.move(10, H - 10); await wait(1200)
    await shot('plane')
    log.rows = await page.locator('.ncp .ncs').count()
    log.icons = await page.evaluate(() => [...document.querySelectorAll('.ncp .ncs')].slice(0, 6).map((r) => { const i = r.querySelector('[class*="icon"], [class*="app"] svg, img'); return { cls: i?.className?.toString?.().slice(0, 60) ?? null, color: i ? getComputedStyle(i).color : null } }))
    log.rowBg = await page.evaluate(() => [...document.querySelectorAll('.ncp .ncs')].slice(0, 4).map((r) => getComputedStyle(r.querySelector('.ncs__slide') || r).backgroundColor))
    if (log.rows > 1) {
      const row = page.locator('.ncp .ncs').nth(1)
      const b = await row.locator('.ncs__slide').boundingBox()
      await page.mouse.move(b.x + b.width * 0.7, b.y + b.height / 2); await page.mouse.down()
      for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width * 0.7 - i * 11, b.y + b.height / 2)
      await page.mouse.up(); await wait(600); await shot('swipe-tray')
      log.trayOpen = await page.locator('.ncp .ncs.is-swiped-end').count()
      log.trayText = await page.locator('.ncp .ncs').nth(1).innerText().catch(() => '')
      await page.mouse.click(10, H - 10).catch(() => null); await wait(400)
      if (!(await page.locator('.ncp').count())) { await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click(); await page.waitForSelector('.ncp .ncs') }
      await page.locator('.ncp .ncs').nth(0).locator('.ncs__check').click({ force: true })
      await page.locator('.ncp .ncs').nth(2).locator('.ncs__check').click({ force: true, modifiers: ['Shift'] })
      await wait(500); await shot('multi-select')
      log.selected = await page.locator('.ncp .ncs.is-selected').count()
      log.checkStyle = await page.evaluate(() => [...document.querySelectorAll('.ncp .ncs__check')].slice(0, 4).map((c) => ({ checked: c.checked, bg: getComputedStyle(c).backgroundColor, tick: getComputedStyle(c, '::after').borderRightColor })))
      log.chipStyle = await page.evaluate(() => { const e = [...document.querySelectorAll('.ncp .ncs *')].find((x) => x.children.length === 0 && /Held for your review/.test(x.textContent || '')); if (!e) return null; const cs = getComputedStyle(e); return { cls: String(e.className), color: cs.color, bg: cs.backgroundColor, opacity: cs.opacity, parentOpacity: getComputedStyle(e.parentElement).opacity, parentCls: String(e.parentElement.className) } })
      log.bulkBar = await text('.ncp .lc-bulk', 200)
      // Clear all opens a confirm; we photograph it and CANCEL with Escape (the confirm is never pressed)
      await page.keyboard.press('Escape'); await wait(300)
      if (!(await page.locator('.ncp').count())) { await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click(); await page.waitForSelector('.ncp .ncs') }
      const clear = page.locator('.ncp button', { hasText: /^Clear all/ }).first()
      if (await clear.count()) { await clear.click(); await wait(600); await shot('clear-all-confirm'); log.confirmText = await page.locator('.lc-dialog').innerText().catch(() => null); await page.keyboard.press('Escape'); await wait(400) } else note('no Clear all button')
    }
  },
  async settings() {
    await go('/settings?section=alerts')
    await page.waitForSelector('.st-body', { timeout: 120000 }); await wait(1500)
    await shot('alerts')
    log.clip = await page.evaluate(() => { const r0 = document.querySelector('.st-body').getBoundingClientRect(); const lim = Math.min(innerWidth, r0.right); return [...document.querySelectorAll('.st-body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > lim + 1.5 }).slice(0, 6).map((e) => `${e.tagName}.${String(e.className).slice(0, 40)} r=${Math.round(e.getBoundingClientRect().right)} lim=${Math.round(lim)}`) })
    log.typing = await page.evaluate(() => (document.querySelector('.st-body')?.innerText || '').match(/Typing[\s\S]{0,400}/)?.[0]?.replace(/\s+/g, ' ') ?? null)
    await page.evaluate(() => { const s = document.querySelector('.st-body'); const t = [...document.querySelectorAll('.st-body *')].find((e) => /typing/i.test(e.textContent || '') && e.children.length < 3); t?.scrollIntoView({ block: 'center' }); if (!t && s) s.scrollTop = s.scrollHeight })
    await wait(800); await shot('alerts-typing')
    await go('/pipeline')
    await page.waitForSelector('.cd-machine', { timeout: 120000 }); await wait(1500)
    await page.locator('button.cd-op').click(); await page.waitForSelector('.dsk-pop--profile')
    await page.locator('.dsk-pop--profile .dsk-seg__tab', { hasText: 'Sound' }).click(); await wait(800)
    await shot('profile-sound')
    log.profileClip = await page.evaluate(() => { const p = document.querySelector('.dsk-pop--profile'); const r0 = p.getBoundingClientRect(); const lim = Math.min(innerWidth, r0.right); return { box: [Math.round(r0.left), Math.round(r0.right)], over: [...p.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > lim + 1.5 }).length, text: p.innerText.replace(/\s+/g, ' ').slice(0, 500) } })
  },
  async mapnight() {
    // Dynamic (sun) — the 8.4 deep night + city lights on the user's chosen basemap (sunLook=basemap)
    await go(`/map?sun_at=${encodeURIComponent(SUN_AT)}`)
    await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 120000 })
    await page.waitForFunction(() => Boolean(window.__nxMap), null, { timeout: 60000 }).catch(() => note('no __nxMap'))
    await wait(6000)
    await jump([-96, 38.5], 3.7, 9000); await shot('national')
    log.legend = await text('.mxd-legend', 300)
    await jump([-93.27, 44.98], 10.5, 9000); await shot('metro-minneapolis-night')
    await jump([-118.3, 34.05], 10.2, 8000); await shot('metro-la')
  },
  async darksat() {
    // a0692570 — Dynamic's satellite look: Black Marble night base ≤ z8, graded satellite past z9
    const res = {}
    const t0 = Date.now()
    await go(`/map?sun_at=${encodeURIComponent(SUN_AT)}`)
    await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 120000 })
    await page.waitForFunction(() => Boolean(window.__nxMap), null, { timeout: 60000 }).catch(() => note('no __nxMap'))
    res.firstIdleMs = await idle(45000); res.bootToIdleMs = Date.now() - t0
    await wait(2000)
    const views = [['national', [-96, 38.5], 3.7], ['region-east', [-80, 39.5], 6.6], ['handoff-z8-nyc', [-74.0, 40.72], 8.6], ['handoff-z9-nyc', [-74.0, 40.72], 9.4], ['metro-chicago', [-87.65, 41.88], 11], ['street-nyc', [-73.985, 40.748], 15.2], ['day-la', [-118.3, 34.05], 11]]
    res.tiles = {}
    for (const [n, c, z] of views) {
      await page.evaluate(([cc, zz]) => window.__nxMap?.jumpTo({ center: cc, zoom: zz, pitch: 0, bearing: 0 }), [c, z])
      res.tiles[n] = await idle(30000)
      await wait(1500); await shot(n)
    }
    await page.evaluate(() => window.__nxMap?.jumpTo({ center: [-87.65, 41.88], zoom: 9.0 })); await idle(30000); await wait(1000)
    res.idleFrames = await frames(4000, 0)
    res.panFrames = await frames(5000, 4)
    res.tilesAfterPan = await idle(30000)
    await page.evaluate(() => window.__nxMap?.jumpTo({ center: [-96, 38.5], zoom: 3.7 })); await idle(30000)
    res.panNational = await frames(5000, 6)
    res.sunCost = await page.evaluate(() => ({ sun: window.__nxSunCost ?? null, lights: window.__nxLightsCost ?? null }))
    res.style = await page.evaluate(() => { const m = window.__nxMap; try { return { layers: m.getStyle().layers.length, sources: Object.keys(m.getStyle().sources).filter((s) => /light|marble|sat|nx/i.test(s)) } } catch { return null } })
    res.gl = await page.evaluate(() => { try { const c = document.createElement('canvas').getContext('webgl'); const e = c.getExtension('WEBGL_debug_renderer_info'); return c.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : c.RENDERER) } catch (x) { return String(x) } })
    res.heapMB = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)
    log.darksat = res
    note(`DARKSAT ${JSON.stringify(res)}`)
  },
  async seller() {
    // Map property focus → the desktop seller/property card and its imagery
    await go('/map')
    await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 120000 }); await wait(6000)
    const pid = arg('pid', '273312064')
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent('nexus:map-property-focus', { detail: { seq: Date.now() + 900000, propertyId: p, label: null, threadKey: null, lat: null, lng: null, source: 'capture', at: Date.now() } })), pid)
    await wait(9000)
    await shot('focus')
    log.cardImgs = await imgs('body')
    log.cardText = await text('.nx-seller-card, .mxd-card, [class*="seller-card"], [class*="inspector"]', 300)
  },
  async comps() {
    const subject = arg('subject', '273448158')
    await go(`/comp-intelligence?property_id=${subject}`)
    await page.waitForSelector('.ciw', { timeout: 180000 })
    await page.waitForSelector('.ciw-map[data-map="ready"]', { timeout: 120000 }).catch(() => note('map not ready'))
    await wait(8000)
    await shot('workstation')
    log.recentToggle = await page.locator('[data-layer="recent-market-sales"]').count()
    log.legend = await text('.ciw-legend', 300)
    log.imgsBefore = await imgs('.ciw')
    // hover a comp row → map halo/popover; click a comp row → inspector with image
    const row = page.locator('[data-comp-row]').nth(1)
    if (await row.count()) { await row.hover(); await wait(1200); await shot('row-hover'); await row.click(); await wait(3500); await shot('comp-open') } else note('no comp rows')
    // click a comp point on the map canvas → popover
    const pt = await page.evaluate(() => { const m = window.__nxCompsMap || null; return Boolean(m) })
    note(`comps map handle=${pt}`)
    log.imgsAfter = await imgs('.ciw')
    await page.locator('.ciw-map').hover().catch(() => null)
  },
  async browser() {
    await go('/browser')
    await page.waitForSelector('.lcb-addr__input', { timeout: 120000 }); await wait(2500)
    const st = () => page.evaluate(() => ({ value: document.querySelector('.lcb-addr__input')?.value, card: document.querySelector('.lcb-state__title')?.textContent ?? null, open: document.querySelector('.lcb-state__open')?.textContent ?? null, frame: document.querySelector('.lcb-surface:not([hidden]) iframe')?.getAttribute('src') ?? null }))
    log.browser = []
    for (const [i, q] of ['https://gis.hennepin.us/property/', 'https://www.minneapolismn.gov/', 'zillow.com'].entries()) {
      await page.locator('.lcb-addr__input').click()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await page.keyboard.type(q, { delay: 15 }); await page.keyboard.press('Enter'); await wait(q.includes('zillow') ? 2000 : 6000)
      const s = await st(); log.browser.push({ q, ...s }); note(`browser ${q} → ${JSON.stringify(s)}`)
      await shot(`nav-${i + 1}`)
    }
  },
  async composer() {
    const q = new URLSearchParams({ compose: '1', market: arg('market', 'Minneapolis, MN') })
    const t0 = Date.now()
    await go(`/campaign-command?${q}`)
    await page.waitForSelector('.ccz', { timeout: 120000 })
    await page.waitForFunction(() => /\d/.test(document.querySelector('.ccz-dock__count b')?.textContent || ''), null, { timeout: 180000 }).catch(() => note('dock count never landed'))
    log.countMs = Date.now() - t0
    await wait(4000)
    await shot('audience')
    log.dock = await text('.ccz-dock', 400)
    log.funnel = await page.evaluate(() => { const f = [...document.querySelectorAll('.ccz [class*="funnel"]')][0]; return f ? f.innerText.replace(/\s+/g, ' ').slice(0, 700) : null })
    log.sizeCtl = await page.evaluate(() => { const all = [...document.querySelectorAll('.ccz *')].filter((e) => /All eligible/.test(e.textContent || '') && e.children.length < 4); const e = all[all.length - 1]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { tag: e.tagName, cls: String(e.className).slice(0, 60), text: e.textContent.trim().slice(0, 80), box: [Math.round(r.width), Math.round(r.height)], ctx: e.closest('section, fieldset, [role="radiogroup"], div')?.innerText?.replace(/\s+/g, ' ').slice(0, 300) } })
    note(`sizeCtl ${JSON.stringify(log.sizeCtl)}`)
    const chip = page.locator('.ccz-dock__issue', { hasText: /campaign size/i }).first()
    if (await chip.count()) { await chip.click(); await wait(2500) }
    log.sizeOptions = await page.evaluate(() => { const e = [...document.querySelectorAll('.ccz button, .ccz [role="radio"], .ccz label')].filter((x) => /^All eligible/.test((x.textContent || '').trim())); return e.map((x) => { const r = x.getBoundingClientRect(); const cs = getComputedStyle(x); return { tag: x.tagName, cls: String(x.className).slice(0, 60), text: x.textContent.trim().slice(0, 60), box: [Math.round(r.width), Math.round(r.height)], visible: r.width > 0 && r.top < innerHeight && r.bottom > 0, weight: cs.fontWeight, ctx: x.closest('section, fieldset, [role="radiogroup"]')?.innerText?.replace(/\s+/g, ' ').slice(0, 260) } }) })
    note(`sizeOptions ${JSON.stringify(log.sizeOptions)}`)
    await wait(800); await shot('size-control')
    const fun = page.locator('.ccz [class*="funnel"]').first()
    if (await fun.count()) { await fun.scrollIntoViewIfNeeded(); await wait(600); await shot('funnel') }
    await page.locator('.ccz-head__meta button', { hasText: 'Map beside' }).click()
    const tB = Date.now()
    await page.waitForSelector('.lc-cpv, .dsk-pane button:has-text("Retry")', { timeout: 60000 }).catch(() => null)
    const retry = page.locator('.dsk-pane button', { hasText: /^Retry$/ }).first()
    if (!(await page.locator('.lc-cpv').count()) && (await retry.count())) { note('map pane unavailable → Retry'); await retry.click() }
    await page.waitForSelector('.lc-cpv__counts', { timeout: 180000 }).catch(() => note('preview counts never landed'))
    log.previewMs = Date.now() - tB
    await wait(4500)
    await shot('map-preview')
    log.preview = await page.evaluate(() => ({ counts: document.querySelector('.lc-cpv__counts')?.getAttribute('aria-label') ?? null, title: document.querySelector('.lc-cpv__title h2')?.textContent ?? null, markets: [...document.querySelectorAll('.lc-cpv__market')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()) }))
    note(`preview ${JSON.stringify(log.preview)} in ${log.previewMs}ms`)
  },
  async inbox() {
    await go('/inbox')
    await page.waitForSelector('[role="option"] .ixl-row__who', { timeout: 300000 }); await wait(2000)
    await page.locator('[role="option"]').nth(Number(arg('row', '0'))).click(); await wait(6000)
    await shot('thread')
    const poster = page.locator('button', { hasText: /Load aerial view/ }).first()
    const tabAerial = page.locator('[role="tab"]', { hasText: /Aerial|Satellite/ }).first()
    if (await tabAerial.count()) { await tabAerial.click(); await wait(2000) }
    if (await poster.count()) { await poster.click(); await wait(6000) }
    await shot('aerial')
    log.intelImgs = await imgs('body')
    log.iframes = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src.replace(/key=[^&]+/, 'key=…').slice(0, 120)))
  },
  async property() {
    await go('/properties')
    await page.waitForSelector('.pi-visual-panel, [class*="property"]', { timeout: 180000 }); await wait(5000)
    if (!(await page.locator('.pi-visual-panel').count())) {
      const first = page.locator('[role="row"], [role="option"], tbody tr').nth(1)
      if (await first.count()) { await first.click(); await wait(5000) }
    }
    await shot('view')
    log.tabs = []
    for (const t of ['Street', 'Satellite', 'Map']) {
      const tab = page.locator('.pi-visual-tabs [role="tab"]', { hasText: t }).first()
      if (!(await tab.count())) { note(`no tab ${t}`); continue }
      await tab.click(); await wait(3500)
      await page.locator('.pi-visual-panel').scrollIntoViewIfNeeded().catch(() => null)
      await shot(`tab-${t.toLowerCase()}`)
      log.tabs.push({ t, imgs: await imgs('.pi-visual-panel') })
    }
  },
  async sellerclick() {
    await go('/map')
    await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 120000 })
    await page.waitForFunction(() => Boolean(window.__nxMap), null, { timeout: 60000 }).catch(() => note('no __nxMap'))
    await wait(4000)
    await jump([-93.2905, 45.0005], Number(arg('z', '13.5')), 15000)
    await shot('before-click')
    const pt = await page.evaluate(() => { const m = window.__nxMap; const ids = m.getStyle().layers.map((l) => l.id).filter((id) => /dot|pin|orb/i.test(id)); const fs = m.queryRenderedFeatures({ layers: ids }).filter((f) => f.geometry?.type === 'Point'); const c = m.getCanvas().getBoundingClientRect(); const f = fs.find((x) => { const p = m.project(x.geometry.coordinates); return p.x > 200 && p.x < c.width - 200 && p.y > 200 && p.y < c.height - 200 }) || fs[0]; if (!f) return { n: 0, ids }; const p = m.project(f.geometry.coordinates); return { n: fs.length, x: c.left + p.x, y: c.top + p.y, layer: f.layer.id, props: Object.keys(f.properties || {}).slice(0, 6) } })
    note(`dots ${JSON.stringify(pt)}`)
    const fixed = arg('click', '')
    if (fixed) { const [cx, cy] = fixed.split(',').map(Number); pt.x = cx; pt.y = cy; pt.n = pt.n || 1 }
    if (!pt.n) return
    await page.mouse.click(pt.x, pt.y); await wait(7000)
    await shot('card')
    const ex = arg('expand', '')
    if (ex) { const [ex1, ey1] = ex.split(',').map(Number); await page.mouse.click(ex1, ey1); await wait(7000); await shot('card-expanded'); log.expandedText = await text('body', 50) }
    log.tabs = await page.evaluate(() => [...document.querySelectorAll('.smcd-tabs button, .smcd-tabs [role="tab"], .smcd-tabs__pill')].map((b) => b.textContent.trim()).filter(Boolean))
    log.cardImgs = await imgs('body')
    note(`tabs ${JSON.stringify(log.tabs)}`)
    for (const t of ['Satellite', 'Map', 'Street']) {
      const b = page.locator('.smcd-tabs button, .smcd-tabs [role="tab"]', { hasText: new RegExp(`^${t}`) }).first()
      if (await b.count()) { await b.click(); await wait(3500); await shot(`card-${t.toLowerCase()}`); log[`imgs_${t}`] = await imgs('body') }
    }
  },
  async multiinbox() {
    const N = Number(arg('panes', '1'))
    const lenses = (arg('lenses', 'new_replies,needs_review,follow_up')).split(',')
    const INTERACT = arg('interact', '') === '1'
    const ph = { name: 'load', writes: [] }
    const phases = [ph]
    let cur = ph
    const counters = { live: 0, counts: 0, api: 0, apiPaths: {}, wsOpen: 0, joins: [], leaves: 0 }
    page.on('request', (q) => { const u = new URL(q.url()); if (!u.pathname.startsWith('/api/')) return; counters.api += 1; const k = u.pathname.replace(/\/[0-9a-f-]{8,}.*/, '/:id'); counters.apiPaths[k] = (counters.apiPaths[k] || 0) + 1; if (u.pathname === '/api/cockpit/inbox/live') counters.live += 1; if (u.pathname.startsWith('/api/cockpit/inbox/counts')) counters.counts += 1 })
    page.on('websocket', (ws) => { counters.wsOpen += 1; ws.on('framesent', (f) => { const s = String(f.payload || ''); if (s.includes('phx_join')) { const m = s.match(/"topic":"([^"]+)"/) || s.match(/\["?[^,]*,"?[^,]*,"([^"]+)","phx_join"/); counters.joins.push(m ? m[1] : 'join') } if (s.includes('phx_leave')) counters.leaves += 1 }) })
    page.on('request', (q) => { const u = new URL(q.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) cur.writes.push(`${q.method()} ${u.pathname}`) })
    const phase = (name) => { cur = { name, writes: [] }; phases.push(cur) }
    const unread = () => page.evaluate(() => [...document.querySelectorAll('[data-ixm-pane]')].map((p) => ({ pane: p.getAttribute('data-ixm-pane'), rows: p.querySelectorAll('.ixl-row').length, unread: p.querySelectorAll('.ixl-row.is-unread').length, title: (p.querySelector('.ixm-head__title, .ixl-head h2, [class*="lens"] [aria-selected="true"]')?.textContent || '').trim().slice(0, 40), count: (p.querySelector('.ixm-head__count')?.textContent || '').trim() })))
    const t0 = Date.now()
    await go('/inbox')
    await page.waitForSelector('.ixl-row', { timeout: 120000 }).catch(() => note('no rows'))
    await page.evaluate(({ N, lenses }) => { const fire = (d) => window.dispatchEvent(new CustomEvent('nexus:command-action', { detail: { kind: 'inbox_multi', ...d } })); fire({ op: 'set_count', count: N }); lenses.slice(0, Math.max(0, N - 1)).forEach((view, i) => fire({ op: 'set_view', pane: i + 2, view })) }, { N, lenses })
    if (N > 1) await page.waitForFunction((n) => document.querySelectorAll("[data-ixm-pane]").length >= n, N, { timeout: 30000 }).catch(() => note(`pane count never reached ${N}`))
    await page.waitForFunction((n) => [...document.querySelectorAll('[data-ixm-pane]')].slice(0, n).every((p) => p.querySelector('.ixl-row, .lc-empty, [class*="empty"]')), N, { timeout: 60000 }).catch(() => note('not every pane rendered rows'))
    log.firstUsableMs = Date.now() - t0
    await wait(4000)
    log.load = { ...counters, joins: [...counters.joins], apiPaths: { ...counters.apiPaths } }
    log.debugAtLoad = await page.evaluate(() => window.__lcInboxDebug?.snapshot?.() ?? null)
    log.panesSeen = await page.locator('[data-ixm-pane]').count()
    log.layoutKind = await page.evaluate(() => document.querySelector('.ixm')?.className || null)
    log.unreadAfterLoad = await unread()
    await shot(`${N}pane`)
    if (INTERACT && N >= 2) {
      const s1 = N >= 3 ? 1 : 0, s2 = N >= 3 ? 2 : 1
      phase('search+filter+nav')
      const search = async (i, q) => { const inp = page.locator(`[data-ixm-pane="${i}"] .ixm-head__search input, [data-ixm-pane="${i}"] input.ixm-head__search, [data-ixm-pane="${i}"] input[type="search"]`).first(); if (await inp.count()) { await inp.fill(q); await wait(2500) } else note(`no search input in pane ${i}`) }
      await search(s1, arg('q1', 'ave')); await search(s2, arg('q2', 'st'))
      await page.evaluate(([p, v]) => window.dispatchEvent(new CustomEvent('nexus:command-action', { detail: { kind: 'inbox_multi', op: 'set_view', pane: p + 1, view: v } })), [s2, arg('v2', 'all_conversations')])
      await wait(3000)
      const list = page.locator(`[data-ixm-pane="${s1}"] .ixl-list, [data-ixm-pane="${s1}"] [role="listbox"]`).first()
      await list.focus().catch(() => null)
      for (let k = 0; k < 4; k += 1) { await page.keyboard.press('ArrowDown'); await wait(400) }
      await page.mouse.move(5, 5); await wait(1500)
      log.unreadAfterNav = await unread()
      await shot(`${N}pane-searches`)
      phase('open-conversations')
      const before = await page.evaluate((i) => { const p = document.querySelector(`[data-ixm-pane="${i}"]`); const sc = p?.querySelector('.ixl-scroll, .ixl-list, [role="listbox"]'); return { first: p?.querySelector('.ixl-row')?.textContent?.slice(0, 60), scroll: sc?.scrollTop ?? null, search: p?.querySelector('input')?.value ?? null } }, s1)
      const openRow = async (i) => { const r = page.locator(`[data-ixm-pane="${i}"] .ixl-row`).nth(1); if (await r.count()) { const b = await r.boundingBox(); await page.mouse.click(b.x + Math.min(120, b.width * 0.3), b.y + b.height / 2); await wait(4000) } else note(`no row to open in pane ${i}`) }
      await openRow(s1); await openRow(s2)
      log.openState = await page.evaluate(() => [...document.querySelectorAll('[data-ixm-pane]')].map((p) => ({ pane: p.getAttribute('data-ixm-pane'), conv: Boolean(p.querySelector('.ixm-pane-body.has-conversation, .ixm-conv, [class*="PaneConversation"], .ixc')) || /conversation/i.test(p.querySelector('[class*="has-conversation"]')?.className || '') })))
      await shot(`${N}pane-two-open`)
      log.paneComposers = await page.evaluate(() => [...document.querySelectorAll('[data-ixm-pane]')].map((p) => ({ pane: p.getAttribute('data-ixm-pane'), composer: Boolean(p.querySelector('.ixm-conversation__composer textarea, .ixm-conversation__composer [contenteditable], .ixm-conversation__composer input')), sendBtn: [...p.querySelectorAll('.ixm-conversation__composer button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()).filter(Boolean).slice(0, 4) })))
      log.debugAfterOpen = await page.evaluate(() => window.__lcInboxDebug?.snapshot?.() ?? null)
      phase('close')
      // pane s1: the × (Close conversation); pane s2: Esc with focus inside the conversation
      const x1 = page.locator(`[data-ixm-pane="${s1}"] button[aria-label="Close conversation"], [data-ixm-pane="${s1}"] button[aria-label="Back to inbox"]`).first()
      log.closeX = await x1.count()
      if (log.closeX) { log.closeXStyle = await x1.evaluate((b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], opacity: cs.opacity, visibility: cs.visibility, display: cs.display, pe: cs.pointerEvents, coveredBy: top && top !== b && !b.contains(top) ? `${top.tagName}.${String(top.className).slice(0, 50)}` : null } }); if (log.closeXStyle.display !== 'none') await x1.click(); else { const f1 = page.locator(`[data-ixm-pane="${s1}"] .ixm-conversation button:visible`).first(); if (await f1.count()) { await f1.focus(); await page.keyboard.press('Escape') } } }
      await wait(1200)
      const f2 = page.locator(`[data-ixm-pane="${s2}"] .ixm-conversation button:visible`).first()
      log.escTarget = await f2.count()
      if (log.escTarget) { await f2.focus(); await page.keyboard.press('Escape') }
      await wait(1200)
      const after = await page.evaluate((i) => { const p = document.querySelector(`[data-ixm-pane="${i}"]`); const sc = p?.querySelector('.ixl-scroll, .ixl-list, [role="listbox"]'); return { first: p?.querySelector('.ixl-row')?.textContent?.slice(0, 60), scroll: sc?.scrollTop ?? null, search: p?.querySelector('input')?.value ?? null } }, s1)
      log.closeRestore = { before, after, same: before.first === after.first && before.search === after.search }
      log.closedState = await page.evaluate(() => [...document.querySelectorAll('.ixm-pane-body')].map((b) => b.classList.contains('has-conversation')))
      await shot(`${N}pane-closed`)
    }
    log.debugEnd = await page.evaluate(() => window.__lcInboxDebug?.snapshot?.() ?? null)
    log.total = { ...counters, joins: counters.joins.length, joinTopics: [...new Set(counters.joins)] }
    log.phases = phases.map((p) => ({ name: p.name, writes: p.writes, readWrites: p.writes.filter((w) => /thread-state|read/i.test(w)) }))
    note(`MI ${JSON.stringify({ N, dbg: log.debugAtLoad, dbgEnd: log.debugEnd, firstUsableMs: log.firstUsableMs, load: { live: log.load.live, counts: log.load.counts, api: log.load.api, ws: log.load.wsOpen, joins: log.load.joins.length }, phases: log.phases.map((p) => [p.name, p.readWrites.length, p.writes.length]), unread: log.unreadAfterLoad, closeRestore: log.closeRestore?.same })}`)
  },
  async pipeline() {
    const cols = ['Year built', 'Beds', 'Language', 'AOS', 'Last message', 'Conversation']
    await go('/pipeline')
    await page.waitForSelector('.pd2[data-ready="1"]', { timeout: 120000 }).catch(() => note('pd2 not ready'))
    await wait(2500); await shot('overview')
    log.neutralLeak = await page.evaluate(() => { const d = document.createElement('div'); d.className = 'is-neutral'; d.textContent = 'x'; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c })
    log.nurtureChip = await text('.pd2-lenschip', 80)
    await go('/pipeline?pv=table')
    await page.waitForSelector('.pd2-table', { timeout: 120000 }); await wait(3500)
    log.headersBefore = await page.evaluate(() => [...document.querySelectorAll('.pd2-table [role="columnheader"], .pd2-table .lc-grid__th')].map((h) => h.textContent.trim()).filter(Boolean))
    await page.locator('.pd2-table button', { hasText: /^Columns/ }).first().click()
    await page.waitForSelector('.pd2-cols', { timeout: 10000 })
    for (const c of cols) {
      const s = page.locator('.pd2-cols__search input').first(); await s.fill(c); await wait(400)
      const t = page.locator('.pd2-cols__all .pd2-cols__toggle', { hasText: new RegExp(`^\\s*${c}`) }).first()
      if (await t.count()) { if ((await t.getAttribute('aria-pressed')) !== 'true') await t.click(); } else note(`column ${c} not found`)
      await wait(300)
    }
    await page.locator('.pd2-cols__search input').first().fill(''); await wait(400)
    await page.locator('button[aria-label="Move Year built left"]').first().click().catch(() => note('no move-left for Year built'))
    await wait(400); await shot('column-picker')
    await page.keyboard.press('Escape'); await wait(4000)
    const readHeaders = () => page.evaluate(() => [...document.querySelectorAll('.pd2-table [role="columnheader"], .pd2-table .lc-grid__th')].map((h) => h.textContent.trim()).filter(Boolean))
    log.headersAfter = await readHeaders()
    log.cellSample = await page.evaluate((names) => { const hs = [...document.querySelectorAll('.pd2-table [role="columnheader"], .pd2-table .lc-grid__th')]; const out = {}; for (const n of names) { const i = hs.findIndex((h) => h.textContent.trim().startsWith(n)); if (i < 0) { out[n] = 'no header'; continue } const rows = [...document.querySelectorAll('.pd2-table [role="row"]')].slice(1, 13); const vals = rows.map((r) => r.querySelectorAll('[role="gridcell"], [role="cell"], .lc-grid__td')[i]?.textContent?.trim() ?? '?'); out[n] = { filled: vals.filter((v) => v && v !== '—' && v !== 'Unknown' && v !== '?').length, of: vals.length, eg: vals.slice(0, 4) } } return out }, cols)
    note(`PIPE cols ${JSON.stringify(log.cellSample)}`)
    await shot('table-columns')
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.pd2-table', { timeout: 120000 }); await wait(4000)
    log.headersReload = await readHeaders()
    log.persisted = cols.every((c) => log.headersReload.some((h) => h.startsWith(c)))
    await shot('table-reloaded')
    // Nurture lens
    const chip = page.locator('.pd2-lenschip').first()
    if (await chip.count()) { await chip.click(); await wait(5000); log.nurtureRows = await page.locator('.pd2-table [role="row"]').count() - 1; log.lensText = await text('.pd2-table', 200); await shot('nurture-lens') } else note('no nurture chip')
    // Offers ledger
    await go('/pipeline?pv=offers'); await page.waitForSelector('.pd2[data-mode="offers"]', { timeout: 120000 }); await wait(5000); await shot('offers')
    log.offersText = await text('.pd2-scroll', 400)
    // Open conversation / DI beside (guarded; the conversation open's read write is aborted)
    await go('/pipeline?pv=table'); await page.waitForSelector('.pd2-table [role="row"]', { timeout: 120000 }); await wait(3500)
    const row = page.locator('.pd2-table [role="row"]').nth(2)
    const b = await row.boundingBox(); await page.mouse.click(b.x + 140, b.y + b.height / 2); await wait(2500)
    await shot('deal-open')
    const conv = page.locator('button', { hasText: /^Open conversation/ }).first()
    if (await conv.count()) { await conv.click(); await wait(15000); log.afterConv = { url: page.url(), panes: await page.locator('.dsk-pane').count(), pipelineStill: await page.locator('.pd2').count() }; await shot('conversation-beside') } else note('no Open conversation button')
    const di = page.locator('button', { hasText: /^Deal Intelligence/ }).first()
    if (await di.count()) { await di.click(); await wait(15000); log.afterDi = { url: page.url(), panes: await page.locator('.dsk-pane').count(), pipelineStill: await page.locator('.pd2').count() }; await shot('di-beside') } else note('no DI button')
    await page.goBack().catch(() => null); await wait(4000)
    log.afterBack = { url: page.url(), mode: await page.locator('.pd2').getAttribute('data-mode').catch(() => null) }
    await shot('after-back')
    note(`PIPE ${JSON.stringify({ persisted: log.persisted, nurture: log.nurtureChip, nurtureRows: log.nurtureRows, conv: log.afterConv, di: log.afterDi, back: log.afterBack, neutral: log.neutralLeak })}`)
  },
  async eg() {
    const cols = ['Year built', 'Zoning', 'Beds', 'Baths', 'Building sqft', 'Repair estimate', 'Last sale date']
    await go('/entity-graph')
    await page.waitForSelector('.egt .egt-row', { timeout: 180000 }).catch(() => note('no EG table'))
    await wait(4000); await shot('table')
    await page.locator('button[aria-label="Columns"]').first().click(); await page.waitForSelector('.egcol', { timeout: 10000 })
    for (const c of cols) {
      const s = page.locator('.egcol-search input, input[placeholder="Search fields…"]').first(); await s.fill(c); await wait(400)
      const r = page.locator('.egcol-row__toggle.is-catalog:not(.is-on)', { has: page.locator('.egcol-row__label', { hasText: new RegExp(`^${c}$`) }) }).first()
      if (await r.count()) await r.click(); else note(`EG column ${c} not found or already on`)
      await wait(300)
    }
    await shot('column-sheet')
    await page.locator('.egm-btn.is-primary', { hasText: 'Done' }).click(); await wait(6000)
    const heads = () => page.evaluate(() => [...document.querySelectorAll('.egt-row.is-head > *')].map((h) => h.textContent.trim()))
    log.heads = await heads()
    log.values = await page.evaluate((names) => { const hs = [...document.querySelectorAll('.egt-row.is-head > *')].map((h) => h.textContent.trim()); const rows = [...document.querySelectorAll('.egt-row:not(.is-head)')].slice(0, 20); const o = {}; for (const n of names) { const i = hs.findIndex((h) => h.startsWith(n)); if (i < 0) { o[n] = 'no header'; continue } const v = rows.map((r) => r.children[i]?.textContent?.trim() ?? '?'); o[n] = { filled: v.filter((x) => x && x !== '—').length, of: v.length, eg: v.slice(0, 3) } } return o }, cols)
    note(`EG values ${JSON.stringify(log.values)}`)
    await shot('table-columns')
    const head = (n) => page.locator('.egt-row.is-head button', { hasText: new RegExp(`^${n}`) }).first()
    log.sort = []
    for (let k = 0; k < 3; k += 1) { await head('Year built').click(); await wait(1500); log.sort.push({ aria: await head('Year built').getAttribute('aria-sort'), status: await text('.egt-status', 120), first: await page.evaluate(() => { const hs = [...document.querySelectorAll('.egt-row.is-head > *')].map((h) => h.textContent.trim()); const i = hs.findIndex((h) => h.startsWith('Year built')); return [...document.querySelectorAll('.egt-row:not(.is-head)')].slice(0, 4).map((r) => r.children[i]?.textContent?.trim()) }) }); if (k === 0) await shot('sort-year-asc') }
    const v = head('Value'); if (await v.count()) { await v.click(); await wait(5000); log.valueSort = { aria: await v.getAttribute('aria-sort'), status: await text('.egt-status', 120) }; await shot('sort-value') } else note('no Value header')
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.egt .egt-row', { timeout: 180000 }); await wait(5000)
    log.headsReload = await heads(); log.persisted = cols.every((c) => log.headsReload.some((h) => h.startsWith(c)))
    await shot('reloaded')
    note(`EG ${JSON.stringify({ sort: log.sort, valueSort: log.valueSort, persisted: log.persisted })}`)
  },
}

try { await steps[STEP]() } catch (e) { note(`FAILED: ${String(e.message).slice(0, 300)}`); await shot('failed').catch(() => {}) }
clearTimeout(dog)
log.googleSummary = log.google.reduce((a, g) => { const k = `${g.s} ${g.p.split('/').slice(0, 4).join('/')}`; a[k] = (a[k] || 0) + 1; return a }, {})
await fs.writeFile(path.join(OUT, `${tag}.json`), JSON.stringify(log, null, 2))
console.log('HOSTS', JSON.stringify(log.hosts))
console.log(JSON.stringify({ step: STEP, notes: log.notes.filter((n) => !n.startsWith('shot')), blocked: log.blockedWrites.length, apiErrors: [...new Set(log.apiErrors)].slice(0, 6), google: log.googleSummary, gibs: { ok: log.gibs.ok, fail: log.gibs.fail.length }, pageErrors: log.pageErrors.slice(0, 4), consoleErrors: [...new Set(log.consoleErrors)].slice(0, 6) }, null, 1))
await browser.close()
