// Composition root: config → audit → data client (lc_action_gateway over PostgREST) → BOOT SELF-CHECK →
// the Action Gateway (store, reads, services) → protocol. Auditing starts before the config is parsed, so a
// refused boot is audited too.
import { loadConfig, scrubEnv, summarize, auditFileOf } from './config.mjs'
import { createAuditor } from '../../leadcommand-mcp/src/audit/audit.mjs'
import { createConcurrencyGate } from '../../leadcommand-mcp/src/safety/limits.mjs'
import { createGatewayClient } from './data/client.mjs'
import { GATEWAY_ROLE } from './data/inventory.mjs'
import { createMcpServer } from './protocol/server.mjs'
import { createActionGateway, createPostgrestActionStore, createGatewayReads, createGatewayServices } from '@/lib/domain/action-gateway/index.js'

const bootError = (code, message) => Object.assign(new Error(message), { code })
const AUDIT_KEYS = ['event_type', 'agent_id', 'action', 'capability', 'tier', 'code', 'correlation_id', 'intent_id', 'transport']

/**
 * @param {{ env?: object, db?: object, gateway?: object, auditSink?: Function, baseFetch?: Function, scrub?: boolean, provider?: object, serviceEnv?: object, skipSelfCheck?: boolean }} [opts]
 *   db: a Supabase-shaped client already running as lc_action_gateway (tests: a disposable PostgreSQL); gateway: a fake (protocol tests)
 */
export async function buildApp(opts = {}) {
  const env = opts.env || process.env
  const auditor = createAuditor({ sink: opts.auditSink || null, file: auditFileOf(env) })
  let cfg
  try {
    cfg = loadConfig(env, { injectedDb: Boolean(opts.db || opts.gateway) })
  } catch (e) {
    auditor.event('server_boot_refused', { stage: 'config', code: String(e?.code || 'CONFIG_INVALID').slice(0, 60), message: String(e?.message || e).slice(0, 300) })
    throw e
  }
  if (opts.scrub !== false && env === process.env) scrubEnv(process.env)
  const s = cfg.secrets()
  let gateway = opts.gateway || null
  if (!gateway) {
    let db = opts.db || null
    if (!db) {
      const c = createGatewayClient({ supabaseUrl: s.live.supabaseUrl, apiKey: s.live.apiKey, gatewayJwt: s.live.gatewayJwt, orgId: cfg.orgId, baseFetch: opts.baseFetch,
        onRefused: (r) => auditor.event('transport_refused', { code: String(r.code || '').slice(0, 40), method: r.method || null, kind: r.kind || null, target: String(r.target || '').slice(0, 64) || null }) })
      db = c.db
      auditor.event('gateway_credential', { role: c.token.role, days_left: c.token.days_left })
    }
    const store = createPostgrestActionStore({ db })
    if (!opts.skipSelfCheck) {
      // the database's own privilege report for the role the token runs as: write only the gateway bookkeeping,
      // definer allowlist, no egress, read inventory. Anything else and the server does not start.
      let self = null
      try { self = await store.selfCheck() } catch (e) { self = { ok: false, findings: [`self_check_unavailable:${String(e?.code || '').slice(0, 20)}`] } }
      auditor.event('credential_self_check', { outcome: self?.ok && self.current_user === GATEWAY_ROLE ? 'ok' : 'refused', running_as: self?.current_user || null, findings: (self?.findings || []).slice(0, 20) })
      if (!self?.ok || self.current_user !== GATEWAY_ROLE) throw bootError('CREDENTIAL_SELF_CHECK_FAILED', `credential self-check refused: ${(self?.findings || []).slice(0, 5).join('; ') || `running as ${self?.current_user}`}`)
    }
    // LeadCommand Workforce on this host (docs/WORKFORCE-AGNTEI.md): born OFF — the Workforce tools answer capability_unavailable
    // (WORKFORCE_DISABLED) until the operator sets LEADCOMMAND_ACTION_MCP_WORKFORCE_ENABLED=true (the Workforce authority engine's own switch)
    const serviceEnv = { ...(String(env.LEADCOMMAND_ACTION_MCP_DRAFT_SHADOW_ENABLED || '').trim() === 'true' ? { AI_CONVERSATION_SHADOW_ENABLED: 'true' } : {}),
      ...(cfg.workforce_enabled ? { WORKFORCE_ENABLED: '1' } : {}), ...(opts.serviceEnv || {}) }
    gateway = createActionGateway({
      store, reads: createGatewayReads({ db }), services: createGatewayServices({ db, store, env: serviceEnv, provider: opts.provider || null }),
      pepper: s.pepper, dataOrgId: cfg.orgId, worker: cfg.worker,
      onAudit: (rec) => auditor.event('action', Object.fromEntries(AUDIT_KEYS.filter((k) => rec[k] != null).map((k) => [k, rec[k]]))),
    })
  }
  const processGate = createConcurrencyGate({ max: cfg.limits.max_concurrency })
  const make = (o = {}) => createMcpServer({ gateway, credentialOf: () => s.stdioCredential, processGate, callTimeoutMs: cfg.limits.call_timeout_ms, ...o })
  const server = cfg.transport === 'stdio' ? make() : null
  auditor.event('server_boot', summarize(cfg))
  let recovery = null
  return {
    cfg, server, gateway, auditor,
    createServer: (o = {}) => make(o),
    /** The recovery sweeper: expired execution leases are re-executed (atomic, idempotent) or recorded outcome_unknown. */
    startRecovery(intervalMs = 30_000) {
      if (recovery || !(intervalMs > 0)) return
      recovery = setInterval(() => { gateway.recover({ limit: 20 }).then((r) => { if (r.scanned) auditor.event('recovery_sweep', { scanned: r.scanned }) }).catch(() => auditor.event('recovery_sweep_failed', {})) }, intervalMs)
      recovery.unref()
    },
    async close() { if (recovery) clearInterval(recovery); await server?.close().catch(() => {}) },
  }
}
