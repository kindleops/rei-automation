// Disposable-PostgreSQL world for the service principals link (PROPOSED_20261105120000_action_gateway_service_principals):
// the record-sync chain (#26 to link 10) + the campaign baseline + this link. AGENT_PG_TEST_DB_URL must name a LOCAL
// scratch server (agent-pg-harness refuses anything else).
import path from 'node:path'
import { applyInTransaction, runSqlFile, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { recordSyncDb } from './record-sync-pg.mjs'
import { MIG, PEPPER, ORG, OWNER, OPERATOR } from './action-gateway-pg.mjs'
import { mintServiceCredential } from '../../src/lib/domain/action-gateway/credentials.js'

export const SP_LINK = MIG('PROPOSED_20261105120000_action_gateway_service_principals.sql')
export const SP_ROLLBACK = MIG('PROPOSED_20261105120000_action_gateway_service_principals_rollback.sql')
export const SP_BASELINE = path.join(REPO_DIR, 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_service_principals_baseline.sql')

export async function servicePrincipalDb({ apply = true } = {}) {
  const env = await recordSyncDb()
  try {
    await runSqlFile(env.owner, SP_BASELINE)
    if (apply) await applyInTransaction(env.owner, SP_LINK)
    return env
  } catch (e) {
    await env.db.drop().catch(() => {})
    throw e
  }
}

/** Register a service principal (owner path) and its delegates; returns its credential (shown once). */
export async function registerService(owner, { service_id = 'svc_agntei', org = ORG, sponsor = OPERATOR, created_by = OWNER, tier_ceiling = 2, delegates = [], expiresDays = 30 } = {}) {
  const { token, digest } = mintServiceCredential(PEPPER)
  await owner.query(`insert into action_gateway.service_principals (service_id, org_id, display_name, sponsor_user_id, credential_digest, credential_expires_at, tier_ceiling, created_by)
                     values ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8)`, [service_id, org, `Service ${service_id}`, sponsor, digest, expiresDays, tier_ceiling, created_by])
  for (const a of delegates) await owner.query('insert into action_gateway.service_delegates (service_principal_id, agent_principal_id, org_id, created_by) values ($1, $2, $3, $4)', [service_id, a, org, created_by])
  return token
}
