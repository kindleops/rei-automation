// The agntei service's role-scoped standing grants (docs/AGNTEI-LAUNCH-RECONCILIATION.md section 6), as the org owner
// writes them. Preview (the default) prints the exact SQL and changes nothing. --apply writes them in ONE transaction
// with the owner's database connection (read from a 0600 file, never an argument, never printed), then reads them back.
// No grant carries a sending capability. An agent with no principal yet is registered in the same transaction, with a
// credential of its own that is minted and immediately discarded (only its peppered digest is stored, nobody ever sees
// it); the service mint then detaches it (--detach-agent-credentials), so the service is the only way to act as them.
// Pepper: LC_PEPPER_FILE (0600), the same pepper the gateway runs with.
//   node scripts/agntei-launch/grants.mjs --org <uuid> --owner <owner user uuid> --agents rowan=agt_rowan,reps=agt_cruz+agt_vale,research=agt_scout [--days 30]
//   LC_OWNER_DB_URL_FILE=<0600 file> LC_PEPPER_FILE=<0600 file> node scripts/agntei-launch/grants.mjs ... --apply --confirm GRANT
import fs from 'node:fs'
import pg from 'pg'
import { mintAgentCredential } from '../../apps/api/src/lib/domain/action-gateway/credentials.js'

export const ROLE_GRANTS = Object.freeze({
  rowan: [['records.read', 1], ['records.apply_change', 2], ['campaigns.create_draft', 1], ['campaigns.read', 1], ['acquisitions.update_lead_status', 2]],
  reps: [['records.read', 1], ['records.apply_change', 2], ['acquisitions.update_lead_status', 2]],
  research: [['records.read', 1]],
})
export const ROLE_TIER = Object.freeze({ rowan: 2, reps: 2, research: 1 })
export const SENDING = /^(sms|messages|campaigns\.(launch|schedule|send|resume)|outbound|send)/
export function plan({ org, owner, agents, days = 30, perHour = 60, perDay = 500 }) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID.test(org) || !UUID.test(owner)) throw new Error('--org and --owner are uuids')
  if (!(days >= 1 && days <= 366)) throw new Error('--days is 1 to 366')
  const rows = []
  for (const [role, ids] of Object.entries(agents)) {
    const set = ROLE_GRANTS[role]; if (!set) throw new Error(`unknown role ${role} (rowan | reps | research)`)
    for (const agent of ids) {
      if (!/^agt_[a-z0-9_]{2,40}$/.test(agent)) throw new Error(`agent id ${agent} is not agt_…`)
      for (const [capability, tier] of set) { if (SENDING.test(capability)) throw new Error(`refusing a sending capability: ${capability}`); rows.push({ role, agent, capability, tier }) }
    }
  }
  const values = rows.map((r) => `('${org}', '${r.agent}', '${r.capability}', ${r.tier}, '{}'::jsonb, '{}'::jsonb, ${perHour}, ${perDay}, 0, '${owner}', now(), now() + interval '${days} days')`)
  const sql = `insert into action_gateway.capability_grants (org_id, agent_id, capability, max_tier, scope, envelope, max_uses_per_hour, max_uses_per_day, max_spend_usd_per_day, granted_by, valid_from, expires_at)\nvalues\n  ${values.join(',\n  ')}\non conflict do nothing;`
  return { rows, sql }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2); const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
  const agents = Object.fromEntries(String(opt('agents') ?? '').split(',').filter(Boolean).map((p) => { const [role, ids] = p.split('='); return [role, String(ids ?? '').split('+').filter(Boolean)] }))
  const p = plan({ org: String(opt('org') ?? ''), owner: String(opt('owner') ?? ''), agents, days: Number(opt('days') ?? 30) })
  console.log(`${p.rows.length} standing grants (no sending capability):`)
  for (const r of p.rows) console.log(`  ${r.agent.padEnd(14)} ${r.capability.padEnd(32)} tier ${r.tier}  (${r.role})`)
  if (!argv.includes('--apply')) { console.log('\nPreview only. The SQL that --apply runs in one transaction:\n'); console.log(p.sql); process.exit(0) }
  if (opt('confirm') !== 'GRANT') { console.error('Writing grants is an owner action: add --confirm GRANT.'); process.exit(2) }
  const f = process.env.LC_OWNER_DB_URL_FILE; if (!f) { console.error('Set LC_OWNER_DB_URL_FILE (a 0600 file holding the owner connection string).'); process.exit(2) }
  if ((fs.statSync(f).mode & 0o077) !== 0) { console.error(`${f} must be chmod 600.`); process.exit(2) }
  const pf = process.env.LC_PEPPER_FILE; if (!pf || (fs.statSync(pf).mode & 0o077) !== 0) { console.error('Set LC_PEPPER_FILE to the 0600 pepper file the gateway uses.'); process.exit(2) }
  const pepper = fs.readFileSync(pf, 'utf8').trim(); if (Buffer.byteLength(pepper) < 32) { console.error('the pepper must hold at least 32 bytes'); process.exit(2) }
  const c = new pg.Client({ connectionString: fs.readFileSync(f, 'utf8').trim() }); await c.connect()
  try {
    await c.query('begin')
    const org = String(opt('org')); const owner = String(opt('owner'))
    const roleOf = new Map(p.rows.map((r) => [r.agent, r.role]))
    for (const [agent, role] of roleOf) {
      const has = (await c.query('select 1 from action_gateway.agent_principals where org_id = $1 and agent_id = $2', [org, agent])).rowCount
      if (has) continue
      const { digest } = mintAgentCredential(pepper) // the credential itself is dropped here, never shown or stored
      await c.query(`insert into action_gateway.agent_principals (agent_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, read_scopes, created_by)
                     values ($1, $2, $3, $4, $5, now() + interval '30 days', $6, array['conversation_context.read']::text[], $4)`, [agent, org, agent.replace(/^agt_/, ''), owner, digest, ROLE_TIER[role] ?? 1])
      console.log(`  registered principal ${agent} (tier ceiling ${ROLE_TIER[role] ?? 1}; its own credential discarded)`)
    }
    await c.query(p.sql); await c.query('commit')
    const back = (await c.query(`select agent_id, capability, max_tier, expires_at from action_gateway.capability_grants where org_id = $1 and revoked_at is null and agent_id = any($2) order by agent_id, capability`, [String(opt('org')), [...new Set(p.rows.map((r) => r.agent))]])).rows
    const want = new Set(p.rows.map((r) => `${r.agent}|${r.capability}`)); const have = new Set(back.map((r) => `${r.agent_id}|${r.capability}`))
    const missing = [...want].filter((k) => !have.has(k))
    console.log(missing.length ? `READ-BACK FAILED: missing ${missing.join(', ')}` : `Read back: ${back.length} active grants; every planned grant is present.`)
    process.exit(missing.length ? 1 : 0)
  } catch (e) { await c.query('rollback').catch(() => {}); console.error(`Not written: ${e.message}`); process.exit(1) } finally { await c.end() }
}
