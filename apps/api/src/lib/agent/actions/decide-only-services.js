// The services the DECIDE-ONLY capabilities (capabilities/decision-registry.js, D6 / D1) read when a HUMAN
// decides one of their approvals through the one decide route. Kept outside agent/capabilities/ (that tree
// builds no query: the red-team static test), loaded lazily by getCapabilityPlane.
/**
 * The services the DECIDE-ONLY capabilities read on decide (D6 / D1): the negotiation envelope + send
 * authorization services (the backend client; the tables are service-role only) and the Action Gateway intent
 * reader (agent_api pool, RLS policy agent_api_select). Lazy; nothing loads until the plane is built.
 */
export async function decideOnlyServices({ pool }) {
  const [{ getDefaultSupabaseClient }, { createNegotiationServices }, { createSupabaseSendAuthorizationStore, grantSendAuthorization }, { createIntentApprovalReader }] = await Promise.all([
    import('@/lib/supabase/default-client.js'),
    import('@/lib/domain/negotiation/services.js'),
    import('@/lib/domain/negotiation/send-authorization.js'),
    import('@/lib/domain/action-gateway/approvals.js'),
  ])
  const supabase = getDefaultSupabaseClient()
  const sends = createSupabaseSendAuthorizationStore({ supabase })
  return {
    negotiationFor: ({ refs }) => {
      const n = createNegotiationServices({ supabase, refs })
      return Object.freeze({ ...n, grantSendAuthorization: (args) => grantSendAuthorization(args, { store: sends }) })
    },
    actionGateway: createIntentApprovalReader({ query: async (sql, params) => (await pool.query(sql, params)).rows }),
  }
}
