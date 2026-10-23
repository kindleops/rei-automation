// The live-mode credential: a DATABASE-ROLE-ENFORCED read-only token. A client-side
// read-only setting does not replace it.
//
//   reader token   a JWT the OWNER mints with the project's JWT secret, role claim
//                  `lc_mcp_reader`. PostgREST verifies it and runs SET ROLE lc_mcp_reader,
//                  so every request runs with that role's grants: SELECT on the read
//                  inventory, EXECUTE on 4 read RPCs, nothing else, no BYPASSRLS.
//   public key     the project's anon (legacy) or publishable key. The API gateway
//                  requires one. It carries no privilege of its own here, because the
//                  reader token sets the role.
//
// What this module refuses, before any request:
//   * a token whose role claim is not exactly lc_mcp_reader (service_role, anon,
//     authenticated, postgres…), by decoding the claim locally with no network; a token
//     with no / past / > 366 day expiry; alg "none";
//   * a "public key" that is really the service-role key or an sb_secret_ key;
//   * credential files that are not dedicated single-value 0600 files owned by this
//     user, that look like env files, or that live inside apps/api;
//   * live mode while a writable app credential sits in the launch environment
//     (SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL, DATABASE_URL, …). Those values are
//     never read; only their NAMES are reported.
// After boot, evaluateSelfCheck() judges the database's own privilege report for the
// role. That report is read through the token itself, so it describes the credential
// actually in use. Its platform_exceptions (the ONE pinned Supabase pg_net exception,
// docs/SUPABASE-PG-NET-POSTURE.md) are re-judged here (data/platform-exposure.mjs); when
// the exception is applied the verdict carries probeRequired, and the live source runs the
// PostgREST / GraphQL exposure probe before the credential is accepted.
import fs from 'node:fs'
import path from 'node:path'
import { READER_ROLE, RELATION_NAMES, OPTIONAL_RELATIONS, RPC_SIGNATURES } from './inventory.mjs'
import { evaluatePlatformExceptions, evaluatePlatformAllowlists } from './platform-exposure.mjs'

export class CredentialError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}
const refuse = (code, message) => new CredentialError(code, message)

/** Roles a reader token may never carry (and the reason it is refused). */
export const PRIVILEGED_ROLES = Object.freeze(['service_role', 'supabase_admin', 'postgres', 'authenticator', 'supabase_auth_admin', 'supabase_storage_admin', 'supabase_functions_admin', 'supabase_replication_admin', 'dashboard_user', 'pgbouncer', 'authenticated', 'anon'])
export const MAX_TOKEN_LIFETIME_DAYS = 366

/** Retired live-mode inputs: each held a WRITABLE credential (service-role key; agent_api login). */
export const RETIRED_LIVE_ENV = Object.freeze(['LEADCOMMAND_MCP_SERVICE_KEY_FILE', 'LEADCOMMAND_MCP_AGENT_DB_URL_FILE', 'LEADCOMMAND_MCP_AGENT_DB_CA_FILE'])

/** Writable app credentials that must not be present in a live-mode launch environment. */
export const AMBIENT_CREDENTIAL_ENV = Object.freeze([
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_JWT_SECRET', 'AGENT_SUPABASE_JWT_SECRET',
  'SUPABASE_DB_URL', 'SUPABASE_URL_NO_POOL', 'SUPABASE_DB_PASSWORD', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_PRISMA_URL',
  'PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'AGENT_DATABASE_URL', 'SUPABASE_ACCESS_TOKEN',
])
const AMBIENT_PATTERN = /(SERVICE_ROLE|SECRET_KEY|JWT_SECRET|(^|_)DB_URL$|DATABASE_URL|POSTGRES_URL|DB_PASSWORD)/

/**
 * NAMES of writable credentials present in env. Presence alone counts: the VALUE is never
 * read, not even to test it for emptiness. LEADCOMMAND_MCP_* keys are the server's own inputs.
 */
export function ambientCredentialNames(env) {
  const out = new Set()
  for (const k of Object.keys(env || {})) {
    if (k.startsWith('LEADCOMMAND_MCP_')) continue
    if (AMBIENT_CREDENTIAL_ENV.includes(k) || AMBIENT_PATTERN.test(k)) out.add(k)
  }
  return [...out].sort()
}

const ENV_FILE_NAME = /(^|[\\/])\.env([.\-_][^\\/]*)?$|\.env$/i
const ENV_LINE = /^\s*(export\s+)?[A-Z_][A-Z0-9_]*\s*=/m

/**
 * A credential file: absolute path, a regular file and not a symlink, owned by this user,
 * mode 0600 or stricter, not an env file, not inside apps/api, ≤ 4 KB, one value.
 * Returns the trimmed value. Error messages name the variable, never the content.
 */
export function readCredentialFile(p, what) {
  const file = String(p || '').trim()
  if (!file) throw refuse('CREDENTIAL_FILE_REQUIRED', `${what} is required in live mode`)
  if (!path.isAbsolute(file)) throw refuse('CREDENTIAL_FILE_INVALID', `${what} must be an absolute path`)
  if (ENV_FILE_NAME.test(file)) throw refuse('ENV_FILE_REFUSED', `${what} points at an env file; live mode reads only a dedicated single-value credential file`)
  const st = fs.lstatSync(file)
  if (st.isSymbolicLink()) throw refuse('CREDENTIAL_FILE_INVALID', `${what} must not be a symlink`)
  if (!st.isFile()) throw refuse('CREDENTIAL_FILE_INVALID', `${what}: not a regular file`)
  const real = fs.realpathSync(file)
  if (/[\\/]apps[\\/]api([\\/]|$)/.test(real)) throw refuse('ENV_FILE_REFUSED', `${what} lies inside apps/api; credentials are never taken from the API's tree`)
  if ((st.mode & 0o077) !== 0) throw refuse('CREDENTIAL_FILE_MODE', `${what} must be mode 0600 (no group / other access)`)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw refuse('CREDENTIAL_FILE_OWNER', `${what} must be owned by the server user`)
  if (st.size > 4096) throw refuse('CREDENTIAL_FILE_INVALID', `${what} is too large for one credential`)
  const value = fs.readFileSync(file, 'utf8').trim()
  if (!value || /\s/.test(value) || ENV_LINE.test(value)) throw refuse('CREDENTIAL_FILE_INVALID', `${what} must hold exactly one value (no KEY=value lines, no whitespace)`)
  return value
}

const B64URL = /^[A-Za-z0-9_-]+$/
const decodePart = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))

/** Decode a JWT WITHOUT verifying it (PostgREST verifies). Throws on a malformed token. No network. */
export function decodeJwtUnverified(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3 || !parts.every((x, i) => (i === 2 ? x.length > 0 : B64URL.test(x)))) throw refuse('TOKEN_MALFORMED', 'the token is not a JWT (header.payload.signature)')
  let header
  let payload
  try {
    header = decodePart(parts[0])
    payload = decodePart(parts[1])
  } catch {
    throw refuse('TOKEN_MALFORMED', 'the token header / payload is not base64url JSON')
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') throw refuse('TOKEN_MALFORMED', 'the token header / payload is not a JSON object')
  return { header, payload }
}

/**
 * The reader token must be EXACTLY a lc_mcp_reader token. The role claim is decoded
 * locally; a service-role (or any other) token is refused before any request.
 * @returns {{ role: string, alg: string, exp: number, iat: number|null, days_left: number }}
 */
export function assertReaderJwt(token, { now = Date.now(), maxLifetimeDays = MAX_TOKEN_LIFETIME_DAYS } = {}) {
  const { header, payload } = decodeJwtUnverified(token)
  const alg = String(header.alg || '')
  if (!alg || alg.toLowerCase() === 'none') throw refuse('TOKEN_UNSIGNED', 'the reader token is unsigned (alg none)')
  const role = typeof payload.role === 'string' ? payload.role : ''
  if (role === 'service_role') throw refuse('SERVICE_ROLE_REFUSED', 'the reader token is a SERVICE-ROLE token; live mode accepts only a lc_mcp_reader token')
  if (PRIVILEGED_ROLES.includes(role)) throw refuse('ROLE_REFUSED', `the reader token's role claim is "${role}"; live mode accepts only ${READER_ROLE}`)
  if (role !== READER_ROLE) throw refuse('ROLE_REFUSED', `the reader token's role claim must be ${READER_ROLE}`)
  const exp = Number(payload.exp)
  if (!Number.isFinite(exp)) throw refuse('TOKEN_NO_EXPIRY', 'the reader token has no exp claim; mint it with an expiry')
  const left = exp * 1000 - now
  if (left <= 0) throw refuse('TOKEN_EXPIRED', 'the reader token has expired; mint a new one')
  if (left > maxLifetimeDays * 86_400_000) throw refuse('TOKEN_LIFETIME', `the reader token expires more than ${maxLifetimeDays} days from now; mint a shorter-lived one`)
  return { role, alg, exp, iat: Number.isFinite(Number(payload.iat)) ? Number(payload.iat) : null, days_left: Math.floor(left / 86_400_000) }
}

/**
 * The gateway key: the anon (legacy JWT) or publishable key. The service-role key, a
 * sb_secret_ key or any other role is refused, again by decoding locally.
 * @returns {{ kind: 'legacy_anon'|'publishable' }}
 */
export function assertPublicApiKey(key) {
  const k = String(key || '')
  if (k.startsWith('sb_secret_')) throw refuse('SECRET_KEY_REFUSED', 'LEADCOMMAND_MCP_API_KEY_FILE holds a SECRET key; give the publishable (or legacy anon) key');
  if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(k)) return { kind: 'publishable' }
  let payload
  try {
    payload = decodeJwtUnverified(k).payload
  } catch {
    throw refuse('API_KEY_INVALID', 'LEADCOMMAND_MCP_API_KEY_FILE must hold the project publishable key or legacy anon key')
  }
  if (payload.role === 'service_role') throw refuse('SERVICE_ROLE_REFUSED', 'LEADCOMMAND_MCP_API_KEY_FILE holds the SERVICE-ROLE key; give the anon / publishable key')
  if (payload.role !== 'anon') throw refuse('API_KEY_INVALID', 'LEADCOMMAND_MCP_API_KEY_FILE must hold the anon (legacy) or publishable key')
  return { kind: 'legacy_anon' }
}

const empty = (v) => Array.isArray(v) && v.length === 0
const list = (v) => (Array.isArray(v) ? v.slice(0, 10).map((x) => String(x).slice(0, 120)).join(', ') : String(v))

/**
 * Judge the database's privilege report (public.lc_mcp_reader_self_check) for the role
 * the token runs as. The rules are evaluated HERE, independently of the report's own
 * `ok`; both must agree for the credential to be accepted.
 * @returns {{ ok: boolean, findings: string[], info: object }}
 */
export function evaluateSelfCheck(rep, { relations = RELATION_NAMES, optional = OPTIONAL_RELATIONS, functions = RPC_SIGNATURES } = {}) {
  const f = []
  if (!rep || typeof rep !== 'object') return { ok: false, findings: ['report_missing'], info: {} }
  if (rep.version !== 1) f.push(`report_version:${rep.version}`)
  if (rep.exists !== true) f.push('role_missing')
  if (rep.role !== READER_ROLE) f.push(`report_role:${String(rep.role).slice(0, 40)}`)
  // the request really RAN as the reader role: proves PostgREST accepted the token and switched role
  if (rep.current_user !== READER_ROLE) f.push(`running_as:${String(rep.current_user).slice(0, 40)}`)
  const a = rep.attributes || {}
  for (const k of ['superuser', 'bypassrls', 'createrole', 'createdb', 'replication', 'canlogin']) if (a[k] !== false) f.push(`attr_${k}`)
  for (const k of ['member_of', 'write_privileges', 'sequence_privileges', 'schema_create', 'reachable_definer_functions', 'reachable_egress_functions', 'exposed_select_outside_inventory']) {
    if (!empty(rep[k])) f.push(`${k}:${list(rep[k])}`)
  }
  if (rep.database_create !== false) f.push('database_create')
  const rels = new Map((rep.relations || []).map((r) => [r.name, r]))
  for (const name of relations) {
    const r = rels.get(name)
    if (!r) { f.push(`relation_not_reported:${name}`); continue }
    if (!r.exists) { if (!optional.includes(name)) f.push(`relation_missing:${name}`); continue }
    if (r.select !== true) f.push(`no_select:${name}`)
    if (r.rls && r.permissive_policy !== true) f.push(`rls_without_policy:${name}`)
    if (r.restrictive_policy) f.push(`restrictive_policy:${name}`)
    if (r.invoker_view) f.push(`invoker_view:${name}`)
  }
  for (const name of rels.keys()) if (!relations.includes(name)) f.push(`relation_not_in_inventory:${name}`)
  const fns = new Map((rep.functions || []).map((x) => [x.signature, x]))
  for (const sig of functions) {
    const x = fns.get(sig)
    if (!x || !x.exists) { f.push(`function_missing:${sig}`); continue }
    if (x.executable !== true) f.push(`no_execute:${sig}`)
    if (x.volatility === 'v') f.push(`volatile_function:${sig}`)
  }
  // the pinned Supabase pg_net platform exception, re-judged independently (version pin, controls, net-only objects)
  const pe = evaluatePlatformExceptions(rep)
  f.push(...pe.findings)
  // the pinned platform allowlists of the indirect-egress rule (PostGIS 3.3.7 dynamic SQL; the pg_net access event trigger)
  const pa = evaluatePlatformAllowlists(rep)
  f.push(...pa.findings)
  // pg_net (schema net) reachable OUTSIDE an applied exception: name the remediation (owner supabase_admin; postgres cannot revoke)
  if ([...(rep.reachable_egress_functions || []), ...(rep.write_privileges || [])].some((x) => /^net\./.test(String(x)))) {
    const why = (pe.summary.find((x) => x.id === 'supabase_pg_net')?.reasons || []).slice(0, 3).join('; ')
    f.push(`pg_net_public: the role can reach schema net (pg_net) and the Supabase platform exception does not apply${why ? ` (${why})` : ''}. Resolve it before going live: drop the extension, or have Supabase revoke PUBLIC on schema net, its functions and tables (docs/SUPABASE-PG-NET-POSTURE.md)`)
  }
  // the database's own verdict must agree
  if (rep.ok !== true || !empty(rep.findings)) f.push(`database_findings:${list(rep.findings)}`)
  const info = {
    running_as: rep.current_user ?? null,
    session_user: rep.session_user ?? null,
    relations: rels.size,
    functions: fns.size,
    select_outside_inventory: Array.isArray(rep.select_outside_inventory) ? rep.select_outside_inventory.length : null,
    database_temp: rep.database_temp ?? null,
    owner_rights_views: [...rels.values()].filter((r) => r.kind === 'v' && !r.invoker_view).map((r) => r.name),
    server_version_num: rep.server_version_num ?? null,
    platform_exceptions: pe.summary,
    platform_allowlists: pa.summary,
  }
  return { ok: f.length === 0, findings: f, info, probeRequired: pe.probeRequired }
}
