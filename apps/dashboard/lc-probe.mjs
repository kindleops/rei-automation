import { chromium } from '@playwright/test'
const base = process.env.LC_BASE_URL || 'http://127.0.0.1:5188'
const route = process.argv[2] || '/pipeline'
const width = Number(process.argv[3] || 820)
const sel = process.argv[4] || '.nx-notification-button'
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width, height: 1180 }, colorScheme: 'dark' })
const p = await ctx.newPage()
await p.goto(base + route, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => document.querySelectorAll('#root *').length > 200, null, { timeout: 90000, polling: 250 }).catch(() => {})
await p.waitForTimeout(2500)
const out = await p.evaluate((s) => {
  const sheets = [...document.styleSheets].map(sh => sh.href || (sh.ownerNode?.getAttribute?.('data-vite-dev-id') || '').slice(0,80))
  const el = document.querySelector(s)
  const base = { sheetCount: sheets.length, lcLoaded: sheets.some(x => String(x).includes('lc-responsive')), innerW: innerWidth, mq: matchMedia('(max-width: 1023.98px)').matches }
  if (!el) return { ...base, found: false }
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return { ...base, found: true, rect: { w: Math.round(r.width), h: Math.round(r.height) }, minH: cs.minHeight, minW: cs.minWidth, h: cs.height, w: cs.width, display: cs.display, box: cs.boxSizing }
}, sel)
console.log(JSON.stringify(out))
await b.close()
