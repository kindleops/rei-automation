// STANDING GRANTS (owner addition 2026-10-19: "reusable, bounded agent authority so approved internal operations
// can run autonomously without repetitive human approval") on a DISPOSABLE PostgreSQL 17, every call AS
// lc_action_gateway: T1 runs under the grant with NO per-use approval; every use is checked and recorded against
// it; the bounds hold under exhaustion, expiry, revocation mid-run, an out-of-scope resource, an argument outside
// the envelope and concurrent use racing the caps; anomalies auto-suspend; T3 / T4 (and irreversible T2) can never
// be authorized by a grant alone; the global action switch is OFF unless set.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { gatewayDb, seedWorld, registerAgent, grantStanding, seedThread, makeGateway, humanApprovals, sel, outcomeRow, setControls, PEPPER, ORG, OWNER } from '../helpers/action-gateway-pg.mjs'
import { credentialDigest } from '../../src/lib/domain/action-gateway/index.js'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)

const task = (gw, cred, k, extra = {}) => gw.call({ credential: cred, tool: 'create_operator_task', args: { client_request_id: k, title: 'Check the overnight replies', ...extra } })
const hold = (gw, cred, thread_id, k, reason_code = 'operator_review') => gw.call({ credential: cred, tool: 'set_thread_hold', args: { client_request_id: k, thread_id, reason_code } })
const grantRow = async (owner, id) => (await sel(owner, `select * from action_gateway.capability_grants where grant_id = $1`, [id]))[0]
const events = async (owner, id) => (await sel(owner, `select event_type, code from action_gateway.grant_events where grant_id = $1 order by event_id`, [id]))
async function world() {
  const env = await gatewayDb()
  await seedWorld(env.owner)
  const cred = await registerAgent(env.owner, { grants: [] })
  return { env, cred, digest: credentialDigest(PEPPER, cred) }
}
const bypassIntent = async (store, { action = 'set_thread_hold', capability = 'holds.set_thread_hold', tier = 2, resource_type = 'thread', resource_id, params, key }) => (await store.openIntent({
  agent_id: 'agt_alpha', action, capability, tier, resource_type, resource_id, client_key: key, idempotency_key: Buffer.from(key).toString('hex').padEnd(64, '0').slice(0, 64),
  params, params_hash: 'e'.repeat(64), correlation_id: crypto.randomUUID() })).intent.intent_id

test('PG standing grant: T1 runs autonomously under the grant (no approval request), every use is recorded against it; the hourly cap and the daily spend cap refuse further uses (recorded cap hits)', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const g = await grantStanding(env.owner, { capability: 'tasks.create_operator_task', perHour: 2, perDay: 10 })
    const r = await grantStanding(env.owner, { capability: 'research.create_job', envelope: { max: { budget_usd: 0.5 } }, spendPerDay: 1.0 })
    const { gateway } = makeGateway(env)
    assert.equal((await task(gateway, cred, 'sg-task-0001')).ok, true)
    assert.equal((await task(gateway, cred, 'sg-task-0002')).ok, true)
    const third = await task(gateway, cred, 'sg-task-0003')
    assert.deepEqual([third.status, third.code, third.retryable], ['refused', 'GRANT_EXHAUSTED_HOURLY', true])
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.approval_request`))[0].n, 0, 'no per-use approval')
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_authorizations where grant_id = $1`, [g]))[0].n, 2, 'each use recorded against the grant')
    assert.deepEqual(await events(env.owner, g), [{ event_type: 'cap_hit', code: 'GRANT_EXHAUSTED_HOURLY' }])
    // spend: 0.4 + 0.4 fits $1.00 / day; a third 0.4 does not
    const q = (k) => gateway.call({ credential: cred, tool: 'create_research_job', args: { client_request_id: k, question: 'Comps near the subject', budget_usd: 0.4 } })
    assert.equal((await q('sg-spend-0001')).ok, true)
    assert.equal((await q('sg-spend-0002')).ok, true)
    const over = await q('sg-spend-0003')
    assert.deepEqual([over.status, over.code], ['refused', 'GRANT_SPEND_CAP'])
    assert.equal((await sel(env.owner, `select sum(spend_usd)::numeric(10,2)::text s from action_gateway.action_authorizations where grant_id = $1`, [r]))[0].s, '0.80')
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.research_job where kind = 'mission.research'`))[0].n, 2)
  } finally { await env.db.drop() }
})

test('PG standing grant: concurrent uses RACE the caps on real PostgreSQL: exactly the cap is authorized, the cap hits are recorded and, at the threshold, the grant SUSPENDS itself (anomaly); then every use is refused until an owner reinstates it', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const g = await grantStanding(env.owner, { capability: 'tasks.create_operator_task', perHour: 3, perDay: 50, capHitsPerHour: 4 })
    const gws = [makeGateway(env, { worker: 'race-a' }).gateway, makeGateway(env, { worker: 'race-b' }).gateway, makeGateway(env, { worker: 'race-c' }).gateway]
    const rs = await Promise.all(Array.from({ length: 12 }, (_, n) => task(gws[n % 3], cred, `race-task-${String(n).padStart(4, '0')}`)))
    const ok = rs.filter((x) => x.ok)
    assert.equal(ok.length, 3, JSON.stringify(rs.map((x) => x.code || x.error?.code)))
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_authorizations where grant_id = $1`, [g]))[0].n, 3)
    assert.equal((await sel(env.owner, `select count(*)::int n from agent.ops_work_item where scope = 'agent'`))[0].n, 3)
    for (const x of rs.filter((y) => !y.ok)) assert.ok(['GRANT_EXHAUSTED_HOURLY', 'GRANT_SUSPENDED'].includes(x.code || x.error?.code), JSON.stringify(x))
    const row = await grantRow(env.owner, g)
    assert.equal(row.suspended_reason, 'ANOMALY_CAP_HITS')
    const ev = await events(env.owner, g)
    assert.equal(ev.filter((e) => e.event_type === 'cap_hit').length, 4)
    assert.equal(ev.filter((e) => e.event_type === 'suspended').length, 1)
    const after = await task(gws[0], cred, 'race-task-after')
    assert.equal(after.error.code, 'GRANT_SUSPENDED')
    // the gateway role cannot reinstate it; an owner can (and the use cap still applies: no use is left this hour)
    await env.owner.query(`update action_gateway.capability_grants set suspended_at = null, suspended_reason = null where grant_id = $1`, [g])
    assert.equal((await task(gws[0], cred, 'race-task-reinstated')).code, 'GRANT_EXHAUSTED_HOURLY')
  } finally { await env.db.drop() }
})

test('PG standing grant: an error-rate anomaly (failed uses per hour) suspends the grant automatically', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const g = await grantStanding(env.owner, { capability: 'ops.reconciliation_report', failuresPerHour: 2 })
    const { gateway } = makeGateway(env, { wrapServices: (s) => ({ ...s, pipelineReport: async () => { throw Object.assign(new Error('engine exploded'), { code: 'BOOM' }) } }) })
    const run = (k) => gateway.call({ credential: cred, tool: 'run_authorized_reconciliation', args: { client_request_id: k, kind: 'pipeline' } })
    assert.equal((await run('err-rate-0001')).status, 'failed')
    assert.equal((await run('err-rate-0002')).status, 'failed')
    assert.equal((await grantRow(env.owner, g)).suspended_reason, 'ANOMALY_ERROR_RATE')
    assert.equal((await run('err-rate-0003')).error.code, 'GRANT_SUSPENDED')
    assert.deepEqual((await events(env.owner, g)).map((e) => e.event_type), ['failure', 'failure', 'suspended'])
  } finally { await env.db.drop() }
})

test('PG standing grant: the validity window: an expired grant offers nothing and is refused by the database if presented; a not-yet-valid grant is refused', { skip }, async () => {
  const { env, cred, digest } = await world()
  try {
    const short = await grantStanding(env.owner, { capability: 'tasks.create_operator_task', expiresIn: '2 seconds' })
    const { gateway, store } = makeGateway(env)
    assert.equal((await task(gateway, cred, 'expiry-task-01')).ok, true)
    await new Promise((r) => setTimeout(r, 2300))
    assert.equal((await task(gateway, cred, 'expiry-task-02')).error.code, 'CAPABILITY_NOT_GRANTED', 'an expired grant is not offered')
    const id = await bypassIntent(store, { action: 'create_operator_task', capability: 'tasks.create_operator_task', tier: 1, resource_type: 'system', resource_id: 'tasks', params: { title: 'x', notes: [], priority: 1, severity: 'info', subject_type: 'system' }, key: 'expiry-bypass-1' })
    const a = await store.authorize(id, digest, { grant_id: short, policy_id: 'create_operator_task.policy', policy_version: 'v1' })
    assert.deepEqual([a.ok, a.code], [false, 'GRANT_EXPIRED'])
    await grantStanding(env.owner, { capability: 'tasks.create_operator_task', validFrom: new Date(Date.now() + 3600_000).toISOString(), scope: { resource_types: ['system'] } })
    assert.equal((await task(gateway, cred, 'expiry-task-03')).error.code, 'GRANT_NOT_YET_VALID')
  } finally { await env.db.drop() }
})

test('PG standing grant: REVOCATION mid-run: revoked after authorization, before the domain write ⇒ the write is refused (nothing written); revoked while a read-only service runs ⇒ its result is withheld', { skip }, async () => {
  const { env, cred } = await world()
  try {
    const t = await seedThread(env.owner)
    const gh = await grantStanding(env.owner, { capability: 'holds.set_thread_hold', tier: 2 })
    const gr = await grantStanding(env.owner, { capability: 'ops.reconciliation_report' })
    const revoke = (g) => env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = $2 where grant_id = $1`, [g, OWNER])
    const a = makeGateway(env, { wrapStore: (s) => ({ ...s, claim: async (...x) => { const r = await s.claim(...x); await revoke(gh); return r } }) })
    const h = await hold(a.gateway, cred, t.thread_id, 'revoke-hold-001')
    assert.deepEqual([h.status, h.code], ['refused', 'GRANT_REVOKED'])
    assert.equal((await sel(env.owner, `select count(*)::int n from public.automation_holds`))[0].n, 0)
    const b = makeGateway(env, { wrapServices: (s) => ({ ...s, pipelineReport: async (o) => { const r = await s.pipelineReport(o); await revoke(gr); return r } }) })
    const rep = await b.gateway.call({ credential: cred, tool: 'run_authorized_reconciliation', args: { client_request_id: 'revoke-recon-01', kind: 'pipeline' } })
    assert.deepEqual([rep.status, rep.code, rep.response], ['refused', 'GRANT_REVOKED', undefined])
    assert.equal((await outcomeRow(env.owner, rep.intent_id)).result.withheld, true)
    // a revoked grant is final (an owner grants a NEW version instead)
    await assert.rejects(env.owner.query(`update action_gateway.capability_grants set revoked_at = null, revoked_by = null where grant_id = $1`, [gh]), /ACTION_GATEWAY_REVOKED/)
    const v2 = await grantStanding(env.owner, { capability: 'holds.set_thread_hold', tier: 2, version: 2, supersedes: gh })
    assert.equal((await hold(makeGateway(env).gateway, cred, t.thread_id, 'revoke-hold-002')).ok, true)
    assert.equal((await sel(env.owner, `select grant_id from action_gateway.action_authorizations a join action_gateway.action_intents i using (intent_id) where i.client_key = 'revoke-hold-002'`))[0].grant_id, v2)
    // a version must supersede a REVOKED lower version of the same capability
    await assert.rejects(grantStanding(env.owner, { capability: 'holds.set_thread_hold', tier: 2, version: 3, supersedes: v2, scope: { resource_types: ['thread'] } }), /ACTION_GATEWAY_VERSION/)
  } finally { await env.db.drop() }
})

test('PG standing grant: an OUT-OF-SCOPE resource (market / resource type) is refused by the gateway and by the database', { skip }, async () => {
  const { env, cred, digest } = await world()
  try {
    const chicago = await seedThread(env.owner, { phone: '+13125550171', property: '1000000101' })
    const dallas = await seedThread(env.owner, { phone: '+12145550172', property: '1000000102' })
    await env.owner.query(`update public.inbox_thread_state set market = case when id = $1 then 'Chicago' else 'Dallas' end where id in ($1, $2)`, [chicago.thread_id, dallas.thread_id])
    const g = await grantStanding(env.owner, { capability: 'holds.set_thread_hold', tier: 2, scope: { markets: ['Chicago'] } })
    await grantStanding(env.owner, { capability: 'tasks.create_operator_task', scope: { resource_types: ['thread'] } })
    const { gateway, store } = makeGateway(env)
    assert.equal((await hold(gateway, cred, chicago.thread_id, 'scope-hold-chi1')).ok, true)
    assert.equal((await hold(gateway, cred, dallas.thread_id, 'scope-hold-dal1')).error.code, 'RESOURCE_OUT_OF_GRANT_SCOPE')
    assert.equal((await task(gateway, cred, 'scope-task-sys1')).error.code, 'RESOURCE_OUT_OF_GRANT_SCOPE', 'a system task is outside a thread-only grant')
    assert.equal((await task(gateway, cred, 'scope-task-thr1', { subject: { type: 'thread', id: dallas.thread_id } })).ok, true)
    const id = await bypassIntent(store, { resource_id: dallas.thread_id, params: { thread_id: dallas.thread_id, reason_code: 'other' }, key: 'scope-bypass-dal' })
    const a = await store.authorize(id, digest, { grant_id: g, policy_id: 'set_thread_hold.policy', policy_version: 'v1' })
    assert.deepEqual([a.ok, a.code], [false, 'RESOURCE_OUT_OF_GRANT_SCOPE'])
    assert.equal((await sel(env.owner, `select count(*)::int n from public.automation_holds where inbox_thread_id = $1`, [dallas.thread_id]))[0].n, 0)
  } finally { await env.db.drop() }
})

test('PG standing grant: an argument OUTSIDE the envelope needs a per-use human approval (then runs); the database refuses it without one', { skip }, async () => {
  const { env, cred, digest } = await world()
  try {
    const t = await seedThread(env.owner)
    const g = await grantStanding(env.owner, { capability: 'holds.set_thread_hold', tier: 2, envelope: { allow: { reason_code: ['operator_review', 'seller_requested_pause'] } } })
    const { gateway, store } = makeGateway(env)
    const humans = humanApprovals(env)
    const inside = await hold(gateway, cred, t.thread_id, 'env-hold-inside', 'operator_review')
    assert.equal(inside.ok, true)
    const out = await hold(gateway, cred, t.thread_id, 'env-hold-outsid', 'other')
    assert.deepEqual([out.status, out.code], ['approval_pending', 'ARGUMENT_OUTSIDE_ENVELOPE'], JSON.stringify(out))
    assert.equal((await humans.decide(out.approval.approval_id)).ok, true)
    const ran = await hold(gateway, cred, t.thread_id, 'env-hold-outsid', 'other')
    assert.deepEqual([ran.ok, ran.code], [true, 'ALREADY_HELD'])
    const id = await bypassIntent(store, { resource_id: t.thread_id, params: { thread_id: t.thread_id, reason_code: 'data_quality' }, key: 'env-bypass-0001' })
    const a = await store.authorize(id, digest, { grant_id: g, policy_id: 'set_thread_hold.policy', policy_version: 'v1' })
    assert.deepEqual([a.ok, a.code], [false, 'ARGUMENT_OUTSIDE_ENVELOPE'])
  } finally { await env.db.drop() }
})

test('PG gateway REGRESSION: an approval for a resource whose UUID contains a phone-shaped digit run is filed (payload_is_clean exempts UUIDs only under id keys) — deterministic, formerly a ~1-in-16 INTERNAL', { skip }, async () => {
  const { env, cred } = await world()
  try {
    // the exact id that failed under concurrency: "a895-58797158f778" is a 10+ digit run with a separator
    const t = await seedThread(env.owner, { id: '700474ee-bd20-4d2a-a895-58797158f778' })
    await grantStanding(env.owner, { capability: 'holds.set_thread_hold', tier: 2, envelope: { allow: { reason_code: ['operator_review'] } } })
    const { gateway } = makeGateway(env)
    const out = await hold(gateway, cred, t.thread_id, 'uuid-run-hold-1', 'other')
    assert.deepEqual([out.status, out.code], ['approval_pending', 'ARGUMENT_OUTSIDE_ENVELOPE'], JSON.stringify(out))
    const row = (await sel(env.owner, `select intended_change from agent.approval_request where approval_id = $1`, [out.approval.approval_id]))[0]
    assert.equal(row.intended_change.resource_id, t.thread_id)
    assert.equal((await humanApprovals(env).decide(out.approval.approval_id)).ok, true)
    assert.equal((await hold(gateway, cred, t.thread_id, 'uuid-run-hold-1', 'other')).code, 'HOLD_SET')
  } finally { await env.db.drop() }
})

test('PG standing grant: T3 / T4 and irreversible T2 actions can never be authorized by a standing grant alone; envelope authorization is not available in phase 1', { skip }, async () => {
  const { env, digest } = await world()
  try {
    await env.owner.query(`update action_gateway.agent_principals set tier_ceiling = 4 where agent_id = 'agt_alpha'`)
    await setControls(env.owner, { action_gateway_tiers: 'T1,T2,T3,T4' })
    const g3 = await grantStanding(env.owner, { capability: 'conversation.queue_reply', tier: 3 })
    const g4 = await grantStanding(env.owner, { capability: 'offers.execute_authorized', tier: 4 })
    const g2 = await grantStanding(env.owner, { capability: 'campaigns.pause', tier: 2 })
    const { store } = makeGateway(env)
    const t = await seedThread(env.owner)
    const cases = [
      [g3, 'queue_authorized_reply', 'conversation.queue_reply', 3, 'TIER_REQUIRES_APPROVAL'],
      [g4, 'execute_authorized_offer', 'offers.execute_authorized', 4, 'TIER_REQUIRES_APPROVAL'],
      [g2, 'pause_campaign', 'campaigns.pause', 2, 'T2_ACTION_NOT_REVERSIBLE'],
    ]
    for (const [grant, action, capability, tier, code] of cases) {
      const id = await bypassIntent(store, { action, capability, tier, resource_id: t.thread_id, params: { thread_id: t.thread_id }, key: `tier-${action}`.slice(0, 40) })
      const a = await store.authorize(id, digest, { grant_id: grant, policy_id: `${action}.policy`, policy_version: 'v1' })
      assert.deepEqual([a.ok, a.code], [false, code], action)
    }
    const id = await bypassIntent(store, { action: 'queue_authorized_reply', capability: 'conversation.queue_reply', tier: 3, resource_id: t.thread_id, params: { thread_id: t.thread_id }, key: 'tier-envelope-ref' })
    await assert.rejects(env.owner.query(`insert into action_gateway.action_authorizations (intent_id, org_id, agent_id, capability, tier, grant_id, policy_id, policy_version, envelope_ref) values ($1, $2, 'agt_alpha', 'conversation.queue_reply', 3, $3, 'x.policy', 'v1', 'negotiation:env_1')`, [id, ORG, g3]), /ENVELOPE_AUTHORIZATION_NOT_IMPLEMENTED/)
  } finally { await env.db.drop() }
})

test('PG standing grant: the global action execution switch is OFF by default (no system_control row) even with every grant in place', { skip }, async () => {
  const env = await gatewayDb()
  try {
    await seedWorld(env.owner)
    await setControls(env.owner, { action_gateway_enabled: null, action_gateway_tiers: null })
    const cred = await registerAgent(env.owner, { grants: [['tasks.create_operator_task', 1]] })
    const r = await task(makeGateway(env).gateway, cred, 'default-off-001')
    assert.deepEqual([r.error.class, r.error.code], ['unavailable', 'ACTION_GATEWAY_STOPPED'])
    assert.equal((await sel(env.owner, `select count(*)::int n from public.system_control where key like 'action\\_gateway\\_%'`))[0].n, 0)
  } finally { await env.db.drop() }
})
