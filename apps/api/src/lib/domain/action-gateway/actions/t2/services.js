// The T2 reads + writer calls of the gateway, bound to its own client (AS lc_action_gateway, tenant claim).
// Reads only: every write is a lease-bound definer function of PROPOSED_20261020100000_action_gateway_t2.
// The guards are the EXISTING ones: followup-lifecycle#loadPropertyContactBlock (property denial, declined
// unverified, no selling nurture after an ownership answer), queue/send-time-contact-guard (STOP, opt-out,
// suppression, wrong number, holds), stage-advance-guard#offerEventFromSellerOffer (offer events).
import { loadOpportunityRow, loadThreadRow, loadHoldRow, loadCampaignRow, loadThreadMessages } from './requests.js'

async function rpc(db, fn, args) {
  let res
  try {
    res = await db.rpc(fn, args)
  } catch (e) {
    throw Object.assign(new Error(`ACTION_STORE_UNAVAILABLE ${fn}`), { code: 'ACTION_STORE_UNAVAILABLE', cause_code: e?.code || null })
  }
  if (res?.error) throw Object.assign(new Error(String(res.error.message || res.error.code || 'rpc failed')), { code: res.error.code || null, fn })
  return res?.data ?? null
}

/** @param {{ db: object }} o */
export function createT2Services({ db }) {
  if (!db?.from || !db?.rpc) throw new Error('t2 services: a Supabase-shaped client is required')
  return Object.freeze({
    opportunity: (id) => loadOpportunityRow(db, id),
    thread: (id) => loadThreadRow(db, id),
    hold: (id) => loadHoldRow(db, id),
    campaign: (id) => loadCampaignRow(db, id),
    /** Offer events of an opportunity (the Offer Term Authority); unreadable ⇒ none (fail closed for Offer). */
    async offerEvents(opportunityId) {
      try {
        const { offerEventFromSellerOffer } = await import('../../../opportunity/stage-advance-guard.js')
        const r = await db.from('seller_offers').select('*').eq('opportunity_id', String(opportunityId)).limit(20)
        if (r?.error) return []
        return (r.data || []).map(offerEventFromSellerOffer).filter(Boolean)
      } catch { return [] }
    },
    /** Recent messages of a thread (the ownership helpers sort). */
    messages: (threadKey) => loadThreadMessages(db, threadKey),
    /** followup-lifecycle#loadPropertyContactBlock (throws on a read error: the caller fails closed). */
    async propertyContactBlock(args) {
      const { loadPropertyContactBlock } = await import('../../../followups/followup-lifecycle.js')
      return loadPropertyContactBlock({ supabase: db, ...args })
    },
    /** The send-time contact guard verdict on the would-be follow-up row (holds through the bound port). */
    async sendTimeGuard(row) {
      const m = await import('../../../queue/send-time-contact-guard.js')
      const facts = await m.loadSendTimeContactFacts(db, row)
      return m.evaluateSendTimeContactGuard(row, facts)
    },
    async followups(threadId) { return (await rpc(db, 'action_gateway_followup_intents', { p_thread_id: threadId })) || [] },
    humanRequest: (intentId, token, request) => rpc(db, 'action_gateway_dw_human_request', { p_intent_id: intentId, p_lease_token: token, p_request: request }),
  })
}
