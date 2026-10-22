// The ADVERSARIAL segment of the milestone E2E (docs/WORKFORCE-AGNTEI.md §6), on the same live stack, after the main
// flow. Each case records the path it took:
//   agntei-agent   Agntei launches the linked agent (the SCRIPTED AGENT) → Agntei's per-turn MCP bridge → the chat tool
//                  executor → Connections.callTool → Agntei's MCP client → the real Action MCP
//   agntei-api     Agntei's own API (the operator's screen: link, check, relay, access) → the real Action MCP
//   direct-mcp     the official MCP SDK client straight to the real Action MCP (only where Agntei itself refuses to send
//                  the call — that refusal is recorded too)
//   owner-sql      the owner's definer functions on the disposable database (unbind, the emergency stop)
// Fixture missions for the refusal cases are written through the REAL Workforce store (openMission / createAssignment, as
// the COO's staffing would): the main mission's own steps are not reused.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

import * as S from './stack.mjs'
import { encodePropertyRef } from '../../../src/lib/agent/missions/mission-codec.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const MANUAL_THREAD = '0000a0e2-cccc-4e2e-8e2e-00000000a0e2'
export const MANUAL_PID = '9900000190'
/** The synthetic properties of the fixture assignments (the research source knows them too). */
export const fixturePid = (n) => String(9_900_000_100 + n)
export const FIXTURE_PIDS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9].map(fixturePid))

/** The official MCP SDK client (the Action MCP's own dependency), as a separate agent would use it. */
async function sdkClient(repo, url, token) {
  const base = path.join(repo, 'mcp/leadcommand-action-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client')
  const { Client } = await import(pathToFileURL(path.join(base, 'index.js')).href)
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(base, 'streamableHttp.js')).href)
  const c = new Client({ name: 'e2e-direct-client', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return {
    async call(name, args = {}) {
      const r = await c.callTool({ name, arguments: args }).catch((e) => ({ isError: true, structuredContent: { status: 'error', error: { code: /Unauthorized|401/.test(String(e?.message)) ? 'HTTP_401' : 'TRANSPORT', message: String(e?.message).slice(0, 200) } } }))
      const s = r.structuredContent || {}
      return { isError: Boolean(r.isError), code: s.code ?? s.error?.code ?? null, status: s.status ?? null, result: s.result ?? null, text: JSON.stringify(s).slice(0, 800) }
    },
    close: () => c.close().catch(() => {}),
  }
}
/** A connection attempt that the Action MCP refuses at the HTTP layer (an unknown credential). */
async function sdkConnect(repo, url, token) {
  try { const c = await sdkClient(repo, url, token); return { connected: true, client: c } } catch (e) { return { connected: false, error: String(e?.message || e).slice(0, 200) } }
}

export async function runAdversarial(x) {
  const { R, o, owner, wf, A, CONN, EMP, AGENT_ID, MISSION, setup, mcp, state, secrets, mint, ORG, ORG_B, OWNER_B, CEO_USER, credential, routes, lcRoute, routeOpts, transcriptOf, agentStatuses, q1, qa, rest, pepperFile, anonKeyFile, jwtSecretFile, logs, runDir } = x
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..')
  const results = []
  const rec = (id, title, via, expected, got, ok, evidence = {}) => {
    results.push({ id, title, via, expected, code: got ?? null, ok: Boolean(ok), evidence })
    R.check(id, `${title} → ${expected}`, ok, { via, got, ...evidence })
  }
  const scenario = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'scenario.json'), 'utf8')) } catch { return { plans: {} } } }
  const plan = (aid, entry) => { const s = scenario(); s.plans = { ...(s.plans || {}), [aid]: { salt: `r${o.run}`, ...entry } }; fs.writeFileSync(path.join(state, 'scenario.json'), JSON.stringify(s)) }
  const callsOf = (aid, since = 0) => transcriptOf(state).filter((t) => t.type === 'call' && t.aid === aid && Date.parse(t.at) >= since)
  const turnDone = (aid, since) => S.waitFor(() => transcriptOf(state).find((t) => (t.type === 'done' || t.type === 'failed') && t.aid === aid && Date.parse(t.at) >= since) || null, { timeoutMs: 240_000, intervalMs: 800, what: `the scripted agent's turn on ${aid}` })
  const launch = async (conn, aid, entry, projectId = setup.project.id) => {
    plan(aid, entry)
    const since = Date.now() - 50
    const r = await A.post(`/api/leadcommand/${conn}/assignments/${aid}/launch`, { projectId })
    return { since, conversationId: r.conversationId }
  }
  const row = (id) => q1(owner, 'select assignment_id, status, attempt, execution_mode, assignee_employee_id, lease_owner, lease_until, next_attempt_at, outcome_class, runtime_job_id, output from workforce.assignment where assignment_id = $1', [id])
  const P = fixturePid
  const fixtureMission = async (title, specs) => {
    const { mission } = await wf.openMission({ org_id: ORG, title, directive: `${title} (E2E adversarial fixture)`, requested_by: CEO_USER, owner_employee_id: 'emp_coo', idempotency_key: crypto.randomUUID() })
    await wf.transitionMission({ org_id: ORG, mission_id: mission.mission_id, to: 'active' })
    const a = {}
    for (const s of specs) {
      const { assignment } = await wf.createAssignment({ org_id: ORG, mission_id: mission.mission_id, step_key: s.step, capability_key: 'research.property', assignee_employee_id: s.assignee, delegated_by_employee_id: 'emp_coo',
        depends_on: [], input: { property_ref: s.pref ?? encodePropertyRef(s.pid), market: 'Dallas', force: true, ...(s.input || {}) }, resource_type: s.resource_type ?? 'property', resource_key: s.resource_key ?? (s.pref ?? encodePropertyRef(s.pid)), max_attempts: 3 })
      a[s.step] = assignment
    }
    return { mission_id: mission.mission_id, a }
  }
  /** Register + mint + principal + grants + bind another Agntei employee (the same owner path as the main flow). */
  const another = async ({ employee_id, display_name, window = '2 hours', grantsToo = true }) => {
    const r = await lcRoute('POST', '/employees', (req) => routes.handleEmployeeUpsert(req, routeOpts), { op: 'register_agntei', employee: { employee_id, role_key: 'research_analyst', display_name, markets: ['Dallas'], manager_employee_id: 'emp_head_data' } })
    if (r.status !== 201) throw new Error(`register ${employee_id}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`)
    const agent_id = r.data.data.link.agent_id
    const file = path.join(secrets, `${agent_id}.credential`)
    const m = await mint({ agentId: agent_id, out: file })
    const steps = Object.fromEntries(r.data.data.link.steps.map((s) => [s.id, s]))
    await owner.query(steps.principal.command.replace('<DIGEST FROM STEP 1>', m.digest))
    if (grantsToo) await owner.query(steps.grants.command)
    const bound_at = Date.now()
    await owner.query(`select workforce.employee_bind_principal($1, $2, $3, $4, $5::interval, now() + interval '3 days')`, [ORG, employee_id, agent_id, CEO_USER, window])
    return { employee_id, agent_id, token: fs.readFileSync(file, 'utf8').trim(), bound_at }
  }

  // ── setup: two more Agntei agents (Echo, Late) and two more employees (Echo, Late), one more principal (Ghost) ─────
  const echo = await another({ employee_id: 'emp_echo_agntei', display_name: 'Echo' })
  const ghost = await another({ employee_id: 'emp_ghost_agntei', display_name: 'Ghost' })
  const late = await another({ employee_id: 'emp_late_agntei', display_name: 'Late', window: '1 minute' })
  const agentB = await A.post('/api/agents', { name: 'Echo', role: 'researcher', accountId: setup.profile.id, allowedRepos: [] })
  const agentC = await A.post('/api/agents', { name: 'Late', role: 'researcher', accountId: setup.profile.id, allowedRepos: [] })
  const c2 = await A.post('/api/connections', { catalogId: 'leadcommand-workforce', url: mcp.url, token: echo.token, label: 'LeadCommand Workforce (Echo)' })
  const c3 = await A.post('/api/connections', { catalogId: 'leadcommand-workforce', url: mcp.url, token: late.token, label: 'LeadCommand Workforce (Late)' })
  for (const [c, ag] of [[c2, agentB], [c3, agentC]]) {
    await A.put(`/api/connections/${c.id}/access`, { scope: 'agent', scopeId: ag.id, maxTier: 'write' })
    await A.put(`/api/connections/${c.id}/access`, { scope: 'project', scopeId: setup.project.id, maxTier: 'write' })
    for (const t of ['leadcommand_workforce_claim_assignment', 'leadcommand_workforce_whoami', 'leadcommand_workforce_list_assignments', 'leadcommand_workforce_get_mission']) await A.post(`/api/connections/${c.id}/policies`, { tool: t, decision: 'allow', agent: 'chat' })
  }
  const echoLink = await A.post(`/api/leadcommand/${c2.id}/link`, {})

  // ── X01 a second Agntei agent with the same external ref ─────────────────────────────────────────────────────────────
  {
    // (a) Agntei refuses a second agent on Scout's connection, and a second LeadCommand connection for Scout
    const second = await A.raw('PUT', `/api/connections/${CONN}/access`, { scope: 'agent', scopeId: agentB.id, maxTier: 'write' })
    const c4 = await A.post('/api/connections', { catalogId: 'leadcommand-workforce', url: mcp.url, token: ghost.token, label: 'LeadCommand Workforce (Ghost)' })
    const twice = await A.raw('PUT', `/api/connections/${c4.id}/access`, { scope: 'agent', scopeId: setup.agent.id, maxTier: 'write' })
    await A.del(`/api/connections/${c4.id}`)
    rec('X01a', 'Agntei: a second agent on Scout\'s LeadCommand connection, and a second LeadCommand connection for Scout', 'agntei-api', 'both refused', `${second.status}/${twice.status}`, second.status >= 400 && twice.status >= 400,
      { second_agent: String(second.data?.error ?? '').slice(0, 160), second_connection: String(twice.data?.error ?? '').slice(0, 160) })
    // (b) LeadCommand refuses another principal presenting Scout's (install, agent) reference — and suspends its grants
    const g = await sdkClient(REPO, mcp.url, ghost.token)
    const r = await g.call('leadcommand_workforce_link_self', { client_request_id: `ghost-same-ref-${o.run}x`, external_install_id: x.out.ids.install, external_agent_id: setup.agent.id })
    const after = await q1(owner, `select count(*) filter (where suspended_at is not null)::int suspended, count(*)::int total from action_gateway.capability_grants where agent_id = $1 and capability like 'workforce.%'`, [ghost.agent_id])
    const ge = await q1(owner, 'select status, external_agent_id from workforce.employee where employee_id = $1', [ghost.employee_id])
    await g.close()
    rec('X01b', 'LeadCommand: another principal presents the linked agent\'s (install, agent) ref', 'direct-mcp', 'EXTERNAL_REF_ALREADY_LINKED', r.code, r.code === 'EXTERNAL_REF_ALREADY_LINKED' && after.suspended === after.total && ge.status === 'pending_link' && !ge.external_agent_id,
      { grants_suspended: `${after.suspended}/${after.total}`, ghost_employee: ge })
  }

  // ── fixture missions (the real store) ────────────────────────────────────────────────────────────────────────────
  const probe = await fixtureMission('E2E adversarial: refusals', [
    { step: 'res.human_thread', assignee: EMP, pid: MANUAL_PID, resource_type: 'thread', resource_key: MANUAL_THREAD, input: { conversation_id: MANUAL_THREAD } },
    { step: 'res.human_claim', assignee: EMP, pid: P(2) },
    { step: 'res.claim_held', assignee: EMP, pid: P(3) },
    { step: 'res.echo_holds', assignee: echo.employee_id, pid: P(3) },
    { step: 'res.forged', assignee: EMP, pid: P(4) },
    { step: 'res.stopped', assignee: EMP, pid: P(5) },
  ])
  const crash = await fixtureMission('E2E adversarial: disconnect mid-lease', [{ step: 'res.crash', assignee: EMP, pid: P(6) }])
  const handoff = await fixtureMission('E2E adversarial: handoff to the engine', [{ step: 'res.handoff', assignee: EMP, pid: P(7) }])
  // a person holds P(2) (the CEO's resource claim)
  await wf.acquireResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: encodePropertyRef(P(2)), employee_id: 'emp_ceo', assignment_id: null, ttl_seconds: 3600 })

  // ── X02 CLAIM_HELD: Echo (a second Agntei agent) claims the shared property first, through Agntei ─────────────────
  {
    const e1 = probe.a['res.echo_holds'].assignment_id
    const l = await launch(c2.id, e1, { plan: 'calls', calls: [{ op: 'workforce_claim_assignment', args: { client_request_id: `echo-holds-${o.run}-x`, assignment_id: '$AID', lease_seconds: 900 }, expect: 'CLAIMED' }] })
    await turnDone(e1, l.since)
    const echoClaim = callsOf(e1, l.since).find((c) => c.op === 'workforce_claim_assignment')
    rec('X02a', 'Echo (second Agntei agent) claims its assignment on the shared property, through Agntei', 'agntei-agent', 'CLAIMED', echoClaim?.code, echoClaim?.code === 'CLAIMED', { echo_link: echoLink.check?.state })
  }

  // ── X03 the probe conversation (Scout, through Agntei): HUMAN_OWNED ×2, CLAIM_HELD, FORGED_CONTEXT ×2 ───────────────
  {
    const aid = probe.a['res.human_thread'].assignment_id
    const id = (k) => probe.a[k].assignment_id
    const l = await launch(CONN, aid, { plan: 'calls', calls: [
      { op: 'workforce_claim_assignment', args: { client_request_id: `probe-human-thread-${o.run}`, assignment_id: '$AID' }, label: 'manual-override thread', expect: 'HUMAN_OWNED' },
      { op: 'workforce_claim_assignment', args: { client_request_id: `probe-human-claim-${o.run}`, assignment_id: id('res.human_claim') }, label: 'a person holds the property', expect: 'HUMAN_OWNED' },
      { op: 'workforce_claim_assignment', args: { client_request_id: `probe-claim-held-${o.run}`, assignment_id: id('res.claim_held') }, label: 'Echo holds the property', expect: 'CLAIM_HELD' },
      { op: 'workforce_claim_assignment', args: { client_request_id: `probe-forged-emp-${o.run}`, assignment_id: id('res.forged'), employee_id: 'emp_research_01' }, label: 'forged employee_id', expect: 'FORGED_CONTEXT' },
      { op: 'workforce_complete_assignment', args: { client_request_id: `probe-forged-act-${o.run}`, assignment_id: id('res.forged'), claim_attempt: 0, actor: 'emp_ceo', output: { summary: 'forged' } }, label: 'forged actor', expect: 'FORGED_CONTEXT' },
    ] })
    await turnDone(aid, l.since)
    const cs = callsOf(aid, l.since)
    const by = (label) => cs.find((c) => c.note === label)
    const rows = { human_thread: await row(aid), human_claim: await row(id('res.human_claim')), claim_held: await row(id('res.claim_held')), forged: await row(id('res.forged')) }
    rec('X03a', 'Claim of an assignment on a thread under manual override (a person owns it)', 'agntei-agent', 'HUMAN_OWNED', by('manual-override thread')?.code, by('manual-override thread')?.code === 'HUMAN_OWNED' && rows.human_thread.status === 'ready' && !rows.human_thread.lease_owner)
    rec('X03b', 'Claim of an assignment whose property a person (the CEO) holds', 'agntei-agent', 'HUMAN_OWNED', by('a person holds the property')?.code, by('a person holds the property')?.code === 'HUMAN_OWNED' && rows.human_claim.status === 'ready')
    rec('X03c', 'Two Agntei agents on one resource: Scout claims the property Echo holds', 'agntei-agent', 'CLAIM_HELD', by('Echo holds the property')?.code, by('Echo holds the property')?.code === 'CLAIM_HELD' && rows.claim_held.status === 'ready' && !rows.claim_held.lease_owner)
    rec('X03d', 'A forged employee_id argument (claim)', 'agntei-agent', 'FORGED_CONTEXT', by('forged employee_id')?.code, by('forged employee_id')?.code === 'FORGED_CONTEXT' && rows.forged.status === 'ready' && !rows.forged.lease_owner)
    rec('X03e', 'A forged actor argument (complete)', 'agntei-agent', 'FORGED_CONTEXT', by('forged actor')?.code, by('forged actor')?.code === 'FORGED_CONTEXT' && rows.forged.status === 'ready' && rows.forged.output == null)
  }

  // ── X04 the agent disconnects mid-lease (killed) → reaped → the same agent re-claims → research deduped → completed once ─
  {
    const aid = crash.a['res.crash'].assignment_id
    const l = await launch(CONN, aid, { plan: 'crash', resume: 'resume' })
    const armed = await S.waitFor(() => agentStatuses(state).find((s) => s.aid === aid && s.phase === 'armed_for_kill') || null, { timeoutMs: 240_000, intervalMs: 800, what: 'the scripted agent to hold its second lease' })
    const before = await row(aid)
    process.kill(armed.pid, 'SIGKILL')
    const killedAt = Date.now()
    await S.waitFor(() => { try { process.kill(armed.pid, 0); return false } catch { return true } }, { timeoutMs: 10_000, what: 'the killed agent process to exit' })
    const job1 = armed.job_id
    // Agntei: the reply was interrupted (the process died without a result)
    const conv = await S.waitFor(async () => { const c = await A.get(`/api/conversations/${l.conversationId}`); const head = (c.messages || []).at(-1); return head && !['pending', 'streaming'].includes(head.status) ? { status: head.status, error: head.error?.message ?? head.error ?? null } : null }, { timeoutMs: 60_000, intervalMs: 1000, what: 'Agntei to see the reply end' })
    // LeadCommand: the lease (60 s) expires; the engine's reaper hands it back to the SAME external assignee
    const reaped = await S.waitFor(async () => { const r = await row(aid); return r.status === 'ready' && r.attempt > before.attempt && (!r.next_attempt_at || Date.parse(r.next_attempt_at) <= Date.now()) ? r : null }, { timeoutMs: 240_000, intervalMs: 1500, what: 'the lease to be reaped' })
    const reapEvent = await q1(owner, `select payload from workforce.event where assignment_id = $1 and type = 'wf.assignment.transitioned' and payload ->> 'reason' = 'lease_expired' order by event_id desc limit 1`, [aid])
    const res = await A.post(`/api/leadcommand/${CONN}/assignments/${aid}/resume`, {})
    const resumedAt = Date.now()
    await S.waitFor(() => transcriptOf(state).find((t) => (t.type === 'done' || t.type === 'failed') && t.aid === aid && Date.parse(t.at) >= resumedAt - 50) || null, { timeoutMs: 240_000, intervalMs: 800, what: 'the resumed turn' })
    const after = await row(aid)
    const cs = callsOf(aid, resumedAt - 50)
    const again = cs.find((c) => c.op === 'workforce_request_research')
    const jobs = await qa(owner, `select job_id from agent.research_job where kind = 'property.research' and input ->> 'property_ref' = $1`, [encodePropertyRef(P(6))])
    const completedEvents = await q1(owner, `select count(*)::int n from workforce.event where assignment_id = $1 and type = 'wf.assignment.transitioned' and payload ->> 'to' = 'completed'`, [aid])
    const item = (await A.get('/api/leadcommand')).connections.find((c) => c.connection.id === CONN)?.workItems?.find((w) => w.assignmentId === aid)
    rec('X04a', 'The scripted agent is killed mid-lease: Agntei sees the reply end; LeadCommand reaps the lease back to the SAME external assignee', 'agntei-agent', 'reaped → ready (external, same assignee, attempt + 1)', `${reaped.status}:${reaped.execution_mode}:${reaped.assignee_employee_id}:attempt ${before.attempt}→${reaped.attempt}`,
      reaped.status === 'ready' && reaped.execution_mode === 'external' && reaped.assignee_employee_id === EMP && reaped.attempt === before.attempt + 1 && Boolean(reapEvent), { agntei_reply: conv, killed_after_ms: killedAt - l.since, reaped_after_kill_ms: Date.now() - killedAt })
    rec('X04b', 'Resume (Agntei re-reads LeadCommand first) → the same agent re-claims; research NOT re-enqueued', 'agntei-agent', 'RESEARCH_REQUESTED deduped (same job, 1 job)', again ? `${again.code}:deduped=${again.result?.deduped}` : null,
      res.resumed === true && again?.code === 'RESEARCH_REQUESTED' && again.result?.deduped === true && again.result?.job_id === job1 && jobs.length === 1, { resume: res.reason, job: job1, jobs: jobs.length })
    rec('X04c', 'It completes ONCE, verified', 'agntei-agent', 'ASSIGNMENT_COMPLETED verified ×1', `${after.status}:${after.outcome_class}:${completedEvents.n}`, after.status === 'completed' && after.outcome_class === 'verified' && completedEvents.n === 1, { work_item: item ? { state: item.state, stopReason: item.stopReason, events: (item.log || []).map((e) => e.event) } : null })
  }

  // ── X05 a link outside the owner's window (1 minute, long past) ──────────────────────────────────────────────────
  {
    const waitMs = Math.max(0, late.bound_at + 62_000 - Date.now())
    if (waitMs) await sleep(waitMs)
    await A.put(`/api/connections/${c3.id}/access`, { scope: 'agent', scopeId: agentC.id, maxTier: 'write' }).catch(() => {})
    const r = await A.raw('POST', `/api/leadcommand/${c3.id}/link`, {})
    const le = await q1(owner, 'select status, external_agent_id, link_expires_at from workforce.employee where employee_id = $1', [late.employee_id])
    const err = String(r.data?.error ?? '')
    const code = (typeof r.data?.code === 'string' && /^[A-Z_]+$/.test(r.data.code) ? r.data.code : null) ?? /LINK_WINDOW_CLOSED/.exec(err)?.[0] ?? (r.status >= 400 ? `HTTP_${r.status}` : 'LINKED')
    rec('X05', 'Link through Agntei after the owner\'s 1-minute link window closed', 'agntei-api', 'LINK_WINDOW_CLOSED', code, code === 'LINK_WINDOW_CLOSED' && le.status === 'pending_link' && !le.external_agent_id, { agntei: err.slice(0, 200), employee: le })
  }

  // ── X06 handoff external → internal → the dispatch completes it ──────────────────────────────────────────────────
  {
    const aid = handoff.a['res.handoff'].assignment_id
    await A.post(`/api/connections/${CONN}/policies`, { tool: 'leadcommand_workforce_handoff', decision: 'allow', agent: 'chat' }).catch(() => {})
    const l = await launch(CONN, aid, { plan: 'handoff' })
    await turnDone(aid, l.since)
    const h = callsOf(aid, l.since).find((c) => c.op === 'workforce_handoff')
    const done = await S.waitFor(async () => { const r = await row(aid); return ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null }, { timeoutMs: 240_000, intervalMs: 1500, what: 'the dispatch to complete the handed-off assignment' })
    const ev = await qa(owner, `select type, payload from workforce.event where assignment_id = $1 and type = 'wf.assignment.handed_off'`, [aid])
    const mode = await qa(owner, `select payload from workforce.event where assignment_id = $1 and type = 'wf.assignment.mode_changed'`, [aid])
    const coo = await qa(owner, `select content from workforce.exec_message where mission_id = $1 and author = 'coo' and content ilike '%handed off%'`, [handoff.mission_id])
    const jobs = await qa(owner, `select state from agent.research_job where kind = 'property.research' and input ->> 'property_ref' = $1`, [encodePropertyRef(P(7))])
    rec('X06', 'Handoff external → internal (to_coo) → the Workforce dispatch completes it', 'agntei-agent', 'HANDED_OFF → emp_research_01 internal → completed by dispatch', `${h?.code}:${h?.result?.to_employee_id}:${h?.result?.execution_mode} → ${done.status}`,
      h?.code === 'HANDED_OFF' && done.assignee_employee_id === 'emp_research_01' && done.execution_mode === 'internal' && done.status === 'completed' && ev.length === 1 && mode.length === 1 && coo.length >= 1 && jobs.length === 1,
      { research_jobs: jobs.map((j) => j.state), handed_off_events: ev.length, mode_changed: mode.map((m) => m.payload), coo_message: coo[0]?.content?.slice(0, 200) ?? null, final_outcome: done.outcome_class })
  }

  // ── X07 the emergency stop ───────────────────────────────────────────────────────────────────────────────────────
  {
    await owner.query(`update agent.runtime_limits set emergency_stop = true, emergency_stop_at = now(), emergency_stop_reason = 'e2e adversarial' where id = 1`)
    const relay = await A.raw('POST', `/api/leadcommand/${CONN}/missions`, { directive: 'Research the two strongest Dallas seller opportunities and report to the COO.', assignToSelf: false })
    const aid = probe.a['res.stopped'].assignment_id
    const l = await launch(CONN, aid, { plan: 'calls', calls: [{ op: 'workforce_claim_assignment', args: { client_request_id: `probe-stopped-${o.run}`, assignment_id: '$AID' }, expect: 'EMERGENCY_STOP' }] })
    await turnDone(aid, l.since)
    const c = callsOf(aid, l.since).find((t) => t.op === 'workforce_claim_assignment')
    const missionsDuring = await q1(owner, `select count(*)::int n from workforce.mission where directive like 'Research the two strongest%'`)
    await owner.query(`update agent.runtime_limits set emergency_stop = false, emergency_stop_at = null, emergency_stop_reason = null where id = 1`)
    const relayCode = (typeof relay.data?.code === 'string' && /^[A-Z_]+$/.test(relay.data.code) ? relay.data.code : null) ?? /EMERGENCY_STOP/.exec(String(relay.data?.error ?? ''))?.[0] ?? `HTTP_${relay.status}`
    rec('X07a', 'The runtime emergency stop: the CEO directive relayed from Agntei', 'agntei-api', 'EMERGENCY_STOP', relayCode, relayCode === 'EMERGENCY_STOP' && missionsDuring.n === 0)
    rec('X07b', 'The runtime emergency stop: the agent\'s claim', 'agntei-agent', 'EMERGENCY_STOP', c?.code, c?.code === 'EMERGENCY_STOP' && (await row(aid)).status === 'ready')
    // the Action Gateway's own stop (system_control): every call refused — Agntei's link check reports it, changes nothing
    await owner.query(`delete from public.system_control where key = 'action_gateway_enabled'`)
    const chk = await A.raw('POST', `/api/leadcommand/${CONN}/check`, {})
    await owner.query(`insert into public.system_control (key, value) values ('action_gateway_enabled', 'true') on conflict (key) do update set value = excluded.value`)
    const back = await A.post(`/api/leadcommand/${CONN}/check`, {})
    const code = /ACTION_GATEWAY_STOPPED/.exec(JSON.stringify(chk.data))?.[0] ?? null
    rec('X07c', 'The Action Gateway stop: Agntei\'s link check (whoami) is refused; the link is kept; after the restart it is linked again', 'agntei-api', 'ACTION_GATEWAY_STOPPED', code, code === 'ACTION_GATEWAY_STOPPED' && chk.data?.state === 'unreachable' && back.state === 'linked', { during: chk.data?.state, after: back.state })
  }

  // ── X08 tenant isolation: an org-B principal ─────────────────────────────────────────────────────────────────────
  {
    const bAgent = 'agt_orgb_probe'
    const file = path.join(secrets, `${bAgent}.credential`)
    const m = await mint({ agentId: bAgent, out: file })
    await owner.query(`insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, read_scopes, created_by)
                       values ($1, $2, 'Org B probe', $3, $4, now() + interval '7 days', 1, '{}', $3)`, [bAgent, ORG_B, OWNER_B, m.digest])
    for (const cap of ['workforce.whoami', 'workforce.list_assignments', 'workforce.get_mission', 'workforce.claim_assignment']) {
      await owner.query(`insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, granted_by, expires_at)
                         values ($1, $2, $3, 1, '{}', '{}', 60, 500, 0, $4, now() + interval '7 days')`, [ORG_B, bAgent, cap, OWNER_B])
    }
    const bToken = fs.readFileSync(file, 'utf8').trim()
    // a second Action MCP serving org B (its own gateway JWT, minted by the real owner script)
    const gwB = path.join(secrets, 'lc_action_gateway.orgb.jwt')
    const { spawnSync } = await import('node:child_process')
    const g = spawnSync(o.lcNode, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/mint-gateway-token.mjs', '--secret-file', jwtSecretFile, '--org', ORG_B, '--out', gwB, '--days', '2'], { cwd: path.join(REPO, 'mcp/leadcommand-action-mcp'), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } })
    if (g.status !== 0) throw new Error(`mint org B token: ${g.stderr}`)
    const mcpB = await S.startActionMcp({ repo: REPO, node: o.lcNode, orgId: ORG_B, dir: runDir, log: path.join(logs, 'action-mcp-orgb.log'), auditFile: path.join(logs, 'action-mcp-orgb-audit.jsonl'),
      files: { supabaseUrl: rest.shim, apiKey: anonKeyFile, gatewayJwt: gwB, pepper: pepperFile } })
    const onB = await sdkClient(REPO, mcpB.url, bToken)
    const who = await onB.call('leadcommand_workforce_whoami')
    const list = await onB.call('leadcommand_workforce_list_assignments', {})
    const mis = await onB.call('leadcommand_workforce_get_mission', { mission_id: MISSION })
    const claim = await onB.call('leadcommand_workforce_claim_assignment', { client_request_id: `orgb-claim-${o.run}-xx`, assignment_id: x.out.ids.assignment })
    await onB.close()
    const bOnA = await sdkConnect(REPO, mcp.url, bToken)
    const bWho = bOnA.connected ? await bOnA.client.call('leadcommand_workforce_whoami') : { code: 'CONNECT_REFUSED', text: bOnA.error }
    if (bOnA.connected) await bOnA.client.close()
    const aOnB = await sdkConnect(REPO, mcpB.url, credential)
    const aWho = aOnB.connected ? await aOnB.client.call('leadcommand_workforce_whoami') : { code: 'CONNECT_REFUSED', text: aOnB.error }
    if (aOnB.connected) await aOnB.client.close()
    await S.stopProcess(mcpB.rec)
    const leaked = [who, list, mis, claim].some((r) => r.text.includes(MISSION) || r.text.includes(x.out.ids.assignment) || r.text.includes('emp_scout_agntei'))
    rec('X08a', 'Tenant isolation: an org-B principal on its own org\'s Action MCP sees nothing of org A', 'direct-mcp', 'not registered / not found; nothing of org A', `whoami:${who.result?.registered === false ? 'registered=false' : who.code} list:${list.result?.registered === false ? 'registered=false' : list.code} mission:${mis.result?.registered === false ? 'registered=false' : mis.code} claim:${claim.code}`,
      !leaked && who.result?.registered === false && list.result?.registered === false && (mis.result?.registered === false || mis.code === 'MISSION_NOT_FOUND') && claim.isError, { claim: claim.text.slice(0, 200) })
    rec('X08b', 'Tenant isolation: cross-tenant credentials (org B on org A\'s MCP; Scout on org B\'s MCP) are refused', 'direct-mcp', 'refused both ways', `${bWho.code}/${aWho.code}`, (bWho.isError || bWho.code === 'CONNECT_REFUSED') && (aWho.isError || aWho.code === 'CONNECT_REFUSED') && !String(bWho.text).includes('emp_scout_agntei'),
      { org_b_on_a: String(bWho.text).slice(0, 200), scout_on_b: String(aWho.text).slice(0, 200) })
  }

  x.out.adversarialIds = { probe: probe.mission_id, crash: crash.mission_id, handoff: handoff.mission_id, echo: echo.employee_id, ghost: ghost.employee_id, late: late.employee_id, agents: { echo: agentB.id, late: agentC.id }, connections: { echo: c2.id, late: c3.id } }
  return results
}

/** X09 the owner revokes Scout's binding: BINDING_REVOKED; Agntei shows revoked and clears its link (run LAST). */
export async function revokeScout(x) {
  const { R, owner, A, CONN, EMP, ORG, CEO_USER, setup, q1, qa, AGENT_ID } = x
  const r = await q1(owner, `select workforce.employee_unbind($1, $2, $3, 'E2E: the owner revokes the binding') r`, [ORG, EMP, CEO_USER])
  const chk = await A.raw('POST', `/api/leadcommand/${CONN}/check`, {})
  const ov = await A.get('/api/leadcommand?refresh=1')
  const panel = ov.connections.find((c) => c.connection.id === CONN)
  const launchAfter = await A.raw('POST', `/api/leadcommand/${CONN}/missions`, { directive: 'Research the strongest Dallas seller opportunity and report to the COO.', assignToSelf: false })
  const audit = await qa(owner, `select code from action_gateway.action_audit_events where agent_id = $1 and code = 'BINDING_REVOKED'`, [AGENT_ID])
  const e = await q1(owner, 'select status, binding_revoked_at from workforce.employee where employee_id = $1', [EMP])
  const ok = chk.data?.state === 'revoked' && panel?.link == null && panel?.check?.state === 'revoked' && /BINDING_REVOKED/.test(JSON.stringify(chk.data)) && launchAfter.status >= 400 && audit.length >= 1 && Boolean(e.binding_revoked_at)
  const out = { id: 'X09', title: 'The owner revokes the binding (employee_unbind)', via: 'owner-sql → agntei-api', expected: 'BINDING_REVOKED; Agntei shows revoked and clears its link', code: /BINDING_REVOKED/.exec(JSON.stringify(chk.data))?.[0] ?? null, ok,
    evidence: { unbind: r.r, agntei_check: chk.data?.state, agntei_link_after: panel?.link ?? null, agntei_check_reason: String(panel?.check?.reason ?? '').slice(0, 200), relay_after: String(launchAfter.data?.error ?? '').slice(0, 200), gateway_audit_binding_revoked: audit.length } }
  R.check('X09', `${out.title} → ${out.expected}`, ok, out.evidence)
  x.out.agnteiViews.overview_revoked = ov
  return out
}
