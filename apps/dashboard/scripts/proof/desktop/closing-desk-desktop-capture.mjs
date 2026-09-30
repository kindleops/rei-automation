import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * CLOSING DESK · DESKTOP 3.0 — targeted scene captures (READ ONLY: every
 * non-GET /api request is aborted and reported).
 *
 *   node scripts/proof/desktop/closing-desk-desktop-capture.mjs --width=1440 --theme=dark --scenes=portfolio,ready
 *
 * Demo scenes (?demo=1) are the badged fixture world run through the real
 * derivation; `empty` is the live production read (zero live closings).
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const WIDTH = Number(arg('width', 1440))
const HEIGHT = Number(arg('height', 900))
const THEME = arg('theme', 'dark')
const OUT = path.resolve(arg('out', 'artifacts/closing-desk-desktop'))
const id = (n) => encodeURIComponent(`closing:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)
const SCENES = {
  portfolio: { q: '?demo=1' },
  ready: { q: `?demo=1&case=${id(4)}` },
  blocked: { q: `?demo=1&case=${id(5)}`, inspect: '.cdx-block li button' },
  waiting_title: { q: `?demo=1&case=${id(13)}&section=title` },
  waiting_buyer: { q: `?demo=1&case=${id(2)}&section=buyer` },
  system_handling: { q: `?demo=1&case=${id(3)}` },
  documents: { q: `?demo=1&case=${id(5)}&section=documents`, inspect: '.cdx-docs .cdx-doc.is-bad' },
  automation: { q: `?demo=1&case=${id(3)}&section=automation`, inspect: '.cdx-loops li.is-scheduled button' },
  timeline: { q: `?demo=1&case=${id(4)}&section=timeline` },
  deadlines: { q: `?demo=1&case=${id(4)}&section=deadlines` },
  settlement: { q: `?demo=1&case=${id(6)}` },
  no_settlement: { q: `?demo=1&case=${id(11)}` },
  cancelled: { q: `?demo=1&case=${id(9)}` },
  title_issue: { q: `?demo=1&case=${id(10)}`, inspect: '.cdx-block li.is-blocking button' },
  collapsed: { q: `?demo=1&case=${id(5)}`, inspect: '.cdx-block li button', collapse: true },
  empty: { q: '', live: true },
}
const WANT = arg('scenes', Object.keys(SCENES).join(',')).split(',')
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
await ctx.addInitScript((t) => { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
const blocked = []; const errors = []
page.on('pageerror', (e) => errors.push(`${page.url()} :: ${String(e.message).slice(0, 200)}`))
await page.route('**/api/**', (r) => { const m = r.request().method(); if (['GET', 'OPTIONS'].includes(m)) return r.continue(); blocked.push(`${m} ${new URL(r.request().url()).pathname}`); return r.abort() })
const report = {}
for (const name of WANT) {
  const s = SCENES[name]
  if (!s) { console.log('unknown scene', name); continue }
  try {
    await page.goto(`${BASE}/closing-desk${s.q}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('[data-testid="closing-desk-desktop"]', { timeout: 90000 })
    await page.waitForFunction(() => !document.querySelector('.cdx-skel'), null, { timeout: s.live ? 120000 : 30000 }).catch(() => {})
    await page.waitForTimeout(900)
    if (s.inspect) { await page.locator(s.inspect).first().click({ timeout: 8000 }).catch((e) => console.log('inspect miss', name, String(e.message).slice(0, 80))); await page.waitForTimeout(500) }
    if (s.collapse) { await page.keyboard.press(']'); await page.waitForTimeout(400) }
    report[name] = await page.evaluate(() => {
      const root = document.querySelector('.cdx')
      const main = document.querySelector('.cdx-main')
      const text = document.body.innerText
      return {
        overflowX: document.documentElement.scrollWidth - innerWidth,
        mainOverflowX: main ? main.scrollWidth - main.clientWidth : null,
        tier: root?.className.match(/is-tier-(\w+)/)?.[1] ?? null,
        badText: /\b(NaN|undefined|\[object Object\])\b/.test(text),
        tinyText: [...document.querySelectorAll('.cdx *')].filter((el) => el.childElementCount === 0 && el.textContent?.trim() && parseFloat(getComputedStyle(el).fontSize) < 9.5).length,
        header: document.querySelector('.cdx-head')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 140) ?? null,
        inspector: (() => { const r = document.querySelector('.cdx-insp')?.getBoundingClientRect(); return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null })(),
      }
    })
    // The dev-only runtime banner (dashboard ↔ API build mismatch) is not product UI.
    await page.addStyleTag({ content: '.nx-dev-runtime-banner{display:none!important}' })
    // Headless compositing can leave a just-started animation pending; finish them for a stable frame.
    await page.screenshot({ path: `${OUT}/${THEME}-${WIDTH}-${name}.png`, animations: 'disabled' })
    console.log('shot', name, JSON.stringify(report[name]))
  } catch (e) { console.log('FAIL', name, String(e.message).slice(0, 160)) }
}
report.errors = errors; report.blocked = blocked
await fs.writeFile(`${OUT}/${THEME}-${WIDTH}-results.json`, JSON.stringify(report, null, 2))
console.log('errors', errors.length, 'blocked writes', blocked.length)
await browser.close()
