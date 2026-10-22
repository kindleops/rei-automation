#!/usr/bin/env node
// LeadCommand Workforce × Agntei — the LIVE milestone (owner-approved 2026-10-22): a REAL, authenticated Claude Code agent
// (the installed `claude` CLI, the owner's claude.ai login bound to the Agntei test agent's legacy profile through Agntei's
// supported AGNTEI_ISOLATED_ALLOW_SHARED_LOGINS=1 opt-in) runs a real internal Workforce research mission end to end on a
// LOCAL, DISPOSABLE stack. Everything else is the scripted milestone's real stack (docs/WORKFORCE-AGNTEI.md §6):
//   PostgreSQL 17 (own cluster) → the REAL schema chain (+ lc_mcp_reader on the same DB) → PostgREST → the REAL Action MCP
//   (+ the READ-ONLY LeadCommand MCP as lc_mcp_reader) → Agntei headless (its claude-code chat path: per-turn MCP bridge,
//   ChatTools policy, Connections, its MCP client) → the REAL claude binary (a transparent recorder in front of it).
//
//   cd apps/api && node --import ./scripts/workforce/e2e-agntei/register.mjs scripts/workforce/e2e-agntei-live.mjs \
//     --agntei-dir=… --agntei-node=… --pg-bin=… --postgrest-bin=… --claude-bin=/Users/…/claude --out=<dir> [--model=claude-sonnet-5]
//
// SYNTHETIC: the test market "Dallas (TEST)" and every opportunity in it. Refuses any non-loopback target. No production,
// no Supabase MCP, no seller, no send. T2–T4 stay off (action_gateway_tiers = T1).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as S from './e2e-agntei/stack.mjs'
import { buildWorld } from './e2e-agntei/world.mjs'
import { MARKET, MARKET_SLUG, liveBook, liveServices, liveResearchSource, seedConversationRows, readerRows } from './e2e-agntei-live/book.mjs'
import { applyReader, seedReader, startReaderMcp } from './e2e-agntei-live/readonly.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const API_DIR = path.resolve(here, '../..')
const REPO = path.resolve(API_DIR, '../..')
export const DIRECTIVE = 'Research the ten most promising acquisition opportunities available in your assigned test market. Review their property information, conversation context, and available underwriting evidence. Identify the strongest opportunities, record your findings, and report your recommendations to the COO.'
const INTERNAL_DIRECTIVE = 'Find the 3 most promising opportunities in Dallas and get them moving'
const ORG = '00000000-0000-4000-8000-00000000a001'
const CEO_USER = '0e2e0000-0000-4000-8000-00000000ce01'
const ENV = Object.freeze({ AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' })
const EMP = 'emp_scout_agntei'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q1 = async (pool, sql, params = []) => (await pool.query(sql, params)).rows[0] || null
const qa = async (pool, sql, params = []) => (await pool.query(sql, params)).rows
const iso = () => new Date().toISOString()

// what the agent may use, preapproved in Agntei for that one agent on that one connection (never a privileged tool)
const WF_ALLOW = ['leadcommand_workforce_whoami', 'leadcommand_workforce_list_assignments', 'leadcommand_workforce_get_mission', 'read_conversation_context',
  'leadcommand_workforce_claim_assignment', 'leadcommand_workforce_report_progress', 'leadcommand_workforce_request_research', 'leadcommand_workforce_complete_assignment',
  'leadcommand_workforce_handoff', 'leadcommand_workforce_escalate']
const AGENT_INSTRUCTIONS = [
  'You are Scout, an acquisitions analyst who works as a LeadCommand Workforce employee (operator-directed AI) for the test market Dallas (TEST).',
  'Every property, seller and conversation in that market is SYNTHETIC test data: what you recommend is not a real lead.',
  'You act only through the LeadCommand tools in your conversation: the LeadCommand Workforce tools (your assignment, progress, research requests, completion, handoff, escalation) and the read-only LeadCommand tools (property facts, acquisition scores and valuations, comps, market data).',
  'You never contact a seller, make or send an offer, or change a pipeline stage; nothing you have can do that.',
  'Base every finding on records you read through those tools and cite them with the ids LeadCommand gave you. Say plainly what you could not read or verify.',
].join(' ')

function agnteiApi(base, token) {
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'x-agentcmd-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { status: r.status, data }
  }
  const must = async (method, p, body) => { const r = await call(method, p, body); if (r.status >= 400) throw new Error(`Agntei ${method} ${p} → ${r.status}: ${JSON.stringify(r.data).slice(0, 600)}`); return r.data }
  return { call, get: (p) => must('GET', p), post: (p, b = {}) => must('POST', p, b), put: (p, b = {}) => must('PUT', p, b), del: (p) => must('DELETE', p) }
}
function runNode(node, args, { cwd, env = {} }) {
  const r = spawnSync(node, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } })
  if (r.status !== 0) throw new Error(`${args.join(' ')} → ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 600)}`)
  return r.stdout
}
/** Agntei's own SQLite (read-only queries of its records: chat tool calls, connection calls, runs). */
const sqlite = (db, sql) => { const r = spawnSync('/usr/bin/sqlite3', ['-json', '-readonly', db, sql], { encoding: 'utf8' }); if (r.status !== 0) return []; try { return JSON.parse(r.stdout || '[]') } catch { return [] } }
/** The official MCP SDK client (the Action MCP's own dependency), as a separate client of the same credential would use it. */
async function sdkClient(url, token) {
  const base = path.join(REPO, 'mcp/leadcommand-action-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client')
  const { Client } = await import(pathToFileURL(path.join(base, 'index.js')).href)
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(base, 'streamableHttp.js')).href)
  const c = new Client({ name: 'live-e2e-direct-client', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return {
    async call(name, args = {}) {
      const r = await c.callTool({ name, arguments: args }).catch((e) => ({ isError: true, structuredContent: { status: 'error', error: { code: 'TRANSPORT', message: String(e?.message).slice(0, 200) } } }))
      const s = r.structuredContent || {}
      return { isError: Boolean(r.isError), code: s.code ?? s.error?.code ?? null, status: s.status ?? null, intent_id: s.intent_id ?? null, replayed: s.replayed ?? s.idempotent_replay ?? null, result: s.result ?? null, raw: s }
    },
    close: () => c.close().catch(() => {}),
  }
}

export async function runLive(o) {
  const t0 = Date.now()
  const runDir = o.runDir
  const logs = path.join(runDir, 'logs'); const secrets = path.join(runDir, 'secrets'); const recDir = path.join(runDir, 'claude-recorder')
  for (const d of [runDir, logs, secrets, recDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  const out = { started_at: iso(), ids: {}, phases: [], checks: [], recovery: {}, security: {}, records: {}, screens: [], failures: [] }
  const phase = async (id, title, fn, { soft = false } = {}) => {
    const s = Date.now(); const rec = { id, title, ok: false, ms: 0, evidence: null, error: null }
    out.phases.push(rec)
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${id} ${title}`)
    try { rec.evidence = await fn(); rec.ok = true } catch (e) { rec.error = String(e?.stack || e).slice(0, 3000); console.log(`   ✖ ${String(e?.message || e).slice(0, 400)}`); out.failures.push({ phase: id, error: String(e?.message || e).slice(0, 600) }); if (!soft) throw e } finally { rec.ms = Date.now() - s }
    return rec.evidence
  }
  const check = (id, name, ok, detail = '') => { out.checks.push({ id, name, ok: Boolean(ok), detail: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 1500) }); console.log(`   ${ok ? '✔' : '✖'} ${id} ${name}`); return Boolean(ok) }
  let world = null; let ticker = null; let A = null; let agHome = null; let agToken = null
  const secretValues = {}
  try {
    // ── 1. database (+ lc_mcp_reader on the same DB), PostgREST ───────────────────────────────────────────
    const pgc = await phase('1a', 'PostgreSQL 17 cluster (own data dir, free loopback port)', async () => {
      const c = await S.startPg({ bin: o.pgBin, dir: path.join(runDir, 'pg'), log: path.join(logs, 'postgres.log') })
      return { port: c.port, version: execFileSync(path.join(o.pgBin, 'postgres'), ['--version'], { encoding: 'utf8' }).trim(), admin_url: c.adminUrl }
    })
    world = await phase('1b', 'The REAL schema chain (scripted milestone\'s) on one disposable database', async () => buildWorld({ adminUrl: pgc.admin_url, ownerUserId: CEO_USER, orgId: ORG }))
    out.phases.at(-1).evidence = { database: world.name, files: world.applied.length }
    const owner = world.owner; const api = world.api
    const reader = await phase('1c', 'The read-only LeadCommand MCP role on the SAME database: chain baseline → widening → PROPOSED_20261019150000_lc_mcp_reader (its self-check)', async () => applyReader({ world, repo: REPO }), { soft: true })
    out.reader = reader ?? { error: out.failures.at(-1)?.error }
    const jwtSecret = crypto.randomBytes(32).toString('hex')
    const jwtSecretFile = S.writeSecret(path.join(secrets, 'jwt-secret'), jwtSecret)
    secretValues.jwt_secret = jwtSecret
    const rest = await phase('1d', 'PostgREST (the real binary) + the /rest/v1 path shim', async () => {
      const p = await S.startPostgrest({ bin: o.postgrestBin, dbUrl: `postgres://authenticator@127.0.0.1:${pgc.port}/${world.name}`, jwtSecret, dir: runDir, log: path.join(logs, 'postgrest.log') })
      const shim = await S.startRestShim({ upstream: p.url })
      return { postgrest: p.url, shim: shim.url, version: execFileSync(o.postgrestBin, ['--version'], { encoding: 'utf8' }).trim() }
    })

    // ── 2. SYNTHETIC data ─────────────────────────────────────────────────────────────────────────────────
    const now0 = Date.now()
    const book = liveBook(now0)
    const seeded = await phase('2', 'SYNTHETIC test market Dallas (TEST): 24 live opportunities + 3 exclusions — property facts, conversations, underwriting (scores / valuation lane / MAO), comps', async () => {
      await seedConversationRows(owner, book)
      const r = reader ? await seedReader(owner, readerRows(book, now0)).catch((e) => ({ error: String(e?.message || e).slice(0, 300) })) : { skipped: 'reader role not applied' }
      return { opportunities: book.length, live: book.filter((x) => x.kind === 'live').length, excluded: book.filter((x) => x.kind !== 'live').map((x) => `${x.property_id}: ${x.kind}`), messages: (await q1(owner, 'select count(*)::int n from public.message_events')).n, reader_rows: r }
    })
    await owner.query(`update agent.runtime_limits set runtime_enabled = true, emergency_stop = false, emergency_stop_at = null, emergency_stop_reason = null, max_concurrency_global = 4, tick_max_jobs = 4,
        lease_seconds = 15, backoff_base_seconds = 5, kind_limits = $1::jsonb where id = 1`,
    [JSON.stringify(Object.fromEntries(Object.entries({ 'workforce.coo_plan': 1, 'workforce.dispatch': 1, 'workforce.mission_review': 1, 'property.research': 2 }).map(([k, n]) => [k, { enabled: true, max_concurrency: n, armed_by: CEO_USER }])))])
    await owner.query(`insert into public.system_control (key, value) values ('action_gateway_enabled', 'true'), ('action_gateway_tiers', 'T1') on conflict (key) do update set value = excluded.value`)
    out.armed = { controls: await qa(owner, "select key, value from public.system_control where key like 'action_gateway%' order by key"), kinds: Object.keys((await q1(owner, 'select kind_limits from agent.runtime_limits where id = 1')).kind_limits) }

    // ── LeadCommand in this process: the REAL store / runtime / route handlers / engine handlers ──────────
    const { createWorkforcePgStore } = await import('../../src/lib/workforce/store/index.js')
    const { createRuntimePgStore } = await import('../../src/lib/agent/runtime/job-runtime.js')
    const { runRuntimeTick } = await import('../../src/lib/agent/runtime/runtime-tick.js')
    const { createMissionPgReads } = await import('../../src/lib/agent/missions/mission-reads.js')
    const { createUserRateLimiter, resolveRateLimits } = await import('../../src/lib/agent/security/rate-limit.js')
    const { buildWorkforceHandlers } = await import('../../src/lib/workforce/engine/handlers.js')
    const { enqueueWorkforceJob } = await import('../../src/lib/workforce/engine/dispatch.js')
    const { createPropertyResearchHandler } = await import('../../src/lib/agent/missions/property-research-handler.js')
    const routes = await import('../../src/lib/workforce/routes.js')
    const { DISPATCH_KIND } = await import('../../src/lib/workforce/config.js')
    const wf = createWorkforcePgStore({ pool: api }); const rt = createRuntimePgStore({ pool: api }); const reads = createMissionPgReads({ pool: api })
    await rt.assertLeastPrivilege()
    const svc = { store: wf, runtimeStore: rt, reads, membership: (org, user) => reads.membership(org, user) }
    const routeOpts = { env: ENV, auth: () => ({ ok: true }), identity: { authenticate: async () => ({ ok: true, identity: { user_id: CEO_USER, verified: true, named: true } }) }, limiter: createUserRateLimiter({ limits: resolveRateLimits({}) }), getServices: async () => svc }
    out.recorded = {}
    const lcRoute = async (method, p, handler, body) => {
      const req = new Request(`http://workforce-live.local/api/cockpit/workforce${p}`, method === 'GET' ? {} : { method, body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } })
      const res = await handler(req); const data = await res.json().catch(() => null)
      if (method === 'GET') out.recorded[p] = { status: res.status, body: data, at: iso() }
      return { status: res.status, data }
    }
    const lcGet = {
      overview: () => lcRoute('GET', '/overview', (r) => routes.handleOverview(r, routeOpts)), command: () => lcRoute('GET', '/command', (r) => routes.handleCommandList(r, routeOpts)),
      missions: () => lcRoute('GET', '/missions', (r) => routes.handleMissionsList(r, routeOpts)), mission: (id) => lcRoute('GET', `/missions/${id}`, (r) => routes.handleMissionGet(r, id, routeOpts)),
      employees: () => lcRoute('GET', '/employees', (r) => routes.handleEmployeesList(r, routeOpts)), employee: (id) => lcRoute('GET', `/employees/${id}`, (r) => routes.handleEmployeeGet(r, id, routeOpts)),
      assignments: () => lcRoute('GET', '/assignments', (r) => routes.handleAssignments(r, routeOpts)), events: () => lcRoute('GET', '/events', (r) => routes.handleEvents(r, routeOpts)),
      authority: () => lcRoute('GET', '/authority', (r) => routes.handleAuthorityGet(r, routeOpts)), kpis: () => lcRoute('GET', '/kpis', (r) => routes.handleKpis(r, routeOpts)), reports: () => lcRoute('GET', '/reports', (r) => routes.handleReports(r, routeOpts)),
    }
    const { services, calls: serviceCalls } = liveServices(book, { now: now0 })
    const research = createPropertyResearchHandler({ source: liveResearchSource(book), reads, buildAsk: null, env: {}, now: () => Date.now() })
    const handlers = { ...buildWorkforceHandlers({ store: wf, runtimeStore: rt, reads, services, env: ENV, now: () => Date.now(), org_id: ORG }), 'property.research': research }
    ticker = (() => {
      let stop = false; let ticks = 0; let nudges = 0; let lastNudge = 0; let running = null; const log = []
      const loop = async () => {
        while (!stop) {
          try {
            const t = await runRuntimeTick({ store: rt, handlers, workerId: 'live-runtime-tick', budgetMs: 25_000, now: () => Date.now() })
            ticks += 1
            if (t.claimed || t.reaped || t.errors?.length) log.push({ at: iso(), claimed: t.claimed, reaped: t.reaped, jobs: t.jobs.map((j) => `${j.kind}:${j.outcome}`), errors: t.errors })
            if (!t.claimed) {
              if (Date.now() - lastNudge > 3000) { await enqueueWorkforceJob(rt, { kind: DISPATCH_KIND, key: ['live-nudge', ++nudges], input: { reason: 'live_nudge' }, requested_by: CEO_USER }).catch(() => {}); lastNudge = Date.now() }
              await sleep(1000)
            }
          } catch (e) { log.push({ at: iso(), error: String(e?.message || e).slice(0, 200) }); await sleep(1500) }
        }
      }
      return { start() { if (!running) { stop = false; running = loop() } }, async stop() { stop = true; await running; running = null }, stats: () => ({ ticks, nudges }), log }
    })()

    // ── 3. employee: register (CEO) → owner mint / principal / grants / bind ──────────────────────────────
    const reg = await phase('3a', 'CEO registers an ACQUISITION-type Agntei employee for the test market: POST /employees {op: register_agntei}', async () => {
      const r = await lcRoute('POST', '/employees', (req) => routes.handleEmployeeUpsert(req, routeOpts), { op: 'register_agntei', employee: { employee_id: EMP, role_key: 'acquisition_agent', display_name: 'Scout', markets: [MARKET], manager_employee_id: 'emp_head_acquisitions', employee_code: 'ACQ-01' } })
      if (r.status !== 201) throw new Error(`register_agntei → ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
      const e = r.data.data.employee
      return { employee: { id: e.employee_id, role: e.role_key, department: e.department_key, markets: e.markets, status: e.status, origin: e.origin, employment_type: e.employment_type }, executed: r.data.data.executed, agent_id: r.data.data.link.agent_id, link: r.data.data.link }
    })
    const AGENT_ID = reg.agent_id
    out.ids.employee = EMP; out.ids.principal = AGENT_ID
    const mcpDir = path.join(REPO, 'mcp/leadcommand-action-mcp')
    const pepper = crypto.randomBytes(32).toString('hex'); secretValues.pepper = pepper
    const pepperFile = S.writeSecret(path.join(secrets, 'action-pepper'), pepper)
    const anonKey = S.hs256(jwtSecret, { role: 'anon', iss: 'supabase', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 86_400 })
    const anonKeyFile = S.writeSecret(path.join(secrets, 'anon-key'), anonKey)
    const gwJwtFile = path.join(secrets, 'lc_action_gateway.jwt')
    const bound = await phase('3b', 'Owner: mint (real scripts) → principal + the registration\'s grants (workforce.* T1) + conversation.read_context → employee_bind_principal', async () => {
      const g = JSON.parse(runNode(o.lcNode, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/mint-gateway-token.mjs', '--secret-file', jwtSecretFile, '--org', ORG, '--out', gwJwtFile, '--days', '7'], { cwd: mcpDir }).trim())
      const credFile = path.join(secrets, `${AGENT_ID}.credential`)
      const stdout = runNode(o.lcNode, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './src/loader/register.mjs', 'scripts/mint-agent-credential.mjs', '--pepper-file', pepperFile, '--agent-id', AGENT_ID, '--out', credFile], { cwd: mcpDir })
      const digest = JSON.parse(stdout.split('\n')[0]).credential_digest
      const steps = Object.fromEntries(reg.link.steps.map((s) => [s.id, s]))
      await owner.query(steps.principal.command.replace('<DIGEST FROM STEP 1>', digest))
      await owner.query(steps.grants.command)
      await owner.query(`update action_gateway.agent_principals set read_scopes = array['conversation_context.read'] where agent_id = $1`, [AGENT_ID])
      await owner.query(`insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, granted_by, expires_at)
                         values ($1, $2, 'conversation.read_context', 1, '{}', '{}', 120, 2000, 0, $3, now() + interval '30 days')`, [ORG, AGENT_ID, CEO_USER])
      const b = await q1(owner, `select workforce.employee_bind_principal($1, $2, $3, $4, interval '4 hours', now() + interval '3 days') r`, [ORG, EMP, AGENT_ID, CEO_USER])
      const grants = await qa(owner, 'select capability, max_tier, expires_at from action_gateway.capability_grants where agent_id = $1 order by capability', [AGENT_ID])
      return { gateway_token: { role: g.role, org: g.org, expires_at: g.expires_at }, credential: { digest_prefix: digest.slice(0, 12), file_mode: (fs.statSync(credFile).mode & 0o777).toString(8) }, grants: grants.map((x) => `${x.capability} (T${x.max_tier})`), bind: { status: b.r.status, binding_valid_until: b.r.binding_valid_until, link_expires_at: b.r.link_expires_at }, credFile }
    })
    const credential = fs.readFileSync(bound.credFile, 'utf8').trim()
    secretValues.agent_credential = credential
    secretValues.gateway_jwt = fs.readFileSync(gwJwtFile, 'utf8').trim()
    secretValues.anon_key = anonKey

    // ── 4. the Action MCP + the read-only MCP ─────────────────────────────────────────────────────────────
    const auditFile = path.join(logs, 'action-mcp-audit.jsonl')
    const mcp = await phase('4a', 'Action MCP (bin/leadcommand-action-mcp.mjs), streamable-http on 127.0.0.1, Workforce on', async () => {
      const m = await S.startActionMcp({ repo: REPO, node: o.lcNode, orgId: ORG, dir: runDir, log: path.join(logs, 'action-mcp.log'), auditFile, files: { supabaseUrl: rest.shim, apiKey: anonKeyFile, gatewayJwt: gwJwtFile, pepper: pepperFile } })
      const audit = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      return { url: m.url, self_check: audit.find((a) => a.event === 'credential_self_check')?.outcome ?? null, running_as: audit.find((a) => a.event === 'credential_self_check')?.running_as ?? null }
    })
    let ro = null
    let roBearer = null
    if (reader && !reader.error) {
      ro = await phase('4b', 'The READ-ONLY LeadCommand MCP (bin/leadcommand-mcp.mjs), live data mode as lc_mcp_reader, streamable-http on 127.0.0.1', async () => {
        const { DEFAULT_SCOPES } = await import(pathToFileURL(path.join(REPO, 'mcp/leadcommand-mcp/src/authz/scopes.mjs')).href)
        const r = await startReaderMcp({ repo: REPO, node: o.lcNode, dir: runDir, log: path.join(logs, 'readonly-mcp.log'), auditFile: path.join(logs, 'readonly-mcp-audit.jsonl'), shimUrl: rest.shim, jwtSecret, anonKeyFile, principal: CEO_USER, orgId: ORG, scopes: DEFAULT_SCOPES.join(' ') })
        secretValues.readonly_bearer = r.bearer; secretValues.reader_jwt = r.readerToken; roBearer = r.bearer
        return { url: r.url, scopes: DEFAULT_SCOPES }
      }, { soft: true })
    }

    // ── 5. Agntei headless, the REAL claude behind a transparent recorder ─────────────────────────────────
    const claudeBin = path.join(runDir, 'claude')
    fs.writeFileSync(claudeBin, `#!/bin/sh\n# the REAL Claude Code CLI (${o.claudeBin}) behind a transparent recorder (same args, env, stdin, stdout, exit)\nexec "${o.agnteiNode}" "${path.join(here, 'e2e-agntei-live/claude-recorder.mjs')}" --state "${recDir}" --real "${o.claudeBin}" -- "$@"\n`, { mode: 0o700 })
    agHome = path.join(runDir, 'agntei-home')
    agToken = crypto.randomBytes(24).toString('base64url')
    const agEnv = { AGNTEI_ISOLATED_ALLOW_SHARED_LOGINS: '1' }
    const startAg = async () => S.startAgntei({ agnteiDir: o.agnteiDir, node: o.agnteiNode, home: agHome, token: agToken, claudeBin, log: path.join(logs, 'agntei.log'), extraEnv: agEnv })
    let agProc = null
    const ag = await phase('5a', 'Agntei server headless (temp data dir, isolated mode + AGNTEI_ISOLATED_ALLOW_SHARED_LOGINS=1, the real claude)', async () => { const s = await startAg(); agProc = s.rec; return { url: s.url, home: agHome, isolated: true, shared_logins: 'allowed (explicit)' } })
    let agUrl = ag.url
    A = agnteiApi(agUrl, agToken)
    const setup = await phase('5b', 'Agntei API: the LEGACY Claude Code profile (the default ~/.claude login) → verify → agent Scout (claude-sonnet-5) → project → connections → one-agent grants → preapprovals', async () => {
      // local only: the operator's web-search switch OFF, so the conversation is offered no WebSearch (Claude's own) and no web tools
      await A.put('/api/settings', { policy: { webSearch: false } })
      const prof = await A.post('/api/profiles', { provider: 'claude-code', label: 'Owner Claude Code login (default ~/.claude, live E2E)', billingMode: 'subscription', kind: 'legacy' })
      const v = await A.post(`/api/profiles/${prof.id}/verify`, {})
      const agent = await A.post('/api/agents', { name: 'Scout', role: 'researcher', accountId: prof.id, model: o.model, purpose: 'LeadCommand Workforce acquisitions analyst (Dallas (TEST), SYNTHETIC)', instructions: AGENT_INSTRUCTIONS, allowedRepos: [] })
      const project = await A.post('/api/projects', { name: 'Reivesti Acquisitions (live E2E, SYNTHETIC)', description: 'LeadCommand Workforce live milestone', ownerKind: 'organization' })
      const conn = await A.post('/api/connections', { catalogId: 'leadcommand-workforce', url: mcp.url, token: credential })
      await A.put(`/api/connections/${conn.id}/access`, { scope: 'agent', scopeId: agent.id, maxTier: 'write' })
      await A.put(`/api/connections/${conn.id}/access`, { scope: 'project', scopeId: project.id, maxTier: 'write' })
      const view = (await A.get('/api/connections')).connections.find((c) => c.id === conn.id)
      const allowed = []; const denied = []
      for (const t of view.tools.map((x) => x.name)) {
        const allow = WF_ALLOW.includes(t)
        await A.post(`/api/connections/${conn.id}/policies`, { tool: t, decision: allow ? 'allow' : 'deny', agent: 'chat', note: allow ? 'live E2E: preapproved for Scout (owner-approved standing authorization, T1 / reads)' : 'live E2E: not part of the standing authorization' })
        ;(allow ? allowed : denied).push(t)
      }
      let roConn = null
      if (ro && !ro.error) {
        const rc = await A.post('/api/connections', { url: ro.url, label: 'LeadCommand', token: roBearer })
        await A.put(`/api/connections/${rc.id}/access`, { scope: 'agent', scopeId: agent.id, maxTier: 'read' })
        await A.put(`/api/connections/${rc.id}/access`, { scope: 'project', scopeId: project.id, maxTier: 'read' })
        const rv = (await A.get('/api/connections')).connections.find((c) => c.id === rc.id)
        for (const t of rv.tools.map((x) => x.name)) await A.post(`/api/connections/${rc.id}/policies`, { tool: t, decision: 'allow', agent: 'chat', note: 'live E2E: read-only LeadCommand MCP, preapproved reads' })
        roConn = { id: rc.id, name: rv.name, state: rv.state, tools: rv.tools.map((x) => x.name), risks: rv.tools.map((x) => x.risk) }
      }
      const pv = await A.get(`/api/profiles/${prof.id}`)
      return { profile: { id: prof.id, kind: pv.kind, verification: pv.verification, state: pv.state, detail: pv.detail, identity: pv.identity }, verify_response: { verification: v.verification, state: v.state },
        agent: { id: agent.id, name: agent.name, model: agent.model ?? o.model }, project: { id: project.id },
        connection: { id: conn.id, name: view.name, state: view.state, tools: view.tools.length }, preapproved: allowed, denied, readonly: roConn }
    })
    const CONN = setup.connection.id
    out.ids.agntei = { agent: setup.agent.id, project: setup.project.id, connection: CONN, readonly_connection: setup.readonly?.id ?? null, profile: setup.profile.id }
    check('V01', 'Agntei rates the bound default Claude Code login VERIFIED through its real identity check (claude auth status: claude.ai, email + org)', setup.profile.verification === 'verified' && setup.profile.kind === 'legacy', setup.profile)
    const link = await phase('5c', 'Agntei Link: whoami → link_self → whoami', async () => {
      const r = await A.post(`/api/leadcommand/${CONN}/link`, {})
      const lc = await q1(owner, 'select status, external_install_id, external_agent_id, binding_valid_until from workforce.employee where org_id = $1 and employee_id = $2', [ORG, EMP])
      return { agntei: { check: r.check?.state, employee: r.link?.lc_employee_id }, leadcommand: lc }
    })
    out.ids.install = link.leadcommand.external_install_id

    // ── 6. the owner's directive, relayed from Agntei (assign_to_self) ────────────────────────────────────
    const relay = await phase('6', 'The owner\'s directive relayed from Agntei (POST /api/leadcommand/:id/missions, assignToSelf)', async () => {
      const r = await A.post(`/api/leadcommand/${CONN}/missions`, { directive: DIRECTIVE, assignToSelf: true })
      return { mission: r.mission?.id, data: r.data }
    })
    const MISSION = relay.mission
    out.ids.mission = MISSION

    // ── 7. Agntei OFFLINE: the internal autonomous work still completes; the agent pulls nothing while no process runs ─
    const offline = await phase('7', 'Agntei OFFLINE (server stopped): the COO plans; internal steps run; a CEO mission typed in Workforce completes entirely internally; the agent\'s step waits, untouched', async () => {
      await S.stopProcess(agProc)
      const turnsBefore = fs.readdirSync(recDir).filter((f) => /^turn-/.test(f)).length
      ticker.start()
      const internal = await lcRoute('POST', '/missions', (req) => routes.handleMissionCreate(req, routeOpts), { directive: INTERNAL_DIRECTIVE, client_request_id: 'live-internal-0001' })
      const IM = internal.data?.data?.mission?.mission_id
      out.ids.internal_mission = IM
      const research = await S.waitFor(async () => {
        const xs = await wf.listAssignments({ org_id: ORG, mission_id: MISSION, limit: 100 })
        return xs.find((x) => x.step_key === 'research' && x.assignee_employee_id === EMP) || null
      }, { timeoutMs: 300_000, intervalMs: 1500, what: 'the delegated research step' })
      const im = await S.waitFor(async () => { const m = await wf.getMission({ org_id: ORG, mission_id: IM }); return ['completed', 'failed', 'cancelled'].includes(m?.status) ? m : null }, { timeoutMs: 600_000, intervalMs: 2000, what: 'the internal mission' })
      await sleep(4000)
      const r2 = await wf.getAssignment({ org_id: ORG, assignment_id: research.assignment_id })
      const iAs = await wf.listAssignments({ org_id: ORG, mission_id: IM, limit: 200 })
      const m = await wf.getMission({ org_id: ORG, mission_id: MISSION })
      const turnsAfter = fs.readdirSync(recDir).filter((f) => /^turn-/.test(f)).length
      return { agntei_process_exited: agProc?.exited ?? null, mission: { status: m.status, plan_delegated: m.plan?.variant?.delegated === true, delegate: m.plan?.delegate, markets: m.plan?.params?.markets, n: m.plan?.params?.n },
        research_step: { assignment_id: r2.assignment_id, status: r2.status, execution_mode: r2.execution_mode, lease_owner: r2.lease_owner, attempt: r2.attempt, candidates: (r2.input?.candidates || []).length, candidates_total: r2.input?.candidates_total },
        opps: (await wf.listAssignments({ org_id: ORG, mission_id: MISSION, limit: 100 })).map((x) => `${x.step_key}:${x.assignee_employee_id}:${x.execution_mode}:${x.status}:${x.outcome_class ?? ''}`),
        internal_mission: { id: IM, status: im.status, assignments: iAs.length, external: iAs.filter((x) => x.execution_mode === 'external').length, by: [...new Set(iAs.map((x) => x.assignee_employee_id))] },
        claude_turns_while_offline: turnsAfter - turnsBefore }
    })
    const AID = offline.research_step.assignment_id
    out.ids.assignment = AID
    check('O01', 'Agntei offline: the CEO mission typed in Workforce completed entirely internally (no external assignment)', offline.internal_mission.status === 'completed' && offline.internal_mission.external === 0, offline.internal_mission)
    check('O02', 'Agntei offline: the agent\'s delegated step waited untouched (no lease, attempt 0) and no claude process ran', !offline.research_step.lease_owner && offline.research_step.attempt === 0 && offline.claude_turns_while_offline === 0 && ['pending', 'ready'].includes(offline.research_step.status), offline.research_step)
    check('P01', 'The COO planned the DELEGATED triage: ONE external research + recommendation step on the Agntei acquisition employee, with the test market\'s candidates', offline.mission.plan_delegated && offline.research_step.execution_mode === 'external' && offline.research_step.candidates >= 10, offline)

    // ── 8. Agntei back (reconnection): the link re-checked; launch the REAL agent on the assignment ───────
    await phase('8a', 'Agntei restarted on the same data dir (reconnection): link re-checked against LeadCommand', async () => {
      const s = await startAg(); agProc = s.rec; agUrl = s.url; A = agnteiApi(agUrl, agToken)
      const c = await A.post(`/api/leadcommand/${CONN}/check`, {})
      return { url: s.url, check: c?.state ?? c?.check?.state ?? c }
    })
    const db = path.join(agHome, 'agent-command.db')
    const calls = (conv) => sqlite(db, `select t.seq, t.tool, t.status, t.args_json, t.error, t.result_preview, t.call_id, t.created_at, t.finished_at, t.message_id from chat_tool_calls t where t.conversation_id = '${conv}' order by t.created_at, t.seq`)
    const launched = await phase('8b', 'Agntei launches the linked agent (the REAL claude, model claude-sonnet-5) on the delegated research assignment', async () => {
      const l = await A.post(`/api/leadcommand/${CONN}/assignments/${AID}/launch`, { projectId: setup.project.id })
      return { conversation: l.conversationId, reused: l.reused }
    })
    const CONV = launched.conversation
    out.ids.conversation = CONV
    // ── 9. the run, with a crash mid-assignment ──────────────────────────────────────────────────────────
    const liveTurn = () => fs.readdirSync(recDir).filter((f) => /^turn-\d+\.json$/.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf8')) } catch { return null } }).filter((t) => t && !t.exit)
    const assignment = () => wf.getAssignment({ org_id: ORG, assignment_id: AID })
    const killed = await phase('9a', 'CRASH: the claude process is killed (SIGKILL) mid-assignment while it holds the lease', async () => {
      const t = await S.waitFor(async () => {
        const a = await assignment()
        if (['completed', 'failed'].includes(a.status)) return { done_before_kill: true, status: a.status }
        const cs = calls(CONV)
        const ctx = cs.filter((c) => c.tool === 'read_conversation_context' && c.status === 'ok').length
        if (['leased', 'running'].includes(a.status) && (ctx >= 4 || cs.length >= 16)) return { a, ctx, total: cs.length }
        return null
      }, { timeoutMs: 30 * 60_000, intervalMs: 2000, what: 'the agent to hold the lease with work under way' })
      if (t.done_before_kill) return t
      const turn = liveTurn().at(-1)
      if (!turn) throw new Error('no live claude turn to kill')
      process.kill(turn.child_pid, 'SIGKILL')
      const killedAt = iso()
      const reply = await S.waitFor(async () => { const r = sqlite(db, `select m.status, m.error_json from conversations c join conversation_messages m on m.id = c.head_id where c.id = '${CONV}'`)[0]; return r && !['pending', 'streaming'].includes(r.status) ? r : null }, { timeoutMs: 120_000, intervalMs: 1000, what: 'Agntei to see the reply end' })
      const a = await assignment()
      return { killed_pid: turn.child_pid, session: turn.session_id, killed_at: killedAt, calls_before_kill: t.total, context_reads_before_kill: t.ctx, agntei_reply: { status: reply.status, error: (() => { try { return JSON.parse(reply.error_json || 'null') } catch { return reply.error_json } })() },
        lease_after_kill: { status: a.status, lease_owner: a.lease_owner, lease_until: a.lease_until, attempt: a.attempt } }
    }, { soft: true })
    out.recovery.kill = killed
    if (killed && !killed.done_before_kill) {
      out.recovery.lease = await phase('9b', 'EXPIRED LEASE: (TEST CLOCK) the dead agent\'s lease moved past its expiry → LeadCommand reaps it → ready for the SAME external assignee, attempt + 1', async () => {
        const before = await assignment()
        await owner.query(`update workforce.assignment set lease_until = now() - interval '1 second' where assignment_id = $1 and status in ('leased', 'running')`, [AID])
        const after = await S.waitFor(async () => { const a = await assignment(); return a.status === 'ready' && a.attempt === before.attempt + 1 ? a : null }, { timeoutMs: 180_000, intervalMs: 1500, what: 'the reaper' })
        const ev = await qa(owner, `select type, payload from workforce.event where assignment_id = $1 and type like 'wf.assignment.%' order by event_id desc limit 5`, [AID]).catch(() => [])
        return { before: { status: before.status, attempt: before.attempt, lease_owner: before.lease_owner }, after: { status: after.status, attempt: after.attempt, lease_owner: after.lease_owner, assignee: after.assignee_employee_id, execution_mode: after.execution_mode }, events: ev.map((e) => e.type) }
      }, { soft: true })
      out.recovery.resume = await phase('9d', 'RESUME via Agntei: it re-reads LeadCommand first; the agent continues from LeadCommand\'s state (re-claims, does not redo research)', async () => {
        const r = await A.post(`/api/leadcommand/${CONN}/assignments/${AID}/resume`, {})
        return { resumed: r.resumed, reason: r.reason, last_read: r.item?.lastRead ?? null, log: (r.item?.log || []).map((x) => x.event) }
      }, { soft: true })
    }
    // REVOKED CAPABILITY, mid-run: once the resumed agent has read 3 conversations, the owner revokes its conversation.read_context grant
    const ctxOk = () => calls(CONV).filter((c) => c.tool === 'read_conversation_context' && c.status === 'ok').length
    const ctxAtResume = ctxOk()
    let revoked = null
    const revokeNow = async (why) => {
      const r = await owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = $2 where agent_id = $1 and capability = 'conversation.read_context' and revoked_at is null returning grant_id, revoked_at`, [AGENT_ID, CEO_USER])
      revoked = { why, at: iso(), context_reads_before: ctxOk(), revoked: r.rows.map((x) => ({ grant_id: x.grant_id, revoked_at: x.revoked_at })) }
      out.recovery.revoke = revoked
      console.log(`   ⚑ revoked conversation.read_context (${why})`)
    }
    const done = (await phase('9e', 'The agent completes the assignment (claim → reads → research → interpretation → complete with evidence); the owner revokes conversation.read_context mid-run', async () => {
      const a = await S.waitFor(async () => {
        if (!revoked && ctxOk() >= ctxAtResume + 2) await revokeNow('after 2 conversation reads of the resumed run')
        const x = await assignment()
        if (['completed', 'failed', 'cancelled'].includes(x.status)) return x
        const r = sqlite(db, `select m.status from conversations c join conversation_messages m on m.id = c.head_id where c.id = '${CONV}'`)[0]
        if (r && ['complete', 'failed', 'interrupted', 'cancelled', 'usage-limited', 'incomplete'].includes(r.status) && !liveTurn().length) {
          // the agent's reply ended without completing: give LeadCommand a moment; then the operator presses Resume (at most twice,
          // recorded) — Agntei re-reads LeadCommand and the agent continues; after that, report it as it is
          await sleep(5000); const y = await assignment(); if (['completed', 'failed', 'cancelled'].includes(y.status)) return y
          out.recovery.operator_resumes = out.recovery.operator_resumes || []
          if (out.recovery.operator_resumes.length < 2) {
            const rr = await A.call('POST', `/api/leadcommand/${CONN}/assignments/${AID}/resume`, {})
            out.recovery.operator_resumes.push({ at: iso(), reply_status: r.status, assignment_status: y.status, http: rr.status, resumed: rr.data?.resumed ?? null, reason: rr.data?.reason ?? rr.data?.error ?? null })
            await sleep(8000)
            return null
          }
          return { ...y, ended_without_completion: r.status }
        }
        return null
      }, { timeoutMs: 45 * 60_000, intervalMs: 3000, what: 'the assignment to finish' })
      return { status: a.status, outcome_class: a.outcome_class, attempt: a.attempt, ended_without_completion: a.ended_without_completion ?? null, output: a.output, evidence: a.evidence }
    }, { soft: true })) || {}
    check('M01', 'The REAL agent completed its research assignment in LeadCommand', done.status === 'completed', { status: done.status, outcome: done.outcome_class, ended: done.ended_without_completion })
    check('M02', 'Completed VERIFIED with evidence LeadCommand resolved (a research job / a logged read)', done.outcome_class === 'verified' && (done.evidence || []).some((e) => e.resolved === true), (done.evidence || []).map((e) => `${e.type}:${e.id}:${e.resolved ? e.via : 'unresolved'}`))
    check('M03', 'Structured recommendations: summary, findings and a recommendation with refs', Boolean(done.output?.summary && done.output?.recommendation && (done.output?.findings || []).length >= 3), { findings: (done.output?.findings || []).length })

    // ── 10. replay + concurrent claim + grant expiry ─────────────────────────────────────────────────────
    const direct = await sdkClient(mcp.url, credential)
    out.recovery.replay = await phase('10a', 'DUPLICATE: the agent\'s own first CLAIMED call replayed with the SAME client_request_id (direct MCP SDK client, same credential) → LeadCommand returns the recorded outcome, one effect', async () => {
      const first = calls(CONV).find((c) => c.tool === 'leadcommand_workforce_claim_assignment' && c.status === 'ok')
      if (!first) throw new Error('no successful claim recorded')
      const args = JSON.parse(first.args_json)
      const before = await q1(owner, `select count(*)::int n from action_gateway.action_intents where agent_id = $1 and action = 'workforce_claim_assignment'`, [AGENT_ID])
      const aBefore = await assignment()
      const r = await direct.call('leadcommand_workforce_claim_assignment', args)
      const after = await q1(owner, `select count(*)::int n from action_gateway.action_intents where agent_id = $1 and action = 'workforce_claim_assignment'`, [AGENT_ID])
      const aAfter = await assignment()
      const orig = await q1(owner, `select intent_id, state, client_key, result_code from action_gateway.action_intents where agent_id = $1 and client_key = $2`, [AGENT_ID, args.client_request_id]).catch(() => null)
      return { client_request_id: args.client_request_id, response: { code: r.code, status: r.status, intent_id: r.intent_id, replayed: r.replayed }, original_intent: orig, intents_before: before.n, intents_after: after.n, assignment_unchanged: aBefore.status === aAfter.status && aBefore.attempt === aAfter.attempt && aBefore.updated_at === aAfter.updated_at }
    }, { soft: true })
    out.recovery.claim_held = await phase('10b', 'CONCURRENT CLAIM: a second agent (an internal Workforce employee) holds a property; the REAL agent, launched on an assignment for it, is refused CLAIM_HELD and says so', async () => {
      const prop = book.find((x) => x.i === 5)
      const { mission: side } = await wf.openMission({ org_id: ORG, title: 'Contested property (live E2E setup)', directive: 'Research the evidence for SYNDAL-005', requested_by: CEO_USER, owner_employee_id: 'emp_coo', idempotency_key: 'live-contested-1' })
      await wf.transitionMission({ org_id: ORG, mission_id: side.mission_id, to: 'active' })
      const { assignment: sa } = await wf.createAssignment({ org_id: ORG, mission_id: side.mission_id, step_key: 'res.contested', capability_key: 'research.property', assignee_employee_id: EMP, delegated_by_employee_id: 'emp_coo', depends_on: [], input: { property_ref: prop.property_ref, market: MARKET, force: true }, resource_type: 'property', resource_key: prop.property_ref, max_attempts: 3 })
      await wf.acquireResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: prop.property_ref, employee_id: 'emp_head_acquisitions', assignment_id: null, ttl_seconds: 3600 })
      out.ids.side_mission = side.mission_id; out.ids.side_assignment = sa.assignment_id
      const l = await A.post(`/api/leadcommand/${CONN}/assignments/${sa.assignment_id}/launch`, { projectId: setup.project.id })
      const conv = l.conversationId
      out.ids.side_conversation = conv
      await S.waitFor(async () => { const r = sqlite(db, `select m.status from conversations c join conversation_messages m on m.id = c.head_id where c.id = '${conv}'`)[0]; return r && !['pending', 'streaming'].includes(r.status) && !liveTurn().length ? r : null }, { timeoutMs: 15 * 60_000, intervalMs: 3000, what: 'the side reply' })
      const cs = calls(conv)
      const claims = cs.filter((c) => c.tool === 'leadcommand_workforce_claim_assignment')
      const reply = sqlite(db, `select m.content from conversations c join conversation_messages m on m.id = c.head_id where c.id = '${conv}'`)[0]?.content || ''
      const sa2 = await wf.getAssignment({ org_id: ORG, assignment_id: sa.assignment_id })
      return { assignment: sa.assignment_id, claims: claims.map((c) => ({ status: c.status, code: (/(CLAIM_HELD|HUMAN_OWNED|CLAIMED)/.exec(`${c.result_preview || ''} ${c.error || ''}`) || [])[1] || null })), after: { status: sa2.status, lease_owner: sa2.lease_owner }, agent_said: reply.slice(0, 1200) }
    }, { soft: true })
    out.recovery.grant_expiry = await phase('10c', 'GRANT EXPIRY: the owner replaces Scout\'s workforce.escalate grant with one that lives 3 seconds (grants are immutable: a new version supersedes); after it lapses the gateway refuses the call', async () => {
      const old = await q1(owner, `select grant_id, grant_version from action_gateway.capability_grants where agent_id = $1 and capability = 'workforce.escalate' and revoked_at is null`, [AGENT_ID])
      await owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = $2 where grant_id = $1`, [old.grant_id, CEO_USER])
      const g = await q1(owner, `insert into action_gateway.capability_grants (org_id, agent_id, capability, grant_version, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, granted_by, expires_at, supersedes_grant_id)
                                 values ($1, $2, 'workforce.escalate', $5, 1, '{}', '{}', 30, 200, 0, $3, now() + interval '3 seconds', $4) returning grant_id, grant_version, valid_from, expires_at`, [ORG, AGENT_ID, CEO_USER, old.grant_id, Number(old.grant_version) + 1])
      await sleep(4500)
      const r = await direct.call('leadcommand_workforce_escalate', { client_request_id: `live-expiry-${Date.now()}`, assignment_id: out.ids.side_assignment || AID, reasons: ['GRANT_EXPIRY_TEST'] })
      const items = await q1(owner, `select count(*)::int n from workforce.assignment where input ->> 'task' = 'escalation' and input -> 'reasons' ? 'GRANT_EXPIRY_TEST'`).catch(() => ({ n: null }))
      return { superseded: old.grant_id, short_grant: g, code: r.code, status: r.status, message: r.raw?.error?.message ?? null, escalation_items_created: items.n }
    }, { soft: true })
    out.recovery.revoked_surface = await phase('10d', 'REVOKED CAPABILITY, surfaced: every call after the revoke was refused (audit) and the agent reported it', async () => {
      const refusedAfter = () => calls(CONV).filter((c) => c.tool === 'read_conversation_context' && c.status !== 'ok').length
      out.recovery.revoke_refused_in_run = refusedAfter()
      if (!revoked || refusedAfter() === 0) {
        // the run made no conversation read after the revoke: (revoke if not yet and) ask the agent, in the same conversation, for one
        if (!revoked) await revokeNow('the run finished before 2 conversation reads: revoked between turns of the same conversation')
        const thread = (out.assignments || await wf.listAssignments({ org_id: ORG, mission_id: MISSION, limit: 100 })).find((x) => x.step_key === 'research')?.input?.candidates?.[0]?.conversation_id
        await A.post(`/api/conversations/${CONV}/messages`, { text: `Operator: before we close, re-read the conversation context of thread ${thread} with read_conversation_context and tell me the seller's latest message. If LeadCommand refuses, say exactly what it answered.`, toolGrants: [CONN, ...(out.ids.agntei.readonly_connection ? [out.ids.agntei.readonly_connection] : [])] })
        await sleep(3000)
        await S.waitFor(async () => { const r = sqlite(db, `select m.status from conversations c join conversation_messages m on m.id = c.head_id where c.id = '${CONV}'`)[0]; return r && !['pending', 'streaming'].includes(r.status) && !liveTurn().length ? r : null }, { timeoutMs: 10 * 60_000, intervalMs: 3000, what: 'the follow-up reply' })
      }
      const reply = sqlite(db, `select m.content from conversations c join conversation_messages m on m.id = c.head_id where c.id = '${CONV}'`)[0]?.content || ''
      const refusals = await qa(owner, `select at, event_type, code from action_gateway.action_audit_events where agent_id = $1 and action = 'read_conversation_context' and coalesce(upper(code), '') not in ('', 'OK', 'READ') order by event_id`, [AGENT_ID])
      const all = await qa(owner, `select at, event_type, action, code from action_gateway.action_audit_events where agent_id = $1 and action = 'read_conversation_context' order by event_id`, [AGENT_ID])
      const agentCalls = calls(CONV).filter((c) => c.tool === 'read_conversation_context')
      return { revoke: revoked, audit: all.map((x) => `${x.at instanceof Date ? x.at.toISOString() : x.at} ${x.event_type}:${x.code ?? '-'}`), refused_in_audit: refusals.length, agent_calls: agentCalls.map((c) => `${c.status}${c.error ? `:${String(c.error).slice(0, 100)}` : ''}`), agent_said_last: reply.slice(0, 1500) }
    }, { soft: true })
    await direct.close()

    // ── 11. the COO's mission review; the outcome from both apps ─────────────────────────────────────────
    const reviewed = (await phase('11a', 'Tick until the COO mission_review; the COO report', async () => {
      const m = await S.waitFor(async () => { const x = await wf.getMission({ org_id: ORG, mission_id: MISSION }); return ['completed', 'failed', 'cancelled'].includes(x.status) ? x : null }, { timeoutMs: 600_000, intervalMs: 2000, what: 'the mission to finish' })
      const msgs = (await wf.listExecMessages({ org_id: ORG, limit: 200 })).filter((x) => x.mission_id === MISSION).reverse()
      return { status: m.status, counts: m.report?.counts ?? null, delegated: m.report?.delegated ?? null, coo_messages: msgs.filter((x) => x.author === 'coo').map((x) => x.content) }
    }, { soft: true })) || { status: null, coo_messages: [] }
    const both = (await phase('11b', 'The outcome read from BOTH apps: Workforce API (missions/[id], command) and Agntei (GET /api/leadcommand, its mission view)', async () => {
      const lm = await lcGet.mission(MISSION); await lcGet.command()
      const ov = await A.get('/api/leadcommand?refresh=1')
      const am = await A.get(`/api/leadcommand/${CONN}/missions/${MISSION}?refresh=1`)
      const panel = ov.connections.find((c) => c.connection.id === CONN)
      const lcA = (lm.data?.data?.assignments || []).find((x) => x.assignment_id === AID)
      const agA = (am.value?.assignments || []).find((x) => x.assignment_id === AID)
      const pA = panel?.work?.value?.assignments?.find((x) => x.id === AID)
      // a ref is {type, id} or a system job ref {job_id, source}: the SAME canonical ref either way (the scripted harness's rule)
      const ev = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map((e) => `${e.type ?? (e.job_id ? 'job' : '?')}:${e.id ?? e.job_id}`))].map((k) => `${k}:${(Array.isArray(xs) ? xs : []).some((e) => `${e.type ?? (e.job_id ? 'job' : '?')}:${e.id ?? e.job_id}` === k && e.resolved === true) ? 'resolved' : 'unresolved'}`).sort()
      out.agnteiViews = { overview: ov, mission: am }
      return { leadcommand: { mission: lm.data?.data?.mission?.mission_id, status: lm.data?.data?.mission?.status, assignment: lcA ? { status: lcA.status, outcome_class: lcA.outcome_class, evidence: ev(lcA.evidence) } : null },
        agntei: { mission: am.value?.mission?.mission_id, status: am.value?.mission?.status, assignment: agA ? { status: agA.status, outcome_class: agA.outcome_class, evidence: ev(agA.evidence) } : null, panel: pA ? { state: pA.state, outcome: pA.output?.outcomeClass ?? null } : null, link: panel?.link?.lc_employee_id ?? null } }
    }, { soft: true })) || { leadcommand: {}, agntei: {} }
    check('B01', 'Both apps: the same mission id and status (completed)', both.leadcommand.mission === MISSION && both.agntei.mission === MISSION && both.leadcommand.status === 'completed' && both.agntei.status === 'completed', both)
    check('B02', 'Both apps: the same assignment outcome and evidence refs', JSON.stringify(both.leadcommand.assignment) === JSON.stringify(both.agntei.assignment), both)
    check('B03', 'The COO report names the agent\'s research and its recommendation', reviewed.status === 'completed' && reviewed.coo_messages.some((m) => /Agntei\) researched/.test(m)), reviewed.coo_messages)

    // ── 12. safety, records, credentials ─────────────────────────────────────────────────────────────────
    out.safety = await phase('12a', 'No send_queue / offer / follow-up / hold write; $0 research spend; web research off', async () => {
      const counts = await q1(owner, `select (select count(*) from public.send_queue)::int send_queue, (select count(*) from public.seller_offers)::int seller_offers, (select count(*) from public.followup_intents)::int followup_intents, (select count(*) from public.automation_holds where set_by like 'agent:%')::int agent_holds`)
      const spend = await q1(owner, `select count(*)::int n, coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0)::float usd from agent.spend_ledger`)
      const jobs = await qa(owner, `select job_id, kind, state, input ->> 'property_ref' property_ref, result -> 'web' ->> 'status' web, result ->> 'cost_usd' cost from agent.research_job where kind = 'property.research' order by created_at`)
      const tiers = await q1(owner, "select value from public.system_control where key = 'action_gateway_tiers'")
      return { counts, spend, research_jobs: jobs, tiers: tiers?.value, service_calls: serviceCalls }
    })
    out.records.agntei_chat_tool_calls = sqlite(db, `select conversation_id, seq, tool, risk, status, args_json, error, call_id, created_at, finished_at from chat_tool_calls order by created_at, seq`)
    out.records.agntei_connection_calls = sqlite(db, `select id, connection_label, tool, risk, status, actor, purpose, error, started_at, finished_at, length(result_text) result_chars from connection_calls order by started_at`)
    out.records.agntei_runs = sqlite(db, `select id, conversation_id, provider, auth_method, model, status, input_tokens, output_tokens, api_key_source, estimated_cost_usd, exit_code, error_kind, error_message, started_at, finished_at from inference_runs order by started_at`)
    out.records.agntei_messages = sqlite(db, `select conversation_id, role, status, substr(content, 1, 6000) content, model, created_at from conversation_messages order by created_at`)
    out.records.lc_audit = await qa(owner, `select event_id, at, event_type, action, capability, tier, code, intent_id, detail -> 'record_refs' record_refs from action_gateway.action_audit_events where agent_id = $1 order by event_id`, [AGENT_ID])
    out.records.lc_intents = await qa(owner, `select intent_id, action, state, result_code, client_key, created_at from action_gateway.action_intents where agent_id = $1 order by created_at`, [AGENT_ID]).catch((e) => [{ error: e.message }])
    out.records.workforce_events = await qa(owner, `select event_id, at, type, mission_id, assignment_id, employee_id from workforce.event where mission_id = $1 or assignment_id = $2 order by event_id`, [MISSION, AID]).catch(() => [])
    out.records.turns = fs.readdirSync(recDir).filter((f) => /^(turn|call)-\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf8')))
    out.records.streams = fs.readdirSync(recDir).filter((f) => /^stream-\d+\.jsonl$/.test(f))
    out.mission = await wf.getMission({ org_id: ORG, mission_id: MISSION })
    out.assignments = await wf.listAssignments({ org_id: ORG, mission_id: MISSION, limit: 100 })
    for (const g of ['overview', 'command', 'missions', 'employees', 'assignments', 'events', 'authority', 'kpis', 'reports']) await lcGet[g]()
    await lcGet.mission(MISSION); await lcGet.employee(EMP)

    // ── 13. screenshots (Agntei live; LeadCommand recorded from the real route handlers) ──────────────────
    if (o.screens) {
      await phase('13', 'Screenshots: Agntei (live UI on the live state) and LeadCommand Workforce (recorded from the real route handlers)', async () => {
        const ui = await import('./e2e-agntei/ui.mjs')
        const banner = 'LIVE LOCAL E2E · Agntei headless on a disposable stack · REAL Claude Code (claude-sonnet-5) · SYNTHETIC test market'
        const a1 = await ui.captureAgntei({ url: agUrl, token: agToken, outDir: o.outDir, name: 'live-agntei-1-leadcommand-panel', scrollTo: 'lcw-done', banner })
        const a2 = await ui.captureAgnteiPage({ url: agUrl, token: agToken, outDir: o.outDir, name: 'live-agntei-2-conversation', hash: `#/chat/${CONV}`, banner, height: 1400 })
        const a3 = out.ids.side_conversation ? await ui.captureAgnteiPage({ url: agUrl, token: agToken, outDir: o.outDir, name: 'live-agntei-3-claim-held', hash: `#/chat/${out.ids.side_conversation}`, banner }) : null
        out.screens.push({ id: 'agntei-panel', ...a1 }, { id: 'agntei-conversation', ...a2 }, ...(a3 ? [{ id: 'agntei-claim-held', ...a3 }] : []))
        // LeadCommand Workforce: the dashboard (vite dev) answered from the responses RECORDED from the real route handlers
        try {
          const d = await ui.startDashboard({ repo: REPO, node: o.lcNode, log: path.join(logs, 'dashboard-vite.log') })
          const lcShots = await ui.captureDashboard({ base: d.url, recorded: out.recorded, outDir: o.outDir, prefix: 'live-leadcommand-recorded', missionTitle: out.mission?.title || '' })
          out.screens.push({ id: 'leadcommand-recorded', ...lcShots })
        } catch (e) { out.screens.push({ id: 'leadcommand-recorded', error: String(e?.message || e).slice(0, 400) }) }
        await ui.closeBrowser()
        return out.screens.map((s) => s.files)
      }, { soft: true })
    }

    // ── 14. teardown of Agntei's secrets ─────────────────────────────────────────────────────────────────
    const conns = (await A.get('/api/connections')).connections.map((c) => c.id)
    for (const id of conns) await A.del(`/api/connections/${id}`).catch(() => {})
    const left = conns.filter((id) => spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'agent-command.isolated', '-a', `mcp-token:${id}`], { encoding: 'utf8' }).status === 0)
    for (const id of left) spawnSync('/usr/bin/security', ['delete-generic-password', '-s', 'agent-command.isolated', '-a', `mcp-token:${id}`])
    check('T01', 'Teardown: every connection removed through Agntei\'s API; no Bearer of this run left in the keychain', left.length === 0, `${conns.length} removed; ${left.length} removed directly`)
  } finally {
    try { await ticker?.stop() } catch { /* ignore */ }
    out.tick = ticker ? { ...ticker.stats(), log: ticker.log.slice(-300) } : null
    try { await world?.owner?.end() } catch { /* ignore */ }
    try { await world?.api?.end() } catch { /* ignore */ }
    try { await world?.db?.pool?.end() } catch { /* ignore */ }
    await S.stopAll()
    out.stopped = { remaining: S.running() }
    try {
      const db = agHome && path.join(agHome, 'agent-command.db')
      if (db && fs.existsSync(db)) {
        const ids = spawnSync('/usr/bin/sqlite3', [db, 'select id from connections'], { encoding: 'utf8' }).stdout.split('\n').filter((x) => /^conn_[0-9a-f]+$/.test(x))
        out.stopped.keychain_removed = ids.filter((id) => spawnSync('/usr/bin/security', ['delete-generic-password', '-s', 'agent-command.isolated', '-a', `mcp-token:${id}`]).status === 0).length
      }
    } catch { /* best effort */ }
    // credentials never in the agent's context / args / logs / transcripts: grep everything this run wrote for every secret value
    try {
      const files = []
      const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (!/pgdata|node_modules/.test(p)) walk(p) } else if (!/\/secrets\//.test(p)) files.push(p) } }
      walk(runDir)
      const hits = []
      for (const f of files) {
        let buf
        try { buf = fs.readFileSync(f) } catch { continue }
        // postgrest.conf is PostgREST's own server config (it must hold the JWT secret); reported, not a leak
        for (const [k, v] of Object.entries(secretValues)) if (v && v.length >= 16 && buf.includes(Buffer.from(v))) hits.push({ file: path.relative(runDir, f), secret: k, ...(path.basename(f) === 'postgrest.conf' && k === 'jwt_secret' ? { expected: 'PostgREST server config (0600)' } : {}) })
        if (/claude-recorder\//.test(f) && /lcag_[A-Za-z0-9_-]{8,}/.test(buf.toString('utf8'))) hits.push({ file: path.relative(runDir, f), secret: 'lcag_ pattern' })
      }
      out.security.secret_grep = { files_scanned: files.length, secrets_checked: Object.keys(secretValues), hits }
    } catch (e) { out.security.secret_grep = { error: String(e?.message || e) } }
  }
  out.wall_ms = Date.now() - t0
  return out
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : process.argv.includes(`--${n}`) ? true : d }
  const need = (n) => { const v = arg(n); if (!v || v === true) { console.error(`--${n}=… is required`); process.exit(2) } return String(v) }
  const outDir = path.resolve(need('out'))
  const opts = { agnteiDir: path.resolve(need('agntei-dir')), agnteiNode: path.resolve(need('agntei-node')), pgBin: path.resolve(need('pg-bin')), postgrestBin: path.resolve(need('postgrest-bin')), claudeBin: path.resolve(need('claude-bin')),
    lcNode: process.execPath, outDir, model: String(arg('model', 'claude-sonnet-5')), screens: arg('screens') === true }
  fs.mkdirSync(outDir, { recursive: true })
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-live-'))
  const shutdown = async () => {
    await S.stopAll()
    // an interrupted run leaves no Bearer of its own in the keychain (isolated service; this run's connection ids only)
    const db = path.join(runDir, 'agntei-home', 'agent-command.db')
    if (fs.existsSync(db)) for (const id of spawnSync('/usr/bin/sqlite3', [db, 'select id from connections'], { encoding: 'utf8' }).stdout.split('\n').filter((x) => /^conn_[0-9a-f]+$/.test(x))) spawnSync('/usr/bin/security', ['delete-generic-password', '-s', 'agent-command.isolated', '-a', `mcp-token:${id}`])
    process.exit(130)
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
  console.log(`live run: state ${runDir}`)
  let r = null
  try { r = await runLive({ ...opts, runDir }) } catch (e) { console.error(`live run FAILED: ${e?.stack || e}`); r = { fatal: String(e?.stack || e).slice(0, 4000) } }
  r = r || {}
  r.run_dir = runDir
  fs.writeFileSync(path.join(outDir, 'live-run.json'), JSON.stringify(r, null, 1))
  // the claude stream-json transcripts, kept with the run's records (capability URLs are masked by the recorder)
  const rec = path.join(runDir, 'claude-recorder')
  if (fs.existsSync(rec)) { fs.mkdirSync(path.join(outDir, 'claude-stream'), { recursive: true }); for (const f of fs.readdirSync(rec)) fs.copyFileSync(path.join(rec, f), path.join(outDir, 'claude-stream', f)) }
  console.log(`checks: ${(r.checks || []).filter((c) => c.ok).length}/${(r.checks || []).length}; failures: ${(r.failures || []).length}; remaining processes ${JSON.stringify(r.stopped?.remaining ?? null)}`)
  process.exit(r.fatal ? 1 : 0)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(async (e) => { console.error(e?.stack || e); await S.stopAll(); process.exit(1) })
