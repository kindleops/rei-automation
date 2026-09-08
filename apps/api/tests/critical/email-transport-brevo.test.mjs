/**
 * email-transport-brevo.test.mjs
 *
 * The email transport boundary, and the classification that decides whether a
 * failed send may ever be repeated.
 *
 * The property that matters more than any other: an outcome we cannot prove is
 * "the seller received nothing" must NEVER be classified as safe to retry. Every
 * ambiguous case below is a duplicate email to a real person if it regresses.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { createBrevoEmailTransport } from "@/lib/domain/email/transport/brevo-email-transport.js";
import { classifyBrevoProviderError } from "@/lib/domain/email/transport/brevo-error-classifier.js";
import {
  assertEmailTransportShape,
  isKnownEmailFailureClass,
  EMAIL_FAILURE_CLASSES,
  toEmailSendFailure,
} from "@/lib/domain/email/transport/email-transport-contract.js";
import { mapTransportOutcome } from "@/lib/domain/communications/transport-outcome-mapping.js";

const OK_KEY = () => "test-api-key";

function transportWith(fetch_impl, over = {}) {
  return createBrevoEmailTransport({ fetch_impl, resolve_api_key: OK_KEY, ...over });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const REQUEST = {
  to: "seller@example.com",
  from: { email: "acq@reivesti.com", name: "Acquisitions" },
  subject: "About your property",
  html: "<p>Hello</p>",
  text: "Hello",
};

// ── the adapter satisfies its own contract ──────────────────────────────────

test("the Brevo adapter matches the transport contract", () => {
  const result = assertEmailTransportShape(transportWith(async () => jsonResponse(201, {})));
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("a transport missing send() is rejected by the contract check", () => {
  assert.equal(assertEmailTransportShape({ provider: "x" }).ok, false);
  assert.equal(assertEmailTransportShape(null).ok, false);
});

// ── success requires a provider message id, and nothing less ────────────────

test("a 201 with a messageId is a send", async () => {
  const transport = transportWith(async () => jsonResponse(201, { messageId: "<abc@brevo>" }));
  const result = await transport.send(REQUEST);
  assert.equal(result.ok, true);
  assert.equal(result.provider_message_id, "<abc@brevo>");
});

test("a 2xx WITHOUT a messageId is ambiguous, not a success", async () => {
  // Reporting this as sent would write a ledger row that can never be matched to
  // a webhook, and tell an operator an email went out that we cannot trace.
  const transport = transportWith(async () => jsonResponse(201, {}));
  const result = await transport.send(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.failure_class, "provider_ambiguous_accept");
  assert.equal(result.may_have_transmitted, true);
});

test("an unreadable success body is still ambiguous, never a send", async () => {
  const transport = transportWith(async () => ({
    ok: true, status: 202, json: async () => { throw new Error("not json"); },
  }));
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "provider_ambiguous_accept");
});

// ── the network phase decides retry safety ──────────────────────────────────

test("a refused connection is provably unsent and safe to repeat", async () => {
  const transport = transportWith(async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  });
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "provider_unreachable_before_request");
  assert.equal(result.may_have_transmitted, false);

  const outcome = mapTransportOutcome(result);
  assert.equal(outcome.delivery_possibility, "definitely_not_sent");
  assert.equal(outcome.retry_authority, "retry_allowed");
});

test("a reset mid-request is AMBIGUOUS and must not be retried", async () => {
  const transport = transportWith(async () => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  });
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "provider_ambiguous_transport");
  assert.equal(result.may_have_transmitted, true);

  const outcome = mapTransportOutcome(result);
  assert.equal(outcome.delivery_possibility, "may_have_been_sent");
  assert.equal(outcome.retry_authority, "retry_denied");
});

test("a timeout is ambiguous, not a clean failure", async () => {
  const transport = transportWith(async () => {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  });
  const result = await transport.send(REQUEST);
  assert.equal(result.may_have_transmitted, true);
  assert.equal(mapTransportOutcome(result).retry_authority, "retry_denied");
});

// ── provider verdicts ───────────────────────────────────────────────────────

test("401 is an auth failure that holds for an operator", async () => {
  const transport = transportWith(async () => jsonResponse(401, { code: "unauthorized", message: "Key not found" }));
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "provider_auth_failed");
  assert.equal(result.may_have_transmitted, false);

  const outcome = mapTransportOutcome(result);
  assert.equal(outcome.delivery_possibility, "definitely_not_sent");
  assert.equal(outcome.retry_authority, "operator_hold");
});

test("a 5xx is ambiguous: acceptance cannot be excluded", async () => {
  const transport = transportWith(async () => jsonResponse(503, { message: "unavailable" }));
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "provider_ambiguous_transport");
  assert.equal(mapTransportOutcome(result).retry_authority, "retry_denied");
});

test("an invalid recipient is terminal and maps to the email-side class", async () => {
  const transport = transportWith(async () => jsonResponse(400, {
    code: "invalid_parameter", message: "to[0].email: invalid email address",
  }));
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "invalid_to_address");
  assert.equal(result.suppression_action, "invalid_address");

  const outcome = mapTransportOutcome(result);
  assert.equal(outcome.delivery_possibility, "definitely_not_sent");
  assert.equal(outcome.retry_authority, "terminal");
});

test("a blocklisted contact is a terminal opt-out, never a config error", async () => {
  const transport = transportWith(async () => jsonResponse(400, {
    code: "invalid_parameter", message: "Contact is blacklisted",
  }));
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "recipient_opted_out");
  assert.equal(result.suppression_action, "unsubscribed");
  assert.equal(mapTransportOutcome(result).retry_authority, "terminal");
});

test("an unverified sender holds for an operator rather than retrying", async () => {
  const transport = transportWith(async () => jsonResponse(400, {
    code: "invalid_parameter", message: "sender is not a valid sender",
  }));
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "sender_not_provisioned");
  assert.equal(mapTransportOutcome(result).retry_authority, "operator_hold");
});

test("rejected content is terminal: the template needs changing, not repeating", async () => {
  const transport = transportWith(async () => jsonResponse(400, {
    code: "invalid_parameter", message: "message content rejected as spam",
  }));
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "content_filter_blocked");
  assert.equal(mapTransportOutcome(result).retry_authority, "terminal");
});

test("429 is held, not retried, because the semantics are unproven", async () => {
  // Documented as a rejection, unverified against the live API. Until it is
  // proven, guessing "safe to repeat" is exactly the assumption that sends a
  // duplicate. The class is named so the hold is greppable.
  const transport = transportWith(async () => jsonResponse(429, { message: "Too many requests" }));
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "provider_rate_limited");
  assert.equal(mapTransportOutcome(result).retry_authority, "retry_denied");
});

test("an unrecognised 4xx holds for a human rather than looping", async () => {
  const transport = transportWith(async () => jsonResponse(418, { message: "no idea" }));
  const result = await transport.send(REQUEST);
  assert.equal(result.failure_class, "provider_configuration_error");
  assert.equal(result.may_have_transmitted, false);
  assert.equal(mapTransportOutcome(result).retry_authority, "operator_hold");
});

// ── the adapter never reaches the wire when it should not ───────────────────

test("a missing credential never opens a socket", async () => {
  let called = false;
  const transport = createBrevoEmailTransport({
    fetch_impl: async () => { called = true; return jsonResponse(201, { messageId: "x" }); },
    resolve_api_key: () => null,
  });
  const result = await transport.send(REQUEST);
  assert.equal(called, false, "no credential means no request");
  assert.equal(result.failure_class, "provider_auth_failed");
  assert.equal(result.transport_phase, "pre_request");
});

test("an incomplete payload never opens a socket", async () => {
  let called = false;
  const transport = transportWith(async () => { called = true; return jsonResponse(201, {}); });
  for (const bad of [
    { ...REQUEST, to: "" },
    { ...REQUEST, subject: "" },
    { ...REQUEST, from: {} },
    { ...REQUEST, html: "", text: "" },
  ]) {
    const result = await transport.send(bad);
    assert.equal(result.ok, false);
    assert.equal(result.transport_phase, "pre_request");
  }
  assert.equal(called, false);
});

test("a brand-scoped send never falls back to a shared credential", async () => {
  const seen = [];
  const transport = createBrevoEmailTransport({
    fetch_impl: async () => jsonResponse(201, { messageId: "x" }),
    resolve_api_key: (brand, opts) => { seen.push({ brand, opts }); return "k"; },
  });
  await transport.send({ ...REQUEST, brand_key: "reivesti" });
  assert.equal(seen[0].brand, "reivesti");
  assert.equal(seen[0].opts.allow_legacy_fallback, false,
    "naming a brand must not permit the legacy shared key");
});

// ── nothing leaks, and headers cannot be injected ───────────────────────────

test("the API key never appears in a result or a failure", async () => {
  const SECRET = "xkeysib-super-secret";
  const transport = createBrevoEmailTransport({
    fetch_impl: async () => jsonResponse(401, { code: "unauthorized", message: `bad key ${SECRET}` }),
    resolve_api_key: () => SECRET,
  });
  const result = await transport.send(REQUEST);
  assert.ok(!JSON.stringify(result).includes(SECRET), "provider text must be sanitized, not echoed");
});

test("newlines in a subject cannot inject a header", async () => {
  let payload = null;
  const transport = transportWith(async (_url, init) => {
    payload = JSON.parse(init.body);
    return jsonResponse(201, { messageId: "x" });
  });
  await transport.send({ ...REQUEST, subject: "Hi\r\nBcc: attacker@evil.com" });
  assert.ok(!/[\r\n]/.test(payload.subject));
});

test("the credential travels only as a header, never in the body", async () => {
  let init = null;
  const transport = transportWith(async (_url, options) => {
    init = options;
    return jsonResponse(201, { messageId: "x" });
  });
  await transport.send(REQUEST);
  assert.equal(init.headers["api-key"], "test-api-key");
  assert.ok(!init.body.includes("test-api-key"));
});

// ── the vocabulary is closed ────────────────────────────────────────────────

test("every class the classifier emits is a declared email failure class", () => {
  const errors = [
    { status: 401 }, { status: 402 }, { status: 403 }, { status: 429 },
    { status: 400, data: { code: "invalid_parameter", message: "invalid email address" } },
    { status: 400, data: { code: "invalid_parameter", message: "sender not valid" } },
    { status: 400, data: { code: "invalid_parameter", message: "blacklisted" } },
    { status: 400, data: { code: "invalid_parameter", message: "spam" } },
    { status: 400, data: { code: "missing_parameter" } },
    { status: 418 }, { status: 500 }, { status: 503 },
    { code: "ECONNREFUSED" }, { code: "ECONNRESET" }, { name: "AbortError" }, {},
  ];
  for (const error of errors) {
    const result = classifyBrevoProviderError(error);
    if (result.ok) continue;
    assert.ok(isKnownEmailFailureClass(result.failure_class),
      `undeclared failure class: ${result.failure_class}`);
  }
});

test("every declared class except the deliberately-unmapped one is understood by the canonical mapping", () => {
  for (const failure_class of EMAIL_FAILURE_CLASSES) {
    const outcome = mapTransportOutcome({ failure_class });
    assert.ok(outcome.logical_state, `no outcome for ${failure_class}`);
    if (failure_class === "provider_rate_limited") {
      // Deliberately unmapped: it must land in the fail-closed branch.
      assert.equal(outcome.delivery_possibility, "may_have_been_sent");
      assert.equal(outcome.retry_authority, "retry_denied");
    }
  }
});

test("an unknown thrown error is treated as ambiguous, never as safe", () => {
  const failure = toEmailSendFailure("brevo", { failure_class: "something_new" });
  assert.equal(failure.failure_class, "provider_ambiguous_transport");
  assert.equal(failure.may_have_transmitted, true);
});

test("a classified success passes straight through", () => {
  const result = classifyBrevoProviderError({ ok: true, provider_message_id: "<m@brevo>" });
  assert.deepEqual(result, { ok: true, provider_message_id: "<m@brevo>" });
});
