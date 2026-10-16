#!/usr/bin/env node
// PRODUCTION DATABASE CREDENTIALS — the ONE explicit loader (rc-8.5.21-c, owner
// directive 2026-10-16).
//
//   "Use dedicated database-role-enforced read-only credentials for diagnostics. A
//    read-only SQL statement or transaction setting is not an adequate replacement for
//    least-privilege credentials."
//   "Never allow testing or migration tooling to silently derive writable production
//    credentials from local API environment files."
//
// Two doors, nothing else:
//
//   READ-ONLY DIAGNOSTICS — connectReadOnlyDiagnostics() / openReadOnlyPool()
//     The connection string comes ONLY from the file named by LC_READONLY_DB_URL_FILE
//     (absolute path, a regular file owned by you, mode 0600/0400, one postgres:// URL).
//     Before any other statement the role is VERIFIED to be read-only by the database's
//     own privilege system — not by a session setting:
//       - current_user and every role it can SET ROLE to: not rolsuper, not rolbypassrls,
//         not rolcreaterole / rolcreatedb / rolreplication
//       - has_table_privilege(role, t, 'INSERT,UPDATE,DELETE,TRUNCATE') is false for
//         every sentinel (public.send_queue, public.sms_templates, public.system_control,
//         agent.runtime_limits when present); a required sentinel that is missing means
//         the role cannot be verified, which is a refusal too
//       - no CREATE on schema public
//     A writable credential is refused even if the caller would have run BEGIN READ ONLY.
//     default_transaction_read_only=on is applied AFTER verification as defense in depth.
//
//   PRODUCTION WRITES — connectProdWrite() / resolveProdWriteUrl()
//     Requires ALL of: an explicit --prod-write=<approval-ref> argument, the file named by
//     LC_PROD_WRITE_DB_URL_FILE (same file rules), an interactive TTY (stdin and stderr),
//     and typing the approval ref back at the prompt. Non-TTY use (CI, pipes, agents) is
//     refused.
//
// This module NEVER reads apps/api/.env*, any dotenv file, SUPABASE_DB_URL, DATABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY or /tmp/.dburl, and refuses a URL file that is any of them.
// It never prints a password.
//
// CLI:
//   node scripts/lib/prod-db-credentials.mjs verify-readonly
//   node scripts/lib/prod-db-credentials.mjs psql [psql args…]                 (read-only role)
//   node scripts/lib/prod-db-credentials.mjs psql-write --prod-write=<ref> [psql args…]
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const READONLY_URL_FILE_ENV = 'LC_READONLY_DB_URL_FILE'
export const PROD_WRITE_URL_FILE_ENV = 'LC_PROD_WRITE_DB_URL_FILE'
export const PROD_WRITE_FLAG = '--prod-write'

/** Tables a diagnostics role must never be able to write. `required: false` = checked when present. */
export const READONLY_SENTINELS = Object.freeze([
  Object.freeze({ table: 'public.send_queue', required: true }),
  Object.freeze({ table: 'public.sms_templates', required: true }),
  Object.freeze({ table: 'public.system_control', required: true }),
  Object.freeze({ table: 'agent.runtime_limits', required: false }),
])

// Sources this loader refuses outright, whatever path points at them.
const FORBIDDEN_URL_FILES = Object.freeze(['/tmp/.dburl', '/private/tmp/.dburl'])
// Env names that must never be the source (and are never read here); an inline URL
// variable is refused so nobody "helpfully" adds one.
const INLINE_URL_ENVS = Object.freeze(['LC_READONLY_DB_URL', 'LC_PROD_WRITE_DB_URL'])
const GENERIC_APPROVALS = new Set(['1', 'y', 'yes', 'true', 'ok', 'approved', 'go', 'owner', 'confirm'])

export class CredentialRefusedError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'CredentialRefusedError'
    this.code = 'LC_CREDENTIAL_REFUSED'
    this.detail = detail
  }
}
const refuse = (msg, detail) => { throw new CredentialRefusedError(msg, detail) }

// ── targets (never the password) ────────────────────────────────────────────

/** Parse a single-host postgres:// URL into libpq parts. */
export function parsePgUrl(url) {
  const m = /^postgres(?:ql)?:\/\/(?:([^@/]*)@)?([^/?#]*)(\/[^?#]*)?(\?[^#]*)?$/i.exec(String(url || '').trim())
  if (!m) refuse('the URL file does not hold a postgres:// URL')
  const [user = '', password = ''] = (m[1] || '').split(':').map((x) => decodeURIComponent(x || ''))
  const authority = m[2] || ''
  if (authority.includes(',')) refuse('multi-host URLs are not supported')
  let host = ''
  let port = ''
  if (authority) {
    const hp = /^(\[[^\]]+\]|[^:]*)(?::(\d*))?$/.exec(authority)
    host = decodeURIComponent(hp?.[1] || '')
    port = hp?.[2] || ''
  }
  const params = new URLSearchParams((m[4] || '').replace(/^\?/, ''))
  if (params.get('service')) refuse('service= is not allowed: the target must be explicit')
  if (!host && params.get('host')) host = params.get('host')
  if (!port && params.get('port')) port = params.get('port')
  return {
    user: params.get('user') || user,
    password,
    host,
    port,
    dbname: decodeURIComponent((m[3] || '').replace(/^\//, '')) || params.get('dbname') || '',
    sslmode: params.get('sslmode') || '',
  }
}

/** user@host:port/db — safe to print. */
export function describeTarget(url) {
  const p = parsePgUrl(url)
  return `${p.user || '(default user)'}@${p.host || '(default host)'}${p.port ? `:${p.port}` : ''}/${p.dbname || '(default db)'}`
}

function isLocalHost(host) {
  return !host || host.startsWith('/') || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)
}

// ── URL files ───────────────────────────────────────────────────────────────

function isForbiddenPath(p) {
  const base = path.basename(p)
  if (/^\.env(\.|$)/i.test(base)) return `a dotenv file (${base})`
  if (FORBIDDEN_URL_FILES.includes(p) || /^\.dburl$/.test(base)) return '/tmp/.dburl (the postgres-role URL file)'
  return null
}

/**
 * Read a connection URL from the file named by env[envName]. Refuses inline URLs, relative
 * paths, symlink tricks onto forbidden files, group/other-readable files, files owned by
 * another user, and anything but exactly one postgres:// URL.
 * @returns {{ url: string, file: string, target: string }}
 */
export function readUrlFile({ env = process.env, envName }) {
  for (const k of INLINE_URL_ENVS) if (env[k]) refuse(`${k} is set: connection strings are never taken from the environment — store it in a 0600 file and point ${k}_FILE at it`)
  const file = String(env[envName] || '').trim()
  if (!file) refuse(`${envName} is not set (a path to a 0600 file holding one postgres:// URL)`)
  if (/^postgres(?:ql)?:\/\/|\b(?:host|user|password|dbname)\s*=/i.test(file)) refuse(`${envName} must be a FILE PATH, not an inline connection string`)
  if (!path.isAbsolute(file)) refuse(`${envName} must be an absolute path`)
  const named = isForbiddenPath(path.resolve(file))
  if (named) refuse(`${envName} points at ${named}; that source is never used`)
  let real
  try { real = fs.realpathSync(file) } catch { refuse(`${envName}: file not found`) }
  const resolved = isForbiddenPath(real)
  if (resolved) refuse(`${envName} resolves to ${resolved}; that source is never used`)
  const st = fs.statSync(real)
  if (!st.isFile()) refuse(`${envName}: not a regular file`)
  if ((st.mode & 0o077) !== 0) refuse(`${envName}: mode ${(st.mode & 0o777).toString(8).padStart(4, '0')} — the file must be 0600 (chmod 600 <file>)`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) refuse(`${envName}: the file is owned by another user`)
  const lines = fs.readFileSync(real, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  if (lines.length !== 1) refuse(`${envName}: the file must hold exactly one connection URL (found ${lines.length} lines)`)
  const url = lines[0]
  if (!/^postgres(?:ql)?:\/\//i.test(url)) refuse(`${envName}: the file does not hold a postgres:// URL`)
  return { url, file: real, target: describeTarget(url) }
}

// ── read-only verification ──────────────────────────────────────────────────

export const VERIFY_READONLY_SQL = `
with reach as (
  select r.oid, r.rolname::text as rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication
    from pg_roles r
   where pg_has_role(current_user, r.oid, 'MEMBER')
),
sentinel as (
  select s.name, s.required, to_regclass(s.name) as rel
    from unnest($1::text[], $2::boolean[]) as s(name, required)
)
select current_user::text as current_user,
       session_user::text as session_user,
       (select coalesce(json_agg(json_build_object('role', rolname, 'super', rolsuper, 'bypassrls', rolbypassrls,
                                                  'createrole', rolcreaterole, 'createdb', rolcreatedb, 'replication', rolreplication)
                                 order by rolname), '[]'::json) from reach) as roles,
       (select coalesce(json_agg(json_build_object('table', s.name, 'required', s.required, 'present', s.rel is not null,
                                                  'writable_by', (select coalesce(json_agg(r.rolname order by r.rolname), '[]'::json)
                                                                    from reach r
                                                                   where s.rel is not null
                                                                     and has_table_privilege(r.oid, s.rel, 'INSERT,UPDATE,DELETE,TRUNCATE')))
                                 order by s.name), '[]'::json) from sentinel s) as sentinels,
       (select coalesce(json_agg(r.rolname order by r.rolname), '[]'::json)
          from reach r
         where has_schema_privilege(r.oid, 'public', 'CREATE')) as public_create_by
`

/** Pure: turn the verification row into { ok, reasons }. */
export function judgeReadOnly(row) {
  const reasons = []
  for (const r of row.roles || []) {
    const via = r.role === row.current_user ? '' : ` (reachable via SET ROLE ${r.role})`
    if (r.super) reasons.push(`role ${r.role} is a superuser${via}`)
    if (r.bypassrls) reasons.push(`role ${r.role} has BYPASSRLS${via}`)
    if (r.createrole) reasons.push(`role ${r.role} has CREATEROLE${via}`)
    if (r.createdb) reasons.push(`role ${r.role} has CREATEDB${via}`)
    if (r.replication) reasons.push(`role ${r.role} has REPLICATION${via}`)
  }
  for (const s of row.sentinels || []) {
    if (!s.present) {
      if (s.required) reasons.push(`sentinel ${s.table} is missing: the role cannot be verified read-only on this database`)
      continue
    }
    if (s.writable_by?.length) reasons.push(`${s.table} is writable (INSERT/UPDATE/DELETE/TRUNCATE) by ${s.writable_by.join(', ')}`)
  }
  if (row.public_create_by?.length) reasons.push(`schema public grants CREATE to ${row.public_create_by.join(', ')}`)
  return { ok: reasons.length === 0, role: row.current_user, reasons }
}

/** Run the verification on an open client. Throws CredentialRefusedError unless read-only. */
export async function verifyRoleEnforcedReadOnly(client, { sentinels = READONLY_SENTINELS } = {}) {
  const { rows } = await client.query(VERIFY_READONLY_SQL, [sentinels.map((s) => s.table), sentinels.map((s) => Boolean(s.required))])
  const verdict = judgeReadOnly(rows[0])
  if (!verdict.ok) refuse(`refused: the diagnostics credential (role ${verdict.role}) is not role-enforced read-only — ${verdict.reasons.join('; ')}. BEGIN READ ONLY does not make a writable credential acceptable; use a least-privilege read-only role.`, verdict)
  return verdict
}

async function loadPg(pg) {
  if (pg) return pg
  const mod = await import('pg')
  return mod.default || mod
}

function clientConfig(url, { applicationName, ssl }) {
  const host = parsePgUrl(url).host
  return {
    connectionString: url,
    application_name: applicationName,
    ssl: ssl !== undefined ? ssl : isLocalHost(host) ? false : { rejectUnauthorized: false },
  }
}

async function connectVerified(cred, { pg, applicationName, statementTimeoutMs, ssl, sentinels }) {
  const { Client } = await loadPg(pg)
  const client = new Client(clientConfig(cred.url, { applicationName, ssl }))
  await client.connect()
  try {
    const verdict = await verifyRoleEnforcedReadOnly(client, { sentinels })
    await client.query(`set default_transaction_read_only = on; set statement_timeout = ${statementTimeoutMs}`)
    client.lcCredential = Object.freeze({ kind: 'readonly', target: cred.target, role: verdict.role })
    return client
  } catch (e) {
    await client.end().catch(() => {})
    throw e
  }
}

const timeoutMs = (v) => Math.max(1000, Math.floor(Number(v) || 30_000))

/**
 * Open ONE verified read-only connection for diagnostics.
 * @param {{ env?: object, pg?: object, applicationName?: string, statementTimeoutMs?: number, ssl?: any, sentinels?: object[] }} [opts]
 */
export async function connectReadOnlyDiagnostics({ env = process.env, pg, applicationName = 'lc-readonly-diagnostics', statementTimeoutMs = 30_000, ssl, sentinels } = {}) {
  const cred = readUrlFile({ env, envName: READONLY_URL_FILE_ENV })
  return connectVerified(cred, { pg, applicationName, statementTimeoutMs: timeoutMs(statementTimeoutMs), ssl, sentinels })
}

/**
 * A pg.Pool for diagnostics: the credential is read once, its role verified on a probe
 * connection, and every pooled session starts default_transaction_read_only.
 */
export async function openReadOnlyPool({ env = process.env, pg, applicationName = 'lc-readonly-diagnostics', statementTimeoutMs = 30_000, max = 4, ssl, sentinels } = {}) {
  const cred = readUrlFile({ env, envName: READONLY_URL_FILE_ENV })
  const timeout = timeoutMs(statementTimeoutMs)
  const probe = await connectVerified(cred, { pg, applicationName, statementTimeoutMs: timeout, ssl, sentinels })
  const meta = probe.lcCredential
  await probe.end()
  const { Pool } = await loadPg(pg)
  const pool = new Pool({ ...clientConfig(cred.url, { applicationName, ssl }), max, options: `-c default_transaction_read_only=on -c statement_timeout=${timeout}` })
  pool.lcCredential = meta
  return pool
}

/** The verified read-only URL, for a child process (psql). Verifies the role first. */
export async function resolveReadOnlyUrl({ env = process.env, pg, sentinels } = {}) {
  const cred = readUrlFile({ env, envName: READONLY_URL_FILE_ENV })
  const probe = await connectVerified(cred, { pg, applicationName: 'lc-verify-readonly', statementTimeoutMs: 30_000, sentinels })
  const meta = probe.lcCredential
  await probe.end()
  return { url: cred.url, target: meta.target, role: meta.role }
}

// ── production writes ───────────────────────────────────────────────────────

/** The approval ref from --prod-write=<ref> (or `--prod-write <ref>`); refuses when absent or generic. */
export function parseProdWriteRef(argv = process.argv.slice(2)) {
  let ref = null
  argv.forEach((a, i) => {
    if (a.startsWith(`${PROD_WRITE_FLAG}=`)) ref = a.slice(PROD_WRITE_FLAG.length + 1)
    else if (a === PROD_WRITE_FLAG) ref = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : ''
  })
  if (ref === null) refuse(`production writes need an explicit ${PROD_WRITE_FLAG}=<approval-ref> argument (the owner approval this write executes)`)
  ref = String(ref).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{3,119}$/.test(ref) || GENERIC_APPROVALS.has(ref.toLowerCase())) refuse(`${PROD_WRITE_FLAG}=${JSON.stringify(ref)} is not an approval reference (e.g. ${PROD_WRITE_FLAG}=owner-2026-10-16-persona-repair)`)
  return ref
}

/** The real terminal; injectable for tests. */
export function processTty() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    question(prompt) {
      return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
        rl.question(prompt, (answer) => { rl.close(); resolve(answer) })
      })
    },
  }
}

/**
 * Resolve the production WRITE URL after every gate: --prod-write=<ref>, an interactive
 * TTY, LC_PROD_WRITE_DB_URL_FILE, and the operator typing the ref back.
 * @returns {Promise<{ url: string, approvalRef: string, target: string }>}
 */
export async function resolveProdWriteUrl({ argv = process.argv.slice(2), env = process.env, tty = processTty(), purpose = 'a production write' } = {}) {
  const approvalRef = parseProdWriteRef(argv)
  if (!tty || !tty.isTTY) refuse('production writes need an interactive terminal (stdin and stderr must be a TTY); non-interactive use is refused')
  if (env.CI) refuse('production writes are refused under CI')
  const cred = readUrlFile({ env, envName: PROD_WRITE_URL_FILE_ENV })
  const answer = await tty.question(`\n  PRODUCTION WRITE — ${purpose}\n  target   ${cred.target}\n  approval ${approvalRef}\n  Type the approval ref to continue: `)
  if (String(answer ?? '').trim() !== approvalRef) refuse('confirmation did not match the approval ref; nothing was done')
  return { url: cred.url, approvalRef, target: cred.target }
}

/** Open a production WRITE connection after every gate in resolveProdWriteUrl. */
export async function connectProdWrite({ argv, env = process.env, tty, pg, purpose, applicationName, ssl, log = (m) => console.error(m) } = {}) {
  const w = await resolveProdWriteUrl({ argv, env, tty, purpose })
  const { Client } = await loadPg(pg)
  const client = new Client(clientConfig(w.url, { applicationName: applicationName || `lc-prod-write:${w.approvalRef}`.slice(0, 63), ssl }))
  await client.connect()
  const { rows } = await client.query('select current_user::text as role')
  client.lcCredential = Object.freeze({ kind: 'prod-write', target: w.target, role: rows[0].role, approvalRef: w.approvalRef })
  log(`prod-write: approval=${w.approvalRef} target=${w.target} role=${rows[0].role}`)
  return client
}

// ── psql (password via env, never argv) ─────────────────────────────────────

/** Child env for psql: libpq parts of `url` as PG* vars; every inherited PG* / credential var removed. */
export function psqlEnv(url, { env = process.env, readOnly }) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (/^PG/.test(k)) continue
    if (/^(SUPABASE_DB_URL|SUPABASE_URL_NO_POOL|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|POSTGRES_URL\w*|DIRECT_URL|LC_READONLY_DB_URL_FILE|LC_PROD_WRITE_DB_URL_FILE)$/.test(k)) continue
    out[k] = v
  }
  const p = parsePgUrl(url)
  if (p.host) out.PGHOST = p.host
  if (p.port) out.PGPORT = p.port
  if (p.user) out.PGUSER = p.user
  if (p.dbname) out.PGDATABASE = p.dbname
  if (p.password) out.PGPASSWORD = p.password
  out.PGSSLMODE = p.sslmode || (isLocalHost(p.host) ? 'disable' : 'require')
  out.PGPASSFILE = '/nonexistent/lc-prod-db-credentials/.pgpass'
  out.PGSERVICEFILE = '/nonexistent/lc-prod-db-credentials/pg_service.conf'
  if (readOnly) out.PGOPTIONS = '-c default_transaction_read_only=on'
  return out
}

async function cli(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'verify-readonly') {
    const c = await connectReadOnlyDiagnostics({ applicationName: 'lc-verify-readonly' })
    console.log(`read-only verified: role ${c.lcCredential.role} at ${c.lcCredential.target}`)
    await c.end()
    return 0
  }
  if (cmd === 'psql') {
    const { url, role, target } = await resolveReadOnlyUrl()
    console.error(`read-only verified: role ${role} at ${target} (psql)`)
    const r = spawnSync(process.env.LC_PSQL || 'psql', ['-X', ...rest], { stdio: 'inherit', env: psqlEnv(url, { readOnly: true }) })
    return r.status ?? 1
  }
  if (cmd === 'psql-write') {
    const w = await resolveProdWriteUrl({ argv: rest, purpose: `psql ${rest.filter((a) => !a.startsWith(PROD_WRITE_FLAG)).join(' ')}` })
    const args = rest.filter((a, i) => !a.startsWith(PROD_WRITE_FLAG) && !(rest[i - 1] === PROD_WRITE_FLAG))
    console.error(`prod-write: approval=${w.approvalRef} target=${w.target} (psql)`)
    const r = spawnSync(process.env.LC_PSQL || 'psql', ['-X', ...args], { stdio: 'inherit', env: { ...psqlEnv(w.url, { readOnly: false }), PGAPPNAME: `lc-prod-write:${w.approvalRef}`.slice(0, 63) } })
    return r.status ?? 1
  }
  console.error('usage: prod-db-credentials.mjs verify-readonly | psql [psql args…] | psql-write --prod-write=<approval-ref> [psql args…]')
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code }, (e) => {
    console.error(`prod-db-credentials: ${e.message}`)
    process.exitCode = e.code === 'LC_CREDENTIAL_REFUSED' ? 3 : 1
  })
}
