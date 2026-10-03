import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * REFINEMENT 8.3 — DESIGN SYSTEM capture (READ ONLY).
 * Accent · liquid glass · conversation composer · Command Deck.
 *
 * Every non-GET to /api or Supabase is aborted (opening a thread fires a
 * read-mark PATCH; it is aborted too). The composer is typed into but NEVER
 * submitted: no Enter in the composer, no click on Send / Launch /
 * Ownership Check (clicks are refused by name below).
 *
 *   node scripts/proof/desktop/r83-design-capture.mjs --themes=dark,true_black \
 *     --accents=cyan,violet --size=1440x900 --states=inbox,composer,qap,deck,home,notif,map \
 *     --tag=before --out=/tmp/r83
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/r83-design'))
const THEMES = arg('themes', 'dark').split(',')
const ACCENTS = arg('accents', 'cyan').split(',')
const SIZES = arg('size', '1440x900').split(',').map((s) => s.split('x').map(Number))
const STATES = arg('states', 'inbox,composer,qap,deck').split(',')
const TAG = arg('tag', 'after')
const QUERY = arg('query', 'dallas')
// --fixture: QA ONLY. The headless browser has no operator session (every
// local read 401s since the operator lockdown), so the inbox list + one
// thread are served from a labeled fixture. Shots are tagged "-fixture".
const FIXTURE = process.argv.includes('--fixture')
  ? JSON.parse(await fs.readFile(new URL('./fixtures/r83-inbox-design.json', import.meta.url), 'utf8'))
  : null
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const results = []
const dog = setTimeout(() => { console.log('WATCHDOG', JSON.stringify(results)); process.exit(2) }, 1_500_000)
const FORBIDDEN = /send|launch|ownership|retry|approve|publish|activate|suppress|confirm/i

for (const [W, H] of SIZES) for (const theme of THEMES) for (const accent of ACCENTS) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, serviceWorkers: 'block' })
  await ctx.addInitScript(([t, a]) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      localStorage.removeItem('nexus.desktop.split')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t, accentPalette: a }))
      const p = JSON.parse(localStorage.getItem('nexus.desktop.shell') || '{}')
      localStorage.setItem('nexus.desktop.shell', JSON.stringify({ ...p, collapsed: false }))
    } catch { /* ignore */ }
  }, [theme, accent])
  const page = await ctx.newPage()
  const errors = []
  const blocked = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', (r) => {
    const q = r.request()
    const u = new URL(q.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) {
      blocked.push(`${q.method()} ${u.pathname}`)
      return r.abort()
    }
    if (FIXTURE && q.method() === 'GET') {
      const json = (body) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      if (u.pathname === '/api/cockpit/inbox/live') return json({ ok: true, threads: FIXTURE.threads, data: { threads: FIXTURE.threads, counts: {} } })
      if (u.pathname === '/api/cockpit/inbox/counts') return json({ ok: true, data: { priority: FIXTURE.threads.length, new_replies: 2 } })
      if (u.pathname === '/api/cockpit/inbox/thread-hydration') return json({ ok: true, messages: FIXTURE.messages, data: { messages: FIXTURE.messages } })
      if (u.pathname === '/api/cockpit/inbox/thread-messages') {
        const key = u.searchParams.get('thread_key')
        const m = key ? FIXTURE.messages : []
        return json({ ok: true, messages: m, data: { messages: m }, pagination: { total: m.length, has_more: false } })
      }
    }
    return r.continue()
  })
  const R = { theme, accent, size: `${W}x${H}`, shots: [] }
  const wait = (ms) => page.waitForTimeout(ms)
  const shot = async (name, clip) => {
    const file = path.join(OUT, `${TAG}-${name}-${theme}-${accent}-${W}${FIXTURE ? '-fixture' : ''}.png`)
    await page.screenshot({ path: file, ...(clip ? { clip } : {}) })
    R.shots.push(path.basename(file))
  }
  const safeClick = async (loc, label) => {
    if (FORBIDDEN.test(label)) throw new Error(`refusing to click ${label}`)
    await loc.click()
  }
  const goto = async (route, sel) => {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await page.waitForSelector(sel, { timeout: 150000 })
  }
  try {
    const wantsInbox = STATES.some((s) => ['inbox', 'composer', 'qap'].includes(s))
    if (wantsInbox) {
      await goto('/inbox', '#nx-inbox-root')
      await page.waitForSelector('.ixl-row', { timeout: 180000 }).catch(() => {})
      await wait(1500)
      if (await page.locator('.ixl-row').count()) {
        await safeClick(page.locator('.ixl-row').first(), 'open thread row')
        await page.waitForSelector('.nx-msg__bubble', { timeout: 90000 }).catch(() => {})
        await wait(2800)
      }
      R.vars = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement)
        const out = document.querySelector('.nx-msg.is-outbound:not(.is-typing):not(.is-scheduled) .nx-msg__bubble')
        const ob = out ? getComputedStyle(out) : null
        return {
          accent: cs.getPropertyValue('--lc-accent').trim(),
          on: cs.getPropertyValue('--lc-accent-on').trim(),
          outBg: ob?.backgroundImage.slice(0, 140) || ob?.backgroundColor,
          outInk: ob?.color,
        }
      })
      if (STATES.includes('inbox')) await shot('inbox')
      const dock = page.locator('.nx-composer-dock').first()
      if (STATES.includes('composer') && await dock.count()) {
        const ta = page.locator('.nx-composer-dock textarea').first()
        const box = await dock.boundingBox()
        const clip = box ? { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 140), width: Math.min(W - Math.max(0, box.x - 40), box.width + 80), height: Math.min(H - Math.max(0, box.y - 140), box.height + 180) } : undefined
        await shot('composer-rest', clip)
        if (await ta.count() && !(await ta.isDisabled())) {
          await ta.focus()
          // typed, never submitted (no Enter)
          await ta.pressSequentially('Hi, just checking in on the property', { delay: 25 })
          await wait(250)
          await shot('composer-typing', clip)
          await ta.fill('')
          await page.locator('body').click({ position: { x: W - 30, y: H - 30 } }).catch(() => {})
        }
      }
      if (STATES.includes('qap') && await dock.count()) {
        const trigger = page.locator('.nx-composer-dock__side .nx-composer-tool-btn').first()
        if (await trigger.count()) {
          await safeClick(trigger, 'quick actions')
          await wait(600)
          await shot('qap')
          await page.keyboard.press('Escape')
          await wait(300)
          if (await page.locator('.nx-qap-anchor').count()) await page.locator('.nx-qap-backdrop').click({ force: true }).catch(() => {})
        }
      }
    }
    if (STATES.includes('deck')) {
      if (!wantsInbox) await goto('/pipeline', '.cd')
      await wait(800)
      await shot('deckbar', { x: 0, y: 0, width: W, height: 90 })
      await page.keyboard.press('Meta+k')
      await wait(400)
      await shot('deck-empty')
      await page.keyboard.type(QUERY, { delay: 50 })
      await page.waitForSelector('.dsk-cmd__item', { timeout: 30000 }).catch(() => {})
      await wait(3500)
      await shot('deck-results')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await wait(300)
    }
    if (STATES.includes('home')) {
      await goto('/home', '.hb .hb-w').catch(() => {})
      await wait(3500)
      await shot('home')
    }
    if (STATES.includes('notif')) {
      await page.waitForSelector('.cd-machine', { timeout: 60000 })
      if (!(await page.locator('.ncp').count())) await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click()
      await page.waitForSelector('.ncp', { timeout: 30000 }).catch(() => {})
      await wait(2500)
      await shot('notif')
      await page.keyboard.press('Escape')
    }
    if (STATES.includes('map')) {
      await goto('/map', '[data-ws-pane]')
      await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 90000 }).catch(() => {})
      await wait(6000)
      await shot('map')
    }
  } catch (error) {
    R.error = String(error?.message ?? error).slice(0, 240)
  }
  R.errors = errors.slice(0, 5)
  R.blocked = [...new Set(blocked)].slice(0, 10)
  results.push(R)
  console.log(JSON.stringify(R))
  await ctx.close()
}
clearTimeout(dog)
await browser.close()
