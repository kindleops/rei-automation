/**
 * FINAL-FRONTEND-LOCK-1 §9/§10/§12/§26/§27 — shell, notifications, PWA, cache.
 *
 * READ ONLY (§36). Opens the notification centre and reads it. It does NOT
 * mark read, dismiss, snooze or run any notification action, because those
 * persist to notification_events and would mutate production state.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const BASE = arg('base', 'http://localhost:5174')
const OUT = path.resolve('artifacts/shell-notifications')
await fs.mkdir(OUT, { recursive: true })

const readSecret = async () => {
  for (const f of ['.env.local', '.env', '.env.development']) {
    try {
      const txt = await fs.readFile(path.resolve(process.cwd(), f), 'utf8')
      const m = txt.match(/^\s*(?:VITE_)?OPS_DASHBOARD_SECRET\s*=\s*(.+)$/m)
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '')
    } catch {}
  }
  return null
}
const secret = await readSecret()

const findings = []
const check = (cell, n, ok, d) => { if (!ok) findings.push({ cell, n, d }); return ok }

// ── canonical notification truth, service-side ───────────────────────────────
let truth = null
if (secret) {
  const res = await fetch(`${BASE}/api/cockpit/notifications?limit=120`, {
    headers: { 'x-ops-dashboard-secret': secret },
  })
  const body = await res.json().catch(() => null)
  /**
   * Derive unread the way the CLIENT does.
   *
   * The envelope carries no `unread_count`, and the raw rows' `status` is
   * 'active' / 'dismissed' — there is no 'unread' status in the table. An
   * earlier version of this harness read `body.unread_count`, got null, and I
   * briefly concluded the badge was structurally dead. It is not:
   * deriveNotificationStatus() in notification-contract.ts maps
   * read_at === null (and not dismissed/snoozed) to 'unread', and the client
   * filters that DERIVED status. Read the mapper, not the column.
   *
   * Note this is PAGE-scoped, exactly like the client: unread counts within the
   * fetched window, which the badge caps at 99+ anyway.
   */
  const rows = Array.isArray(body?.notifications) ? body.notifications : []
  const derivedUnread = rows.filter((r) => {
    if (r.snoozed_until && new Date(r.snoozed_until) > new Date()) return false
    if (r.status === 'dismissed' || r.dismissed_at) return false
    return !r.read_at
  }).length
  truth = {
    status: res.status,
    ok: body?.ok,
    count: rows.length,
    unread: derivedUnread,
    total: body?.total ?? null,
  }
  console.log(`CANONICAL notifications  http=${truth.status} ok=${truth.ok} returned=${truth.count} unread=${truth.unread} total=${truth.total}`)
  check('api', '§8 the notification authority responds', truth.status === 200, `http ${truth.status}`)
  check('api', '§10 unread is a real number, not absent', typeof truth.unread === 'number', `unread=${truth.unread}`)
}

// ── §26/§27 static shell assets ──────────────────────────────────────────────
for (const [label, url, test] of [
  ['manifest', `${BASE}/manifest.webmanifest`, (t) => { const j = JSON.parse(t); return !!(j.name || j.short_name) }],
  ['service worker', `${BASE}/sw.js`, (t) => t.length > 0],
]) {
  const res = await fetch(url).catch(() => null)
  const body = res && res.ok ? await res.text().catch(() => '') : ''
  let valid = false
  try { valid = !!body && test(body) } catch { valid = false }
  console.log(`PWA ${label.padEnd(15)} http=${res?.status ?? 'ERR'} valid=${valid}`)
  check('pwa', `§26 ${label} is served and parseable`, !!res?.ok && valid, `http ${res?.status}`)
}

const browser = await chromium.launch()

async function run(label, { width, desktop }) {
  /**
   * Desktop must NOT be tested on /inbox. NexusTopBar sets
   * `showGlobalBell = routePath !== '/inbox' && !isMobile`, so the global bell
   * is deliberately suppressed there (the inbox owns its own chrome). Probing
   * /inbox on desktop found no control and reported the centre as failing to
   * open, when the control is correctly absent by design.
   */
  const route = desktop ? '/queue' : '/inbox'
  const context = await browser.newContext({
    viewport: { width, height: desktop ? 900 : 844 },
    isMobile: !desktop, hasTouch: !desktop, deviceScaleFactor: desktop ? 1 : 2,
    timezoneId: 'America/Phoenix',
    userAgent: desktop ? undefined
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)))

  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForSelector('#root > *', { timeout: 45_000 })
  await page.waitForTimeout(6000)

  // ── §27 no stale-chunk failures after deploy ───────────────────────────────
  const chunkErrors = errors.filter((e) => /Failed to fetch dynamically imported module|Loading chunk|ChunkLoadError|MIME type/i.test(e))
  check(label, '§27 no stale/failed JS chunk loads', chunkErrors.length === 0, chunkErrors.join(' | '))

  // ── §15 the global error boundary is installed ──────────────────────────────
  const boundary = await page.evaluate(() => {
    // The app must not have rendered a blank root.
    const root = document.querySelector('#root')
    return { children: root?.children.length ?? 0, bodyChars: (document.body.innerText || '').trim().length }
  })
  check(label, '§15 the shell rendered (root not blank)', boundary.children > 0 && boundary.bodyChars > 50, JSON.stringify(boundary))

  // ── §9 open the notification centre ────────────────────────────────────────
  const bellSel = desktop
    ? '.nx-notification-control button, .nx-notification-control [role="button"], [aria-label*="otification" i], [title*="otification" i]'
    : '.nx-mobile-command-dock__btn'
  const opened = await page.evaluate((sel) => {
    const candidates = [...document.querySelectorAll(sel)]
    // Find the control that owns the bell glyph rather than guessing by index.
    const bell = candidates.find((b) => /bell/i.test(b.innerHTML) || /otification/i.test(b.getAttribute('aria-label') ?? ''))
      ?? candidates.find((b) => b.querySelector('svg'))
    if (!bell) return { found: false }
    bell.click()
    return { found: true, label: bell.getAttribute('aria-label') ?? bell.textContent?.trim()?.slice(0, 30) ?? null }
  }, bellSel)
  await page.waitForTimeout(2500)

  const centre = await page.evaluate(() => {
    const el = document.querySelector('.lcnc, [class*="lcnc-"], [class*="notification-center"]')
    if (!el) return { present: false }
    const b = el.getBoundingClientRect()
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim()
    return {
      present: true,
      visible: b.width > 0 && b.height > 0,
      w: Math.round(b.width), h: Math.round(b.height),
      inViewport: b.left >= -2 && b.right <= window.innerWidth + 2,
      cards: el.querySelectorAll('[class*="lcnc-card"]').length,
      statesUnavailable: /feed unavailable/i.test(txt),
      statesAllClear: /all clear/i.test(txt),
      txt: txt.slice(0, 140),
    }
  })

  check(label, '§9 a notification control exists', opened.found, 'no bell control found')
  if (opened.found) {
    check(label, '§9 the notification centre opens', centre.present && centre.visible,
      `${JSON.stringify(centre)} (clicked: ${opened.label})`)
    if (centre.present) {
      check(label, '§9 the centre fits the viewport', centre.inViewport !== false, `w=${centre.w}`)
      /**
       * §10 — the centre must never present a failed read as a healthy empty
       * feed. "All clear" and "Feed unavailable" are different claims.
       */
      if (truth && truth.status !== 200) {
        check(label, '§10 a failed feed is not shown as All clear', !centre.statesAllClear, centre.txt)
      }
      if (truth && truth.unread === 0 && truth.status === 200) {
        check(label, '§10 a genuinely empty feed is not shown as unavailable', !centre.statesUnavailable, centre.txt)
      }
    }
  }

  // ── §10 badge must not assert a count the authority does not have ──────────
  /**
   * The NOTIFICATION badge only. A `[class*="badge"]` fallback matched a lead
   * tag ("Tired Landlord") on the inbox and reported it as the badge value.
   */
  const badge = await page.evaluate(() => {
    const el = document.querySelector('.nx-mobile-command-dock__badge, .nx-notification-control [class*="badge"]')
    return el ? (el.textContent || '').trim() : null
  })
  if (truth?.status === 200 && typeof truth.unread === 'number' && !desktop) {
    if (truth.unread === 0) {
      check(label, '§10 no badge is shown when unread is 0', badge === null || badge === '' || badge === '0',
        `badge=${JSON.stringify(badge)} canonical unread=0`)
    } else {
      check(label, '§10 badge matches the canonical unread count',
        badge === String(truth.unread) || badge === '99+',
        `badge=${JSON.stringify(badge)} canonical=${truth.unread}`)
    }
  }

  console.log(`${label.padEnd(16)} route=${route} bell=${opened.found} centre=${centre.present ? `${centre.w}x${centre.h}` : 'absent'} cards=${centre.cards ?? '-'} badge=${JSON.stringify(badge)} allClear=${centre.statesAllClear} unavailable=${centre.statesUnavailable} err=${errors.length}`)
  if (centre.present) console.log(`   centre: ${centre.txt}`)

  await page.screenshot({ path: path.join(OUT, `notifications-${label}.png`) }).catch(() => {})
  await context.close()
}

await run('mobile-390', { width: 390, desktop: false })
await run('desktop-1440', { width: 1440, desktop: true })

await browser.close()
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ truth, findings }, null, 2))

console.log('\n' + '─'.repeat(70))
if (findings.length === 0) console.log('PASS — shell, notifications, PWA and cache')
else {
  console.log(`FAIL — ${findings.length} finding(s)`)
  for (const f of findings) console.log(`  [${f.cell}] ${f.n}\n      ${f.d}`)
}
process.exit(findings.length === 0 ? 0 : 1)
