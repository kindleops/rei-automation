// DISPOSABLE-TARGET GUARD for every migration / pretest / rollback runner.
//
// Owner boundary 2026-10-15 (after the 2026-10-14 incident): migration,
// rollback and pretest SQL never runs against production — not even wrapped
// in BEGIN … ROLLBACK. Test SQL runs only on an isolated, disposable database.
//
// assertDisposableTarget(url) THROWS unless every host in the connection
// string is a loopback address or a unix-socket directory. A production-like
// target (any *.supabase.co / *.supabase.com host, the production project ref,
// a pooler user "postgres.<ref>") is refused ALWAYS — no flag overrides that.
// A non-local, non-production host (e.g. a CI service container reached by
// name) is allowed only when LC_DISPOSABLE_DB_HOST names exactly that host,
// which the runner / CI sets only for a database it created itself.
//
// The production identifiers below are the DENYLIST. They are the only place
// outside ops tooling where they may appear (scan-test-prod-targets.mjs
// allowlists this file for exactly that reason).

export const PRODUCTION_PROJECT_REF = 'lcppdrmrdfblstpcbgpf'
export const PRODUCTION_HOST_PATTERNS = Object.freeze([
  /(^|\.)supabase\.co$/i,
  /(^|\.)supabase\.com$/i, // *.pooler.supabase.com and anything else Supabase-hosted
  /(^|\.)supabase\.(?:in|net|io)$/i,
  new RegExp(PRODUCTION_PROJECT_REF, 'i'),
])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1'])

export class UnsafeDbTargetError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'UnsafeDbTargetError'
    this.code = 'LC_UNSAFE_DB_TARGET'
    this.detail = detail
  }
}

function isUnixSocketHost(h) {
  return typeof h === 'string' && h.startsWith('/')
}

/** Is a single host string production-like? */
export function isProductionLikeHost(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '')
  if (!h) return false
  return PRODUCTION_HOST_PATTERNS.some((re) => re.test(h))
}

/**
 * Parse a libpq URL or keyword/value conninfo into { hosts, user, dbname, raw }.
 * Never returns or logs the password.
 */
export function parseConnTarget(target) {
  const raw = String(target ?? '').trim()
  if (!raw) throw new UnsafeDbTargetError('no database target given')
  const hosts = []
  let user = ''
  let dbname = ''
  if (/^postgres(?:ql)?:\/\//i.test(raw)) {
    // node's URL cannot parse multi-host authority (h1:5432,h2:5432): split it ourselves.
    const m = /^postgres(?:ql)?:\/\/(?:([^@/]*)@)?([^/?#]*)(\/[^?#]*)?(\?[^#]*)?/i.exec(raw)
    if (!m) throw new UnsafeDbTargetError('unparseable database URL')
    const userinfo = m[1] || ''
    user = decodeURIComponent(userinfo.split(':')[0] || '')
    const authority = m[2] || ''
    for (const part of authority.split(',')) {
      const hp = part.trim()
      if (!hp) continue
      const host = hp.startsWith('[') ? hp.slice(0, hp.indexOf(']') + 1) : hp.replace(/:\d*$/, '')
      hosts.push(decodeURIComponent(host))
    }
    dbname = decodeURIComponent((m[3] || '').replace(/^\//, ''))
    const params = new URLSearchParams((m[4] || '').replace(/^\?/, ''))
    for (const key of ['host', 'hostaddr']) {
      for (const v of params.getAll(key)) for (const h of v.split(',')) if (h.trim()) hosts.push(h.trim())
    }
    if (params.get('user')) user = params.get('user')
    if (params.get('dbname')) dbname = params.get('dbname')
    if (params.get('service')) throw new UnsafeDbTargetError('service= is not allowed: the target must be explicit')
  } else {
    // keyword/value conninfo: host=... port=... user=...
    const re = /(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/g
    let mm
    while ((mm = re.exec(raw))) {
      const k = mm[1].toLowerCase()
      const val = mm[2].replace(/^'|'$/g, '')
      if (k === 'host' || k === 'hostaddr') for (const h of val.split(',')) if (h.trim()) hosts.push(h.trim())
      if (k === 'user') user = val
      if (k === 'dbname') dbname = val
      if (k === 'service') throw new UnsafeDbTargetError('service= is not allowed: the target must be explicit')
    }
  }
  return { hosts, user, dbname }
}

/**
 * Throw UnsafeDbTargetError unless `target` is a disposable local database.
 * @param {string} target libpq URL or conninfo
 * @param {{ env?: Record<string,string|undefined> }} [opts]
 * @returns {{ hosts: string[], user: string, dbname: string, local: boolean }}
 */
export function assertDisposableTarget(target, { env = process.env } = {}) {
  const raw = String(target ?? '')
  if (new RegExp(PRODUCTION_PROJECT_REF, 'i').test(raw)) {
    throw new UnsafeDbTargetError('refused: the target names the production project ref')
  }
  if (/supabase\.(co|com|in|net|io)\b/i.test(raw)) {
    throw new UnsafeDbTargetError('refused: the target is a Supabase-hosted (production-like) database')
  }
  const parsed = parseConnTarget(raw)
  // libpq falls back to PGHOST / the default socket when no host is given:
  // that default must itself be checked.
  const hosts = parsed.hosts.length ? parsed.hosts : [String(env.PGHOST || '').trim() || '/tmp']
  if (/^postgres\.[a-z0-9]{20}$/i.test(parsed.user)) {
    throw new UnsafeDbTargetError('refused: pooler-style user postgres.<project-ref>')
  }
  const declared = String(env.LC_DISPOSABLE_DB_HOST || '').trim()
  let local = true
  for (const h of hosts) {
    if (isProductionLikeHost(h)) throw new UnsafeDbTargetError(`refused: production-like host ${h}`)
    const bare = h.replace(/^\[|\]$/g, '')
    if (LOOPBACK.has(h) || LOOPBACK.has(bare) || isUnixSocketHost(h)) continue
    if (declared && declared === h) { local = false; continue }
    throw new UnsafeDbTargetError(`refused: host ${h} is not loopback or a unix socket (set LC_DISPOSABLE_DB_HOST=${h} only for a database the runner itself created)`)
  }
  return { hosts, user: parsed.user, dbname: parsed.dbname, local }
}

/**
 * Environment for a child psql / node process that may only reach `target`:
 * every libpq default that could redirect it elsewhere is removed.
 */
export function sanitizedPgEnv(env = process.env, extra = {}) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (/^PG/.test(k)) continue
    if (/^(SUPABASE_DB_URL|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|POSTGRES_URL.*|DIRECT_URL)$/.test(k)) continue
    out[k] = v
  }
  // point libpq's implicit config files at a path that does not exist (silently ignored)
  out.PGSERVICEFILE = '/nonexistent/lc-migration-test/pg_service.conf'
  out.PGSYSCONFDIR = '/nonexistent/lc-migration-test'
  out.PGPASSFILE = '/nonexistent/lc-migration-test/.pgpass'
  out.PGAPPNAME = 'lc-migration-test'
  return { ...out, ...extra }
}
