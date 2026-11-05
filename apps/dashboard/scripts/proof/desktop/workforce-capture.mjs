/**
 * WORKFORCE (Phase A) CAPTURE — visual QA only, against a DEV server started
 * with the fixture flag (synthetic records; nothing here ships):
 *
 *   VITE_LC_WF_FIXTURES=1 npx vite --port 5419 --strictPort
 *   node scripts/proof/desktop/workforce-capture.mjs --base=http://localhost:5419 --out=artifacts/workforce
 *
 * READ-ONLY. The app's fixture server (fixtures/wf-fixture-server.ts) answers
 * the Workforce routes in-process, so no Workforce request reaches a network.
 * Every other request is guarded here: a non-GET to anything is aborted,
 * a local /api GET gets an empty 200, a non-local host is aborted.
 *
 * Shots: every section at 1440×900 dark, Executive Command and Missions in
 * light, and both at pane widths 25 / 50 / 75 / 100 % of a 1920×1080
 * workspace (Shell split beside Settings).
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5419')
const OUT = path.resolve(arg('out', 'artifacts/workforce'))
const ONLY = arg('only', '')
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const stats = { aborted: 0, blocked: [], errors: [], shots: [] }

const LOCATOR = { propertyId: '9100037', threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: '2207 Bluebonnet Trl, Dallas' }

async function open({ W = 1440, H = 900, theme = 'dark', section = 'command', share = null, linked = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await ctx.addInitScript(({ t, s, share, loc }) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      localStorage.setItem('lc.wf.section.v1', s)
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      if (loc) sessionStorage.setItem('nexus:property-locator:v1', JSON.stringify({ ...loc, setAt: Date.now() }))
      else sessionStorage.removeItem('nexus:property-locator:v1')
      if (share && share < 1) {
        const layout = {
          root: { kind: 'split', id: 'sx', dir: 'row', children: [{ kind: 'pane', id: 'pa', tabs: ['ia'], active: 'ia' }, { kind: 'pane', id: 'pb', tabs: ['ib'], active: 'ib' }], sizes: [share, 1 - share] },
          instances: { ia: { id: 'ia', app: 'workforce', path: '/workforce', pinned: false }, ib: { id: 'ib', app: 'settings', path: '/settings', pinned: false } },
          focus: 'pa', primary: 'ia', maximized: null,
        }
        sessionStorage.setItem('lc.workspace.session.v1', JSON.stringify({ layout, linked: true, name: null, savedId: null, dirty: false }))
      } else sessionStorage.removeItem('lc.workspace.session.v1')
    } catch { /* ignore */ }
  }, { t: theme, s: section, share, loc: linked ? LOCATOR : null })
  const pg = await ctx.newPage()
  pg.on('pageerror', (e) => stats.errors.push(String(e.message).slice(0, 200)))
  await pg.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { stats.blocked.push(`${req.method()} ${u.pathname}`); return r.abort() }
    if (local && u.pathname.startsWith('/api/')) return r.fulfill({ status: u.pathname === '/api/cockpit/shell/telemetry' ? 503 : 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: null, items: [], rows: [], results: [] }) })
    if (local) return r.continue()
    stats.aborted += 1
    return r.abort()
  })
  await pg.goto(`${BASE}/workforce`, { waitUntil: 'domcontentloaded', timeout: 240000 })
  await pg.waitForSelector('.wf .wf-head', { timeout: 180000 })
  await pg.evaluate(() => { if (window.__wfFx) window.__wfFx.speed = 1 })
  await pg.waitForTimeout(1200)
  return { ctx, pg }
}

async function shot(pg, name) {
  if (ONLY && !name.includes(ONLY)) return
  await pg.waitForTimeout(500)
  const file = path.join(OUT, `${name}.png`)
  await pg.screenshot({ path: file })
  stats.shots.push(path.basename(file))
}

const clickRow = (pg, text) => pg.evaluate((t) => { const b = [...document.querySelectorAll('.wf-mrow')].find((x) => x.textContent.includes(t)); b?.scrollIntoView({ block: 'center' }); b?.click() }, text)
const waitThread = (pg) => pg.waitForFunction(() => document.querySelectorAll('.wf-thread .wf-msg').length > 0, null, { timeout: 30000 })
const goSection = async (pg, label) => {
  const nav = pg.locator(`.wf-nav__i[title="${label}"]`)
  if (await nav.isVisible().catch(() => false)) await nav.click()
  else await pg.locator('.wf-tabs [role="tab"]', { hasText: label.split(' ')[0] }).first().click()
  await pg.waitForTimeout(900)
}

// 1 · Executive Command: linked context → submit a directive → live progress → report
{
  const { ctx, pg } = await open({ linked: true })
  await waitThread(pg)
  await shot(pg, '01-dark-1440-command')
  await pg.click('.wf-linked__ask')
  await pg.waitForTimeout(300)
  await shot(pg, '02-dark-1440-command-linked-prefill')
  await pg.fill('.wf-composer textarea', 'Find the 10 most promising opportunities in Dallas and Minneapolis and get them moving.')
  await pg.keyboard.press('Enter')
  await pg.waitForSelector('.wf-mcard', { timeout: 20000 })
  await pg.waitForTimeout(9000)
  await shot(pg, '03-dark-1440-command-mission-live')
  await pg.waitForSelector('.wf-mcard.is-completed', { timeout: 60000 }).catch(() => {})
  await pg.waitForTimeout(1500)
  await shot(pg, '04-dark-1440-command-mission-done')
  await ctx.close()
}

// 2 · every other section, dark 1440
{
  const { ctx, pg } = await open({ section: 'organization' })
  await pg.waitForSelector('.wf-org__chart', { timeout: 30000 })
  await shot(pg, '05-dark-1440-organization')
  await goSection(pg, 'Employees')
  await pg.waitForSelector('.wf-emps .lc-grid, .wf-emps [role="grid"]', { timeout: 30000 }).catch(() => {})
  await shot(pg, '06-dark-1440-employees')
  await pg.locator('.wf-emps [role="row"]', { hasText: 'Scout' }).first().click()
  await pg.waitForSelector('.lc-insp .wf-charter', { timeout: 20000 })
  await shot(pg, '07-dark-1440-employee-profile')
  await pg.locator('.lc-insp [role="tab"]', { hasText: 'Memory' }).click()
  await pg.waitForSelector('.lc-insp .wf-facts', { timeout: 10000 })
  await pg.waitForTimeout(900)
  await shot(pg, '08-dark-1440-employee-memory')
  await pg.keyboard.press('Escape')
  await goSection(pg, 'Missions')
  await clickRow(pg, 'Top 10 opportunities')
  await pg.waitForSelector('.wf-report', { timeout: 20000 })
  await shot(pg, '09-dark-1440-missions-report')
  await pg.locator('.wf-mdetail__plan').scrollIntoViewIfNeeded()
  await pg.evaluate(() => document.querySelector('.wf-missions__detail')?.scrollTo({ top: document.querySelector('.wf-report__ranked')?.offsetTop ?? 600 }))
  await shot(pg, '10-dark-1440-missions-ranked')
  await pg.evaluate(() => document.querySelector('.wf-missions__detail')?.scrollTo({ top: 0 }))
  await clickRow(pg, 'Diagnose Dallas')
  await pg.waitForSelector('.wf-dag', { timeout: 20000 })
  await pg.evaluate(() => document.querySelector('.wf-missions__detail')?.scrollTo({ top: 0 }))
  await shot(pg, '11a-dark-1440-missions-active-plan')
  await pg.locator('.wf-mdetail__tabs [role="tab"]', { hasText: 'Assignments' }).click()
  await pg.evaluate(() => { const d = document.querySelector('.wf-missions__detail'); const t = document.querySelector('.wf-mdetail__tabs'); if (d && t) d.scrollTo({ top: t.offsetTop - 40 }) })
  await shot(pg, '11-dark-1440-missions-active-assignments')
  await pg.locator('.wf-mdetail__tabs [role="tab"]', { hasText: 'Events' }).click()
  await shot(pg, '12-dark-1440-missions-events')
  for (const [i, s] of [['13', 'Operations'], ['14', 'Work Queue'], ['15', 'Intelligence'], ['16', 'Financial Performance'], ['17', 'Authority Center'], ['18', 'Reports']]) {
    await goSection(pg, s)
    await pg.waitForTimeout(800)
    await shot(pg, `${i}-dark-1440-${s.toLowerCase().replace(/\s+/g, '-')}`)
  }
  await ctx.close()
}

// 3 · light: Executive Command + Missions
{
  const { ctx, pg } = await open({ theme: 'light', linked: true })
  await waitThread(pg)
  await shot(pg, '19-light-1440-command')
  await goSection(pg, 'Missions')
  await clickRow(pg, 'Top 10 opportunities')
  await pg.waitForSelector('.wf-report', { timeout: 20000 })
  await shot(pg, '20-light-1440-missions')
  await ctx.close()
}

// 4 · pane widths: Executive Command and Missions at 25 / 50 / 75 / 100 % of a 1920×1080 workspace
// (at 1440 a quarter pane is under the shell's cramped threshold for any app with minW > 405)
for (const share of [0.25, 0.5, 0.75, 1]) {
  const pct = Math.round(share * 100)
  {
    const { ctx, pg } = await open({ W: 1920, H: 1080, share, linked: true })
    await waitThread(pg)
    await shot(pg, `21-dark-1920-pane${pct}-command`)
    await ctx.close()
  }
  {
    const { ctx, pg } = await open({ W: 1920, H: 1080, share, section: 'missions' })
    await pg.waitForSelector('.wf-mrow', { timeout: 30000 })
    await clickRow(pg, 'Top 10 opportunities')
    await pg.waitForSelector('.wf-report', { timeout: 20000 })
    await shot(pg, `22-dark-1920-pane${pct}-missions`)
    await ctx.close()
  }
}

await browser.close()
console.log(JSON.stringify({ out: OUT, ...stats }, null, 2))
