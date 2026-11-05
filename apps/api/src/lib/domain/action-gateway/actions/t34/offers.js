// The T4 (financial) offer family. Three steps, each a different authority:
//
//   prepare_acquisition_offer   READ (no intent; audited). A lane-labelled valuation, the MAO (THE CEILING, never the
//                               opening) and an opening STRICTLY below it, with provenance; the negotiation position
//                               as the composer sees it; a plan_hash. Never sent, never stored. Uneconomic ⇒ never HOT.
//   submit_offer_for_approval   files ONE approval request on the EXISTING ledger (agent.approval_request, the gateway's
//                               agent_actions.authorize_action) bound to (property, thread, max price, opening, terms,
//                               expiry, plan_hash = the parameters hash a human sees). Max ≤ the engine MAO; opening
//                               strictly below it. On the HUMAN decision the gateway's domain write grants the
//                               negotiation envelope for EXACTLY that thread + property (public.negotiation_envelopes).
//   execute_authorized_offer    communicates an offer ONLY inside a valid operator-authorized envelope for that exact
//                               property and thread AND its DISTINCT live send authorization (operator-approved through
//                               the D6 decide path): max price, allowed terms, expiry, both approval records; the send
//                               budget is DURABLE and consumed atomically (R5, single-use per send, replay-protected).
//                               Only when the production negotiation capability is activated (system_control
//                               negotiation_send_enabled), else capability_unavailable. LeadCommand's worker then runs
//                               composeNegotiationReply → persistActiveOffer (the R4 ceiling) → the ledger → the
//                               canonical queue writer → the dispatcher.
// Contracts, withdrawals of communicated offers, acceptance and legal actions are NEVER exposed (catalog NEVER_EXPOSED).
import { UUID, obj, str, int, bool, enumOf } from '../../../../agent/capabilities/defs/_schema.js'
import { sendAuthorizationStatus } from '../../../negotiation/send-authorization.js'
import { validateEnvelope, underwritingBasis, underwritingHash, ENVELOPE_MAX_TTL_DAYS } from '../../../negotiation/envelope.js'
import { gwErr } from '../../errors.js'
import { TIERS, DOMAIN_WRITES } from '../../constants.js'
import { mustThread, mustProperty, threadResource, holdDeny, permissionDeny, negotiationActivation, pref, PROPERTY_ID, num, iso } from './shared.js'
import { loadOfferAuthority, planHash, economicsClassOf } from './offer-authority.js'

const CLIENT_KEY = str(80, { minLength: 8, pattern: '^[A-Za-z0-9_.:-]{8,80}$' })
const HEX64 = str(64, { minLength: 64, pattern: '^[0-9a-f]{64}$' })
const MONEY = int(1000, 99_999_999)

// ── prepare (read) ───────────────────────────────────────────────────────────
export const PREPARE_SPEC = Object.freeze({
  name: 'prepare_acquisition_offer',
  title: 'Prepare an acquisition offer (never sent)',
  description: 'The engine\'s lane-labelled valuation, the MAO (the CEILING, never the opening) and an opening strictly below it, with provenance, plus the negotiation position as the composer would see it and a plan_hash to submit for approval. Read only: nothing is stored, sent or offered. Uneconomic properties are never labelled HOT.',
  capability: 'offers.prepare', tier: TIERS.T4, scope: null, resource: 'property',
  input: obj({ property_id: PROPERTY_ID, thread_id: UUID }, ['property_id']),
  limits: { per_min: 12 },
  wraps: { service: 'opportunity-economics#assessOpportunityEconomics + property-research/offer-plan#planOffer + acquisition/laneValuation (cross-check) + negotiation-service#preparePosition → composerView' },
})

function field(f) { return f && typeof f === 'object' && 'value' in f ? { value: f.value ?? null, source: f.source ?? f.provenance?.source ?? null, as_of: f.as_of ?? f.provenance?.as_of ?? null, confidence: f.confidence ?? f.provenance?.confidence ?? null } : f ?? null }

export const PREPARE_LOGIC = Object.freeze({
  async read({ input, reads, store, services, now, coverResource }) {
    const property = await mustProperty(reads, input.property_id)
    coverResource({ type: 'property', id: String(input.property_id), refs: { market: property.market || null } })
    const thread = input.thread_id ? await mustThread(reads, input.thread_id) : null
    if (thread) coverResource({ type: 'thread', id: thread.id, refs: { market: thread.market || null } })
    const a = await loadOfferAuthority({ reads, store, services, property_id: input.property_id, thread, now: now() })
    const plan = a.plan
    const opening = plan.available ? plan.opening.recommended : null
    if (opening != null && !(opening < plan.mao.amount)) throw gwErr('internal', 'OPENING_NOT_BELOW_CEILING') // the invariant, asserted
    const cls = economicsClassOf(a.economics, plan)
    return {
      version: 'action-gateway.prepare-offer.v1', resource_type: 'property', property_id: String(input.property_id), thread_id: thread?.id || null,
      seller_facing: false, sent: false, stored: false,
      lane: plan.lane,
      valuation: plan.values ? Object.fromEntries(Object.entries(plan.values).map(([k, v]) => [k, field(v)])) : null,
      mao: plan.available ? { amount: plan.mao.amount, role: 'ceiling_not_opening', source: plan.mao.source, as_of: plan.mao.as_of, permission: 'recommendation_only_requires_granted_envelope' } : null,
      target: plan.available ? plan.target : null,
      opening: plan.available ? { recommended: plan.opening.recommended, range: plan.opening.range, strictly_below_ceiling: true, factors: (plan.opening.factors || []).map((f) => ({ factor: f.factor, effect: f.effect })) } : null,
      available: plan.available === true, reason: plan.reason || null, recommendation: plan.recommendation || null,
      engine: plan.engine || null,
      economics: { class: cls, original_class: a.economics?.class || null, reasons: (a.economics?.reasons || []).slice(0, 12), uncertainty: a.economics?.uncertainty?.level || null, rule: 'uneconomic_never_hot' },
      lane_valuation: a.lane,
      position: a.view ? { status: a.view.status, move: a.view.move, allowed_terms: a.view.allowed_terms, may_state_amount: a.view.may_state_amount } : null,
      envelope: a.state?.envelope ? { envelope_id: a.state.envelope.envelope_id, version: a.state.envelope.version, live: a.state.envelope.revoked !== true && Date.parse(a.state.envelope.expires_at) > now(), expires_at: a.state.envelope.expires_at } : null,
      plan_hash: planHash(plan, input.property_id),
      notes: (plan.notes || []).slice(0, 12),
      provenance: { engine_row: 'public.property_acquisition_scores (Decision Engine)', planner: plan.version, generated_at: iso(now()) },
    }
  },
})

// ── submit for approval ──────────────────────────────────────────────────────
export const SUBMIT_SPEC = Object.freeze({
  name: 'submit_offer_for_approval',
  title: 'Submit an offer envelope for human approval',
  description: 'File ONE approval request (the existing approval ledger) for a negotiation envelope on EXACTLY this thread + property: max price (≤ the engine MAO), an opening strictly below it, the terms, the expiry, bound to the plan_hash from prepare_acquisition_offer. A human decides; on approval LeadCommand grants the envelope. Nothing is sent: communicating an offer additionally needs a separate send authorization and execute_authorized_offer.',
  capability: 'offers.submit_for_approval', tier: TIERS.T4, resource: 'thread',
  input: obj({ client_request_id: CLIENT_KEY, thread_id: UUID, property_id: PROPERTY_ID, max_price: MONEY, opening_price: MONEY, max_moves: int(1, 10),
    closing_window_min_days: int(1, 365), closing_window_max_days: int(1, 365), earnest_money_min: int(0, 9_999_999), earnest_money_max: int(0, 9_999_999),
    as_is: bool(), closing_costs_paid_by: enumOf(['buyer', 'seller', 'split']), expires_in_days: int(1, ENVELOPE_MAX_TTL_DAYS), plan_hash: HEX64 },
  ['client_request_id', 'thread_id', 'property_id', 'max_price', 'opening_price', 'closing_window_min_days', 'closing_window_max_days', 'earnest_money_min', 'earnest_money_max', 'closing_costs_paid_by', 'expires_in_days', 'plan_hash']),
  executor: { kind: 'domain_write', fn: DOMAIN_WRITES.offer_envelope },
  recovery: 'reexecute',
  limits: { per_min: 6 },
  wraps: { service: 'agent.approval_request (agent_actions.authorize_action) → public.negotiation_envelopes on the human decision', module: 'apps/api/src/lib/domain/negotiation/envelope.js' },
  touches: ['negotiation_envelope', 'approval_request'],
})

export const SUBMIT_LOGIC = Object.freeze({
  async resolve(input, { reads }) {
    await mustProperty(reads, input.property_id)
    return threadResource(await mustThread(reads, input.thread_id), { property_id: String(input.property_id) })
  },
  async params(input, resource, { reads, store, services, now }) {
    const a = await loadOfferAuthority({ reads, store, services, property_id: input.property_id, thread: { id: resource.id, thread_key: resource.refs.thread_key }, now: now() })
    const state = a.state
    if (!state?.scope_hash || !state?.thread_ref) throw gwErr('refused', 'SCOPE_UNRESOLVED', 'the thread / property scope could not be resolved')
    const basis = underwritingBasis(a.economics)
    return {
      thread_id: resource.id, property_ref: pref(input.property_id), scope_hash: state.scope_hash, thread_ref: state.thread_ref,
      terms: { max_price: input.max_price, opening_price: input.opening_price, max_moves: input.max_moves ?? 3, closing_window_min_days: input.closing_window_min_days, closing_window_max_days: input.closing_window_max_days,
        earnest_money_min: input.earnest_money_min, earnest_money_max: input.earnest_money_max, as_is: input.as_is !== false, closing_costs_paid_by: input.closing_costs_paid_by, expires_in_days: input.expires_in_days },
      underwriting: { basis: { ...basis, valuation_snapshot_ref: basis.valuation_snapshot_id ? String(basis.valuation_snapshot_id) : null, valuation_snapshot_id: undefined }, class: a.economics?.class ?? null },
      underwriting_hash: underwritingHash(a.economics), plan_hash: input.plan_hash,
    }
  },
  async policy({ input, resource, params, reads, store, services, now }) {
    const h = await holdDeny(services, { threadKey: resource.refs.thread_key, threadId: resource.id, propertyId: String(input.property_id) }, ['offer_write'])
    if (h) return h
    const a = await loadOfferAuthority({ reads, store, services, property_id: input.property_id, thread: { id: resource.id, thread_key: resource.refs.thread_key }, now: now() })
    if (planHash(a.plan, input.property_id) !== params.plan_hash) return { decision: 'deny', code: 'PLAN_DRIFTED', evidence: { hint: 'prepare_acquisition_offer again and submit its plan_hash' } }
    if (!a.plan.available) return { decision: 'deny', code: 'NO_ENGINE_CEILING', evidence: { reason: a.plan.reason || null } }
    if (economicsClassOf(a.economics, a.plan) === 'PASS') return { decision: 'deny', code: 'ECONOMICS_PASS', evidence: {} }
    const mao = a.plan.mao.amount
    if (input.max_price > mao) return { decision: 'deny', code: 'ENVELOPE_ABOVE_ENGINE_MAO', evidence: { mao } }
    if (!(input.opening_price < input.max_price) || !(input.opening_price < mao)) return { decision: 'deny', code: 'OPENING_NOT_BELOW_CEILING', evidence: {} }
    const nowMs = now()
    const v = validateEnvelope({ ...params.terms, valid_from: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + input.expires_in_days * 864e5).toISOString() }, { now: nowMs })
    if (!v.ok) return { decision: 'deny', code: 'ENVELOPE_INVALID', evidence: { errors: v.errors.slice(0, 8) } }
    return { decision: 'allow', evidence: { mao, max_price: input.max_price, opening: input.opening_price, expires_in_days: input.expires_in_days } }
  },
  summary: (p) => [
    `Grant a negotiation envelope for this thread + property: max $${Number(p.terms.max_price).toLocaleString('en-US')} (≤ the engine MAO), opening $${Number(p.terms.opening_price).toLocaleString('en-US')}`,
    `Terms: closing ${p.terms.closing_window_min_days}-${p.terms.closing_window_max_days} days; EMD $${p.terms.earnest_money_min}-$${p.terms.earnest_money_max}; ${p.terms.as_is ? 'as-is' : 'repairs negotiable'}; closing costs: ${p.terms.closing_costs_paid_by}; up to ${p.terms.max_moves} moves; expires ${p.terms.expires_in_days} day(s) after the grant`,
    'Financial (T4). Nothing is sent: sending needs a separate send authorization.',
  ],
})

// ── execute ──────────────────────────────────────────────────────────────────
export const EXECUTE_SPEC = Object.freeze({
  name: 'execute_authorized_offer',
  title: 'Communicate an authorized offer',
  description: 'Communicate the engine\'s authorized move to the seller ONLY inside a live operator-granted envelope AND its separate live send authorization for EXACTLY this thread + property (amount ≤ the send ceiling ≤ the envelope max ≤ the engine MAO, allowed terms, expiry, both approval records, the durable send budget). Only when the production negotiation capability is activated (else capability_unavailable). LeadCommand composes from an approved template, persists the offer (ceiling-checked), records the ledger and queues it through the canonical writer.',
  capability: 'offers.execute_authorized', tier: TIERS.T4, resource: 'thread', envelope_authorized: true,
  input: obj({ client_request_id: CLIENT_KEY, thread_id: UUID, property_id: PROPERTY_ID, amount: MONEY }, ['client_request_id', 'thread_id', 'property_id', 'amount']),
  executor: { kind: 'domain_write', fn: DOMAIN_WRITES.handoff },
  recovery: 'reexecute',
  limits: { per_min: 6 },
  wraps: { service: 'handoff → LeadCommand worker action_gateway.execute: negotiation-composer#composeNegotiationReply + seller-offer-authority#persistActiveOffer + negotiation-service#recordNegotiationEvent + the canonical queue writer', module: 'apps/api/src/lib/domain/negotiation/negotiation-send.js' },
  touches: ['agent_runtime_job', 'negotiation_send_authorization_use'],
})

export const EXECUTE_LOGIC = Object.freeze({
  async available({ reads }) { return negotiationActivation(reads) },
  async resolve(input, { reads }) {
    await mustProperty(reads, input.property_id)
    return threadResource(await mustThread(reads, input.thread_id), { property_id: String(input.property_id) })
  },
  async params(input, resource, { store }) {
    const state = await store.negotiationState(resource.id, input.property_id)
    const sa = state?.send_authorization || null
    return { thread_id: resource.id, property_ref: pref(input.property_id), amount: input.amount, send_permit_id: sa?.send_authorization_id || null,
      envelope_id: state?.envelope?.envelope_id || null, envelope_version: num(state?.envelope?.version), runtime_kind: 'action_gateway.execute' }
  },
  async policy({ input, resource, params, reads, store, services, now }) {
    const act = await negotiationActivation(reads).catch(() => ({ available: false, code: 'CAPABILITY_STATE_UNREADABLE' }))
    if (!act.available) return { decision: 'deny', code: 'CAPABILITY_UNAVAILABLE', evidence: { reason: act.code } }
    const h = await holdDeny(services, { threadKey: resource.refs.thread_key, threadId: resource.id, propertyId: String(input.property_id) }, ['negotiation.compose', 'offer_write', 'outbound_send'])
    if (h) return h
    const p = await permissionDeny(reads, resource)
    if (p) return p
    const a = await loadOfferAuthority({ reads, store, services, property_id: input.property_id, thread: { id: resource.id, thread_key: resource.refs.thread_key }, now: now() })
    const state = a.state
    const sa = state?.send_authorization || null
    if (!state?.envelope) return { decision: 'deny', code: 'NO_ENVELOPE', evidence: {} }
    if (!sa || sa.send_authorization_id !== params.send_permit_id) return { decision: 'deny', code: 'NO_SEND_AUTHORIZATION', evidence: {} }
    const st = sendAuthorizationStatus(sa, { scope_key: `nscope_${state.scope_hash}`, envelope: state.envelope, envelope_meta: { revoked: state.envelope.revoked, latest_version: state.envelope.latest_version }, amount: input.amount, sends_used: Number(sa.uses || 0), revoked: sa.revoked, now: now() })
    if (!st.live) return { decision: 'deny', code: `SEND_AUTHORIZATION_${String(st.reason).replace(/[^a-z0-9_]/gi, '_').toUpperCase()}`.slice(0, 80), evidence: {} }
    if (input.amount > Number(state.envelope.max_price)) return { decision: 'deny', code: 'AMOUNT_ABOVE_ENVELOPE_MAX', evidence: {} }
    if (a.plan.available && input.amount > a.plan.mao.amount) return { decision: 'deny', code: 'AMOUNT_ABOVE_ENGINE_MAO', evidence: {} }
    const view = a.view
    if (!view || view.status !== 'within_authority') return { decision: 'deny', code: `POSITION_${String(view?.status || 'unavailable').toUpperCase()}`, evidence: { reasons: (a.position?.escalation?.reasons || []).slice(0, 6) } }
    if (!view.move || view.move.amount == null) return { decision: 'deny', code: 'POSITION_HOLD_NO_NEW_OFFER', evidence: {} }
    if (Number(view.move.amount) !== Number(input.amount)) return { decision: 'deny', code: 'MOVE_AMOUNT_MISMATCH', evidence: { hint: 'the engine authorizes its own move amount; prepare_acquisition_offer shows it' } }
    return { decision: 'allow', envelope_ref: `send_authorization:${sa.send_authorization_id}`, evidence: { move: view.move.kind, envelope_version: num(state.envelope.version), send_uses: Number(sa.uses || 0), max_sends: Number(sa.max_sends || 1) } }
  },
})
