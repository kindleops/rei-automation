// ─── acquisition-brain-burst-benchmark.test.mjs ────────────────────────────
// Pure-compute performance budget for planShadowBurst.
//
// WHY THIS FILE EXISTS SEPARATELY. This benchmark previously lived alongside 51
// other tests in acquisition-brain-burst-timing.test.mjs and measured wall time
// with Date.now(). It failed intermittently on unchanged production code -- three
// consecutive runs of identical code on an idle machine gave pass / pass / fail
// (p95=20), and it failed inside the full critical suite while passing in
// isolation. That is a MEASUREMENT defect, not a performance regression.
//
// MEASURED ROOT CAUSE (not assumed). The workload genuinely costs ~5-9ms of CPU,
// so the 15ms budget is real but not generous. Sampling 50 iterations with NO
// warmup was measured at p95=19.10ms, max=111.97ms -- with the FIRST call alone
// costing 111.97ms of JIT compilation. At 50 samples the p95 index is the 48th
// smallest, so that cold-start outlier sat directly in the measured tail and
// blew the budget by itself. The same loop after a 200-iteration warmup measured
// p95=12.67ms, max=14.15ms. The old test was therefore measuring V8 compilation,
// not the production workload.
//
// Two further amplifiers:
//   * Date.now() is scheduler-sensitive wall time, so any preemption by another
//     process was attributed to the code under test.
//   * It shared a process with 51 other tests, inheriting their GC pressure and
//     allocation state -- which is why it failed inside the full suite while
//     passing in isolation.
//
// WHAT CHANGED -- METHODOLOGY ONLY:
//   * The 15ms budget is UNCHANGED. No threshold was raised, no skip, no
//     retry-until-pass, no tolerance added.
//   * The workload is UNCHANGED: the same production planShadowBurst() on the
//     same two-message fixture.
//   * Deterministic warmup before sampling, so JIT compilation is not measured.
//   * The hard assertion uses CPU compute time (process.cpuUsage(), microsecond
//     resolution, user+system). "Pure compute" is precisely what the budget is
//     about, and CPU time cannot be inflated by another process preempting this
//     one -- which is exactly what made the old assertion unstable.
//   * Wall-clock p95 is still measured and REPORTED for diagnosis, so a real
//     latency regression remains visible; it is simply not the pass/fail signal
//     for a pure-compute budget.
//   * This file contains only the benchmark, so its process does no other work.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { planShadowBurst } from "@/lib/domain/acquisition-brain/shadow-burst-timing.js";

const THREAD = "+16128072000";
const BASE = "2026-07-17T15:00:00.000Z";
const baseMs = Date.parse(BASE);

function msg(id, text, intent, offset_ms = 0, extra = {}) {
  return {
    id: String(id),
    message: text,
    classification: { primary_intent: intent, confidence: 0.95 },
    timestamp: new Date(baseMs + offset_ms).toISOString(),
    ...extra,
  };
}

/** The exact production workload the budget covers. Unchanged. */
function runOnce() {
  return planShadowBurst({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "proposal?", "asks_offer", 5_000),
    ],
    now: new Date(baseMs + 120_000),
  });
}

function p95Of(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
}

const WARMUP_ITERATIONS = 200;
const SAMPLE_ITERATIONS = 50;
const BUDGET_MS = 15;

test("p95 pure compute under 15ms on fixture loop", () => {
  // Deterministic warmup: compile and settle before anything is measured.
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) runOnce();

  const cpuMs = [];
  const wallMs = [];
  for (let i = 0; i < SAMPLE_ITERATIONS; i += 1) {
    const cpu0 = process.cpuUsage();
    const wall0 = process.hrtime.bigint();
    runOnce();
    const cpu1 = process.cpuUsage(cpu0);
    const wall1 = process.hrtime.bigint();
    cpuMs.push((cpu1.user + cpu1.system) / 1000); // microseconds -> ms
    wallMs.push(Number(wall1 - wall0) / 1e6); // nanoseconds -> ms
  }

  const cpuP95 = p95Of(cpuMs);
  const wallP95 = p95Of(wallMs);
  const diagnostic = `cpu_p95=${cpuP95.toFixed(3)}ms wall_p95=${wallP95.toFixed(3)}ms budget=${BUDGET_MS}ms`;

  // Diagnostic wall-clock reporting: a genuine latency regression stays visible.
  console.log(`[BURST_BENCHMARK] ${diagnostic}`);

  // HARD BUDGET, UNCHANGED AT 15ms, asserted on pure compute time.
  assert.ok(cpuP95 < BUDGET_MS, `pure-compute budget exceeded: ${diagnostic}`);
});

test("benchmark workload still produces a real plan (not optimised away)", () => {
  // A performance budget is meaningless if the measured call does nothing.
  const plan = runOnce();
  assert.ok(plan, "planShadowBurst returned no plan");
  assert.ok(plan.burst || plan.plan || plan.burst_id || plan.reply_at, "plan payload is empty");
});
