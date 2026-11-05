// 8.5.19 Phase 10 — operator feedback (append-only), evaluation-set builder (deterministic,
// held-out by thread, reviewed items only), scoring rubric, and the learning boundary
// (no production path reads feedback; nothing changes behaviour automatically).
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'

import { buildFeedbackRow, createMemoryFeedbackStore, recordOperatorFeedback, FEEDBACK_KINDS } from '../../src/lib/domain/operator-feedback/feedback.js'
import { buildEvalSet, publishEvalSet, splitBucket } from '../../src/lib/domain/operator-feedback/eval-set.js'
import { scoreItem, amountsIn, scoreAuthorizationRespected, scoreKnownFactsUsed, scoreRepetition, scoreToneMatch, scoreEconomicMismatch, scoreEscalation, scoreModelCost, scoreQuestionUsefulness, RUBRIC_DIMENSIONS } from '../../src/lib/domain/operator-feedback/rubric.js'
import { importClosure, listFiles, SRC } from '../helpers/import-graph.mjs'

const T0 = Date.parse('2026-10-15T12:00:00.000Z')

test('feedback rows: linked, reviewer named, edit carries text, masked, idempotent', () => {
  assert.throws(() => buildFeedbackRow({ kind: 'draft_generated' }), (e) => e.errors.includes('link:ai_message_id_or_decision_id_required'))
  assert.throws(() => buildFeedbackRow({ kind: 'draft_approved', ai_message_id: 'a1' }), (e) => e.errors.includes('operator_id:required_for_review'))
  assert.throws(() => buildFeedbackRow({ kind: 'draft_edited', ai_message_id: 'a1', operator_id: 'op' }), (e) => e.errors.includes('final_text:required_for_edit'))
  assert.throws(() => buildFeedbackRow({ kind: 'auto_applied', ai_message_id: 'a1' }), (e) => e.errors.includes('kind:enum'))
  const r = buildFeedbackRow({ kind: 'operator_note', decision_id: 'd1', operator_id: 'op', note: 'Seller Jane Roe said call 612-555-0147 or jane@example.com', mask_names: ['Jane Roe'], thread_key: '+15555550123' })
  assert.ok(!/612-555-0147|jane@example\.com|Roe/.test(JSON.stringify(r)), 'phones, emails and names are masked')
  assert.match(r.thread_ref, /^thr_[a-p]{12}$/)
  assert.equal(r.idempotency_key, buildFeedbackRow({ kind: 'operator_note', decision_id: 'd1', operator_id: 'op', note: 'Seller Jane Roe said call 612-555-0147 or jane@example.com', mask_names: ['Jane Roe'], thread_key: '+15555550123' }).idempotency_key)
  const labels = buildFeedbackRow({ kind: 'draft_rejected', ai_message_id: 'a1', operator_id: 'op', labels: { expected_intent: 'asks_offer', age: 80, injected: 'x', nested: { a: 1 } } }).labels
  assert.deepEqual(labels, { expected_intent: 'asks_offer' }, 'only rubric label keys; protected / unknown keys dropped')
  assert.deepEqual(FEEDBACK_KINDS, ['draft_generated', 'draft_approved', 'draft_rejected', 'draft_edited', 'operator_note', 'seller_response', 'negotiation_outcome', 'acquisition_outcome'])
})

test('append-only store: no update / delete, duplicates refused', async () => {
  const store = createMemoryFeedbackStore({ now: () => T0 })
  const a = await recordOperatorFeedback({ kind: 'draft_generated', ai_message_id: 'a1', draft_text: 'What would you need to get for it?', model: 'haiku', cost_usd: 0.0011 }, { store })
  assert.equal(a.ok, true)
  await assert.rejects(() => recordOperatorFeedback({ kind: 'draft_generated', ai_message_id: 'a1', draft_text: 'What would you need to get for it?', model: 'haiku', cost_usd: 0.0011 }, { store }), /DUPLICATE_IDEMPOTENCY_KEY/)
  await assert.rejects(() => store.update(), /APPEND_ONLY/)
  await assert.rejects(() => store.delete(), /APPEND_ONLY/)
  const rows = store._rows()
  assert.equal(rows.length, 1)
})

function fixtureFeedback() {
  const rows = []
  let i = 0
  const add = (o) => rows.push({ feedback_id: `f${String(++i).padStart(3, '0')}`, created_at: new Date(T0 + i * 1000).toISOString(), ...buildFeedbackRow(o) })
  for (let m = 1; m <= 40; m += 1) {
    const thread = `+1555555${String(1000 + (m % 17)).padStart(4, '0')}`
    add({ kind: 'draft_generated', ai_message_id: `aim-${m}`, thread_key: thread, draft_text: `Draft ${m}: what price would work for you?`, model: 'haiku', cost_usd: 0.001 * (m % 4) })
    if (m % 5 === 0) continue // unreviewed: never in an eval set
    if (m % 3 === 0) add({ kind: 'draft_edited', ai_message_id: `aim-${m}`, thread_key: thread, operator_id: 'op-1', final_text: `Edited ${m}: what number did you have in mind?`, labels: { expected_next_action: 'get_asking_price' } })
    else if (m % 7 === 0) add({ kind: 'draft_rejected', ai_message_id: `aim-${m}`, thread_key: thread, operator_id: 'op-2', note: 'asked price twice', labels: { repetition: 'repeated_price_question' } })
    else add({ kind: 'draft_approved', ai_message_id: `aim-${m}`, thread_key: thread, operator_id: 'op-1' })
    if (m % 4 === 0) add({ kind: 'seller_response', ai_message_id: `aim-${m}`, thread_key: thread, outcome: { seller_replied: true, seller_intent: 'asking_price_provided' } })
  }
  return rows
}

test('eval-set builder: deterministic, reviewed-only, held out by thread, versioned', async () => {
  const rows = fixtureFeedback()
  const a = buildEvalSet({ name: 'seller_s3', version: 1, feedback: rows, seed: 'seed-1', holdout_fraction: 0.25, created_by: 'op-1' })
  const shuffled = [...rows].sort((x, y) => (x.feedback_id < y.feedback_id ? 1 : -1))
  const b = buildEvalSet({ name: 'seller_s3', version: 1, feedback: shuffled, seed: 'seed-1', holdout_fraction: 0.25, created_by: 'op-1' })
  assert.equal(a.content_hash, b.content_hash, 'input order does not matter')
  assert.deepEqual(a.manifest, b.manifest)
  assert.equal(a.eval_set_id, 'evalset_seller_s3_v1')
  assert.equal(a.item_count, 32, '40 drafts − 8 unreviewed')
  assert.equal(a.manifest.counts.unreviewed_skipped, 8)
  assert.ok(a.manifest.items.every((it) => it.reviewers.length >= 1))
  assert.ok(!a.manifest.items.some((it) => ['aim-5', 'aim-10', 'aim-40'].includes(it.ai_message_id)))
  const byThread = new Map()
  for (const it of a.manifest.items) {
    const s = byThread.get(it.thread_ref) || new Set()
    s.add(it.split)
    byThread.set(it.thread_ref, s)
  }
  assert.ok([...byThread.values()].every((s) => s.size === 1), 'a thread never sits in both halves')
  assert.ok(a.manifest.counts.holdout > 0 && a.manifest.counts.dev > 0)
  const c = buildEvalSet({ name: 'seller_s3', version: 1, feedback: rows, seed: 'seed-2', holdout_fraction: 0.25, created_by: 'op-1' })
  assert.notEqual(c.content_hash, a.content_hash, 'the seed is part of the set identity')
  assert.equal(splitBucket('s', 'x'), splitBucket('s', 'x'))
  const edited = a.manifest.items.find((it) => it.ai_message_id === 'aim-3')
  assert.equal(edited.verdict, 'edited')
  assert.match(edited.final, /^Edited 3/)
  const approved = a.manifest.items.find((it) => it.ai_message_id === 'aim-1')
  assert.equal(approved.final, approved.draft)
  assert.equal(a.manifest.items.find((it) => it.ai_message_id === 'aim-4').outcome.seller_replied, true)
  // publish: next version, immutable, a duplicate version refused
  const store = createMemoryFeedbackStore({ now: () => T0 })
  for (const r of rows) await store.append(r)
  const p1 = await publishEvalSet({ name: 'seller_s3', seed: 'seed-1', holdout_fraction: 0.25, created_by: 'op-1' }, { store })
  const p2 = await publishEvalSet({ name: 'seller_s3', seed: 'seed-1', holdout_fraction: 0.25, created_by: 'op-1' }, { store })
  assert.deepEqual([p1.version, p2.version], [1, 2])
  await assert.rejects(() => store.insertEvalSet({ name: 'seller_s3', version: 1 }), /EVAL_SET_VERSION_EXISTS/)
  assert.throws(() => buildEvalSet({ name: 'Bad Name', version: 1, feedback: rows, seed: 's', created_by: 'x' }), /EVAL_NAME_INVALID/)
})

test('rubric: every dimension, authorization is a hard fail', () => {
  assert.deepEqual(RUBRIC_DIMENSIONS, ['intent', 'next_action', 'known_facts_used', 'tone_match', 'repetition', 'question_usefulness', 'authorization_respected', 'economic_mismatch', 'escalation_appropriate', 'model_cost'])
  assert.deepEqual(amountsIn('We could do $140,000 or 145k, closing in 14 days'), [140000, 145000])
  const within = { status: 'within_authority', move: { amount: 140000 } }
  assert.equal(scoreAuthorizationRespected({ draft: 'I can do $140,000.', position: within }), 1)
  assert.equal(scoreAuthorizationRespected({ draft: 'I can do $145,000.', position: within }), 0)
  assert.equal(scoreAuthorizationRespected({ draft: 'I can do $140,000.', position: { status: 'needs_envelope', move: null } }), 0)
  assert.equal(scoreAuthorizationRespected({ draft: 'How is the roof?', position: null }), 1)
  assert.equal(scoreKnownFactsUsed({ draft: 'What price would you take for it?', known_facts: ['asking_price'] }), 0)
  assert.equal(scoreKnownFactsUsed({ draft: 'How is the condition, any repairs needed?', known_facts: ['asking_price'] }), 1)
  assert.equal(scoreRepetition({ draft: 'What price would you take for it?', prior_outbound: ['What price would you take for it?'] }), 0)
  assert.equal(scoreToneMatch({ draft: 'a b c', final: null, verdict: 'approved' }), 1)
  assert.equal(scoreToneMatch({ draft: 'a b', final: 'x y', verdict: 'rejected' }), 0)
  assert.equal(scoreEconomicMismatch({ economics_class: 'PASS', proposes_offer: true }), 0)
  assert.equal(scoreEconomicMismatch({ economics_class: 'HOT', proposes_offer: true }), 1)
  assert.equal(scoreEscalation({ escalated: false, position_status: 'escalate' }), 0)
  assert.equal(scoreModelCost(0.01), 1)
  assert.equal(scoreModelCost(0.06), 0)
  assert.equal(scoreQuestionUsefulness({ draft: 'How is the condition?', expected_objective: 'get_condition' }), 1)
  const s = scoreItem({ item: { item_id: 'm:a1', labels: { expected_intent: 'asks_offer', expected_next_action: 'get_condition' }, verdict: 'approved', cost_usd: 0.004 }, turn: { intent: 'asks_offer', next_action: 'get_condition', draft: 'I can do $150,000.', position: within, known_facts: [], prior_outbound: [] } })
  assert.deepEqual(s.hard_fail, ['authorization_respected'])
  assert.equal(s.scores.intent, 1)
  assert.equal(s.scores.model_cost, 1)
})

test('learning boundary: no production path imports the feedback / eval modules', () => {
  const FEEDBACK_DIR = path.join(SRC, 'lib/domain/operator-feedback')
  // the interface re-exports recordOperatorFeedback only (a write of evidence, never a read that drives behaviour)
  const allowed = new Set([path.join(SRC, 'lib/domain/negotiation/conversation-engine-interface.js')])
  const direct = listFiles(SRC).filter((f) => !f.startsWith(FEEDBACK_DIR) && !allowed.has(f) && /operator-feedback\//.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(direct.map((f) => path.relative(SRC, f)), [], 'only the interface may import operator-feedback')
  const iface = fs.readFileSync([...allowed][0], 'utf8')
  assert.match(iface, /import \{ recordOperatorFeedback, createSupabaseFeedbackStore, FEEDBACK_KINDS \} from '\.\.\/operator-feedback\/feedback\.js'/)
  assert.ok(!/eval-set|rubric/.test(iface), 'the engine interface never imports the eval builder or the rubric')
  const { files } = importClosure([path.join(FEEDBACK_DIR, 'eval-set.js'), path.join(FEEDBACK_DIR, 'rubric.js'), path.join(FEEDBACK_DIR, 'feedback.js')])
  const forbidden = [...files].filter((f) => /prompts\.js|send-queue|providers\/textgrid|seller-flow\/|templates\//.test(f))
  assert.deepEqual(forbidden.map((f) => path.relative(SRC, f)), [], 'feedback never reaches prompts, templates or the send path')
})
