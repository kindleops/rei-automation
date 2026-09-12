import assert from 'node:assert/strict'
import test from 'node:test'

import { extractSellerFacts, extractionToResolverFacts } from '@/lib/domain/seller-flow/extract-seller-facts.js'
import { transitionQualifiesForOpportunity } from '@/lib/domain/seller-flow/persist-seller-transition.js'
import { resolveSellerStageTransition, mergeSellerFacts } from '@/lib/domain/seller-flow/resolve-seller-stage-transition.js'

/**
 * OPS-1 P0-1 — a classified acquisition fact must reach canonical state.
 *
 * THE RONALD DEFECT. A real seller said "150k" three times across 2.5 months.
 * Every time the classifier reported asking_price_provided and the extractor
 * produced 150000 at 0.9 confidence. Every time the number died in
 * extractionToResolverFacts(), which mapped the AMBIGUOUS
 * `asking_price_mention` but never the CONFIDENT `facts.asking_price`. With no
 * fact in the patch, transitionQualifiesForOpportunity() returned false, no
 * acquisition_opportunity was created, and economics never learned a price
 * existed — so the system kept asking whether he was open to discussing
 * numbers.
 *
 * Conversation classification is not persistence. These tests pin the seam.
 */

const seam = (message) => extractionToResolverFacts(extractSellerFacts({ message }))

// ── The seam itself ────────────────────────────────────────────────────────

test('P0-1: a confident asking price survives the extraction seam', () => {
  const out = seam('150k')
  assert.equal(out.asking_price, 150_000)
  assert.equal(out.asking_price_source, 'seller_stated')
})

test('P0-1 REGRESSION: the seam no longer drops the confident price', () => {
  // Before the fix this object contained only { extractor_version }.
  const out = seam('150k')
  assert.ok(Object.keys(out).length > 1, `seam returned only ${JSON.stringify(out)}`)
})

test('P0-1: every common price phrasing survives the seam', () => {
  for (const msg of ['150k', '150K', '$150k', '150,000', '$150,000']) {
    assert.equal(seam(msg).asking_price, 150_000, `dropped: ${msg}`)
  }
})

test('P0-1: an AMBIGUOUS mention still does NOT become a canonical price', () => {
  // The low-confidence path must stay evidence-only — the fix must not turn
  // every stray number into an asking price.
  const out = seam("It's rented for 1800 and I want 250")
  assert.equal(out.asking_price, undefined)
  assert.equal(out.asking_price_needs_clarification, true)
})

// ── Opportunity qualification ──────────────────────────────────────────────

test('P0-1: a price-bearing turn qualifies for a canonical opportunity', () => {
  const t = resolveSellerStageTransition({
    stage_before: 'ownership_confirmation',
    intent: 'asking_price_provided',
    known_facts: {},
    new_facts: seam('150k'),
  })
  assert.equal(transitionQualifiesForOpportunity(t), true)
  assert.equal(t.facts_patch?.asking_price?.value, 150_000)
})

test('P0-1: the price is kept even though ownership is unresolved', () => {
  // "Do not throw away the price merely because ownership remains unresolved."
  const t = resolveSellerStageTransition({
    stage_before: 'ownership_confirmation',
    intent: 'asking_price_provided',
    known_facts: {},
    new_facts: seam('150k'),
  })
  assert.equal(t.facts_patch?.asking_price?.value, 150_000)
  // and ownership is NOT invented
  assert.equal(t.facts_patch?.ownership_status, undefined)
})

test('P0-1: opportunity qualification does not imply ownership or acceptance', () => {
  const t = resolveSellerStageTransition({
    stage_before: 'ownership_confirmation', intent: 'asking_price_provided',
    known_facts: {}, new_facts: seam('150k'),
  })
  assert.equal(transitionQualifiesForOpportunity(t), true)
  assert.equal(t.facts_patch?.ownership_status, undefined)
  assert.equal(t.facts_patch?.terms_accepted, undefined)
})

// ── Idempotency: three identical "150k" statements ─────────────────────────

test('P0-1 IDEMPOTENT: repeating the same price yields one current value', () => {
  let facts = {}
  for (let i = 0; i < 10; i += 1) {
    facts = mergeSellerFacts(facts, seam('150k'), {})
  }
  assert.equal(facts.asking_price.value, 150_000)
  // One canonical current price, not an accumulating list.
  assert.ok(!Array.isArray(facts.asking_price))
})

test('P0-1: a repeated price keeps provenance rather than duplicating it', () => {
  const once = mergeSellerFacts({}, seam('150k'), {})
  const thrice = mergeSellerFacts(mergeSellerFacts(once, seam('150k'), {}), seam('150k'), {})
  assert.equal(thrice.asking_price.value, once.asking_price.value)
  assert.equal(thrice.asking_price.price_type, 'exact')
  assert.equal(thrice.asking_price.currency, 'USD')
})

test('P0-1: a CHANGED price supersedes rather than accumulating', () => {
  const first = mergeSellerFacts({}, seam('150k'), {})
  const second = mergeSellerFacts(first, seam('180k'), {})
  assert.equal(second.asking_price.value, 180_000)
})

// ── Multi-fact single inbound ──────────────────────────────────────────────

test('P0-1 MULTI-FACT: one inbound carries every canonical fact through the seam', () => {
  const out = seam("Yeah I own it. I'd take 220 and it's rented for 1400 month to month.")

  // Ownership evidence present (a claim, not verified authority).
  assert.ok(out.ownership_claim_evidence || out.ownership_status || out.ownership_claim,
    `ownership evidence missing: ${JSON.stringify(out)}`)
  // Occupancy
  assert.equal(out.occupancy_status, 'tenant_occupied')
})

test('P0-1 MULTI-FACT: no rent/price collision through the seam', () => {
  const out = seam("Yeah I own it. I'd take 220 and it's rented for 1400 month to month.")
  // Whatever is captured, a rent must never be recorded as the asking price
  // and the asking price must never land in the rent roll.
  if (out.asking_price !== undefined) {
    assert.notEqual(out.asking_price, 1400, 'rent captured as asking price')
  }
  if (out.reported_unit_rents !== undefined) {
    assert.ok(!String(out.reported_unit_rents).split(',').includes('220'),
      'asking price captured as rent')
  }
})

test('P0-1: a clean rent+price message keeps both, distinctly', () => {
  const out = seam("Rents are 7500 a month and I'd sell for 900k")
  assert.equal(out.asking_price, 900_000)
  assert.equal(out.monthly_gross_rent, 7500)
})

// ── Failure semantics ──────────────────────────────────────────────────────

test('P0-1: an empty inbound produces no fabricated facts', () => {
  const out = seam('')
  assert.equal(out.asking_price, undefined)
  assert.equal(out.ownership_status, undefined)
})

test('P0-1: a non-price reply does not manufacture a price', () => {
  const out = seam('Who is this?')
  assert.equal(out.asking_price, undefined)
})
