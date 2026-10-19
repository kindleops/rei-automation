// Configuration, read ONCE from the trusted host environment (the MCP client's server launch config),
// validated, then credentials move into closures and the process environment is scrubbed, so no module
// loaded later can find a key, a token, a pepper or a database URL in process.env.
//
// Identity: an AGENT is never configured here and never taken from a tool argument. Each agent presents
// its own credential (lcag_…): over HTTP as the bearer token of the request; over stdio from a 0600
// credential file named by the host. The gateway verifies it against the principal registry per call.
import fs from 'node:fs'
import { readCredentialFile, ambientCredentialNames, CredentialError } from '../../leadcommand-mcp/src/data/credential.mjs'
import { AGENT_CREDENTIAL_RE } from '@/lib/domain/action-gateway/credentials.js'

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
export const PREFIX = 'LEADCOMMAND_ACTION_MCP_'
export const TRANSPORTS = Object.freeze(['stdio', 'streamable-http'])
export const LOOPBACK_BINDS = Object.freeze(['127.0.0.1', '::1'])
export const HTTP_DEFAULTS = Object.freeze({ port: 8766, session_concurrency: 2, max_sessions: 16, session_idle_ms: 15 * 60_000, max_body_bytes: 65_536 })
export const HTTP_CEILINGS = Object.freeze({ session_concurrency: 4, max_sessions: 64, session_idle_ms: 60 * 60_000, max_body_bytes: 262_144 })
export const LIMIT_DEFAULTS = Object.freeze({ max_concurrency: 6, call_timeout_ms: 45_000 })
const LIVE_URL = /^(https:\/\/[a-z0-9.-]+(:[0-9]+)?|http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5})\/?$/i
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/i

/** Env keys removed from process.env after boot (credentials and DB URLs of any kind + our own inputs). */
export const SCRUB_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|DATABASE_URL|DB_URL|POSTGRES|SUPABASE|PGPASSWORD|PGUSER|PGHOST|CREDENTIAL|PRIVATE|PEPPER|JWT)/i
export function scrubEnv(env = process.env) {
  let n = 0
  for (const k of Object.keys(env)) if (SCRUB_RE.test(k) || k.startsWith(PREFIX) || k.startsWith('LEADCOMMAND_MCP_')) { delete env[k]; n += 1 }
  return n
}

const intIn = (raw, dflt, ceil, min = 1) => {
  if (raw == null || raw === '') return dflt
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`invalid integer ${String(raw).slice(0, 20)}`)
  return Math.min(n, ceil)
}

export const auditFileOf = (env = process.env) => String(env[`${PREFIX}AUDIT_FILE`] || '').trim() || null

/**
 * @param {Record<string,string|undefined>} env
 * @param {{ injectedDb?: boolean }} [o] tests inject a database client: the live credential files are then optional
 */
export function loadConfig(env = process.env, { injectedDb = false } = {}) {
  const get = (k) => String(env[`${PREFIX}${k}`] ?? '').trim()
  const transport = (get('TRANSPORT') || 'stdio').toLowerCase()
  if (!TRANSPORTS.includes(transport)) throw new Error(`${PREFIX}TRANSPORT must be stdio | streamable-http`)
  const orgId = get('ORG_ID').toLowerCase()
  if (!UUID.test(orgId)) throw new Error(`${PREFIX}ORG_ID (the served org) must be a uuid`)
  const ambient = ambientCredentialNames(env).filter((k) => !k.startsWith(PREFIX))
  if (ambient.length) throw new CredentialError('AMBIENT_CREDENTIAL', `refusing to start: writable app credentials are present in the launch environment (${ambient.slice(0, 8).join(', ')}); the Action MCP never reads them`)
  const pepper = readCredentialFile(env[`${PREFIX}PEPPER_FILE`], `${PREFIX}PEPPER_FILE`)
  if (Buffer.byteLength(pepper, 'utf8') < 32) throw new CredentialError('PEPPER_INVALID', `${PREFIX}PEPPER_FILE must hold at least 32 bytes`)
  let live = null
  if (!injectedDb) {
    const supabaseUrl = get('SUPABASE_URL')
    if (!LIVE_URL.test(supabaseUrl)) throw new CredentialError('URL_INVALID', `${PREFIX}SUPABASE_URL must be the https origin of the app data service (or an http loopback origin)`)
    live = Object.freeze({ supabaseUrl: supabaseUrl.replace(/\/$/, ''), apiKey: readCredentialFile(env[`${PREFIX}API_KEY_FILE`], `${PREFIX}API_KEY_FILE`), gatewayJwt: readCredentialFile(env[`${PREFIX}GATEWAY_JWT_FILE`], `${PREFIX}GATEWAY_JWT_FILE`) })
  }
  let stdioCredential = null
  if (transport === 'stdio') {
    stdioCredential = readCredentialFile(env[`${PREFIX}AGENT_CREDENTIAL_FILE`], `${PREFIX}AGENT_CREDENTIAL_FILE`)
    if (!AGENT_CREDENTIAL_RE.test(stdioCredential)) throw new CredentialError('AGENT_CREDENTIAL_INVALID', `${PREFIX}AGENT_CREDENTIAL_FILE must hold one agent credential (lcag_…)`)
  }
  let http = null
  if (transport === 'streamable-http') {
    const bind = get('HTTP_BIND') || '127.0.0.1'
    if (!LOOPBACK_BINDS.includes(bind)) throw new Error(`${PREFIX}HTTP_BIND must be 127.0.0.1 or ::1; public exposure is not supported`)
    const origins = get('HTTP_ALLOWED_ORIGINS').split(/[\s,]+/).filter(Boolean)
    for (const o of origins) if (!LOOPBACK_ORIGIN.test(o)) throw new Error(`${PREFIX}HTTP_ALLOWED_ORIGINS may list loopback origins only`)
    http = Object.freeze({
      bind,
      port: intIn(get('HTTP_PORT'), HTTP_DEFAULTS.port, 65_535, 0),
      path: '/mcp',
      allowed_origins: Object.freeze(origins.map((o) => o.toLowerCase())),
      session_concurrency: intIn(get('HTTP_SESSION_CONCURRENCY'), HTTP_DEFAULTS.session_concurrency, HTTP_CEILINGS.session_concurrency),
      max_sessions: intIn(get('HTTP_MAX_SESSIONS'), HTTP_DEFAULTS.max_sessions, HTTP_CEILINGS.max_sessions),
      session_idle_ms: intIn(get('HTTP_SESSION_IDLE_MS'), HTTP_DEFAULTS.session_idle_ms, HTTP_CEILINGS.session_idle_ms, 1000),
      max_body_bytes: intIn(get('HTTP_MAX_BODY_BYTES'), HTTP_DEFAULTS.max_body_bytes, HTTP_CEILINGS.max_body_bytes, 1024),
    })
  }
  const cfg = {
    transport,
    orgId,
    http,
    worker: (get('WORKER_ID') || `action-mcp:${process.pid}`).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80),
    limits: Object.freeze({ max_concurrency: intIn(get('MAX_CONCURRENCY'), LIMIT_DEFAULTS.max_concurrency, 16), call_timeout_ms: intIn(get('CALL_TIMEOUT_MS'), LIMIT_DEFAULTS.call_timeout_ms, 60_000, 1000) }),
    auditFile: auditFileOf(env),
  }
  const secrets = Object.freeze({ pepper, live, stdioCredential })
  Object.defineProperty(cfg, 'secrets', { value: () => secrets, enumerable: false })
  return Object.freeze(cfg)
}

export const summarize = (cfg) => ({ transport: cfg.transport, org_configured: Boolean(cfg.orgId), http: cfg.http ? { bind: cfg.http.bind, port: cfg.http.port, path: cfg.http.path, allowed_origins: [...cfg.http.allowed_origins], max_sessions: cfg.http.max_sessions, auth: 'per_agent_bearer_credential' } : null, limits: cfg.limits, worker: cfg.worker })

/** A 0600 file helper for tests and scripts (never inside the repository's apps/api). */
export function writeSecretFile(p, value) {
  fs.writeFileSync(p, `${value}\n`, { mode: 0o600 })
  fs.chmodSync(p, 0o600)
  return p
}
