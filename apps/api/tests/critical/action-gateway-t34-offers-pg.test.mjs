// Action Gateway T4 (financial) END TO END on a DISPOSABLE PostgreSQL 17: prepare_acquisition_offer (read) →
// submit_offer_for_approval (the existing approval ledger, a human decides, the envelope is granted for EXACTLY the
// thread + property) → the operator's DISTINCT send authorization (decided through the D6 decide path) →
// execute_authorized_offer (envelope-ref authorization verified in the database, the DURABLE send budget consumed
// atomically, R5) → LeadCommand's worker (composer → persistActiveOffer with the R4 ceiling → ledger → canonical
// queue writer) → the REAL runner with a SIMULATED provider. Plus record_seller_counteroffer (never auto-accepted).
// The negotiation production capability is activated in the disposable database ONLY.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import { pgAvailable, skipReason, API_DIR } from '../pg/agent-pg-harness.mjs'
import { t34Db } from '../helpers/action-gateway-t34-pg.mjs'
import { makeGateway, trapTransport, humanApprovals, OPERATOR } from '../helpers/action-gateway-pg.mjs'
import { simProvider } from '../helpers/followup-lifecycle-pg.mjs'
import { pgSupabase } from '../helpers/pg-supabase.mjs'
import { __setAutomationHoldResolverForTests } from '../../src/lib/domain/holds/automation-hold.js'
import { persistActiveOffer } from '../../src/lib/domain/seller-flow/seller-offer-authority.js'
import { seedT34, agent, worker, receipt, workItems, setControls, sel, liveDispatch, dispatchQueued, approveAndRetry, seedOfferWorld, operatorSendAuthorization, offerRows, sellerOffers, SELLER, OURS, crypto } from '../helpers/action-gateway-t34-world.mjs'

const skip = pgAvailable() ? false : skipReason
__setAutomationHoldResolverForTests(null)

async function world({ negotiation = 'true' } = {}) {
  const env = await t34Db()
  await seedT34(env)
  if (negotiation) await setControls(env.owner, { negotiation_send_enabled: negotiation })
  const cred = await agent(env)
  const o = await seedOfferWorld(env)
  return { env, cred, ...o }
}

/** prepare → submit → human approval → envelope; returns the prepared plan. */
async function grantEnvelope(env, gateway, cred, { t, pid }, over = {}) {
  const prep = await gateway.call({ credential: cred, tool: 'prepare_acquisition_offer', args: { property_id: pid, thread_id: t.thread_id } })
  assert.equal(prep.ok, true, JSON.stringify(prep))
  const r = prep.result
  const args = { client_request_id: over.key || 'submit-0001', thread_id: t.thread_id, property_id: pid, max_price: r.mao.amount, opening_price: r.opening.recommended,
    closing_window_min_days: 14, closing_window_max_days: 30, earnest_money_min: 1000, earnest_money_max: 1000, as_is: true, closing_costs_paid_by: 'buyer', expires_in_days: 7, plan_hash: r.plan_hash, ...(over.args || {}) }
  const out = await approveAndRetry(env, gateway, cred, 'submit_offer_for_approval', args)
  return { prep: r, args, ...out }
}

async function fullyAuthorized(env, gateway, cred, o, { max_sends = 1 } = {}) {
  const g = await grantEnvelope(env, gateway, cred, o)
  assert.equal(g.final.code, 'ENVELOPE_GRANTED', JSON.stringify(g.final))
  const sa = await operatorSendAuthorization(env, { thread_key: o.t.phone, pid: o.pid, max_sends })
  return { ...g, sa }
}

test('PG T4 prepare: a lane-labelled valuation, the MAO as the CEILING, an opening STRICTLY below it, provenance; nothing stored or sent; capability gated by grant + tier', { skip }, async () => {
  const { env, cred, t, pid, mao } = await world()
  try {
    const { gateway } = makeGateway(env)
    const r = await gateway.call({ credential: cred, tool: 'prepare_acquisition_offer', args: { property_id: pid, thread_id: t.thread_id } })
    assert.equal(r.ok, true, JSON.stringify(r))
    const p = r.result
    assert.equal(p.mao.amount, mao)
    assert.equal(p.mao.role, 'ceiling_not_opening')
    assert.ok(p.opening.recommended < p.mao.amount, 'strictly below the ceiling')
    assert.equal(p.lane, 'sfr')
    assert.ok(p.valuation.as_is_value?.source, 'provenance on the values')
    assert.deepEqual([p.sent, p.stored, p.seller_facing], [false, false, false])
    assert.match(p.plan_hash, /^[0-9a-f]{64}$/)
    assert.notEqual(p.economics.class, 'HOT_UNECONOMIC')
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents`))[0].n, 0, 'a read opens no intent')
    assert.equal((await sellerOffers(env)).length, 0)
    const low = await agent(env, { agent_id: 'agt_low', tier_ceiling: 3 })
    assert.equal((await gateway.call({ credential: low, tool: 'prepare_acquisition_offer', args: { property_id: pid } })).error.code, 'TIER_ABOVE_CEILING')
    // uneconomic (no engine ceiling) ⇒ no opening and never HOT
    await env.owner.query(`update public.property_acquisition_scores set decision_tier = 'REVIEW_REQUIRED'`)
    const u = await gateway.call({ credential: cred, tool: 'prepare_acquisition_offer', args: { property_id: pid } })
    assert.deepEqual([u.result.available, u.result.opening, u.result.mao], [false, null, null])
    assert.notEqual(u.result.economics.class, 'HOT')
  } finally { await env.db.drop() }
})

test('PG T4 happy path: submit (human approval) → envelope for EXACTLY this thread + property → operator send authorization (D6) → execute (envelope-authorized, no per-use approval) → ONE seller_offers row under the ceiling, ONE ledger event, ONE queued offer → ONE simulated send', { skip }, async () => {
  const o = await world()
  const { env, cred, t, pid } = o
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    const { prep, first, final, sa } = await fullyAuthorized(env, gateway, cred, o)
    assert.equal(first.status, 'approval_pending')
    const env1 = (await sel(env.owner, `select * from public.negotiation_envelopes`))
    assert.equal(env1.length, 1)
    assert.deepEqual([Number(env1[0].max_price), Number(env1[0].opening_price), env1[0].property_id], [prep.mao.amount, prep.opening.recommended, pid])
    assert.equal(env1[0].approval_id, first.approval.approval_id, 'the envelope is bound to the human approval record')
    assert.ok(sa.send_authorization_id)
    const ex = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: { client_request_id: 'exec-0001', thread_id: t.thread_id, property_id: pid, amount: prep.opening.recommended } })
    assert.equal(ex.ok, true, JSON.stringify(ex))
    assert.equal(ex.code, 'HANDOFF_QUEUED')
    const auth = (await sel(env.owner, `select * from action_gateway.action_authorizations where intent_id = $1`, [ex.intent_id]))[0]
    assert.deepEqual([auth.envelope_ref, auth.approval_id], [`send_authorization:${sa.send_authorization_id}`, null])
    assert.equal((await sel(env.owner, `select count(*)::int n from public.negotiation_send_authorization_uses`))[0].n, 1, 'the durable budget is consumed with the handoff')
    const w = worker(env)
    const tk = await w.tick()
    assert.equal(tk.jobs?.[0]?.outcome, 'completed', JSON.stringify(tk))
    const rec = await receipt(env, ex.intent_id)
    assert.equal(rec.state, 'enqueued', JSON.stringify(rec))
    const offers = await sellerOffers(env)
    assert.equal(offers.length, 1)
    assert.ok(Number(offers[0].purchase_price) <= Number(offers[0].authorized_ceiling), 'persisted under the ceiling')
    assert.equal(Number(offers[0].purchase_price), prep.opening.recommended)
    assert.equal((await sel(env.owner, `select count(*)::int n from public.negotiation_offer_events where seller_offer_id = $1`, [offers[0].offer_id]))[0].n, 1)
    const rows = await offerRows(env)
    assert.equal(rows.length, 1)
    assert.match(rows[0].message_body, new RegExp(`\\$${prep.opening.recommended.toLocaleString('en-US').replace(/,/g, ',')}`))
    assert.doesNotMatch(rows[0].message_body, new RegExp(prep.mao.amount.toLocaleString('en-US')), 'the ceiling never reaches the seller')
    assert.deepEqual([rows[0].from_phone_number, rows[0].to_phone_number, rows[0].agent_name], [OURS, SELLER, 'Helen'])
    await liveDispatch(env)
    const sim = simProvider()
    const d = await dispatchQueued(env, w, rows[0].id, sim)
    assert.equal(sim.sent.length, 1, JSON.stringify(d).slice(0, 400))
    await w.execution.reconcileReceipts()
    assert.equal((await receipt(env, ex.intent_id)).state, 'sent')
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

const execArgs = (o, prep, key = 'exec-0001', amount = prep.opening.recommended) => ({ client_request_id: key, thread_id: o.t.thread_id, property_id: o.pid, amount })

test('PG T4: the negotiation capability OFF ⇒ execute is capability_unavailable whatever the grants (prepare / submit stay available; nothing is sent)', { skip }, async () => {
  const o = await world({ negotiation: null })
  const { env, cred } = o
  try {
    const { gateway } = makeGateway(env)
    const g = await grantEnvelope(env, gateway, cred, o)
    assert.equal(g.final.code, 'ENVELOPE_GRANTED')
    const r = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep) })
    assert.deepEqual([r.error.class, r.error.code], ['unavailable', 'capability_unavailable'], JSON.stringify(r))
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_intents where action = 'execute_authorized_offer'`))[0].n, 0)
  } finally { await env.db.drop() }
})

test('PG T4 refusals: no send authorization; an amount above the envelope / not the engine\'s move; an EXPIRED envelope; an envelope for another thread + property; a forged envelope ref in the arguments', { skip }, async () => {
  const o = await world()
  const { env, cred } = o
  try {
    const { gateway } = makeGateway(env)
    const g = await grantEnvelope(env, gateway, cred, o)
    // the envelope alone is NOT permission to send
    const noSa = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep, 'exec-nosa-01') })
    assert.deepEqual([noSa.state, noSa.code], ['refused', 'NO_SEND_AUTHORIZATION'], JSON.stringify(noSa))
    await operatorSendAuthorization(env, { thread_key: o.t.phone, pid: o.pid })
    const above = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep, 'exec-above-1', g.prep.mao.amount + 5000) })
    assert.equal(above.state, 'refused'); assert.match(above.code, /ABOVE/, above.code)
    const other = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep, 'exec-move-01', g.prep.opening.recommended - 1000) })
    assert.deepEqual([other.state, other.code], ['refused', 'MOVE_AMOUNT_MISMATCH'], JSON.stringify(other))
    const later = makeGateway(env, { now: () => Date.now() + 8 * 864e5 }).gateway
    const expired = await later.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep, 'exec-late-01') })
    assert.equal(expired.state, 'refused'); assert.match(expired.code, /EXPIRED/, expired.code)
    // another thread + property: no envelope there
    const o2 = await seedOfferWorld(env, { pid: '338987953', phone: '+13125550163' })
    const cross = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: { client_request_id: 'exec-cross-1', thread_id: o2.t.thread_id, property_id: o2.pid, amount: g.prep.opening.recommended } })
    assert.deepEqual([cross.state, cross.code], ['refused', 'NO_ENVELOPE'], JSON.stringify(cross))
    // the agent can never name the envelope / approval itself
    const forged = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: { ...execArgs(o, g.prep, 'exec-forge-1'), approval_id: g.first.approval.approval_id } })
    assert.equal(forged.error.code, 'FORGED_CONTEXT')
    const forged2 = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: { ...execArgs(o, g.prep, 'exec-forge-2'), envelope_ref: 'send_authorization:00000000-0000-4000-8000-000000000001' } })
    assert.equal(forged2.error.code, 'INPUT_INVALID')
    assert.equal((await sel(env.owner, `select count(*)::int n from public.negotiation_send_authorization_uses`))[0].n, 0, 'no refusal consumed the budget')
  } finally { await env.db.drop() }
})

test('PG T4 database backstop: an envelope ref for ANOTHER thread + property, presented straight to the database (the JS policy bypassed), is refused by the authorization guard', { skip }, async () => {
  const o = await world()
  const { env, cred } = o
  try {
    const { gateway, store } = makeGateway(env)
    const g = await grantEnvelope(env, gateway, cred, o)
    const sa = await operatorSendAuthorization(env, { thread_key: o.t.phone, pid: o.pid })
    const o2 = await seedOfferWorld(env, { pid: '338987953', phone: '+13125550163' })
    const { credentialDigest } = await import('../../src/lib/domain/action-gateway/credentials.js')
    const { PEPPER } = await import('../helpers/action-gateway-pg.mjs')
    const digest = credentialDigest(PEPPER, cred)
    const p = await store.principal(digest)
    const grant = p.grants.find((x) => x.capability === 'offers.execute_authorized')
    const { encodePropertyRef } = await import('../../src/lib/agent/missions/mission-codec.js')
    const opened = await store.openIntent({ agent_id: p.agent_id, action: 'execute_authorized_offer', capability: 'offers.execute_authorized', tier: 4, resource_type: 'thread', resource_id: o2.t.thread_id,
      client_key: 'bypass-0001', idempotency_key: crypto.createHash('sha256').update('bypass').digest('hex'), params: { thread_id: o2.t.thread_id, property_ref: encodePropertyRef(o2.pid), amount: g.prep.opening.recommended, send_permit_id: sa.send_authorization_id, runtime_kind: 'action_gateway.execute' },
      params_hash: 'a'.repeat(64), correlation_id: crypto.randomUUID(), recovery: 'reexecute', max_attempts: 3 })
    await assert.rejects(store.authorizeEnvelope(opened.intent.intent_id, digest, { grant_id: grant.grant_id, policy_id: 'execute_authorized_offer.policy', policy_version: 'v1', envelope_ref: `send_authorization:${sa.send_authorization_id}` }), /ENVELOPE_SCOPE_MISMATCH/)
    // and an envelope ref on an action that is not envelope-authorized
    await assert.rejects(store.authorizeEnvelope(opened.intent.intent_id, digest, { grant_id: grant.grant_id, policy_id: 'x.policy', policy_version: 'v1', envelope_ref: 'send_authorization:not-a-uuid' }), /ENVELOPE_REF_INVALID|ENVELOPE/)
    assert.equal((await sel(env.owner, `select count(*)::int n from action_gateway.action_authorizations where intent_id = $1`, [opened.intent.intent_id]))[0].n, 0)
  } finally { await env.db.drop() }
})

test('PG T4: send-budget REPLAY + concurrent agents: two agents racing to execute the same authorized offer (max_sends 1) ⇒ exactly ONE handoff, ONE use, ONE queued offer; any later request is refused', { skip }, async () => {
  const o = await world()
  const { env, cred } = o
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    const g = await fullyAuthorized(env, gateway, cred, o)
    const cred2 = await agent(env, { agent_id: 'agt_beta' })
    const g2 = makeGateway(env).gateway
    const [a, b] = await Promise.all([
      gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep, 'race-a-0001') }),
      g2.call({ credential: cred2, tool: 'execute_authorized_offer', args: execArgs(o, g.prep, 'race-b-0001') }),
    ])
    const codes = [a, b].map((x) => x.code || x.error?.code)
    assert.equal([a, b].filter((x) => x.code === 'HANDOFF_QUEUED').length, 1, JSON.stringify(codes))
    assert.equal((await sel(env.owner, `select count(*)::int n from public.negotiation_send_authorization_uses`))[0].n, 1)
    const late = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep, 'late-0000001') })
    assert.equal(late.state, 'refused'); assert.match(late.code, /BUDGET|EXHAUSTED/, late.code)
    const w = worker(env)
    await w.tick(); await w.tick()
    assert.equal((await offerRows(env)).length, 1)
    assert.equal((await sellerOffers(env)).filter((x) => x.status === 'active').length, 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})

test('PG T4 (REAL SIGKILL): the worker dies after the offer + ledger writes and before the queue insert ⇒ nothing dispatched; the retry finishes exactly ONE queued offer, ONE active offer version, ONE ledger event', { skip }, async () => {
  const o = await world()
  const { env, cred } = o
  try {
    const { gateway } = makeGateway(env)
    const g = await fullyAuthorized(env, gateway, cred, o)
    const ex = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep) })
    assert.equal(ex.code, 'HANDOFF_QUEUED')
    await env.owner.query(`update agent.runtime_limits set runtime_enabled = true, emergency_stop = false, max_concurrency_global = 2, tick_max_jobs = 4, kind_limits = $1::jsonb where id = 1`,
      [JSON.stringify({ 'action_gateway.execute': { enabled: true, max_concurrency: 2, armed_by: OPERATOR } })])
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--import', './tests/register-aliases.mjs', 'tests/helpers/action-gateway-t34-crash-child.mjs', env.db.url, env.db.apiUrl, 'offer'],
      { cwd: API_DIR, env: process.env, encoding: 'utf8', timeout: 120_000 })
    assert.equal(child.signal, 'SIGKILL', `child: ${child.status} ${child.stdout} ${String(child.stderr).slice(-800)}`)
    assert.equal((await offerRows(env)).length, 0)
    assert.equal((await sellerOffers(env)).length, 1, 'the offer was persisted before the kill')
    await env.owner.query(`update agent.research_job set lease_until = clock_timestamp() - interval '1 second' where state in ('claimed','running')`)
    const w = worker(env)
    await w.tick()
    await env.owner.query(`update agent.research_job set next_attempt_at = clock_timestamp() where state = 'retrying'`)
    await w.tick()
    assert.equal((await offerRows(env)).length, 1, 'exactly ONE queued offer')
    assert.equal((await sellerOffers(env)).length, 1, 'the same offer version is reused')
    assert.equal((await sel(env.owner, `select count(*)::int n from public.negotiation_offer_events where actor = 'engine'`))[0].n, 1)
    assert.equal((await receipt(env, ex.intent_id)).state, 'enqueued')
  } finally { await env.db.drop() }
})

test('PG T4: a STOP arriving after the authorization and before LeadCommand prepares the offer ⇒ refused at execution, NOTHING persisted or queued, visible to an operator', { skip }, async () => {
  const o = await world()
  const { env, cred } = o
  try {
    const { gateway } = makeGateway(env)
    const g = await fullyAuthorized(env, gateway, cred, o)
    const ex = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep) })
    assert.equal(ex.code, 'HANDOFF_QUEUED')
    await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
      values ($1, 'SMstop-o', 'inbound', $2::text, $2::text, $3::text, 'STOP', now(), now(), $4, 'en')`, [crypto.randomUUID(), o.t.phone, OURS, o.pid])
    await worker(env).tick()
    const rec = await receipt(env, ex.intent_id)
    assert.deepEqual([rec.state, rec.code], ['refused', 'CONTACT_NOT_PERMITTED_AT_EXECUTION'])
    assert.equal((await sellerOffers(env)).length, 0)
    assert.equal((await offerRows(env)).length, 0)
    assert.equal((await workItems(env)).length, 1)
  } finally { await env.db.drop() }
})

test('PG R4: persistActiveOffer above the ceiling is REFUSED (JS) and the database refuses the same write (trigger); only a complete HUMAN override passes, recorded on the row; an agent "override" never does', { skip }, async () => {
  const o = await world()
  const { env } = o
  try {
    const sb = pgSupabase(env.owner)
    const base = { opportunity_id: o.opp, thread_key: o.t.phone, property_id: o.pid, offer_type: 'initial_offer', supabase: sb }
    const hartford = await persistActiveOffer({ ...base, purchase_price: 315000, authorized_ceiling: 126100 })
    assert.deepEqual([hartford.ok, hartford.reason], [false, 'offer_above_authorized_ceiling'])
    assert.equal((await persistActiveOffer({ ...base, purchase_price: 140000 })).reason, 'offer_ceiling_missing')
    assert.equal((await persistActiveOffer({ ...base, purchase_price: 140000, authorized_ceiling: 200000, mao: 130000 })).reason, 'offer_above_authorized_ceiling', 'the LOWEST ceiling wins')
    const agentOverride = await persistActiveOffer({ ...base, purchase_price: 315000, authorized_ceiling: 126100, ceiling_override: { operator_id: 'agt_alpha', reason: 'the agent thinks it is fine', approval_ref: 'apr_x' } })
    assert.equal(agentOverride.reason, 'offer_above_authorized_ceiling')
    assert.equal((await sellerOffers(env)).length, 0)
    // the database (a writer that skips the JS)
    const ins = (price, ceiling, md = {}) => env.owner.query(`insert into public.seller_offers (offer_id, opportunity_id, thread_key, property_id, offer_version, offer_type, direction, purchase_price, authorized_ceiling, status, terms_hash, metadata)
      values ($1, $2, $3, $4, $5, 'initial_offer', 'outbound', $6, $7, 'active', 'h', $8::jsonb)`, [`offer:${o.opp}:v${Math.floor(Math.random() * 1e6)}`, o.opp, o.t.phone, o.pid, Math.floor(Math.random() * 1e6), price, ceiling, JSON.stringify(md)])
    await assert.rejects(ins(315000, 126100), /SELLER_OFFER_ABOVE_CEILING/)
    await assert.rejects(ins(140000, null), /SELLER_OFFER_CEILING_MISSING/)
    await assert.rejects(ins(315000, 126100, { ceiling_override: { operator_id: 'agent:x', reason: 'long enough reason here', approval_ref: 'r' } }), /SELLER_OFFER_ABOVE_CEILING/)
    const human = await persistActiveOffer({ ...base, purchase_price: 131000, authorized_ceiling: 126100, ceiling_override: { operator_id: OPERATOR, reason: 'owner reviewed the comps by phone', approval_ref: 'ops-ticket-77' } })
    assert.equal(human.ok, true, JSON.stringify(human))
    const row = (await sellerOffers(env))[0]
    assert.equal(row.metadata.ceiling_override.operator_id, OPERATOR)
    assert.equal(Number(row.metadata.ceiling_override.over_by), 4900)
    // a seller counter is the seller's number (never capped here)
    await env.owner.query(`update public.seller_offers set status = 'superseded'`)
    await ins(400000, null, {}).catch(() => null)
    const counter = await env.owner.query(`insert into public.seller_offers (offer_id, opportunity_id, thread_key, property_id, offer_version, offer_type, direction, purchase_price, status, terms_hash, metadata)
      values ('offer:c:v9', $1, $2, $3, 99, 'seller_counter', 'inbound', 400000, 'active', 'h', '{}'::jsonb) returning offer_id`, [o.opp, o.t.phone, o.pid])
    assert.equal(counter.rows.length, 1)
  } finally { await env.db.drop() }
})

test('PG R5: the send budget is DURABLE and race-safe: 8 concurrent consumes of a max_sends=2 authorization ⇒ exactly 2 uses; a retried use replays its own row', { skip }, async () => {
  const o = await world()
  const { env, cred } = o
  try {
    const { gateway } = makeGateway(env)
    await grantEnvelope(env, gateway, cred, o)
    const sa = await operatorSendAuthorization(env, { thread_key: o.t.phone, pid: o.pid, max_sends: 2 })
    const pools = Array.from({ length: 8 }, (_, i) => i)
    const res = await Promise.all(pools.map((i) => env.owner.query(`select public.negotiation_send_authorization_consume($1, $2, 100000) r`, [sa.send_authorization_id, `race:use:${i}`]).then((x) => x.rows[0].r)))
    assert.equal(res.filter((r) => r.ok).length, 2, JSON.stringify(res))
    assert.equal(res.filter((r) => r.reason === 'send_budget_exhausted').length, 6)
    const okKey = `race:use:${res.findIndex((r) => r.ok)}`
    const replay = (await env.owner.query(`select public.negotiation_send_authorization_consume($1, $2, 100000) r`, [sa.send_authorization_id, okKey])).rows[0].r
    assert.deepEqual([replay.ok, replay.replayed], [true, true])
    assert.equal((await sel(env.owner, `select count(*)::int n from public.negotiation_send_authorization_uses`))[0].n, 2)
    await assert.rejects(env.owner.query(`update public.negotiation_send_authorization_uses set amount = 1`), /append-only/)
  } finally { await env.db.drop() }
})

test('PG counteroffer: the price must be stated in the bound inbound; a human approves the recording; it becomes a NEW seller-counter version and a ledger event, and is NEVER auto-accepted (the acceptance guard routes it to a human)', { skip }, async () => {
  const o = await world()
  const { env, cred } = o
  const net = trapTransport()
  try {
    const { gateway } = makeGateway(env)
    // an outbound offer on record first (ours), then the seller's counter
    const g = await fullyAuthorized(env, gateway, cred, o)
    const ex = await gateway.call({ credential: cred, tool: 'execute_authorized_offer', args: execArgs(o, g.prep) })
    assert.equal(ex.code, 'HANDOFF_QUEUED')
    const w = worker(env)
    await w.tick()
    const inId = crypto.randomUUID()
    await env.owner.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
      values ($1, 'SMcounter', 'inbound', $2::text, $2::text, $3::text, 'I would take $165,000 for it', now(), now(), $4, 'en')`, [inId, o.t.phone, OURS, o.pid])
    const bad = await gateway.call({ credential: cred, tool: 'record_seller_counteroffer', args: { client_request_id: 'counter-bad1', thread_id: o.t.thread_id, inbound_message_id: inId, counter_price: 150000 } })
    assert.deepEqual([bad.state, bad.code], ['refused', 'COUNTER_PRICE_NOT_IN_MESSAGE'], JSON.stringify(bad))
    const { first, final } = await approveAndRetry(env, gateway, cred, 'record_seller_counteroffer', { client_request_id: 'counter-ok01', thread_id: o.t.thread_id, inbound_message_id: inId, counter_price: 165000 })
    assert.equal(first.status, 'approval_pending', 'an irreversible T2 needs a human')
    assert.equal(final.code, 'HANDOFF_QUEUED', JSON.stringify(final))
    await w.tick()
    const rec = await receipt(env, final.intent_id)
    assert.deepEqual([rec.state, rec.code], ['recorded', 'COUNTER_RECORDED'], JSON.stringify(rec))
    assert.equal(rec.detail.auto_accepted, false)
    assert.equal(rec.detail.acceptance_automatable, false)
    assert.ok(rec.detail.acceptance_review_reasons.length >= 1, JSON.stringify(rec.detail))
    const offers = await sellerOffers(env)
    const counter = offers.find((x) => x.offer_type === 'seller_counter')
    assert.deepEqual([counter.direction, Number(counter.purchase_price), counter.status], ['inbound', 165000, 'active'])
    assert.equal(offers.filter((x) => x.status === 'accepted').length, 0, 'nothing is ever accepted')
    assert.ok(offers.some((x) => x.direction === 'outbound' && x.status === 'superseded'), 'history is kept')
    assert.equal((await sel(env.owner, `select count(*)::int n from public.negotiation_offer_events where event_type = 'seller_counter' and source_message_id = $1`, [inId]))[0].n, 1)
    assert.deepEqual(net.hits, [])
  } finally { net.restore(); await env.db.drop() }
})
