// What would have REACHED A SELLER in a blind evaluation of the agent writer: every text the agntei employee attempted
// goes through (1) agntei Communications' own content refusals that apply before LeadCommand (an empty text; a second
// immediate text to the same contact from one work item) and (2) LeadCommand's deterministic agent-text gate
// (validateAgentText — the same function queue_agent_text runs at request time and in the worker), plus the contact's
// eligibility (an ineligible contact is refused before any content check). No model, no database, nothing sent.
//
// Usage: node --import ./tests/register-aliases.mjs tests/ohg/agent-text-gate-eval.mjs <results.json> <out.json>
import fs from 'node:fs'
import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'

const [inFile, outFile] = process.argv.slice(2)
const run = JSON.parse(fs.readFileSync(inFile, 'utf8'))
const COMPANY = normalizeCompanyIdentity(JSON.stringify({ name: 'Reivesti Home Buyers', website: null, human_review: false, persona_descriptor: null }))
const PURPOSE = (p, first) => (first ? 'first_touch' : /qualif|answer|reply/i.test(p ?? '') ? 'reply' : /follow/i.test(p ?? '') ? 'followup' : /nurture/i.test(p ?? '') ? 'nurture' : /negotiat/i.test(p ?? '') ? 'negotiation' : /schedul|appoint/i.test(p ?? '') ? 'appointment' : 'reengage')
const rows = []
for (const r of run.results) {
  const messages = (r.thread || []).map((m) => ({ id: m.message_id, direction: m.direction, body: m.body, at: m.at }))
  let passedOne = false
  const verdicts = []
  for (const a of r.attempted || []) {
    const body = String(a.body ?? '')
    const first = String(a.to ?? '').startsWith('lc:target:')
    let v
    if (body.replace(/[^\p{L}\p{N}]/gu, '').length < 4) v = { reaches: false, by: 'agntei', code: 'empty-message' }
    else if (passedOne) v = { reaches: false, by: 'agntei', code: 'one-message-per-turn' }
    else if (!r.eligible) v = { reaches: false, by: 'LeadCommand', code: 'CONTACT_SUPPRESSED' }
    else {
      const g = validateAgentText(body, { purpose: PURPOSE(a.purpose, first), messages, policy: { languages: ['en'] }, companyIdentity: COMPANY, authorEmployee: 'Nova', now: run.ran_at })
      v = g.ok ? { reaches: true, by: null, code: null } : { reaches: false, by: 'LeadCommand', code: g.code || 'CONTENT_REJECTED', reasons: g.reasons }
    }
    if (v.reaches) passedOne = true
    verdicts.push({ body, ...v })
  }
  rows.push({ id: r.id, expected: r.expected, attempted: verdicts.length, reached: verdicts.filter((v) => v.reaches).map((v) => v.body), verdicts })
  console.log(`${r.id} ${r.expected.padEnd(20)} attempted ${verdicts.length} → reaches ${verdicts.filter((v) => v.reaches).length}  ${verdicts.map((v) => (v.reaches ? 'PASS' : `${v.by}:${v.code}${v.reasons ? `[${v.reasons.slice(0, 3).join(',')}]` : ''}`)).join(' | ')}`)
}
fs.writeFileSync(outFile, JSON.stringify({ gated_at: new Date().toISOString(), source: inFile, scenarios_sha256: run.scenarios_sha256, gate: 'agntei Communications content refusals + LeadCommand validateAgentText (agent-text-validator.v1) + contact eligibility', rows }, null, 1))
