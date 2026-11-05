// Test helper (rc-8.5.21): the CANONICAL decision record (runtime/canonical.js#decideAndCompose
// output shape) for an R1-shaped judgment + text, so executor tests can drive R3 with exactly the
// record a conversation.turn decision hands it.
import { CANONICAL_VERSIONS } from '../../src/lib/domain/conversation-ai/runtime/canonical.js'

// the canonical record a turn decision produces for an R1-shaped judgment + text (test adapter)
const OBJ = { confirm_ownership: 'ownership', gauge_interest: 'interest', get_asking_price: 'asking_price', get_condition: 'condition', clarify_identity: 'ownership' }
export function toRecord(decision, inboundId, { contentReasons = [], decidedAt = '2026-10-14T17:00:00.000Z', planActions = null } = {}) {
  const judgment = { intent: decision.intent, seller_interest: decision.seller_interest, outcome: decision.outcome, next_objective: decision.next_objective, confidence: decision.confidence, facts_extracted: decision.facts_extracted || [], source_message_ids: decision.source_message_ids || [] }
  const base = { record_kind: 'conv-ai.canonical-decision', versions: CANONICAL_VERSIONS, caller: 'turn', inbound_message_id: inboundId, decided_at: decidedAt, judgment, cost_usd: 0.0002, composition: { ok: true, model: 'claude-haiku-5-5', usd: 0.0002, playbook_version: CANONICAL_VERSIONS.playbook, prompt_version: CANONICAL_VERSIONS.compose_prompt } }
  if (planActions) { const terminal = planActions.find((x) => ['SUPPRESS', 'NO_RESPONSE', 'HOLD', 'AI_GENERATED_REPLY', 'ESCALATE_TO_OPERATOR'].includes(x.type)); return { ...base, plan: { actions: planActions }, terminal, reply: null, validation: null } }
  if (decision.outcome === 'NO_RESPONSE') { const terminal = { type: 'NO_RESPONSE' }; return { ...base, plan: { actions: [terminal] }, terminal, reply: null, validation: null } }
  if (decision.outcome !== 'REPLY_CANDIDATE' || !decision.proposed_message) { const terminal = { type: 'HOLD', reason: 'test' }; return { ...base, plan: { actions: [terminal] }, terminal, reply: null, validation: null } }
  const category = decision.intent === 'who_is_this' ? 'identity_answer' : decision.intent === 'not_interested' ? 'not_interested_close' : 'next_missing_fact'
  const objective = category === 'not_interested_close' ? 'close_no_question' : OBJ[decision.next_objective] || 'none'
  const terminal = { type: 'AI_GENERATED_REPLY', category, objective }
  const actions = category === 'not_interested_close' ? [{ type: 'SCHEDULE_FOLLOWUP', kind: 'nurture_30_day', days: 30 }, terminal] : [terminal]
  return { ...base, plan: { actions }, terminal, reply: { text: decision.proposed_message, category, objective, send_ready: true }, validation: { status: contentReasons.length ? 'rejected' : 'validated', content_reasons: contentReasons, reasons: contentReasons } }
}

// in-memory stand-in for public.ai_generated_messages (append-only; one per inbound / queue key;
// body hash enforced — the real CHECKs + triggers are proven on a disposable PG17)
import crypto from 'node:crypto'
export function makeAiRecords() {
  const byKey = new Map()
  const events = []
  const sha = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex')
  return {
    byKey, events,
    insert: async (rec) => {
      if (byKey.has(rec.queue_key) || [...byKey.values()].some((r) => r.inbound_message_id === rec.inbound_message_id)) return { ok: false, reason: 'ai_generated_record_exists' }
      if (rec.body_sha256 !== sha(rec.message_body) || rec.message_origin !== 'ai_generated' || /[–—]/.test(rec.message_body)) return { ok: false, reason: 'ai_generated_record_insert_failed' }
      const stored = Object.freeze({ id: crypto.randomUUID(), ...structuredClone(rec) })
      byKey.set(rec.queue_key, stored)
      return { ok: true, id: stored.id, queue_key: rec.queue_key }
    },
    load: async (queueKey) => ({ found: byKey.has(queueKey), read_failed: false, record: byKey.get(queueKey) || null }),
    event: async (e) => { events.push(Object.freeze({ ...e })); return { ok: true } },
  }
}
