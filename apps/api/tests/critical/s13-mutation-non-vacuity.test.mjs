/**
 * s13-mutation-non-vacuity.test.mjs
 *
 * THE PROOF THAT THE PROOF IS WORTH ANYTHING.
 *
 * A model check that reports "0 violations" is indistinguishable from a model
 * check that cannot detect violations at all. So every load-bearing guard is
 * removed one at a time, and each removal MUST produce a counterexample.
 *
 * A mutation that survives is not good news. It means either the invariant set
 * has a hole, or the guard was never load-bearing in the first place. Both are
 * findings.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { search } from "../model/s13-combined-model.mjs";

const BASE = {
  maxAttempts: 2, maxCallbacks: 2, maxCrashes: 1,
  maxAuthorityChanges: 1, maxDepth: 11,
  // BFS visits in depth order, so the first violation IS a minimal-length
  // counterexample. Continuing past it only re-derives the same defect.
  stopOnFirstViolation: true,
};

/** Each mutation names the guard removed and the invariant that must catch it. */
const MUTATIONS = [
  { id: 'no_sibling_guard',
    removes: 'the active-attempt sibling guard',
    expect: ['S5_NO_ACTIVE_SIBLING_PAIR', 'S1_SINGLE_SELLER_VISIBLE_SEND'] },
  { id: 'weak_ambiguity_retry',
    removes: 'ambiguity absorbing retry authority',
    expect: ['S1_SINGLE_SELLER_VISIBLE_SEND', 'S3_AMBIGUITY_ABSORBS_RETRY', 'S4_PROVIDER_ACCEPTED_ABSORBS_RETRY'] },
  { id: 'weak_request_started_ordering',
    removes: 'provider_request_started committed before the network call',
    expect: ['S2_REQUEST_STARTED_BEFORE_NETWORK'] },
  { id: 'no_cas',
    removes: 'the callback compare-and-swap (reproduces the Slice 2 defect)',
    expect: ['S7_DELIVERED_NEVER_REGRESSES'] },
  { id: 'weak_stale_protection',
    removes: 'lattice stale rejection',
    expect: ['S7_DELIVERED_NEVER_REGRESSES'] },
  { id: 'allow_delivered_regression',
    removes: 'conflict handling for contradictory terminal verdicts',
    expect: ['S7_DELIVERED_NEVER_REGRESSES'] },
  { id: 'orphan_at_least_one',
    removes: 'strict exactly-one orphan adoption',
    // Caught by MISATTRIBUTION, not SID uniqueness. Adopting the first of two
    // candidates still binds one SID to one attempt, so S6 is satisfied while
    // the receipt is credited to a communication it may not describe -- which
    // is the actual harm.
    expect: ['S15_NO_AMBIGUOUS_ORPHAN_ADOPTION'] },
  { id: 'poll_may_advance',
    removes: 'the provenance gate on poll observations',
    expect: ['ANY'] },
  { id: 'no_stop_reevaluation',
    removes: 'runtime/compliance re-evaluation before sending',
    expect: ['S13_NO_PROVIDER_CALL_WITHOUT_AUTHORITY', 'S1_SINGLE_SELLER_VISIBLE_SEND'] },
  { id: 'projection_is_authority',
    removes: 'projection non-authority',
    expect: ['ANY'] },
  { id: 'no_trust_gate',
    removes: 'the callback receipt trust gate (Slice 4)',
    // The forged-callback adversary: an unauthenticated POST claiming an
    // outcome for a SID it does not own.
    expect: ['S17_UNTRUSTED_CANNOT_ADVANCE_TRUSTED_TRUTH'] },
  { id: 'dedupe_on_recorded',
    removes: 'dedupe-on-processed (reproduces the Slice 2 stranded-callback defect)',
    expect: ['LIVENESS'] },
];

test("BASELINE: the unmutated model has zero violations", () => {
  const r = search({ ...BASE, stopOnFirstViolation: false });
  assert.equal(r.violations.length, 0);
});

for (const m of MUTATIONS) {
  test(`MUTATION ${m.id}: removing ${m.removes} must be caught`, () => {
    const r = search({ ...BASE, mutation: m.id });

    if (m.expect.includes('LIVENESS')) {
      // The stranded-callback defect is a LOSS OF PROGRESS, not an unsafe state.
      // It is caught by convergence, not by a safety invariant -- so it is
      // asserted in s13-liveness, and here we only pin that the mutation
      // genuinely changes reachable behaviour.
      // Lost progress produces no unsafe state, so it is proven in
      // s13-liveness.test.mjs as an UNREACHABILITY result. Here we only pin
      // that the switch genuinely alters reachable behaviour.
      const base = search({ ...BASE, stopOnFirstViolation: false });
      const mut = search({ ...BASE, mutation: m.id, stopOnFirstViolation: false });
      assert.notEqual(mut.visitedCount, base.visitedCount,
        `${m.id} changed nothing at all -- the switch is not wired`);
      console.log(`  ${m.id.padEnd(30)} -> proven in s13-liveness (lost progress, `
        + `${base.visitedCount} vs ${mut.visitedCount} states)`);
      return;
    }

    assert.ok(r.violations.length > 0,
      `SURVIVED: removing ${m.removes} produced no counterexample. `
      + `Either the invariant set has a hole or the guard is not load-bearing.`);

    const hit = new Set(r.violations.map((v) => v.invariant));
    if (!m.expect.includes('ANY')) {
      const matched = m.expect.some((e) => hit.has(e));
      assert.ok(matched,
        `caught by ${[...hit].join(',')} but expected one of ${m.expect.join(',')}`);
    }

    // A counterexample is only useful if it comes with a trace.
    const v = r.violations.find((x) => m.expect.includes('ANY') || m.expect.includes(x.invariant))
      || r.violations[0];
    assert.ok(Array.isArray(v.trace) && v.trace.length > 0, 'counterexample has no trace');
    console.log(`  ${m.id.padEnd(30)} -> ${v.invariant}`);
    console.log(`     minimal trace: ${v.trace.join(' -> ')}`);
  });
}
