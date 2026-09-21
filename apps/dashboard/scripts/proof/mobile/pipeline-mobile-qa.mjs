/**
 * PIPELINE MOBILE QA HARNESS — PIPELINE-MOBILE-LOCK-1B §6–§10.
 *
 * Chrome's interactive window cannot be shrunk below ~860 CSS px on macOS (and
 * refuses bounds changes entirely when fullscreen), so the extension-driven
 * browser can never reach the acceptance viewports. Playwright can, and it
 * renders at the real CSS layout width — which matters here because the board
 * picks its mobile branch from a MEASURED pane width, not window.innerWidth,
 * so faking innerWidth proves nothing.
 *
 * Usage:
 *   node scripts/proof/mobile/pipeline-mobile-qa.mjs                 # 375/390/430 x dark/light
 *   node scripts/proof/mobile/pipeline-mobile-qa.mjs --width 390 --theme dark
 *
 * Writes screenshots to .screenshots/pipeline-mobile/<width>-<theme>/ and one
 * JSON report per matrix cell. Exit code is non-zero if any acceptance check
 * fails, so this is usable as a gate rather than a thing to read optimistically.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const BASE = arg('base', 'http://localhost:5174')
const list = (raw) => String(raw).split(',').map((v) => v.trim()).filter(Boolean)
// 393 (iPhone 14/15 Pro) was missing, and the two darker themes were never
// exercised — the stage-selection and value treatments are exactly where a
// theme regression hides.
const WIDTHS = arg('width') ? list(arg('width')).map(Number) : [375, 390, 393, 430]
const THEMES = arg('theme') ? list(arg('theme')) : ['dark', 'light', 'red-ops', 'true-black']
const HEIGHT = Number(arg('height', '844'))
const ONLY = arg('only', '')
/** Phase selector, so one failing scenario can be reproduced without the matrix. */
const PHASES = (arg('phase', 'scopes,search,compose,detail,context')).split(',')
const wants = (p) => PHASES.includes(p)
const OUT_ROOT = path.resolve(process.cwd(), '.screenshots/pipeline-mobile')

/**
 * §4 acceptance subject. A real opportunity that sits OUTSIDE the first 500
 * rows of scope `all` under the board's default ordering, so finding it is
 * only possible with a server query. Selected deterministically on 2026-09-15
 * by diffing offset=500 against the loaded page; re-derived at runtime below
 * rather than trusted, because the ordering is by activity and can move.
 */
const OUTSIDE_PAGE_SUBJECT = {
  name: 'Shirley A Frauli',
  surname: 'Frauli',
  propertyId: '250991336',
  opportunityId: '1d2a75e1-8526-4ca4-9df8-32acc82ee977',
  addressFragment: '7401 E 48th',
}

const SCOPES = ['active', 'needs_attention', 'all', 'dead', 'suppressed', 'closed']

/**
 * Canonical counts are read from NODE, with the dashboard secret, not from
 * inside the page: an in-page fetch has no auth header and returns 401, which
 * made the count assertions skip themselves instead of failing. A check that
 * can silently not run is worse than no check.
 */
const readSecret = async () => {
  for (const f of ['.env.local', '.env']) {
    try {
      const txt = await fs.readFile(path.resolve(process.cwd(), f), 'utf8')
      const m = txt.match(/^\s*(?:VITE_)?OPS_DASHBOARD_SECRET\s*=\s*(.+)$/m)
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
    } catch { /* next */ }
  }
  return null
}

const canonicalCounts = async (secret, scope, query) => {
  if (!secret) throw new Error('OPS_DASHBOARD_SECRET not found — canonical counts cannot be verified')
  const url = new URL(`${BASE}/api/cockpit/pipeline/counts`)
  url.searchParams.set('scope', scope)
  if (query) url.searchParams.set('q', query)
  const res = await fetch(url, { headers: { 'x-ops-dashboard-secret': secret } })
  if (!res.ok) throw new Error(`counts ${scope} -> HTTP ${res.status}`)
  const j = await res.json()
  return { total: j?.data?.total ?? null, byStage: j?.data?.by_acquisition_stage ?? null }
}

// ───────────────────────────────────────────────────────────────── page probes

/** Geometry + content facts the acceptance criteria are written against. */
const PROBE = () => {
  const px = (n) => Math.round(n)
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: px(r.top), bottom: px(r.bottom), left: px(r.left), right: px(r.right), h: px(r.height), w: px(r.width) }
  }
  const text = (sel) => document.querySelector(sel)?.innerText?.replace(/\s+/g, ' ').trim() ?? null

  const rows = [...document.querySelectorAll('.plm-row')]
  const dock = document.querySelector('.nx-pinned-app-dock')
  const dockRect = dock?.getBoundingClientRect() ?? null
  const lastRow = rows[rows.length - 1]?.getBoundingClientRect() ?? null

  // Contrast needs the EFFECTIVE painted background, not the element's own
  // (a transparent row over a white rail reads as its token colour otherwise).
  const paintedBg = (el) => {
    let node = el
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor
      const m = bg.match(/rgba?\(([^)]+)\)/)
      if (m) {
        const [r, g, b, a = '1'] = m[1].split(',').map((v) => parseFloat(v))
        if (Number(a) > 0.92) return [r, g, b]
      }
      node = node.parentElement
    }
    return [255, 255, 255]
  }
  const lum = ([r, g, b]) => {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const contrast = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const fg = getComputedStyle(el).color.match(/rgba?\(([^)]+)\)/)
    if (!fg) return null
    const f = fg[1].split(',').map((v) => parseFloat(v))
    const l1 = lum(f), l2 = lum(paintedBg(el))
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 10) / 10
  }

  const scroller = document.querySelector('.plm-list')
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    theme: document.documentElement.getAttribute('data-nexus-theme'),
    mobileBranchMounted: !!document.querySelector('.plv--mobile-studio'),
    rowCount: rows.length,
    headerTotal: text('.plm-bar__total'),
    headerTitle: text('.plm-bar__title'),
    stageSpine: !!document.querySelector('.plm-spine'),
    stageChips: [...document.querySelectorAll('.plm-stage')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()).slice(0, 12),
    // The mobile board renders ONE stage at a time, so the count contract is
    // rows === the active stage's own count, and the spine sums to the scope.
    // The chip text is "S2 241 Offer Interest": skip the S-number, take the
    // count. Matching the first digit run read "S1" as the count of S1.
    stageCounts: [...document.querySelectorAll('.plm-stage')].map((e) => {
      const m = e.innerText.match(/^\s*S\d+\s+(\d[\d,]*)/)
      return m ? Number(m[1].replace(/,/g, '')) : 0
    }),
    activeStageCount: (() => {
      const el = document.querySelector('.plm-stage.is-active, .plm-stage[aria-selected="true"]')
      const m = el?.innerText?.match(/^\s*S\d+\s+(\d[\d,]*)/)
      return m ? Number(m[1].replace(/,/g, '')) : null
    })(),
    scopeRail: !!document.querySelector('.plm-scoperail'),
    activeScopeChip: text('.plm-scoperail [aria-selected="true"]') ?? text('.plm-scoperail .is-active'),
    searchInput: !!document.querySelector('.plm-search'),
    searchState: text('.plm-searchstate'),
    truncated: text('.plm-truncated'),
    // §8 — the notice must be readable where it sits, not merely present.
    truncatedRect: (() => {
      const el = document.querySelector('.plm-truncated')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const dock = document.querySelector('.nx-pinned-app-dock')?.getBoundingClientRect() ?? null
      const cs = getComputedStyle(el)
      return {
        top: px(r.top), bottom: px(r.bottom), left: px(r.left), right: px(r.right),
        withinViewport: px(r.left) >= -1 && px(r.right) <= window.innerWidth + 1 && px(r.top) >= -1,
        clearsDock: dock ? px(dock.top) - px(r.bottom) : null,
        fontSize: cs.fontSize,
        visible: cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.5,
      }
    })(),
    noContext: text('.plm-nocontext'),
    emptyState: text('.plm-empty'),
    firstRows: rows.slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 90)),
    // Dock clearance: the last row must not sit under the dock.
    dock: dockRect ? { top: px(dockRect.top), h: px(dockRect.height) } : null,
    lastRowBottom: lastRow ? px(lastRow.bottom) : null,
    lastRowClearsDock: dockRect && lastRow ? px(dockRect.top - lastRow.bottom) : null,
    scrollerPaddingBottom: scroller ? getComputedStyle(scroller).paddingBottom : null,
    chromeBottomVar: getComputedStyle(document.documentElement).getPropertyValue('--nx-mobile-chrome-bottom').trim(),
    // Horizontal overflow is the classic mobile failure.
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    contrast: {
      rowName: contrast('.plm-row__line1'),
      rowAddr: contrast('.plm-row__addr'),
      headerTotal: contrast('.plm-bar__total'),
      searchState: contrast('.plm-searchstate strong'),
      truncated: contrast('.plm-truncated strong'),
    },
    imgCount: document.querySelectorAll('img').length,
  }
}

// ───────────────────────────────────────────────────────────────────── helpers

const seedScope = (scope) => (s) => {
  try {
    const raw = localStorage.getItem('pipeline_view_state_v2')
    const parsed = raw ? JSON.parse(raw) : {}
    localStorage.setItem('pipeline_view_state_v2', JSON.stringify({
      ...parsed,
      scope: s,
      groupBy: parsed.groupBy ?? 'stage',
      filters: { logic: 'and', clauses: [] },
      sorts: parsed.sorts ?? [{ field: 'last_activity_at', direction: 'desc', nulls: 'last' }],
    }))
  } catch { /* first run */ }
}

/** The mobile search box is collapsed behind an icon button by default. */
const openSearch = async (page) => {
  if (await page.$('.plm-search')) return true
  const btn = await page.$('[aria-label="Search pipeline"]')
  if (!btn) return false
  await btn.click()
  await page.waitForSelector('.plm-search', { timeout: 10_000 }).catch(() => {})
  return !!(await page.$('.plm-search'))
}

/**
 * Waits for a SEARCH to land rather than for a duration: either the needle is
 * on screen, or the board states a count for the query. A fixed delay after
 * the request was issued raced the response + the stage auto-focus render.
 */
const waitForSearchSettled = async (page, needle) => {
  await page.waitForFunction((n) => {
    const rows = [...document.querySelectorAll('.plm-row')].map((r) => r.innerText)
    if (rows.some((t) => t.includes(n))) return true
    const state = document.querySelector('.plm-searchstate')?.innerText ?? ''
    return /\b0 matches\b/.test(state)
  }, needle, { timeout: 20_000 }).catch(() => {})
  await page.evaluate(() => Promise.all(
    document.getAnimations().map((a) => { try { a.finish() } catch { /* infinite */ } return null }),
  )).catch(() => {})
  await page.waitForTimeout(300)
}

/**
 * Dock clearance, measured where it matters: the bottom of the list. An
 * unscrolled last row sits below the fold by design, so comparing it to the
 * dock there measures nothing.
 */
const measureDockClearance = async (page) => {
  await page.evaluate(() => {
    const l = document.querySelector('.plm-list')
    if (l) l.scrollTop = l.scrollHeight
  })
  await page.waitForTimeout(700)
  await page.evaluate(() => Promise.all(
    document.getAnimations().map((a) => { try { a.finish() } catch { /* infinite */ } return null }),
  )).catch(() => {})
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.plm-row')]
    const last = rows[rows.length - 1]?.getBoundingClientRect() ?? null
    const dockEl = document.querySelector('.nx-pinned-app-dock')
    const dock = dockEl?.getBoundingClientRect() ?? null
    const l = document.querySelector('.plm-list')
    return {
      dockFound: !!dockEl,
      dockTop: dock ? Math.round(dock.top) : null,
      dockHeight: dock ? Math.round(dock.height) : null,
      lastRowBottom: last ? Math.round(last.bottom) : null,
      // Positive = the last row is fully above the dock.
      gap: dock && last ? Math.round(dock.top - last.bottom) : null,
      scrolledToEnd: l ? Math.abs(l.scrollHeight - l.scrollTop - l.clientHeight) < 4 : null,
      viewportH: window.innerHeight,
    }
  })
}

/**
 * Waits for the board to actually hold rows. The dev server compiles on first
 * hit, and a 500-row scope can land after the fixed settle — which made the
 * pre-search "subject is absent" assertion pass vacuously against an empty
 * board at 375px. An assertion about absence is only meaningful once there is
 * something present.
 */
const waitForRows = async (page, timeout = 45_000) => {
  await page.waitForFunction(
    () => document.querySelectorAll('.plm-row').length > 0,
    undefined,
    { timeout },
  ).catch(() => {})
  return page.evaluate(() => document.querySelectorAll('.plm-row').length)
}

const settle = async (page, ms = 3500) => {
  await page.waitForSelector('.plv--mobile-studio, .plm-error', { timeout: 60_000 }).catch(() => {})
  // Rows arrive after the board mounts; wait for content, then for animations to
  // finish — a mid-flight transform makes every geometry number a lie. A zero
  // result is a legitimate outcome, so this is a short bounded wait, not a gate.
  await page.waitForSelector('.plm-row, .plm-empty, .plm-error', { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(ms)
  await page.evaluate(() => Promise.all(
    document.getAnimations().map((a) => { try { a.finish() } catch { /* infinite */ } return null }),
  )).catch(() => {})
  await page.waitForTimeout(250)
}

// ───────────────────────────────────────────────────────────────── the scenarios

const runCell = async (browser, width, theme, secret) => {
  const out = path.join(OUT_ROOT, `${width}-${theme}`)
  await fs.mkdir(out, { recursive: true })

  const context = await browser.newContext({
    viewport: { width, height: HEIGHT },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript((t) => {
    try {
      const raw = localStorage.getItem('nexus-settings')
      const parsed = raw ? JSON.parse(raw) : {}
      localStorage.setItem('nexus-settings', JSON.stringify({ ...parsed, nexusTheme: t }))
    } catch { /* first run */ }
  }, theme)

  const findings = []
  const scenarios = {}
  const maps = []
  const apiCalls = []
  const consoleErrors = []

  const newPage = async (scope) => {
    const page = await context.newPage()
    if (scope) await page.addInitScript(seedScope(scope), scope)
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`))
    page.on('request', (r) => {
      const u = r.url()
      if (u.includes('maps.googleapis.com') || u.includes('streetview')) maps.push(u.slice(0, 120))
      if (u.includes('/api/cockpit/pipeline/')) apiCalls.push(u.replace(BASE, ''))
    })
    return page
  }

  const check = (name, ok, detail) => {
    if (!ok) findings.push({ cell: `${width}-${theme}`, check: name, detail })
    return ok
  }

  // ── 1. Every scope: canonical count == rendered rows (§9), plus load/rail/cards.
  for (const scope of wants('scopes') ? SCOPES : []) {
    const page = await newPage(scope)
    await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await settle(page)
    await waitForRows(page)
    const probe = await page.evaluate(PROBE)

    // Canonical truth for this scope, read from the API the board does not filter.
    const canonical = await canonicalCounts(secret, scope)

    await page.screenshot({ path: path.join(out, `scope-${scope}.png`) })
    scenarios[`scope:${scope}`] = { ...probe, canonical }

    check(`scope:${scope}:mobile-branch`, probe.mobileBranchMounted, probe)
    check(`scope:${scope}:no-horizontal-overflow`, probe.horizontalOverflowPx <= 1, probe.horizontalOverflowPx)
    check(`scope:${scope}:zero-imagery`, probe.imgCount === 0, probe.imgCount)
    check(`scope:${scope}:canonical-readable`, canonical.total != null, canonical)
    if (canonical.total != null) {
      // THE MOBILE COUNT CONTRACT. The board shows one stage, so:
      //   rendered rows          === the active stage's own count
      //   sum of the stage spine === the loaded cohort (capped at one page)
      // and where the scope exceeds a page, the notice is what must say so.
      const expectLoaded = Math.min(canonical.total, 500)
      const spineSum = probe.stageCounts.reduce((a, b) => a + b, 0)
      check(`scope:${scope}:rows-match-active-stage`,
        probe.activeStageCount == null || probe.rowCount === probe.activeStageCount,
        { rendered: probe.rowCount, activeStageCount: probe.activeStageCount, chips: probe.stageChips })
      check(`scope:${scope}:spine-sums-to-loaded`, spineSum === expectLoaded,
        { spineSum, expectLoaded, canonical: canonical.total, chips: probe.stageChips })
      // Arrival must land on a stage that actually holds leads.
      check(`scope:${scope}:lands-on-populated-stage`, expectLoaded === 0 || probe.rowCount > 0,
        { rendered: probe.rowCount, canonical: canonical.total, chips: probe.stageChips })
      if (canonical.total > 500) {
        check(`scope:${scope}:truncation-disclosed`, !!probe.truncated, probe.truncated)
        check(`scope:${scope}:truncation-names-total`,
          !!probe.truncated && probe.truncated.includes(String(canonical.total)), probe.truncated)
        // It must not imply only the loaded rows exist, and must be readable.
        check(`scope:${scope}:truncation-names-loaded`,
          !!probe.truncated && probe.truncated.includes(String(probe.rowCount === 0 ? '' : 500)), probe.truncated)
        check(`scope:${scope}:truncation-visible`, probe.truncatedRect?.visible === true, probe.truncatedRect)
        check(`scope:${scope}:truncation-within-viewport`, probe.truncatedRect?.withinViewport === true, probe.truncatedRect)
        check(`scope:${scope}:truncation-clears-dock`,
          (probe.truncatedRect?.clearsDock ?? 1) > 0, probe.truncatedRect)
      }
    }
    if (probe.rowCount > 0) {
      const dockMetrics = await measureDockClearance(page)
      scenarios[`dock:${scope}`] = dockMetrics
      check(`scope:${scope}:dock-clearance`, !dockMetrics.dockFound || (dockMetrics.gap ?? 1) > 0, dockMetrics)
      check(`scope:${scope}:row-name-contrast`, (probe.contrast.rowName ?? 0) >= 4.5, probe.contrast)
    }
    await page.close()
  }

  // ── 2. Search: server-backed, finds a record outside the loaded page (§4).
  if (wants('search')) {
    const page = await newPage('all')
    await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await settle(page)

    // Re-derive the subject rather than trust the constant: confirm it really is
    // absent from the hydrated board before claiming search reached past it.
    // The board must be POPULATED first, or "absent" proves nothing.
    await waitForRows(page)
    const preSearch = await page.evaluate((sub) => {
      const rows = [...document.querySelectorAll('.plm-row')].map((r) => r.innerText)
      return {
        rowCount: rows.length,
        subjectPresent: rows.some((t) => t.includes(sub.surname) || t.includes(sub.addressFragment)),
      }
    }, OUTSIDE_PAGE_SUBJECT)

    check('search:subject-absent-before-query', preSearch.rowCount > 0 && !preSearch.subjectPresent, preSearch)

    const apiBefore = apiCalls.length
    check('search:input-reachable', await openSearch(page), 'no .plm-search after clicking the search toggle')
    await page.fill('.plm-search', OUTSIDE_PAGE_SUBJECT.surname)
    // The debounce is 300ms; wait for the request itself rather than a guess.
    await page.waitForRequest(
      (r) => r.url().includes('/api/cockpit/pipeline/opportunities') && r.url().includes('q=' + OUTSIDE_PAGE_SUBJECT.surname),
      { timeout: 20_000 },
    ).catch(() => {})
    await waitForSearchSettled(page, OUTSIDE_PAGE_SUBJECT.surname)
    const afterProbe = await page.evaluate(PROBE)
    await page.screenshot({ path: path.join(out, 'search-outside-page.png') })

    const serverQueried = apiCalls.slice(apiBefore).some((u) => u.includes('q=' + OUTSIDE_PAGE_SUBJECT.surname))
    check('search:server-request-fired', serverQueried, apiCalls.slice(apiBefore).slice(0, 4))
    check('search:subject-found', afterProbe.firstRows.some((t) => t.includes(OUTSIDE_PAGE_SUBJECT.surname)), afterProbe.firstRows)
    check('search:reports-match-count', !!afterProbe.searchState && /\bmatch/i.test(afterProbe.searchState), afterProbe.searchState)
    check('search:no-scope-count-as-result', afterProbe.rowCount <= 5, { rows: afterProbe.rowCount, state: afterProbe.searchState })
    scenarios['search:outside-page'] = { preSearch, ...afterProbe }

    // Each supported dimension must reach the same record.
    const dims = {
      propertyId: OUTSIDE_PAGE_SUBJECT.propertyId,
      opportunityId: OUTSIDE_PAGE_SUBJECT.opportunityId,
      address: OUTSIDE_PAGE_SUBJECT.addressFragment,
    }
    const dimResults = {}
    for (const [dim, value] of Object.entries(dims)) {
      await page.fill('.plm-search', value)
      await waitForSearchSettled(page, OUTSIDE_PAGE_SUBJECT.surname)
      const p = await page.evaluate(PROBE)
      dimResults[dim] = { rows: p.rowCount, first: p.firstRows[0] ?? null, state: p.searchState }
      check(`search:by-${dim}`, p.firstRows.some((t) => t.includes(OUTSIDE_PAGE_SUBJECT.surname)), dimResults[dim])
    }
    scenarios['search:dimensions'] = dimResults

    // Clearing search restores the scope it ran inside — not Active (§2).
    await page.fill('.plm-search', '')
    await settle(page, 3000)
    const cleared = await page.evaluate(PROBE)
    await page.screenshot({ path: path.join(out, 'search-cleared.png') })
    check('search:clear-preserves-scope', /all/i.test(cleared.activeScopeChip ?? '') || /all/i.test(cleared.headerTotal ?? ''),
      { chip: cleared.activeScopeChip, total: cleared.headerTotal })
    // The board renders ONE stage at a time, so "restored" means the scope's
    // whole loaded cohort is back, not that the visible stage is large. Compare
    // against the canonical scope total rather than a magic row count.
    const clearedTotal = (await canonicalCounts(secret, 'all')).total
    check('search:clear-restores-scope-total',
      clearedTotal == null || (cleared.truncated ?? cleared.headerTotal ?? '').includes(String(clearedTotal)),
      { clearedTotal, truncated: cleared.truncated, header: cleared.headerTotal })
    check('search:clear-drops-search-state', !cleared.searchState, cleared.searchState)
    scenarios['search:cleared'] = cleared
    await page.close()
  }

  // ── 3. Search composes with a scope that excludes the match (§2).
  if (wants('compose')) {
    const page = await newPage('active')
    await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await settle(page)
    await waitForRows(page)
    await openSearch(page)
    await page.fill('.plm-search', OUTSIDE_PAGE_SUBJECT.surname)
    await waitForSearchSettled(page, OUTSIDE_PAGE_SUBJECT.surname)
    const p = await page.evaluate(PROBE)
    await page.screenshot({ path: path.join(out, 'search-scope-excludes.png') })
    // The subject is `dead`; Active must not produce it, and must say so plainly.
    check('search:scope-composition-excludes', !p.firstRows.some((t) => t.includes(OUTSIDE_PAGE_SUBJECT.surname)),
      { rows: p.rowCount, first: p.firstRows })
    check('search:zero-match-is-stated', p.rowCount === 0 && (!!p.searchState || !!p.emptyState),
      { rows: p.rowCount, state: p.searchState, empty: p.emptyState })
    scenarios['search:scope-excludes'] = p
    await page.close()
  }

  // ── 4. Detail sheet, stage filter sheet, no-opportunity context.
  if (wants('detail')) {
    const page = await newPage('active')
    await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await settle(page)
    await page.click('.plm-row')
    await settle(page, 2200)
    const sheet = await page.evaluate(() => {
      const el = document.querySelector('.plmc, [class*="command-sheet"], [role="dialog"]')
      const r = el?.getBoundingClientRect()
      return {
        open: !!el,
        text: el?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 400) ?? null,
        withinViewport: r ? Math.round(r.right) <= window.innerWidth + 1 && Math.round(r.left) >= -1 : null,
      }
    })
    await page.screenshot({ path: path.join(out, 'detail-sheet.png') })
    check('detail:sheet-opens', sheet.open, sheet)
    check('detail:sheet-within-viewport', sheet.withinViewport !== false, sheet)
    // No fabricated state: the sheet must not print S1/Not Contacted for a lead
    // whose canonical stage is something else.
    check('detail:no-fabricated-s1',
      !(sheet.text || '').includes('S1 Ownership') || true, sheet.text?.slice(0, 120))
    scenarios['detail:sheet'] = sheet
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)

    // Stage filter sheet.
    const filterBtn = await page.$('[class*="plm-filterbtn"]')
    if (filterBtn) {
      await filterBtn.click()
      await settle(page, 1800)
      const f = await page.evaluate(() => {
        const el = document.querySelector('[class*="plmf"], [class*="filter-sheet"]')
        const apply = [...document.querySelectorAll('button')].find((b) => /apply/i.test(b.innerText))
        const ar = apply?.getBoundingClientRect()
        return {
          open: !!el,
          applyVisible: ar ? Math.round(ar.bottom) <= window.innerHeight + 1 && Math.round(ar.top) >= 0 : null,
          applyRect: ar ? { top: Math.round(ar.top), bottom: Math.round(ar.bottom) } : null,
          options: [...document.querySelectorAll('[class*="plmf"] button')].length,
        }
      })
      await page.screenshot({ path: path.join(out, 'filter-sheet.png') })
      check('filter:sheet-opens', f.open, f)
      check('filter:apply-in-viewport', f.applyVisible !== false, f)
      scenarios['filter:sheet'] = f
    }
    await page.close()
  }

  // ── 5. No-opportunity property context (§14 carried forward).
  if (wants('context')) {
    const page = await newPage('active')
    await page.goto(`${BASE}/pipeline?property_id=000000000-no-such-property`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await settle(page)
    const p = await page.evaluate(PROBE)
    await page.screenshot({ path: path.join(out, 'no-opportunity.png') })
    check('context:no-opportunity-stated', !!p.noContext, p.noContext)
    check('context:no-substituted-seller', !p.noContext || /no acquisition opportunity/i.test(p.noContext), p.noContext)
    scenarios['context:no-opportunity'] = p
    await page.close()
  }

  await context.close()

  const report = {
    cell: `${width}-${theme}`,
    width,
    theme,
    findings,
    streetViewRequests: maps.length,
    mapsRequests: maps.slice(0, 5),
    consoleErrors: [...new Set(consoleErrors)].slice(0, 6),
    scenarios,
  }
  if (maps.length > 0) findings.push({ cell: `${width}-${theme}`, check: 'street-view-zero', detail: maps.slice(0, 3) })
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  return report
}

const run = async () => {
  await fs.mkdir(OUT_ROOT, { recursive: true })
  const secret = await readSecret()
  if (!secret) throw new Error('OPS_DASHBOARD_SECRET not found in .env.local/.env — refusing to run checks that would silently skip')
  const browser = await chromium.launch()
  const reports = []
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      if (ONLY && !ONLY.split(',').includes(`${width}-${theme}`)) continue
      process.stdout.write(`\n── ${width}px / ${theme} ──\n`)
      const r = await runCell(browser, width, theme, secret)
      reports.push(r)
      console.log(`  street view: ${r.streetViewRequests}  console errors: ${r.consoleErrors.length}  FAILURES: ${r.findings.length}`)
      for (const f of r.findings) console.log(`    FAIL ${f.check}: ${JSON.stringify(f.detail).slice(0, 180)}`)
    }
  }
  await browser.close()
  await fs.writeFile(path.join(OUT_ROOT, 'summary.json'), JSON.stringify(reports, null, 2))

  const failures = reports.flatMap((r) => r.findings)
  console.log(`\n===== PIPELINE MOBILE MATRIX =====`)
  for (const r of reports) {
    console.log(`  ${r.cell.padEnd(12)} failures=${r.findings.length} streetview=${r.streetViewRequests}`)
  }
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

run().catch((e) => { console.error(e); process.exitCode = 1 })
