/**
 * A REQUEST-BODY BOOLEAN IS NOT AUTHORITY.
 *
 * `evaluateCanonicalSendAuthority` returns ok:true UNCONDITIONALLY when
 * `scopedCanary === true`, and that flag originates from a caller-controlled
 * request body (queue-run-request.js reads body.scoped_canary /
 * body.scopedCanary / ?scoped_canary=). Read alone, that looks like a bypass of
 * the emergency stop, the processor mode and the execution mode.
 *
 * It is not, because the canonical authority is NOT the boundary for that path
 * — the scoped-canary architecture is, and it re-verifies everything against
 * durable rows the caller does not control. This file pins that, so the
 * shortcut cannot quietly become a real bypass.
 *
 * HARDENING DEBT, recorded deliberately: the unconditional early return in
 * evaluateCanonicalSendAuthority should be replaced by an explicit
 * "scoped-canary authority was actually established" verdict before any
 * multi-row or broader canary. Tracked here rather than refactored mid-release.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateInternalProofContactWindowBypass } from "@/lib/domain/queue/internal-proof-session.js";
import {
  parseScopedCanaryRequest,
  validateScopedCanaryRequest,
  validateScopedCanaryAllowlist,
  SCOPED_CANARY_MAX_ROWS,
} from "@/lib/domain/queue/run-scoped-campaign-canary.js";

const ROW_ID = "row-canary-1";
const OTHER_ROW = "row-canary-2";
const CAMPAIGN = "camp-canary-1";
const RUN_ID = "run-canary-1";

/** The full conjunction, as runScopedCampaignCanary forwards it. */
function fullContext(overrides = {}) {
  return {
    scoped_canary: true,
    authorization_validated: true,
    canary_run_id: RUN_ID,
    scoped_canary_max_rows: 1,
    scoped_canary_requested_ids: [ROW_ID],
    getSystemValue: async (key) =>
      key === "queue_execution_mode" ? "scoped_canary_only" : null,
    ...overrides,
  };
}

const row = { id: ROW_ID };

// ══════════════════════════════════════════════════════════════════════════
// EVERY DENIAL CASE
// ══════════════════════════════════════════════════════════════════════════

test("body flag alone, with no scoped-canary execution context, denies", async () => {
  // This is literally "the caller said scopedCanary:true and nothing else".
  const verdict = await evaluateInternalProofContactWindowBypass(row, {
    scoped_canary: false,
    getSystemValue: async () => "scoped_canary_only",
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "not_scoped_canary_dispatch");
});

test("no validated authorization denies", async () => {
  const verdict = await evaluateInternalProofContactWindowBypass(
    row,
    fullContext({ authorization_validated: false }),
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "authorization_not_validated");
});

test("missing canary_run_id denies", async () => {
  for (const bad of [undefined, null, "", "   "]) {
    const verdict = await evaluateInternalProofContactWindowBypass(
      row,
      fullContext({ canary_run_id: bad }),
    );
    assert.equal(verdict.allowed, false, `canary_run_id=${JSON.stringify(bad)}`);
    assert.equal(verdict.reason, "canary_run_id_required");
  }
});

test("a second row under the same request denies — max_rows must be exactly one", async () => {
  for (const bad of [2, 3, 0, null, undefined]) {
    const verdict = await evaluateInternalProofContactWindowBypass(
      row,
      fullContext({ scoped_canary_max_rows: bad }),
    );
    assert.equal(verdict.allowed, false, `max_rows=${bad}`);
    assert.equal(verdict.reason, "max_rows_must_be_one");
  }
});

test("a manifest carrying two rows denies even when max_rows says one", async () => {
  const verdict = await evaluateInternalProofContactWindowBypass(
    row,
    fullContext({ scoped_canary_requested_ids: [ROW_ID, OTHER_ROW] }),
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "request_manifest_not_single_row");
});

test("the WRONG row denies — the manifest must name the row being dispatched", async () => {
  const verdict = await evaluateInternalProofContactWindowBypass(
    row,
    fullContext({ scoped_canary_requested_ids: [OTHER_ROW] }),
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "request_manifest_not_single_row");
});

test("execution mode not scoped_canary_only denies, read FRESH each time", async () => {
  // A cached mode must not outlive an operator stop.
  for (const mode of ["normal", "stopped", "", null, "SCOPED_CANARY", "paused"]) {
    const verdict = await evaluateInternalProofContactWindowBypass(
      row,
      fullContext({ getSystemValue: async () => mode }),
    );
    assert.equal(verdict.allowed, false, `mode=${JSON.stringify(mode)}`);
    assert.equal(verdict.reason, "queue_execution_mode_not_scoped_canary_only");
  }
});

test("with the whole conjunction satisfied, an ABSENT proof session still denies", async () => {
  // The last gate. Everything else is correct here; there is simply no session.
  const verdict = await evaluateInternalProofContactWindowBypass(row, fullContext());
  assert.equal(verdict.allowed, false, "no active proof session must deny");
  assert.notEqual(verdict.reason, undefined);
  // And it must NOT be one of the earlier reasons - we got all the way here.
  for (const earlier of [
    "not_scoped_canary_dispatch",
    "authorization_not_validated",
    "canary_run_id_required",
    "max_rows_must_be_one",
    "request_manifest_not_single_row",
    "queue_execution_mode_not_scoped_canary_only",
  ]) {
    assert.notEqual(verdict.reason, earlier);
  }
});

test("a missing row id denies before anything else is consulted", async () => {
  const verdict = await evaluateInternalProofContactWindowBypass({}, fullContext());
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "missing_queue_row_id");
});

// ══════════════════════════════════════════════════════════════════════════
// REQUEST SHAPE — the flag cannot scope a request by itself
// ══════════════════════════════════════════════════════════════════════════

test("scopedCanary=true without campaign or rows is not a scoped request at all", async () => {
  assert.equal(parseScopedCanaryRequest({ scopedCanary: true }).scoped, false);
  assert.equal(parseScopedCanaryRequest({ scoped_canary: true }).scoped, false);
  assert.equal(
    parseScopedCanaryRequest({ scopedCanary: true, campaign_id: CAMPAIGN }).scoped,
    false,
    "a campaign without an explicit row allowlist is not scoped",
  );
  assert.equal(
    parseScopedCanaryRequest({ scopedCanary: true, queue_row_ids: [ROW_ID] }).scoped,
    false,
    "rows without a campaign are not scoped",
  );
});

test("validation requires campaign AND an explicit bounded allowlist", () => {
  assert.ok(validateScopedCanaryRequest({ queue_row_ids: [ROW_ID] }).errors?.includes("campaign_id_required")
    || !validateScopedCanaryRequest({ queue_row_ids: [ROW_ID] }).ok);
  assert.ok(validateScopedCanaryRequest({ campaign_id: CAMPAIGN }).errors?.includes("queue_row_ids_required")
    || !validateScopedCanaryRequest({ campaign_id: CAMPAIGN }).ok);

  // And the allowlist is bounded.
  const oversized = Array.from({ length: SCOPED_CANARY_MAX_ROWS + 1 }, (_, i) => `row-${i}`);
  const verdict = validateScopedCanaryRequest({ campaign_id: CAMPAIGN, queue_row_ids: oversized });
  assert.equal(verdict.ok, false, "an oversized allowlist must not validate");
});

test("a row outside the allowlist is rejected by the allowlist check", () => {
  const verdict = validateScopedCanaryAllowlist(
    [{ id: OTHER_ROW, campaign_id: CAMPAIGN }],
    { campaign_id: CAMPAIGN, queue_row_ids: [ROW_ID], max_rows: 1 },
  );
  assert.notEqual(verdict?.ok, true, "a row the operator never authorized must not pass");
});
