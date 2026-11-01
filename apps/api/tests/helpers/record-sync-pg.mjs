// Disposable-PostgreSQL world for link 10 (record sync): the agent-message chain (#26–#28, OHG, standing reply, ledger,
// link 9) + PROPOSED_20261101120000_record_sync. AGENT_PG_TEST_DB_URL must name a LOCAL scratch server.
import { applyInTransaction } from '../pg/agent-pg-harness.mjs'
import { agentMessageDb } from './action-gateway-agent-message-pg.mjs'
import { MIG } from './action-gateway-pg.mjs'

export const RECORD_LINK = MIG('PROPOSED_20261101120000_record_sync.sql')
export const RECORD_ROLLBACK = MIG('PROPOSED_20261101120000_record_sync_rollback.sql')

export async function recordSyncDb({ apply = true } = {}) {
  const env = await agentMessageDb()
  try {
    if (apply) await applyInTransaction(env.owner, RECORD_LINK)
    return env
  } catch (e) {
    await env.db.drop().catch(() => {})
    throw e
  }
}
