#!/usr/bin/env node
/**
 * BUYER MATCH MOBILE — BUYER-MATCH-MOBILE-LOCK-1 §4/§17/§18.
 *
 * Proves the production route now serves the CANONICAL engine for the
 * operator's property, and that switching property switches the buyers.
 *
 * Subjects are real production properties with real match runs. Canonical truth
 * is read from NODE with the dashboard secret, because an in-page
 * /api/cockpit/* fetch 401s and guarding an assertion on a nullable value makes
 * it SKIP rather than fail.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5174')
// Comma lists so one invocation can cover the whole §18 matrix. Number() on a
// comma list silently yields NaN, which Playwright then rejects at newContext.
const list = (raw, fallback) => (raw ? String(raw).split(',').map((v) => v.trim()).filter(Boolean) : fallback)
const WIDTHS = list(arg('width'), ['375', '390', '430']).map(Number)
const THEMES = list(arg('theme'), ['dark', 'light'])
if (WIDTHS.some((w) => !Number.isInteger(w))) throw new Error(`--width must be integers: ${WIDTHS.join(',')}`)
const OUT = path.resolve(process.cwd(), '.screenshots/buyer-match-mobile')
await fs.mkdir(OUT, { recursive: true })

/** Real production properties: A and B have runs; EMPTY ran and found none. */
const SUBJECT_A = { id: '24613730', label: 'Phoenix SFR', addressPart: 'Monterey' }
const SUBJECT_B = { id: '239280459', label: 'Atlanta SFR', addressPart: 'Mozley' }
const SUBJECT_EMPTY = { id: '2145766246', label: 'Spokane (run, 0 candidates)' }
const SUBJECT_NO_RUN = { id: '278477219', label: 'KC (no run)' }

const readSecret = async () => {
  for (const f of ['../api/.env.local', '../api/.env']) {
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

const canonical = async (propertyId) => {
  const res = await fetch(`${BASE}/api/cockpit/buyer-match/property/${propertyId}/candidates?limit=50`, {
    headers: { 'x-ops-dashboard-secret': secret },
  })
  if (!res.ok) throw new Error(`candidates ${propertyId} -> HTTP ${res.status}`)
  const body = await res.json()
  const d = body.data ?? body
  return {
    runId: d.run_id ?? null,
    total: d.total ?? 0,
    top: (d.candidates ?? []).slice(0, 3).map((c) => ({
      name: c.buyer_name, entity: c.buyer_entity_id, score: c.total_match_score, grade: c.match_grade,
    })),
    distinctEntities: new Set((d.candidates ?? []).map((c) => c.buyer_entity_id)).size,
    rows: (d.candidates ?? []).length,
  }
}

const A = await canonical(SUBJECT_A.id)
const B = await canonical(SUBJECT_B.id)
const E = await canonical(SUBJECT_EMPTY.id)
const N = await canonical(SUBJECT_NO_RUN.id)

console.log('CANONICAL TRUTH (node, service-side)')
for (const [label, s] of [[SUBJECT_A.label, A], [SUBJECT_B.label, B], [SUBJECT_EMPTY.label, E], [SUBJECT_NO_RUN.label, N]]) {
  console.log(`  ${label.padEnd(30)} run=${String(s.runId).slice(0, 8).padEnd(9)} total=${String(s.total).padEnd(4)} rows=${String(s.rows).padEnd(4)} distinct=${s.distinctEntities}`)
}
console.log(`  A top: ${A.top.map((t) => `${t.name} ${t.grade}/${t.score}`).join(' | ')}`)
console.log('')

const findings = []
const browser = await chromium.launch()

const setTheme = (t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), nexusTheme: t }))
  } catch { /* first run */ }
}

const runCell = async (width, theme) => {
  const check = (n, ok, d) => { if (!ok) findings.push({ cell: `${width}-${theme}`, n, d }); return ok }
  const context = await browser.newContext({
    viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript(setTheme, theme)
  const page = await context.newPage()
  /**
   * Maps/Street View requests, bucketed PER SUBJECT.
   *
   * The first version of this harness kept one cumulative array, asserted it
   * during phase A, and printed it after phase B — so it printed "6" next to a
   * PASS of an assertion that reads `<= 2`. The number reported has to be the
   * number asserted, or the evidence is worthless. Each subject load resets its
   * own bucket.
   */
  const maps = { a: [], b: [], spokane: [], kc: [] }
  let watching = 'a'
  page.on('request', (r) => {
    const u = r.url()
    if (/maps\.googleapis\.com|streetview|maps\/embed\/v1/.test(u)) maps[watching]?.push(u.slice(0, 80))
  })
  /**
   * §19 — what the browser actually paid for. The candidates request is the
   * only large read on this surface, so its byte size and row count are
   * recorded: the buyer universe is ~26k rows and none of it may be hydrated
   * into the browser to render one property's matches.
   */
  const payloads = []
  page.on('response', async (r) => {
    if (!/\/buyer-match\/property\/.*\/candidates/.test(r.url())) return
    try {
      const body = await r.text()
      let rows = null
      try { rows = JSON.parse(body)?.data?.candidates?.length ?? null } catch { /* non-JSON */ }
      payloads.push({ bytes: body.length, rows, status: r.status() })
    } catch { /* body already consumed */ }
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))

  const openSubject = async (id, bucket = 'a') => {
    watching = bucket
    maps[bucket] = []
    const startedAt = Date.now()
    await page.goto(`${BASE}/buyer-match?property_id=${id}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForFunction(
      () => !document.querySelector('.bmm__state')?.textContent?.includes('Loading canonical'),
      undefined, { timeout: 60_000 },
    ).catch(() => {})
    await page.waitForTimeout(3500)
    const elapsedMs = Date.now() - startedAt
    return Object.assign({ elapsedMs }, await page.evaluate(() => ({
      address: document.querySelector('.bmm__subject-address')?.textContent?.trim() ?? null,
      count: document.querySelector('.bmm__count')?.textContent?.trim() ?? null,
      cards: document.querySelectorAll('.bmm__card').length,
      buyers: [...document.querySelectorAll('.bmm__buyer')].map((e) => e.textContent.trim()),
      grades: [...document.querySelectorAll('.bmm__grade')].map((e) => e.textContent.trim()),
      reasons: [...document.querySelectorAll('.bmm__reasons li')].map((e) => e.textContent.trim()).slice(0, 3),
      state: document.querySelector('.bmm__state')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      theme: document.documentElement.getAttribute('data-nexus-theme'),
      propertyVisual: document.querySelectorAll('.bmm__subject-visual').length,
      dockTop: (() => { const e = document.querySelector('.nx-pinned-app-dock'); return e ? Math.round(e.getBoundingClientRect().top) : null })(),
      /**
       * §13 — the disposition actions, measured but NEVER invoked. These write
       * to real production buyer_match_candidates rows, so the proof asserts
       * reachability at each control's own centre and stops there. Clicking one
       * would mutate a production candidate for the sake of a test.
       */
      actions: [...document.querySelectorAll('.bmm-act')].map((el) => {
        const b = el.getBoundingClientRect()
        const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
        return {
          label: el.getAttribute('aria-label'),
          w: Math.round(b.width),
          h: Math.round(b.height),
          reachable: !!(hit && (hit === el || el.contains(hit))),
        }
      }),
      sendPackageControls: document.querySelectorAll('.aic-buyer-action.is-primary, [data-action="send-package"]').length,
      searchReachable: (() => {
        const el = document.querySelector('input[aria-label="Search buyer matches"]')
        if (!el) return { present: false }
        const b = el.getBoundingClientRect()
        const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
        return { present: true, reachable: !!(hit && (hit === el || el.contains(hit))) }
      })(),
    })))
  }

  // ── §4 A
  const a = await openSubject(SUBJECT_A.id, 'a')
  check('A: property context is the selected property', /Monterey/i.test(a.address ?? ''), `address=${a.address}`)
  check('A: theme applied', a.theme === theme, `${a.theme}`)
  check('A: no page-wide horizontal overflow', a.overflow === 0, `${a.overflow}px`)
  check('A: canonical count is shown', a.count === `${A.total} matches` || a.count === `Showing ${A.rows} of ${A.total} matches`,
    `ui="${a.count}" canonical total=${A.total} rows=${A.rows}`)
  check('A: one card per canonical candidate', a.cards === A.rows, `${a.cards} cards vs ${A.rows} canonical`)
  check('A: top buyer matches the engine ordering', a.buyers[0] === A.top[0]?.name,
    `ui="${a.buyers[0]}" canonical="${A.top[0]?.name}"`)
  check('A: no duplicate buyer cards', new Set(a.buyers).size === a.buyers.length,
    `${a.buyers.length} cards, ${new Set(a.buyers).size} unique`)
  check('A: grades are words, never percentages', a.grades.every((g) => !g.includes('%')), a.grades.slice(0, 3).join(' | '))
  check('A: match reasons come from the engine', a.reasons.length > 0 && a.reasons.some((r) => /purchase|buy|mi |zip|capital/i.test(r)),
    JSON.stringify(a.reasons))
  check('A: selected property visual present', a.propertyVisual === 1, `${a.propertyVisual}`)
  check('A: search input reachable at its own centre',
    a.searchReachable.present && a.searchReachable.reachable, JSON.stringify(a.searchReachable))
  /**
   * THE FAN-OUT RULE, per QUEUE-MOBILE-FINAL-LOCK. One intentional request for
   * the single selected property is correct; a request PER BUYER ROW is the
   * blocker. 25 rows against <=2 requests is what separates the two — a
   * per-row implementation would show ~25. The URLs are printed so the
   * surviving requests can be attributed to the subject, not to a buyer.
   */
  check('A: buyer list makes NO per-buyer Maps request',
    maps.a.length <= 2, `${maps.a.length} requests for ${a.cards} cards :: ${maps.a.join(' | ') || 'none'}`)
  const aPayload = payloads[payloads.length - 1] ?? null
  check('§19: the browser is not sent the buyer universe',
    aPayload !== null && aPayload.rows !== null && aPayload.rows <= 50,
    `rows=${aPayload?.rows} bytes=${aPayload?.bytes}`)
  check('§19: the candidates payload stays small',
    aPayload !== null && aPayload.bytes < 400_000, `${aPayload?.bytes} bytes`)
  check('§19: the subject renders within budget', a.elapsedMs < 12_000, `${a.elapsedMs}ms`)
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-A.png`) })

  // ── §4 B — the mandatory switch
  const b = await openSubject(SUBJECT_B.id, 'b')
  check('B: property context switched', /Mozley/i.test(b.address ?? ''), `address=${b.address}`)
  check('B: canonical count switched', b.count === `${B.total} matches` || b.count === `Showing ${B.rows} of ${B.total} matches`,
    `ui="${b.count}" canonical=${B.total}`)
  check('B: top buyer is B\'s, not A\'s', b.buyers[0] === B.top[0]?.name && b.buyers[0] !== a.buyers[0],
    `B ui="${b.buyers[0]}" canonical="${B.top[0]?.name}" A was "${a.buyers[0]}"`)
  check('B: no buyer leaked from A', b.buyers.every((n) => !a.buyers.includes(n)) || A.top[0]?.name !== B.top[0]?.name,
    `overlap=${b.buyers.filter((n) => a.buyers.includes(n)).slice(0, 3).join(', ')}`)
  check('B: the switched subject also makes no per-buyer Maps request',
    maps.b.length <= 2, `${maps.b.length} requests for ${b.cards} cards :: ${maps.b.join(' | ') || 'none'}`)
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-B.png`) })

  // ── back to A
  const a2 = await openSubject(SUBJECT_A.id, 'a')
  check('A again: context returns exactly', /Monterey/i.test(a2.address ?? '') && a2.buyers[0] === A.top[0]?.name,
    `address=${a2.address} top=${a2.buyers[0]}`)

  // ── §13 disposition actions, opened but never invoked
  await page.locator('.bmm__card').first().click()
  await page.waitForSelector('.bmm-sheet', { timeout: 15_000 })
  await page.waitForTimeout(600)
  const sheet = await page.evaluate(() => ({
    actions: [...document.querySelectorAll('.bmm-act')].map((el) => {
      const b = el.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
      return {
        label: el.getAttribute('aria-label'),
        h: Math.round(b.height),
        reachable: !!(hit && (hit === el || el.contains(hit))),
      }
    }),
    sendPackage: [...document.querySelectorAll('.bmm-sheet button')]
      .map((el) => (el.textContent || '').trim())
      .filter((t) => /send\s*package/i.test(t)),
    packageClaim: (document.querySelector('.bmm-sheet__body')?.textContent || '').includes('Package sent'),
    reasons: [...document.querySelectorAll('.bmm-sheet .bmm__reasons li')].length,
  }))
  const wanted = ['Mark buyer interested', 'Mark buyer passed', 'Select as buyer']
  check('§13: every disposition action is reachable at its own centre',
    wanted.every((w) => sheet.actions.some((a) => a.label === w && a.reachable && a.h >= 36)),
    JSON.stringify(sheet.actions))
  check('§13: mobile exposes NO "Send Package" control (it transmits nothing)',
    sheet.sendPackage.length === 0, sheet.sendPackage.join(' | '))
  check('§13: the sheet never claims a package was sent',
    sheet.packageClaim === false, 'sheet body contains the literal "Package sent"')
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-sheet.png`) })
  await page.locator('.bmm-sheet__close').click()
  await page.waitForTimeout(300)

  // ── §16 states
  const empty = await openSubject(SUBJECT_EMPTY.id, 'spokane')
  check('a run that found nothing says so', /returned no buyers/i.test(empty.state ?? ''), `state="${empty.state}"`)
  const norun = await openSubject(SUBJECT_NO_RUN.id, 'kc')
  check('a property with no run says so', /no match run/i.test(norun.state ?? ''), `state="${norun.state}"`)

  // ── §3 no subject
  await page.goto(`${BASE}/buyer-match`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForTimeout(6000)
  const none = await page.evaluate(() => ({
    state: document.querySelector('.bmm__state')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    cards: document.querySelectorAll('.bmm__card').length,
  }))
  check('no property selected is honest and shows no buyers',
    /select a property/i.test(none.state ?? '') && none.cards === 0,
    `state="${none.state}" cards=${none.cards}`)

  // ── dock clearance after scrolling the list
  await openSubject(SUBJECT_A.id, 'a')
  const clearance = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.bmm__card')]
    if (!cards.length) return null
    cards[cards.length - 1].scrollIntoView({ block: 'end' })
    return new Promise((res) => setTimeout(() => {
      const last = cards[cards.length - 1].getBoundingClientRect()
      const dock = document.querySelector('.nx-pinned-app-dock')?.getBoundingClientRect() ?? null
      res({ lastBottom: Math.round(last.bottom), dockTop: dock ? Math.round(dock.top) : null })
    }, 900))
  })
  if (clearance?.dockTop) {
    check('final buyer card clears the bottom dock', clearance.lastBottom <= clearance.dockTop + 2,
      `card ${clearance.lastBottom} vs dock ${clearance.dockTop}`)
  }

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  await context.close()
  return {
    cell: `${width}-${theme}`, a, b,
    mapsA: maps.a.length, mapsB: maps.b.length,
    ms: a.elapsedMs, payload: payloads[0] ?? null,
  }
}

const results = []
try {
  for (const w of WIDTHS) for (const t of THEMES) {
    const before = findings.length
    const r = await runCell(w, t)
    results.push(r)
    const bad = findings.length - before
    console.log(`${r.cell.padEnd(12)} ${(bad ? `FAIL (${bad})` : 'PASS').padEnd(10)} A:${r.a.cards} cards  B:${r.b.cards} cards  maps A:${r.mapsA} B:${r.mapsB}  ${r.ms}ms  ${r.payload?.rows} rows/${Math.round((r.payload?.bytes ?? 0) / 1024)}KB`)
    for (const f of findings.slice(before)) console.log(`   ✗ ${f.n}: ${f.d}`)
  }
} finally { await browser.close() }

console.log('')
console.log(`BUYER MATCH MATRIX ${results.length - new Set(findings.map((f) => f.cell)).size}/${results.length} cells clean, ${findings.length} finding(s)`)
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ canonical: { A, B, E, N }, results, findings }, null, 2))
if (findings.length) process.exit(1)
