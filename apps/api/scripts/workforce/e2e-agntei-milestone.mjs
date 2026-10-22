#!/usr/bin/env node
// LeadCommand Workforce × Agntei — THE FIRST CROSS-PLATFORM MILESTONE (docs/WORKFORCE-AGNTEI.md §6), end to end, on a
// fully LOCAL, DISPOSABLE stack:
//
//   cd apps/api && node --import ./scripts/workforce/e2e-agntei/register.mjs scripts/workforce/e2e-agntei-milestone.mjs \
//     --agntei-dir=<agntei worktree> --agntei-node=<node 22 binary> --pg-bin=<pg17 bin dir> --postgrest-bin=<postgrest> \
//     --out=<dir> [--runs=2] [--keep-alive-for-ui]
//
// One run:
//   1. its OWN PostgreSQL 17 cluster (a free loopback port) → the REAL schema chain → the real PostgREST binary
//      (+ a /rest/v1 path shim standing in for Supabase's API gateway). Armed on THIS database only: the runtime, the
//      kinds workforce.* + property.research, action_gateway_enabled + tier T1; Workforce enabled in this process and on
//      the Action MCP host.
//   2. The CEO registers an Agntei employee (POST /employees {op:'register_agntei'}, the real route handler, an owner).
//   3. The owner mints the agent credential + the gateway JWT with the REAL owner scripts, runs the owner SQL the
//      registration returned (principal, grants), and binds (employee_bind_principal: link window + binding validity).
//   4. The REAL Action MCP (bin/leadcommand-action-mcp.mjs), streamable-http on loopback, from 0600 files.
//   5. Agntei headless (apps/server/src/main.ts; temp data dir; isolated mode; a session token): through Agntei's own
//      API the agent, the LeadCommand Workforce connection (the Bearer goes to Agntei's secret store), the one-agent grant,
//      and Link (whoami → link_self → whoami).
//   6. The CEO directive relayed from Agntei's composer route (workforce_open_mission, assign_to_self).
//   7. LeadCommand's REAL runtime tick: the COO plans; the research step goes to the Agntei employee (external).
//   8. Agntei launches the linked agent on it: a conversation whose "Claude Code" is the SCRIPTED AGENT
//      (agntei scripts/leadcommand-e2e/scripted-agent.mjs: Claude Code's CLI contract, a fixed script, NO model). It calls
//      the LeadCommand tools through Agntei's REAL per-turn MCP bridge → chat tool executor → Connections.callTool →
//      Agntei's MCP client → the REAL Action MCP: list → claim → reads → request_research (a real R2 job, run by the
//      tick) → claim again → complete with resolvable evidence → verified.
//   9. Tick until the COO's mission_review; the COO exec_message.
//  10. The outcome read from BOTH sides (Workforce API: missions/[id], command; Agntei: GET /api/leadcommand + mission).
//  11. No send_queue / offer / stage write; $0 model spend.
//  + the adversarial segment (forged context, a second agent with the same ref, a closed link window, revoke, CLAIM_HELD,
//    HUMAN_OWNED, a disconnect mid-lease → reap → re-claim → research deduped → completed once, the emergency stop,
//    handoff external → internal → dispatch, tenant isolation). Every process and the cluster are stopped at the end.
//
// It REFUSES any non-loopback target (database, PostgREST, Action MCP, Agntei). Nothing reaches production, a model, a
// seller or the network.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import * as S from './e2e-agntei/stack.mjs'
import { buildWorld } from './e2e-agntei/world.mjs'
import { e2eBook, researchSource, seedPublicRows } from './e2e-agntei/book.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const API_DIR = path.resolve(here, '../..')
const REPO = path.resolve(API_DIR, '../..')
export const DIRECTIVE = 'Research the three strongest Dallas seller opportunities and report the acquisition economics to the COO.'
const ORG = '00000000-0000-4000-8000-00000000a001' // the LeadCommand org (WORKFORCE_ORG_ID)
const ORG_B = '00000000-0000-4000-8000-0000000000b2'
export const CEO_USER = '0e2e0000-0000-4000-8000-00000000ce01' // the named owner of the disposable org (synthetic)
const OWNER_B = '0e2e0000-0000-4000-8000-00000000ce0b'
const ENV = Object.freeze({ AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex')
const ASSIGNMENT_ID = /^wfa_[0-9a-f-]{36}$/

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────────
function makeRecorder(t0) {
  const steps = []
  const checks = []
  const timings = {}
  return {
    steps, checks, timings,
    async step(id, title, fn) {
      const s = Date.now()
      const rec = { id, title, ok: false, ms: 0, evidence: null, error: null }
      steps.push(rec)
      try { rec.evidence = await fn(); rec.ok = true } catch (e) { rec.error = String(e?.stack || e).slice(0, 2000); throw e } finally { rec.ms = Date.now() - s; timings[id] = rec.ms }
      return rec.evidence
    },
    check(id, name, ok, detail = '') { checks.push({ id, name, ok: Boolean(ok), detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }); return Boolean(ok) },
    elapsed: () => Date.now() - t0,
  }
}
const q1 = async (pool, sql, params = []) => (await pool.query(sql, params)).rows[0] || null
const qa = async (pool, sql, params = []) => (await pool.query(sql, params)).rows

function agntei(base, token) {
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'x-agentcmd-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { status: r.status, data }
  }
  const must = async (method, p, body) => {
    const r = await call(method, p, body)
    if (r.status >= 400) throw new Error(`Agntei ${method} ${p} → ${r.status}: ${JSON.stringify(r.data).slice(0, 600)}`)
    return r.data
  }
  return { call, get: (p) => must('GET', p), post: (p, b = {}) => must('POST', p, b), put: (p, b = {}) => must('PUT', p, b), patch: (p, b = {}) => must('PATCH', p, b), del: (p) => must('DELETE', p), raw: call }
}

/** Run a node script (the REAL owner scripts) and return its stdout. */
function runNode(node, args, { cwd, env = {} }) {
  const r = spawnSync(node, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } })
  if (r.status !== 0) throw new Error(`${args.join(' ')} → ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 600)}`)
  return r.stdout
}

const transcriptOf = (stateDir) => {
  try { return fs.readFileSync(path.join(stateDir, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const agentStatuses = (stateDir) => fs.readdirSync(stateDir).filter((f) => /^agent-\d+\.json$/.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')) } catch { return null } }).filter(Boolean)

// ── one run ──────────────────────────────────────────────────────────────────────────────────────────────
export async function runMilestone(o) {
  const t0 = Date.now()
  const R = makeRecorder(t0)
  const runDir = o.runDir
  const logs = path.join(runDir, 'logs')
  const secrets = path.join(runDir, 'secrets')
  const state = path.join(runDir, 'scripted-agent')
  for (const d of [runDir, logs, secrets, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  const out = { run: o.run, ids: {}, recorded: {}, agnteiViews: {}, transcript: [], gatewayAudit: [], adversarial: [] }
  let world = null
  let ticker = null
  const pools = []
  try {
    // ── 1. PostgreSQL + the schema chain + PostgREST ─────────────────────────────────────────────────────
    const pgc = await R.step('1a', 'PostgreSQL 17 cluster (own data dir, free loopback port)', async () => {
      const c = await S.startPg({ bin: o.pgBin, dir: path.join(runDir, 'pg'), log: path.join(logs, 'postgres.log') })
      const v = execFileSync(path.join(o.pgBin, 'postgres'), ['--version'], { encoding: 'utf8' }).trim()
      return { port: c.port, version: v, admin_url: c.adminUrl }
    })
    world = await R.step('1b', 'The REAL schema chain on one disposable database', async () => {
      const w = await buildWorld({ adminUrl: pgc.admin_url, ownerUserId: CEO_USER, orgId: ORG })
      return w
    })
    out.ids.database = world.name
    const owner = world.owner
    const api = world.api
    const evidence1b = { database: world.name, files: world.applied }
    R.steps.at(-1).evidence = evidence1b
    // the other tenant + the CEO's operator membership (the membership sync's rows)
    await owner.query(`insert into agent.org (org_id, name) values ($1, 'tenant b (e2e)') on conflict do nothing`, [ORG_B])
    await owner.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'owner', 'workforce-agntei-e2e') on conflict do nothing`, [ORG_B, OWNER_B])

    const jwtSecret = crypto.randomBytes(32).toString('hex')
    const jwtSecretFile = S.writeSecret(path.join(secrets, 'jwt-secret'), jwtSecret)
    const rest = await R.step('1c', 'PostgREST (the real binary) + the /rest/v1 path shim', async () => {
      const authUrl = `postgres://authenticator@127.0.0.1:${pgc.port}/${world.name}`
      const p = await S.startPostgrest({ bin: o.postgrestBin, dbUrl: authUrl, jwtSecret, dir: runDir, log: path.join(logs, 'postgrest.log') })
      const shim = await S.startRestShim({ upstream: p.url })
      const version = execFileSync(o.postgrestBin, ['--version'], { encoding: 'utf8' }).trim()
      return { postgrest: p.url, shim: shim.url, version, hits: shim.hits }
    })

    const book = e2eBook(Date.now())
    const { MANUAL_THREAD, MANUAL_PID } = await import('./e2e-agntei/adversarial.mjs')
    await seedPublicRows(owner, book, { manualThread: MANUAL_THREAD, manualPid: MANUAL_PID })
    const armed = await R.step('1d', 'Arm ONLY what the milestone needs, on THIS database', async () => {
      const kinds = { 'workforce.coo_plan': 1, 'workforce.dispatch': 1, 'workforce.mission_review': 1, 'property.research': 2 }
      await owner.query(`update agent.runtime_limits set runtime_enabled = true, emergency_stop = false, emergency_stop_at = null, emergency_stop_reason = null, max_concurrency_global = 4, tick_max_jobs = 4,
          lease_seconds = 15, backoff_base_seconds = 5, kind_limits = $1::jsonb where id = 1`,
      [JSON.stringify(Object.fromEntries(Object.entries(kinds).map(([k, n]) => [k, { enabled: true, max_concurrency: n, armed_by: CEO_USER }])))])
      await owner.query(`insert into public.system_control (key, value) values ('action_gateway_enabled', 'true'), ('action_gateway_tiers', 'T1')
                         on conflict (key) do update set value = excluded.value`)
      const lim = await q1(owner, 'select runtime_enabled, emergency_stop, kind_limits from agent.runtime_limits where id = 1')
      const ctl = await qa(owner, "select key, value from public.system_control where key like 'action_gateway%' order by key")
      return { runtime_enabled: lim.runtime_enabled, emergency_stop: lim.emergency_stop, kinds: Object.keys(lim.kind_limits).sort(), controls: ctl, workforce_env: ENV, action_mcp_workforce: 'LEADCOMMAND_ACTION_MCP_WORKFORCE_ENABLED=true' }
    })

    const publicWrites = async () => {
      await sleep(1100) // cumulative stats flush at most once a second per backend
      await owner.query('select pg_stat_clear_snapshot()')
      return Object.fromEntries((await qa(owner, `select relname, n_tup_ins::int ins, n_tup_upd::int upd, n_tup_del::int del from pg_stat_user_tables where schemaname = 'public' order by relname`)).map((r) => [r.relname, r]))
    }
    const writesBefore = await publicWrites()

    // the LeadCommand side in this process: the REAL store / runtime / route handlers / engine handlers
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
    const { syntheticServices } = await import('./demo-opportunity-triage.mjs')
    const wf = createWorkforcePgStore({ pool: api })
    const rt = createRuntimePgStore({ pool: api })
    const reads = createMissionPgReads({ pool: api })
    await rt.assertLeastPrivilege()
    const svc = { store: wf, runtimeStore: rt, reads, membership: (org, user) => reads.membership(org, user) }
    const limiter = createUserRateLimiter({ limits: resolveRateLimits({}) })
    const routeOpts = { env: ENV, auth: () => ({ ok: true }), identity: { authenticate: async () => ({ ok: true, identity: { user_id: CEO_USER, verified: true, named: true } }) }, limiter, getServices: async () => svc }
    const LC = 'http://workforce-e2e.local/api/cockpit/workforce'
    /** The REAL route handlers; every response is recorded (the dashboard screenshots replay them). */
    const lcRoute = async (method, p, handler, body) => {
      const req = new Request(`${LC}${p}`, method === 'GET' ? {} : { method, body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } })
      const res = await handler(req)
      const data = await res.json().catch(() => null)
      if (method === 'GET') out.recorded[p] = { status: res.status, body: data, at: new Date().toISOString() }
      return { status: res.status, data }
    }
    const lcGet = {
      overview: () => lcRoute('GET', '/overview', (r) => routes.handleOverview(r, routeOpts)),
      command: () => lcRoute('GET', '/command', (r) => routes.handleCommandList(r, routeOpts)),
      missions: () => lcRoute('GET', '/missions', (r) => routes.handleMissionsList(r, routeOpts)),
      mission: (id) => lcRoute('GET', `/missions/${id}`, (r) => routes.handleMissionGet(r, id, routeOpts)),
      employees: () => lcRoute('GET', '/employees', (r) => routes.handleEmployeesList(r, routeOpts)),
      employee: (id) => lcRoute('GET', `/employees/${id}`, (r) => routes.handleEmployeeGet(r, id, routeOpts)),
      assignments: () => lcRoute('GET', '/assignments', (r) => routes.handleAssignments(r, routeOpts)),
      events: () => lcRoute('GET', '/events', (r) => routes.handleEvents(r, routeOpts)),
      authority: () => lcRoute('GET', '/authority', (r) => routes.handleAuthorityGet(r, routeOpts)),
      kpis: () => lcRoute('GET', '/kpis', (r) => routes.handleKpis(r, routeOpts)),
      reports: () => lcRoute('GET', '/reports', (r) => routes.handleReports(r, routeOpts)),
    }

    const { services, calls: serviceCalls } = syntheticServices(book, { now: Date.now() })
    const { FIXTURE_PIDS } = await import('./e2e-agntei/adversarial.mjs')
    const research = createPropertyResearchHandler({ source: researchSource(book, { extraIds: FIXTURE_PIDS }), reads, buildAsk: null, env: {}, now: () => Date.now() })
    const handlers = { ...buildWorkforceHandlers({ store: wf, runtimeStore: rt, reads, services, env: ENV, now: () => Date.now(), org_id: ORG }), 'property.research': research }
    // the REAL runtime tick, in the background (the 60 s workforce-dispatch schedule is stood in for by an operator
    // "run now" enqueue when the runtime is idle — the real enqueue, as in the Phase A demonstration)
    ticker = (() => {
      let stop = false; let ticks = 0; let nudges = 0; let lastNudge = 0; let running = null; const log = []
      const loop = async () => {
        while (!stop) {
          try {
            const t = await runRuntimeTick({ store: rt, handlers, workerId: 'e2e-runtime-tick', budgetMs: 25_000, now: () => Date.now() })
            ticks += 1
            if (t.claimed || t.reaped || t.errors?.length) log.push({ at: Date.now() - t0, claimed: t.claimed, reaped: t.reaped, jobs: t.jobs.map((j) => `${j.kind}:${j.outcome}`), errors: t.errors })
            if (!t.claimed) {
              if (Date.now() - lastNudge > 2000) { await enqueueWorkforceJob(rt, { kind: DISPATCH_KIND, key: ['e2e-nudge', o.run, ++nudges], input: { reason: 'e2e_nudge' }, requested_by: CEO_USER }).catch(() => {}); lastNudge = Date.now() }
              await sleep(700)
            }
          } catch (e) { log.push({ at: Date.now() - t0, error: String(e?.message || e).slice(0, 200) }); await sleep(1000) }
        }
      }
      return { start() { if (!running) { stop = false; running = loop() } }, async stop() { stop = true; await running; running = null }, stats: () => ({ ticks, nudges }), log }
    })()

    // ── 2. The CEO registers the Agntei employee (the real route handler, as the owner) ─────────────────
    const EMP = 'emp_scout_agntei'
    const reg = await R.step('2', 'CEO registers an Agntei employee: POST /employees {op: register_agntei}', async () => {
      const r = await lcRoute('POST', '/employees', (req) => routes.handleEmployeeUpsert(req, routeOpts), { op: 'register_agntei', employee: { employee_id: EMP, role_key: 'research_analyst', display_name: 'Scout', markets: ['Dallas'], manager_employee_id: 'emp_head_data', employee_code: 'DAT-02' } })
      if (r.status !== 201) throw new Error(`register_agntei → ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`)
      return { status: r.status, employee: { id: r.data.data.employee.employee_id, status: r.data.data.employee.status, origin: r.data.data.employee.origin, employment_type: r.data.data.employee.employment_type }, executed: r.data.data.executed, agent_id: r.data.data.link.agent_id, steps: r.data.data.link.steps.map((s) => s.id), link: r.data.data.link }
    })
    const AGENT_ID = reg.agent_id
    out.ids.employee = EMP
    out.ids.principal = AGENT_ID

    // ── 3. The owner: the REAL mint scripts, the owner SQL the registration returned, the bind ─────────
    const mcpDir = path.join(REPO, 'mcp/leadcommand-action-mcp')
    const pepperFile = S.writeSecret(path.join(secrets, 'action-pepper'), crypto.randomBytes(32).toString('hex'))
    const anonKeyFile = S.writeSecret(path.join(secrets, 'anon-key'), S.hs256(jwtSecret, { role: 'anon', iss: 'supabase', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 86_400 }))
    const gwJwtFile = path.join(secrets, 'lc_action_gateway.jwt')
    const mint = async ({ agentId, out: file }) => {
      const stdout = runNode(o.lcNode, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './src/loader/register.mjs', 'scripts/mint-agent-credential.mjs', '--pepper-file', pepperFile, '--agent-id', agentId, '--out', file], { cwd: mcpDir })
      const first = JSON.parse(stdout.split('\n')[0])
      return { digest: first.credential_digest, sql: stdout.split('\n').slice(1).join('\n'), mode: (fs.statSync(file).mode & 0o777).toString(8) }
    }
    const bound = await R.step('3', 'Owner: mint (real scripts) → principal + grants (the registration\'s owner SQL) → employee_bind_principal', async () => {
      const g = JSON.parse(runNode(o.lcNode, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/mint-gateway-token.mjs', '--secret-file', jwtSecretFile, '--org', ORG, '--out', gwJwtFile, '--days', '7'], { cwd: mcpDir }).trim())
      const credFile = path.join(secrets, `${AGENT_ID}.credential`)
      const m = await mint({ agentId: AGENT_ID, out: credFile })
      const steps = Object.fromEntries(reg.link.steps.map((s) => [s.id, s]))
      await owner.query(steps.principal.command.replace('<DIGEST FROM STEP 1>', m.digest))
      await owner.query(steps.grants.command)
      // + one owner-minted read grant: the conversation context of a thread (its own capability + read scope)
      await owner.query(`update action_gateway.agent_principals set read_scopes = array['conversation_context.read'] where agent_id = $1`, [AGENT_ID])
      await owner.query(`insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, granted_by, expires_at)
                         values ($1, $2, 'conversation.read_context', 1, '{}', '{}', 120, 2000, 0, $3, now() + interval '30 days')`, [ORG, AGENT_ID, CEO_USER])
      const b = await q1(owner, `select workforce.employee_bind_principal($1, $2, $3, $4, interval '2 hours', now() + interval '3 days') r`, [ORG, EMP, AGENT_ID, CEO_USER])
      const e = await q1(owner, 'select status, action_principal_id, link_expires_at, binding_valid_until from workforce.employee where org_id = $1 and employee_id = $2', [ORG, EMP])
      const grants = await qa(owner, 'select capability from action_gateway.capability_grants where agent_id = $1 order by capability', [AGENT_ID])
      return { gateway_token: { role: g.role, org: g.org, expires_at: g.expires_at, file_mode: (fs.statSync(gwJwtFile).mode & 0o777).toString(8) }, credential: { digest_prefix: m.digest.slice(0, 12), file_mode: m.mode },
        bind: b.r, employee: e, grants: grants.map((x) => x.capability), credFile }
    })
    const credential = fs.readFileSync(bound.credFile, 'utf8').trim()

    // ── 4. The REAL Action MCP (streamable-http, loopback, 0600 files) ───────────────────────────────────
    const auditFile = path.join(logs, 'action-mcp-audit.jsonl')
    const mcp = await R.step('4', 'Action MCP (bin/leadcommand-action-mcp.mjs), streamable-http on 127.0.0.1, Workforce on', async () => {
      const m = await S.startActionMcp({ repo: REPO, node: o.lcNode, orgId: ORG, dir: runDir, log: path.join(logs, 'action-mcp.log'), auditFile,
        files: { supabaseUrl: rest.shim, apiKey: anonKeyFile, gatewayJwt: gwJwtFile, pepper: pepperFile } })
      const audit = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const self = audit.find((a) => a.event === 'credential_self_check')
      return { url: m.url, self_check: self?.outcome ?? null, running_as: self?.running_as ?? null, boot: audit.find((a) => a.event === 'server_boot')?.transport ?? null }
    })

    // ── 5. Agntei headless + its own API: agent, connection (Bearer → secret store), grant, Link ─────────
    const claudeBin = path.join(runDir, 'scripted-claude')
    fs.writeFileSync(claudeBin, `#!/bin/sh\n# SCRIPTED AGENT wrapper (not Claude Code): the Agntei E2E's provider-CLI stand-in\nexec "${o.agnteiNode}" "${path.join(o.agnteiDir, 'scripts/leadcommand-e2e/scripted-agent.mjs')}" --state-dir "${state}" "$@"\n`, { mode: 0o700 })
    const agHome = path.join(runDir, 'agntei-home')
    const token = crypto.randomBytes(24).toString('base64url')
    const ag = await R.step('5a', 'Agntei server headless (temp data dir, isolated mode, session token)', async () => {
      const s = await S.startAgntei({ agnteiDir: o.agnteiDir, node: o.agnteiNode, home: agHome, token, claudeBin, log: path.join(logs, 'agntei.log') })
      return { url: s.url, home: agHome, isolated: true }
    })
    out.ids.agnteiUrl = ag.url
    out.ids.agnteiToken = token
    const A = agntei(ag.url, token)
    const setup = await R.step('5b', 'Agntei API: profile (scripted agent CLI) → agent → project → LeadCommand Workforce connection → one-agent grant → preapproved Workforce writes', async () => {
      const prof = await A.post('/api/profiles', { provider: 'claude-code', label: 'Scripted agent (E2E, not Claude Code)', billingMode: 'subscription' })
      const verified = await A.post(`/api/profiles/${prof.id}/verify`, {})
      const agent = await A.post('/api/agents', { name: 'Scout', role: 'researcher', accountId: prof.id, purpose: 'LeadCommand research analyst (E2E)', allowedRepos: [] })
      const project = await A.post('/api/projects', { name: 'Reivesti Acquisitions (E2E)', description: 'LeadCommand Workforce E2E', ownerKind: 'organization' })
      const conn = await A.post('/api/connections', { catalogId: 'leadcommand-workforce', url: mcp.url, token: credential })
      await A.put(`/api/connections/${conn.id}/access`, { scope: 'agent', scopeId: agent.id, maxTier: 'write' })
      await A.put(`/api/connections/${conn.id}/access`, { scope: 'project', scopeId: project.id, maxTier: 'write' })
      const pre = []
      for (const t of ['leadcommand_workforce_claim_assignment', 'leadcommand_workforce_report_progress', 'leadcommand_workforce_request_research', 'leadcommand_workforce_complete_assignment', 'leadcommand_workforce_handoff', 'leadcommand_workforce_whoami', 'leadcommand_workforce_list_assignments', 'leadcommand_workforce_get_mission', 'read_conversation_context']) {
        await A.post(`/api/connections/${conn.id}/policies`, { tool: t, decision: 'allow', agent: 'chat', note: 'E2E: the person preapproved the Workforce tools' })
        pre.push(t)
      }
      const view = (await A.get('/api/connections')).connections.find((c) => c.id === conn.id)
      const db = path.join(agHome, 'agent-command.db')
      return { profile: { id: prof.id, verification: verified.verification, state: verified.state }, agent: { id: agent.id, name: agent.name }, project: { id: project.id }, connection: { id: conn.id, state: view.state, tools: view.tools.length, url: view.url },
        preapproved: pre, token_in_db: fs.existsSync(db) ? fs.readFileSync(db).includes(Buffer.from(credential)) : null }
    })
    out.ids.agntei = { agent: setup.agent.id, project: setup.project.id, connection: setup.connection.id, profile: setup.profile.id }
    const CONN = setup.connection.id
    const link = await R.step('5c', 'Agntei Link: whoami → link_self → whoami (POST /api/leadcommand/:id/link)', async () => {
      const r = await A.post(`/api/leadcommand/${CONN}/link`, {})
      const lcRow = await q1(owner, 'select status, external_install_id, external_agent_id, external_linked_at, binding_valid_until from workforce.employee where org_id = $1 and employee_id = $2', [ORG, EMP])
      return { agntei: { link: r.link, check: r.check, identity: r.identity }, leadcommand: lcRow }
    })
    out.ids.install = link.agntei.link?.external_install_id

    // ── 6. The CEO directive, relayed from Agntei's composer route ──────────────────────────────────────
    ticker.start()
    const relay = await R.step('6', 'CEO directive relayed from Agntei (POST /api/leadcommand/:id/missions, assignToSelf)', async () => {
      const r = await A.post(`/api/leadcommand/${CONN}/missions`, { directive: DIRECTIVE, assignToSelf: true })
      return { mission: r.mission, data: r.data, callId: r.callId }
    })
    const MISSION = relay.mission?.id
    if (!MISSION) throw new Error('no mission id from the relay')
    out.ids.mission = MISSION

    // ── 7. The runtime tick: the COO plans; the research step goes to the Agntei employee (external) ────
    const planned = await R.step('7', 'Runtime tick: COO plans; the research step is assigned to the Agntei employee (external)', async () => {
      const a = await S.waitFor(async () => {
        const xs = await wf.listAssignments({ org_id: ORG, mission_id: MISSION, limit: 500 })
        return xs.find((x) => x.assignee_employee_id === EMP && x.capability_key === 'research.property' && x.status === 'ready') || null
      }, { timeoutMs: 240_000, intervalMs: 1000, what: 'the external research assignment (ready)' })
      const m = await wf.getMission({ org_id: ORG, mission_id: MISSION })
      const all = await wf.listAssignments({ org_id: ORG, mission_id: MISSION, limit: 500 })
      const skipped = await qa(owner, "select payload from workforce.event where mission_id = $1 and type = 'wf.mission.assign_to_self_skipped'", [MISSION])
      return { mission: { status: m.status, origin: m.origin, requested_by: m.requested_by, owner: m.owner_employee_id, plan_version: m.plan_version, intent: m.plan?.intent },
        assign_to_self: skipped.length ? { skipped: skipped[0].payload } : { applied: true },
        research: { assignment_id: a.assignment_id, step: a.step_key, assignee: a.assignee_employee_id, execution_mode: a.execution_mode, property_ref: a.input?.property_ref, status: a.status },
        assignments: all.map((x) => `${x.step_key}:${x.assignee_employee_id}:${x.execution_mode}:${x.status}`).sort() }
    })
    const AID = planned.research.assignment_id
    out.ids.assignment = AID

    // ── 8. Agntei launches the linked agent (the SCRIPTED AGENT) on it ───────────────────────────────────
    fs.writeFileSync(path.join(state, 'scenario.json'), JSON.stringify({ default: { plan: 'main' }, plans: { [AID]: { plan: 'main', salt: `r${o.run}` } }, poll_ms: 2000 }))
    const launched = await R.step('8', 'Agntei launches the linked agent (scripted) on the assignment: claim → reads → request_research → job → claim → complete (verified)', async () => {
      const l = await A.post(`/api/leadcommand/${CONN}/assignments/${AID}/launch`, { projectId: setup.project.id })
      const done = await S.waitFor(async () => {
        const a = await wf.getAssignment({ org_id: ORG, assignment_id: AID })
        const failed = transcriptOf(state).find((x) => x.type === 'failed' && x.aid === AID)
        if (failed) throw new Error(`the scripted agent stopped: ${failed.error}`)
        return a && ['completed', 'failed', 'cancelled'].includes(a.status) ? a : null
      }, { timeoutMs: 600_000, intervalMs: 1500, what: 'the external assignment to complete' })
      const tr = transcriptOf(state).filter((x) => x.aid === AID || x.type === 'credential_check')
      return { conversation: l.conversationId, launched: !l.reused, assignment: { status: done.status, outcome_class: done.outcome_class, attempt: done.attempt, evidence: done.evidence },
        calls: tr.filter((x) => x.type === 'call').map((x) => `${x.op} → ${x.code ?? (x.isError ? 'error' : 'ok')}`), credential_check: tr.find((x) => x.type === 'credential_check') }
    })
    out.ids.conversation = launched.conversation

    // ── 9. Tick until the COO's mission_review ───────────────────────────────────────────────────────────
    const reviewed = await R.step('9', 'Tick until the COO mission_review; the COO exec_message', async () => {
      const m = await S.waitFor(async () => {
        const x = await wf.getMission({ org_id: ORG, mission_id: MISSION })
        return ['completed', 'failed', 'cancelled'].includes(x.status) ? x : null
      }, { timeoutMs: 420_000, intervalMs: 1500, what: 'the mission to finish' })
      const msgs = (await wf.listExecMessages({ org_id: ORG, limit: 200 })).filter((x) => x.mission_id === MISSION).reverse()
      return { status: m.status, report_counts: m.report?.counts ?? null, coo_messages: msgs.filter((x) => x.author === 'coo').map((x) => x.content) }
    })

    // ── 10. The outcome from BOTH sides ──────────────────────────────────────────────────────────────────
    const both = await R.step('10', 'Outcome read from BOTH sides: Workforce API (missions/[id], command) and Agntei (GET /api/leadcommand, mission)', async () => {
      const lm = await lcGet.mission(MISSION)
      const lc = await lcGet.command()
      const ov = await A.get('/api/leadcommand?refresh=1')
      const am = await A.get(`/api/leadcommand/${CONN}/missions/${MISSION}?refresh=1`)
      out.agnteiViews.overview_completed = ov
      out.agnteiViews.mission = am
      const panel = ov.connections.find((c) => c.connection.id === CONN)
      const ev = (xs) => [...new Set((xs || []).map((e) => `${e.type ?? (e.job_id ? 'job' : '?')}:${e.id ?? e.job_id}:${e.resolved === true ? 'resolved' : 'unresolved'}`))].sort()
      const lcA = (lm.data?.data?.assignments || []).find((x) => x.assignment_id === AID)
      const agA = panel?.work?.value?.assignments?.find((x) => x.id === AID)
      const agMissionA = (am.value?.assignments || []).find((x) => x.assignment_id === AID)
      return {
        leadcommand: { http: lm.status, mission_id: lm.data?.data?.mission?.mission_id, status: lm.data?.data?.mission?.status, origin: lm.data?.data?.mission?.origin, assignment: lcA ? { status: lcA.status, outcome_class: lcA.outcome_class, evidence: ev(lcA.evidence) } : null, command_http: lc.status, command_messages: (lc.data?.data?.messages || []).filter((x) => x.mission_id === MISSION).length },
        agntei: { mission_id: am.value?.mission?.mission_id, status: am.value?.mission?.status, origin: am.value?.mission?.origin, visible_because: am.value?.visible_because, assignment_via_mission: agMissionA ? { status: agMissionA.status, outcome_class: agMissionA.outcome_class, evidence: ev(agMissionA.evidence) } : null,
          panel_assignment: agA ? { status: agA.status, state: agA.state, outcome: agA.output?.outcomeClass ?? null, evidence_links: agA.output?.evidence ?? [] } : null, link: panel?.link ? { employee: panel.link.lc_employee_id, valid_until: panel.link.valid_until } : null, identity: panel?.identity?.value ?? panel?.identity ?? null },
      }
    })

    // ── 11. Nothing seller-facing; $0 model spend ────────────────────────────────────────────────────────
    const safety = await R.step('11', 'No send_queue / offer / stage write; $0 model spend', async () => {
      const counts = await q1(owner, `select (select count(*) from public.send_queue)::int send_queue, (select count(*) from public.seller_offers)::int seller_offers,
        (select count(*) from public.followup_intents)::int followup_intents, (select count(*) from public.automation_holds where set_by like 'agent:%')::int agent_holds`)
      const after = await publicWrites()
      const stats = Object.entries(after).map(([t, v]) => ({ relname: t, ins: v.ins - (writesBefore[t]?.ins || 0), upd: v.upd - (writesBefore[t]?.upd || 0), del: v.del - (writesBefore[t]?.del || 0) })).filter((x) => x.ins || x.upd || x.del)
      const spend = await q1(owner, `select count(*)::int n, coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0)::float usd from agent.spend_ledger`)
      const jobs = await qa(owner, `select kind, state, count(*)::int n, coalesce(sum(cost_usd), 0)::float cost from agent.research_job group by 1, 2 order by 1, 2`).catch(async () => qa(owner, 'select kind, state, count(*)::int n from agent.research_job group by 1, 2 order by 1, 2'))
      const researchResults = await qa(owner, `select job_id, result -> 'web' ->> 'status' web, (result ->> 'cost_usd') cost from agent.research_job where kind = 'property.research'`)
      return { counts, table_writes: stats, spend, jobs, research_web: researchResults.map((r) => r.web), service_calls: serviceCalls }
    })
    out.safety = safety
    out.main = { planned, launched, reviewed, both, relay, link, setup, bound: { ...bound, credFile: '<0600 file>' }, reg: { status: reg.status, employee: reg.employee, executed: reg.executed, steps: reg.steps }, mcp, armed, rest: { postgrest: rest.postgrest, shim: rest.shim, version: rest.version } }

    // ── checks (main flow) ───────────────────────────────────────────────────────────────────────────────
    const C = (id, n, ok, d) => R.check(id, n, ok, d)
    C('A01', 'registration: pending_link, operator_ai, origin agntei, executed nothing', reg.employee.status === 'pending_link' && reg.employee.employment_type === 'operator_ai' && reg.employee.origin === 'agntei' && reg.executed === false, reg.employee)
    C('A02', 'credential + gateway JWT files are 0600', bound.credential.file_mode === '600' && bound.gateway_token.file_mode === '600', `${bound.credential.file_mode} ${bound.gateway_token.file_mode}`)
    C('A03', 'Action MCP booted only after the database self-check of lc_action_gateway', mcp.self_check === 'ok' && mcp.running_as === 'lc_action_gateway', mcp)
    C('A04', 'Agntei: the connection is Connected over a real MCP handshake; the Bearer is not in Agntei\'s database', setup.connection.state === 'connected' && setup.token_in_db === false, setup.connection)
    C('A05', 'Link: LeadCommand bound the Agntei install + agent; the employee is active', link.leadcommand.status === 'active' && link.leadcommand.external_agent_id === setup.agent.id && /^agntei_inst_[0-9a-f]{32}$/.test(link.leadcommand.external_install_id || ''), link.leadcommand)
    C('A06', 'Link: Agntei stored the link from whoami (employee id + binding_valid_until)', link.agntei.link?.lc_employee_id === EMP && link.agntei.check?.state === 'linked' && Number(link.agntei.link?.valid_until) === Date.parse(link.leadcommand.binding_valid_until), { link: link.agntei.link, lc_valid_until: link.leadcommand.binding_valid_until })
    C('A07', 'Relay: MISSION_OPENED with origin agntei, requested by the CEO user, owned by the COO', planned.mission.origin === 'agntei' && planned.mission.requested_by === CEO_USER && planned.mission.owner === 'emp_coo', planned.mission)
    C('A08', 'The COO planned opportunity_triage; the research step is the Agntei employee\'s, execution_mode external', planned.mission.intent === 'opportunity_triage' && planned.research.execution_mode === 'external' && planned.research.assignee === EMP, planned.research)
    const tr = transcriptOf(state)
    const mainCalls = tr.filter((x) => x.type === 'call' && x.aid === AID)
    const codes = mainCalls.map((x) => `${x.op}:${x.code}`)
    C('A09', 'The scripted agent called through Agntei: claim CLAIMED → request_research RESEARCH_REQUESTED → claim CLAIMED → complete ASSIGNMENT_COMPLETED', ['workforce_claim_assignment:CLAIMED', 'workforce_request_research:RESEARCH_REQUESTED', 'workforce_complete_assignment:ASSIGNMENT_COMPLETED'].every((c) => codes.includes(c)) && codes.filter((c) => c === 'workforce_claim_assignment:CLAIMED').length === 2, codes.join(', '))
    C('A10', 'It read permitted data: whoami, get_mission, list_assignments and read_conversation_context (a logged gateway read)', ['workforce_whoami', 'workforce_get_mission', 'workforce_list_assignments', 'read_conversation_context'].every((op) => mainCalls.some((x) => x.op === op && !x.isError)), mainCalls.filter((x) => /whoami|get_mission|read_conversation/.test(x.op)).map((x) => `${x.op}:${x.code ?? (x.isError ? 'error' : 'ok')}`).join(', '))
    C('A11', 'Completed verified with resolvable evidence (job + intent + thread)', launched.assignment.status === 'completed' && launched.assignment.outcome_class === 'verified' && (launched.assignment.evidence || []).filter((e) => e.resolved).length >= 2, (launched.assignment.evidence || []).map((e) => `${e.type}:${e.via ?? '-'}:${e.resolved}`).join(', '))
    C('A12', 'The scripted agent saw no LeadCommand credential (env, argv, MCP config, prompt)', tr.filter((x) => x.type === 'credential_check').every((x) => !x.found_lcag && !x.found_bearer_header), tr.filter((x) => x.type === 'credential_check').length + ' processes checked')
    C('A13', 'The mission completed; the COO wrote its report message', reviewed.status === 'completed' && reviewed.coo_messages.length >= 2, `${reviewed.status}; ${reviewed.coo_messages.length} COO messages`)
    C('A14', 'Both sides: the same mission id and status', both.leadcommand.mission_id === MISSION && both.agntei.mission_id === MISSION && both.leadcommand.status === both.agntei.status && both.agntei.status === 'completed', { lc: both.leadcommand.status, ag: both.agntei.status })
    C('A15', 'Both sides: the same assignment outcome and evidence refs', both.leadcommand.assignment && both.agntei.assignment_via_mission && both.leadcommand.assignment.status === both.agntei.assignment_via_mission.status && both.leadcommand.assignment.outcome_class === both.agntei.assignment_via_mission.outcome_class && JSON.stringify(both.leadcommand.assignment.evidence) === JSON.stringify(both.agntei.assignment_via_mission.evidence), { lc: both.leadcommand.assignment, ag: both.agntei.assignment_via_mission })
    C('A16', 'Agntei\'s panel shows the assignment Completed with LeadCommand\'s outcome class', both.agntei.panel_assignment?.state === 'completed', both.agntei.panel_assignment)
    C('A17', 'No send_queue / seller_offers / follow-up / agent hold row exists', Object.values(safety.counts).every((n) => n === 0), safety.counts)
    C('A18', 'No public.* table was written during the milestone (pg_stat inserts / updates / deletes after the synthetic seed: send_queue, seller_offers, acquisition_opportunities*, inbox_thread_state, deal_thread_state, system_control …)', safety.table_writes.length === 0, safety.table_writes.length ? safety.table_writes : 'every public table: 0 writes')
    C('A19', '$0 model spend: no spend-ledger commitment; property.research ran with web off (no ask service)', safety.spend.usd === 0 && safety.research_web.every((w) => /^skipped/.test(String(w))), { spend: safety.spend, web: safety.research_web })

    // ── the completed state, recorded from the real route handlers (the dashboard screenshots replay it) ────
    for (const g of ['overview', 'command', 'missions', 'employees', 'assignments', 'events', 'authority', 'kpis', 'reports']) await lcGet[g]()
    await lcGet.mission(MISSION)
    await lcGet.employee(EMP)
    out.recordedCompleted = JSON.parse(JSON.stringify(out.recorded))
    out.screens = []
    if (o.screens) {
      const ui = await import('./e2e-agntei/ui.mjs')
      const s1 = await ui.captureAgntei({ url: ag.url, token, outDir: o.outDir, name: 'agntei-1-linked-mission-completed', scrollTo: 'lcw-done' })
      out.screens.push({ id: 'agntei-linked-completed', ...s1 })
    }

    // ── the adversarial segment ──────────────────────────────────────────────────────────────────────────
    const ax = { R, o, out, owner, api, wf, rt, A, CONN, EMP, AGENT_ID, MISSION, setup, mcp, state, secrets, mint, runDir, logs, rest, pepperFile, anonKeyFile, jwtSecretFile, ORG, ORG_B, OWNER_B, CEO_USER, credential, routes, lcRoute, routeOpts, book, transcriptOf, agentStatuses, q1, qa }
    if (o.adversarial !== false) {
      const { runAdversarial, revokeScout } = await import('./e2e-agntei/adversarial.mjs')
      const ta = Date.now()
      out.adversarial = await runAdversarial(ax)
      out.adversarialMs = Date.now() - ta
      out.adversarial.push(await revokeScout(ax))
      if (o.screens) {
        const ui = await import('./e2e-agntei/ui.mjs')
        const s2 = await ui.captureAgntei({ url: ag.url, token, outDir: o.outDir, name: 'agntei-2-revoked' })
        out.screens.push({ id: 'agntei-revoked', ...s2 })
        await ui.closeBrowser()
      }
    }

    // ── final reads for the dashboard (recorded from the real route handlers) ────────────────────────────
    out.recorded = {}
    for (const g of ['overview', 'command', 'missions', 'employees', 'assignments', 'events', 'authority', 'kpis', 'reports']) await lcGet[g]()
    await lcGet.mission(MISSION)
    await lcGet.employee(EMP)
    out.transcript = transcriptOf(state)
    out.gatewayAudit = await qa(owner, 'select event_type, action, code from action_gateway.action_audit_events where agent_id = $1 order by event_id', [AGENT_ID])
    out.tick = { ...ticker.stats(), log: ticker.log.slice(-200) }
    out.missionRow = await wf.getMission({ org_id: ORG, mission_id: MISSION })
    out.assignments = await wf.listAssignments({ org_id: ORG, mission_id: MISSION, limit: 500 })

    // ── teardown of Agntei's secrets: every connection this run made is removed through Agntei's own API, which deletes
    // its Bearer from the OS keychain (isolated service); anything left is removed directly and the check says so
    const conns = (await A.get('/api/connections')).connections.filter((c) => c.catalogId === 'leadcommand-workforce').map((c) => c.id)
    for (const id of conns) await A.del(`/api/connections/${id}`).catch(() => {})
    const kc = 'agent-command.isolated'
    const left = conns.filter((id) => spawnSync('/usr/bin/security', ['find-generic-password', '-s', kc, '-a', `mcp-token:${id}`], { encoding: 'utf8' }).status === 0)
    for (const id of left) spawnSync('/usr/bin/security', ['delete-generic-password', '-s', kc, '-a', `mcp-token:${id}`])
    R.check('A20', 'Teardown: every LeadCommand connection removed through Agntei\'s API, its Bearer gone from the keychain (isolated service)', left.length === 0, `${conns.length} connection(s) removed; ${left.length} keychain item(s) had to be removed directly`)

  } finally {
    try { await ticker?.stop() } catch { /* ignore */ }
    for (const p of pools) await p.end().catch(() => {})
    try { await world?.owner?.end() } catch { /* ignore */ }
    try { await world?.api?.end() } catch { /* ignore */ }
    try { await world?.db?.pool?.end() } catch { /* ignore */ }
    await S.stopAll()
    out.stopped = { remaining: S.running() }
    // whatever happened above: no Bearer of this run stays in the OS keychain (the isolated service; this run's ids only)
    try {
      const db = path.join(runDir, 'agntei-home', 'agent-command.db')
      if (fs.existsSync(db)) {
        const ids = spawnSync('/usr/bin/sqlite3', [db, 'select id from connections'], { encoding: 'utf8' }).stdout.split('\n').filter((x) => /^conn_[0-9a-f]+$/.test(x))
        out.stopped.keychain_removed = ids.filter((id) => spawnSync('/usr/bin/security', ['delete-generic-password', '-s', 'agent-command.isolated', '-a', `mcp-token:${id}`]).status === 0).length
      }
    } catch { /* best effort */ }
  }
  out.steps = R.steps
  out.checks = R.checks
  out.timings = R.timings
  out.wallMs = Date.now() - t0
  out.structure = structureOf(out)
  out.fingerprint = sha(out.structure).slice(0, 16)
  return out
}

/** The deterministic part of a run (no ids, no times): two runs must produce the same object. */
export function structureOf(r) {
  return {
    steps: r.steps.map((s) => [s.id, s.ok]),
    checks: r.checks.map((c) => [c.id, c.ok]),
    main_calls: (r.transcript || []).filter((x) => x.type === 'call' && x.aid === r.ids.assignment).map((x) => `${x.op}:${x.code ?? (x.isError ? 'error' : 'ok')}`).filter((x) => !/list_assignments/.test(x) || true).reduce((a, x) => (a.at(-1) === x && /list_assignments:/.test(x) ? a : [...a, x]), []),
    assignments: (r.assignments || []).map((a) => `${a.step_key}:${a.assignee_employee_id}:${a.execution_mode}:${a.status}:${a.outcome_class ?? ''}`).sort(),
    mission: r.missionRow ? [r.missionRow.status, r.missionRow.origin, r.missionRow.plan?.intent] : null,
    adversarial: (r.adversarial || []).map((x) => [x.id, x.code ?? null, x.ok]),
    safety: r.safety ? { counts: r.safety.counts, spend_usd: r.safety.spend?.usd } : null,
  }
}

export { here as E2E_DIR, REPO as E2E_REPO }

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : process.argv.includes(`--${n}`) ? true : d }
  const need = (n) => { const v = arg(n); if (!v || v === true) { console.error(`--${n}=… is required`); process.exit(2) } return String(v) }
  const outDir = path.resolve(need('out'))
  const opts = {
    agnteiDir: path.resolve(need('agntei-dir')), agnteiNode: path.resolve(need('agntei-node')), pgBin: path.resolve(need('pg-bin')), postgrestBin: path.resolve(need('postgrest-bin')),
    lcNode: process.execPath, adversarial: arg('no-adversarial') !== true, outDir,
  }
  for (const [k, v] of Object.entries(opts)) if (typeof v === 'string' && !fs.existsSync(v)) { console.error(`${k}: ${v} does not exist`); process.exit(2) }
  const runs = Math.min(Math.max(Number(arg('runs', 1)) || 1, 1), 3)
  fs.mkdirSync(outDir, { recursive: true })
  const results = []
  const shutdown = async () => { await S.stopAll(); process.exit(130) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  for (let i = 1; i <= runs; i += 1) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `wfa-e2e-run${i}-`))
    console.log(`\n── run ${i}/${runs} (state ${runDir})`)
    let r
    try {
      r = await runMilestone({ ...opts, run: i, runDir, screens: arg('screens') === true && i === runs })
    } catch (e) {
      console.error(`run ${i} FAILED: ${e?.stack || e}`)
      process.exitCode = 1
      break
    }
    results.push(r)
    console.log(`  checks ${r.checks.filter((c) => c.ok).length}/${r.checks.length}; fingerprint ${r.fingerprint}; ${Math.round(r.wallMs / 1000)} s; remaining processes ${JSON.stringify(r.stopped.remaining)}`)
    for (const c of r.checks.filter((x) => !x.ok)) console.log(`  FAIL ${c.id} ${c.name}: ${c.detail.slice(0, 400)}`)
    fs.writeFileSync(path.join(outDir, `run-${i}.json`), JSON.stringify(r, null, 1))
    if (!arg('keep-state')) fs.rmSync(runDir, { recursive: true, force: true })
  }
  // the LeadCommand dashboard, from the LAST run's recorded responses (no live backend)
  let dashboard = null
  if (arg('screens') === true && results.length === runs) {
    const ui = await import('./e2e-agntei/ui.mjs')
    const last = results[results.length - 1]
    try {
      const d = await ui.startDashboard({ repo: REPO, node: process.execPath, log: path.join(outDir, 'dashboard-vite.log') })
      const title = last.missionRow?.title || ''
      const done = await ui.captureDashboard({ base: d.url, recorded: last.recordedCompleted, outDir, prefix: 'leadcommand-recorded', missionTitle: title })
      const revoked = await ui.captureDashboard({ base: d.url, recorded: last.recorded, outDir, prefix: 'leadcommand-recorded-after-revoke', missionTitle: title })
      dashboard = { url: d.url, completed: done, after_revoke: { files: revoked.files.filter((f) => /employee/.test(f)), served: revoked.served, errors: revoked.errors } }
      for (const f of revoked.files.filter((f) => !/employee/.test(f))) fs.rmSync(f, { force: true })
    } catch (e) { dashboard = { error: String(e?.stack || e).slice(0, 600) } }
    await ui.closeBrowser()
    await S.stopAll()
    last.dashboard = dashboard
  }
  if (results.length) {
    const { renderReport } = await import('./e2e-agntei/report.mjs')
    fs.writeFileSync(path.join(outDir, 'E2E-REPORT.md'), renderReport(results, { opts, outDir }))
    fs.writeFileSync(path.join(outDir, 'E2E-TRANSCRIPT.json'), JSON.stringify({ runs: results.map((r) => ({ run: r.run, fingerprint: r.fingerprint, structure: r.structure, steps: r.steps, checks: r.checks, timings: r.timings, ids: { ...r.ids, agnteiToken: '<redacted>' }, transcript: r.transcript, gatewayAudit: r.gatewayAudit, adversarial: r.adversarial, tick: r.tick })) }, null, 1))
    console.log(`\nreport → ${path.join(outDir, 'E2E-REPORT.md')}`)
  }
  const same = new Set(results.map((r) => r.fingerprint)).size === 1
  const allOk = results.length === runs && results.every((r) => r.checks.every((c) => c.ok))
  console.log(`${results.length}/${runs} run(s); fingerprints ${same ? 'identical' : 'DIFFER'}; all checks ${allOk ? 'PASS' : 'FAIL'}`)
  process.exit(allOk && same ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (e) => { console.error(e?.stack || e); await S.stopAll(); process.exit(1) })
}
