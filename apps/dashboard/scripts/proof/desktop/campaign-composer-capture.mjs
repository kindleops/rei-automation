import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * CAMPAIGN COMPOSER 2.0 capture (READ ONLY, real data).
 *
 * Guard: every non-GET to /api or Supabase is ABORTED (except read-only
 * rpc/get_* reads). The Composer's reads are GET. Nothing is created, saved,
 * prepared or launched. The one exception is opt-in (--fixture-review): the
 * review sheet's `save` / `prepare` POSTs are FULFILLED IN THE BROWSER from a
 * fixture built from the real read-only Dallas audience, so the launch
 * summary can be photographed without a write. `launch` is always aborted and
 * never clicked.
 *
 *   node scripts/proof/desktop/campaign-composer-capture.mjs --cases=blank,dallas --themes=dark --size=1440x900 --out=/tmp/composer
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/campaign-composer'))
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('size', '1440x900').split(',').map((s) => s.split('x').map(Number))
const CASES = arg('cases', 'blank,dallas').split(',')
const SCALE = Number(arg('scale', 1))
const FIXTURE_REVIEW = arg('fixture-review', '0') === '1'
await fs.mkdir(OUT, { recursive: true })

const MARKET_URL = (m) => `/campaign-command?compose=1&market=${encodeURIComponent(m)}`
const CASE_ROUTES = {
  blank: '/campaign-command?compose=1',
  dallas: MARKET_URL('Dallas, TX'),
  minneapolis: MARKET_URL('Minneapolis, MN'),
  nosender: MARKET_URL('Charlotte, NC'),
  miami: MARKET_URL('Miami, FL'),
  multizone: MARKET_URL('Dallas, TX|Minneapolis, MN|Los Angeles, CA|Miami, FL'),
  houston: MARKET_URL('Houston, TX'),
  map: MARKET_URL('Minneapolis, MN'),
  phoenix: MARKET_URL('Dallas, TX|Phoenix, AZ'),
}

const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 1_500_000)
const blocked = []
for (const [W, H] of SIZES) for (const theme of THEMES) for (const kase of CASES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      localStorage.removeItem('lc.campaignComposer')
      sessionStorage.removeItem('lc.workspace.session.v1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 240)))
  await page.route('**/*', async (r) => {
    const req = r.request()
    const u = new URL(req.url())
    const isApi = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
    if (!isApi || ['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return r.continue()
    if (/\/rest\/v1\/rpc\/get_/.test(u.pathname)) return r.continue()
    if (FIXTURE_REVIEW && u.pathname === '/api/cockpit/campaigns/composer') {
      const body = JSON.parse(req.postData() || '{}')
      if (body.action === 'save') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, campaign_id: 'fixture-draft', created: true }) })
      if (body.action === 'prepare') {
        const fx = JSON.parse(await fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/composer-prepare-dallas.json'), 'utf8'))
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx) })
      }
    }
    blocked.push(`${req.method()} ${u.pathname}`)
    return r.abort()
  })
  const tag = `${theme}-${W}x${H}-${kase}`
  await page.goto(`${BASE}${CASE_ROUTES[kase] ?? CASE_ROUTES.blank}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.ccz', { timeout: 120000 })
  const shot = (name, opts = {}) => page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`), ...opts })
  const plane = (layer) => page.locator(`#ccz-${layer}`)
  if (kase === 'blank') {
    await page.waitForFunction(() => !document.querySelector('.ccz-quick:disabled em')?.textContent?.startsWith('Reading'), null, { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(2500)
    await shot('blank')
  } else {
    // the audience read is a real dry-run preview (~10 s on a cold API)
    await page.waitForFunction(() => {
      const big = document.querySelector('.ccz-big')
      return big && /\d/.test(big.textContent || '') || document.querySelector('.ccz-aud .ccz-err')
    }, null, { timeout: 240000 }).catch(() => console.log(tag, 'note: audience did not settle'))
    await page.waitForSelector('.ccz-strat', { timeout: 120000 }).catch(() => {})
    // the authoritative whole-cohort count (the build's own pipeline) lands after the sample
    await page.waitForFunction(() => /Whole cohort/.test(document.querySelector('.ccz-aud')?.textContent || ''), null, { timeout: 240000 }).catch(() => console.log(tag, 'note: whole cohort not counted'))
    await page.waitForTimeout(2500)
    if (kase !== 'nosender') await page.fill('.ccz-name', kase === 'dallas' ? 'Dallas · first touch' : `${kase} · QA`)
    await page.waitForTimeout(1800)
    if (kase === 'map') {
      // Map beside the Composer through the Composer's own control (workspace openApp 'beside')
      await page.locator('.ccz-head__meta button', { hasText: 'Map beside' }).click()
      await page.waitForTimeout(12000)
    }
    await shot('full')
    for (const layer of ['audience', 'strategy', 'delivery', 'schedule', 'launch']) {
      const el = plane(layer)
      if (await el.count()) { await el.scrollIntoViewIfNeeded().catch(() => {}); await el.screenshot({ path: path.join(OUT, `${tag}-${layer}.png`) }).catch(() => {}) }
    }
    if (kase === 'phoenix' || kase === 'multizone') {
      // open the labelled Routing 2.0 preview (read-only disclosure)
      await page.waitForSelector('.ccz-cov__row', { timeout: 120000 }).catch(() => {})
      await page.locator('.ccz-v2__toggle').click().catch(() => {})
      await page.waitForTimeout(600)
      await plane('delivery').screenshot({ path: path.join(OUT, `${tag}-delivery-v2.png`) }).catch(() => {})
      console.log(tag, 'coverage', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.ccz-cov__row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()))))
      console.log(tag, 'duration', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.ccz-schedule .ccz-kv')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()))))
    }
    await page.locator('.ccz-dock').screenshot({ path: path.join(OUT, `${tag}-dock.png`) }).catch(() => {})
    if (kase === 'dallas' && arg('missed', '0') === '1') {
      await page.locator('.ccz-sched__ctl [role="radio"]', { hasText: 'Scheduled' }).click().catch(() => {})
      await page.waitForTimeout(400)
      await page.fill('.ccz-dt', '2026-10-01T09:00')
      await page.waitForTimeout(900)
      await plane('schedule').screenshot({ path: path.join(OUT, `${tag}-missed.png`) }).catch(() => {})
      if (kase === 'phoenix' || kase === 'multizone') {
      // open the labelled Routing 2.0 preview (read-only disclosure)
      await page.waitForSelector('.ccz-cov__row', { timeout: 120000 }).catch(() => {})
      await page.locator('.ccz-v2__toggle').click().catch(() => {})
      await page.waitForTimeout(600)
      await plane('delivery').screenshot({ path: path.join(OUT, `${tag}-delivery-v2.png`) }).catch(() => {})
      console.log(tag, 'coverage', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.ccz-cov__row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()))))
      console.log(tag, 'duration', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.ccz-schedule .ccz-kv')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()))))
    }
    await page.locator('.ccz-dock').screenshot({ path: path.join(OUT, `${tag}-blocked-dock.png`) }).catch(() => {})
      await page.locator('.ccz-missed button', { hasText: 'Start now' }).click().catch(() => {})
      await page.waitForTimeout(600)
    }
    if (kase === 'dallas' && FIXTURE_REVIEW) {
      const go = page.locator('.ccz-go')
      if (await go.isEnabled()) {
        await go.click()
        await page.waitForSelector('.ccz-review__grid', { timeout: 60000 }).catch(() => {})
        await page.waitForTimeout(1200)
        await shot('launch-summary')
        await page.keyboard.press('Escape')
      } else console.log(tag, 'review disabled — not ready')
    }
  }
  const metrics = await page.evaluate(() => {
    const root = document.querySelector('.ccz')
    const stage = document.querySelector('.ccz-stage')
    return {
      overflowX: stage ? stage.scrollWidth > stage.clientWidth + 1 : null,
      big: document.querySelector('.ccz-big')?.textContent ?? null,
      readiness: [...document.querySelectorAll('.ccz-check')].map((c) => `${c.className.replace(/.*is-/, '')}:${c.querySelector('.ccz-check__v')?.textContent}`),
      width: root?.getBoundingClientRect().width,
    }
  })
  console.log(tag, JSON.stringify(metrics), errors.length ? `errors=${JSON.stringify(errors)}` : '')
  await ctx.close()
}
console.log('blocked non-GET:', JSON.stringify([...new Set(blocked)]))
clearTimeout(watchdog)
await browser.close()
