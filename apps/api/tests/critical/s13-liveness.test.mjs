/**
 * s13-liveness.test.mjs
 *
 * Safety says nothing bad happens. That is satisfied perfectly by a system that
 * does nothing at all -- so safety alone cannot distinguish "correct" from
 * "stuck". These are the progress properties.
 *
 * They are deliberately NOT universal. §11 contains irreducible ambiguity by
 * design, and demanding convergence there would force the system to invent
 * certainty it does not have.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { reachable, OUTCOME, POSSIBILITY, RETRY } from "../model/s13-combined-model.mjs";

const BOUNDS = {
  maxAttempts: 2, maxCallbacks: 2, maxCrashes: 1,
  maxAuthorityChanges: 1, maxDepth: 11,
};

test("L1 convergence: provider truth eventually becomes canonical", () => {
  const r = reachable(BOUNDS, (s) => s.attempts.some((a) => a.outcome === OUTCOME.DELIVERED));
  assert.ok(r.found, "delivered provider truth must be reachable as canonical state");
  console.log(`  L1 trace: ${r.trace.join(" -> ")}`);
});

test("L2 recovery: a callback recorded then crashed CAN still be applied", () => {
  // The dual of the Slice 2 stranded-callback defect. The good state must
  // remain reachable after a crash between recording and applying.
  const r = reachable(BOUNDS, (s) =>
    s.events.some((e) => e.strandedOnce === true && e.processing === "applied"));
  assert.ok(r.found,
    "after a crash between recording and applying, redelivery must still converge");
  console.log(`  L2 trace: ${r.trace.join(" -> ")}`);
});

test("L2-MUTANT: dedupe-on-recorded makes that recovery UNREACHABLE", () => {
  // This is the counterexample for the stranded-callback defect. It is a
  // LOST-PROGRESS counterexample: no unsafe state is ever entered, the good
  // state simply stops existing.
  const good = (s) => s.events.some((e) => e.strandedOnce === true && e.processing === "applied");

  const baseline = reachable(BOUNDS, good);
  const mutant = reachable({ ...BOUNDS, mutation: "dedupe_on_recorded" }, good);

  assert.ok(baseline.found, "baseline must recover");
  assert.equal(mutant.found, false,
    "MUTATION SURVIVED: dedupe-on-recorded should strand the event permanently");
  console.log(`  baseline recovers in ${baseline.trace.length} steps; `
    + `mutant: unreachable after exploring ${mutant.explored} states`);
});

test("L3 irreducible ambiguity may persist forever, and must not self-resolve", () => {
  // A timeout with no SID and no callback cannot be resolved by waiting. The
  // model must NOT converge it, and must never hand back retry authority.
  const stuck = (s) => s.possibility === POSSIBILITY.MAY_HAVE_BEEN_SENT
    && s.inflight.length === 0
    && s.attempts.every((a) => a.completed);
  const r = reachable(BOUNDS, stuck);
  assert.ok(r.found, "permanent ambiguity must be a legitimate resting state");

  // and from there, retry must never be reachable
  const unsafe = (s) => s.possibility === POSSIBILITY.MAY_HAVE_BEEN_SENT
    && (s.retry === RETRY.ALLOWED || s.retry === RETRY.AFTER);
  const bad = reachable(BOUNDS, unsafe);
  assert.equal(bad.found, false, "ambiguity must never regain retry authority");
  console.log(`  L3 resting-state trace: ${r.trace.join(" -> ")}`);
});

test("L4 orphan liveness: exactly-one binds; zero and multi must NOT", () => {
  const adopted = (s) => s.events.some((e) => e.bound !== null && e.processing === "applied");
  assert.ok(reachable(BOUNDS, adopted).found, "a lone strict candidate must be adoptable");

  const forced = (s) => s.events.some((e) => e.ambiguousAdoption === true);
  assert.equal(reachable(BOUNDS, forced).found, false,
    "insufficient evidence must never be forced to converge");
});
