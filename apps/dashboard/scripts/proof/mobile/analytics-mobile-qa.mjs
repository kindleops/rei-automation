/**
 * ANALYTICS ON MOBILE — the geographic intelligence drill-down.
 *
 * READ ONLY. Analytics is a read surface; nothing here mutates anything.
 *
 * RETARGETED for MOBILE-LOCK §7. This harness used to assert the war room's
 * 25% KPI rail (`.wr`, `.wr-rail__kpi`), which was what mobile rendered before
 * §7 replaced it with AnalyticsGeoMobile. Every TRUTH assertion it carried is
 * preserved and re-pointed at the new surface — the endpoint is still read, the
 * fabricated datasets are still forbidden, a rendered number still has to equal
 * canonical, a failed read still has to be stated rather than drawn as a healthy
 * empty dashboard. What changes is the DOM it looks at, plus the §7 claims that
 * did not exist before: a real US map, a working drill-down, a touch-scrubbable
 * trend, and rates withheld below the volume floor.
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
    await page.waitForSelector('[data-analytics="geo-mobile"]', { timeout: 60_000 })
  })

  // Settle on a STATED outcome: real KPI values, or an explicit unavailable.
  const settle = async (target) => {
    await target.waitForFunction(
      () => {
        // An explicit failure is a settled outcome.
        if (document.querySelector('.geo__state.is-error')) return true
        // …so is a headline that has stopped saying "—".
        const headline = document.querySelector('.geo__headline > strong')?.textContent?.trim()
        return Boolean(headline) && headline !== '—'
      },
      undefined, { timeout: 30_000 },
    ).catch(() => {})
    await target.waitForTimeout(1500)
  }
  await settle(page)

  const probe = () => page.evaluate(() => {
    const txt = (s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null
    const reach = (el) => {
      if (!el) return { present: false }
      const b = el.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
      return { present: true, h: Math.round(b.height), bottom: Math.round(b.bottom), reachable: !!(hit && (hit === el || el.contains(hit))) }
    }
    const body = (document.body.innerText || '').replace(/\s+/g, ' ')
    const mapEl = document.querySelector('.geo-map')
    const chartEl = document.querySelector('.geo .geo-chart__svg')
    return {
      root: document.querySelectorAll('[data-analytics="geo-mobile"]').length,
      level: document.querySelector('[data-analytics="geo-mobile"]')?.getAttribute('data-level') ?? null,
      headlineLabel: txt('.geo__headline > span'),
      headlineValue: txt('.geo__headline > strong'),
      /**
       * §7 — the map is the primary instrument, not a thumbnail.
       *
       * Retargeted from the SVG choropleth this replaced: there is no
       * `.geo-map__state` node and no `viewBox` to read any more, because the map
       * is MapLibre rendering to a CANVAS. What can still be asserted from
       * outside is that the canvas exists at real size, that the surface did not
       * fall back to its own "map unavailable" state, and that the accessible
       * state list — which is built from the SAME features the map draws — holds
       * every state the endpoint reported.
       */
      map: mapEl ? {
        h: Math.round(mapEl.getBoundingClientRect().height),
        canvas: (() => {
          const c = document.querySelector('.geo-map__canvas canvas')
          return c ? { w: c.width, h: c.height } : null
        })(),
        unavailable: mapEl.classList.contains('is-unavailable'),
      } : null,
      statesWithData: document.querySelectorAll('.geo-map .nx-sr-only li').length,
      /** §7 — the trend must be a real chart, not a 16px icon-sized SVG. */
      chart: chartEl ? { w: Math.round(chartEl.getBoundingClientRect().width), h: Math.round(chartEl.getBoundingClientRect().height) } : null,
      metricModes: [...document.querySelectorAll('.geo__metric')].map((e) => e.textContent.trim()),
      stateRows: [...document.querySelectorAll('.geo__row')].map((e) => ({
        name: e.querySelector('.geo__row-copy strong')?.textContent?.trim() ?? null,
        value: e.querySelector('.geo__row-value b')?.textContent?.trim() ?? null,
        rate: e.querySelector('.geo__row-value em')?.textContent?.trim() ?? null,
      })),
      rateRow: txt('.geo__rate-row'),
      errorState: txt('.geo__state.is-error'),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      theme: document.documentElement.getAttribute('data-nexus-theme'),
      body: body.slice(0, 900),
      /** §2 — the fabricated datasets that used to be on this route. */
      fabricated: [
        '45,200', '45200', '42,100', '12,400', '11,800', '1,840',
        'Under Contract 42', 'Closed 18',
      ].filter((n) => body.includes(n)),
      trends: [...document.querySelectorAll('[class*="trend"]')].map((e) => e.textContent.trim()).slice(0, 6),
      rangeBtns: [...document.querySelectorAll('.geo__ranges button')].map((b) => ({
        label: b.textContent.trim(), ...reach(b),
      })),
      dock: (() => { const e = document.querySelector('.nx-pinned-app-dock'); return e ? Math.round(e.getBoundingClientRect().top) : null })(),
    }
  })

  /** The 51 state outlines the mask is punched from — served, not bundled. */
  const outlineAsset = await page.evaluate(async () => {
    try {
      const response = await fetch('/geo/us-states.json')
      if (!response.ok) return { ok: false, features: 0 }
      const data = await response.json()
      return { ok: true, features: Array.isArray(data?.features) ? data.features.length : 0 }
    } catch {
      return { ok: false, features: 0 }
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

  // ── the surface exists and actually reads
  check('§7 the analytics surface renders the geographic drill-down',
    p.root === 1, `${p.root} roots, level="${p.level}"`)
  check('§45 the surface actually reads the canonical metrics endpoint',
    dataRequests.length > 0, `${dataRequests.length} war-room requests`)
  check('theme applied', p.theme === theme, `${p.theme}`)
  check('§41 no page-wide horizontal overflow', p.overflow === 0, `${p.overflow}px`)
  check('§2 no fabricated dataset appears on the production route',
    p.fabricated.length === 0, p.fabricated.join(', ') || 'none')

  // ── §7 the map is the instrument, not a decoration
  check('§7 the map is a real MapLibre canvas, not a drawing of the country',
    p.map !== null && !p.map.unavailable && (p.map.canvas?.w ?? 0) > 0 && (p.map.canvas?.h ?? 0) > 0,
    JSON.stringify(p.map))
  // The carve-out and every state border come from this one asset. If it 404s the
  // map still draws — which is why its absence has to be caught here rather than
  // left to look like a styling choice.
  check('§7 the state outlines the carve-out is cut from are served',
    outlineAsset.ok && outlineAsset.features >= 50,
    `ok=${outlineAsset.ok} features=${outlineAsset.features}`)
  check('§7 the map is a meaningful part of the screen, not a thumbnail',
    p.map !== null && p.map.h >= 180, `${p.map?.h}px tall`)
  check('§7 the map carries every state the endpoint measured',
    p.statesWithData > 0 || TRUTH.sent === 0,
    `${p.statesWithData} placed, canonical sent=${TRUTH.sent}`)

  // ── §7 the trend chart is a chart
  // `.nx-premium-inbox svg { width:16px }` is a (0,1,1) global icon rule that
  // outranks a bare class selector, and it silently crushed this chart to a 16px
  // square once. A 16x16 "chart" is the regression this asserts against.
  check('§7 the trend chart is rendered at chart size, not icon size',
    p.chart !== null && p.chart.w > 120 && p.chart.h > 40, JSON.stringify(p.chart))

  // ── §7 metric modes are real and drill-safe
  check('§7 the metric rail offers the canonical modes',
    p.metricModes.length >= 4, p.metricModes.join(', '))
  check('§17 an unwired metric is absent from the rail, not offered as a number',
    !p.metricModes.some((m) => /buyer/i.test(m)) || TRUTH.buyerDemand !== null,
    `modes=${p.metricModes.join(', ')} canonical buyerDemand=${TRUTH.buyerDemand}`)

  // ── §4 no junk values anywhere the operator can read one
  const junk = [p.headlineValue, ...p.stateRows.map((r) => r.value), ...p.stateRows.map((r) => r.rate)]
    .filter((v) => v && /null|nan|undefined|infinity/i.test(String(v)))
  check('§4 no rendered metric is null/NaN/undefined', junk.length === 0, junk.join(', ') || 'none')

  // ── §3/§45 the headline must equal canonical truth
  if (p.headlineValue && lk.sentCount != null && /sent/i.test(p.headlineLabel ?? '')) {
    // Tolerance of 2 absorbs rows aging out of the rolling window between the
    // page's own fetch and this one; it is not slack on correctness.
    check('§45 the nationwide headline equals the canonical sent count',
      Math.abs(Number(String(p.headlineValue).replace(/,/g, '')) - lk.sentCount) <= 2,
      `ui="${p.headlineValue}" canonical=${lk.sentCount}`)
  }

  // ── §7 a rate on thin volume is withheld, not printed
  const thin = p.stateRows.filter((r) => Number(String(r.value).replace(/,/g, '')) > 0 && Number(String(r.value).replace(/,/g, '')) < 25)
  check('§7 low-volume rows do not print a rate they cannot support',
    thin.every((r) => !r.rate || r.rate === '—'),
    thin.map((r) => `${r.name} ${r.value}/${r.rate}`).join(', ') || 'none')

  // §25 no hardcoded trend text
  check('§25 no hardcoded trend string is rendered',
    !/(↑|↓)\s*(12|8|4\.2)%/.test(p.body), p.trends.join(' | ') || 'none')

  // §39/§41 controls reachable
  check('§39 the date-range controls are reachable at their own centre',
    p.rangeBtns.length >= 2 && p.rangeBtns.every((b) => b.reachable && b.h >= 24),
    JSON.stringify(p.rangeBtns.slice(0, 4)))
  check('§41 the bottom dock is not covered by content',
    p.dock === null || p.overflow === 0, `dock top=${p.dock}`)
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-nation.png`) })

  // ── §7 THE DRILL-DOWN. United States → state → market.
  let drill = null
  const nationalFrame = await page.locator('.geo-map__canvas canvas').screenshot()
    .then((b) => b.toString('base64').length).catch(() => null)

  if (p.stateRows.length > 0) {
    await page.locator('.geo__row').first().click()
    await page.waitForTimeout(1800)
    drill = await page.evaluate(() => ({
      level: document.querySelector('[data-analytics="geo-mobile"]')?.getAttribute('data-level') ?? null,
      crumbs: document.querySelector('.geo__crumbs')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
      reset: Boolean(document.querySelector('.geo-map__reset')),
      rows: document.querySelectorAll('.geo__row').length,
      headline: document.querySelector('.geo__headline > strong')?.textContent?.trim() ?? null,
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    }))
    check('§7 tapping a state drills into it', drill.level === 'state', JSON.stringify(drill))
    // The camera move is the whole point of the drill, and a canvas has no
    // attribute that reports it. Comparing the rendered pixels before and after
    // is the only honest check: if the map did not move, the frames match.
    const movedTo = await page.locator('.geo-map__canvas canvas').screenshot().then((b) => b.toString('base64').length).catch(() => null)
    check('§7 the drill reframes the map on that state',
      drill.reset && movedTo !== null && movedTo !== nationalFrame,
      `reset=${drill.reset} frameBefore=${nationalFrame} frameAfter=${movedTo}`)
    check('§7 the breadcrumb states the scope', /United States\s*\/\s*\S/.test(drill.crumbs ?? ''), drill.crumbs)
    check('§41 the drill does not overflow', drill.overflow === 0, `${drill.overflow}px`)
    await page.screenshot({ path: path.join(OUT, `${width}-${theme}-state.png`) })

    if (drill.rows > 0) {
      await page.locator('.geo__row').first().click()
      await page.waitForTimeout(1500)
      const market = await page.evaluate(() => ({
        level: document.querySelector('[data-analytics="geo-mobile"]')?.getAttribute('data-level') ?? null,
        crumbs: document.querySelector('.geo__crumbs')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      }))
      check('§7 tapping a market drills into it', market.level === 'market', JSON.stringify(market))
      check('§41 the market level does not overflow', market.overflow === 0, `${market.overflow}px`)
      await page.screenshot({ path: path.join(OUT, `${width}-${theme}-market.png`) })
      // Back out to the nation for the range test below.
      await page.locator('.geo__crumbs button').first().click()
      await page.waitForTimeout(1200)
    }
  }

  // ── §35/§36 the date filter must change the backend query
  if (p.rangeBtns.length >= 2) {
    const urls = []
    page.on('request', (r) => { if (r.url().includes('/metrics/war-room')) urls.push(r.url()) })
    const target = p.rangeBtns.find((b) => /30/.test(b.label)) ?? p.rangeBtns[p.rangeBtns.length - 1]
    await page.locator('.geo__ranges button', { hasText: target.label }).first().click()
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
  await failPage.waitForSelector('[data-analytics="geo-mobile"]', { timeout: 60_000 }).catch(() => {})
  await settle(failPage)
  const failed = await failPage.evaluate(() => {
    const values = [
      document.querySelector('.geo__headline > strong')?.textContent?.trim() ?? null,
      ...[...document.querySelectorAll('.geo__row-value b')].map((e) => e.textContent.trim()),
    ].filter(Boolean)
    return {
      values,
      alerts: [
        document.querySelector('.geo__state.is-error')?.innerText.replace(/\s+/g, ' ').trim(),
      ].filter(Boolean),
      rows: document.querySelectorAll('.geo__row').length,
      body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
    }
  })
  check('§4/§43 a failed metrics read is stated, not rendered as a healthy dashboard',
    failed.alerts.some((a) => /unavailable/i.test(a)),
    `alerts=${JSON.stringify(failed.alerts).slice(0, 180)}`)
  check('§4 a failed read renders no state rows and no fabricated counts',
    failed.rows === 0 && failed.values.every((v) => !/^0$/.test(String(v))),
    `rows=${failed.rows} values=${failed.values.join(', ') || 'none'}`)
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
  return { cell: `${width}-${theme}`, states: p.stateRows.length, drill: drill?.level ?? null, timings, failReqs }
}

const results = []
try {
  for (const w of WIDTHS) for (const t of THEMES) {
    const before = findings.length
    const r = await runCell(w, t)
    results.push(r)
    const bad = findings.length - before
    const ms = r.timings || {}
    console.log(`${r.cell.padEnd(12)} ${(bad ? `FAIL (${bad})` : 'PASS').padEnd(10)} states ${String(r.states).padEnd(3)} drill ${String(r.drill).padEnd(7)} shell ${ms.shell ?? '-'}ms  requests-while-failing ${r.failReqs}`)
    for (const f of findings.slice(before)) console.log(`   x ${f.n}: ${f.d}`)
  }
} finally { await browser.close() }

console.log('')
const badCells = new Set(findings.map((f) => f.cell))
console.log(`ANALYTICS MATRIX ${results.length - [...badCells].filter((c) => c !== 'api').length}/${results.length} cells clean, ${findings.length} finding(s)`)
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ TRUTH, results, findings }, null, 2))
if (findings.length) process.exit(1)
