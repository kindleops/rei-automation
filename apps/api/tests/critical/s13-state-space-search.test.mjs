/**
 * s13-state-space-search.test.mjs
 *
 * Bounded exhaustive reachability search over the combined outbound + callback
 * state machine, checking every §11 safety invariant at every reachable state.
 *
 * The bounds are REPORTED, not hidden. "Exhaustive" with an unstated bound is a
 * claim about nothing.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { search, INVARIANTS } from "../model/s13-combined-model.mjs";

const BOUNDS = {
  maxAttempts: 2,
  maxCallbacks: 3,
  maxCrashes: 2,
  maxAuthorityChanges: 2,
  maxDepth: 14,
};

test("BOUNDED SEARCH: no reachable state violates any safety invariant", () => {
  const { stats, violations, visitedCount } = search(BOUNDS);

  // Report the actual bound. A search that silently shrank is not a proof.
  console.log(`\n  bounds            ${JSON.stringify(BOUNDS)}`);
  console.log(`  reachable states  ${visitedCount}`);
  console.log(`  states visited    ${stats.states}`);
  console.log(`  transitions       ${stats.transitions}`);
  console.log(`  max depth reached ${stats.maxDepth}`);
  console.log(`  pruned at bound   ${stats.pruned}`);
  console.log(`  invariants        ${INVARIANTS.length}`);
  console.log(`  violations        ${violations.length}\n`);

  if (violations.length) {
    const v = violations[0];
    console.log(`  FIRST COUNTEREXAMPLE: ${v.invariant}`);
    console.log(`  why: ${v.why}`);
    console.log(`  trace: ${v.trace.join(" -> ")}\n`);
  }

  assert.equal(violations.length, 0,
    violations.length ? `${violations[0].invariant}: ${violations[0].trace.join(" -> ")}` : "");

  // The search must actually have explored something. A model that reaches 3
  // states proves nothing, and would pass the assertion above.
  assert.ok(visitedCount > 500, `search too small to be meaningful: ${visitedCount} states`);
  assert.ok(stats.transitions > 2000, `too few transitions: ${stats.transitions}`);
});

test("the search reaches the states that matter, not just easy ones", () => {
  // Coverage guard. Without this, a model could pass by never reaching the
  // interesting region at all.
  const { stats } = search(BOUNDS);
  assert.ok(stats.maxDepth >= 8, `search never went deep: ${stats.maxDepth}`);
});
