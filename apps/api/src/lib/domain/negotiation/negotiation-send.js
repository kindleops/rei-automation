// THE SEND PATH for an envelope-authorized negotiation move (Action Gateway execute_authorized_offer, run by
// LeadCommand's worker: runtime kind action.offer_send) and the recording of a seller counter (record_seller_counteroffer,
// action.record_counter). It owns exactly the writes negotiation-composer.js describes and never does itself:
//
//   composeNegotiationReply (envelope + DISTINCT live send authorization + the DURABLE send budget this send already
//     holds (R5: send_use_key) + an approved sms_templates row + the seller-facing guard)  → DETERMINISTIC_REPLY
//   persistActiveOffer BEFORE the send (R4: the amount ≤ the lowest of the envelope max, the send ceiling, the engine
//     MAO, refused otherwise) → recordNegotiationEvent (the ledger, engine within_envelope) → the CANONICAL queue
//     writer insertSupabaseSendQueueRow (deterministic key negotiation_offer:<intent>, the thread's established persona
//     + sender number, max_retries 1: dispatchable once; an ambiguous accept is never retried) → bindOfferToQueueRow.
//
// IDEMPOTENT RESUME (a crashed worker retries the job): the queue row is looked up by its key first (present ⇒
// already enqueued); persistActiveOffer reuses identical terms; the ledger event is matched by its seller_offer_id.
// So one authorized intent produces at most ONE queued offer, whatever crashes in between.
import { insertSupabaseSendQueueRow } from '@/lib/supabase/sms-engine.js'
import { persistActiveOffer, bindOfferToQueueRow, recordSellerCounter } from '@/lib/domain/seller-flow/seller-offer-authority.js'
import { composeNegotiationReply, MOVE_TEMPLATE_USE_CASES } from './negotiation-composer.js'
import { createSupabaseNegotiationStore } from './store.js'
import { createSupabaseSendAuthorizationStore } from './send-authorization.js'
import { recordNegotiationEvent, loadThreadFactLedger } from './negotiation-service.js'
import { scopeKey } from './envelope.js'
import { resolveThreadContinuity } from '@/lib/domain/conversation-ai/persona-continuity.js'
import { assessOpportunityEconomics } from '@/lib/domain/opportunity-economics/economics-service.js'
import { planOffer } from '@/lib/domain/property-research/offer-plan.js'
import { evaluateAcceptanceRules } from '@/lib/domain/holds/automation-hold-core.js'
import { checkAutomationHold, resolveAutomationHold, HOLD_CAPABILITIES } from '@/lib/domain/holds/automation-hold.js'

export const NEGOTIATION_SEND_VERSION = 'lc.negotiation-send.v1'
export const offerQueueKey = (intentId) => `negotiation_offer:${intentId}`

const clean = (v) => String(v ?? '').trim()
async function rows(q) { const r = await q; if (r?.error) throw Object.assign(new Error('READ_FAILED'), { code: 'READ_FAILED' }); return Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : [] }

/**
 * @param {{ intent_id: string, thread_key: string, property_id: string, opportunity_id: string, amount: number, send_authorization_id: string,
 *           supabase: object, env?: object, now?: number, insertQueueRow?: Function, beforeQueueInsert?: Function }} a
 * @returns {Promise<{ status: 'enqueued'|'held'|'refused', code: string, queue_row_id?: string, offer_id?: string, detail?: object }>}
 */
export async function sendAuthorizedOffer({ intent_id, thread_key, property_id, opportunity_id, amount, send_authorization_id, supabase, env = process.env, now = Date.now(), insertQueueRow = null, beforeQueueInsert = null }) {
  const key = offerQueueKey(intent_id)
  // resume: the queue row exists ⇒ this intent's offer is already enqueued (exactly once)
  const existing = await rows(supabase.from('send_queue').select('id,queue_status').eq('queue_key', key).limit(1))
  if (existing[0]) return { status: 'enqueued', code: 'ALREADY_ENQUEUED', queue_row_id: String(existing[0].id) }

  const base = createSupabaseNegotiationStore({ supabase })
  // RESUME after a crash between the offer / ledger writes and the queue insert: the position is decided as of
  // BEFORE this intent's own writes (its offer version and its ledger event are set aside), so the composer
  // re-derives the SAME move and text, persistActiveOffer reuses the version and no second event is appended
  const mine = (await rows(supabase.from('seller_offers').select('offer_id,metadata,direction').eq('thread_key', thread_key).limit(50)))
    .find((x) => clean(x.metadata?.action_intent_id) === clean(intent_id) && clean(x.direction) !== 'inbound') || null
  const store = mine ? Object.freeze({ ...base,
    listEvents: async (k) => (await base.listEvents(k)).filter((e) => clean(e.seller_offer_id) !== clean(mine.offer_id)),
    sellerOffers: async (a) => (await base.sellerOffers(a)).filter((x) => clean(x.offer_id) !== clean(mine.offer_id)) }) : base
  const sends = createSupabaseSendAuthorizationStore({ supabase })
  const { ledger, canonical } = await loadThreadFactLedger({ supabase, thread_key, now: new Date(now) })
  const economics = await assessOpportunityEconomics({ supabase, property_id, thread_key, ledger, now: new Date(now) }).catch(() => null)
  const valuation = (await rows(supabase.from('property_acquisition_scores').select('*').eq('property_id', String(property_id)).limit(1)))[0] || null
  const latest = await store.latestEnvelope(scopeKey(thread_key, property_id))
  const plan = planOffer({ valuation, property: { property_id }, envelope: latest?.envelope || null, now })
  const templates = await rows(supabase.from('sms_templates').select('id,template_id,use_case,language,is_active,template_body').in('use_case', [...new Set(Object.values(MOVE_TEMPLATE_USE_CASES).flat())]).eq('is_active', true).limit(50))
  const events = await store.listEvents(scopeKey(thread_key, property_id))
  const outcome = events.some((e) => ['our_offer', 'our_counter', 'our_final'].includes(e.event_type)) ? 'NEGOTIATE_WITHIN_AUTHORITY' : 'PREPARE_OFFER'
  const composed = await composeNegotiationReply({
    outcome, context: { thread_key, property_id, opportunity_id, fact_ledger: canonical || ledger, economics, offer_plan: plan, now },
    deps: { store }, sendAuthorizations: sends, templates,
    thread: { language: 'english', template_context: {}, send_use_key: `gw:${intent_id}` },
    checkAutomationHold: (a) => checkAutomationHold(a, { supabase }), env,
  })
  if (composed.action !== 'DETERMINISTIC_REPLY') return { status: 'held', code: 'COMPOSER_ESCALATED', detail: { reason: clean(composed.reason).slice(0, 120) } }
  if (Number(composed.amount) !== Number(amount)) return { status: 'held', code: 'MOVE_DRIFTED_SINCE_AUTHORIZATION', detail: {} }
  if (composed.authority_ref?.send_authorization_id !== send_authorization_id) return { status: 'held', code: 'SEND_AUTHORIZATION_DRIFTED', detail: {} }

  // the established persona + sender number of the thread (never a number change)
  const [sent, ts] = await Promise.all([
    rows(supabase.from('send_queue').select('id,queue_status,agent_name,from_phone_number,created_at,metadata').eq('thread_key', thread_key).order('created_at', { ascending: false }).limit(60)),
    rows(supabase.from('inbox_thread_state').select('our_number').eq('thread_key', thread_key).limit(1)),
  ])
  const continuity = resolveThreadContinuity({ sentRows: sent, threadState: ts[0] || null })
  // the seller's first name (the runner refuses a template row without one: a visible pause, never a guess)
  let firstName = null
  try {
    const [st] = await rows(supabase.from('inbox_thread_state').select('prospect_id').eq('thread_key', thread_key).limit(1))
    if (st?.prospect_id) firstName = clean((await rows(supabase.from('prospects').select('first_name').eq('prospect_id', String(st.prospect_id)).limit(1)))[0]?.first_name) || null
  } catch { firstName = null }
  if (!continuity.ok || !continuity.sender_number) return { status: 'held', code: 'SENDER_CONTINUITY_UNRESOLVED', detail: { reasons: (continuity.reasons || []).slice(0, 6) } }

  // R4: persist BEFORE the send, under every independent ceiling
  const args = composed.persist.seller_offer_args
  const offer = await persistActiveOffer({
    ...args, opportunity_id, thread_key, property_id,
    envelope_max_price: latest?.envelope?.max_price ?? null, mao: economics?.metrics?.mao ?? (plan.available ? plan.mao.amount : null),
    ade_snapshot_id: valuation?.evidence?.immutable_snapshot_id ?? valuation?.id ?? null, recommended_offer: valuation?.recommended_cash_offer ?? null, valuation_mid: valuation?.valuation_mid ?? null,
    metadata: { ...(args.metadata || {}), action_intent_id: intent_id, send_authorization_id, source: 'action_gateway' },
    supabase,
  })
  if (!offer?.ok) return { status: 'held', code: `OFFER_NOT_PERSISTED:${clean(offer?.reason).slice(0, 50)}`, detail: {} }
  // the ledger (engine move within the envelope), once per offer
  if (!(await base.listEvents(scopeKey(thread_key, property_id))).some((e) => clean(e.seller_offer_id) === clean(offer.offer_id))) {
    const ev = await recordNegotiationEvent({ thread_key, property_id, opportunity_id, event: { ...composed.persist.ledger_event, seller_offer_id: offer.offer_id }, now }, { store: base })
    if (!ev.ok) return { status: 'held', code: `LEDGER_REFUSED:${clean(ev.code).slice(0, 50)}`, offer_id: offer.offer_id, detail: {} }
  }
  const payload = {
    queue_key: key, queue_id: key, dedupe_key: key, queue_status: 'queued', send_priority: 5, retry_count: 0, max_retries: 1,
    message_body: composed.rendered_text, message_text: composed.rendered_text, character_count: composed.rendered_text.length,
    to_phone_number: thread_key, from_phone_number: continuity.sender_number, agent_name: continuity.persona_name, seller_first_name: firstName, thread_key, property_id,
    message_origin: 'template', template_id: composed.template_id, selected_template_id: composed.template_id, template_source: 'sms_templates',
    use_case_template: composed.template_use_case, message_type: 'negotiation_offer', type: 'negotiation_offer', source: 'action_gateway', language: 'English',
    sms_eligible: true, routing_allowed: true,
    metadata: { source: 'action_gateway', action_type: 'negotiation_offer', action_intent_id: intent_id, offer_id: offer.offer_id, offer_version: offer.offer_version,
      envelope_id: composed.authority_ref.envelope_id, envelope_version: composed.authority_ref.envelope_version, send_authorization_id, send_use_key: `gw:${intent_id}`,
      agent_persona: continuity.persona_name, persona_continuity: { version: continuity.version, persona_source: continuity.persona_source, sender_source: continuity.sender_source },
      negotiation_send_version: NEGOTIATION_SEND_VERSION, no_direct_provider_send: true },
  }
  if (beforeQueueInsert) await beforeQueueInsert(payload)
  let res
  try { res = insertQueueRow ? await insertQueueRow(payload) : await insertSupabaseSendQueueRow(payload, { supabase }) } catch (e) { res = { ok: false, reason: clean(e?.message).slice(0, 60) } }
  const qid = res?.queue_row_id || res?.item_id || null
  if (!res?.ok || !qid) return { status: 'held', code: `QUEUE_INSERT_REFUSED:${clean(res?.reason).slice(0, 50)}`, offer_id: offer.offer_id, detail: {} }
  await bindOfferToQueueRow({ offer_id: offer.offer_id, send_queue_row_id: qid, supabase })
  return { status: 'enqueued', code: 'OFFER_ENQUEUED', queue_row_id: String(qid), offer_id: offer.offer_id, detail: { offer_version: offer.offer_version, move: composed.composer_view?.move?.kind || null } }
}

/**
 * The seller's counter as an immutable offer-history version + its ledger event; NEVER an acceptance. The existing
 * acceptance guard is run on the recorded counter and its verdict reported (an acceptance is always a human act).
 */
export async function recordAgentCounter({ intent_id, thread_key, property_id, opportunity_id, counter_price, inbound_message_id, supabase, now = Date.now() }) {
  const r = await recordSellerCounter({ opportunity_id, thread_key, property_id, counter_price, source_message_event_id: inbound_message_id, metadata: { action_intent_id: intent_id, source: 'action_gateway' }, supabase })
  if (!r?.ok) return { status: 'held', code: `COUNTER_NOT_RECORDED:${clean(r?.reason).slice(0, 50)}`, detail: {} }
  const store = createSupabaseNegotiationStore({ supabase })
  let ledger = 'not_recorded'
  try {
    const events = await store.listEvents(scopeKey(thread_key, property_id))
    if (!events.some((e) => clean(e.source_message_id) === clean(inbound_message_id))) {
      const ourOffer = events.some((e) => ['our_offer', 'our_counter', 'our_final'].includes(e.event_type))
      const ev = await recordNegotiationEvent({ thread_key, property_id, opportunity_id, event: { event_type: ourOffer ? 'seller_counter' : 'seller_ask', actor: 'seller', authority: 'seller_stated', amount: counter_price, source_message_id: inbound_message_id, seller_offer_id: r.offer_id }, now }, { store })
      ledger = ev.ok ? 'recorded' : `refused:${clean(ev.code).slice(0, 40)}`
    } else ledger = 'already_recorded'
  } catch { ledger = 'ledger_unavailable' }
  // the acceptance guard (report only): operator-origin / above-MAO / above-ceiling / archived / held ⇒ human review
  const [opp, score] = await Promise.all([
    rows(supabase.from('acquisition_opportunities').select('*').eq('id', opportunity_id).limit(1)).then((x) => x[0] || null).catch(() => null),
    rows(supabase.from('property_acquisition_scores').select('*').eq('property_id', String(property_id)).limit(1)).then((x) => x[0] || null).catch(() => null),
  ])
  const hold = await resolveAutomationHold({ thread_key, property_id, opportunity_id }, { capability: HOLD_CAPABILITIES.OFFER_ACCEPTANCE, supabase }).catch(() => ({ held: true, fail_closed: true }))
  const verdict = evaluateAcceptanceRules({ offer: r.offer || null, opportunity: opp, score, hold })
  return { status: 'recorded', code: r.reused ? 'COUNTER_ALREADY_RECORDED' : 'COUNTER_RECORDED', offer_id: r.offer_id,
    detail: { offer_version: r.offer_version, ledger, auto_accepted: false, acceptance_automatable: verdict.allowed, acceptance_review_reasons: verdict.reasons.slice(0, 8), acceptance: 'human_review_only' } }
}
