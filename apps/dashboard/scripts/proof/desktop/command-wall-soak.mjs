import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startStaticServer, loadFixture, installWallMock } from './command-wall-mock.mjs'
/**
 * COMMAND WALL SOAK (READ ONLY, REPLAYED DATA — never production).
 * Runs the production build against the mock wall API replaying a recorded
 * real event stream at 1× (or --speed), samples renderer memory/CPU via CDP,
 * listener/node/timer counts, map FPS and request rate every minute, and injects
 * faults: offline, server 503, revoke+re-pair, config change.
 *
 *   node scripts/proof/desktop/command-wall-soak.mjs --minutes=150 --out=<dir> [--size=1920x1080] [--theme=dark] [--render=full] [--speed=1]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const MINUTES = Number(arg('minutes', '150'))
const OUT = path.resolve(arg('out', '/tmp/cw-soak'))
const [W, H] = arg('size', '1920x1080').split('x').map(Number)
const THEME = arg('theme', 'dark')
const RENDER = arg('render', 'full')
const SPEED = Number(arg('speed', '1'))
const FIXTURE = loadFixture(arg('fixture', '/Users/ryankindle/.claude/jobs/c39b0175/tmp/command-wall/replay-raw.json'))
const PRESET = arg('preset', 'national_command')
await fs.mkdir(OUT, { recursive: true })
const { server, base } = await startStaticServer(arg('dist', '/tmp/cw-dist'))
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, serviceWorkers: 'block' })
const mock = await installWallMock(ctx, { fixture: FIXTURE, speed: SPEED, startAt: Date.parse(FIXTURE.recorded_from) + 2 * 3600_000, config: { config: { theme: THEME, preset: PRESET, privacy_mode: 'privacy', oled_protection: 'low', rotation: { enabled: PRESET === 'rotation', steps: [] } } } })
const page = await ctx.newPage()
const errors = []
let loads = 0
page.on('pageerror', (e) => errors.push({ at: Date.now(), msg: String(e.message).slice(0, 200) }))
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|status of (401|503)/.test(m.text())) errors.push({ at: Date.now(), msg: `console: ${m.text().slice(0, 160)}` }) })
page.on('load', () => { loads += 1 })
const cdp = await ctx.newCDPSession(page)
await cdp.send('Performance.enable', { timeDomain: 'threadTicks' })
const t0 = Date.now()
await page.goto(`${base}/wall?render=${RENDER}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForSelector('.cw-stage', { timeout: 90_000 })

const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
const fps = () => page.evaluate(() => new Promise((resolve) => { let n = 0; const start = performance.now(); const step = () => { n += 1; if (performance.now() - start < 3000) requestAnimationFrame(step); else resolve(Math.round((n / ((performance.now() - start) / 1000)) * 10) / 10) }; requestAnimationFrame(step) }))
const samples = []
const faults = [
  { at: 30, dur: 3, name: 'offline', on: () => mock.setOffline(true), off: () => mock.setOffline(false) },
  { at: 60, dur: 4, name: 'server_503', on: () => mock.setServerDown(true), off: () => mock.setServerDown(false) },
  { at: 90, dur: 2, name: 'revoked_then_repaired', on: () => mock.setRevoked(true), off: () => mock.setRevoked(false) },
  { at: 110, dur: 0, name: 'config_change_theme', on: () => mock.setConfig({ config: { ...mock.state.config.config, theme: THEME === 'dark' ? 'true_black' : 'dark' } }), off: () => {} },
]
const log = []
let prevTask = null
let prevT = null
for (let minute = 1; minute <= MINUTES; minute += 1) {
  await page.waitForTimeout(Math.max(0, t0 + minute * 60_000 - Date.now()))
  for (const f of faults) {
    if (minute === f.at) { f.on(); log.push({ minute, fault: f.name, phase: 'start' }) }
    if (minute === f.at + f.dur && f.dur > 0) { f.off(); log.push({ minute, fault: f.name, phase: 'end' }) }
  }
  const m = await metric().catch(() => ({}))
  const dbg = await page.evaluate(() => ({ wall: window.__lcWall?.debug?.() ?? null, markers: document.querySelectorAll('.maplibregl-marker').length, pulses: document.querySelectorAll('.cw-pulse').length, canvas: document.querySelectorAll('canvas').length, paired: Boolean(document.querySelector('.cw-stage')), pairing: Boolean(document.querySelector('.cw-pair')) })).catch(() => null)
  const f = minute % 5 === 0 ? await fps().catch(() => null) : null
  const now = Date.now()
  const cpu = prevTask !== null && m.TaskDuration !== undefined ? Math.round(((m.TaskDuration - prevTask) / ((now - prevT) / 1000)) * 1000) / 10 : null
  prevTask = m.TaskDuration ?? prevTask
  prevT = now
  const s = { minute, heapMB: m.JSHeapUsedSize ? Math.round((m.JSHeapUsedSize / 1048576) * 10) / 10 : null, heapTotalMB: m.JSHeapTotalSize ? Math.round(m.JSHeapTotalSize / 1048576) : null, nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, cpuPct: cpu, fps: f, requestsThisMinute: mock.state.perMinute[minute - 1] || 0, wall: dbg?.wall ? { connection: dbg.wall.connection, events: dbg.wall.events, listeners: dbg.wall.listeners, timers: dbg.wall.timers, renderMode: dbg.wall.renderMode, generation: dbg.wall.generation, requests: dbg.wall.requests } : null, markers: dbg?.markers, pulses: dbg?.pulses, canvas: dbg?.canvas, pairing: dbg?.pairing, loads, errors: errors.length }
  samples.push(s)
  if (minute % 10 === 0 || minute <= 2) console.log(JSON.stringify(s))
  await fs.writeFile(path.join(OUT, 'soak-samples.json'), JSON.stringify({ samples, log, errors }, null, 1))
}
const steady = samples.filter((s) => s.minute >= 5)
const heap = steady.map((s) => s.heapMB).filter(Number.isFinite)
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null }
const fpsList = samples.map((s) => s.fps).filter(Number.isFinite)
const reqs = samples.map((s) => s.requestsThisMinute)
const quiet = samples.filter((s) => !log.some((l) => l.phase === 'start' && s.minute >= l.minute && s.minute <= l.minute + 6)).map((s) => s.requestsThisMinute).slice(2)
const summary = {
  duration_min: MINUTES, size: `${W}x${H}`, theme: THEME, render: RENDER, speed: SPEED, preset: PRESET,
  heap_mb: { first: heap[0], last: heap.at(-1), peak: Math.max(...heap), min: Math.min(...heap), delta_first_to_last: Math.round((heap.at(-1) - heap[0]) * 10) / 10 },
  heap_first_hour_vs_last_hour_median: { first: median(heap.slice(0, 55)), last: median(heap.slice(-55)) },
  nodes: { first: steady[0]?.nodes, last: steady.at(-1)?.nodes, peak: Math.max(...steady.map((s) => s.nodes || 0)) },
  listeners: { first: steady[0]?.listeners, last: steady.at(-1)?.listeners, peak: Math.max(...steady.map((s) => s.listeners || 0)) },
  cpu_pct_median: median(steady.map((s) => s.cpuPct).filter(Number.isFinite)),
  cpu_pct_peak: Math.max(...steady.map((s) => s.cpuPct).filter(Number.isFinite)),
  fps: { min: Math.min(...fpsList), median: median(fpsList), max: Math.max(...fpsList) },
  requests_per_min: { median_quiet: median(quiet), peak: Math.max(...reqs), total: reqs.reduce((a, b) => a + b, 0), by_endpoint: mock.state.counts },
  reconnects: samples.at(-1)?.wall?.requests ? null : null,
  page_loads: loads, errors: errors.length, error_samples: errors.slice(0, 8),
  final: samples.at(-1), faults: log,
  wall_events_final: samples.at(-1)?.wall?.events,
}
await fs.writeFile(path.join(OUT, 'soak-summary.json'), JSON.stringify(summary, null, 2))
await page.screenshot({ path: path.join(OUT, 'soak-final.png') })
console.log('SUMMARY', JSON.stringify(summary))
await browser.close()
server.close()
