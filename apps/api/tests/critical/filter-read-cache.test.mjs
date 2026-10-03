import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cachedFilterRead, __resetFilterReadCacheForTests, __filterReadStateForTests } from "../../src/lib/domain/inbox/filter-read-cache.js";

// The Advanced Filters sheet fired 14 option scans + a count at once and every
// one hit the statement timeout on prod. Reads are now cached, coalesced, bounded.
beforeEach(() => __resetFilterReadCacheForTests());
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("the same question asked concurrently runs once", async () => {
  let calls = 0;
  const fn = async () => { calls += 1; await tick(10); return ["a"]; };
  const [a, b, c] = await Promise.all([cachedFilterRead("k", fn), cachedFilterRead("k", fn), cachedFilterRead("k", fn)]);
  assert.equal(calls, 1);
  assert.deepEqual([a, b, c], [["a"], ["a"], ["a"]]);
});

test("a cached answer is served until the TTL, then re-read", async () => {
  let calls = 0; let t = 1_000;
  const fn = async () => { calls += 1; return calls; };
  assert.equal(await cachedFilterRead("k", fn, { now: () => t }), 1);
  t += 1_000;
  assert.equal(await cachedFilterRead("k", fn, { now: () => t, ttlMs: 5_000 }), 1);
  t += 10_000;
  assert.equal(await cachedFilterRead("k", fn, { now: () => t, ttlMs: 5_000 }), 2);
});

test("failures are never cached", async () => {
  let calls = 0;
  const bad = async () => { calls += 1; throw new Error("canceling statement due to statement timeout"); };
  await assert.rejects(cachedFilterRead("k", bad));
  await assert.rejects(cachedFilterRead("k", bad));
  assert.equal(calls, 2);
  assert.equal(await cachedFilterRead("k", async () => 7), 7);
});

test("at most three distinct scans run at once; the rest queue and all finish", async () => {
  let running = 0; let peak = 0;
  const fn = (v) => async () => { running += 1; peak = Math.max(peak, running); await tick(15); running -= 1; return v; };
  const out = await Promise.all(Array.from({ length: 8 }, (_, i) => cachedFilterRead(`k${i}`, fn(i))));
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);
  assert.equal(__filterReadStateForTests().active, 0);
});

test("stale-while-revalidate serves the old answer at once and refreshes behind it", async () => {
  let t = 0; let calls = 0;
  const fn = async () => { calls += 1; await tick(5); return calls; };
  assert.equal(await cachedFilterRead("k", fn, { now: () => t, ttlMs: 100, staleMs: 10_000 }), 1);
  t = 500; // past ttl, inside stale window
  assert.equal(await cachedFilterRead("k", fn, { now: () => t, ttlMs: 100, staleMs: 10_000 }), 1);
  await tick(20);
  assert.equal(calls, 2);
  assert.equal(await cachedFilterRead("k", fn, { now: () => t, ttlMs: 100, staleMs: 10_000 }), 2);
  t = 50_000; // past the stale window: waits for a fresh read
  assert.equal(await cachedFilterRead("k", fn, { now: () => t, ttlMs: 100, staleMs: 10_000 }), 3);
});
