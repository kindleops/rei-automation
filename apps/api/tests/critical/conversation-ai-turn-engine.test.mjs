// rc-8.5.20 part A — the 24/7 event-driven conversation engine: the adaptive 3–40 min delay
// planner, deterministic event routing, turn consolidation (burst → one decision), stale-draft
// invalidation, opt-out immediacy, one reply per turn, restart recovery. Memory stores here;
// the SQL contract is proven on a disposable PG17 (conversation-ai-turns-pg.test.mjs and
// scripts/db/run-migration-test.mjs --id conversation_reply_turns).
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { planReplyDelay, DELAY_BOUNDS, DEFAULT_DELAY_POLICY, normalizeDelayPolicy, truncatedLogNormal, nextLocalOpen, inLocalWindow } from '../../src/lib/domain/conversation-ai/turns/delay-planner.js'
import { routeConversationEvent, ROUTES, ROUTE_PRIORITY } from '../../src/lib/domain/conversation-ai/turns/events.js'
import { createMemoryTurnStore } from '../../src/lib/domain/conversation-ai/turns/turn-store.js'
import {
  handleConversationEvent, runDueTurn, recoverDueTurns, planInputsFromThread, turnJobInput, decodeTurnJobInput, turnEventKey,
  CONVERSATION_TURN_KIND, CONVERSATION_TURN_SWEEP_KIND, turnsRequested,
} from '../../src/lib/domain/conversation-ai/turns/turn-engine.js'
import { buildCanonicalLedger } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { createRuntimeMemoryStore } from '../../src/lib/agent/runtime/job-runtime.js'
import { runRuntimeTick } from '../../src/lib/agent/runtime/runtime-tick.js'
import { createConversationTurnHandler, createConversationTurnSweepHandler } from '../../src/lib/ai/conversation-turn-handler.js'
import { conversationRuntimeHandlers, createConversationDecideHandler, turnRouteResult } from '../../src/lib/ai/conversation-decide-handler.js'
import { conversationDecidePriority, scheduleConversationTurnChange, CONVERSATION_DECIDE_KIND, encodeRef } from '../../src/lib/ai/conversation-ai-shadow-hook.js'
import { importClosure } from '../helpers/import-graph.mjs'

const TZ = 'America/Chicago'
const NOON = '2026-10-14T17:00:00.000Z' // 12:00 CDT
const OP = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
const SELLER = '+15555550101'
const MIN = 60_000
const plus = (iso, min) => new Date(Date.parse(iso) + min * MIN).toISOString()
const plan = (over = {}) => planReplyDelay({ seed: 'turn-x#1', now: NOON, lastInboundAt: NOON, timezone: TZ, ...over })
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(q * (s.length - 1))] }
const sample = (over = {}, n = 400) => Array.from({ length: n }, (_, i) => plan({ seed: `s${i}`, ...over }).since_inbound_minutes)

// ── the delay planner ───────────────────────────────────────────────────────
test('planner: every delay is inside [3, 40] minutes, non-mechanical (no point mass, seconds kept), deterministic per seed', () => {
  const xs = sample({}, 3000)
  assert.ok(Math.min(...xs) >= DELAY_BOUNDS.min_minutes && Math.max(...xs) <= DELAY_BOUNDS.max_minutes)
  assert.ok(new Set(xs).size > 600, `distinct delays: ${new Set(xs).size}`)
  assert.ok(xs.filter((x) => x === 3 || x === 40).length < 15, 'no pile-up at the bounds')
  assert.ok(xs.filter((x) => Number.isInteger(x)).length < xs.length * 0.05, 'not whole minutes')
  const p50 = quantile(xs, 0.5)
  assert.ok(p50 > 6 && p50 < 13, `prior median ~9: ${p50}`)
  assert.deepEqual(plan(), plan(), 'the same turn version always plans the same time')
  assert.notEqual(plan({ seed: 'a' }).due_at, plan({ seed: 'b' }).due_at)
  // truncation by inverse CDF stays inside the bounds even for an extreme center
  for (const u of [0, 1e-9, 0.5, 1 - 1e-9, 1]) for (const c of [0.5, 3, 40, 400]) {
    const x = truncatedLogNormal(u, c, 0.5); assert.ok(x >= 3 && x <= 40, `${u} ${c} ${x}`)
  }
})

test('planner adaptivity: mirrors the seller cadence (shrunk toward the prior when thin); negotiation shorter; complexity / underwriting / weak sender longer', () => {
  const med = (over) => quantile(sample(over), 0.5)
  const prior = med({})
  const fast = med({ sellerReplyLatenciesMinutes: [1, 2, 2, 3, 2, 1, 2, 2] })
  const slow = med({ sellerReplyLatenciesMinutes: [120, 200, 180, 240, 90, 300, 150, 160] })
  assert.ok(fast < prior && prior < slow, `fast ${fast} < prior ${prior} < slow ${slow}`)
  // shrinkage: one fast observation moves the center less than eight
  const one = plan({ sellerReplyLatenciesMinutes: [1] })
  const eight = plan({ sellerReplyLatenciesMinutes: [1, 1, 1, 1, 1, 1, 1, 1] })
  assert.equal(one.confidence, 'thin_history'); assert.equal(eight.confidence, 'observed'); assert.equal(plan().confidence, 'prior')
  assert.ok(one.center_minutes > eight.center_minutes, `${one.center_minutes} > ${eight.center_minutes}`)
  assert.ok(one.shrinkage_weight < 0.5 && eight.shrinkage_weight > 0.5)
  assert.ok(med({ activeNegotiation: true }) < prior, 'active negotiation answers sooner')
  assert.ok(med({ urgency: 1 }) < prior, 'urgency answers sooner')
  assert.ok(med({ complexity: 1 }) > prior, 'complex turns take longer')
  assert.ok(med({ underwriting: { required: true, ready: false } }) > prior, 'underwriting not ready takes longer')
  assert.ok(med({ underwriting: { required: true, ready: true } }) <= prior * 1.05)
  assert.ok(med({ senderHealth: 0.2 }) > prior, 'an unhealthy sender slows down')
  assert.ok(med({ engagement: 1 }) < med({ engagement: 0 }), 'engaged sellers sooner')
  const burst = plan({ recentInboundAts: [plus(NOON, -2), plus(NOON, -1), NOON] })
  assert.equal(burst.factors.seller_mid_burst, 1.15)
})

test('planner window: night inbound stays in session (owner rule 10-10); outside both ⇒ the next lawful time, never a bypass', () => {
  const night = '2026-10-15T04:30:00.000Z' // 23:30 CDT
  const inSession = plan({ now: night, lastInboundAt: night })
  assert.equal(inSession.action, 'schedule')
  assert.equal(inSession.window.lawful_basis, 'in_session')
  assert.ok(inSession.since_inbound_minutes <= DEFAULT_DELAY_POLICY.in_session_minutes - DEFAULT_DELAY_POLICY.session_margin_minutes)
  // in-session replies disabled ⇒ deferred to the next local open (08:02–08:24 CDT), never at night
  for (let i = 0; i < 50; i += 1) {
    const p = plan({ seed: `n${i}`, now: night, lastInboundAt: night, policy: { in_session_minutes: 0 } })
    assert.equal(p.action, 'schedule')
    assert.ok(p.reasons.includes('deferred_to_contact_window'))
    assert.ok(inLocalWindow(Date.parse(p.due_at), TZ, { start_hour: 8, end_hour: 21 }), p.due_at)
    const local = new Date(Date.parse(p.due_at) - 5 * 3600_000).toISOString().slice(11, 16)
    assert.ok(local >= '08:02' && local <= '08:24', local)
  }
  // a slow target late in the evening is pulled into the session rather than leaving the window
  const evening = '2026-10-15T01:50:00.000Z' // 20:50 CDT
  for (let i = 0; i < 30; i += 1) {
    const p = plan({ seed: `e${i}`, now: evening, lastInboundAt: evening, sellerReplyLatenciesMinutes: Array(10).fill(300), complexity: 1, underwriting: { required: true, ready: false } })
    const due = Date.parse(p.due_at)
    const ok = inLocalWindow(due, TZ, { start_hour: 8, end_hour: 21 }) || due - Date.parse(evening) <= 28 * MIN
    assert.ok(ok && p.since_inbound_minutes >= 3, JSON.stringify(p))
  }
  // unknown recipient zone: only the session is lawful; past it ⇒ hold
  assert.equal(plan({ timezone: null }).action, 'schedule')
  assert.deepEqual(plan({ timezone: null, policy: { in_session_minutes: 0 } }).reasons, ['recipient_timezone_unresolved'])
  assert.equal(nextLocalOpen(Date.parse(night), TZ, { start_hour: 8, end_hour: 21 }), Date.parse('2026-10-15T13:00:00.000Z'))
  // a caller cannot widen the window or the bounds
  const n = normalizeDelayPolicy({ contact_window: { start_hour: 0, end_hour: 24 }, in_session_minutes: 999 })
  assert.deepEqual(n.contact_window, { start_hour: 8, end_hour: 21 })
  assert.equal(n.in_session_minutes, 120)
})

test('planner: opt-out bypasses the delay entirely; frequency caps hold; negotiation turns are a POLICY field (off by default); spacing; recovery', () => {
  const stop = plan({ optOut: true })
  assert.deepEqual([stop.action, stop.delay_minutes, stop.reasons], ['immediate', 0, ['opt_out_bypasses_delay']])
  assert.deepEqual(plan({ counts: { aiRepliesToSellerToday: 1 } }).reasons, ['seller_daily_ai_reply_cap'])
  assert.deepEqual(plan({ counts: { aiRepliesToSellerToday: 1 }, activeNegotiation: true }).reasons, ['seller_daily_ai_reply_cap'], 'canary: 1/seller/day even in negotiation')
  const approved = plan({ counts: { aiRepliesToSellerToday: 1, negotiationTurnsToday: 2 }, activeNegotiation: true, policy: { negotiation_turns_enabled: true } })
  assert.equal(approved.action, 'schedule')
  assert.ok(approved.reasons.includes('negotiation_turn_beyond_canary_cap'))
  assert.deepEqual(plan({ counts: { aiRepliesToSellerToday: 1, negotiationTurnsToday: 6 }, activeNegotiation: true, policy: { negotiation_turns_enabled: true } }).reasons, ['negotiation_turn_cap'])
  assert.deepEqual(plan({ counts: { outboundToSellerToday: 8 } }).reasons, ['contact_frequency_limit'])
  assert.equal(DEFAULT_DELAY_POLICY.max_ai_replies_per_seller_per_day, 1)
  assert.equal(DEFAULT_DELAY_POLICY.negotiation_turns_enabled, false)
  const spaced = plan({ counts: { lastOutboundAt: plus(NOON, 10) }, seed: 'sp' })
  assert.ok(Date.parse(spaced.due_at) >= Date.parse(plus(NOON, 13)), spaced.due_at)
  const late = plan({ now: plus(NOON, 120) })
  assert.ok(late.reasons.includes('overdue_recovery'))
  assert.ok(Date.parse(late.due_at) >= Date.parse(plus(NOON, 120)) && Date.parse(late.due_at) <= Date.parse(plus(NOON, 122)))
})

// ── deterministic event routing ─────────────────────────────────────────────
test('routing: a stop is immediate and model-free; denial closes; offers / counters / objections schedule a turn; failures never duplicate', () => {
  const r = (e) => routeConversationEvent({ kind: 'inbound', ...e })
  for (const text of ['STOP', 'please stop texting me', 'Remove me from your list', 'No more texts']) {
    const x = r({ text })
    assert.deepEqual([x.route, x.model_needed, x.priority], [ROUTES.SUPPRESS_NOW, false, 1], text)
  }
  assert.equal(r({ text: 'ok', deterministic: { intent: 'opt_out' } }).route, ROUTES.SUPPRESS_NOW)
  assert.equal(r({ text: 'No', lastQuestionKind: 'ownership' }).route, ROUTES.CLOSE_NO_REPLY)
  assert.equal(r({ text: 'wrong number', deterministic: { intent: 'wrong_number' } }).route, ROUTES.CLOSE_NO_REPLY)
  assert.equal(r({ text: 'you idiot', deterministic: { intent: 'hostile_or_troll' } }).route, ROUTES.NO_REPLY)
  assert.deepEqual([r({ text: "What's your offer?" }).type, r({ text: "What's your offer?" }).route], ['offer_request', ROUTES.SCHEDULE_TURN])
  assert.equal(r({ text: 'Can you do 180k? That is my bottom line' }).type, 'counteroffer')
  assert.equal(r({ text: 'Is this a scam?' }).type, 'objection')
  assert.equal(r({ text: 'Yes I still own it' }).type, 'new_inbound')
  assert.equal(r({ text: 'and the roof is new', openTurn: true }).type, 'meaningful_update')
  assert.deepEqual([r({ text: 'ok' }).route, r({ text: 'Thanks!' }).route], [ROUTES.JOIN_OR_IGNORE, ROUTES.JOIN_OR_IGNORE])
  const f = (failureClass) => routeConversationEvent({ kind: 'failed_outbound_reply', failureClass }).route
  assert.equal(f('pre_acceptance'), ROUTES.REOPEN_TURN)
  for (const fc of ['uncertain_ack', 'accepted', 'delivery_failed', '']) assert.equal(f(fc), ROUTES.HOLD_NO_DUPLICATE, fc)
  const s = (change, openTurn = true) => routeConversationEvent({ kind: 'state_change', change, openTurn }).route
  assert.deepEqual([s('operator_took_over'), s('owner_handled'), s('offer_recorded'), s('offer_recorded', false), s('archived')], [ROUTES.CANCEL_TURN, ROUTES.CANCEL_TURN, ROUTES.REPLAN_TURN, ROUTES.NOOP, ROUTES.NOOP])
  assert.ok(ROUTE_PRIORITY.suppress_now < ROUTE_PRIORITY.schedule_turn)
  assert.equal(conversationDecidePriority({ messageBody: 'STOP' }), 1)
  assert.equal(conversationDecidePriority({ messageBody: 'yes' }), 120)
})

// ── the turn engine (memory stores) ─────────────────────────────────────────
function harness({ start = NOON } = {}) {
  let clock = Date.parse(start)
  const now = () => clock
  const runtime = createRuntimeMemoryStore({ now, limits: { runtime_enabled: true, tick_max_jobs: 5, max_concurrency_global: 5, kind_limits: { [CONVERSATION_TURN_KIND]: { enabled: true, max_concurrency: 2, armed_by: OP }, [CONVERSATION_TURN_SWEEP_KIND]: { enabled: true, max_concurrency: 1, armed_by: OP } } } })
  const turns = createMemoryTurnStore({ now })
  const decisions = []
  const decide = async (claim) => { decisions.push({ turn_id: claim.turn_id, version: claim.version, members: [...claim.inbound_ids] }); return { code: 'SHADOW_RECORDED', outcome: 'REPLY_CANDIDATE', reply: null } }
  const inbound = async (id, body, { atMin = 0, planArgs = {}, deterministic = null, lastQuestionKind = null } = {}) => {
    const at = new Date(Date.parse(start) + atMin * MIN).toISOString()
    clock = Math.max(clock, Date.parse(at))
    return handleConversationEvent({ event: { kind: 'inbound', thread_key: SELLER, inbound: { id, at, body }, deterministic, lastQuestionKind }, store: turns, enqueueAt: (o) => runtime.enqueueEventAt(o), planArgs: { timezone: TZ, ...planArgs }, now: new Date(clock).toISOString() })
  }
  const handlers = { [CONVERSATION_TURN_KIND]: createConversationTurnHandler({ store: turns, decide }) }
  const tick = (h = handlers) => runRuntimeTick({ store: runtime, handlers: h, workerId: 'w1', now, budgetMs: 5000, minClaimMs: 10 })
  return { runtime, turns, decisions, inbound, tick, handlers, decide, advance: (min) => { clock += min * MIN }, set: (iso) => { clock = Date.parse(iso) }, now }
}
const jobs = (rt) => [...rt._state.jobs.values()].filter((j) => j.kind === CONVERSATION_TURN_KIND)

test('burst consolidation: 3 rapid inbounds ⇒ ONE turn (version 3), the stale versions supersede, exactly ONE decision on all three', async () => {
  const h = harness()
  const a = await h.inbound('m1', 'Yes I still own it', { atMin: 0 })
  const b = await h.inbound('m2', 'its a 3 bed', { atMin: 0.5 })
  const c = await h.inbound('m3', 'roof is old though', { atMin: 1 })
  assert.deepEqual([a.code, b.code, c.code], ['TURN_OPENED', 'TURN_EXTENDED', 'TURN_EXTENDED'])
  assert.equal(new Set([a.turn_id, b.turn_id, c.turn_id]).size, 1)
  assert.equal(c.version, 3)
  assert.equal(jobs(h.runtime).length, 3, 'one job per version (each at its own due time)')
  for (const j of jobs(h.runtime)) assert.ok(decodeTurnJobInput(j.input), 'clean, decodable payload')
  assert.ok(!JSON.stringify(jobs(h.runtime).map((j) => j.input)).match(/[0-9]/), 'no digits in any job payload')
  // nothing is due before the planned time
  const early = await h.tick()
  assert.equal(early.claimed, 0)
  h.advance(45)
  for (let i = 0; i < 3; i += 1) await h.tick()
  assert.equal(h.decisions.length, 1, JSON.stringify(h.decisions))
  assert.deepEqual(h.decisions[0].members, ['m1', 'm2', 'm3'])
  assert.equal(h.decisions[0].version, 3)
  const codes = jobs(h.runtime).map((j) => j.result?.code).sort()
  assert.deepEqual(codes, ['TURN_DECIDED_SHADOW', 'TURN_SUPERSEDED', 'TURN_SUPERSEDED'])
  const turn = h.turns.get(c.turn_id)
  assert.equal(turn.state, 'decided')
  assert.match(turn.outcome, /^shadow:/)
  assert.equal(turn.result.send_status, 'not_sent_shadow')
  // a later inbound opens a NEW turn
  h.advance(5)
  const d = await h.inbound('m4', 'any update?', { atMin: 51 })
  assert.equal(d.code, 'TURN_OPENED')
  assert.notEqual(d.turn_id, c.turn_id)
})

test('stale invalidation: an inbound during an in-flight decision revokes the claim; the old draft is discarded; the new version decides once', async () => {
  const h = harness()
  const a = await h.inbound('m1', 'Yes I own it', { atMin: 0 })
  h.advance(45)
  let release
  const gate = new Promise((r) => { release = r })
  let calls = 0
  const slow = async (claim) => { calls += 1; if (calls === 1) await gate; return { code: 'SHADOW_RECORDED', outcome: `v${claim.version}` } }
  const p = runDueTurn({ turn_id: a.turn_id, version: 1, store: h.turns, worker: 'w1', decideTurn: slow })
  await new Promise((r) => setImmediate(r))
  const b = await h.inbound('m2', 'actually I might sell for 150k', { atMin: 46 })
  assert.equal(b.code, 'TURN_EXTENDED')
  assert.equal(b.revoked_claim, true)
  release()
  const first = await p
  assert.equal(first.code, 'TURN_SUPERSEDED_DURING_DECISION')
  assert.equal(h.turns.get(a.turn_id).stale_drafts, 1)
  h.advance(45)
  const second = await runDueTurn({ turn_id: a.turn_id, version: 2, store: h.turns, worker: 'w2', decideTurn: slow })
  assert.equal(second.code, 'TURN_DECIDED_SHADOW')
  assert.equal(h.turns.get(a.turn_id).outcome, 'shadow:v2')
  const again = await runDueTurn({ turn_id: a.turn_id, version: 1, store: h.turns, worker: 'w3', decideTurn: slow })
  assert.equal(again.code, 'TURN_SUPERSEDED')
})

test('opt-out immediacy: a STOP during a pending turn cancels it NOW (no delay, no model, no job); the pending draft never goes', async () => {
  const h = harness()
  const a = await h.inbound('m1', 'Maybe, depends on price', { atMin: 0 })
  const s = await h.inbound('m2', 'Actually stop texting me', { atMin: 1 })
  assert.deepEqual([s.code, s.route, s.delay_minutes, s.cancelled, s.model_needed], ['SUPPRESSED_NOW', 'suppress_now', 0, 1, false])
  assert.equal(h.turns.get(a.turn_id).state, 'cancelled')
  assert.equal(jobs(h.runtime).length, 1, 'the stop enqueued nothing')
  h.advance(45)
  await h.tick()
  assert.equal(h.decisions.length, 0, 'the cancelled turn is never decided')
  assert.equal(jobs(h.runtime)[0].result.code, 'TURN_STATE_CANCELLED')
  // ownership denial closes the open turn too (no reply, no nurture)
  const h2 = harness()
  const t2 = await h2.inbound('x1', 'hello?', { atMin: 0 })
  const d = await h2.inbound('x2', 'No', { atMin: 1, lastQuestionKind: 'ownership' })
  assert.deepEqual([d.code, h2.turns.get(t2.turn_id).state], ['TURN_CLOSED_NO_REPLY', 'cancelled'])
})

test('one reply per turn: two workers race for the same due turn — one claims, one reply reservation; another origin first ⇒ answered elsewhere', async () => {
  const h = harness()
  const a = await h.inbound('m1', 'Yes', { atMin: 0 })
  await h.inbound('m2', 'what do you want', { atMin: 0.2 })
  h.advance(45)
  const dispatched = []
  const decideReply = async () => ({ code: 'SHADOW_RECORDED', outcome: 'REPLY_CANDIDATE', reply: { text: 'Thanks. Would you consider selling it?' } })
  const dispatch = async (x) => { dispatched.push(x.turn_id); return { status: 'enqueued' } }
  const [r1, r2] = await Promise.all([
    runDueTurn({ turn_id: a.turn_id, version: 2, store: h.turns, worker: 'w1', decideTurn: decideReply, dispatch }),
    runDueTurn({ turn_id: a.turn_id, version: 2, store: h.turns, worker: 'w2', decideTurn: decideReply, dispatch }),
  ])
  assert.deepEqual([r1.code, r2.code].sort(), ['TURN_DISPATCHED', 'TURN_STATE_CLAIMED'])
  assert.equal(dispatched.length, 1)
  assert.deepEqual([...h.turns.reservations.keys()].sort(), ['m1', 'm2'])
  // the template engine already holds one member ⇒ the AI turn stands down (all or none)
  const h2 = harness()
  const b = await h2.inbound('n1', 'Yes', { atMin: 0 })
  await h2.inbound('n2', 'who is this', { atMin: 0.3 })
  h2.turns.reservations.set('n2', { status: 'completed', origin: 'template' })
  h2.advance(45)
  const r3 = await runDueTurn({ turn_id: b.turn_id, version: 2, store: h2.turns, worker: 'w1', decideTurn: decideReply, dispatch })
  assert.deepEqual([r3.code, r3.conflict_inbound_id], ['TURN_ANSWERED_ELSEWHERE', 'n2'])
  assert.equal(h2.turns.reservations.has('n1'), false)
  // with no dispatcher injected (this release) nothing is reserved and nothing is dispatched
  const h3 = harness()
  const c = await h3.inbound('k1', 'Yes', { atMin: 0 })
  h3.advance(45)
  const r4 = await runDueTurn({ turn_id: c.turn_id, version: 1, store: h3.turns, worker: 'w1', decideTurn: decideReply })
  assert.equal(r4.code, 'TURN_DECIDED_SHADOW')
  assert.equal(h3.turns.reservations.size, 0)
})

test('restart recovery: the schedule is the job row (no timer); a lost job is re-enqueued by the sweep; a dead worker\'s claim expires and is retaken', async () => {
  const h = harness()
  // the enqueue after the turn write is LOST (crash between the two writes)
  const lost = await handleConversationEvent({ event: { kind: 'inbound', thread_key: SELLER, inbound: { id: 'm1', at: NOON, body: 'Yes' } }, store: h.turns, enqueueAt: async () => { throw Object.assign(new Error('crash'), { code: 'CRASH' }) }, planArgs: { timezone: TZ }, now: NOON }).catch((e) => ({ code: e.code }))
  assert.equal(lost.code, 'CRASH')
  const open = await h.turns.peekOpen(SELLER)
  assert.equal(open.state, 'pending', 'the turn itself is durable')
  assert.equal(jobs(h.runtime).length, 0)
  h.advance(45)
  // "restart": a fresh handler set over the SAME stores; the sweep finds the overdue turn
  const sweep = createConversationTurnSweepHandler({ store: h.turns, runtimeStore: h.runtime, now: () => new Date(h.now()).toISOString() })
  const s = await runRuntimeTick({ store: h.runtime, handlers: { [CONVERSATION_TURN_SWEEP_KIND]: sweep }, workerId: 'w1', now: h.now, budgetMs: 5000, minClaimMs: 10 }).catch(() => null)
  // the sweep kind runs via a schedule in production; here it is invoked directly
  const r = await recoverDueTurns({ store: h.turns, enqueueAt: (o) => h.runtime.enqueueEventAt(o), now: new Date(h.now()).toISOString() })
  assert.deepEqual([r.due, r.enqueued], [1, 1], JSON.stringify({ r, s: s?.claimed }))
  await h.tick()
  assert.equal(h.decisions.length, 1)
  // a worker dies holding a claim: the lease expires, the sweep re-enqueues, another worker decides once
  const h2 = harness()
  const t = await h2.inbound('z1', 'Yes', { atMin: 0 })
  h2.advance(45)
  const c = await h2.turns.claim({ turn_id: t.turn_id, version: 1, worker: 'dead', lease_seconds: 60 })
  assert.ok(c.ok)
  h2.advance(2)
  const r2 = await recoverDueTurns({ store: h2.turns, enqueueAt: (o) => h2.runtime.enqueueEventAt(o), now: new Date(h2.now()).toISOString() })
  assert.equal(r2.enqueued, 1)
  for (let i = 0; i < 2; i += 1) await h2.tick()
  assert.equal(h2.decisions.length, 1)
  assert.equal(h2.turns.get(t.turn_id).state, 'decided')
})

test('failed reply before the provider ⇒ the turn re-decides (never a duplicate after acceptance)', async () => {
  const h = harness()
  const a = await h.inbound('m1', 'Yes', { atMin: 0 })
  h.advance(45)
  await runDueTurn({ turn_id: a.turn_id, version: 1, store: h.turns, worker: 'w1', decideTurn: async () => ({ outcome: 'REPLY_CANDIDATE', reply: { text: 'x' } }), dispatch: async () => ({ status: 'enqueued' }) })
  assert.equal(h.turns.reservations.size, 1)
  const held = await handleConversationEvent({ event: { kind: 'failed_outbound_reply', thread_key: SELLER, turn_id: a.turn_id, failureClass: 'uncertain_ack' }, store: h.turns, enqueueAt: (o) => h.runtime.enqueueEventAt(o), now: new Date(h.now()).toISOString() })
  assert.equal(held.code, 'HELD_NO_DUPLICATE')
  assert.equal(h.turns.get(a.turn_id).state, 'decided')
  const re = await handleConversationEvent({ event: { kind: 'failed_outbound_reply', thread_key: SELLER, turn_id: a.turn_id, failureClass: 'pre_acceptance' }, store: h.turns, enqueueAt: (o) => h.runtime.enqueueEventAt(o), planArgs: { timezone: TZ }, now: new Date(h.now()).toISOString() })
  assert.equal(re.code, 'TURN_REOPENED')
  assert.equal(re.version, 2)
  assert.equal(h.turns.reservations.size, 0, 'its own reservation released')
})

test('planner inputs from the thread: cadence, counts (AI replies today), urgency, offer request ⇒ underwriting required', () => {
  const at = (m) => plus(NOON, m)
  const thread = [
    { id: 'o1', direction: 'outbound', body: 'Do you still own 12 Elm?', at: at(-300), use_case: 'ownership_check' },
    { id: 'i1', direction: 'inbound', body: 'yes', at: at(-296) },
    { id: 'o2', direction: 'outbound', body: 'Would you consider selling it?', at: at(-290), use_case: 'consider_selling' },
    { id: 'i2', direction: 'inbound', body: "maybe, need to sell asap. what's your offer?", at: at(0) },
  ]
  const ledger = buildCanonicalLedger({ messages: thread, now: NOON })
  const q = [{ id: 'q1', queue_status: 'sent', source: 'ai_conversation', use_case_template: 'ai_consider_selling', created_at: at(-290) }, { id: 'q0', queue_status: 'sent', use_case_template: 'ownership_check', created_at: at(-300) }]
  const a = planInputsFromThread({ thread, inbound: thread[3], ledger, queueRows: q, timezone: TZ, now: NOON })
  assert.deepEqual(a.sellerReplyLatenciesMinutes, [4, 290])
  assert.deepEqual(a.counts, { aiRepliesToSellerToday: 1, negotiationTurnsToday: 0, outboundToSellerToday: 2, lastOutboundAt: at(-290) })
  assert.equal(a.underwriting.required, true)
  assert.equal(a.underwriting.ready, false)
  assert.equal(planReplyDelay({ seed: 'x', now: NOON, ...a }).reasons[0], 'seller_daily_ai_reply_cap', 'canary cap: already one AI reply today')
})

test('runtime: turn kinds register only with BOTH flags; payload refs round-trip; decide handler routes to turns when enabled', async () => {
  assert.deepEqual(Object.keys(conversationRuntimeHandlers({})), [])
  assert.deepEqual(Object.keys(conversationRuntimeHandlers({ AI_CONVERSATION_SHADOW_ENABLED: 'true' })), [CONVERSATION_DECIDE_KIND])
  assert.deepEqual(Object.keys(conversationRuntimeHandlers({ AI_CONVERSATION_SHADOW_ENABLED: 'true', AI_CONVERSATION_TURNS_ENABLED: 'true' })).sort(), [CONVERSATION_DECIDE_KIND, CONVERSATION_TURN_KIND, CONVERSATION_TURN_SWEEP_KIND].sort())
  assert.equal(turnsRequested({}), false)
  const id = '0f8e2c1a-1111-4abc-9def-0123456789ab'
  assert.deepEqual(decodeTurnJobInput(turnJobInput({ turn_id: id, version: 7 })), { turn_id: id, version: 7 })
  assert.equal(decodeTurnJobInput({ turn_ref: 'zz', turn_version: 'dd' }), null)
  assert.equal(turnEventKey(id, 2), `turn:${id}#v2`)
  // the decide job, turns ON: routes (no shadow decision at inbound time)
  let routed = null
  const handler = createConversationDecideHandler({ env: { AI_CONVERSATION_SHADOW_ENABLED: 'true', AI_CONVERSATION_TURNS_ENABLED: 'true' }, run: async () => { throw new Error('must not decide on the spot') }, route: async (a) => { routed = a; return { code: 'TURN_OPENED', route: 'schedule_turn', event_type: 'new_inbound', turn_id: id, version: 1, plan: { since_inbound_minutes: 8.5, reasons: [] }, job: { deduped: false } } }, runtimeStore: {} })
  const ctx = { job: { input: { inbound_ref: encodeRef('SM00000000'), inbound_version: null } }, step: async () => {} }
  const out = await handler.run(ctx)
  assert.equal(routed.providerMessageSid, 'SM00000000')
  assert.equal(out.result.code, 'TURN_OPENED')
  assert.ok(!JSON.stringify(out.result).includes(id), 'the turn id is letter-encoded in the job result')
  assert.deepEqual(turnRouteResult({}).code, null)
  // turns OFF: the 8.5.15 behaviour (decide on the spot)
  let ran = false
  const off = createConversationDecideHandler({ env: { AI_CONVERSATION_SHADOW_ENABLED: 'true' }, run: async () => { ran = true; return { code: 'SHADOW_RECORDED' } }, route: async () => { throw new Error('turns are off') } })
  await off.run({ job: { input: { inbound_ref: encodeRef('SM00000000') } }, step: async () => {} })
  assert.equal(ran, true)
  // the change hook: OFF unless both flags; never throws
  assert.equal(scheduleConversationTurnChange({ kind: 'state_change', turnId: id, change: 'operator_took_over' }, { env: {} }).code, 'TURNS_ENV_OFF')
  let enq = null
  const r = scheduleConversationTurnChange({ kind: 'state_change', turnId: id, change: 'operator_took_over' }, { env: { AI_CONVERSATION_SHADOW_ENABLED: 'true', AI_CONVERSATION_TURNS_ENABLED: 'true' }, gate: async () => ({ enabled: true }), getStore: async () => ({ enqueueEvent: async (o) => { enq = o; return { ok: true } } }), defer: (fn) => fn() })
  assert.equal(r.code, 'TURN_CHANGE_ENQUEUE_SCHEDULED')
  await new Promise((res) => setImmediate(res))
  assert.equal(enq.input.event_kind, 'state_change')
  assert.ok(!/[0-9]/.test(JSON.stringify(enq.input)))
})

test('static: the turn engine and its handlers never reach the R3 executor, the queue writer or a transport', () => {
  const SRC = path.resolve(import.meta.dirname, '../../src')
  const files = ['lib/domain/conversation-ai/turns/turn-engine.js', 'lib/domain/conversation-ai/turns/delay-planner.js', 'lib/domain/conversation-ai/turns/events.js', 'lib/domain/conversation-ai/turns/turn-store.js', 'lib/ai/conversation-turn-handler.js', 'lib/ai/conversation-turn-wiring.js'].map((f) => path.join(SRC, f))
  const g = importClosure(files)
  const reached = [...g.parents.keys()].map((f) => path.relative(SRC, f))
  for (const bad of ['lib/ai/conversation-ai-r3-executor.js', 'lib/supabase/sms-engine.js', 'lib/providers/textgrid.js', 'lib/domain/queue/process-send-queue.js']) {
    assert.ok(!reached.includes(bad), `${bad} reached`)
  }
})
