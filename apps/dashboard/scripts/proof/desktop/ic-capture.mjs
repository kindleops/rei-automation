/**
 * INTELLIGENCE COMMAND 8.5.17 CAPTURE — visual QA only, against a DEV server
 * started with the dev fixture flag (synthetic data; nothing here ships):
 *
 *   VITE_LC_IC_FIXTURES=1 npx vite --port 5417 --strictPort
 *   node scripts/proof/desktop/ic-capture.mjs --base=http://localhost:5417 --out=<dir>
 *
 * The app's own dev fetch double (fixtures/ic-dev-fixtures.ts) answers the
 * agent routes; any other /api request gets an empty 200 here and non-local
 * hosts are aborted, so no real API or data is touched.
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5417')
const OUT = path.resolve(arg('out', '/tmp/ic-shots'))
const ONLY = arg('only', '')
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const stats = { aborted: 0, errors: [], shots: [] }

async function open({ W = 1440, H = 900, theme = 'dark', route = '/intelligence-command' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const pg = await ctx.newPage()
  pg.on('pageerror', (e) => stats.errors.push(String(e.message).slice(0, 200)))
  await pg.route('**/*', (r) => {
    const u = new URL(r.request().url())
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (local && u.pathname.startsWith('/api/')) return r.fulfill({ status: u.pathname === '/api/cockpit/shell/telemetry' ? 503 : 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: null, items: [], rows: [], results: [] }) })
    if (local) return r.continue()
    stats.aborted += 1
    return r.abort()
  })
  await pg.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 240000 })
  await pg.waitForFunction(() => Boolean(window.__icDev), null, { timeout: 180000 })
  await pg.evaluate(() => { window.__icDev.speed = 1 })
  return { ctx, pg }
}

async function shot(pg, name, sel = null) {
  if (ONLY && !name.includes(ONLY)) return
  await pg.waitForTimeout(450)
  const file = path.join(OUT, `${name}.png`)
  if (sel) await (await pg.$(sel)).screenshot({ path: file })
  else await pg.screenshot({ path: file })
  stats.shots.push(path.basename(file))
}

const select = (pg) => pg.evaluate(() => window.__icDev.select({ propertyId: '9100001', address: '1418 Larkspur Ct · synthetic', threadKey: '+15550104471', opportunityId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }))
async function ask(pg, text, { limit = Infinity } = {}) {
  await pg.evaluate((n) => { window.__icDev.limit = n }, limit)
  await pg.click('.ic-conv .ic-composer textarea')
  await pg.fill('.ic-conv .ic-composer textarea', text)
  await pg.keyboard.press('Meta+Enter')
}
const waitDone = (pg) => pg.waitForSelector('.ic-turn__status.is-done', { timeout: 60000 })

for (const theme of ['dark', 'light']) {
  for (const [W, H, tag] of theme === 'dark' ? [[1440, 900, '1440'], [2560, 1440, '2560']] : [[1440, 900, '1440']]) {
    const { ctx, pg } = await open({ W, H, theme })
    await pg.waitForSelector('.ic-nav', { timeout: 120000 })
    await select(pg)
    // the focused pane is Intelligence Command itself: property + deal attach (a thread only from conversation apps)
    if (tag === '1440' && theme === 'dark') await shot(pg, `01-${theme}-${tag}-start-context`)
    if (tag === '1440' && theme === 'dark') {
      await ask(pg, 'Which of these has the strongest distress evidence, and is any of them listed?', { limit: 10 })
      await pg.waitForSelector('.ic-step.is-running, .ic-step', { timeout: 30000 })
      await pg.waitForTimeout(4500)
      await shot(pg, `02-${theme}-${tag}-running-steps`)
      await pg.evaluate(() => { window.__icDev.limit = 22 })
      await pg.waitForTimeout(2500)
      await shot(pg, `03-${theme}-${tag}-streaming`)
      await pg.evaluate(() => { window.__icDev.limit = Infinity })
    } else {
      await ask(pg, 'Which of these has the strongest distress evidence, and is any of them listed?')
    }
    await waitDone(pg)
    await pg.waitForTimeout(800)
    await pg.click('.ic-turn .ic-turn__acts button:has-text("Inspect")')
    await shot(pg, `04-${theme}-${tag}-result-inspector`)
    if (theme === 'dark' && tag === '1440') {
      await pg.click('.ic-turn .ic-turn__acts button:has-text("Steps")')
      await shot(pg, `05-${theme}-${tag}-steps-expanded`)
      // Plan
      await pg.click('.ic-conv .ic-modes__b:has-text("Plan")')
      await ask(pg, 'Plan the probate follow-through for 1418 Larkspur Ct')
      await pg.waitForFunction(() => document.querySelectorAll('.ic-turn__status.is-done').length >= 2, null, { timeout: 60000 })
      await pg.waitForTimeout(600)
      await shot(pg, `06-${theme}-${tag}-plan`)
      // Act → diff → approve
      await pg.click('.ic-conv .ic-modes__b:has-text("Act")')
      await pg.waitForSelector('.ic-act-opt', { timeout: 20000 })
      await pg.selectOption('.ic-conv .ic-field select', 'offer')
      await pg.fill('.ic-conv .ic-composer textarea', 'Seller asked for a number; probate verified')
      await shot(pg, `07-${theme}-${tag}-act-form`)
      await pg.keyboard.press('Meta+Enter')
      await pg.waitForSelector('.ic-diff.is-pending', { timeout: 20000 })
      await shot(pg, `08-${theme}-${tag}-act-diff-pending`)
      await pg.click('.ic-conv .ic-act .ic-btn.is-accept')
      await pg.waitForSelector('.ic-act .ic-diff.is-executed', { timeout: 20000 })
      await shot(pg, `09-${theme}-${tag}-act-approved`)
      for (const [i, s] of [['10', 'Missions'], ['11', 'Research'], ['12', 'Findings'], ['13', 'Approvals'], ['14', 'Activity'], ['15', 'Agent workforce'], ['16', 'System health']]) {
        await pg.click(`.ic-nav__i:has-text("${s}")`)
        await pg.waitForTimeout(s === 'Agent workforce' || s === 'System health' ? 2200 : 900)
        await shot(pg, `${i}-${theme}-${tag}-${s.toLowerCase().replace(/\s+/g, '-')}`)
      }
      await pg.click('.ic-nav__t:has-text("Seller AI")')
      await pg.waitForTimeout(800)
      await shot(pg, `17-${theme}-${tag}-shadow`)
    }
    if (theme === 'light') {
      await pg.keyboard.press("Meta+'")
      await shot(pg, `18-${theme}-${tag}-result-light`)
    }
    await ctx.close()
  }
}

// the ⌘' overlay over another app, with that page's context
{
  const { ctx, pg } = await open({ route: '/entity-graph' })
  await pg.waitForSelector('.cd', { timeout: 120000 }).catch(() => {})
  await select(pg)
  await pg.keyboard.press("Meta+'")
  await pg.waitForSelector('.ic-ov .ic-composer', { timeout: 20000 })
  await shot(pg, '19-dark-1440-overlay-context')
  await pg.evaluate(() => { window.__icDev.limit = 14 })
  await pg.fill('.ic-ov .ic-composer textarea', 'What distress evidence does this property have?')
  await pg.keyboard.press('Meta+Enter')
  await pg.waitForTimeout(6000)
  await shot(pg, '20-dark-1440-overlay-running')
  await pg.evaluate(() => { window.__icDev.limit = Infinity })
  await pg.waitForSelector('.ic-ov .ic-turn__status.is-done', { timeout: 60000 })
  await shot(pg, '21-dark-1440-overlay-result')
  await ctx.close()
}

// planes switched off: the truthful states
{
  const { ctx, pg } = await open({})
  await pg.evaluate(() => { window.__icDev.planes = 'off' })
  await pg.waitForSelector('.ic-nav', { timeout: 120000 })
  for (const [i, s] of [['22', 'Approvals'], ['23', 'Missions'], ['24', 'System health']]) {
    await pg.click(`.ic-nav__i:has-text("${s}")`)
    await pg.waitForTimeout(1500)
    await shot(pg, `${i}-dark-1440-off-${s.toLowerCase().replace(/\s+/g, '-')}`)
  }
  await pg.click('.ic-nav__i:has-text("Conversations")')
  await pg.click('.ic-conv .ic-modes__b:has-text("Act")')
  await pg.waitForTimeout(1200)
  await shot(pg, '25-dark-1440-off-act')
  await ctx.close()
}

await browser.close()
console.log(JSON.stringify({ out: OUT, ...stats }, null, 2))
