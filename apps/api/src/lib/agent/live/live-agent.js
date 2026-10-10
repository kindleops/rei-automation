// Live (non-fixture) agent wiring for LOCAL DEV (S3). One process-wide
// instance on globalThis (Next dev may evaluate a module once per route
// bundle; the file store also reloads when another instance wrote it).
//
// GATE (feature-flag matrix in tmp/briefs/agent-s3-rc-20261009.md):
//   non-production  AGENT_LIVE_ROUTES=1
//   production      AGENT_LIVE_ROUTES=1 AND AGENT_LIVE_PRODUCTION_PILOT=1 AND
//                   AGENT_STORE=postgres (the durable store) — every one is
//                   off/unset by default, and the Cloudflare Worker forwards
//                   only an explicit env allowlist, so none reaches the
//                   container without a reviewed code change (gate E).
// Plus the Gate B kill switch AGENT_ENABLED (default off in production).
// Otherwise every route answers 404 before auth or any other work.
//
// STORE: AGENT_STORE=postgres → runtime/pg-store.js (PROPOSED S3 schema;
// AGENT_DATABASE_URL or the app's resolveDatabaseUrl()). Otherwise the local
// file store (dev only; refused in production). There is no in-memory
// fallback in a server process.
//
// The live store is a separate namespace ('live') from fixtures; fixture
// events are refused by its event log (allowFixture=false) and by the DB.
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { resolveDatabaseUrl } from '@/lib/postgres/resolve-database-url.js'
import { createPgAgentStore } from '../runtime/pg-store.js'
import { isAgentEnabled, isProductionRuntime } from '../config/agent-config.js'
import { createFileAgentStore } from '../runtime/file-store.js'
import { createRunService } from '../runtime/run-service.js'
import { createEventLog } from '../runtime/event-log.js'
import { createResearchJobService } from '../research/research-jobs.js'
import { DEFAULT_BUDGET_CONFIG } from '../budget/budget-config.js'
import { createQuickScanToolRegistry } from '../quick-scan/tools.js'
import { createQuickScanServices } from '../quick-scan/services.js'
import { createQuickScanReadClient } from '../quick-scan/read-client.js'
import { createQuickScanService } from '../quick-scan/quick-scan-service.js'

export const LIVE_ROUTES_FLAG = 'AGENT_LIVE_ROUTES'

export const PRODUCTION_PILOT_FLAG = 'AGENT_LIVE_PRODUCTION_PILOT'

const flag = (env, name) => String(env?.[name] ?? '').trim()

export function liveStoreKind(env = process.env) {
  return flag(env, 'AGENT_STORE') === 'postgres' ? 'postgres' : 'file'
}

export function isLiveAgentEnabled(env = process.env) {
  if (!isAgentEnabled(env)) return false // AGENT_ENABLED kill switch (Gate B): default OFF in production
  if (flag(env, LIVE_ROUTES_FLAG) !== '1') return false
  if (!isProductionRuntime(env)) return true
  // production: a separately approved pilot on the durable store only
  return flag(env, PRODUCTION_PILOT_FLAG) === '1' && liveStoreKind(env) === 'postgres'
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * pg Pool config for the agent store (security review M3). Pure: exported for tests.
 *   production: AGENT_DATABASE_URL is REQUIRED (no fallback to the app's
 *     full-privilege DATABASE_URL); the role must not be postgres / postgres.<ref>;
 *     TLS verifies the server certificate against the Supabase CA
 *     (AGENT_DATABASE_CA_PEM, or AGENT_DATABASE_CA_FILE); loopback hosts refused.
 *   non-production: AGENT_DATABASE_URL, else the app URL; TLS is off only when
 *     the PARSED hostname is loopback; otherwise verified (CA if given, else system CAs).
 * ssl* query parameters are stripped so the URL can never downgrade verification.
 */
export function agentPgPoolConfig(env = process.env, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const prod = isProductionRuntime(env)
  const explicit = flag(env, 'AGENT_DATABASE_URL')
  if (prod && !explicit) throw new Error('AGENT_DATABASE_URL_REQUIRED')
  const raw = explicit || resolveDatabaseUrl()
  if (!raw) throw new Error('agent_database_url_missing')
  let u
  try { u = new URL(raw) } catch { throw new Error('AGENT_DATABASE_URL_INVALID') }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('AGENT_DATABASE_URL_INVALID')
  // host / hostaddr query params override the URL host in libpq-style parsers: refuse outright
  for (const k of u.searchParams.keys()) if (/^(host|hostaddr)$/i.test(k)) throw new Error('AGENT_DATABASE_URL_HOST_OVERRIDE')
  for (const k of [...u.searchParams.keys()]) if (/^ssl/i.test(k)) u.searchParams.delete(k)
  const host = u.hostname.toLowerCase()
  const user = decodeURIComponent(u.username || '')
  const loopback = LOOPBACK.has(host)
  if (prod) {
    if (loopback) throw new Error('AGENT_DATABASE_HOST_LOOPBACK_IN_PRODUCTION')
    if (!user || /^postgres(\.|$)/i.test(user) || /^(supabase_admin|service_role|authenticator)(\.|$)/i.test(user)) throw new Error('AGENT_DATABASE_ROLE_NOT_LEAST_PRIVILEGE')
  }
  const caPem = flag(env, 'AGENT_DATABASE_CA_PEM') || (flag(env, 'AGENT_DATABASE_CA_FILE') ? readFile(flag(env, 'AGENT_DATABASE_CA_FILE')) : '')
  if (prod && !caPem) throw new Error('AGENT_DATABASE_CA_REQUIRED')
  const ssl = loopback && !prod ? false : { rejectUnauthorized: true, servername: host, ...(caPem ? { ca: caPem } : {}) }
  return { connectionString: u.toString(), ssl, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: 'lc-agent-s3' }
}

function createAgentPgPool(env) {
  const pool = new pg.Pool(agentPgPoolConfig(env))
  pool.on('error', () => {}) // a dropped idle client is replaced on next checkout
  return pool
}

export function defaultStoreDir(env = process.env) {
  return String(env?.AGENT_DEV_STORE_DIR || '').trim() || path.resolve(process.cwd(), '.agent-dev-store')
}

/**
 * Build a live agent (exported for tests: inject store / services / env).
 */
export function createLiveAgent({ env = process.env, store = null, createServices = null, leaseTtlMs = 15_000, slotPollMs = 500, budgetConfig = DEFAULT_BUDGET_CONFIG, now, requireVerifiedOperator = false } = {}) {
  const s = store || createFileAgentStore({ dir: defaultStoreDir(env), namespace: 'live', env })
  // requireVerifiedOperator: the server path (getLiveAgent) sets it — no run without a verified named user
  const runService = createRunService({ store: s, budgetConfig, requireVerifiedOperator, ...(now ? { now } : {}) })
  const researchJobs = createResearchJobService({ store: s, runService, config: budgetConfig, ...(now ? { now } : {}) })
  const registry = createQuickScanToolRegistry({ readOnly: true }) // the S3 review-only path: small T0 reads only, whatever AGENT_READ_ONLY says
  const eventLog = createEventLog({ store: s, allowFixture: false, ...(now ? { now } : {}) })
  const requestLog = []
  const makeServices = createServices || (() => {
    const { client, requests } = createQuickScanReadClient({ env, onRequest: (r) => requestLog.push(r) })
    void requests
    return createQuickScanServices({ db: client })
  })
  const quickScan = createQuickScanService({ store: s, runService, researchJobs, registry, createServices: makeServices, env, leaseTtlMs, slotPollMs, config: budgetConfig, eventLog, ...(now ? { now } : {}) })
  return { store: s, runService, researchJobs, registry, eventLog, quickScan, requestLog }
}

const KEY = Symbol.for('lc.agent.live.s3')

/** Process-wide live agent (recovers interrupted scans on first use). */
export function getLiveAgent({ env = process.env } = {}) {
  if (!isLiveAgentEnabled(env)) return null
  if (!globalThis[KEY]) {
    const store = liveStoreKind(env) === 'postgres' ? createPgAgentStore({ pool: createAgentPgPool(env) }) : null
    const agent = createLiveAgent({ env, store, requireVerifiedOperator: true })
    // durable store: open (load the working set) before recovering interrupted scans
    agent.recovered = Promise.resolve(store ? store.open() : null)
      .then(() => agent.quickScan.recover())
      .catch((e) => {
        agent.unavailable = e?.code || e?.message || 'AGENT_STORE_UNAVAILABLE'
        return { error: agent.unavailable }
      })
    globalThis[KEY] = agent
  }
  return globalThis[KEY]
}

/** Test hook. */
export function __resetLiveAgent() {
  delete globalThis[KEY]
}
