/**
 * CLOSING AUTHORITY — the canonical writers for a closing, contract → money.
 *
 * Every mutation here:
 *   - validates against the canonical records (never the UI's idea of state)
 *   - requires an actor and, where the fact is financial or legal, evidence
 *   - is idempotent (deterministic ids / unique keys; a replay is a no-op)
 *   - writes an audit event (closing_activity_events) with before → after
 *   - moves lifecycle stage forward only through transitionOpportunityStage,
 *     and never to CLOSED — S10 exists only via finalizeClosing()
 *
 * Nothing here sends email. Communication is requested through
 * closing_email_requests (see closing-email-requests.js) and delivered by
 * the email system.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { transitionOpportunityStage } from '@/lib/domain/opportunity/opportunity-service.js'
import { emitNotificationFromBusinessEvent } from '@/lib/domain/notifications/notification-emitter.js'
import { emitSellerLifecycle } from '@/lib/domain/seller-portal/seller-portal-lifecycle.js'
import { buildBuyerOfferId } from '@/lib/domain/disposition/buyer-commitment-authority.js'
import { evaluateClosingGuard } from './closing-guard.js'
import { cancelOpenEmailRequests } from './closing-email-requests.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null }
const iso = (v) => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const STAGE_ORDER = ['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close', 'closed']
const stageRank = (s) => STAGE_ORDER.indexOf(lower(s))

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })
const ctx = (deps) => ({ db: deps.supabase || defaultSupabase, now: () => (deps.now ? new Date(deps.now()) : new Date()), notify: deps.notify || emitNotificationFromBusinessEvent, transition: deps.transitionOpportunityStage || transitionOpportunityStage, sellerLifecycle: deps.sellerLifecycle || emitSellerLifecycle })
const isDuplicate = (error) => error && (error.code === '23505' || /duplicate key/i.test(String(error.message || '')))

function requireActor(actor) {
  return clean(actor) ? null : fail('ACTOR_REQUIRED', 'Every closing write needs an actor (operator id or automation name)')
}

export async function loadClosingCase(db, id) {
  const key = clean(id)
  if (!key) return null
  let q = db.from('closing_cases').select('*')
  q = UUID_RE.test(key) ? q.eq('opportunity_id', key) : q.eq('closing_case_id', key)
  const { data, error } = await q.limit(1)
  if (error) throw error
  return (data || [])[0] || null
}

async function loadBundle(db, c) {
  const opp = c.opportunity_id
  const pick = async (table, col, val) => {
    if (!val) return []
    const { data, error } = await db.from(table).select('*').eq(col, val).limit(500)
    if (error) throw error
    return data || []
  }
  const [offers, agreements, emdReceipts, settlements, titleIssues] = await Promise.all([
    pick('buyer_offers', 'opportunity_id', opp),
    pick('buyer_agreements', 'opportunity_id', opp),
    pick('emd_receipts', 'closing_case_id', c.closing_case_id),
    pick('settlement_records', 'closing_case_id', c.closing_case_id),
    pick('closing_title_issues', 'closing_case_id', c.closing_case_id),
  ])
  return { closingCase: c, offers, agreements, emdReceipts, settlements, titleIssues }
}

const isTerminal = (c) => Boolean(c.terminal_outcome) || Boolean(c.provenance?.voided) || ['cancelled', 'declined'].includes(lower(c.contract_status))

/** Audit trail. The unique key makes a replayed write a no-op, not a second row. */
export async function audit(db, c, { type, actor, source, detail = {}, key }) {
  const row = { closing_case_id: c.closing_case_id, event_type: type, actor: clean(actor), source: clean(source) || 'closing_authority', detail, idempotency_key: key }
  const { error } = await db.from('closing_activity_events').insert(row)
  if (error && !isDuplicate(error)) throw error
  return { duplicate: isDuplicate(error) }
}

async function milestone(db, c, { type, actor, occurredAt, prior, resulting, snapshot = {}, key }) {
  const { error } = await db.from('closing_milestones').insert({
    closing_case_id: c.closing_case_id, milestone_type: type, source_system: 'closing_authority', source_entity_id: c.closing_case_id,
    occurred_at: occurredAt, actor, prior_state: prior ?? null, resulting_state: resulting ?? null, snapshot, idempotency_key: key,
  })
  if (error && !isDuplicate(error)) throw error
}

async function updateCase(db, c, patch) {
  const { data, error } = await db.from('closing_cases').update({ ...patch, last_activity_at: new Date().toISOString() }).eq('closing_case_id', c.closing_case_id).select('*').limit(1)
  if (error) throw error
  return (data || [])[0] || { ...c, ...patch }
}

/**
 * Forward-only lifecycle sync: the closing case and the Pipeline opportunity
 * move together, through the Pipeline's own transition (history + events).
 * Never to 'closed' — that is finalize_closing_case's alone.
 */
export async function advanceLifecycle(env, c, toStage, { reason, actor }) {
  if (toStage === 'closed') throw new Error('advanceLifecycle cannot close — use finalizeClosing')
  let next = c
  if (stageRank(toStage) > stageRank(c.universal_stage)) next = await updateCase(env.db, c, { universal_stage: toStage })
  if (c.opportunity_id) {
    const { data } = await env.db.from('acquisition_opportunities').select('acquisition_stage').eq('id', c.opportunity_id).limit(1)
    const current = data?.[0]?.acquisition_stage
    if (current && stageRank(toStage) > stageRank(current)) {
      await env.transition(c.opportunity_id, { to_stage: toStage, reason: `closing_authority:${reason}`, source: 'closing_authority', actor }).catch(() => null)
    }
  }
  return next
}

/* ═════ EMD ═════ */

/** Buyer EMD received (unverified). emd_receipts is buyer-side by schema. */
export async function recordEmdReceipt(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (isTerminal(c)) return fail('CLOSING_TERMINATED', 'Closing is terminal')
  const amount = pos(input.amount); if (!amount) return fail('AMOUNT_REQUIRED', 'EMD amount must be positive')
  const receivedAt = iso(input.receivedAt); if (!receivedAt) return fail('RECEIVED_AT_REQUIRED', 'When was it received?')
  if (!clean(input.escrowDestination)) return fail('ESCROW_REQUIRED', 'Where is the deposit held?')
  const { offers } = await loadBundle(env.db, c)
  const offer = offers.find((o) => o.buyer_offer_id === clean(input.buyerOfferId)) || offers.find((o) => ['committed', 'selected'].includes(lower(o.status)))
  if (!offer) return fail('NO_BUYER_OFFER', 'EMD belongs to a selected or committed buyer offer')
  const key = clean(input.idempotencyKey) || clean(input.externalReference) || `${receivedAt}:${amount}`
  const receiptId = `emd:${c.closing_case_id}:${key}`
  const row = {
    receipt_id: receiptId, opportunity_id: c.opportunity_id, closing_case_id: c.closing_case_id, property_id: c.property_id || offer.property_id,
    buyer_id: offer.buyer_id, buyer_offer_id: offer.buyer_offer_id, amount, currency: 'USD', escrow_destination: clean(input.escrowDestination),
    escrow_reference: clean(input.escrowReference) || null, status: 'received_unverified', received_at: receivedAt,
    evidence_reference: clean(input.evidenceReference) || null, evidence_note: clean(input.note) || null,
    external_reference: clean(input.externalReference) || null, source: clean(input.source) || 'manual_operator',
    metadata: { recorded_by: clean(input.actor) },
  }
  const { error } = await env.db.from('emd_receipts').insert(row)
  if (error && !isDuplicate(error)) throw error
  if (!error) {
    await audit(env.db, c, { type: 'emd_received', actor: input.actor, source: row.source, detail: { receipt_id: receiptId, amount, received_at: receivedAt, buyer_offer_id: offer.buyer_offer_id, evidence: row.evidence_reference }, key: `emd_received:${receiptId}` })
  }
  return { ok: true, duplicate: Boolean(error), receiptId }
}

const EMD_METHODS = new Set(['manual_operator', 'title_provider', 'bank_feed', 'document_upload'])

/** Verification needs provenance — the DB CHECK refuses it otherwise; so do we, with a reason. */
export async function verifyEmdReceipt(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  if (!EMD_METHODS.has(lower(input.method))) return fail('VERIFICATION_METHOD_REQUIRED', 'Verification method must be one of manual_operator, title_provider, bank_feed, document_upload')
  if (!clean(input.evidenceReference)) return fail('EVIDENCE_REQUIRED', 'Verification needs evidence (receipt, title confirmation, bank record)')
  const { data, error } = await env.db.from('emd_receipts').select('*').eq('receipt_id', clean(input.receiptId)).limit(1)
  if (error) throw error
  const r = data?.[0]; if (!r) return fail('RECEIPT_NOT_FOUND', 'No such EMD receipt')
  if (lower(r.status) === 'verified') return { ok: true, duplicate: true, receiptId: r.receipt_id }
  if (lower(r.status) !== 'received_unverified') return fail('RECEIPT_NOT_VERIFIABLE', `Receipt is ${r.status}`)
  const c = await loadClosingCase(env.db, r.closing_case_id)
  const at = env.now().toISOString()
  const { error: uerr } = await env.db.from('emd_receipts').update({ status: 'verified', verified_at: at, verified_by: clean(input.actor), verification_method: lower(input.method), evidence_reference: clean(input.evidenceReference), updated_at: at }).eq('receipt_id', r.receipt_id).eq('status', 'received_unverified')
  if (uerr) throw uerr
  if (c) await audit(env.db, c, { type: 'emd_verified', actor: input.actor, source: lower(input.method), detail: { receipt_id: r.receipt_id, before: r.status, after: 'verified', evidence: clean(input.evidenceReference) }, key: `emd_verified:${r.receipt_id}` })
  return { ok: true, receiptId: r.receipt_id }
}

/** EMD waived for this buyer: explicit, with a reason and evidence, never implied. */
export async function waiveBuyerEmd(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  if (!clean(input.reason) || !clean(input.evidenceReference)) return fail('WAIVER_NEEDS_REASON_AND_EVIDENCE', 'Waiving EMD needs a reason and evidence')
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  const { offers } = await loadBundle(env.db, c)
  const offer = offers.find((o) => o.buyer_offer_id === clean(input.buyerOfferId)) || offers.find((o) => ['committed', 'selected'].includes(lower(o.status)))
  if (!offer) return fail('NO_BUYER_OFFER', 'No selected or committed buyer offer')
  if (lower(offer.emd_status) === 'not_required') return { ok: true, duplicate: true }
  const waiver = { reason: clean(input.reason), evidence: clean(input.evidenceReference), actor: clean(input.actor), at: env.now().toISOString(), prior_status: offer.emd_status }
  const { error } = await env.db.from('buyer_offers').update({ emd_status: 'not_required', metadata: { ...(offer.metadata || {}), emd_waiver: waiver }, updated_at: waiver.at }).eq('buyer_offer_id', offer.buyer_offer_id)
  if (error) throw error
  await audit(env.db, c, { type: 'emd_waived', actor: input.actor, source: 'operator', detail: { buyer_offer_id: offer.buyer_offer_id, before: offer.emd_status, after: 'not_required', ...waiver }, key: `emd_waived:${offer.buyer_offer_id}` })
  return { ok: true }
}

/** Seller-contract earnest money we deposit — no canonical table exists, so it is an audited deposit event. */
export async function recordContractEmdDeposit(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  const amount = pos(input.amount); const at = iso(input.depositedAt)
  if (!amount || !at || !clean(input.evidenceReference)) return fail('DEPOSIT_NEEDS_AMOUNT_DATE_EVIDENCE', 'Amount, date and evidence are required')
  const r = await audit(env.db, c, { type: 'contract_emd_deposited', actor: input.actor, source: clean(input.source) || 'operator', detail: { amount, deposited_at: at, evidence: clean(input.evidenceReference), escrow: clean(input.escrowDestination) || null }, key: `contract_emd_deposited:${c.closing_case_id}` })
  return { ok: true, duplicate: r.duplicate }
}

/* ═════ BUYER ═════ */

/** Record a real buyer offer (the Buyer Match workspace has no writer). */
export async function recordBuyerOffer(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (!c.opportunity_id) return fail('NO_OPPORTUNITY', 'Closing has no opportunity')
  const buyerId = clean(input.buyerId); const price = pos(input.offerPrice)
  if (!buyerId || !price) return fail('BUYER_AND_PRICE_REQUIRED', 'Buyer and a positive price are required')
  const version = Math.max(1, Math.trunc(num(input.offerVersion) || 1))
  const buyerOfferId = buildBuyerOfferId({ opportunity_id: c.opportunity_id, buyer_id: buyerId, offer_version: version })
  const emdAmount = pos(input.emdAmount)
  const strategy = ['assignment', 'double_close', 'novation', 'other'].includes(lower(input.strategy)) ? lower(input.strategy) : 'assignment'
  const terms = { offer_price: price, assignment_price: pos(input.assignmentPrice), emd_amount: emdAmount, emd_due_date: clean(input.emdDueDate) || null, closing_date: clean(input.closingDate) || null, strategy }
  const row = {
    buyer_offer_id: buyerOfferId, offer_version: version, opportunity_id: c.opportunity_id, property_id: c.property_id, buyer_id: buyerId,
    offer_price: price, assignment_price: terms.assignment_price, strategy, emd_amount: emdAmount, emd_status: emdAmount ? 'required' : 'not_required',
    emd_due_date: terms.emd_due_date, closing_date: terms.closing_date, material_terms: terms, terms_hash: `${buyerOfferId}:${JSON.stringify(terms)}`,
    status: 'submitted', submitted_at: env.now().toISOString(), source: clean(input.source) || 'operator',
    metadata: { buyer_name: clean(input.buyerName) || null, recorded_by: clean(input.actor) },
  }
  const { error } = await env.db.from('buyer_offers').insert(row)
  if (error && !isDuplicate(error)) throw error
  if (!error) await audit(env.db, c, { type: 'buyer_offer_recorded', actor: input.actor, source: row.source, detail: { buyer_offer_id: buyerOfferId, ...terms }, key: `buyer_offer_recorded:${buyerOfferId}` })
  return { ok: true, duplicate: Boolean(error), buyerOfferId }
}

/** SELECTED ≠ COMMITTED. Selection supersedes any previously selected offer. */
export async function selectBuyerOffer(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (isTerminal(c)) return fail('CLOSING_TERMINATED', 'Closing is terminal')
  const { offers } = await loadBundle(env.db, c)
  const offer = offers.find((o) => o.buyer_offer_id === clean(input.buyerOfferId))
  if (!offer) return fail('BUYER_OFFER_NOT_FOUND', 'No such buyer offer')
  if (['selected', 'committed'].includes(lower(offer.status))) return { ok: true, duplicate: true }
  if (!['submitted', 'draft'].includes(lower(offer.status))) return fail('OFFER_NOT_SELECTABLE', `Offer is ${offer.status}`)
  if (offers.some((o) => lower(o.status) === 'committed')) return fail('BUYER_ALREADY_COMMITTED', 'A committed buyer exists; resolve that commitment first')
  const at = env.now().toISOString()
  for (const prev of offers.filter((o) => lower(o.status) === 'selected')) {
    const { error } = await env.db.from('buyer_offers').update({ status: 'superseded', superseded_at: at, superseded_by_offer_id: offer.buyer_offer_id, updated_at: at }).eq('buyer_offer_id', prev.buyer_offer_id)
    if (error) throw error
  }
  const { error } = await env.db.from('buyer_offers').update({ status: 'selected', selected_at: at, selected_by: clean(input.actor), selection_reason: clean(input.reason) || null, commitment_status: 'agreement_required', updated_at: at }).eq('buyer_offer_id', offer.buyer_offer_id)
  if (error) throw error
  await updateCase(env.db, c, { buyer_id: offer.buyer_id, buyer_price: pos(offer.assignment_price) ?? pos(offer.offer_price), buyer_emd: pos(offer.emd_amount), disposition_status: 'buyer_selected' })
  await audit(env.db, c, { type: 'buyer_selected', actor: input.actor, source: 'operator', detail: { buyer_offer_id: offer.buyer_offer_id, before: offer.status, after: 'selected', reason: clean(input.reason) || null }, key: `buyer_selected:${offer.buyer_offer_id}` })
  return { ok: true, buyerOfferId: offer.buyer_offer_id }
}

const AGREEMENT_RANK = { draft: 0, ready: 1, sent: 2, viewed: 3, buyer_signed: 4, counterparty_signed: 4, fully_executed: 5 }
const AGREEMENT_TERMINAL = new Set(['declined', 'voided', 'expired', 'superseded'])

/** Buyer agreement status — monotonic, provider-referenced; executed only from an execution event. */
export async function recordBuyerAgreementStatus(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const status = lower(input.status)
  if (!(status in AGREEMENT_RANK) && !AGREEMENT_TERMINAL.has(status)) return fail('BAD_STATUS', 'Unknown agreement status')
  if (status === 'fully_executed' && !clean(input.providerEnvelopeId) && !clean(input.evidenceReference)) return fail('EXECUTION_EVIDENCE_REQUIRED', 'Executed needs the signing envelope or signed-document reference')
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  const { offers, agreements } = await loadBundle(env.db, c)
  const offer = offers.find((o) => o.buyer_offer_id === clean(input.buyerOfferId)) || offers.find((o) => ['selected', 'committed'].includes(lower(o.status)))
  if (!offer) return fail('NO_BUYER_OFFER', 'Agreement belongs to a selected buyer offer')
  const type = ['assignment_agreement', 'purchase_agreement', 'novation_agreement'].includes(lower(input.agreementType)) ? lower(input.agreementType) : (offer.strategy === 'novation' ? 'novation_agreement' : offer.strategy === 'double_close' ? 'purchase_agreement' : 'assignment_agreement')
  const existing = agreements.find((a) => a.buyer_offer_id === offer.buyer_offer_id && !AGREEMENT_TERMINAL.has(lower(a.status)))
  const at = iso(input.at) || env.now().toISOString()
  const stamp = { sent: 'sent_at', fully_executed: 'executed_at', declined: 'declined_at', voided: 'voided_at', expired: 'expired_at', superseded: 'superseded_at', ready: 'ready_at' }[status]
  let agreementId
  if (!existing) {
    agreementId = `agreement:${offer.buyer_offer_id}:v1`
    const row = {
      agreement_id: agreementId, agreement_version: 1, agreement_type: type, opportunity_id: c.opportunity_id, property_id: c.property_id || offer.property_id,
      buyer_id: offer.buyer_id, buyer_offer_id: offer.buyer_offer_id, buyer_offer_version: offer.offer_version || 1, buyer_terms_hash: offer.terms_hash,
      buyer_price: pos(offer.assignment_price) ?? pos(offer.offer_price), strategy: offer.strategy, emd_terms: pos(offer.emd_amount),
      provider: clean(input.provider) || 'docusign', provider_envelope_id: clean(input.providerEnvelopeId) || null, status,
      document_payload: clean(input.evidenceReference) ? { document_reference: clean(input.evidenceReference) } : {},
      metadata: { recorded_by: clean(input.actor) },
      ...(stamp ? { [stamp]: at } : {}),
    }
    const { error } = await env.db.from('buyer_agreements').insert(row)
    if (error && !isDuplicate(error)) throw error
  } else {
    agreementId = existing.agreement_id
    const before = lower(existing.status)
    if (before === status) return { ok: true, duplicate: true, agreementId }
    if (!AGREEMENT_TERMINAL.has(status) && (AGREEMENT_RANK[status] ?? -1) < (AGREEMENT_RANK[before] ?? -1)) return fail('AGREEMENT_REGRESSION', `Agreement is already ${before}`)
    const patch = { status, updated_at: at, ...(stamp ? { [stamp]: at } : {}) }
    if (clean(input.providerEnvelopeId)) patch.provider_envelope_id = clean(input.providerEnvelopeId)
    if (clean(input.evidenceReference)) patch.document_payload = { ...(existing.document_payload || {}), document_reference: clean(input.evidenceReference) }
    const { error } = await env.db.from('buyer_agreements').update(patch).eq('agreement_id', agreementId)
    if (error) throw error
  }
  if (status === 'sent' && lower(offer.commitment_status) === 'agreement_required') {
    await env.db.from('buyer_offers').update({ commitment_status: 'agreement_sent', updated_at: at }).eq('buyer_offer_id', offer.buyer_offer_id)
  }
  await audit(env.db, c, { type: 'buyer_agreement_status', actor: input.actor, source: clean(input.provider) || 'operator', detail: { agreement_id: agreementId, before: existing?.status ?? null, after: status, envelope: clean(input.providerEnvelopeId) || null, evidence: clean(input.evidenceReference) || null }, key: `buyer_agreement:${agreementId}:${status}` })
  // Executed agreement IS the commitment event.
  if (status === 'fully_executed') {
    const committed = await commitBuyer({ closingCaseId: c.closing_case_id, buyerOfferId: offer.buyer_offer_id, commitmentType: type, agreementId, executedAt: at, evidenceReference: clean(input.providerEnvelopeId) || clean(input.evidenceReference), actor: input.actor }, deps)
    return { ok: true, agreementId, commitment: committed }
  }
  return { ok: true, agreementId }
}

/**
 * COMMITTED — only from an explicit event: an executed agreement, or an
 * operator confirmation carrying evidence. Never inferred from selection.
 * This is the canonical S8 (Under Contract With Buyer) entry.
 */
export async function commitBuyer(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (isTerminal(c)) return fail('CLOSING_TERMINATED', 'Closing is terminal')
  if (lower(c.contract_status) !== 'fully_executed') return fail('SELLER_CONTRACT_NOT_EXECUTED', 'S8 requires the seller contract to be fully executed')
  const { offers, agreements } = await loadBundle(env.db, c)
  const offer = offers.find((o) => o.buyer_offer_id === clean(input.buyerOfferId))
  if (!offer) return fail('BUYER_OFFER_NOT_FOUND', 'No such buyer offer')
  if (lower(offer.status) === 'committed') return { ok: true, duplicate: true }
  if (lower(offer.status) !== 'selected') return fail('BUYER_NOT_SELECTED', 'Only a selected buyer can commit')
  const executed = agreements.find((a) => a.buyer_offer_id === offer.buyer_offer_id && lower(a.status) === 'fully_executed')
  const type = lower(input.commitmentType) || (executed ? executed.agreement_type : 'other')
  if (!executed && !(type === 'other' && clean(input.evidenceReference))) return fail('COMMITMENT_EVIDENCE_REQUIRED', 'Commitment needs an executed agreement, or operator confirmation with evidence')
  const at = iso(input.executedAt) || env.now().toISOString()
  const eventId = `commitment:${offer.buyer_offer_id}`
  const { error } = await env.db.from('buyer_offers').update({
    status: 'committed', commitment_status: 'committed', committed_at: at, commitment_event_id: eventId, commitment_type: type,
    commitment_evidence: { agreement_id: executed?.agreement_id || clean(input.agreementId) || null, evidence: clean(input.evidenceReference) || null, actor: clean(input.actor) },
    updated_at: at,
  }).eq('buyer_offer_id', offer.buyer_offer_id).eq('status', 'selected')
  if (error && !isDuplicate(error)) throw error
  if (executed) await env.db.from('buyer_agreements').update({ commitment_event_id: eventId }).eq('agreement_id', executed.agreement_id).is('commitment_event_id', null)
  let next = await updateCase(env.db, c, { buyer_id: offer.buyer_id, buyer_price: pos(offer.assignment_price) ?? pos(offer.offer_price), buyer_emd: pos(offer.emd_amount), disposition_status: 'buyer_committed' })
  next = await advanceLifecycle(env, next, 'under_contract', { reason: 'buyer_committed', actor: input.actor })
  await milestone(env.db, next, { type: 'buyer_committed', actor: clean(input.actor), occurredAt: at, prior: offer.status, resulting: 'committed', snapshot: { buyer_offer_id: offer.buyer_offer_id, type }, key: `closing:${c.closing_case_id}:buyer_committed:${offer.buyer_offer_id}` })
  await audit(env.db, next, { type: 'buyer_committed', actor: input.actor, source: executed ? 'agreement_execution' : 'operator_confirmation', detail: { buyer_offer_id: offer.buyer_offer_id, before: 'selected', after: 'committed', type, evidence: clean(input.evidenceReference) || executed?.agreement_id || null }, key: `buyer_committed:${offer.buyer_offer_id}` })
  await env.notify({ eventType: 'closing_buyer_commitment', sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, participantId: c.thread_key, titleVars: { case_name: c.property_address }, deduplicationKey: `closing_buyer_commitment:${c.closing_case_id}` })
  return { ok: true, stage: 'under_contract' }
}

/* ═════ TITLE ═════ */

export async function acknowledgeTitleOrder(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (c.title_acknowledged_at) return { ok: true, duplicate: true }
  const at = iso(input.at) || env.now().toISOString()
  const next = await updateCase(env.db, c, { title_acknowledged_at: at, title_acknowledged_source: clean(input.source) || 'operator', title_status: lower(c.title_status) === 'opened' ? c.title_status : 'opened', title_opened_date: c.title_opened_date || at })
  await audit(env.db, next, { type: 'title_acknowledged', actor: input.actor, source: clean(input.source) || 'operator', detail: { before: c.title_status, after: next.title_status, evidence: clean(input.evidenceReference) || null }, key: `title_acknowledged:${c.closing_case_id}` })
  return { ok: true }
}

export async function recordTitleCommitment(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  if (!clean(input.evidenceReference)) return fail('EVIDENCE_REQUIRED', 'Reference the commitment document')
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (c.title_commitment_received_at) return { ok: true, duplicate: true }
  const at = iso(input.receivedAt) || env.now().toISOString()
  const next = await updateCase(env.db, c, { title_commitment_received_at: at, title_commitment_evidence: clean(input.evidenceReference), title_acknowledged_at: c.title_acknowledged_at || at, title_acknowledged_source: c.title_acknowledged_source || 'title_commitment' })
  await audit(env.db, next, { type: 'title_commitment_received', actor: input.actor, source: clean(input.source) || 'operator', detail: { received_at: at, evidence: clean(input.evidenceReference), due_was: c.title_commitment_date || null }, key: `title_commitment_received:${c.closing_case_id}` })
  return { ok: true }
}

/** Expected title-commitment date (a promise from title, not the commitment itself). Feeds the follow-up cadence + Calendar. */
export async function setTitleCommitmentDue(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  if (!clean(input.source)) return fail('SOURCE_REQUIRED', 'Who gave this date (title email / operator)?')
  const due = iso(input.dueDate); if (!due) return fail('DATE_REQUIRED', 'A commitment date is required')
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (isTerminal(c) || c.closed_at) return fail('CLOSING_NOT_OPEN', 'Closing is not open')
  if (c.title_commitment_received_at) return fail('COMMITMENT_ALREADY_RECEIVED', 'The commitment is already in')
  if (iso(c.title_commitment_date) === due) return { ok: true, duplicate: true }
  const next = await updateCase(env.db, c, { title_commitment_date: due })
  await audit(env.db, next, { type: 'title_commitment_date_set', actor: input.actor, source: clean(input.source), detail: { before: c.title_commitment_date || null, after: due, evidence: clean(input.evidenceReference) || null }, key: `title_commitment_date:${c.closing_case_id}:${due}` })
  return { ok: true }
}

const ISSUE_TYPES = new Set(['open_lien', 'probate', 'name_discrepancy', 'hoa_balance', 'missing_release', 'tax', 'judgment', 'easement', 'survey', 'other'])

/** A real transaction title issue (reported by title / found in the commitment) — not property intelligence. */
export async function openTitleIssue(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  if (!ISSUE_TYPES.has(lower(input.issueType))) return fail('BAD_ISSUE_TYPE', 'Unknown title issue type')
  if (!clean(input.source)) return fail('SOURCE_REQUIRED', 'Where did this issue come from?')
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  const issueId = `title_issue:${c.closing_case_id}:${clean(input.idempotencyKey) || `${lower(input.issueType)}:${clean(input.description).slice(0, 40)}`}`
  const row = { issue_id: issueId, closing_case_id: c.closing_case_id, issue_type: lower(input.issueType), status: 'open', description: clean(input.description) || null, owner: lower(input.owner) || 'title', source: clean(input.source), evidence_reference: clean(input.evidenceReference) || null, notes: clean(input.notes) || null, opened_by: clean(input.actor) }
  const { error } = await env.db.from('closing_title_issues').insert(row)
  if (error && !isDuplicate(error)) throw error
  if (!error) {
    await audit(env.db, c, { type: 'title_issue_opened', actor: input.actor, source: row.source, detail: { issue_id: issueId, type: row.issue_type, description: row.description }, key: `title_issue_opened:${issueId}` })
    await env.notify({ eventType: 'closing_title_issue', sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, titleVars: { case_name: c.property_address }, description: `${row.issue_type.replace(/_/g, ' ')}${row.description ? ` — ${row.description}` : ''}`, deduplicationKey: `closing_title_issue:${issueId}` })    // The seller hears about an item only when it is theirs to provide.
    if (row.owner === 'seller' && c.opportunity_id) await env.sellerLifecycle({ kind: 'action_needed', opportunityId: c.opportunity_id, dedupeKey: `action_needed:${issueId}` })
  }
  return { ok: true, duplicate: Boolean(error), issueId }
}

/** Resolve / waive needs evidence; blockers are never silently cleared. */
export async function updateTitleIssue(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const status = lower(input.status)
  if (!['in_progress', 'resolved', 'waived'].includes(status)) return fail('BAD_STATUS', 'Status must be in_progress, resolved or waived')
  if (status !== 'in_progress' && !clean(input.resolutionEvidence)) return fail('RESOLUTION_EVIDENCE_REQUIRED', 'Resolving or waiving needs evidence')
  const { data, error } = await env.db.from('closing_title_issues').select('*').eq('issue_id', clean(input.issueId)).limit(1)
  if (error) throw error
  const issue = data?.[0]; if (!issue) return fail('ISSUE_NOT_FOUND', 'No such issue')
  if (lower(issue.status) === status) return { ok: true, duplicate: true }
  if (['resolved', 'waived'].includes(lower(issue.status))) return fail('ISSUE_CLOSED', `Issue is already ${issue.status}`)
  const at = env.now().toISOString()
  const patch = { status, updated_at: at, notes: clean(input.notes) || issue.notes, ...(status === 'in_progress' ? {} : { resolved_at: at, resolved_by: clean(input.actor), resolution_evidence: clean(input.resolutionEvidence) }) }
  const { error: uerr } = await env.db.from('closing_title_issues').update(patch).eq('issue_id', issue.issue_id)
  if (uerr) throw uerr
  const c = await loadClosingCase(env.db, issue.closing_case_id)
  if (c) await audit(env.db, c, { type: 'title_issue_updated', actor: input.actor, source: 'operator', detail: { issue_id: issue.issue_id, before: issue.status, after: status, evidence: clean(input.resolutionEvidence) || null }, key: `title_issue:${issue.issue_id}:${status}` })
  return { ok: true }
}

const CTC_SOURCES = new Set(['title_email', 'title_integration', 'title_provider', 'operator_confirmation'])

/**
 * CLEAR TO CLOSE — explicit, from a trusted source, with evidence. Never
 * inferred from the absence of problems. Refused while title issues are open.
 */
export async function recordClearToClose(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  if (!CTC_SOURCES.has(lower(input.source))) return fail('CTC_SOURCE_REQUIRED', 'Clear to close must come from title (email / integration / provider) or an operator confirmation')
  if (!clean(input.evidenceReference)) return fail('EVIDENCE_REQUIRED', 'Reference the clear-to-close confirmation')
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (isTerminal(c)) return fail('CLOSING_TERMINATED', 'Closing is terminal')
  if (c.clear_to_close_at) return { ok: true, duplicate: true }
  if (lower(c.contract_status) !== 'fully_executed') return fail('SELLER_CONTRACT_NOT_EXECUTED', 'Title cannot clear an unexecuted contract')
  const { titleIssues } = await loadBundle(env.db, c)
  const open = titleIssues.filter((i) => ['open', 'in_progress'].includes(lower(i.status)))
  if (open.length) return fail('OPEN_TITLE_ISSUES', `${open.length} title issue(s) still open`, { issues: open.map((i) => i.issue_id) })
  const at = iso(input.at) || env.now().toISOString()
  const next = await updateCase(env.db, c, { clear_to_close_at: at, clear_to_close_source: lower(input.source), clear_to_close_evidence: clean(input.evidenceReference), clear_to_close_actor: clean(input.actor), readiness: { ...(c.readiness || {}), clear_to_close: true } })
  await milestone(env.db, next, { type: 'clear_to_close', actor: clean(input.actor), occurredAt: at, prior: c.title_status, resulting: 'clear_to_close', snapshot: { source: lower(input.source), evidence: clean(input.evidenceReference) }, key: `closing:${c.closing_case_id}:clear_to_close:final` })
  await audit(env.db, next, { type: 'clear_to_close', actor: input.actor, source: lower(input.source), detail: { at, evidence: clean(input.evidenceReference) }, key: `clear_to_close:${c.closing_case_id}` })
  await env.notify({ eventType: 'closing_escrow_update', sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, severity: 'positive', title: `Clear to close — ${c.property_address || 'closing'}`, deduplicationKey: `closing_clear_to_close:${c.closing_case_id}` })
  await maybePreparedToClose(env, next, input.actor)
  return { ok: true }
}

/** S9 Prepared to Close = title clear AND a confirmed closing date. */
async function maybePreparedToClose(env, c, actor) {
  if (c.clear_to_close_at && c.closing_date_confirmed_at && stageRank(c.universal_stage) >= stageRank('under_contract') && stageRank(c.universal_stage) < stageRank('prepared_to_close')) {
    return advanceLifecycle(env, c, 'prepared_to_close', { reason: 'clear_to_close_and_date_confirmed', actor })
  }
  return c
}

/* ═════ CLOSING DATE ═════ */

/**
 * Reschedule / confirm. The prior date survives in the audit trail with the
 * reason and source; the time keeps the property's zone (the caller passes an
 * ISO instant with offset, plus the IANA zone it was expressed in).
 */
export async function setClosingDate(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const at = iso(input.scheduledAt); if (!at) return fail('DATE_REQUIRED', 'A closing date/time is required')
  if (!clean(input.reason)) return fail('REASON_REQUIRED', 'Why is the date being set or changed?')
  if (!clean(input.source)) return fail('SOURCE_REQUIRED', 'Who set this date (title email / operator)?')
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (isTerminal(c) || c.closed_at) return fail('CLOSING_NOT_OPEN', 'Closing is not open')
  const confirmed = input.confirmed === true
  const prior = { at: c.scheduled_closing_date, confirmed: Boolean(c.closing_date_confirmed_at), tz: c.closing_tz || null }
  if (iso(prior.at) === at && prior.confirmed === confirmed) return { ok: true, duplicate: true }
  const now = env.now().toISOString()
  let next = await updateCase(env.db, c, {
    scheduled_closing_date: at,
    closing_tz: clean(input.tz) || c.closing_tz || null,
    closing_date_confirmed_at: confirmed ? now : null,
    closing_date_source: clean(input.source),
    closing_status: confirmed ? 'scheduled' : (lower(c.closing_status) === 'scheduled' ? 'in_title' : c.closing_status),
  })
  await audit(env.db, next, { type: 'closing_date_changed', actor: input.actor, source: clean(input.source), detail: { before: prior, after: { at, confirmed, tz: next.closing_tz }, reason: clean(input.reason) }, key: `closing_date:${c.closing_case_id}:${at}:${confirmed ? 'confirmed' : 'target'}:${now}` })
  if (confirmed) await milestone(env.db, next, { type: 'closing_scheduled', actor: clean(input.actor), occurredAt: now, prior: prior.at, resulting: at, snapshot: { reason: clean(input.reason), source: clean(input.source) }, key: `closing:${c.closing_case_id}:closing_scheduled:${at}` })
  if (prior.at && iso(prior.at) !== at) {
    await env.notify({ eventType: 'closing_status_changed', sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, title: `Closing rescheduled — ${c.property_address || 'closing'}`, description: clean(input.reason), deduplicationKey: `closing_rescheduled:${c.closing_case_id}:${at}` })
  }
  // Sellers are told about confirmed dates only; targets are internal.
  if (confirmed && c.opportunity_id) await env.sellerLifecycle({ kind: prior.confirmed && prior.at ? 'closing_changed' : 'closing_scheduled', opportunityId: c.opportunity_id, dedupeKey: `closing_date:${c.closing_case_id}:${at}`, context: { start_at: at, timezone: next.closing_tz || undefined } })
  next = await maybePreparedToClose(env, next, input.actor)
  return { ok: true, closing: { at, confirmed, tz: next.closing_tz } }
}

/* ═════ SETTLEMENT ═════ */

const SETTLE_METHODS = new Set(['manual_operator', 'title_provider', 'escrow_provider', 'bank_feed', 'document_upload'])

/**
 * The settlement record — ACTUAL money only. Pending until the settlement
 * statement is final and verified; settled requires evidence (DB CHECK) and
 * is immutable afterwards (DB trigger). Estimates are never copied in.
 */
export async function recordSettlement(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (isTerminal(c)) return fail('CLOSING_TERMINATED', 'Closing is terminal')
  const leg = ['single', 'a_to_b', 'b_to_c'].includes(lower(input.leg)) ? lower(input.leg) : 'single'
  const strategy = ['assignment', 'double_close', 'novation'].includes(lower(input.strategy)) ? lower(input.strategy) : 'assignment'
  const settlementId = `settlement:${c.closing_case_id}:${leg}`
  const { data: existingRows, error: rerr } = await env.db.from('settlement_records').select('*').eq('settlement_id', settlementId).limit(1)
  if (rerr) throw rerr
  const existing = existingRows?.[0] || null
  if (existing && lower(existing.settlement_status) === 'settled') return fail('SETTLEMENT_IMMUTABLE', 'This leg is settled; its actuals cannot be rewritten (record a post-close exception)')
  const settle = input.settle === true
  if (settle) {
    if (!SETTLE_METHODS.has(lower(input.verificationMethod))) return fail('VERIFICATION_METHOD_REQUIRED', 'How was the settlement verified?')
    if (!clean(input.evidenceReference)) return fail('EVIDENCE_REQUIRED', 'Settled needs the final statement / confirmation reference')
    if (!iso(input.closedAt)) return fail('CLOSED_AT_REQUIRED', 'When did it settle?')
    if (!clean(input.closingProvider)) return fail('PROVIDER_REQUIRED', 'Who settled it (title / escrow)?')
    if (num(input.actualNetProceeds) === null) return fail('ACTUALS_REQUIRED', 'Settled needs the actual net proceeds from the statement')
  }
  const { offers } = await loadBundle(env.db, c)
  const committed = offers.find((o) => lower(o.status) === 'committed') || null
  const now = env.now().toISOString()
  const row = {
    settlement_id: settlementId, opportunity_id: c.opportunity_id, closing_case_id: c.closing_case_id, property_id: c.property_id,
    buyer_id: committed?.buyer_id || null, buyer_offer_id: committed?.buyer_offer_id || null, strategy, leg,
    settlement_status: settle ? 'settled' : 'pending',
    funding_status: ['expected', 'initiated', 'received', 'verified', 'cleared', 'disbursed'].includes(lower(input.fundingStatus)) ? lower(input.fundingStatus) : (existing?.funding_status || 'expected'),
    funded_amount: num(input.fundedAmount), disbursed_amount: num(input.disbursedAmount), funded_at: iso(input.fundedAt), disbursed_at: iso(input.disbursedAt),
    settlement_statement_type: ['alta', 'hud1', 'closing_statement', 'other'].includes(lower(input.statementType)) ? lower(input.statementType) : (existing?.settlement_statement_type || null),
    settlement_statement_reference: clean(input.statementReference) || existing?.settlement_statement_reference || null,
    actual_seller_amount: num(input.actualSellerAmount), actual_buyer_amount: num(input.actualBuyerAmount), actual_assignment_fee: num(input.actualAssignmentFee),
    actual_closing_costs: num(input.actualClosingCosts), actual_other_costs: num(input.actualOtherCosts), actual_net_proceeds: num(input.actualNetProceeds),
    closed_at: iso(input.closedAt), closing_provider: clean(input.closingProvider) || null,
    recording_status: ['pending', 'submitted', 'recorded', 'rejected'].includes(lower(input.recordingStatus)) ? lower(input.recordingStatus) : (existing?.recording_status || 'not_applicable'),
    recording_instrument_id: clean(input.recordingInstrumentId) || null, recorded_at: iso(input.recordedAt), recording_jurisdiction: clean(input.recordingJurisdiction) || null,
    recording_evidence_reference: clean(input.recordingEvidenceReference) || null,
    ...(settle ? { verified_by: clean(input.actor), verified_at: now, verification_method: lower(input.verificationMethod), evidence_reference: clean(input.evidenceReference) } : {}),
    source: clean(input.source) || 'manual_operator',
    metadata: { ...(existing?.metadata || {}), last_recorded_by: clean(input.actor), extraction_confidence: input.extractionConfidence ?? null },
    updated_at: now,
  }
  // Uncertain extraction never settles money on its own.
  if (settle && input.extractionConfidence !== undefined && input.extractionConfidence !== null && Number(input.extractionConfidence) < 0.95 && !input.operatorConfirmed) {
    return fail('REVIEW_REQUIRED', 'Parsed settlement figures need operator confirmation before they become actuals')
  }
  const { error } = existing
    ? await env.db.from('settlement_records').update(row).eq('settlement_id', settlementId).neq('settlement_status', 'settled')
    : await env.db.from('settlement_records').insert(row)
  if (error && !isDuplicate(error)) throw error
  await audit(env.db, c, { type: settle ? 'settlement_settled' : 'settlement_recorded', actor: input.actor, source: row.source, detail: { settlement_id: settlementId, before: existing?.settlement_status ?? null, after: row.settlement_status, statement: row.settlement_statement_reference, net: row.actual_net_proceeds, fee: row.actual_assignment_fee }, key: `settlement:${settlementId}:${row.settlement_status}${settle ? '' : `:${now}`}` })
  return { ok: true, settlementId, status: row.settlement_status }
}

/* ═════ S10 ═════ */

export async function getClosingGuard(id, deps = {}) {
  const env = ctx(deps)
  const c = await loadClosingCase(env.db, id)
  if (!c) return { ok: false, code: 'CLOSING_NOT_FOUND', missing: [], blockers: [] }
  return { ...evaluateClosingGuard(await loadBundle(env.db, c)), closingCaseId: c.closing_case_id }
}

/**
 * THE ONLY PATH TO S10. Full guard here (structured blockers), then the
 * atomic database transition, which re-checks the financial core under lock.
 * Repeating it is a no-op.
 */
export async function finalizeClosing(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const c = await loadClosingCase(env.db, input.closingCaseId || input.opportunityId)
  if (!c) return fail('CLOSING_NOT_FOUND', 'No closing case for this deal — a deal closes only through its closing', { missing: ['no_closing_case'], blockers: [{ code: 'no_closing_case', message: 'No closing case exists for this deal', owner: 'you' }] })
  if (c.closed_at && lower(c.closing_status) === 'closed') return { ok: true, alreadyClosed: true, closingCaseId: c.closing_case_id }
  const guard = evaluateClosingGuard(await loadBundle(env.db, c))
  if (!guard.ok) return { ...fail('CLOSING_BLOCKED', 'Closing requirements are not met'), missing: guard.missing, blockers: guard.blockers, closingCaseId: c.closing_case_id }
  const { data, error } = await env.db.rpc('finalize_closing_case', { p_closing_case_id: c.closing_case_id, p_actor: clean(input.actor), p_source: clean(input.source) || 'closing_authority' })
  if (error) throw error
  if (!data?.ok) return { ...fail(data?.code || 'CLOSING_BLOCKED', 'Closing requirements are not met'), missing: data?.missing || [], blockers: (data?.missing || []).map((code) => ({ code })), closingCaseId: c.closing_case_id }
  if (!data.already_closed) {
    await cancelOpenEmailRequests(env.db, c.closing_case_id, 'closing_finalized')
    await env.notify({ eventType: 'closing_case_completed', sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, participantId: c.thread_key, titleVars: { case_name: c.property_address }, metrics: { actual_net_proceeds: data.actual_net_proceeds, actual_assignment_fee: data.actual_assignment_fee }, deduplicationKey: `closing_case_completed:${c.closing_case_id}` })
    if (c.opportunity_id) await env.sellerLifecycle({ kind: 'closed', opportunityId: c.opportunity_id, dedupeKey: `closed:${c.closing_case_id}` })
  }
  return { ok: true, alreadyClosed: Boolean(data.already_closed), closedAt: data.closed_at, closingCaseId: c.closing_case_id }
}

/* ═════ TERMINAL / AUTOMATION CONTROL ═════ */

/** Cancelled / failed / withdrawn: automation stops, history stays, nothing becomes Closed. */
export async function terminateClosing(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const outcome = lower(input.outcome)
  if (!['cancelled', 'failed', 'withdrawn'].includes(outcome)) return fail('BAD_OUTCOME', 'Outcome must be cancelled, failed or withdrawn')
  if (!clean(input.reason)) return fail('REASON_REQUIRED', 'Why is this closing ending?')
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  if (c.closed_at) return fail('ALREADY_CLOSED', 'A closed deal cannot be cancelled; record a post-close exception')
  if (c.terminal_outcome) return { ok: true, duplicate: true }
  const at = env.now().toISOString()
  const next = await updateCase(env.db, c, { terminal_outcome: outcome, terminal_reason: clean(input.reason), terminal_at: at, terminal_actor: clean(input.actor) })
  const cancelled = await cancelOpenEmailRequests(env.db, c.closing_case_id, `closing_${outcome}`)
  await audit(env.db, next, { type: 'closing_terminated', actor: input.actor, source: 'operator', detail: { outcome, reason: clean(input.reason), cancelled_email_requests: cancelled }, key: `closing_terminated:${c.closing_case_id}` })
  await env.notify({ eventType: 'closing_status_changed', sourceEntityType: 'closing_case', sourceEntityId: c.closing_case_id, closingId: c.closing_case_id, propertyId: c.property_id, dealId: c.opportunity_id, severity: 'warning', title: `Closing ${outcome} — ${c.property_address || 'closing'}`, description: clean(input.reason), deduplicationKey: `closing_terminated:${c.closing_case_id}` })
  return { ok: true, outcome }
}

export async function setAutomationPaused(input = {}, deps = {}) {
  const env = ctx(deps)
  const bad = requireActor(input.actor); if (bad) return bad
  const c = await loadClosingCase(env.db, input.closingCaseId); if (!c) return fail('CLOSING_NOT_FOUND', 'No such closing')
  const pause = input.paused === true
  if (pause === Boolean(c.automation_paused_at)) return { ok: true, duplicate: true }
  if (pause && !clean(input.reason)) return fail('REASON_REQUIRED', 'Why pause automation for this closing?')
  const at = env.now().toISOString()
  const next = await updateCase(env.db, c, pause ? { automation_paused_at: at, automation_paused_reason: clean(input.reason), automation_paused_by: clean(input.actor) } : { automation_paused_at: null, automation_paused_reason: null, automation_paused_by: null })
  await audit(env.db, next, { type: pause ? 'automation_paused' : 'automation_resumed', actor: input.actor, source: 'operator', detail: { reason: clean(input.reason) || null }, key: `automation_${pause ? 'paused' : 'resumed'}:${c.closing_case_id}:${at}` })
  return { ok: true, paused: pause }
}
