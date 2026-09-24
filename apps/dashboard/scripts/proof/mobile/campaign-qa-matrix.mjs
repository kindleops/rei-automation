import { chromium } from 'playwright'
import fs from 'node:fs/promises'
// Read-only QA matrix: widths × themes. Every non-GET API call is aborted.
// Types nothing into the builder. Reports horizontal overflow per screen.
const WIDTHS = (process.argv[2] || '375,390,393,430').split(',').map(Number)
const THEMES = (process.argv[3] || 'dark,light,true_black,red_ops').split(',')
const NAME = 'Miami - Test Campaign'
const setTheme = (t) => { try { const r = localStorage.getItem('nexus-settings'); const p = r ? JSON.parse(r) : {}; localStorage.setItem('nexus-settings', JSON.stringify({ ...p, nexusTheme: t })) } catch {} }
const b = await chromium.launch()
const overflowOf = (p, sel, w) => p.evaluate(({ sel, w }) => {
  const out = []
  for (const root of document.querySelectorAll(sel)) {
    for (const n of root.querySelectorAll('*')) {
      const r = n.getBoundingClientRect()
      if (!r.width || !r.height) continue
      const cs = getComputedStyle(n)
      if (cs.position === 'fixed') continue
      // Children of a horizontal scroller may extend past the edge by design.
      let scroller = n.parentElement, inScroller = false
      while (scroller && scroller !== root.parentElement) { const s = getComputedStyle(scroller); if (/(auto|scroll)/.test(s.overflowX)) { inScroller = true; break } scroller = scroller.parentElement }
      if (inScroller) continue
      if (r.right > w + 1 || r.left < -1) out.push(`${n.tagName.toLowerCase()}.${String(n.className).split(' ')[0]} [${Math.round(r.left)}–${Math.round(r.right)}]`)
    }
  }
  return [...new Set(out)].slice(0, 5)
}, { sel, w })

let problems = 0
for (const W of WIDTHS) for (const T of THEMES) {
  const OUT = `.screenshots/campaign-audit/qa-${W}-${T}`
  await fs.mkdir(OUT, { recursive: true })
  const ctx = await b.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await ctx.addInitScript(setTheme, T)
  const p = await ctx.newPage()
  await p.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)))
  const report = []
  const shot = async (name, sel) => {
    await p.screenshot({ path: `${OUT}/${name}.png` })
    const o = await overflowOf(p, sel, W)
    if (o.length) { report.push(`${name}: ${o.join(', ')}`); problems += 1 }
  }
  await p.goto('http://localhost:5173/campaign-command', { waitUntil: 'domcontentloaded', timeout: 180000 })
  await p.waitForSelector('.cmc__hit', { timeout: 120000 }); await p.waitForTimeout(1800)
  await shot('01-index', '.cmk')
  await p.locator('.cmc__hit').filter({ hasText: new RegExp(NAME) }).first().click()
  await p.waitForSelector('.cdm2', { timeout: 60000 }); await p.waitForTimeout(4500)
  await shot('02-detail', '.cdm2')
  for (const [label, slug] of [['Queue', '03-queue'], ['Replies', '04-replies'], ['Exceptions', '05-exceptions'], ['Audience', '06-audience'], ['Activity', '07-activity']]) {
    await p.locator('.cst__tab').filter({ hasText: label }).first().click(); await p.waitForTimeout(3500)
    await p.evaluate(() => { const el = document.querySelector('.cdm2__scroll'); const sec = document.querySelector('.cdm2__section'); const tabs = document.querySelector('.cst'); if (el && sec) el.scrollTop = sec.offsetTop - (tabs?.offsetHeight ?? 50) - 8 })
    await p.waitForTimeout(400)
    await shot(slug, '.cdm2')
  }
  await p.locator('.cad__more').click(); await p.waitForTimeout(700)
  await shot('08-more-sheet', '.cad-sheet')
  await p.locator('.cad-sheet__cancel').click(); await p.waitForTimeout(400)
  await p.locator('.cdb2 button').first().click(); await p.waitForTimeout(900)
  await p.locator('.cmk__ico[aria-label="New campaign"]').click()
  await p.waitForSelector('.cmp-studio--mobile', { timeout: 60000 }); await p.waitForTimeout(2200)
  await shot('09-builder', '.cmp-studio--mobile')
  console.log(`${String(W).padEnd(4)} ${T.padEnd(11)} ${report.length ? 'OVERFLOW → ' + report.join(' | ') : 'ok'}${errs.length ? '  ERRORS ' + errs.join(' ; ') : ''}`)
  await ctx.close()
}
console.log(problems ? `\n${problems} screen(s) with overflow` : '\nno overflow on any screen')
await b.close()
