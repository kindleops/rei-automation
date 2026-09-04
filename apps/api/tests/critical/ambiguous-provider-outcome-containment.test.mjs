/**
 * ambiguous-provider-outcome-containment.test.mjs
 *
 * THE DEFECT THIS CLOSES.
 *
 * A 15-second timeout on a message TextGrid had ALREADY ACCEPTED caused a
 * second, differently worded SMS to reach the seller:
 *
 *   1. textgrid.js sends with AbortSignal.timeout(15_000); a timeout yields no sid
 *   2. the classifier had no timeout/abort/network handling at all, so it fell to
 *      `retryable = normalized.retry_allowed !== false && error?.retryable !== false`
 *      -- `undefined !== false` on both sides, i.e. RETRYABLE BY DEFAULT
 *   3. sms-engine treated `classified.retryable === true` as rotation-eligible
 *   4. the rotation patch NULLed provider_message_id, textgrid_message_id and
 *      metadata.provider_message_sid so the SID short-circuit could not stop it
 *   5. it rotated to a different template body
 *   6. the surviving duplicate guard is body-exact, so a rotated body defeats it
 *
 * INVARIANT: an outcome whose provider result cannot be proven must never
 * produce another automatic provider attempt, by ANY route -- rotation, retry
 * budget, next_retry_at, lease reclaim or campaign re-enqueue.
 *
 * Absence of a sid means the provider identity is UNKNOWN. It never means the
 * provider declined.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  TextGridError,
  classifyNetworkFailurePhase,
} from "@/lib/providers/textgrid.js";
import { classifyTextGridProviderError } from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";

// ── transport phase: which side of the wire did it fail on? ─────────────────

test("connection-level failures are PROVABLY unsent", () => {
  const cases = [
    ["ECONNREFUSED", { name: "TypeError", message: "fetch failed", cause: { code: "ECONNREFUSED" } }],
    ["ENOTFOUND (DNS)", { name: "TypeError", message: "fetch failed", cause: { code: "ENOTFOUND" } }],
    ["EAI_AGAIN (DNS)", { name: "TypeError", message: "fetch failed", cause: { code: "EAI_AGAIN" } }],
    ["EHOSTUNREACH", { name: "TypeError", message: "fetch failed", cause: { code: "EHOSTUNREACH" } }],
    ["TLS failure", { name: "TypeError", message: "fetch failed", cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }],
    ["connect timeout", { name: "TypeError", message: "fetch failed", cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }],
  ];
  for (const [label, err] of cases) {
    const phase = classifyNetworkFailurePhase(err);
    assert.equal(phase.phase, "connect", label);
    assert.equal(phase.may_have_transmitted, false, `${label} must be provably unsent`);
  }
});

test("in-flight failures MAY have been transmitted", () => {
  const cases = [
    ["AbortSignal timeout", { name: "TimeoutError", message: "The operation was aborted due to timeout" }],
    ["AbortError", { name: "AbortError", message: "This operation was aborted" }],
    ["ECONNRESET", { name: "TypeError", message: "fetch failed", cause: { code: "ECONNRESET" } }],
    ["socket hang up", { name: "Error", message: "socket hang up" }],
    ["headers timeout", { name: "TypeError", message: "fetch failed", cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }],
    ["body timeout", { name: "TypeError", message: "fetch failed", cause: { code: "UND_ERR_BODY_TIMEOUT" } }],
  ];
  for (const [label, err] of cases) {
    const phase = classifyNetworkFailurePhase(err);
    assert.equal(phase.phase, "inflight", label);
    assert.equal(phase.may_have_transmitted, true, `${label} must be treated as possibly sent`);
  }
});

test("an UNRECOGNISED transport failure fails closed", () => {
  for (const err of [{}, { name: "WeirdError" }, { message: "" }, { cause: { code: "NOPE_UNKNOWN" } }]) {
    const phase = classifyNetworkFailurePhase(err);
    assert.equal(phase.may_have_transmitted, true, "unknown transport must be assumed transmitted");
  }
});

// ── classifier: retry authority ────────────────────────────────────────────

const ambiguous = () =>
  new TextGridError("The operation was aborted due to timeout", {
    endpoint: "https://api.textgrid.com/x",
    to: "+13125550100",
    from: "+18885551212",
    cause_name: "TimeoutError",
    network_phase: "inflight",
    may_have_transmitted: true,
  });

const provablyUnsent = () =>
  new TextGridError("fetch failed", {
    endpoint: "https://api.textgrid.com/x",
    cause_code: "ECONNREFUSED",
    network_phase: "connect",
    may_have_transmitted: false,
  });

test("a TIMEOUT is ambiguous and closes every automatic re-entry", () => {
  const c = classifyTextGridProviderError(ambiguous());
  assert.equal(c.failure_class, "provider_ambiguous_transport");
  assert.equal(c.retryable, false, "must not be retryable");
  assert.equal(c.is_terminal, true);
  assert.equal(c.no_sender_rotation, true, "rotation must be closed");
  assert.equal(c.no_alternate_number_retry, true, "alternate-number retry must be closed");
  assert.equal(c.no_campaign_reenqueue, true, "campaign re-enqueue must be closed");
  assert.notEqual(c.queue_disposition, "queued", "must not return to the dispatchable set");
  assert.equal(c.may_have_transmitted, true);
});

test("a REFUSED connection is provably unsent and stays retry-safe", () => {
  const c = classifyTextGridProviderError(provablyUnsent());
  assert.equal(c.failure_class, "provider_unreachable_before_request");
  assert.equal(c.retryable, true, "no request left the process, so a retry is safe");
  assert.equal(c.is_terminal, false);
  assert.equal(c.no_sender_rotation, false);
  assert.equal(c.queue_disposition, "queued");
  assert.equal(c.may_have_transmitted, false);
});

test("an UNKNOWN provider error no longer defaults to retryable", () => {
  // This is the exact regression: `x !== false` on an absent value was true.
  const c = classifyTextGridProviderError(new TextGridError("something we have never seen", {}));
  assert.equal(c.retryable, false, "unclassified failures must fail closed");
  assert.equal(c.no_sender_rotation, true);
  assert.equal(c.no_alternate_number_retry, true);
  assert.notEqual(c.queue_disposition, "queued");
});

test("the sid-less ambiguous accept remains terminal and non-rotating", () => {
  const c = classifyTextGridProviderError({ no_sid_ambiguous_send: true, message: "send failed - no sid" });
  assert.equal(c.retryable, false);
  assert.equal(c.no_sender_rotation, true);
  assert.equal(c.no_campaign_reenqueue, true);
});

test("content_filter_blocked stays retry/rotation eligible: the seller never saw it", () => {
  // TextGrid accepted, returned a sid, then filtered. Provider evidence proves
  // no seller-visible delivery, so an alternate body is safe. This is the ONE
  // outcome that may still rotate.
  const c = classifyTextGridProviderError({
    message: "blocked by textgrid content filter",
    data: { code: "30007", message: "content_filter_blocked" },
    status: 400,
  });
  assert.equal(c.failure_class, "content_filter_blocked");
  assert.notEqual(c.failure_class, "provider_ambiguous_transport");
  // NOTE: content_filter_blocked DOES set no_sender_rotation:true -- that flag
  // gates rotating the FROM NUMBER, not the template. Template rotation is
  // gated purely on the failure class, which is why this outcome still rotates.
});

// ── the ambiguous class must never be confused with a rejection ─────────────

test("ambiguous is DISTINGUISHABLE from a terminal provider rejection", () => {
  const amb = classifyTextGridProviderError(ambiguous());
  const rejected = classifyTextGridProviderError({
    message: "invalid number",
    data: { code: "21211" },
    status: 400,
  });
  assert.notEqual(amb.failure_class, rejected.failure_class);
  assert.equal(amb.normalized_reason, "provider_outcome_unknown_after_request");
  assert.match(amb.operator_reason, /may have been delivered/i,
    "the operator must be told the message may already have gone out");
});

test("no ambiguous outcome anywhere claims the message was sent OR provably not sent", () => {
  const c = classifyTextGridProviderError(ambiguous());
  assert.notEqual(c.queue_disposition, "sent");
  assert.notEqual(c.failure_class, "provider_unreachable_before_request");
  assert.equal(c.may_have_transmitted, true, "evidence of possible transmission is preserved");
});

// ── an ambiguous attempt must count as CONTACT, not as a clean failure ──────

import {
  isAmbiguousSendRow,
  findAmbiguousPriorSend,
} from "@/lib/domain/messaging/ambiguous-send-evidence.js";

const rowWith = (provider_error) => ({ id: "q-1", queue_status: "failed", metadata: { provider_error } });

test("an ambiguous attempt is recognised from its durable evidence", () => {
  assert.equal(isAmbiguousSendRow(rowWith({ failure_class: "provider_ambiguous_transport" })), true);
  assert.equal(isAmbiguousSendRow(rowWith({ failure_class: "provider_ambiguous_accept" })), true);
  assert.equal(isAmbiguousSendRow(rowWith({ normalized_reason: "provider_outcome_unknown_after_request" })), true);
});

test("an ordinary provably-unsent failure is NOT ambiguous", () => {
  // Otherwise every failure would block legitimate future sends.
  assert.equal(isAmbiguousSendRow(rowWith({ failure_class: "invalid_to_number" })), false);
  assert.equal(isAmbiguousSendRow(rowWith({ failure_class: "provider_unreachable_before_request" })), false);
  assert.equal(isAmbiguousSendRow(rowWith({ failure_class: "content_filter_blocked" })), false);
  assert.equal(isAmbiguousSendRow({}), false);
  assert.equal(isAmbiguousSendRow(null), false);
});

function fakeSupabase(rows, { error = null } = {}) {
  const chain = {
    select: () => chain, eq: () => chain, in: () => chain,
    contains: () => chain, gte: () => chain, limit: () => chain,
    then: (resolve) => resolve({ data: rows, error }),
  };
  return { from: () => chain };
}

test("a prior AMBIGUOUS attempt to the same recipient is found", async () => {
  const r = await findAmbiguousPriorSend({
    supabase: fakeSupabase([rowWith({ failure_class: "provider_ambiguous_transport" })]),
    to_phone_number: "+13125550100",
  });
  assert.equal(r.found, true);
  assert.equal(r.degraded, false);
  assert.equal(r.failure_class, "provider_ambiguous_transport");
});

test("ordinary failures to the same recipient do NOT block a new send", async () => {
  const r = await findAmbiguousPriorSend({
    supabase: fakeSupabase([rowWith({ failure_class: "invalid_to_number" })]),
    to_phone_number: "+13125550100",
  });
  assert.equal(r.found, false);
  assert.equal(r.degraded, false);
});

test("an unreadable dedupe lookup DEGRADES CLOSED rather than permitting a send", async () => {
  const onError = await findAmbiguousPriorSend({
    supabase: fakeSupabase(null, { error: { message: "boom" } }),
    to_phone_number: "+13125550100",
  });
  assert.equal(onError.degraded, true, "a failed lookup must not authorise a duplicate");

  const noClient = await findAmbiguousPriorSend({ to_phone_number: "+13125550100" });
  assert.equal(noClient.degraded, true);

  const thrown = await findAmbiguousPriorSend({
    supabase: { from: () => { throw new Error("nope"); } },
    to_phone_number: "+13125550100",
  });
  assert.equal(thrown.degraded, true);
});
