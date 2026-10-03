import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * RC 8.2 desktop smoke walkthrough (READ ONLY). Every non-GET to /api or
 * Supabase is ABORTED and logged per step, so the walkthrough doubles as proof
 * that viewing a surface writes nothing. Never clicks Send / Launch / Arm.
 *
 *   node scripts/proof/desktop/rc82-smoke-capture.mjs --out=/tmp/rc82-smoke
 *
 * Steps: Home, Notifications plane, Signal Center, Composer (no launch),
 * Browser, Map focus, Inbox read-state (arrow-key navigation must not mark read).
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/rc82-smoke'))
const PID = arg('pid', '273312064')
const W = 1440, H = 900
await fs.mkdir(OUT, { recursive: true })

const log = { base: BASE, at: new Date().toISOString(), steps: [] }
const watchdog = setTimeout(async () => { log.watchdog = true; await fs.writeFile(path.join(OUT, 'smoke.json'), JSON.stringify(log, null, 2)); process.exit(2) }, 900_000)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H } })
await ctx.addInitScript(() => {
  try {
    const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
    localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: 'dark' }))
    localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
  } catch { /* ignore */ }
})
const page = await ctx.newPage()
let current = null
const errors = []
page.on('pageerror', (e) => errors.push({ step: current?.name, error: String(e.message).slice(0, 200) }))
await page.route('**/*', (r) => {
  const req = r.request()
  const u = new URL(req.url())
  if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
    current?.blockedWrites.push(`${req.method()} ${u.pathname}`)
    return r.abort()
  }
  return r.continue()
})
page.on('response', (res) => {
  const u = new URL(res.url())
  if (u.pathname.startsWith('/api/') && res.status() >= 400) current?.apiErrors.push(`${res.status()} ${u.pathname}`)
})

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })
const go = (p) => page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 120000 })

const ONLY = arg('only', '')
async function step(name, fn) {
  if (ONLY && !ONLY.split(',').some((k) => name.startsWith(k))) return
  current = { name, ok: false, notes: [], blockedWrites: [], apiErrors: [] }
  const t0 = Date.now()
  try { await fn(current); current.ok = true } catch (e) { current.notes.push(`FAILED: ${String(e.message).slice(0, 240)}`); await shot(`${name}-failed`).catch(() => {}) }
  current.ms = Date.now() - t0
  log.steps.push(current)
  console.log(`${current.ok ? 'PASS' : 'FAIL'} ${name} ${current.ms}ms writes=${current.blockedWrites.length} apiErrors=${current.apiErrors.length}`)
}

await step('01-home', async () => {
  await go('/home')
  await page.waitForSelector('.hb .hb-w', { timeout: 120000 })
  await page.waitForTimeout(4000)
  current.notes.push(`widgets=${await page.locator('.hb .hb-w').count()}`)
  await shot('01-home')
})

await step('02-notifications', async () => {
  await go('/pipeline')
  await page.waitForSelector('.cd-machine', { timeout: 120000 })
  await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click()
  await page.waitForSelector('.ncp, .lcnc-panel', { timeout: 30000 })
  await page.waitForTimeout(3000)
  current.notes.push(`stories=${await page.locator('.ncs').count()}`)
  await shot('02-notifications')
})

await step('03-signal-center', async () => {
  // NC 2.0: Alerts & Signals open INSIDE the plane (settings face)
  if (!(await page.locator('.ncp').count())) await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click()
  await page.waitForSelector('.ncp', { timeout: 30000 })
  await page.locator('.ncp [aria-label="Alerts & Signals"]').first().click()
  await page.waitForSelector('.ncp-set__sig, .lcsig', { timeout: 30000 })
  await page.waitForTimeout(3000)
  current.notes.push(`text=${(await page.locator('.ncp-set, .lcsig').first().innerText()).replace(/\s+/g, ' ').slice(0, 400)}`)
  await shot('03-signal-center')
  await page.keyboard.press('Escape')
})

await step('04-composer-no-launch', async () => {
  await go('/campaign-command?compose=1')
  await page.waitForSelector('.ccz', { timeout: 120000 })
  await page.waitForTimeout(5000)
  await shot('04-composer')
})

await step('05-browser', async () => {
  await go('/browser')
  await page.waitForSelector('.lcb-start, .lcb', { timeout: 120000 })
  await page.waitForTimeout(2000)
  await shot('05-browser-start')
  const q = new URLSearchParams({ do: 'research', kind: 'property', id: PID, label: 'smoke', n: `rc82${Date.now().toString(36)}` })
  await go(`/browser?${q}`)
  await page.waitForSelector('.lcb-launch__group, .lcb', { timeout: 120000 })
  await page.waitForTimeout(2000)
  await shot('05-browser-research')
})

await step('06-map-focus', async () => {
  await go('/map')
  await page.waitForSelector('.dsk-pane__body canvas, canvas.maplibregl-canvas', { timeout: 120000 })
  await page.waitForTimeout(6000)
  await page.evaluate((pid) => window.dispatchEvent(new CustomEvent('nexus:map-property-focus', { detail: { seq: Date.now() + 900000, propertyId: pid, label: null, threadKey: null, lat: null, lng: null, source: 'capture', at: Date.now() } })), PID)
  await page.waitForTimeout(5000)
  await shot('06-map-focus')
})

await step('07-inbox-read-state', async () => {
  await go('/inbox')
  await page.waitForSelector('[role="option"] .ixl-row__who', { timeout: 300000 })
  await page.waitForTimeout(1500)
  await shot('07-inbox')
  // keyboard navigation through the list must never mark a conversation read
  await page.locator('[role="option"]').first().focus().catch(() => {})
  const before = current.blockedWrites.length
  for (let i = 0; i < 4; i += 1) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(700) }
  const navWrites = current.blockedWrites.slice(before)
  current.notes.push(`arrow-nav writes attempted: ${navWrites.length ? navWrites.join(', ') : 'none'}`)
  await shot('07-inbox-after-nav')
  if (navWrites.some((w) => /read|thread-state|inbox_thread_state/i.test(w))) throw new Error(`navigation attempted a read-state write: ${navWrites.join(', ')}`)
  // positive control: opening a row IS the read (the PATCH is attempted, and aborted by the guard)
  const b2 = current.blockedWrites.length
  await page.locator('[role="option"]').nth(1).click()
  await page.waitForTimeout(3000)
  current.notes.push(`open-row writes attempted (aborted): ${current.blockedWrites.slice(b2).join(', ') || 'none'}`)
  await shot('07-inbox-open')
})

log.pageErrors = errors
clearTimeout(watchdog)
await fs.writeFile(path.join(OUT, 'smoke.json'), JSON.stringify(log, null, 2))
await browser.close()
console.log(`wrote ${OUT}/smoke.json`)
