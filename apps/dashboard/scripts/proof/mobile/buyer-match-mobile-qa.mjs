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
/**
 * REPOINTED. This was 278477219, which stopped being a no-run fixture the moment
 * anything opened Buyer Match on it: the workspace auto-commissions a match run
 * when a property has no candidates, so visiting the fixture destroys the
 * fixture. (It was consumed exactly that way during the MOBILE-LOCK pass, by a
 * desktop probe on the same property the Comps and Map checks use.)
 *
 * 256541080 has no row in `buyer_match_runs`, verified service-side. It carries
 * the same risk, so treat a future failure here as "the fixture has been used"
 * before treating it as a regression — and repoint rather than deleting the run,
 * which is real engine output.
 */
const SUBJECT_NO_RUN = { id: '256541080', label: 'KC 1501 N 23rd (no run)' }

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

/**
 * A dev server compiling a route for the first time answers 502/503 for a few
 * seconds, and this read is the harness's own source of truth — so a cold start
 * used to abort the whole matrix with `candidates … -> HTTP 502` before a single
 * assertion ran. Transport-level retry only: a 4xx is still a real failure and is
 * raised immediately.
 */
const canonical = async (propertyId, attempt = 0) => {
  const res = await fetch(`${BASE}/api/cockpit/buyer-match/property/${propertyId}/candidates?limit=50`, {
    headers: { 'x-ops-dashboard-secret': secret },
  })
  if (!res.ok) {
    // Up to ~60s: a Next dev server can spend that long compiling a route on
    // first hit, and this harness is frequently the first thing to touch it.
    if (res.status >= 500 && attempt < 12) {
      await new Promise((r) => setTimeout(r, 5000))
      return canonical(propertyId, attempt + 1)
    }
    throw new Error(`candidates ${propertyId} -> HTTP ${res.status}`)
  }
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
    names: (d.candidates ?? []).map((c) => c.buyer_name),
  }
}

/**
 * Read live rather than reusing the values captured at startup: a match run can
 * be commissioned between then and now, and comparing the UI against a stale
 * snapshot would report drift as a defect.
 */
const canonicalRunId = async (propertyId) => (await canonical(propertyId)).runId
const canonicalNames = async (propertyId) => (await canonical(propertyId)).names

/**
 * Warm the deal-context route before the matrix.
 *
 * The subject header is hydrated from /api/cockpit/deal-context, which a Next dev
 * server compiles on first hit — and the FIRST cell of the matrix was that first
 * hit. The surface behaved correctly (it said "Loading property…" because it was
 * loading), but the harness then measured a genuinely mid-flight state and
 * reported it as a product failure. Warming it makes the matrix measure the
 * product rather than the dev server's cold start; the request is a read and
 * changes nothing.
 */
await fetch(`${BASE}/api/cockpit/deal-context/property/${SUBJECT_A.id}`, {
  headers: { 'x-ops-dashboard-secret': secret },
}).catch(() => undefined)

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
    /**
     * Wait for a SETTLED outcome, not for a fixed delay.
     *
     * The old wait only cleared "Loading canonical" and then slept 3.5s, which is
     * enough on a warm dev server and not on a cold one — the first cell of a run
     * (and the desktop cell) pays the route's first compile, so it measured a
     * surface still showing "Loading property…" and reported nine product
     * failures for a timing artifact. A settled surface is one that has cards, a
     * subject address, or has said why it has neither.
     */
    await page.waitForFunction(
      () => {
        const state = document.querySelector('.bmm__state')?.textContent ?? ''
        if (/Loading canonical|Loading property/i.test(state)) return false

        /**
         * The SUBJECT settles independently of the candidates, and later: the
         * property record is a separate read, so cards can be on screen while the
         * header still says "Loading property…". Requiring only the cards is what
         * left the first cell asserting against a half-hydrated surface.
         */
        const address = document.querySelector('.bmm__subject-address')?.textContent?.trim()
        const subjectSettled = Boolean(address) && !/^Loading/i.test(address)
        const hydrationFailed = /details unavailable/i.test(document.body.innerText)
        if (!subjectSettled && !hydrationFailed) return false

        if (document.querySelectorAll('.bmm__card').length > 0) return true
        if (document.querySelectorAll('.aic-buyer-card__header').length > 0) return true
        // An explicit no-run / no-buyers / error message is also settled.
        return /no match run|returned no buyers|unavailable|could not/i.test(state)
      },
      /**
       * 120s, because on a COLD dev server this page waits on two routes being
       * compiled for the first time (the candidates read and deal-context), and
       * 60s was not enough for both — the harness gave up mid-hydration and
       * reported "Loading property…" as a product failure. Measured directly:
       * with a 30s settle the same surface shows the real address and 25 cards.
       * On a warm server this returns in well under a second.
       */
      undefined, { timeout: 120_000 },
    ).catch(() => {})
    await page.waitForTimeout(1500)
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

/**
 * DESKTOP, on the same route.
 *
 * The same envelope defect broke desktop harder than mobile. `res.data.candidates.length`
 * threw a TypeError on every success, which skipped past the Supabase fallback
 * (that fallback only ran when the API FAILED), so the canonical workspace
 * rendered zero buyers for a property with 25 matches.
 *
 * It had a second consequence. The auto-run condition is
 * `candidates.length === 0 && (isStale || !latestRun)` — with candidates stuck
 * at 0 forever, every desktop visit to a property commissioned a FRESH
 * production match run. So this also proves the run id is stable across a
 * load: a correct read makes the auto-run stand down.
 */
async function runDesktopCell() {
  const check = (n, ok, d) => { if (!ok) findings.push({ cell: 'desktop-1600', n, d }); return ok }
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await context.addInitScript(setTheme, 'dark')
  const page = await context.newPage()
  const ran = []
  page.on('console', (m) => { if (/runMatch:start|runMatch:complete/.test(m.text())) ran.push(m.text().slice(0, 60)) })

  const runBefore = await canonicalRunId(SUBJECT_A.id)
  await page.goto(`${BASE}/buyer-match?property_id=${SUBJECT_A.id}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('.aic-buyer-list', { timeout: 60_000 }).catch(() => {})
  // Same settle rule as the mobile cells: a cold first compile made this report
  // "0 cards" for a workspace that renders 25 a second later.
  await page.waitForFunction(
    () => document.querySelectorAll('.aic-buyer-card__header').length > 0
      || Boolean(document.querySelector('.aic-buyer-empty, .bmm__state')),
    undefined, { timeout: 60_000 },
  ).catch(() => {})
  await page.waitForTimeout(2500)
  const d = await page.evaluate(() => ({
    cards: document.querySelectorAll('.aic-buyer-card__header').length,
    toolbarCount: document.querySelector('.aic-buyer-toolbar__count')?.textContent?.trim() ?? null,
    names: [...document.querySelectorAll('.aic-buyer-name')].map((e) => e.textContent.trim()),
  }))
  const runAfter = await canonicalRunId(SUBJECT_A.id)
  const endpointOrder = await canonicalNames(SUBJECT_A.id)

  check('desktop: the canonical workspace renders the buyer list', d.cards > 0, `${d.cards} cards`)
  check('desktop: every candidate in the run is rendered',
    d.cards === endpointOrder.length && d.toolbarCount === String(endpointOrder.length),
    `${d.cards} cards, toolbar="${d.toolbarCount}", endpoint=${endpointOrder.length}`)
  check('desktop: ordering is the engine\'s, not re-sorted',
    d.names.slice(0, 5).join('|') === endpointOrder.slice(0, 5).join('|'),
    `ui=${d.names.slice(0, 3).join(', ')} :: endpoint=${endpointOrder.slice(0, 3).join(', ')}`)
  check('desktop: a cached run is NOT re-commissioned on load',
    runBefore === runAfter && ran.length === 0,
    `run ${String(runBefore).slice(0, 8)} -> ${String(runAfter).slice(0, 8)}, runMatch=${ran.length}`)
  await page.screenshot({ path: path.join(OUT, 'desktop-A.png') })
  await context.close()
  return { cell: 'desktop-1600', cards: d.cards, runStable: runBefore === runAfter }
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
  const beforeDesktop = findings.length
  const dres = await runDesktopCell()
  const badDesktop = findings.length - beforeDesktop
  console.log(`${dres.cell.padEnd(12)} ${(badDesktop ? `FAIL (${badDesktop})` : 'PASS').padEnd(10)} ${dres.cards} buyer cards  run stable: ${dres.runStable}`)
  for (const f of findings.slice(beforeDesktop)) console.log(`   ✗ ${f.n}: ${f.d}`)
} finally { await browser.close() }

console.log('')
console.log(`BUYER MATCH MATRIX ${results.length - new Set(findings.map((f) => f.cell)).size}/${results.length} cells clean, ${findings.length} finding(s)`)
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ canonical: { A, B, E, N }, results, findings }, null, 2))
if (findings.length) process.exit(1)
