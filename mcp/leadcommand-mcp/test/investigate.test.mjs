// The Phase 3 investigation runbook (scripts/investigate-leads.mjs) over FIXTURE data: it drives only the
// gateway's read tools, every report is evidence-cited, masked and private, and the next steps never
// contact a seller who stopped us, denied ownership or is blocked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { connect } from './helpers.mjs'
import { FIXTURE_PHONES } from '../fixtures/dataset.mjs'
import { investigate, reportMarkdown } from '../scripts/investigate-leads.mjs'

const digits = (s) => s.replace(/[^0-9]/g, '')

test('investigation runbook: evidence report per lead, read tools only, no contact values, human next steps', async () => {
  const c = await connect()
  try {
    const out = {}
    for (const id of ['FX1001', 'FX1002', 'FX1003', 'FX2002']) out[id] = await investigate(c.app.gateway, id)
    assert.deepEqual(Object.fromEntries(Object.entries(out).map(([k, o]) => [k, o.next_step.action])), {
      FX1001: 'human_review_blocker', FX1002: 'resolve_unknowns_first', FX1003: 'do_not_contact', FX2002: 'no_conversation_on_record',
    })
    assert.match(out.FX1002.next_step.detail, /Never contact: T1 not_owner/)
    const tools = new Set(c.audit.filter((a) => a.event === 'tool_call').map((a) => a.tool))
    for (const t of tools) assert.match(t, /^leadcommand_(get|search)_/)
    const md = reportMarkdown(out.FX1001, { mode: 'FIXTURE' })
    for (const h of ['## Property', '## Decision Engine', '## Recorded sales nearby', '## Conversation', '## Contact eligibility', '## Recommended next step', '## Uncertainties']) assert.ok(md.includes(h), h)
    assert.match(md, /no message was sent, queued or approved/)
    assert.match(md, /\$185,000 \(seller_ask_candidate, me-a4\)/)
    assert.match(md, /instruction-like/)
    const all = Object.values(out).map((o) => JSON.stringify(o) + reportMarkdown(o, { mode: 'FIXTURE' })).join('\n')
    for (const p of FIXTURE_PHONES) assert.equal(digits(all).includes(digits(p).slice(1)), false)
    assert.doesNotMatch(all, /fixture\.seller@example\.test/)
  } finally { await c.close() }
})
