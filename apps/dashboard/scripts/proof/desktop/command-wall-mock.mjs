/**
 * COMMAND WALL mock harness (READ ONLY, NO PRODUCTION CONTACT).
 *
 *   - serves a production build (default /tmp/cw-dist) from a local static
 *     server with SPA fallback; every /api/* reaching it answers 503 — it never
 *     proxies anywhere;
 *   - intercepts /api/wall/* in the page and answers from a REPLAY fixture built
 *     by apps/api/scripts/ops/command-wall-build-fixture.mjs (real recorded event
 *     shapes run through the real server tick/aggregation/privacy code);
 *   - aborts every other /api request and anything to Supabase;
 *   - maps wall-clock time onto the recording (speed ×N) and shifts event times
 *     to "now", so pulses, capsule and ages behave exactly as live;
 *   - failure injection: offline (abort), server 503, revoke (401).
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
// the REAL server privacy projection (plain ESM, no aliases): the mock projects per display exactly like /api/wall
import { projectEvent, projectSnapshot } from '../../../../api/src/lib/domain/command-wall/wall-privacy.js'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.wav': 'audio/wav' }

export function startStaticServer(root = '/tmp/cw-dist', port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname.startsWith('/api/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"mock_static_server_has_no_api"}'); return }
    let p = path.join(root, decodeURIComponent(u.pathname))
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, 'index.html')
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': p.endsWith('index.html') ? 'no-store' : 'max-age=3600' })
    fs.createReadStream(p).pipe(res)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })))
}

export function loadFixture(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const SESSION = (cfg = {}) => ({
  id: 'cwd_mock_living_room',
  name: cfg.name || 'Living Room TV',
  config_version: cfg.config_version || 1,
  view_command: cfg.view_command || null,
  token_expires_at: new Date(Date.now() + 180 * 864e5).toISOString(),
  config: {
    preset: 'national_command', theme: 'dark', privacy_mode: 'privacy', oled_protection: 'low', camera_mode: 'static', audio: 'off',
    show_feed: true, overnight_low_light: false, rotation: { enabled: false, steps: [] }, layers: null, watched_markets: [], map_view: null,
    ...(cfg.config || {}),
  },
})

/**
 * Installs the mock on a Playwright BrowserContext. Returns a controller.
 * opts: { fixture, speed=1, startAt (recorded ms; default = busiest window), paired=true, config }
 */
export async function installWallMock(context, opts) {
  const fx = opts.fixture
  const speed = opts.speed ?? 1
  const recStart = Date.parse(fx.recorded_from)
  const startAt = opts.startAt ?? recStart + 2 * 3600_000
  const t0 = Date.now()
  const state = { paired: opts.paired !== false, offline: false, serverDown: false, revoked: false, config: opts.config || {}, counts: {}, bytes: {}, perMinute: [] }
  const vt = () => startAt + (Date.now() - t0) * speed
  const shift = () => Date.now() - vt()
  const ticksUpTo = (t) => { let lo = 0; let hi = fx.ticks.length; while (lo < hi) { const m = (lo + hi) >> 1; if (fx.ticks[m].t <= t) lo = m + 1; else hi = m } return lo }
  const sentReplayedSince = () => {
    let n = 0
    const a = ticksUpTo(startAt); const b = ticksUpTo(vt())
    const seen = new Map()
    for (let i = a; i < b; i += 1) for (const e of fx.ticks[i].events) if (e.kind === 'sends') seen.set(e.id, e.count)
    for (const v of seen.values()) n += v
    return n
  }

  const json = (route, status, body) => {
    const text = JSON.stringify(body)
    return route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: text })
  }

  await context.route(/supabase\.co/, (r) => r.abort())
  await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (!u.pathname.startsWith('/api/wall/')) return route.abort()
    const ep = u.pathname.replace('/api/wall/', '')
    state.counts[ep] = (state.counts[ep] || 0) + 1
    const minute = Math.floor((Date.now() - t0) / 60_000)
    state.perMinute[minute] = (state.perMinute[minute] || 0) + 1
    if (state.offline) return route.abort('internetdisconnected')
    if (state.serverDown) return json(route, 503, { ok: false, error: 'wall_failed' })
    if (ep === 'pair') {
      const body = JSON.parse(req.postData() || '{}')
      if (body.action === 'start') return json(route, 200, { ok: true, pairing_id: 'cwp_mock', code: 'KXRM-4827', poll_secret: 'mock', expires_at: new Date(Date.now() + 9.5 * 60_000).toISOString(), poll_interval_ms: 4000 })
      if (state.paired) return json(route, 200, { ok: true, paired: true, display: SESSION(state.config) })
      return json(route, 200, { ok: true, paired: false, expires_at: new Date(Date.now() + 9 * 60_000).toISOString(), poll_interval_ms: 4000 })
    }
    if (!state.paired || state.revoked) return json(route, 401, { ok: false, error: state.revoked ? 'display_revoked' : 'display_unpaired' })
    if (ep === 'session' || ep === 'heartbeat') return json(route, 200, { ok: true, display: SESSION(state.config), rotated: false, server_time: new Date().toISOString() })
    const mode = state.config?.config?.privacy_mode || 'privacy'
    const raw = fx.privacy_mode === 'raw'
    if (ep === 'state') {
      const s = raw ? { ok: true, ...projectSnapshot(structuredClone(fx.state), mode) } : structuredClone(fx.state)
      const iso = new Date().toISOString()
      for (const k of ['metrics', 'queue', 'fleet', 'offers']) if (s[k] && s[k].status !== 'unavailable') s[k].as_of = iso
      if (s.metrics?.status === 'ok') s.metrics.sent += sentReplayedSince()
      if (opts.mutateState) opts.mutateState(s)
      return json(route, 200, s)
    }
    if (ep === 'events') {
      const after = Number(u.searchParams.get('after') || 0)
      const reset = u.searchParams.get('epoch') !== fx.epoch
      const now = vt()
      const dt = shift()
      const upTo = ticksUpTo(now)
      const byId = new Map()
      const from = reset ? ticksUpTo(now - 2 * 3600_000) : 0
      for (let i = from; i < upTo; i += 1) for (const e of fx.ticks[i].events) if (reset || e.seq > after) byId.set(e.id, e)
      const events = [...byId.values()].sort((a, b) => a.seq - b.seq).slice(-250).map((e) => (raw ? projectEvent(e, mode) : e)).map((e) => ({ ...e, occurred_at: new Date(Date.parse(e.occurred_at) + dt).toISOString() }))
      const head = upTo ? fx.ticks[upTo - 1].events.reduce((m, e) => Math.max(m, e.seq), 0) : 0
      return json(route, 200, { ok: true, epoch: fx.epoch, reset, head: Math.max(head, after), events, status: { state: 'live', last_ok_at: new Date().toISOString(), stale_ms: 0, projector_lag_ms: 22_000, tick_ms: 15_000 }, config_version: state.config.config_version || 1, server_time: new Date().toISOString() })
    }
    if (ep === 'layers') return json(route, 200, { ok: true, mode: 'none', cameras: [], cells: [], incidents: [], covered: false })
    return json(route, 404, { ok: false, error: 'not_found' })
  })

  return {
    state,
    virtualNow: vt,
    setOffline(v) { state.offline = v },
    setServerDown(v) { state.serverDown = v },
    setRevoked(v) { state.revoked = v },
    setConfig(c) { state.config = { ...state.config, ...c, config_version: (state.config.config_version || 1) + 1 } },
  }
}

/** The busiest 2-hour window of a fixture by P1 events + sends (so captures show real activity). */
export function busiestWindowStart(fx, windowMs = 2 * 3600_000) {
  let best = Date.parse(fx.recorded_from); let bestScore = -1
  for (let i = 0; i < fx.ticks.length; i += 8) {
    const s = fx.ticks[i].t
    let score = 0
    for (let j = i; j < fx.ticks.length && fx.ticks[j].t < s + windowMs; j += 1) for (const e of fx.ticks[j].events) score += e.priority <= 1 ? 10 : e.kind === 'sends' ? e.count / 10 : 1
    if (score > bestScore) { bestScore = score; best = s }
  }
  return best
}
