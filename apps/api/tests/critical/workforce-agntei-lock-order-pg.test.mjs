// Workforce × Agntei — LOCK ORDER (found by the first cross-platform milestone E2E: an external claim answered
// DOMAIN_WRITE_FAILED / SQLSTATE 40P01 while the Workforce dispatch pass ran). On a DISPOSABLE PostgreSQL 17:
//   the dispatch pass locks assignment rows (FOR UPDATE: dependency promotion, the reaper, the lease) and then writes
//   events / resource claims whose foreign keys take KEY SHARE on the assignee's employee row;
//   the gateway's Workforce writer locked the acting employee FOR UPDATE first and then the assignment.
// FOR UPDATE conflicts with KEY SHARE: the two orders deadlocked. The writer now locks the employee FOR NO KEY UPDATE
// (it still serializes one principal's writes; a foreign-key check never waits on it), so the interleaving below
// completes on both sides.
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { agnteiWorld, registerAgnteiAgent, wfGateway, agentSession, missionWith, ORG } from '../helpers/workforce-agntei-pg.mjs'

const skip = pgAvailable() ? false : skipReason
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('PG lock order: an external claim and a dispatch-style writer (assignment FOR UPDATE, then an event naming the employee) never deadlock', { skip }, async () => {
  const env = await agnteiWorld()
  const t2 = new pg.Client({ connectionString: env.url })
  try {
    const reg = await registerAgnteiAgent(env)
    const s = agentSession(wfGateway(env), reg.token)
    assert.equal((await s.call('workforce_link_self', { client_request_id: s.id('link'), external_install_id: 'inst_a1b2c3d4e5f6', external_agent_id: 'agent_scout01' })).code, 'LINKED')
    const { mission, a } = await missionWith(env, [{ step: 'res.c01', assignee: 'emp_scout', capability: 'research.property', input: { property_ref: 'pid_ghijk', force: true }, resource_type: 'property', resource_key: 'pid_ghijk' }])
    const id = a['res.c01'].assignment_id
    await t2.connect()
    await t2.query('begin')
    await t2.query('select assignment_id from workforce.assignment where assignment_id = $1 for update', [id]) // the dispatch pass holds the row
    const claim = s.call('workforce_claim_assignment', { client_request_id: 'lock-order-claim-01', assignment_id: id })
    // the claim is now waiting on that row (with the employee already locked by the writer)
    for (let i = 0; i < 100; i += 1) {
      const w = await env.owner.query("select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%action_gateway_dw_workforce%'")
      if (w.rows[0].n > 0) break
      await sleep(50)
    }
    // …and the dispatch pass writes its event (the foreign key takes KEY SHARE on the employee row)
    const ev = await t2.query("select workforce.emit($1, 'wf.assignment.transitioned', $2, $3, 'emp_scout', '{\"from\":\"pending\",\"to\":\"ready\"}'::jsonb) e", [ORG, mission.mission_id, id])
      .then(() => 'written', (e) => `refused:${e.code}`)
    await t2.query(ev === 'written' ? 'commit' : 'rollback')
    const r = await claim
    assert.equal(ev, 'written', 'the dispatch-style writer is never the deadlock victim')
    assert.equal(r.code, 'CLAIMED', `the claim completes after the writer commits (${JSON.stringify(r).slice(0, 300)})`)
  } finally {
    await t2.end().catch(() => {})
    await env.drop()
  }
})
