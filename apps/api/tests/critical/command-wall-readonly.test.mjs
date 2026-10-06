/**
 * Command Wall — READ-ONLY IS SERVER-ENFORCED (owner brief §5, §58, §63).
 *
 * 1. Enumerates EVERY route file under src/app/api that exports a mutation
 *    handler (POST/PUT/PATCH/DELETE) and proves the API middleware refuses a
 *    display credential on each of them — in a cookie, the display header, a
 *    Bearer, or smuggled through an operator credential header.
 * 2. Proves the middleware matcher covers every API path.
 * 3. Proves the wall's own namespace exposes no mutation except pairing and
 *    the heartbeat.
 * 4. Calls real mutation handlers with a display token as the only credential
 *    and gets 401 (the container's own gate), independently of middleware.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { middleware, config as middlewareConfig } from '../../middleware.js'
import { mintDisplayToken } from '@/lib/domain/command-wall/wall-crypto.js'
import { DISPLAY_COOKIE, DISPLAY_HEADER, hasDisplayCredential } from '@/lib/domain/command-wall/wall-credential.js'

const API_ROOT = fileURLToPath(new URL('../../src/app/api/', import.meta.url))
const MUTATION = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\b|export\s*\{[^}]*\b(POST|PUT|PATCH|DELETE)\b[^}]*\}/g

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/^route\.(js|ts|mjs)$/.test(name)) out.push(p)
  }
  return out
}

function mutationRoutes() {
  const routes = []
  for (const file of walk(API_ROOT)) {
    const src = readFileSync(file, 'utf8')
    const methods = new Set()
    for (const m of src.matchAll(MUTATION)) methods.add(m[1] || m[2] || m[3])
    if (!methods.size) continue
    const rel = relative(API_ROOT, file).split(sep).slice(0, -1).join('/')
    // dynamic segments → a concrete sample value
    const path = `/api/${rel}`.replace(/\[\.\.\.[^\]]+\]/g, 'a/b').replace(/\[[^\]]+\]/g, 'sample-id')
    routes.push({ file: rel, path, methods: [...methods] })
  }
  return routes
}

const TOKEN = mintDisplayToken()
const CARRIERS = {
  cookie: { cookie: `${DISPLAY_COOKIE}=${TOKEN}` },
  header: { [DISPLAY_HEADER]: TOKEN },
  bearer: { authorization: `Bearer ${TOKEN}` },
  'smuggled-ops-secret': { 'x-ops-dashboard-secret': TOKEN },
  'smuggled-internal-secret': { 'x-internal-api-secret': TOKEN },
  'cookie-among-others': { cookie: `theme=dark; ${DISPLAY_COOKIE}=${TOKEN}; other=1` },
}

test('the enumeration finds the full mutation surface (≥ 200 routes, incl. the canonical writes)', () => {
  const routes = mutationRoutes()
  assert.ok(routes.length >= 200, `found ${routes.length}`)
  const paths = new Set(routes.map((r) => r.file))
  for (const must of [
    'cockpit/inbox/send-now', 'cockpit/inbox/queue-reply', 'cockpit/queue/control', 'cockpit/queue/run', 'cockpit/queue/retry',
    'cockpit/campaigns/[id]/lifecycle', 'cockpit/campaigns/composer', 'cockpit/email/command/send', 'cockpit/email/manual-send',
    'cockpit/pipeline/opportunities/[id]/stage', 'cockpit/lead-state/patch', 'cockpit/workflows/[id]/publish',
    'cockpit/routing/sender-coverage', 'cockpit/signals/[id]', 'cockpit/signals/rules', 'cockpit/notifications/stories/state',
    'cockpit/properties/[property_id]/push-to-underwriting', 'cockpit/threads/[thread_key]', 'cockpit/wall/displays',
    'internal/queue/run', 'internal/outbound/direct-send', 'internal/campaigns/activate-due', 'webhooks/textgrid/inbound',
  ]) assert.ok(paths.has(must), `enumerated ${must}`)
})

test('middleware matcher covers every API path', () => {
  assert.deepEqual(middlewareConfig.matcher, ['/api/:path*'])
})

test('EVERY mutation endpoint refuses a display credential, in every carrier', async () => {
  const routes = mutationRoutes()
  const nonWall = routes.filter((r) => !r.path.startsWith('/api/wall/'))
  let checked = 0
  for (const r of nonWall) {
    for (const method of r.methods) {
      for (const [carrier, headers] of Object.entries(CARRIERS)) {
        const res = middleware(new Request(`http://localhost:3000${r.path}`, { method, headers }))
        assert.equal(res?.status, 403, `${method} ${r.path} via ${carrier}`)
        const body = await res.json()
        assert.equal(body.error, 'display_credential_forbidden')
        checked += 1
      }
    }
  }
  assert.ok(checked > 1000, `checked ${checked} method×route×carrier combinations`)
})

test('read APIs outside /api/wall refuse a display credential too (no general API exposure, §58)', async () => {
  for (const path of ['/api/cockpit/inbox/live', '/api/cockpit/platform/events', '/api/cockpit/signals', '/api/cockpit/market-intel?op=status', '/api/internal/dashboard/ops/map', '/api/intel/buyer-match', '/api/version']) {
    const res = middleware(new Request(`http://localhost:3000${path}`, { headers: CARRIERS.cookie }))
    assert.equal(res.status, 403, path)
  }
})

test('requests without a display credential pass through unchanged (operators unaffected)', () => {
  const res = middleware(new Request('http://localhost:3000/api/cockpit/queue/control', { method: 'POST', headers: { 'x-ops-dashboard-secret': 'real-secret', origin: 'https://ops.leadcommand.ai' } }))
  assert.notEqual(res.status, 403)
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://ops.leadcommand.ai', 'cockpit CORS unchanged')
  const hook = middleware(new Request('http://localhost:3000/api/webhooks/textgrid/inbound', { method: 'POST' }))
  assert.notEqual(hook.status, 403)
  assert.equal(hook.headers.get('access-control-allow-origin'), null, 'no CORS added to webhook paths')
  assert.equal(hasDisplayCredential(new Request('http://x/api/cockpit/a', { headers: { authorization: 'Bearer eyJhbGciOi.supabase.jwt' } })), false)
})

test('the wall namespace accepts the display credential and exposes only pairing + heartbeat as writes', () => {
  const res = middleware(new Request('http://localhost:3000/api/wall/state', { headers: CARRIERS.cookie }))
  assert.notEqual(res.status, 403)
  const wall = walk(join(API_ROOT, 'wall')).map((f) => ({ rel: relative(API_ROOT, f), src: readFileSync(f, 'utf8') }))
  assert.ok(wall.length >= 6)
  for (const { rel, src } of wall) {
    const methods = [...src.matchAll(MUTATION)].map((m) => m[1] || m[2] || m[3])
    const allowed = /wall[/\\](pair|heartbeat)[/\\]route\.js$/.test(rel) ? ['POST'] : []
    assert.deepEqual(methods.filter((m) => !allowed.includes(m)), [], `${rel} exposes ${methods}`)
    // the wall never imports an operational write path
    assert.doesNotMatch(src, /send-now|queue-message|direct-send|campaign-lifecycle|setSystemValues|sender-routing-service|signal-service/, rel)
  }
})

test('real mutation handlers reject a display token as their only credential (container gate)', async () => {
  const prev = process.env.OPS_DASHBOARD_SECRET
  process.env.OPS_DASHBOARD_SECRET = 'test-operator-secret'
  try {
    const cases = [
      ['@/app/api/cockpit/queue/control/route.js', 'POST', '/api/cockpit/queue/control', {}],
      ['@/app/api/cockpit/inbox/send-now/route.js', 'POST', '/api/cockpit/inbox/send-now', {}],
      ['@/app/api/cockpit/wall/displays/route.js', 'POST', '/api/cockpit/wall/displays', {}],
      ['@/app/api/cockpit/wall/displays/[id]/route.js', 'DELETE', '/api/cockpit/wall/displays/x', { params: { id: 'x' } }],
      ['@/app/api/cockpit/wall/displays/[id]/view/route.js', 'POST', '/api/cockpit/wall/displays/x/view', { params: { id: 'x' } }],
      ['@/app/api/cockpit/signals/[id]/route.js', 'POST', '/api/cockpit/signals/x', { params: { id: 'x' } }],
    ]
    for (const [mod, method, path, ctx] of cases) {
      const route = await import(mod)
      for (const headers of [CARRIERS.bearer, CARRIERS.header, CARRIERS.cookie]) {
        const res = await route[method](new Request(`http://localhost:3000${path}`, { method, headers: { ...headers, 'content-type': 'application/json' }, body: '{}' }), ctx)
        assert.equal(res.status, 401, `${method} ${path}`)
      }
    }
  } finally {
    if (prev === undefined) delete process.env.OPS_DASHBOARD_SECRET
    else process.env.OPS_DASHBOARD_SECRET = prev
  }
})
