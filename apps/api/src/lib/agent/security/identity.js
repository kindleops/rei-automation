// Identity provider contract (architecture §3.2 prerequisite, §13 O5, §16 S7).
//
// GATE B (10-10): the agent ROUTES now use security/agent-auth.js — the
// operator's own Supabase JWT verified server-side + the operator allowlist
// (method 'supabase_jwt'). The stub below remains only for code paths that are
// not request-bound (approvals stay refused until fresh-auth exists, S4.2).
//
// Historical note: named-user identity did not exist (gap G1). Until S7 — the API
// verifying the operator's own Supabase JWT, not only the shared secret +
// x-ops-user-id header — the ONLY provider wired in is the stub below, which
// never verifies anyone. Consequences (enforced by the registry + approvals):
//   * T2 and T3 are refused (IDENTITY_REQUIRED)
//   * approvals can be requested and shown, but never granted
//   * T0/T1 are attributed to the worker-asserted session user (unverified)
//
// @typedef {Object} VerifiedIdentity
// @property {boolean} verified           true only from a real verifier (S7)
// @property {boolean} named              a named human user (not a shared secret)
// @property {string|null} user_id
// @property {string|null} display_name
// @property {string|null} authenticated_at  ISO; drives fresh-auth (≤ 5 min)
// @property {'stub'|'supabase_jwt'|'test'} method
// @property {string|null} reason
//
// @typedef {Object} IdentityProvider
// @property {boolean} available          false until S7
// @property {(session: unknown) => Promise<VerifiedIdentity>} verify
// @property {(request: Request) => { user_id: string|null, verified: false, method: 'header_asserted' }} attribute

export const IDENTITY_UNAVAILABLE_REASON = 'NAMED_USER_IDENTITY_NOT_IMPLEMENTED'

/** @returns {IdentityProvider} */
export function createStubIdentityProvider() {
  return Object.freeze({
    available: false,
    async verify() {
      return Object.freeze({
        verified: false,
        named: false,
        user_id: null,
        display_name: null,
        authenticated_at: null,
        method: 'stub',
        reason: IDENTITY_UNAVAILABLE_REASON,
      })
    },
    attribute(request) {
      const id = String(request?.headers?.get?.('x-ops-user-id') ?? '').trim() || null
      return { user_id: id, verified: false, method: 'header_asserted' }
    },
  })
}

/** True only for a verified, named identity. */
export function isConsequentialIdentity(identity) {
  return Boolean(identity && identity.verified === true && identity.named === true && identity.user_id)
}
