// A line-oriented stand-in for LeadCommand's queue_agent_text content gate, for evaluations. No model, no database,
// nothing sent. Each stdin line is one request, answered by one stdout line, in order:
//   { op: 'inbound', text }  → LeadCommand's inbound classifier (the same one the webhook runs before any agent sees the
//                              message): { opt_out, compliance_flag, intent }. An opt-out there suppresses the contact.
//   { body, purpose, messages, eligible, property }  → the verdict validateAgentText (the function the gateway runs)
//                              gives, after the contact's eligibility.
import readline from 'node:readline'
import { validateAgentText } from '../../src/lib/domain/conversation-ai/agent-text-validator.js'
import { normalizeCompanyIdentity } from '../../src/lib/domain/conversation-ai/company-identity.js'
import { classify } from '../../src/lib/domain/classification/classify.js'

const COMPANY = normalizeCompanyIdentity(JSON.stringify({ name: process.env.GATE_COMPANY || 'Reivesti Home Buyers', website: null, human_review: false, persona_descriptor: null, practices: [] }))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
async function answer(line) {
  let q; try { q = JSON.parse(line) } catch { return out({ ok: false, code: 'BAD_REQUEST' }) }
  if (q.op === 'inbound') {
    const c = await classify(String(q.text ?? ''), {})
    return out({ opt_out: c?.compliance_flag === 'stop_texting' || c?.primary_intent === 'opt_out', compliance_flag: c?.compliance_flag ?? null, intent: c?.primary_intent ?? null })
  }
  if (q.eligible === false) return out({ ok: false, code: 'CONTACT_SUPPRESSED', reasons: ['contact:suppressed'] })
  const g = validateAgentText(String(q.body ?? ''), { purpose: q.purpose, messages: q.messages || [], policy: { languages: ['en'] }, companyIdentity: COMPANY, authorEmployee: q.author || 'Nova', now: q.now, property: q.property || null })
  return out({ ok: g.ok, code: g.code, reasons: g.reasons })
}
let chain = Promise.resolve()
readline.createInterface({ input: process.stdin }).on('line', (line) => { chain = chain.then(() => answer(line)).catch((e) => out({ ok: false, code: 'GATE_ERROR', reasons: [String(e?.message ?? e)] })) })
