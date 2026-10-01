import { chromium } from 'playwright'
/**
 * PIPELINE DESKTOP 2 — phone sanity check (READ ONLY; non-GET /api + Supabase aborted).
 * The desktop rebuild must leave the phone Pipeline exactly as it was: the
 * command center (.plc) mounts, the desktop surface (.pd2) never does.
 *
 *   node scripts/proof/desktop/pipeline-desktop-2-mobile-check.mjs --out=/tmp/pipeline
 */
const OUT = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || '/tmp'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/*', (r) => { const q = r.request(); const u = new URL(q.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return r.abort(); return r.continue() })
const wd = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 600_000)
await page.goto('http://localhost:5173/pipeline', { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('.plc', { timeout: 300000 }).catch(() => console.log('note: .plc did not mount'))
await page.waitForFunction(() => /live deals|deals/i.test(document.querySelector('.plc-hero')?.textContent || ''), null, { timeout: 330000 }).catch(() => console.log('note: hero not loaded'))
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/phone-390x844-pipeline.png` })
const info = await page.evaluate(() => ({ plc: Boolean(document.querySelector('.plc')), pd2: Boolean(document.querySelector('.pd2')), hero: (document.querySelector('.plc-hero')?.textContent || '').replace(/\s+/g, ' ').slice(0, 160) }))
console.log(JSON.stringify({ ...info, errors: errors.slice(0, 4) }))
clearTimeout(wd)
await browser.close()
