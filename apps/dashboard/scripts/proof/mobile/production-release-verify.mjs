/**
 * PRODUCTION RELEASE VERIFICATION — against the LIVE Cloudflare origin.
 *
 * READ ONLY. It loads routes and reads the DOM. It never submits a form,
 * never clicks a send/dispatch control, and never mutates anything.
 *
 * Covers §14 mobile shell, §15 live route smoke, §17-25 subsystem truth,
 * §28 fabricated-data sweep, §29 console/network, §30 performance.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, f) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${f}`).replace(`--${n}=`, '')
const BASE = arg('base', 'https://ops.leadcommand.ai')
const WIDTHS = arg('width', '390,430').split(',').map(Number)

const ROUTES = [
  ['/inbox', /inbox|thread|message/i], ['/conversation', /conversation|thread|message/i],
  ['/email-command', /mail|email|compose/i], ['/deal-intelligence', /deal|intelligence|property/i],
  ['/entity-graph', /entity|graph|owner/i], ['/comp-intelligence', /comp|valuation|subject/i],
  ['/buyer-match', /buyer|match/i], ['/map', /map|activity|scope/i],
  ['/pipeline', /pipeline|stage|deal/i], ['/queue', /queue|send|pending/i],
  ['/campaign-command', /campaign|target|template/i], ['/workflow-studio', /workflow|node|trigger/i],
  ['/closing-desk', /closing|case|title/i], ['/calendar', /calendar|schedule|event/i],
  ['/analytics', /analytics|metric|war/i], ['/properties', /propert|address/i],
]

/* Tells that a surface is rendering invented data rather than reading one. */
const FAKE = ['Lorem', 'John Doe', 'Jane Doe', 'Test Seller', 'Demo Deal', 'Sample Property',
  'foo@bar', 'example.com', 'DEMO DATA', 'TODO', 'undefined undefined', 'NaN', '$NaN']

const OUT = path.resolve('artifacts/production-release')
await fs.mkdir(OUT, { recursive: true })
const findings = []
const check = (cell, label, ok, detail = '') => { if (!ok) findings.push({ cell, label, detail }); return ok }

const browser = await chromium.launch()
const rows = []

for (const width of WIDTHS) {
  const ctx = await browser.newContext({
    viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  })
  for (const [route, signature] of ROUTES) {
    const cell = `${width}${route}`
    const page = await ctx.newPage()
    const errs = []; const failed = []
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)))
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console:${m.text().slice(0, 100)}`) })
    page.on('requestfailed', (r) => failed.push(`${r.url().split('?')[0].slice(-48)}:${r.failure()?.errorText || ''}`))
    const t0 = Date.now()
    try {
      const resp = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      check(cell, '§15 route serves 2xx', (resp?.status() ?? 0) < 400, `http=${resp?.status()}`)
      // Settle on a real mount, never a fixed sleep over a loading screen.
      await page.waitForFunction(() => {
        const t = document.body?.innerText || ''
        return t.length > 120 && !/^\s*(Loading|Authenticating)/i.test(t)
      }, undefined, { timeout: 45_000 }).catch(() => {})
      await page.waitForTimeout(1500)
      const ttm = Date.now() - t0

      const m = await page.evaluate(() => {
        const doc = document.documentElement
        /*
         * "Trapped under the dock" means the DOCK is what covers a control the
         * operator can actually see. Three things masquerade as that and are
         * not it, and a raw rect test counts all three:
         *   - the dock's own buttons (it always overlaps itself),
         *   - a list row hanging below the fold, whose centre is off-viewport
         *     and whose getBoundingClientRect still reports a real position,
         *   - a control clipped by an ancestor scroller.
         * So: ignore the dock's subtree, require the control to be fully on
         * screen, and ask elementFromPoint whether the DOCK is on top.
         */
        const dock = document.querySelector('.nx-pinned-app-dock')
        let under = 0
        const underDetail = []
        if (dock) {
          for (const el of document.querySelectorAll('button, a[href]')) {
            if (dock.contains(el)) continue
            const r = el.getBoundingClientRect()
            if (r.height === 0 || r.width === 0) continue
            if (r.top < 0 || r.bottom > window.innerHeight) continue
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            if (hit && (dock === hit || dock.contains(hit))) {
              under += 1
              underDetail.push(`${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20)}@${Math.round(r.top)}-${Math.round(r.bottom)}`)
            }
          }
        }
        return {
          overflow: Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth)),
          text: (document.body.innerText || '').replace(/\s+/g, ' '),
          under, underDetail, mounted: !!document.querySelector('#root')?.firstElementChild,
        }
      })

      check(cell, '§15 the app mounted', m.mounted, 'empty #root')
      check(cell, '§15 surface signature present', signature.test(m.text), `"${m.text.slice(0, 90)}"`)
      check(cell, '§14 no horizontal overflow', m.overflow === 0, `${m.overflow}px`)
      check(cell, '§14 nothing trapped under the dock', m.under === 0, `${m.under}: ${m.underDetail.join(', ')}`)
      const hits = FAKE.filter((f) => m.text.includes(f))
      check(cell, '§28 no fabricated-data tells', hits.length === 0, hits.join(', '))
      check(cell, '§29 no page/console errors', errs.length === 0, errs.slice(0, 2).join(' | '))
      check(cell, '§29 no failed requests', failed.length === 0, failed.slice(0, 2).join(' | '))
      check(cell, '§30 mounts under 15s', ttm < 15_000, `${ttm}ms`)

      if (width === 390) await page.screenshot({ path: path.join(OUT, `${route.replace(/\//g, '')}.png`) })
      rows.push(`${String(width).padEnd(4)} ${route.padEnd(20)} ${String(ttm + 'ms').padEnd(8)} ovf=${m.overflow} under=${m.under} err=${errs.length} netfail=${failed.length}`)
    } catch (e) {
      findings.push({ cell, label: 'route failed to load', detail: String(e?.message || e).slice(0, 160) })
    } finally { await page.close() }
  }
  await ctx.close()
}
await browser.close()

console.log(rows.join('\n'))
console.log('─'.repeat(78))
if (findings.length === 0) console.log(`PASS — ${ROUTES.length * WIDTHS.length} cells, 0 findings`)
else {
  console.log(`FAIL — ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  [${f.cell}] ${f.label}\n      ${f.detail}`)
  process.exitCode = 1
}
