// Production bindings for the negotiation plane (lazy; nothing loads Supabase until used).
// Every binding delegates to an existing service: economics → assessOpportunityEconomics
// (read-only), envelopes/ledger → the PROPOSED tables via createSupabaseNegotiationStore.
import { assessOpportunityEconomics } from '../opportunity-economics/economics-service.js'
import { createSupabaseNegotiationStore } from './store.js'
import { grantEnvelope, loadThreadFactLedger } from './negotiation-service.js'

/**
 * @param {{ supabase: object, refs?: { open(ref, org_id): string|null }, getMarketDemand?: Function }} o
 */
export function createNegotiationServices({ supabase, refs = null, getMarketDemand = null }) {
  const store = createSupabaseNegotiationStore({ supabase })
  return Object.freeze({
    store,
    openThread: (ref, org_id) => (refs ? refs.open(ref, org_id) : null),
    async underwriting({ thread_key, property_id, now = new Date() }) {
      const { ledger } = await loadThreadFactLedger({ supabase, thread_key, now })
      return assessOpportunityEconomics({ supabase, property_id, thread_key, ledger, getMarketDemand, now })
    },
    latestEnvelope: (scope_key) => store.latestEnvelope(scope_key),
    grant: (args) => grantEnvelope(args, { store }),
  })
}
