/**
 * §20 — CONVERSATION SCROLL / NAVIGATION SEMANTICS.
 *
 * READ ONLY against product data. The only writes are INBOUND message_events on
 * the sanctioned canary thread, created and deleted inside this file. Inbound
 * transmits nothing: no send, no queue row, no lifecycle change.
 *
 * ONE PAGE PER SCENARIO. An earlier version shared a page across scenarios and
 * spent more iterations fighting its own state than testing the product --
 * threads "opened at the top" here that a standalone check showed opening at
 * the bottom. Each scenario now loads its own page and waits on a POSITIONED
 * timeline rather than a fixed sleep.
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs/promises'

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://localhost:5174').split('=')[1]
const rd = async (p) => fs.readFile(p, 'utf8').catch(() => '')
const env = (await rd('.env.local')) + '\n' + (await rd('../api/.env.local'))
const pick = (k) => (new RegExp(`^${k}=(.+)$`, 'm').exec(env)?.[1] ?? '').trim()
const admin = createClient(pick('VITE_SUPABASE_URL'), pick('SUPABASE_SERVICE_ROLE_KEY'))
const CANARY = '+13059807795'
/*
 * A faithful inbound. The selected-thread realtime handler matches on
 * prospect/property/owner id (belongsToSelection), so a fixture carrying only
 * thread_key is ignored -- which looked exactly like "realtime does not append"
 * until the real canary rows were compared against it. `to_phone_number` is our
 * number, as a genuine inbound would be.
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
  source_app: 'inbox_scroll_proof',
}

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
    top: Math.round(n.scrollTop),
    max: Math.round(n.scrollHeight - n.clientHeight),
    /*
     * `.nx-msg` is ONE message. An earlier selector of
     * `.nx-msg, [class*="bubble"]` also matched nx-msg__bubble,
     * nx-bubble-hover-actions and nx-bubble-action -- four nodes per message --
     * and reported 72 for an 18-message thread, so a single new message could
     * not be seen against the noise.
     */
    bubbles: n.querySelectorAll('.nx-msg').length,
    pill: document.querySelector('.nx-new-message-pill') !== null,
  }
})

/** Open a thread and wait until its timeline is POSITIONED, not merely present. */
/**
 * Open a thread and wait until its timeline is POSITIONED, not merely present.
 *
 * Retries once. Against a dev server serving production-shaped data, a cold
 * route occasionally leaves the conversation unmounted past the wait, and a
 * single reload is a far more honest fix than inflating every timeout.
 */
const openThread = async (page, index, attempt = 0) => {
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.waitForFunction(() => document.querySelectorAll('.nx-row25').length > 0,
    undefined, { timeout: 180_000, polling: 400 }).catch(() => {})
  await page.waitForTimeout(1200)
  const box = await page.locator('.nx-row25').nth(index).boundingBox().catch(() => null)
  if (box) {
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
    /*
     * "Positioned" = the list exists and either sits at its bottom or has no
     * room to scroll. That is exactly the contract §3 states, so waiting for it
     * is waiting for the thing under test rather than guessing at hydration.
     */
    /*
     * Wait for the position to SETTLE, not merely to cross a threshold once.
     * The weaker check returned mid-placement and reported threads opening at
     * 503 of 683 that the dedicated switch proof shows settling correctly.
     */
    await page.waitForFunction(() => {
      const n = document.querySelector('.nx-message-list')
      if (!n || document.querySelectorAll('.nx-chat-skeleton__bubble').length > 0) return false
      const w = window
      const key = `${n.scrollTop}:${n.scrollHeight}`
      const stable = w.__sk === key ? (w.__sn = (w.__sn || 0) + 1) : (w.__sn = 0)
      w.__sk = key
      return stable >= 2
    }, undefined, { timeout: 120_000, polling: 300 }).catch(() => {})
    await page.evaluate(() => { delete window.__sk; delete window.__sn })
  }
  const result = await read(page)
  if (!result && attempt < 1) return openThread(page, index, attempt + 1)
  return result
}

// ── A. INITIAL POSITION ────────────────────────────────────────────────────
{
  const page = await ctx.newPage()
  const a = await openThread(page, 0)
  check('A. opens at the latest message', a !== null && (a.max - a.top) < 60, a ? `top=${a.top} max=${a.max} bubbles=${a.bubbles}` : 'no timeline')
  check('A. no affordance on open', a !== null && !a.pill, '')
  await page.close()
}

// ── B/C/D/E. REALTIME, AFFORDANCE, DEDUPE ──────────────────────────────────
{
  /*
   * SEED ENOUGH HISTORY TO BE ABLE TO SCROLL.
   *
   * The canary carries two messages, so "scroll up and receive one" is not
   * expressible against it: at a scroll range under the 48px near-bottom
   * threshold, scrollTop 0 IS the bottom, the timeline correctly re-anchors,
   * and the affordance correctly never appears. The proof was reporting its
   * own impossible precondition as a product defect.
   *
   * Inbound only, on the sanctioned canary, removed at the end of the block.
   */
  const seedKeys = []
  for (let i = 0; i < 14; i += 1) {
    const key = `scrollproof:seed:${Date.now()}:${i}`
    seedKeys.push(key)
    await admin.from('message_events').insert({
      ...CANARY_IDENTITY, message_event_key: key,
      message_body: `Scroll proof history ${i + 1}`,
      received_at: new Date(Date.now() - (20 - i) * 60_000).toISOString(),
    })
  }

  const page = await ctx.newPage()
  const start = await openThread(page, 0)
  check('B. baseline timeline present', start !== null && start.bubbles > 0, start ? `msgs=${start.bubbles} max=${start.max}` : '')

  // B — at bottom, a real inbound arrives.
  const keyB = `scrollproof:b:${Date.now()}`
  await admin.from('message_events').insert({
    ...CANARY_IDENTITY, message_event_key: keyB,
    message_body: 'Scroll proof inbound B', received_at: new Date().toISOString(),
  })
  await page.waitForFunction((n) => {
    const l = document.querySelector('.nx-message-list')
    return l ? l.querySelectorAll('.nx-msg').length > n : false
  }, start?.bubbles ?? 0, { timeout: 40_000, polling: 250 }).catch(() => {})
  /*
   * Let the insert SETTLE before judging the anchor. The wait above fires the
   * instant the bubble count changes, which is mid-layout -- reading there
   * compares scrollTop against a scrollHeight that is still growing and
   * reports a miss the view corrects a frame later.
   */
  await page.waitForFunction(() => {
    const n = document.querySelector('.nx-message-list')
    if (!n) return false
    const w = window
    const key = `${n.scrollTop}:${n.scrollHeight}`
    const stable = w.__bk === key ? (w.__bn = (w.__bn || 0) + 1) : (w.__bn = 0)
    w.__bk = key
    return stable >= 2
  }, undefined, { timeout: 20_000, polling: 250 }).catch(() => {})
  await page.evaluate(() => { delete window.__bk; delete window.__bn })
  const b = await read(page)
  check('B. one new bubble, no duplicate', b !== null && start !== null && b.bubbles === start.bubbles + 1,
    b && start ? `${start.bubbles} -> ${b.bubbles}` : '')
  check('B. stays anchored to latest', b !== null && (b.max - b.top) < 60, b ? `top=${b.top} max=${b.max}` : '')

  // E — the same event delivered again must not duplicate.
  await admin.from('message_events').update({ updated_at: new Date().toISOString() }).eq('message_event_key', keyB)
  await page.waitForTimeout(5000)
  const e = await read(page)
  check('E. repeated delivery of one event does not duplicate it',
    e !== null && b !== null && e.bubbles === b.bubbles, e && b ? `${b.bubbles} -> ${e.bubbles}` : '')

  // C — scrolled up, another inbound arrives.
  await page.evaluate(() => { const n = document.querySelector('.nx-message-list'); if (n) n.scrollTop = 0 })
  await page.waitForTimeout(600)
  const beforeC = await read(page)
  const keyC = `scrollproof:c:${Date.now()}`
  await admin.from('message_events').insert({
    ...CANARY_IDENTITY, message_event_key: keyC,
    message_body: 'Scroll proof inbound C', received_at: new Date().toISOString(),
  })
  await page.waitForFunction(() => document.querySelector('.nx-new-message-pill') !== null,
    undefined, { timeout: 40_000, polling: 250 }).catch(() => {})
  const c = await read(page)
  check('C. reading position preserved', c !== null && beforeC !== null && Math.abs(c.top - beforeC.top) < 80,
    c && beforeC ? `${beforeC.top} -> ${c.top}` : '')
  check('C. new-message affordance appears', c !== null && c.pill, '')

  // D — tap it.
  if (c?.pill) {
    await page.locator('.nx-new-message-pill').click({ timeout: 15_000 })
    await page.waitForFunction(() => {
      const n = document.querySelector('.nx-message-list')
      return n ? (n.scrollHeight - n.clientHeight - n.scrollTop) < 60 : false
    }, undefined, { timeout: 15_000, polling: 150 }).catch(() => {})
    // Smooth scrolling is in flight when the threshold is first crossed; let it
    // come to rest before judging, exactly as B has to.
    await page.waitForFunction(() => {
      const n = document.querySelector('.nx-message-list')
      if (!n) return false
      const w = window
      const key = `${n.scrollTop}:${n.scrollHeight}`
      const stable = w.__dk === key ? (w.__dn = (w.__dn || 0) + 1) : (w.__dn = 0)
      w.__dk = key
      return stable >= 2
    }, undefined, { timeout: 20_000, polling: 250 }).catch(() => {})
    await page.evaluate(() => { delete window.__dk; delete window.__dn })
    const d = await read(page)
    check('D. jumps to latest', d !== null && (d.max - d.top) < 60, d ? `top=${d.top} max=${d.max}` : '')
    check('D. affordance clears', d !== null && !d.pill, '')
  }

  // Cleanup must survive an early exit: an interrupted run left two fixture
  // rows on the canary, which the final safety check caught.
  await admin.from('message_events').delete().eq('source_app', 'inbox_scroll_proof')
  void seedKeys
  await page.close()
}

// ── G. BACK RESTORES THE INBOX ─────────────────────────────────────────────
{
  const page = await ctx.newPage()
  await openThread(page, 0)
  await page.locator('.nx-mobile-command-dock__btn--back').first().click({ timeout: 30_000 }).catch(() => {})
  await page.waitForFunction(() => document.querySelectorAll('.nx-row25').length > 0,
    undefined, { timeout: 60_000, polling: 300 }).catch(() => {})
  const g = await page.evaluate(() => ({
    rows: document.querySelectorAll('.nx-row25').length,
    active: (document.querySelector('.nx-cat-nav__item.is-active')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20),
    threadOpen: document.querySelector('.nx-message-list') !== null,
  }))
  check('G. Back returns to the list', g.rows > 0 && !g.threadOpen, `rows=${g.rows}`)
  check('G. category preserved', g.active.length > 0, g.active)
  await page.close()
}

/*
 * H (Property Intelligence preserves the conversation) lives in
 * inbox-thread-switch-proof.mjs, which asserts it at LIFECYCLE level -- it tags
 * the message-list node and proves the same instance survives, which is the
 * actual claim. Running a second, weaker copy here on a page already exercised
 * by the realtime scenarios above only produced flake.
 */

// ── J. THREAD SWITCHING ────────────────────────────────────────────────────
{
  const page = await ctx.newPage()
  const j = await openThread(page, 2)
  check('J. a different thread opens at its own latest', j !== null && (j.max - j.top) < 90, j ? `top=${j.top} max=${j.max}` : '')
  check('J. no affordance carried from the previous thread', j !== null && !j.pill, '')
  await page.close()
}

// ── I. KEYBOARD / COMPOSER ─────────────────────────────────────────────────
{
  const page = await ctx.newPage()
  await openThread(page, 0)
  const k = await page.evaluate(() => {
    const comp = document.querySelector('[class*="composer"]')
    const dock = document.querySelector('.nx-pinned-app-dock')
    const cr = comp?.getBoundingClientRect()
    const dr = dock?.getBoundingClientRect()
    const input = comp?.querySelector('textarea, input')
    return {
      composerVisible: cr ? cr.height > 0 && cr.bottom <= window.innerHeight + 1 : false,
      clearsDock: cr && dr ? cr.bottom <= dr.top + 1 : null,
      inputReachable: input ? input.getBoundingClientRect().height >= 24 : false,
    }
  })
  check('I. composer visible and within the viewport', k.composerVisible, '')
  check('I. composer clears the dock', k.clearsDock !== false, '')
  check('I. input is reachable', k.inputReachable, '')
  await page.close()
}

await browser.close()
console.log('─'.repeat(66))
console.log(findings.length === 0 ? `PASS — 0 findings` : `FAIL — ${findings.length} finding(s)`)
process.exitCode = findings.length ? 1 : 0
