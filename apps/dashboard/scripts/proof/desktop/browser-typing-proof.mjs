import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * BROWSER ADDRESS-BAR PROOF (READ ONLY — non-GET to /api or Supabase aborted;
 * "Open in your browser" is never clicked). Types the four inputs the owner
 * reported and asserts each lands:
 *   google.com                         → external handoff card (one-click Open)
 *   zillow 3635 emerson ave n          → a web search (search URL built)
 *   https://zillow.com                 → external handoff card
 *   https://gis.hennepin.us/property/  → rendered in a sandboxed frame
 * and that consecutive typing never appends to the previous URL.
 *   node scripts/proof/desktop/browser-typing-proof.mjs --out=/tmp/typing [--base=http://localhost:5173]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/browser-typing'))
await fs.mkdir(OUT, { recursive: true })
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage()
const errs = []; p.on('pageerror', (e) => errs.push(e.message))
ctx.on('page', (x) => { if (x !== p) x.close().catch(() => {}) })
await p.route('**/*', (r) => { const q = r.request(); const u = new URL(q.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET','HEAD','OPTIONS'].includes(q.method())) return r.abort(); return r.continue() })
setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 240000)
await p.goto(BASE + '/browser', { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForSelector('.lcb-addr__input', { timeout: 120000 }); await p.waitForTimeout(2500)
const state = () => p.evaluate(() => ({ value: document.querySelector('.lcb-addr__input')?.value, focused: document.activeElement === document.querySelector('.lcb-addr__input'), card: document.querySelector('.lcb-state__title')?.textContent ?? null, why: document.querySelector('.lcb-state__why')?.textContent ?? null, open: document.querySelector('.lcb-state__open')?.textContent ?? null, frame: document.querySelector('.lcb-surface:not([hidden]) iframe')?.getAttribute('src') ?? null, err: document.querySelector('.lcb-addr__error')?.textContent ?? null }))
const cases = [
  { q: 'google.com', expect: (s) => s.value === 'https://google.com/' && s.open && !s.frame },
  { q: 'zillow 3635 emerson ave n', expect: (s) => /google\.com\/search\?q=zillow/.test(s.value) },
  { q: 'https://zillow.com', expect: (s) => s.value === 'https://zillow.com/' && s.open && !s.frame },
  { q: 'https://gis.hennepin.us/property/', expect: (s) => s.frame === 'https://gis.hennepin.us/property/' },
]
const results = []
let i = 0
for (const c of cases) {
  await p.locator('.lcb-addr__input').click()
  await p.keyboard.type(c.q, { delay: 12 })
  const typed = await state()
  await p.keyboard.press('Enter'); await p.waitForTimeout(c.q.includes('hennepin') ? 6000 : 1500)
  const after = await state()
  const pass = typed.value === c.q && !after.focused && Boolean(c.expect(after))
  results.push({ q: c.q, pass, typed: typed.value, after })
  await p.screenshot({ path: path.join(OUT, `typing-${++i}.png`) })
}
console.log(JSON.stringify({ results, errors: errs.slice(0, 5) }, null, 2))
await b.close()
process.exit(results.every((r) => r.pass) && !errs.length ? 0 : 1)
