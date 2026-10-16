// CONVERSATION EVENT ROUTING (rc-8.5.20, Phase 1A). PURE.
//
// Every inbound and every conversation change becomes ONE R2 runtime event job
// (conversation.decide, idempotent per event version). The job first ROUTES the event here —
// deterministic checks only, never a model call — and only a turn that needs words goes on to
// the scheduled, consolidated decision (conversation.turn at the planned time).
//
//   event                      route              what happens (no model unless noted)
//   ─────────────────────────  ─────────────────  ───────────────────────────────────────────
//   opt_out (any stop request) suppress_now       IMMEDIATE: the open turn is cancelled, no delay,
//                                                 no model; the existing deterministic engine's
//                                                 suppression (webhook path) is unchanged
//   ownership denied / wrong # close_no_reply     facts only; the open turn is cancelled (no reply,
//                                                 no nurture, no further ownership ask)
//   new_inbound                schedule_turn      open a turn (or join the open one) at the planned
//   meaningful_update          schedule_turn       delay; the model runs at the due time, once,
//   offer_request              schedule_turn       on the consolidated turn
//   counteroffer               schedule_turn      (offer / counter are human-bound in the pipeline:
//   objection                  schedule_turn       NegotiationAuthority / operator, never the model)
//   acknowledgement only       join_or_ignore     joins an open turn (context), else nothing to say
//   hostile without stop       no_reply           insults never suppress; no reply, no model
//   failed_outbound_reply      reopen_turn        the reply never reached the provider: re-decide
//                              hold_no_duplicate  accepted / uncertain ack: NEVER sent again
//   state_change               cancel_turn        operator took over / owner-handled / suppressed
//                              replan_turn        offer recorded / stage moved: re-decide at due
//                              noop               archive (visibility only)
import { isStopRequest } from '../stop-request.js'
import { deterministicPrecheck } from '../precheck.js'
import { isDeflectionToOffer } from '../questions.js'
import { ownershipDenialTerminal } from '../ownership-evidence.js'

export const EVENT_ROUTER_VERSION = 'conv-ai.event-router.v2'

export const EVENT_TYPES = Object.freeze([
  'new_inbound', 'meaningful_update', 'offer_request', 'counteroffer', 'objection', 'acknowledgement',
  'opt_out', 'ownership_denied', 'hostile', 'failed_outbound_reply', 'state_change',
])
export const ROUTES = Object.freeze({
  SUPPRESS_NOW: 'suppress_now', CLOSE_NO_REPLY: 'close_no_reply', SCHEDULE_TURN: 'schedule_turn', JOIN_OR_IGNORE: 'join_or_ignore',
  NO_REPLY: 'no_reply', REOPEN_TURN: 'reopen_turn', HOLD_NO_DUPLICATE: 'hold_no_duplicate', CANCEL_TURN: 'cancel_turn', REPLAN_TURN: 'replan_turn', NOOP: 'noop',
})
// runtime priority (lower = sooner): a stop is claimed before anything else
export const ROUTE_PRIORITY = Object.freeze({ suppress_now: 1, close_no_reply: 20, cancel_turn: 20, hold_no_duplicate: 30, reopen_turn: 60, replan_turn: 80, schedule_turn: 100, join_or_ignore: 110, no_reply: 120, noop: 150 })

const ACK_ONLY_RE = /^\s*(?:ok(?:ay)?|k|kk|thanks?|thank\s+you|thx|ty|got\s+it|cool|sounds\s+good|alright|sure|noted|👍|🙏)\s*[.!]*\s*$/iu
const COUNTER_RE = /\b(?:counter|lowest\s+(?:i|we)\s+(?:would|will|can)|(?:can|could)\s+(?:you|u)\s+(?:do|go|come\s+up)|come\s+up|meet\s+(?:me\s+)?in\s+the\s+middle|firm\s+(?:on|at)|bottom\s+line|best\s+(?:you\s+can|offer)|too\s+low|lowball|low\s*ball|(?:i|we)\s+(?:need|want)\s+(?:at\s+least|more))\b/i
const OBJECTION_RE = /\b(?:scam|not\s+(?:that|so)\s+cheap|worth\s+(?:a\s+lot\s+)?more|insult(?:ing)?|why\s+(?:so|would\s+i)|don'?t\s+trust|let\s+me\s+think|need\s+(?:some\s+)?time|not\s+right\s+now|not\s+ready|talk\s+to\s+my\s+(?:wife|husband|family|partner|attorney))\b/i
const FAILED_PRE_ACCEPTANCE = new Set(['pre_acceptance', 'not_sent', 'failed_before_provider', 'refused_by_guard', 'transport_unreachable'])
const STATE_CANCEL = new Set(['operator_took_over', 'owner_handled', 'suppressed', 'thread_closed', 'manual_reply_sent'])
const STATE_REPLAN = new Set(['offer_recorded', 'stage_changed', 'property_linked', 'facts_corrected'])

/**
 * @param {object} e
 * @param {'inbound'|'failed_outbound_reply'|'state_change'} e.kind
 * @param {string} [e.text]                  inbound body
 * @param {{ intent?: string|null, compliance_flag?: string|null }|null} [e.deterministic]
 * @param {string|null} [e.lastQuestionKind] our last question before this inbound
 * @param {object|null} [e.ledger]           canonical ledger AFTER this inbound (optional)
 * @param {boolean} [e.openTurn]             a turn is open on the thread
 * @param {string|null} [e.failureClass]     failed_outbound_reply: pre_acceptance | uncertain_ack | accepted | …
 * @param {string|null} [e.change]           state_change: operator_took_over | offer_recorded | …
 * @param {boolean} [e.priorBodySeen]        the same body was already routed for this message (an edit-free repeat)
 * @returns {{ type: string, route: string, priority: number, model_needed: boolean, reasons: string[], version: string }}
 */
export function routeConversationEvent(e = {}) {
  const out = (type, route, reasons = [], model_needed = false) => ({ type, route, priority: ROUTE_PRIORITY[route], model_needed, reasons, version: EVENT_ROUTER_VERSION })
  if (e.kind === 'failed_outbound_reply') {
    const fc = String(e.failureClass || '').toLowerCase()
    // never duplicate a text after provider acceptance because of an uncertain ack
    if (FAILED_PRE_ACCEPTANCE.has(fc)) return out('failed_outbound_reply', ROUTES.REOPEN_TURN, [`failure:${fc}`])
    return out('failed_outbound_reply', ROUTES.HOLD_NO_DUPLICATE, [`failure:${fc || 'unknown'}`, 'never_resend_after_possible_acceptance'])
  }
  if (e.kind === 'state_change') {
    const ch = String(e.change || '').toLowerCase()
    if (STATE_CANCEL.has(ch)) return out('state_change', ROUTES.CANCEL_TURN, [`change:${ch}`])
    if (STATE_REPLAN.has(ch)) return out('state_change', e.openTurn ? ROUTES.REPLAN_TURN : ROUTES.NOOP, [`change:${ch}`])
    return out('state_change', ROUTES.NOOP, [`change:${ch || 'unknown'}`])
  }
  const text = String(e.text ?? '')
  const det = e.deterministic || null
  // 1. stop: deterministic, immediate, no model — beats everything
  if (isStopRequest(text) || ['opt_out', 'stop_texting'].includes(String(det?.intent)) || det?.compliance_flag === 'stop_texting') return out('opt_out', ROUTES.SUPPRESS_NOW, ['stop_request'])
  const pre = deterministicPrecheck({ text, inboundId: 'event', deterministic: det, lastQuestionKind: e.lastQuestionKind ?? null })
  if (pre.decided) {
    const o = pre.decision.outcome
    if (o === 'SUPPRESS') return out('opt_out', ROUTES.SUPPRESS_NOW, [`precheck:${pre.reason}`])
    if (o === 'UPDATE_ONLY') return out('ownership_denied', ROUTES.CLOSE_NO_REPLY, [`precheck:${pre.reason}`])
    if (o === 'NO_RESPONSE') return out('hostile', ROUTES.NO_REPLY, [`precheck:${pre.reason}`])
    return out('new_inbound', e.openTurn ? ROUTES.SCHEDULE_TURN : ROUTES.JOIN_OR_IGNORE, [`precheck:${pre.reason}`]) // empty body / media
  }
  const own = e.ledger?.facts?.ownership?.value
  if (own === 'denied' || own === 'former_owner') {
    const lastId = e.ledger?.last_message?.id
    const fromThis = (e.ledger.facts.ownership.source_message_ids || []).includes(lastId)
    // rc-8.5.21 (Phase 3A): a "sold" / denial the same message takes back, or one that carries a
    // price / answers a live negotiation, is NOT terminal — it is decided at the turn (a person)
    const verdict = fromThis ? ownershipDenialTerminal({ ledger: e.ledger, inboundId: lastId, inboundText: text }) : null
    if (fromThis && verdict.terminal) return out('ownership_denied', ROUTES.CLOSE_NO_REPLY, [`ledger:ownership_${own}`])
    if (fromThis) return out('meaningful_update', ROUTES.SCHEDULE_TURN, [`ownership_signal_not_terminal:${verdict.reasons[0]}`], true)
  }
  if (ACK_ONLY_RE.test(text)) return out('acknowledgement', ROUTES.JOIN_OR_IGNORE, ['acknowledgement_only'])
  if (isDeflectionToOffer(text) || det?.intent === 'asks_offer') return out('offer_request', ROUTES.SCHEDULE_TURN, ['offer_request_human_bound'], true)
  if (COUNTER_RE.test(text) || det?.intent === 'counter_or_negotiation') return out('counteroffer', ROUTES.SCHEDULE_TURN, ['counter_human_bound'], true)
  if (OBJECTION_RE.test(text)) return out('objection', ROUTES.SCHEDULE_TURN, ['objection'], true)
  if (e.openTurn) return out('meaningful_update', ROUTES.SCHEDULE_TURN, ['joins_open_turn'], true)
  return out('new_inbound', ROUTES.SCHEDULE_TURN, [], true)
}
