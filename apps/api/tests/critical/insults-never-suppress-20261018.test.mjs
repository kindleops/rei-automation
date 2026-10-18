// OWNER RULES (locked) re-asserted after the rc-8.5.21 blind evaluation (REAL-117 / SCONV-27 /
// SYN-48: a bare "Fu", "You people are vultures", "go f*** yourself" were labelled hostile_or_legal and
// the phone suppressed). Written from those described behaviours, new phrasings:
//   - 2026-10-06: an insult NEVER suppresses — no reply plus a quiet archive, nurture eligibility
//     unchanged. Only a genuine legal threat or an explicit stop request suppresses.
//   - 2026-10-17: a property denial is NEVER global — the legacy not-owner rule never marks the phone.
import test from 'node:test'
import assert from 'node:assert/strict'

import { classify } from '../../src/lib/domain/classification/classify.js'
import { resolveSellerStageTransition } from '../../src/lib/domain/seller-flow/resolve-seller-stage-transition.js'
import { resolveFollowUpPlan } from '../../src/lib/domain/seller-flow/seller-followup-scheduler.js'
import { executeAutomationAction } from '../../src/lib/domain/automation/automation-actions.js'
import { matchAutomationRule, getDefaultAutomationRule } from '../../src/lib/domain/automation/automation-rules.js'
import { deterministicPrecheck } from '../../src/lib/domain/conversation-ai/precheck.js'

const INSULTS = ['FU', 'f u', 'you guys are bloodsuckers', 'go f*** off', 'screw you', 'eat shit', 'what a bunch of vultures']

test('insults and profanity WITHOUT a stop request or legal threat: hostile_or_troll, no suppression, quiet archive', async () => {
  for (const t of INSULTS) {
    const r = await classify(t, null, { heuristicOnly: true })
    if (r.primary_intent === 'hostile_or_legal') assert.fail(`${t} is still hostile_or_legal`)
    if (r.primary_intent !== 'hostile_or_troll') continue // a non-hostile reading (e.g. unclear) never suppresses either
    assert.equal(r.compliance_flag, null, t)
    assert.equal(r.automation_decision?.suppression_action, 'none', t)
    assert.equal(r.automation_decision?.quiet_archive, true, t)
    assert.equal(r.automation_decision?.auto_reply_allowed, false, `${t}: no reply`)
  }
  const fu = await classify('FU', null, { heuristicOnly: true })
  assert.equal(fu.primary_intent, 'hostile_or_troll')
})

test('a genuine legal threat stays hostile_or_legal (review + suppression path as today); an explicit stop is an opt-out', async () => {
  const legal = await classify('Text me again and my attorney will be in touch', null, { heuristicOnly: true })
  assert.ok(['hostile_or_legal', 'opt_out'].includes(legal.primary_intent), legal.primary_intent)
  const stop = await classify('f*** off and stop texting me', null, { heuristicOnly: true })
  assert.equal(stop.primary_intent, 'opt_out')
  assert.equal(stop.compliance_flag, 'stop_texting')
})

test('the stage transition for an insult writes NO contactability (no DNC) and leaves follow-up eligibility unchanged', () => {
  const t = resolveSellerStageTransition({ intent: 'hostile_or_troll', classification_confidence: 0.9, classification: { primary_intent: 'hostile_or_troll' }, stage_before: 'offer_interest' })
  assert.equal(t.contactability_patch ?? t.contactability ?? null, null)
  assert.equal(t.follow_up.cancel, false)
  assert.equal(t.follow_up.create, false)
  // the follow-up scheduler never treats an insult as a permanent suppression
  const plan = resolveFollowUpPlan('hostile_or_troll', { thread_key: '+15555550100' })
  assert.notEqual(plan.suppressed, true, JSON.stringify(plan))
  // a legal threat keeps its existing handling
  const legal = resolveSellerStageTransition({ intent: 'hostile_or_legal', classification_confidence: 0.9, classification: { primary_intent: 'hostile_or_legal' }, stage_before: 'offer_interest' })
  assert.equal(legal.review_required, true)
})

test('the AI pre-check: an insult is NO_RESPONSE, never SUPPRESS', () => {
  const p = deterministicPrecheck({ text: 'you guys are bloodsuckers', inboundId: 'i1', deterministic: { intent: 'hostile_or_troll', confidence: 0.9 } })
  if (p.decided) assert.notEqual(p.decision.outcome, 'SUPPRESS', JSON.stringify(p.decision))
})

test('a property denial is NEVER global: the legacy not-owner rule is retired and mark_bad_contact refuses a property-scoped reason', async () => {
  const rule = getDefaultAutomationRule('suppression.not_owner_bad_contact') || { rule_key: 'suppression.not_owner_bad_contact', event_type: 'inbound_message_received', condition: { matcher: 'not_owner_or_tenant' } }
  const ev = { id: 'e1', event_type: 'inbound_message_received', phone_e164: '+15555550123', payload: { message_body: 'I am not the owner of that house' } }
  assert.deepEqual([matchAutomationRule({ ...rule, is_active: true, status: 'active' }, ev).matched, matchAutomationRule({ ...rule, is_active: true, status: 'active' }, ev).reason], [false, 'rule_retired:property_denial_never_global'])
  const writes = []
  // a chainable PostgREST-shaped fake: every call returns the chain; awaiting it yields no rows
  const chain = (t) => {
    const done = { data: null, error: null }
    const c = new Proxy(function () {}, {
      get: (_, k) => (k === 'then' ? (res) => res(done) : (...args) => { if (['update', 'insert', 'upsert'].includes(k)) writes.push([t, k, args[0]]); return c }),
    })
    return c
  }
  const db = { from: (t) => chain(t) }
  const retired = await executeAutomationAction({ event: ev, run: { id: 'r1' }, rule, action: { action_type: 'mark_bad_contact', params: { reason: 'not_owner_or_tenant' } }, supabaseClient: db, dry_run: false })
  assert.equal(retired.skipped, true)
  // the same action under any other rule key still refuses a property-scoped reason
  const r2 = await executeAutomationAction({ event: ev, run: { id: 'r2' }, rule: { rule_key: 'custom.rule' }, action: { action_type: 'mark_bad_contact', params: { reason: 'not_owner_or_tenant' } }, supabaseClient: db, dry_run: false })
  assert.equal(JSON.stringify(r2).includes('property_scoped_reason_never_phone_wide'), true, JSON.stringify(r2))
  assert.equal(writes.filter(([t, k]) => t === 'phones' && k === 'update').length, 0, 'the phone was never marked')
})
