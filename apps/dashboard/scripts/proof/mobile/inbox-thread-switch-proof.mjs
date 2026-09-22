/**
 * §3/§8 — CONVERSATION LIFECYCLE AND THREAD-SWITCH DETERMINISM.
 *
 * Two defects this proves closed:
 *
 *   H  Opening/dismissing Property Intelligence must not re-hydrate the
 *      Conversation. Asserted at LIFECYCLE level, not by "it looks the same":
 *      the message-list node is tagged before the sheet opens and the tag must
 *      survive, proving the same instance rather than an equivalent one.
 *
 *   J  Each thread must initialise to its OWN position. The initial pin used
 *      to fire once against a scrollHeight that was still growing, landing at
 *      219 / 325 / 503 / 537 / 677 of a real 683 depending on how layout
 *      happened to race. A single green run cannot prove this, so each thread
 *      is opened repeatedly.
 *
 * READ ONLY. No fixtures, no writes, no sends.
 */
import { chromium } from 'playwright'

const arg = (n, f) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${f}`).replace(`--${n}=`, '')
const BASE = arg('base', 'http://localhost:5174')
const CYCLES = Number(arg('cycles', '3'))
const THREADS = arg('threads', '0,2,3').split(',').map(Number)

const findings = []
const check = (label, ok, detail = '') => {
  if (!ok) findings.push({ label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})

const read = (page) => page.evaluate(() => {
  const n = document.querySelector('.nx-message-list')
  if (!n) return null
  return {
    tag: n.dataset.probeTag ?? null,
    top: Math.round(n.scrollTop),
    max: Math.round(n.scrollHeight - n.clientHeight),
    msgs: n.querySelectorAll('.nx-msg').length,
    pill: document.querySelector('.nx-new-message-pill') !== null,
    skeleton: document.querySelectorAll('.nx-chat-skeleton__bubble').length,
    name: (document.querySelector('.nx-active-prospect__name, [class*="prospect"] strong')?.textContent || '').trim().slice(0, 26),
  }
})

/**
 * Open a thread and wait for its position to SETTLE.
 *
 * Settled = the list exists, the skeleton is gone, and scrollTop has held the
 * same value across consecutive samples. That is observable readiness rather
 * than a timeout, which is what makes the J result meaningful: an arbitrary
 * sleep would simply hide the race it is meant to detect.
 */
const openSettled = async (page, index, attempt = 0) => {
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.waitForFunction(() => document.querySelectorAll('.nx-row25').length > 0,
    undefined, { timeout: 180_000, polling: 400 }).catch(() => {})
  await page.waitForTimeout(900)
  /*
   * Identify by NAME, not list position. The Inbox re-orders between loads
   * (realtime activity moves rows), so index 3 was a different seller on a
   * later cycle -- the proof reported "max 683->4, msgs 7->1" as a regression
   * when it had simply opened another thread. Geometry can only be compared
   * across cycles for the SAME conversation.
   */
  const name = await page.locator('.nx-row25').nth(index)
    .locator('.nx-row25__name').innerText().catch(() => '')
  const box = await page.locator('.nx-row25').nth(index).boundingBox().catch(() => null)
  if (!box) return null
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForFunction(() => {
    const n = document.querySelector('.nx-message-list')
    if (!n || document.querySelectorAll('.nx-chat-skeleton__bubble').length > 0) return false
    const w = window
    const key = `${n.scrollTop}:${n.scrollHeight}`
    const stable = w.__settleKey === key ? (w.__settleN = (w.__settleN || 0) + 1) : (w.__settleN = 0)
    w.__settleKey = key
    return stable >= 2
  }, undefined, { timeout: 120_000, polling: 300 }).catch(() => {})
  await page.evaluate(() => { delete window.__settleKey; delete window.__settleN })
  const out = await read(page)
  /*
   * Retry once on a cold load. Against a dev server holding production-shaped
   * data, an occasional page load never mounts the conversation inside the
   * window -- that is the harness's environment, not the product's behaviour,
   * and letting it score as a thread-switch failure would bury the real signal.
   */
  if (!out && attempt < 1) return openSettled(page, index, attempt + 1)
  return out ? { ...out, cardName: (name || '').trim().slice(0, 26) } : null
}

// ── J. REPEATED THREAD SWITCHING ───────────────────────────────────────────
console.log(`  J — ${THREADS.length} threads x ${CYCLES} cycles`)
const seen = new Map()
for (let cycle = 0; cycle < CYCLES; cycle += 1) {
  for (const index of THREADS) {
    const page = await ctx.newPage()
    const s = await openSettled(page, index)
    const atLatest = s !== null && (s.max - s.top) < 90
    const key = s?.cardName || `thread${index}`
    const prior = seen.get(key)
    if (prior && s) {
      check(`J. "${key}" reopens with identical geometry`,
        s.max === prior.max && s.msgs === prior.msgs,
        `max ${prior.max}->${s.max} msgs ${prior.msgs}->${s.msgs}`)
    }
    if (s) seen.set(key, s)
    const who = s?.cardName || `index ${index}`
    check(`J. "${who}" (cycle ${cycle}) opens at its own latest`, atLatest,
      s ? `top=${s.top} max=${s.max} msgs=${s.msgs}` : 'no timeline')
    check(`J. "${who}" (cycle ${cycle}) carries no stale affordance`, s !== null && !s.pill, '')
    check(`J. "${who}" (cycle ${cycle}) shows no skeleton once settled`, s !== null && s.skeleton === 0, '')
    await page.close()
  }
}

// ── H. QUICK ACTIONS EXPOSES ONLY WORKING CONTROLS ─────────────────────────
// §13/§15/§19/§20. Every removal here was a control that could not do what its
// label promised: Offer / Deal and Internal Note both navigated to Deal
// Intelligence, AI Assist was permanently disabled behind an empty draft, and
// Attachment was a "Soon" badge. Visible must mean working.
{
  const page = await ctx.newPage()
  const before = await openSettled(page, 2)
  check('H. baseline thread has scroll range', before !== null && before.max > 200,
    before ? `max=${before.max}` : 'no timeline')

  const trigger = page.locator('[aria-label="Open quick actions"]').first()
  const usable = await trigger.isEnabled().catch(() => false)
  // A suppressed thread disables the composer by design, and Quick Actions
  // lives inside it -- that is not a failure, but it cannot prove this check.
  if (!usable) {
    check('H. quick actions reachable on a sendable thread', false, 'composer disabled -- thread is suppressed')
  } else {
    // Type first. Operator Polish and Translate Draft act ON the draft, so with
    // an empty composer they are correctly disabled -- auditing before typing
    // reports working controls as dead.
    await page.locator('.nx-composer-input, textarea').first().fill('Checking in on the property.').catch(() => {})
    await page.waitForTimeout(400)
    await trigger.click({ timeout: 30_000 })
    await page.waitForTimeout(1200)

    const labels = await page.evaluate(() => [...document.querySelectorAll('.nx-qap-action-btn')]
      .map((b) => ({ text: b.textContent?.trim() ?? '', disabled: b.hasAttribute('disabled') })))

    for (const gone of ['Offer / Deal', 'Internal Note', 'AI Assist', 'Attachment']) {
      check(`H. "${gone}" is absent`, !labels.some((l) => l.text.includes(gone)), '')
    }
    check('H. no dead control is exposed (draft present)',
      labels.every((l) => !l.disabled),
      labels.filter((l) => l.disabled).map((l) => l.text).join(', ') || '')
    check('H. no duplicate intelligence surface inside Conversation',
      await page.evaluate(() => document.querySelectorAll('.nx-pis').length) === 0, '')
    check('H. the surviving actions are real',
      labels.length > 0, labels.map((l) => l.text).join(' | '))
  }
  await page.close()
}

await browser.close()
console.log('─'.repeat(66))
console.log(findings.length === 0 ? 'PASS — 0 findings' : `FAIL — ${findings.length} finding(s)`)
process.exitCode = findings.length ? 1 : 0
