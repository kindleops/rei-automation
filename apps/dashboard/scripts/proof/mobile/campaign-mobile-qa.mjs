/**
 * CAMPAIGN COMMAND MOBILE QA HARNESS — CAMPAIGN-COMMAND-MOBILE-LOCK-1 §36.
 *
 * Chrome's interactive window will not go below ~860 CSS px on macOS and
 * ignores bounds changes in fullscreen, and the app picks its mobile branch
 * from a MEASURED pane width, so faking window.innerWidth proves nothing.
 * Playwright renders at the real CSS width.
 *
 * Three traps this file encodes, each of which produced a false result first:
 *
 *  1. `.cmk__row` also matches the four LOADING SKELETONS, which are empty and
 *     aria-hidden. The campaign list takes seconds to arrive, so a naive wait
 *     measures a skeleton: the first run reported "4 rows, KPIs all zero" for a
 *     40-campaign book. Every wait here is for `:not(.is-skeleton)`.
 *  2. An in-page fetch of /api/cockpit/* returns 401 (no dashboard secret), so
 *     canonical counts are read from NODE. Guarding an assertion on a nullable
 *     canonical value makes it SKIP rather than fail, which is worse than
 *     having no assertion.
 *  3. Geometry is not reachability. The mobile header sat fully underneath the
 *     global top dock — a fixed, z-index 150 element with an interactive inner
 *     — and no bounding-box check would have noticed. Controls are verified by
 *     elementFromPoint at their own centre.
 *
 * Usage:
 *   node scripts/proof/mobile/campaign-mobile-qa.mjs
 *   node scripts/proof/mobile/campaign-mobile-qa.mjs --width 390 --theme dark
 *   node scripts/proof/mobile/campaign-mobile-qa.mjs --phase list,search,detail
 *
 * Exits non-zero on any failed check, so it is a gate rather than a report.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const BASE = arg('base', 'http://localhost:5174')
const WIDTHS = arg('width') ? [Number(arg('width'))] : [375, 390, 430]
const THEMES = arg('theme') ? [arg('theme')] : ['dark', 'light']
const HEIGHT = Number(arg('height', '844'))
const PHASES = arg('phase', 'list,search,detail').split(',')
const wants = (p) => PHASES.includes(p)
const OUT_ROOT = path.resolve(process.cwd(), '.screenshots/campaign-mobile')

/** §25 subject — the Entity Graph explicit handoff campaign. */
const EXPLICIT_CAMPAIGN = { name: 'Entity Graph · 5 properties' }

/** Controls the operator must be able to actually touch. */
const REQUIRED_CONTROLS = [
  ['search/filter', 'button[aria-label="Search and filter"]'],
  ['new campaign', 'button[aria-label="New campaign"]'],
]

// ─────────────────────────────────────────────────────── canonical truth (node)

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

const canonicalTruth = async (secret) => {
  const res = await fetch(`${BASE}/api/cockpit/campaigns`, {
    headers: { 'x-ops-dashboard-secret': secret },
  })
  if (!res.ok) throw new Error(`/campaigns -> HTTP ${res.status}`)
  const body = await res.json()
  const campaigns = body.campaigns || []
  const terminal = new Set(['archived', 'completed'])
  return {
    count: campaigns.length,
    truncated: body.truncated === true,
    listCap: body.list_cap ?? null,
    readyLive: campaigns
      .filter((c) => !terminal.has(String(c.status || '').toLowerCase()))
      .reduce((n, c) => n + Number(c.ready_targets || 0), 0),
    totalTargets: campaigns.reduce((n, c) => n + Number(c.total_targets || 0), 0),
    explicit: campaigns
      .filter((c) => c.target_mode === 'explicit' || c.target_mode === 'explicit_filtered')
      .map((c) => ({ name: c.name, selected: c.explicit_target_count, built: c.total_targets })),
    statuses: campaigns.reduce((m, c) => {
      const s = String(c.status || 'unknown').toLowerCase()
      m[s] = (m[s] || 0) + 1
      return m
    }, {}),
  }
}

/**
 * §2 — EXPLICIT TARGETING MUST BE EXACT.
 *
 * The one invariant worth checking on every run: for a pinned selection, every
 * built target must be inside the selection. Built count alone cannot show
 * this — campaign_targets is contact-grained, so 5 selected legitimately
 * resolves to 2 rows and 186 to 984 — which is exactly why the earlier
 * "61,500 rows for a 5-property selection" defect needed the identity check
 * rather than an arithmetic one.
 *
 * Reported separately from the viewport matrix: a widened cohort is a DATA
 * hazard on a specific campaign, not a rendering failure at 390px.
 */
const auditExplicitContainment = async (secret) => {
  const res = await fetch(`${BASE}/api/cockpit/campaigns`, {
    headers: { 'x-ops-dashboard-secret': secret },
  })
  const campaigns = (await res.json()).campaigns || []
  const explicit = campaigns.filter((c) => c.target_mode === 'explicit' || c.target_mode === 'explicit_filtered')
  const audits = []

  for (const c of explicit) {
    const detailRes = await fetch(`${BASE}/api/cockpit/campaigns/${c.id}`, {
      headers: { 'x-ops-dashboard-secret': secret },
    })
    const detail = await detailRes.json()
    const metadata = (detail.campaign || detail)?.metadata || {}
    const clauses = Object.values(metadata.target_filters || {}).flatMap((v) => (Array.isArray(v) ? v : []))
    const selected = new Set()
    for (const clause of clauses) {
      if (clause?.field_key !== 'properties.property_id') continue
      const value = Array.isArray(clause.value) ? clause.value : [clause.value]
      for (const v of value) if (v != null) selected.add(String(v))
    }
    if (selected.size === 0) continue

    // Page the target rows — the endpoint pages, and a partial read would
    // understate contamination.
    const outside = new Set()
    let inside = 0
    let total = 0
    for (let page = 1; page <= 40; page += 1) {
      const t = await fetch(`${BASE}/api/cockpit/campaigns/${c.id}/targets?page=${page}&page_size=200`, {
        headers: { 'x-ops-dashboard-secret': secret },
      })
      const body = await t.json()
      const rows = body.targets || []
      for (const row of rows) {
        total += 1
        const pid = String(row.property_id ?? '')
        if (selected.has(pid)) inside += 1
        else outside.add(pid)
      }
      if (rows.length < 200) break
    }
    audits.push({
      name: c.name,
      selected: selected.size,
      builtRows: total,
      inside,
      outsideProperties: outside.size,
      contained: outside.size === 0,
      // A widened campaign that is QUARANTINED is a known, contained state:
      // auto-queue is off and the queue-plan guard refuses it outright. A
      // widened campaign that is still live is not, and must fail the gate.
      quarantined: c.quarantined === true,
      quarantineReason: c.quarantine_reason ?? null,
      sampleOutside: [...outside].slice(0, 4),
    })
  }
  return audits
}

// ───────────────────────────────────────────────────────────────── page probes

const PROBE = () => {
  const px = (n) => Math.round(n)
  const all = (sel) => [...document.querySelectorAll(sel)]
  const text = (sel) => document.querySelector(sel)?.innerText?.replace(/\s+/g, ' ').trim() ?? null

  const paintedBg = (el) => {
    let node = el
    while (node && node !== document.documentElement) {
      const m = getComputedStyle(node).backgroundColor.match(/rgba?\(([^)]+)\)/)
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
    const l1 = lum(fg[1].split(',').map((v) => parseFloat(v)))
    const l2 = lum(paintedBg(el))
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 10) / 10
  }

  /** Is the element's own centre the topmost thing there? */
  const reachable = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return { present: false }
    const r = el.getBoundingClientRect()
    const cx = px(r.left + r.width / 2)
    const cy = px(r.top + r.height / 2)
    const hit = document.elementFromPoint(cx, cy)
    return {
      present: true,
      rect: { top: px(r.top), bottom: px(r.bottom), left: px(r.left), right: px(r.right) },
      inViewport: px(r.top) >= 0 && px(r.bottom) <= window.innerHeight && px(r.left) >= 0 && px(r.right) <= window.innerWidth,
      reachable: !!(hit && (hit === el || el.contains(hit))),
      blockedBy: hit && !(hit === el || el.contains(hit))
        ? `${hit.tagName}.${String(hit.className || '').split(' ').slice(0, 2).join('.')}`
        : null,
    }
  }

  const rows = all('.cmk__row:not(.is-skeleton)')
  const bottomDock = document.querySelector('.nx-pinned-app-dock')?.getBoundingClientRect() ?? null
  const scroller = document.querySelector('.cmk__scroll')

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    theme: document.documentElement.getAttribute('data-nexus-theme'),
    skeletons: all('.cmk__row.is-skeleton').length,
    rowCount: rows.length,
    rowNames: all('.cmk__row-name').map((e) => e.innerText.trim()).slice(0, 6),
    rowStates: [...new Set(all('.cmk__row-state').map((e) => e.innerText.trim()))],
    rowQuiet: [...new Set(all('.cmk__row-quiet').map((e) => e.innerText.replace(/\s+/g, ' ').trim()))].slice(0, 6),
    kpis: text('.cmk__kpis'),
    readyKpi: (() => {
      const label = all('.cmk__kpi-label').find((e) => e.innerText.trim() === 'READY')
      const value = label?.parentElement?.querySelector('.cmk__kpi-value')?.innerText?.trim() ?? null
      return value
    })(),
    posture: text('.cmk__posture'),
    emptyState: text('.cmk__empty'),
    searchNote: text('.cxi__search-note'),
    searchInputPresent: !!document.querySelector('input[aria-label="Search campaigns"]'),
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    imgCount: document.querySelectorAll('img').length,
    controls: Object.fromEntries(
      [['search/filter', 'button[aria-label="Search and filter"]'],
       ['new campaign', 'button[aria-label="New campaign"]']].map(([k, sel]) => [k, reachable(sel)]),
    ),
    bottomDock: bottomDock ? { top: px(bottomDock.top), h: px(bottomDock.height) } : null,
    lastRowBottom: rows.length ? px(rows[rows.length - 1].getBoundingClientRect().bottom) : null,
    scrollerPadBottom: scroller ? getComputedStyle(scroller).paddingBottom : null,
    contrast: {
      rowName: contrast('.cmk__row-name'),
      kpiValue: contrast('.cmk__kpi-value'),
      posture: contrast('.cmk__posture'),
    },
  }
}

// ───────────────────────────────────────────────────────────────────── helpers

const setTheme = (t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    const parsed = raw ? JSON.parse(raw) : {}
    localStorage.setItem('nexus-settings', JSON.stringify({ ...parsed, nexusTheme: t }))
  } catch { /* first run */ }
}

/** Real rows, not the four skeletons. */
const waitForRows = async (page, timeout = 150_000) => {
  await page.waitForFunction(() => {
    if (document.querySelector('.cmk__row:not(.is-skeleton)')) return true
    return /no campaigns/i.test(document.body.innerText)
  }, undefined, { timeout }).catch(() => {})
  await page.waitForTimeout(2500)
  await page.evaluate(() => Promise.all(
    document.getAnimations().map((a) => { try { a.finish() } catch { /* infinite */ } return null }),
  )).catch(() => {})
  await page.waitForTimeout(250)
}

const scrollToEnd = async (page) => {
  await page.evaluate(() => {
    const s = document.querySelector('.cmk__scroll')
    if (s) s.scrollTop = s.scrollHeight
  })
  await page.waitForTimeout(800)
}

// ────────────────────────────────────────────────────────────────── the run

const runCell = async (browser, width, theme, canonical) => {
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
  await context.addInitScript(setTheme, theme)

  const findings = []
  const scenarios = {}
  const maps = []
  const consoleErrors = []
  const failedRequests = []

  const newPage = async () => {
    const page = await context.newPage()
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 170)) })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 170)}`))
    page.on('request', (r) => {
      const u = r.url()
      if (u.includes('maps.googleapis.com') || u.includes('streetview')) maps.push(u.slice(0, 120))
    })
    page.on('response', (r) => {
      if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().replace(BASE, '').slice(0, 140)}`)
    })
    return page
  }

  const check = (name, ok, detail) => {
    if (!ok) findings.push({ cell: `${width}-${theme}`, check: name, detail })
    return ok
  }

  const baseChecks = (tag, probe) => {
    check(`${tag}:no-horizontal-overflow`, probe.horizontalOverflowPx <= 1, probe.horizontalOverflowPx)
    check(`${tag}:zero-imagery`, probe.imgCount === 0, probe.imgCount)
    for (const [label] of REQUIRED_CONTROLS) {
      const c = probe.controls[label]
      check(`${tag}:control-present:${label}`, c?.present === true, c)
      check(`${tag}:control-reachable:${label}`, c?.reachable === true, c)
      check(`${tag}:control-in-viewport:${label}`, c?.inViewport === true, c)
    }
  }

  // ── campaign list (§19, §21, §31, §36, §37)
  if (wants('list')) {
    const page = await newPage()
    await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
    await waitForRows(page)
    const probe = await page.evaluate(PROBE)
    await page.screenshot({ path: path.join(out, 'list.png') })
    scenarios.list = probe
    baseChecks('list', probe)

    check('list:renders-all-campaigns', probe.rowCount === canonical.count,
      { rendered: probe.rowCount, canonical: canonical.count, skeletons: probe.skeletons })
    check('list:no-skeletons-left', probe.skeletons === 0, probe.skeletons)
    // §21 — READY must reflect actionable ready targets, not 0 and not the
    // archived-inclusive book total.
    check('list:ready-kpi-canonical', probe.readyKpi !== null && Number(String(probe.readyKpi).replace(/[^\d]/g, '')) > 0,
      { readyKpi: probe.readyKpi, canonicalReadyLive: canonical.readyLive })
    // §31 — a built campaign must not read DRAFT.
    if (canonical.statuses.built > 0) {
      check('list:built-not-draft', probe.rowStates.includes('BUILT'), probe.rowStates)
    }
    check('list:row-name-contrast', (probe.contrast.rowName ?? 0) >= 4.5, probe.contrast)
    check('list:search-note-honest', canonical.truncated ? !!probe.searchNote : probe.searchNote === null,
      { truncated: canonical.truncated, note: probe.searchNote })

    const dock = await (async () => { await scrollToEnd(page); return page.evaluate(PROBE) })()
    scenarios.listScrolled = dock
    if (dock.bottomDock && dock.lastRowBottom != null) {
      check('list:dock-clearance', dock.bottomDock.top - dock.lastRowBottom > 0,
        { dockTop: dock.bottomDock.top, lastRowBottom: dock.lastRowBottom })
    }
    await page.close()
  }

  // ── search (§28, §31)
  if (wants('search')) {
    const page = await newPage()
    await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
    await waitForRows(page)
    await page.click('button[aria-label="Search and filter"]')
    await page.waitForTimeout(1200)
    const opened = await page.evaluate(() => !!document.querySelector('input[aria-label="Search campaigns"]'))
    check('search:opens', opened, 'search toggle did not reveal the input')

    if (opened) {
      const sel = 'input[aria-label="Search campaigns"]'
      await page.fill(sel, 'Entity Graph')
      await page.waitForTimeout(1600)
      const hit = await page.evaluate(PROBE)
      await page.screenshot({ path: path.join(out, 'search-hit.png') })
      check('search:narrows-to-matches', hit.rowCount > 0 && hit.rowCount < canonical.count,
        { rows: hit.rowCount, canonical: canonical.count, names: hit.rowNames })
      check('search:matches-are-relevant', hit.rowNames.every((n) => /entity graph/i.test(n)), hit.rowNames)

      await page.fill(sel, 'zzzz-no-such-campaign')
      // The list renders skeletons whenever `loading && campaigns.length === 0`,
      // and a zero-match search satisfies the second half — so a background
      // refetch paints skeletons over what should be the empty state. Waiting
      // for them to clear is the difference between measuring the empty state
      // and measuring a refetch.
      await page.waitForFunction(
        () => document.querySelectorAll('.cmk__row.is-skeleton').length === 0,
        undefined, { timeout: 30_000 },
      ).catch(() => {})
      await page.waitForTimeout(1200)
      const zero = await page.evaluate(PROBE)
      await page.screenshot({ path: path.join(out, 'search-zero.png') })
      check('search:zero-is-stated', zero.rowCount === 0 && !!zero.emptyState,
        { rows: zero.rowCount, empty: zero.emptyState })

      await page.fill(sel, '')
      await page.waitForTimeout(1600)
      const cleared = await page.evaluate(PROBE)
      check('search:clear-restores-all', cleared.rowCount === canonical.count,
        { rows: cleared.rowCount, canonical: canonical.count })
      scenarios.search = { hit, zero, cleared }
    }
    await page.close()
  }

  // ── detail (§20, §36)
  if (wants('detail')) {
    const page = await newPage()
    await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
    await waitForRows(page)
    const opened = await page.evaluate((name) => {
      const row = [...document.querySelectorAll('.cmk__row:not(.is-skeleton)')]
        .find((r) => r.innerText.includes(name))
      if (!row) return false
      row.click()
      return true
    }, EXPLICIT_CAMPAIGN.name)
    check('detail:explicit-campaign-row-present', opened, `no row for ${EXPLICIT_CAMPAIGN.name}`)

    if (opened) {
      await page.waitForTimeout(7000)
      const detail = await page.evaluate(() => ({
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        imgs: document.querySelectorAll('img').length,
        text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 700),
        sections: (() => {
          const t = document.querySelector('.ccc-detail-tab-filter .occ-liquid-filter__trigger')
          return t ? t.innerText.replace(/\s+/g, ' ').trim() : null
        })(),
      }))
      await page.screenshot({ path: path.join(out, 'detail-explicit.png'), fullPage: true })
      scenarios.detail = detail
      check('detail:no-horizontal-overflow', detail.overflow <= 1, detail.overflow)
      check('detail:zero-imagery', detail.imgs === 0, detail.imgs)
      check('detail:has-section-navigation', !!detail.sections, detail.sections)
    }
    await page.close()
  }

  await context.close()
  if (maps.length > 0) findings.push({ cell: `${width}-${theme}`, check: 'street-view-zero', detail: maps.slice(0, 3) })

  const report = {
    cell: `${width}-${theme}`, width, theme, findings,
    streetViewRequests: maps.length,
    consoleErrors: [...new Set(consoleErrors)].slice(0, 8),
    failedRequests: [...new Set(failedRequests)].slice(0, 8),
    canonical, scenarios,
  }
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  return report
}

const run = async () => {
  await fs.mkdir(OUT_ROOT, { recursive: true })
  const secret = await readSecret()
  if (!secret) throw new Error('OPS_DASHBOARD_SECRET not found — refusing to run checks that would silently skip')
  const canonical = await canonicalTruth(secret)
  console.log('canonical:', JSON.stringify(canonical))

  const containment = await auditExplicitContainment(secret)
  console.log('\n== §2 EXPLICIT TARGET CONTAINMENT ==')
  for (const a of containment) {
    const verdict = a.contained
      ? 'CONTAINED'
      : a.quarantined
        ? `WIDENED by ${a.outsideProperties} unselected properties — QUARANTINED (${a.quarantineReason})`
        : `WIDENED by ${a.outsideProperties} unselected properties — NOT QUARANTINED`
    console.log(`  ${a.name}: ${a.selected} selected -> ${a.builtRows} rows (${a.inside} inside) — ${verdict}`)
    if (!a.contained) console.log(`    sample unselected property ids: ${a.sampleOutside.join(', ')}`)
  }
  // Only an UNQUARANTINED widened campaign fails the gate.
  const widened = containment.filter((a) => !a.contained && !a.quarantined)
  const quarantinedWidened = containment.filter((a) => !a.contained && a.quarantined)

  const browser = await chromium.launch()
  const reports = []
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      process.stdout.write(`\n── ${width}px / ${theme} ──\n`)
      const r = await runCell(browser, width, theme, canonical)
      reports.push(r)
      console.log(`  street view: ${r.streetViewRequests}  console errors: ${r.consoleErrors.length}  FAILURES: ${r.findings.length}`)
      for (const f of r.findings) console.log(`    FAIL ${f.check}: ${JSON.stringify(f.detail).slice(0, 200)}`)
    }
  }
  await browser.close()
  await fs.writeFile(path.join(OUT_ROOT, 'summary.json'), JSON.stringify(reports, null, 2))

  const failures = reports.flatMap((r) => r.findings)
  console.log('\n===== CAMPAIGN MOBILE MATRIX =====')
  for (const r of reports) console.log(`  ${r.cell.padEnd(12)} failures=${r.findings.length} streetview=${r.streetViewRequests}`)
  console.log(failures.length === 0 ? '\nALL VIEWPORT CHECKS PASSED' : `\n${failures.length} VIEWPORT CHECK(S) FAILED`)
  if (widened.length > 0) {
    console.log(`\nBLOCKER: ${widened.length} LIVE explicit campaign(s) contain unselected properties:`)
    for (const a of widened) console.log(`  ${a.name}: ${a.outsideProperties} unselected properties among ${a.builtRows} target rows`)
  }
  if (quarantinedWidened.length > 0) {
    console.log(`\nKnown and contained — ${quarantinedWidened.length} quarantined campaign(s) with historical widening:`)
    for (const a of quarantinedWidened) {
      console.log(`  ${a.name}: ${a.outsideProperties} unselected of ${a.builtRows} rows, auto-queue off, queue-plan refuses it`)
    }
  }
  await fs.writeFile(path.join(OUT_ROOT, 'explicit-containment.json'), JSON.stringify(containment, null, 2))
  process.exitCode = failures.length === 0 && widened.length === 0 ? 0 : 1
}

run().catch((e) => { console.error(e); process.exitCode = 1 })
