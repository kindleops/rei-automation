// 8.5.19 Phase 8 — negotiation authority: envelope, position, ledger, approvals, stage advance.
// No network, no DB (the disposable-DB proof of the tables is negotiation-authority-pg.test.mjs
// and scripts/db/run-migration-test.mjs --id negotiation_authority).
import test from 'node:test'
import assert from 'node:assert/strict'

import { scopeKey, scopeOf, validateEnvelope, envelopeStatus, termsWithinEnvelope, buildProposedEnvelope, buildEnvelopeRow, underwritingHash } from '../../src/lib/domain/negotiation/envelope.js'
import { decidePosition, FORBIDDEN_CLAIMS } from '../../src/lib/domain/negotiation/position.js'
import { emptyLedgerState, validateLedgerEvent, applyLedgerEvent, replayLedger, reconcileWithSellerOffers, buildLedgerEventRow, toSellerOfferArgs } from '../../src/lib/domain/negotiation/ledger.js'
import { createMemoryNegotiationStore } from '../../src/lib/domain/negotiation/store.js'
import { preparePosition, recordNegotiationEvent, grantEnvelope, revokeEnvelope } from '../../src/lib/domain/negotiation/negotiation-service.js'
import { createEnvelopeApprovals, encodePropertyRef, ENVELOPE_CAPABILITY_ID } from '../../src/lib/domain/negotiation/envelope-approval.js'
import { advanceStageIfEvidenceSupports } from '../../src/lib/domain/negotiation/stage-advance.js'
import { handleDecisionOutcome, DECISION_OUTCOMES_HANDLED, NEGOTIATION_INTERFACE_VERSION } from '../../src/lib/domain/negotiation/conversation-engine-interface.js'
import { createMemoryCapabilityStore } from '../../src/lib/agent/capabilities/stores.js'
import { createThreadRefCodec } from '../../src/lib/agent/capabilities/thread-ref.js'
import { FIRST_CAPABILITIES } from '../../src/lib/agent/capabilities/index.js'

const NOW = Date.parse('2026-10-15T15:00:00.000Z')
const TK = '+15555550123'
const PID = '227876842'
const SCOPE = { thread_key: TK, property_id: PID }
const ECON = { class: 'NEGOTIATE', reasons: ['ask_within_15pct_of_mao'], uncertainty: { level: 'low', missing: [], conflicts: [] }, evidence: { valuation_snapshot_id: 'snap-1', computed_at: '2026-10-10T12:00:00.000Z' }, metrics: { lane: 'sfr', mao: 150000, recommended_offer: 138000, ask: 165000, realistic_value: { mid: 200000 } } }

function envelopeRow(over = {}) {
  const scope = scopeOf(SCOPE)
  return {
    envelope_id: 'env-1', scope_key: scope.scope_key, version: 1, thread_ref: scope.thread_ref, property_id: PID,
    max_price: 150000, opening_price: 130000, max_moves: 3, closing_window_min_days: 7, closing_window_max_days: 30, earnest_money_min: 500, earnest_money_max: 2000,
    as_is: true, closing_costs_paid_by: 'buyer', valid_from: new Date(NOW - 864e5).toISOString(), expires_at: new Date(NOW + 6 * 864e5).toISOString(),
    granted_by: 'op-1', approval_id: 'apr_00000000-0000-4000-8000-000000000001', underwriting_hash: underwritingHash(ECON), ...over,
  }
}
const ledgerWith = (events) => replayLedger(events.map((e, i) => ({ seq: i + 1, ...e })), { scope_key: scopeKey(TK, PID) }).state
const decide = (over = {}) => decidePosition({ scope: SCOPE, economics: ECON, envelope: envelopeRow(), envelope_meta: { revoked: false, latest_version: 1 }, ledger: emptyLedgerState(scopeKey(TK, PID)), now: NOW, ...over })

test('no envelope ⇒ needs_envelope with a proposal for the operator and NO amount for the seller', () => {
  const p = decide({ envelope: null, envelope_meta: {} })
  assert.equal(p.status, 'needs_envelope')
  assert.equal(p.move, null)
  assert.equal(p.reason, 'no_envelope')
  assert.equal(p.proposed_envelope.operator_only, true)
  assert.equal(p.proposed_envelope.recommendation, 'grant')
  assert.equal(p.proposed_envelope.proposal.max_price, 150000, 'proposal max = the engine MAO, never above')
  assert.ok(p.proposed_envelope.proposal.opening_price <= 138000, 'opens at or below the engine recommended offer')
  assert.equal(p.proposed_envelope.underwriting.hash, underwritingHash(ECON))
  assert.ok(!JSON.stringify(p.proposed_envelope).includes(TK), 'no phone in the proposal')
  // no MAO → the proposal carries no price at all
  const unpriced = decide({ envelope: null, economics: { ...ECON, class: 'INVESTIGATE', metrics: { ...ECON.metrics, mao: null, recommended_offer: null } } })
  assert.equal(unpriced.proposed_envelope.proposal.max_price, null)
  assert.equal(unpriced.proposed_envelope.recommendation, 'operator_must_price')
  const pass = decide({ envelope: null, economics: { ...ECON, class: 'PASS' } })
  assert.equal(pass.proposed_envelope.recommendation, 'do_not_grant')
  assert.equal(pass.proposed_envelope.proposal.max_price, null)
})

test('expired / revoked / superseded / not-yet-valid envelopes are not authority', () => {
  assert.equal(decide({ envelope: envelopeRow({ expires_at: new Date(NOW - 1).toISOString() }) }).reason, 'expired')
  assert.equal(decide({ envelope_meta: { revoked: true, latest_version: 1 } }).reason, 'revoked')
  assert.equal(decide({ envelope_meta: { revoked: false, latest_version: 2 } }).reason, 'superseded')
  assert.equal(decide({ envelope: envelopeRow({ valid_from: new Date(NOW + 1000).toISOString() }) }).reason, 'not_yet_valid')
  for (const p of [decide({ envelope: envelopeRow({ expires_at: new Date(NOW - 1).toISOString() }) }), decide({ envelope_meta: { revoked: true } })]) {
    assert.equal(p.status, 'needs_envelope')
    assert.equal(p.move, null)
  }
})

test('scope mismatch escalates (another thread or another property)', () => {
  const other = scopeOf({ thread_key: '+15555550199', property_id: PID })
  const p = decide({ envelope: envelopeRow({ scope_key: other.scope_key }) })
  assert.equal(p.status, 'escalate')
  assert.deepEqual(p.escalation.reasons, ['scope_mismatch'])
  assert.equal(p.move, null)
  const p2 = decide({ scope: { thread_key: TK, property_id: '999' } })
  assert.equal(p2.status, 'escalate')
  assert.equal(decide({ scope: { thread_key: TK } }).escalation.reasons[0], 'scope_missing')
})

test('within authority: opens at the granted opening, counters half-way, never above max, final at max', () => {
  const open = decide({ seller_request: { amount: 170000 } })
  assert.equal(open.status, 'within_authority')
  assert.equal(open.move.kind, 'open')
  assert.equal(open.move.amount, 130000)
  assert.equal(open.move.ledger_event_type, 'our_offer')
  assert.equal(open.move.justification_visibility, 'internal_only')
  assert.deepEqual(open.forbidden_claims, [...FORBIDDEN_CLAIMS])
  assert.deepEqual(open.allowed_terms.closing_window_days, [7, 30])
  // seller at/below the opening → agree at THEIR number
  const cheap = decide({ seller_request: { amount: 120000 } })
  assert.equal(cheap.move.kind, 'agree_at_seller_price')
  assert.equal(cheap.move.amount, 120000)
  // after our 130K, seller counters 170K → half-way toward the limit, ≤ max
  const env = envelopeRow()
  const l1 = ledgerWith([
    { event_type: 'seller_ask', actor: 'seller', authority: 'seller_stated', amount: 170000 },
    { event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 130000 },
  ])
  const c1 = decide({ ledger: l1, seller_request: { amount: 168000 } })
  assert.equal(c1.move.kind, 'counter')
  assert.equal(c1.move.amount, 140000)
  assert.ok(c1.move.amount <= 150000)
  // two engine moves used of 3 → the next is the FINAL, at max (never above)
  const l2 = ledgerWith([
    { event_type: 'seller_ask', actor: 'seller', authority: 'seller_stated', amount: 170000 },
    { event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 130000 },
    { event_type: 'seller_counter', actor: 'seller', authority: 'seller_stated', amount: 168000 },
    { event_type: 'our_counter', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 140000 },
  ])
  const fin = decide({ ledger: l2, seller_request: { amount: 165000 } })
  assert.equal(fin.move.kind, 'final')
  assert.equal(fin.move.amount, 150000)
  // our last == max and the seller is still above → escalate, never a higher number
  const l3 = ledgerWith([...l2.history.map((h) => ({ event_type: h.event_type, actor: h.actor, authority: h.authority, envelope_id: h.envelope_id, amount: h.amount })), { event_type: 'seller_counter', actor: 'seller', authority: 'seller_stated', amount: 165000 }, { event_type: 'our_final', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 150000 }])
  const over = decide({ ledger: l3, seller_request: { amount: 160000 } })
  assert.equal(over.status, 'escalate')
  assert.equal(over.move, null)
  // moves spent: even a seller number under ours escalates (no engine move is left to record it)
  const env1 = envelopeRow({ max_moves: 1 })
  const spent = ledgerWith([{ event_type: 'seller_ask', actor: 'seller', authority: 'seller_stated', amount: 170000 }, { event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: env1.envelope_id, amount: 130000 }])
  assert.deepEqual(decide({ envelope: env1, ledger: spent, seller_request: { amount: 125000 } }).escalation.reasons, ['envelope_move_budget_exhausted'])
  assert.equal(decide({ envelope: env1, ledger: spent }).move.kind, 'hold')
  // a small remaining gap under max is closed at the seller's number
  const close = decide({ ledger: l1, seller_request: { amount: 131000 } })
  assert.equal(close.move.kind, 'agree_at_seller_price')
  assert.equal(close.move.amount, 131000)
  // no new seller number while our offer is out → hold, no new amount
  const hold = decide({ ledger: l1 })
  assert.equal(hold.move.kind, 'hold')
  assert.equal(hold.move.amount, null)
})

test('property: across 600 random states the amount is never above max and never present without an envelope', () => {
  let seed = 42
  const seen = { priced: 0, needs_envelope: 0, escalate: 0 }
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  for (let i = 0; i < 600; i += 1) {
    const max = 50000 + Math.floor(rnd() * 400000)
    const econ = { ...ECON, metrics: { ...ECON.metrics, mao: rnd() < 0.2 ? null : max + Math.floor(rnd() * 20000), recommended_offer: Math.floor(max * 0.9) } }
    const env = rnd() < 0.15 ? null : envelopeRow({ max_price: max, opening_price: rnd() < 0.2 ? null : Math.floor(max * (0.6 + rnd() * 0.4)), max_moves: 1 + Math.floor(rnd() * 4), expires_at: new Date(NOW + (rnd() < 0.1 ? -1 : 1) * 864e5).toISOString(), underwriting_hash: rnd() < 0.1 ? 'stale' : underwritingHash(econ) })
    const evs = []
    const n = Math.floor(rnd() * 5)
    let our = Math.floor(max * (0.5 + rnd() * 0.3))
    for (let k = 0; k < n; k += 1) {
      evs.push({ event_type: k === 0 ? 'seller_ask' : 'seller_counter', actor: 'seller', authority: 'seller_stated', amount: Math.floor(max * (0.8 + rnd() * 0.8)) })
      if (env && rnd() < 0.7) { evs.push({ event_type: evs.some((e) => e.actor === 'engine') ? 'our_counter' : 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: our }); our = Math.min(max, our + 5000) }
    }
    const fixed = []
    for (const e of evs) { if (e.event_type === 'seller_counter' && !fixed.some((x) => x.actor === 'engine')) e.event_type = 'seller_ask'; fixed.push(e) }
    const ledger = ledgerWith(fixed)
    const p = decide({ envelope: env, economics: { ...econ, }, ledger, seller_request: rnd() < 0.7 ? { amount: Math.floor(max * (0.5 + rnd())) } : {} })
    if (!env || p.status !== 'within_authority') assert.ok(p.move == null || p.move.amount == null, 'no amount outside authority')
    if (p.move?.amount != null) {
      assert.equal(p.status, 'within_authority')
      assert.ok(p.move.amount <= env.max_price, `amount ${p.move.amount} ≤ max ${env.max_price}`)
      assert.ok(p.move.amount > 0)
      seen.priced += 1
    }
    if (p.status !== 'within_authority') seen[p.status] += 1
  }
  assert.ok(seen.priced > 100 && seen.needs_envelope > 50 && seen.escalate > 20, JSON.stringify(seen))
})

test('seller terms outside authority escalate; creative structures and contingencies escalate', () => {
  for (const terms of [{ closing_days: 60 }, { earnest_money: 10000 }, { as_is: false }, { repairs_by_buyer_before_close: true }, { structure: 'seller_financing' }, { contingencies: ['inspection'] }]) {
    const p = decide({ seller_request: { amount: 140000, terms } })
    assert.equal(p.status, 'escalate', JSON.stringify(terms))
    assert.equal(p.move, null)
  }
  assert.equal(decide({ seller_request: { amount: 140000, terms: { closing_days: 21, earnest_money: 1000 } } }).status, 'within_authority')
  assert.deepEqual(termsWithinEnvelope({ closing_costs_paid_by: 'seller' }, envelopeRow()).violations, [], 'buyer-pays authority covers a seller offering to pay')
})

test('underwriting drift, PASS economics, envelope above current MAO, acceptance and stale prior offers escalate', () => {
  assert.deepEqual(decide({ economics: { ...ECON, evidence: { ...ECON.evidence, valuation_snapshot_id: 'snap-2' } } }).escalation.reasons, ['underwriting_changed_since_grant'])
  const passEcon = { ...ECON, class: 'PASS' }
  assert.deepEqual(decide({ economics: passEcon, envelope: envelopeRow({ underwriting_hash: underwritingHash(passEcon) }) }).escalation.reasons, ['economics_now_pass'])
  const lowMao = { ...ECON, metrics: { ...ECON.metrics, mao: 140000 } }
  assert.deepEqual(decide({ economics: lowMao, envelope: envelopeRow({ underwriting_hash: underwritingHash(lowMao) }) }).escalation.reasons, ['envelope_max_above_current_engine_mao'])
  const env = envelopeRow()
  const agreed = ledgerWith([{ event_type: 'seller_ask', actor: 'seller', authority: 'seller_stated', amount: 170000 }, { event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 130000 }, { event_type: 'seller_accept', actor: 'seller', authority: 'seller_stated' }])
  assert.deepEqual(decide({ ledger: agreed }).escalation.reasons, ['seller_accepted_contract_is_an_operator_act'])
  const legacy = reconcileWithSellerOffers(emptyLedgerState(scopeKey(TK, PID)), [{ offer_id: 'offer:o1:v1', direction: 'outbound', status: 'active', purchase_price: 160000, offer_version: 1 }])
  assert.deepEqual(decide({ ledger: legacy }).escalation.reasons, ['prior_offer_on_record_above_envelope'])
  assert.equal(decide({ economics: null }).escalation.reasons[0], 'economics_unavailable')
})

test('envelope contract: validation, scope key holds no phone, rows need an approval and an operator', () => {
  const sk = scopeKey(TK, PID)
  assert.match(sk, /^nscope_[0-9a-f]{64}$/)
  assert.ok(!sk.includes('5555550123'))
  const ok = validateEnvelope(envelopeRow(), { now: NOW })
  assert.equal(ok.ok, true)
  assert.ok(validateEnvelope(envelopeRow({ opening_price: 160000 }), { now: NOW }).errors.includes('opening_price:must_be_le_max'))
  assert.ok(validateEnvelope(envelopeRow({ expires_at: new Date(NOW + 40 * 864e5).toISOString() }), { now: NOW }).errors.includes('expires_at:within_30_days'))
  assert.ok(validateEnvelope(envelopeRow({ closing_costs_paid_by: 'anyone' }), { now: NOW }).errors.includes('closing_costs_paid_by:enum'))
  assert.throws(() => buildEnvelopeRow({ grant: envelopeRow(), scope: scopeOf(SCOPE), version: 1, approval_id: null, granted_by: 'op', underwriting_hash: 'x' }), /APPROVAL_ID_REQUIRED/)
  assert.throws(() => buildEnvelopeRow({ grant: envelopeRow(), scope: scopeOf(SCOPE), version: 1, approval_id: 'apr_00000000-0000-4000-8000-000000000001', granted_by: ' ', underwriting_hash: 'x' }), /GRANTED_BY_REQUIRED/)
  assert.equal(envelopeStatus(envelopeRow(), { scope_key: sk, now: NOW }).live, true)
})

test('ledger state machine: order, actors, envelope bound, monotonic engine moves, acceptance rules', () => {
  const sk = scopeKey(TK, PID)
  const env = envelopeRow()
  let s = emptyLedgerState(sk)
  const ev = (o) => ({ scope_key: sk, seq: s.seq + 1, ...o })
  const step = (o, opts = {}) => { const e = ev(o); const v = validateLedgerEvent(s, e, { envelope: env, envelope_meta: { latest_version: 1 }, now: NOW, ...opts }); if (v.ok) s = applyLedgerEvent(s, e); return v }
  assert.equal(step({ event_type: 'seller_counter', actor: 'seller', authority: 'seller_stated', amount: 170000 }).code, 'COUNTER_WITHOUT_OUR_OFFER_IS_AN_ASK')
  assert.equal(step({ event_type: 'seller_ask', actor: 'seller', authority: 'seller_stated', amount: 170000 }).ok, true)
  assert.equal(s.status, 'seller_priced')
  assert.equal(step({ event_type: 'seller_accept', actor: 'seller', authority: 'seller_stated' }).code, 'NOTHING_TO_ACCEPT')
  assert.equal(step({ event_type: 'our_offer', actor: 'engine', authority: 'none', amount: 120000 }).code, 'ENGINE_MOVE_NEEDS_ENVELOPE')
  assert.equal(step({ event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 150001 }).code, 'ABOVE_ENVELOPE_MAX')
  assert.equal(step({ event_type: 'our_offer', actor: 'seller', authority: 'seller_stated', amount: 120000 }).code, 'OUR_EVENT_BY_SELLER')
  assert.equal(step({ event_type: 'our_offer', actor: 'operator', authority: 'operator_direct', amount: 120000 }).code, 'OPERATOR_ID_REQUIRED')
  assert.equal(validateLedgerEvent(s, { ...ev({ event_type: 'seller_ask', actor: 'seller', authority: 'seller_stated', amount: 1 }), seq: s.seq + 2 }).code, 'SEQ_OUT_OF_ORDER')
  assert.equal(step({ event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 130000 }).ok, true)
  assert.equal(s.status, 'offer_out')
  assert.equal(step({ event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 135000 }).code, 'USE_OUR_COUNTER_AFTER_FIRST_OFFER')
  assert.equal(step({ event_type: 'seller_counter', actor: 'seller', authority: 'seller_stated', amount: 160000 }).ok, true)
  assert.equal(step({ event_type: 'our_counter', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 125000 }).code, 'ENGINE_MOVE_BELOW_PRIOR_OFFER')
  assert.equal(step({ event_type: 'our_counter', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 140000 }, { now: Date.parse(env.expires_at) }).code, 'ENVELOPE_EXPIRED')
  assert.equal(step({ event_type: 'our_counter', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 140000 }).ok, true)
  assert.equal(step({ event_type: 'our_counter', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 145000 }).ok, true)
  assert.equal(step({ event_type: 'our_final', actor: 'engine', authority: 'within_envelope', envelope_id: env.envelope_id, amount: 150000 }).code, 'ENVELOPE_MOVES_EXHAUSTED')
  assert.equal(step({ event_type: 'our_final', actor: 'operator', authority: 'operator_direct', operator_id: 'op-1', amount: 150000 }).ok, true)
  assert.equal(step({ event_type: 'seller_accept', actor: 'seller', authority: 'seller_stated' }).ok, true)
  assert.equal(s.status, 'agreed')
  assert.deepEqual(s.accepted, { amount: 150000, seq: s.seq })
  assert.deepEqual(s.our_amounts, [130000, 140000, 145000, 150000])
  // replay of the stored history reproduces the state
  const rows = s.history.map((h) => ({ scope_key: sk, seq: h.seq, event_type: h.event_type, actor: h.actor, authority: h.authority, amount: h.amount, envelope_id: h.envelope_id, operator_id: h.actor === 'operator' ? 'op-1' : null }))
  const re = replayLedger(rows.reverse(), { scope_key: sk })
  assert.equal(re.ok, true)
  assert.equal(re.state.status, 'agreed')
  assert.deepEqual(re.state.our_amounts, s.our_amounts)
  // a gap in stored history is reported, never repaired
  assert.equal(replayLedger(rows.filter((r) => r.seq !== 2), { scope_key: sk }).ok, false)
})

test('seller_offers stays THE formal offer authority: unbound offers are flagged, linked ones are not', () => {
  const sk = scopeKey(TK, PID)
  const base = replayLedger([{ scope_key: sk, seq: 1, event_type: 'seller_ask', actor: 'seller', authority: 'seller_stated', amount: 170000 }, { scope_key: sk, seq: 2, event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: 'env-1', amount: 130000, seller_offer_id: 'offer:o1:v1' }], { scope_key: sk }).state
  const r = reconcileWithSellerOffers(base, [
    { offer_id: 'offer:o1:v1', direction: 'outbound', status: 'superseded', purchase_price: 130000, offer_version: 1 },
    { offer_id: 'offer:o1:v2', direction: 'outbound', status: 'active', purchase_price: 135000, offer_version: 2 },
  ])
  assert.deepEqual(r.flags.map((f) => f.offer_id), ['offer:o1:v2'])
  const args = toSellerOfferArgs({ event: { event_type: 'our_counter', actor: 'engine', amount: 140000, terms: { closing_days: 14 } }, envelope: envelopeRow(), opportunity_id: 'o1', thread_key: TK, property_id: PID })
  assert.equal(args.authorized_ceiling, 150000)
  assert.equal(args.offer_type, 'counter_offer')
  assert.equal(args.metadata.offer_event.envelope_id, 'env-1')
  const row = buildLedgerEventRow({ scope: scopeOf(SCOPE), seq: 1, event_type: 'seller_ask', actor: 'seller', amount: 170000, authority: 'seller_stated', source_message_id: 'm1', now: NOW })
  assert.ok(!JSON.stringify(row).includes('5555550123'), 'ledger rows carry no phone')
  assert.equal(row.idempotency_key, buildLedgerEventRow({ scope: scopeOf(SCOPE), seq: 1, event_type: 'seller_ask', actor: 'seller', amount: 170000, authority: 'seller_stated', source_message_id: 'm1', now: NOW + 5 }).idempotency_key)
})

test('service: preparePosition / recordNegotiationEvent / grant / revoke over the memory store (DB invariants mirrored)', async () => {
  const store = createMemoryNegotiationStore({ now: () => NOW })
  const deps = { store, assessEconomics: async () => ECON }
  const first = await preparePosition({ ...SCOPE, now: NOW }, deps)
  assert.equal(first.status, 'needs_envelope')
  assert.equal(first.move, null)
  await assert.rejects(() => grantEnvelope({ ...SCOPE, grant: envelopeRow(), approval_id: 'nope', granted_by: 'op-1', economics: ECON, now: NOW }, { store }), /APPROVAL_ID_REQUIRED/)
  const g = await grantEnvelope({ ...SCOPE, grant: { ...envelopeRow(), valid_from: new Date(NOW).toISOString() }, approval_id: 'apr_00000000-0000-4000-8000-000000000001', granted_by: 'op-1', economics: ECON, now: NOW }, { store })
  assert.equal(g.version, 1)
  const ask = await recordNegotiationEvent({ ...SCOPE, event: { event_type: 'seller_ask', actor: 'seller', authority: 'seller_stated', amount: 170000, source_message_id: 'm1' }, now: NOW }, { store })
  assert.equal(ask.ok, true)
  const pos = await preparePosition({ ...SCOPE, now: NOW }, deps)
  assert.equal(pos.status, 'within_authority')
  assert.equal(pos.move.amount, 130000)
  const over = await recordNegotiationEvent({ ...SCOPE, event: { event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: g.envelope_id, amount: 150500 }, now: NOW }, { store })
  assert.deepEqual(over, { ok: false, code: 'ABOVE_ENVELOPE_MAX' })
  const mv = await recordNegotiationEvent({ ...SCOPE, event: { event_type: 'our_offer', actor: 'engine', authority: 'within_envelope', envelope_id: g.envelope_id, amount: pos.move.amount }, now: NOW }, { store })
  assert.equal(mv.ok, true)
  // immutability: a second version supersedes; the first is untouched; v1 moves are refused
  const g2 = await grantEnvelope({ ...SCOPE, grant: { ...envelopeRow({ max_price: 148000 }), valid_from: new Date(NOW).toISOString() }, approval_id: 'apr_00000000-0000-4000-8000-000000000002', granted_by: 'op-1', economics: ECON, now: NOW }, { store })
  assert.equal(g2.version, 2)
  const v2 = (await store.latestEnvelope(scopeKey(TK, PID))).envelope
  assert.throws(() => { v2.max_price = 999999 }, TypeError, 'stored envelopes are immutable')
  assert.equal(store._dump().envelopes[0].max_price, 150000, 'version 1 is untouched')
  assert.equal(store._dump().envelopes[1].supersedes_envelope_id, g.envelope_id)
  assert.equal(typeof store.updateEnvelope, 'undefined', 'no update path exists')
  const stale = await recordNegotiationEvent({ ...SCOPE, event: { event_type: 'our_counter', actor: 'engine', authority: 'within_envelope', envelope_id: g.envelope_id, amount: 140000 }, now: NOW }, { store })
  assert.equal(stale.ok, false)
  assert.equal((await revokeEnvelope({ envelope_id: g2.envelope_id, revoked_by: '', reason: 'x' }, { store })).code, 'OPERATOR_REQUIRED')
  await revokeEnvelope({ envelope_id: g2.envelope_id, revoked_by: 'op-1', reason: 'seller went quiet' }, { store })
  const afterRevoke = await preparePosition({ ...SCOPE, seller_request: { amount: 160000 }, now: NOW }, deps)
  assert.equal(afterRevoke.status, 'needs_envelope')
  assert.equal(afterRevoke.reason, 'revoked')
  // the 8.5.16 entry point
  assert.deepEqual(DECISION_OUTCOMES_HANDLED, ['PREPARE_OFFER', 'NEGOTIATE_WITHIN_AUTHORITY'])
  assert.equal(NEGOTIATION_INTERFACE_VERSION, 'lc.negotiation-interface.v1')
  const h = await handleDecisionOutcome('PREPARE_OFFER', { ...SCOPE, now: NOW }, deps)
  assert.equal(h.next, 'route_envelope_request_to_operator')
  const x = await handleDecisionOutcome('REPLY_CANDIDATE', { ...SCOPE, now: NOW }, deps)
  assert.equal(x.position.status, 'escalate')
})

test('envelope grant goes through the EXISTING approvals plane: operator-only, exact payload, drift refusal, single execution', async () => {
  const ORG = '00000000-0000-4000-8000-00000000a001'
  const OP = '11111111-1111-4111-8111-111111111111'
  const capStore = createMemoryCapabilityStore({ members: [{ org_id: ORG, user_id: OP, role: 'owner' }], now: () => NOW })
  const negStore = createMemoryNegotiationStore({ now: () => NOW })
  const refs = createThreadRefCodec({ secret: 'test-secret-0123456789abcdef' })
  let econ = ECON
  const services = { negotiation: { openThread: (ref, org) => refs.open(ref, org), underwriting: async () => econ, latestEnvelope: (sk) => negStore.latestEnvelope(sk), grant: (a) => grantEnvelope({ ...a, now: NOW }, { store: negStore }) } }
  const plane = createEnvelopeApprovals({ store: capStore, services, now: () => NOW })
  const identity = { user_id: OP, verified: true, named: true }
  const input = { thread_ref: refs.seal(TK, ORG), property_ref: encodePropertyRef(PID), max_price: 150000, opening_price: 130000, closing_window_min_days: 7, closing_window_max_days: 30, earnest_money_min: 500, earnest_money_max: 2000, closing_costs_paid_by: 'buyer', expires_in_days: 7 }
  assert.equal((await plane.propose({ org_id: ORG, identity: { user_id: OP }, input })).code, 'IDENTITY_REQUIRED')
  assert.equal((await plane.propose({ org_id: ORG, identity, input: { ...input, max_price: 160000 } })).code, 'ENVELOPE_ABOVE_ENGINE_MAO')
  const req = await plane.propose({ org_id: ORG, identity, input })
  assert.equal(req.ok, true)
  assert.equal((await negStore.latestEnvelope(scopeKey(TK, PID))).envelope, null, 'pending: nothing granted yet')
  const card = (await plane.get({ org_id: ORG, identity, approval_id: req.approval_id })).approval
  assert.equal(card.capability_id, ENVELOPE_CAPABILITY_ID)
  assert.equal(card.provenance, 'operator')
  assert.ok(!JSON.stringify(card).includes('5555550123') && !JSON.stringify(card).includes(PID), 'no phone or raw property id in the approval')
  assert.equal((await plane.decide({ org_id: ORG, identity, approval_id: req.approval_id, decision: 'approve', payload_hash: 'f'.repeat(64) })).code, 'HASH_MISMATCH')
  const done = await plane.decide({ org_id: ORG, identity, approval_id: req.approval_id, decision: 'approve', payload_hash: card.payload_hash })
  assert.equal(done.ok, true)
  assert.equal(done.state, 'executed')
  const latest = await negStore.latestEnvelope(scopeKey(TK, PID))
  assert.equal(latest.envelope.max_price, 150000)
  assert.equal(latest.envelope.approval_id, req.approval_id)
  assert.equal(latest.envelope.granted_by, OP)
  const replay = await plane.decide({ org_id: ORG, identity, approval_id: req.approval_id, decision: 'approve', payload_hash: card.payload_hash })
  assert.equal(replay.replayed, true)
  assert.equal(negStore._dump().envelopes.length, 1, 'a replay never grants twice')
  // drift: the valuation moves between request and approval → refused
  const req2 = await plane.propose({ org_id: ORG, identity, input: { ...input, max_price: 149000 } })
  const card2 = (await plane.get({ org_id: ORG, identity, approval_id: req2.approval_id })).approval
  econ = { ...ECON, evidence: { ...ECON.evidence, valuation_snapshot_id: 'snap-9' } }
  const drift = await plane.decide({ org_id: ORG, identity, approval_id: req2.approval_id, decision: 'approve', payload_hash: card2.payload_hash })
  assert.equal(drift.code, 'STATE_DRIFTED')
  assert.equal(negStore._dump().envelopes.length, 1)
  // the model-facing registry never contains the envelope capability (agent prohibitions intact)
  assert.ok(!FIRST_CAPABILITIES.some((c) => c.id === ENVELOPE_CAPABILITY_ID))
})

test('stage advance: only through the existing guard + domain service; dry run by default; contract stages refused', async () => {
  const opp = { id: 'o1', acquisition_stage: 'property_condition', asking_price: 165000 }
  const offers = [{ offer_id: 'offer:o1:v1', opportunity_id: 'o1', thread_key: TK, purchase_price: 130000, status: 'active', direction: 'outbound', sent_at: '2026-10-15T14:00:00.000Z', policy_version: 'v1', valuation_mid: 200000, authorized_ceiling: 150000, metadata: { offer_event: { source: 'engine', quote_type: 'FORMAL_OFFER', engine_version: 'negotiation.position.v1' } } }]
  const calls = []
  const deps = { transitionOpportunityStage: async (id, input) => { calls.push([id, input]); return { ok: true } } }
  assert.equal((await advanceStageIfEvidenceSupports({ opportunity: opp, to_stage: 'formal_contract', seller_offers: offers }, deps)).code, 'STAGE_NOT_REACHABLE_FROM_NEGOTIATION')
  const none = await advanceStageIfEvidenceSupports({ opportunity: opp, to_stage: 'offer', seller_offers: [] }, deps)
  assert.equal(none.code, 'OFFER_EVENT_REQUIRED')
  const dry = await advanceStageIfEvidenceSupports({ opportunity: opp, to_stage: 'offer', seller_offers: offers, valuation: { valuation_mid: 200000 } }, deps)
  assert.equal(dry.code, 'EVIDENCE_SUPPORTS_ADVANCE_DRY_RUN')
  assert.equal(calls.length, 0)
  const applied = await advanceStageIfEvidenceSupports({ opportunity: opp, to_stage: 'offer', seller_offers: offers, valuation: { valuation_mid: 200000 }, apply: true }, deps)
  assert.equal(applied.applied, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].source, 'engine')
})
