import test from "node:test";
import assert from "node:assert/strict";

import { runSupabaseOutboundFeeder } from "@/lib/domain/outbound/run-supabase-outbound-feeder.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fast no-op pipeline deps — no DB calls, all injectable.
function makeFastDeps(overrides = {}) {
  return {
    _loadCandidates: async () => ({ rows: [], scanned_count: 0, source: "test" }),
    _resolveNextTouch: async () => ({ ok: true, touch_number: 1, template_use_case: "ownership_check", stage_code: "T1", is_first_touch: true }),
    _evaluateEligibility: async () => ({ ok: true, scheduled_for: new Date().toISOString() }),
    _chooseNumber: async () => ({ ok: true, from_phone_number: "+15005550099", textgrid_number_id: "tg-1" }),
    _renderTemplate: async () => ({ ok: false, reason_code: "NO_TEMPLATE" }),
    _insertRow: async () => ({ ok: true }),
    canSend: async () => ({ ok: true }),
    ...overrides,
  };
}

// Slow-completing pipeline: delay then returns empty candidates.
function makeSlowDeps(delay_ms = 50) {
  return {
    ...makeFastDeps(),
    _loadCandidates: async () => {
      await new Promise(r => setTimeout(r, delay_ms));
      return { rows: [], scanned_count: 0, source: "test" };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("RISK-003: concurrent second caller returns feeder_already_running immediately", async () => {
  let lock_state = false;

  const acquire = () => {
    if (lock_state) return false;
    lock_state = true;
    return true;
  };
  const release = () => { lock_state = false; };

  // Start first run (slow enough that second fires while first holds lock)
  const first = runSupabaseOutboundFeeder(
    { limit: 5 },
    { ...makeSlowDeps(80), _acquireFeederLock: acquire, _releaseFeederLock: release }
  );

  // Give first run time to acquire lock before second fires
  await new Promise(r => setTimeout(r, 15));

  // Second concurrent run should bounce immediately
  const second = await runSupabaseOutboundFeeder(
    { limit: 5 },
    { ...makeFastDeps(), _acquireFeederLock: acquire, _releaseFeederLock: release }
  );

  assert.equal(second.ok, false);
  assert.equal(second.reason, "feeder_already_running");
  assert.equal(second.queued_count, 0);
  assert.equal(second.skipped_count, 0);

  // First run must still complete
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
});

test("RISK-003: lock is released after normal completion", async () => {
  let lock_state = false;
  let acquire_count = 0;

  const acquire = () => {
    if (lock_state) return false;
    lock_state = true;
    acquire_count++;
    return true;
  };
  const release = () => { lock_state = false; };

  await runSupabaseOutboundFeeder(
    { limit: 5 },
    { ...makeFastDeps(), _acquireFeederLock: acquire, _releaseFeederLock: release }
  );
  assert.equal(lock_state, false, "lock must be released after completion");

  // Second sequential run can now acquire
  await runSupabaseOutboundFeeder(
    { limit: 5 },
    { ...makeFastDeps(), _acquireFeederLock: acquire, _releaseFeederLock: release }
  );
  assert.equal(acquire_count, 2, "second sequential run must be able to acquire the lock");
});

test("RISK-003: lock is released after error in _runFeeder", async () => {
  let lock_state = false;

  const acquire = () => {
    if (lock_state) return false;
    lock_state = true;
    return true;
  };
  const release = () => { lock_state = false; };

  const result = await runSupabaseOutboundFeeder(
    { limit: 5 },
    {
      ...makeFastDeps(),
      _loadCandidates: async () => { throw new Error("db_error_for_test"); },
      _acquireFeederLock: acquire,
      _releaseFeederLock: release,
    }
  );

  assert.equal(lock_state, false, "lock must be released even when _runFeeder throws");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes("db_error_for_test")));
});

test("RISK-003: feeder_already_running result has zero counts", async () => {
  const result = await runSupabaseOutboundFeeder(
    { limit: 10 },
    {
      ...makeFastDeps(),
      _acquireFeederLock: () => false, // always blocked
      _releaseFeederLock: () => {},
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "feeder_already_running");
  assert.equal(result.queued_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.equal(result.scanned_count, 0);
  assert.equal(result.eligible_count, 0);
  assert.deepEqual(result.errors, []);
});

test("RISK-003: injectable lock allows full test isolation (no shared module state leaked)", async () => {
  let lock_a = false;
  let lock_b = false;

  const depsA = {
    ...makeFastDeps(),
    _acquireFeederLock: () => { if (lock_a) return false; lock_a = true; return true; },
    _releaseFeederLock: () => { lock_a = false; },
  };
  const depsB = {
    ...makeFastDeps(),
    _acquireFeederLock: () => { if (lock_b) return false; lock_b = true; return true; },
    _releaseFeederLock: () => { lock_b = false; },
  };

  const [resultA, resultB] = await Promise.all([
    runSupabaseOutboundFeeder({ limit: 5 }, depsA),
    runSupabaseOutboundFeeder({ limit: 5 }, depsB),
  ]);

  // Both should succeed independently since they use separate lock state
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
});
