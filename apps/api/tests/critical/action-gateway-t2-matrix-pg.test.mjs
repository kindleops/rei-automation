// Action Gateway TIER-2: the adversarial MATRIX, every T2 tool × { unauthorized capability, cross-tenant, idempotent
// replay (exactly one domain effect), a forged source / identity argument, concurrent agents on the same lead, a crash
// mid-execution (lease expiry → recovery re-executes exactly once) } on a DISPOSABLE PostgreSQL 17, plus D1: a
// gateway approval decided in the PRODUCTION capability registry, consumed once, and never replayable.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { makeGateway, seedThread, sel, registerAgent, intentRow, gatewayPool, ORG_B, SELLER_2 } from '../helpers/action-gateway-pg.mjs'
import { t2World, seedOpportunity, seedCampaign, humanPlane, T2_GRANTS } from '../helpers/action-gateway-t2-pg.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString()

/** Per tool: a fresh resource + arguments, and the count of its domain effect (exactly-once checks). */
const TOOLS = {
  update_lead_stage: {
    async make(env, k) { const opp = await seedOpportunity(env.owner, {}); return { opportunity_id: opp, to_stage: 'property_condition', reason: `roof and kitchen ${k}` } },
    effect: (env) => count(env, `select count(*)::int n from agent.approval_request where capability_id = 'pipeline.propose_stage_change'`),
  },
  update_lead_disposition: {
    async make(env, k) { const t = await seedThread(env.owner, { phone: phoneFor(k), property: `p-${k}`, inboundBody: 'Yes I own it, maybe later' }); return { thread_id: t.thread_id, disposition: 'interested', reason: `seller engaged ${k}` } },
    effect: (env) => count(env, `select count(*)::int n from agent.approval_request where capability_id = 'inbox.prepare_disposition_change'`),
  },
  create_deal_action: {
    async make(env, k) { const opp = await seedOpportunity(env.owner, {}); return { opportunity_id: opp, action_kind: 'call_seller', title: `Call the seller ${k}` } },
    effect: (env) => count(env, `select count(*)::int n from agent.ops_work_item where scope = 'agent'`),
  },
  request_thread_hold_release: {
    async make(env, k) {
      const t = await seedThread(env.owner, { phone: phoneFor(k), property: `p-${k}` })
      const h = (await sel(env.owner, `insert into public.automation_holds (hold_key, hold_type, thread_key, inbox_thread_id, reason, set_by, approval_ref) values ($1, 'operator_hold', $2, $3, 'r', 'owner', 'test') returning id`, [`test:${k}`, t.phone, t.thread_id]))[0].id
      return { thread_id: t.thread_id, hold_id: h, reason_code: 'issue_resolved' }
    },
    effect: (env) => count(env, `select count(*)::int n from agent.approval_request where capability_id = 'holds.prepare_release_approval'`),
  },
  schedule_followup: {
    // rc-8.5.21.1: a reply to our ownership question needs an explicit SELLING answer before any follow-up (burstHasSellingAnswer)
    async make(env, k) { const t = await seedThread(env.owner, { phone: phoneFor(k), property: `p-${k}`, inboundBody: 'Yes I own it but not ready to sell. Call me in two weeks' }); return { thread_id: t.thread_id, kind: 'seller_requested_callback', due_at: inDays(14), reason_code: 'seller_asked_for_callback' } },
    effect: (env) => count(env, `select count(*)::int n from public.followup_intents where writer = 'action_gateway' and state = 'planned'`),
  },
  cancel_followup: {
    async make(env, k) {
      const t = await seedThread(env.owner, { phone: phoneFor(k), property: `p-${k}` })
      await env.owner.query(`select public.followup_intent_plan(jsonb_build_object('intent_key', $1::text, 'thread_key', $2::text, 'kind', 'seller_requested_callback', 'intent', 'seller_callback', 'due_at', now() + interval '5 days', 'writer', 'test'))`, [`fi1.test${k}`, t.phone])
      return { thread_id: t.thread_id, reason_code: 'seller_replied' }
    },
    effect: (env) => count(env, `select count(*)::int n from public.followup_intents where state = 'cancelled'`),
  },
  pause_campaign: {
    async make(env) { return { campaign_id: await seedCampaign(env.owner), reason_code: 'complaint_spike' } },
    effect: (env) => count(env, `select count(*)::int n from public.campaigns where status = 'paused'`),
  },
  request_campaign_resume: {
    async make(env) { return { campaign_id: await seedCampaign(env.owner, { status: 'paused' }), reason: 'list fixed' } },
    effect: (env) => count(env, `select count(*)::int n from agent.approval_request where capability_id = 'campaigns.prepare_resume_approval'`),
  },
  adjust_campaign_plan: {
    async make(env) { return { campaign_id: await seedCampaign(env.owner), changes: { daily_cap: 50 }, reason: 'slow down' } },
    effect: (env) => count(env, `select count(*)::int n from agent.approval_request where capability_id = 'campaigns.prepare_plan_adjustment_approval'`),
  },
}
let seq = 0
function phoneFor() { seq += 1; return `+1312555${String(1000 + seq).slice(-4)}` }
const count = async (env, q) => (await sel(env.owner, q))[0].n
const capOf = { update_lead_stage: 'leads.update_stage', update_lead_disposition: 'leads.update_disposition', create_deal_action: 'deals.create_action', request_thread_hold_release: 'holds.request_release',
  schedule_followup: 'followups.schedule', cancel_followup: 'followups.cancel', pause_campaign: 'campaigns.pause', request_campaign_resume: 'campaigns.request_resume', adjust_campaign_plan: 'campaigns.adjust_plan' }

test('PG T2 matrix: every T2 tool refuses an UNAUTHORIZED capability, a CROSS-TENANT agent and a FORGED source / identity argument, and an idempotent REPLAY returns the recorded outcome with exactly ONE domain effect', { skip }, async () => {
  const { env, creds } = await t2World({ agents: ['agt_alpha', 'agt_noperm'], grants: T2_GRANTS })
  try {
    // agt_noperm: revoke everything (an owner revocation is final)
    await env.owner.query(`update action_gateway.capability_grants set revoked_at = now(), revoked_by = $1 where agent_id = 'agt_noperm'`, ['2b3ee0ff-0000-4000-8000-0000000000c1'])
    const other = await registerAgent(env.owner, { agent_id: 'agt_other_tenant', org: ORG_B, sponsor: '2b3ee0ff-0000-4000-8000-0000000000d1', created_by: '2b3ee0ff-0000-4000-8000-0000000000d1', grants: T2_GRANTS })
    const { gateway } = makeGateway(env)
    for (const [tool, spec] of Object.entries(TOOLS)) {
      const args = { client_request_id: `${tool.slice(0, 20)}-m01`, ...(await spec.make(env, tool)) }
      const before = await spec.effect(env)
      const noperm = await gateway.call({ credential: creds.agt_noperm, tool, args })
      assert.equal(noperm.error?.code, 'CAPABILITY_NOT_GRANTED', `${tool}: ${JSON.stringify(noperm)}`)
      const xt = await gateway.call({ credential: other, tool, args })
      // another tenant's agent does not exist in this tenant (the principal lookup is tenant-scoped in the database)
      assert.equal(xt.error?.code, 'CREDENTIAL_UNKNOWN', `${tool}: ${JSON.stringify(xt)}`)
      for (const forged of [{ source: 'closing_authority' }, { agent_id: 'agt_other' }, { actor: 'operator' }, { approval_id: 'apr_00000000-0000-4000-8000-000000000000' }]) {
        const f = await gateway.call({ credential: creds.agt_alpha, tool, args: { ...args, ...forged } })
        assert.equal(f.error?.class, 'invalid_input', `${tool} ${Object.keys(forged)[0]}: ${JSON.stringify(f)}`)
      }
      assert.equal(await spec.effect(env), before, `${tool}: a refused call had an effect`)
      const ok = await gateway.call({ credential: creds.agt_alpha, tool, args })
      assert.equal(ok.ok, true, `${tool}: ${JSON.stringify(ok)}`)
      const after = await spec.effect(env)
      assert.equal(after, before + 1, `${tool}: exactly one effect`)
      const replay = await gateway.call({ credential: creds.agt_alpha, tool, args })
      assert.equal(replay.status, 'replayed', `${tool}: ${JSON.stringify(replay)}`)
      assert.equal(replay.intent_id, ok.intent_id)
      assert.equal(await spec.effect(env), after, `${tool}: a replay had a second effect`)
      // every stored change names the authenticated agent, never an argument
      const i = await intentRow(env.owner, ok.intent_id)
      if (i.params.source) assert.equal(i.params.source, 'action_gateway:agt_alpha', tool)
    }
  } finally { await env.db.drop() }
})

test('PG T2 matrix: CONCURRENT agents on the same lead serialize (one executing intent per resource); the domain keeps its own invariant: one stage request (shared approval), one pause, one live follow-up per thread × kind, one release request', { skip }, async () => {
  const { env, creds } = await t2World({ agents: ['agt_alpha', 'agt_beta'] })
  try {
    const gA = makeGateway(env, { worker: 'gw-a' }).gateway
    const gB = makeGateway(env, { worker: 'gw-b' }).gateway
    for (const tool of ['update_lead_stage', 'pause_campaign', 'schedule_followup', 'request_thread_hold_release', 'update_lead_disposition', 'request_campaign_resume']) {
      const spec = TOOLS[tool]
      const base = await spec.make(env, `${tool}-c`)
      const before = await spec.effect(env)
      const [a, b] = await Promise.all([
        gA.call({ credential: creds.agt_alpha, tool, args: { client_request_id: `${tool.slice(0, 20)}-ca`, ...base } }),
        gB.call({ credential: creds.agt_beta, tool, args: { client_request_id: `${tool.slice(0, 20)}-cb`, ...base } }),
      ])
      assert.equal(a.ok, true, `${tool} A: ${JSON.stringify(a)}`)
      assert.equal(b.ok, true, `${tool} B: ${JSON.stringify(b)}`)
      assert.equal(await spec.effect(env), before + 1, `${tool}: concurrent agents produced one domain effect`)
      if (tool !== 'pause_campaign' && tool !== 'schedule_followup') assert.equal(a.result.approval_id, b.result.approval_id, `${tool}: one shared human request`)
    }
    // the follow-up lifecycle's own invariant: one LIVE intent per thread × property × kind (the newer supersedes)
    assert.equal((await sel(env.owner, `select count(*)::int n from public.followup_intents where writer = 'action_gateway' and state = 'superseded'`))[0].n, 1)
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents where state = 'executing'`))[0].n, 0)
  } finally { await env.db.drop() }
})

test('PG T2 matrix: a CRASH mid-execution (the process dies after the lease is claimed, before / inside the write) leaves NO effect; lease expiry → recovery re-executes EXACTLY once, for the domain writers and the human-request writer alike', { skip }, async () => {
  const { env, cred } = await t2World()
  try {
    for (const tool of ['schedule_followup', 'pause_campaign', 'create_deal_action', 'cancel_followup', 'update_lead_stage', 'request_campaign_resume']) {
      const spec = TOOLS[tool]
      const args = { client_request_id: `${tool.slice(0, 20)}-x1`, ...(await spec.make(env, `${tool}-x`)) }
      const before = await spec.effect(env)
      let crashed = false
      const crash = () => { crashed = true; throw Object.assign(new Error('ECONNRESET: process killed'), { code: 'ECONNRESET' }) }
      const { gateway } = makeGateway(env, { leaseSeconds: 1, worker: 'gw-crash',
        wrapStore: (s) => ({ ...s, domainWrite: (fn, id, tok) => (crashed ? s.domainWrite(fn, id, tok) : crash()) }),
        wrapServices: (svc) => ({ ...svc, t2: { ...svc.t2, humanRequest: (id, tok, req) => (crashed ? svc.t2.humanRequest(id, tok, req) : crash()) } }) })
      const r = await gateway.call({ credential: cred, tool, args })
      assert.equal(r.ok, false, `${tool}: ${JSON.stringify(r)}`)
      assert.equal(await spec.effect(env), before, `${tool}: the crash left an effect`)
      assert.equal((await intentRow(env.owner, r.intent_id || (await sel(env.owner, `select intent_id from action_gateway.action_intents where client_key = $1`, [args.client_request_id]))[0].intent_id)).state, 'executing')
      await new Promise((res) => setTimeout(res, 1300))
      const rec = await makeGateway(env, { worker: 'gw-recover' }).gateway.recover()
      assert.ok(rec.results.some((x) => x.state === 'succeeded'), `${tool}: ${JSON.stringify(rec)}`)
      assert.equal(await spec.effect(env), before + 1, `${tool}: recovery executed exactly once`)
      const again = await makeGateway(env, { worker: 'gw-replay' }).gateway.call({ credential: cred, tool, args })
      assert.equal(again.status, 'replayed')
      assert.equal(await spec.effect(env), before + 1)
    }
  } finally { await env.db.drop() }
})

test('PG T2 matrix (D1): a T2 use OUTSIDE the grant envelope files agent_actions.authorize_action; a human decides it in the PRODUCTION capability registry (createDefaultCapabilityRegistry + withActionGatewayServices); the agent consumes it ONCE; the approval can never be replayed for another intent; a denial refuses', { skip }, async () => {
  const { env, cred } = await t2World({ grants: [['followups.schedule', 2, { envelope: { allow: { kind: ['seller_requested_callback'] } } }], ['campaigns.pause', 2]] })
  try {
    const t = await seedThread(env.owner, { inboundBody: 'Yes I own it. Maybe next year, not now' })
    const { gateway } = makeGateway(env)
    const plane = humanPlane(env)
    assert.ok(plane.registry.get('agent_actions.authorize_action'), 'D1: registered in the production registry')
    const args = { client_request_id: 'd1-fu-00001', thread_id: t.thread_id, kind: 'not_interested_nurture', due_at: inDays(30), reason_code: 'not_interested_30_day' }
    const first = await gateway.call({ credential: cred, tool: 'schedule_followup', args })
    assert.equal(first.status, 'approval_pending', JSON.stringify(first))
    assert.equal(first.code, 'ARGUMENT_OUTSIDE_ENVELOPE')
    assert.equal((await sel(env.owner, `select count(*)::int n from public.followup_intents`))[0].n, 0)
    const d = await plane.decide(first.approval.approval_id)
    assert.equal(d.ok, true, JSON.stringify(d))
    const used = await gateway.call({ credential: cred, tool: 'schedule_followup', args })
    assert.equal(used.code, 'FOLLOWUP_PLANNED', JSON.stringify(used))
    assert.equal((await sel(env.owner, `select approved_by from action_gateway.action_authorizations where intent_id = $1`, [used.intent_id]))[0].approved_by, '2b3ee0ff-0000-4000-8000-0000000000c1')
    // replay of the decision: recorded, never re-executed; the approval cannot authorize another intent
    assert.equal((await plane.decide(first.approval.approval_id)).replayed, true)
    const t2 = await seedThread(env.owner, { phone: SELLER_2, property: 'p200', inboundBody: 'Yes I own it. Maybe next year, not now' })
    const other = await gateway.call({ credential: cred, tool: 'schedule_followup', args: { ...args, client_request_id: 'd1-fu-00002', thread_id: t2.thread_id } })
    assert.equal(other.status, 'approval_pending', 'a new intent needs its own approval')
    assert.notEqual(other.approval.approval_id, first.approval.approval_id)
    const gw = gatewayPool(env.url)
    try {
      await assert.rejects(gw.query(`select public.action_gateway_authorize($1::uuid, $2, jsonb_build_object('grant_id', (select grant_id from action_gateway.action_authorizations where intent_id = $3::uuid), 'policy_id', 'x.policy', 'policy_version', 'v1', 'approval_required', true, 'approval_id', $4::text))`,
        [other.intent_id, 'f'.repeat(64), used.intent_id, first.approval.approval_id]), /ACTION_GATEWAY_/)
    } finally { await gw.end() }
    // a denial: the intent is refused
    assert.equal((await plane.decide(other.approval.approval_id, { decision: 'deny' })).state, 'denied')
    const denied = await gateway.call({ credential: cred, tool: 'schedule_followup', args: { ...args, client_request_id: 'd1-fu-00002', thread_id: t2.thread_id } })
    assert.equal(denied.state, 'refused')
    assert.equal((await sel(env.owner, `select count(*)::int n from public.followup_intents`))[0].n, 1)
  } finally { await env.db.drop() }
})

