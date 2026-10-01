import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * PIPELINE DESKTOP 2 capture (READ ONLY). Every non-GET to /api or Supabase is
 * aborted and reported — nothing on this page may write. Captures each mode
 * (Overview · Flow · Table · Offers) per theme and size, optionally the deal
 * inspector and the ownership re-projection, and measures overflow, garbage
 * text and the pane root.
 *
 *   node scripts/proof/desktop/pipeline-desktop-2-capture.mjs --sizes=1440x900 --themes=dark \
 *     --modes=overview,flow,table,offers --out=/tmp/pipeline [--inspect] [--owner] [--pane=560]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/pipeline-desktop-2'))
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const THEMES = arg('themes', 'dark').split(',')
const MODES = arg('modes', 'overview').split(',')
const PANE = Number(arg('pane', '0')) || 0
const ROOT = arg('root', '.pd2')
const INSPECT = process.argv.includes('--inspect')
const OWNER = process.argv.includes('--owner')
const FULL = process.argv.includes('--full')
const PULSE = process.argv.includes('--pulse')
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG: capture exceeded 1500 s'); process.exit(2) }, 1_500_000)
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
    const blocked = []; const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
    page.on('console', (m) => { if (m.type() === 'error' && !/ResizeObserver|favicon|ERR_ABORTED|Failed to load resource/i.test(m.text())) errors.push(m.text().slice(0, 200)) })
    await page.route('**/*', (r) => {
      const req = r.request(); const u = new URL(req.url()); const m = req.method()
      const guarded = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
      if (!guarded || ['GET', 'HEAD', 'OPTIONS'].includes(m)) return r.continue()
      blocked.push(`${m} ${u.hostname}${u.pathname}`)
      return r.abort()
    })
    for (const mode of MODES) {
      const tag = `${theme}-${W}x${H}${PANE ? `-pane${PANE}` : ''}-${mode}`
      const q = mode === 'overview' ? '' : `?pv=${mode}`
      await page.goto(`${BASE}/pipeline${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await page.waitForSelector(ROOT, { timeout: 120000 })
      if (PANE) {
        // Simulate a Shell 6.0 pane: constrain the app root's container width.
        await page.addStyleTag({ content: `${ROOT}{max-width:${PANE}px !important;margin-left:0 !important}` })
      }
      // wait until the read model landed (the root marks itself ready)
      if (process.argv.includes('--nowait')) await page.waitForTimeout(30000)
      else await page.waitForFunction((root) => {
        const r = document.querySelector(root)
        return r && r.getAttribute('data-ready') === '1'
      }, ROOT, { timeout: 330000 }).catch(() => console.log(tag, 'note: root not ready at capture time'))
      await page.waitForTimeout(1600)
      if (OWNER && mode === 'flow') {
        await page.locator('[data-pd2-lens="owner"]').first().click().catch(() => console.log(tag, 'note: no owner lens'))
        await page.waitForTimeout(900)
      }
      const m = await page.evaluate((root) => {
        const r = document.querySelector(root)
        const leaves = [...(r?.querySelectorAll('*') ?? [])].filter((el) => el.children.length === 0 && (el.textContent || '').trim())
        const garbage = leaves.map((el) => (el.textContent || '').trim()).filter((t) => /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|^null$/.test(t)).slice(0, 6)
        const scroller = r?.querySelector('[data-pd2-scroll]') || r
        return {
          overflowX: r ? r.scrollWidth - r.clientWidth : null,
          scrollerOverflowX: scroller ? scroller.scrollWidth - scroller.clientWidth : null,
          scrollH: scroller?.scrollHeight ?? 0,
          clientH: scroller?.clientHeight ?? 0,
          rootW: r?.getBoundingClientRect().width ?? 0,
          garbage,
          telemetry: [...document.querySelectorAll('[data-pd2-tel]')].map((el) => el.textContent.trim().replace(/\s+/g, ' ')).slice(0, 12),
        }
      }, ROOT)
      await page.screenshot({ path: `${OUT}/${tag}.png` })
      if (FULL && m.scrollH > m.clientH + 40) {
        const shots = Math.min(4, Math.ceil(m.scrollH / Math.max(1, m.clientH)))
        for (let i = 1; i < shots; i += 1) {
          await page.evaluate(([root, y]) => { const r = document.querySelector(root); const s = r?.querySelector('[data-pd2-scroll]') || r; if (s) s.scrollTop = y }, [ROOT, i * m.clientH])
          await page.waitForTimeout(450)
          await page.screenshot({ path: `${OUT}/${tag}-${i + 1}.png` })
        }
        await page.evaluate((root) => { const r = document.querySelector(root); const s = r?.querySelector('[data-pd2-scroll]') || r; if (s) s.scrollTop = 0 }, ROOT)
      }
      if (PULSE && mode === 'overview') {
        // SAMPLE movement through the DEV-only seam (never in production builds) — verifies the one-shot pulse.
        const at = new Date().toISOString()
        await page.evaluate((iso) => window.dispatchEvent(new CustomEvent('pd2:qa-arrivals', { detail: [
          { id: `qa1:${iso}`, opportunityId: 'qa', at: iso, kind: 'advance', title: 'S2 → S4', detail: 'Asking price provided', address: null, seller: null, stage: 'property_condition', stageIndex: 4, fromStage: 'offer_interest', toStage: 'property_condition' },
          { id: `qa2:${iso}`, opportunityId: 'qa', at: iso, kind: 'created', title: 'Opened at S2', detail: null, address: null, seller: null, stage: 'offer_interest', stageIndex: 2, toStage: 'offer_interest' },
          { id: `qa3:${iso}`, opportunityId: 'qa', at: iso, kind: 'advance', title: 'S3 → S5', detail: 'Made offer', address: null, seller: null, stage: 'offer', stageIndex: 5, fromStage: 'asking_price', toStage: 'offer' },
        ] })), at)
        await page.waitForTimeout(650)
        await page.screenshot({ path: `${OUT}/${tag}-pulse-1.png`, clip: { x: 250, y: 220, width: W - 250, height: 420 } })
        await page.waitForTimeout(1100)
        await page.screenshot({ path: `${OUT}/${tag}-pulse-2.png`, clip: { x: 250, y: 220, width: W - 250, height: 420 } })
      }
      if (INSPECT) {
        const target = page.locator('[data-pd2-deal]').first()
        if (await target.count()) {
          await target.click()
          await page.waitForTimeout(1500)
          await page.screenshot({ path: `${OUT}/${tag}-inspector.png` })
          await page.keyboard.press('Escape')
          await page.waitForTimeout(500)
        } else console.log(tag, 'note: no deal to inspect')
      }
      console.log(JSON.stringify({ tag, ...m, blocked, errors: errors.slice(0, 5) }))
    }
    await ctx.close()
  }
}
clearTimeout(watchdog)
await browser.close()
