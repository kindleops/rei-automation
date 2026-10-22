// Findings of the LIVE Claude Code milestone (2026-10-22), on a DISPOSABLE PostgreSQL 17 through the REAL Action Gateway:
//   * the claim answers result.claim_attempt (the lease generation) by its own name — a live model passed the gateway
//     envelope's own `attempt` (the intent's) and got LEASE_LOST;
//   * request_research takes an opaque alphanumeric property id (the delegated research names properties by id; the SQL
//     accepted only the pid_ encoding of a numeric id, the Workforce JS accepted both); phone-shaped values stay refused.
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { agnteiWorld, registerAgnteiAgent, wfGateway, agentSession, missionWith, armRuntime, completeJob, jobsOf } from '../helpers/workforce-agntei-pg.mjs'
import { trapTransport } from '../helpers/action-gateway-pg.mjs'

const skip = pgAvailable() ? false : skipReason
const REF = { external_install_id: 'inst_a1b2c3d4e5f6', external_agent_id: 'agent_scout01' }

test('PG live fixes: claim_attempt by name; research on an opaque alphanumeric property id (one job per mission × property); a phone-shaped id refused', { skip }, async () => {
  const trap = trapTransport()
  const env = await agnteiWorld()
  try {
    await armRuntime(env)
    const reg = await registerAgnteiAgent(env, { role_key: 'acquisition_agent', markets: ['dallas_test'] })
    const s = agentSession(wfGateway(env), reg.token)
    assert.equal((await s.call('workforce_link_self', { client_request_id: s.id('link'), ...REF })).code, 'LINKED')
    const { a } = await missionWith(env, [{ step: 'research', assignee: 'emp_scout', capability: 'research.property', input: { mode: 'delegated_review', n: 10, market: 'dallas test', candidates: [{ property_ref: 'SYNDAL-024' }] } }])
    const id = a.research.assignment_id
    const c = await s.call('workforce_claim_assignment', { client_request_id: s.id('claim'), assignment_id: id })
    assert.equal(c.code, 'CLAIMED', JSON.stringify(c))
    assert.equal(c.result.claim_attempt, 0, 'the lease generation, by name')
    assert.notEqual(c.attempt, undefined, 'the envelope also has an attempt (the intent\'s): the reason claim_attempt is named')
    const r = await s.call('workforce_request_research', { client_request_id: 'research-syndal-024', assignment_id: id, claim_attempt: c.result.claim_attempt, property_id: 'SYNDAL-024' })
    assert.equal(r.code, 'RESEARCH_REQUESTED', JSON.stringify(r))
    const jobs = await jobsOf(env)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].input.property_ref, 'SYNDAL-024')
    // the job parks the assignment; once it is done the agent claims again; asking again for the same property is the SAME job
    await completeJob(env, jobs[0].job_id)
    const c2 = await s.call('workforce_claim_assignment', { client_request_id: s.id('claim'), assignment_id: id })
    assert.equal(c2.code, 'CLAIMED', JSON.stringify(c2))
    const again = await s.call('workforce_request_research', { client_request_id: 'research-syndal-024-b', assignment_id: id, claim_attempt: c2.result.claim_attempt, property_id: 'SYNDAL-024' })
    assert.equal(again.code, 'RESEARCH_REQUESTED', JSON.stringify(again))
    assert.equal(again.result.job_id, jobs[0].job_id)
    assert.equal(again.result.deduped, true)
    assert.equal((await jobsOf(env)).length, 1, 'one job per mission × property')
    // a phone-shaped value is never a property ref: the payload guard refuses it before the writer would (PROPERTY_REQUIRED)
    const c3 = await s.call('workforce_claim_assignment', { client_request_id: s.id('claim'), assignment_id: id })
    const bad = await s.call('workforce_request_research', { client_request_id: 'research-bad-0001', assignment_id: id, claim_attempt: c3.result?.claim_attempt ?? c2.result.claim_attempt, property_id: 'A2145551234' })
    assert.ok(['PARAMS_NOT_STORABLE', 'PROPERTY_REQUIRED'].includes(bad.code ?? bad.error?.code), JSON.stringify(bad))
    assert.equal((await jobsOf(env)).length, 1, 'no job for it')
    // an over-long field: refused (never cut), and the answer says ONLY the listed issue is wrong (a live model dropped its valid
    // findings and evidence on the retry when it was told only "do not match")
    const c4 = await s.call('workforce_claim_assignment', { client_request_id: s.id('claim'), assignment_id: id })
    const tooLong = await s.call('workforce_complete_assignment', { client_request_id: 'complete-too-long-1', assignment_id: id, claim_attempt: c4.result?.claim_attempt ?? 1,
      output: { summary: 'ok', findings: ['SYNDAL-024: ask under the ceiling'], recommendation: 'x'.repeat(1501) }, evidence: [{ type: 'job', id: jobs[0].job_id }] })
    assert.equal(tooLong.error?.code, 'INPUT_INVALID', JSON.stringify(tooLong))
    assert.match(tooLong.error.message, /fix ONLY the listed issues/)
    assert.deepEqual(tooLong.error.details.issues, ['$.output.recommendation: longer than 1500'])
  } finally { await env.drop(); trap.restore(); assert.deepEqual(trap.hits, [], 'no network') }
})
