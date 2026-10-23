// Composition root: config → auth → data source → [live: credential self-check] → gateway → protocol.
//
// Auditing starts BEFORE the config is parsed, so a refused boot (bad / retired /
// service-role credential, ambient credentials, failed self-check) is written to
// the audit file too, never only to stderr.
import { loadConfig, scrubEnv, summarize, auditFileOf } from './config.mjs'
import { createAuthorizer, createRpcMembershipStore, createFixtureMembershipStore } from './auth/principal.mjs'
import { createLiveSource, createFixtureSource } from './data/sources.mjs'
import { createAuditor } from './audit/audit.mjs'
import { createGateway } from './gateway.mjs'
import { createMcpServer } from './protocol/server.mjs'
import { TOOLS, assertCatalogReadOnly } from './tools/catalog.mjs'

const bootError = (code, message) => Object.assign(new Error(message), { code })

/** One audit line per credential self-check (boot and re-checks). Names only, never a value. */
function auditSelfCheck(auditor, credential) {
  let lastOk = null
  return (verdict, stage) => {
    // re-checks are audited when the verdict changes; boot and first-call checks always
    if (stage === 'recheck' && lastOk === verdict.ok) return
    lastOk = verdict.ok
    auditor.event('credential_self_check', {
      stage,
      outcome: verdict.ok ? 'ok' : 'refused',
      role: credential?.role ?? null,
      running_as: verdict.info?.running_as ?? null,
      expires_at: credential?.expires_at ?? null,
      findings: (verdict.findings || []).slice(0, 20).map((x) => String(x).slice(0, 200)),
      relations: verdict.info?.relations ?? null,
      functions: verdict.info?.functions ?? null,
      select_outside_inventory: verdict.info?.select_outside_inventory ?? null,
      // the pinned Supabase pg_net platform exception (what was excepted) and the live exposure probe, never dropped
      platform_exceptions: verdict.info?.platform_exceptions ?? null,
      platform_allowlists: verdict.info?.platform_allowlists ?? null,
      exposure_probe: verdict.info?.exposure_probe ?? null,
    })
  }
}

/**
 * @param {{ env?: object, fixture?: object, faults?: object, auditSink?: Function, membershipStore?: object, baseFetch?: Function, scrub?: boolean, now?: () => Date }} [opts]
 */
export async function buildApp(opts = {}) {
  const env = opts.env || process.env
  const auditor = createAuditor({ sink: opts.auditSink || null, file: auditFileOf(env) })
  let cfg
  try {
    cfg = loadConfig(env)
  } catch (e) {
    auditor.event('server_boot_refused', { stage: 'config', code: String(e?.code || 'CONFIG_INVALID').slice(0, 60), message: String(e?.message || e).slice(0, 300) })
    throw e
  }
  if (opts.scrub !== false && env === process.env) scrubEnv(process.env)
  assertCatalogReadOnly(TOOLS)

  let source
  let store = opts.membershipStore || null
  if (cfg.dataMode === 'live') {
    const s = cfg.secrets()
    source = createLiveSource({
      supabaseUrl: s.supabaseUrl, apiKey: s.apiKey, readerJwt: s.readerJwt, baseFetch: opts.baseFetch, onSelfCheck: auditSelfCheck(auditor, cfg.credential),
      // a refused read is audited by its code and the relation / function NAME only (no query, no value)
      onRefused: (r) => auditor.event('transport_refused', { code: String(r.code || '').slice(0, 40), method: r.method || null, kind: r.kind || null, target: String(r.target || '').slice(0, 64) || null }),
    })
    // BOOT SELF-CHECK: the database's privilege report for the role this token runs as.
    // Any write privilege, reachable write / egress function, membership, BYPASSRLS, or
    // missing read → the server does not start (and the refusal is audited above).
    const verdict = await source.selfCheck('boot')
    if (!verdict.ok) throw bootError('CREDENTIAL_SELF_CHECK_FAILED', `credential self-check refused: ${verdict.findings.slice(0, 5).join('; ')}`)
    store = store || createRpcMembershipStore(source)
  } else {
    const fixture = opts.fixture || (await import('../fixtures/dataset.mjs')).FIXTURE
    source = createFixtureSource(fixture, { faults: opts.faults || {} })
    store = store || createFixtureMembershipStore(fixture.membership)
  }
  const authorizer = createAuthorizer({ principal: cfg.principal, dataOrgId: cfg.dataOrgId, scopes: cfg.scopes, store })
  const gateway = createGateway({ tools: TOOLS, authorizer, source, auditor, limits: cfg.limits, ...(opts.now ? { now: opts.now } : {}) })
  const server = cfg.transport === 'stdio' ? createMcpServer({ gateway }) : null
  auditor.event('server_boot', summarize(cfg))
  return {
    cfg, server, gateway, auditor, source, authorizer,
    /** A fresh protocol Server over the shared gateway (one per HTTP session). */
    createServer: (o = {}) => createMcpServer({ gateway, ...o }),
    async close() { await store?.close?.(); await server?.close().catch(() => {}) },
  }
}
