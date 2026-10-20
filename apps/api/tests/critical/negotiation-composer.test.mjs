// 8.5.21-b — the negotiation reply composer (THE call site of composerView + checkSellerFacingText):
// renders ONLY an envelope-authorized move, ONLY with a distinct live send authorization, ONLY from an
// approved template; the ceiling stays hidden; every violation is a hold for a human. Plus the send
// authorization type itself, its operator approval, and the negotiation pathway (opening < MAO, the
// lot example: land zoning / density first).
import test from 'node:test'
import assert from 'node:assert/strict'

import { scopeKey } from '../../src/lib/domain/negotiation/envelope.js'
import { createMemoryNegotiationStore } from '../../src/lib/domain/negotiation/store.js'
import { grantEnvelope } from '../../src/lib/domain/negotiation/negotiation-service.js'
import { composeNegotiationReply, createEnvelopeNegotiationAuthority, selectMoveTemplate, MOVE_TEMPLATE_USE_CASES } from '../../src/lib/domain/negotiation/negotiation-composer.js'
import { buildSendAuthorizationRow, sendAuthorizationStatus, createMemorySendAuthorizationStore, createSendAuthorizationApprovals, grantSendAuthorization, sendTermsFromEnvelope, SEND_AUTHORIZATION_CAPABILITY_ID } from '../../src/lib/domain/negotiation/send-authorization.js'
import { encodePropertyRef } from '../../src/lib/domain/negotiation/envelope-approval.js'
import { buildNegotiationPathway } from '../../src/lib/domain/negotiation/negotiation-pathway.js'
import { classifyOpportunityEconomics } from '../../src/lib/domain/opportunity-economics/classify-opportunity.js'
import { planOffer } from '../../src/lib/domain/property-research/offer-plan.js'
import { createMemoryCapabilityStore } from '../../src/lib/agent/capabilities/stores.js'
import { createThreadRefCodec } from '../../src/lib/agent/capabilities/thread-ref.js'
import { FIRST_CAPABILITIES } from '../../src/lib/agent/capabilities/index.js'
import { assertNegotiationAuthority } from '../../src/lib/domain/conversation-ai/pipeline/negotiation-authority.js'
import { score } from '../helpers/property-research-fixtures.mjs'

const NOW = Date.parse('2026-10-16T15:00:00.000Z')
const TK = '+15555550123'
const PID = '227876842'
const OP = '11111111-1111-4111-8111-111111111111'
const ON = { NEGOTIATION_COMPOSER_ENABLED: '1' }
const ECON = { class: 'NEGOTIATE', reasons: ['ask_within_15pct_of_mao'], uncertainty: { level: 'low', missing: [], conflicts: [] }, evidence: { valuation_snapshot_id: 'snap-1', computed_at: '2026-10-10T12:00:00.000Z' }, metrics: { lane: 'sfr', mao: 150000, recommended_offer: 138000, realistic_value: { mid: 200000 }, assignment_margin: { buyer_exit: 172000 } } }
const TPL = (o = {}) => ({ id: '6b0f7c62-1f4e-4b71-9a8e-3b1c2d4e5f60', use_case: 'offer_reveal_cash', template_body: 'Thanks for the details. We could buy it as-is for {{offer_price}} with no repairs on your end. Would that work for you?', is_active: true, language: 'English', ...o })
const apr = (n) => `apr_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function world({ grantSend = true, sendGrant = {}, envelope = {} } = {}) {
  const store = createMemoryNegotiationStore({ now: () => NOW })
  await grantEnvelope({ thread_key: TK, property_id: PID, grant: { max_price: 150000, opening_price: 132000, max_moves: 3, closing_window_min_days: 14, closing_window_max_days: 30, earnest_money_min: 1000, earnest_money_max: 1000, as_is: true, closing_costs_paid_by: 'buyer', valid_from: new Date(NOW - 3600e3).toISOString(), expires_at: new Date(NOW + 6 * 864e5).toISOString(), ...envelope }, approval_id: apr(1), granted_by: OP, economics: ECON, now: NOW }, { store })
  const sends = createMemorySendAuthorizationStore({ now: () => NOW })
  const env = (await store.latestEnvelope(scopeKey(TK, PID))).envelope
  if (grantSend) await grantSendAuthorization({ envelope: env, grant: { ceiling: 140000, max_sends: 1, expires_in_hours: 24, ...sendGrant }, approval_id: apr(2), granted_by: OP, now: NOW }, { store: sends })
  return { store, sends, env }
}
const compose = (w, o = {}) => composeNegotiationReply({ outcome: 'PREPARE_OFFER', context: { thread_key: TK, property_id: PID, economics: ECON, now: NOW, ...(o.context || {}) }, deps: { store: w.store }, sendAuthorizations: w.sends, templates: o.templates || [TPL()], thread: o.thread || {}, env: o.env || ON })

test('composer OFF by default; no envelope ⇒ escalate with NO amount and NO text', async () => {
  const w = await world()
  const off = await compose(w, { env: {} })
  assert.deepEqual([off.action, off.reason, off.rendered_text, off.amount], ['ESCALATE_TO_OPERATOR', 'negotiation_composer_disabled', null, null])
  const bare = { store: createMemoryNegotiationStore({ now: () => NOW }), sends: createMemorySendAuthorizationStore() }
  const r = await compose(bare)
  assert.deepEqual([r.action, r.rendered_text, r.amount], ['ESCALATE_TO_OPERATOR', null, null])
  assert.match(r.reason, /^needs_envelope/)
  assert.equal(r.composer_view.may_state_amount, false)
})

test('an envelope alone is NOT permission to send: without a distinct send authorization ⇒ escalate, nothing rendered', async () => {
  const w = await world({ grantSend: false })
  const r = await compose(w)
  assert.deepEqual([r.action, r.reason, r.rendered_text], ['ESCALATE_TO_OPERATOR', 'send_authorization:no_send_authorization', null])
  assert.equal(r.composer_view.move.amount, 132000, 'the move exists inside the envelope … but is not rendered')
})

test('envelope + send authorization + approved template ⇒ ONLY the authorized amount is rendered; opening < MAO; the ceiling stays hidden; persistence is described, never done', async () => {
  const w = await world()
  const r = await compose(w)
  assert.equal(r.action, 'DETERMINISTIC_REPLY', JSON.stringify(r))
  assert.equal(r.amount, 132000)
  assert.ok(r.amount < ECON.metrics.mao && r.amount < w.env.max_price, 'the opening is strictly below the ceiling')
  assert.match(r.rendered_text, /\$132,000/)
  assert.doesNotMatch(r.rendered_text, /150,000|140,000|138,000|200,000|172,000/, 'no ceiling, send ceiling, target, value or buyer exit')
  assert.deepEqual(r.validation, { ok: true, violations: [], amounts: [132000] })
  assert.equal(r.template_id, TPL().id)
  assert.equal(r.composer_view.move.kind, 'open')
  assert.equal(JSON.stringify(r.composer_view).includes('150000'), false, 'the composer view never carries the envelope max')
  assert.deepEqual(Object.keys(r.authority_ref).sort(), ['envelope_id', 'envelope_version', 'send_authorization_id'])
  assert.equal(r.persist.ledger_event.authority, 'within_envelope')
  assert.equal(r.persist.seller_offer_args.purchase_price, 132000)
  assert.equal(w.store._dump().events.length, 0, 'the composer appends nothing to the ledger')
})

test('send authorization scope: amount above the send ceiling, expired, revoked, superseded envelope, other terms, budget spent ⇒ refused', async () => {
  const low = await world({ sendGrant: { ceiling: 130000 } })
  assert.equal((await compose(low)).reason, 'send_authorization:amount_above_send_ceiling')
  const w = await world()
  const later = await composeNegotiationReply({ outcome: 'PREPARE_OFFER', context: { thread_key: TK, property_id: PID, economics: ECON, now: NOW + 25 * 3600e3 }, deps: { store: w.store }, sendAuthorizations: w.sends, templates: [TPL()], env: ON })
  assert.equal(later.reason, 'send_authorization:expired')
  const sk = scopeKey(TK, PID)
  const { authorization } = await w.sends.latestFor(sk)
  // R5: the budget is DURABLE — a caller-supplied count is never read (a forged 0 cannot reopen a spent budget)
  assert.equal((await compose(w, { thread: { sends_used: 1 } })).action, 'DETERMINISTIC_REPLY', 'a caller count is ignored')
  assert.deepEqual(await w.sends.consume({ send_authorization_id: authorization.send_authorization_id, use_key: 'use-1', amount: 132000 }), { ok: true, replayed: false, use_no: 1, remaining: 0 })
  assert.deepEqual(await w.sends.consume({ send_authorization_id: authorization.send_authorization_id, use_key: 'use-1', amount: 132000 }), { ok: true, replayed: true, use_no: 1 }, 'a retried send replays its own use')
  assert.deepEqual(await w.sends.consume({ send_authorization_id: authorization.send_authorization_id, use_key: 'use-2', amount: 132000 }), { ok: false, reason: 'send_budget_exhausted' })
  assert.equal((await compose(w, { thread: { sends_used: 0 } })).reason, 'send_authorization:send_budget_exhausted')
  assert.equal((await compose(w, { thread: { send_use_key: 'use-1' } })).action, 'DETERMINISTIC_REPLY', 'the send that holds the reservation is checked against the OTHER uses')
  assert.equal((await compose(w, { thread: { send_use_key: 'use-9' } })).reason, 'send_authorization:send_use_not_reserved')
  const noCount = { latestFor: (k) => w.sends.latestFor(k) }
  assert.equal((await composeNegotiationReply({ outcome: 'PREPARE_OFFER', context: { thread_key: TK, property_id: PID, economics: ECON, now: NOW }, deps: { store: w.store }, sendAuthorizations: noCount, templates: [TPL()], env: ON })).reason, 'send_authorization:send_budget_unverifiable', 'no durable count ⇒ fail closed')
  await w.sends.revoke({ send_authorization_id: authorization.send_authorization_id, revoked_by: OP, reason: 'seller went quiet' })
  assert.equal((await compose(w)).reason, 'send_authorization:revoked')
  const base = { scope_key: sk, envelope: w.env, envelope_meta: { revoked: false, latest_version: 1 }, amount: 132000, terms: sendTermsFromEnvelope(w.env), now: NOW }
  assert.equal(sendAuthorizationStatus(authorization, base).live, true)
  assert.equal(sendAuthorizationStatus(authorization, { ...base, scope_key: scopeKey(TK, '999') }).reason, 'scope_mismatch')
  assert.equal(sendAuthorizationStatus(authorization, { ...base, envelope_meta: { revoked: false, latest_version: 2 } }).reason, 'envelope_not_live:superseded')
  assert.equal(sendAuthorizationStatus(authorization, { ...base, terms: { ...base.terms, as_is: false } }).reason, 'terms_mismatch')
  assert.equal(sendAuthorizationStatus(authorization, { ...base, envelope: { ...w.env, envelope_id: 'other' } }).reason, 'envelope_mismatch')
})

test('the send authorization is a DISTINCT type: its own approval (never the envelope approval), ceiling ≤ envelope max, expiry ≤ 7 days and ≤ the envelope', async () => {
  const w = await world({ grantSend: false })
  assert.throws(() => buildSendAuthorizationRow({ envelope: w.env, grant: {}, approval_id: w.env.approval_id, granted_by: OP, now: NOW }), /SEND_AUTHORIZATION_NEEDS_ITS_OWN_APPROVAL/)
  assert.throws(() => buildSendAuthorizationRow({ envelope: w.env, grant: { ceiling: 150001 }, approval_id: apr(9), granted_by: OP, now: NOW }), /SEND_CEILING_ABOVE_ENVELOPE_MAX/)
  const row = buildSendAuthorizationRow({ envelope: w.env, grant: { expires_in_hours: 999 }, approval_id: apr(9), granted_by: OP, now: NOW })
  assert.ok(Date.parse(row.expires_at) <= NOW + 7 * 864e5 && Date.parse(row.expires_at) <= Date.parse(w.env.expires_at))
  assert.equal(row.ceiling, 150000, 'default ceiling = the envelope max, never above')
  assert.equal(row.contract_version, 'negotiation.send_authorization.v1')
  // operator-only, through the existing approvals plane, never in the model tool list
  assert.ok(!FIRST_CAPABILITIES.some((c) => c.id === SEND_AUTHORIZATION_CAPABILITY_ID))
  const ORG = '00000000-0000-4000-8000-00000000a001'
  const capStore = createMemoryCapabilityStore({ members: [{ org_id: ORG, user_id: OP, role: 'owner' }], now: () => NOW })
  const refs = createThreadRefCodec({ secret: 'test-secret-0123456789abcdef' })
  const sends = createMemorySendAuthorizationStore({ now: () => NOW })
  const services = { negotiation: { openThread: (ref, org) => refs.open(ref, org), latestEnvelope: (sk) => w.store.latestEnvelope(sk), grantSendAuthorization: (a) => grantSendAuthorization({ ...a, now: NOW }, { store: sends }) } }
  const plane = createSendAuthorizationApprovals({ store: capStore, services, now: () => NOW })
  const identity = { user_id: OP, verified: true, named: true }
  const input = { thread_ref: refs.seal(TK, ORG), property_ref: encodePropertyRef(PID), envelope_version: 1, ceiling: 140000, max_sends: 1, expires_in_hours: 24 }
  assert.equal((await plane.propose({ org_id: ORG, identity, input: { ...input, ceiling: 151000 } })).code, 'SEND_CEILING_ABOVE_ENVELOPE_MAX')
  assert.equal((await plane.propose({ org_id: ORG, identity, input: { ...input, envelope_version: 2 } })).code, 'ENVELOPE_VERSION_MISMATCH')
  const req = await plane.propose({ org_id: ORG, identity, input })
  assert.equal(req.ok, true)
  assert.equal((await sends.latestFor(scopeKey(TK, PID))).authorization, null, 'pending: nothing authorized yet')
  const card = (await plane.get({ org_id: ORG, identity, approval_id: req.approval_id })).approval
  assert.equal(card.capability_id, SEND_AUTHORIZATION_CAPABILITY_ID)
  assert.ok(!JSON.stringify(card).includes('5555550123') && !JSON.stringify(card).includes(PID))
  const done = await plane.decide({ org_id: ORG, identity, approval_id: req.approval_id, decision: 'approve', payload_hash: card.payload_hash })
  assert.equal(done.state, 'executed', JSON.stringify(done))
  const got = (await sends.latestFor(scopeKey(TK, PID))).authorization
  assert.deepEqual([got.ceiling, got.approval_id !== w.env.approval_id, got.envelope_id === w.env.envelope_id], [140000, true, true])
})

test('every violation is a hold for a human, never a rewrite: ceiling language, a forbidden claim, a non-approved (local) template, a template that states money', async () => {
  const w = await world()
  const ceilingTpl = TPL({ template_body: 'Our max is {{offer_price}} for the house as-is.' })
  const r1 = await compose(w, { templates: [ceilingTpl] })
  assert.equal(r1.action, 'ESCALATE_TO_OPERATOR')
  assert.match(r1.reason, /^seller_facing_guard:.*ceiling_language/)
  assert.equal(r1.rendered_text, null)
  const claimTpl = TPL({ template_body: 'We have cash on hand and can pay {{offer_price}} as-is.' })
  assert.match((await compose(w, { templates: [claimTpl] })).reason, /forbidden_claim:cash_on_hand_or_funds_available/)
  assert.match((await compose(w, { templates: [TPL({ id: 'local-template:offer_reveal_cash' })] })).reason, /^no_approved_template_for_move/)
  assert.match((await compose(w, { templates: [TPL({ template_body: 'We can do {{offer_price}} plus $5,000 earnest money.' })] })).reason, /^no_approved_template_for_move/)
  assert.match((await compose(w, { templates: [TPL({ is_active: false })] })).reason, /^no_approved_template_for_move/)
  assert.match((await compose(w, { templates: [TPL({ language: 'Spanish' })] })).reason, /^no_approved_template_for_move/)
  assert.equal(selectMoveTemplate([TPL({ use_case: 'narrow_range' })], { move_kind: 'counter' }).use_case, 'narrow_range')
  assert.deepEqual(Object.keys(MOVE_TEMPLATE_USE_CASES), ['open', 'counter', 'final', 'agree_at_seller_price'])
})

test('pipeline adapter: a valid NegotiationAuthority whose answers stay inside the 8.5.16 contract (no rendered text leaks through it)', async () => {
  const w = await world()
  const auth = assertNegotiationAuthority(createEnvelopeNegotiationAuthority({ resolveContext: async () => ({ context: { thread_key: TK, property_id: PID, economics: ECON, now: NOW } }), deps: { store: w.store }, sendAuthorizations: w.sends, templatesFor: async () => [TPL()], env: ON }))
  const r = await auth.prepareOffer({ thread_ref: 'thr_x' })
  assert.deepEqual(Object.keys(r).sort(), ['action', 'authority_ref', 'reason', 'template_use_case'])
  assert.equal(r.action, 'DETERMINISTIC_REPLY')
  const unresolved = createEnvelopeNegotiationAuthority({ resolveContext: async () => null, deps: { store: w.store }, sendAuthorizations: w.sends, env: ON })
  assert.equal((await unresolved.negotiateWithinAuthority({})).reason, 'negotiation_context_unresolved')
})

// ── negotiation pathway ─────────────────────────────────────────────────────
test('pathway (HOT/NEGOTIATE): MAO is the ceiling, the opening range is strictly below it, concessions never exceed it, next action is an operator act', () => {
  const valuation = score()
  const economics = classifyOpportunityEconomics({ ask: { amount: 145000 }, property: { property_type: 'Single Family Residential', units_count: 1 }, valuation, market: { investor_count: 6, priced_sales: 20 }, now: NOW })
  const plan = planOffer({ valuation, property: { property_type: 'Single Family Residential', units_count: 1 }, ask: { amount: 145000 }, now: NOW })
  const p = buildNegotiationPathway({ economics, offer_plan: plan, envelope_terms: { closing_window_days: [14, 30], closing_costs_paid_by: 'buyer' }, age: 81, marital_status: 'widowed' })
  assert.ok(['HOT', 'NEGOTIATE'].includes(p.class), p.class)
  assert.equal(p.mao.role, 'ceiling_not_opening')
  assert.ok(p.opening_range.recommended < p.mao.amount && p.opening_range.range.every((x) => x < p.mao.amount))
  assert.ok(p.concessions.filter((c) => c.kind === 'price').every((c) => c.ceiling_respected))
  assert.equal(p.concessions[0].kind, 'terms', 'terms before price')
  assert.match(p.next_action, /^operator_/)
  assert.equal(p.visibility, 'internal_only')
  assert.deepEqual(p.ignored.protected_attributes_stripped.sort(), ['age', 'marital_status'])
  for (const k of ['justification', 'flexibility', 'closing_requirements', 'buyer_liquidity', 'complexity', 'margin', 'friction']) assert.ok(k in p, k)
})

test('THE LOT EXAMPLE: $500K ask on a lot where finished homes sell ~$360K — zoning / density FIRST; single-family zoning ⇒ PASS (no flexibility) or a realistic-price NURTURE; unknown zoning ⇒ INVESTIGATE "verify zoning"', () => {
  const lot = (zoning, facts = {}) => {
    const property = { property_type: 'Vacant Land', land_use: 'Residential Vacant Land', is_vacant_land: true, zoning, lot_square_feet: 7000 }
    const economics = classifyOpportunityEconomics({ ask: { amount: 500000 }, property, valuation: null, market: { completed_home_median: 360000, completed_home_source: 'test' }, facts, now: NOW })
    return buildNegotiationPathway({ economics, offer_plan: planOffer({ valuation: null, property, ask: { amount: 500000 }, now: NOW }) })
  }
  const sf = lot('R-1')
  assert.equal(sf.class, 'PASS')
  assert.equal(sf.land_zoning_first.path, 'pass')
  assert.equal(sf.mao, null, 'no engine MAO for a raw lot: never a fabricated number')
  assert.equal(sf.opening_range, null)
  assert.equal(sf.next_action, 'no_offer_keep_record')
  const flex = lot('R-1', { motivation: { value: 'relocating' } })
  assert.equal(flex.class, 'NURTURE')
  assert.equal(flex.land_zoning_first.path, 'nurture_realistic_price')
  assert.deepEqual(flex.land_zoning_first.realistic_price_band, [72000, 126000], 'an internal lot-share band (20-35 % of the finished home), never seller-facing')
  const unknown = lot(null)
  assert.equal(unknown.class, 'INVESTIGATE')
  assert.equal(unknown.land_zoning_first.path, 'investigate_zoning_density_first')
  assert.equal(unknown.next_action, 'verify_zoning_and_entitled_density')
  const dense = lot('RM-2')
  assert.equal(dense.class, 'INVESTIGATE')
  assert.match(dense.next_action, /zoning|density|development/)
})
