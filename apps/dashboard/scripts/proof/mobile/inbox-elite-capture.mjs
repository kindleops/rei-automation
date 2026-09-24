import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * INBOX + CONVERSATION + COMPOSER — visual capture matrix.
 *
 * READ ONLY. Every non-GET API call is aborted, so opening a thread cannot mark
 * it read and nothing typed can be sent or saved. The composer draft typed for
 * the "ready" state is cleared before leaving the thread.
 *
 * Reaches each state by the selectors the components actually render (mapped
 * 2026-09-24), picks threads by what the list advertises rather than by index,
 * and waits on bubble count + scrollHeight stability before measuring — the
 * three causes of past false regressions in these proofs.
 *
 *   node scripts/proof/mobile/inbox-elite-capture.mjs --label=before
 *   node scripts/proof/mobile/inbox-elite-capture.mjs --label=after --width=393 --theme=dark
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const LABEL = arg('label', 'after')
const SIZES = { 375: 812, 390: 844, 393: 852, 430: 932 }
const WIDTHS = arg('width', '375,390,393,430').split(',').map(Number)
const THEMES = arg('theme', 'dark,light,true_black,red_ops').split(',')
const ONLY = arg('states', '') ? new Set(arg('states', '').split(',')) : null
const OUT = path.resolve(arg('out', `artifacts/inbox-elite/${LABEL}`))
await fs.mkdir(OUT, { recursive: true })

const INSTALL = () => {
  const proto = window.VisualViewport && window.VisualViewport.prototype
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'height')
  if (!desc || !desc.get) return
  const real = desc.get
  window.__kbPx = 0
  Object.defineProperty(proto, 'height', { configurable: true, get() { return real.call(this) - (window.__kbPx || 0) } })
  window.__setKeyboard = (px) => { window.__kbPx = px; window.visualViewport.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize')); return px }
}

const settleThread = (page) => page.evaluate(async () => {
  const deadline = Date.now() + 20000
  let last = '', since = Date.now()
  while (Date.now() < deadline) {
    const n = document.querySelector('.nx-message-list')
    const skel = document.querySelectorAll('.nx-chat-skeleton__bubble').length
    const key = n ? `${n.querySelectorAll('.nx-msg').length}:${n.scrollHeight}:${skel}` : 'none'
    if (key !== last) { last = key; since = Date.now() }
    else if (Date.now() - since > 1800 && n && !skel) return key
    await new Promise((r) => setTimeout(r, 150))
  }
  return last
})

const results = []
const browser = await chromium.launch()
for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const cell = `${width}-${theme}`
    const ctx = await browser.newContext({ viewport: { width, height: SIZES[width] ?? 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await ctx.addInitScript(INSTALL)
    await ctx.addInitScript((t) => {
      try {
        const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t }))
        localStorage.setItem('nx.inbox.catRailCollapsed', '1')
      } catch {}
    }, theme)
    const page = await ctx.newPage()
    const writes = []
    await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes.push(r.request().method()), r.abort())))
    const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)))
    const done = []; const missed = []
    const want = (s) => !ONLY || ONLY.has(s)
    const shot = async (state) => { await page.screenshot({ path: `${OUT}/${cell}-${state}.png` }); done.push(state) }
    const step = async (state, fn) => {
      if (!want(state)) return
      try { await fn() } catch (e) { missed.push(`${state}: ${String(e.message).split('\n')[0].slice(0, 90)}`) }
    }

    await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await page.waitForFunction(() => [...document.querySelectorAll('.nx-row25')].some((r) => (r.dataset.threadId || '').startsWith('ct:')), undefined, { timeout: 180000, polling: 400 }).catch(() => {})
    await page.waitForTimeout(1500)
    const theme_ = await page.evaluate(() => document.documentElement.getAttribute('data-nexus-theme'))

    await step('inbox', () => shot('inbox'))

    // The rail is always visible on the redesigned phone Inbox (no toggle);
    // the older layout needs its toggle opened first.
    const toggle = page.locator('button.nx-cat-nav__toggle')
    await step('rail', async () => {
      if (await toggle.count()) { await toggle.first().click(); await page.waitForTimeout(500) }
      await page.evaluate(() => { const r = document.querySelector('.nx-cat-nav'); if (r) r.scrollLeft = r.scrollWidth })
      await page.waitForTimeout(400); await shot('rail')
      await page.evaluate(() => { const r = document.querySelector('.nx-cat-nav'); if (r) r.scrollLeft = 0 })
      if (await toggle.count()) { await toggle.first().click(); await page.waitForTimeout(300) }
    })

    await step('filters', async () => {
      await page.locator('button[title="Advanced filters"]').first().click()
      await page.waitForSelector('.nx-ifm-modal', { timeout: 10000 }); await page.waitForTimeout(500)
      await shot('filters')
      await page.locator('.nx-ifm-close').first().click(); await page.waitForTimeout(400)
    })

    await step('long-row', async () => {
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.nx-row25')]
        const len = (r) => (r.querySelector('.nx-row25__name')?.textContent || '').length + (r.querySelector('.nx-row25__addr')?.textContent || '').length
        const best = rows.sort((a, b) => len(b) - len(a))[0]
        best?.scrollIntoView({ block: 'center' })
      })
      await page.waitForTimeout(500); await shot('long-row')
    })

    // After the bucket switch the list reloads and reorders; wait for hydrated
    // rows again and retry across candidates instead of trusting one position.
    let openError = ''
    const opened = await (async () => {
      await page.evaluate(() => { const s = document.querySelector('.nx-sidebar-rebuilt__threads-scroll'); if (s) s.scrollTop = 0 })
      await page.waitForFunction(() => [...document.querySelectorAll('.nx-row25')].filter((r) => (r.dataset.threadId || '').startsWith('ct:')).length >= 3, undefined, { timeout: 60000, polling: 400 }).catch(() => {})
      await page.waitForTimeout(2000)
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const target = await page.evaluate((k) => {
          const rows = [...document.querySelectorAll('.nx-row25')].filter((r) => (r.dataset.threadId || '').startsWith('ct:'))
          const withPreview = rows.filter((r) => (r.querySelector('.nx-row25__preview')?.textContent || '').trim().length > 12)
          const pool = withPreview.length ? withPreview : rows
          const r = pool[(1 + k) % Math.max(pool.length, 1)]
          return r ? { id: r.dataset.threadId, prop: r.dataset.propertyId || '' } : null
        }, attempt)
        if (!target) { openError = 'no hydrated rows'; continue }
        const sel = `.nx-row25[data-thread-id="${target.id}"]${target.prop ? `[data-property-id="${target.prop}"]` : ''}`
        try {
          const row = page.locator(sel).first()
          await row.scrollIntoViewIfNeeded({ timeout: 5000 })
          await page.waitForTimeout(300)
          // Rows answer touch, not mouse — the long-press multi-select wrapper owns pointer handling.
          await row.tap({ timeout: 5000 })
          await page.waitForSelector('.nx-inbox-shell.m-thread-open', { timeout: 15000 })
          await page.waitForSelector('.nx-message-list, .nx-chat-container.is-empty', { timeout: 30000 })
          await settleThread(page)
          return true
        } catch (e) {
          openError = String(e.message).split('\n')[0].slice(0, 90)
          await page.waitForTimeout(1500)
        }
      }
      return false
    })().catch((e) => { openError = String(e.message).slice(0, 90); return false })

    if (opened) {
      await step('conv-bottom', () => shot('conv-bottom'))
      await step('conv-top', async () => {
        await page.evaluate(() => { const n = document.querySelector('.nx-message-list'); if (n) n.scrollTop = 0 })
        await page.waitForTimeout(700); await shot('conv-top')
      })
      await step('conv-mid', async () => {
        await page.evaluate(() => { const n = document.querySelector('.nx-message-list'); if (n) n.scrollTop = (n.scrollHeight - n.clientHeight) / 2 })
        await page.waitForTimeout(700); await shot('conv-mid')
        await page.evaluate(() => { const n = document.querySelector('.nx-message-list'); if (n) n.scrollTop = n.scrollHeight })
        await page.waitForTimeout(500)
      })
      await step('stage', async () => {
        await page.locator('[aria-label^="Acquisition stage"]').first().click()
        await page.waitForSelector('.nx-conv-dropdown-portal', { timeout: 6000 }); await page.waitForTimeout(400)
        await shot('stage')
        await page.keyboard.press('Escape'); await page.waitForTimeout(300)
        if (await page.locator('.nx-conv-dropdown-portal').count()) { await page.locator('[aria-label^="Acquisition stage"]').first().click().catch(() => {}); await page.waitForTimeout(300) }
      })
      await step('linked', async () => {
        const b = page.locator('button.nx-active-prospect__expand').first()
        if (!(await b.count())) throw new Error('thread has no linked prospects control')
        await b.click(); await page.waitForTimeout(500); await shot('linked')
        await b.click().catch(() => {}); await page.waitForTimeout(300)
      })
      await step('composer-kb', async () => {
        const input = page.locator('.nx-composer-dock__input-wrap textarea').first()
        await input.click(); await input.fill('Hi — following up on the property. Still open to an offer?')
        await page.evaluate(() => window.__setKeyboard?.(Math.round(window.innerHeight * 0.4)))
        await page.waitForTimeout(700); await shot('composer-kb')
        await page.evaluate(() => window.__setKeyboard?.(0))
        await input.fill(''); await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
        await page.waitForTimeout(400)
      })
      const openQap = async () => {
        await page.locator('[aria-label="Open quick actions"]').first().click()
        await page.waitForSelector('.nx-quick-actions-popover', { timeout: 6000 })
        // Staged templates arrive after the sheet opens; wait for them rather than shooting "Loading…".
        await page.waitForSelector('.nx-qap-template-btn.is-staged', { timeout: 20000 }).catch(() => {})
        await page.waitForTimeout(450)
      }
      const closeQap = async () => {
        if (await page.locator('.nx-qap-close').count()) await page.locator('.nx-qap-close').first().click().catch(() => {})
        await page.waitForTimeout(350)
      }
      await step('quick-actions', async () => { await openQap(); await shot('quick-actions'); await closeQap() })
      await step('quick-templates', async () => {
        await openQap()
        await page.evaluate(() => document.querySelector('.nx-qap-template-btn')?.scrollIntoView({ block: 'center' }))
        await page.waitForTimeout(400); await shot('quick-templates'); await closeQap()
      })
      await step('browse-all', async () => {
        await openQap()
        await page.locator('.nx-qap-template-btn', { hasText: /browse all/i }).first().click()
        await page.waitForSelector('.nx-mtb', { timeout: 8000 }); await page.waitForTimeout(700)
        await shot('browse-all')
        await page.locator('.nx-mtb__close').first().click().catch(() => {}); await page.waitForTimeout(400)
      })
      await step('schedule', async () => {
        await openQap()
        await page.locator('.nx-qap-action-btn', { hasText: /schedule/i }).first().click()
        await page.waitForSelector('.nx-sp', { timeout: 8000 }); await page.waitForTimeout(500)
        await shot('schedule')
        await page.keyboard.press('Escape'); await page.waitForTimeout(300)
      })
    } else {
      missed.push(`conversation: could not open a thread (${openError})`)
    }

    // Unread/priority rows, via the Priority bucket, on a fresh load so the
    // bucket switch never disturbs the conversation states above.
    await step('unread', async () => {
      await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180000 })
      await page.waitForFunction(() => document.querySelectorAll('.nx-row25').length > 0, undefined, { timeout: 120000, polling: 400 })
      await page.waitForTimeout(1200)
      if (await page.locator('button.nx-cat-nav__toggle').count()) { await page.locator('button.nx-cat-nav__toggle').first().click(); await page.waitForTimeout(400) }
      await page.locator('.nx-cat-nav__item[data-category="priority"]').first().click()
      await page.waitForTimeout(3000)
      await shot('unread')
    })

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    results.push({ cell, theme: theme_, shots: done.length, missed, overflow, writesBlocked: writes.length, errs: errs.slice(0, 3) })
    console.log(JSON.stringify(results.at(-1)))
    await ctx.close()
  }
}
await browser.close()
