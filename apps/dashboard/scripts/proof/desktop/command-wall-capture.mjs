import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startStaticServer, loadFixture, installWallMock, busiestWindowStart } from './command-wall-mock.mjs'
/**
 * COMMAND WALL capture (READ ONLY, MOCKED WALL API — never production).
 * Serves a production build locally, replays a recorded event stream through
 * the mock wall API, and captures the brief §74 scenes.
 *
 *   node scripts/proof/desktop/command-wall-capture.mjs --fixture=<replay-privacy.json> [--ops=<replay-operations.json>]
 *        --out=<dir> [--scenes=national,pulse,...] [--variants=1920x1080:dark,1920x1080:true_black,3840x2160:dark,3840x2160:true_black]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const OUT = path.resolve(arg('out', '/tmp/cw-shots'))
const FIXTURE = loadFixture(arg('fixture', '/Users/ryankindle/.claude/jobs/c39b0175/tmp/command-wall/replay-raw.json'))
const OPS = arg('ops', null) ? loadFixture(arg('ops')) : null
const DIST = arg('dist', '/tmp/cw-dist')
const SCENES = arg('scenes', 'national,pulse,campaign_ops,mi,signal,reconnect,privacy,oled,pairing').split(',')
const VARIANTS = arg('variants', '1920x1080:dark,1920x1080:true_black,3840x2160:dark,3840x2160:true_black').split(',').map((v) => { const [s, theme] = v.split(':'); const [w, h] = s.split('x').map(Number); return { w, h, theme } })
const GPU = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
await fs.mkdir(OUT, { recursive: true })
const { server, base } = await startStaticServer(DIST)
const browser = await chromium.launch({ args: GPU })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 25 * 60_000)
const start = busiestWindowStart(FIXTURE)
const report = []

const SCENE = {
  national: { preset: 'national_command' },
  pulse: { preset: 'acquisition_pulse', camera_mode: 'static' },
  campaign_ops: { preset: 'campaign_operations', privacy_mode: 'operations' },
  mi: { preset: 'market_intelligence', watched_markets: ['dallas-tx'] },
  signal: { preset: 'national_command' },
  reconnect: { preset: 'national_command', offline: true },
  privacy: { preset: 'national_command', privacy_mode: 'public_safe' },
  oled: { preset: 'national_command', oled_protection: 'high', oledPair: true },
  pairing: { paired: false },
}

for (const v of VARIANTS) {
  for (const name of SCENES) {
    const sc = SCENE[name]
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 1, serviceWorkers: 'block' })
    const fx = sc.fixture === 'ops' && OPS ? OPS : FIXTURE
    const { preset, privacy_mode, oled_protection, watched_markets, camera_mode } = sc
    const mock = await installWallMock(ctx, {
      fixture: fx, speed: 20, startAt: start, paired: sc.paired !== false,
      config: { config: { theme: v.theme, ...(preset ? { preset } : {}), ...(privacy_mode ? { privacy_mode } : {}), ...(oled_protection ? { oled_protection } : {}), ...(watched_markets ? { watched_markets } : {}), ...(camera_mode ? { camera_mode } : {}) } },
    })
    const page = await ctx.newPage()
    const P1 = 11 * 60_000
    const T1 = Math.floor(Date.now() / P1) * P1 + P1 / 4 // surface drift at its +x extreme
    if (sc.oledPair) { await page.clock.install({ time: T1 }); await page.clock.resume() }
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
    await page.goto(`${base}/wall?render=full`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const file = (suffix = '') => path.join(OUT, `${String(SCENES.indexOf(name) + 1).padStart(2, '0')}-${name}${suffix}-${v.w}x${v.h}-${v.theme}.png`)
    if (sc.paired === false) {
      await page.waitForSelector('.cw-pair__code span:not(.cw-pair__wait)', { timeout: 30_000 })
      await page.waitForTimeout(800)
      await page.screenshot({ path: file() })
    } else {
      await page.waitForSelector('.cw-stage', { timeout: 60_000 })
      // let the map load tiles and the replay deliver real arrivals
      await page.waitForFunction(() => document.querySelector('.cw-map canvas') || document.querySelector('.cw-atlas'), null, { timeout: 30_000 }).catch(() => {})
      await page.waitForTimeout(9_000)
      if (sc.offline) { mock.setOffline(true); await page.waitForSelector('.cw-conn', { timeout: 120_000 }).catch(() => {}); await page.waitForTimeout(1_000) }
      if (sc.oledPair) {
        // OLED drift: the same view at the two horizontal extremes of the surface path (half a period apart)
        const read = () => page.evaluate(() => ({ safe: document.querySelector('.cw-safe')?.style.transform, rail: document.querySelector('.cw-rail')?.style.transform, map: document.querySelector('.cw-stage__map')?.style.transform }))
        await page.clock.fastForward(21_000); await page.waitForTimeout(21_500)
        const a = await read()
        await page.screenshot({ path: file('-a') })
        await page.clock.fastForward(P1 / 2); await page.waitForTimeout(21_500)
        const b = await read()
        await page.screenshot({ path: file('-b') })
        console.log('oled drift', JSON.stringify({ a, b }))
        report.push({ scene: 'oled-measure', a, b })
      } else {
        await page.screenshot({ path: file() })
      }
    }
    const dbg = await page.evaluate(() => window.__lcWall?.debug?.() ?? null).catch(() => null)
    report.push({ scene: name, variant: `${v.w}x${v.h}:${v.theme}`, errors, renderMode: dbg?.renderMode, events: dbg?.events, requests: mock.state.counts })
    console.log(name, `${v.w}x${v.h}`, v.theme, dbg?.renderMode, 'events', dbg?.events, errors.length ? `ERR ${errors[0]}` : '')
    await ctx.close()
  }
}
await fs.writeFile(path.join(OUT, 'capture-report.json'), JSON.stringify(report, null, 2))
clearTimeout(watchdog)
await browser.close()
server.close()
