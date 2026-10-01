import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * DEAL INTELLIGENCE · DECISION ROOM capture (READ ONLY). Every non-GET to
 * /api or Supabase is aborted and reported — the engine re-run is never
 * clicked. Scenes drive modes and selections only (client state).
 *
 *   node scripts/proof/desktop/deal-intelligence-capture.mjs \
 *     --subject=273312064 --themes=dark --sizes=1440x900 --scenes=decision --out=/tmp/di
 *
 * Scenes: decision · decision-scroll · marker · fact · evidence-comps · comp ·
 *         evidence-debt · record-ownership · record-tax · model · snapshot ·
 *         scenario · scenario-custom · pane (DI in a ~520px box)
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/deal-intelligence'))
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const THEMES = arg('themes', 'dark').split(',')
const SUBJECT = arg('subject', '273312064')
const PARAM = arg('param', 'property_id')
const SCENES = arg('scenes', 'decision').split(',')
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const report = []
for (const theme of THEMES) {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } })
    await ctx.addInitScript((t) => {
      try {
        localStorage.removeItem('nexus.desktop.split')
        localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
        localStorage.removeItem('lc.inspector.deal-intelligence.w')
        const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      } catch { /* ignore */ }
    }, theme)
    const page = await ctx.newPage()
    const blocked = []
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 220)))
    page.on('console', (m) => { if (m.type() === 'error' && !/ResizeObserver|favicon|ERR_ABORTED|Failed to load resource|net::ERR/i.test(m.text())) errors.push(m.text().slice(0, 220)) })
    await page.route('**/*', (r) => {
      const req = r.request()
      const u = new URL(req.url())
      const m = req.method()
      const guarded = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
      if (!guarded || ['GET', 'HEAD', 'OPTIONS'].includes(m)) return r.continue()
      blocked.push(`${m} ${u.hostname}${u.pathname}`)
      return r.abort()
    })
    const watchdog = setTimeout(() => { console.log('WATCHDOG: capture exceeded 420 s'); process.exit(2) }, 420_000)
    const tag = `${theme}-${W}x${H}-${SUBJECT}`
    await page.goto(`${BASE}/deal-intelligence?${PARAM}=${encodeURIComponent(SUBJECT)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('.dr', { timeout: 120000 })
    await page.waitForFunction(() => document.querySelector('.dr-hero, .dr-boot .lc-error, .dr-boot .lc-empty, .dr-nosubject'), null, { timeout: 150000 }).catch(() => console.log(tag, 'note: decision not on screen in time'))
    // The deal story (prospect timeline) and imagery settle after the decision.
    await page.waitForFunction(() => !document.querySelector('.dr-story [aria-busy="true"]'), null, { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(1800)

    const measure = async (scene) => page.evaluate((sc) => {
      const main = document.querySelector('.dr-main')
      const root = document.querySelector('.dr')
      const leaves = [...(root?.querySelectorAll('*') ?? [])].filter((el) => el.children.length === 0 && (el.textContent || '').trim())
      const garbage = leaves.map((el) => (el.textContent || '').trim()).filter((t) => /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|^null$/.test(t)).slice(0, 8)
      const overflowing = [...(root?.querySelectorAll('.dr-plane') ?? [])].filter((el) => el.scrollWidth - el.clientWidth > 2).map((el) => el.getAttribute('data-plane')).slice(0, 8)
      return {
        scene: sc,
        mainOverflowX: main ? main.scrollWidth - main.clientWidth : null,
        rootWidth: root?.getBoundingClientRect().width ?? null,
        docked: root?.classList.contains('is-docked') ?? null,
        scrollH: main?.scrollHeight ?? 0,
        clientH: main?.clientHeight ?? 0,
        garbage,
        overflowing,
        verdict: document.querySelector('.dr-verdict__tier')?.textContent ?? null,
        engine: document.querySelector('.dr-engine__value')?.textContent ?? null,
        status: document.querySelector('.dr-strip__state .lc-status')?.textContent ?? null,
      }
    }, scene)
    const shot = (name, opts = {}) => page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`), ...opts })
    const scrollMain = (y) => page.evaluate((yy) => { const m = document.querySelector('.dr-main'); if (m) m.scrollTo({ top: yy, behavior: 'instant' }) }, y)
    const mode = async (label) => { await page.locator('.dr-modes [role="tab"]', { hasText: label }).first().click(); await page.waitForTimeout(700) }
    const rail = async (label) => { await page.locator('.dr-rail__item', { hasText: label }).first().click(); await page.waitForTimeout(600) }

    for (const scene of SCENES) {
      try {
        if (scene === 'raw') {
          await shot('raw'); report.push({ tag, ...(await measure(scene)), html: await page.evaluate(() => (document.querySelector('.dr')?.outerHTML ?? document.body.innerHTML).slice(0, 1500)) })
        } else if (scene === 'transition') {
          // Linked context: a selection elsewhere publishes the property locator; a following
          // pane moves in place — dim → new identity → new decision — and rewrites its URL.
          const next = arg('next', '273330908')
          await page.evaluate((pid) => window.dispatchEvent(new CustomEvent('nexus:property-locator', { detail: { propertyId: pid, threadKey: null, opportunityId: null, prospectId: null, masterOwnerId: null, address: null, setAt: Date.now() } })), next)
          await page.waitForTimeout(160)
          await shot('transition-1-dim')
          const pending = await page.evaluate(() => document.querySelector('.dr')?.classList.contains('is-pending') ?? false)
          await page.waitForFunction((pid) => document.querySelector('.dr') && !document.querySelector('.dr.is-pending') && new URLSearchParams(location.search).get('property_id') === pid, next, { timeout: 120000 }).catch(() => {})
          await page.waitForTimeout(1200)
          await shot('transition-2-arrived')
          report.push({ tag, ...(await measure(scene)), pendingSeen: pending, url: await page.evaluate(() => location.pathname + location.search) })
        } else if (scene === 'deeplink-mode') {
          await page.goto(`${BASE}/deal-intelligence?property=${encodeURIComponent(SUBJECT)}&mode=record`, { waitUntil: 'domcontentloaded', timeout: 120000 })
          await page.waitForSelector('.dr-record', { timeout: 150000 }).catch(() => console.log(tag, 'note: record mode not on screen'))
          await page.waitForTimeout(800)
          await shot('deeplink-record')
          report.push({ tag, ...(await measure(scene)), mode: await page.evaluate(() => document.querySelector('.dr')?.getAttribute('data-mode')) })
        } else if (scene === 'decision') {
          await mode('Decision'); await scrollMain(0)
          await shot('decision'); report.push({ tag, ...(await measure(scene)) })
        } else if (scene === 'decision-scroll') {
          await mode('Decision')
          const m = await measure(scene)
          const steps = Math.min(4, Math.ceil(m.scrollH / Math.max(1, m.clientH)))
          for (let i = 1; i < steps; i += 1) { await scrollMain(i * (m.clientH - 80)); await page.waitForTimeout(450); await shot(`decision-${i}`) }
          await scrollMain(0)
        } else if (scene === 'marker') {
          await mode('Decision'); await scrollMain(0)
          await page.locator('.dr-engine').first().click(); await page.waitForTimeout(700)
          await shot('marker-engine')
          await page.keyboard.press('Escape'); await page.waitForTimeout(400)
        } else if (scene === 'fact') {
          await mode('Decision')
          const f = page.locator('.dr-fact__val').first()
          if (await f.count()) { await f.scrollIntoViewIfNeeded(); await f.click(); await page.waitForTimeout(700); await shot('fact') }
        } else if (scene === 'gate') {
          await mode('Decision')
          const g = page.locator('.dr-gate.is-fail').first()
          if (await g.count()) { await g.scrollIntoViewIfNeeded(); await g.click(); await page.waitForTimeout(700); await shot('gate') }
        } else if (scene === 'evidence-comps') {
          await mode('Evidence'); await rail('Comparable'); await scrollMain(0)
          await shot('evidence-comps'); report.push({ tag, ...(await measure(scene)) })
          await scrollMain(520); await page.waitForTimeout(400); await shot('evidence-comps-grid'); await scrollMain(0)
        } else if (scene === 'comp') {
          await mode('Evidence'); await rail('Comparable')
          const row = page.locator('.lc-grid [role="row"][aria-rowindex], .lc-grid__row').nth(1)
          const dot = page.locator('.dr-dist__dot').first()
          if (await dot.count()) await dot.click(); else if (await row.count()) await row.click()
          await page.waitForTimeout(900); await shot('comp')
        } else if (scene === 'evidence-debt') {
          await mode('Evidence'); await rail('Debt'); await scrollMain(0)
          await shot('evidence-debt'); report.push({ tag, ...(await measure(scene)) })
        } else if (scene === 'record-ownership') {
          await mode('Record'); await rail('Ownership'); await scrollMain(0)
          await shot('record-ownership'); report.push({ tag, ...(await measure(scene)) })
        } else if (scene === 'record-tax') {
          await mode('Record'); await rail('Tax'); await scrollMain(0)
          await shot('record-tax')
        } else if (scene === 'model') {
          await mode('Model'); await scrollMain(0)
          await shot('model'); report.push({ tag, ...(await measure(scene)) })
          await scrollMain(700); await page.waitForTimeout(400); await shot('model-2'); await scrollMain(0)
        } else if (scene === 'snapshot') {
          await mode('Model')
          const row = page.locator('.dr-snaps tbody tr').last()
          if (await row.count()) { await row.scrollIntoViewIfNeeded(); await row.click(); await page.waitForTimeout(700); await shot('snapshot') }
        } else if (scene === 'scenario') {
          await mode('Scenario'); await scrollMain(0)
          await shot('scenario'); report.push({ tag, ...(await measure(scene)) })
          await scrollMain(800); await page.waitForTimeout(400); await shot('scenario-2'); await scrollMain(0)
        } else if (scene === 'scenario-custom') {
          await mode('Scenario'); await scrollMain(0)
          await page.locator('.dr-presets [role="radio"]', { hasText: 'Conservative' }).click(); await page.waitForTimeout(400)
          const price = page.locator('.dr-lever.is-price input[type="range"]')
          if (await price.count()) { await price.focus(); for (let i = 0; i < 24; i += 1) await page.keyboard.press('ArrowRight') }
          await page.waitForTimeout(500); await shot('scenario-custom')
        }
      } catch (e) {
        console.log(tag, scene, 'scene failed:', String(e?.message ?? e).slice(0, 1400))
      }
    }
    clearTimeout(watchdog)
    console.log(JSON.stringify({ tag, blocked: blocked.slice(0, 6), errors: errors.slice(0, 6) }))
    await ctx.close()
  }
}
await fs.writeFile(path.join(OUT, `report-${SUBJECT}.json`), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 1))
await browser.close()
