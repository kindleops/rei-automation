// The Action Gateway T3 (seller-facing) / T4 (financial) family. Registered by ONE line each in catalog.js
// (T34_ACTIONS / T34_READS replace the phase-1 stubs of the same name) and actions.js (T34_LOGIC).
// Durable half: supabase/migrations/PROPOSED_20261020110000_action_gateway_t34.sql. LeadCommand's executing half:
// apps/api/src/lib/ai/action-gateway-execution.js (runtime kinds action.*; born OFF).
import { QUEUE_REPLY_SPEC, QUEUE_REPLY_LOGIC } from './queue-reply.js'
import { PREPARE_SPEC, PREPARE_LOGIC, SUBMIT_SPEC, SUBMIT_LOGIC, EXECUTE_SPEC, EXECUTE_LOGIC } from './offers.js'
import { COUNTER_SPEC, COUNTER_LOGIC } from './counter.js'

export const T34_ACTIONS = Object.freeze([QUEUE_REPLY_SPEC, SUBMIT_SPEC, EXECUTE_SPEC, COUNTER_SPEC])
export const T34_READS = Object.freeze([PREPARE_SPEC])
export const T34_NAMES = Object.freeze([...T34_ACTIONS, ...T34_READS].map((s) => s.name))
export const T34_LOGIC = Object.freeze({
  queue_authorized_reply: QUEUE_REPLY_LOGIC,
  prepare_acquisition_offer: PREPARE_LOGIC,
  submit_offer_for_approval: SUBMIT_LOGIC,
  execute_authorized_offer: EXECUTE_LOGIC,
  record_seller_counteroffer: COUNTER_LOGIC,
})
/** The runtime kinds the handoff enqueues (mirrors action_gateway.t34_handoff_kind). */
export const T34_RUNTIME_KINDS = Object.freeze({ queue_authorized_reply: 'action.seller_reply', execute_authorized_offer: 'action.offer_send', record_seller_counteroffer: 'action.record_counter' })
