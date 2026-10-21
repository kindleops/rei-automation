// PERSONA + SENDER CONTINUITY (rc-8.5.20, Phase 2). Pure.
//
// Owner rule (binding): every thread keeps its persona name and its sender number. AI and
// template replies on a thread use the SAME persona and the SAME number the seller already
// knows. One resolver, both origins:
//   persona  the persona already SHOWN on this thread (seller-visible sent / delivered rows:
//            agent_name / metadata.agent_persona / the name the body signed with), through
//            the existing outbound-persona resolver (hotfix 8.4.8). Two different personas
//            shown = CONFLICT ⇒ hold (never auto-switch). None shown ⇒ a reply gives NO name
//            (an AI reply never mints a persona; first touches keep the existing
//            multi-persona distribution, which is the template feeder's job).
//   sender   the thread's sticky number (inbox_thread_state.our_number), else the number the
//            seller just texted (the inbound's "to"), else the last sent row's "from". When the
//            sticky number and the number the seller texted disagree the reply HOLDS: the
//            conversation moved numbers and a human decides which one continues it.
// The model never chooses either value; the composer is TOLD the persona and the validator
// (playbook v2) refuses any other name.
import { personaFromQueueRow, resolveOutboundPersona, shownPersonas } from '../outbound/outbound-persona.js'

export const PERSONA_CONTINUITY_VERSION = 'conv-ai.persona-continuity.v1'

const SHOWN = new Set(['sent', 'delivered'])
const digits = (p) => String(p ?? '').replace(/[^0-9]/g, '').slice(-10)
const e164 = (p) => (digits(p).length === 10 ? `+1${digits(p)}` : null)

/**
 * @param {object} a
 * @param {Array<{ queue_status?: string, agent_name?: string|null, metadata?: object|null, message_body?: string|null, from_phone_number?: string|null, created_at?: string|null }>} a.sentRows thread send_queue rows (any order)
 * @param {{ our_number?: string|null }|null} [a.threadState]
 * @param {string|null} [a.inboundTo]  the number the seller's latest inbound was sent TO
 * @returns {{ ok: boolean, persona_name: string|null, persona_source: string|null, sender_number: string|null, sender_source: string|null, reasons: string[], version: string }}
 */
export function resolveThreadContinuity({ sentRows = [], threadState = null, inboundTo = null, auditedSender = null } = {}) {
  const reasons = []
  const shownRows = (sentRows || []).filter((r) => SHOWN.has(String(r?.queue_status || '').toLowerCase()))
    .sort((a, b) => (Date.parse(b?.created_at || 0) || 0) - (Date.parse(a?.created_at || 0) || 0))
  const personas = shownPersonas(shownRows)
  let persona_name = null
  let persona_source = null
  if (personas.length) {
    const p = resolveOutboundPersona({ thread_persona: personas })
    if (p.ok) { persona_name = p.first_name; persona_source = 'thread_established' } else reasons.push(p.reason || 'persona_unresolved')
  } else {
    persona_source = 'none_established'
  }

  const sticky = e164(threadState?.our_number)
  const texted = e164(inboundTo)
  const lastFrom = e164(shownRows.find((r) => e164(r?.from_phone_number))?.from_phone_number)
  let sender_number = null
  let sender_source = null
  // rc-8.5.21 v4 (rt-sc-05): an AUDITED operator reassignment binds the thread to its target even when the
  // seller replied to the old number (the reassignment event is the authority, never the inbound's To)
  if (sticky && texted && sticky !== texted && e164(auditedSender) === sticky) { sender_number = sticky; sender_source = 'operator_reassignment' }
  else if (sticky && texted && sticky !== texted) reasons.push('sender_number_mismatch')
  else if (sticky) { sender_number = sticky; sender_source = 'thread_sticky' }
  else if (texted) { sender_number = texted; sender_source = 'inbound_to' }
  else if (lastFrom) { sender_number = lastFrom; sender_source = 'last_outbound' }
  else reasons.push('sender_number_unresolved')

  return { ok: reasons.length === 0, persona_name, persona_source, sender_number, sender_source, reasons, version: PERSONA_CONTINUITY_VERSION }
}

/** The persona one queue row carries / signed with (first name), or null. */
export function rowPersonaName(row) {
  return personaFromQueueRow(row || {})?.first_name || null
}

/**
 * Does an outbound (any origin) keep the thread's persona and number?
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkOutboundContinuity({ continuity, fromNumber = null, personaName = null } = {}) {
  const reasons = []
  if (!continuity?.ok) reasons.push(...(continuity?.reasons || ['continuity_unresolved']).map((r) => `continuity:${r}`))
  if (continuity?.sender_number && e164(fromNumber) !== continuity.sender_number) reasons.push('continuity:sender_number_changed')
  const want = String(continuity?.persona_name || '').toLowerCase()
  const got = String(personaName || '').toLowerCase()
  if (got && got !== want) reasons.push(want ? 'continuity:persona_changed' : 'continuity:persona_not_established')
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] }
}
