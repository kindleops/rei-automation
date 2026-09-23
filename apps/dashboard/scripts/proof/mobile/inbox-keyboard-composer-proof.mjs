/**
 * KEYBOARD / COMPOSER — CASES A–F.
 *
 * The software keyboard cannot be opened from Playwright, and faking it with a
 * CSS class would prove nothing: the whole point is that iOS shrinks the VISUAL
 * viewport while leaving the layout viewport alone. So the keyboard is emulated
 * the way the product actually observes it -- by driving
 * `window.visualViewport` (height + offsetTop) and dispatching its `resize`
 * event -- and then focusing the textarea for real.
 *
 * That is the same signal `useMobileKeyboardInset` subscribes to, so everything
 * downstream (the inset var, the is-keyboard-open class, the list re-anchor)
 * runs its true code path.
 *
 * READ ONLY except for CASE E, which inserts INBOUND message_events on the
 * sanctioned canary and deletes them again by source_app.
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs/promises'

const arg = (name, fallback) =>
  (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${fallback}`).split('=')[1]

const BASE = arg('base', 'http://localhost:5173')
const KEYBOARD_PX = Number(arg('keyboard', '336'))

const rd = async (p) => fs.readFile(p, 'utf8').catch(() => '')
const env = (await rd('.env.local')) + '\n' + (await rd('../api/.env.local'))
const pick = (k) => (new RegExp(`^${k}=(.+)$`, 'm').exec(env)?.[1] ?? '').trim()
const admin = createClient(pick('VITE_SUPABASE_URL'), pick('SUPABASE_SERVICE_ROLE_KEY'))

const CANARY = '+13059807795'
const SOURCE_APP = 'inbox_keyboard_proof'

/*
 * The sanctioned fixture shape, copied from the conversation scroll proof.
 *
 * event_type is NOT NULL, and the prospect/property/owner ids are what
 * `belongsToSelection` matches on -- a fixture carrying only a phone number is
 * inserted successfully and then never rendered, which reads as a product
 * failure. Both mistakes have already cost a debugging session each.
 */
const CANARY_IDENTITY = {
  thread_key: CANARY,
  from_phone_number: CANARY,
  to_phone_number: '+14693131600',
  prospect_id: 'cpros_canary_offerauth_v2',
  property_id: 'canaryprop_offerauth_v2_75060',
  master_owner_id: 'canaryowner_offerauth_v2',
  direction: 'inbound',
  event_type: 'message_received',
  routing_allowed: false,
  auto_reply_status: 'skipped',
  source_app: SOURCE_APP,
}

const findings = []
const check = (label, ok, detail = '') => {
  if (!ok) findings.push({ label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`)
}

/*
 * Install the keyboard emulation BEFORE the app loads.
 *
 * A first attempt patched visualViewport after mount and never took effect --
 * the run reported `is-keyboard-open=false, inset=0px` through every case, so
 * eleven "failures" were all one harness bug. Patching the PROTOTYPE from an
 * init script guarantees the accessor is in place before
 * `useMobileKeyboardInset` ever reads it, and the return value is asserted
 * rather than assumed.
 *
 * The hook computes `innerHeight - viewport.height - viewport.offsetTop`, so
 * shrinking height by N produces an N-pixel inset -- exactly what iOS does.
 */
const INSTALL_KEYBOARD = () => {
  const proto = window.VisualViewport && window.VisualViewport.prototype
  if (!proto) return
  const heightDesc = Object.getOwnPropertyDescriptor(proto, 'height')
  if (!heightDesc || !heightDesc.get) return
  const realHeight = heightDesc.get
  window.__kbPx = 0
  Object.defineProperty(proto, 'height', {
    configurable: true,
    get() { return realHeight.call(this) - (window.__kbPx || 0) },
  })
  window.__setKeyboard = (px) => {
    window.__kbPx = px
    window.visualViewport.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    return {
      px,
      vvHeight: window.visualViewport.height,
      innerHeight: window.innerHeight,
    }
  }
}

const setKeyboard = async (page, px) => {
  const result = await page.evaluate((n) => (
    typeof window.__setKeyboard === 'function' ? window.__setKeyboard(n) : null
  ), px)
  if (!result) throw new Error('keyboard emulation not installed — the proof cannot measure anything')
  return result
}

const readState = async (page) => page.evaluate(() => {
  const list = document.querySelector('.nx-message-list')
  const composer = document.querySelector('.nx-composer')
  const rows = [...document.querySelectorAll('.nx-message-list .nx-msg')]
  const last = rows[rows.length - 1]
  const lastText = (last?.textContent ?? '').trim().slice(0, 40)
  const r = composer?.getBoundingClientRect()
  return {
    top: list ? Math.round(list.scrollTop) : null,
    max: list ? Math.round(list.scrollHeight - list.clientHeight) : null,
    clientH: list ? Math.round(list.clientHeight) : null,
    msgs: rows.length,
    lastText,
    composerBottom: r ? Math.round(r.bottom) : null,
    composerTop: r ? Math.round(r.top) : null,
    innerH: window.innerHeight,
    keyboardOpen: document.documentElement.classList.contains('is-keyboard-open'),
    inset: getComputedStyle(document.documentElement).getPropertyValue('--nx-keyboard-inset').trim(),
    pageScrollY: Math.round(window.scrollY),
    affordance: document.querySelectorAll('.nx-new-message-pill').length,
  }
})

/** Anchor = the message currently at the top of the viewport, and its offset. */
const readAnchor = async (page) => page.evaluate(() => {
  const list = document.querySelector('.nx-message-list')
  if (!list) return null
  const listTop = list.getBoundingClientRect().top
  for (const row of list.querySelectorAll('.nx-msg')) {
    const r = row.getBoundingClientRect()
    if (r.bottom > listTop + 8) {
      return { text: (row.textContent ?? '').trim().slice(0, 36), offset: Math.round(r.top - listTop) }
    }
  }
  return null
})

/*
 * SEED THE CANARY, DO NOT HUNT FOR A LUCKY THREAD.
 *
 * Cases A-D need a conversation long enough that "held my place" is
 * distinguishable from "was already at the top", and the loaded page rarely
 * has one whose composer is also enabled. Hunting for one made the run take
 * half an hour and still report "no suitable thread".
 *
 * So the proof seeds the history it needs on the sanctioned canary -- inbound
 * fixtures only, deleted by source_app in the finally block -- exactly as the
 * conversation scroll proof does.
 */
const seedCanaryHistory = async (n = 14) => {
  const rows = Array.from({ length: n }, (_, i) => ({
    ...CANARY_IDENTITY,
    message_event_key: `kbproof:seed:${Date.now()}:${i}`,
    message_body: `Keyboard proof history line ${i + 1} — padding so the timeline is taller than the viewport.`,
    /*
     * SECONDS in the past, not minutes.
     *
     * Seeding 14 minutes back left the canary sorted below the 25 rows the
     * Inbox loads, so the proof could not find the thread it had just seeded
     * and reported "no suitable thread" / "canary not reachable" on roughly
     * half of all runs. Recent timestamps put it at the top where the proof
     * looks, while still preserving their order.
     */
    received_at: new Date(Date.now() - (n - i) * 1_000).toISOString(),
  }))
  const { error } = await admin.from('message_events').insert(rows)
  if (error) console.log(`  seed ERROR: ${error.message}`)
  return !error
}

const openThread = async (page) => {
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.waitForFunction(() => document.querySelectorAll('.nx-row25').length > 0,
    undefined, { timeout: 180_000, polling: 400 }).catch(() => {})
  await page.waitForTimeout(1500)

  const byId = page.locator(`.nx-row25[data-thread-id*="${CANARY.replace('+', '')}"]`).first()
  const target = (await byId.count().catch(() => 0)) > 0
    ? byId
    : page.locator('.nx-row25', { hasText: 'INTERNAL CANARY' }).first()

  const found = await target.count().then((n) => n > 0).catch(() => false)
  if (!found) {
    // The row exists but may be below the fold of the virtualised list.
    await page.evaluate(() => {
      const list = document.querySelector('.nx-inbox-list, .nx-premium-inbox__list, [class*="list"]')
      if (list) list.scrollTop = 0
    })
    await page.waitForTimeout(800)
  }
  await target.click({ timeout: 20_000 }).catch(() => {})
  const settled = await page.waitForFunction(() => {
    const n = document.querySelector('.nx-message-list')
    if (!n || document.querySelectorAll('.nx-chat-skeleton__bubble').length > 0) return false
    return n.querySelectorAll('.nx-msg').length > 3
  }, undefined, { timeout: 60_000, polling: 300 }).then(() => true).catch(() => false)
  if (!settled) return null
  // Wait for the count AND the geometry to hold still: reading straight after
  // the settle predicate returned msgs=0 against a list that had 16, and every
  // "before" comparison built on it was meaningless.
  await page.waitForFunction(() => {
    const n = document.querySelector('.nx-message-list')
    if (!n) return false
    const key = `${n.querySelectorAll('.nx-msg').length}:${n.scrollHeight}`
    const stable = window.__ktKey === key ? (window.__ktN = (window.__ktN || 0) + 1) : (window.__ktN = 0)
    window.__ktKey = key
    return stable >= 4
  }, undefined, { timeout: 40_000, polling: 250 }).catch(() => {})
  await page.evaluate(() => { delete window.__ktKey; delete window.__ktN })
  await page.waitForTimeout(600)
  return readState(page)
}

const focusComposer = async (page) => {
  const input = page.locator('.nx-composer textarea, .nx-composer-input').first()
  await input.click({ timeout: 15_000 }).catch(() => {})
  return input
}

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
})
await ctx.addInitScript(INSTALL_KEYBOARD)

try {
  const seeded = await seedCanaryHistory()
  check('seeded canary history for the long-thread cases', seeded, '')

  // ── CASE A — ALREADY AT LATEST ────────────────────────────────────────────
  {
    const page = await ctx.newPage()
    const before = await openThread(page)
    check('A. long conversation opened at latest', before !== null && (before.max - before.top) < 90,
      before ? `top=${before.top} max=${before.max} msgs=${before.msgs}` : 'no suitable thread')

    if (before) {
      await focusComposer(page)
      await setKeyboard(page, KEYBOARD_PX)
      await page.waitForTimeout(900)
      const after = await readState(page)

      check('A. keyboard state is observed', after.keyboardOpen,
        `class=${after.keyboardOpen} inset=${after.inset}`)
      check('A. the list gives up height to the keyboard', after.clientH < before.clientH,
        `${before.clientH} -> ${after.clientH}`)
      check('A. latest message is still the one above the composer',
        after.lastText === before.lastText && (after.max - after.top) < 90,
        `top=${after.top} max=${after.max} last="${after.lastText}"`)
      check('A. the PAGE did not scroll (the list is the scroller)', after.pageScrollY === 0,
        `window.scrollY=${after.pageScrollY}`)
      check('A. no rehydration', after.msgs === before.msgs, `${before.msgs} -> ${after.msgs}`)
      check('A. composer sits above the keyboard',
        after.composerBottom !== null && after.composerBottom <= after.innerH - KEYBOARD_PX + 8,
        `composerBottom=${after.composerBottom} innerH=${after.innerH} kb=${KEYBOARD_PX}`)
    }
    await page.close()
  }

  // ── CASE B — READING OLD MESSAGES ─────────────────────────────────────────
  {
    const page = await ctx.newPage()
    const opened = await openThread(page)
    if (!opened) {
      check('B. long conversation available', false, 'no suitable thread')
    } else {
      await page.evaluate(() => { document.querySelector('.nx-message-list').scrollTop = 0 })
      await page.waitForTimeout(700)
      const beforeAnchor = await readAnchor(page)
      const before = await readState(page)

      await focusComposer(page)
      await setKeyboard(page, KEYBOARD_PX)
      await page.waitForTimeout(900)
      const afterAnchor = await readAnchor(page)
      const after = await readState(page)

      check('B. not yanked to latest', (after.max - after.top) > 90 || after.top < 120,
        `top=${after.top} max=${after.max}`)
      check('B. the same message is still the anchor',
        Boolean(beforeAnchor && afterAnchor && beforeAnchor.text === afterAnchor.text),
        `${beforeAnchor?.text ?? '?'} -> ${afterAnchor?.text ?? '?'}`)
      check('B. anchor held its position within tolerance',
        Boolean(beforeAnchor && afterAnchor && Math.abs(beforeAnchor.offset - afterAnchor.offset) <= 48),
        `offset ${beforeAnchor?.offset} -> ${afterAnchor?.offset}`)
      check('B. the PAGE did not scroll', after.pageScrollY === 0, `window.scrollY=${after.pageScrollY}`)
      void before
    }
    await page.close()
  }

  // ── CASE C — KEYBOARD CLOSE ───────────────────────────────────────────────
  for (const mode of ['latest', 'scrolled-up']) {
    const page = await ctx.newPage()
    const opened = await openThread(page)
    if (!opened) {
      check(`C. [${mode}] conversation available`, false, 'no suitable thread')
      await page.close()
      continue
    }
    if (mode === 'scrolled-up') {
      await page.evaluate(() => { document.querySelector('.nx-message-list').scrollTop = 0 })
      await page.waitForTimeout(700)
    }
    await focusComposer(page)
    await setKeyboard(page, KEYBOARD_PX)
    await page.waitForTimeout(800)
    const open = await readState(page)
    const openAnchor = await readAnchor(page)

    await setKeyboard(page, 0)
    await page.evaluate(() => document.activeElement?.blur())
    await page.waitForTimeout(900)
    const closed = await readState(page)
    const closedAnchor = await readAnchor(page)

    check(`C. [${mode}] keyboard state cleared`, !closed.keyboardOpen, `inset=${closed.inset}`)
    check(`C. [${mode}] list height restored`, closed.clientH > open.clientH,
      `${open.clientH} -> ${closed.clientH}`)
    check(`C. [${mode}] no rebound of reading position`,
      mode === 'latest'
        ? (closed.max - closed.top) < 90
        : Boolean(openAnchor && closedAnchor && openAnchor.text === closedAnchor.text),
      mode === 'latest'
        ? `top=${closed.top} max=${closed.max}`
        : `${openAnchor?.text ?? '?'} -> ${closedAnchor?.text ?? '?'}`)
    check(`C. [${mode}] composer has no dead zone below it`,
      closed.composerBottom !== null && (closed.innerH - closed.composerBottom) <= 48,
      `gap=${closed.composerBottom === null ? '?' : closed.innerH - closed.composerBottom}px`)
    await page.close()
  }

  // ── CASE D — MULTILINE DRAFT ──────────────────────────────────────────────
  {
    const page = await ctx.newPage()
    const opened = await openThread(page)
    if (!opened) {
      check('D. conversation available', false, 'no suitable thread')
    } else {
      await focusComposer(page)
      await setKeyboard(page, KEYBOARD_PX)
      await page.waitForTimeout(600)
      const one = await readState(page)

      const input = page.locator('.nx-composer textarea, .nx-composer-input').first()
      await input.fill('Checking in about the property. '.repeat(6))
      await page.waitForTimeout(900)
      const many = await readState(page)

      check('D. composer grew for the draft', many.composerTop < one.composerTop,
        `top ${one.composerTop} -> ${many.composerTop}`)
      check('D. the message list absorbed the growth', many.clientH <= one.clientH,
        `${one.clientH} -> ${many.clientH}`)
      check('D. still anchored to latest', (many.max - many.top) < 90,
        `top=${many.top} max=${many.max}`)
      check('D. composer still clears the keyboard',
        many.composerBottom <= many.innerH - KEYBOARD_PX + 8,
        `composerBottom=${many.composerBottom} innerH=${many.innerH}`)

      const sendBox = await page.locator('.nx-composer [aria-label*="Send" i], .nx-composer-send')
        .first().boundingBox().catch(() => null)
      check('D. send control is reachable',
        Boolean(sendBox && sendBox.y + sendBox.height <= many.innerH - KEYBOARD_PX + 8),
        sendBox ? `sendBottom=${Math.round(sendBox.y + sendBox.height)}` : 'send control not found')
    }
    await page.close()
  }

  // ── CASE E — REALTIME WHILE THE KEYBOARD IS OPEN ──────────────────────────
  for (const mode of ['at-latest', 'scrolled-up']) {
    const page = await ctx.newPage()
    const settled = await openThread(page) !== null
    if (!settled) {
      check(`E. [${mode}] canary conversation opened`, false, 'canary not reachable')
      await page.close()
      continue
    }
    await page.waitForTimeout(1500)

    if (mode === 'scrolled-up') {
      await page.evaluate(() => { document.querySelector('.nx-message-list').scrollTop = 0 })
      await page.waitForTimeout(600)
    }
    await focusComposer(page)
    await setKeyboard(page, KEYBOARD_PX)
    await page.waitForTimeout(800)

    const before = await readState(page)
    const beforeAnchor = await readAnchor(page)

    const key = `kbproof:${mode}:${Date.now()}`
    await admin.from('message_events').insert({
      ...CANARY_IDENTITY,
      message_event_key: key,
      message_body: `Keyboard proof inbound ${mode}`,
      received_at: new Date().toISOString(),
    })

    await page.waitForFunction((n) => (
      document.querySelectorAll('.nx-message-list .nx-msg').length > n
    ), before.msgs, { timeout: 30_000, polling: 300 }).catch(() => {})

    /*
     * WAIT FOR THE AFFORDANCE, DO NOT RACE IT.
     *
     * The bubble and the pill are decided by two different effects. Reading a
     * fixed 1.6s after the bubble appeared reported `pills=0` on one run and
     * `pills=1` on the next -- the only difference being two diagnostic calls
     * that happened to add ~150ms. A proof that passes because of its own
     * instrumentation is not a proof, so the scrolled-up case waits for the
     * pill explicitly and the at-latest case waits for the scroll to settle.
     */
    if (mode === 'scrolled-up') {
      await page.waitForFunction(() => (
        document.querySelectorAll('.nx-new-message-pill').length > 0
      ), undefined, { timeout: 15_000, polling: 200 }).catch(() => {})
    }
    await page.waitForTimeout(1200)
    const after = await readState(page)

    check(`E. [${mode}] exactly one new bubble`, after.msgs === before.msgs + 1,
      `${before.msgs} -> ${after.msgs}`)

    if (mode === 'at-latest') {
      check('E. [at-latest] latest stays visible with the keyboard up',
        (after.max - after.top) < 90, `top=${after.top} max=${after.max}`)
    } else {
      const afterAnchor = await readAnchor(page)
      check('E. [scrolled-up] reading position preserved',
        Boolean(beforeAnchor && afterAnchor && beforeAnchor.text === afterAnchor.text),
        `${beforeAnchor?.text ?? '?'} -> ${afterAnchor?.text ?? '?'}`)
      check('E. [scrolled-up] New Message affordance appears', after.affordance > 0,
        `pills=${after.affordance}`)
      /*
       * ONE CLICK, THEN WAIT FOR ARRIVAL.
       *
       * An instrumented run settled this: clicking the pill scrolls the list
       * 78 -> 1196 -> 1996 -> 2338 of 2338 over about 800ms and it stays
       * there. Every "failure" I chased -- landings of 9, 23, 217, 360, 474 --
       * came from this harness, which either clicked a pill the click itself
       * had already cleared (a retry loop that broke on `pills === 0`) or read
       * the position mid-climb. The product was never wrong.
       */
      await page.locator('.nx-new-message-pill').first().click({ timeout: 8_000 }).catch(() => {})
      await page.waitForFunction(() => {
        const n = document.querySelector('.nx-message-list')
        return n ? (n.scrollHeight - n.clientHeight - n.scrollTop) < 90 : false
      }, undefined, { timeout: 15_000, polling: 150 }).catch(() => {})
      await page.waitForTimeout(400)
      const jumped = await readState(page)
      check('E. [scrolled-up] jump to latest works', (jumped.max - jumped.top) < 90,
        `top=${jumped.top} max=${jumped.max}`)
      check('E. [scrolled-up] affordance clears', jumped.affordance === 0, `pills=${jumped.affordance}`)
    }

    // Replay the same event: it must not produce a second bubble.
    await admin.from('message_events')
      .update({ updated_at: new Date().toISOString() })
      .eq('message_event_key', key)
    await page.waitForTimeout(2200)
    const replayed = await readState(page)
    check(`E. [${mode}] replay does not duplicate`, replayed.msgs === after.msgs,
      `${after.msgs} -> ${replayed.msgs}`)

    await page.close()
  }

  // ── CASE F — ORIENTATION WITH A DRAFT ─────────────────────────────────────
  {
    const page = await ctx.newPage()
    const opened = await openThread(page)
    if (!opened) {
      check('F. conversation available', false, 'no suitable thread')
    } else {
      const draft = 'Draft that must survive rotation.'
      const input = page.locator('.nx-composer textarea, .nx-composer-input').first()
      await input.fill(draft)
      await page.waitForTimeout(600)
      const before = await readState(page)
      const beforeName = await page.evaluate(() =>
        document.querySelector('.nx-conv-seller-name--mobile')?.textContent?.trim() ?? '')

      await page.setViewportSize({ width: 844, height: 390 })
      await page.waitForTimeout(1600)
      const land = await page.evaluate(() => ({
        draft: document.querySelector('.nx-composer textarea, .nx-composer-input')?.value ?? '',
        mobile: document.documentElement.classList.contains('is-mobile-layout'),
        msgs: document.querySelectorAll('.nx-message-list .nx-msg').length,
        name: document.querySelector('.nx-conv-seller-name--mobile')?.textContent?.trim() ?? '',
      }))

      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(1600)
      const back = await page.evaluate(() => ({
        draft: document.querySelector('.nx-composer textarea, .nx-composer-input')?.value ?? '',
        mobile: document.documentElement.classList.contains('is-mobile-layout'),
        msgs: document.querySelectorAll('.nx-message-list .nx-msg').length,
        name: document.querySelector('.nx-conv-seller-name--mobile')?.textContent?.trim() ?? '',
      }))

      check('F. draft survives landscape', land.draft === draft, `"${land.draft.slice(0, 30)}"`)
      check('F. draft survives return to portrait', back.draft === draft, `"${back.draft.slice(0, 30)}"`)
      check('F. same thread throughout',
        land.name === beforeName && back.name === beforeName,
        `${beforeName} | ${land.name} | ${back.name}`)
      check('F. no duplicated messages',
        land.msgs === before.msgs && back.msgs === before.msgs,
        `${before.msgs} | ${land.msgs} | ${back.msgs}`)
      check('F. mobile shell retained in landscape', land.mobile, `is-mobile-layout=${land.mobile}`)
    }
    await page.close()
  }
} finally {
  /*
   * Cleanup RETRIES.
   *
   * A transient Supabase error once made the delete return an HTML error page.
   * The run reported "cleanup: ERROR" and moved on, leaving 16 inbound
   * fixtures on the canary -- found later by hand. Reporting a failed cleanup
   * is not the same as cleaning up, and fixtures on a real thread are exactly
   * what the safety section exists to prevent.
   */
  let remaining = '?'
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { error } = await admin.from('message_events').delete().eq('source_app', SOURCE_APP)
    lastError = error
    const { count, error: countError } = await admin.from('message_events')
      .select('id', { count: 'exact', head: true }).eq('source_app', SOURCE_APP)
    if (!error && !countError) {
      remaining = count ?? 0
      if (remaining === 0) break
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  const clean = remaining === 0
  console.log(`  cleanup: ${clean ? 'ok' : `INCOMPLETE${lastError ? ` (${String(lastError.message).slice(0, 60)})` : ''}`} — fixtures remaining: ${remaining}`)
  if (!clean) findings.push({ label: 'SAFETY: fixtures were not removed', detail: String(remaining) })
  await browser.close()
}

console.log('─'.repeat(66))
console.log(findings.length ? `FAIL — ${findings.length} finding(s)` : 'PASS — 0 findings')
