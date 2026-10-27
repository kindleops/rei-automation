// Agntei 5.4 Autonomous Communications — the STANDING seller-reply link (PROPOSED_20261028100000) on a DISPOSABLE
// PostgreSQL 17 (t34Db + the link). An owner-minted standing seller-facing grant lets the ONE certified seller reply
// (queue_authorized_reply) run without a per-use approval; nothing else about the reply path changes:
//   - with the flag: no approval request is filed; the handoff, LeadCommand's canonical decideAndCompose → R3 → ONE
//     queued AI row, and the REAL runner sending exactly once (simulated provider) are as before;
//   - without it: unchanged (approval_pending, TIER_REQUIRES_APPROVAL);
//   - the flag never bypasses the AI send capability (kill switch / policy) nor the queue emergency stop;
//   - the database confines the flag to conversation.queue_reply at tier 3 with a recorded basis, and refuses an
//     authorization of any other T3 / T4 action without an approval even when a flagged grant is presented;
//   - a grant revoked after the authorization stops the reply at LeadCommand's worker (re-verified there);
//   - the rollback refuses while a live flagged grant exists, then restores the T3 rule (standing history kept).
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason, applyInTransaction } from '../pg/agent-pg-harness.mjs'
import { t34Db } from '../helpers/action-gateway-t34-pg.mjs'
import { makeGateway, trapTransport, MIG, ORG, OWNER } from '../helpers/action-gateway-pg.mjs'
import { simProvider } from '../helpers/followup-lifecycle-pg.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { ALL_T34, seedT34, agent, replyThread, worker, receipt, aiRows, replySwitches, liveDispatch, dispatchQueued, setControls, sel, REPLY_TEXT, SELLER } from '../helpers/action-gateway-t34-world.mjs'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)
const LINK = MIG('PROPOSED_20261028100000_action_gateway_standing_reply.sql')
const ROLLBACK = MIG('PROPOSED_20261028100000_action_gateway_standing_reply_rollback.sql')
const BASIS = 'owner decision 2026-10-28 (disposable test): certified reply path'

async function world({ switches = replySwitches(), standing = true } = {}) {
  const env = await t34Db()
  await applyInTransaction(env.owner, LINK)
  await seedT34(env)
  await setControls(env.owner, switches)
  const cred = await agent(env, { grants: standing ? ALL_T34.filter(([c]) => c !== 'conversation.queue_reply') : ALL_T34 })
  if (standing) await mintStandingReply(env.owner)
  const t = await replyThread(env)
  return { env, cred, t }
}
/** An owner mints the standing seller-reply grant (grants are immutable: a new grant, never an edit). */
const mintStandingReply = (owner, { agent_id = 'agt_alpha', capability = 'conversation.queue_reply', tier = 3, basis = BASIS } = {}) => owner.query(
  `insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, max_failures_per_hour, max_cap_hits_per_hour, granted_by, valid_from, expires_at, standing_seller_facing, standing_basis)
   values ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, 30, 200, 0, 5, 5, $5, now(), now() + interval '30 days', true, $6) returning grant_id`, [ORG, agent_id, capability, tier, OWNER, basis])
const approvals = (env) => sel(env.owner, 'select count(*)::int n from agent.approval_request').then((r) => r[0].n)

test('PG standing reply: an owner-minted standing seller-facing grant ⇒ NO approval request; the canonical path queues ONE AI row and the REAL runner sends exactly once', { skip }, async () => {
  const { env, cred, t } = await world()
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    const args = { client_request_id: 'standing-01', thread_id: t.thread_id }
    const first = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.code, 'HANDOFF_QUEUED')
    assert.equal(await approvals(env), 0, 'no per-message approval is filed')
    const auth = await sel(env.owner, 'select approval_required, approval_id, evidence from action_gateway.action_authorizations where intent_id = $1', [first.intent_id])
    assert.deepEqual([auth[0].approval_required, auth[0].approval_id], [false, null])
    assert.equal(auth[0].evidence.authority, 'standing_seller_facing')
    const w = worker(env)
    await w.tick()
    const rows = await aiRows(env)
    assert.equal(rows.length, 1, JSON.stringify(await receipt(env, first.intent_id)))
    assert.deepEqual([rows[0].message_body, rows[0].to_phone_number], [REPLY_TEXT, SELLER])
    const sim = simProvider()
    await liveDispatch(env)
    await dispatchQueued(env, w, rows[0].id, sim)
    assert.equal(sim.sent.length, 1)
    await w.execution.reconcileReceipts()
    assert.equal((await receipt(env, first.intent_id)).state, 'sent')
    // the same request again is the same intent: nothing new is queued or sent
    const again = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args })
    assert.equal(again.status, 'replayed')
    await w.tick()
    assert.equal((await aiRows(env)).length, 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG standing reply: without the flag nothing changes — the reply waits for a human (TIER_REQUIRES_APPROVAL)', { skip }, async () => {
  const { env, cred, t } = await world({ standing: false })
  try {
    const { gateway } = makeGateway(env)
    const r = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'standing-02', thread_id: t.thread_id } })
    assert.deepEqual([r.status, r.code], ['approval_pending', 'TIER_REQUIRES_APPROVAL'], JSON.stringify(r))
    assert.equal(await approvals(env), 1)
  } finally { await env.db.drop() }
})

test('PG standing reply: the flag never bypasses the AI send capability (kill switch off) nor the queue emergency stop', { skip }, async () => {
  const { env, cred, t } = await world({ switches: {} })
  try {
    const { gateway } = makeGateway(env)
    const off = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'standing-03', thread_id: t.thread_id } })
    assert.equal(off.error?.code, 'capability_unavailable', JSON.stringify(off))
    await setControls(env.owner, { ...replySwitches(), queue_emergency_stop_at: new Date().toISOString() })
    const stopped = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'standing-04', thread_id: t.thread_id } })
    assert.equal(stopped.ok, false, JSON.stringify(stopped))
    assert.equal((await aiRows(env)).length, 0)
    assert.equal(await approvals(env), 0)
  } finally { await env.db.drop() }
})

test('PG standing reply: the database confines the flag (one capability, tier 3, a recorded basis) and still refuses any other T3 / T4 authorization without approval', { skip }, async () => {
  const { env } = await world()
  try {
    await assert.rejects(mintStandingReply(env.owner, { capability: 'offers.execute_authorized', tier: 4 }), /capability_grants_standing_seller_facing_chk/)
    await assert.rejects(mintStandingReply(env.owner, { basis: null }), /capability_grants_standing_seller_facing_chk/)
    await assert.rejects(env.owner.query(`update action_gateway.capability_grants set standing_seller_facing = false where standing_seller_facing`), /IMMUTABLE/)
    // the verdict function itself: the flagged grant waives T3 only for queue_authorized_reply
    const g = (await sel(env.owner, `select * from action_gateway.capability_grants where agent_id = 'agt_alpha' and capability = 'conversation.queue_reply'`))[0]
    const verdict = async (action, tier) => (await env.owner.query(`select action_gateway.grant_refusal(g, jsonb_populate_record(null::action_gateway.action_intents,
        jsonb_build_object('org_id', g.org_id, 'agent_id', g.agent_id, 'capability', g.capability, 'tier', $2::int, 'action', $1::text, 'resource_type', 'thread', 'resource_id', gen_random_uuid()::text, 'params', '{}'::jsonb)), false) v
      from action_gateway.capability_grants g where g.grant_id = $3`, [action, tier, g.grant_id])).rows[0].v
    assert.equal(await verdict('queue_authorized_reply', 3), null)
    assert.equal(await verdict('execute_authorized_offer', 3), 'TIER_REQUIRES_APPROVAL')
  } finally { await env.db.drop() }
})

test('PG standing reply: a grant revoked after the authorization stops the reply at LeadCommand\'s worker (re-verified, never assumed)', { skip }, async () => {
  const { env, cred, t } = await world()
  try {
    const { gateway } = makeGateway(env)
    const first = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'standing-06', thread_id: t.thread_id } })
    assert.equal(first.code, 'HANDOFF_QUEUED', JSON.stringify(first))
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = granted_by where standing_seller_facing`)
    await worker(env).tick()
    assert.deepEqual([(await receipt(env, first.intent_id)).state, (await receipt(env, first.intent_id)).code], ['refused', 'NO_PER_USE_AUTHORITY'])
    assert.equal((await aiRows(env)).length, 0)
    // and a new request now waits for a human again (no live flagged grant)
    const next = await gateway.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'standing-07', thread_id: t.thread_id } })
    assert.equal(next.ok, false, JSON.stringify(next))
    assert.equal((await aiRows(env)).length, 0)
  } finally { await env.db.drop() }
})

test('PG standing reply: the rollback refuses while a live flagged grant exists, then restores the per-use rule', { skip }, async () => {
  const { env, cred, t } = await world()
  try {
    // one standing reply is history before the rollback
    const { gateway: g0 } = makeGateway(env)
    assert.equal((await g0.call({ credential: cred, tool: 'queue_authorized_reply', args: { client_request_id: 'standing-08', thread_id: t.thread_id } })).code, 'HANDOFF_QUEUED')
    await assert.rejects(applyInTransaction(env.owner, ROLLBACK), /live grant carries standing_seller_facing/)
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = granted_by where standing_seller_facing`)
    await applyInTransaction(env.owner, ROLLBACK)
    assert.equal((await sel(env.owner, `select count(*)::int n from pg_attribute where attrelid = 'action_gateway.capability_grants'::regclass and attname = 'standing_seller_facing' and not attisdropped`))[0].n, 0)
    // the standing authorization stays as history; #26's per-use authority check binds every new row again
    assert.equal((await sel(env.owner, 'select count(*)::int n from action_gateway.action_authorizations where standing'))[0].n, 1)
    assert.equal((await sel(env.owner, `select convalidated from pg_constraint where conrelid = 'action_gateway.action_authorizations'::regclass and conname = 'action_authorizations_check1'`))[0].convalidated, false)
    assert.equal((await sel(env.owner, `select count(*)::int n from pg_proc where proname in ('standing_reply_refusal', 'standing_authority')`))[0].n, 0)
    const cred2 = await agent(env, { agent_id: 'agt_beta' })
    const { gateway } = makeGateway(env)
    const r = await gateway.call({ credential: cred2, tool: 'queue_authorized_reply', args: { client_request_id: 'standing-05', thread_id: t.thread_id } })
    assert.deepEqual([r.status, r.code], ['approval_pending', 'TIER_REQUIRES_APPROVAL'], JSON.stringify(r))
    void cred
  } finally { await env.db.drop() }
})
