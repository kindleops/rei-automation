// Subprocess preload for test/credential.test.mjs (tests only). It records:
//   * every path passed to the fs read / open / stat family, and
//   * every read of a forbidden environment variable (process.env is wrapped in a Proxy),
// and (with LCMCP_TRACE_FAKE_PG=1) replaces globalThis.fetch with the fake PostgREST.
// So a test can prove the REAL server process never touches apps/api/.env* and never reads
// SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL / DATABASE_URL, end to end. The trace is
// written to LCMCP_TRACE_OUT at exit.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
// the alias loader first: the helpers below are loaded dynamically, after it is registered
import '../../src/loader/register.mjs'

const OUT = process.env.LCMCP_TRACE_OUT
const FORBIDDEN = new Set(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'PGPASSWORD', 'SUPABASE_JWT_SECRET'])
const trace = { paths: [], env_reads: [], fetches: [] }

for (const name of ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream', 'existsSync', 'statSync', 'lstatSync', 'accessSync', 'readdirSync', 'realpathSync']) {
  const orig = fs[name]
  if (typeof orig !== 'function') continue
  fs[name] = function traced(p, ...rest) {
    trace.paths.push(String(p?.href || p))
    return orig.call(this, p, ...rest)
  }
}
for (const name of ['readFile', 'open', 'stat', 'lstat', 'access', 'readdir']) {
  const orig = fs.promises[name]
  fs.promises[name] = function traced(p, ...rest) {
    trace.paths.push(String(p?.href || p))
    return orig.call(this, p, ...rest)
  }
}

// named ESM imports of node:fs (import { readFileSync } …) see the patched functions too
syncBuiltinESMExports()

const real = process.env
process.env = new Proxy(real, {
  get(t, k) {
    if (typeof k === 'string' && FORBIDDEN.has(k)) trace.env_reads.push(k)
    return Reflect.get(t, k)
  },
})

if (real.LCMCP_TRACE_FAKE_PG === '1') {
  const { createFakePostgrest } = await import('./fake-postgrest.mjs')
  const { LIVE_MEMBERSHIP } = await import('./live-env.mjs')
  const pg = createFakePostgrest({ membership: LIVE_MEMBERSHIP })
  globalThis.fetch = async (input, init) => {
    trace.fetches.push(String(input).replace(/\?.*$/, ''))
    return pg.fetch(input, init)
  }
  trace.reader_roles = () => [...new Set(pg.requests.map((r) => r.role))]
}

process.on('exit', () => {
  if (!OUT) return
  const out = { ...trace, reader_roles: typeof trace.reader_roles === 'function' ? trace.reader_roles() : null }
  fs.writeFileSync(OUT, JSON.stringify(out))
})
