/**
 * email-provider-event-reconcile.test.mjs
 *
 * The one place a Brevo webhook may change what we believe about an email.
 *
 * The properties that matter, each a real incident if broken:
 *   - a duplicate redelivery changes nothing the first one did not
 *   - a LATE, WEAKER event cannot downgrade a delivered message
 *   - an open NEVER moves delivery state, because an open is a resource fetch
 *   - an unauthenticated event advances nothing, but is still recorded
 *   - an event never CREATES a communication or an attempt
 *   - an opt-out suppresses even when we cannot resolve which send it answers
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileEmailProviderEvent,
  normalizeBrevoWebhookPayload,
  buildEmailEventKey,
  PROCESSING_STATUS,
} from "@/lib/domain/email/reconcile-email-provider-event.js";
import { TRUST_CLASS } from "@/lib/domain/communications/callback-trust-policy.js";
import { PROVIDER_OUTCOME } from "@/lib/domain/email/email-provider-outcome-lattice.js";

const MESSAGE_ID = "<202609081800.1@brevo>";

/** A store double that records everything it was asked to do. */
function makeStore(over = {}) {
  const calls = { events: [], outcomes: [], suppressions: [], telemetry: [] };
  return {
    calls,
    recordEvent: async (event) => { calls.events.push(event); return { ok: true }; },
    applyOutcome: async (input) => { calls.outcomes.push(input); return { ok: true }; },
    applySuppression: async (input) => { calls.suppressions.push(input); return { ok: true }; },
    recordTelemetry: async (input) => { calls.telemetry.push(input); return { ok: true }; },
    resolveAttempt: over.resolveAttempt || (async () => ({
      ok: true,
      attempt_id: "att-1",
      logical_communication_id: "lc-1",
      provider_outcome: over.current_outcome ?? PROVIDER_OUTCOME.PROVIDER_ACCEPTED,
    })),
  };
}

const event = (over = {}) => ({
  event: "delivered",
  "message-id": MESSAGE_ID,
  email: "seller@example.com",
  date: "2026-09-08T18:05:00Z",
  ...over,
});

const run = (payload, store, trust = TRUST_CLASS.AUTHENTICATED) =>
  reconcileEmailProviderEvent({ payload, trust_class: trust }, store);

// ── the happy path ─────────────────────────────────────────────────────────

test("a delivered event advances the outcome", async () => {
  const store = makeStore();
  const result = await run(event(), store);

  assert.equal(result.processing_status, PROCESSING_STATUS.APPLIED);
  assert.equal(result.advanced, true);
  assert.equal(result.to_outcome, PROVIDER_OUTCOME.DELIVERED);
  assert.equal(store.calls.outcomes.length, 1);
  assert.equal(store.calls.outcomes[0].logical_communication_id, "lc-1");
});

// ── trust ──────────────────────────────────────────────────────────────────

test("an UNAUTHENTICATED event advances nothing", async () => {
  const store = makeStore();
  const result = await run(event(), store, TRUST_CLASS.UNAUTHENTICATED);

  assert.equal(result.ok, false);
  assert.equal(result.processing_status, PROCESSING_STATUS.UNTRUSTED);
  assert.equal(store.calls.outcomes.length, 0);
  assert.equal(store.calls.suppressions.length, 0,
    "an unauthenticated caller must not be able to suppress an address");
});

test("an unauthenticated event is still RECORDED", async () => {
  // It is the only evidence the request arrived. Dropping it makes "did Brevo
  // tell us?" unanswerable.
  const store = makeStore();
  await run(event(), store, TRUST_CLASS.UNAUTHENTICATED);
  assert.equal(store.calls.events.length, 1);
  assert.equal(store.calls.events[0].processing_status, PROCESSING_STATUS.UNTRUSTED);
});

// ── duplicates and ordering ────────────────────────────────────────────────

test("a DUPLICATE redelivery is idempotent, not a second application", async () => {
  const store = makeStore({ current_outcome: PROVIDER_OUTCOME.DELIVERED });
  const result = await run(event(), store);

  assert.equal(result.processing_status, PROCESSING_STATUS.IDEMPOTENT);
  assert.equal(result.advanced, false);
  assert.equal(store.calls.outcomes.length, 0);
});

test("a duplicate produces the SAME event key, so the unique index catches it", async () => {
  const first = normalizeBrevoWebhookPayload(event());
  const second = normalizeBrevoWebhookPayload(event());
  assert.equal(first.event_key, second.event_key);
});

test("the provider's own event id is preferred as the key", async () => {
  const key = buildEmailEventKey({ id: "evt_123" }, {});
  assert.equal(key, "brevo:evt_123");
});

test("the fallback key ignores incidental payload fields", async () => {
  // Brevo varies incidental fields between redeliveries. Hashing them would make
  // every duplicate look new, which is exactly what the key exists to prevent.
  const a = normalizeBrevoWebhookPayload(event({ tags: ["a"], "X-Mailin-custom": "1" }));
  const b = normalizeBrevoWebhookPayload(event({ tags: ["b"], "X-Mailin-custom": "2" }));
  assert.equal(a.event_key, b.event_key);
});

test("an OUT-OF-ORDER weaker event is recorded as stale, never applied", async () => {
  // `delivered` then `sent` is normal. The late `sent` is OLDER, weaker evidence,
  // and applying it would silently downgrade a delivered message.
  const store = makeStore({ current_outcome: PROVIDER_OUTCOME.DELIVERED });
  const result = await run(event({ event: "request" }), store);

  assert.equal(result.processing_status, PROCESSING_STATUS.STALE);
  assert.equal(result.advanced, false);
  assert.equal(store.calls.outcomes.length, 0);
  assert.equal(store.calls.events[0].processing_status, PROCESSING_STATUS.STALE,
    "stale evidence is still evidence and must be kept");
});

test("CONTRADICTORY terminal outcomes are a conflict, never a silent overwrite", async () => {
  const store = makeStore({ current_outcome: PROVIDER_OUTCOME.DELIVERED });
  const result = await run(event({ event: "hard_bounce" }), store);

  assert.equal(result.processing_status, PROCESSING_STATUS.CONFLICT);
  assert.equal(store.calls.outcomes.length, 0,
    "a delivered message that later reports bounced is a contradiction to record, not a downgrade to process");
});

test("a hard bounce after mere acceptance DOES advance", async () => {
  // Without this the conflict test above could pass by refusing everything.
  const store = makeStore({ current_outcome: PROVIDER_OUTCOME.PROVIDER_ACCEPTED });
  const result = await run(event({ event: "hard_bounce" }), store);
  assert.equal(result.processing_status, PROCESSING_STATUS.APPLIED);
});

// ── telemetry is not authority ─────────────────────────────────────────────

test("an OPEN never moves delivery state", async () => {
  // An open is a resource fetch. Scanners, corporate gateways and Apple Mail
  // Privacy Protection all perform it without a human reading anything.
  for (const type of ["opened", "unique_opened", "proxy_open"]) {
    const store = makeStore({ current_outcome: PROVIDER_OUTCOME.PROVIDER_ACCEPTED });
    const result = await run(event({ event: type }), store);
    assert.equal(result.processing_status, PROCESSING_STATUS.INERT, `${type} was not inert`);
    assert.equal(result.advanced, false);
    assert.equal(store.calls.outcomes.length, 0, `${type} moved delivery state`);
  }
});

test("a CLICK never moves delivery state either", async () => {
  for (const type of ["click", "clicked", "unique_click"]) {
    const store = makeStore({ current_outcome: PROVIDER_OUTCOME.PROVIDER_ACCEPTED });
    const result = await run(event({ event: type }), store);
    assert.equal(result.processing_status, PROCESSING_STATUS.INERT, `${type} was not inert`);
    assert.equal(store.calls.outcomes.length, 0);
  }
});

test("telemetry is still RECORDED, because it is real data", async () => {
  const store = makeStore();
  await run(event({ event: "opened" }), store);
  assert.equal(store.calls.telemetry.length, 1);
  assert.equal(store.calls.telemetry[0].event_type, "opened");
  assert.equal(store.calls.events.length, 1);
});

test("an open cannot even reach delivery state via a resolved attempt", async () => {
  // The mechanism is the vocabulary, not a downstream special case: telemetry
  // carries no outcome, so the shared gate sees UNKNOWN and returns inert.
  let resolved = false;
  const store = makeStore({ resolveAttempt: async () => { resolved = true; return { ok: true }; } });
  await run(event({ event: "opened" }), store);
  assert.equal(resolved, false, "telemetry should not even resolve an attempt");
});

// ── unrecognised events ────────────────────────────────────────────────────

test("an UNRECOGNISED event is inert, not a guess", async () => {
  const store = makeStore();
  const result = await run(event({ event: "some_future_brevo_event" }), store);
  assert.equal(result.processing_status, PROCESSING_STATUS.INERT);
  assert.equal(result.processing_reason, "unrecognised_provider_event");
  assert.equal(store.calls.outcomes.length, 0);
});

// ── resolution ─────────────────────────────────────────────────────────────

test("an event with NO message id is unresolved, not applied", async () => {
  const store = makeStore();
  const payload = event();
  delete payload["message-id"];
  const result = await run(payload, store);

  assert.equal(result.processing_status, PROCESSING_STATUS.UNRESOLVED);
  assert.equal(store.calls.outcomes.length, 0);
});

test("an event matching NO attempt never creates one", async () => {
  // A callback that could mint an attempt could mint a send that never happened.
  const store = makeStore({ resolveAttempt: async () => ({ ok: false, reason: "no_attempt_for_provider_message_id" }) });
  const result = await run(event(), store);

  assert.equal(result.processing_status, PROCESSING_STATUS.UNRESOLVED);
  assert.equal(result.advanced, false);
  assert.equal(store.calls.outcomes.length, 0);
});

// ── suppression ────────────────────────────────────────────────────────────

test("an unsubscribe suppresses, and does NOT touch delivery state", async () => {
  const store = makeStore();
  const result = await run(event({ event: "unsubscribed" }), store);

  assert.equal(result.suppressed, true);
  assert.equal(store.calls.suppressions[0].reason, "unsubscribed");
  assert.equal(result.processing_status, PROCESSING_STATUS.INERT,
    "an unsubscribe says nothing about whether the message arrived");
  assert.equal(store.calls.outcomes.length, 0);
});

test("a spam complaint suppresses as a complaint", async () => {
  const store = makeStore();
  await run(event({ event: "spam" }), store);
  assert.equal(store.calls.suppressions[0].reason, "complaint");
});

test("suppression happens even when the send cannot be resolved", async () => {
  // Refusing to suppress because our own bookkeeping failed would turn an
  // internal problem into a compliance one.
  const store = makeStore({ resolveAttempt: async () => ({ ok: false, reason: "no_attempt_for_provider_message_id" }) });
  const result = await run(event({ event: "hard_bounce" }), store);

  assert.equal(result.suppressed, true);
  assert.equal(result.processing_status, PROCESSING_STATUS.UNRESOLVED);
  assert.equal(store.calls.suppressions[0].reason, "hard_bounce");
});

test("suppression is keyed on BOTH the delivery address and the folded mailbox", async () => {
  const store = makeStore();
  await run(event({ event: "unsubscribed", email: "Bob+House@GoogleMail.com" }), store);
  const call = store.calls.suppressions[0];
  assert.equal(call.email_address, "bob+house@googlemail.com");
  assert.equal(call.mailbox_identity, "bob@gmail.com");
});

test("each bounce kind maps to its own suppression reason", async () => {
  const cases = [
    ["hard_bounce", "hard_bounce"],
    ["soft_bounce", "soft_bounce"],
    ["blocked", "blocked"],
    ["invalid_email", "invalid_address"],
    ["unsubscribed", "unsubscribed"],
    ["spam", "complaint"],
  ];
  for (const [event_type, reason] of cases) {
    const store = makeStore();
    await run(event({ event: event_type }), store);
    assert.equal(store.calls.suppressions[0]?.reason, reason, `${event_type} mapped wrongly`);
  }
});

test("a delivered event suppresses nothing", async () => {
  const store = makeStore();
  await run(event(), store);
  assert.equal(store.calls.suppressions.length, 0);
});

// ── normalization ──────────────────────────────────────────────────────────

test("Brevo's spelling variants normalize onto one vocabulary", async () => {
  const pairs = [
    ["delivery", "delivered"], ["bounce", "hard_bounce"], ["hardbounce", "hard_bounce"],
    ["softbounce", "soft_bounce"], ["unsubscribe", "unsubscribed"], ["abuse", "complaint"],
    ["open", "opened"], ["invalid", "invalid_email"],
  ];
  for (const [raw, canonical] of pairs) {
    assert.equal(normalizeBrevoWebhookPayload(event({ event: raw })).event_type, canonical,
      `${raw} did not normalize to ${canonical}`);
  }
});

test("a second-precision timestamp and a millisecond one both parse", async () => {
  const seconds = normalizeBrevoWebhookPayload(event({ date: "1789408800" }));
  const millis = normalizeBrevoWebhookPayload(event({ date: "1789408800000" }));
  assert.equal(seconds.event_at, millis.event_at);
});

test("a missing timestamp falls back to receipt time rather than failing", async () => {
  const payload = event();
  delete payload.date;
  const normalized = normalizeBrevoWebhookPayload(payload, { received_at: "2026-09-08T18:00:00.000Z" });
  assert.equal(normalized.event_at, "2026-09-08T18:00:00.000Z");
});

test("an unparseable recipient does not crash normalization", async () => {
  const normalized = normalizeBrevoWebhookPayload(event({ email: "not an address" }));
  assert.equal(normalized.email_address, null);
});

test("reconciliation never throws on a hostile payload", async () => {
  for (const payload of [null, undefined, {}, [], "string", { event: null }]) {
    const store = makeStore();
    await assert.doesNotReject(() => run(payload, store));
  }
});
