// ─── OPERATOR FEEDBACK (8.5.19, owner directive 2026-10-15 Phase 10) ─────────
// An APPEND-ONLY record of what happened to every AI draft: generated, approved,
// rejected, edited (with the operator's notes), the seller's response, and the
// negotiation / acquisition outcome. PROPOSED table public.ai_operator_feedback.
//
// Linkage: ai_message_id = the 8.5.16 AI message record id (public.ai_generated_messages.id,
// the table the 8.5.16 build is renaming to) and/or decision_id (the conversation
// decision id). No FK: that table ships with 8.5.16.
//
// LEARNING BOUNDARY (binding): nothing here changes production behaviour. Feedback
// is read by the evaluation-set builder only. Prompt / playbook changes are versioned
// PRs reviewed by a human; no code path reads this table to send, route or re-prompt
// (enforced by the static import-graph test).
import { hashCanonical } from '../../agent/runtime/canonical.js'
import { maskText, threadRef } from '../conversation-ai/pii.js'
import { residualContact } from '../../agent/research/pii.js'

export const FEEDBACK_CONTRACT_VERSION = 'ai-feedback.v1'
export const FEEDBACK_KINDS = Object.freeze(['draft_generated', 'draft_approved', 'draft_rejected', 'draft_edited', 'operator_note', 'seller_response', 'negotiation_outcome', 'acquisition_outcome'])
export const REVIEW_KINDS = Object.freeze(['draft_approved', 'draft_rejected', 'draft_edited', 'operator_note'])
/** Rubric labels a reviewer may attach (the eval set's expected values). */
export const LABEL_KEYS = Object.freeze(['expected_intent', 'expected_next_action', 'expected_outcome', 'expected_escalation', 'tone_ok', 'repetition', 'question_useful', 'authorization_ok', 'economic_mismatch', 'facts_ignored', 'reason'])
export const OUTCOME_KEYS = Object.freeze(['seller_replied', 'seller_intent', 'negotiation_status', 'agreed_amount', 'acquisition_stage', 'closed', 'lost_reason'])

const clip = (s, n) => (s == null ? null : String(s).slice(0, n))
const pick = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => keys.includes(k) && v !== undefined && (v === null || ['string', 'number', 'boolean'].includes(typeof v))).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v]))

function maskedOrRefuse(text, names) {
  if (text == null || text === '') return { ok: true, value: null }
  const v = maskText(String(text), { maskNames: names || [] })
  if (residualContact(v)) return { ok: false }
  return { ok: true, value: v }
}

/**
 * Build one feedback row. Throws FEEDBACK_INVALID on a contract violation (the DB
 * re-checks the same rules). Free text is masked (phones, emails, known names).
 */
export function buildFeedbackRow({ kind, ai_message_id = null, decision_id = null, thread_key = null, property_id = null, operator_id = null, draft_text = null, final_text = null, note = null, labels = {}, outcome = {}, model = null, cost_usd = null, mask_names = [], occurred_at = null } = {}) {
  const errors = []
  if (!FEEDBACK_KINDS.includes(kind)) errors.push('kind:enum')
  if (!ai_message_id && !decision_id) errors.push('link:ai_message_id_or_decision_id_required')
  if (REVIEW_KINDS.includes(kind) && !String(operator_id || '').trim()) errors.push('operator_id:required_for_review')
  if (kind === 'draft_edited' && !String(final_text || '').trim()) errors.push('final_text:required_for_edit')
  const d = maskedOrRefuse(clip(draft_text, 640), mask_names)
  const f = maskedOrRefuse(clip(final_text, 640), mask_names)
  const n = maskedOrRefuse(clip(note, 1000), mask_names)
  if (!d.ok || !f.ok || !n.ok) errors.push('text:contact_residue')
  if (cost_usd != null && !(Number(cost_usd) >= 0)) errors.push('cost_usd:range')
  if (errors.length) throw Object.assign(new Error('FEEDBACK_INVALID'), { code: 'FEEDBACK_INVALID', errors })
  const row = {
    contract_version: FEEDBACK_CONTRACT_VERSION,
    kind,
    ai_message_id: ai_message_id ? String(ai_message_id).slice(0, 120) : null,
    decision_id: decision_id ? String(decision_id).slice(0, 160) : null,
    thread_ref: thread_key ? threadRef(thread_key) : null,
    property_id: property_id ? String(property_id).slice(0, 80) : null,
    operator_id: operator_id ? String(operator_id).trim().slice(0, 80) : null,
    draft_text_masked: d.value,
    final_text_masked: f.value,
    note_masked: n.value,
    labels: pick(labels, LABEL_KEYS),
    outcome: pick(outcome, OUTCOME_KEYS),
    model: model ? String(model).slice(0, 80) : null,
    cost_usd: cost_usd == null ? null : Math.round(Number(cost_usd) * 1e6) / 1e6,
  }
  if (occurred_at) row.created_at = new Date(occurred_at).toISOString()
  row.idempotency_key = `fb:${hashCanonical({ k: row.kind, m: row.ai_message_id, d: row.decision_id, o: row.operator_id, t: [row.draft_text_masked, row.final_text_masked, row.note_masked], l: row.labels, x: row.outcome, at: occurred_at || null }).slice(0, 48)}`
  return row
}

/** Supabase store: insert + select only (the table refuses UPDATE / DELETE). */
export function createSupabaseFeedbackStore({ supabase }) {
  const run = async (q) => {
    const r = await q
    if (r?.error) throw Object.assign(new Error('FEEDBACK_TABLES_UNAVAILABLE'), { code: 'FEEDBACK_TABLES_UNAVAILABLE', detail: String(r.error.message || '').slice(0, 160) })
    return Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : []
  }
  return Object.freeze({
    async append(row) { return (await run(supabase.from('ai_operator_feedback').insert(row).select('*')))[0] },
    async listForEval({ since = null, limit = 5000 } = {}) {
      let q = supabase.from('ai_operator_feedback').select('*').order('created_at', { ascending: true }).limit(Math.min(limit, 5000))
      if (since) q = q.gte('created_at', since)
      return run(q)
    },
    async insertEvalSet(row) { return (await run(supabase.from('ai_eval_sets').insert(row).select('*')))[0] },
    async latestEvalSetVersion(name) {
      const r = await run(supabase.from('ai_eval_sets').select('version').eq('name', name).order('version', { ascending: false }).limit(1))
      return r[0] ? Number(r[0].version) : 0
    },
  })
}

/** Memory store with the table's invariants (append-only, unique idempotency key, unique eval-set version). */
export function createMemoryFeedbackStore({ now = () => Date.now() } = {}) {
  const rows = []
  const sets = []
  let n = 0
  const fail = (code) => { throw Object.assign(new Error(code), { code }) }
  return {
    async append(row) {
      if (rows.some((r) => r.idempotency_key === row.idempotency_key)) fail('DUPLICATE_IDEMPOTENCY_KEY')
      const stored = Object.freeze({ feedback_id: `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`, created_at: new Date(now()).toISOString(), ...row })
      rows.push(stored)
      return stored
    },
    async listForEval() { return rows.map((r) => ({ ...r })) },
    async insertEvalSet(row) {
      if (sets.some((s) => s.name === row.name && s.version === row.version)) fail('EVAL_SET_VERSION_EXISTS')
      const stored = Object.freeze({ ...row, created_at: new Date(now()).toISOString() })
      sets.push(stored)
      return stored
    },
    async latestEvalSetVersion(name) { return sets.filter((s) => s.name === name).reduce((m, s) => Math.max(m, s.version), 0) },
    /** Append-only: these exist only so tests can prove they are refused. */
    async update() { fail('APPEND_ONLY') },
    async delete() { fail('APPEND_ONLY') },
    _rows: () => rows.map((r) => ({ ...r })),
  }
}

/** Record one feedback event. */
export async function recordOperatorFeedback(input, { store }) {
  const row = buildFeedbackRow(input)
  const stored = await store.append(row)
  return { ok: true, feedback_id: stored.feedback_id, idempotency_key: row.idempotency_key }
}
