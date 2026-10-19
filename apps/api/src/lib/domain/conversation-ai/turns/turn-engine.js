// THE 24/7 EVENT-DRIVEN CONVERSATION ENGINE — turn orchestration (rc-8.5.20, Phases 1A / 3 /
// 12 conversation side). OFF by default (AI_CONVERSATION_TURNS_ENABLED, plus the runtime
// arming of conversation.turn). Pure apart from the injected store / enqueue / decide.
//
//   inbound / change ──► conversation.decide job (exists; idempotent per inbound VERSION)
//        │  handleConversationEvent(): deterministic routing (events.js), NO model
//        ├─ suppress_now ─────► cancel the open turn NOW (no delay, no model)
//        ├─ close_no_reply ───► cancel the open turn (ownership denied / wrong number)
//        ├─ schedule_turn ────► plan the delay (delay-planner.js) → open / JOIN the thread's ONE
//        │                      open turn (version + 1, older draft stale, claim revoked) →
//        │                      enqueue conversation.turn for (turn, version) with
//        │                      next_attempt_at = due (durable: the job row IS the schedule)
//        └─ hold / noop ......  nothing scheduled (frequency cap, ack with no open turn, …)
//   due ─────────────────► conversation.turn job: runDueTurn(): claim (exact version, lease) →
//                          decide ONCE on the consolidated, freshly loaded thread (model at most
//                          here) → finalize (version + token checked; a reply reserves EVERY
//                          member inbound in idempotency_ledger 'inbound_reply', all or none)
//   sweep ───────────────► conversation.turn_sweep: recoverDueTurns() re-enqueues overdue turns
//                          and expired claims after a restart / lost job
//
// Dispatch: this release records the decision (shadow); the R3 AI sender stays OFF and unwired.
// A reply candidate is finalized WITHOUT reservation (send_status not_sent_shadow) unless a
// dispatcher is injected — nothing in the codebase injects one.
import { planReplyDelay } from './delay-planner.js'
import { ROUTES, routeConversationEvent } from './events.js'
import { measureComplexity } from '../pipeline/complexity.js'

export const TURN_ENGINE_VERSION = 'conv-ai.turn-engine.v1'
export const CONVERSATION_TURN_KIND = 'conversation.turn'
export const CONVERSATION_TURN_SWEEP_KIND = 'conversation.turn_sweep'
/** The recovery sweep schedule (born disabled): seeded by PROPOSED_20261016120100_conversation_reply_turns_schedules.sql.
 *  600 s = the recovery dedupe epoch (10 min) of recoverDueTurns. */
export const CONVERSATION_TURN_SWEEP_SCHEDULE = Object.freeze({ name: 'conversation-turn-sweep', kind: CONVERSATION_TURN_SWEEP_KIND, interval_seconds: 600, input: Object.freeze({}) })
export const TURNS_ENV = 'AI_CONVERSATION_TURNS_ENABLED'

export function turnsRequested(env = process.env) {
  return String(env?.[TURNS_ENV] ?? '').trim() === 'true'
}

// letter-only refs (the conversation-ai-shadow-hook encoding, repeated here so the domain layer
// imports nothing from lib/ai): each UTF-8 byte → two letters a–p; digit-free for payload_is_clean
const NIB = 'abcdefghijklmnop'
export const encodeRef = (s) => [...Buffer.from(String(s), 'utf8')].map((b) => NIB[b >> 4] + NIB[b & 15]).join('')
export const decodeRef = (s) => {
  const x = String(s)
  if (!/^(?:[a-p]{2})+$/.test(x)) return null
  return Buffer.from(x.match(/../g).map((p) => (NIB.indexOf(p[0]) << 4) | NIB.indexOf(p[1]))).toString('utf8')
}

export const turnEventKey = (turnId, version, epoch = null) => `turn:${turnId}#v${version}${epoch != null ? `#r${epoch}` : ''}`
export const turnJobInput = ({ turn_id, version }) => ({ turn_ref: encodeRef(String(turn_id)), turn_version: encodeRef(String(version)) })
export function decodeTurnJobInput(input = {}) {
  const id = typeof input?.turn_ref === 'string' && input.turn_ref.length <= 160 ? decodeRef(input.turn_ref) : null
  const v = typeof input?.turn_version === 'string' ? Number(decodeRef(input.turn_version)) : NaN
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(v) || v < 1 || v > 1000) return null
  return { turn_id: id, version: v }
}

const MIN = 60_000
const t = (x) => Date.parse(x?.at ?? x) || 0
const SENT_LIKE = new Set(['queued', 'scheduled', 'pending', 'approval', 'processing', 'sending', 'sent', 'delivered'])
const URGENT_RE = /\b(?:asap|as\s+soon\s+as|soon|quick(?:ly)?|fast|urgent|this\s+(?:week|month)|[0-9]+\s+days?|right\s+away|immediately|need\s+to\s+(?:sell|move))\b/i

/**
 * Planner inputs from the loaded thread (pure). The day counters are a ROLLING 24 h window
 * (the R3 seller-day reservation stays the authoritative per-day cap at enqueue).
 * @param {{ thread: Array, inbound: { id: string, at: string, body?: string }, ledger?: object|null, queueRows?: Array, timezone?: string|null, now: string, extra?: object }} a
 */
export function planInputsFromThread({ thread = [], inbound, ledger = null, queueRows = [], timezone = null, recipientZones = null, now, extra = {} }) {
  const msgs = [...thread].filter((m) => m && m.at).sort((a, b) => t(a) - t(b))
  if (inbound?.id && !msgs.some((m) => m.id === inbound.id)) msgs.push({ ...inbound, direction: 'inbound' })
  const latencies = []
  for (let i = 1; i < msgs.length; i += 1) {
    const m = msgs[i]; const prev = msgs[i - 1]
    if (m.direction === 'inbound' && prev.direction === 'outbound') {
      const d = (t(m) - t(prev)) / MIN
      if (d >= 0 && d <= 7 * 1440) latencies.push(Math.round(d * 10) / 10)
    }
  }
  const inbounds = msgs.filter((m) => m.direction === 'inbound')
  const outbounds = msgs.filter((m) => m.direction === 'outbound')
  const avgLen = inbounds.length ? inbounds.reduce((s, m) => s + String(m.body || '').length, 0) / inbounds.length : 0
  const engagement = Math.min(1, Math.min(1, inbounds.length / Math.max(1, outbounds.length)) * 0.85 + (avgLen > 40 ? 0.15 : 0))
  const nowMs = Date.parse(now)
  const day = (x) => nowMs - (Date.parse(x) || 0) <= 24 * 60 * MIN
  const rowsToday = (queueRows || []).filter((r) => SENT_LIKE.has(String(r?.queue_status || '').toLowerCase()) && day(r.created_at))
  const aiToday = rowsToday.filter((r) => String(r.source || '') === 'ai_conversation' || /^ai_/.test(String(r.use_case_template || ''))).length
  const lastOut = outbounds.length ? outbounds[outbounds.length - 1].at : null
  const timeline = JSON.stringify(ledger?.facts?.timeline?.value ?? '')
  const offerAsked = (ledger?.offer_requests || []).includes(inbound?.id)
  const cx = measureComplexity({ inboundText: inbound?.body || '', ledger, threadLength: msgs.length })
  return {
    lastInboundAt: inbound?.at,
    inboundId: inbound?.id ? String(inbound.id) : null,
    recipientZones,
    sellerReplyLatenciesMinutes: latencies,
    recentInboundAts: inbounds.map((m) => m.at),
    timezone,
    engagement: Math.round(engagement * 100) / 100,
    stage: ledger?.stage?.stage || null,
    urgency: URGENT_RE.test(timeline) ? 0.8 : 0,
    activeNegotiation: (ledger?.existing_offers || []).length > 0,
    complexity: cx.score,
    underwriting: { required: offerAsked || ledger?.stage?.stage === 'S5_offer', ready: extra.underwritingReady === true },
    senderHealth: extra.senderHealth ?? null,
    campaignHealth: extra.campaignHealth ?? null,
    counts: { aiRepliesToSellerToday: aiToday, negotiationTurnsToday: extra.negotiationTurnsToday ?? 0, outboundToSellerToday: rowsToday.length, lastOutboundAt: lastOut },
  }
}

/**
 * Route one event and act on it. Never calls a model.
 * @param {object} a
 * @param {object} a.event   { kind: 'inbound'|'failed_outbound_reply'|'state_change', thread_key, inbound?, text?, deterministic?, lastQuestionKind?, ledger?, failureClass?, change?, turn_id? }
 * @param {object} a.store   turn store (turn-store.js)
 * @param {(o: { kind: string, event_key: string, input: object, priority: number, not_before: string }) => Promise<object>} a.enqueueAt
 * @param {object} [a.planArgs]  planInputsFromThread() result (+ policy)
 * @param {{ persona_name?: string|null, sender_number?: string|null }|null} [a.continuity]
 * @param {string} a.now
 */
export async function handleConversationEvent({ event = {}, store, enqueueAt, planArgs = {}, continuity = null, now, planner = planReplyDelay }) {
  const tk = String(event.thread_key || '').trim()
  if (!tk) return { code: 'THREAD_KEY_MISSING' }
  const open = event.kind === 'inbound' || event.kind === 'state_change' ? await store.peekOpen(tk) : null
  const route = routeConversationEvent({ ...event, text: event.inbound?.body ?? event.text, openTurn: Boolean(open) })
  const base = { route: route.route, event_type: route.type, priority: route.priority, model_needed: route.model_needed, reasons: route.reasons, engine_version: TURN_ENGINE_VERSION }
  const schedule = async (opened) => {
    if (!opened?.ok) return { ...base, code: 'TURN_OPEN_REFUSED', store: opened }
    if (opened.deduped) return { ...base, code: 'TURN_EVENT_DEDUPED', turn_id: opened.turn_id, version: opened.version }
    const job = await enqueueAt({ kind: CONVERSATION_TURN_KIND, event_key: turnEventKey(opened.turn_id, opened.version), input: turnJobInput(opened), priority: route.priority, not_before: opened.due_at })
    return { ...base, code: opened.created ? 'TURN_OPENED' : opened.extended ? 'TURN_EXTENDED' : 'TURN_REOPENED', turn_id: opened.turn_id || opened.merged_into, version: opened.version, due_at: opened.due_at, revoked_claim: Boolean(opened.revoked_claim), job: { ok: job?.ok !== false, deduped: Boolean(job?.deduped), reason: job?.reason || null } }
  }

  switch (route.route) {
    case ROUTES.SUPPRESS_NOW: {
      // IMMEDIATE: no delay, no model. The open turn (any pending draft) dies now.
      const r = await store.cancel({ thread_key: tk, reason: 'stop_request' })
      return { ...base, code: 'SUPPRESSED_NOW', cancelled: r?.cancelled ?? 0, delay_minutes: 0 }
    }
    case ROUTES.CLOSE_NO_REPLY:
    case ROUTES.CANCEL_TURN:
    case ROUTES.NO_REPLY: {
      const reason = route.route === ROUTES.CLOSE_NO_REPLY ? 'ownership_denied_no_reply' : route.route === ROUTES.NO_REPLY ? 'hostile_no_reply' : `state_${String(event.change || 'change').toLowerCase()}`
      const r = open ? await store.cancel({ thread_key: tk, reason }) : { cancelled: 0 }
      return { ...base, code: 'TURN_CLOSED_NO_REPLY', cancelled: r?.cancelled ?? 0 }
    }
    case ROUTES.HOLD_NO_DUPLICATE:
      return { ...base, code: 'HELD_NO_DUPLICATE' }
    case ROUTES.NOOP:
    case ROUTES.REPLAN_TURN:
      // replan: the open turn re-decides on fresh state at its due time anyway
      return { ...base, code: route.route === ROUTES.REPLAN_TURN ? 'TURN_REDECIDES_AT_DUE' : 'NOOP' }
    case ROUTES.REOPEN_TURN: {
      if (!event.turn_id) return { ...base, code: 'TURN_ID_MISSING' }
      const plan = planner({ seed: `reopen:${event.turn_id}`, now, ...planArgs, lastInboundAt: planArgs.lastInboundAt || now })
      if (plan.action !== 'schedule') return { ...base, code: 'REOPEN_HELD', plan }
      const r = await store.reopen({ turn_id: event.turn_id, reason: 'reply_not_sent_pre_acceptance', due_at: plan.due_at, plan })
      if (!r?.ok) return { ...base, code: 'REOPEN_REFUSED', store: r }
      return schedule({ ...r, ok: true, turn_id: r.turn_id || r.merged_into })
    }
    case ROUTES.JOIN_OR_IGNORE:
      if (!open) return { ...base, code: 'NOTHING_TO_ANSWER' }
    // falls through: an acknowledgement joins the open turn (context), re-planned
    case ROUTES.SCHEDULE_TURN: {
      const inbound = event.inbound
      if (!inbound?.id || !inbound?.at) return { ...base, code: 'INBOUND_REQUIRED' }
      const plan = planner({ seed: `${tk}|${open ? open.turn_id : 'new'}|${inbound.id}`, now, ...planArgs, lastInboundAt: inbound.at })
      if (plan.action === 'immediate') {
        const r = await store.cancel({ thread_key: tk, reason: 'stop_request' })
        return { ...base, code: 'SUPPRESSED_NOW', cancelled: r?.cancelled ?? 0, plan }
      }
      if (plan.action !== 'schedule') {
        // a held turn has no time: the open turn (if any) is closed for a human
        if (open) await store.cancel({ thread_key: tk, reason: `held_${plan.reasons[0] || 'plan'}` })
        return { ...base, code: 'TURN_HELD', plan }
      }
      const opened = await store.open({ thread_key: tk, inbound_id: inbound.id, inbound_at: inbound.at, due_at: plan.due_at, plan: compactPlan(plan), persona_name: continuity?.persona_name ?? null, sender_number: continuity?.sender_number ?? null })
      return { ...(await schedule(opened)), plan: compactPlan(plan) }
    }
    default:
      return { ...base, code: 'ROUTE_UNKNOWN' }
  }
}

export function compactPlan(p) {
  return { version: p.version, action: p.action, due_at: p.due_at, since_inbound_minutes: p.since_inbound_minutes ?? null, center_minutes: p.center_minutes ?? null, confidence: p.confidence ?? null, history_n: p.history_n ?? null, factors: p.factors || {}, window: p.window || null, reasons: p.reasons || [] }
}

export const DEFERRED_LIVE_DISPATCH = 'deferred_live_dispatch'
export const DEFERRED_LIVE_CLAIM = 'deferred_live_claim'
/** R3 statuses → the turn's terminal dispatch outcome (blind-eval D3: a hold is never "dispatched"). */
export const R3_DISPATCHED_STATUSES = Object.freeze(['enqueued', 'already_enqueued'])
export const R3_NOT_SENT_STATUSES = Object.freeze(['no_response', 'suppressed', 'stale_inbound'])
export function dispatchOutcomeOf(d) {
  const status = String(d?.status || '')
  if (R3_DISPATCHED_STATUSES.includes(status)) return 'dispatched'
  if (status === 'deferred' && d?.next_permitted_at) return 'deferred'
  if (R3_NOT_SENT_STATUSES.includes(status)) return 'not_sent'
  return 'held'   // held, refused, duplicate, blocked_at_insert, anything unknown: a person decides
}
export const DISPATCH_MAX_ATTEMPTS = 3
const RETRY_JITTER_MS = 5_000

/** A deterministic 0..RETRY_JITTER_MS jitter per (turn, worker) so parallel losers do not wake in lock-step. */
function jitterMs(seed) {
  let h = 2166136261
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
  return h % RETRY_JITTER_MS
}

/**
 * The due turn: claim (exact version) → decide once on the consolidated thread → finalize →
 * (rc-8.5.21) dispatch a send-authorised canonical reply through R3.
 *
 * OWNER DIRECTIVE (2026-10-17): "No worker, sender or agent may independently produce a duplicate
 * response to the same inbound turn." finalize hands the claimant the DISPATCH LEASE atomically
 * with the decision. Any other worker that finds the turn decided may recover the dispatch ONLY
 * through store.dispatchClaim, which succeeds only when the lease has EXPIRED (DB clock) and no
 * terminal dispatch outcome exists. Under a live lease it does not dispatch: it throws
 * DEFERRED_LIVE_DISPATCH with retry_after_ms (lease remaining + jitter), and the runtime
 * reschedules the job (bounded attempts, then dead letter). The send_queue unique index on
 * metadata.turn.turn_id is the database backstop behind all of this.
 * @param {object} a
 * @param {(claim: object) => Promise<{ code: string, outcome?: string|null, reply?: { text: string }|null, record?: object|null }>} a.decideTurn
 * @param {null|((x: object) => Promise<object>)} [a.dispatch]  the R3 turn dispatcher (OFF switches inside R3)
 * @param {null|Function} [a.enqueueAt]  runtime enqueue (a window deferral re-schedules the turn)
 */
export async function runDueTurn({ turn_id, version, store, worker, decideTurn, dispatch = null, enqueueAt = null, raiseOperatorItem = null, leaseSeconds = 180, maxDispatchAttempts = DISPATCH_MAX_ATTEMPTS, now = null }) {
  const claim = await store.claim({ turn_id, version, worker, lease_seconds: leaseSeconds })
  if (!claim?.ok) {
    const reason = String(claim?.reason || 'claim_refused')
    if (reason === 'not_due') throw Object.assign(new Error('TURN_NOT_DUE'), { code: 'TURN_NOT_DUE', due_at: claim.due_at })
    // a job for an OLDER version than the turn's is superseded whatever state the turn is in now
    const older = Number.isInteger(claim?.version) && claim.version !== version
    // blind-eval D4: another worker holds a LIVE claim. This job must not complete (if that worker
    // froze or died, nothing else would decide the turn): it is rescheduled at the claim lease's
    // end + jitter (DB clock), bounded by the job's max_attempts; after expiry it claims the turn.
    // Recovery therefore never depends on the optional turn sweep.
    if (reason === 'state_claimed' && !older && claim?.retry_after_ms != null) {
      const retry_after_ms = Math.max(1_000, Number(claim.retry_after_ms) || 0) + jitterMs(`${turn_id}|${worker}|claim`)
      throw Object.assign(new Error('DEFERRED_LIVE_CLAIM'), { code: 'DEFERRED_LIVE_CLAIM', outcome: DEFERRED_LIVE_CLAIM, retry_after_ms })
    }
    if (reason === 'state_decided' && typeof dispatch === 'function' && !older) {
      return recoverDispatch({ turn_id, version, store, worker, decideTurn, dispatch, enqueueAt, raiseOperatorItem, now, leaseSeconds, maxDispatchAttempts })
    }
    // stale_version: a newer inbound joined — the newer version's job decides; state_*: closed / claimed elsewhere
    const superseded = reason === 'stale_version' || older
    return { code: superseded ? 'TURN_SUPERSEDED' : `TURN_${reason.toUpperCase()}`, reason }
  }
  const decision = await decideTurn({ ...claim, turn_id })
  // blind-eval v2 (STP-09 and every decision that hands the turn to a person): the escalation raises
  // ONE operator work item BEFORE the decision is recorded (a failed write retries: never silent)
  if (decision?.code === 'ESCALATE_TO_OPERATOR' && typeof raiseOperatorItem === 'function') {
    await raiseOperatorItem({ turn_id, version, r3_status: 'escalated', reasons: [String(decision.reason || 'escalated').slice(0, 60)], escalated_by_decision: true })
  }
  const outcome = String(decision?.outcome || 'no_decision').toLowerCase().replace(/[^a-z0-9_:.-]/g, '_').slice(0, 60)
  const wantsReply = Boolean(decision?.reply?.text) && typeof dispatch === 'function'
  const result = { code: decision?.code || null, outcome, send_status: wantsReply ? 'dispatch_pending' : 'not_sent_shadow', members: (claim.inbound_ids || []).length, writer_version: decision?.writer_version || null, ...(wantsReply ? { reservation_token: claim.token } : {}) }
  const fin = await store.finalize({ turn_id, token: claim.token, version, outcome: `${wantsReply ? 'reply' : 'shadow'}:${outcome}`, result, reserve: wantsReply, reply_origin: wantsReply ? 'ai_generated' : null })
  if (!fin?.ok) return { code: 'TURN_SUPERSEDED_DURING_DECISION', reason: fin?.reason || null, decision_code: decision?.code || null }
  if (wantsReply && fin.reserved === false) return { code: 'TURN_ANSWERED_ELSEWHERE', conflict_inbound_id: fin.conflict_inbound_id || null }
  // the finalize handed THIS worker the dispatch lease
  if (wantsReply) return dispatchUnderLease({ turn_id, version, worker, claim, decision, dispatch, store, enqueueAt, raiseOperatorItem, now, members: result.members })
  return { code: 'TURN_DECIDED_SHADOW', outcome, members: result.members, decision_code: decision?.code || null }
}

/** A decided turn found by a worker that did not decide it: lease-gated recovery, never a blind re-dispatch. */
async function recoverDispatch({ turn_id, version, store, worker, decideTurn, dispatch, enqueueAt, raiseOperatorItem, now, leaseSeconds, maxDispatchAttempts }) {
  // fail closed: a store without the lease contract never recovers a dispatch
  if (typeof store.dispatchClaim !== 'function') return { code: 'TURN_STATE_DECIDED', reason: 'state_decided', recovery: 'no_dispatch_lease_contract' }
  const dc = await store.dispatchClaim({ turn_id, version, worker, lease_seconds: leaseSeconds, max_attempts: maxDispatchAttempts })
  if (!dc?.ok) {
    const r = String(dc?.reason || 'dispatch_claim_refused')
    if (r === 'live_dispatch') {
      const retry_after_ms = Math.max(1_000, Number(dc.retry_after_ms) || 0) + jitterMs(`${turn_id}|${worker}`)
      throw Object.assign(new Error('DEFERRED_LIVE_DISPATCH'), { code: 'DEFERRED_LIVE_DISPATCH', outcome: DEFERRED_LIVE_DISPATCH, retry_after_ms })
    }
    if (r === 'attempts_exhausted' || r === 'dead_letter') {
      // visible escalation: the job fails permanently (the supervisor counts failed / dead-letter jobs)
      throw Object.assign(new Error('TURN_DISPATCH_DEAD_LETTER'), { code: 'TURN_DISPATCH_DEAD_LETTER', permanent: true, reason: r })
    }
    if (r === 'dispatch_done') return { code: 'TURN_ALREADY_DISPATCHED', dispatch_state: dc.dispatch_state || null }
    return { code: 'TURN_STATE_DECIDED', reason: 'state_decided', recovery: r }
  }
  if (!dc.token) {
    await store.dispatchDone({ turn_id, version, worker, outcome: 'released' })
    return { code: 'TURN_RESUME_NO_TOKEN' }
  }
  const inbound_ids = dc.inbound_ids || []
  let decision
  try {
    decision = await decideTurn({ ok: true, token: dc.token, version, thread_key: dc.thread_key, inbound_ids, latest_inbound_id: dc.latest_inbound_id, persona_name: dc.persona_name, sender_number: dc.sender_number, turn_id, resumed: true })
  } catch (e) {
    await releaseQuietly(store, { turn_id, version, worker })
    throw e
  }
  if (!decision?.reply?.text) {
    await releaseQuietly(store, { turn_id, version, worker })
    return { code: 'TURN_RESUME_NO_REPLY', decision_code: decision?.code || null }
  }
  return dispatchUnderLease({ turn_id, version, worker, claim: { token: dc.token, inbound_ids }, decision, dispatch, store, enqueueAt, raiseOperatorItem, now, members: inbound_ids.length, resumed: true })
}

async function releaseQuietly(store, { turn_id, version, worker }) {
  try { await store.dispatchDone?.({ turn_id, version, worker, outcome: 'released' }) } catch { /* the lease expires on its own */ }
}

/** Dispatch while holding the lease, then record the outcome (a transient failure releases it). */
async function dispatchUnderLease({ turn_id, version, worker, claim, decision, dispatch, store, enqueueAt, raiseOperatorItem, now, members, resumed = false }) {
  let d
  try {
    d = await dispatch({ turn_id, version, claim, decision })
  } catch (e) {
    await releaseQuietly(store, { turn_id, version, worker })
    throw e
  }
  const status = d?.status || null
  if (status === 'retry') {
    await releaseQuietly(store, { turn_id, version, worker })
    throw Object.assign(new Error('TURN_DISPATCH_RETRY'), { code: 'TURN_DISPATCH_RETRY', reasons: d?.reasons || [] })
  }
  const outcome = dispatchOutcomeOf(d)
  const reasons = (d?.reasons || []).map((r) => String(r).toLowerCase().replace(/[^a-z0-9_:.-]/g, '_').slice(0, 60)).slice(0, 6)
  let operatorItem = null
  if (outcome === 'held' && typeof raiseOperatorItem === 'function') {
    // the operator item is raised BEFORE the hold is recorded: if it cannot be written the lease is
    // released and the job retries (bounded), so a hold is never silent
    try {
      operatorItem = await raiseOperatorItem({ turn_id, version, r3_status: status || 'unknown', reasons })
    } catch (e) {
      await releaseQuietly(store, { turn_id, version, worker })
      throw Object.assign(new Error('TURN_HELD_OPERATOR_ITEM_FAILED'), { code: 'TURN_HELD_OPERATOR_ITEM_FAILED', cause: e })
    }
  }
  if (typeof store.dispatchDone === 'function') {
    const detail = outcome === 'held' || outcome === 'not_sent' ? { r3_status: status || 'unknown', reasons, operator_item: operatorItem?.ok === true } : null
    const done = await store.dispatchDone({ turn_id, version, worker, outcome, detail })
    if (!done?.ok) return { code: 'TURN_DISPATCH_LEASE_LOST', dispatch: status, reason: done?.reason || null, members, resumed }
  }
  if (outcome === 'held') return { code: 'TURN_DISPATCH_HELD', dispatch: status, reasons, operator_item: operatorItem?.ok === true, members, resumed }
  if (outcome === 'not_sent') return { code: 'TURN_NOT_SENT', dispatch: status, reasons, members, resumed }
  return afterDispatch({ d, turn_id, store, enqueueAt, now, members, resumed })
}

/** R3's verdict → the turn's next step. */
async function afterDispatch({ d, turn_id, store, enqueueAt, now, members, resumed = false }) {
  const status = d?.status || null
  if (status === 'deferred' && d?.next_permitted_at) {
    // the shared send-time function says "not now": re-plan the SAME turn at the next permitted
    // time (reopen deletes the turn's reservations; a new version + job carries the schedule)
    const r = await store.reopen({ turn_id, reason: 'window_deferred', due_at: d.next_permitted_at, plan: { action: 'schedule', due_at: d.next_permitted_at, reasons: ['deferred_by_send_time_check'] } })
    if (r?.ok && typeof enqueueAt === 'function') {
      const id = r.turn_id || r.merged_into || turn_id
      await enqueueAt({ kind: CONVERSATION_TURN_KIND, event_key: turnEventKey(id, r.version), input: turnJobInput({ turn_id: id, version: r.version }), priority: 100, not_before: r.due_at || d.next_permitted_at })
    }
    return { code: 'TURN_DEFERRED_TO_WINDOW', dispatch: status, next_permitted_at: d.next_permitted_at, members, resumed }
  }
  return { code: 'TURN_DISPATCHED', dispatch: status, reasons: (d?.reasons || []).slice(0, 6), members, resumed }
}

/** Restart recovery: re-enqueue overdue turns and expired claims (event key per 10-min epoch). */
export async function recoverDueTurns({ store, enqueueAt, now, limit = 50, graceSeconds = 60 }) {
  const due = await store.due({ limit, grace_seconds: graceSeconds })
  const epoch = Math.floor(Date.parse(now) / (10 * MIN))
  let enqueued = 0; let deduped = 0
  for (const d of Array.isArray(due) ? due : []) {
    const r = await enqueueAt({ kind: CONVERSATION_TURN_KIND, event_key: turnEventKey(d.turn_id, d.version, epoch), input: turnJobInput(d), priority: 90, not_before: now })
    if (r?.deduped) deduped += 1; else if (r?.ok !== false) enqueued += 1
  }
  return { code: 'TURN_SWEEP_DONE', due: Array.isArray(due) ? due.length : 0, enqueued, deduped }
}
