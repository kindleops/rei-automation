#!/usr/bin/env node
// CERTIFICATION — Sterling (a REAL Claude Code agent run by Agntei's REAL task runtime) performs an authorized internal
// Workforce write through the EXISTING LeadCommand Action Gateway, on a fully LOCAL, DISPOSABLE stack.
//
//   cd apps/api && node --import ./scripts/workforce/e2e-agntei/register.mjs scripts/workforce/cert-sterling-agntei.mjs \
//     --pg-bin=<pg17 bin dir> --agntei-dir=<agntei worktree> --out=<dir> [--claude-bin=<claude>] [--port=8766] [--keep-alive]
//
// Differences from the milestone E2E (e2e-agntei-milestone.mjs), each deliberate and reported:
//   • the agent is NOT the scripted stand-in: Agntei launches the real `claude` CLI (the host's existing Claude Code
//     sign-in, opted in with AGNTEI_ISOLATED_ALLOW_SHARED_LOGINS=1; no API key, no metered spend);
//   • Agntei is driven only through its EXISTING API (profile → agent → project → repo → connection → grants → tool
//     policies → ONE queued task). No chat is open; nobody approves anything mid-run;
//   • the Action MCP data path is the cert host (scripts/cert-pg-host.mjs: the real app behind the credential fence, the DB
//     reached as `authenticator` with role lc_action_gateway + the tenant claim) because the PostgREST macOS binary is
//     unsigned and was not run on this machine.
// Everything listens on 127.0.0.1. Nothing reaches production, a seller or a provider other than the model.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import * as S from './e2e-agntei/stack.mjs'
import { buildWorld } from './e2e-agntei/world.mjs'
import { e2eBook, researchSource, seedPublicRows } from './e2e-agntei/book.mjs'
import { MANUAL_THREAD, MANUAL_PID, FIXTURE_PIDS } from './e2e-agntei/adversarial.mjs'
import { DIRECTIVE, CEO_USER } from './e2e-agntei-milestone.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const API_DIR = path.resolve(here, '../..')
const REPO = path.resolve(API_DIR, '../..')
const ORG = '00000000-0000-4000-8000-00000000a001'
const EMP = 'emp_sterling_agntei'
const ENV = Object.freeze({ AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q1 = async (pool, sql, params = []) => (await pool.query(sql, params)).rows[0] || null
const qa = async (pool, sql, params = []) => (await pool.query(sql, params)).rows
const arg = (n, d = null) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : process.argv.includes(`--${n}`) ? true : d }

/** One cleanup for the normal end, an error and a signal: the Agntei connection (secret-store entry), the tick, every process. */
export const CLEANUP = {
  A: null, connId: null, ticker: null, done: false,
  async run() {
    if (this.done) return
    this.done = true
    if (this.ticker) await this.ticker.stop().catch(() => {})
    if (this.A && this.connId) await this.A.del(`/api/connections/${this.connId}`).catch(() => {})
    await S.stopAll()
  },
}

export function agntei(base, token) {
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'x-agentcmd-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (r.status >= 400) throw new Error(`Agntei ${method} ${p} → ${r.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`)
    return data
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}

/** Agntei headless with its own data dir, isolated; the REAL claude CLI with the host's own sign-in (explicit opt-in). */
export async function startAgnteiReal({ agnteiDir, node, home, token, claudeBin, log }) {
  const port = await S.freePort()
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const real = path.join(process.env.HOME || '', '.agent-command')
  if (path.resolve(home).startsWith(path.resolve(real))) throw new Error('refusing to run Agntei on ~/.agent-command')
  const env = {
    PATH: `${path.dirname(node)}:${path.dirname(claudeBin)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8',
    AGENT_COMMAND_HOME: home, AGENT_COMMAND_TOKEN: token, AGNTEI_ISOLATED: '1', AGNTAU_DISPOSABLE: '1', AGENT_COMMAND_CLAUDE_BIN: claudeBin, PORT: String(port),
    AGNTEI_ISOLATED_ALLOW_SHARED_LOGINS: '1', // the host's own Claude Code sign-in, on purpose (certification)
  }
  const rec = S.startProcess('agntei', node, [path.join(agnteiDir, 'node_modules/tsx/dist/cli.mjs'), 'apps/server/src/main.ts'], { cwd: agnteiDir, env, log })
  const url = `http://127.0.0.1:${port}`
  await S.waitFor(async () => {
    if (rec.exited) throw new Error(`Agntei exited (${JSON.stringify(rec.exited)}): ${fs.readFileSync(log, 'utf8').slice(-800)}`)
    const r = await fetch(`${url}/api/health`, { headers: { 'x-agentcmd-token': token } }).catch(() => null)
    if (r) await r.arrayBuffer().catch(() => {})
    return r && r.status === 200
  }, { what: 'the Agntei server', timeoutMs: 180_000, intervalMs: 500 })
  return { port, url, rec }
}

export async function startCertHost({ dbUrl, port, files, auditFile, log, dir }) {
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR || '/tmp', LC_CERT_DB_URL: dbUrl,
    LEADCOMMAND_ACTION_MCP_TRANSPORT: 'streamable-http', LEADCOMMAND_ACTION_MCP_HTTP_BIND: '127.0.0.1', LEADCOMMAND_ACTION_MCP_HTTP_PORT: String(port),
    LEADCOMMAND_ACTION_MCP_ORG_ID: ORG, LEADCOMMAND_ACTION_MCP_SUPABASE_URL: 'http://127.0.0.1:1', // unused: the data client is injected
    LEADCOMMAND_ACTION_MCP_API_KEY_FILE: files.apiKey, LEADCOMMAND_ACTION_MCP_GATEWAY_JWT_FILE: files.gatewayJwt, LEADCOMMAND_ACTION_MCP_PEPPER_FILE: files.pepper,
    LEADCOMMAND_ACTION_MCP_WORKFORCE_ENABLED: 'true', LEADCOMMAND_ACTION_MCP_AUDIT_FILE: auditFile, LEADCOMMAND_ACTION_MCP_WORKER_ID: 'cert-sterling',
  }
  const cwd = path.join(REPO, 'mcp/leadcommand-action-mcp')
  const rec = S.startProcess('action-mcp', process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/cert-pg-host.mjs'], { cwd, env, log })
  const url = `http://127.0.0.1:${port}/mcp`
  await S.waitFor(async () => {
    if (rec.exited) throw new Error(`the Action MCP exited (${JSON.stringify(rec.exited)}): ${fs.readFileSync(log, 'utf8').slice(-800)}`)
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }).catch(() => null)
    if (r) await r.arrayBuffer().catch(() => {})
    return r && r.status === 401
  }, { what: 'the Action MCP', timeoutMs: 90_000 })
  return { url, rec }
}

function sterlingPrompt({ installId, agentId }) {
  return `You are Sterling. In LeadCommand Workforce you hold the Research Analyst charter: you research properties the COO assigns to you. This is a CERTIFICATION run on a disposable, synthetic LeadCommand environment.

Use ONLY the LeadCommand tools whose names end in leadcommand_workforce_* (and leadcommand_read_conversation_context if you need it). Do not edit, create or delete any file in this repository, do not run shell commands, and never call any other LeadCommand tool. Nothing you do may contact a seller, make an offer, change a stage or launch a campaign.

Every write tool needs a fresh, unique client_request_id (8–80 characters, letters/digits/dashes), e.g. "sterling-link-1".

Procedure:
1. Call leadcommand_workforce_whoami. Then call leadcommand_workforce_link_self with external_install_id "${installId}" and external_agent_id "${agentId}". Call whoami again and confirm you are linked and active.
2. Call leadcommand_workforce_open_mission with the directive "${DIRECTIVE}" (do not set assign_to_self). Note the mission_id.
3. The COO plans the mission in the background and staffs it; research steps go to research analysts, possibly you. Call leadcommand_workforce_list_assignments (with that mission_id) until at least one assignment assigned to YOU is "ready". The other steps run first, so this can take a few minutes: keep checking (each check is one call), and stop waiting after about 10 minutes without one.
4. For EACH research assignment assigned to you, in turn:
   a. Claim it with leadcommand_workforce_claim_assignment (lease_seconds 900). Keep the returned attempt number: it is your claim_attempt.
   b. Call leadcommand_workforce_request_research for it (claim_attempt from a; pass property_id only if the assignment's input names one). Note the job_id.
   c. The research job runs in the background and then hands the assignment back to you. Call leadcommand_workforce_list_assignments until it is "ready" again, then claim it again (a NEW claim_attempt).
   d. Complete it with leadcommand_workforce_complete_assignment: outcome_class "verified", output { summary, findings[], next_steps[], recommendation } written ONLY from what the tools returned (the research result is in the assignment's output/input), and evidence [{ "type": "job", "id": <the job_id> }]. If something is missing from the tool results, say so in the summary.
   Never invent an id. If a tool refuses, do not work around it: note the code; if the assignment cannot be done, escalate it with leadcommand_workforce_escalate and move on.
5. When no assignment of yours is open, finish with a short report: the mission_id, each assignment_id with its job_id, the completion code and outcome_class each completion returned, and every refusal you received (with its code).`
}

export async function runCert(o) {
  const t0 = Date.now()
  const steps = []
  const checks = []
  const step = async (id, title, fn) => {
    const s = Date.now()
    process.stdout.write(`… ${id} ${title}\n`)
    try { const r = await fn(); steps.push({ id, title, ok: true, ms: Date.now() - s, evidence: r }); return r } catch (e) { steps.push({ id, title, ok: false, ms: Date.now() - s, error: String(e?.stack || e).slice(0, 1500) }); throw e }
  }
  const check = (id, name, ok, detail) => { checks.push({ id, name, ok: Boolean(ok), detail }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}\n`) }
  const runDir = o.out
  const logs = path.join(runDir, 'logs')
  const secrets = path.join(runDir, 'secrets')
  for (const d of [runDir, logs, secrets]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  const out = { started_at: new Date(t0).toISOString(), ids: {}, steps, checks }
  let ticker = null
  let A = null
  let connId = null
  try {
    // ── 1. disposable PostgreSQL + the REAL schema chain + synthetic book + arming (this database only) ──────────────
    const pgc = await step('1a', 'PostgreSQL 17 (own cluster, loopback)', async () => {
      const c = await S.startPg({ bin: o.pgBin, dir: path.join(runDir, 'pg'), log: path.join(logs, 'postgres.log') })
      return { port: c.port, admin_url: c.adminUrl, version: execFileSync(path.join(o.pgBin, 'postgres'), ['--version'], { encoding: 'utf8' }).trim() }
    })
    const world = await step('1b', 'The REAL schema chain (… → Action Gateway #26–#28 → Workforce → workforce_agntei)', async () => buildWorld({ adminUrl: pgc.admin_url, ownerUserId: CEO_USER, orgId: ORG, psqlBin: path.join(o.pgBin, 'psql') }))
    steps.at(-1).evidence = { database: world.name, files: world.applied }
    const owner = world.owner
    const api = world.api
    const book = e2eBook(Date.now())
    await seedPublicRows(owner, book, { manualThread: MANUAL_THREAD, manualPid: MANUAL_PID })
    await step('1c', 'Arm ONLY what this certification needs, on THIS database', async () => {
      const kinds = { 'workforce.coo_plan': 1, 'workforce.dispatch': 1, 'workforce.mission_review': 1, 'property.research': 2 }
      await owner.query(`update agent.runtime_limits set runtime_enabled = true, emergency_stop = false, emergency_stop_at = null, emergency_stop_reason = null, max_concurrency_global = 4, tick_max_jobs = 4,
          lease_seconds = 15, backoff_base_seconds = 5, kind_limits = $1::jsonb where id = 1`,
      [JSON.stringify(Object.fromEntries(Object.entries(kinds).map(([k, n]) => [k, { enabled: true, max_concurrency: n, armed_by: CEO_USER }])))])
      await owner.query(`insert into public.system_control (key, value) values ('action_gateway_enabled', 'true'), ('action_gateway_tiers', 'T1') on conflict (key) do update set value = excluded.value`)
      return { kinds: Object.keys(kinds), controls: await qa(owner, "select key, value from public.system_control where key like 'action_gateway%' order by key") }
    })
    const publicWrites = async () => {
      await sleep(1100)
      await owner.query('select pg_stat_clear_snapshot()')
      return Object.fromEntries((await qa(owner, `select relname, n_tup_ins::int ins, n_tup_upd::int upd, n_tup_del::int del from pg_stat_user_tables where schemaname = 'public' order by relname`)).map((r) => [r.relname, r]))
    }
    const writesBefore = await publicWrites()

    // ── 2. LeadCommand in this process: the REAL Workforce store, runtime, route handlers and engine handlers ────────
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
    const routeOpts = { env: ENV, auth: () => ({ ok: true }), identity: { authenticate: async () => ({ ok: true, identity: { user_id: CEO_USER, verified: true, named: true } }) }, limiter: createUserRateLimiter({ limits: resolveRateLimits({}) }), getServices: async () => svc }
    const { services } = syntheticServices(book, { now: Date.now() })
    const research = createPropertyResearchHandler({ source: researchSource(book, { extraIds: FIXTURE_PIDS }), reads, buildAsk: null, env: {}, now: () => Date.now() })
    const handlers = { ...buildWorkforceHandlers({ store: wf, runtimeStore: rt, reads, services, env: ENV, now: () => Date.now(), org_id: ORG }), 'property.research': research }
    const tickLog = []
    ticker = (() => {
      let stop = false; let running = null; let lastNudge = 0; let nudges = 0
      const loop = async () => {
        while (!stop) {
          try {
            const t = await runRuntimeTick({ store: rt, handlers, workerId: 'cert-runtime-tick', budgetMs: 25_000, now: () => Date.now() })
            if (t.claimed || t.reaped || t.errors?.length) tickLog.push({ at_ms: Date.now() - t0, jobs: t.jobs.map((j) => `${j.kind}:${j.outcome}`), errors: t.errors })
            if (!t.claimed) {
              if (Date.now() - lastNudge > 2000) { await enqueueWorkforceJob(rt, { kind: DISPATCH_KIND, key: ['cert-nudge', ++nudges], input: { reason: 'cert_nudge' }, requested_by: CEO_USER }).catch(() => {}); lastNudge = Date.now() }
              await sleep(700)
            }
          } catch (e) { tickLog.push({ at_ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200) }); await sleep(1000) }
        }
      }
      return { start() { if (!running) { stop = false; running = loop() } }, async stop() { stop = true; await running; running = null } }
    })()

    // ── 3. The CEO registers Sterling (real route), the owner mints + binds (real scripts, the registration's SQL) ────
    const reg = await step('3a', 'CEO registers Sterling as an Agntei employee: POST /employees {op: register_agntei}', async () => {
      const req = new Request('http://cert.local/api/cockpit/workforce/employees', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'register_agntei', employee: { employee_id: EMP, role_key: 'research_analyst', display_name: 'Sterling', markets: ['Dallas'], manager_employee_id: 'emp_head_data', employee_code: 'DAT-07' } }) })
      const res = await routes.handleEmployeeUpsert(req, routeOpts)
      const data = await res.json()
      if (res.status !== 201) throw new Error(`register_agntei → ${res.status} ${JSON.stringify(data).slice(0, 400)}`)
      return { status: res.status, employee: { id: data.data.employee.employee_id, status: data.data.employee.status, origin: data.data.employee.origin, employment_type: data.data.employee.employment_type, role: data.data.employee.role_key }, agent_id: data.data.link.agent_id, link: data.data.link }
    })
    const AGENT_ID = reg.agent_id
    out.ids.employee = EMP
    out.ids.principal = AGENT_ID
    const mcpDir = path.join(REPO, 'mcp/leadcommand-action-mcp')
    const jwtSecretFile = S.writeSecret(path.join(secrets, 'jwt-secret'), crypto.randomBytes(32).toString('hex'))
    const pepperFile = S.writeSecret(path.join(secrets, 'action-pepper'), crypto.randomBytes(32).toString('hex'))
    const anonKeyFile = S.writeSecret(path.join(secrets, 'anon-key'), S.hs256(crypto.randomBytes(16).toString('hex'), { role: 'anon', iss: 'supabase', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86_400 }))
    const gwJwtFile = path.join(secrets, 'lc_action_gateway.jwt')
    const credFile = path.join(secrets, `${AGENT_ID}.credential`)
    const nodeRun = (args) => { const r = spawnSync(process.execPath, args, { cwd: mcpDir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } }); if (r.status !== 0) throw new Error(`${args.join(' ')} → ${r.status}: ${(r.stderr || r.stdout).slice(0, 500)}`); return r.stdout }
    const bound = await step('3b', 'Owner: mint (real scripts) → principal + standing T1 grants (registration SQL) → employee_bind_principal', async () => {
      const g = JSON.parse(nodeRun(['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/mint-gateway-token.mjs', '--secret-file', jwtSecretFile, '--org', ORG, '--out', gwJwtFile, '--days', '1']).trim())
      const m = nodeRun(['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './src/loader/register.mjs', 'scripts/mint-agent-credential.mjs', '--pepper-file', pepperFile, '--agent-id', AGENT_ID, '--out', credFile])
      const digest = JSON.parse(m.split('\n')[0]).credential_digest
      const linkSteps = Object.fromEntries(reg.link.steps.map((s) => [s.id, s]))
      await owner.query(linkSteps.principal.command.replace('<DIGEST FROM STEP 1>', digest))
      await owner.query(linkSteps.grants.command)
      await owner.query(`update action_gateway.agent_principals set read_scopes = array['conversation_context.read'] where agent_id = $1`, [AGENT_ID])
      await owner.query(`insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, granted_by, expires_at)
                         values ($1, $2, 'conversation.read_context', 1, '{}', '{}', 120, 2000, 0, $3, now() + interval '30 days')`, [ORG, AGENT_ID, CEO_USER])
      const b = await q1(owner, `select workforce.employee_bind_principal($1, $2, $3, $4, interval '2 hours', now() + interval '1 day') r`, [ORG, EMP, AGENT_ID, CEO_USER])
      const grants = await qa(owner, `select capability, max_tier, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day::float, expires_at from action_gateway.capability_grants where agent_id = $1 order by capability`, [AGENT_ID])
      const principal = await q1(owner, 'select agent_id, display_name, tier_ceiling, sponsor_user_id, status, credential_expires_at from action_gateway.agent_principals where agent_id = $1', [AGENT_ID])
      return { gateway_token: { role: g.role, org: g.org, expires_at: g.expires_at }, credential: { digest_prefix: digest.slice(0, 12), file_mode: (fs.statSync(credFile).mode & 0o777).toString(8) }, principal, grants, bind: b.r }
    })
    const credential = fs.readFileSync(credFile, 'utf8').trim()

    // ── 4. The REAL Action MCP app (cert host), streamable-http on 127.0.0.1:<port>, Workforce on ────────────────────
    const auditFile = path.join(logs, 'action-mcp-audit.jsonl')
    const mcp = await step('4', `Action MCP (real app, credential fence) on 127.0.0.1:${o.port}`, async () => {
      const authUrl = `postgres://authenticator@127.0.0.1:${pgc.port}/${world.name}`
      const m = await startCertHost({ dbUrl: authUrl, port: o.port, files: { apiKey: anonKeyFile, gatewayJwt: gwJwtFile, pepper: pepperFile }, auditFile, log: path.join(logs, 'action-mcp.log'), dir: runDir })
      const audit = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      const self = audit.find((a) => a.event === 'credential_self_check')
      return { url: m.url, self_check: self?.outcome ?? null, running_as: self?.running_as ?? null }
    })

    // ── 5. Agntei headless (its own data dir) + its EXISTING API ────────────────────────────────────────────────────
    const agHome = path.join(runDir, 'agntei-home')
    const token = crypto.randomBytes(24).toString('base64url')
    const ag = await step('5a', 'Agntei engine headless (isolated data dir; the real claude CLI)', async () => {
      const s = await startAgnteiReal({ agnteiDir: o.agnteiDir, node: process.execPath, home: agHome, token, claudeBin: o.claudeBin, log: path.join(logs, 'agntei.log') })
      return { url: s.url, home: agHome, claude: execFileSync(o.claudeBin, ['--version'], { encoding: 'utf8' }).trim() }
    })
    A = agntei(ag.url, token); CLEANUP.A = A
    const installId = `agntei_inst_${crypto.createHash('sha256').update(`agntei-install:${agHome}`).digest('hex').slice(0, 32)}`
    const workspace = path.join(runDir, 'sterling-workspace')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Sterling certification workspace\n\nNothing here is meant to change. Sterling works through LeadCommand tools only.\n')
    const git = (...a) => execFileSync('git', a, { cwd: workspace, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'cert', GIT_AUTHOR_EMAIL: 'cert@localhost', GIT_COMMITTER_NAME: 'cert', GIT_COMMITTER_EMAIL: 'cert@localhost' } })
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'workspace')
    const WORKFORCE_TOOLS = ['whoami', 'link_self', 'list_assignments', 'get_mission', 'open_mission', 'claim_assignment', 'report_progress', 'request_research', 'complete_assignment', 'handoff', 'escalate'].map((t) => `leadcommand_workforce_${t}`)
    const setup = await step('5b', 'Agntei API: Claude Code profile (subscription, verified) → agent Sterling → project + repo → connection (Bearer → secret store) → grants (Sterling + project only) → tool policies', async () => {
      // kind legacy = Claude Code's default sign-in on this computer, allowed in this
      // isolated engine only because AGNTEI_ISOLATED_ALLOW_SHARED_LOGINS=1 was set on purpose. A managed profile would get
      // its own empty folder and start signed out.
      const prof = await A.post('/api/profiles', { provider: 'claude-code', label: 'Claude Code (host sign-in, certification)', billingMode: 'subscription', kind: 'legacy' })
      const verified = await A.post(`/api/profiles/${prof.id}/verify`, {})
      if (verified.verification !== 'verified') throw new Error(`the Claude Code profile is not verified (${verified.state} / ${verified.verification}): ${verified.detail ?? ''}`)
      const project = await A.post('/api/projects', { name: 'Reivesti Acquisitions (certification)', description: 'Disposable LeadCommand certification', ownerKind: 'organization' })
      const repo = await A.post('/api/repos', { path: workspace, projectId: project.id })
      await A.put(`/api/profiles/${prof.id}/projects/${repo.id}`, {}).catch(() => null) // a legacy profile already covers every workspace
      const agent = await A.post('/api/agents', { name: 'Sterling', role: 'acquisitions', accountId: prof.id, allowedRepos: [repo.id], purpose: 'Acquisitions agent: finds and researches seller opportunities through LeadCommand (certification)' })
      const other = await A.post('/api/agents', { name: 'Equity', role: 'underwriting', accountId: prof.id, allowedRepos: [repo.id], purpose: 'Control agent: must NOT get the Sterling connection' })
      const conn = await A.post('/api/connections', { url: mcp.url, label: 'LeadCommand Actions (cert) - Sterling', token: credential })
      connId = conn.id; CLEANUP.connId = conn.id
      await A.put(`/api/connections/${conn.id}/access`, { scope: 'agent', scopeId: agent.id, maxTier: 'write' })
      await A.put(`/api/connections/${conn.id}/access`, { scope: 'project', scopeId: project.id, maxTier: 'write' })
      const policies = []
      for (const t of [...WORKFORCE_TOOLS, 'read_conversation_context']) {
        const r = await A.post(`/api/connections/${conn.id}/policies`, { tool: t, decision: 'allow', agent: 'claude-code', note: 'Certification: the operator preapproved Sterling\'s internal Workforce tools' }).then(() => 'allow').catch((e) => `refused: ${String(e.message).slice(0, 120)}`)
        policies.push(`${t}:${r}`)
      }
      const view = (await A.get('/api/connections')).connections.find((c) => c.id === conn.id)
      const access = await A.get(`/api/connections/${conn.id}/access`)
      const dbFile = path.join(agHome, 'agent-command.db')
      const repoId = repo.id
      return { profile: { id: prof.id, verification: verified.verification, state: verified.state }, agent: { id: agent.id, name: agent.name }, control_agent: { id: other.id, name: other.name }, project: { id: project.id }, repoId,
        connection: { id: conn.id, state: view?.state, tools: view?.tools?.length ?? null, url: view?.url }, access, policies, token_in_agntei_db: fs.existsSync(dbFile) ? fs.readFileSync(dbFile).includes(Buffer.from(credential)) : null }
    })
    out.ids.agntei = { agent: setup.agent.id, control_agent: setup.control_agent.id, project: setup.project.id, connection: setup.connection.id, install_id: installId }
    let repoId = setup.repoId
    if (!repoId) { const repos = await A.get('/api/repos'); repoId = (Array.isArray(repos) ? repos : repos.repos || []).find((r) => path.resolve(r.path) === path.resolve(workspace))?.id }
    if (!repoId) throw new Error('could not resolve the workspace repo id')

    // row-level write counters of the schemas the gateway / Workforce / runtime own (genuine mutations, not just responses)
    const schemaWrites = async () => {
      await sleep(1100)
      await owner.query('select pg_stat_clear_snapshot()')
      return Object.fromEntries((await qa(owner, `select schemaname || '.' || relname t, n_tup_ins::int ins, n_tup_upd::int upd, n_tup_del::int del from pg_stat_user_tables where schemaname in ('workforce', 'action_gateway', 'agent')`)).map((r) => [r.t, r]))
    }
    const schemaBefore = await schemaWrites()

    // ── 6. ONE queued task for Sterling. No chat; nobody approves anything during the run ───────────────────────────
    CLEANUP.ticker = ticker; ticker.start()
    const task = await step('6', 'Agntei: queue ONE task for Sterling (no chat open; the runtime runs it)', async () => {
      const t = await A.post('/api/tasks', { repoId, title: 'Certification: open, research and complete an acquisition mission through LeadCommand', prompt: sterlingPrompt({ installId, agentId: setup.agent.id }), agentId: setup.agent.id })
      return { id: t.id, status: t.status, agent: t.agent_id ?? t.agentId }
    })
    out.ids.task = task.id
    const done = await step('7', 'Wait for Sterling\'s run to end (runtime + COO + research job run in the background)', async () => {
      const r = await S.waitFor(async () => {
        const x = await A.get(`/api/tasks/${task.id}`)
        const st = x.task.status
        return ['review', 'done', 'failed', 'cancelled', 'merged', 'blocked', 'needs_approval', 'approval'].includes(st) || (x.approvals || []).some((a) => a.status === 'pending') ? x : null
      }, { timeoutMs: o.timeoutMs, intervalMs: 3000, what: 'Sterling\'s task to finish' })
      return { status: r.task.status, runs: r.runs.map((x) => ({ id: x.id, status: x.status, started_at: x.started_at, ended_at: x.finished_at ?? x.ended_at ?? null, cost_usd: x.cost_usd ?? null, provider: x.provider ?? null, model: x.model ?? null })), pending_approvals: (r.approvals || []).filter((a) => a.status === 'pending').map((a) => ({ kind: a.kind, title: a.title ?? null })), event_types: Object.entries(r.events.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] || 0) + 1 }), {})) }
    })
    const taskFull = await A.get(`/api/tasks/${task.id}`)
    const finalText = taskFull.events.filter((e) => /result|message|summary|final/i.test(e.type)).map((e) => e.message || e.summary || '').filter(Boolean).slice(-3)

    // ── 8. Evidence from BOTH sides ─────────────────────────────────────────────────────────────────────────────────
    await sleep(3000)
    const calls = (await A.get(`/api/connections/${connId}/calls`))
    const callRows = (Array.isArray(calls) ? calls : calls.calls || []).map((c) => ({ tool: c.tool, status: c.status, risk: c.risk, task_id: c.task_id ?? c.taskId ?? null, run_id: c.run_id ?? c.runId ?? null, actor: c.actor ?? null, client_request_id: (() => { try { const a = typeof c.args === 'string' ? JSON.parse(c.args) : (c.args ?? JSON.parse(c.args_json || '{}')); return a?.client_request_id ?? null } catch { return null } })(), at: c.startedAt ? new Date(c.startedAt).toISOString() : null, started_ms: c.startedAt ?? null, finished_ms: c.finishedAt ?? null }))
    // ONE row per gateway intent of Sterling's principal: the intent, its immutable authorization, the standing grant that
    // authorized it, its outcome and its audit trail (all keyed by the intent; the client_request_id is the intent's client_key)
    const intents = await qa(owner, `select i.intent_id, i.action, i.capability, i.agent_id, i.client_key as client_request_id, i.state, i.result_code,
        (extract(epoch from i.created_at) * 1000)::bigint created_ms, (extract(epoch from i.finished_at) * 1000)::bigint finished_ms,
        a.authorization_id, a.grant_id, a.grant_id is not null as by_grant, a.tier, a.sponsor_user_id, a.approval_required, a.spend_usd::float, (extract(epoch from a.decided_at) * 1000)::bigint authorized_ms,
        g.agent_id grant_agent, g.capability grant_capability, g.grant_version, g.max_uses_per_hour, g.max_uses_per_day, g.max_spend_usd_per_day::float, g.expires_at grant_expires_at, g.revoked_at grant_revoked_at,
        o.outcome_id, o.status outcome_status, o.code as outcome_code, (extract(epoch from o.recorded_at) * 1000)::bigint outcome_ms,
        (select array_agg(e.event_type order by e.event_id) from action_gateway.action_audit_events e where e.intent_id = i.intent_id) audit
      from action_gateway.action_intents i
      left join action_gateway.action_authorizations a on a.intent_id = i.intent_id
      left join action_gateway.capability_grants g on g.grant_id = a.grant_id
      left join action_gateway.action_outcomes o on o.intent_id = i.intent_id
      where i.agent_id = $1 order by i.created_at`, [AGENT_ID]).catch(async (e) => [{ error: String(e.message) }])
    const auditCounts = await qa(owner, `select event_type, count(*)::int n from action_gateway.action_audit_events where agent_id = $1 group by 1 order by 1`, [AGENT_ID]).catch((e) => [{ error: String(e.message) }])
    const employee = await q1(owner, 'select status, external_install_id, external_agent_id, external_linked_at, action_principal_id from workforce.employee where org_id = $1 and employee_id = $2', [ORG, EMP])
    const missions = await qa(owner, `select mission_id, status, origin, requested_by, owner_employee_id, title from workforce.mission where org_id = $1 and origin = 'agntei' order by created_at`, [ORG])
    const MISSION = missions[0]?.mission_id ?? null
    const assignments = MISSION ? await qa(owner, `select assignment_id, step_key, capability_key, assignee_employee_id, execution_mode, status, outcome_class, attempt, evidence from workforce.assignment where org_id = $1 and mission_id = $2 order by created_at`, [ORG, MISSION]) : []
    const mine = assignments.find((x) => x.assignee_employee_id === EMP) || null
    const events = MISSION ? await qa(owner, `select type, employee_id, at from workforce.event where org_id = $1 and mission_id = $2 order by at`, [ORG, MISSION]) : []
    const jobs = await qa(owner, `select job_id, kind, state, requested_by, created_at, ended_at from agent.research_job order by created_at`)
    if (MISSION) {
      await S.waitFor(async () => ['completed', 'failed', 'cancelled'].includes((await q1(owner, 'select status from workforce.mission where mission_id = $1', [MISSION]))?.status), { timeoutMs: 240_000, intervalMs: 1500, what: 'the COO mission_review' }).catch(() => null)
    }
    const missionFinal = MISSION ? await q1(owner, 'select status, report is not null as has_report from workforce.mission where mission_id = $1', [MISSION]) : null
    const coo = MISSION ? (await qa(owner, `select author, left(content, 400) content from workforce.exec_message where org_id = $1 and mission_id = $2 order by created_at`, [ORG, MISSION]).catch(() => [])) : []
    const counts = await q1(owner, `select (select count(*) from public.send_queue)::int send_queue, (select count(*) from public.seller_offers)::int seller_offers, (select count(*) from public.followup_intents)::int followup_intents, (select count(*) from public.automation_holds where set_by like 'agent:%')::int agent_holds`)
    const after = await publicWrites()
    const tableWrites = Object.entries(after).map(([t, v]) => ({ relname: t, ins: v.ins - (writesBefore[t]?.ins || 0), upd: v.upd - (writesBefore[t]?.upd || 0), del: v.del - (writesBefore[t]?.del || 0) })).filter((x) => x.ins || x.upd || x.del)
    const mcpAudit = fs.readFileSync(auditFile, 'utf8')
    const agnteiDb = path.join(agHome, 'agent-command.db')
    Object.assign(out, { reg: { status: reg.status, employee: reg.employee }, bound, mcp, setup, task, done, finalText, agntei_calls: callRows, gateway: { intents, audit: auditCounts }, workforce: { employee, missions, mission_final: missionFinal, assignments, events: events.map((e) => e.type), coo_messages: coo }, jobs, safety: { counts, table_writes: tableWrites }, ticks: tickLog.slice(-60) })

    // ── 9. Checks ───────────────────────────────────────────────────────────────────────────────────────────────────
    const writeIntents = Array.isArray(intents) ? intents.filter((i) => !i.error) : []
    const gwCodes = writeIntents.map((i) => `${i.action}:${i.outcome_code ?? i.state}`)
    check('C01', 'Action MCP booted only after the database self-check as lc_action_gateway', mcp.self_check === 'ok' && mcp.running_as === 'lc_action_gateway', mcp)
    check('C02', 'Agntei profile verified (real Claude Code, subscription sign-in; no API key)', setup.profile.verification === 'verified', setup.profile)
    check('C03', 'The connection is Connected over a real MCP handshake and its Bearer is not in Agntei\'s database', setup.connection.state === 'connected' && setup.token_in_agntei_db === false, setup.connection)
    check('C04', 'Access: the connection is granted to Sterling and the project only (the control agent Equity has no grant)', JSON.stringify(setup.access).includes(setup.agent.id) && !JSON.stringify(setup.access).includes(setup.control_agent.id), setup.access)
    check('C05', 'Sterling\'s run ended without a person approving anything mid-run (no pending approval)', done.pending_approvals.length === 0 && ['review', 'done'].includes(done.status), { status: done.status, pending: done.pending_approvals })
    check('C06', 'Agntei recorded Sterling\'s LeadCommand calls against THIS task', callRows.length > 0 && callRows.every((c) => !c.task_id || c.task_id === task.id), callRows.map((c) => `${c.tool}:${c.status}`))
    check('C07', 'LeadCommand linked Sterling: active, bound to THIS Agntei install + agent', employee?.status === 'active' && employee?.external_agent_id === setup.agent.id && employee?.external_install_id === installId, employee)
    check('C08', 'A mission was opened from Agntei (origin agntei), requested by the CEO user, owned by the COO', missions.length >= 1 && missions[0].origin === 'agntei' && missions[0].requested_by === CEO_USER && missions[0].owner_employee_id === 'emp_coo', missions)
    const mineAll = assignments.filter((x) => x.assignee_employee_id === EMP)
    check('C09', 'EVERY assignment staffed to Sterling completed VERIFIED with resolvable evidence', mineAll.length > 0 && mineAll.every((m) => m.status === 'completed' && m.outcome_class === 'verified' && (m.evidence || []).some((e) => e.resolved)), mineAll.map((m) => ({ step: m.step_key, status: m.status, outcome_class: m.outcome_class, evidence: (m.evidence || []).map((e) => `${e.type}:${e.via ?? '-'}:${e.resolved}`) })))
    check('C10', 'A real property.research job ran to completion for it', jobs.some((j) => j.kind === 'property.research' && ['succeeded', 'completed', 'done'].includes(j.state)), jobs.map((j) => `${j.kind}:${j.state}`))
    check('C11', 'Every gateway write was authorized by a standing grant, attributed to Sterling\'s principal', writeIntents.length > 0 && writeIntents.filter((i) => i.state === 'succeeded').every((i) => i.by_grant), gwCodes)
    const runId = done.runs[0]?.id ?? null
    const AUDIT_CHAIN = ['intent_opened', 'authorized', 'claimed', 'intent_succeeded']
    const correlation = writeIntents.map((i) => {
      const c = callRows.find((x) => x.client_request_id === i.client_request_id && x.tool === `leadcommand_${i.action}`) || null
      return { client_request_id: i.client_request_id, action: i.action, agntei_call: c && { tool: c.tool, status: c.status, task_id: c.task_id, run_id: c.run_id, actor: c.actor }, intent_id: i.intent_id, authorization_id: i.authorization_id, grant_id: i.grant_id, outcome: i.outcome_code, audit: i.audit,
        ok: !!c && c.status === 'ok' && c.task_id === task.id && c.run_id === runId && !!i.authorization_id && !!i.grant_id && !!i.outcome_id && i.outcome_status === 'succeeded' && AUDIT_CHAIN.every((ev) => (i.audit || []).includes(ev)) }
    })
    const agnteiWrites = callRows.filter((c) => c.client_request_id)
    out.correlation = correlation
    check('C12', 'Agntei\'s recorded MCP call arguments ↔ LeadCommand intent + authorization (grant) + outcome + audit chain: the SAME client_request_id, both directions, same task + run', correlation.length > 0 && correlation.every((x) => x.ok) && agnteiWrites.every((c) => writeIntents.some((i) => i.client_request_id === c.client_request_id)), correlation.map((x) => `${x.client_request_id} → ${x.ok ? 'ok' : 'BROKEN'} (${x.action}:${x.outcome}; grant ${String(x.grant_id).slice(0, 8)}; audit ${(x.audit || []).join('>')})`))
    check('C13', 'No credential in the Action MCP audit file or in Agntei\'s database', !mcpAudit.includes(credential) && !(fs.existsSync(agnteiDb) && fs.readFileSync(agnteiDb).includes(Buffer.from(credential))), 'searched')
    check('C14', 'Nothing seller-facing: no send_queue / offer / follow-up / agent hold row; no public.* table written', Object.values(counts).every((n) => n === 0) && tableWrites.length === 0, { counts, tableWrites })
    check('C15', 'The COO completed the mission review', missionFinal?.status === 'completed', missionFinal)

    // ── 10. Evidence (E): identity, scope, grants, timestamps, genuine mutations, the real runtime, exposure, isolation ──
    const okIntents = writeIntents.filter((i) => i.state === 'succeeded')
    check('E01', 'Identity chain: Agntei agent → LeadCommand employee → gateway principal → every intent / authorization / grant; sponsor = the CEO user; tier 1',
      employee?.external_agent_id === setup.agent.id && employee?.action_principal_id === AGENT_ID && okIntents.every((i) => i.agent_id === AGENT_ID && i.grant_agent === AGENT_ID && i.grant_capability === i.capability && i.sponsor_user_id === CEO_USER && i.tier === 1),
      { agntei_agent: setup.agent.id, employee: EMP, principal: AGENT_ID, sponsor: CEO_USER, per_intent: okIntents.map((i) => `${i.action}: ${i.capability} grant v${i.grant_version} (${i.max_uses_per_hour}/h, ${i.max_uses_per_day}/d, $${i.max_spend_usd_per_day}/d)`) })
    const access = setup.access || []
    check('E02', 'Project scope: the task ran in the granted project\'s repository; the connection\'s access is EXACTLY {agent Sterling, project}',
      taskFull.task.repo_id === repoId && taskFull.task.agent_id === setup.agent.id && access.length === 2 && access.some((g) => g.scope === 'agent' && g.scopeId === setup.agent.id) && access.some((g) => g.scope === 'project' && g.scopeId === setup.project.id),
      { task: task.id, repo: taskFull.task.repo_id, project: setup.project.id, access: access.map((g) => `${g.scope}:${g.scopeId}:${g.maxTier}`) })
    check('E03', 'Standing grants: each authorization used a live (unrevoked, unexpired) grant; no per-use approval; spend within the grant cap',
      okIntents.every((i) => !i.grant_revoked_at && new Date(i.grant_expires_at) > new Date() && i.approval_required === false && (i.spend_usd ?? 0) <= (i.max_spend_usd_per_day ?? 0)),
      okIntents.map((i) => `${i.action}: grant ${String(i.grant_id).slice(0, 8)} expires ${new Date(i.grant_expires_at).toISOString()} spend $${i.spend_usd ?? 0}`))
    const TOL = 1500
    const timeline = correlation.map((x) => {
      const i = writeIntents.find((y) => y.intent_id === x.intent_id); const c = callRows.find((y) => y.client_request_id === x.client_request_id && y.tool === `leadcommand_${x.action}`)
      return { key: x.client_request_id, call_started: c?.started_ms, intent: Number(i.created_ms), authorized: Number(i.authorized_ms), outcome: Number(i.outcome_ms), call_finished: c?.finished_ms }
    })
    const run0 = done.runs[0]
    check('E04', 'Execution timestamps are causally ordered: Agntei call start ≤ intent ≤ authorization ≤ outcome ≤ call end, all inside Sterling\'s run',
      timeline.length > 0 && timeline.every((t) => t.call_started - TOL <= t.intent && t.intent <= t.authorized && t.authorized <= t.outcome && (!t.call_finished || t.outcome <= t.call_finished + TOL) && t.call_started >= run0.started_at - TOL && (!run0.ended_at || t.outcome <= run0.ended_at + TOL)),
      { run: { id: run0.id, started: new Date(run0.started_at).toISOString(), ended: run0.ended_at ? new Date(run0.ended_at).toISOString() : null }, mission: MISSION, task: task.id, timeline: timeline.map((t) => ({ ...t, call_started: new Date(t.call_started).toISOString(), outcome: new Date(t.outcome).toISOString() })) })
    const schemaAfter = await schemaWrites()
    const delta = (t, k) => (schemaAfter[t]?.[k] || 0) - (schemaBefore[t]?.[k] || 0)
    const researchIntent = okIntents.find((i) => i.action === 'workforce_request_research')
    const evJob = mineAll.flatMap((m) => m.evidence || []).find((e) => e.type === 'job' && e.resolved)
    const jobRow = evJob ? await q1(owner, `select job_id, kind, state, requested_by, ended_at is not null ended, result is not null has_result, length(result::text) result_bytes from agent.research_job j where job_id = $1`, [evJob.id]) : null
    // the gateway links the job to Sterling's request_research intent through the intent's OUTCOME (finish_intent … RESEARCH_REQUESTED {job_id})
    // and the assignment's runtime_job_id (workforce.assignment_wait_job), not by writing the intent id into the job
    const researchOutcome = researchIntent ? await q1(owner, `select code, result ->> 'job_id' job_id from action_gateway.action_outcomes where intent_id = $1`, [researchIntent.intent_id]) : null
    const assignmentJob = mineAll[0] ? await q1(owner, 'select runtime_job_id from workforce.assignment where assignment_id = $1', [mineAll[0].assignment_id]) : null
    if (jobRow) Object.assign(jobRow, { intent_outcome_job: researchOutcome?.job_id ?? null, assignment_runtime_job: assignmentJob?.runtime_job_id ?? null, carries_intent: !!researchOutcome && researchOutcome.code === 'RESEARCH_REQUESTED' && researchOutcome.job_id === jobRow.job_id })
    const mutations = { 'action_gateway.action_intents': delta('action_gateway.action_intents', 'ins'), 'action_gateway.action_authorizations': delta('action_gateway.action_authorizations', 'ins'), 'action_gateway.action_outcomes': delta('action_gateway.action_outcomes', 'ins'),
      'action_gateway.action_audit_events': delta('action_gateway.action_audit_events', 'ins'), 'workforce.employee(upd)': delta('workforce.employee', 'upd'), 'workforce.mission': delta('workforce.mission', 'ins'), 'workforce.assignment': delta('workforce.assignment', 'ins'), 'workforce.assignment(upd)': delta('workforce.assignment', 'upd'), 'agent.research_job': delta('agent.research_job', 'ins') }
    check('E05', 'Genuine database mutations (pg_stat row counters + the rows themselves): intents/authorizations/outcomes/audit inserted; employee linked; mission + assignments written; the evidence job is a completed property.research row with a result, created by Sterling\'s request_research intent',
      mutations['action_gateway.action_intents'] >= okIntents.length && mutations['action_gateway.action_authorizations'] >= okIntents.length && mutations['action_gateway.action_outcomes'] >= okIntents.length && mutations['action_gateway.action_audit_events'] >= okIntents.length * 4 && mutations['workforce.employee(upd)'] >= 1 && mutations['workforce.mission'] >= 1 && mutations['workforce.assignment'] >= 1 && mutations['agent.research_job'] >= 1 &&
        jobRow?.kind === 'property.research' && jobRow?.state === 'completed' && jobRow?.ended && jobRow?.has_result && jobRow?.carries_intent,
      { mutations, job: jobRow, research_intent: researchIntent?.intent_id })
    const { DatabaseSync } = await import('node:sqlite')
    const adb = new DatabaseSync(path.join(agHome, 'agent-command.db'), { readOnly: true })
    const runRow = adb.prepare('select id, status, provider, billing_mode, session_id, executable, served_model, input_tokens, output_tokens, cwd, started_at, finished_at from runs where id = ?').get(run0.id)
    adb.close()
    const claudeReal = fs.realpathSync(o.claudeBin)
    const projDir = path.join(process.env.HOME, '.claude/projects', String(runRow?.cwd || '').replace(/[^A-Za-z0-9]/g, '-'))
    const transcript = runRow?.session_id ? path.join(projDir, `${runRow.session_id}.jsonl`) : null
    const tx = transcript && fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8') : ''
    out.runtime = { run: runRow, claude_bin: claudeReal, transcript: transcript && fs.existsSync(transcript) ? transcript : null }
    check('E06', 'The REAL configured Agntei runtime, not a stand-in: Agntei spawned the real claude binary on the subscription profile; Claude Code\'s own session transcript holds the LeadCommand tool calls',
      runRow?.provider === 'claude-code' && runRow?.billing_mode === 'subscription' && fs.realpathSync(runRow.executable) === claudeReal && !/scripted/i.test(runRow.executable) && !!runRow.session_id && runRow.output_tokens > 0 && !!runRow.served_model &&
        tx.includes('leadcommand_workforce_complete_assignment') && tx.includes('leadcommand_workforce_request_research'),
      { executable: runRow?.executable, real: claudeReal, model: runRow?.served_model, session: runRow?.session_id, tokens: { in: runRow?.input_tokens, out: runRow?.output_tokens }, transcript: out.runtime.transcript })
    const scan = (dir, skip) => { const hits = []; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (skip.some((s) => p.startsWith(s))) continue; if (f.isDirectory()) walk(p); else if (f.isFile() && fs.statSync(p).size < 200_000_000) { if (fs.readFileSync(p).includes(Buffer.from(credential))) hits.push(path.relative(runDir, p)) } } }; walk(dir); return hits }
    const hits = scan(runDir, [secrets, path.join(runDir, 'pg')])
    if (tx.includes(credential)) hits.push('claude transcript')
    check('E07', 'Credential exposure: Sterling\'s lcag_ credential appears NOWHERE but its 0600 secret file (Agntei DB, every log, the audit file, the workspace, Claude\'s transcript)', hits.length === 0, hits.length ? hits : 'scanned the run directory (except secrets/ and the cluster) and the transcript')
    const loop = [mcp.url, ag.url, pgc.admin_url].every((u) => ['127.0.0.1', 'localhost'].includes(new URL(u).hostname))
    check('E08', 'Isolation: every endpoint is loopback; the database is the run\'s own disposable cluster; no production host anywhere in the run', loop && /^postgres:\/\/postgres@127\.0\.0\.1:\d+\/postgres$/.test(pgc.admin_url) && !fs.readFileSync(path.join(logs, 'action-mcp.log'), 'utf8').includes('supabase.co'), { mcp: mcp.url, agntei: ag.url, pg: pgc.admin_url, database: world.name })

    // ── 11. Negative paths (N) ───────────────────────────────────────────────────────────────────────────────────────
    const auditSince = async (t) => qa(owner, `select event_type, action, code from action_gateway.action_audit_events where agent_id = $1 and at > to_timestamp($2 / 1000.0) order by event_id`, [AGENT_ID, t])
    const missionCount = async () => Number((await q1(owner, 'select count(*)::int n from workforce.mission'))?.n)
    const linkKey = okIntents.find((i) => i.action === 'workforce_link_self')?.client_request_id
    const missionKey = okIntents.find((i) => i.action === 'workforce_open_mission')?.client_request_id
    const linkedAt = String(employee?.external_linked_at)
    // N-runtime: a second REAL Sterling task. The owner revokes Sterling's open_mission grant first; the operator preapproves
    // create_operator_task in Agntei (so the GATEWAY, not Agntei, is what refuses it: Sterling holds no grant for it).
    await owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = $2 where agent_id = $1 and capability = 'workforce.open_mission' and revoked_at is null`, [AGENT_ID, CEO_USER])
    await A.post(`/api/connections/${connId}/policies`, { tool: 'create_operator_task', decision: 'allow', agent: 'claude-code', note: 'Certification: preapproved in Agntei so that the gateway refusal is what is tested' })
    const n0 = Date.now()
    const missionsBeforeNeg = await missionCount()
    const negPrompt = `You are Sterling. This is a NEGATIVE-PATH certification on a disposable, synthetic environment: some of these calls are EXPECTED to be refused.
Make exactly these three LeadCommand calls, once each, in this order. Do not retry anything, do not work around a refusal, do not call any other tool, do not edit files or run commands.
A) create_operator_task with {"client_request_id": "sterling-neg-unauth-1", "title": "Certification: an action Sterling holds no grant for"}
B) leadcommand_workforce_link_self with EXACTLY {"client_request_id": "${linkKey}", "external_install_id": "${installId}", "external_agent_id": "${setup.agent.id}"}
C) leadcommand_workforce_open_mission with {"client_request_id": "sterling-neg-revoked-1", "directive": "Research the strongest Dallas seller opportunity."}
Then report, for each of A, B and C, the exact status and code the tool returned.`
    const neg = await A.post('/api/tasks', { repoId, title: 'Certification: negative paths (unauthorized, duplicate, revoked)', prompt: negPrompt, agentId: setup.agent.id })
    const negDone = await S.waitFor(async () => { const x = await A.get(`/api/tasks/${neg.id}`); return ['review', 'done', 'failed', 'cancelled', 'blocked'].includes(x.task.status) || (x.approvals || []).some((a) => a.status === 'pending') ? x : null }, { timeoutMs: 10 * 60_000, intervalMs: 3000, what: 'the negative-path task' })
    const negCalls = (await A.get(`/api/connections/${connId}/calls`)).filter((c) => c.taskId === neg.id).map((c) => ({ tool: c.tool, status: c.status, key: c.args?.client_request_id ?? null, result: String(c.resultText || c.error || '').slice(0, 300) }))
    const negAudit = await auditSince(n0)
    out.negative = { task: { id: neg.id, status: negDone.task.status, runs: negDone.runs.map((r) => r.id), pending_approvals: (negDone.approvals || []).filter((a) => a.status === 'pending').length }, calls: negCalls, audit: negAudit }
    const refusedA = negAudit.find((e) => e.event_type === 'call_refused' && e.action === 'create_operator_task')
    check('N01', 'Unauthorized action through the real runtime: create_operator_task (preapproved in Agntei, NO LeadCommand grant) is refused by the GATEWAY; no work item written',
      negCalls.some((c) => c.tool === 'create_operator_task') && refusedA?.code === 'CAPABILITY_NOT_GRANTED' && Number((await q1(owner, 'select count(*)::int n from agent.ops_work_item'))?.n) === 0, { agntei: negCalls.find((c) => c.tool === 'create_operator_task'), gateway: refusedA })
    const linkIntents = await qa(owner, `select count(*)::int n from action_gateway.action_intents where agent_id = $1 and client_key = $2`, [AGENT_ID, linkKey])
    const empAfter = await q1(owner, 'select external_linked_at, external_agent_id from workforce.employee where org_id = $1 and employee_id = $2', [ORG, EMP])
    const bCall = negCalls.find((c) => c.tool === 'leadcommand_workforce_link_self')
    check('N02', 'Duplicate request through the real runtime: the SAME link_self (same client_request_id + arguments) is replayed: one intent, one link, no second effect',
      !!bCall && /replayed|LINKED/i.test(bCall.result) && linkIntents[0].n === 1 && String(empAfter.external_linked_at) === linkedAt, { agntei: bCall, intents_with_key: linkIntents[0].n, linked_at_unchanged: String(empAfter.external_linked_at) === linkedAt })
    const refusedC = negAudit.find((e) => e.event_type === 'call_refused' && e.action === 'workforce_open_mission')
    check('N03', 'Revoked grant through the real runtime: open_mission after the owner revoked its grant is refused; no mission opened',
      !!refusedC && ['CAPABILITY_NOT_GRANTED', 'GRANT_REVOKED'].includes(refusedC.code) && (await missionCount()) === missionsBeforeNeg, { gateway: refusedC, missions_unchanged: (await missionCount()) === missionsBeforeNeg })
    check('N04', 'The negative-path run needed no person (no pending approval) and Agntei recorded every attempt under its task', out.negative.task.pending_approvals === 0 && negCalls.length >= 3, out.negative.task)

    // N-protocol: the official MCP client with Sterling's REAL credential against the same Action MCP (labelled: not the agent)
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const req = createRequire(path.join(mcpDir, 'package.json'))
    const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
    const { StreamableHTTPClientTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href)
    const pc = new Client({ name: 'cert-negative-protocol-client', version: '1.0.0' })
    await pc.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }))
    const call = async (name, args) => { const r = await pc.callTool({ name, arguments: args }); const sc = r.structuredContent || {}; return { isError: !!r.isError, status: sc.status ?? null, code: sc.error?.code ?? sc.code ?? null } }
    const proto = {}
    proto.forged = await call('leadcommand_workforce_link_self', { client_request_id: 'cert-forged-0001', external_install_id: installId, external_agent_id: setup.agent.id, employee_id: 'emp_ceo' })
    check('N05', 'Forged context (an employee_id argument naming someone else) is refused: FORGED_CONTEXT', proto.forged.isError && proto.forged.code === 'FORGED_CONTEXT', proto.forged)
    const holdsBefore = Number((await q1(owner, 'select count(*)::int n from public.automation_holds'))?.n)
    proto.t2 = await call('set_thread_hold', { client_request_id: 'cert-t2-hold-0001', thread_id: MANUAL_THREAD, reason_code: 'other' })
    check('N06', 'Out-of-tier / ungranted operational write (T2 set_thread_hold) is refused; no hold written', proto.t2.isError && Number((await q1(owner, 'select count(*)::int n from public.automation_holds'))?.n) === holdsBefore, proto.t2)
    // the owner issues a NEW VERSION of the open_mission grant with a 1-per-hour cap (supersedes the revoked one)
    const prev = await q1(owner, `select grant_id, grant_version from action_gateway.capability_grants where agent_id = $1 and capability = 'workforce.open_mission' order by grant_version desc limit 1`, [AGENT_ID])
    const v2 = await q1(owner, `insert into action_gateway.capability_grants (org_id, agent_id, capability, grant_version, supersedes_grant_id, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, max_cap_hits_per_hour, granted_by, expires_at)
                       values ($1, $2, 'workforce.open_mission', $3, $4, 1, '{}', '{}', 1, 5, 0, 50, $5, now() + interval '1 day') returning grant_id`, [ORG, AGENT_ID, prev.grant_version + 1, prev.grant_id, CEO_USER])
    // with a live grant again, the REUSED key reaches the idempotency check (no authorization, so no use is consumed)
    const mc0 = await missionCount()
    proto.conflict = await call('leadcommand_workforce_open_mission', { client_request_id: missionKey, directive: 'A DIFFERENT directive under a used key: must not open anything.' })
    check('N07', 'Duplicate key with DIFFERENT parameters is an idempotency conflict (IDEMPOTENCY_KEY_REUSED), never a second effect', proto.conflict.isError && proto.conflict.code === 'IDEMPOTENCY_KEY_REUSED' && (await missionCount()) === mc0, proto.conflict)
    proto.cap1 = await call('leadcommand_workforce_open_mission', { client_request_id: 'cert-cap-0001', directive: 'Research the strongest Dallas seller opportunity.' })
    proto.cap2 = await call('leadcommand_workforce_open_mission', { client_request_id: 'cert-cap-0002', directive: 'Research the second strongest Dallas seller opportunity.' })
    const capEvents = await qa(owner, `select event_type, code from action_gateway.grant_events where grant_id = $1 order by event_id`, [v2.grant_id])
    check('N08', 'Budget limit (use cap): under a 1-use-per-hour grant version the first use runs and the second is refused GRANT_EXHAUSTED_HOURLY (cap hit recorded)',
      !proto.cap1.isError && proto.cap2.isError && proto.cap2.code === 'GRANT_EXHAUSTED_HOURLY' && capEvents.length >= 1, { first: proto.cap1, second: proto.cap2, grant_events: capEvents })
    await owner.query(`delete from public.system_control where key = 'action_gateway_enabled'`)
    proto.stopped = await call('leadcommand_workforce_link_self', { client_request_id: 'cert-stop-0001', external_install_id: installId, external_agent_id: setup.agent.id })
    await owner.query(`insert into public.system_control (key, value) values ('action_gateway_enabled', 'true') on conflict (key) do update set value = excluded.value`)
    proto.restored = await call('leadcommand_workforce_link_self', { client_request_id: 'cert-stop-0002', external_install_id: installId, external_agent_id: setup.agent.id })
    check('N09', 'Gateway emergency stop (system_control.action_gateway_enabled removed): writes refused ACTION_GATEWAY_STOPPED; restored, the same write runs again', proto.stopped.isError && proto.stopped.code === 'ACTION_GATEWAY_STOPPED' && !proto.restored.isError, { stopped: proto.stopped, restored: proto.restored })
    await owner.query(`update agent.runtime_limits set emergency_stop = true, emergency_stop_at = now(), emergency_stop_reason = 'certification N10', emergency_stop_by = $1 where id = 1`, [CEO_USER])
    const probe = await enqueueWorkforceJob(rt, { kind: DISPATCH_KIND, key: ['cert-estop-probe', Date.now()], input: { reason: 'cert_estop_probe' }, requested_by: CEO_USER }).catch((e) => ({ error: String(e.message) }))
    await sleep(6000)
    const probeId = probe?.job_id ?? probe?.job?.job_id ?? null; const probeJob = probeId ? await q1(owner, "select state from agent.research_job where job_id = $1", [probeId]) : null
    const claimedDuringStop = Number((await q1(owner, `select count(*)::int n from agent.research_job where state in ('claimed', 'running') `))?.n)
    await owner.query(`update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null, emergency_stop_reason = null where id = 1`)
    check('N10', 'Runtime emergency stop (agent.runtime_limits.emergency_stop): nothing is claimed while it is on (a queued job stays queued, or the enqueue itself is refused)', claimedDuringStop === 0 && (probe?.error || !probeJob || probeJob.state === 'queued'), { probe, probe_state_after_6s: probeJob?.state ?? null, claimed_or_running: claimedDuringStop })
    const raw = async (auth) => { const r = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cert', version: '0' } } }) }); await r.arrayBuffer().catch(() => {}); return r.status }
    proto.auth = { none: await raw(null), malformed: await raw('Bearer not-a-credential'), unknown: await raw(`Bearer lcag_${crypto.randomBytes(32).toString('base64url')}`) }
    check('N11', 'Authentication: no bearer, a malformed bearer and a well-formed UNKNOWN agent credential are all refused (401)', proto.auth.none === 401 && proto.auth.malformed === 401 && proto.auth.unknown === 401, proto.auth)
    await pc.close().catch(() => {})
    // N-Agntei: the engine's own emergency stop holds a queued task (no run is started), then resume
    await A.post('/api/engine/emergency-stop', {})
    const held = await A.post('/api/tasks', { repoId, title: 'Certification: queued during the Agntei emergency stop', prompt: 'Reply with the single word: held. Call no tools.', agentId: setup.agent.id })
    await sleep(15_000)
    const heldView = await A.get(`/api/tasks/${held.id}`)
    await A.post(`/api/tasks/${held.id}/cancel`, {}).catch(() => null)
    await A.post('/api/engine/resume', {})
    check('N12', 'Agntei emergency stop: a task queued while stopped does not start (no run) for 15 s; cancelled; the scheduler resumed', heldView.runs.length === 0 && heldView.task.status !== 'running', { status: heldView.task.status, runs: heldView.runs.length })
    out.protocol = proto
    const countsAfterNeg = await q1(owner, `select (select count(*) from public.send_queue)::int send_queue, (select count(*) from public.seller_offers)::int seller_offers, (select count(*) from public.followup_intents)::int followup_intents, (select count(*) from public.automation_holds where set_by like 'agent:%')::int agent_holds`)
    const afterNeg = await publicWrites()
    const tableWritesNeg = Object.entries(afterNeg).map(([t, v]) => ({ relname: t, ins: v.ins - (writesBefore[t]?.ins || 0), upd: v.upd - (writesBefore[t]?.upd || 0), del: v.del - (writesBefore[t]?.del || 0) })).filter((x) => x.ins || x.upd || x.del)
    // the ONLY public write allowed is the harness's own N09 toggle of system_control.action_gateway_enabled (owner: 1 delete + 1 insert)
    const otherPublic = tableWritesNeg.filter((x) => !(x.relname === 'system_control' && x.ins === 1 && x.del === 1 && x.upd === 0))
    check('N13', 'After every negative path: still nothing seller-facing; no public.* table written except the harness\'s own N09 emergency-stop toggle (system_control: 1 delete + 1 insert)', Object.values(countsAfterNeg).every((n) => n === 0) && otherPublic.length === 0, { counts: countsAfterNeg, tableWrites: tableWritesNeg, other_than_the_n09_toggle: otherPublic })
  } finally {
    out.finished_at = new Date().toISOString()
    out.ok = checks.length > 0 && checks.every((c) => c.ok) && steps.every((s) => s.ok)
    fs.writeFileSync(path.join(runDir, 'cert-report.json'), JSON.stringify(out, null, 2))
    Object.assign(CLEANUP, { A, connId, ticker })
    if (o.keepAlive) {
      process.stdout.write('kept alive for inspection — Ctrl-C stops everything (and removes the connection)\n')
      await new Promise(() => {}) // the signal handler cleans up and exits
    }
    await CLEANUP.run()
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const which = (b) => { try { return execFileSync('/usr/bin/which', [b], { encoding: 'utf8' }).trim() } catch { return null } }
  const o = {
    pgBin: arg('pg-bin'), agnteiDir: arg('agntei-dir'), out: arg('out'), claudeBin: arg('claude-bin') || which('claude'),
    port: Number(arg('port', '8766')), keepAlive: arg('keep-alive') === true, timeoutMs: Number(arg('timeout-ms', String(25 * 60_000))),
  }
  for (const k of ['pgBin', 'agnteiDir', 'out', 'claudeBin']) if (!o[k]) { process.stderr.write(`missing --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}\n`); process.exit(2) }
  // Ctrl-C / SIGTERM: remove the Agntei connection (its secret-store entry) and stop every process and the cluster
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => { await CLEANUP.run().catch(() => {}); process.exit(130) })
  const r = await runCert(o).catch((e) => { process.stderr.write(`${e?.stack || e}\n`); return { ok: false } })
  process.stdout.write(`\n${r.ok ? 'CERTIFICATION PASS' : 'CERTIFICATION NOT PASSED'} — report: ${path.join(o.out, 'cert-report.json')}\n`)
  process.exit(r.ok ? 0 : 1)
}
