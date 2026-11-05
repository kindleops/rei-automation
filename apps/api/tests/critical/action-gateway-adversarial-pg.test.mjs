// Action Gateway phase 1, ADVERSARIAL proofs on a DISPOSABLE PostgreSQL 17 (PROPOSED link #26 + its real
// prerequisites; every gateway call AS lc_action_gateway with the tenant claim, as PostgREST runs it):
//   unauthorized capability · tier ceiling · cross-tenant · forged agent identity · approval (human path,
//   replay, denial, expiry, grant window) · duplicate requests (sequential + concurrent) · concurrent agents
//   on the same lead · the global emergency stop + tier / capability kills (incl. a stop engaged between
//   authorization and execution) · raw SQL / privilege escalation through tool arguments and the role.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { gatewayDb, seedWorld, registerAgent, seedThread, makeGateway, humanApprovals, sel, audits, intentRow, outcomeRow, setControls, gatewayPool, PEPPER, ORG, ORG_B, OWNER, OPERATOR } from '../helpers/action-gateway-pg.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { credentialDigest, INTENT_TRANSITIONS, INTENT_STATES } from '../../src/lib/domain/action-gateway/index.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)

const hold = (cred, gateway, thread_id, key) => gateway.call({ credential: cred, tool: 'set_thread_hold', args: { client_request_id: key, thread_id, reason_code: 'operator_review' } })
const activeHolds = async (owner) => (await sel(owner, `select count(*)::int n from public.automation_holds where released_at is null`))[0].n

test('PG gateway: an ungranted capability and a tier above the agent ceiling are refused BEFORE any intent; the database refuses the same even when the JS checks are bypassed', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const noGrant = await registerAgent(env.owner, { agent_id: 'agt_nogrant', grants: [['tasks.create_operator_task', 1]] })
    const lowCeiling = await registerAgent(env.owner, { agent_id: 'agt_low', tier_ceiling: 1, grants: [['holds.set_thread_hold', 2]] })
    const t = await seedThread(env.owner)
    const { gateway, store } = makeGateway(env)
    const a = await hold(noGrant, gateway, t.thread_id, 'ungranted-0001')
    assert.deepEqual([a.error.class, a.error.code], ['forbidden', 'CAPABILITY_NOT_GRANTED'])
    const b = await hold(lowCeiling, gateway, t.thread_id, 'ceiling-00001')
    assert.deepEqual([b.error.class, b.error.code], ['forbidden', 'TIER_ABOVE_CEILING'])
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents`))[0].n, 0)
    assert.equal(await activeHolds(env.owner), 0)
    // bypass the JS: open an intent for the low-ceiling agent and try to authorize it with its own (valid) grant
    const grant = (await sel(env.owner, `select grant_id from action_gateway.capability_grants where agent_id = 'agt_low'`))[0]
    const opened = await store.openIntent({ agent_id: 'agt_low', action: 'set_thread_hold', capability: 'holds.set_thread_hold', tier: 2, resource_type: 'thread', resource_id: t.thread_id,
      client_key: 'bypass-00001', idempotency_key: 'a'.repeat(64), params: { thread_id: t.thread_id, reason_code: 'other' }, params_hash: 'b'.repeat(64), correlation_id: crypto.randomUUID() })
    await assert.rejects(store.authorize(opened.intent.intent_id, credentialDigest(PEPPER, lowCeiling), { grant_id: grant.grant_id, policy_id: 'set_thread_hold.policy', policy_version: 'v1' }), /TIER_ABOVE_CEILING/)
    const refused = await sel(env.owner, `select code from action_gateway.action_audit_events where event_type = 'call_refused' order by event_id`)
    assert.deepEqual(refused.map((r) => r.code), ['CAPABILITY_NOT_GRANTED', 'TIER_ABOVE_CEILING'])
  } finally { await env.db.drop() }
})

test('PG gateway: cross-tenant: another tenant\'s credential is unknown here, another tenant\'s intents are invisible, and a gateway whose DB tenant differs from its served org fails closed', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const credA = await registerAgent(env.owner, { agent_id: 'agt_tenant_a', grants: [['holds.set_thread_hold', 2]] })
    const credB = await registerAgent(env.owner, { agent_id: 'agt_tenant_b', org: ORG_B, sponsor: '2b3ee0ff-0000-4000-8000-0000000000d1', created_by: '2b3ee0ff-0000-4000-8000-0000000000d1', grants: [['holds.set_thread_hold', 2]] })
    const t = await seedThread(env.owner)
    const A = makeGateway(env, { org: ORG })
    const B = makeGateway(env, { org: ORG_B })
    const r1 = await hold(credB, A.gateway, t.thread_id, 'tenant-b-on-a')
    assert.deepEqual([r1.error.class, r1.error.code], ['unauthenticated', 'CREDENTIAL_UNKNOWN'])
    const ok = await hold(credA, A.gateway, t.thread_id, 'tenant-a-on-a')
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.equal(await B.store.getIntent(ok.intent_id), null, 'tenant B cannot read tenant A intent')
    assert.equal((await B.store.claim(ok.intent_id, 'x', 30)).reason, 'not_found')
    assert.equal((await B.store.recoverable(50)).length, 0)
    // a misconfigured gateway (serves ORG, its database tenant claim is ORG_B) resolves nobody
    const pool = env.db.trackPool(gatewayPool(env.url, ORG_B))
    const { createActionGateway, createPostgrestActionStore, createGatewayReads, createGatewayServices } = await import('../../src/lib/domain/action-gateway/index.js')
    const { pgSupabase } = await import('../helpers/pg-supabase.mjs')
    const db = pgSupabase(pool)
    const store = createPostgrestActionStore({ db })
    const mis = createActionGateway({ store, reads: createGatewayReads({ db }), services: createGatewayServices({ db, store, bindHoldPort: false }), pepper: PEPPER, dataOrgId: ORG })
    const r2 = await hold(credA, mis, t.thread_id, 'misconfigured-1')
    assert.equal(r2.error.class, 'unauthenticated')
    // tenant B's own agent on tenant B's gateway acts within B (the domain tables are single-tenant: one DB = one org)
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents where org_id = $1`, [ORG_B]))[0].n, 0)
  } finally { await env.db.drop() }
})

test('PG gateway: forged identity: unknown / malformed credentials, identity keys in arguments, a suspended / revoked / expired principal, a sponsor no longer a member, and a digest that is not the intent agent\'s are all refused', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const good = await registerAgent(env.owner, { agent_id: 'agt_good', grants: [['holds.set_thread_hold', 2]] })
    const other = await registerAgent(env.owner, { agent_id: 'agt_other', grants: [['holds.set_thread_hold', 2]] })
    const t = await seedThread(env.owner)
    const { gateway, store } = makeGateway(env)
    const cases = [
      [`lcag_${'Z'.repeat(43)}`, {}, 'CREDENTIAL_UNKNOWN'],
      ['Bearer x', {}, 'CREDENTIAL_MISSING_OR_MALFORMED'],
      [undefined, {}, 'CREDENTIAL_MISSING_OR_MALFORMED'],
      [good, { agent_id: 'agt_other' }, 'FORGED_CONTEXT'],
      [good, { org_id: ORG_B }, 'FORGED_CONTEXT'],
      [good, { approval_id: 'apr_00000000-0000-4000-8000-000000000000' }, 'FORGED_CONTEXT'],
      [good, { tier: 4 }, 'FORGED_CONTEXT'],
    ]
    for (const [cred, extra, code] of cases) {
      const r = await gateway.call({ credential: cred, tool: 'set_thread_hold', args: { client_request_id: `forged-${code}`.slice(0, 40), thread_id: t.thread_id, reason_code: 'other', ...extra } })
      assert.equal(r.error?.code, code, `${code}: ${JSON.stringify(r)}`)
    }
    // the database: an intent of agt_good authorized with agt_other's digest
    const grant = (await sel(env.owner, `select grant_id from action_gateway.capability_grants where agent_id = 'agt_good'`))[0]
    const opened = await store.openIntent({ agent_id: 'agt_good', action: 'set_thread_hold', capability: 'holds.set_thread_hold', tier: 2, resource_type: 'thread', resource_id: t.thread_id,
      client_key: 'forged-digest', idempotency_key: 'c'.repeat(64), params: { thread_id: t.thread_id, reason_code: 'other' }, params_hash: 'd'.repeat(64), correlation_id: crypto.randomUUID() })
    await assert.rejects(store.authorize(opened.intent.intent_id, credentialDigest(PEPPER, other), { grant_id: grant.grant_id, policy_id: 'set_thread_hold.policy', policy_version: 'v1' }), /CREDENTIAL_MISMATCH/)
    // principal lifecycle (owner actions)
    await env.owner.query(`update action_gateway.agent_principals set status = 'suspended' where agent_id = 'agt_good'`)
    assert.equal((await hold(good, gateway, t.thread_id, 'suspended-01')).error.code, 'PRINCIPAL_SUSPENDED')
    await env.owner.query(`update action_gateway.agent_principals set status = 'active' where agent_id = 'agt_good'`)
    await env.owner.query(`delete from agent.operator_membership where user_id = $1`, [OPERATOR])
    assert.equal((await hold(good, gateway, t.thread_id, 'nosponsor-01')).error.code, 'SPONSOR_NOT_MEMBER')
    await env.owner.query(`insert into agent.operator_membership (org_id, user_id, role, added_by) values ($1, $2, 'operator', 'test')`, [ORG, OPERATOR])
    await env.owner.query(`update action_gateway.agent_principals set status = 'revoked', revoked_at = now(), revoked_by = $1 where agent_id = 'agt_other'`, [OWNER])
    assert.equal((await hold(other, gateway, t.thread_id, 'revoked-0001')).error.code, 'PRINCIPAL_REVOKED')
    await assert.rejects(env.owner.query(`update action_gateway.agent_principals set status = 'active', revoked_at = null, revoked_by = null where agent_id = 'agt_other'`), /ACTION_GATEWAY_REVOKED/)
    const expired = await registerAgent(env.owner, { agent_id: 'agt_expiring', grants: [['holds.set_thread_hold', 2]] })
    await env.owner.query(`update action_gateway.agent_principals set credential_rotated_at = now() - interval '10 days', credential_expires_at = now() - interval '1 second' where agent_id = 'agt_expiring'`)
    assert.equal((await hold(expired, gateway, t.thread_id, 'expired-0001')).error.code, 'CREDENTIAL_EXPIRED')
    assert.equal(await activeHolds(env.owner), 0, 'no forged path set a hold')
  } finally { await env.db.drop() }
})

test('PG gateway: approvals: a spend above the autonomous ceiling waits for a HUMAN decision through the existing approval path; the approval is consumed ONCE (replay refused), a denial refuses, an undecided approval expires, and a lapsed grant window is refused', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const cred = await registerAgent(env.owner, { grants: [['research.create_job', 1, { envelope: { max: { budget_usd: 0.5 } }, spendPerDay: 10 }]] })
    const humans = humanApprovals(env)
    const { gateway, store } = makeGateway(env)
    const args = { client_request_id: 'approve-0001', question: 'Deep comps pass on the Oak St area', budget_usd: 1.5 }
    const p = await gateway.call({ credential: cred, tool: 'create_research_job', args })
    assert.equal(p.status, 'approval_pending', JSON.stringify(p))
    const apr = p.approval.approval_id
    const row = (await sel(env.owner, `select * from agent.approval_request where approval_id = $1`, [apr]))[0]
    assert.deepEqual([row.state, row.capability_id, row.requested_by, row.provenance], ['pending', 'agent_actions.authorize_action', OPERATOR, 'model'])
    // still pending: retrying does nothing
    assert.equal((await gateway.call({ credential: cred, tool: 'create_research_job', args })).status, 'approval_pending')
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.research_job where kind = 'mission.research'`))[0].n, 0)
    // a human approves through the EXISTING decide path (verified named operator, payload hash echoed)
    const d = await humans.decide(apr, { by: OWNER })
    assert.equal(d.ok, true, JSON.stringify(d))
    assert.equal(d.execution_result.state, 'granted')
    const done = await gateway.call({ credential: cred, tool: 'create_research_job', args })
    assert.equal(done.ok, true, JSON.stringify(done))
    const auth = (await sel(env.owner, `select approval_id, approved_by, approval_required from action_gateway.action_authorizations where intent_id = $1`, [done.intent_id]))[0]
    assert.deepEqual([auth.approval_id, auth.approved_by, auth.approval_required], [apr, OWNER, true])
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.research_job where kind = 'mission.research'`))[0].n, 1)
    // REPLAY: the same request again is the recorded outcome; the SAME parameters under a new key need a NEW approval
    assert.equal((await gateway.call({ credential: cred, tool: 'create_research_job', args })).status, 'replayed')
    const second = await gateway.call({ credential: cred, tool: 'create_research_job', args: { ...args, client_request_id: 'approve-0002' } })
    assert.equal(second.status, 'approval_pending')
    assert.notEqual(second.approval.approval_id, apr)
    // forcing the consumed approval onto the second intent is refused by the database (bound to the first intent; single use)
    const grant = (await sel(env.owner, `select grant_id from action_gateway.capability_grants where agent_id = 'agt_alpha'`))[0]
    await assert.rejects(store.authorize(second.intent_id, credentialDigest(PEPPER, cred), { grant_id: grant.grant_id, policy_id: 'create_research_job.policy', policy_version: 'v1', approval_required: true, approval_id: apr }), /APPROVAL_INVALID|duplicate key/)
    // DENIAL
    assert.equal((await humans.decide(second.approval.approval_id, { decision: 'deny' })).state, 'denied')
    const denied = await gateway.call({ credential: cred, tool: 'create_research_job', args: { ...args, client_request_id: 'approve-0002' } })
    assert.deepEqual([denied.status, denied.code], ['refused', 'APPROVAL_DENIED'])
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.research_job where kind = 'mission.research'`))[0].n, 1)
    // an approval nobody decided in time: the human can no longer approve it, the intent expires
    const fast = makeGateway(env, { approvalDecideTtlMs: 1200, approvalGrantTtlMs: 60_000 })
    const slow = await fast.gateway.call({ credential: cred, tool: 'create_research_job', args: { ...args, client_request_id: 'approve-0003' } })
    assert.equal(slow.status, 'approval_pending')
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal((await humans.decide(slow.approval.approval_id)).code, 'APPROVAL_EXPIRED')
    const lapsed = await fast.gateway.call({ credential: cred, tool: 'create_research_job', args: { ...args, client_request_id: 'approve-0003' } })
    assert.deepEqual([lapsed.state, lapsed.code], ['expired', 'APPROVAL_EXPIRED'])
    // approved in time, but the agent came back after the GRANT window: refused, nothing enqueued
    const shortGrant = makeGateway(env, { approvalDecideTtlMs: 60_000, approvalGrantTtlMs: 1200 })
    const g = await shortGrant.gateway.call({ credential: cred, tool: 'create_research_job', args: { ...args, client_request_id: 'approve-0004' } })
    assert.equal((await humans.decide(g.approval.approval_id)).ok, true)
    await new Promise((r) => setTimeout(r, 1500))
    const late = await shortGrant.gateway.call({ credential: cred, tool: 'create_research_job', args: { ...args, client_request_id: 'approve-0004' } })
    assert.deepEqual([late.state, late.code], ['expired', 'APPROVAL_EXPIRED'])
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.research_job where kind = 'mission.research'`))[0].n, 1, 'exactly one approved spend ever ran')
    // an agent cannot approve: the decide path requires an org member's verified identity
    assert.equal((await humans.decide(g.approval.approval_id, { by: '2b3ee0ff-0000-4000-8000-00000000dead' })).code, 'NOT_A_MEMBER')
  } finally { await env.db.drop() }
})

test('PG gateway: duplicate requests: 8 concurrent calls with ONE client key make ONE intent and ONE hold; sequential repeats replay the recorded outcome', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const cred = await registerAgent(env.owner, { grants: [['holds.set_thread_hold', 2]] })
    const t = await seedThread(env.owner)
    const { gateway } = makeGateway(env, { maxBusyRetries: 20 })
    const rs = await Promise.all(Array.from({ length: 8 }, () => hold(cred, gateway, t.thread_id, 'dup-key-00001')))
    assert.equal(new Set(rs.map((r) => r.intent_id)).size, 1, JSON.stringify(rs.map((r) => r.status)))
    for (const r of rs) assert.ok(['succeeded', 'replayed', 'in_progress'].includes(r.status), r.status)
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents`))[0].n, 1)
    assert.equal((await sel(env.owner, `select count(*)::int n from public.automation_holds`))[0].n, 1)
    const again = await hold(cred, gateway, t.thread_id, 'dup-key-00001')
    assert.equal(again.status, 'replayed')
    assert.equal((await outcomeRow(env.owner, again.intent_id)).code, 'HOLD_SET')
  } finally { await env.db.drop() }
})

test('PG gateway: concurrent agents on the same lead serialize on the resource: exactly one active hold, every intent terminal, nothing left executing', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const a = await registerAgent(env.owner, { agent_id: 'agt_one', grants: [['holds.set_thread_hold', 2], ['tasks.create_operator_task', 1]] })
    const b = await registerAgent(env.owner, { agent_id: 'agt_two', grants: [['holds.set_thread_hold', 2], ['tasks.create_operator_task', 1]] })
    const t = await seedThread(env.owner)
    const ga = makeGateway(env, { worker: 'gw-a', maxBusyRetries: 40 }).gateway
    const gb = makeGateway(env, { worker: 'gw-b', maxBusyRetries: 40 }).gateway
    const task = (cred, gw, k) => gw.call({ credential: cred, tool: 'create_operator_task', args: { client_request_id: k, title: 'Review the seller thread', subject: { type: 'thread', id: t.thread_id } } })
    const rs = await Promise.all([
      hold(a, ga, t.thread_id, 'lead-a-hold-1'), hold(b, gb, t.thread_id, 'lead-b-hold-1'), task(a, ga, 'lead-a-task-1'), task(b, gb, 'lead-b-task-1'),
      hold(a, ga, t.thread_id, 'lead-a-hold-2'), hold(b, gb, t.thread_id, 'lead-b-hold-2'), task(a, ga, 'lead-a-task-2'), task(b, gb, 'lead-b-task-2'),
    ])
    for (const r of rs) assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(await activeHolds(env.owner), 1, 'one agent hold per thread')
    assert.deepEqual(rs.filter((r) => r.tool === 'set_thread_hold').map((r) => r.code).sort(), ['ALREADY_HELD', 'ALREADY_HELD', 'ALREADY_HELD', 'HOLD_SET'])
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.ops_work_item where scope = 'agent'`))[0].n, 4)
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents where state <> 'succeeded'`))[0].n, 0)
  } finally { await env.db.drop() }
})

test('PG gateway: the GLOBAL EMERGENCY STOP (absent = OFF) refuses every action and read; tier and capability kills refuse only theirs; a stop engaged between authorization and execution refuses the domain write (recorded, nothing written)', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const cred = await registerAgent(env.owner, { grants: [['holds.set_thread_hold', 2], ['tasks.create_operator_task', 1], ['conversation.read_context', 1]], read_scopes: ['conversation_context.read'] })
    const t = await seedThread(env.owner)
    // the stop lands AFTER authorization, while the agent holds the lease (armed below)
    let stopOnClaim = false
    const { gateway } = makeGateway(env, { wrapStore: (s) => ({ ...s, claim: async (...a) => { const r = await s.claim(...a); if (stopOnClaim) await setControls(env.owner, { action_gateway_enabled: null }); return r } }) })
    const task = (k) => gateway.call({ credential: cred, tool: 'create_operator_task', args: { client_request_id: k, title: 'Check the thread' } })
    await setControls(env.owner, { action_gateway_enabled: null })
    for (const r of [await task('stop-task-001'), await hold(cred, gateway, t.thread_id, 'stop-hold-001'), await gateway.call({ credential: cred, tool: 'read_conversation_context', args: { thread_id: t.thread_id } })]) {
      assert.deepEqual([r.error?.class, r.error?.code], ['unavailable', 'ACTION_GATEWAY_STOPPED'])
    }
    await setControls(env.owner, { action_gateway_enabled: 'false' })
    assert.equal((await task('stop-task-002')).error.code, 'ACTION_GATEWAY_STOPPED')
    await setControls(env.owner, { action_gateway_enabled: 'true', action_gateway_tiers: 'T1' })
    assert.equal((await hold(cred, gateway, t.thread_id, 'tier-hold-001')).error.code, 'TIER_DISABLED')
    assert.equal((await task('tier-task-001')).ok, true)
    await setControls(env.owner, { action_gateway_tiers: 'T1,T2', action_gateway_killed_capabilities: 'tasks.create_operator_task' })
    assert.equal((await task('kill-task-001')).error.code, 'CAPABILITY_KILLED')
    await setControls(env.owner, { action_gateway_killed_capabilities: null })
    stopOnClaim = true
    const mid = await hold(cred, gateway, t.thread_id, 'midflight-hold-1')
    stopOnClaim = false
    assert.deepEqual([mid.status, mid.code], ['refused', 'ACTION_GATEWAY_STOPPED'])
    assert.equal((await outcomeRow(env.owner, mid.intent_id)).result.stage, 'execution')
    assert.equal(await activeHolds(env.owner), 0, 'nothing written under the stop')
    assert.ok((await sel(env.owner, `select count(*)::int n from action_gateway.action_audit_events where code = 'ACTION_GATEWAY_STOPPED'`))[0].n >= 5)
  } finally { await env.db.drop() }
})

test('PG gateway: raw SQL / privilege escalation through tool arguments goes nowhere, and the role itself cannot escalate (no SET ROLE, no registry read, no raw write, no other tenant)', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    const cred = await registerAgent(env.owner, { grants: [['holds.set_thread_hold', 2], ['tasks.create_operator_task', 1], ['valuation.request', 1]] })
    const t = await seedThread(env.owner)
    const { gateway, pool } = makeGateway(env)
    const bad = [
      ['set_thread_hold', { thread_id: t.thread_id, reason_code: 'other', sql: 'drop table public.automation_holds' }, 'ESCALATION_REFUSED'],
      ['set_thread_hold', { thread_id: t.thread_id, reason_code: 'other', role: 'service_role' }, 'FORGED_CONTEXT'],
      ['set_thread_hold', { thread_id: `${t.thread_id}'; drop table public.automation_holds; --`, reason_code: 'other' }, 'INPUT_INVALID'],
      ['request_property_valuation', { property_id: "1' or '1'='1" }, 'INPUT_INVALID'],
      ['create_operator_task', { title: 'x', subject: { type: 'thread', id: t.thread_id, statement: 'select 1' } }, 'ESCALATION_REFUSED'],
      ['create_operator_task', { title: 'x', search_path: 'public' }, 'ESCALATION_REFUSED'],
      ['create_operator_task', { title: 'x', subject: { type: 'campaign', id: t.thread_id } }, 'INPUT_INVALID'],
    ]
    for (const [tool, args, code] of bad) {
      const r = await gateway.call({ credential: cred, tool, args: { client_request_id: `esc-${code}-${tool}`.slice(0, 60), ...args } })
      assert.equal(r.error?.code, code, `${tool} ${JSON.stringify(args)} → ${JSON.stringify(r)}`)
    }
    // SQL text in a free-text field is data: stored masked, parameterized, nothing executed
    const ok = await gateway.call({ credential: cred, tool: 'create_operator_task', args: { client_request_id: 'esc-text-0001', title: "Robert'); drop table public.automation_holds; --" } })
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.ok((await sel(env.owner, `select to_regclass('public.automation_holds') is not null ok`))[0].ok)
    // the role, with any SQL at all (PostgREST exposes only the RPC entry points; this is the stronger test)
    for (const q of ['select * from action_gateway.agent_principals', 'select * from action_gateway.capability_grants',
      `insert into public.automation_holds (hold_key, hold_type, thread_key, reason, set_by, approval_ref) values ('x', 'operator_hold', 'y', 'r', 's', 'a')`,
      `update public.system_control set value = 'T1,T2,T3,T4' where key = 'action_gateway_tiers'`, 'create table public.escalate (x int)', 'create schema escalate',
      `select agent.runtime_enqueue('mission.research', repeat('e', 64), '{}'::jsonb, '${OPERATOR}')`, 'delete from action_gateway.action_audit_events']) {
      await assert.rejects(pool.query(q), (e) => ['42501'].includes(e.code), q)
    }
    // no function the role can reach runs dynamic SQL or changes role (PostgREST's surface for the role is these
    // RPC entry points + the inventory reads; there is no SQL text an agent argument could reach)
    const reachable = await sel(env.owner, `select p.oid::regprocedure::text sig, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'action_gateway' or (n.nspname = 'public' and p.proname like 'action\\_gateway\\_%')) and has_function_privilege('lc_action_gateway', p.oid, 'EXECUTE')`)
    assert.ok(reachable.length >= 20)
    for (const f of reachable) {
      assert.ok(!/\bexecute\s+(format|'|\$|[a-z_]+\s*(\|\||;))/i.test(f.prosrc), `dynamic SQL in ${f.sig}`)
      assert.ok(!/set\s+(local\s+)?role|set_config\s*\(\s*'role'|set\s+session\s+authorization/i.test(f.prosrc), `role change in ${f.sig}`)
    }
    const self = (await pool.query('select public.action_gateway_self_check() r')).rows[0].r
    assert.equal(self.ok, true, JSON.stringify(self.findings))
    assert.equal(self.current_user, 'lc_action_gateway')
  } finally { await env.db.drop() }
})

test('PG gateway: the JS intent state graph mirrors action_gateway.intent_transition_ok exactly', { skip }, async () => {
  const env = await gatewayDb()
  try {
    for (const from of INTENT_STATES) for (const to of INTENT_STATES) {
      const db = (await sel(env.owner, 'select action_gateway.intent_transition_ok($1, $2) ok', [from, to]))[0].ok
      assert.equal(db, (INTENT_TRANSITIONS[from] || []).includes(to), `${from} → ${to}`)
    }
  } finally { await env.db.drop() }
})
