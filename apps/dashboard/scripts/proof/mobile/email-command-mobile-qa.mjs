/**
 * EMAIL-COMMAND-MOBILE-LOCK-1 §40 — Email Command on mobile.
 *
 * Canonical truth is read from Node first (service-side), then the UI is
 * compared against it. Nothing here sends mail: the composer is exercised for
 * reachability and refusal only, and the send control is never clicked.
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
if (WIDTHS.some((w) => !Number.isInteger(w))) throw new Error(`--width must be integers`)

const OUT = path.resolve('artifacts/email-command-mobile')
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
  const res = await fetch(`${BASE}/api/cockpit/email/${p}`, { headers: { 'x-ops-dashboard-secret': secret } })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/**
 * §6 — two real subjects with different, non-overlapping email sets, plus one
 * that has none. Verified in the database: A has 5 addresses at 600 Raintree
 * Dr, B has 3 at 8002 W Weldon Ave, and an unknown property has 0.
 */
const SUBJECT_A = { id: '237787391', addressPart: 'Raintree' }
const SUBJECT_B = { id: '24563665', addressPart: 'Weldon' }
const SUBJECT_NONE = { id: '000-not-a-real-property', addressPart: null }

// ── canonical truth, service-side
const overview = await api('overview')
const records = await api('records?limit=25')
const threads = await api('threads?limit=25')
const templates = await api('templates')
const health = await api('brevo-health')

const subjectTruth = async (id) => {
  const r = await api(`records?limit=25&property_id=${encodeURIComponent(id)}`)
  return {
    status: r.status,
    count: r.body?.count ?? null,
    emails: (r.body?.records ?? []).map((x) => x.email),
    address: r.body?.records?.[0]?.property_address ?? null,
  }
}
const SUB_A = await subjectTruth(SUBJECT_A.id)
const SUB_B = await subjectTruth(SUBJECT_B.id)
const SUB_NONE = await subjectTruth(SUBJECT_NONE.id)

const TRUTH = {
  total: overview.body?.total_emails ?? null,
  eligible: overview.body?.email_eligible ?? null,
  suppressed: overview.body?.suppressed ?? null,
  recordCount: records.body?.count ?? null,
  recordRows: (records.body?.records ?? []).length,
  firstEmail: records.body?.records?.[0]?.email ?? null,
  threadCount: threads.body?.count ?? null,
  templateCount: (templates.body?.templates ?? []).length,
  providerConnected: health.body?.connected ?? null,
  providerMissing: health.body?.missing ?? [],
  sendEnabled: health.body?.send_enabled ?? null,
}

console.log('\nCANONICAL TRUTH (service-side)')
console.log(`  overview        http ${overview.status}  total=${TRUTH.total} eligible=${TRUTH.eligible} suppressed=${TRUTH.suppressed}`)
console.log(`  records         http ${records.status}  count=${TRUTH.recordCount} rows=${TRUTH.recordRows} first=${TRUTH.firstEmail}`)
console.log(`  threads         http ${threads.status}  count=${TRUTH.threadCount}`)
console.log(`  templates       http ${templates.status}  count=${TRUTH.templateCount}`)
console.log(`  provider        connected=${TRUTH.providerConnected} send_enabled=${TRUTH.sendEnabled} missing=${JSON.stringify(TRUTH.providerMissing)}`)
console.log(`  subject A       count=${SUB_A.count} addr=${SUB_A.address}`)
console.log(`  subject B       count=${SUB_B.count} addr=${SUB_B.address}`)
console.log(`  subject none    count=${SUB_NONE.count}`)

// §3 — no endpoint may 500
const findings = []
for (const [name, r] of [['overview', overview], ['records', records], ['threads', threads], ['templates', templates], ['brevo-health', health]]) {
  if (r.status !== 200) findings.push({ cell: 'api', n: `§3 ${name} must not fail`, d: `http ${r.status} ${JSON.stringify(r.body).slice(0, 160)}` })
  else if (r.body?.ok === false) findings.push({ cell: 'api', n: `§3 ${name} envelope ok:false`, d: JSON.stringify(r.body).slice(0, 160) })
}

// §6 — the subject scope must be real before the UI is judged against it.
if (SUB_A.count !== null) {
  if (!(SUB_A.count > 0 && SUB_B.count > 0))
    findings.push({ cell: 'api', n: '§6 both test subjects must have email records', d: `A=${SUB_A.count} B=${SUB_B.count}` })
  if (SUB_A.emails.some((e) => SUB_B.emails.includes(e)))
    findings.push({ cell: 'api', n: '§6 test subjects must not share addresses', d: 'overlap found' })
  if (SUB_NONE.count !== 0)
    findings.push({ cell: 'api', n: '§6 an unknown subject must yield ZERO, not the corpus', d: `${SUB_NONE.count}` })
}


/**
 * Seed the theme the way the APP reads it.
 *
 * Setting `data-nexus-theme` (and a `nexus:theme` key) is not enough: the
 * settings module persists under `nexus-settings` with a `nexusTheme` field
 * and reapplies it on boot, so the attribute was overwritten back to 'dark'
 * and every light cell measured dark. 'dark' and 'light' are both valid
 * NexusTheme values, so the real store is seeded and the attribute is set too
 * for the instant before the app boots.
 */
const setTheme = (t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    const settings = raw ? JSON.parse(raw) : {}
    localStorage.setItem('nexus-settings', JSON.stringify({ ...settings, nexusTheme: t }))
  } catch {}
  // documentElement can be null this early inside addInitScript; an unguarded
  // setAttribute here throws a pageerror that looks like an application fault.
  try { document.documentElement?.setAttribute('data-nexus-theme', t) } catch {}
  try {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement?.setAttribute('data-nexus-theme', t)
    })
  } catch {}
}

const browser = await chromium.launch()

async function runCell(width, theme) {
  const check = (n, ok, d) => { if (!ok) findings.push({ cell: `${width}-${theme}`, n, d }); return ok }
  const context = await browser.newContext({
    viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript(setTheme, theme)
  const page = await context.newPage()

  const maps = []
  page.on('request', (r) => {
    const u = r.url()
    if (/maps\.googleapis\.com|streetview|maps\/embed\/v1/.test(u)) maps.push(u.slice(0, 80))
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)))

  /**
   * §41 — measured, not asserted. Each figure is time-to-CONTENT for that
   * step, excluding the fixed settle waits that follow it.
   */
  const timings = {}
  const mark = async (name, fn) => {
    const t0 = Date.now()
    await fn()
    timings[name] = Date.now() - t0
  }

  await mark('shell', async () => {
    await page.goto(`${BASE}/email-command`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForSelector('.ecc', { timeout: 60_000 })
  })
  await page.waitForTimeout(4500)

  const openTab = async (label) => {
    const btn = page.locator('.ecc__tab', { hasText: label }).first()
    if (await btn.count() === 0) return false
    await btn.click()
    await page.waitForTimeout(1800)
    return true
  }

  const probe = () => page.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? null
    const reach = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      if (b.width === 0 || b.height === 0) return { visible: false }
      const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
      return { visible: true, w: Math.round(b.width), h: Math.round(b.height), reachable: !!(hit && (hit === el || el.contains(hit) || el.contains(hit))) }
    }
    return {
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      theme: document.documentElement.getAttribute('data-nexus-theme'),
      isMobile: document.querySelector('.ecc__inbox')?.classList.contains('is-mobile') ?? null,
      sectionTitle: txt('.ecc__section-title'),
      errorPanels: [...document.querySelectorAll('.ecc__error-panel')].map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)),
      emptyLabels: [...document.querySelectorAll('.ecc__empty-label')].map((e) => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 140)),
      kpis: [...document.querySelectorAll('.ecc__kpi-value')].map((e) => e.textContent.trim()),
      kpiLabels: [...document.querySelectorAll('.ecc__kpi-label')].map((e) => e.textContent.trim()),
      statusPills: [...document.querySelectorAll('.ecc__status-pill')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
      tableRows: document.querySelectorAll('.ecc__table tbody tr').length,
      firstEmailCell: txt('.ecc__table tbody tr td:nth-child(2)'),
      threadRows: document.querySelectorAll('.ecc__thread-list > div[class*="thread"]').length,
      loading: document.querySelectorAll('.ecc__loading').length,
      tabs: [...document.querySelectorAll('.ecc__tab')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
      searchInput: reach(document.querySelector('.ecc__search input')),
      dockTop: (() => { const e = document.querySelector('.nx-pinned-app-dock'); return e ? Math.round(e.getBoundingClientRect().top) : null })(),
      rawVars: (document.body.innerText.match(/\{\{[\w.]+\}\}/g) || []).slice(0, 5),
      bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
    }
  })

  // ── Overview
  const ov = await probe()
  check('theme applied', ov.theme === theme, `${ov.theme}`)
  check('no page-wide horizontal overflow', ov.overflow === 0, `${ov.overflow}px`)
  check('§28 overview shows the real corpus total, not a zero',
    TRUTH.total === null || ov.kpis.some((v) => v.replace(/,/g, '') === String(TRUTH.total)),
    `kpis=${ov.kpis.slice(0, 4).join(' | ')} canonical total=${TRUTH.total}`)
  check('§30 no error panel on a healthy overview', ov.errorPanels.length === 0, ov.errorPanels.join(' | '))
  check('§31 provider state is shown truthfully',
    TRUTH.providerConnected === true
      ? ov.statusPills.some((p) => /connected/i.test(p))
      : ov.statusPills.some((p) => /disconnected|degraded/i.test(p)),
    `pills=${ov.statusPills.join(' | ')} canonical connected=${TRUTH.providerConnected}`)
  check('§31 an unconfigured provider is never shown as Connected',
    !(TRUTH.providerConnected === false && ov.statusPills.some((p) => /\bconnected\b/i.test(p) && !/dis/i.test(p))),
    `pills=${ov.statusPills.join(' | ')}`)
  check('§21 no raw template variables anywhere on screen', ov.rawVars.length === 0, ov.rawVars.join(' '))
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-overview.png`) })

  // ── Records
  await mark('records', async () => {
    const btn = page.locator('.ecc__tab', { hasText: 'Records' }).first()
    if (await btn.count()) {
      await btn.click()
      // Waits for CONTENT — rows, an empty state, or an error — not a timer.
      await page.waitForFunction(
        () => document.querySelectorAll('.ecc__table tbody tr').length > 0 ||
              document.querySelector('.ecc__empty-panel') !== null ||
              document.querySelector('.ecc__error-panel') !== null,
        undefined, { timeout: 30_000 },
      ).catch(() => {})
    }
  })
  await page.waitForTimeout(1200)
  const rec = await probe()
  check('§28 the records header reports the corpus count, not the page length',
    TRUTH.recordCount === null || (rec.sectionTitle || '').replace(/,/g, '').includes(String(TRUTH.recordCount)),
    `title="${rec.sectionTitle}" canonical count=${TRUTH.recordCount}`)
  check('records render rows from the canonical read',
    TRUTH.recordRows === 0 || rec.tableRows > 0, `${rec.tableRows} rows, canonical page=${TRUTH.recordRows}`)
  check('the first row matches canonical ordering',
    !TRUTH.firstEmail || (rec.firstEmailCell || '').toLowerCase().includes(TRUTH.firstEmail.toLowerCase()),
    `ui="${rec.firstEmailCell}" canonical="${TRUTH.firstEmail}"`)
  check('§26 the records search control is reachable at its own centre',
    rec.searchInput?.visible && rec.searchInput?.reachable, JSON.stringify(rec.searchInput))
  check('§30 records show no error panel when the read succeeded',
    records.status === 200 ? rec.errorPanels.length === 0 : true, rec.errorPanels.join(' | '))
  check('no horizontal page overflow on records', rec.overflow === 0, `${rec.overflow}px`)
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-records.png`) })

  // ── §26 server-backed search
  if (rec.searchInput?.visible) {
    await mark('search', async () => {
      await page.fill('.ecc__search input', 'yahoo.com')
      await page.waitForFunction(
        () => !(document.querySelector('.ecc__section-title')?.textContent || '').includes('Loading'),
        undefined, { timeout: 30_000 },
      ).catch(() => {})
    })
    await page.waitForTimeout(1600)
    const searched = await probe()
    const canonical = await api('records?limit=25&search=yahoo.com')
    check('§26 search narrows against the server, not the loaded page',
      canonical.body?.count > 0 && (searched.sectionTitle || '').replace(/,/g, '').includes(String(canonical.body.count)),
      `title="${searched.sectionTitle}" canonical=${canonical.body?.count}`)
    await page.fill('.ecc__search input', 'zzz-no-such-address-zzz')
    await page.waitForTimeout(2600)
    const none = await probe()
    check('§30 a search with no matches says so and shows no error',
      none.errorPanels.length === 0 && none.tableRows === 0 && none.emptyLabels.length > 0,
      `rows=${none.tableRows} empty="${none.emptyLabels[0]}" errors=${none.errorPanels.length}`)
    await page.fill('.ecc__search input', '')
    await page.waitForTimeout(1800)
  }

  // ── Inbox
  await openTab('Inbox')
  const inbox = await probe()
  check('§38 the inbox uses its mobile layout', inbox.isMobile === true, `is-mobile=${inbox.isMobile}`)
  check('§30 an empty inbox explains WHY, not just "none"',
    TRUTH.threadCount > 0
      ? inbox.threadRows > 0
      : inbox.emptyLabels.some((l) => /no connected email account|not configured|sent or received/i.test(l)),
    `threads=${inbox.threadRows} canonical=${TRUTH.threadCount} empty="${inbox.emptyLabels.join(' | ')}"`)
  check('§30 an empty inbox is not reported as an error',
    threads.status === 200 ? inbox.errorPanels.length === 0 : true, inbox.errorPanels.join(' | '))
  check('§37 the message list makes NO Street View request',
    maps.length === 0, `${maps.length} requests :: ${maps.join(' | ') || 'none'}`)
  check('no horizontal page overflow on the inbox', inbox.overflow === 0, `${inbox.overflow}px`)
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-inbox.png`) })

  // ── Composer — reachability and refusal only. The send control is NEVER clicked.
  await mark('composer', async () => {
    const btn = page.locator('.ecc__tab', { hasText: 'Composer' }).first()
    if (await btn.count()) {
      await btn.click()
      await page.waitForSelector('.ecc__composer', { timeout: 30_000 }).catch(() => {})
    }
  })
  await page.waitForTimeout(900)
  /**
   * Scroll the send control into view before measuring it. Measuring a long
   * form's footer at the initial scroll position reports "unreachable" for
   * every control below the fold, which is not what §39 asks: the question is
   * whether the operator CAN reach it and whether it clears the dock once
   * reached.
   */
  await page.evaluate(() => {
    const sendBtn = [...document.querySelectorAll('.ecc__compose-actions button, .ecc__btn')]
      .find((b) => /^send/i.test((b.textContent || '').trim()))
    sendBtn?.scrollIntoView({ block: 'center' })
  })
  await page.waitForTimeout(700)
  const comp = await page.evaluate(() => {
    const reach = (el) => {
      if (!el) return { present: false }
      const b = el.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2))
      return {
        present: true, w: Math.round(b.width), h: Math.round(b.height),
        top: Math.round(b.top), bottom: Math.round(b.bottom),
        reachable: !!(hit && (hit === el || el.contains(hit))),
      }
    }
    const byLabel = (re) => [...document.querySelectorAll('.ecc__field')]
      .find((f) => re.test(f.querySelector('.ecc__field-label')?.textContent || ''))
    const inputIn = (f) => f?.querySelector('input, textarea, select') ?? null
    const sendBtn = [...document.querySelectorAll('.ecc__compose-actions button, .ecc__btn')]
      .find((b) => /^send/i.test((b.textContent || '').trim()))
    return {
      to: reach(inputIn(byLabel(/to|recipient/i))),
      subject: reach(inputIn(byLabel(/subject/i))),
      body: reach(document.querySelector('.ecc__composer textarea')),
      send: sendBtn ? { ...reach(sendBtn), disabled: sendBtn.disabled, label: sendBtn.textContent.trim() } : { present: false },
      dock: (() => { const e = document.querySelector('.nx-pinned-app-dock'); return e ? Math.round(e.getBoundingClientRect().top) : null })(),
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    }
  })
  check('§39 the recipient field is reachable', comp.to?.present && comp.to?.reachable, JSON.stringify(comp.to))
  check('§39 the subject field is reachable', comp.subject?.present && comp.subject?.reachable, JSON.stringify(comp.subject))
  check('§39 the body field is reachable', comp.body?.present && comp.body?.reachable, JSON.stringify(comp.body))
  check('§39 the send control is reachable once scrolled to',
    comp.send?.present && comp.send?.reachable, JSON.stringify(comp.send))
  check('§39 the send control clears the bottom dock',
    comp.dock === null || comp.send?.bottom == null || comp.send.bottom <= comp.dock,
    `send bottom=${comp.send?.bottom} dock top=${comp.dock}`)
  check('§11 send is disabled until the message is complete',
    comp.send?.disabled === true, `disabled=${comp.send?.disabled} label="${comp.send?.label}"`)
  check('no horizontal page overflow in the composer', comp.overflow === 0, `${comp.overflow}px`)
  await page.screenshot({ path: path.join(OUT, `${width}-${theme}-composer.png`) })

  // ── §21 unresolved variables block the send
  await page.fill('.ecc__composer textarea', 'Hi {{first_name}}, about your property.')
  const toField = page.locator('.ecc__field input').first()
  if (await toField.count()) await toField.fill('proof@example.invalid')
  const subjField = page.locator('.ecc__field input').nth(1)
  if (await subjField.count()) await subjField.fill('Proof subject')
  await page.waitForTimeout(900)
  const guarded = await page.evaluate(() => {
    const sendBtn = [...document.querySelectorAll('.ecc__compose-actions button, .ecc__btn')]
      .find((b) => /^send/i.test((b.textContent || '').trim()))
    return { disabled: sendBtn?.disabled ?? null }
  })
  check('§21/§44 a body with unresolved {{variables}} cannot be sent',
    guarded.disabled === true, `send disabled=${guarded.disabled}`)

  // ── §7/§8/§9/§10 thread list and detail, when a thread exists
  if (TRUTH.threadCount > 0) {
    await openTab('Inbox')
    await page.waitForTimeout(1500)
    const row = page.locator('.ecc__thread-list > div[class*="thread"]').first()
    const listed = await page.evaluate(() => {
      const r = document.querySelector('.ecc__thread-list > div[class*="thread"]')
      return r ? r.textContent.replace(/\s+/g, ' ').trim() : null
    })
    check('§7 a thread row carries recipient and subject', !!listed && listed.length > 4, `"${String(listed).slice(0, 120)}"`)

    if (await row.count()) {
      await row.click()
      await page.waitForTimeout(2200)
      const detail = await page.evaluate(() => {
        const msgs = [...document.querySelectorAll('[class*="ecc__msg"], [class*="ecc__message"]')]
        return {
          messageCount: msgs.length,
          directions: msgs.map((m) => (/inbound|is-in/.test(m.className) ? 'inbound' : /outbound|is-out/.test(m.className) ? 'outbound' : 'unknown')),
          text: (document.querySelector('[class*="ecc__thread-detail"], .ecc__inbox')?.textContent || '').replace(/\s+/g, ' ').slice(0, 500),
          errorPanels: document.querySelectorAll('.ecc__error-panel').length,
          overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        }
      })
      check('§8 opening a thread renders its messages', detail.messageCount > 0, `${detail.messageCount} messages`)
      check('§9 inbound and outbound are visually distinguished',
        new Set(detail.directions).size > 1 || detail.directions.every((d) => d !== 'unknown'),
        detail.directions.join(','))
      check('§8 a thread detail read does not error', detail.errorPanels === 0, `${detail.errorPanels} panels`)
      check('§8 no overflow in the thread detail', detail.overflow === 0, `${detail.overflow}px`)
      check('§10 the detail never claims delivery it does not have',
        !/\bdelivered\b/i.test(detail.text) || /queued|sent|received/i.test(detail.text),
        detail.text.slice(0, 120))
      await page.screenshot({ path: path.join(OUT, `${width}-${theme}-thread.png`) })
    }
  }

  // ── §5/§6 subject scoping, A -> B -> unknown
  const openSubject = async (id) => {
    await page.goto(`${BASE}/email-command?property_id=${encodeURIComponent(id)}`, {
      waitUntil: 'domcontentloaded', timeout: 120_000,
    })
    await page.waitForSelector('.ecc', { timeout: 60_000 })
    await page.waitForTimeout(2200)
    const btn = page.locator('.ecc__tab', { hasText: 'Records' }).first()
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(2600) }
    return page.evaluate(() => ({
      subjectPill: document.querySelector('.ecc__status-pill.is-subject')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      sectionTitle: document.querySelector('.ecc__section-title')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      rows: document.querySelectorAll('.ecc__table tbody tr').length,
      emails: [...document.querySelectorAll('.ecc__table tbody tr td:nth-child(2)')].map((e) => e.textContent.trim()),
      addresses: [...document.querySelectorAll('.ecc__table tbody tr')].map((r) => r.textContent).join(' '),
      emptyLabels: [...document.querySelectorAll('.ecc__empty-label')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
      errorPanels: document.querySelectorAll('.ecc__error-panel').length,
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    }))
  }

  if (SUB_A.count > 0 && SUB_B.count > 0) {
    const a = await openSubject(SUBJECT_A.id)
    check('§5 the subject is stated on screen', !!a.subjectPill, `pill="${a.subjectPill}"`)
    check('§5 A shows exactly A\'s address count',
      (a.sectionTitle || '').replace(/,/g, '').includes(String(SUB_A.count)),
      `title="${a.sectionTitle}" canonical=${SUB_A.count}`)
    check('§5 A shows A\'s property, not an unrelated one',
      new RegExp(SUBJECT_A.addressPart, 'i').test(a.addresses), `looking for ${SUBJECT_A.addressPart}`)
    check('§5 A is scoped, not the whole corpus', a.rows === SUB_A.count, `${a.rows} rows vs ${SUB_A.count}`)
    check('no overflow with a subject applied', a.overflow === 0, `${a.overflow}px`)

    const b = await openSubject(SUBJECT_B.id)
    check('§6 B shows B\'s count, not A\'s',
      (b.sectionTitle || '').replace(/,/g, '').includes(String(SUB_B.count)) && SUB_A.count !== SUB_B.count,
      `title="${b.sectionTitle}" B=${SUB_B.count} A=${SUB_A.count}`)
    check('§6 not one address leaks from A into B',
      b.emails.every((e) => !a.emails.includes(e)),
      `leaked=${b.emails.filter((e) => a.emails.includes(e)).join(', ') || 'none'}`)
    check('§6 B shows B\'s property', new RegExp(SUBJECT_B.addressPart, 'i').test(b.addresses), SUBJECT_B.addressPart)

    const none = await openSubject(SUBJECT_NONE.id)
    check('§6 a subject with no addresses says so, and does NOT fall back to the corpus',
      none.rows === 0 && none.errorPanels === 0 &&
      none.emptyLabels.some((l) => /no email addresses are linked/i.test(l)),
      `rows=${none.rows} errors=${none.errorPanels} empty="${none.emptyLabels.join(' | ')}"`)
    await page.screenshot({ path: path.join(OUT, `${width}-${theme}-subject.png`) })
  }

  // ── Campaigns: an absent authority must say so
  await openTab('Campaigns')
  const camp = await probe()
  check('§27 the campaigns tab does not pretend to be an empty list',
    camp.emptyLabels.some((l) => /not available|does not exist|no email campaign/i.test(l)) ||
    camp.errorPanels.some((l) => /campaign/i.test(l)),
    `empty="${camp.emptyLabels.join(' | ')}" errors="${camp.errorPanels.join(' | ')}"`)

  // §41 budgets, deliberately generous: the brief asks for obvious 10s+ waits
  // to be fixed, not for micro-optimisation.
  for (const [step, budget] of [['shell', 15000], ['records', 15000], ['search', 15000], ['composer', 8000]]) {
    if (timings[step] === undefined) continue
    check(`§41 ${step} responds within budget`, timings[step] < budget, `${timings[step]}ms (budget ${budget}ms)`)
  }

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  await context.close()
  return { cell: `${width}-${theme}`, maps: maps.length, rows: rec.tableRows, timings }
}

const results = []
try {
  for (const w of WIDTHS) for (const t of THEMES) {
    const before = findings.length
    const r = await runCell(w, t)
    results.push(r)
    const bad = findings.filter((f) => f.cell === r.cell).length
    // NOT `const t` — that would shadow the loop variable `t` for this whole
    // block and make `runCell(w, t)` above a TDZ reference.
    const ms = r.timings || {}
    console.log(`${r.cell.padEnd(12)} ${(bad ? `FAIL (${bad})` : 'PASS').padEnd(10)} rows ${String(r.rows).padEnd(4)} maps ${r.maps}  shell ${ms.shell ?? '-'}ms  records ${ms.records ?? '-'}ms  search ${ms.search ?? '-'}ms  composer ${ms.composer ?? '-'}ms`)
    for (const f of findings.slice(before)) console.log(`   x ${f.n}: ${f.d}`)
  }
} finally { await browser.close() }

console.log('')
const badCells = new Set(findings.map((f) => f.cell))
console.log(`EMAIL COMMAND MATRIX ${results.length - [...badCells].filter((c) => c !== 'api').length}/${results.length} cells clean, ${findings.length} finding(s)`)
await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify({ TRUTH, results, findings }, null, 2))
if (findings.length) process.exit(1)
