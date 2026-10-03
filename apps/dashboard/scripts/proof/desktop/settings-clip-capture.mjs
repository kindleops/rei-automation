import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * Settings clipping audit (READ ONLY: non-GET /api + Supabase aborted). Every /settings section and the
 * deck profile panel's Sound tab, at each width; reports any element whose box overflows its section /
 * the viewport (the "right-hand side is cut off" defect) and shoots each.
 *   node scripts/proof/desktop/settings-clip-capture.mjs --out=/tmp/st --sizes=1280x800,1440x900,1920x1080,5120x1440
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const OUT = path.resolve(arg('out', 'artifacts/settings-clip'))
const SIZES = arg('sizes', '1280x800,1440x900,1920x1080,5120x1440').split(',').map((s) => s.split('x').map(Number))
const SECTIONS = arg('sections', 'appearance,alerts,workspace,keyboard,account,about').split(',')
const THEME = arg('theme', 'dark')
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 900_000)
const browser = await chromium.launch()
const report = []
const clipped = (root) => {
  const r0 = document.querySelector(root)?.getBoundingClientRect()
  if (!r0) return { missing: root }
  const vw = window.innerWidth
  const out = []
  for (const el of document.querySelectorAll(`${root} *`)) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    if (r.right > Math.min(vw, r0.right) + 1.5) out.push({ el: `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}`, right: Math.round(r.right), limit: Math.round(Math.min(vw, r0.right)), text: (el.textContent || '').trim().slice(0, 40) })
  }
  // only the outermost offenders
  return { root: { left: Math.round(r0.left), right: Math.round(r0.right), width: Math.round(r0.width) }, overflow: out.slice(0, 8), n: out.length }
}
for (const [W, H] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript((t) => { try { const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t })); localStorage.setItem('nexus.desktop.ultrawide.seeded', '1') } catch { /* ignore */ } }, THEME)
  const page = await ctx.newPage()
  await page.route('**/*', (r) => { const q = r.request(); const u = new URL(q.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return r.abort(); return r.continue() })
  for (const s of SECTIONS) {
    await page.goto(`http://localhost:5173/settings?section=${s}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('.st-body', { timeout: 120000 }); await page.waitForTimeout(900)
    await page.screenshot({ path: path.join(OUT, `settings-${s}-${W}.png`) })
    report.push({ where: `settings/${s}`, size: `${W}x${H}`, ...(await page.evaluate(clipped, '.st-body')) })
  }
  // the deck's profile panel → Sound tab
  await page.goto('http://localhost:5173/pipeline', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cd-machine', { timeout: 120000 }); await page.waitForTimeout(1200)
  await page.locator('button.cd-op').click(); await page.waitForSelector('.dsk-pop--profile')
  await page.locator('.dsk-pop--profile .dsk-seg__tab', { hasText: 'Sound' }).click(); await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(OUT, `profile-sound-${W}.png`) })
  report.push({ where: 'profile/sound', size: `${W}x${H}`, ...(await page.evaluate(clipped, '.dsk-pop--profile')) })
  await ctx.close()
}
clearTimeout(watchdog)
console.log(JSON.stringify(report.filter((r) => r.n || r.missing), null, 1))
console.log('checked', report.length)
await browser.close()
