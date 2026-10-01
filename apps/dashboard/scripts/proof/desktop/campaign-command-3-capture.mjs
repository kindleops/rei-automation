import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * CAMPAIGN COMMAND 3.0 capture (READ ONLY). Every non-GET to /api or Supabase
 * is aborted and reported — nothing on this page may write, and nothing here
 * clicks Launch / Activate / Resume / Send / Retry. Captures each room mode
 * per theme and size, optionally an inspector context and a simulated pane
 * width, and measures horizontal overflow and garbage text in the app root.
 *
 *   node scripts/proof/desktop/campaign-command-3-capture.mjs --sizes=1440x900 --themes=dark \
 *     --modes=overview,execution,targets,activity,performance --campaign=<uuid> --out=/tmp/cc3 \
 *     [--inspect=senders|audience|gate|delivery|replies|geo] [--pane=560] [--root=.cc3] [--demo]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/campaign-command-3'))
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const THEMES = arg('themes', 'dark').split(',')
const MODES = arg('modes', 'overview').split(',')
const CAMPAIGNS = arg('campaign', '').split(',')
const PANE = Number(arg('pane', '0')) || 0
const ROOT = arg('root', '.cc3')
const INSPECT = arg('inspect', '')
const DEMO = process.argv.includes('--demo')
const SCROLL = Number(arg('scroll', '0')) || 0
const TAG = arg('tag', '')
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG: capture exceeded 600 s'); process.exit(2) }, 600_000)
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
    for (const CAMPAIGN of CAMPAIGNS) for (const mode of MODES) {
      const who = CAMPAIGNS.length > 1 && CAMPAIGN ? `-${CAMPAIGN.slice(0, 14)}` : ''
      const tag = `${theme}-${W}x${H}${PANE ? `-pane${PANE}` : ''}-${mode}${who}${INSPECT ? `-${INSPECT.replace(/[^a-z0-9]+/gi, '-')}` : ''}${TAG ? `-${TAG}` : ''}`
      const q = new URLSearchParams()
      if (CAMPAIGN) q.set('campaign', CAMPAIGN)
      if (mode !== 'overview') q.set('cc', mode)
      if (INSPECT) q.set('ccx', INSPECT)
      if (DEMO) q.set('demo', '1')
      await page.goto(`${BASE}/campaign-command${q.toString() ? `?${q}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await page.waitForSelector(ROOT, { timeout: 120000 })
      if (PANE) await page.addStyleTag({ content: `${ROOT}{max-width:${PANE}px !important;margin-left:0 !important}` })
      if (process.argv.includes('--nowait')) await page.waitForTimeout(Number(arg('settle', '25000')))
      else await page.waitForFunction((root) => {
        const r = document.querySelector(root)
        return r && r.getAttribute('data-ready') === '1'
      }, ROOT, { timeout: 150000 }).catch(() => console.log(tag, 'note: root not ready at capture time'))
      await page.waitForTimeout(2200)
      if (SCROLL) {
        await page.evaluate(([root, y]) => { const s = document.querySelector(`${root} [data-cc3-scroll]`); if (s) s.scrollTop = y }, [ROOT, SCROLL])
        await page.waitForTimeout(500)
      }
      const m = await page.evaluate((root) => {
        const r = document.querySelector(root)
        const leaves = [...(r?.querySelectorAll('*') ?? [])].filter((el) => el.children.length === 0 && (el.textContent || '').trim())
        const garbage = leaves.map((el) => (el.textContent || '').trim()).filter((t) => /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|^null$/.test(t)).slice(0, 6)
        const scroller = r?.querySelector('[data-cc3-scroll]') || r
        // what pokes past the room's right edge (the deepest offenders first)
        const edge = scroller ? scroller.getBoundingClientRect().right : 0
        const wide = scroller ? [...scroller.querySelectorAll('*')]
          .filter((el) => el.getBoundingClientRect().right > edge + 0.5 && el.getBoundingClientRect().width > 0)
          .filter((el, _, all) => !all.some((o) => o !== el && el.contains(o)))
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(' ').slice(0, 2).join('.')} +${Math.round(el.getBoundingClientRect().right - edge)}`) : []
        return {
          wide,
          overflowX: r ? r.scrollWidth - r.clientWidth : null,
          scrollerOverflowX: scroller ? scroller.scrollWidth - scroller.clientWidth : null,
          scrollH: scroller?.scrollHeight ?? 0,
          clientH: scroller?.clientHeight ?? 0,
          garbage,
        }
      }, ROOT)
      await page.screenshot({ path: path.join(OUT, `${tag}.png`) })
      if (process.argv.includes('--full')) {
        await page.evaluate((root) => {
          const s = document.querySelector(`${root} [data-cc3-scroll]`)
          if (s) { s.style.overflow = 'visible'; s.style.height = 'auto'; s.style.maxHeight = 'none' }
        }, ROOT)
        await page.screenshot({ path: path.join(OUT, `${tag}-full.png`), fullPage: true })
      }
      console.log(JSON.stringify({ tag, ...m }))
    }
    console.log(JSON.stringify({ theme, size: `${W}x${H}`, blockedWrites: blocked, errors: errors.slice(0, 6) }))
    await ctx.close()
  }
}
clearTimeout(watchdog)
await browser.close()
