import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * ENVIRONMENT STUDIO 3.0 — one-pass proof (READ ONLY).
 *
 * Every non-GET to /api or Supabase is aborted. Appearance is UI preference
 * in localStorage; nothing here writes product data. To keep load on the
 * shared machine low, each viewport is ONE page load: every theme, environment,
 * material, built-in environment and editor state is reached by clicking the
 * Studio itself, in place.
 *
 *   node scripts/proof/desktop/environment-studio-capture.mjs --out=/tmp/es [--ultrawide=1] [--only=1440]
 *
 * Also measured live: style-recalc / script cost of a hue drag, localStorage
 * writes per drag (debounced persistence), whether the token sheet lands
 * before React's first paint (no flash), cross-tab sync via the storage
 * event, and corrupt-settings fallback.
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', '/tmp/es'))
const ULTRA = arg('ultrawide', '1') === '1'
const ONLY = arg('only', '')
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const report = { notes: [], errors: [], blocked: [], metrics: {} }
const note = (k, v) => { report.notes.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`); console.log(k, typeof v === 'string' ? v : JSON.stringify(v)) }

async function newPage(W, H) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await ctx.addInitScript(() => {
    // first-paint ordering probe: is the token sheet in place before React renders?
    const t0 = performance.now()
    window.__esProbe = { sheetAt: null, rootAt: null }
    const mo = new MutationObserver(() => {
      if (window.__esProbe.sheetAt === null && document.getElementById('lc-appearance')) window.__esProbe.sheetAt = performance.now() - t0
      const root = document.getElementById('root')
      if (window.__esProbe.rootAt === null && root && root.childElementCount > 0) window.__esProbe.rootAt = performance.now() - t0
    })
    mo.observe(document, { childList: true, subtree: true })
    // seed once per browser context (shared by every tab in it)
    if (localStorage.getItem('es.seeded.v1')) return
    localStorage.setItem('es.seeded.v1', '1')
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      // a pre-Studio operator: legacy backdrop key + no appearance block → exercises migration
      localStorage.setItem('nexus.desktop.backdrop', JSON.stringify({ style: 'liquid', palette: 'accent', intensity: 55, motion: true }))
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      delete c.appearance
      delete c.appearanceLibrary
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: 'dark', accentPalette: 'cyan' }))
    } catch { /* ignore */ }
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => report.errors.push(`${W}: ${String(e.message).slice(0, 240)}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED/.test(m.text())) report.errors.push(`${W} console: ${m.text().slice(0, 200)}`) })
  await page.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { report.blocked.push(`${req.method()} ${u.pathname}`); return r.abort() }
    return r.continue()
  })
  return { ctx, page }
}

const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 900_000)

/* ═══ 1440 × 900: the whole Studio, in place ═══════════════════════════════ */
if (!ONLY || ONLY === '1440') {
  const W = 1440, H = 900
  const { ctx, page } = await newPage(W, H)
  const settled = async () => {
    // no appearance transition in flight, and two quiet frames for React to commit
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-lc-vt'), null, { timeout: 20000 }).catch(() => note('warn', 'transition still running'))
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  }
  const shot = async (name, clip) => { await settled(); const p = path.join(OUT, `${W}-${name}.png`); await page.screenshot({ path: p, ...(clip ? { clip } : {}) }); console.log('shot', p) }
  const panelClip = async () => { const b = await page.locator('.dsk-pop--profile').boundingBox(); return b ? { x: Math.max(0, b.x - 24), y: 0, width: Math.min(W - Math.max(0, b.x - 24), b.width + 48), height: H } : undefined }
  const studio = () => page.locator('.es')
  const open = async () => {
    if (await studio().count()) return
    await page.locator('.cd-op, .dsk-top__profile, [aria-label="Operator, appearance and system"]').first().click({ timeout: 20000 })
    await page.waitForSelector('.es', { timeout: 20000 })
    await page.waitForTimeout(700)
  }
  const close = async () => { if (await studio().count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(500) } }
  const scrollTo = async (sel) => { await page.locator(sel).first().scrollIntoViewIfNeeded(); await page.waitForTimeout(250) }
  const pickTheme = async (id) => {
    await page.locator(`.es-themes [data-seg="${id}"]`).click()
    await page.waitForFunction((t) => document.documentElement.getAttribute('data-nexus-theme') === t && document.querySelector(`.es-themes [data-seg="${t}"]`)?.getAttribute('aria-checked') === 'true', id, { timeout: 30000 })
    await settled()
    await page.waitForTimeout(400)
  }

  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.dsk-bd', { timeout: 90000 })
  await page.waitForTimeout(3500)
  note('first-paint', await page.evaluate(() => window.__esProbe))
  note('migrated', await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); return { version: s.appearance?.version, env: s.appearance?.environment?.type, auto: s.appearance?.environment?.autoHarmony, accent: s.accentPalette } }))
  await shot('desk-dark-default')

  await open()
  await shot('panel-dark')
  await page.locator('.es-disc__toggle', { hasText: 'Compose' }).click()
  await page.waitForTimeout(450)
  await scrollTo('.es-compose')
  await shot('panel-dark-compose', await panelClip())
  await page.locator('.es-disc__toggle', { hasText: 'Compose' }).click()
  await scrollTo('.es-glasses')
  await page.locator('.es-sec:has(.es-glasses) .es-disc__toggle').click()
  await page.waitForTimeout(450)
  await shot('panel-dark-material', await panelClip())
  await page.locator('.es-sec:has(.es-glasses) .es-disc__toggle').click()
  await scrollTo('.es-saved')
  await shot('panel-dark-saved', await panelClip())

  /* the colour editor: morph, drag (measured), paste, Esc */
  await scrollTo('.es-swatches')
  await page.locator('.es-swatch.is-custom').click()
  await page.waitForSelector('.es-ce', { timeout: 30000 })
  await page.waitForTimeout(800)
  await scrollTo('.es-ce')
  await shot('editor-open')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  await page.evaluate(() => {
    window.__esWrites = 0
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = function (k, v) { if (k === 'nexus-settings') window.__esWrites += 1; return orig.call(this, k, v) }
  })
  const rail = await page.locator('.es-ce__rail').boundingBox()
  const before = await metric()
  const t0 = Date.now()
  await page.mouse.move(rail.x + rail.width * 0.05, rail.y + rail.height / 2)
  await page.mouse.down()
  for (let i = 0; i <= 40; i++) await page.mouse.move(rail.x + rail.width * (0.05 + 0.4 * (i / 40)), rail.y + rail.height / 2)
  await page.mouse.up()
  const dragMs = Date.now() - t0
  await page.waitForTimeout(600)
  const after = await metric()
  const d = (k) => Number((after[k] - before[k]).toFixed(4))
  report.metrics.hueDrag = { moves: 41, wallMs: dragMs, recalcStyles: d('RecalcStyleCount'), recalcStyleSec: d('RecalcStyleDuration'), layoutSec: d('LayoutDuration'), scriptSec: d('ScriptDuration'), taskSec: d('TaskDuration'), settingsWrites: await page.evaluate(() => window.__esWrites) }
  note('hue-drag', report.metrics.hueDrag)
  const sv = await page.locator('.es-ce__sv').boundingBox()
  await page.mouse.move(sv.x + sv.width * 0.82, sv.y + sv.height * 0.12)
  await page.mouse.down()
  await page.mouse.move(sv.x + sv.width * 0.86, sv.y + sv.height * 0.1, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(700)
  await shot('editor-dragged')
  await page.locator('.es-ce__hex input').fill('rgb(254, 249, 195)')
  await page.waitForTimeout(600)
  await shot('editor-pasted-pale')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.es-ce'), null, { timeout: 30000 }).catch(() => undefined)
  await settled()
  note('esc-closes-editor-not-panel', { editor: await page.locator('.es-ce').count(), panel: await studio().count(), accent: await page.evaluate(() => document.documentElement.getAttribute('data-nexus-accent')) })
  await shot('editor-escaped')

  /* themes, through the lens */
  await scrollTo('.es-themes')
  for (const id of ['light', 'true_black', 'red_ops']) {
    await pickTheme(id)
    await shot(`panel-${id}`)
  }
  await pickTheme('light')
  await page.locator('.es-swatch.is-custom').click()
  await page.waitForSelector('.es-ce', { timeout: 30000 })
  await page.waitForTimeout(600)
  await page.locator('.es-ce__hex input').fill('#FEF9C3')
  await page.waitForTimeout(500)
  await scrollTo('.es-ce')
  await shot('light-pale-yellow-adjusted')
  await page.locator('.es-ce__btn', { hasText: 'Cancel' }).click()
  await page.waitForFunction(() => !document.querySelector('.es-ce'), null, { timeout: 30000 }).catch(() => undefined)
  note('cancel-restored-accent', await page.evaluate(() => document.documentElement.getAttribute('data-nexus-accent')))
  await pickTheme('dark')

  /* environments: each type, panel closed so the field is seen against the real product */
  for (const t of ['Aurora', 'Waves', 'Still', 'Custom', 'Liquid']) {
    await open()
    await scrollTo('.es-envtiles')
    await page.locator('.es-envtile', { hasText: t }).click()
    await page.waitForTimeout(t === 'Aurora' ? 1200 : 400)
    if (t === 'Aurora') await shot('panel-dark-aurora')
    await close()
    await page.waitForTimeout(800)
    await shot(`desk-dark-${t.toLowerCase()}`)
  }

  /* built-in environments (QA §159 looks) */
  for (const name of ['Deep Aurora', 'Light Crystal', 'Red Ops', 'Executive Gold', 'Midnight Cyan', 'Studio Black']) {
    await open()
    await scrollTo('.es-saved')
    await page.locator('.es-card__apply', { hasText: name }).click()
    await page.waitForTimeout(1300)
    const slug = name.toLowerCase().replace(/\s+/g, '-')
    await shot(`builtin-${slug}-panel`)
    await close()
    await page.waitForTimeout(700)
    await shot(`builtin-${slug}-desk`)
  }

  /* Light + cool / warm custom environment, Red Ops + custom environment */
  await open()
  await scrollTo('.es-themes')
  await pickTheme('light')
  await page.locator('.es-envtile', { hasText: 'Liquid' }).click()
  const autoOn = await page.locator('.es-switch[aria-checked="true"]', { hasText: 'Auto harmony' }).count()
  if (!autoOn) await page.locator('.es-switch', { hasText: 'Auto harmony' }).click()
  await page.locator('.es-harmony', { hasText: 'Cool Glass' }).click()
  await page.waitForTimeout(900)
  await close()
  await shot('desk-light-cool')
  await open()
  await page.locator('.es-envtile', { hasText: 'Still' }).click()
  await page.locator('.es-harmony', { hasText: 'Analogous' }).click()
  await page.locator('.es-swatch[aria-label="Orange"]').click()
  await page.waitForTimeout(900)
  await close()
  await shot('desk-light-warm')
  await open()
  await pickTheme('red_ops')
  await page.locator('.es-envtile', { hasText: 'Custom' }).click()
  await page.locator('.es-swatch[aria-label="Ice"]').click()
  await page.waitForTimeout(900)
  await close()
  await shot('desk-redops-custom')

  /* materials over True Black, multicolour aurora */
  await open()
  await pickTheme('true_black')
  await page.locator('.es-envtile', { hasText: 'Aurora' }).click()
  for (const m of ['Clear', 'Frosted', 'Smoke', 'Crystal']) {
    await scrollTo('.es-glasses')
    await page.locator('.es-glass', { hasText: m }).click()
    await page.waitForTimeout(900)
    await close()
    await shot(`desk-trueblack-aurora-${m.toLowerCase()}`)
    await open()
  }

  /* save → success → delete (UI preference only) */
  await scrollTo('.es-savebtn')
  await page.locator('.es-savebtn').click()
  await page.waitForTimeout(400)
  await page.locator('.es-saveform input').fill('Midnight Teal')
  await page.locator('.es-saveform button[type="submit"]').click()
  await page.waitForTimeout(700)
  await scrollTo('.es-saved')
  await shot('saved-success', await panelClip())
  const card = page.locator('.es-card', { hasText: 'Midnight Teal' })
  await card.hover()
  await card.locator('.es-card__more').click()
  await page.waitForTimeout(400)
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.waitForTimeout(300)
  await shot('saved-delete-confirm', await panelClip())
  await page.locator('.es-card__confirm .is-danger').click()
  await page.waitForTimeout(400)
  note('deleted', await page.locator('.es-card', { hasText: 'Midnight Teal' }).count() === 0)

  /* undo after a material change */
  await scrollTo('.es-glasses')
  await page.locator('.es-glass', { hasText: 'Smoke' }).click()
  await page.waitForTimeout(700)
  await scrollTo('.es-hero')
  const undo = page.locator('.es-iconbtn[aria-label="Undo last appearance change"]')
  note('undo-visible', await undo.count())
  if (await undo.count()) { await undo.click(); await page.waitForTimeout(700) }
  note('material-after-undo', await page.evaluate(() => document.documentElement.getAttribute('data-lc-material')))

  /* idle environment cost (motion on, panel closed) */
  await close()
  const idleBefore = await metric()
  await page.waitForTimeout(5000)
  const idleAfter = await metric()
  report.metrics.idle5s = { taskSec: Number((idleAfter.TaskDuration - idleBefore.TaskDuration).toFixed(4)), recalcStyles: idleAfter.RecalcStyleCount - idleBefore.RecalcStyleCount, layouts: idleAfter.LayoutCount - idleBefore.LayoutCount }
  note('idle-5s', report.metrics.idle5s)

  /* cross-tab: a second same-origin page (no app load) changes the theme */
  const other = await ctx.newPage()
  await other.goto(`${BASE}/favicon.svg`, { waitUntil: 'domcontentloaded' })
  await other.evaluate(() => { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); c.nexusTheme = 'light'; localStorage.setItem('nexus-settings', JSON.stringify(c)) })
  await page.waitForTimeout(900)
  note('cross-tab-theme', await page.evaluate(() => document.documentElement.getAttribute('data-nexus-theme')))
  /* corrupt settings from "another tab": the app repairs, field by field */
  await other.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
    localStorage.setItem('__es_backup', JSON.stringify(c))
    localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: 'banana', accentPalette: 'zzz', appearance: { version: 1, accent: { custom: 'nothex', intensity: 'x' }, environment: { type: 'lava', palette: ['#ggg', 7] }, motion: 'warp' }, liquidGlass: { preset: 'diamond', blur: 'x' } }))
  })
  await page.waitForTimeout(900)
  note('corrupt-fallback', await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-nexus-theme'), accent: document.documentElement.getAttribute('data-nexus-accent'), env: document.documentElement.getAttribute('data-lc-env'), material: document.documentElement.getAttribute('data-lc-material'), sheet: Boolean(document.getElementById('lc-appearance')?.textContent) })))
  await shot('corrupt-fallback')
  await other.evaluate(() => { localStorage.setItem('nexus-settings', localStorage.getItem('__es_backup')); localStorage.removeItem('__es_backup') })
  await other.close()
  await page.waitForTimeout(600)

  /* Settings › Appearance (in-app navigation, no reload) */
  await page.locator('[aria-label="Settings"], a[href="/settings"]').first().click().catch(() => {})
  await page.waitForSelector('.st', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1200)
  if (await page.locator('.es.is-page').count()) await shot('settings-appearance')
  else note('settings', 'page variant not reached by click')

  report.metrics.persisted = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); return { theme: s.nexusTheme, accent: s.accentPalette, env: s.appearance?.environment?.type, glass: s.liquidGlass?.preset, saved: s.appearanceLibrary?.saved?.length } })
  await ctx.close()
}

/* ═══ check: the last-mile verification — one load, a few clicks ═══════════ */
if (ONLY === 'check') {
  const W = 1440, H = 900
  const { ctx, page } = await newPage(W, H)
  const shot = async (name) => {
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-lc-vt'), null, { timeout: 20000 }).catch(() => undefined)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const p = path.join(OUT, `check-${name}.png`); await page.screenshot({ path: p }); console.log('shot', p)
  }
  const open = async () => {
    if (await page.locator('.es').count()) return
    await page.locator('.cd-op, .dsk-top__profile, [aria-label="Operator, appearance and system"]').first().click({ timeout: 20000 })
    await page.waitForSelector('.es', { timeout: 20000 })
    await page.waitForTimeout(600)
  }
  const close = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(600) }
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.dsk-bd', { timeout: 90000 })
  await page.waitForTimeout(3000)
  for (const t of ['Aurora', 'Waves']) {
    await open()
    await page.locator('.es-envtile', { hasText: t }).click()
    await page.waitForTimeout(1200)
    await close()
    await shot(`desk-${t.toLowerCase()}`)
  }
  // two theme clicks in quick succession must land in click order
  await open()
  await page.locator('.es-themes [data-seg="light"]').click()
  await page.locator('.es-themes [data-seg="true_black"]').click()
  await page.waitForTimeout(2500)
  note('rapid-theme-order', await page.evaluate(() => document.documentElement.getAttribute('data-nexus-theme')))
  await shot('panel-after-rapid-themes')
  await page.locator('.es-themes [data-seg="dark"]').click()
  await page.waitForTimeout(1500)
  // undo after a material change
  await page.locator('.es-glass', { hasText: 'Smoke' }).scrollIntoViewIfNeeded()
  await page.locator('.es-glass', { hasText: 'Smoke' }).click()
  await page.waitForFunction(() => document.documentElement.getAttribute('data-lc-material') === 'smoke', null, { timeout: 20000 }).catch(() => undefined)
  await page.locator('.es-hero').scrollIntoViewIfNeeded()
  await page.locator('.es-iconbtn[aria-label="Undo last appearance change"]').click()
  await page.waitForFunction(() => document.documentElement.getAttribute('data-lc-material') !== 'smoke', null, { timeout: 20000 }).catch(() => undefined)
  note('undo-material', await page.evaluate(() => document.documentElement.getAttribute('data-lc-material')))
  await ctx.close()
}

/* ═══ 5120 × 1440: the field across an ultrawide desk ══════════════════════ */
if (ULTRA && (!ONLY || ONLY === 'ultra') && ONLY !== 'check') {
  const W = 5120, H = 1440
  const { ctx, page } = await newPage(W, H)
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.dsk-bd', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: path.join(OUT, `${W}-desk.png`) })
  await page.locator('.cd-op, .dsk-top__profile, [aria-label="Operator, appearance and system"]').first().click({ timeout: 20000 })
  await page.waitForSelector('.es', { timeout: 20000 })
  await page.waitForTimeout(800)
  await page.locator('.es-envtile', { hasText: 'Aurora' }).click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(OUT, `${W}-panel-aurora.png`) })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(OUT, `${W}-desk-aurora.png`) })
  await ctx.close()
}

clearTimeout(watchdog)
await browser.close()
await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ errors: report.errors.slice(0, 12), blocked: report.blocked.slice(0, 12), metrics: report.metrics }, null, 1))
