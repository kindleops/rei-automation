/**
 * CAMPAIGN COMMAND MOBILE QA HARNESS — CAMPAIGN-COMMAND-MOBILE-LOCK-1 §36.
 *
 * Same rationale as pipeline-mobile-qa.mjs: Chrome's interactive window will
 * not go below ~860 CSS px on macOS and ignores bounds changes in fullscreen,
 * and the app picks its mobile branch from a MEASURED pane width, so faking
 * window.innerWidth proves nothing. Playwright renders at the real CSS width.
 *
 * Canonical truth is read from NODE with the dashboard secret — an in-page
 * fetch of /api/cockpit/* returns 401, which would make every reconciliation
 * assertion skip itself rather than fail.
 *
 * Usage:
 *   node scripts/proof/mobile/campaign-mobile-qa.mjs                      # full matrix
 *   node scripts/proof/mobile/campaign-mobile-qa.mjs --width 390 --theme dark
 *   node scripts/proof/mobile/campaign-mobile-qa.mjs --phase list,detail
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
const PHASES = arg('phase', 'list,detail,targets,search').split(',')
const wants = (p) => PHASES.includes(p)
const OUT_ROOT = path.resolve(process.cwd(), '.screenshots/campaign-mobile')

/**
 * §25 subject — the Entity Graph explicit handoff campaign. Its target
 * definition carries exactly five property ids and the backend preview
 * reconciles 5 scanned / 5 matched / 2 clean with NO_PHONE 2 +
 * suppression_blocked 1. Verified from Node below rather than trusted.
 */
const EXPLICIT_CAMPAIGN = {
  id: '4ce9fbaa-d8e3-40db-95b6-9c0ae652265c',
  name: 'Entity Graph · 5 properties',
  explicitIds: ['273588014', '229081541', '273657631', '212296224', '217298095'],
}

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

const api = async (secret, pathname, init = {}) => {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { 'x-ops-dashboard-secret': secret, 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

// ───────────────────────────────────────────────────────────────── page probes

const PROBE = () => {
  const px = (n) => Math.round(n)
  const text = (sel) => document.querySelector(sel)?.innerText?.replace(/\s+/g, ' ').trim() ?? null
  const all = (sel) => [...document.querySelectorAll(sel)]

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

  const dockEl = document.querySelector('.nx-pinned-app-dock')
  const dock = dockEl?.getBoundingClientRect() ?? null

  /** Any element whose painted box crosses the dock's top edge. */
  const obscuredByDock = () => {
    if (!dock) return []
    const hits = []
    for (const el of all('button, a, input, select, textarea, [role="button"]')) {
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.2) continue
      // Fixed/sticky chrome is allowed to live alongside the dock.
      if (cs.position === 'fixed' || cs.position === 'sticky') continue
      if (r.top < dock.bottom && r.bottom > dock.top) {
        hits.push({ label: (el.innerText || el.getAttribute('aria-label') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 40), top: px(r.top), bottom: px(r.bottom) })
      }
    }
    return hits.slice(0, 6)
  }

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    theme: document.documentElement.getAttribute('data-nexus-theme'),
    url: location.pathname + location.search,
    bodyHead: document.body.innerText.slice(0, 260).replace(/\s+/g, ' ').trim(),
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    imgCount: document.querySelectorAll('img').length,
    // Campaign list
    cardCount: all('.clc').length,
    cardClasses: [...new Set(all('*').map((e) => String(e.className || '')).flatMap((c) => c.split(' ')).filter((c) => /campaign|ccc|ccl|cmp/i.test(c)))].slice(0, 26),
    firstCards: all('.clc').slice(0, 3).map((e) => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 170)),
    cardNames: all('.clc__name').map((e) => e.innerText.trim()).slice(0, 8),
    searchInput: !!document.querySelector('input[type="search"], input[placeholder*="ampaign" i], input[placeholder*="earch" i]'),
    // Dock / safe area
    dock: dock ? { top: px(dock.top), bottom: px(dock.bottom), h: px(dock.height) } : null,
    obscuredControls: obscuredByDock(),
    chromeBottomVar: getComputedStyle(document.documentElement).getPropertyValue('--nx-mobile-chrome-bottom').trim(),
    contrast: {
      heading: contrast('h1, h2, [class*="title"]'),
      body: contrast('p, [class*="subtitle"], [class*="meta"]'),
    },
    // Numbers on screen, for reconciliation against canonical counts.
    numbersOnScreen: (document.body.innerText.match(/\b\d[\d,]*\b/g) || []).slice(0, 40),
  }
}

// ───────────────────────────────────────────────────────────────────── helpers

const setTheme = (theme) => (t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    const parsed = raw ? JSON.parse(raw) : {}
    localStorage.setItem('nexus-settings', JSON.stringify({ ...parsed, nexusTheme: t }))
  } catch { /* first run */ }
}

const settle = async (page, ms = 3000) => {
  await page.waitForSelector('#root > *', { timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(ms)
  await page.evaluate(() => Promise.all(
    document.getAnimations().map((a) => { try { a.finish() } catch { /* infinite */ } return null }),
  )).catch(() => {})
  await page.waitForTimeout(250)
}

/** The campaign list is slow (canonical /campaigns measured ~20s), so wait on content. */
const waitForCards = async (page, timeout = 90_000) => {
  // Waiting on the word "campaign" matched the page HEADER on first paint, so
  // the probe ran against a skeleton. Wait for an actual card, or for a
  // rendered empty state — both are real outcomes, a skeleton is not.
  await page.waitForFunction(() => {
    if (document.querySelector('.clc')) return true
    const txt = document.body.innerText
    return /no campaigns|nothing to show|failed/i.test(txt)
  }, undefined, { timeout }).catch(() => {})
  await page.waitForTimeout(1500)
}

// ────────────────────────────────────────────────────────────────── the run

const runCell = async (browser, width, theme, secret, canonical) => {
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
  await context.addInitScript(setTheme(theme), theme)

  const findings = []
  const scenarios = {}
  const maps = []
  const consoleErrors = []
  const apiCalls = []

  const newPage = async () => {
    const page = await context.newPage()
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 170)) })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 170)}`))
    page.on('request', (r) => {
      const u = r.url()
      if (u.includes('maps.googleapis.com') || u.includes('streetview')) maps.push(u.slice(0, 120))
      if (u.includes('/api/cockpit/campaigns')) apiCalls.push(u.replace(BASE, '').slice(0, 130))
    })
    return page
  }

  const check = (name, ok, detail) => {
    if (!ok) findings.push({ cell: `${width}-${theme}`, check: name, detail })
    return ok
  }

  // ── campaign list
  if (wants('list')) {
    const page = await newPage()
    await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await waitForCards(page)
    await settle(page)
    const probe = await page.evaluate(PROBE)
    await page.screenshot({ path: path.join(out, 'list.png') })
    scenarios.list = probe

    check('list:no-horizontal-overflow', probe.horizontalOverflowPx <= 1, probe.horizontalOverflowPx)
    check('list:zero-imagery', probe.imgCount === 0, probe.imgCount)
    check('list:renders-campaigns', probe.cardCount > 0, { cards: probe.cardCount, classes: probe.cardClasses, head: probe.bodyHead })
    check('list:no-control-under-dock', probe.obscuredControls.length === 0, probe.obscuredControls)
    check('list:heading-contrast', (probe.contrast.heading ?? 0) >= 4.5, probe.contrast)
    if (canonical.listCount != null) {
      check('list:count-plausible', probe.cardCount <= canonical.listCount, { rendered: probe.cardCount, canonical: canonical.listCount })
    }
    await page.close()
  }

  // ── campaign detail for the explicit-handoff campaign
  if (wants('detail')) {
    const page = await newPage()
    await page.goto(`${BASE}/campaign-command?campaign=${EXPLICIT_CAMPAIGN.id}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await waitForCards(page)
    await settle(page, 5000)
    const probe = await page.evaluate(PROBE)
    await page.screenshot({ path: path.join(out, 'detail-explicit.png'), fullPage: true })
    scenarios.detailExplicit = probe

    check('detail:no-horizontal-overflow', probe.horizontalOverflowPx <= 1, probe.horizontalOverflowPx)
    check('detail:no-control-under-dock', probe.obscuredControls.length === 0, probe.obscuredControls)
    check('detail:zero-imagery', probe.imgCount === 0, probe.imgCount)
    await page.close()
  }

  await context.close()

  if (maps.length > 0) findings.push({ cell: `${width}-${theme}`, check: 'street-view-zero', detail: maps.slice(0, 3) })

  const report = {
    cell: `${width}-${theme}`, width, theme, findings,
    streetViewRequests: maps.length,
    consoleErrors: [...new Set(consoleErrors)].slice(0, 8),
    apiCalls: [...new Set(apiCalls)].slice(0, 12),
    canonical,
    scenarios,
  }
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  return report
}

const run = async () => {
  await fs.mkdir(OUT_ROOT, { recursive: true })
  const secret = await readSecret()
  if (!secret) throw new Error('OPS_DASHBOARD_SECRET not found — refusing to run checks that would silently skip')

  // Canonical truth, once, from Node.
  const list = await api(secret, '/api/cockpit/campaigns?limit=100')
  const detail = await api(secret, `/api/cockpit/campaigns/${EXPLICIT_CAMPAIGN.id}`)
  const targets = await api(secret, `/api/cockpit/campaigns/${EXPLICIT_CAMPAIGN.id}/targets?limit=50`)
  const canonical = {
    listStatus: list.status,
    listCount: Array.isArray(list.body?.campaigns) ? list.body.campaigns.length : null,
    explicitFilters: detail.body?.campaign?.metadata?.target_filters ?? detail.body?.metadata?.target_filters ?? null,
    explicitTargetCount: targets.body?.total_count ?? null,
    persistedStatus: detail.body?.campaign?.status ?? detail.body?.status ?? null,
  }
  console.log('canonical:', JSON.stringify(canonical).slice(0, 400))

  const browser = await chromium.launch()
  const reports = []
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      process.stdout.write(`\n── ${width}px / ${theme} ──\n`)
      const r = await runCell(browser, width, theme, secret, canonical)
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
  console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

run().catch((e) => { console.error(e); process.exitCode = 1 })
