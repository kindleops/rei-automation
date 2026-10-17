// rc-8.5.21 part A, Phases 3 + 4 — classification, ownership evidence, financing objections,
// evidence-backed escalations, confidence recalibration, identity + forbidden claims.
// Every example is an INDEPENDENT phrasing written for this suite (never copied from the 8.5.20
// evaluation set). Fictional 555 numbers only. No model, no network.
import test from 'node:test'
import assert from 'node:assert/strict'

import { decideAndCompose, canonicalRoutineScope, CANONICAL_VERSIONS } from '../../src/lib/domain/conversation-ai/runtime/canonical.js'
import { decideActions } from '../../src/lib/domain/conversation-ai/pipeline/decide.js'
import { ledgerFromContextInput } from '../../src/lib/domain/conversation-ai/fact-ledger.js'
import { resolveOwnershipEvidence, ownershipDenialTerminal } from '../../src/lib/domain/conversation-ai/ownership-evidence.js'
import { mapModelEscalation, multiPropertyEvidence } from '../../src/lib/domain/conversation-ai/escalation-evidence.js'
import { validateOutbound } from '../../src/lib/domain/conversation-ai/outbound-validator.js'
import { normalizeCompanyIdentity, NO_COMPANY_IDENTITY, COMPANY_IDENTITY_KEY, loadCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { deterministicPrecheck } from '../../src/lib/domain/conversation-ai/precheck.js'
import { routeConversationEvent, ROUTES } from '../../src/lib/domain/conversation-ai/turns/events.js'
import { normalizeSendPolicy } from '../../src/lib/domain/conversation-ai/send-policy.js'

const P = '+12125550134'
const NOW = '2026-10-14T17:00:00.000Z'
const at = (min) => new Date(Date.parse(NOW) - min * 60_000).toISOString()
const m = (id, d, body, ago, extra = {}) => ({ id, direction: d, body, at: at(ago), thread_key: P, seller_phone: P, property_id: 'p1', ...extra })
function input(thread, extra = {}) {
  const ib = thread.filter((x) => x.direction === 'inbound').pop()
  return { now: NOW, inbound: { id: ib.id, body: ib.body, at: ib.at, thread_key: P, from_phone: P, property_id: 'p1' }, thread, properties: [{ property_id: 'p1', state: 'NY' }], offers: [], followups: [], names: { full_names: [], first_name: 'Dana' }, language: 'en', ...extra }
}
const OPEN = { blocked: false, reasons: [], timing: { lawful: true, basis: 'local_hours' } }
const plan = (thread, { eligibility = OPEN, deterministic = null, judgment = null, companyIdentity = NO_COMPANY_IDENTITY } = {}) => {
  const inp = input(thread)
  const ledger = ledgerFromContextInput(inp, { now: NOW })
  return decideActions({ ledger, inboundText: inp.inbound.body, inboundId: inp.inbound.id, deterministic, eligibility, judgment, thread, inbound: inp.inbound, companyIdentity, language: 'en' })
}
const term = (p) => p.actions.find((a) => ['NO_RESPONSE', 'AI_GENERATED_REPLY', 'DETERMINISTIC_REPLY', 'ESCALATE_TO_OPERATOR', 'HOLD', 'SUPPRESS', 'PREPARE_OFFER', 'NEGOTIATE_WITHIN_AUTHORITY'].includes(a.type))
const OWN_Q = m('o1', 'outbound', 'Hi Dana, do you still own the house on Oak?', 60, { use_case: 'ownership_check' })
const SELL_Q = m('o2', 'outbound', 'Thanks for confirming. Would you be open to an offer on it?', 30, { use_case: 'consider_selling' })

// ── 3A mixed intent ─────────────────────────────────────────────────────────
test('3A: a "sold" claim taken back in the same message is not terminal; with our quoted amount and a number it is a negotiation for a person', () => {
  const quote = m('o1', 'outbound', 'Based on recent sales I could be at $120,000 cash. Would that work?', 60)
  const p = plan([quote, m('i1', 'inbound', 'Ha sold it already... just kidding. 140 and we can sign Friday', 2)])
  const t = term(p)
  assert.equal(t.type, 'ESCALATE_TO_OPERATOR')
  assert.equal(t.reason, 'missing_negotiation_authority')
  // the model's own (generic) escalation never renames a live negotiation
  const pm = plan([quote, m('i1', 'inbound', 'Ha sold it already... just kidding. 140 and we can sign Friday', 2)], { judgment: { intent: 'unclear', confidence: 0.5, outcome: 'NEEDS_REVIEW', escalation_required: true, escalation_reason: 'validation_failure' } })
  assert.equal(term(pm).reason, 'missing_negotiation_authority')
  assert.equal(t.evidence.kind, 'number_answering_our_quoted_amount')
  assert.ok(!p.actions.some((a) => a.type === 'UPDATE_SELLER_FACTS' && ['former_owner', 'denied'].includes(a.facts?.ownership)), JSON.stringify(p.actions))
  // the event router never closes it either
  const inp = input([quote, m('i1', 'inbound', 'Ha sold it already... just kidding. 140 and we can sign Friday', 2)])
  const ledger = ledgerFromContextInput(inp, { now: NOW })
  assert.notEqual(routeConversationEvent({ kind: 'inbound', text: inp.inbound.body, ledger }).route, ROUTES.CLOSE_NO_REPLY)
})

test('3A: a weak regex "sold" reading with a price in the same message, or against a live offer, is not terminal; a plain "sold it" still closes', () => {
  const quote = m('o1', 'outbound', 'I could be at $95,000 for it as-is. Interested?', 120)
  const p1 = plan([quote, m('i1', 'inbound', 'Already sold, but for 150 I would have', 2)])
  assert.notEqual(term(p1).type, 'NO_RESPONSE', JSON.stringify(term(p1)))
  const inp = input([quote, m('i1', 'inbound', 'Already sold, but for 150 I would have', 2)])
  const v = ownershipDenialTerminal({ ledger: ledgerFromContextInput(inp, { now: NOW }), inboundId: 'i1', inboundText: inp.inbound.body })
  assert.equal(v.terminal, false)
  assert.ok(v.reasons.includes('live_negotiation'), JSON.stringify(v.reasons))
  // no price, no offer, no contradiction: the owner rule (no reply, no nurture)
  const p2 = plan([OWN_Q, m('i1', 'inbound', 'Sold that place last spring', 2)])
  assert.equal(term(p2).type, 'NO_RESPONSE')
  assert.deepEqual(p2.reasons, ['ownership_denied_no_nurture'])
  // an explicit denial is the locked policy regardless of earlier talk
  const p3 = plan([OWN_Q, m('i0', 'inbound', 'yes', 50), m('o3', 'outbound', 'Would you consider selling?', 40), m('i1', 'inbound', 'Actually I do not own it, it is my cousins', 2)])
  assert.equal(term(p3).type, 'NO_RESPONSE')
})

// ── 3B ownership evidence precedence ────────────────────────────────────────
test('3B: a stored not-owner label vs a stated confirmation ⇒ HOLD for a person, never SUPPRESS; without confirmation ⇒ property-scoped denial', () => {
  const stale = { blocked: true, reasons: ['prior_reply_not_owner'], guard: { blocked: true, reason: 'prior_reply_not_owner', signal: 'tenant_respondent', source: 'thread_state' }, timing: { lawful: true } }
  const confirmed = [OWN_Q, m('i0', 'inbound', 'Yes I am the owner', 50), SELL_Q, m('i1', 'inbound', 'I have been in real estate a long time, send me something real', 2)]
  const p = plan(confirmed, { eligibility: stale })
  assert.deepEqual([term(p).type, term(p).reason], ['HOLD', 'ownership_evidence_conflict'])
  assert.ok(!p.actions.some((a) => a.type === 'SUPPRESS'))
  assert.equal(p.ownership.class, 'confirmed_owner')
  // the precheck no longer turns this label into a suppression either
  const pre = deterministicPrecheck({ text: 'hi', inboundId: 'i1', eligibility: stale })
  assert.equal(pre.decision.outcome, 'NEEDS_REVIEW')
  // no confirmation in the thread ⇒ the property-scoped denial (no reply, no nurture, no suppression)
  const p2 = plan([OWN_Q, m('i1', 'inbound', 'ok what is this about', 2)], { eligibility: stale })
  assert.deepEqual([term(p2).type, term(p2).reason], ['NO_RESPONSE', 'property_scoped_denial'])
  assert.ok(!p2.actions.some((a) => a.type === 'SCHEDULE_FOLLOWUP' || a.type === 'SUPPRESS'))
})

test('3B: STOP and valid suppression are absolute — no ownership confirmation overrides them; wrong number is no owner outreach', () => {
  const confirmed = [OWN_Q, m('i0', 'inbound', 'Yes thats mine', 50), SELL_Q]
  const supp = { blocked: true, reasons: ['sms_suppression_list_active'], guard: { blocked: true, reason: 'sms_suppression_list_active' } }
  const p = plan([...confirmed, m('i1', 'inbound', 'yes I would sell', 2)], { eligibility: supp })
  assert.deepEqual([term(p).type, term(p).cancel_pending, term(p).reason], ['SUPPRESS', false, 'existing_suppression:sms_suppression_list_active'])
  const stop = plan([...confirmed, m('i1', 'inbound', 'I own it but stop texting me', 2)])
  assert.deepEqual([term(stop).type, term(stop).cancel_pending], ['SUPPRESS', true])
  const wn = plan([...confirmed, m('i1', 'inbound', 'sure', 2)], { eligibility: { blocked: true, reasons: ['wrong_number'], guard: { blocked: true, reason: 'wrong_number' } } })
  assert.deepEqual([term(wn).type, term(wn).reason], ['NO_RESPONSE', 'wrong_number_no_owner_outreach'])
  // an unreadable guard is never "no block"
  const ro = plan([...confirmed, m('i1', 'inbound', 'sure', 2)], { eligibility: { blocked: true, reasons: ['send_time_guard_read_failed'], guard: { blocked: true, reason: 'send_time_guard_read_failed' } } })
  assert.equal(term(ro).type, 'HOLD')
})

test('3B: ownership classes from the thread: authorized representative, tenant (classifier), confirmed, uncertain', () => {
  const rep = input([OWN_Q, m('i1', 'inbound', "I'm her son, I handle it for my mom's house", 2)])
  assert.equal(resolveOwnershipEvidence({ ledger: ledgerFromContextInput(rep, { now: NOW }), inboundId: 'i1', inboundText: rep.inbound.body }).class, 'authorized_rep')
  const ten = input([OWN_Q, m('i1', 'inbound', 'I just rent here', 2)])
  const tv = resolveOwnershipEvidence({ ledger: ledgerFromContextInput(ten, { now: NOW }), inboundId: 'i1', inboundText: ten.inbound.body, deterministic: { intent: 'tenant_respondent' } })
  assert.deepEqual([tv.class, tv.action], ['tenant', 'property_denial_no_reply'])
  const unk = input([OWN_Q, m('i1', 'inbound', 'maybe', 2)])
  assert.equal(resolveOwnershipEvidence({ ledger: ledgerFromContextInput(unk, { now: NOW }), inboundId: 'i1', inboundText: 'maybe' }).class, 'uncertain')
})

// ── 3C creative financing ───────────────────────────────────────────────────
test('3C: a financing-terms objection is conditional interest; the objection is recorded and the next step is the purchase path (the asking price)', () => {
  for (const body of ['Only if there is no seller financing involved', 'As long as it is not owner financing, sure', "I won't do any rent to own stuff", 'Only if it is not one of those creative financing things']) {
    const p = plan([OWN_Q, m('i0', 'inbound', 'yes', 50), SELL_Q, m('i1', 'inbound', body, 2)], { judgment: { intent: 'not_interested', confidence: 0.92, outcome: 'NO_RESPONSE' } })
    const t = term(p)
    assert.deepEqual([t.type, t.category, t.objective], ['AI_GENERATED_REPLY', 'conditional_interest_clarify', 'asking_price'], `${body}: ${JSON.stringify(p)}`)
    assert.ok(!p.actions.some((a) => a.type === 'SCHEDULE_FOLLOWUP'), 'not a disinterest close')
    assert.equal(p.actions.find((a) => a.type === 'UPDATE_SELLER_FACTS').facts.objection, 'financing_terms')
  }
  // a seller PROPOSING a structure is an incompatible term for a person
  const prop = plan([OWN_Q, m('i0', 'inbound', 'yes', 50), SELL_Q, m('i1', 'inbound', 'Would you take over the payments on it?', 2)])
  assert.deepEqual([term(prop).type, term(prop).reason], ['ESCALATE_TO_OPERATOR', 'incompatible_term'])
  // the clarification may say "no creative financing" (a negation), never claim funds
  const L = ledgerFromContextInput(input([OWN_Q, m('i0', 'inbound', 'yes', 50), SELL_Q, m('i1', 'inbound', 'Only if there is no seller financing involved', 2)]), { now: NOW })
  assert.deepEqual(validateOutbound('Understood, no creative financing here, just a straightforward purchase. What price did you have in mind?', { ledger: L, objective: 'asking_price', category: 'conditional_interest_clarify' }).content_reasons, [])
  assert.ok(validateOutbound('No financing needed, we pay cash. What price did you have in mind?', { ledger: L, objective: 'asking_price', category: 'conditional_interest_clarify' }).content_reasons.includes('claim:funds_without_evidence'))
})

// ── 3D evidence-backed escalation reasons ───────────────────────────────────
test('3D: several property ids on a thread are not "multiple properties"; seller text or a property mismatch is, with evidence; an unsupported model reason is insufficient_context', () => {
  const twoIds = [m('o0', 'outbound', 'an older campaign text', 900, { property_id: 'p2' }), OWN_Q, m('i1', 'inbound', 'yes I do', 2)]
  assert.equal(multiPropertyEvidence({ inboundText: 'yes I do', thread: twoIds, inbound: { id: 'i1', property_id: 'p1' } }), null)
  assert.notEqual(term(plan(twoIds)).reason, 'multiple_properties')
  const text = plan([OWN_Q, m('i1', 'inbound', 'I own three houses on that street, which one?', 2)])
  assert.deepEqual([term(text).reason, term(text).evidence.kind], ['multiple_properties', 'seller_text'])
  const mism = multiPropertyEvidence({ inboundText: 'yes', thread: [m('o0', 'outbound', 'a', 90, { property_id: 'p2' }), m('o1', 'outbound', 'b', 60, { property_id: 'p3' })], inbound: { id: 'i1', property_id: 'p1' } })
  assert.equal(mism.kind, 'inbound_property_differs_from_last_outbound')
  // the model's own claim without evidence
  assert.deepEqual([mapModelEscalation({ escalation_reason: 'multiple_properties' }, { inboundText: 'yes', thread: twoIds, inbound: { id: 'i1' } }).reason], ['insufficient_context'])
  assert.equal(mapModelEscalation({ escalation_reason: 'multiple_owners' }, { inboundText: 'its listed with a realtor' }).reason, 'insufficient_context')
  assert.equal(mapModelEscalation({ escalation_reason: 'multiple_owners' }, { inboundText: 'my brother and I own it together, co-owner' }).reason, 'multiple_owners')
  // an offer request: the authority (stub) has no envelope ⇒ missing authority, never a model number
  const offer = plan([OWN_Q, m('i0', 'inbound', 'yes', 50), SELL_Q, m('i1', 'inbound', 'Make me an offer then', 2)])
  assert.equal(term(offer).type, 'PREPARE_OFFER')
})

test('3D: confidence recalibration — deterministic-backed replies are not held for the model\'s self-reported confidence; model-decided ones are; deterministic blocks unchanged', () => {
  const policy = normalizeSendPolicy({ enabled: true, scope: { thread_keys: [P] }, categories: ['identity_answer', 'not_interested_close', 'next_missing_fact', 'clarification'] })
  const rec = (category, conf, text = 'I am a local buyer reaching out about the house on Oak. Do you still own it?') => ({ versions: CANONICAL_VERSIONS, terminal: { type: 'AI_GENERATED_REPLY', category }, reply: { text, category, objective: 'ownership' }, judgment: { confidence: conf } })
  assert.equal(canonicalRoutineScope(rec('identity_answer', 0.6), { languageEnglish: true, policy, inboundText: 'why' }).in_scope, true)
  assert.equal(canonicalRoutineScope(rec('not_interested_close', 0.7, 'Understood, thanks for the quick reply.'), { languageEnglish: true, policy, inboundText: 'not for sale' }).in_scope, true)
  assert.deepEqual(canonicalRoutineScope(rec('clarification', 0.6), { languageEnglish: true, policy, inboundText: 'hmm' }).reasons, ['low_confidence_model_decided_reply'])
  // a deterministic exclusion still holds whatever the confidence
  assert.ok(canonicalRoutineScope(rec('identity_answer', 0.99), { languageEnglish: true, policy, inboundText: 'send me the contract' }).reasons.includes('excluded_legal_or_contract'))
  assert.ok(canonicalRoutineScope(rec('identity_answer', 0.99), { languageEnglish: false, languageReason: 'spanish_detected', policy, inboundText: 'hola' }).reasons.includes('excluded_language:spanish_detected'))
  // opt-in categories are never enabled by default
  assert.deepEqual(normalizeSendPolicy({ enabled: true }).categories, ['next_missing_fact', 'identity_answer', 'not_interested_close', 'no_response'])
})

// ── email / card requests and the 30-day follow-up ──────────────────────────
test('email / business-card request: a person handles it (never an AI promise); "I will reach out when I want to sell" keeps the 30-day follow-up', () => {
  const p = plan([OWN_Q, m('i1', 'inbound', 'Yes. Send me your business card and I will reach out to you when I want to sell.', 2)])
  assert.deepEqual([term(p).type, term(p).reason], ['ESCALATE_TO_OPERATOR', 'requested_email_or_card'])
  assert.ok(p.actions.some((a) => a.type === 'SCHEDULE_FOLLOWUP' && a.days === 30), JSON.stringify(p.actions))
  const p2 = plan([OWN_Q, m('i0', 'inbound', 'yes', 50), SELL_Q, m('i1', 'inbound', 'maybe, can you email me some info first', 2)])
  assert.deepEqual([term(p2).type, term(p2).reason], ['ESCALATE_TO_OPERATOR', 'requested_email_or_card'])
  for (const t of ['I will send my card over now.', "I'll email you our info today.", 'I just sent you an email with the details.', 'Check your inbox for my card.']) {
    assert.ok(validateOutbound(t, { ledger: null }).content_reasons.includes('claim:sent_or_will_send_email_or_card'), t)
  }
})

// ── Phase 4 identity + style ────────────────────────────────────────────────
test('identity: no configured company ⇒ never "not with a company", no company name, no website; a company question goes to a person', () => {
  for (const t of ["I'm not with a company, just a local buyer.", 'No company involved, it is just me.', "We're not part of any company."]) {
    assert.ok(validateOutbound(t, { ledger: null }).content_reasons.includes('identity:denies_company'), t)
  }
  assert.ok(validateOutbound("I'm with Northgate Homes, a local buyer.", { ledger: null }).content_reasons.includes('identity:company_not_configured'))
  assert.ok(validateOutbound('You can look us up at oakbuyers.com.', { ledger: null }).content_reasons.includes('identity:unverified_website'))
  for (const body of ['Which company r u with', 'Which outfit are you with?', 'who are you with']) {
    const q = plan([OWN_Q, m('i0', 'inbound', 'yes', 50), m('i1', 'inbound', body, 2)])
    assert.deepEqual([term(q).type, term(q).reason], ['ESCALATE_TO_OPERATOR', 'company_identity_not_configured'], body)
  }
})

test('identity: a configured company (system_control, PROPOSED key) is the ONLY company fact the AI may state; the website only when verified', async () => {
  assert.equal(COMPANY_IDENTITY_KEY, 'ai_conversation_company_identity')
  assert.deepEqual(await loadCompanyIdentity({ readSwitch: async () => null }), NO_COMPANY_IDENTITY)
  assert.deepEqual(await loadCompanyIdentity({ readSwitch: async () => { throw new Error('x') } }), NO_COMPANY_IDENTITY)
  assert.equal(normalizeCompanyIdentity('').configured, false)
  assert.equal(normalizeCompanyIdentity('{bad').configured, false)
  const unverified = normalizeCompanyIdentity({ name: 'Northgate Homes', website: 'https://northgatehomes.com' })
  assert.deepEqual([unverified.configured, unverified.website], [true, null])
  const id = normalizeCompanyIdentity(JSON.stringify({ name: 'Northgate Homes', website: 'https://northgatehomes.com', website_verified: true }))
  assert.equal(validateOutbound("I'm with Northgate Homes, a local buyer. Do you still own it?", { ledger: null, companyIdentity: id }).content_reasons.filter((r) => r.startsWith('identity:')).length, 0)
  assert.ok(validateOutbound("I'm with Southpoint Realty Group, a local buyer.", { ledger: null, companyIdentity: id }).content_reasons.includes('identity:company_name_mismatch'))
  assert.ok(!validateOutbound('Our site is https://northgatehomes.com if you want to look.', { ledger: null, companyIdentity: id }).content_reasons.some((r) => r === 'identity:unverified_website' || r === 'content:contains_link'))
  assert.ok(validateOutbound('Our site is https://othersite.com if you want to look.', { ledger: null, companyIdentity: id }).content_reasons.includes('identity:unverified_website'))
  const q = plan([OWN_Q, m('i0', 'inbound', 'yes', 50), m('i1', 'inbound', 'what company is this?', 2)], { companyIdentity: id })
  assert.deepEqual([term(q).type, term(q).category], ['AI_GENERATED_REPLY', 'identity_answer'])
})

test('forbidden claims: inspected, funds, sent email / card, never-contact-again; style: em dash, stock opener, two questions', () => {
  const r = (t) => validateOutbound(t, { ledger: null }).content_reasons
  assert.ok(r('I drove by the house this morning and it looks great.').includes('claim:inspected_property'))
  assert.ok(r('After seeing your home I think we can help.').includes('claim:inspected_property'))
  assert.ok(!r('I looked at the property records and wanted to check in.').includes('claim:inspected_property'))
  assert.ok(r('We have the funds ready to go.').includes('claim:funds_without_evidence'))
  assert.ok(r('We are cash buyers in the area.').includes('claim:funds_without_evidence'))
  assert.ok(r('Understood, we will not contact you again.').includes('claim:no_further_contact_while_nurture_scheduled'))
  assert.ok(r('Got it — thanks.').includes('style:em_dash'))
  assert.ok(r('Got it, thanks for letting me know. Would you sell?').includes('style:stock_opener'))
  assert.ok(r('Do you own it? Would you sell?').some((x) => /more_than_one_question/.test(x)))
})

// ── the canonical record carries every version, and R1 text never survives ──
test('canonical: the record carries the writer / runtime / playbook / validator versions; the R1 proposed_message is discarded (input stage only)', async () => {
  const thread = [OWN_Q, m('i1', 'inbound', 'yes I still own it', 2)]
  let composeCalls = 0
  const r1Text = 'R1 TEXT MUST NEVER BE USED. Would you sell?'
  const modelClient = { decide: async ({ inputSchema }) => {
    if (inputSchema?.properties?.message) { composeCalls += 1; return { input: { message: 'Good to know. Would you consider an offer on it?' }, model: 'claude-haiku-5-5', usd: 0.0001, usage: { input_tokens: 10, output_tokens: 5 } } }
    return { input: { contract_version: 'conv-ai.decision.v1', intent: 'ownership_confirmed', seller_interest: 'unknown', facts_extracted: [{ fact: 'ownership', value: 'confirmed', source_message_id: 'i1', confidence: 0.95 }], facts_already_known: [], stage_evidence: { stage: 'S2_interest', evidence_message_ids: ['i1'], rationale: 'x' }, next_objective: 'gauge_interest', response_needed: true, outcome: 'REPLY_CANDIDATE', proposed_message: r1Text, confidence: 0.95, escalation_required: false, escalation_reason: null, send_permission_requested: true, source_message_ids: ['i1'] }, model: 'claude-haiku-5-5', usd: 0.0002, usage: { input_tokens: 10, output_tokens: 5 } }
  } }
  const rec = await decideAndCompose({ input: input(thread), eligibility: OPEN, modelClient, spend: { perMessageMaxUsd: 0.02, dailyMaxUsd: 1, spentTodayUsd: () => 0, estimateUsd: () => 0.001 }, caller: 'evaluation', now: NOW })
  assert.equal(rec.versions, CANONICAL_VERSIONS)
  assert.equal(rec.versions.writer, 'conv-ai.pipeline.v2+playbook.v3+compose.v3')
  assert.equal(rec.caller, 'evaluation')
  assert.equal(rec.reply.text, 'Good to know. Would you consider an offer on it?')
  assert.equal(composeCalls, 1)
  assert.ok(!JSON.stringify(rec).includes('R1 TEXT'), 'the R1 proposed_message is never carried')
  await assert.rejects(() => decideAndCompose({ input: input(thread), caller: 'somewhere_else' }), (e) => e.code === 'CANONICAL_CALLER_REQUIRED')
})
