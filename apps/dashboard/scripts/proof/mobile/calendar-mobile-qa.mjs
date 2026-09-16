/**
 * CALENDAR-MOBILE-LOCK-1 §40 — Calendar on mobile.
 *
 * READ ONLY (§41). Nothing here reschedules, cancels or completes real seller
 * work: the detail sheet is opened and inspected, and no mutating control is
 * ever clicked.
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

const OUT = path.resolve('artifacts/calendar-mobile')
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

const TZ = 'America/Phoenix'
const dayKey = (d, tz = TZ) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d)

const iso = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString()
}

const api = async (qs) => {
  const res = await fetch(`${BASE}/api/cockpit/calendar/events?${qs}`, {
    headers: { 'x-ops-dashboard-secret': secret },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

// ── canonical truth, service-side
const wide = await api(new URLSearchParams({
  start_date: iso(-30), end_date: iso(30), timezone: TZ,
}).toString())

const events = wide.body?.events ?? []
const kpi = (id) => wide.body?.kpis?.find((k) => k.id === id)?.value ?? null
const todayK = dayKey(new Date())

const TRUTH = {
  status: wide.status,
  total: events.length,
  dueToday: kpi('due-today'),
  overdue: kpi('overdue'),
  actionable: wide.body?.actionable_counts?.actionable ?? null,
  notActionable: wide.body?.actionable_counts?.not_actionable ?? null,
  tzApplied: wide.body?.timezone?.applied ?? null,
  layersAvailable: Object.entries(wide.body?.layer_availability ?? {}).filter(([, v]) => v.available).map(([k]) => k),
  layersDead: Object.entries(wide.body?.layer_availability ?? {}).filter(([, v]) => !v.available).map(([k]) => k),
  // §6 two real subjects with scheduled work
  subjects: [...new Map(events.filter((e) => e.property_id && e.master_owner_id && e.seller_name && !/unresolved/i.test(e.seller_name))
    .map((e) => [e.property_id, { propertyId: e.property_id, ownerId: e.master_owner_id, seller: e.seller_name, address: e.property_address }]))
    .values()].slice(0, 2),
}

console.log('\nCANONICAL TRUTH (service-side)')
console.log(`  events        http ${TRUTH.status}  total=${TRUTH.total} actionable=${TRUTH.actionable} not_actionable=${TRUTH.notActionable}`)
console.log(`  kpis          due_today=${TRUTH.dueToday} overdue=${TRUTH.overdue}  tz=${TRUTH.tzApplied}`)
console.log(`  layers        available=${TRUTH.layersAvailable.join(',')}`)
console.log(`  layers        no authority=${TRUTH.layersDead.join(',')}`)
for (const s of TRUTH.subjects) console.log(`  subject       ${s.propertyId} ${s.seller} · ${s.address}`)

const findings = []
if (wide.status !== 200) findings.push({ cell: 'api', n: '§45 the calendar API must not fail', d: `http ${wide.status}` })
if (wide.body?.ok === false) findings.push({ cell: 'api', n: '§45 envelope ok:false', d: JSON.stringify(wide.body).slice(0, 160) })
if (TRUTH.subjects.length < 2) findings.push({ cell: 'api', n: '§6 needs two resolvable subjects with scheduled work', d: `${TRUTH.subjects.length} found` })

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
    timezoneId: TZ,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript(setTheme, theme)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))
  const calRequests = []
  page.on('request', (r) => {
    if (r.url().includes('/api/cockpit/calendar/events')) calRequests.push(r.url())
  })

  const timings = {}
  const mark = async (name, fn) => { const t0 = Date.now(); await fn(); timings[name] = Date.now() - t0 }

  await mark('shell', async () => {
    await page.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForSelector('.nx-cal__mobile', { timeout: 60_000 })
  })

  /**
   * Wait for the load to SETTLE before probing.
   *
   * With a fixed 5s delay the agenda row count alternated 13 / 0 / 0 / 13
   * across cells, which meant the §22 detail assertion was silently skipped in
   * half of them — a check that quietly does nothing is worse than no check.
   */
  /**
   * "Not updating" is NOT "loaded".
   *
   * Waiting only for the absence of "Updating" returned before the events
   * arrived, so the agenda measured 0 rows in cells where it actually renders
   * 13 — and the §22 detail assertion was skipped on that false empty. Settle
   * means the surface has reached a STATED outcome: a count, an explicit
   * empty, or an error panel.
   */
  const settle = async (target) => {
    await target.waitForFunction(
      () => {
        const head = document.querySelector('.nx-cal__mobile-head')?.textContent || ''
        // The surface states "Loading schedule…" until it knows something.
        if (/updating|loading/i.test(head)) return false
        if (document.querySelector('.nx-cal__mobile-error')) return true
        if (document.querySelector('.nx-cal__mobile-empty')) return true
        if (document.querySelectorAll('.nx-cal__agenda-row').length > 0) return true
        // A stated count (including a real zero) is a settled outcome.
        return /\d+\s+(events\s+)?in range|unavailable|fallback/i.test(head)
      },
      undefined, { timeout: 30_000 },
    ).catch(() => {})
    await target.waitForTimeout(1500)
  }
  await settle(page)

  const probe = () => page.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? null
    return {
      mobileSurface: document.querySelectorAll('.nx-cal__mobile').length,
      head: txt('.nx-cal__mobile-head'),
      dayStrip: document.querySelectorAll('.nx-cal__mobile-day').length,
      selectedDay: txt('.nx-cal__mobile-day.is-selected'),
      todayMarked: document.querySelectorAll('.nx-cal__mobile-day.is-today').length,
      agendaRows: document.querySelectorAll('.nx-cal__agenda-row').length,
      agendaTitles: [...document.querySelectorAll('.nx-cal__agenda-main')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).slice(0, 6),
      overdueRows: document.querySelectorAll('.nx-cal__agenda-row.is-overdue').length,
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      theme: document.documentElement.getAttribute('data-nexus-theme'),
      // §3 — proof fixtures must never appear without the query flag
      proofLeak: (document.body.innerText || '').includes('Jane Seller') ||
                 (document.body.innerText || '').includes('1550 E Emelita'),
      fab: (() => {
        const el = document.querySelector('.nx-cal__mobile-fab')
        if (!el) return { present: false }
        const b = el.getBoundingClientRect()
        const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
        return { present: true, h: Math.round(b.height), bottom: Math.round(b.bottom), reachable: !!(hit && (hit === el || el.contains(hit))) }
      })(),
      monthBtn: (() => {
        const el = [...document.querySelectorAll('.nx-cal__cmd-btn')].find((b) => /month/i.test(b.textContent || ''))
        if (!el) return { present: false }
        const b = el.getBoundingClientRect()
        const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
        return { present: true, reachable: !!(hit && (hit === el || el.contains(hit))) }
      })(),
      dayReach: (() => {
        const el = document.querySelector('.nx-cal__mobile-day')
        if (!el) return { present: false }
        const b = el.getBoundingClientRect()
        const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
        return { present: true, h: Math.round(b.height), reachable: !!(hit && (hit === el || el.contains(hit))) }
      })(),
      dock: (() => { const e = document.querySelector('.nx-pinned-app-dock'); return e ? Math.round(e.getBoundingClientRect().top) : null })(),
      deadLayerButtons: [...document.querySelectorAll('button, [role="tab"]')]
        .map((b) => (b.textContent || '').trim().toLowerCase())
        .filter((t) => ['offers', 'contracts', 'closings', 'buyers', 'appointments', 'title'].includes(t)),
    }
  })

  const p = await probe()
  check('the mobile calendar surface renders', p.mobileSurface === 1, `${p.mobileSurface}`)
  check('theme applied', p.theme === theme, `${p.theme}`)
  check('no page-wide horizontal overflow', p.overflow === 0, `${p.overflow}px`)
  check('§3 no proof fixtures leak without ?calendar_proof', p.proofLeak === false, 'found fixture seller/address on screen')
  check('§39 the day strip is present and reachable',
    p.dayStrip >= 7 && p.dayReach?.reachable, `${p.dayStrip} days, reach=${JSON.stringify(p.dayReach)}`)
  check('§39 today is marked in the day strip', p.todayMarked >= 1, `${p.todayMarked}`)
  check('§39 the month control is reachable', p.monthBtn?.present && p.monthBtn?.reachable, JSON.stringify(p.monthBtn))
  check('§39 the new-event control is reachable', p.fab?.present && p.fab?.reachable, JSON.stringify(p.fab))
  check('§39 the new-event control clears the bottom dock',
    p.dock === null || p.fab?.bottom == null || p.fab.bottom <= p.dock,
    `fab bottom=${p.fab?.bottom} dock top=${p.dock}`)
  check('§28 no filter offered for an authority that does not exist',
    p.deadLayerButtons.length === 0, p.deadLayerButtons.join(', ') || 'none')
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-today.png`) })

  // ── §29 the surface must not claim a count it cannot back
  const rangeApi = await api(new URLSearchParams({ start_date: iso(-1), end_date: iso(1), timezone: TZ }).toString())
  check('§29/§45 the calendar API does not fail for the rendered range',
    rangeApi.status === 200 && rangeApi.body?.ok !== false, `http ${rangeApi.status}`)

  // ── §22 item detail
  if (p.agendaRows > 0) {
    await page.locator('.nx-cal__agenda-row').first().click()
    await page.waitForTimeout(1600)
    const detail = await page.evaluate(() => {
      const root = document.querySelector('[class*="execution-drawer"], [class*="nx-cal__drawer"], [role="dialog"]')
      return {
        open: Boolean(root),
        text: root ? root.textContent.replace(/\s+/g, ' ').trim().slice(0, 400) : null,
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      }
    })
    check('§22 tapping an item opens a detail surface', detail.open === true, `open=${detail.open}`)
    if (detail.open) {
      check('§22 the detail states what and when',
        /\d/.test(detail.text || ''), `"${String(detail.text).slice(0, 100)}"`)
      check('§22 no overflow with the detail open', detail.overflow === 0, `${detail.overflow}px`)
    }
    await page.screenshot({ path: path.join(OUT, `${width}-${theme}-detail.png`) })
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(500)
  } else {
    // Reaching here is legitimate only when the range genuinely has no items.
    check('§30 an empty agenda explains itself rather than showing nothing',
      /no |nothing |empty|clear/i.test(p.bodyText), `"${p.bodyText.slice(0, 120)}"`)
    check('§30 an empty agenda is not hiding a load that never settled',
      !/updating/i.test(p.head || ''), `head="${p.head}"`)
  }

  // ── §5/§6 subject A -> B
  if (TRUTH.subjects.length >= 2) {
    const openSubject = async (s) => {
      await page.goto(`${BASE}/calendar?property_id=${encodeURIComponent(s.propertyId)}`, {
        waitUntil: 'domcontentloaded', timeout: 120_000,
      })
      await page.waitForSelector('.nx-cal__mobile', { timeout: 60_000 })
      await settle(page)
      return page.evaluate(() => ({
        text: (document.body.innerText || '').replace(/\s+/g, ' '),
        rows: document.querySelectorAll('.nx-cal__agenda-row').length,
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      }))
    }
    const [A, B] = TRUTH.subjects
    const a = await openSubject(A)
    const b = await openSubject(B)
    const nameOf = (s) => String(s.seller).split(/\s+/)[0]
    check('§6 switching subject changes what is shown',
      a.text !== b.text || a.rows !== b.rows,
      `A rows=${a.rows} B rows=${b.rows}`)
    check("§6 subject B does not show subject A's seller",
      !(b.text.includes(nameOf(A)) && nameOf(A) !== nameOf(B)),
      `A="${nameOf(A)}" leaked into B`)
    check('no overflow with a subject applied', a.overflow === 0 && b.overflow === 0, `${a.overflow}/${b.overflow}`)
    await page.screenshot({ path: path.join(OUT, `${width}-${theme}-subject.png`) })
  }

  // ── §30 a failed read must not look like an empty calendar
  /**
   * Count requests only while the failure is being served. The earlier
   * aggregate counted every navigation in the cell and printed a meaningless
   * four-figure number; measured directly the app issues ~9 and does not
   * retry in a loop, which is what actually matters here (§42).
   */
  /**
   * Count requests for THIS navigation only, in a fresh context.
   *
   * Counting inside the shared page accumulated across every navigation the
   * cell had already performed (today, detail, subject A, subject B) with the
   * route installed mid-flight, and reported a meaningless four-figure number.
   * Measured in isolation the app issues 4-9 requests in every
   * subject/success/failure combination and does not retry in a loop, so the
   * count has to be scoped the same way to mean anything (§42).
   */
  const failCtx = await browser.newContext({
    viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    timezoneId: TZ,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await failCtx.addInitScript(setTheme, theme)
  const failPage = await failCtx.newPage()
  let failedRequests = 0
  await failPage.route('**/api/cockpit/calendar/events**', (route) => {
    failedRequests += 1
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'calendar_events_fetch_failed' }) })
  })
  await failPage.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await failPage.waitForSelector('.nx-cal__mobile', { timeout: 60_000 }).catch(() => {})
  /**
   * Wait for STEADY STATE, not a fixed delay.
   *
   * When the canonical read fails the surface falls back to a slower
   * client-side path, so for several seconds it legitimately shows "Updating".
   * A fixed 6s probe caught that transient and reported it as "no error
   * shown" — and a 9s probe caught two different intermediate states on
   * consecutive runs. The assertion has to be made once the load settles.
   */
  await settle(failPage)
  const failed = await failPage.evaluate(() => ({
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
    rows: document.querySelectorAll('.nx-cal__agenda-row').length,
    errorPanels: document.querySelectorAll('.nx-cal__mobile-error').length,
    panelText: document.querySelector('.nx-cal__mobile-error')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
  }))
  /**
   * §30/§45 — the requirement is that a failed canonical read is never
   * presented as truth. It is NOT that the screen must be empty: the client
   * fallback reads Supabase directly and can return genuine events, so the
   * surface may legitimately show data while stating the live schedule is
   * unavailable. What must never happen is silence.
   */
  check('§30/§45 an API failure is stated, never presented as a normal calendar',
    failed.errorPanels > 0 && /couldn|could not|unavailable/i.test(failed.text),
    `rows=${failed.rows} panels=${failed.errorPanels} text="${failed.text.slice(0, 160)}"`)
  check('§30 the surface distinguishes a fallback view from the live schedule',
    failed.rows === 0
      ? /nothing could be read|not an empty day/i.test(failed.panelText || '')
      : /fallback/i.test(failed.panelText || ''),
    `rows=${failed.rows} panel="${String(failed.panelText).slice(0, 200)}"`)
  check('§29 a read that returned nothing claims no count',
    failed.rows > 0 || !/\b\d+ events in range\b/.test(failed.text),
    `text="${failed.text.slice(0, 120)}"`)
  check('§42 a failing calendar does not retry in an unbounded loop',
    failedRequests > 0 && failedRequests < 40, `${failedRequests} requests while failing`)
  await failPage.screenshot({ path: path.join(OUT, `${width}-${theme}-error.png`) })
  await failCtx.close()

  for (const [step, budget] of [['shell', 15000]]) {
    if (timings[step] === undefined) continue
    check(`§42 ${step} responds within budget`, timings[step] < budget, `${timings[step]}ms`)
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

  await context.close()
  return { cell: `${width}-${theme}`, rows: p.agendaRows, timings, failedRequests }
}

const results = []
try {
  for (const w of WIDTHS) for (const t of THEMES) {
    const before = findings.length
    const r = await runCell(w, t)
    results.push(r)
    const bad = findings.length - before
    const ms = r.timings || {}
    console.log(`${r.cell.padEnd(12)} ${(bad ? `FAIL (${bad})` : 'PASS').padEnd(10)} agenda ${String(r.rows).padEnd(4)} shell ${ms.shell ?? '-'}ms  requests-while-failing ${r.failedRequests}`)
    for (const f of findings.slice(before)) console.log(`   x ${f.n}: ${f.d}`)
  }
} finally { await browser.close() }

console.log('')
const badCells = new Set(findings.map((f) => f.cell))
console.log(`CALENDAR MATRIX ${results.length - [...badCells].filter((c) => c !== 'api').length}/${results.length} cells clean, ${findings.length} finding(s)`)
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ TRUTH, results, findings }, null, 2))
if (findings.length) process.exit(1)
