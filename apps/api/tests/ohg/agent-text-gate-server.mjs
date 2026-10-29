// A line-oriented stand-in for LeadCommand's queue_agent_text content gate, for evaluations: each stdin line is
// { body, purpose, messages, eligible } and each stdout line is the verdict validateAgentText (the same function the
// gateway runs) gives, plus the contact's eligibility. No model, no database, nothing sent.
import readline from 'node:readline'
import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'

const COMPANY = normalizeCompanyIdentity(JSON.stringify({ name: process.env.GATE_COMPANY || 'Reivesti Home Buyers', website: null, human_review: false, persona_descriptor: null, practices: [] }))
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let q; try { q = JSON.parse(line) } catch { process.stdout.write(JSON.stringify({ ok: false, code: 'BAD_REQUEST' }) + '\n'); return }
  if (q.eligible === false) { process.stdout.write(JSON.stringify({ ok: false, code: 'CONTACT_SUPPRESSED', reasons: ['contact:suppressed'] }) + '\n'); return }
  const g = validateAgentText(String(q.body ?? ''), { purpose: q.purpose, messages: q.messages || [], policy: { languages: ['en'] }, companyIdentity: COMPANY, authorEmployee: q.author || 'Nova', now: q.now, property: q.property || null })
  process.stdout.write(JSON.stringify({ ok: g.ok, code: g.code, reasons: g.reasons }) + '\n')
})
