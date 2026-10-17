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
//   READ-ONLY DIAGNOSTICS — loadReadOnly(purpose) / connectReadOnlyDiagnostics({ purpose })
//                           / openReadOnlyPool({ purpose }) / resolveReadOnlyUrl({ purpose })
//     There is no single broad diagnostics role (owner decision 2026-10-16): every caller
//     names a PURPOSE from READONLY_PURPOSES (e.g. 'ops_diag'), and the connection string
//     comes ONLY from that purpose's file, LC_RO_<PURPOSE>_DB_URL_FILE (absolute path, a
//     regular file owned by you, mode 0600/0400, one postgres:// URL). An unknown purpose
//     is refused. Before any other statement the role is VERIFIED to be read-only by the
//     database's own privilege system — not by a session setting:
//       - current_user and every role it can SET ROLE to: not rolsuper, not rolcreaterole /
//         rolcreatedb / rolreplication, and not rolbypassrls — the login role may hold
//         BYPASSRLS only when its purpose is explicitly allowlisted for it
//         (READONLY_PURPOSES[p].allowBypassRls; none is today); a role reachable through
//         SET ROLE never may
//       - has_table_privilege(role, t, 'INSERT,UPDATE,DELETE,TRUNCATE') is false for
//         every sentinel (public.send_queue, public.sms_templates, public.system_control,
//         agent.runtime_limits when present); a required sentinel that is missing means
//         the role cannot be verified, which is a refusal too
//       - no CREATE on schema public
//       - no network egress: no EXECUTE (directly, by membership or through PUBLIC) on
//         net.http_get / http_post / http_delete or any function of the pg_net, http or
//         dblink extensions, and no USAGE on a foreign server. In production PUBLIC holds
//         EXECUTE on pg_net, so this refuses EVERY role until the owner revokes it — the
//         intended fail-closed behavior.
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
//   node scripts/lib/prod-db-credentials.mjs verify-readonly <purpose>
//   node scripts/lib/prod-db-credentials.mjs psql <purpose> [psql args…]       (read-only role)
//   node scripts/lib/prod-db-credentials.mjs psql-write --prod-write=<ref> [psql args…]
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PROD_WRITE_URL_FILE_ENV = 'LC_PROD_WRITE_DB_URL_FILE'
export const PROD_WRITE_FLAG = '--prod-write'

/**
 * Read-only PURPOSES. Each maps to its own credential file (LC_RO_<PURPOSE>_DB_URL_FILE) so
 * each can be a purpose-specific least-privilege role. allowBypassRls lets that purpose's
 * LOGIN role hold BYPASSRLS; it is false everywhere until the owner allowlists a purpose.
 * Adding a purpose or flipping allowBypassRls is a reviewed code change, by design.
 */
export const READONLY_PURPOSES = Object.freeze({
  ops_diag: Object.freeze({ description: 'queue / inbox / sender routing / follow-up / autopilot / safety diagnostics', allowBypassRls: false }),
  entity_graph: Object.freeze({ description: 'Entity Graph probes, fixtures, captures and facts verification', allowBypassRls: false }),
  market_intel: Object.freeze({ description: 'Market Intelligence service performance harness', allowBypassRls: false }),
  seller_intel: Object.freeze({ description: 'seller-schema propagation and scoring comparisons', allowBypassRls: false }),
  research_agent: Object.freeze({ description: 'read-only research agent local end-to-end proof', allowBypassRls: false }),
})

/** LC_RO_<PURPOSE>_DB_URL_FILE for a registered purpose; refuses anything else. */
export function readOnlyUrlFileEnv(purpose) {
  const p = String(purpose ?? '').trim()
  if (!p) refuse(`a read-only PURPOSE is required (one of: ${Object.keys(READONLY_PURPOSES).join(', ')}) — there is no default diagnostics role`)
  if (!Object.hasOwn(READONLY_PURPOSES, p)) refuse(`unknown read-only purpose ${JSON.stringify(p)} (registered: ${Object.keys(READONLY_PURPOSES).join(', ')})`)
  return `LC_RO_${p.toUpperCase()}_DB_URL_FILE`
}

/** Tables a diagnostics role must never be able to write. `required: false` = checked when present. */
export const READONLY_SENTINELS = Object.freeze([
  Object.freeze({ table: 'public.send_queue', required: true }),
  Object.freeze({ table: 'public.sms_templates', required: true }),
  Object.freeze({ table: 'public.system_control', required: true }),
  Object.freeze({ table: 'agent.runtime_limits', required: false }),
])

// Sources this loader refuses outright, whatever path points at them.
const FORBIDDEN_URL_FILES = Object.freeze(['/tmp/.dburl', '/private/tmp/.dburl'])
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
  // an inline URL variable next to the file variable is refused so nobody "helpfully" adds one
  const inline = envName.replace(/_FILE$/, '')
  if (env[inline]) refuse(`${inline} is set: connection strings are never taken from the environment — store it in a 0600 file and point ${envName} at it`)
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
),
-- network egress: pg_net's net.http_get / http_post / http_delete by name, and every function
-- that belongs to a network-capable extension (pg_net, http, dblink)
egress as (
  select p.oid, p.oid::regprocedure::text as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'net' and p.proname in ('http_get', 'http_post', 'http_delete'))
      or exists (select 1
                   from pg_depend d
                   join pg_extension e on e.oid = d.refobjid
                  where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                    and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e'
                    and e.extname = any($3::text[]))
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
         where has_schema_privilege(r.oid, 'public', 'CREATE')) as public_create_by,
       (select coalesce(json_agg(json_build_object('fn', g.fn, 'roles', g.roles) order by g.fn), '[]'::json)
          from (select g.fn, json_agg(r.rolname order by r.rolname) as roles
                  from egress g
                  cross join reach r
                 where has_function_privilege(r.oid, g.oid, 'EXECUTE')
                 group by g.fn) g) as egress_exec,
       (select coalesce(json_agg(format('%s via %s', fs.srvname, r.rolname) order by fs.srvname, r.rolname), '[]'::json)
          from pg_foreign_server fs
          cross join reach r
         where has_server_privilege(r.oid, fs.oid, 'USAGE')) as foreign_server_usage
`

/** Extensions whose functions reach the network (checked by membership, any schema). */
export const EGRESS_EXTENSIONS = Object.freeze(['pg_net', 'http', 'dblink'])

/**
 * Pure: turn the verification row into { ok, reasons }. `allowBypassRls` (from the purpose)
 * tolerates BYPASSRLS on the LOGIN role only — never on a role reachable via SET ROLE.
 */
export function judgeReadOnly(row, { allowBypassRls = false, purpose = null } = {}) {
  const reasons = []
  for (const r of row.roles || []) {
    const self = r.role === row.current_user
    const via = self ? '' : ` (reachable via SET ROLE ${r.role})`
    if (r.super) reasons.push(`role ${r.role} is a superuser${via}`)
    if (r.bypassrls && !(self && allowBypassRls)) reasons.push(`role ${r.role} has BYPASSRLS${via}${self && purpose ? ` and purpose ${purpose} is not allowlisted for BYPASSRLS` : ''}`)
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
  // network egress: a read-only role that can make the database call out can exfiltrate what
  // it reads (or trigger side effects through an HTTP endpoint). EXECUTE reached through
  // PUBLIC counts — in production PUBLIC holds it on pg_net, so EVERY role is refused until
  // the owner revokes it (intended; see docs/CREDENTIAL-SAFETY.md).
  const egress = row.egress_exec || []
  if (egress.length) {
    const shown = egress.slice(0, 5).map((e) => `${e.fn} (EXECUTE held by ${e.roles.join(', ')}, directly or through PUBLIC)`)
    reasons.push(`the role can reach network-egress functions: ${shown.join('; ')}${egress.length > 5 ? `; … ${egress.length - 5} more` : ''}`)
  }
  if (row.foreign_server_usage?.length) reasons.push(`the role has USAGE on foreign servers (network egress): ${row.foreign_server_usage.join(', ')}`)
  return { ok: reasons.length === 0, role: row.current_user, reasons }
}

/** Run the verification on an open client. Throws CredentialRefusedError unless read-only. */
export async function verifyRoleEnforcedReadOnly(client, { sentinels = READONLY_SENTINELS, purpose = null } = {}) {
  const spec = purpose ? READONLY_PURPOSES[purpose] : null
  const { rows } = await client.query(VERIFY_READONLY_SQL, [sentinels.map((s) => s.table), sentinels.map((s) => Boolean(s.required)), EGRESS_EXTENSIONS])
  const verdict = { ...judgeReadOnly(rows[0], { allowBypassRls: Boolean(spec?.allowBypassRls), purpose }), purpose }
  if (!verdict.ok) refuse(`refused: the ${purpose ? `${purpose} ` : ''}diagnostics credential (role ${verdict.role}) is not role-enforced read-only — ${verdict.reasons.join('; ')}. BEGIN READ ONLY does not make a writable credential acceptable; use a least-privilege read-only role.`, verdict)
  return verdict
}

async function loadPg(pg) {
  if (pg) return pg
  const mod = await import('pg')
  return mod.default || mod
}

function clientConfig(url, { applicationName, ssl, types }) {
  const host = parsePgUrl(url).host
  return {
    connectionString: url,
    application_name: applicationName,
    ...(types ? { types } : {}),
    ssl: ssl !== undefined ? ssl : isLocalHost(host) ? false : { rejectUnauthorized: false },
  }
}

function readPurposeUrlFile(purpose, env) {
  return readUrlFile({ env, envName: readOnlyUrlFileEnv(purpose) })
}

async function connectVerified(cred, { purpose, pg, applicationName, statementTimeoutMs, ssl, sentinels, types }) {
  const { Client } = await loadPg(pg)
  const client = new Client(clientConfig(cred.url, { applicationName, ssl, types }))
  await client.connect()
  try {
    const verdict = await verifyRoleEnforcedReadOnly(client, { sentinels, purpose })
    await client.query(`set default_transaction_read_only = on; set statement_timeout = ${statementTimeoutMs}`)
    client.lcCredential = Object.freeze({ kind: 'readonly', purpose, target: cred.target, role: verdict.role })
    return client
  } catch (e) {
    await client.end().catch(() => {})
    throw e
  }
}

const timeoutMs = (v) => Math.max(1000, Math.floor(Number(v) || 30_000))

/**
 * Open ONE verified read-only connection for a registered purpose.
 * @param {{ purpose: string, env?: object, pg?: object, applicationName?: string, statementTimeoutMs?: number, ssl?: any, sentinels?: object[], types?: object }} opts
 */
export async function connectReadOnlyDiagnostics({ purpose, env = process.env, pg, applicationName, statementTimeoutMs = 30_000, ssl, sentinels, types } = {}) {
  const cred = readPurposeUrlFile(purpose, env)
  return connectVerified(cred, { purpose, pg, applicationName: applicationName || `lc-ro-${purpose}`, statementTimeoutMs: timeoutMs(statementTimeoutMs), ssl, sentinels, types })
}

/** loadReadOnly('ops_diag', opts) — the same door, purpose first. */
export function loadReadOnly(purpose, opts = {}) {
  return connectReadOnlyDiagnostics({ ...opts, purpose })
}

/**
 * A pg.Pool for diagnostics: the credential is read once, its role verified on a probe
 * connection, and every pooled session starts default_transaction_read_only.
 */
export async function openReadOnlyPool({ purpose, env = process.env, pg, applicationName, statementTimeoutMs = 30_000, max = 4, ssl, sentinels, types } = {}) {
  const cred = readPurposeUrlFile(purpose, env)
  const timeout = timeoutMs(statementTimeoutMs)
  applicationName ||= `lc-ro-${purpose}`
  const probe = await connectVerified(cred, { purpose, pg, applicationName, statementTimeoutMs: timeout, ssl, sentinels })
  const meta = probe.lcCredential
  await probe.end()
  const { Pool } = await loadPg(pg)
  const pool = new Pool({ ...clientConfig(cred.url, { applicationName, ssl, types }), max, options: `-c default_transaction_read_only=on -c statement_timeout=${timeout}` })
  pool.lcCredential = meta
  return pool
}

/** The verified read-only URL, for a child process (psql). Verifies the role first. */
export async function resolveReadOnlyUrl({ purpose, env = process.env, pg, sentinels } = {}) {
  const cred = readPurposeUrlFile(purpose, env)
  const probe = await connectVerified(cred, { purpose, pg, applicationName: `lc-verify-ro-${purpose}`, statementTimeoutMs: 30_000, sentinels })
  const meta = probe.lcCredential
  await probe.end()
  return { url: cred.url, purpose, target: meta.target, role: meta.role }
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
    if (/^(SUPABASE_DB_URL|SUPABASE_URL_NO_POOL|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|POSTGRES_URL\w*|DIRECT_URL|LC_RO_\w+_DB_URL_FILE|LC_PROD_WRITE_DB_URL_FILE)$/.test(k)) continue
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
    const [purpose] = rest
    const c = await connectReadOnlyDiagnostics({ purpose, applicationName: `lc-verify-ro-${purpose}` })
    console.log(`read-only verified: purpose ${purpose}, role ${c.lcCredential.role} at ${c.lcCredential.target}`)
    await c.end()
    return 0
  }
  if (cmd === 'psql') {
    const [purpose, ...args] = rest
    const { url, role, target } = await resolveReadOnlyUrl({ purpose })
    console.error(`read-only verified: purpose ${purpose}, role ${role} at ${target} (psql)`)
    const r = spawnSync(process.env.LC_PSQL || 'psql', ['-X', ...args], { stdio: 'inherit', env: psqlEnv(url, { readOnly: true }) })
    return r.status ?? 1
  }
  if (cmd === 'psql-write') {
    const w = await resolveProdWriteUrl({ argv: rest, purpose: `psql ${rest.filter((a) => !a.startsWith(PROD_WRITE_FLAG)).join(' ')}` })
    const args = rest.filter((a, i) => !a.startsWith(PROD_WRITE_FLAG) && !(rest[i - 1] === PROD_WRITE_FLAG))
    console.error(`prod-write: approval=${w.approvalRef} target=${w.target} (psql)`)
    const r = spawnSync(process.env.LC_PSQL || 'psql', ['-X', ...args], { stdio: 'inherit', env: { ...psqlEnv(w.url, { readOnly: false }), PGAPPNAME: `lc-prod-write:${w.approvalRef}`.slice(0, 63) } })
    return r.status ?? 1
  }
  console.error(`usage: prod-db-credentials.mjs verify-readonly <purpose> | psql <purpose> [psql args…] | psql-write --prod-write=<approval-ref> [psql args…]\n  purposes: ${Object.keys(READONLY_PURPOSES).join(', ')}`)
  return 2
}

// realpath: a symlinked checkout or tmp dir (/var → /private/var) must still count as "run directly"
const isMain = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code }, (e) => {
    console.error(`prod-db-credentials: ${e.message}`)
    process.exitCode = e.code === 'LC_CREDENTIAL_REFUSED' ? 3 : 1
  })
}
