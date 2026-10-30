// QUEUE-RUNNER GATE: ONE VOICE ON AN AGENT-HELD LEAD (link #32; independent review 2026-10-30). While an Agntei employee
// holds a lead, the conversation is that agent's: an AUTOMATED template row for the thread (a campaign touch, a template
// follow-up or auto-reply — message_origin 'template' or unset) is cancelled, so the seller never gets a template and an
// agent text on the same day. An operator's manual send ('operator_manual') is a person's decision and passes; AI rows
// have their own gates (the AI reply gate cancels LeadCommand's, the agent-text gate judges the agent's).
//   no thread key / link #32 absent (nobody can hold a lead)   → applies: false (unchanged)
//   the holder unreadable                                        → DEFER (fail closed)
//   an agent holds the lead                                      → CANCEL template_row_lead_held_by_agent
import { isAgentTextRow } from '@/lib/domain/queue/agent-text-row-gate.js'

const clean = (v) => String(v ?? '').trim()
const PASS_ORIGINS = new Set(['operator_manual', 'ai_generated'])

export async function evaluateAgentHeldTemplateRowGate(row = {}, { readHolder } = {}) {
  if (isAgentTextRow(row) || PASS_ORIGINS.has(clean(row.message_origin)) || !clean(row.thread_key) || typeof readHolder !== 'function') return { applies: false }
  let h
  try { h = await readHolder(clean(row.thread_key)) } catch { h = { read_failed: true } }
  if (!h || h.read_failed) return { applies: true, action: 'defer', reason: 'template_row_lead_holder_unreadable' }
  if (h.link_absent || !clean(h.agent_id)) return { applies: false }
  return { applies: true, action: 'cancel', reason: 'template_row_lead_held_by_agent' }
}
