// 8.5.20 part C — Inbound Action Center: state derivation (exactly one of nine), the
// lost-conversation detector, archive ≠ resolved, unread ≠ unresolved, the verified stage,
// the reconciler job (durable rows + lost work items, lease-bound) and the API gate.
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConversationFacts } from '../../src/lib/agent/operations/conversation-facts.js'
import { deriveActionState, isLostConversation, summarizeActionStates, verifiedStage, ACTION_STATES, ACTIVE_QUEUE_STATES } from '../../src/lib/agent/operations/action-center.js'
import { createActionCenterHandler } from '../../src/lib/agent/operations/operations-handlers.js'
import { createOperationsMemorySource } from '../../src/lib/agent/operations/operations-source.js'
import { createOperationsMemoryStore } from '../../src/lib/agent/operations/operations-store.js'
import { ACTION_CENTER_KIND } from '../../src/lib/agent/operations/operations-kinds.js'
import { handleActionCenter, handleWorkItemDecide, handleBrief } from '../../src/lib/agent/operations/operations-routes.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { conv, waiting, uuid, T0, H, D, at } from '../helpers/operations-fixtures.mjs'

const OP = '11111111-1111-4111-8111-111111111111'
const derive = (row, o = {}) => deriveActionState(normalizeConversationFacts(row), { now: T0, ...o })

test('nine states, one active queue state', () => {
  assert.deepEqual(ACTION_STATES, ['needs_attention', 'ai_handling', 'researching', 'negotiating', 'awaiting_operator_decision', 'scheduled_follow_up', 'waiting_on_seller', 'resolved', 'suppressed_ineligible'])
  assert.deepEqual(ACTIVE_QUEUE_STATES, ['needs_attention'])
})

test('each state is derived from real events, with owner, verified stage, next action, due date, priority reason, evidence refs', () => {
  const cases = [
    ['suppressed_ineligible', conv({ any_opt_out: true })],
    ['suppressed_ineligible', conv({ inbound_intents: ['wrong_number'] })],
    ['resolved', conv({ opportunity_id: uuid(), opp_stage: 'closed', opp_status: 'dead', opp_stage_entered_at: at(T0 - D), last_inbound_at: at(T0 - 3 * D), last_meaningful_at: at(T0 - 3 * D) })],
    ['ai_handling', waiting({ pending_count: 1, next_pending_at: at(T0 + 10 * 60_000) })],
    ['needs_attention', waiting()],
    ['negotiating', conv({ opportunity_id: uuid(), opp_stage: 'asking_price', opp_status: 'active', opp_next_action: 'Ask condition', opp_next_action_due: at(T0 + D) })],
    ['scheduled_follow_up', conv({ last_outbound_at: at(T0 - 5 * D), last_inbound_at: at(T0 - 6 * D), last_meaningful_at: at(T0 - 6 * D), follow_up_at: at(T0 + 2 * D) })],
    ['waiting_on_seller', conv()],
  ]
  for (const [want, row] of cases) {
    const s = derive(row)
    assert.equal(s.state, want, `${want}: ${JSON.stringify(s.reasons)}`)
    assert.ok(ACTION_STATES.includes(s.state))
    assert.ok(s.owner && s.next_action && s.priority_reason, want)
    assert.ok(Array.isArray(s.evidence_refs) && Array.isArray(s.pending_approvals))
    if (['scheduled_follow_up', 'negotiating', 'ai_handling'].includes(want)) assert.ok(s.due_at, `${want} is scheduled ⇒ due date`)
    if (want === 'needs_attention') assert.equal(s.owner, 'none')
  }
})

test('awaiting operator decision: a pending approval on the opportunity, or an ACKNOWLEDGED review item — an item the reconcilers opened themselves assigns nothing', () => {
  const opp = uuid()
  const row = waiting({ opportunity_id: opp, opp_stage: 'asking_price', opp_status: 'active' })
  const a = derive(row, { approvals: [{ approval_id: `apr_${uuid()}`, capability_id: 'pipeline.propose_stage_change', expires_at: at(T0 + H) }] })
  assert.equal(a.state, 'awaiting_operator_decision')
  assert.equal(a.pending_approvals.length, 1)
  assert.equal(derive(row, { work: [{ kind: 'lost_conversation', state: 'open' }] }).state, 'needs_attention', 'an unclaimed item does not hide the conversation')
  assert.equal(derive(row, { work: [{ kind: 'recovery_review', state: 'acknowledged' }] }).state, 'awaiting_operator_decision')
  assert.equal(derive(row, { work: [{ kind: 'recovery_research', state: 'acknowledged' }] }).state, 'researching')
})

test('lost-conversation detector: a meaningful inbound past the grace with no next action of any kind', () => {
  const lost = derive(waiting({ last_inbound_at: at(T0 - 3 * H), last_meaningful_at: at(T0 - 3 * H) }))
  assert.equal(lost.state, 'needs_attention')
  assert.equal(isLostConversation(lost), true)
  assert.ok(lost.reasons.includes('meaningful_inbound_without_next_action'))
  const fresh = derive(waiting({ last_inbound_at: at(T0 - 10 * 60_000), last_meaningful_at: at(T0 - 10 * 60_000), last_outbound_at: at(T0 - H) }))
  assert.equal(fresh.state, 'needs_attention')
  assert.equal(isLostConversation(fresh), false, 'inside the grace: attention, not yet lost')
  // a reaction is not meaningful: nothing to answer
  const reaction = derive(conv({ inbound_intents: ['reaction_only'], last_inbound_intent: 'reaction_only', last_meaningful_id: null, last_meaningful_at: null, last_meaningful_intent: null, last_outbound_at: at(T0 - D), last_inbound_at: at(T0 - 3 * H) }))
  assert.notEqual(reaction.state, 'needs_attention')
  // a queued reply that is stuck in the past is nobody's next action
  const stuck = derive(waiting({ pending_count: 1, next_pending_at: at(T0 - 2 * D) }))
  assert.equal(stuck.state, 'needs_attention')
  assert.ok(stuck.reasons.includes('queued_reply_overdue'))
  // a failed reply after the seller wrote: still lost, with the retry-safety fact
  const failed = derive(waiting({ outbound_after_inbound: 1, failed_after_inbound: 1, last_outbound_at: at(T0 - H) }))
  assert.equal(failed.state, 'needs_attention', 'a reply that failed is not an answer')
  assert.ok(failed.reasons.includes('reply_failed_after_provider_accepted'))
})

test('"No" to selling: a scheduled 30-day follow-up is the next action; none scheduled is lost (policy follow-up missing)', () => {
  const ni = { inbound_intents: ['not_interested'], last_meaningful_intent: 'not_interested', last_inbound_intent: 'not_interested', last_inbound_at: at(T0 - 2 * D), last_meaningful_at: at(T0 - 2 * D), last_outbound_at: at(T0 - 3 * D) }
  assert.equal(derive(waiting({ ...ni, follow_up_at: at(T0 + 28 * D) })).state, 'scheduled_follow_up')
  const missing = derive(waiting(ni))
  assert.equal(missing.state, 'needs_attention')
  assert.deepEqual(missing.reasons, ['not_interested_without_scheduled_follow_up'])
  assert.equal(missing.next_action, 'schedule the 30-day follow-up')
  assert.equal(missing.lost, true)
})

test('ARCHIVE ≠ RESOLVED, UNREAD ≠ UNRESOLVED: the archive flag, the read flag and the bucket change nothing', () => {
  const base = waiting({ inbound_intents: ['asks_offer'], last_meaningful_intent: 'asks_offer' })
  const variants = [
    { is_archived: true, archive_reason: 'owner_pipeline_cleanup_20261010:negative' }, { is_archived: false }, { is_read: true }, { is_read: false },
    { inbox_bucket: 'dead' }, { inbox_bucket: null }, { inbox_bucket: 'priority' },
  ]
  const states = variants.map((v) => derive({ ...base, ...v }))
  for (const s of states) {
    assert.equal(s.state, 'needs_attention')
    assert.equal(s.lost, true)
  }
  assert.equal(new Set(states.map((s) => JSON.stringify({ ...s, derived_from: null }))).size, 1, 'identical derivation')
  // and the converse: an archived, read conversation that IS handled is not resurrected
  assert.equal(derive(conv({ is_archived: true, is_read: true })).state, 'waiting_on_seller')
})

test('verified stage: offer needs an offer event, contract stages a live closing case; parsed thread stages are evidence only', () => {
  const v = (o) => verifiedStage(normalizeConversationFacts(conv(o)))
  assert.deepEqual([v({ opportunity_id: uuid(), opp_stage: 'offer', opp_status: 'active' }).verified, v({ opportunity_id: uuid(), opp_stage: 'offer', opp_status: 'active' }).reason], [false, 'offer_stage_without_offer_event'])
  assert.equal(v({ opportunity_id: uuid(), opp_stage: 'offer', opp_status: 'active', offers_sent: 1 }).verified, true)
  assert.equal(v({ opportunity_id: uuid(), opp_stage: 'under_contract', opp_status: 'active' }).reason, 'contract_stage_without_live_closing_case')
  assert.equal(v({ opportunity_id: uuid(), opp_stage: 'under_contract', opp_status: 'active', live_closing_case: true }).verified, true)
  const thread = v({ seller_stage: 'property_condition' })
  assert.deepEqual([thread.stage, thread.verified, thread.source], ['property_condition', false, 'thread_evidence'])
})

test('summary: counts per state, the active queue and lost', () => {
  const s = summarizeActionStates([derive(waiting()), derive(conv()), derive(conv({ any_opt_out: true }))])
  assert.equal(s.counts.needs_attention, 1)
  assert.equal(s.active_queue, 1)
  assert.equal(s.lost, 1)
  assert.equal(s.total, 3)
})

test('inbox.action_center job: durable rows (lease-bound), lost work items + findings, auto-resolve when answered, $0, no send', async () => {
  let t = T0
  const runtime = createRuntimeMemoryStore({ now: () => t, limits: { runtime_enabled: true, max_concurrency_global: 2, tick_max_jobs: 2, lease_seconds: 60, kind_limits: { [ACTION_CENTER_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  const lostId = uuid()
  const rows = [waiting({ conversation_id: lostId, is_archived: true }), conv(), conv({ any_opt_out: true })]
  const source = createOperationsMemorySource({ conversations: rows })
  const store = createOperationsMemoryStore({ runtime, now: () => t })
  const handler = createActionCenterHandler({ source, store, now: () => t })
  const run = async (k) => { await runtime.enqueue({ kind: ACTION_CENTER_KIND, idempotency_key: k.repeat(64), input: {}, requested_by: OP }); await runRuntimeTick({ store: runtime, handlers: { [ACTION_CENTER_KIND]: handler }, workerId: 'w', budgetMs: 20_000, now: () => t }) }
  await run('a')
  const job = [...runtime._state.jobs.values()][0]
  assert.equal(job.state, 'completed', JSON.stringify(job.last_error))
  assert.equal(job.result.lost, 1)
  assert.equal(job.result.sends, 0)
  assert.equal(store._states.size, 3)
  assert.equal(store._states.get(lostId).state, 'needs_attention')
  assert.equal(store._items.get(`action_center:lost:${lostId}`).state, 'open')
  assert.ok([...runtime._state.findings.values()].some((f) => f.finding_type === 'inbox.lost_conversation' && f.key === `conv.${lostId}`))
  // someone answers: the next run moves it to waiting_on_seller and resolves the lost item
  Object.assign(rows[0], { outbound_after_inbound: 1, delivered_after_inbound: 1, last_outbound_at: at(T0 + 10 * 60_000) })
  t += 30 * 60_000
  await run('b')
  assert.equal(store._states.get(lostId).state, 'waiting_on_seller')
  assert.equal(store._items.get(`action_center:lost:${lostId}`).state, 'resolved')
  assert.ok(!runtime._state.ledger.length)
  // a lease that is not this kind's cannot write action states
  assert.deepEqual(await store.upsertActionStates({ job_id: job.job_id, token: 'x', rows: [] }), { ok: false, reason: 'lease_lost' })
})

// ── API ────────────────────────────────────────────────────────────────────
const ENV = { AGENT_ENABLED: '1', AGENT_OPERATIONS_ENABLED: '1' }
const okAuth = () => ({ ok: true })
const identity = { authenticate: async () => ({ ok: true, identity: { user_id: OP } }) }
const limiter = { check: () => ({ ok: true }) }

test('API: 404 empty unless AGENT_ENABLED + AGENT_OPERATIONS_ENABLED; 403 without membership; truthful not-run / not-applied states', async () => {
  const store = createOperationsMemoryStore()
  const svc = { store, membership: async () => ({ role: 'owner' }) }
  const req = (u) => new Request(`http://x/api/cockpit/agent/operations/${u}`)
  const off = await handleActionCenter(req('action-center'), { env: { AGENT_ENABLED: '1' }, auth: okAuth, identity, limiter, getServices: async () => svc })
  assert.equal(off.status, 404)
  assert.equal(await off.text(), '')
  const nm = await handleActionCenter(req('action-center'), { env: ENV, auth: okAuth, identity, limiter, getServices: async () => ({ ...svc, membership: async () => null }) })
  assert.equal(nm.status, 403)
  const notRun = await (await handleActionCenter(req('action-center'), { env: ENV, auth: okAuth, identity, limiter, getServices: async () => svc })).json()
  assert.deepEqual([notRun.available, notRun.code], [false, 'ACTION_CENTER_NOT_RUN'])
  const broken = { ...svc, store: { ...store, actionCenterSummary: async () => { throw Object.assign(new Error('x'), { code: 'OPERATIONS_NOT_APPLIED' }) }, listActionStates: async () => [] } }
  const na = await (await handleActionCenter(req('action-center'), { env: ENV, auth: okAuth, identity, limiter, getServices: async () => broken })).json()
  assert.deepEqual([na.available, na.code], [false, 'OPERATIONS_NOT_APPLIED'])
  const brief = await (await handleBrief(req('brief'), { env: ENV, auth: okAuth, identity, limiter, getServices: async () => svc })).json()
  assert.deepEqual([brief.available, brief.code], [false, 'BRIEF_NOT_GENERATED'])
  const bad = await handleWorkItemDecide(new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'delete' }) }), uuid(), { env: ENV, auth: okAuth, identity, limiter, getServices: async () => svc })
  assert.equal(bad.status, 422)
})
