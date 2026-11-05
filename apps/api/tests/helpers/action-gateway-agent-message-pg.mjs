// Disposable-PostgreSQL world for link #32 (queue_agent_message): t34Db (#26 → #27 → #28) + #29 (OHG) + #31 (standing
// reply) + the ledger kind (PROPOSED_20261029090000) + the campaign / template baseline + link #32.
// AGENT_PG_TEST_DB_URL must name a LOCAL scratch server (agent-pg-harness refuses anything else).
import path from 'node:path'
import { applyInTransaction, runSqlFile, REPO_DIR } from '../pg/agent-pg-harness.mjs'
import { t34Db } from './action-gateway-t34-pg.mjs'
import { MIG } from './action-gateway-pg.mjs'

export const OHG_LINK = MIG('PROPOSED_20261027120000_action_gateway_ohg.sql')
export const STANDING_LINK = MIG('PROPOSED_20261028100000_action_gateway_standing_reply.sql')
export const LEDGER_LINK = MIG('PROPOSED_20261029090000_ai_generated_outbound.sql')
export const LEDGER_ROLLBACK = MIG('PROPOSED_20261029090000_ai_generated_outbound_rollback.sql')
export const AM_LINK = MIG('PROPOSED_20261029100000_action_gateway_agent_message.sql')
export const AM_ROLLBACK = MIG('PROPOSED_20261029100000_action_gateway_agent_message_rollback.sql')
export const AM_BASELINE = path.join(REPO_DIR, 'mcp/leadcommand-action-mcp/migrations/test/action_gateway_agent_message_baseline.sql')

export async function agentMessageDb({ apply = true, ohg = true } = {}) {
  const env = await t34Db()
  try {
    if (ohg) await applyInTransaction(env.owner, OHG_LINK)
    await applyInTransaction(env.owner, STANDING_LINK)
    await applyInTransaction(env.owner, LEDGER_LINK)
    await runSqlFile(env.owner, AM_BASELINE)
    if (apply) await applyInTransaction(env.owner, AM_LINK)
    return env
  } catch (e) {
    await env.db.drop().catch(() => {})
    throw e
  }
}
