// ─── EVALUATION-SET BUILDER (8.5.19 Phase 10) ─────────────────────────────────
// Pulls REVIEWED feedback into a versioned, held-out evaluation set.
//
//   item        one AI message (ai_message_id, else decision_id) with ≥ 1 operator
//               review (approved / rejected / edited / note). Unreviewed drafts are
//               never included — an unreviewed seller exchange teaches nothing.
//   verdict     the LAST review wins (rejected / edited / approved); notes add labels
//   split       by THREAD (thread_ref), never by message, so one conversation cannot sit in
//               both halves: holdout iff sha256(seed|thread) / 2^32 < holdout_fraction
//   determinism the same feedback rows + name + version + seed ⇒ byte-identical manifest
//               and content_hash, whatever the input order (rows are sorted first)
//
// Stored immutably (PROPOSED public.ai_eval_sets, unique (name, version)). Building a set
// changes nothing in production: the set is an input to offline scoring (rubric.js).
import { canonicalJson, sha256Hex } from '../../agent/runtime/canonical.js'
import { REVIEW_KINDS } from './feedback.js'

export const EVAL_BUILDER_VERSION = 'ai-evalset.v1'
const VERDICT = Object.freeze({ draft_approved: 'approved', draft_rejected: 'rejected', draft_edited: 'edited' })

const itemKey = (r) => (r.ai_message_id ? `m:${r.ai_message_id}` : `d:${r.decision_id}`)
const order = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.idempotency_key || a.feedback_id || '').localeCompare(String(b.idempotency_key || b.feedback_id || ''))

/** Deterministic split bucket in [0, 1). */
export function splitBucket(seed, unit) {
  return parseInt(sha256Hex(`${seed}|${unit}`).slice(0, 8), 16) / 0x100000000
}

/**
 * @param {object} a
 * @param {string} a.name               ^[a-z0-9_]{1,40}$
 * @param {number} a.version            ≥ 1 (the store refuses a duplicate name+version)
 * @param {object[]} a.feedback         ai_operator_feedback rows
 * @param {string} a.seed
 * @param {number} [a.holdout_fraction] (0, 1), default 0.2
 * @param {string} a.created_by
 */
export function buildEvalSet({ name, version, feedback = [], seed, holdout_fraction = 0.2, created_by }) {
  if (!/^[a-z0-9_]{1,40}$/.test(String(name || ''))) throw Object.assign(new Error('EVAL_NAME_INVALID'), { code: 'EVAL_NAME_INVALID' })
  if (!(Number.isInteger(version) && version >= 1 && version <= 9999)) throw Object.assign(new Error('EVAL_VERSION_INVALID'), { code: 'EVAL_VERSION_INVALID' })
  if (!String(seed || '').trim()) throw Object.assign(new Error('EVAL_SEED_REQUIRED'), { code: 'EVAL_SEED_REQUIRED' })
  if (!(holdout_fraction > 0 && holdout_fraction < 1)) throw Object.assign(new Error('EVAL_HOLDOUT_INVALID'), { code: 'EVAL_HOLDOUT_INVALID' })
  const groups = new Map()
  for (const r of [...feedback].sort(order)) {
    if (!r || (!r.ai_message_id && !r.decision_id)) continue
    const k = itemKey(r)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const items = []
  for (const [k, rows] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const reviews = rows.filter((r) => REVIEW_KINDS.includes(r.kind))
    if (!reviews.length) continue
    const gen = rows.find((r) => r.kind === 'draft_generated') || null
    const lastVerdict = [...reviews].reverse().find((r) => VERDICT[r.kind]) || null
    const labels = Object.assign({}, ...reviews.map((r) => r.labels || {}))
    const outcome = Object.assign({}, ...rows.filter((r) => ['seller_response', 'negotiation_outcome', 'acquisition_outcome'].includes(r.kind)).map((r) => r.outcome || {}))
    const thread = rows.find((r) => r.thread_ref)?.thread_ref || k
    items.push({
      item_id: k,
      ai_message_id: rows[0].ai_message_id || null,
      decision_id: rows.find((r) => r.decision_id)?.decision_id || null,
      thread_ref: rows.find((r) => r.thread_ref)?.thread_ref || null,
      split: splitBucket(seed, thread) < holdout_fraction ? 'holdout' : 'dev',
      draft: gen?.draft_text_masked ?? null,
      final: lastVerdict?.kind === 'draft_edited' ? lastVerdict.final_text_masked : lastVerdict?.kind === 'draft_approved' ? (gen?.draft_text_masked ?? null) : null,
      verdict: lastVerdict ? VERDICT[lastVerdict.kind] : 'noted',
      reviewers: [...new Set(reviews.map((r) => r.operator_id).filter(Boolean))].sort(),
      notes: reviews.map((r) => r.note_masked).filter(Boolean),
      labels,
      outcome,
      model: gen?.model ?? null,
      cost_usd: gen?.cost_usd ?? null,
      feedback_ids: rows.map((r) => r.feedback_id || r.idempotency_key).filter(Boolean),
    })
  }
  const manifest = {
    builder_version: EVAL_BUILDER_VERSION,
    name, version, seed: String(seed), holdout_fraction,
    counts: { items: items.length, holdout: items.filter((i) => i.split === 'holdout').length, dev: items.filter((i) => i.split === 'dev').length, unreviewed_skipped: [...groups.values()].filter((rows) => !rows.some((r) => REVIEW_KINDS.includes(r.kind))).length },
    items,
  }
  const content_hash = sha256Hex(canonicalJson(manifest))
  return {
    eval_set_id: `evalset_${name}_v${version}`,
    name, version,
    builder_version: EVAL_BUILDER_VERSION,
    seed: String(seed),
    holdout_fraction,
    item_count: items.length,
    manifest,
    content_hash,
    created_by: String(created_by || '').slice(0, 80),
  }
}

/** Build the next version from the store and persist it (immutable; a duplicate version is refused). */
export async function publishEvalSet({ name, seed, holdout_fraction = 0.2, created_by }, { store }) {
  const feedback = await store.listForEval({})
  const version = (await store.latestEvalSetVersion(name)) + 1
  const set = buildEvalSet({ name, version, feedback, seed, holdout_fraction, created_by })
  await store.insertEvalSet(set)
  return { ok: true, eval_set_id: set.eval_set_id, version, item_count: set.item_count, content_hash: set.content_hash }
}
