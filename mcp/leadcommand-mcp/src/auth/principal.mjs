// Principal + org authorization.
//
// stdio (1.0): the principal is ESTABLISHED BY THE HOST — the operator's user id
// and org in the server launch config (the same trust as the process owner who
// can read the key files). It is never taken from a tool argument; a tool input
// carrying org / user / principal keys is refused as forged context.
//
// Org scoping reads agent.operator_membership through the SAME role-enforced
// read-only credential as every other live read: one RPC,
// public.lc_mcp_operator_role(org, user) (SECURITY DEFINER, STABLE, sql). The role
// lc_mcp_reader needs no privilege in schema agent, and the old agent_api login is
// gone: it could write agent.*. Results are cached 60 s; a lookup failure fails
// CLOSED (unavailable), never open.
//
// Multi-tenancy, stated plainly: membership, scopes and the cross-org check are
// tenant-aware, but LeadCommand's domain tables (properties, campaigns, …) carry
// no org column today — one database is one org's data. The server therefore
// serves exactly ONE data org (LEADCOMMAND_MCP_DATA_ORG_ID) and refuses any
// principal whose org is not that org. Row-level tenant isolation is a 2.0 item.
import { err } from '../errors.mjs'
import { ROLE_RANK } from '../authz/scopes.mjs'

export const MEMBERSHIP_TTL_MS = 60_000

/** Membership through the live source's allowlisted RPC (lc_mcp_reader token). */
export function createRpcMembershipStore(source) {
  if (typeof source?.operatorRole !== 'function') throw new Error('membership store needs the live source')
  return {
    async lookup(orgId, userId) {
      const role = await source.operatorRole(orgId, userId)
      return role ? { role } : null
    },
    async close() {},
  }
}

export function createFixtureMembershipStore(rows = []) {
  return {
    async lookup(orgId, userId) {
      const r = rows.find((m) => m.org_id === orgId && m.user_id === userId)
      return r ? { role: r.role } : null
    },
    async close() {},
  }
}

/**
 * @param {{ principal: {user_id, org_id}|null, dataOrgId: string|null, scopes: string[], store, now?: () => number }} o
 */
export function createAuthorizer({ principal, dataOrgId, scopes, store, now = () => Date.now() }) {
  let cache = null
  async function membership() {
    if (cache && now() - cache.at < MEMBERSHIP_TTL_MS) return cache.value
    let value
    try {
      value = await store.lookup(principal.org_id, principal.user_id)
    } catch {
      throw err('unavailable', 'the membership store could not be read; refusing (fail closed)', { code: 'MEMBERSHIP_UNAVAILABLE' })
    }
    cache = { at: now(), value }
    return value
  }
  return {
    get principal() { return principal },
    get scopes() { return scopes },
    /** Every check, in order. Returns { user_id, org_id, role } or throws a typed error. */
    async authorize(tool) {
      if (!principal || !principal.user_id) throw err('unauthorized', 'no principal: the host did not configure an operator identity for this server', { code: 'NO_PRINCIPAL' })
      if (!principal.org_id) throw err('unauthorized', 'no org: the host did not configure the operator org', { code: 'NO_ORG' })
      if (!dataOrgId) throw err('unavailable', 'this server has no data org configured', { code: 'NO_DATA_ORG' })
      if (principal.org_id !== dataOrgId) throw err('forbidden', 'the principal\'s org is not the org this server serves', { code: 'CROSS_ORG' })
      const m = await membership()
      if (!m) throw err('unauthorized', 'the principal is not a member of the org (agent.operator_membership)', { code: 'NOT_A_MEMBER' })
      if (!scopes.includes(tool.scope)) throw err('forbidden', `scope ${tool.scope} is not granted to this server`, { code: 'SCOPE_NOT_GRANTED', details: { required_scope: tool.scope } })
      if ((ROLE_RANK[m.role] || 0) < (ROLE_RANK[tool.min_role] || 99)) throw err('forbidden', `role ${m.role} cannot call ${tool.name}`, { code: 'ROLE_NOT_ALLOWED' })
      return { user_id: principal.user_id, org_id: principal.org_id, role: m.role }
    },
    reset() { cache = null },
  }
}
