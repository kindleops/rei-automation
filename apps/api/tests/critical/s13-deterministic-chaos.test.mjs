/**
 * s13-deterministic-chaos.test.mjs
 *
 * Seeded, reproducible chaos over the combined model.
 *
 * The bounded search proves there is no unsafe state within its bounds. Chaos
 * does a different job: it walks LONG traces -- far past the search depth --
 * where crashes, redeliveries, reorderings and authority changes compound. A
 * defect that needs eleven steps to appear is invisible to a depth-14 exhaustive
 * search of a much wider space, but a random walk finds it.
 *
 * Every run is reproducible from its seed. A chaos suite you cannot replay is a
 * rumour, not a test.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { initialState, transitions, INVARIANTS } from "../model/s13-combined-model.mjs";

/** mulberry32: tiny, fast, fully deterministic from a 32-bit seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform selection is the wrong sampler here.
 *
 * Authority withdrawal and projection toggles are always available, so uniform
 * choice spends most of its budget on them and the walk dies before it ever
 * reaches a provider call. That yields a green report that exercised almost
 * nothing. Weighting keeps the walk on the productive path while still visiting
 * the disruptive transitions often enough to matter.
 */
function weightOf(name) {
  if (name === 'brake_engaged' || name === 'stop_received') return 1;
  if (name.startsWith('projection_')) return 1;
  if (name.startsWith('poll_observation')) return 2;
  if (name === 'crash_restart') return 3;
  if (name === 'provider_redelivers') return 4;
  if (name.startsWith('callback:')) return 8;
  return 10; // allocate / commit_request_started / provider:*
}

function weightedPick(opts, rand) {
  const total = opts.reduce((n, o) => n + weightOf(o.name), 0);
  let r = rand() * total;
  for (const o of opts) {
    r -= weightOf(o.name);
    if (r <= 0) return o;
  }
  return opts[opts.length - 1];
}

const BOUNDS = {
  maxAttempts: 2, maxCallbacks: 3, maxCrashes: 3,
  maxAuthorityChanges: 2, maxDepth: Infinity,
};

const SEEDS = 4000;
const STEPS = 40;

function runSeed(seed) {
  const rand = rng(seed);
  let s = initialState();
  const trace = ['INIT'];
  const counts = { steps: 0, crashes: 0, callbacks: 0, duplicates: 0, polls: 0, authority: 0 };

  for (let i = 0; i < STEPS; i += 1) {
    const opts = transitions(s, BOUNDS);
    if (!opts.length) break;
    const pick = weightedPick(opts, rand);
    s = pick.next;
    trace.push(pick.name);
    counts.steps += 1;
    if (pick.name.includes('crash')) counts.crashes += 1;
    if (pick.name.startsWith('callback:')) counts.callbacks += 1;
    if (pick.name.includes('duplicate')) counts.duplicates += 1;
    if (pick.name.startsWith('poll_observation')) counts.polls += 1;
    if (pick.name === 'brake_engaged' || pick.name === 'stop_received') counts.authority += 1;

    for (const inv of INVARIANTS) {
      if (!inv.check(s)) {
        return { seed, violated: inv.id, why: inv.why, trace, counts, state: s };
      }
    }
  }
  return { seed, violated: null, trace, counts, state: s };
}

test(`DETERMINISTIC CHAOS: ${SEEDS} seeds x up to ${STEPS} steps, zero safety violations`, () => {
  const total = {
    seeds: 0, steps: 0, crashes: 0, callbacks: 0, duplicates: 0, polls: 0,
    authority: 0, providerCalls: 0, sellerSends: 0, maxSellerSends: 0,
  };
  const failures = [];

  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const r = runSeed(seed);
    total.seeds += 1;
    total.steps += r.counts.steps;
    total.crashes += r.counts.crashes;
    total.callbacks += r.counts.callbacks;
    total.duplicates += r.counts.duplicates;
    total.polls += r.counts.polls;
    total.authority += r.counts.authority;
    total.providerCalls += r.state.providerCalls;
    total.sellerSends += r.state.sellerVisibleSends;
    total.maxSellerSends = Math.max(total.maxSellerSends, r.state.sellerVisibleSends);
    if (r.violated) failures.push(r);
  }

  console.log(`\n  seeds                  ${total.seeds}`);
  console.log(`  transitions taken      ${total.steps}`);
  console.log(`  crashes injected       ${total.crashes}`);
  console.log(`  callbacks processed    ${total.callbacks}`);
  console.log(`  duplicate callbacks    ${total.duplicates}`);
  console.log(`  poll observations      ${total.polls}`);
  console.log(`  authority changes      ${total.authority}`);
  console.log(`  provider invocations   ${total.providerCalls}`);
  console.log(`  seller-visible sends   ${total.sellerSends}`);
  console.log(`  MAX sends per logical  ${total.maxSellerSends}`);
  console.log(`  safety violations      ${failures.length}\n`);

  if (failures.length) {
    const f = failures[0];
    console.log(`  FAILING SEED ${f.seed}: ${f.violated}`);
    console.log(`  ${f.why}`);
    console.log(`  trace: ${f.trace.join(' -> ')}\n`);
  }

  assert.equal(failures.length, 0,
    failures.length ? `seed ${failures[0].seed}: ${failures[0].violated}` : '');

  // THE property, restated over the whole campaign.
  assert.ok(total.maxSellerSends <= 1,
    `a logical communication reached the seller ${total.maxSellerSends} times`);

  // Non-vacuity: a campaign that never crashed or never delivered a callback
  // would pass trivially.
  assert.ok(total.crashes > 500, `too few crashes exercised: ${total.crashes}`);
  assert.ok(total.callbacks > 2000, `too few callbacks exercised: ${total.callbacks}`);
  assert.ok(total.providerCalls > 1000, `too few provider calls: ${total.providerCalls}`);
});

test("chaos is reproducible: the same seed yields the identical trace", () => {
  for (const seed of [7, 1234, 99999]) {
    const a = runSeed(seed);
    const b = runSeed(seed);
    assert.deepEqual(a.trace, b.trace, `seed ${seed} was not reproducible`);
  }
});

test("chaos under mutation DOES find the defect (non-vacuity of the harness)", () => {
  // If the harness cannot detect a known defect, its clean report means nothing.
  let found = null;
  for (let seed = 1; seed <= 2000 && !found; seed += 1) {
    const rand = rng(seed);
    let s = initialState();
    const trace = ['INIT'];
    for (let i = 0; i < STEPS; i += 1) {
      const opts = transitions(s, { ...BOUNDS, mutation: 'no_sibling_guard' });
      if (!opts.length) break;
      const pick = weightedPick(opts, rand);
      s = pick.next; trace.push(pick.name);
      const bad = INVARIANTS.find((inv) => !inv.check(s));
      if (bad) { found = { seed, inv: bad.id, trace }; break; }
    }
  }
  assert.ok(found, 'the chaos harness failed to detect a deliberately broken guard');
  console.log(`  harness caught ${found.inv} at seed ${found.seed} in ${found.trace.length} steps`);
});
