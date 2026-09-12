import assert from 'node:assert/strict'
import test from 'node:test'

import { extractSellerFacts, extractionToResolverFacts } from '@/lib/domain/seller-flow/extract-seller-facts.js'
import {
  resolveSellerStageTransition,
  mergeSellerFacts,
  SELLER_LEVEL_ENGAGEMENT_INTENTS,
  OWNERSHIP_INFERRED_FROM_ENGAGEMENT,
} from '@/lib/domain/seller-flow/resolve-seller-stage-transition.js'
import { transitionQualifiesForOpportunity } from '@/lib/domain/seller-flow/persist-seller-transition.js'
import { LIFECYCLE_STAGE_ORDER } from '@/lib/domain/lead-state/universal-lead-state-registry.js'

/**
 * MONOTONIC SEMANTIC STAGE PROGRESSION.
 *
 * The acquisition flow is not a questionnaire. A seller-LEVEL response
 * operationally resolves the ownership milestone: someone naming their price,
 * asking us to make an offer, expressing interest, countering, or declining to
 * sell is answering AS THE SELLER, and we must not then ask "do you own it?".
 *
 * Two things this is NOT:
 *   - it is not title/legal verification (provenance is explicit);
 *   - it is not licence to infer from any statement ABOUT a property. A bare
 *     rent or condition disclosure is something a tenant or neighbour could
 *     equally say, so it resolves nothing.
 *
 * Explicit contradiction always wins and routes to contact resolution, which
 * is an EXIT from the contact path rather than a stage regression.
 */

const seam = (message) => extractionToResolverFacts(extractSellerFacts({ message }))
const idx = (stage) => LIFECYCLE_STAGE_ORDER.indexOf(stage)

const turn = ({ message, intent, known = {}, stage = 'ownership_confirmation', ade = null }) =>
  resolveSellerStageTransition({
    stage_before: stage, intent, known_facts: known, new_facts: seam(message), ade_result: ade,
  })

const UW = { recommended_cash_offer: 80_000, max_allowable_offer: 85_000 }

// ── Seller-level engagement resolves ownership ─────────────────────────────

const SELLER_LEVEL = [
  ['interest', "I'm interested.", 'seller_interested'],
  ['asks offer', 'Make me an offer.', 'asks_offer'],
  ['asking price', 'I want 150k.', 'asking_price_provided'],
  ['not interested', 'Not interested.', 'not_interested'],
]

for (const [label, message, intent] of SELLER_LEVEL) {
  test(`SELLER-LEVEL "${label}" operationally resolves ownership`, () => {
    const t = turn({ message, intent })
    assert.equal(t.facts_patch?.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT,
      `"${message}" must resolve ownership for acquisition purposes`)
    assert.equal(t.facts_patch?.ownership_resolution_basis, 'seller_level_engagement')
  })
}

test('provenance is explicit and is NOT title/legal verification', () => {
  const t = turn({ message: 'I want 150k.', intent: 'asking_price_provided' })
  assert.equal(t.facts_patch?.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT)
  assert.notEqual(t.facts_patch?.ownership_status, 'confirmed')
  assert.equal(t.facts_patch?.title_verified, undefined)
  assert.equal(t.facts_patch?.legal_owner_verified, undefined)
})

// ── Statements ABOUT a property resolve nothing ────────────────────────────

const NOT_SELLER_LEVEL = [
  ['rent disclosure', "It's rented for 1400.", 'tenant_occupied'],
  ['condition disclosure', 'It needs a roof.', 'condition_disclosed'],
]

for (const [label, message, intent] of NOT_SELLER_LEVEL) {
  test(`"${label}" is a statement ABOUT a property and resolves nothing`, () => {
    // A tenant or neighbour could say exactly this.
    const t = turn({ message, intent })
    const owner = String(t.facts_patch?.ownership_status ?? '')
    assert.ok(owner === '' || owner === 'unknown', `fabricated ownership from "${message}"`)
    assert.equal(t.stage_after, 'ownership_confirmation')
  })
}

test('the engagement intent set is exactly the seller-level responses', () => {
  for (const i of ['seller_interested', 'asks_offer', 'not_interested', 'asking_price_provided', 'counter_offer']) {
    assert.ok(SELLER_LEVEL_ENGAGEMENT_INTENTS.has(i), `${i} must be seller-level`)
  }
  for (const i of ['tenant_occupied', 'condition_disclosed', 'wrong_number', 'opt_out']) {
    assert.ok(!SELLER_LEVEL_ENGAGEMENT_INTENTS.has(i), `${i} must NOT resolve ownership`)
  }
})

// ── Explicit contradiction overrides inference ─────────────────────────────

test('CONTRADICTION: an explicit denial overrides engagement inference', () => {
  const t = turn({
    message: "I don't own it.", intent: 'asking_price_provided',
    known: { ownership_status: 'not_owner' },
  })
  assert.notEqual(t.facts_patch?.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT)
})

test('CONTRADICTION: a denied claim blocks inference even mid-engagement', () => {
  const t = turn({
    message: 'I want 150k.', intent: 'asking_price_provided',
    known: { ownership_claim: 'denied' },
  })
  assert.notEqual(t.facts_patch?.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT)
})

test('CONTRADICTION: an explicit confirmation still outranks inference', () => {
  const t = turn({ message: 'Yes, I own it.', intent: 'ownership_confirmed' })
  assert.equal(t.facts_patch?.ownership_status, 'confirmed')
})

// ── Semantic skipping matrix ───────────────────────────────────────────────

test('S1 → ≥S2 on interest', () => {
  const t = turn({ message: "I'm interested.", intent: 'seller_interested' })
  assert.ok(idx(t.stage_after) >= idx('offer_interest'), `got ${t.stage_after}`)
  assert.notEqual(t.stage_after, 'ownership_confirmation')
})

test('S1 → ≥S3 on an asking price', () => {
  const t = turn({ message: 'I want 150k.', intent: 'asking_price_provided' })
  assert.equal(t.facts_patch?.asking_price?.value, 150_000)
  assert.ok(idx(t.stage_after) >= idx('asking_price'), `got ${t.stage_after}`)
})

test('S1 → S5 when economics already authorize an offer', () => {
  // ask 70k <= executable 80k: discovery is not needed to complete a stage.
  const t = turn({ message: "I'd take 70k.", intent: 'asking_price_provided', ade: UW })
  assert.equal(t.facts_patch?.asking_price?.value, 70_000)
  assert.equal(t.stage_after, 'offer')
  // ...and favourable economics are still not acceptance.
  assert.notEqual(t.stage_after, 'formal_contract')
  assert.equal(t.facts_patch?.terms_accepted, undefined)
})

test('S1 → S4 when the gap requires discovery', () => {
  const t = turn({ message: "I'd take 100k.", intent: 'asking_price_provided', ade: UW })
  assert.equal(t.facts_patch?.asking_price?.value, 100_000)
  assert.equal(t.stage_after, 'property_condition')
})

test('economics, not stage order, decides S4 vs S5', () => {
  const favourable = turn({ message: "I'd take 70k.", intent: 'asking_price_provided', ade: UW })
  const gap = turn({ message: "I'd take 100k.", intent: 'asking_price_provided', ade: UW })
  assert.notEqual(favourable.stage_after, gap.stage_after)
})

test('not interested from S1 resolves ownership and nurtures', () => {
  const t = turn({ message: 'Not interested.', intent: 'not_interested' })
  assert.equal(t.facts_patch?.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT)
  assert.notEqual(t.stage_after, 'ownership_confirmation')
  // and it must NOT be read as a wrong-owner signal
  assert.ok(!['not_owner', 'wrong_person', 'wrong_number'].includes(String(t.facts_patch?.ownership_status)))
})

// ── Monotonicity ───────────────────────────────────────────────────────────

test('MONOTONIC: stage never regresses for the same thread', () => {
  const stages = ['asking_price', 'property_condition', 'offer']
  for (const before of stages) {
    for (const [message, intent] of [["I'm interested.", 'seller_interested'], ['Not interested.', 'not_interested'], ['I want 150k.', 'asking_price_provided']]) {
      const t = turn({ message, intent, stage: before })
      assert.ok(idx(t.stage_after) >= idx(before),
        `REGRESSION ${before} -> ${t.stage_after} on "${message}"`)
    }
  }
})

test('MONOTONIC: a late low-signal reply cannot pull a deal backwards', () => {
  const t = turn({ message: "It's rented for 1400.", intent: 'tenant_occupied', stage: 'offer' })
  assert.ok(idx(t.stage_after) >= idx('offer'))
})

// ── Out-of-order facts are remembered ──────────────────────────────────────

test('OUT OF ORDER: downstream facts are kept, never discarded for arriving early', () => {
  const t = turn({ message: "Give me 150k. It's rented for 1400 month-to-month.", intent: 'asking_price_provided' })
  assert.equal(t.facts_patch?.asking_price?.value, 150_000)
  assert.equal(t.facts_patch?.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT)
  assert.equal(t.facts_patch?.occupancy_status, 'tenant_occupied')
})

test('OUT OF ORDER: a known price is never re-asked after ownership confirms', () => {
  const t1 = turn({ message: 'I want 150k.', intent: 'asking_price_provided' })
  const carried = mergeSellerFacts({}, t1.facts_patch, {})
  const t2 = resolveSellerStageTransition({
    stage_before: t1.stage_after, intent: 'ownership_confirmed',
    known_facts: carried, new_facts: seam('Yes I own it.'),
  })
  assert.notEqual(t2.stage_after, 'asking_price', 'must not re-ask a known price')
  assert.ok(idx(t2.stage_after) >= idx(t1.stage_after), 'monotonic')
})

// ── Opportunity ────────────────────────────────────────────────────────────

test('OPPORTUNITY: a price-bearing turn creates the canonical aggregate', () => {
  const t = turn({ message: '150k', intent: 'asking_price_provided' })
  assert.equal(transitionQualifiesForOpportunity(t), true)
  assert.equal(t.facts_patch?.asking_price?.value, 150_000)
})

// ── Ronald ─────────────────────────────────────────────────────────────────

test('RONALD: "150k" resolves ownership, captures price, reaches ≥S3', () => {
  const t = turn({ message: '150k', intent: 'asking_price_provided' })
  assert.equal(t.facts_patch?.asking_price?.value, 150_000)
  assert.equal(t.facts_patch?.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT)
  assert.ok(idx(t.stage_after) >= idx('asking_price'), `got ${t.stage_after}`)
  assert.equal(transitionQualifiesForOpportunity(t), true)
})

test('RONALD: three repeats are idempotent and never regress', () => {
  let facts = {}
  let stage = 'ownership_confirmation'
  for (let i = 0; i < 3; i += 1) {
    const t = turn({ message: '150k', intent: 'asking_price_provided', known: facts, stage })
    assert.ok(idx(t.stage_after) >= idx(stage), 'monotonic across repeats')
    facts = mergeSellerFacts(facts, t.facts_patch, {})
    stage = t.stage_after
  }
  assert.equal(facts.asking_price.value, 150_000)
  assert.equal(facts.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT)
})

// ── latent_interest is NOT safe for ownership inference ────────────────────

test('LATENT: latent_interest is excluded from ownership inference', () => {
  // Evidence from the live classifier (heuristic path):
  //   "I heard they're interested."  -> latent_interest   (third-party)
  //   "Are you still interested?"    -> latent_interest   (buyer-directed)
  //   "You should just let it go."   -> latent_interest   (idiom)
  // None is a seller POSITION, so the intent cannot resolve ownership.
  assert.ok(!SELLER_LEVEL_ENGAGEMENT_INTENTS.has('latent_interest'))
})

test('LATENT: a latent_interest turn does not resolve ownership', () => {
  const t = turn({ message: "I heard they're interested.", intent: 'latent_interest' })
  const owner = String(t.facts_patch?.ownership_status ?? '')
  assert.ok(owner === '' || owner === 'unknown',
    `third-party commentary fabricated ownership=${owner}`)
})

test('LATENT: genuine conditional-sale phrasing is still covered elsewhere', () => {
  // "Maybe, what would you offer?" classifies as asks_offer, which IS
  // seller-level — so narrowing latent_interest loses no real coverage.
  const t = turn({ message: 'Maybe, what would you offer?', intent: 'asks_offer' })
  assert.equal(t.facts_patch?.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT)
})

// ── §6 required final proofs ───────────────────────────────────────────────

test('PROOF: explicit contradiction routes to contact resolution, not regression', () => {
  // An earlier turn inferred ownership from engagement; the seller now denies
  // it. The denial wins, and this is an EXIT from the contact path.
  const t = turn({
    message: "I don't own it.", intent: 'wrong_number',
    known: { ownership_status: OWNERSHIP_INFERRED_FROM_ENGAGEMENT, asking_price: { value: 150_000 } },
    stage: 'asking_price',
  })
  assert.notEqual(t.facts_patch?.ownership_status, OWNERSHIP_INFERRED_FROM_ENGAGEMENT)
  // Monotonicity still holds for the thread itself.
  assert.ok(idx(t.stage_after) >= idx('asking_price'))
})

test('PROOF: S5 never regresses to an earlier acquisition stage', () => {
  for (const [message, intent] of [
    ["I'm interested.", 'seller_interested'],
    ['It needs a roof.', 'condition_disclosed'],
    ["It's rented for 1400.", 'tenant_occupied'],
    ['Not interested.', 'not_interested'],
  ]) {
    const t = turn({ message, intent, stage: 'offer' })
    assert.ok(idx(t.stage_after) >= idx('offer'), `S5 regressed to ${t.stage_after} on "${message}"`)
  }
})

test('PROOF: S4 never regresses to S1/S2/S3', () => {
  for (const [message, intent] of [
    ["I'm interested.", 'seller_interested'],
    ['I want 150k.', 'asking_price_provided'],
  ]) {
    const t = turn({ message, intent, stage: 'property_condition' })
    assert.ok(idx(t.stage_after) >= idx('property_condition'), `regressed to ${t.stage_after}`)
  }
})
