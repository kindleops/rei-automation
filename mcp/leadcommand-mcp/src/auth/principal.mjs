// Principal + org authorization.
//
// stdio (1.0): the principal is ESTABLISHED BY THE HOST — the operator's user id
// and org in the server launch config (the same trust as the process owner who
// can read the key files). It is never taken from a tool argument; a tool input
// carrying org / user / principal keys is refused as forged context.
//
// Org scoping goes through agent.operator_membership (the agent plane's tenancy
// table), read as the least-privilege agent_api login (verify-full TLS, no
// superuser / BYPASSRLS, 5 s statement timeout). Results are cached 60 s; a
// lookup failure fails CLOSED (unavailable), never open.
//
// Multi-tenancy, stated plainly: membership, scopes and the cross-org check are
// tenant-aware, but LeadCommand's domain tables (properties, campaigns, …) carry
// no org column today — one database is one org's data. The server therefore
// serves exactly ONE data org (LEADCOMMAND_MCP_DATA_ORG_ID) and refuses any
// principal whose org is not that org. Row-level tenant isolation is a 2.0 item.
import pg from 'pg'
import { err } from '../errors.mjs'
import { ROLE_RANK } from '../authz/scopes.mjs'

export const MEMBERSHIP_TTL_MS = 60_000

/** agent_api pool: verify-full TLS against the Supabase CA; privileged roles refused at first use. */
export function createPgMembershipStore({ url, ca }) {
  const u = new URL(url)
  for (const k of [...u.searchParams.keys()]) if (/^ssl/i.test(k) || /^(host|hostaddr)$/i.test(k)) u.searchParams.delete(k)
  const user = decodeURIComponent(u.username || '')
  if (!user || /^(postgres|supabase_admin|service_role|authenticator)(\.|$)/i.test(user)) throw new Error('membership store must connect as the least-privilege agent_api login')
  const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: true, servername: u.hostname, ca }, max: 2, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 6_000, application_name: 'leadcommand-mcp' })
  pool.on('error', () => {})
  let roleChecked = false
  return {
    async lookup(orgId, userId) {
      if (!roleChecked) {
        const { rows } = await pool.query('select r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user')
        if (!rows[0] || rows[0].rolsuper || rows[0].rolbypassrls) throw new Error('membership store role is privileged')
        roleChecked = true
      }
      const { rows } = await pool.query('select role from agent.operator_membership where org_id = $1::uuid and user_id = $2::uuid limit 1', [orgId, userId])
      return rows[0] ? { role: rows[0].role } : null
    },
    async close() { await pool.end().catch(() => {}) },
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
