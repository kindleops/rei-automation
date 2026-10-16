// Configuration. Read ONCE from the trusted host environment (the MCP client's
// server launch config), validated, then credentials are moved into closures
// and the process environment is scrubbed, so no module loaded later (a
// transitively imported default Supabase client, a logger, a crash reporter)
// can find a key or a database URL in process.env.
//
// The principal comes from here — never from a tool argument.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { parseScopes } from './authz/scopes.mjs'

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

// hard ceilings: env may LOWER a budget, never raise it past these
export const CEILINGS = Object.freeze({ rate_per_min: 120, max_concurrency: 8, call_timeout_ms: 15_000, max_response_bytes: 262_144 })
export const DEFAULTS = Object.freeze({ rate_per_min: 60, max_concurrency: 4, call_timeout_ms: 10_000, max_response_bytes: 98_304 })

const intIn = (raw, dflt, ceil, min = 1) => {
  if (raw == null || raw === '') return dflt
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`invalid integer ${raw}`)
  return Math.min(n, ceil)
}

/** Transports 1.x can run. Anything else refuses to boot. */
export const TRANSPORTS = Object.freeze(['stdio', 'streamable-http'])
/** The ONLY bind addresses 1.x accepts: loopback literals. No hostname (it could resolve elsewhere), no wildcard. */
export const LOOPBACK_BINDS = Object.freeze(['127.0.0.1', '::1'])
export const HTTP_DEFAULTS = Object.freeze({ port: 8765, session_concurrency: 2, max_sessions: 8, session_idle_ms: 15 * 60_000, max_body_bytes: 65_536 })
export const HTTP_CEILINGS = Object.freeze({ session_concurrency: CEILINGS.max_concurrency, max_sessions: 32, session_idle_ms: 60 * 60_000, max_body_bytes: 262_144 })
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{32,512}$/

/**
 * Bearer token file for the HTTP transport: a regular file owned by this uid with no group /
 * other permission bits (0600 or stricter). Only the SHA-256 digest is kept; the token itself
 * never leaves this function, never enters a log, an error message or a tool result.
 */
export function readTokenDigest(p) {
  if (!p) throw new Error('LEADCOMMAND_MCP_HTTP_TOKEN_FILE is required for streamable-http')
  const st = fs.statSync(p)
  if (!st.isFile()) throw new Error('LEADCOMMAND_MCP_HTTP_TOKEN_FILE: not a regular file')
  if ((st.mode & 0o077) !== 0) throw new Error('LEADCOMMAND_MCP_HTTP_TOKEN_FILE must be mode 0600 (no group / other access)')
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('LEADCOMMAND_MCP_HTTP_TOKEN_FILE must be owned by the server user')
  const tok = fs.readFileSync(p, 'utf8').trim()
  if (!TOKEN_RE.test(tok)) throw new Error('LEADCOMMAND_MCP_HTTP_TOKEN_FILE must hold one token of 32–512 URL-safe characters')
  return crypto.createHash('sha256').update(tok, 'utf8').digest()
}

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/i

function loadHttp(env, limits) {
  const bind = String(env.LEADCOMMAND_MCP_HTTP_BIND || '127.0.0.1').trim()
  if (!LOOPBACK_BINDS.includes(bind)) throw new Error(`LEADCOMMAND_MCP_HTTP_BIND must be 127.0.0.1 or ::1 in 1.x (got a non-loopback address); public exposure is not supported`)
  const port = intIn(env.LEADCOMMAND_MCP_HTTP_PORT, HTTP_DEFAULTS.port, 65_535, 0)
  const origins = String(env.LEADCOMMAND_MCP_HTTP_ALLOWED_ORIGINS || '').split(/[\s,]+/).map((o) => o.trim()).filter(Boolean)
  for (const o of origins) if (!LOOPBACK_ORIGIN.test(o)) throw new Error('LEADCOMMAND_MCP_HTTP_ALLOWED_ORIGINS may list loopback origins only (http(s)://127.0.0.1 | localhost | [::1] [:port])')
  const digest = readTokenDigest(String(env.LEADCOMMAND_MCP_HTTP_TOKEN_FILE || '').trim())
  const http = {
    bind,
    port,
    path: '/mcp',
    allowed_origins: Object.freeze(origins.map((o) => o.toLowerCase())),
    session_concurrency: Math.min(intIn(env.LEADCOMMAND_MCP_HTTP_SESSION_CONCURRENCY, HTTP_DEFAULTS.session_concurrency, HTTP_CEILINGS.session_concurrency), limits.max_concurrency),
    max_sessions: intIn(env.LEADCOMMAND_MCP_HTTP_MAX_SESSIONS, HTTP_DEFAULTS.max_sessions, HTTP_CEILINGS.max_sessions),
    session_idle_ms: intIn(env.LEADCOMMAND_MCP_HTTP_SESSION_IDLE_MS, HTTP_DEFAULTS.session_idle_ms, HTTP_CEILINGS.session_idle_ms, 1000),
    max_body_bytes: intIn(env.LEADCOMMAND_MCP_HTTP_MAX_BODY_BYTES, HTTP_DEFAULTS.max_body_bytes, HTTP_CEILINGS.max_body_bytes, 1024),
  }
  Object.defineProperty(http, 'tokenDigest', { value: () => digest, enumerable: false })
  return Object.freeze(http)
}

const readSecretFile = (p, what) => {
  if (!p) return null
  const st = fs.statSync(p)
  if (!st.isFile()) throw new Error(`${what}: not a file`)
  return fs.readFileSync(p, 'utf8').trim()
}

/** Env keys removed from process.env after boot (credentials and DB URLs of any kind). */
export const SCRUB_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|DATABASE_URL|DB_URL|POSTGRES|SUPABASE|PGPASSWORD|PGUSER|PGHOST|CREDENTIAL|PRIVATE)/i

export function scrubEnv(env = process.env) {
  const removed = []
  for (const k of Object.keys(env)) if (SCRUB_RE.test(k) || k.startsWith('LEADCOMMAND_MCP_')) { delete env[k]; removed.push(k) }
  return removed.length
}

/**
 * @param {Record<string,string|undefined>} env
 * @returns {object} frozen config; `secrets` is a closure accessor, never enumerable
 */
export function loadConfig(env = process.env) {
  const transport = String(env.LEADCOMMAND_MCP_TRANSPORT || 'stdio').toLowerCase()
  if (!TRANSPORTS.includes(transport)) throw new Error(`LEADCOMMAND_MCP_TRANSPORT=${transport.slice(0, 32)} is not supported (stdio | streamable-http)`)
  const dataMode = String(env.LEADCOMMAND_MCP_DATA || 'fixture').toLowerCase()
  if (!['fixture', 'live'].includes(dataMode)) throw new Error('LEADCOMMAND_MCP_DATA must be fixture | live')
  const principal = String(env.LEADCOMMAND_MCP_PRINCIPAL_USER_ID || '').trim() || null
  const orgId = String(env.LEADCOMMAND_MCP_ORG_ID || '').trim() || null
  const dataOrgId = String(env.LEADCOMMAND_MCP_DATA_ORG_ID || orgId || '').trim() || null
  for (const [k, v] of [['LEADCOMMAND_MCP_PRINCIPAL_USER_ID', principal], ['LEADCOMMAND_MCP_ORG_ID', orgId], ['LEADCOMMAND_MCP_DATA_ORG_ID', dataOrgId]]) {
    if (v && !UUID.test(v)) throw new Error(`${k} must be a UUID`)
  }
  let secrets = null
  if (dataMode === 'live') {
    const supabaseUrl = String(env.LEADCOMMAND_MCP_SUPABASE_URL || '').trim()
    if (!/^https:\/\/[a-z0-9.-]+(:[0-9]+)?\/?$/i.test(supabaseUrl)) throw new Error('LEADCOMMAND_MCP_SUPABASE_URL must be the https origin of the app data service')
    const serviceKey = readSecretFile(env.LEADCOMMAND_MCP_SERVICE_KEY_FILE, 'LEADCOMMAND_MCP_SERVICE_KEY_FILE')
    const agentDbUrl = readSecretFile(env.LEADCOMMAND_MCP_AGENT_DB_URL_FILE, 'LEADCOMMAND_MCP_AGENT_DB_URL_FILE')
    const agentDbCa = readSecretFile(env.LEADCOMMAND_MCP_AGENT_DB_CA_FILE, 'LEADCOMMAND_MCP_AGENT_DB_CA_FILE')
    if (!serviceKey) throw new Error('LEADCOMMAND_MCP_SERVICE_KEY_FILE is required in live mode')
    if (!agentDbUrl || !agentDbCa) throw new Error('LEADCOMMAND_MCP_AGENT_DB_URL_FILE and LEADCOMMAND_MCP_AGENT_DB_CA_FILE are required in live mode (membership is verified as agent_api)')
    const frozen = Object.freeze({ supabaseUrl: supabaseUrl.replace(/\/$/, ''), serviceKey, agentDbUrl, agentDbCa })
    secrets = () => frozen
  }
  const limits = Object.freeze({
    rate_per_min: intIn(env.LEADCOMMAND_MCP_RATE_PER_MIN, DEFAULTS.rate_per_min, CEILINGS.rate_per_min),
    max_concurrency: intIn(env.LEADCOMMAND_MCP_MAX_CONCURRENCY, DEFAULTS.max_concurrency, CEILINGS.max_concurrency),
    call_timeout_ms: intIn(env.LEADCOMMAND_MCP_CALL_TIMEOUT_MS, DEFAULTS.call_timeout_ms, CEILINGS.call_timeout_ms, 100),
    max_response_bytes: intIn(env.LEADCOMMAND_MCP_MAX_RESPONSE_BYTES, DEFAULTS.max_response_bytes, CEILINGS.max_response_bytes, 1024),
  })
  const cfg = {
    transport,
    http: transport === 'streamable-http' ? loadHttp(env, limits) : null,
    dataMode,
    principal: principal ? Object.freeze({ user_id: principal, org_id: orgId, method: 'host_config' }) : null,
    dataOrgId,
    scopes: Object.freeze(parseScopes(env.LEADCOMMAND_MCP_SCOPES)),
    limits,
    auditFile: String(env.LEADCOMMAND_MCP_AUDIT_FILE || '').trim() || null,
  }
  Object.defineProperty(cfg, 'secrets', { value: secrets, enumerable: false })
  return Object.freeze(cfg)
}

const httpSummary = (h) => (h ? { bind: h.bind, port: h.port, path: h.path, allowed_origins: [...h.allowed_origins], session_concurrency: h.session_concurrency, max_sessions: h.max_sessions, session_idle_ms: h.session_idle_ms, max_body_bytes: h.max_body_bytes, auth: 'bearer_token_file' } : null)

export const summarize = (cfg) => ({ transport: cfg.transport, http: httpSummary(cfg.http), dataMode: cfg.dataMode, principal_configured: Boolean(cfg.principal), scopes: [...cfg.scopes], limits: cfg.limits })
