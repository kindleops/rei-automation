/**
 * s14-transport-forensics.test.mjs
 *
 * §11 Slice 4H. Pins the transport boundary that the first live provider canary
 * exposed, and the observability that made it diagnosable only by reading source.
 *
 * WHAT ACTUALLY HAPPENED (2026-09-07 21:42:17Z, production):
 *   The canary never contacted TextGrid. `sendTextgridSMS` refused at its own
 *   emergency-stop brake, BEFORE `fetch`. The refusal was thrown as a bare
 *   TextGridError with no transport evidence, so the classifier could not
 *   recognise it, the model fell through to its fail-closed default, and a
 *   message that provably never left the process was recorded
 *   `may_have_been_sent` + `retry_denied`. The ledger row read
 *   `failure_class=unknown_failure, http_status=null` and nothing else.
 *
 * The first test reproduces that EXACT row from the old error shape. It is the
 * regression witness and must keep passing: it describes the defect, not the fix.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateQueueSendRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import {
  TextGridError,
  evaluateTextgridRuntimeBrakeForSend,
  sendTextgridSMS,
} from "@/lib/providers/textgrid.js";
import { resetTextgridConfigCache } from "@/lib/config/textgrid-config.js";
import { classifyTextGridProviderError } from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";
import { mapTransportOutcome } from "@/lib/domain/communications/transport-outcome-mapping.js";
import {
  evaluateLogicalTransition,
  LOGICAL_STATES,
  DELIVERY_POSSIBILITY,
  RETRY_AUTHORITY,
  ATTEMPT_STATES,
  TRANSITION_CAUSES,
  AUTOMATIC_RETRY_STATES,
  canAllocateAttempt,
} from "@/lib/domain/communications/communication-transition-authority.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = path.resolve(__dirname, "../../src/lib/providers/textgrid.js");

/** Exact production system_control values at the moment of the canary. */
const PROD_CONTROL_AT_CANARY = Object.freeze({
  queue_processor_mode: "off",
  queue_emergency_stop_at: "2026-08-18T03:18:33.928Z",
});

/** The exact seller_communication_attempts row the live canary produced. */
const LIVE_CANARY_ROW = Object.freeze({
  failure_class: "unknown_failure",
  outcome_class: "ambiguous",
  delivery_possibility: "may_have_been_sent",
  retry_authority: "retry_denied",
  http_status: null,
});

function axes(outcome) {
  return {
    failure_class: outcome.reason,
    outcome_class: outcome.attempt_state,
    delivery_possibility: outcome.delivery_possibility,
    retry_authority: outcome.retry_authority,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 1. THE LIVE FAILURE, REPRODUCED FROM THE OLD ERROR SHAPE
// ══════════════════════════════════════════════════════════════════════════

test("live canary: production control values refuse the send at the emergency brake", () => {
  const brake = evaluateQueueSendRuntimeBrakes(PROD_CONTROL_AT_CANARY, {
    action: "sendTextgridSMS",
    failClosed: false,
  });
  assert.equal(brake.ok, false);
  assert.equal(brake.reason, "queue_emergency_stop_active");

  // dispatchSellerQueueRow's sendProvider passes only to/from/body, so there is
  // no manual-inbox context and the emergency-stop bypass does not apply.
  const decision = evaluateTextgridRuntimeBrakeForSend(brake, {});
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "queue_emergency_stop_active");
});

test("live canary: the OLD unstamped refusal reproduces the production row exactly", () => {
  // Verbatim the throw the adapter used to raise: no phase, no transmit flag.
  const legacy_error = new TextGridError(
    "sendTextgridSMS: queue_emergency_stop_active - send blocked by runtime safety brake",
    { to: "+15550000000", from: "+15550000001", body: "redacted" }
  );

  const classified = classifyTextGridProviderError(legacy_error);
  const outcome = mapTransportOutcome(classified);

  assert.deepEqual(
    { ...axes(outcome), http_status: legacy_error.status },
    LIVE_CANARY_ROW,
    "the old shape must still reproduce the exact live row"
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 2. THE FIX: A PRE-WIRE REFUSAL IS PROVEN UNSENT
// ══════════════════════════════════════════════════════════════════════════

test("fix: a stamped local refusal is definitely_not_sent and held, not ambiguous", () => {
  const refusal = new TextGridError(
    "sendTextgridSMS: queue_emergency_stop_active - send blocked by runtime safety brake",
    {
      to: "+15550000000",
      from: "+15550000001",
      body: "redacted",
      local_refusal: true,
      local_refusal_reason: "queue_emergency_stop_active",
      network_phase: "not_attempted",
      may_have_transmitted: false,
    }
  );

  const classified = classifyTextGridProviderError(refusal);
  assert.equal(classified.failure_class, "local_refusal_before_request");
  assert.equal(classified.transport_phase, "not_attempted");
  assert.equal(classified.may_have_transmitted, false);
  assert.equal(classified.retryable, false, "must not spin against the brake");

  const outcome = mapTransportOutcome(classified);
  assert.deepEqual(axes(outcome), {
    failure_class: "local_refusal_before_request",
    outcome_class: ATTEMPT_STATES.FAILED_PROVABLY_UNSENT,
    delivery_possibility: DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT,
    retry_authority: RETRY_AUTHORITY.OPERATOR_HOLD,
  });

  // The whole point: no longer laundered into the ambiguous absorbing state.
  assert.notEqual(outcome.delivery_possibility, DELIVERY_POSSIBILITY.MAY_HAVE_BEEN_SENT);
  assert.ok(!AUTOMATIC_RETRY_STATES.includes(outcome.retry_authority));
});

test("fix: the local-refusal outcome is a LEGAL transition from provider_request_started", () => {
  const classified = classifyTextGridProviderError({
    local_refusal: true,
    local_refusal_reason: "queue_emergency_stop_active",
    message: "blocked",
  });
  const outcome = mapTransportOutcome(classified);

  const transition = evaluateLogicalTransition({
    current: {
      state: LOGICAL_STATES.PROVIDER_REQUEST_STARTED,
      delivery_possibility: DELIVERY_POSSIBILITY.UNKNOWN,
      retry_authority: RETRY_AUTHORITY.RETRY_ALLOWED,
      retry_after_at: null,
    },
    requested: {
      state: outcome.logical_state,
      delivery_possibility: outcome.delivery_possibility,
      retry_authority: outcome.retry_authority,
    },
    cause: outcome.cause,
    now: "2026-09-07T22:00:00.000Z",
  });

  assert.equal(transition.ok, true, `refused: ${transition.reason}`);
  assert.equal(outcome.cause, TRANSITION_CAUSES.LOCAL_REFUSAL_BEFORE_REQUEST);
});

test("fix: the local-refusal cause may NOT be used to claim a message was accepted", () => {
  for (const bad of [
    DELIVERY_POSSIBILITY.PROVIDER_ACCEPTED,
    DELIVERY_POSSIBILITY.DELIVERED,
    DELIVERY_POSSIBILITY.MAY_HAVE_BEEN_SENT,
  ]) {
    const transition = evaluateLogicalTransition({
      current: {
        state: LOGICAL_STATES.PROVIDER_REQUEST_STARTED,
        delivery_possibility: DELIVERY_POSSIBILITY.UNKNOWN,
        retry_authority: RETRY_AUTHORITY.RETRY_ALLOWED,
      },
      requested: {
        state: LOGICAL_STATES.FAILED_RETRY_ALLOWED,
        delivery_possibility: bad,
        retry_authority: RETRY_AUTHORITY.OPERATOR_HOLD,
      },
      cause: TRANSITION_CAUSES.LOCAL_REFUSAL_BEFORE_REQUEST,
      now: "2026-09-07T22:00:00.000Z",
    });
    assert.equal(transition.ok, false, `${bad} must not be evidenced by a local refusal`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3. NO PRE-WIRE GUARD MAY FORGET THE STAMP
// ══════════════════════════════════════════════════════════════════════════

test("structural: every refusal before fetch() goes through localRefusal()", () => {
  const source = fs.readFileSync(ADAPTER_PATH, "utf8");
  const start = source.indexOf("export async function sendTextgridSMS");
  const wire = source.indexOf("const response = await fetch(", start);
  assert.ok(start > 0 && wire > start, "could not locate the send function or its fetch call");

  const pre_wire = source.slice(start, wire);
  const bare = pre_wire.match(/throw new TextGridError\(/g) || [];
  assert.equal(
    bare.length,
    0,
    "a guard before the wire raised a bare TextGridError; it must use localRefusal() " +
      "or its proof of non-delivery is lost and §11 will call it may_have_been_sent"
  );
  assert.ok((pre_wire.match(/throw localRefusal\(/g) || []).length >= 8);
});

// ══════════════════════════════════════════════════════════════════════════
// 4. ADAPTER GUARDS, EXERCISED FOR REAL
// ══════════════════════════════════════════════════════════════════════════

async function refusalFrom(args) {
  try {
    await sendTextgridSMS({ bypass_system_control: true, ...args });
  } catch (error) {
    return error;
  }
  throw new Error("expected the adapter to refuse");
}

test("adapter: content and address guards all prove non-delivery", async () => {
  const cases = [
    [{ to: "nope", from: "+15550000001", body: "Hi Dana, quick question." }, "invalid_to_number"],
    [{ to: "+15550000000", from: "nope", body: "Hi Dana, quick question." }, "invalid_from_number"],
    [{ to: "+15550000000", from: "+15550000001", body: "   " }, "empty_message_body"],
    [{ to: "+15550000000", from: "+15550000001", body: "Hello , are you open to an offer?" }, "blank_seller_greeting"],
    [{ to: "+15550000000", from: "+15550000001", body: "Hi {{first_name}}, offer?" }, "unresolved_placeholder"],
  ];

  for (const [args, expected_reason] of cases) {
    const error = await refusalFrom(args);
    assert.equal(error.local_refusal, true, `${expected_reason}: missing local_refusal stamp`);
    assert.equal(error.local_refusal_reason, expected_reason);
    assert.equal(error.may_have_transmitted, false);
    assert.equal(error.network_phase, "not_attempted");

    const outcome = mapTransportOutcome(classifyTextGridProviderError(error));
    assert.equal(outcome.delivery_possibility, DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT);
    assert.ok(!AUTOMATIC_RETRY_STATES.includes(outcome.retry_authority));
  }
});

test("adapter: missing credentials are a proven non-send, never an ambiguity", async () => {
  const original = { ...process.env };
  delete process.env.TEXTGRID_ACCOUNT_SID;
  delete process.env.TEXTGRID_AUTH_TOKEN;
  delete process.env.TEXTGRID_API_KEY;
  resetTextgridConfigCache();
  try {
    const error = await refusalFrom({
      to: "+15550000000",
      from: "+15550000001",
      body: "Hi Dana, quick question about your property.",
    });
    assert.equal(error.local_refusal, true);
    assert.equal(error.local_refusal_reason, "provider_configuration_missing");
    const outcome = mapTransportOutcome(classifyTextGridProviderError(error));
    assert.equal(outcome.delivery_possibility, DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT);
    assert.equal(outcome.retry_authority, RETRY_AUTHORITY.OPERATOR_HOLD);
  } finally {
    process.env = original;
    resetTextgridConfigCache();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 5. SID EXTRACTION / RESPONSE SHAPE MATRIX
//
// The success shape is not a guess: 9,686 production outbound rows carry a
// TextGrid SID of the form SM + 25 chars, extracted by this adapter from
// `data.sid`, most recently on 2026-08-27. That is the provider contract.
// ══════════════════════════════════════════════════════════════════════════

const REAL_SID = "SM0123456789abcdef012345678";

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

async function sendWithStub(impl, overrides = {}) {
  const restore = stubFetch(impl);
  const original = { ...process.env };
  process.env.TEXTGRID_ACCOUNT_SID = "AC_test_account";
  process.env.TEXTGRID_AUTH_TOKEN = "test_token";
  resetTextgridConfigCache();
  try {
    return {
      result: await sendTextgridSMS({
        to: "+15550000000",
        from: "+15550000001",
        body: "Hi Dana, quick question about your property.",
        bypass_system_control: true,
        ...overrides,
      }),
      error: null,
    };
  } catch (error) {
    return { result: null, error };
  } finally {
    restore();
    process.env = original;
    resetTextgridConfigCache();
  }
}

test("response matrix: 2xx with sid is the ONLY accepted shape", async () => {
  const { result, error } = await sendWithStub(async () =>
    jsonResponse(201, { sid: REAL_SID, status: "queued" })
  );
  assert.equal(error, null);
  assert.equal(result.sid, REAL_SID);
  assert.equal(result.provider_message_id, REAL_SID);

  const outcome = mapTransportOutcome({ ok: true, provider_message_id: result.sid });
  assert.equal(outcome.delivery_possibility, DELIVERY_POSSIBILITY.PROVIDER_ACCEPTED);
  assert.equal(outcome.logical_state, LOGICAL_STATES.PROVIDER_ACCEPTED);
});

test("response matrix: every non-SID answer stays ambiguous and un-retryable", async () => {
  const cases = [
    ["2xx missing sid", async () => jsonResponse(200, { status: "queued" })],
    ["2xx alternate casing only", async () => jsonResponse(200, { MessageSid: REAL_SID })],
    ["2xx nested shape only", async () => jsonResponse(200, { data: { sid: REAL_SID } })],
    ["invalid JSON", async () => jsonResponse(200, "<html>gateway</html>")],
    ["empty body", async () => jsonResponse(200, "")],
    ["500 with JSON error", async () => jsonResponse(500, { message: "server error" })],
    ["503 text error", async () => jsonResponse(503, "unavailable")],
    ["timeout after request written", async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }],
  ];

  for (const [label, impl] of cases) {
    const { result, error } = await sendWithStub(impl);
    assert.equal(result, null, `${label}: must not report success`);
    const outcome = mapTransportOutcome(classifyTextGridProviderError(error));
    assert.equal(
      outcome.delivery_possibility,
      DELIVERY_POSSIBILITY.MAY_HAVE_BEEN_SENT,
      `${label}: acceptance cannot be excluded once the request was written`
    );
    assert.ok(
      !AUTOMATIC_RETRY_STATES.includes(outcome.retry_authority),
      `${label}: an unproven outcome must never regain automatic retry`
    );
    // Diagnostics must NOT have been laundered into a local-refusal claim.
    assert.notEqual(outcome.reason, "local_refusal_before_request", `${label}`);
  }
});

test("response matrix: a refused socket is provably unsent and safely retryable", async () => {
  const { error } = await sendWithStub(async () => {
    const e = new TypeError("fetch failed");
    e.cause = { code: "ECONNREFUSED" };
    throw e;
  });
  const outcome = mapTransportOutcome(classifyTextGridProviderError(error));
  assert.equal(outcome.delivery_possibility, DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT);
  assert.equal(outcome.retry_authority, RETRY_AUTHORITY.RETRY_ALLOWED);
});

test("response matrix: HTTP status survives a body that cannot be parsed", async () => {
  const { error } = await sendWithStub(async () => jsonResponse(502, "<html>bad gateway</html>"));
  assert.equal(error.status, 502, "the status must not be lost because JSON parsing threw");
  assert.equal(error.may_have_transmitted, true);
});

// ══════════════════════════════════════════════════════════════════════════
// 6. MUTATION PROOFS
// ══════════════════════════════════════════════════════════════════════════

test("mutation: dropping the local-refusal stamp re-creates the live canary failure", () => {
  const stamped = classifyTextGridProviderError({
    message: "sendTextgridSMS: queue_emergency_stop_active - send blocked by runtime safety brake",
    local_refusal: true,
    local_refusal_reason: "queue_emergency_stop_active",
    network_phase: "not_attempted",
    may_have_transmitted: false,
  });

  // MUTANT: the guard forgets the stamp, exactly as production did.
  const unstamped = classifyTextGridProviderError({
    message: "sendTextgridSMS: queue_emergency_stop_active - send blocked by runtime safety brake",
  });

  const fixed = mapTransportOutcome(stamped);
  const mutant = mapTransportOutcome(unstamped);

  assert.equal(fixed.delivery_possibility, DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT);
  assert.equal(mutant.delivery_possibility, DELIVERY_POSSIBILITY.MAY_HAVE_BEEN_SENT);
  assert.equal(mutant.reason, "unknown_failure");
  assert.notDeepEqual(axes(fixed), axes(mutant), "the stamp must be load-bearing");
});

test("mutation: a local refusal must not be granted automatic retry", () => {
  const classified = classifyTextGridProviderError({
    local_refusal: true,
    local_refusal_reason: "queue_emergency_stop_active",
  });
  const outcome = mapTransportOutcome(classified);

  // MUTANT: someone "helpfully" upgrades the hold to retry_allowed because the
  // message was provably not sent. The queue would then spin on the brake.
  const transition = evaluateLogicalTransition({
    current: {
      state: LOGICAL_STATES.FAILED_RETRY_ALLOWED,
      delivery_possibility: DELIVERY_POSSIBILITY.DEFINITELY_NOT_SENT,
      retry_authority: RETRY_AUTHORITY.OPERATOR_HOLD,
    },
    requested: { retry_authority: RETRY_AUTHORITY.RETRY_ALLOWED },
    cause: TRANSITION_CAUSES.LOCAL_REFUSAL_BEFORE_REQUEST,
    now: "2026-09-07T22:00:00.000Z",
  });
  assert.equal(transition.ok, false, "releasing an operator hold needs a remediation cause");
  assert.equal(transition.reason, "operator_hold_release_requires_remediation_cause");
  assert.equal(outcome.retry_authority, RETRY_AUTHORITY.OPERATOR_HOLD);
});

test("mutation: expecting the wrong SID key turns a real acceptance into an ambiguity", () => {
  const real = mapTransportOutcome({ ok: true, provider_message_id: REAL_SID });
  // MUTANT: parser reads data.messageSid, which TextGrid does not send.
  const mutant = mapTransportOutcome({ ok: true, provider_message_id: "" });

  assert.equal(real.delivery_possibility, DELIVERY_POSSIBILITY.PROVIDER_ACCEPTED);
  assert.equal(mutant.delivery_possibility, DELIVERY_POSSIBILITY.MAY_HAVE_BEEN_SENT);
});

// ══════════════════════════════════════════════════════════════════════════
// 7. DIAGNOSTICS MAY NOT MOVE THE SAFETY VERDICT
// ══════════════════════════════════════════════════════════════════════════

test("observability: richer diagnostics never grant retry authority", () => {
  const ambiguous_shapes = [
    { status: 500, message: "server error" },
    { status: 200, message: "Missing SID (NOT SENT): {}" },
    { name: "TimeoutError", message: "aborted due to timeout" },
    { message: "socket hang up" },
  ];
  for (const shape of ambiguous_shapes) {
    const outcome = mapTransportOutcome(classifyTextGridProviderError(shape));
    assert.ok(
      !AUTOMATIC_RETRY_STATES.includes(outcome.retry_authority),
      `${JSON.stringify(shape)} must not hold automatic retry authority`
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 8. THE QUEUE RUNNER MUST NOT RE-DERIVE A VERDICT THE SEAM ALREADY REACHED
// ══════════════════════════════════════════════════════════════════════════

/** Mirrors the two errors process-send-queue raises when no SID came back. */
function queueErrorFor(dispatch_reason) {
  const local_refusal = dispatch_reason === "local_refusal_before_request";
  const error = new Error(local_refusal ? "SEND REFUSED BEFORE REQUEST" : "SEND FAILED - NO SID");
  error.no_sid_ambiguous_send = !local_refusal;
  error.local_refusal = local_refusal;
  error.local_refusal_reason = local_refusal ? dispatch_reason : null;
  error.retryable = false;
  return error;
}

test("queue runner: a local refusal is no longer filed as a provider no-SID accept", () => {
  const refusal = classifyTextGridProviderError(queueErrorFor("local_refusal_before_request"));
  assert.equal(refusal.failure_class, "local_refusal_before_request");
  assert.equal(refusal.failure_bucket, "local_refusal");
  assert.notEqual(
    refusal.failure_bucket,
    "provider_no_sid",
    "the provider was never contacted; calling it a provider accept is the Slice 4H defect"
  );

  // A genuine sid-less provider answer must STILL be provider_no_sid.
  const genuine = classifyTextGridProviderError(queueErrorFor("provider_ambiguous_accept"));
  assert.equal(genuine.failure_bucket, "provider_no_sid");
  assert.equal(genuine.retryable, false);
});

test("queue runner: neither no-SID path ever regains automatic retry", () => {
  for (const reason of ["local_refusal_before_request", "provider_ambiguous_accept"]) {
    const classified = classifyTextGridProviderError(queueErrorFor(reason));
    assert.equal(classified.retryable, false, reason);
    const outcome = mapTransportOutcome(classified);
    assert.ok(!AUTOMATIC_RETRY_STATES.includes(outcome.retry_authority), reason);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 9. THE HELD OUTCOME MUST NOT BECOME A RETRY LOOP
//
// This is the property the whole fix rests on. `failed_retry_allowed` IS in
// STATES_ALLOWING_ATTEMPT, so moving local refusals out of the absorbing
// `ambiguous` state could have handed them straight back to the allocator and
// spun an attempt per cycle against a brake that never yields. It does not,
// because allocation gates on retry authority too -- pinned here so that
// second gate can never be quietly relaxed.
// ══════════════════════════════════════════════════════════════════════════

test("safety: a local refusal is held by the allocator, not re-attempted", () => {
  const outcome = mapTransportOutcome(
    classifyTextGridProviderError({ local_refusal: true, local_refusal_reason: "queue_emergency_stop_active" })
  );

  const verdict = canAllocateAttempt({
    state: outcome.logical_state,
    delivery_possibility: outcome.delivery_possibility,
    retry_authority: outcome.retry_authority,
  });

  assert.equal(verdict.ok, false, "a held refusal must not be re-attempted automatically");
  assert.equal(verdict.reason, "retry_authority_denies");

  // And the state alone is NOT what stops it: prove the second gate is the one
  // doing the work, so nobody deletes it believing the state check suffices.
  const state_only = canAllocateAttempt({
    state: outcome.logical_state,
    delivery_possibility: outcome.delivery_possibility,
    retry_authority: RETRY_AUTHORITY.RETRY_ALLOWED,
  });
  assert.equal(state_only.ok, true, "the state check alone would have allowed the attempt");
});

test("safety: the old ambiguous outcome also remains unallocatable", () => {
  const verdict = canAllocateAttempt({
    state: LOGICAL_STATES.AMBIGUOUS,
    delivery_possibility: DELIVERY_POSSIBILITY.MAY_HAVE_BEEN_SENT,
    retry_authority: RETRY_AUTHORITY.RETRY_DENIED,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "ambiguous_outcome_absorbing");
});
