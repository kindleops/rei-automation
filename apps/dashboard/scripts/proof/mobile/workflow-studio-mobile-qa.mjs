/**
 * WORKFLOW STUDIO MOBILE QA HARNESS — WORKFLOW-STUDIO-MOBILE-LOCK-1 §39/§40.
 *
 * Renders the real surface at real CSS widths. Chrome's interactive window will
 * not go below ~860 CSS px on macOS and the studio picks its mobile branch from
 * `useBreakpoint()`, so resizing a desktop browser or faking window.innerWidth
 * proves nothing about what a phone gets.
 *
 * What this file exists to catch, in the order the traps bit on other surfaces:
 *
 *  1. GEOMETRY IS NOT REACHABILITY. Campaign Command's mobile header sat
 *     entirely underneath the global top dock — `position: fixed`, z-index 150,
 *     with an interactive inner — and every bounding-box check passed. Controls
 *     here are verified with document.elementFromPoint at their own centre.
 *  2. TWO BOTTOM DOCKS. The studio ships `.wfs2-mobile-dock` while the shell
 *     ships `.nx-pinned-app-dock`. Both are bottom-anchored. Their rects are
 *     compared directly rather than assumed to coexist.
 *  3. A VIEWPORT UNIT IN THE FULLSCREEN ANCESTRY. `.wfs2--mobile-studio` sizes
 *     from 100dvh, which resolves to the SHORT layout viewport in an installed
 *     PWA. The certified contract is html 100lvh with descendants at 100%
 *     (see scripts/assert-mobile-fullscreen-contract.mjs), and that guard only
 *     inspects the standalone media block, so this rule escaped it.
 *  4. THE LIST WAS LYING. Every published workflow rendered as "active safe"
 *     via operational_mode, while none of them can be entered. Row text is
 *     compared against canonical API truth read from NODE with the dashboard
 *     secret — an in-page fetch of /api/cockpit/* returns 401, and guarding an
 *     assertion on a nullable value makes it SKIP instead of fail.
 *
 * Usage:
 *   node scripts/proof/mobile/workflow-studio-mobile-qa.mjs
 *   node scripts/proof/mobile/workflow-studio-mobile-qa.mjs --width 390 --theme dark
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
const OUT_ROOT = path.resolve(process.cwd(), '.screenshots/workflow-studio-mobile')

/**
 * §24/§25 subjects. `thread_key` is a Workflow Studio context query param, so
 * these drive the real subject-scoped path rather than a mocked one.
 *
 * Subject A is the runtime-proof fixture and genuinely has an enrollment.
 * Subject B is a thread key no workflow has ever seen, so the surface must say
 * so instead of resolving to the first workflow in the catalog.
 */
const SUBJECT_WITH_AUTOMATION = 'wfproof:thread:0f7e1a00-runtime-proof-a'
const SUBJECT_WITHOUT_AUTOMATION = 'wfproof:thread:definitely-no-automation'

/** The studio's own bottom navigation. Every one must be touchable. */
const DOCK_CONTROLS = [
  /**
   * MOBILE-LOCK §16 changed this dock.
   *
   *   'dock steps'  is NEW and is the mobile default — a workflow read as an
   *                 ordered structure. The canvas is no longer what a phone
   *                 opens on; §16 forbids that explicitly.
   *   'dock canvas' gained a hint suffix, so its aria-label is now
   *                 "Canvas — Full-screen graph".
   *   'dock log'    is GONE. The mobile header already carries a Console
   *                 toggle, so the dock was a second control for one surface —
   *                 and six columns clipped every label. The header's Console
   *                 control is asserted below instead.
   */
  ['dock steps', 'button[aria-label="Steps — Ordered structure"]'],
  ['dock canvas', 'button[aria-label="Canvas — Full-screen graph"]'],
  ['dock flows', 'button[aria-label="Flows — Switch flow"]'],
  ['dock nodes', 'button[aria-label="Nodes — Add step"]'],
  ['dock inspect', 'button[aria-label="Node config"], button[aria-label="Inspect — Node config"]'],
]

const HEADER_CONTROLS = [['workflow actions', 'button[aria-label="Workflow actions"]']]

// ─────────────────────────────────────────────────────── canonical truth (node)

const readSecret = async () => {
  for (const f of ['../api/.env.local', '../api/.env', '.env.local', '.env']) {
    try {
      const txt = await fs.readFile(path.resolve(process.cwd(), f), 'utf8')
      const m = txt.match(/^\s*(?:VITE_)?OPS_DASHBOARD_SECRET\s*=\s*(.+)$/m)
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
    } catch { /* next */ }
  }
  return null
}

/**
 * The catalog, as the API reports it. Read here rather than in the page so an
 * unreadable value fails the run instead of skipping an assertion.
 */
const canonicalTruth = async (secret) => {
  const res = await fetch(`${BASE}/api/cockpit/workflows`, {
    headers: { 'x-ops-dashboard-secret': secret },
  })
  if (!res.ok) throw new Error(`/api/cockpit/workflows -> HTTP ${res.status}`)
  const body = await res.json()
  if (body.ok !== true) throw new Error(`/api/cockpit/workflows -> ${JSON.stringify(body).slice(0, 200)}`)
  const workflows = body.data?.workflows ?? []
  if (!workflows.length) throw new Error('canonical catalog is empty — nothing to verify')

  return {
    count: workflows.length,
    durationMs: body.meta?.duration_ms ?? null,
    names: workflows.map((w) => w.name),
    /** §22 — can this workflow actually be entered, per the real matcher? */
    matchable: workflows.filter((w) => w.trigger_matchable === true).map((w) => w.name),
    neverFired: workflows.filter((w) => w.trigger_event_count === 0).map((w) => w.name),
    unmeasured: workflows.filter((w) => w.trigger_event_count == null).map((w) => w.name),
    /** §3 — which workflows can text a seller. */
    withSendNodes: workflows.filter((w) => (w.send_node_count ?? 0) > 0).map((w) => w.name),
    sendNodeTotal: workflows.reduce((n, w) => n + (w.send_node_count ?? 0), 0),
    draftCount: workflows.filter((w) => String(w.status ?? '').toLowerCase() === 'draft').length,
    statuses: workflows.reduce((m, w) => {
      const s = String(w.status ?? 'unknown').toLowerCase()
      m[s] = (m[s] ?? 0) + 1
      return m
    }, {}),
    liveSendEnabled: workflows.filter((w) => w.live_send_enabled === true).map((w) => w.name),
  }
}

// ───────────────────────────────────────────────────────────────── page probes

const PROBE = () => {
  const px = (n) => Math.round(n)
  const all = (sel) => [...document.querySelectorAll(sel)]
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: px(r.top), bottom: px(r.bottom), left: px(r.left), right: px(r.right), h: px(r.height), w: px(r.width) }
  }

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

  /** Is the element's own centre the topmost thing at that point? */
  const reachable = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return { present: false }
    const r = el.getBoundingClientRect()
    const cx = px(r.left + r.width / 2)
    const cy = px(r.top + r.height / 2)
    const hit = document.elementFromPoint(cx, cy)
    return {
      present: true,
      rect: { top: px(r.top), bottom: px(r.bottom) },
      inViewport: px(r.top) >= 0 && px(r.bottom) <= window.innerHeight
        && px(r.left) >= 0 && px(r.right) <= window.innerWidth,
      reachable: !!(hit && (hit === el || el.contains(hit))),
      blockedBy: hit && !(hit === el || el.contains(hit))
        ? `${hit.tagName}.${String(hit.className || '').split(' ').slice(0, 2).join('.')}`
        : null,
    }
  }

  const studio = document.querySelector('.wfs2--mobile-studio')
  const studioStyle = studio ? getComputedStyle(studio) : null

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    theme: document.documentElement.getAttribute('data-nexus-theme'),

    // §40 — did the mobile branch actually render at this width?
    mobileBranch: !!studio,
    desktopBranch: !!document.querySelector('.wfs2:not(.wfs2--mobile-studio)'),

    // §37 — geometry. The contract is that the studio consumes the root, and
    // sizes from it rather than from a viewport unit.
    studioRect: rect('.wfs2--mobile-studio'),
    studioHeightDecl: studioStyle ? studioStyle.height : null,
    studioPosition: studioStyle ? studioStyle.position : null,
    rootHeight: px(document.documentElement.getBoundingClientRect().height),
    coversViewport: studio
      ? px(studio.getBoundingClientRect().height) >= window.innerHeight - 1
      : null,

    // §38 — dock contracts. The global chrome and the studio's own.
    globalTopDock: rect('.nx-mobile-command-dock'),
    globalTopbar: rect('.nx-topbar'),
    globalTopbarHidden: (() => {
      const el = document.querySelector('.nx-topbar')
      if (!el) return 'absent'
      return getComputedStyle(el).display === 'none' ? 'display-none' : 'visible'
    })(),
    globalBottomDock: rect('.nx-pinned-app-dock'),
    studioDock: rect('.wfs2-mobile-dock'),
    chromeVars: {
      top: getComputedStyle(document.documentElement).getPropertyValue('--nx-mobile-chrome-top').trim() || null,
      bottom: getComputedStyle(document.documentElement).getPropertyValue('--nx-mobile-chrome-bottom').trim() || null,
    },

    controls: Object.fromEntries(
      [['workflow actions', 'button[aria-label="Workflow actions"]'],
       ['dock steps', 'button[aria-label="Steps — Ordered structure"]'],
       ['dock canvas', 'button[aria-label="Canvas — Full-screen graph"]'],
       ['dock flows', 'button[aria-label="Flows — Switch flow"]'],
       ['dock nodes', 'button[aria-label="Nodes — Add step"]']].map(([k, sel]) => [k, reachable(sel)]),
    ),

    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    imgCount: document.querySelectorAll('img').length,

    openSheets: all('.wfs2-mobile-sheet').map((el) => el.getAttribute('aria-label')),

    // §3/§4 — what the surface is claiming about each workflow.
    hero: document.querySelector('.wfs2-mobile-hero')?.innerText?.replace(/\s+/g, ' ').trim() ?? null,
    heroChips: all('.wfs2-mobile-hero__chip').map((e) => e.innerText.trim()),

    contrast: {
      heroName: contrast('.wfs2-mobile-hero__identity strong, .wfs2-mobile-hero__identity'),
      dockLabel: contrast('.wfs2-mobile-dock__btn span:last-child'),
    },
  }
}

/** The Flows sheet, once opened. Reads what each row claims. */
const PROBE_FLOWS = () => {
  const all = (sel) => [...document.querySelectorAll(sel)]
  const rows = all('.wfs2-nav__row')
  return {
    sheetOpen: !!document.querySelector('.wfs2-mobile-sheet[aria-label="Flows"]'),
    rowCount: rows.length,
    rows: rows.map((row) => ({
      name: row.querySelector('.wfs2-nav__row-copy strong')?.innerText.trim() ?? null,
      status: row.querySelector('.wfs2-nav__row-status')?.innerText.trim() ?? null,
      activation: row.querySelector('.wfs2-nav__row-activation')?.innerText.trim() ?? null,
      activationDetail: row.querySelector('.wfs2-nav__row-activation')?.getAttribute('title') ?? null,
      sends: row.querySelector('.wfs2-nav__row-sends')?.innerText.trim() ?? null,
    })),
    // The exact string the surface used to show for every published workflow.
    claimsActiveSafe: all('.wfs2-nav__row-status').some((e) => /^active safe$/i.test(e.innerText.trim())),
    anyClaimsArmed: all('.wfs2-nav__row-activation')
      .filter((e) => e.innerText.trim() === 'armed')
      .map((e) => e.closest('.wfs2-nav__row')?.querySelector('.wfs2-nav__row-copy strong')?.innerText.trim() ?? '?'),
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

/**
 * Wait for the STEADY state, not the first paint.
 *
 * The first version of this file waited a flat 3s and reported every dock
 * button reachable — because the workflow detail had not arrived yet. Once it
 * did, the canvas pre-selected nodes[0], which force-opened the Inspect sheet
 * and buried the whole dock. A harness that probes before the surface finishes
 * settling measures a state the operator never sees.
 */
const settle = async (page) => {
  await page.waitForFunction(
    () => !!document.querySelector('.wfs2--mobile-studio, .wfs2'),
    undefined,
    { timeout: 120_000 },
  ).catch(() => {})
  // The canvas has rendered real nodes, or the surface has told us it has none.
  await page.waitForFunction(() => {
    if (document.querySelector('.wfs2-canvas__node, .wfs2-node')) return true
    return /no workflow|select a workflow|no flows/i.test(document.body.innerText)
  }, undefined, { timeout: 120_000 }).catch(() => {})
  await page.waitForTimeout(2500)
  await page.evaluate(() => Promise.all(
    document.getAnimations().map((a) => { try { a.finish() } catch { /* infinite */ } return null }),
  )).catch(() => {})
  await page.waitForTimeout(400)
}

/** Real navigator rows, not the loading placeholder. */
const waitForFlowRows = async (page, timeout = 60_000) => {
  await page.waitForFunction(() => {
    if (document.querySelector('.wfs2-nav__row')) return true
    return /no flows in this view/i.test(document.body.innerText)
  }, undefined, { timeout }).catch(() => {})
  await page.waitForTimeout(600)
}

// ────────────────────────────────────────────────────────────────────── the run

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
  const consoleErrors = []
  const failedRequests = []
  const mapRequests = []

  const check = (name, ok, detail) => {
    if (!ok) findings.push({ cell: `${width}-${theme}`, check: name, detail })
    return ok
  }

  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 170)) })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 170)}`))
  page.on('request', (r) => {
    const u = r.url()
    if (u.includes('maps.googleapis.com') || u.includes('streetview')) mapRequests.push(u.slice(0, 120))
  })
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().replace(BASE, '').slice(0, 140)}`)
  })

  const t0 = Date.now()
  await page.goto(`${BASE}/workflow-studio`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await settle(page)
  const loadMs = Date.now() - t0

  const p = await page.evaluate(PROBE)
  await page.screenshot({ path: path.join(out, '01-canvas.png'), fullPage: false })

  // ── §40 the mobile branch must actually be the one that renders
  check('mobile branch renders', p.mobileBranch, `studio=${p.mobileBranch} desktop=${p.desktopBranch}`)
  check('viewport is the requested width', p.viewport.w === width, JSON.stringify(p.viewport))
  check('theme applied', p.theme === theme, `got ${p.theme}`)

  // ── §37 geometry.
  //
  // The contract is TILING, not coverage. The studio is one band between the
  // global top chrome and the global bottom dock; asserting it fills the whole
  // viewport is a desktop-lane assumption and fails on a correct layout
  // (measured 390x844: studio 53-822, bottom dock 824-844).
  const chromeTop = p.globalTopDock ? p.globalTopDock.bottom : 0
  if (p.studioRect) {
    check('studio starts at or below the global top chrome', p.studioRect.top >= chromeTop - 4,
      `studio top ${p.studioRect.top} vs chrome bottom ${chromeTop}`)
    check('studio does not overrun the viewport', p.studioRect.bottom <= p.viewport.h + 1,
      `studio bottom ${p.studioRect.bottom} vs viewport ${p.viewport.h}`)
    if (p.globalBottomDock) {
      check('studio does not run under the global bottom dock',
        p.studioRect.bottom <= p.globalBottomDock.top + 1,
        `studio bottom ${p.studioRect.bottom} vs dock top ${p.globalBottomDock.top}`)
      // Dead space between the two is wasted screen on a phone.
      const gap = p.globalBottomDock.top - p.studioRect.bottom
      check('no dead band between the studio and the bottom dock', gap <= 8, `${gap}px gap`)
    }
  }
  check('no horizontal overflow', p.horizontalOverflowPx === 0, `${p.horizontalOverflowPx}px`)

  // ── §38 the surface must come up with nothing modal in the way. The canvas
  // pre-selects nodes[0], which used to force the Inspect sheet open over a
  // fixed inset:0 z-10060 root and made every dock button unreachable.
  check('no sheet is open on load', p.openSheets.length === 0,
    `open on load: ${p.openSheets.join(', ')}`)

  // ── §38 dock contracts: the studio's dock must not be buried under the
  // shell's, and the shell's top chrome must not cover the studio header.
  if (p.studioDock && p.globalBottomDock) {
    const overlap = Math.min(p.studioDock.bottom, p.globalBottomDock.bottom)
      - Math.max(p.studioDock.top, p.globalBottomDock.top)
    check('studio dock does not collide with the global bottom dock', overlap <= 0,
      `overlap ${Math.round(overlap)}px — studio ${JSON.stringify(p.studioDock)} global ${JSON.stringify(p.globalBottomDock)}`)
  }
  check('studio dock is inside the viewport', !p.studioDock || p.studioDock.bottom <= p.viewport.h + 1,
    JSON.stringify(p.studioDock))

  // ── reachability, not geometry
  for (const [label, probe] of Object.entries(p.controls)) {
    if (!probe.present) {
      // Inspect is conditional on a selected node; the rest are unconditional.
      if (label === 'dock inspect') continue
      check(`${label} is present`, false, 'not in the DOM')
      continue
    }
    check(`${label} is reachable at its own centre`, probe.reachable,
      `blocked by ${probe.blockedBy} rect=${JSON.stringify(probe.rect)}`)
    check(`${label} is inside the viewport`, probe.inViewport, JSON.stringify(probe.rect))
  }

  // ── no Street View / Maps billing on this surface
  check('no Google Maps requests', mapRequests.length === 0, mapRequests.slice(0, 3).join(', '))

  // ── §3/§4 list truth, via the Flows sheet
  let flows = null
  const flowsBtn = page.locator('button[aria-label="Flows — Switch flow"]')
  if (await flowsBtn.count()) {
    await flowsBtn.first().click()
    await waitForFlowRows(page)
    flows = await page.evaluate(PROBE_FLOWS)
    await page.screenshot({ path: path.join(out, '02-flows.png'), fullPage: false })

    check('flows sheet lists the canonical catalog', flows.rowCount === canonical.count,
      `sheet ${flows.rowCount} vs canonical ${canonical.count}`)

    // The regression this phase exists to close.
    check('no workflow is labelled "active safe"', flows.claimsActiveSafe === false,
      'a published workflow that cannot be entered was presented as active')

    // §22 — "armed" may only appear where the real matcher would select it.
    const wrongfullyArmed = flows.anyClaimsArmed.filter((n) => !canonical.matchable.includes(n))
    check('only matchable workflows claim to be armed', wrongfullyArmed.length === 0,
      `claimed armed but not matchable: ${wrongfullyArmed.join(', ')}`)

    // §3 — send capability must match the graph, not a hardcoded zero.
    const claimingSends = flows.rows.filter((r) => r.sends && !/unknown/.test(r.sends)).map((r) => r.name)
    const missing = canonical.withSendNodes.filter((n) => !claimingSends.includes(n))
    const extra = claimingSends.filter((n) => !canonical.withSendNodes.includes(n))
    check('send-capable workflows are marked, and only those', missing.length === 0 && extra.length === 0,
      `missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`)

    // Every row must say something about whether it can run.
    const silent = flows.rows.filter((r) => !r.activation).map((r) => r.name)
    check('every row reports its activation state', silent.length === 0, silent.slice(0, 5).join(', '))

    // ── search narrows the real list, and clearing restores it byte-for-byte
    const search = page.locator('input[aria-label="Search workflows"]')
    if (await search.count()) {
      await search.first().fill('Underwriting')
      await page.waitForTimeout(700)
      const narrowed = await page.evaluate(PROBE_FLOWS)
      const expected = canonical.names.filter((n) => /underwriting/i.test(n)).length
      check('search narrows to the matching workflows', narrowed.rowCount === expected,
        `search "Underwriting" -> ${narrowed.rowCount} rows, canonical has ${expected}`)
      check('search matches by name, not by accident', narrowed.rows.every((r) => /underwriting/i.test(r.name ?? '')),
        narrowed.rows.map((r) => r.name).join(', '))

      // A term that cannot match must empty the list rather than fall back to
      // showing everything — a filter that silently ignores itself is worse
      // than one that returns nothing.
      await search.first().fill('zzzznotaworkflow')
      await page.waitForTimeout(700)
      const empty = await page.evaluate(PROBE_FLOWS)
      check('a zero-match search shows nothing rather than everything', empty.rowCount === 0,
        `${empty.rowCount} rows survived an impossible search`)

      await search.first().fill('')
      await page.waitForTimeout(700)
      const restored = await page.evaluate(PROBE_FLOWS)
      check('clearing search restores the full list', restored.rowCount === canonical.count,
        `${restored.rowCount} of ${canonical.count} after clearing`)
    } else {
      check('flows search input exists', false, 'the list cannot be narrowed on mobile')
    }


    // ── filter tabs must agree with the canonical statuses they claim to select
    // Fail closed. A missing tab must not make this assertion disappear — the
    // silent-skip guard is how six count checks quietly stopped running on the
    // Campaign Command harness.
    // On mobile each tab carries its own count badge, so the label is "Draft 7"
    // rather than "Draft" — an anchored /^Draft$/ matched nothing and the
    // `if (count)` guard then skipped the assertion entirely. Fail closed.
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('.wfs2-nav__tab')].map((el) => ({
        label: el.innerText.replace(/\s+/g, ' ').trim(),
        badge: el.querySelector('.wfs2-nav__tab-count')?.innerText.trim() ?? null,
      })))
    check('the mobile filter tabs are present', tabs.length > 0, 'no filter tabs at all')
    const draftIndex = tabs.findIndex((t) => /^draft\b/i.test(t.label))
    check('a Draft filter tab exists', draftIndex >= 0, `tabs: ${tabs.map((t) => t.label).join(' | ')}`)

    if (draftIndex >= 0) {
      // The badge is a count, so it must agree with the list it filters.
      check('the Draft tab badge matches the canonical draft count',
        Number(tabs[draftIndex].badge) === canonical.draftCount,
        `badge ${tabs[draftIndex].badge} vs canonical ${canonical.draftCount}`)

      await page.locator('.wfs2-nav__tab').nth(draftIndex).click()
      await page.waitForTimeout(700)
      const drafts = await page.evaluate(PROBE_FLOWS)
      check('the Draft tab selects exactly the draft workflows',
        drafts.rowCount === canonical.draftCount,
        `${drafts.rowCount} rows vs canonical draft count ${canonical.draftCount}`)
      check('every row under the Draft tab is a draft',
        drafts.rows.every((r) => /draft/i.test(r.status ?? '')),
        drafts.rows.map((r) => `${r.name}=${r.status}`).join(', ').slice(0, 200))
    }
  } else {
    check('flows dock button exists', false, 'cannot verify list truth without it')
  }

  // The Flows sheet is a modal — its backdrop legitimately intercepts the
  // header, so it has to be dismissed before the header checks. (That
  // interception is correct for a sheet the OPERATOR opened; the defect was a
  // sheet opening by itself on load.)
  const closeSheet = page.locator('.wfs2-mobile-sheet__close')
  if (await closeSheet.count()) {
    await closeSheet.first().click()
    await page.waitForTimeout(700)
  }
  const stillOpen = await page.evaluate(() => document.querySelectorAll('.wfs2-mobile-sheet').length)
  check('an open sheet can be dismissed', stillOpen === 0, `${stillOpen} sheet(s) still open`)

  // ── a fabricated run may never be presented as a live one.
  //
  // The header toggle cycles off -> live -> demo, and demo mode paints
  // synthetic tokens ("Demo Seller", "123 Demo St", demo-run-1) onto the
  // canvas. The hero chip was fed `liveMode !== 'off'`, so both states rendered
  // "Live overlay" — two taps put fake runs on screen labelled as real, on an
  // engine that has nothing in flight.
  const liveToggle = page.locator('.wfs2-mobile-hero__action').filter({ hasText: /live/i })
  const toggleCount = await liveToggle.count()
  check('the live-mode toggle is present', toggleCount > 0, 'cannot verify demo labelling without it')
  if (toggleCount > 0) {
    const chips = async () => page.evaluate(() =>
      [...document.querySelectorAll('.wfs2-mobile-hero__chip')].map((el) => ({
        text: el.innerText.replace(/\s+/g, ' ').trim(),
        demo: el.classList.contains('is-demo'),
        live: el.classList.contains('is-live'),
      })))

    await liveToggle.first().click()           // -> live
    await page.waitForTimeout(900)
    const liveChips = await chips()
    check('live mode is labelled live', liveChips.some((c) => c.live && /live/i.test(c.text)),
      JSON.stringify(liveChips))

    await liveToggle.first().click()           // -> demo
    await page.waitForTimeout(900)
    const demoChips = await chips()
    check('demo mode is labelled as sample data, not as live',
      demoChips.some((c) => c.demo && /not real runs/i.test(c.text)),
      JSON.stringify(demoChips))
    check('demo mode never claims to be a live overlay',
      !demoChips.some((c) => c.live), JSON.stringify(demoChips))

    // Any fabricated token on the canvas must be reachable only under that
    // label — never while the surface says live.
    const fabricated = await page.evaluate(() =>
      /Demo Seller|123 Demo St/.test(document.body.innerText))
    check('fabricated tokens only appear under the sample-data label',
      !fabricated || demoChips.some((c) => c.demo), 'demo tokens rendered without the sample-data chip')

    await liveToggle.first().click()           // -> off
    await page.waitForTimeout(600)
  }

  // ── contrast, both themes
  for (const [what, ratio] of Object.entries(p.contrast)) {
    if (ratio == null) continue
    check(`${what} contrast >= 4.5`, ratio >= 4.5, `${ratio}:1`)
  }

  // ── no runtime noise
  const realErrors = consoleErrors.filter((e) => !/favicon|ResizeObserver loop/i.test(e))
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
  const realFailures = failedRequests.filter((r) => !/favicon/.test(r))
  check('no failed requests', realFailures.length === 0, realFailures.slice(0, 4).join(' | '))

  // ── §24/§25 subject scoping. Opened from a subject, the surface must show
  // THAT subject's automation or say there is none — never the first workflow
  // in the catalog, which is what it used to do.
  const subjectProbe = async (threadKey) => {
    const subjectPage = await context.newPage()
    try {
      await subjectPage.goto(`${BASE}/workflow-studio?thread_key=${encodeURIComponent(threadKey)}`,
        { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await subjectPage.waitForTimeout(7000)
      return await subjectPage.evaluate(() => ({
        emptyState: document.querySelector('.wfs2-mobile-empty.is-subject-empty')?.innerText
          ?.replace(/\s+/g, ' ').trim() ?? null,
        heroText: document.querySelector('.wfs2-mobile-hero')?.innerText?.replace(/\s+/g, ' ').trim() ?? null,
        canvasNodes: document.querySelectorAll('.wfs2-canvas__node, .wfs2-node').length,
      }))
    } finally {
      await subjectPage.close()
    }
  }

  const withAutomation = await subjectProbe(SUBJECT_WITH_AUTOMATION)
  check('a subject WITH automation shows its own workflow, not an empty state',
    withAutomation.emptyState === null,
    `empty state shown: ${withAutomation.emptyState}`)
  /**
   * §16 — a phone opens on the STRUCTURE, so the canvas has no nodes until it is
   * asked for. The claim worth testing is that the subject's automation is
   * rendered at all, which the hero assertion below carries. Asserting canvas
   * nodes here would be asserting the very default §16 removed.
   */
  check('a subject WITH automation names the test fixture, not the first catalog entry',
    /Runtime Proof/i.test(withAutomation.heroText ?? ''),
    `hero: ${String(withAutomation.heroText).slice(0, 120)}`)

  const withoutAutomation = await subjectProbe(SUBJECT_WITHOUT_AUTOMATION)
  check('a subject with NO automation says so explicitly',
    /no active automation for this opportunity/i.test(withoutAutomation.emptyState ?? ''),
    `empty state: ${withoutAutomation.emptyState}`)
  check('a subject with NO automation does not fall back to any workflow graph',
    withoutAutomation.canvasNodes === 0,
    `${withoutAutomation.canvasNodes} canvas nodes rendered for a subject with no automation`)
  check('a subject with NO automation does not name a workflow in the header',
    !/Runtime Proof|Master Acquisition|Inbound Classification/i.test(withoutAutomation.heroText ?? ''),
    `hero: ${String(withoutAutomation.heroText).slice(0, 120)}`)

  await context.close()
  return { cell: `${width}-${theme}`, loadMs, probe: p, flows, findings, subjects: { withAutomation, withoutAutomation } }
}

const main = async () => {
  const secret = await readSecret()
  if (!secret) throw new Error('OPS_DASHBOARD_SECRET not found — canonical truth is unreadable, so this run would prove nothing')
  const canonical = await canonicalTruth(secret)

  console.log('CANONICAL (API, read from node)')
  console.log(`  workflows            ${canonical.count}  (${canonical.durationMs}ms)`)
  console.log(`  statuses             ${JSON.stringify(canonical.statuses)}`)
  console.log(`  matchable            ${canonical.matchable.length}  ${JSON.stringify(canonical.matchable)}`)
  console.log(`  trigger never fired  ${canonical.neverFired.length}`)
  console.log(`  trigger unmeasured   ${canonical.unmeasured.length}`)
  console.log(`  with send nodes      ${canonical.withSendNodes.length} (${canonical.sendNodeTotal} nodes) ${JSON.stringify(canonical.withSendNodes)}`)
  console.log(`  live_send_enabled    ${canonical.liveSendEnabled.length}`)
  console.log('')

  const browser = await chromium.launch()
  const results = []
  try {
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        const r = await runCell(browser, width, theme, canonical)
        results.push(r)
        const status = r.findings.length ? `FAIL (${r.findings.length})` : 'PASS'
        console.log(`${r.cell.padEnd(12)} ${String(status).padEnd(10)} load ${r.loadMs}ms  rows ${r.flows?.rowCount ?? '-'}  branch ${r.probe.mobileBranch ? 'mobile' : 'DESKTOP'}`)
        for (const f of r.findings) console.log(`   ✗ ${f.check}: ${f.detail}`)
      }
    }
  } finally {
    await browser.close()
  }

  const total = results.reduce((n, r) => n + r.findings.length, 0)
  console.log('')
  console.log(`MATRIX ${results.filter((r) => !r.findings.length).length}/${results.length} cells clean, ${total} finding(s)`)

  // One representative geometry dump, so a failure is diagnosable from the log.
  const sample = results.find((r) => r.probe.mobileBranch) ?? results[0]
  if (sample) {
    console.log('')
    console.log(`GEOMETRY (${sample.cell})`)
    console.log(`  studio            ${JSON.stringify(sample.probe.studioRect)} height:${sample.probe.studioHeightDecl} position:${sample.probe.studioPosition}`)
    console.log(`  viewport          ${JSON.stringify(sample.probe.viewport)}`)
    console.log(`  global topbar     ${sample.probe.globalTopbarHidden} ${JSON.stringify(sample.probe.globalTopbar)}`)
    console.log(`  global top dock   ${JSON.stringify(sample.probe.globalTopDock)}`)
    console.log(`  global bottom dock${JSON.stringify(sample.probe.globalBottomDock)}`)
    console.log(`  studio dock       ${JSON.stringify(sample.probe.studioDock)}`)
    console.log(`  chrome vars       ${JSON.stringify(sample.probe.chromeVars)}`)
    if (sample.flows) {
      console.log('')
      console.log(`FLOWS ROWS (${sample.cell})`)
      for (const r of sample.flows.rows) {
        console.log(`  ${String(r.status).padEnd(26)} ${String(r.activation).padEnd(13)} ${String(r.sends ?? '').padEnd(13)} ${r.name}`)
      }
    }
  }

  await fs.writeFile(
    path.join(OUT_ROOT, 'result.json'),
    JSON.stringify({ canonical, results, generated_at: new Date().toISOString() }, null, 2),
  )

  if (total > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
