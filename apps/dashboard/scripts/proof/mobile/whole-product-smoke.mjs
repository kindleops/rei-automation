/**
 * FINAL-FRONTEND-LOCK-1 §32/§34 — whole-product route + system smoke.
 *
 * PERMANENT HARNESS. Keep this for future releases.
 *
 * READ ONLY (§36). It navigates and reads; it never sends, never mutates a
 * seller, never writes a closing. The only state it touches is the local theme
 * preference used to exercise dark/light.
 *
 * Usage:
 *   node scripts/proof/mobile/whole-product-smoke.mjs --base=https://ops.leadcommand.ai
 *   ... --width=390 --theme=dark        # single cell
 *   ... --desktop                        # one 1440 desktop sanity pass
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`)) ??
    (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : null)
  return hit ? hit.replace(`--${name}=`, '') : fallback
}
const has = (name) => process.argv.includes(`--${name}`)
const list = (raw, fb) => (raw ? String(raw).split(',').map((v) => v.trim()).filter(Boolean) : fb)

const BASE = arg('base', 'http://localhost:5174')
const DESKTOP = has('desktop')
const WIDTHS = DESKTOP ? [Number(arg('width', '1440'))] : list(arg('width'), ['375', '390', '430']).map(Number)
const THEMES = list(arg('theme'), DESKTOP ? ['dark'] : ['dark', 'light'])

const OUT = path.resolve('artifacts/whole-product')
await fs.mkdir(OUT, { recursive: true })

/**
 * The canonical production surfaces.
 *
 * `sig` is a TEXT signature the intended app produces, and `mount` is the
 * shell/view class the ROUTER sets. Together they prove the right app mounted:
 * the class alone cannot discriminate (several apps share the inbox shell by
 * design) and the text alone is weaker than it looks.
 *
 * An earlier version also carried a `notSig` blacklist of other apps' names to
 * catch "silently fell back to another app". It produced ten false findings,
 * for two compounding reasons: the app launcher renders EVERY app's label into
 * the DOM on every route, and an app may legitimately offer "Open in Entity
 * Graph". A foreign app's NAME on a surface is not evidence of misrouting; the
 * router's own mount class is.
 */
const SURFACES = [
  { route: '/', name: 'Home/Conversation', sig: /inbox|thread|reply|seller|no subject/i, mount: '.nx-premium-inbox, .nx-inbox' },
  { route: '/inbox', name: 'Inbox', sig: /inbox|thread|reply|seller|all\b/i, mount: '.nx-premium-inbox, .nx-inbox' },
  { route: '/pipeline', name: 'Pipeline', sig: /pipeline/i, mount: '.nx-premium-inbox, .nx-inbox' },
  { route: '/entity-graph', name: 'Entity Graph', sig: /entity graph/i, mount: '.is-view-entity_graph' },
  { route: '/campaign-command', name: 'Campaign Command', sig: /campaign/i, mount: '.is-view-campaigns' },
  { route: '/workflow-studio', name: 'Workflow Studio', sig: /workflow|orchestrator|dry run/i, mount: '.is-view-workflow_studio' },
  { route: '/queue', name: 'Queue/Outbound', sig: /queue/i, mount: '.is-view-queue' },
  { route: '/buyer-match', name: 'Buyer Match', sig: /buyer/i, mount: '.is-view-buyer_match' },
  { route: '/email-command', name: 'Email Command', sig: /email/i, mount: '.is-view-email' },
  { route: '/calendar', name: 'Calendar', sig: /month|week|agenda|timeline/i, mount: '.nx-premium-inbox, .nx-inbox' },
  { route: '/analytics', name: 'Analytics', sig: /kpi|sent|delivered|repl/i, mount: '.nx-premium-inbox, .nx-inbox' },
  { route: '/closing-desk', name: 'Closing Desk', sig: /closing desk/i, mount: '.is-view-closing_desk' },
]

/**
 * Fabricated values and demo markers found and removed in earlier phases. If
 * any reappears on a production route, a demo surface is being served.
 * Deliberately excludes bare "$0", which is a legitimate measured zero.
 */
const DEMO_MARKERS = [
  '45,200', '45200', '42,100', '12,400', '11,800', '1,840',
  'Under Contract 42', 'Closed 18',
  'TC — Demo', 'Demo Title', 'DEMO DATA', 'Synthetic Demo', 'Synthetic Demo Data',
  'Lorem ipsum', 'placeholder', 'John Doe', 'Jane Doe', 'Acme',
]

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

const findings = []
const rows = []

/**
 * Settle on STABILITY, not on a fixed timeout and not on the absence of a
 * loading word. Two consecutive identical text lengths means the surface has
 * stopped changing; `/properties` needed ~12s, so a 5s sample reported it as
 * an infinite skeleton when it was merely slow.
 */
async function settle(page, { timeout = 45_000 } = {}) {
  const t0 = Date.now()
  let last = -1
  let stable = 0
  while (Date.now() - t0 < timeout) {
    await page.waitForTimeout(1500)
    const n = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').length)
      .catch(() => -1)
    if (n === last && n > 0) {
      if (++stable >= 2) return { ms: Date.now() - t0, chars: n, settled: true }
    } else {
      stable = 0
    }
    last = n
  }
  return { ms: Date.now() - t0, chars: last, settled: false }
}

const browser = await chromium.launch()

async function runCell(width, theme) {
  const cell = DESKTOP ? `desktop-${width}-${theme}` : `${width}-${theme}`
  const context = await browser.newContext({
    viewport: { width, height: DESKTOP ? 900 : 844 },
    isMobile: !DESKTOP, hasTouch: !DESKTOP, deviceScaleFactor: DESKTOP ? 1 : 2,
    timezoneId: 'America/Phoenix',
    userAgent: DESKTOP
      ? undefined
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript(setTheme, theme)
  const page = await context.newPage()

  for (const s of SURFACES) {
    const check = (n, ok, d) => { if (!ok) findings.push({ cell, route: s.route, n, d }); return ok }
    const errors = []
    const onErr = (e) => errors.push(String(e).slice(0, 130))
    page.on('pageerror', onErr)
    const apiReqs = []
    const onReq = (r) => { if (/\/api\//.test(r.url())) apiReqs.push(r.url().replace(BASE, '').split('?')[0]) }
    page.on('request', onReq)

    let status = null
    const onRes = (r) => {
      try { if (new URL(r.url()).pathname === s.route) status = r.status() } catch {}
    }
    page.on('response', onRes)

    let navFailed = null
    try {
      await page.goto(`${BASE}${s.route}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      await page.waitForSelector('#root > *', { timeout: 45_000 })
    } catch (e) {
      navFailed = String(e).slice(0, 140)
    }

    if (navFailed) {
      check('§3 route loads', false, navFailed)
      page.off('pageerror', onErr); page.off('request', onReq); page.off('response', onRes)
      rows.push({ cell, route: s.route, failed: navFailed })
      continue
    }

    const st = await settle(page)

    const p = await page.evaluate(({ demoMarkers, mount }) => {
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ')
      /**
       * Signature checks must read the APP region only.
       *
       * The app launcher/dock renders every app's LABEL into the DOM on every
       * route, so `body.innerText` contains "Entity Graph", "Closing Desk",
       * "Email Command" et al. no matter which app is mounted. Matching a
       * foreign app's name against the whole body reported a fallback-routing
       * defect on ten routes that were all rendering correctly.
       */
      const CHROME = '.nx-pinned-app-dock, .nx-mobile-command-dock, .nx-topbar,'
        + ' [class*="app-launcher"], [class*="AppLauncher"], [class*="launcher"],'
        + ' [class*="more-sheet"], [class*="settings-sheet"], [class*="search-overlay"],'
        // textContent on a clone includes inline <script> SOURCE; the demo-marker
        // scan would then match strings that exist only in code.
        + ' script, style, noscript, template'
      const clone = document.body.cloneNode(true)
      for (const n of clone.querySelectorAll(CHROME)) n.remove()
      // textContent, not innerText: a detached clone has no layout.
      const appTxt = (clone.textContent || '').replace(/\s+/g, ' ').trim()
      /** Hit-test at the control's own centre; geometry alone proves nothing. */
      const hit = (el) => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        if (b.width === 0 || b.height === 0) return { present: true, zero: true }
        const cx = Math.round(b.left + b.width / 2)
        const cy = Math.round(Math.min(Math.max(b.top + b.height / 2, 1), window.innerHeight - 1))
        const top = document.elementFromPoint(cx, cy)
        return {
          present: true,
          h: Math.round(b.height),
          top: Math.round(b.top),
          reachable: !!(top && (top === el || el.contains(top) || top.contains(el))),
          covering: top && !(top === el || el.contains(top) || top.contains(el))
            ? `${top.tagName.toLowerCase()}.${(top.className || '').toString().slice(0, 34)}`
            : null,
        }
      }
      // BOTH docks are measured. Querying them together returns only the
      // first, which hid that one dock can cover the other.
      const pinnedDock = document.querySelector('.nx-pinned-app-dock')
      const commandDock = document.querySelector('.nx-mobile-command-dock')
      return {
        mounted: !!document.querySelector(mount),
        text: txt,
        appText: appTxt,
        chars: txt.length,
        appChars: appTxt.length,
        overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        theme: document.documentElement.getAttribute('data-nexus-theme'),
        skeletons: document.querySelectorAll('[class*="skeleton"],[class*="skel"]').length,
        pinnedDock: hit(pinnedDock),
        commandDock: hit(commandDock),
        dockPresent: !!(pinnedDock || commandDock),
        commandDockCount: document.querySelectorAll('.nx-mobile-command-dock').length,
        pinnedDockCount: document.querySelectorAll('.nx-pinned-app-dock').length,
        // Scanned in the APP region so a dock label can never read as demo data.
        demo: demoMarkers.filter((m) => appTxt.toLowerCase().includes(m.toLowerCase())),
        demoBanner: !!document.querySelector('[data-testid$="-env-demo"],[data-testid="cd-env-demo"]'),
        /** A white-on-white / dark-on-dark smoke: body vs text colour. */
        contrast: (() => {
          const cs = getComputedStyle(document.body)
          return { bg: cs.backgroundColor, fg: cs.color }
        })(),
      }
    }, { demoMarkers: DEMO_MARKERS, mount: s.mount })

    // ── §3 route resolves and is not an error page ──────────────────────────
    check('§3 route does not 404/500', status === null || (status !== 404 && status < 500), `http ${status}`)

    // ── §3/§5 the INTENDED surface mounted ─────────────────────────────────
    check('§3 the intended surface rendered', s.sig.test(p.appText),
      `appChars=${p.appChars} head="${p.appText.slice(0, 90)}"`)
    check('§3/§5 the router mounted the intended view', p.mounted,
      `expected ${s.mount} — route fell back to another app or failed to mount`)

    // ── §16/§32 no infinite skeleton ────────────────────────────────────────
    check('§16 surface settled (no infinite loading)', st.settled, `after ${st.ms}ms chars=${st.chars}`)
    check('§16 surface rendered content', p.appChars > 60, `appChars=${p.appChars}`)

    // ── §2/§32 no demo or fabricated production data ────────────────────────
    check('§32 no demo/fabricated markers', p.demo.length === 0, p.demo.join(', '))
    check('§32 no demo banner', !p.demoBanner, 'demo banner present')

    // ── §19/§20/§32 mobile chrome ───────────────────────────────────────────
    check('§32 no page-wide horizontal overflow', p.overflow === 0, `overflow=${p.overflow}px`)
    if (!DESKTOP) {
      check('§20 an app dock is present', p.dockPresent, 'no dock element')
      /**
       * EXACTLY ONE of each dock. /analytics shipped TWO
       * `.nx-mobile-command-dock` elements — both fixed at top:0, z-index:150,
       * same 47px box — because the route was repointed at the inbox shell
       * without being added to INBOX_COMMAND_SHELL_ROUTES, so NexusTopBar and
       * PortableCommandShell each painted one. The buried dock's four controls
       * were permanently unclickable, and nothing about the page looked wrong.
       */
      check('§19 exactly one command dock', p.commandDockCount === 1, `count=${p.commandDockCount}`)
      check('§20 exactly one pinned dock', p.pinnedDockCount === 1, `count=${p.pinnedDockCount}`)
      for (const [label, d] of [['pinned', p.pinnedDock], ['command', p.commandDock]]) {
        if (!d || d.zero) continue
        check(`§20 the ${label} dock is reachable (hit-tested)`, d.reachable !== false,
          d.covering ? `covered by ${d.covering}` : JSON.stringify(d))
      }
    }

    // ── §17 theme propagates ────────────────────────────────────────────────
    check('§17 theme applied', p.theme === theme, `wanted=${theme} got=${p.theme}`)
    check('§17 body has a resolved colour (no transparent-on-transparent)',
      p.contrast.fg && p.contrast.fg !== 'rgba(0, 0, 0, 0)', JSON.stringify(p.contrast))

    // ── §32 no fatal page error ─────────────────────────────────────────────
    check('§32 no fatal page error', errors.length === 0, errors.slice(0, 2).join(' | '))

    // ── §31 request fan-out: sane scaling, not zero requests ────────────────
    const counts = apiReqs.reduce((m, u) => (m[u] = (m[u] || 0) + 1, m), {})
    const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
    const maps = apiReqs.filter((u) => /streetview|staticmap|maps/i.test(u)).length
    check('§31 no request storm on route load', apiReqs.length <= 60, `apiRequests=${apiReqs.length} worst=${JSON.stringify(worst)}`)
    check('§31 no per-row Street View fan-out', maps <= 3, `maps/streetview requests=${maps}`)

    rows.push({
      cell, route: s.route, name: s.name, status, chars: p.chars, settleMs: st.ms,
      overflow: p.overflow, theme: p.theme, apiRequests: apiReqs.length, maps,
      pinnedDockReachable: p.pinnedDock?.reachable ?? null,
      commandDockReachable: p.commandDock?.reachable ?? null,
      errors: errors.length, demo: p.demo,
      worstRepeat: worst ?? null,
    })

    console.log(`  ${s.route.padEnd(19)} http=${String(status ?? '-').padStart(3)} chars=${String(p.chars).padStart(5)} settle=${String(st.ms).padStart(5)}ms ovf=${p.overflow} api=${String(apiReqs.length).padStart(2)} maps=${maps} docks=${p.pinnedDockCount}/${p.commandDockCount} err=${errors.length}${p.demo.length ? '  DEMO:' + p.demo.join(',') : ''}`)

    page.off('pageerror', onErr); page.off('request', onReq); page.off('response', onRes)
  }

  await page.screenshot({ path: path.join(OUT, `shell-${cell}.png`) }).catch(() => {})
  await context.close()
}

for (const w of WIDTHS) {
  for (const t of THEMES) {
    console.log(`\n── cell ${DESKTOP ? 'desktop ' : ''}${w} ${t} ──────────────────────────────────────────`)
    await runCell(w, t)
  }
}
await browser.close()

await fs.writeFile(path.join(OUT, DESKTOP ? 'desktop.json' : 'mobile.json'),
  JSON.stringify({ base: BASE, rows, findings }, null, 2))

const cells = new Set(rows.map((r) => r.cell)).size
console.log('\n' + '─'.repeat(74))
if (findings.length === 0) {
  console.log(`PASS — ${cells} cell(s) x ${SURFACES.length} routes, 0 findings`)
} else {
  console.log(`FAIL — ${findings.length} finding(s) across ${cells} cell(s)`)
  const seen = new Map()
  for (const f of findings) {
    const k = `${f.route} :: ${f.n}`
    if (!seen.has(k)) seen.set(k, { ...f, cells: [] })
    seen.get(k).cells.push(f.cell)
  }
  for (const f of seen.values()) {
    console.log(`  ${f.route}  ${f.n}`)
    console.log(`      cells: ${f.cells.join(', ')}`)
    console.log(`      ${f.d}`)
  }
}
process.exit(findings.length === 0 ? 0 : 1)
