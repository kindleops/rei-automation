#!/usr/bin/env node
// MINT and administer ONE service credential (the OWNER runs this; nothing else does).
// PROPOSED_20261105120000_action_gateway_service_principals.sql must be applied.
//
// A service principal is one administratively managed integration (agntei) acting for the agent principals the owner
// registers as its delegates. Each request names the acting agent in the X-LC-Acting-Agent header; that agent's OWN
// grants apply, with the tier ceiling min(agent, service). The credential (lcsvc_...) is printed ONCE to stdout; only its
// HMAC digest (the server's pepper) is stored. It is never written to a file or a log by this script.
//
//   node --import ./src/loader/register.mjs scripts/mint-service-credential.mjs \
//     --database-url-file ~/.leadcommand/owner-db-url --org <org uuid> --owner <owner user uuid> <command>
//
// --database-url-file  a 0600 file outside the repository holding an OWNER database URL (SQL editor / service_role
//                      equivalent). Never an argument (it would land in shell history).
// --org / --owner      the served org and the org OWNER recorded as created_by / disabled_by / revoked_by.
//
// Commands (exactly one):
//   --create --service-id svc_<name> --sponsor <operator uuid> --tier-ceiling 1-4 --pepper-file <0600 file>
//            [--display-name "agntei acquisitions"] [--days 1-90] [--delegate <agent id or display name>]... [--detach-agent-credentials]
//            creates the service principal and its delegates, then prints the credential ONCE.
//   --list [--service-id svc_<name>]                   the services of the org and their delegates (no secrets, no digests)
//   --add-delegate <agent id or display name> --service-id svc_<name> [--detach-agent-credentials]
//   --disable-delegate <agent id or display name> --service-id svc_<name>
//   --revoke --service-id svc_<name>                   final; every request with that credential is refused at once
//
// --detach-agent-credentials  also clears the delegate agents' OWN credentials (digest NULL): the service is then the only
//                             way to act as them. A delegate without a credential of its own keeps its registration valid
//                             until the service credential's expiry (renewed whenever the service is re-minted).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCredentialFile } from '../../leadcommand-mcp/src/data/credential.mjs'
import { mintServiceCredential } from '@/lib/domain/action-gateway/credentials.js'
import { AGENT_ID_RE, SERVICE_ID_RE } from '@/lib/domain/action-gateway/constants.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const inside = (p) => { const a = path.resolve(p); return a === REPO || a.startsWith(`${REPO}${path.sep}`) }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DISPLAY_RE = /^[A-Za-z0-9 ._()-]{1,80}$/
export const MAX_DAYS = 90
export const USAGE = 'usage: --database-url-file <0600 file> --org <uuid> --owner <uuid> (--create --service-id svc_<name> --sponsor <uuid> --tier-ceiling 1-4 --pepper-file <0600 file> [--display-name <name>] [--days 1-90] [--delegate <agent>]... [--detach-agent-credentials] | --list [--service-id svc_<name>] | --add-delegate <agent> --service-id svc_<name> [--detach-agent-credentials] | --disable-delegate <agent> --service-id svc_<name> | --revoke --service-id svc_<name>)'
export const WARNING = 'WARNING: this is the ONLY time this service credential is shown. Put it in the agntei host\'s secret store now. LeadCommand keeps only its digest and cannot show it again; if it is lost, revoke this service and mint a new one.'

const fail = (msg) => { throw Object.assign(new Error(msg), { code: 'MINT_SERVICE_REFUSED' }) }

function parse(argv) {
  const one = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? null : null }
  const many = (n) => argv.flatMap((a, i) => (a === n && argv[i + 1] != null ? [argv[i + 1]] : []))
  const has = (n) => argv.includes(n)
  const commands = ['--create', '--list', '--add-delegate', '--disable-delegate', '--revoke'].filter(has)
  if (commands.length !== 1) fail(USAGE)
  return { command: commands[0].slice(2), one, many, has }
}

async function withClient(db, fn) {
  // a pool lends one client (a transaction needs one connection); a client is used as is
  const c = typeof db.connect === 'function' && 'totalCount' in db ? await db.connect() : db
  try { return await fn(c) } finally { if (c !== db) c.release() }
}
async function tx(c, fn) {
  await c.query('begin')
  try { const r = await fn(); await c.query('commit'); return r } catch (e) { await c.query('rollback').catch(() => {}); throw e }
}

/** An agent principal of the org by id or (case-insensitive, unique) display name. */
async function resolveAgent(c, org, ref) {
  const r = String(ref || '').trim()
  if (!r) fail('an agent id or display name is required')
  const rows = (await c.query(`select agent_id, display_name, status, credential_digest is not null as has_own_credential, credential_expires_at
                                 from action_gateway.agent_principals where org_id = $1 and (agent_id = $2 or lower(display_name) = lower($2)) order by agent_id`, [org, r])).rows
  const exact = rows.filter((x) => x.agent_id === r)
  const hit = exact.length ? exact : rows
  if (!hit.length) fail(`no agent principal "${r}" in this org`)
  if (hit.length > 1) fail(`"${r}" names ${hit.length} agent principals; use the agent id`)
  return hit[0]
}

async function serviceRow(c, org, serviceId) {
  if (!SERVICE_ID_RE.test(String(serviceId || ''))) fail('--service-id must be svc_<lowercase, digits, _> (3-41 chars)')
  const s = (await c.query('select service_id, display_name, status, tier_ceiling, credential_expires_at from action_gateway.service_principals where org_id = $1 and service_id = $2', [org, serviceId])).rows[0]
  if (!s) fail(`no service principal ${serviceId} in this org`)
  return s
}

/**
 * Register (or re-enable) one delegate. A delegate WITHOUT a credential of its own (or detached now) is valid exactly as
 * long as the service credential: its registration window is aligned to the service's expiry.
 */
async function addDelegate(c, { org, owner, service, agentRef, detach }) {
  const a = await resolveAgent(c, org, agentRef)
  if (a.status !== 'active') fail(`agent ${a.agent_id} is ${a.status}`)
  await c.query(`insert into action_gateway.service_delegates (service_principal_id, agent_principal_id, org_id, created_by) values ($1, $2, $3, $4)
                 on conflict (service_principal_id, agent_principal_id) do update set enabled = true, disabled_at = null, disabled_by = null`, [service.service_id, a.agent_id, org, owner])
  let own = a.has_own_credential
  if (detach && own) {
    await c.query(`update action_gateway.agent_principals set credential_digest = null, credential_rotated_at = clock_timestamp(), credential_expires_at = $3
                    where org_id = $1 and agent_id = $2`, [org, a.agent_id, service.credential_expires_at])
    own = false
  } else if (!own) {
    await c.query(`update action_gateway.agent_principals set credential_rotated_at = clock_timestamp(), credential_expires_at = $3
                    where org_id = $1 and agent_id = $2`, [org, a.agent_id, service.credential_expires_at])
  }
  const exp = (await c.query('select credential_expires_at from action_gateway.agent_principals where org_id = $1 and agent_id = $2', [org, a.agent_id])).rows[0].credential_expires_at
  return { agent_id: a.agent_id, display_name: a.display_name, enabled: true, own_credential: own, registration_expires_at: new Date(exp).toISOString(),
    ...(own ? { note: 'this agent still holds its own credential; its own expiry also bounds delegated calls (--detach-agent-credentials makes the service the only way in)' } : {}) }
}

/**
 * @param {string[]} argv
 * @param {{ db?: { query: Function, connect?: Function }, out?: (s: string) => void, now?: () => number }} [deps] db: an owner connection (tests inject it)
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(s))
  const { command, one, many, has } = parse(argv)
  const org = String(one('--org') || '')
  const owner = String(one('--owner') || '')
  if (!UUID_RE.test(org) || !UUID_RE.test(owner)) fail(`--org and --owner must be uuids; ${USAGE}`)
  const resolve = (p) => path.resolve(String(p).replace(/^~(?=\/)/, process.env.HOME || '~'))
  let db = deps.db || null
  let ownClient = null
  if (!db) {
    const f = one('--database-url-file')
    if (!f) fail(USAGE)
    if (inside(resolve(f))) fail('--database-url-file must be outside the repository')
    const url = readCredentialFile(resolve(f), '--database-url-file')
    const pg = (await import('pg')).default
    ownClient = new pg.Client({ connectionString: url })
    await ownClient.connect()
    db = ownClient
  }
  try {
    return await withClient(db, async (c) => {
      if (command === 'list') {
        const sid = one('--service-id')
        if (sid && !SERVICE_ID_RE.test(sid)) fail('--service-id must be svc_<name>')
        const services = (await c.query(`select s.service_id, s.display_name, s.status, s.tier_ceiling, s.sponsor_user_id, s.credential_expires_at, s.created_at, s.revoked_at,
                                                coalesce((select json_agg(json_build_object('agent_id', d.agent_principal_id, 'enabled', d.enabled, 'disabled_at', d.disabled_at) order by d.agent_principal_id)
                                                            from action_gateway.service_delegates d where d.service_principal_id = s.service_id), '[]'::json) delegates
                                           from action_gateway.service_principals s where s.org_id = $1 and ($2::text is null or s.service_id = $2) order by s.service_id`, [org, sid || null])).rows
        out(`${JSON.stringify({ org, services })}\n`)
        return 0
      }
      if (command === 'create') {
        const serviceId = String(one('--service-id') || '')
        if (!SERVICE_ID_RE.test(serviceId)) fail('--service-id must be svc_<lowercase, digits, _> (3-41 chars)')
        const sponsor = String(one('--sponsor') || '')
        if (!UUID_RE.test(sponsor)) fail('--sponsor must be the accountable operator\'s user uuid')
        const ceiling = Number(one('--tier-ceiling'))
        if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 4) fail('--tier-ceiling must be 1-4 (T1 internal, T2 operational, T3 seller-facing, T4 financial)')
        const days = Number(one('--days') ?? MAX_DAYS)
        if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) fail(`--days must be an integer 1-${MAX_DAYS}`)
        const display = String(one('--display-name') || serviceId)
        if (!DISPLAY_RE.test(display)) fail('--display-name: letters, digits, space . _ ( ) - (1-80)')
        const pepperFile = one('--pepper-file')
        if (!pepperFile) fail('--pepper-file is required (the SAME 0600 file the Action MCP server reads)')
        const pepper = readCredentialFile(resolve(pepperFile), '--pepper-file')
        for (const d of many('--delegate')) if (!AGENT_ID_RE.test(d) && !DISPLAY_RE.test(d)) fail(`--delegate "${d}" is neither an agent id nor a display name`)
        const { token, digest } = mintServiceCredential(pepper)
        const summary = await tx(c, async () => {
          const s = (await c.query(`insert into action_gateway.service_principals (service_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, created_by)
                                    values ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8) returning service_id, display_name, tier_ceiling, credential_expires_at`,
          [serviceId, org, display, sponsor, digest, days, ceiling, owner])).rows[0]
          const delegates = []
          for (const d of many('--delegate')) delegates.push(await addDelegate(c, { org, owner, service: s, agentRef: d, detach: has('--detach-agent-credentials') }))
          return { created: true, service_id: s.service_id, display_name: s.display_name, tier_ceiling: `T${s.tier_ceiling}`, credential_expires_at: new Date(s.credential_expires_at).toISOString(), delegates,
            header: 'X-LC-Acting-Agent: <agent id of a delegate>', authorization: 'Bearer <the credential below>' }
        })
        out(`${JSON.stringify(summary)}\n`)
        out(`${WARNING}\n`)
        out(`${token}\n`)
        return 0
      }
      const service = await serviceRow(c, org, one('--service-id'))
      if (command === 'add-delegate') {
        if (service.status !== 'active') fail(`service ${service.service_id} is ${service.status}`)
        const d = await tx(c, () => addDelegate(c, { org, owner, service, agentRef: one('--add-delegate'), detach: has('--detach-agent-credentials') }))
        out(`${JSON.stringify({ service_id: service.service_id, delegate: d })}\n`)
        return 0
      }
      if (command === 'disable-delegate') {
        const a = await resolveAgent(c, org, one('--disable-delegate'))
        const r = await c.query(`update action_gateway.service_delegates set enabled = false, disabled_at = now(), disabled_by = $3
                                  where service_principal_id = $1 and agent_principal_id = $2 and enabled returning agent_principal_id`, [service.service_id, a.agent_id, owner])
        out(`${JSON.stringify({ service_id: service.service_id, agent_id: a.agent_id, disabled: r.rowCount === 1, ...(r.rowCount ? {} : { note: 'not an enabled delegate of this service' }) })}\n`)
        return 0
      }
      // revoke
      if (service.status === 'revoked') { out(`${JSON.stringify({ service_id: service.service_id, revoked: true, already: true })}\n`); return 0 }
      await c.query(`update action_gateway.service_principals set status = 'revoked', revoked_at = now(), revoked_by = $3 where org_id = $1 and service_id = $2`, [org, service.service_id, owner])
      out(`${JSON.stringify({ service_id: service.service_id, revoked: true })}\n`)
      return 0
    })
  } finally {
    if (ownClient) await ownClient.end().catch(() => {})
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (e) => { process.stderr.write(`mint-service-credential: ${e.message}\n`); process.exitCode = 2 })
}
