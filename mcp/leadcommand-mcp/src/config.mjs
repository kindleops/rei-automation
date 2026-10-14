// Configuration. Read ONCE from the trusted host environment (the MCP client's
// server launch config), validated, then credentials are moved into closures
// and the process environment is scrubbed, so no module loaded later (a
// transitively imported default Supabase client, a logger, a crash reporter)
// can find a key or a database URL in process.env.
//
// The principal comes from here — never from a tool argument.
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
  if (transport !== 'stdio') throw new Error(`LEADCOMMAND_MCP_TRANSPORT=${transport} is not enabled in 1.0 (stdio only; Streamable HTTP is designed but disabled)`)
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
  const cfg = {
    transport,
    dataMode,
    principal: principal ? Object.freeze({ user_id: principal, org_id: orgId, method: 'host_config' }) : null,
    dataOrgId,
    scopes: Object.freeze(parseScopes(env.LEADCOMMAND_MCP_SCOPES)),
    limits: Object.freeze({
      rate_per_min: intIn(env.LEADCOMMAND_MCP_RATE_PER_MIN, DEFAULTS.rate_per_min, CEILINGS.rate_per_min),
      max_concurrency: intIn(env.LEADCOMMAND_MCP_MAX_CONCURRENCY, DEFAULTS.max_concurrency, CEILINGS.max_concurrency),
      call_timeout_ms: intIn(env.LEADCOMMAND_MCP_CALL_TIMEOUT_MS, DEFAULTS.call_timeout_ms, CEILINGS.call_timeout_ms, 100),
      max_response_bytes: intIn(env.LEADCOMMAND_MCP_MAX_RESPONSE_BYTES, DEFAULTS.max_response_bytes, CEILINGS.max_response_bytes, 1024),
    }),
    auditFile: String(env.LEADCOMMAND_MCP_AUDIT_FILE || '').trim() || null,
  }
  Object.defineProperty(cfg, 'secrets', { value: secrets, enumerable: false })
  return Object.freeze(cfg)
}

export const summarize = (cfg) => ({ transport: cfg.transport, dataMode: cfg.dataMode, principal_configured: Boolean(cfg.principal), scopes: [...cfg.scopes], limits: cfg.limits })
