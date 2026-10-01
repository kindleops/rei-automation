import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * HOME · COMMAND CENTER capture (READ ONLY): non-GET /api and every non-GET to
 * Supabase are aborted and reported. Waits for the Home's own sources to
 * settle, then captures the composition top to bottom (the Home scrolls inside
 * its pane) and measures overflow, garbage text and stuck loading.
 *
 *   node scripts/proof/desktop/home-command-capture.mjs --sizes=1440x900 --themes=dark --out=/tmp/home
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/home-command'))
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const THEMES = arg('themes', 'dark').split(',')
const MODE = arg('mode', '')
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
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
      // Supabase RPC reads are POSTs by protocol; only allow the read-only ones Home uses.
      if (/supabase\.co$/.test(u.hostname) && m === 'POST' && /\/rest\/v1\/rpc\/(get_map_area_summary|get_command_map_seller_pins)$/.test(u.pathname)) return r.continue()
      blocked.push(`${m} ${u.hostname}${u.pathname}`)
      return r.abort()
    })
    const tag = `${theme}-${W}x${H}${MODE ? `-${MODE}` : ''}`
    const net = []
    if (process.argv.includes('--net')) {
      const started = new Map()
      page.on('request', (q) => started.set(q, Date.now()))
      page.on('requestfinished', async (q) => { const r = await q.response(); net.push({ m: q.method(), u: q.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 110), s: r?.status(), ms: Date.now() - (started.get(q) ?? Date.now()) }) })
      page.on('requestfailed', (q) => net.push({ m: q.method(), u: q.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 110), s: 'FAILED', err: q.failure()?.errorText, ms: Date.now() - (started.get(q) ?? Date.now()) }))
    }
    const watchdog = setTimeout(() => { console.log(tag, 'WATCHDOG: capture exceeded 300 s'); process.exit(2) }, 300_000)
    await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('.ch-grid', { timeout: 90000 })
    // The Home's own sources: performance, pipeline, activity — wait until none is a skeleton.
    await page.waitForFunction(() => !document.querySelector('.ch .ch-skel'), null, { timeout: 90000 }).catch(() => console.log(tag, 'note: a source was still loading at capture time'))
    // The shared Home sources (campaigns, closings) settle more slowly than the command sources.
    await page.waitForFunction(() => document.querySelectorAll('.ch-sys').length >= 5, null, { timeout: 45000 }).catch(() => console.log(tag, 'note: fewer than 5 system pulses at capture time'))
    await page.waitForTimeout(2500)
    const m = await page.evaluate(() => {
      const root = document.querySelector('.ch')
      const leaves = [...(root?.querySelectorAll('*') ?? [])].filter((el) => el.children.length === 0 && (el.textContent || '').trim())
      const garbage = leaves.map((el) => (el.textContent || '').trim()).filter((t) => /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|^null$/.test(t)).slice(0, 6)
      const unavailable = [...(root?.querySelectorAll('.ch-unavail, .ch-map__state.is-bad') ?? [])].map((el) => el.textContent.trim().slice(0, 120))
      return {
        mode: root?.getAttribute('data-mode'),
        overflowX: root ? root.scrollWidth - root.clientWidth : null,
        scrollH: root?.scrollHeight ?? 0,
        clientH: root?.clientHeight ?? 0,
        garbage,
        unavailable,
        telemetry: [...document.querySelectorAll('.ch-tel')].map((el) => el.textContent.trim().replace(/\s+/g, ' ')),
        systems: [...document.querySelectorAll('.ch-sys')].map((el) => el.textContent.trim().replace(/\s+/g, ' ')),
        feed: document.querySelectorAll('.ch-moment').length,
        litDots: null,
      }
    })
    const shots = Math.min(4, Math.ceil(m.scrollH / Math.max(1, m.clientH)))
    for (let i = 0; i < shots; i += 1) {
      await page.evaluate((y) => { const r = document.querySelector('.ch'); if (r) r.scrollTop = y }, i * m.clientH)
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${OUT}/${tag}-${i + 1}.png` })
    }
    clearTimeout(watchdog)
    console.log(JSON.stringify({ tag, ...m, shots, blocked, errors: errors.slice(0, 5) }))
    if (net.length) for (const n of net.filter((x) => /\/api\/|\/rest\/v1/.test(x.u))) console.log('NET', n.m, n.s, `${n.ms}ms`, n.u, n.err || '')
    await ctx.close()
  }
}
await browser.close()
