// The Action Gateway T3 (seller-facing) / T4 (financial) family. Registered by ONE line each in catalog.js
// (T34_ACTIONS / T34_READS replace the phase-1 stubs of the same name) and actions.js (T34_LOGIC).
// Durable half: supabase/migrations/PROPOSED_20261020110000_action_gateway_t34.sql. LeadCommand's executing half:
// apps/api/src/lib/ai/action-gateway-execution.js (the ONE runtime kind action_gateway.execute; born OFF).
import { QUEUE_REPLY_SPEC, QUEUE_REPLY_LOGIC } from './queue-reply.js'
import { PREPARE_SPEC, PREPARE_LOGIC, SUBMIT_SPEC, SUBMIT_LOGIC, EXECUTE_SPEC, EXECUTE_LOGIC } from './offers.js'
import { COUNTER_SPEC, COUNTER_LOGIC } from './counter.js'
// link #32: the agent-initiated message (T3) + its fallback-template read
import { QUEUE_AGENT_MESSAGE_SPEC, QUEUE_AGENT_MESSAGE_LOGIC, MESSAGE_TEMPLATES_READ_SPEC, MESSAGE_TEMPLATES_READ_LOGIC } from './queue-agent-message.js'
// link #32 (owner architecture correction 2026-10-29): the agent composes EVERY SMS — queue_agent_text sends its exact text
import { QUEUE_AGENT_TEXT_SPEC, QUEUE_AGENT_TEXT_LOGIC } from '../agent-text/index.js'

/**
 * RETIRED for agents (kept for the record): the paths where LeadCommand would write the words for an agent — the
 * brief-based agent message (composeAgentOutbound) and the certified reply (decideAndCompose). The gateway answers
 * AGENT_COMPOSES_TEXT (pointing to sms_send_agent_text = queue_agent_text); the database's handoff refuses them too.
 */
export const COMPOSER_RETIRED = Object.freeze({ code: 'AGENT_COMPOSES_TEXT', use: 'sms_send_agent_text', action: 'queue_agent_text' })
const retire = (spec) => Object.freeze({ ...spec, retired: COMPOSER_RETIRED, description: `RETIRED: LeadCommand never composes text for an agent — compose the exact SMS yourself and send it with sms_send_agent_text (answers AGENT_COMPOSES_TEXT). ${spec.description}` })

export const T34_ACTIONS = Object.freeze([retire(QUEUE_REPLY_SPEC), SUBMIT_SPEC, EXECUTE_SPEC, COUNTER_SPEC, retire(QUEUE_AGENT_MESSAGE_SPEC), QUEUE_AGENT_TEXT_SPEC])
export const T34_READS = Object.freeze([PREPARE_SPEC, MESSAGE_TEMPLATES_READ_SPEC])
export const T34_NAMES = Object.freeze([...T34_ACTIONS, ...T34_READS].map((s) => s.name))
export const T34_LOGIC = Object.freeze({
  queue_authorized_reply: QUEUE_REPLY_LOGIC,
  prepare_acquisition_offer: PREPARE_LOGIC,
  submit_offer_for_approval: SUBMIT_LOGIC,
  execute_authorized_offer: EXECUTE_LOGIC,
  record_seller_counteroffer: COUNTER_LOGIC,
  queue_agent_message: QUEUE_AGENT_MESSAGE_LOGIC,
  queue_agent_text: QUEUE_AGENT_TEXT_LOGIC,
  list_message_templates: MESSAGE_TEMPLATES_READ_LOGIC,
})
/** The runtime kinds the handoff enqueues (mirrors action_gateway.t34_handoff_kind). */
export const T34_RUNTIME_KINDS = Object.freeze({ queue_authorized_reply: 'action_gateway.execute', execute_authorized_offer: 'action_gateway.execute', record_seller_counteroffer: 'action_gateway.execute', queue_agent_message: 'action_gateway.execute', queue_agent_text: 'action_gateway.execute' })
