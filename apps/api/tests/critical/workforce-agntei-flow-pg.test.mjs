// Workforce × Agntei — the execution modes (docs/WORKFORCE-AGNTEI.md §2–§3 + the owner additions of 2026-10-22) on a
// DISPOSABLE PostgreSQL 17, through the REAL Action Gateway (as lc_action_gateway) and the REAL in-process engine (the
// dispatch pass + the R2 runtime functions):
//   claim external / CLAIM_HELD / HUMAN_OWNED · a lease reaped back to ready for the SAME external assignee · a late call of
//   a reaped lease generation is LEASE_LOST and never applied · request_research → job → resume → verified with resolvable
//   evidence, partial / unknown without · research idempotent per (assignment, property) across a disconnect · handoff
//   external → internal → dispatch completes it · on_external_timeout: wait escalates once, reassign_internal → dispatch
//   completes it with no duplicate job · autonomous Workforce with ZERO external agents online · a mission opened through the
//   gateway has the canonical shape of one opened in Workforce (origin differs) · nothing seller-facing is ever written.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { agnteiWorld, registerAgnteiAgent, wfGateway, agentSession, missionWith, armRuntime, completeJob, jobsOf, dispatchPass, sel, ORG, OWNER } from '../helpers/workforce-agntei-pg.mjs'
import { trapTransport } from '../helpers/action-gateway-pg.mjs'
import { createCooPlanHandler, createMissionReviewHandler } from '../../src/lib/workforce/engine/handlers.js'
import * as R from '../../src/lib/workforce/routes.js'

const skip = pgAvailable() ? false : skipReason
const REF = { external_install_id: 'inst_a1b2c3d4e5f6', external_agent_id: 'agent_scout01' }
const P = 'pid_ghijk'
const P2 = 'pid_ghijl'

async function withAgent(fn, opts = {}) {
  const trap = trapTransport()
  const env = await agnteiWorld()
  try {
    const reg = await registerAgnteiAgent(env, opts)
    const gw = wfGateway(env)
    const s = agentSession(gw, reg.token)
    const l = await s.call('workforce_link_self', { client_request_id: s.id('link'), ...REF })
    assert.equal(l.code, 'LINKED', JSON.stringify(l))
    await fn({ env, s, gw, reg })
    // nothing seller-facing, ever (send_queue, offers, opportunities, follow-ups, holds were never written)
    const counts = (await sel(env.owner, `select (select count(*) from public.send_queue)::int sq, (select count(*) from public.seller_offers)::int so,
      (select count(*) from public.followup_intents)::int fi, (select count(*) from public.automation_holds where set_by like 'agent:%')::int ah`))[0]
    assert.deepEqual(counts, { sq: 0, so: 0, fi: 0, ah: 0 }, 'no seller-facing write')
  } finally { await env.drop(); trap.restore(); assert.deepEqual(trap.hits, [], 'no network') }
}
const row = async (env, id) => (await sel(env.owner, 'select * from workforce.assignment where assignment_id = $1', [id]))[0]
const research = (step, assignee, pref = P, extra = {}) => ({ step, assignee, capability: 'research.property', input: { property_ref: pref, force: true, ...extra }, resource_type: 'property', resource_key: pref })

test('PG claim: external assignments are claimed only by their agent; CLAIM_HELD when another employee holds the resource; HUMAN_OWNED for a person\'s resource or a manually overridden thread; dispatch never claims them', { skip }, () => withAgent(async ({ env, s }) => {
  const thread = '7a1c2e3d-4b5f-4a6b-8c7d-9e0f1a2b3c4d'
  await env.owner.query("insert into public.inbox_thread_state (id, thread_key, property_id, manual_override) values ($1, '+13125550101', '01235', true)", [thread])
  const { a } = await missionWith(env, [research('res.c01', 'emp_scout'), research('res.c02', 'emp_scout', P2),
    { step: 'conv.c03', assignee: 'emp_scout', capability: 'research.property', input: { property_ref: P2 }, resource_type: 'thread', resource_key: thread },
    research('res.c04', 'emp_research_01', 'pid_ghijm')])
  // dispatch leases the internal row only
  const d = await dispatchPass(env)
  assert.equal(d.processed, 1, 'the internal row only')
  for (const k of ['res.c01', 'res.c02', 'conv.c03']) assert.equal((await row(env, a[k].assignment_id)).lease_owner, null, `${k}: dispatch never claims an external row`)
  // another employee holds P → CLAIM_HELD (nothing leased)
  await env.store.acquireResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: P, employee_id: 'emp_research_01', assignment_id: null, ttl_seconds: 600 })
  let r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.c01'].assignment_id })
  assert.equal(r.code, 'CLAIM_HELD')
  assert.equal((await row(env, a['res.c01'].assignment_id)).status, 'ready', 'the lease was rolled back with the refusal')
  // a person holds P2 → HUMAN_OWNED; a thread under manual override → HUMAN_OWNED
  await env.store.acquireResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: P2, employee_id: 'emp_ceo', assignment_id: null, ttl_seconds: 600 })
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.c02'].assignment_id })
  assert.equal(r.code, 'HUMAN_OWNED')
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['conv.c03'].assignment_id })
  assert.equal(r.code, 'HUMAN_OWNED')
  // an internal employee's assignment is not the agent's
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.c04'].assignment_id })
  assert.equal(r.code, 'NOT_ASSIGNEE')
  // released → claimed, with the resource claim, a claim_attempt and no lease token in the answer
  await env.store.releaseResourceClaim({ org_id: ORG, resource_type: 'property', resource_key: P, assignment_id: null })
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.c01'].assignment_id })
  assert.equal(r.code, 'CLAIMED', JSON.stringify(r))
  assert.equal(r.result.attempt, 0)
  assert.ok(!JSON.stringify(r).includes('lease_token'))
  assert.equal((await sel(env.owner, "select employee_id from workforce.resource_claim where resource_key = $1 and released_at is null", [P]))[0].employee_id, 'emp_scout')
}))

test('PG disconnect: the lease is reaped back to ready for the SAME external assignee (no mode flip); a late call of the reaped generation is LEASE_LOST and never applied; research is idempotent per (assignment, property); the assignment completes ONCE, verified', { skip }, () => withAgent(async ({ env, s }) => {
  await armRuntime(env, ['property.research'])
  const { a } = await missionWith(env, [research('res.c01', 'emp_scout')])
  const id = a['res.c01'].assignment_id
  let r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id })
  assert.equal(r.code, 'CLAIMED')
  const g0 = r.result.attempt
  const rq = await s.call('workforce_request_research', { client_request_id: 'research-once-0001', assignment_id: id, claim_attempt: g0 })
  assert.equal(rq.code, 'RESEARCH_REQUESTED', JSON.stringify(rq))
  const job = rq.result.job_id
  assert.equal((await row(env, id)).status, 'waiting_job')
  await completeJob(env, job, { dossier: { comps: 4 } })
  // the job returned the assignment to its agent (the claim resolves the finished job: no dispatch tick needed)
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id })
  assert.equal(r.code, 'CLAIMED', JSON.stringify(r))
  const g1 = r.result.attempt
  assert.equal((await row(env, id)).output.research.job_id, job)
  // the agent DISCONNECTS: its lease expires and the engine's reaper hands it back
  await env.owner.query("update workforce.assignment set lease_until = now() - interval '1 second' where assignment_id = $1", [id])
  await env.store.reapAssignments({ org_id: ORG })
  let x = await row(env, id)
  assert.deepEqual({ status: x.status, assignee: x.assignee_employee_id, mode: x.execution_mode }, { status: 'ready', assignee: 'emp_scout', mode: 'external' }, 'the SAME external assignee, never internal')
  await env.owner.query('update workforce.assignment set next_attempt_at = null where assignment_id = $1', [id]) // (the backoff elapsed)
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id })
  assert.equal(r.code, 'CLAIMED')
  const g2 = r.result.attempt
  assert.equal(g2, g1 + 1, 'the reap burned one attempt: a new lease generation')
  // late calls of the reaped generation: LEASE_LOST, nothing applied
  const before = JSON.stringify((await row(env, id)).output)
  r = await s.call('workforce_report_progress', { client_request_id: s.id('p'), assignment_id: id, claim_attempt: g1, output: { summary: 'LATE OUTPUT' } })
  assert.equal(r.code, 'LEASE_LOST')
  r = await s.call('workforce_complete_assignment', { client_request_id: s.id('done'), assignment_id: id, claim_attempt: g1, output: { summary: 'LATE COMPLETION' }, evidence: [{ type: 'job', id: job }] })
  assert.equal(r.code, 'LEASE_LOST')
  x = await row(env, id)
  assert.equal(JSON.stringify(x.output), before, 'the late output was not applied')
  assert.equal(x.status, 'leased')
  // the agent retries its research after the crash: the SAME job, never a second one
  const again = await s.call('workforce_request_research', { client_request_id: 'research-after-crash-0001', assignment_id: id, claim_attempt: g2 })
  assert.equal(again.code, 'RESEARCH_REQUESTED')
  assert.equal(again.result.job_id, job)
  assert.equal(again.result.deduped, true)
  assert.equal((await jobsOf(env)).length, 1, 'one property.research job for (mission, property)')
  r = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id })
  assert.equal(r.code, 'CLAIMED')
  const fin = { client_request_id: 'complete-once-0001', assignment_id: id, claim_attempt: r.result.attempt, output: { summary: 'Comps support the valuation', findings: ['4 comparable sales'] }, evidence: [{ type: 'job', id: job }, { type: 'intent', id: rq.intent_id }] }
  r = await s.call('workforce_complete_assignment', fin)
  assert.equal(r.code, 'ASSIGNMENT_COMPLETED', JSON.stringify(r))
  assert.equal(r.result.outcome_class, 'verified')
  assert.equal(r.result.evidence_resolved, 2, 'the mission job and the agent\'s own research intent both resolve')
  const replay = await s.call('workforce_complete_assignment', fin)
  assert.equal(replay.replayed, true, 'a retry of the SAME completion returns the recorded outcome')
  x = await row(env, id)
  assert.equal(x.status, 'completed')
  assert.equal(x.outcome_class, 'verified')
  assert.ok(x.evidence.some((e) => e.type === 'job' && e.id === job && e.resolved === true && e.via === 'mission_job'))
  assert.equal((await sel(env.owner, "select count(*)::int n from workforce.event where assignment_id = $1 and type = 'wf.assignment.transitioned' and payload ->> 'to' = 'completed'", [id]))[0].n, 1, 'completed ONCE')
}))

test('PG evidence: an unresolvable ref never makes a completion verified (partial with output, unknown without)', { skip }, () => withAgent(async ({ env, s }) => {
  const { a } = await missionWith(env, [research('res.c01', 'emp_scout'), research('res.c02', 'emp_scout', P2)])
  for (const [k, output, evidence, expected] of [
    ['res.c01', { summary: 'I looked at it' }, [{ type: 'job', id: 'mjob_00000000-0000-4000-8000-000000000009' }, { type: 'property', id: '01234' }, { type: 'intent', id: '00000000-0000-4000-8000-000000000009' }], 'partial'],
    ['res.c02', {}, [{ type: 'job', id: 'mjob_00000000-0000-4000-8000-000000000008' }], 'unknown'],
  ]) {
    const c = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a[k].assignment_id })
    const r = await s.call('workforce_complete_assignment', { client_request_id: s.id('d'), assignment_id: a[k].assignment_id, claim_attempt: c.result.attempt, outcome_class: 'verified', output, evidence })
    assert.equal(r.code, 'ASSIGNMENT_COMPLETED')
    assert.equal(r.result.outcome_class, expected, k)
    assert.equal(r.result.evidence_resolved, 0)
    assert.equal((await row(env, a[k].assignment_id)).outcome_class, expected)
  }
}))

test('PG handoff external → internal: the lease is released, output kept, the mode re-derived and recorded; the dispatch pass then completes it (one job)', { skip }, () => withAgent(async ({ env, s }) => {
  await armRuntime(env, ['property.research'])
  const { mission, a } = await missionWith(env, [research('res.c01', 'emp_scout')])
  const id = a['res.c01'].assignment_id
  const c = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id })
  await s.call('workforce_report_progress', { client_request_id: s.id('p'), assignment_id: id, claim_attempt: c.result.attempt, progress: { percent: 40, phase: 'reading' }, output: { summary: 'Halfway' }, cost: { usd: 0.012, model: 'claude-sonnet' } })
  let r = await s.call('workforce_handoff', { client_request_id: s.id('h'), assignment_id: id, to_coo: true, note: 'Over to the engine' })
  assert.equal(r.code, 'HANDED_OFF', JSON.stringify(r))
  assert.equal(r.result.to_employee_id, 'emp_research_01', 'the COO staffs an internal employee whose role covers it')
  assert.equal(r.result.execution_mode, 'internal')
  let x = await row(env, id)
  assert.equal(x.status, 'ready')
  assert.equal(x.output.summary, 'Halfway', 'progress preserved')
  assert.equal(x.output.reported_cost.status, 'reported')
  const ev = await sel(env.owner, "select type from workforce.event where assignment_id = $1 and type in ('wf.assignment.handed_off', 'wf.assignment.mode_changed')", [id])
  assert.deepEqual(ev.map((e) => e.type).sort(), ['wf.assignment.handed_off', 'wf.assignment.mode_changed'])
  assert.ok((await sel(env.owner, "select 1 from workforce.exec_message where mission_id = $1 and author = 'coo' and content like '%handed off%'", [mission.mission_id])).length)
  // the agent can no longer act on it
  assert.equal((await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: id })).code, 'NOT_ASSIGNEE')
  // the engine runs it: research enqueued → job → resume → completed (verified)
  await dispatchPass(env)
  x = await row(env, id)
  assert.equal(x.status, 'waiting_job', JSON.stringify(x.last_error))
  await completeJob(env, x.runtime_job_id)
  await dispatchPass(env)
  x = await row(env, id)
  assert.equal(x.status, 'completed')
  assert.equal(x.outcome_class, 'verified')
  assert.equal((await jobsOf(env)).length, 1)
}))

test('PG on_external_timeout: wait escalates to the COO ONCE (the row stays external); reassign_internal moves it to an internal employee, recorded, and dispatch completes it with NO duplicate job', { skip }, () => withAgent(async ({ env, s }) => {
  await armRuntime(env, ['property.research'])
  const { mission, a } = await missionWith(env, [research('res.c01', 'emp_scout'), research('res.c02', 'emp_scout', P2)])
  const later = () => Date.now() + 3 * 3600_000 // the bounded wait (default 1 h) has passed
  // c01: the agent requested research, the job finished, then the agent disconnected (never came back)
  const c = await s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.c01'].assignment_id })
  const rq = await s.call('workforce_request_research', { client_request_id: s.id('r'), assignment_id: a['res.c01'].assignment_id, claim_attempt: c.result.attempt })
  await completeJob(env, rq.result.job_id)
  await env.store.resumeWaitingAssignments({ org_id: ORG, resolver: async (id) => ({ state: (await sel(env.owner, 'select state from agent.research_job where job_id = $1', [id]))[0].state, result: {} }) })
  assert.equal((await row(env, a['res.c01'].assignment_id)).status, 'ready')
  await env.store.setAssignmentExternalPolicy({ org_id: ORG, assignment_id: a['res.c01'].assignment_id, policy: 'reassign_internal', wait_seconds: 600, actor: 'emp_coo' })
  // c02: policy wait (the default)
  let d = await dispatchPass(env, { now: later })
  assert.deepEqual(d.external_timeouts, { escalated: 1, reassigned: 1 })
  let x2 = await row(env, a['res.c02'].assignment_id)
  assert.deepEqual({ assignee: x2.assignee_employee_id, mode: x2.execution_mode }, { assignee: 'emp_scout', mode: 'external' }, 'wait never changes the mode')
  d = await dispatchPass(env, { now: later })
  assert.equal(d.external_timeouts.escalated, 0, 'escalated once per idle period')
  assert.equal((await sel(env.owner, "select count(*)::int n from workforce.event where assignment_id = $1 and type = 'wf.assignment.external_timeout'", [a['res.c02'].assignment_id]))[0].n, 1)
  // c01 was reassigned (recorded) and the engine reuses the SAME research job
  let x1 = await row(env, a['res.c01'].assignment_id)
  assert.equal(x1.assignee_employee_id, 'emp_research_01')
  assert.equal(x1.execution_mode, 'internal')
  const evs = (await sel(env.owner, 'select type, payload from workforce.event where assignment_id = $1 order by event_id', [a['res.c01'].assignment_id])).map((e) => e.type)
  for (const t of ['wf.assignment.external_policy_set', 'wf.assignment.mode_changed', 'wf.assignment.transferred', 'wf.assignment.external_timeout']) assert.ok(evs.includes(t), t)
  for (let i = 0; i < 3 && x1.status !== 'completed'; i += 1) { await dispatchPass(env, { now: later }); x1 = await row(env, a['res.c01'].assignment_id) }
  assert.equal(x1.status, 'completed', JSON.stringify(x1.last_error))
  assert.equal(x1.outcome_class, 'verified')
  assert.equal(x1.runtime_job_id, rq.result.job_id, 'the job the agent requested')
  assert.equal((await jobsOf(env)).filter((j) => j.input.property_ref === P).length, 1, 'no duplicate job')
  assert.ok((await sel(env.owner, "select 1 from workforce.exec_message where mission_id = $1 and author = 'coo' and content like '%reassigned%'", [mission.mission_id])).length)
}))

test('PG autonomy: with ZERO external agents online (none registered, the gateway idle) internal assignments and missions progress and the COO reviews', { skip }, async () => {
  const trap = trapTransport()
  const env = await agnteiWorld()
  try {
    await armRuntime(env, ['property.research'])
    assert.equal((await sel(env.owner, "select count(*)::int n from workforce.employee where origin = 'agntei'"))[0].n, 0)
    const { mission, a } = await missionWith(env, [research('res.c01', 'emp_research_01'),
      { step: 'memory', assignee: 'emp_coo', capability: 'memory.assert', depends_on: ['res.c01'], input: { fact: 'research_done', value: { done: true } } }])
    await dispatchPass(env)
    const job = (await row(env, a['res.c01'].assignment_id)).runtime_job_id
    assert.ok(job)
    await completeJob(env, job)
    await dispatchPass(env)
    await dispatchPass(env)
    for (const k of ['res.c01', 'memory']) assert.equal((await row(env, a[k].assignment_id)).status, 'completed', k)
    const review = createMissionReviewHandler({ store: env.store, reads: { jobSpend: async () => ({ committed_usd: 0 }) }, org_id: ORG })
    const r = await review.run({ job: { job_id: 'mjob_review', input: { mission_id: mission.mission_id } }, step: async () => {} })
    assert.equal(r.result.status, 'completed', JSON.stringify(r))
    assert.equal((await env.store.getMission({ org_id: ORG, mission_id: mission.mission_id })).status, 'completed')
  } finally { await env.drop(); trap.restore() }
})

test('PG open_mission: a directive relayed through the gateway opens a mission with the CANONICAL shape of one typed in Workforce (origin differs); the COO plans it; assign_to_self NEVER gives an external agent an engine-computed first step (B2: internal staff; the skip is recorded)', { skip }, () => withAgent(async ({ env, s }) => {
  const directive = 'Find the 5 most promising opportunities in Dallas and get them moving'
  const r = await s.call('workforce_open_mission', { client_request_id: 'relay-0001-dallas', directive, assign_to_self: true })
  assert.equal(r.code, 'MISSION_OPENED', JSON.stringify(r))
  const viaGateway = await env.store.getMission({ org_id: ORG, mission_id: r.result.mission_id })
  // the SAME directive opened in Workforce (the real route, as the CEO's session)
  const svc = { store: env.store, runtimeStore: env.runtime, reads: null, membership: async () => ({ role: 'owner' }) }
  const res = await R.handleMissionCreate(new Request('http://x/missions', { method: 'POST', body: JSON.stringify({ directive, client_request_id: 'workforce-0001-dallas' }) }),
    { env: { AGENT_ENABLED: '1', WORKFORCE_ENABLED: '1' }, auth: () => ({ ok: true }), identity: { authenticate: async () => ({ ok: true, identity: { user_id: OWNER, verified: true, named: true } }) }, limiter: { check: () => ({ ok: true }) }, getServices: async () => svc })
  assert.equal(res.status, 201)
  const viaWorkforce = await env.store.getMission({ org_id: ORG, mission_id: (await res.json()).data.mission.mission_id })
  const strip = ({ mission_id, idempotency_key, created_at, updated_at, origin, ...m }) => m
  assert.deepEqual(Object.keys(viaGateway).sort(), Object.keys(viaWorkforce).sort(), 'the same row shape')
  assert.deepEqual(strip(viaGateway), strip(viaWorkforce), 'the same canonical mission')
  assert.equal(viaGateway.origin, 'agntei')
  assert.equal(viaWorkforce.origin, 'workforce')
  assert.equal(viaGateway.requested_by, OWNER, 'requested by the principal\'s sponsor (the CEO)')
  // the COO plans it from its own runtime job. The first step ('opps', intel.active_opportunities) is ENGINE-COMPUTED: B2
  // (2026-10-25) routes it to INTERNAL staff even though the relaying agent (an acquisition agent of Dallas) asked
  // assign_to_self — an external completion of 'opps' carries no candidates and expanded to an EMPTY triage.
  const jobs = await jobsOf(env, 'workforce.coo_plan')
  assert.equal(jobs.length, 2)
  const gj = jobs.find((j) => j.input.mission_id === viaGateway.mission_id)
  assert.equal(gj.input.assign_first_to, 'emp_scout')
  const plan = createCooPlanHandler({ store: env.store, runtimeStore: env.runtime, env: { WORKFORCE_ENABLED: '1' }, org_id: ORG })
  await plan.run({ job: { job_id: gj.job_id, input: gj.input, requested_by: OWNER }, step: async () => {} })
  const first = (await env.store.listAssignments({ org_id: ORG, mission_id: viaGateway.mission_id }))[0]
  assert.equal(first.capability_key, 'intel.active_opportunities')
  assert.notEqual(first.assignee_employee_id, 'emp_scout', 'never the external agent for an engine-computed step')
  assert.equal(first.execution_mode, 'internal')
  const skipped = (await env.owner.query(`select payload from workforce.event where mission_id = $1 and type = 'wf.mission.assign_to_self_skipped'`, [viaGateway.mission_id])).rows
  assert.equal(skipped[0]?.payload?.reason, 'not_externally_executable', 'the skip is recorded with its reason')
  assert.equal((await env.store.getMission({ org_id: ORG, mission_id: viaGateway.mission_id })).status, 'active')
  // a replay of the relay returns the SAME mission
  const again = await s.call('workforce_open_mission', { client_request_id: 'relay-0001-dallas', directive, assign_to_self: true })
  assert.equal(again.result.mission_id, viaGateway.mission_id)
  // a refused / unclear directive opens nothing
  assert.equal((await s.call('workforce_open_mission', { client_request_id: s.id('m'), directive: 'text the seller an offer of 200k' })).code, 'DIRECTIVE_REFUSED')
}, { role_key: 'acquisition_agent', markets: ['dallas'] }))

test('PG B2 intelligence: a participant reads the ENGINE-COMPUTED acquisition intelligence of its mission (candidates + exclusion reasons + provenance), allowlisted and PII-free; a non-participant cannot', { skip }, () => withAgent(async ({ env, s }) => {
  const { capability: opps } = await import('../../src/lib/workforce/capabilities/active-opportunities.js')
  // the REAL capability over deal-context rows that carry contact PII the projection must never surface
  const rows = [
    { property_id: '9910001', market: 'Dallas', universal_status: 'active', universal_stage: 'offer_interest', thread_key: '+12145550101', inbox_thread_id: '0000aaaa-0000-4000-8000-000000000001',
      latest_message_direction: 'inbound', last_inbound_at: new Date().toISOString(), owner_name: 'Rosa Example', canonical_e164: '+12145550101', latest_message_body: 'call me at 214-555-0101 or rosa@example.com',
      property_address_full: '12 Oak St, Dallas, TX 75201', reply_intent: 'interested' },
    { property_id: '9910002', market: 'Dallas', universal_status: 'closed', universal_stage: 'closed', owner_name: 'Closed Person' },
    { property_id: '9910003', market: 'Dallas', universal_status: 'active', universal_stage: 'ownership_confirmation', opt_out: true, owner_name: 'Opted Out', canonical_e164: '+12145550103' },
  ]
  const r = await opps.run({ services: { listDealContexts: async () => ({ rows }), listActiveHolds: async () => ({ ok: true, holds: [] }) } }, { markets: ['Dallas'], pool: 10 })
  assert.equal(r.status, 'completed')
  const { mission, a } = await missionWith(env, [
    { step: 'opps', capability: 'intel.active_opportunities', assignee: 'emp_head_acquisitions', input: { markets: ['Dallas'], pool: 10 } },
    { step: 'res.c01', capability: 'research.property', assignee: 'emp_scout', depends_on: ['opps'], input: { property_ref: r.output.candidates[0].property_ref } },
  ])
  const [claimed] = await env.store.claimAssignments({ org_id: ORG, owner: 'b2-test-engine', limit: 1, lease_seconds: 60 })
  assert.equal(claimed.assignment_id, a.opps.assignment_id)
  await env.store.finishAssignment({ org_id: ORG, assignment_id: claimed.assignment_id, lease_token: claimed.lease_token, status: 'completed', outcome_class: r.outcome_class, output: r.output })

  const x = await s.call('workforce_get_mission_intelligence', { mission_id: mission.mission_id })
  assert.equal(x.ok, true, JSON.stringify(x))
  const item = x.result.items.find((i) => i.capability === 'intel.active_opportunities')
  assert.ok(item, 'the engine-computed opportunity step is returned')
  assert.equal(item.outcome_class, 'verified')
  assert.equal(item.data.source, 'deal-context-service.listDealContexts', 'provenance')
  assert.equal(item.data.eligible, 1)
  assert.deepEqual([item.data.excluded.closed, item.data.excluded.suppressed], [1, 1], 'the exclusion reasons')
  assert.equal(item.data.candidates.length, 1)
  assert.deepEqual(Object.keys(item.data.candidates[0]).sort().filter((k) => ['opportunity_id', 'conversation_id'].includes(k)), [], 'no opportunity / conversation uuid in the projection')
  assert.ok(x.result.pending.some((p) => p.step_key === 'res.c01'), 'unfinished intelligence steps are listed as pending')
  const text = JSON.stringify(x.result)
  for (const pii of ['Rosa', 'Example', '555-0101', '5550101', 'example.com', 'Oak St', 'call me', 'Opted Out', 'Closed Person']) assert.ok(!text.includes(pii), `no PII in the projection: ${pii}`)
  // a mission the agent does NOT participate in
  const other = await missionWith(env, [{ step: 'opps', capability: 'intel.active_opportunities', assignee: 'emp_head_acquisitions' }], { key: crypto.randomUUID() })
  const y = await s.call('workforce_get_mission_intelligence', { mission_id: other.mission.mission_id })
  assert.equal(y.ok, false)
  assert.equal(y.code ?? y.error?.code, 'MISSION_NOT_FOUND')
}))
