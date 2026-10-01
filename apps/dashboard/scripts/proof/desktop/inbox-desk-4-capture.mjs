import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * INBOX DESKTOP 4.0 capture (READ ONLY).
 *
 * Every non-GET request to /api or Supabase is aborted, so nothing here can
 * send, schedule, queue, suppress, mark read or change a stage. Opening a
 * thread fires the read-mark PATCH; it is aborted like every other write.
 *
 *   node scripts/proof/desktop/inbox-desk-4-capture.mjs --themes=dark,light --size=1440x900 \
 *     --states=priority,new_replies,needs_review,open,close --out=/tmp/inbox4
 *
 * States: priority · new_replies · needs_review · waiting · follow_up · more ·
 *         open (first row) · switch (second row while open) · close (Esc) ·
 *         context (row context menu) · search (Command Deck, Inbox scope) ·
 *         baseline (legacy list + open, for before/after)
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/inbox-desk-4'))
const THEMES = arg('themes', 'dark').split(',')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
const STATES = arg('states', 'priority,new_replies,needs_review,open,close').split(',')
const QUERY = arg('query', 'wendy')
const REDUCED = arg('reduced', '0') === '1'
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const results = []
const dog = setTimeout(() => { console.log('WATCHDOG', JSON.stringify(results)); process.exit(2) }, 600_000)

for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, serviceWorkers: 'block', reducedMotion: REDUCED ? 'reduce' : 'no-preference' })
  await ctx.addInitScript((t) => {
    try {
      if (!sessionStorage.getItem('__inbox4_capture')) { sessionStorage.clear(); sessionStorage.setItem('__inbox4_capture', '1') }
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      localStorage.removeItem('nexus.desktop.split')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      const p = JSON.parse(localStorage.getItem('nexus.desktop.shell') || '{}')
      localStorage.setItem('nexus.desktop.shell', JSON.stringify({ ...p, collapsed: false }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  const blocked = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 220)))
  await page.route('**/*', (r) => {
    const q = r.request()
    const u = new URL(q.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(q.method())) {
      blocked.push(`${q.method()} ${u.pathname}`)
      return r.abort()
    }
    return r.continue()
  })
  const R = { theme, size: `${W}x${H}`, shots: [] }
  const shot = async (name, clip) => {
    const file = path.join(OUT, `${theme}-${W}-${name}.png`)
    await page.screenshot({ path: file, ...(clip ? { clip } : {}) })
    R.shots.push(file)
  }
  const wait = (ms) => page.waitForTimeout(ms)

  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.waitForSelector('#nx-inbox-root', { timeout: 120000 })
  const desk = await page.locator('#nx-inbox-root.is-desk-inbox').count()
  R.desk = desk > 0
  const rowSel = R.desk ? '.ixl-row' : '.nx-row25'
  const t0 = Date.now()
  await page.waitForSelector(rowSel, { timeout: 180000 }).catch(() => {})
  R.firstRowsMs = Date.now() - t0
  await wait(1800)

  const lens = async (id) => {
    if (!R.desk) return false
    const btn = page.locator(`.ixl-lens [data-seg="${id}"]`)
    if (!(await btn.count())) return false
    await btn.first().click()
    await page.waitForSelector(`${rowSel}, .ixl-empty, .lc-empty`, { timeout: 90000 }).catch(() => {})
    await wait(1600)
    return true
  }
  const metrics = async () => page.evaluate(() => {
    const box = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) } }
    const counts = {}
    document.querySelectorAll('.ixl-lens [data-seg]').forEach((b) => { counts[b.getAttribute('data-seg')] = (b.querySelector('.ixl-lens__count')?.textContent ?? '').trim() })
    return {
      ledger: box('.nx-workspace-pane.is-view-thread'),
      room: box('.nx-workspace-pane.is-view-sms_thread'),
      composer: box('.nx-composer-dock'),
      rows: document.querySelectorAll('.ixl-row').length,
      lensCounts: counts,
      railInbox: (document.querySelector('.cr-row[data-app="inbox"] .crt__count')?.textContent ?? '').trim(),
      overflowX: document.documentElement.scrollWidth - innerWidth,
    }
  })

  for (const state of STATES) {
    try {
      if (state === 'baseline') {
        await shot('baseline-list')
        if (await page.locator(rowSel).count()) {
          await page.locator(rowSel).first().click()
          await wait(3500)
          await shot('baseline-open')
        }
        continue
      }
      if (['priority', 'new_replies', 'needs_review', 'waiting', 'follow_up'].includes(state)) {
        if (await lens(state)) { R[state] = await metrics(); await shot(`lens-${state}`) }
        continue
      }
      if (state === 'more') {
        const more = page.locator('.ixl-more-trigger')
        if (await more.count()) { await more.first().click(); await wait(500); await shot('more-menu'); await page.keyboard.press('Escape'); await wait(300) }
        continue
      }
      if (state === 'open') {
        await lens('priority')
        if (await page.locator(rowSel).count()) {
          await page.locator(rowSel).first().click()
          await wait(420)
          await shot('open-mid')
          await page.waitForSelector('.nx-msg__bubble, .nx-composer-dock', { timeout: 90000 }).catch(() => {})
          await wait(2600)
          R.open = await metrics()
          await shot('open')
        }
        continue
      }
      if (state === 'switch') {
        if (await page.locator(rowSel).count() > 1) {
          await page.locator(rowSel).nth(1).click()
          await wait(2600)
          R.switch = await metrics()
          await shot('switch')
        }
        continue
      }
      if (state === 'composer') {
        const dock = await page.locator('.nx-composer').boundingBox().catch(() => null)
        if (dock) await shot('composer', { x: Math.max(0, dock.x - 8), y: Math.max(0, dock.y - 60), width: Math.min(W - Math.max(0, dock.x - 8), dock.width + 16), height: Math.min(H - Math.max(0, dock.y - 60), dock.height + 68) })
        continue
      }
      if (state === 'close') {
        await page.locator('.ixl-list').first().focus().catch(() => {})
        await page.keyboard.press('Escape')
        await wait(160)
        await shot('close-mid')
        await wait(900)
        R.close = await metrics()
        await shot('closed')
        continue
      }
      if (state === 'context') {
        const row = page.locator(rowSel).first()
        if (await row.count()) {
          await row.click({ button: 'right' })
          await wait(500)
          await shot('context-menu')
          await page.keyboard.press('Escape')
          await wait(300)
        }
        continue
      }
      if (state === 'hover') {
        const row = page.locator(rowSel).nth(2)
        if (await row.count()) { await row.hover(); await wait(400); await shot('row-hover') }
        continue
      }
      if (state === 'keys') {
        await page.locator('.ixl-list').first().focus().catch(() => {})
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await wait(300)
        await shot('keys-cursor')
        continue
      }
      if (state === 'search') {
        await page.keyboard.press('Meta+k')
        await wait(500)
        await page.keyboard.type(QUERY, { delay: 60 })
        await page.waitForSelector('.dsk-cmd__item', { timeout: 30000 }).catch(() => {})
        await wait(4200)
        R.search = await page.evaluate(() => [...document.querySelectorAll('.dsk-cmd__item')].slice(0, 10).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)))
        await shot('search')
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        await wait(300)
        continue
      }
    } catch (error) {
      R[`${state}_error`] = String(error?.message ?? error).slice(0, 200)
    }
  }
  R.errors = errors.slice(0, 8)
  R.blocked = blocked.slice(0, 20)
  results.push(R)
  await fs.writeFile(path.join(OUT, `${theme}-${W}-results.json`), JSON.stringify(R, null, 2))
  await ctx.close()
}
clearTimeout(dog)
console.log(JSON.stringify(results, null, 1))
await browser.close()
