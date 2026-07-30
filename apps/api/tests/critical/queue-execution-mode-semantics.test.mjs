/**
 * Canonical fail-closed queue execution-mode semantics.
 *
 * Production was frozen on 2026-07-29 by writing the literal 'paused', which is
 * not one of the three canonical modes. These tests pin the contract so the
 * legacy value stays fail-closed and unknown values can never become unsafe.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import "../helpers/critical-test-environment.mjs";

import {
  QUEUE_EXECUTION_MODES,
  QUEUE_EXECUTION_MODE_LEGACY_ALIASES,
  CANONICAL_FAIL_CLOSED_EXECUTION_MODE,
  normalizeQueueExecutionMode,
  describeQueueExecutionMode,
  evaluateUnrestrictedDispatchGate,
  evaluateScopedCanaryDispatchGate,
} from "@/lib/domain/queue/queue-execution-mode.js";

test("canonical fail-closed storage value is stopped", () => {
  assert.equal(CANONICAL_FAIL_CLOSED_EXECUTION_MODE, "stopped");
  assert.equal(QUEUE_EXECUTION_MODES.STOPPED, "stopped");
});

test("stopped blocks all unrestricted dispatch", () => {
  const gate = evaluateUnrestrictedDispatchGate("stopped", { action: "runSendQueue" });
  assert.equal(gate.ok, false);
  assert.equal(gate.status, 423);
  assert.equal(gate.reason, "queue_execution_mode_stopped");
  assert.equal(gate.sent_count, 0);
  assert.equal(gate.claimed_count, 0);
});

test("legacy 'paused' remains fail-closed for compatibility", () => {
  assert.equal(normalizeQueueExecutionMode("paused"), "stopped");
  assert.equal(normalizeQueueExecutionMode("PAUSED"), "stopped");
  assert.equal(normalizeQueueExecutionMode("  paused  "), "stopped");
  assert.equal(normalizeQueueExecutionMode("pause"), "stopped");

  const gate = evaluateUnrestrictedDispatchGate("paused");
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "queue_execution_mode_stopped");

  // Reported as a legacy alias, not as an unrecognised value.
  const described = describeQueueExecutionMode("paused");
  assert.equal(described.mode, "stopped");
  assert.equal(described.raw, "paused");
  assert.equal(described.source, "legacy_alias");
  assert.equal(described.fail_closed, true);
  assert.ok(Object.hasOwn(QUEUE_EXECUTION_MODE_LEGACY_ALIASES, "paused"));
});

test("scoped_canary_only allows only scoped canary dispatch", () => {
  const unrestricted = evaluateUnrestrictedDispatchGate("scoped_canary_only");
  assert.equal(unrestricted.ok, false);
  assert.equal(unrestricted.reason, "queue_execution_mode_scoped_canary_only");

  const scoped = evaluateScopedCanaryDispatchGate("scoped_canary_only");
  assert.equal(scoped.ok, true);
  assert.equal(scoped.mode, "scoped_canary_only");

  // And a canary gate refuses every other mode, including normal.
  for (const mode of ["stopped", "paused", "normal", "garbage"]) {
    assert.equal(evaluateScopedCanaryDispatchGate(mode).ok, false, `${mode} must not pass canary gate`);
  }
});

test("normal is required for unrestricted production dispatch", () => {
  const gate = evaluateUnrestrictedDispatchGate("normal");
  assert.equal(gate.ok, true);
  assert.equal(gate.mode, "normal");
  assert.equal(describeQueueExecutionMode("normal").fail_closed, false);
});

test("unknown values fail closed and are reported as unknown", () => {
  for (const raw of ["", null, undefined, "on", "live", "enabled", "true", "1", "normal ish", "stopped;normal"]) {
    assert.equal(normalizeQueueExecutionMode(raw), "stopped", `${String(raw)} must fail closed`);
    assert.equal(evaluateUnrestrictedDispatchGate(raw).ok, false);
  }
  const described = describeQueueExecutionMode("enabled");
  assert.equal(described.source, "unknown_fail_closed");
  assert.equal(described.mode, "stopped");
  assert.equal(described.fail_closed, true);
  // An unknown value must never be reported as a canonical/deliberate posture.
  assert.notEqual(described.source, "canonical");
});

test("an explicit non-stopped fallback still cannot rescue an unknown value into normal by default", () => {
  // Callers may pass a fallback, but every production caller uses the default.
  assert.equal(normalizeQueueExecutionMode("garbage"), "stopped");
  assert.equal(normalizeQueueExecutionMode(undefined), "stopped");
});

test("SQL mirror normalizes paused to stopped too (JS/SQL parity)", () => {
  // The DB-side atomic claim path has its own normalizer; both layers must agree
  // that anything other than normal/scoped_canary_only is a stop.
  const sqlPath = path.join(
    process.cwd(),
    "supabase/migrations/20260625200000_queue_atomic_claim_containment.sql",
  );
  const sql = readFileSync(sqlPath, "utf8");
  const fnMatch = sql.match(/queue_execution_mode_normalized[\s\S]*?\$\$;/);
  assert.ok(fnMatch, "expected queue_execution_mode_normalized() in the containment migration");
  const body = fnMatch[0];
  assert.match(body, /WHEN 'normal' THEN 'normal'/);
  assert.match(body, /WHEN 'scoped_canary_only' THEN 'scoped_canary_only'/);
  // The catch-all must be the fail-closed value, which is what makes the stored
  // legacy 'paused' safe at the database layer.
  assert.match(body, /ELSE 'stopped'/);
});
