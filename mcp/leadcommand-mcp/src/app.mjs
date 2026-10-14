// Composition root: config → auth → data source → gateway → protocol.
import { loadConfig, scrubEnv, summarize } from './config.mjs'
import { createAuthorizer, createPgMembershipStore, createFixtureMembershipStore } from './auth/principal.mjs'
import { createLiveSource, createFixtureSource } from './data/sources.mjs'
import { createAuditor } from './audit/audit.mjs'
import { createGateway } from './gateway.mjs'
import { createMcpServer } from './protocol/server.mjs'
import { TOOLS, assertCatalogReadOnly } from './tools/catalog.mjs'

/**
 * @param {{ env?: object, fixture?: object, faults?: object, auditSink?: Function, membershipStore?: object, baseFetch?: Function, scrub?: boolean, now?: () => Date }} [opts]
 */
export async function buildApp(opts = {}) {
  const env = opts.env || process.env
  const cfg = loadConfig(env)
  if (opts.scrub !== false && env === process.env) scrubEnv(process.env)
  assertCatalogReadOnly(TOOLS)
  const auditor = createAuditor({ sink: opts.auditSink || null, file: cfg.auditFile })

  let source
  let store = opts.membershipStore || null
  if (cfg.dataMode === 'live') {
    const s = cfg.secrets()
    source = createLiveSource({ supabaseUrl: s.supabaseUrl, serviceKey: s.serviceKey, baseFetch: opts.baseFetch })
    store = store || createPgMembershipStore({ url: s.agentDbUrl, ca: s.agentDbCa })
  } else {
    const fixture = opts.fixture || (await import('../fixtures/dataset.mjs')).FIXTURE
    source = createFixtureSource(fixture, { faults: opts.faults || {} })
    store = store || createFixtureMembershipStore(fixture.membership)
  }
  const authorizer = createAuthorizer({ principal: cfg.principal, dataOrgId: cfg.dataOrgId, scopes: cfg.scopes, store })
  const gateway = createGateway({ tools: TOOLS, authorizer, source, auditor, limits: cfg.limits, ...(opts.now ? { now: opts.now } : {}) })
  const server = createMcpServer({ gateway })
  auditor.event('server_boot', summarize(cfg))
  return {
    cfg, server, gateway, auditor, source, authorizer,
    async close() { await store?.close?.(); await server.close().catch(() => {}) },
  }
}
