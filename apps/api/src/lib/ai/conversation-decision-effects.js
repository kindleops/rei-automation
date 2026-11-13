// CANONICAL DECISION EFFECTS (rc-8.5.21 v4, S2 / S3 / ownership persistence).
//
// The canonical turn pipeline DECIDED a stop, a possible stop or a property denial but nothing WROTE it:
// the writes lived only on the legacy inbound path (apply-inbound-automation-decision.js), so a decision the
// legacy classifier did not share (the understanding read opt_out; a possible opt-out in a language we do not
// converse in; a denial read against our actual question) left the contact fully contactable and the denial
// invisible to every other planner. This module is the ONE place the canonical decision's protective effects
// are written, through the EXISTING writers (no new table, no new writer of those tables):
//
//   SUPPRESS mode 'opt_out'         record-phone-suppression.js (sms_suppression_list, fail closed +
//                                   automation_suppressions fallback + critical alert)
//   SUPPRESS mode 'precautionary'   record-precautionary-hold.js (automation_suppressions
//                                   precautionary_no_contact, contact-wide, no expiry, operator review)
//   (pending rows: never cancelled from here — this module must reach no queue / send module (static
//    no-send invariant); every pending row is refused at the final send-time contact guard, which reads both
//    tables above, and the legacy inbound path cancels them under compliance_terminal)
//   UPDATE_SELLER_FACTS ownership   contact-resolution-repository.js recordContactOutcome — the ONE writer of
//     denied / former / tenant      contact_property_resolution, property × contact only (never the phone,
//     (persist: true)               never global; a wrong number is the inbound path's phone outcome)
//
// Idempotent: every writer upserts / dedupes per inbound. FAIL CLOSED: a protective write that fails with no
// fallback block throws DECISION_EFFECT_WRITE_FAILED (the runtime retries the job; nothing is sent meanwhile —
// the turn never reaches a dispatcher for a SUPPRESS decision).
import { decisionEffectsOf } from '@/lib/domain/conversation-ai/decision-effects-plan.js'

export { decisionEffectsOf }

export const DECISION_EFFECTS_VERSION = 'conv-ai.decision-effects.v1'
const clean = (v) => String(v ?? '').trim()

async function defaultWriters() {
  const [{ recordPhoneSuppression }, { recordPrecautionaryNoContactHold }, { recordContactOutcome }] = await Promise.all([
    import('@/lib/domain/compliance/record-phone-suppression.js'),
    import('@/lib/domain/compliance/record-precautionary-hold.js'),
    import('@/lib/domain/seller-flow/contact-resolution-repository.js'),
  ])
  return {
    suppress: (a) => recordPhoneSuppression(a),
    precautionary: (a) => recordPrecautionaryNoContactHold(a),
    ownership: (supabase, a) => recordContactOutcome(supabase, a),
  }
}

/**
 * @param {object} a
 * @param {object} a.supabase
 * @param {object} a.record            decideAndCompose() result
 * @param {string} a.sellerPhone       the inbound's from number (the contact)
 * @param {string} a.threadKey
 * @param {string} a.inboundEventId    message_events.id of the decided inbound
 * @param {string|null} [a.inboundReceivedAt]
 * @param {object} [deps]              { writers } (tests inject)
 * @returns {Promise<{ version: string, ok: boolean, effects: Array<{ kind: string, ok: boolean, reason?: string|null }> }>}
 */
export async function applyCanonicalDecisionEffects({ supabase, record, sellerPhone, threadKey, inboundEventId, inboundReceivedAt = null }, deps = {}) {
  const planned = decisionEffectsOf(record)
  const out = { version: DECISION_EFFECTS_VERSION, ok: true, effects: [] }
  if (!planned.length) return out
  const w = deps.writers || (await defaultWriters())
  for (const e of planned) {
    if (e.kind === 'opt_out') {
      const r = await w.suppress({ supabase, phone: sellerPhone, reason: 'opt_out', source: 'conversation_turn_opt_out', threadKey })
      const ok = Boolean(r?.ok || r?.fallback_block)
      out.effects.push({ kind: e.kind, ok, reason: r?.ok ? null : r?.reason || 'suppression_failed' })
      if (!ok) throw Object.assign(new Error('DECISION_EFFECT_WRITE_FAILED'), { code: 'DECISION_EFFECT_WRITE_FAILED', effect: e.kind })
    } else if (e.kind === 'precautionary_no_contact') {
      const ev = e.evidence || {}
      const r = await w.precautionary({ supabase, phone: sellerPhone, threadKey, inboundEventId, evidence: { rule_id: ev.rule_id || (ev.sources || [])[0] || null, language: ev.language || null, token: ev.token || null, version: ev.version || null } })
      out.effects.push({ kind: e.kind, ok: Boolean(r?.ok), reason: r?.ok ? null : r?.reason || 'precautionary_hold_failed' })
      if (!r?.ok) throw Object.assign(new Error('DECISION_EFFECT_WRITE_FAILED'), { code: 'DECISION_EFFECT_WRITE_FAILED', effect: e.kind })
    } else if (e.kind === 'property_denial') {
      const r = await w.ownership(supabase, { property_id: e.property_id, contact_phone_e164: sellerPhone, outcome: e.outcome, rejection_reason: `canonical_turn:${e.basis || 'ownership_denied'}`.slice(0, 120), source_message_id: inboundEventId, source_thread_key: threadKey })
      out.effects.push({ kind: e.kind, ok: Boolean(r?.ok), property_id: e.property_id, outcome: e.outcome, reason: r?.ok ? null : r?.reason || 'resolution_write_failed' })
      if (!r?.ok) throw Object.assign(new Error('DECISION_EFFECT_WRITE_FAILED'), { code: 'DECISION_EFFECT_WRITE_FAILED', effect: e.kind })
    }
  }
  out.ok = out.effects.every((x) => x.ok)
  return out
}
