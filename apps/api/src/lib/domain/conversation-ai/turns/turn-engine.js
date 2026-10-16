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
export function planInputsFromThread({ thread = [], inbound, ledger = null, queueRows = [], timezone = null, now, extra = {} }) {
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

/**
 * The due turn: claim (exact version) → decide once on the consolidated thread → finalize.
 * @param {object} a
 * @param {(claim: object) => Promise<{ code: string, outcome?: string|null, reply?: { text: string }|null, record?: object|null }>} a.decideTurn
 * @param {null|((x: object) => Promise<object>)} [a.dispatch]  NOT wired in this release (R3 OFF)
 */
export async function runDueTurn({ turn_id, version, store, worker, decideTurn, dispatch = null, leaseSeconds = 180 }) {
  const claim = await store.claim({ turn_id, version, worker, lease_seconds: leaseSeconds })
  if (!claim?.ok) {
    const reason = String(claim?.reason || 'claim_refused')
    if (reason === 'not_due') throw Object.assign(new Error('TURN_NOT_DUE'), { code: 'TURN_NOT_DUE', due_at: claim.due_at })
    // stale_version: a newer inbound joined — the newer version's job decides; state_*: closed / claimed elsewhere
    // (a job for an OLDER version than the turn's is superseded whatever state the turn is in now)
    const superseded = reason === 'stale_version' || (Number.isInteger(claim?.version) && claim.version !== version)
    return { code: superseded ? 'TURN_SUPERSEDED' : `TURN_${reason.toUpperCase()}`, reason }
  }
  const decision = await decideTurn({ ...claim, turn_id })
  const outcome = String(decision?.outcome || 'no_decision').toLowerCase().replace(/[^a-z0-9_:.-]/g, '_').slice(0, 60)
  const wantsReply = Boolean(decision?.reply?.text) && typeof dispatch === 'function'
  const result = { code: decision?.code || null, outcome, send_status: wantsReply ? 'dispatch_pending' : 'not_sent_shadow', members: (claim.inbound_ids || []).length }
  const fin = await store.finalize({ turn_id, token: claim.token, version, outcome: `${wantsReply ? 'reply' : 'shadow'}:${outcome}`, result, reserve: wantsReply, reply_origin: wantsReply ? 'ai_generated' : null })
  if (!fin?.ok) return { code: 'TURN_SUPERSEDED_DURING_DECISION', reason: fin?.reason || null, decision_code: decision?.code || null }
  if (wantsReply && fin.reserved === false) return { code: 'TURN_ANSWERED_ELSEWHERE', conflict_inbound_id: fin.conflict_inbound_id || null }
  if (wantsReply) {
    const d = await dispatch({ turn_id, version, claim, decision })
    return { code: 'TURN_DISPATCHED', dispatch: d?.status || null, members: result.members }
  }
  return { code: 'TURN_DECIDED_SHADOW', outcome, members: result.members, decision_code: decision?.code || null }
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
