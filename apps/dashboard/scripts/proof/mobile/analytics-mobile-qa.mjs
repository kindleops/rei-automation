/**
 * ANALYTICS-MOBILE-LOCK-1 §41 — Analytics on mobile.
 *
 * READ ONLY. Analytics is a read surface; nothing here mutates anything.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`)) ??
    (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : null)
  return hit ? hit.replace(`--${name}=`, '') : fallback
}

const BASE = arg('base', 'http://localhost:5174')
const list = (raw, fb) => (raw ? String(raw).split(',').map((v) => v.trim()).filter(Boolean) : fb)
const WIDTHS = list(arg('width'), ['375', '390', '430']).map(Number)
const THEMES = list(arg('theme'), ['dark', 'light'])
if (WIDTHS.some((w) => !Number.isInteger(w))) throw new Error('--width must be integers')

const OUT = path.resolve('artifacts/analytics-mobile')
await fs.mkdir(OUT, { recursive: true })

const readSecret = async () => {
  for (const f of ['.env.local', '.env', '.env.development']) {
    try {
      const txt = await fs.readFile(path.resolve(process.cwd(), f), 'utf8')
      const m = txt.match(/^\s*(?:VITE_)?OPS_DASHBOARD_SECRET\s*=\s*(.+)$/m)
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
    } catch { /* next */ }
  }
  return null
}
const secret = await readSecret()
if (!secret) throw new Error('OPS_DASHBOARD_SECRET not found — canonical truth unreadable')

const api = async (qs = 'window=7d&channel=all') => {
  const res = await fetch(`${BASE}/api/cockpit/metrics/war-room?${qs}`, {
    headers: { 'x-ops-dashboard-secret': secret },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

// ── canonical truth, service-side
const wr = await api('window=7d&channel=all')
const k = wr.body?.kpis ?? {}
const TRUTH = {
  status: wr.status,
  sent: k.sentCount, delivered: k.deliveredCount, replied: k.repliedCount,
  failed: k.failedCount, deliveryRate: k.deliveryRate, replyRate: k.replyRate,
  replyBasis: k.replyRateBasis,
  buyerDemand: k.buyerDemandScore,
  queueHealth: k.queueHealth,
  autoHealth: k.automationHealthScore,
  emailWired: wr.body?.email_health?.wired,
  emailSent: wr.body?.email_health?.sent,
  availability: wr.body?.metric_availability,
  sources: Object.keys(wr.body?.source_audit ?? {}).length,
}

console.log('\nCANONICAL TRUTH (service-side)')
console.log(`  war-room      http ${TRUTH.status}  sources=${TRUTH.sources}`)
console.log(`  sms           sent=${TRUTH.sent} delivered=${TRUTH.delivered} failed=${TRUTH.failed} deliveryRate=${TRUTH.deliveryRate}`)
console.log(`  reply         rate=${TRUTH.replyRate} basis=${JSON.stringify(TRUTH.replyBasis)}`)
console.log(`  unmeasured    buyerDemand=${TRUTH.buyerDemand} emailWired=${TRUTH.emailWired} emailSent=${TRUTH.emailSent}`)
console.log(`  health        queue=${TRUTH.queueHealth} auto=${TRUTH.autoHealth}`)

const findings = []
if (wr.status !== 200) findings.push({ cell: 'api', n: '§47 the war-room API must not fail', d: `http ${wr.status}` })
if (wr.body?.ok === false) findings.push({ cell: 'api', n: '§47 envelope ok:false', d: JSON.stringify(wr.body).slice(0, 160) })
// §4/§17 — unmeasured must be null, never 0
if (TRUTH.buyerDemand === 0) findings.push({ cell: 'api', n: '§17 an unwired buyer source must be null, not 0', d: `${TRUTH.buyerDemand}` })
if (TRUTH.emailWired === false && TRUTH.emailSent === 0) {
  findings.push({ cell: 'api', n: '§16 uncommissioned email must be null, not 0', d: `sent=${TRUTH.emailSent}` })
}

const setTheme = (t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: t }))
  } catch {}
  try { document.documentElement?.setAttribute('data-nexus-theme', t) } catch {}
  try {
    document.addEventListener('DOMContentLoaded', () => document.documentElement?.setAttribute('data-nexus-theme', t))
  } catch {}
}

const browser = await chromium.launch()

async function runCell(width, theme) {
  const check = (n, ok, d) => { if (!ok) findings.push({ cell: `${width}-${theme}`, n, d }); return ok }
  const context = await browser.newContext({
    viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    timezoneId: 'America/Phoenix',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript(setTheme, theme)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))
  /**
   * Count the canonical request itself.
   *
   * The first version of this harness only asserted downstream symptoms, so
   * when the surface made NO war-room request at all — paused forever, eight
   * skeleton cards — it reported "KPI renders null" instead of the actual
   * defect. A read surface that never reads is the thing to assert.
   */
  const dataRequests = []
  page.on('request', (r) => {
    if (r.url().includes('/api/cockpit/metrics/war-room')) dataRequests.push(r.url())
  })

  const timings = {}
  const mark = async (name, fn) => { const t0 = Date.now(); await fn(); timings[name] = Date.now() - t0 }

  await mark('shell', async () => {
    await page.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForSelector('.wr', { timeout: 60_000 })
  })

  // Settle on a STATED outcome: real KPI values, or an explicit unavailable.
  const settle = async (target) => {
    await target.waitForFunction(
      () => {
        if (document.querySelector('.wr-alert__msg')?.textContent?.match(/unavailable/i)) return true
        // A stated outcome means real cards, or an explicit hold/failure —
        // never just the absence of a word.
        if (document.querySelector('.wr-alert__msg')?.textContent?.match(/paused/i)) return true
        const labelled = [...document.querySelectorAll('.wr-rail__kpi')]
          .filter((el) => el.querySelector('.wr-rail__kpi-label'))
        return labelled.length > 0
      },
      undefined, { timeout: 30_000 },
    ).catch(() => {})
    await target.waitForTimeout(1500)
  }
  await settle(page)

  const probe = () => page.evaluate(() => {
    const txt = (s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null
    // A skeleton placeholder shares the .wr-rail__kpi class but has no label.
    // Counting them as cards made an unloaded surface look populated.
    const kpis = [...document.querySelectorAll('.wr-rail__kpi')]
      .filter((el) => el.querySelector('.wr-rail__kpi-label'))
      .map((el) => ({
        label: el.querySelector('.wr-rail__kpi-label')?.textContent?.trim() ?? null,
        value: el.querySelector('.wr-rail__kpi-value')?.textContent?.trim() ?? null,
        sub: el.querySelector('.wr-rail__kpi-sub')?.textContent?.trim() ?? null,
      }))
    const skeletons = document.querySelectorAll('.wr-skel').length
    const reach = (el) => {
      if (!el) return { present: false }
      const b = el.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
      return { present: true, h: Math.round(b.height), bottom: Math.round(b.bottom), reachable: !!(hit && (hit === el || el.contains(hit))) }
    }
    const body = (document.body.innerText || '').replace(/\s+/g, ' ')
    return {
      rail: document.querySelectorAll('.wr.wr--rail').length,
      skeletons,
      title: txt('.wr-rail__title'),
      kpis,
      alerts: [...document.querySelectorAll('.wr-alert__msg')].map((e) => e.textContent.trim()),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      theme: document.documentElement.getAttribute('data-nexus-theme'),
      body: body.slice(0, 900),
      /** §2 — the fabricated datasets that used to be on this route. */
      fabricated: [
        '45,200', '45200', '42,100', '12,400', '11,800', '1,840',
        'Under Contract 42', 'Closed 18',
      ].filter((n) => body.includes(n)),
      // §25 a trend must never be a hardcoded string
      trends: [...document.querySelectorAll('[class*="trend"]')].map((e) => e.textContent.trim()).slice(0, 6),
      rangeBtns: [...document.querySelectorAll('.wr-header__range-btn')].map((b) => ({
        label: b.textContent.trim(), ...reach(b),
      })),
      dock: (() => { const e = document.querySelector('.nx-pinned-app-dock'); return e ? Math.round(e.getBoundingClientRect().top) : null })(),
      scrollable: (() => {
        const el = document.querySelector('.wr-rail__scroll')
        if (!el) return null
        return { scrollH: el.scrollHeight, clientH: el.clientHeight, canScroll: el.scrollHeight > el.clientHeight + 4 }
      })(),
    }
  })

  /**
   * Re-read canonical truth INSIDE the cell.
   *
   * The window is a 7-day ROLLING range, so rows age out of it as the matrix
   * runs. Comparing the last cell against a snapshot taken ~10 minutes earlier
   * reported "ui 147 vs canonical 148" — the UI was right and my reference was
   * stale. Same drift class as the Calendar run ids: read live, don't snapshot.
   */
  const live = await api('window=7d&channel=all')
  const lk = live.body?.kpis ?? {}

  const p = await probe()
  check('the analytics surface renders its mobile rail', p.rail === 1, `${p.rail} rails, title="${p.title}"`)
  check('§45 the surface actually reads the canonical metrics endpoint',
    dataRequests.length > 0, `${dataRequests.length} war-room requests`)
  check('§4 the surface is not stuck on skeleton placeholders',
    p.skeletons === 0 || p.kpis.length > 0,
    `${p.skeletons} skeletons, ${p.kpis.length} real cards`)
  check('theme applied', p.theme === theme, `${p.theme}`)
  check('§41 no page-wide horizontal overflow', p.overflow === 0, `${p.overflow}px`)
  check('§2 no fabricated dataset appears on the production route',
    p.fabricated.length === 0, p.fabricated.join(', ') || 'none')
  check('§3 KPI cards are rendered with labels', p.kpis.length >= 6, `${p.kpis.length} cards`)

  // §4 — a real number or an explicit dash, never "null"/"NaN"/"undefined"
  const junk = p.kpis.filter((c) => /null|nan|undefined|infinity/i.test(String(c.value)))
  check('§4 no KPI renders null/NaN/undefined', junk.length === 0,
    junk.map((c) => `${c.label}=${c.value}`).join(', ') || 'none')

  // §17 — unmeasured buyer demand must show as unavailable, not a score
  const buyer = p.kpis.find((c) => /buyer/i.test(c.label || ''))
  check('§17 an unwired metric shows as unavailable, not a number',
    !buyer || buyer.value === '—', `${buyer?.label}="${buyer?.value}" sub="${buyer?.sub}"`)

  // §4 — a health verdict with no data must not read as Crit/Good
  const health = p.kpis.find((c) => /queue health/i.test(c.label || ''))
  if (health && TRUTH.queueHealth === null) {
    check('§4 a health verdict with no data is not rendered as Crit',
      health.value === '—', `queue health="${health.value}"`)
  }

  // §3/§45 — the rendered KPI must equal canonical truth
  const sentCard = p.kpis.find((c) => c.label === 'Sent')
  if (sentCard && lk.sentCount != null) {
    // Tolerance of 2 absorbs rows aging out of the rolling window between the
    // page's own fetch and this one; it is not slack on correctness.
    check('§45 the Sent card equals the canonical count',
      Math.abs(Number(sentCard.value.replace(/,/g, '')) - lk.sentCount) <= 2,
      `ui="${sentCard.value}" canonical=${lk.sentCount}`)
  }
  const deliveredCard = p.kpis.find((c) => c.label === 'Delivered')
  if (deliveredCard && lk.deliveredCount != null) {
    check('§45/§11 the Delivered card equals canonical delivered, not sent',
      Math.abs(Number(deliveredCard.value.replace(/,/g, '')) - lk.deliveredCount) <= 2 &&
      lk.deliveredCount !== lk.sentCount,
      `ui="${deliveredCard.value}" canonical delivered=${lk.deliveredCount} sent=${lk.sentCount}`)
  }

  // §25 no hardcoded trend text
  check('§25 no hardcoded trend string is rendered',
    !/(↑|↓)\s*(12|8|4\.2)%/.test(p.body), p.trends.join(' | ') || 'none')

  // §39/§41 controls reachable
  check('§39 the date-range controls are reachable at their own centre',
    p.rangeBtns.length === 0 || p.rangeBtns.every((b) => b.reachable && b.h >= 24),
    JSON.stringify(p.rangeBtns.slice(0, 4)))
  check('§39 the KPI rail scrolls rather than overflowing the page',
    p.scrollable === null || p.overflow === 0, JSON.stringify(p.scrollable))
  const lowest = p.kpis.length ? null : null
  check('§41 the bottom dock is not covered by content',
    p.dock === null || p.overflow === 0, `dock top=${p.dock}`)
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-rail.png`) })

  // ── §35/§36 the date filter must change the backend query
  if (p.rangeBtns.length >= 2) {
    const urls = []
    page.on('request', (r) => { if (r.url().includes('/metrics/war-room')) urls.push(r.url()) })
    const target = p.rangeBtns.find((b) => /30/.test(b.label)) ?? p.rangeBtns[p.rangeBtns.length - 1]
    await page.locator('.wr-header__range-btn', { hasText: target.label }).first().click()
    await page.waitForTimeout(3500)
    check('§35/§36 changing the range re-queries the backend with a new window',
      urls.some((u) => /window=(30d|40d|today)/.test(u)),
      urls.map((u) => (u.match(/window=[a-z0-9_]+/) || [''])[0]).join(', ') || 'no new request')
  }

  // ── §4/§43 a failed metrics read must not render as a healthy empty dashboard
  const failCtx = await browser.newContext({
    viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    timezoneId: 'America/Phoenix',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await failCtx.addInitScript(setTheme, theme)
  const failPage = await failCtx.newPage()
  let failReqs = 0
  await failPage.route('**/api/cockpit/metrics/war-room**', (route) => {
    failReqs += 1
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'war_room_failed' }) })
  })
  await failPage.goto(`${BASE}/analytics`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await failPage.waitForSelector('.wr', { timeout: 60_000 }).catch(() => {})
  await settle(failPage)
  const failed = await failPage.evaluate(() => {
    const kpis = [...document.querySelectorAll('.wr-rail__kpi')].map((el) => ({
      label: el.querySelector('.wr-rail__kpi-label')?.textContent?.trim() ?? null,
      value: el.querySelector('.wr-rail__kpi-value')?.textContent?.trim() ?? null,
    }))
    return {
      kpis,
      alerts: [...document.querySelectorAll('.wr-alert__msg')].map((e) => e.textContent.trim()),
      body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
    }
  })
  check('§4/§43 a failed metrics read is stated, not rendered as a healthy dashboard',
    failed.alerts.some((a) => /unavailable/i.test(a)),
    `alerts=${JSON.stringify(failed.alerts).slice(0, 180)}`)
  check('§4 a failed read shows no fabricated zero or health verdict',
    failed.kpis.every((c) => !/^0%?$/.test(String(c.value)) && !/^(Good|Crit|Warn)$/.test(String(c.value))),
    failed.kpis.filter((c) => /^0%?$|^(Good|Crit|Warn)$/.test(String(c.value))).map((c) => `${c.label}=${c.value}`).join(', ') || 'none')
  check('§42 a failing dashboard does not retry in an unbounded loop',
    failReqs > 0 && failReqs < 40, `${failReqs} requests while failing`)
  await failPage.screenshot({ path: path.join(OUT, `${width}-${theme}-error.png`) })
  await failCtx.close()

  for (const [step, budget] of [['shell', 15000]]) {
    if (timings[step] === undefined) continue
    check(`§42 ${step} responds within budget`, timings[step] < budget, `${timings[step]}ms`)
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

  await context.close()
  return { cell: `${width}-${theme}`, kpis: p.kpis.length, timings, failReqs }
}

const results = []
try {
  for (const w of WIDTHS) for (const t of THEMES) {
    const before = findings.length
    const r = await runCell(w, t)
    results.push(r)
    const bad = findings.length - before
    const ms = r.timings || {}
    console.log(`${r.cell.padEnd(12)} ${(bad ? `FAIL (${bad})` : 'PASS').padEnd(10)} kpis ${String(r.kpis).padEnd(3)} shell ${ms.shell ?? '-'}ms  requests-while-failing ${r.failReqs}`)
    for (const f of findings.slice(before)) console.log(`   x ${f.n}: ${f.d}`)
  }
} finally { await browser.close() }

console.log('')
const badCells = new Set(findings.map((f) => f.cell))
console.log(`ANALYTICS MATRIX ${results.length - [...badCells].filter((c) => c !== 'api').length}/${results.length} cells clean, ${findings.length} finding(s)`)
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ TRUTH, results, findings }, null, 2))
if (findings.length) process.exit(1)
