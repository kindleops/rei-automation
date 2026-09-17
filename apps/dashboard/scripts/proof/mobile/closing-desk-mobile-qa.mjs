/**
 * CLOSING-DESK-MOBILE-LOCK-1 §45 — Closing Desk on mobile.
 *
 * READ ONLY (§43). Nothing here mutates a closing case. The destructive
 * scenarios (terminal cases, failed reads) are proved by the server invariant
 * suite and the projection unit tests against synthetic rows; the browser only
 * ever reads production.
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

const OUT = path.resolve('artifacts/closing-desk-mobile')
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

const api = async (p) => {
  const res = await fetch(`${BASE}${p}`, { headers: { 'x-ops-dashboard-secret': secret } })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** Canonical truth, service-side. Re-read per cell — never snapshot. */
const truth = async () => {
  const [cases, summary] = await Promise.all([
    api('/api/cockpit/closing-desk/cases?limit=200'),
    api('/api/cockpit/closing-desk/summary'),
  ])
  const d = summary.body?.data ?? {}
  return {
    casesStatus: cases.status,
    casesOk: cases.body?.ok,
    rows: Array.isArray(cases.body?.data) ? cases.body.data.length : null,
    counts: cases.body?.counts ?? null,
    provenance: cases.body?.provenance?.source ?? null,
    summaryStatus: summary.status,
    summaryOk: summary.body?.ok,
    metrics: Object.fromEntries(
      Object.entries(d).map(([k, v]) => [k, { v: v?.value ?? null, s: v?.source ?? null }]),
    ),
  }
}

const T0 = await truth()
console.log('\nCANONICAL TRUTH (service-side)')
console.log(`  cases     http ${T0.casesStatus} ok=${T0.casesOk} rows=${T0.rows} counts=${JSON.stringify(T0.counts)} source=${T0.provenance}`)
console.log(`  summary   http ${T0.summaryStatus} ok=${T0.summaryOk}`)
for (const [k, m] of Object.entries(T0.metrics)) {
  console.log(`    ${k.padEnd(30)} value=${JSON.stringify(m.v)} source=${m.s}`)
}

const findings = []
if (T0.casesStatus !== 200) findings.push({ cell: 'api', n: '§48 the cases endpoint must not fail', d: `http ${T0.casesStatus}` })
if (T0.casesOk === false) findings.push({ cell: 'api', n: '§48 cases envelope ok:false', d: JSON.stringify(T0.counts) })
if (T0.summaryStatus !== 200) findings.push({ cell: 'api', n: '§48 the summary endpoint must not fail', d: `http ${T0.summaryStatus}` })
if (T0.provenance && T0.provenance !== 'closing_cases') {
  findings.push({ cell: 'api', n: '§4 cases must be sourced from the canonical grain', d: `source=${T0.provenance}` })
}
// §37 — an absent authority must be null, never 0.
for (const [k, m] of Object.entries(T0.metrics)) {
  if (m.s === 'absent' && m.v !== null) {
    findings.push({ cell: 'api', n: `§37 ${k} is declared absent but carries a value`, d: `${m.v}` })
  }
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
  const cell = `${width}-${theme}`
  const check = (n, ok, d) => { if (!ok) findings.push({ cell, n, d }); return ok }
  const context = await browser.newContext({
    viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    timezoneId: 'America/Phoenix',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript(setTheme, theme)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))

  /** A read surface that never reads is the defect to assert, not its symptoms. */
  const reads = []
  page.on('request', (r) => {
    if (r.url().includes('/api/cockpit/closing-desk/')) reads.push(r.url().replace(BASE, ''))
  })

  await page.goto(`${BASE}/closing-desk`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('.cd-command-header', { timeout: 60_000 })

  /**
   * Settle on a STATED outcome, never on the absence of a word. The skeleton
   * and the loaded surface share container classes, so waiting for "not
   * loading" measured a half-built DOM in an earlier phase.
   */
  await page.waitForFunction(() => {
    if (document.querySelector('[data-testid="cd-loading"]')) return false
    if (document.querySelector('[data-testid="cd-error"]')) return true
    return !!document.querySelector('[data-testid="cd-metrics"]')
  }, undefined, { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(1200)

  // Re-read canonical truth INSIDE the cell — the desk is live and the matrix
  // takes minutes, so a snapshot taken before the first cell can go stale.
  const T = await truth()

  const p = await page.evaluate(() => {
    const txt = (s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null
    const pulse = [...document.querySelectorAll('.cd-pulse-metric')].map((el) => ({
      label: el.querySelector('.cd-pulse-metric__label')?.textContent?.trim() ?? null,
      value: el.querySelector('.cd-pulse-metric__value')?.textContent?.trim() ?? null,
    }))
    const kpis = [...document.querySelectorAll('[data-testid^="cd-metric-"]')].map((el) => ({
      key: el.getAttribute('data-testid').replace('cd-metric-', ''),
      value: el.querySelector('.cd-kpi__value, .cd-signal__value')?.textContent?.trim()
        ?? el.querySelector('[class*="value"]')?.textContent?.trim() ?? null,
      unknown: el.className.includes('is-unknown'),
    }))
    const body = (document.body.innerText || '').replace(/\s+/g, ' ')
    return {
      pill: txt('.cd-status-pill'),
      pulse,
      kpis,
      cards: document.querySelectorAll('[data-testid="cd-card"]').length,
      rows: document.querySelectorAll('[data-testid="cd-table-row"]').length,
      demoBanner: !!document.querySelector('[data-testid="cd-env-demo"]'),
      degradedBanner: !!document.querySelector('[data-testid="cd-env-degraded"]'),
      errorState: !!document.querySelector('[data-testid="cd-error"]'),
      loading: !!document.querySelector('[data-testid="cd-loading"]'),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      theme: document.documentElement.getAttribute('data-nexus-theme'),
      /**
       * Markers from closing-fixtures.ts. If any reach a live route, synthetic
       * transactions are being shown as real ones.
       */
      fixtureLeak: ['TC — Demo', 'Demo Title', 'DEMO DATA'].filter((n) => body.includes(n)),
      dockTop: (() => { const e = document.querySelector('.nx-pinned-app-dock'); return e ? Math.round(e.getBoundingClientRect().top) : null })(),
      body: body.slice(0, 700),
    }
  })

  const revenue = p.pulse.find((m) => /revenue/i.test(m.label ?? ''))?.value ?? null
  const truthRevenue = T.metrics.expected_revenue ?? { v: null, s: null }

  // ── §37/§48: absent revenue must render '—', NEVER '$0' ────────────────────
  if (truthRevenue.v === null) {
    check('§37 absent revenue must not render as $0',
      !/^\$0(\.00)?$/.test(String(revenue)),
      `canonical=null ui=${JSON.stringify(revenue)}`)
    check('§37 absent revenue must be visibly stated as unknown',
      revenue === '—' || revenue === '…',
      `ui=${JSON.stringify(revenue)}`)
  } else {
    check('§23 a real revenue figure must reach the header',
      revenue && revenue !== '—',
      `canonical=${truthRevenue.v} ui=${JSON.stringify(revenue)}`)
  }

  /**
   * §37 per-KPI: every card is compared against the authority behind it.
   *
   * Checking only the header missed that the KPI grid rendered "0" for metrics
   * the server explicitly reports as absent — the client was recomputing the
   * summary from an empty case list, which manufactures a zero for every field
   * and stamps it 'derived'. Zero IS data; absent is not zero.
   */
  const KPI_MAP = {
    under_contract: 'underContract',
    closings_this_week: 'closingsThisWeek',
    clear_to_close: 'clearToClose',
    title_blocked: 'titleBlocked',
    seller_action_required: 'sellerActionRequired',
    buyer_action_required: 'buyerActionRequired',
    emd_overdue: 'emdOverdue',
    expected_revenue: 'expectedRevenue',
    confirmed_revenue_this_month: 'confirmedRevenueThisMonth',
  }
  for (const [serverKey, uiKey] of Object.entries(KPI_MAP)) {
    const m = T.metrics[serverKey]
    const card = p.kpis.find((k) => k.key === uiKey)
    if (!m || !card) continue
    const shown = String(card.value ?? '')
    if (m.v === null || m.s === 'absent') {
      check(`§37 ${uiKey} is absent and must not render a number`,
        shown === '—' || shown === '…' || card.unknown,
        `canonical=${JSON.stringify(m.v)} source=${m.s} ui=${JSON.stringify(card.value)}`)
    } else {
      const uiNum = Number(shown.replace(/[$,]/g, ''))
      check(`§37 ${uiKey} matches the authority`,
        Number.isFinite(uiNum) && Math.round(uiNum) === Math.round(m.v),
        `canonical=${m.v} ui=${JSON.stringify(card.value)}`)
    }
  }

  // ── §31: a terminated case must never be rendered as active work ───────────
  const activeTruth = T.counts?.active ?? null
  if (activeTruth !== null) {
    check('§31 rendered case count matches the ACTIVE cohort',
      p.cards === activeTruth || p.rows === activeTruth || (activeTruth === 0 && p.cards === 0 && p.rows === 0),
      `canonical active=${activeTruth} terminated=${T.counts?.terminated} cards=${p.cards} rows=${p.rows}`)
  }

  // ── no synthetic transactions on a live route ──────────────────────────────
  check('§2 no fixture data on the live route', p.fixtureLeak.length === 0, p.fixtureLeak.join(','))
  check('§2 no demo banner on the live route', !p.demoBanner, 'demo banner present')

  // ── the surface must actually read the canonical authority ─────────────────
  check('the desk issues a canonical closing-desk read', reads.length > 0, `requests=${reads.length}`)

  // ── a zero desk must say WHY, and must not be confusable with an outage ────
  if (activeTruth === 0) {
    check('§48 an empty desk states its emptiness',
      /zero|no deals|no closing/i.test(p.body) || /zero/i.test(p.pill ?? ''),
      `pill=${p.pill}`)
    check('§48 an empty desk is not presented as an error',
      !p.errorState, 'error state rendered for a genuinely empty desk')
  }

  // ── mobile layout ──────────────────────────────────────────────────────────
  check('§45 no horizontal overflow', p.overflow === 0, `overflow=${p.overflow}px`)
  check('§45 the surface finished loading', !p.loading, 'still rendering the skeleton')
  check('§45 theme applied', p.theme === theme, `wanted=${theme} got=${p.theme}`)
  check('§45 no page errors', errors.length === 0, errors.join(' | '))

  /**
   * Controls are measured AFTER scrolling — but scroll the RIGHT container.
   *
   * The first version did `window.scrollTo(0, document.body.scrollHeight)` and
   * reported this control unreachable at every width. That was the harness, not
   * the product: the fullscreen shell pins `body` to the viewport (docH ===
   * viewportH === 844, scrollY stayed 0), so the window scroll was a no-op and
   * the control sat at y=1659 — outside the viewport, where elementFromPoint
   * returns null. A null hit is "nothing is there to test", which is not the
   * same finding as "something is covering it".
   *
   * scrollIntoView lets the browser resolve which ancestor must move, and the
   * assertion below refuses to run until the element is genuinely in view.
   */
  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="cd-diagnostics-btn"]')
    if (!el) return { present: false }
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    return { present: true }
  })
  if (after.present) {
    await page.waitForTimeout(400)
    const m = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cd-diagnostics-btn"]')
      const b = el.getBoundingClientRect()
      const cx = Math.round(b.left + b.width / 2)
      const cy = Math.round(b.top + b.height / 2)
      const inViewport = b.top >= 0 && b.bottom <= window.innerHeight && b.width > 0
      const hit = inViewport ? document.elementFromPoint(cx, cy) : null
      return {
        inViewport,
        h: Math.round(b.height),
        reachable: !!(hit && (hit === el || el.contains(hit))),
        covering: hit && !(hit === el || el.contains(hit))
          ? `${hit.tagName.toLowerCase()}.${(hit.className || '').toString().slice(0, 40)}`
          : null,
      }
    })
    // Guard the measurement itself: an off-screen control cannot be hit-tested,
    // and reporting that as "unreachable" is a false positive.
    if (check('§45 the diagnostics control can be brought into view', m.inViewport, JSON.stringify(m))) {
      check('§45 the diagnostics control is reachable, nothing covering it',
        m.reachable, m.covering ? `covered by ${m.covering}` : JSON.stringify(m))
      check('§45 the diagnostics control meets the touch target', (m.h ?? 0) >= 40, `h=${m.h}`)
    }
  }

  await page.screenshot({ path: path.join(OUT, `closing-desk-${cell}.png`), fullPage: false })
  console.log(`\n${cell}  pill=${JSON.stringify(p.pill)} overflow=${p.overflow} cards=${p.cards} rows=${p.rows} reads=${reads.length}`)
  console.log(`  pulse   ${p.pulse.map((m) => `${m.label}=${m.value}`).join('  ')}`)
  console.log(`  kpis    ${p.kpis.map((k) => `${k.key}=${k.value}${k.unknown ? '(unknown)' : ''}`).join('  ')}`)

  await context.close()
  return { cell, p, T, reads: reads.length, errors }
}

const cells = []
for (const w of WIDTHS) for (const t of THEMES) cells.push(await runCell(w, t))
await browser.close()

await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ truth: T0, cells, findings }, null, 2))

console.log('\n' + '─'.repeat(72))
if (findings.length === 0) {
  console.log(`PASS — ${cells.length} cells, 0 findings`)
} else {
  console.log(`FAIL — ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  [${f.cell}] ${f.n}\n      ${f.d}`)
}
process.exit(findings.length === 0 ? 0 : 1)
