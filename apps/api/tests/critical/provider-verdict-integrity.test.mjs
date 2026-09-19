/**
 * A MISSING SID IS NOT ONE FACT (§1-§4).
 *
 * Four different things produce a send with no message SID, and they are not
 * interchangeable:
 *
 *   the request never left the process        -> definitely not sent
 *   the provider answered and REJECTED it     -> definitely not sent
 *   the provider answered unparseably         -> may have been sent
 *   the request started, nothing came back    -> may have been sent
 *
 * Collapsing all four into "ambiguous" is not caution, it is a false record:
 * the ambiguity verdict permanently bars the recipient, so filing a provider
 * REJECTION as possibly-delivered blocks a human the provider explicitly
 * refused to message.
 *
 * Both shapes here are real production incidents on +16128072000, eleven days
 * apart, that presented identically as "SEND FAILED - NO SID".
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { classifyTextGridProviderError } from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";
import { isAmbiguousSendRow } from "@/lib/domain/messaging/ambiguous-send-evidence.js";

/** Build the error the queue runner throws for a no-SID dispatch. */
const noSidError = ({ message, ambiguous, possibility, http_status = null, local_refusal = false }) => {
  const error = new Error(message);
  error.no_sid_ambiguous_send = ambiguous;
  error.seam_delivery_possibility = possibility;
  error.provider_http_status = http_status;
  error.local_refusal = local_refusal;
  return error;
};

// ── 2026-09-07: the runtime brake fired before any request existed

test("SEPT 7 SHAPE: a pre-transport refusal is NOT ambiguous", () => {
  const classified = classifyTextGridProviderError(
    noSidError({
      message: "SEND REFUSED BEFORE REQUEST",
      ambiguous: false,
      possibility: "definitely_not_sent",
      local_refusal: true,
    }),
    {}
  );
  assert.notEqual(classified.failure_class, "provider_ambiguous_accept");
  assert.notEqual(classified.normalized_reason, "provider_response_missing_sid");
});

// ── 2026-09-17: the provider answered 400 and refused

test("SEPT 17 SHAPE: an HTTP 400 rejection is TERMINAL, not ambiguous", () => {
  const classified = classifyTextGridProviderError(
    noSidError({
      message: "SEND REJECTED BY PROVIDER - NO SID",
      ambiguous: false,
      possibility: "definitely_not_sent",
      http_status: 400,
    }),
    {}
  );
  assert.equal(classified.failure_class, "provider_rejected_terminal");
  assert.equal(classified.normalized_reason, "provider_rejected_no_sid");
  assert.equal(classified.is_terminal, true);
  assert.equal(classified.http_status, 400);
  // It must state plainly that nothing was delivered.
  assert.match(classified.operator_reason, /NOT delivered/);
});

test("SEPT 17 SHAPE: the resulting row does not read as ambiguous", () => {
  const classified = classifyTextGridProviderError(
    noSidError({ message: "x", ambiguous: false, possibility: "definitely_not_sent", http_status: 400 }),
    {}
  );
  assert.equal(
    isAmbiguousSendRow({ metadata: { provider_error: classified } }),
    false,
    "a provider rejection must not bar the recipient as possibly-delivered"
  );
});

// ── the genuinely unknowable case must STILL fail closed

test("A TRULY UNKNOWN TRANSPORT OUTCOME REMAINS AMBIGUOUS", () => {
  // The request started and nothing came back. We cannot prove the human did
  // not receive it, so the pessimistic reading is the correct one and must
  // survive this change.
  const classified = classifyTextGridProviderError(
    noSidError({ message: "SEND FAILED - NO SID", ambiguous: true, possibility: "may_have_been_sent" }),
    {}
  );
  assert.equal(classified.failure_class, "provider_ambiguous_accept");
  assert.equal(isAmbiguousSendRow({ metadata: { provider_error: classified } }), true);
});

test("an unknown possibility with no structured verdict still fails closed", () => {
  const legacy = new Error("SEND FAILED - NO SID");
  const classified = classifyTextGridProviderError(legacy, {});
  assert.equal(classified.failure_class, "provider_ambiguous_accept");
});

// ── the string must never outrank the structured verdict

test("THE MESSAGE STRING IS NOT AN AUTHORITY", () => {
  // Same damning text, but the seam established the message never went out.
  // The wording of a synthetic error must not decide whether a human can ever
  // be contacted again.
  const classified = classifyTextGridProviderError(
    noSidError({
      message: "SEND FAILED - NO SID",
      ambiguous: false,
      possibility: "definitely_not_sent",
      http_status: 400,
    }),
    {}
  );
  assert.notEqual(classified.failure_class, "provider_ambiguous_accept");
  assert.equal(classified.failure_class, "provider_rejected_terminal");
});

test("a structured AMBIGUOUS verdict is honoured even with reassuring text", () => {
  const classified = classifyTextGridProviderError(
    noSidError({ message: "all good", ambiguous: true, possibility: "may_have_been_sent" }),
    {}
  );
  assert.equal(classified.failure_class, "provider_ambiguous_accept");
});

// ── the runner must carry the seam's verdict, not re-derive one

test("THE QUEUE RUNNER DERIVES AMBIGUITY FROM THE SEAM, NOT FROM THE SID", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");

  // The flag must be computed from delivery_possibility, not set to a constant.
  assert.match(source, /seam_delivery_possibility/);
  assert.match(source, /no_sid_ambiguous_send\s*=\s*\n?\s*!local_refusal/);
  // ...and the structured evidence must be carried onto the error.
  assert.match(source, /provider_http_status/);
  assert.match(source, /transport_phase/);
});

test("the dispatch seam RETURNS its diagnostics, not only emits them", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/communications/canonical-communication-dispatch.js", import.meta.url), "utf8");
  // They existed only in telemetry and the ledger; the runner could not see them.
  assert.match(source, /http_status:\s*diagnostics\.http_status/);
  assert.match(source, /transport_phase:\s*diagnostics\.transport_phase/);
});
