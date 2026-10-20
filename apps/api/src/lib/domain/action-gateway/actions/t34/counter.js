// record_seller_counteroffer (T2, NOT reversible ⇒ a per-use human approval). Records a seller's counter as an
// immutable offer-history version through the EXISTING writer (seller-flow/seller-offer-authority#recordSellerCounter,
// run by LeadCommand's worker: action_gateway.execute) plus the negotiation ledger event (seller_counter / seller_ask).
// The price is bound to ONE inbound message of the thread and must be a dollar amount that message actually states
// (never a model-asserted number). NO AUTO-ACCEPTANCE: after recording, the worker runs the existing acceptance
// guard (holds/automation-hold-core#evaluateAcceptanceRules: operator-origin / above-MAO / above-ceiling / archived /
// held ⇒ human review) and reports its verdict; acceptance is never exposed (catalog NEVER_EXPOSED: accept_offer).
import { UUID, obj, str, int } from '../../../../agent/capabilities/defs/_schema.js'
import { extractMoneyAmounts } from '../../../negotiation/seller-facing-guard.js'
import { gwErr } from '../../errors.js'
import { TIERS, DOMAIN_WRITES } from '../../constants.js'
import { mustThread, threadResource, holdDeny, pref } from './shared.js'

const CLIENT_KEY = str(80, { minLength: 8, pattern: '^[A-Za-z0-9_.:-]{8,80}$' })

export const COUNTER_SPEC = Object.freeze({
  name: 'record_seller_counteroffer',
  title: 'Record a seller counteroffer',
  description: 'Record the price a seller stated in ONE inbound message of a thread as an immutable offer-history version (a new seller-counter version; history is never overwritten) and a negotiation ledger event. The price must appear in that message. Never accepts anything: the acceptance guard routes it to a human. A human approves each recording.',
  capability: 'offers.record_counter', tier: TIERS.T2, resource: 'thread',
  input: obj({ client_request_id: CLIENT_KEY, thread_id: UUID, inbound_message_id: UUID, counter_price: int(1000, 99_999_999) }, ['client_request_id', 'thread_id', 'inbound_message_id', 'counter_price']),
  executor: { kind: 'domain_write', fn: DOMAIN_WRITES.handoff },
  recovery: 'reexecute',
  limits: { per_min: 10 },
  wraps: { service: 'handoff → LeadCommand worker action_gateway.execute: seller-offer-authority#recordSellerCounter + negotiation-service#recordNegotiationEvent + automation-hold-core#evaluateAcceptanceRules (report only)', module: 'apps/api/src/lib/domain/negotiation/negotiation-send.js' },
  touches: ['agent_runtime_job'],
})

export const COUNTER_LOGIC = Object.freeze({
  async resolve(input, { reads }) { return threadResource(await mustThread(reads, input.thread_id)) },
  async params(input, resource, { reads }) {
    const m = await reads.message(input.inbound_message_id)
    if (!m || m.thread_key !== resource.refs.thread_key || String(m.direction).toLowerCase() !== 'inbound') throw gwErr('not_found', 'INBOUND_NOT_IN_THREAD', 'no inbound message with this id on this thread')
    const property_id = m.property_id || resource.refs.property_id
    if (!property_id) throw gwErr('refused', 'PROPERTY_UNRESOLVED', 'the message is not tied to a property')
    const opp = await reads.opportunityFor(resource.refs.thread_key, property_id)
    if (!opp?.id) throw gwErr('refused', 'OPPORTUNITY_NOT_FOUND', 'no acquisition opportunity for this thread and property')
    return { thread_id: resource.id, inbound_message_id: String(m.id), property_ref: pref(property_id), opportunity_id: String(opp.id), counter_price: input.counter_price, runtime_kind: 'action_gateway.execute' }
  },
  async policy({ input, resource, params, reads, services }) {
    const m = await reads.message(params.inbound_message_id)
    const stated = extractMoneyAmounts(m?.message_body || '').map(Number)
    if (!stated.includes(Number(input.counter_price))) return { decision: 'deny', code: 'COUNTER_PRICE_NOT_IN_MESSAGE', evidence: { stated_amounts: stated.length } }
    const h = await holdDeny(services, { threadKey: resource.refs.thread_key, threadId: resource.id, propertyId: resource.refs.property_id }, ['offer_write'])
    if (h) return h
    return { decision: 'allow', evidence: { bound_to: 'inbound_message', amount_stated_in_message: true, auto_accept: false } }
  },
  summary: (p) => [`Record the seller's counter of $${Number(p.counter_price).toLocaleString('en-US')} (stated in their message) as a new offer-history version.`, 'Never an acceptance: the acceptance guard routes any acceptance to a human.'],
})
