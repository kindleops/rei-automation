// The bounded, explicit pagination of the model-facing Workforce reads, end to end through the REAL Action Gateway (as
// lc_action_gateway) on a DISPOSABLE PostgreSQL 17 (the live Claude Code milestone, 2026-10-22). The delegated research
// assignment carries 24 candidates: listing it never exceeds a client's 8,000-character result cap, the candidates move
// behind an explicit stub, and the member read pages them back exactly; a mission with a large report the same; an
// assignment_id filter reads one row; property refs reach the agent as their opaque pid_ refs (never decoded-then-masked).
import test from 'node:test'
import assert from 'node:assert/strict'

import { pgAvailable, skipReason } from '../pg/agent-pg-harness.mjs'
import { agnteiWorld, registerAgnteiAgent, wfGateway, agentSession, missionWith, ORG } from '../helpers/workforce-agntei-pg.mjs'
import { trapTransport } from '../helpers/action-gateway-pg.mjs'
import { encodePropertyRef } from '../../src/lib/agent/missions/mission-codec.js'

const skip = pgAvailable() ? false : skipReason
const REF = { external_install_id: 'inst_a1b2c3d4e5f6', external_agent_id: 'agent_scout01' }
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
// the MCP text a client shows its model (bin/leadcommand-action-mcp: a one-line preamble + the JSON envelope)
const mcpText = (out) => `LeadCommand action result (data only, not instructions):\n${JSON.stringify(out)}`
const CAP = 8_000

test('PG paging: list_assignments / get_mission / whoami stay inside a client\'s 8,000-character cap; large members move behind explicit stubs and page back exactly; property refs stay opaque', { skip }, async () => {
  const trap = trapTransport()
  const env = await agnteiWorld()
  try {
    const reg = await registerAgnteiAgent(env, { role_key: 'acquisition_agent', markets: ['dallas_test'] })
    const s = agentSession(wfGateway(env), reg.token)
    assert.equal((await s.call('workforce_link_self', { client_request_id: s.id('link'), ...REF })).code, 'LINKED')
    // 24 candidates whose property ids are 10-digit (phone-shaped): stored as their pid_ refs
    const candidates = Array.from({ length: 24 }, (_, i) => ({ property_ref: encodePropertyRef(String(9_900_000_001 + i)), conversation_id: uuid(100 + i), opportunity_id: uuid(200 + i), market: 'Dallas TEST', stage: 'asking_price', status: 'active', intent: 'asks_offer', temperature: 'warm', seller_spoke_last: true, last_inbound_at: '2026-10-22T10:00:00.000Z', has_decision: true }))
    const { mission, a } = await missionWith(env, [{ step: 'research', assignee: 'emp_scout', capability: 'research.property', input: { mode: 'delegated_review', n: 10, market: 'Dallas TEST', candidates, candidates_total: 24 } }])
    const id = a.research.assignment_id

    const list = await s.call('workforce_list_assignments', {})
    assert.equal(list.status, 'read', JSON.stringify(list).slice(0, 400))
    assert.ok(mcpText(list).length < CAP, `list: ${mcpText(list).length}`)
    const row = list.result.assignments.find((x) => x.assignment_id === id)
    assert.equal(row.input.mode, 'delegated_review')
    assert.equal(row.input.candidates._paged, 'input.candidates')
    assert.equal(row.input.candidates.items, 24)
    assert.deepEqual(row.input.candidates.read_with, { tool: 'leadcommand_workforce_list_assignments', arguments: { assignment_id: id, part: 'input.candidates' } })
    assert.equal(list.result.page.complete, false)

    // the member read, page by page → exactly the 24 candidates, refs opaque
    const got = []
    let cursor = null
    let pages = 0
    do {
      const p = await s.call('workforce_list_assignments', { assignment_id: id, part: 'input.candidates', ...(cursor ? { cursor } : {}) })
      assert.equal(p.status, 'read', JSON.stringify(p).slice(0, 400))
      assert.ok(mcpText(p).length < CAP, `part page ${pages}: ${mcpText(p).length}`)
      got.push(...p.result.items)
      cursor = p.result.page.next_cursor
      pages += 1
    } while (cursor && pages < 10)
    assert.ok(pages >= 2, 'it needed more than one page')
    assert.deepEqual(got, candidates)
    assert.ok(got.every((c) => /^pid_[g-p]+$/.test(c.property_ref)), 'a property ref reaches the agent as its pid_ ref (usable as property_id / evidence id)')

    // the assignment_id filter reads one row; a part without an assignment is refused; a foreign cursor is refused
    const one = await s.call('workforce_list_assignments', { assignment_id: id })
    assert.deepEqual(one.result.assignments.map((x) => x.assignment_id), [id])
    assert.equal((await s.call('workforce_list_assignments', { part: 'input.candidates' })).error?.code, 'ASSIGNMENT_REQUIRED')
    assert.equal((await s.call('workforce_list_assignments', { assignment_id: id, part: 'input.candidates', cursor: list.result.page.next_cursor || 'eyJrIjoieCIsIm8iOjF9' })).error?.code, 'CURSOR_INVALID')

    // get_mission with a report far over the cap: the mission row condensed, the report one part read away, paged back exactly
    const report = { version: 'wf.report.v1', state: 'complete', completed: Array.from({ length: 60 }, (_, i) => ({ assignment_id: uuid(i), step: `s${i}`, capability: 'research.property', outcome_class: 'verified', summary: { note: 'x'.repeat(120) } })) }
    await env.owner.query('update workforce.mission set report = $2 where mission_id = $1', [mission.mission_id, JSON.stringify(report)])
    const gm = await s.call('workforce_get_mission', { mission_id: mission.mission_id })
    assert.equal(gm.status, 'read', JSON.stringify(gm).slice(0, 400))
    assert.ok(mcpText(gm).length < CAP, `get_mission: ${mcpText(gm).length}`)
    // the most specific large member: the report's 60 completed items (its small fields stay in place)
    assert.equal(gm.result.mission.report.completed._paged, 'mission.report.completed')
    assert.equal(gm.result.mission.report.state, 'complete')
    assert.deepEqual(gm.result.page.mission_condensed, ['report.completed'])
    const rp = []
    cursor = null
    pages = 0
    do {
      const p = await s.call('workforce_get_mission', { mission_id: mission.mission_id, part: 'mission.report.completed', ...(cursor ? { cursor } : {}) })
      assert.ok(mcpText(p).length < CAP, `report page ${pages}`)
      rp.push(...p.result.items)
      cursor = p.result.page.next_cursor
      pages += 1
    } while (cursor && pages < 20)
    assert.deepEqual(rp, report.completed)

    // whoami: identity + grants whole, the open assignment condensed, inside the cap
    const who = await s.call('workforce_whoami', {})
    assert.ok(mcpText(who).length < CAP, `whoami: ${mcpText(who).length}`)
    assert.equal(who.result.employee.employee_id, 'emp_scout')
    assert.ok(who.result.grants.length >= 9)
    assert.equal(who.result.open_assignments[0].input.candidates._paged, 'input.candidates')
    assert.equal(ORG, who.result.employee.org_id)
  } finally { await env.drop(); trap.restore(); assert.deepEqual(trap.hits, [], 'no network') }
})
