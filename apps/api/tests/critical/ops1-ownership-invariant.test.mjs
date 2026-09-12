import assert from 'node:assert/strict'
import test from 'node:test'

import { extractSellerFacts, extractionToResolverFacts } from '@/lib/domain/seller-flow/extract-seller-facts.js'
import { resolveSellerStageTransition, mergeSellerFacts } from '@/lib/domain/seller-flow/resolve-seller-stage-transition.js'
import { transitionQualifiesForOpportunity } from '@/lib/domain/seller-flow/persist-seller-transition.js'

/**
 * OPS-1 — THE OWNERSHIP INVARIANT.
 *
 *   Ownership is its own durable fact.
 *
 * It may be resolved only from explicit seller confirmation or authoritative
 * ownership data. It is never a by-product of engagement: a price, an offer
 * request, a rent figure, a repair disclosure or even "I'd sell" are all
 * things a tenant, a relative, an agent or the wrong person entirely can say
 * about a property they do not own.
 *
 * FACTS MAY ARRIVE OUT OF STAGE ORDER. That is allowed and must not be
 * "corrected" by inventing the upstream fact they arrived ahead of. The
 * out-of-order fact is REMEMBERED, so once ownership is confirmed the resolver
 * skips straight past questions already answered.
 */

const seam = (message) => extractionToResolverFacts(extractSellerFacts({ message }))

const turn = ({ message, intent, known = {}, stage = 'ownership_confirmation' }) =>
  resolveSellerStageTransition({
    stage_before: stage, intent, known_facts: known, new_facts: seam(message),
  })

// ── Facts that must NOT resolve ownership ──────────────────────────────────

const NON_OWNERSHIP_EVIDENCE = [
  ["price only", '150k', 'asking_price_provided'],
  ["interest only", "I'd consider selling.", 'seller_interested'],
  ["interest + price", "I'd sell for 150k.", 'seller_interested'],
  ["asks offer", 'Make me an offer.', 'asks_offer'],
  ["counter-ish", '200 works for me.', 'asking_price_provided'],
  ["rent disclosure", "It's rented for 1400.", 'tenant_occupied'],
  ["condition", 'It needs a roof.', 'condition_disclosed'],
]

for (const [label, message, intent] of NON_OWNERSHIP_EVIDENCE) {
  test(`OWNERSHIP INVARIANT: "${label}" does not resolve ownership`, () => {
    const t = turn({ message, intent })
    const owner = String(t.facts_patch?.ownership_status ?? '')
    assert.ok(
      owner === '' || owner === 'unknown',
      `"${message}" fabricated ownership_status=${owner}`
    )
  })
}

test('OWNERSHIP INVARIANT: "not interested" does not resolve ownership', () => {
  const t = turn({ message: 'Not interested.', intent: 'not_interested' })
  const owner = String(t.facts_patch?.ownership_status ?? '')
  assert.ok(owner === '' || owner === 'unknown', `fabricated ownership_status=${owner}`)
})

// ── Facts that MAY resolve ownership ───────────────────────────────────────

test('OWNERSHIP: an explicit confirmation resolves it', () => {
  const t = turn({ message: 'Yes, I own it.', intent: 'ownership_confirmed' })
  assert.equal(t.facts_patch?.ownership_status, 'confirmed')
})

test('OWNERSHIP: an explicit denial is respected over any other signal', () => {
  const t = turn({
    message: "No, my brother owns it. He wants 150k.", intent: 'ownership_confirmed',
    known: { ownership_status: 'not_owner' },
  })
  assert.notEqual(t.facts_patch?.ownership_status, 'confirmed')
})

// ── Required scenario matrix ───────────────────────────────────────────────

test('SCENARIO price only: price persists, ownership unknown, objective = ownership', () => {
  const t = turn({ message: '150k', intent: 'asking_price_provided' })
  assert.equal(t.facts_patch?.asking_price?.value, 150_000)
  assert.equal(t.stage_after, 'ownership_confirmation')
  assert.equal(transitionQualifiesForOpportunity(t), true, 'opportunity must still be created')
})

test('SCENARIO interest only: interest persists, objective = ownership', () => {
  const t = turn({ message: "I'd consider selling.", intent: 'seller_interested' })
  assert.equal(t.stage_after, 'ownership_confirmation')
})

test('SCENARIO interest + price: both persist, objective = ownership', () => {
  const t = turn({ message: "I'd sell for 150k.", intent: 'seller_interested' })
  assert.equal(t.facts_patch?.asking_price?.value, 150_000)
  assert.equal(t.stage_after, 'ownership_confirmation')
})

test('SCENARIO ownership + interest + price: skips S2/S3 to discovery', () => {
  // Semantic skipping: never re-ask what has already been answered.
  const t = turn({ message: 'Yeah I own it. I would sell for 150k.', intent: 'ownership_confirmed' })
  assert.equal(t.facts_patch?.ownership_status, 'confirmed')
  assert.equal(t.facts_patch?.asking_price?.value, 150_000)
  assert.notEqual(t.stage_after, 'ownership_confirmation')
  assert.notEqual(t.stage_after, 'offer_interest')
  assert.notEqual(t.stage_after, 'asking_price')
})

// ── Out-of-order accumulation + semantic skipping ──────────────────────────

test('OUT OF ORDER: price first, ownership later — no re-asking', () => {
  // Turn 1: price arrives with ownership unknown.
  const t1 = turn({ message: '150k', intent: 'asking_price_provided' })
  assert.equal(t1.stage_after, 'ownership_confirmation')
  const carried = mergeSellerFacts({}, t1.facts_patch, {})
  assert.equal(carried.asking_price.value, 150_000)

  // Turn 2: ownership confirmed. The remembered price must let the resolver
  // skip the asking-price objective entirely.
  const t2 = resolveSellerStageTransition({
    stage_before: 'ownership_confirmation', intent: 'ownership_confirmed',
    known_facts: carried, new_facts: seam('Yes I own it.'),
  })
  assert.equal(t2.facts_patch?.ownership_status, 'confirmed')
  assert.notEqual(t2.stage_after, 'asking_price', 'must not re-ask a known price')
  assert.notEqual(t2.stage_after, 'ownership_confirmation')
})

test('OUT OF ORDER: the accumulated state is valid and complete-as-far-as-it-goes', () => {
  const carried = mergeSellerFacts({}, turn({ message: "I'd sell for 150k.", intent: 'seller_interested' }).facts_patch, {})
  assert.equal(carried.asking_price.value, 150_000)
  // ownership legitimately absent
  const owner = String(carried.ownership_status ?? '')
  assert.ok(owner === '' || owner === 'unknown')
})

test('OPPORTUNITY: creation is independent of ownership resolution', () => {
  const t = turn({ message: '150k', intent: 'asking_price_provided' })
  assert.equal(transitionQualifiesForOpportunity(t), true)
  // ...and creating it asserts nothing about ownership or interest.
  const owner = String(t.facts_patch?.ownership_status ?? '')
  assert.ok(owner === '' || owner === 'unknown')
  assert.equal(t.facts_patch?.terms_accepted, undefined)
})

// ── Ronald, end to end ─────────────────────────────────────────────────────

test('RONALD: the final canonical state after the latest 150k', () => {
  const t = turn({ message: '150k', intent: 'asking_price_provided' })
  assert.equal(t.facts_patch?.asking_price?.value, 150_000, 'price must persist')
  assert.equal(transitionQualifiesForOpportunity(t), true, 'opportunity must exist')
  const owner = String(t.facts_patch?.ownership_status ?? '')
  assert.ok(owner === '' || owner === 'unknown', 'ownership must remain unresolved')
  assert.equal(t.stage_after, 'ownership_confirmation', 'next objective is ownership')
})

test('RONALD: repeating 150k three times is idempotent', () => {
  let facts = {}
  for (let i = 0; i < 3; i += 1) {
    facts = mergeSellerFacts(facts, turn({ message: '150k', intent: 'asking_price_provided', known: facts }).facts_patch, {})
  }
  assert.equal(facts.asking_price.value, 150_000)
  const owner = String(facts.ownership_status ?? '')
  assert.ok(owner === '' || owner === 'unknown', 'three repeats must not accumulate into ownership')
})
