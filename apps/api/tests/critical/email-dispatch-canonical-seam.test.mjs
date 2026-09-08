/**
 * email-dispatch-canonical-seam.test.mjs
 *
 * Email sends go through the SAME seam as SMS, and are granted no privilege it
 * withholds.
 *
 * The properties under test are the ones that put a duplicate, a suppressed or
 * an unauthorised email in front of a real seller if they break:
 *   - a refused send NEVER reaches the network
 *   - a refused send never CONSUMES an attempt number
 *   - ambiguity is absorbing: a timed-out send is not retried
 *   - the kill switch, the recipient and the sender are three separate vetoes
 *   - a dry run stops before the seam, not before the wire
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryS11Store } from "../helpers/s11-memory-store.mjs";
import { dispatchEmailQueueRow } from "@/lib/domain/email/dispatch-email-queue-row.js";

const ELIGIBLE = async () => ({ ok: true, eligible: true, reason: null, blocking_reasons: [] });
const SENDER = {
  sender_key: "acq-primary",
  from_email: "acq@reivesti.com",
  sender_name: "Acquisitions",
  reply_to_email: "replies@reivesti.com",
  domain: "reivesti.com",
  domain_verified: true,
  is_active: true,
  sender_status: "active",
  warmup_status: "warmed",
  daily_limit: 500,
  messages_sent_today: 10,
};

/** system_control values that permit a send. */
const ALLOW_RUNTIME = async (key) => {
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  return null;
};

function spy(impl) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (typeof impl === "function") return impl(args, calls.length);
    return { ok: true, provider: "brevo", provider_message_id: `<m${calls.length}@brevo>` };
  };
  return { calls, fn, get count() { return calls.length; } };
}

const ROW = (over = {}) => ({
  id: "eq-1",
  queue_status: "queued",
  to_email: "seller@example.com",
  subject: "About your property",
  email_body: "<p>Would you consider an offer?</p>",
  text_body: "Would you consider an offer?",
  campaign_target_id: "11111111-1111-4111-8111-111111111111",
  touch_number: 3,
  master_owner_id: "own-1",
  property_id: "prop-1",
  ...over,
});

function deps(over = {}) {
  const provider = over.provider || spy();
  return {
    provider,
    options: {
      store: over.store || createMemoryS11Store(),
      transport: { provider: "brevo", send: provider.fn },
      getSystemFlag: over.getSystemFlag || (async () => true),
      getSystemValue: over.getSystemValue || ALLOW_RUNTIME,
      resolveEligibility: over.resolveEligibility || ELIGIBLE,
      sender: "sender" in over ? over.sender : SENDER,
      dry_run: over.dry_run,
      now: "2026-09-08T18:00:00.000Z",
    },
  };
}

// ── the happy path, so every refusal below means something ─────────────────

test("a fully authorised email reaches the provider exactly once", async () => {
  const { provider, options } = deps();
  const result = await dispatchEmailQueueRow(ROW(), options);

  assert.equal(result.sent, true, result.reason);
  assert.equal(provider.count, 1);
  assert.equal(result.channel, "email");
  assert.match(result.provider_message_id, /@brevo>$/);
});

test("the whole message reaches the adapter, not just to/from/body", async () => {
  // The seam used to project three fields. An email that lost its subject at the
  // boundary would be sent blank, or refused by the provider as malformed.
  const { provider, options } = deps();
  await dispatchEmailQueueRow(ROW(), options);

  const sent = provider.calls[0];
  assert.equal(sent.to, "seller@example.com");
  assert.equal(sent.subject, "About your property");
  assert.equal(sent.html, "<p>Would you consider an offer?</p>");
  assert.equal(sent.from.email, "acq@reivesti.com");
  assert.equal(sent.reply_to.email, "replies@reivesti.com");
});

// ── every denial path: the provider count MUST be zero ─────────────────────

test("NO denial path ever reaches the network", async () => {
  const cases = [
    ["kill switch off", { getSystemFlag: async () => false }, ROW()],
    ["identity underivable", {}, ROW({ campaign_target_id: null, touch_number: null })],
    ["recipient unparseable", {}, ROW({ to_email: "not an address" })],
    ["recipient ineligible", {
      resolveEligibility: async () => ({ ok: true, eligible: false, reason: "opted_out", blocking_reasons: ["opted_out"] }),
    }, ROW()],
    ["sender missing", { sender: null }, ROW()],
    ["sender suspended", { sender: { ...SENDER, sender_status: "suspended" } }, ROW()],
    ["sender daily cap reached", { sender: { ...SENDER, messages_sent_today: 500 } }, ROW()],
    ["subject missing", {}, ROW({ subject: "", subject_rendered: "" })],
    ["body missing", {}, ROW({ email_body: "" })],
    ["store unavailable", { store: {} }, ROW()],
    ["runtime brake engaged", { getSystemValue: async () => "off" }, ROW()],
    ["monetary row with no offer authority", {}, ROW({ use_case: "initial_offer" })],
  ];

  for (const [label, over, row] of cases) {
    const { provider, options } = deps(over);
    const result = await dispatchEmailQueueRow(row, options);
    assert.equal(result.sent, false, `${label}: must not report a send`);
    assert.equal(provider.count, 0, `${label}: reached the network`);
    assert.equal(result.provider_invoked, false, `${label}: provider_invoked must be false`);
    assert.ok(result.reason, `${label}: a refusal must name a reason`);
  }
});

test("a refusal never CONSUMES an attempt number", async () => {
  // An attempt is a durable claim that a provider request was about to happen.
  // Spending one on a message we were never going to send corrupts the ledger
  // that crash recovery reads.
  const store = createMemoryS11Store();
  const { provider, options } = deps({
    store,
    resolveEligibility: async () => ({ ok: true, eligible: false, reason: "hard_bounced", blocking_reasons: ["hard_bounced"] }),
  });
  await dispatchEmailQueueRow(ROW(), options);

  assert.equal(provider.count, 0);
  assert.equal(store._state.attempts.length, 0, "a refused send allocated an attempt");
});

// ── the three vetoes are genuinely independent ─────────────────────────────

test("the email kill switch stops email without consulting anything else", async () => {
  let eligibility_called = false;
  const { provider, options } = deps({
    getSystemFlag: async () => false,
    resolveEligibility: async () => { eligibility_called = true; return { ok: true, eligible: true }; },
  });
  const result = await dispatchEmailQueueRow(ROW(), options);

  assert.equal(result.reason, "email_channel_disabled");
  assert.equal(result.flag_key, "email_enabled");
  assert.equal(eligibility_called, false, "a disabled channel needs no further questions");
  assert.equal(provider.count, 0);
});

test("a perfect recipient cannot rescue an unfit sender", async () => {
  const { options } = deps({ sender: { ...SENDER, warmup_status: "paused" } });
  const result = await dispatchEmailQueueRow(ROW(), options);
  assert.equal(result.stage, "sender");
  assert.equal(result.reason, "sender_warmup_paused");
});

test("a fit sender cannot rescue an ineligible recipient", async () => {
  const { options } = deps({
    resolveEligibility: async () => ({
      ok: true, eligible: false, reason: "cross_channel_cooldown_active",
      blocking_reasons: ["cross_channel_cooldown_active"], next_eligible_at: "2026-09-09T18:00:00.000Z",
    }),
  });
  const result = await dispatchEmailQueueRow(ROW(), options);
  assert.equal(result.stage, "eligibility");
  assert.equal(result.reason, "cross_channel_cooldown_active");
  assert.equal(result.next_eligible_at, "2026-09-09T18:00:00.000Z",
    "an operator must be told when this becomes sendable");
});

test("an unloadable sender is a refusal, not a fallback to the env default", async () => {
  // Falling back to EMAIL_DEFAULT_SENDER_EMAIL would bypass caps, warm-up and
  // suspension in one step, because the env default has none of them.
  const { provider, options } = deps({ sender: undefined });
  const result = await dispatchEmailQueueRow(ROW(), options);
  assert.equal(result.reason, "sender_not_found");
  assert.equal(provider.count, 0);
});

// ── transport outcomes ─────────────────────────────────────────────────────

test("a REPORTED provider failure is honoured, not read as success", async () => {
  // The adapter reports rather than throws. A seam that only understood
  // exceptions would file this as a send with no message id.
  const provider = spy(async () => ({
    ok: false, provider: "brevo", failure_class: "invalid_to_address",
    may_have_transmitted: false, provider_code: "invalid_parameter",
  }));
  const { options } = deps({ provider });
  const result = await dispatchEmailQueueRow(ROW(), options);

  assert.equal(result.sent, false);
  assert.equal(result.provider_invoked, true);
  assert.equal(result.reason, "invalid_to_address");
  assert.equal(result.delivery_possibility, "definitely_not_sent");
  assert.equal(result.retry_authority, "terminal");
});

test("a TIMEOUT is ambiguous, and a second dispatch is then refused", async () => {
  const store = createMemoryS11Store();
  const provider = spy(async () => ({
    ok: false, provider: "brevo", failure_class: "provider_ambiguous_transport",
    may_have_transmitted: true,
  }));
  const { options } = deps({ store, provider });

  const first = await dispatchEmailQueueRow(ROW(), options);
  assert.equal(first.delivery_possibility, "may_have_been_sent");
  assert.equal(first.retry_authority, "retry_denied");

  // Same row, same anchors: the same logical communication.
  const second = await dispatchEmailQueueRow(ROW(), options);
  assert.equal(second.sent, false);
  assert.equal(second.provider_invoked, false, "ambiguity is absorbing");
  assert.equal(provider.count, 1, "a second email must not reach the seller");
});

test("a provably unsent failure DOES allow a second attempt", async () => {
  // Without this the ambiguity test above could pass by refusing everything.
  const store = createMemoryS11Store();
  const provider = spy(async (_args, attempt) =>
    attempt === 1
      ? { ok: false, provider: "brevo", failure_class: "provider_unreachable_before_request", may_have_transmitted: false }
      : { ok: true, provider: "brevo", provider_message_id: "<retry@brevo>" });
  const { options } = deps({ store, provider });

  const first = await dispatchEmailQueueRow(ROW(), options);
  assert.equal(first.delivery_possibility, "definitely_not_sent");
  assert.equal(first.retry_authority, "retry_allowed");

  const second = await dispatchEmailQueueRow(ROW(), options);
  assert.equal(second.sent, true, second.reason);
  assert.equal(provider.count, 2);
});

test("a 2xx with no message id is not a send", async () => {
  const provider = spy(async () => ({
    ok: false, provider: "brevo", failure_class: "provider_ambiguous_accept", may_have_transmitted: true,
  }));
  const { options } = deps({ provider });
  const result = await dispatchEmailQueueRow(ROW(), options);
  assert.equal(result.sent, false);
  assert.equal(result.retry_authority, "retry_denied");
});

// ── identity ───────────────────────────────────────────────────────────────

test("the same touch on SMS and on email are different communications", async () => {
  const store = createMemoryS11Store();
  const { options } = deps({ store });
  await dispatchEmailQueueRow(ROW(), options);

  const communications = [...store._state.communications.values()];
  assert.equal(communications.length, 1);
  assert.equal(communications[0].channel, "email",
    "the email dispatch must claim the email channel, not inherit sms");
});

test("a bound row uses its stored identity rather than re-deriving one", async () => {
  const store = createMemoryS11Store();
  const seeded = await store.getOrCreateLogicalCommunication({
    logical_key: `lck_v2:campaign_touch:${"a".repeat(64)}`,
    logical_key_version: "lck_v2",
    communication_type: "campaign_touch",
    lineage: { channel: "email", to_email: "seller@example.com" },
  });
  const { provider, options } = deps({ store });

  const result = await dispatchEmailQueueRow(
    ROW({ logical_communication_id: seeded.communication.id, campaign_target_id: null, touch_number: null }),
    options
  );
  assert.equal(result.sent, true, result.reason);
  assert.equal(result.logical_communication_id, seeded.communication.id);
  assert.equal(provider.count, 1);
  assert.equal(store._state.communications.size, 1, "a bound row must not mint a second action");
});

test("a monetary email is identified by its offer and version, never by the touch", async () => {
  const store = createMemoryS11Store();
  const { options } = deps({ store });
  const result = await dispatchEmailQueueRow(
    ROW({ use_case: "counter_offer", seller_offer_id: "offer:opp-1:v2", seller_offer_version: 2 }),
    options
  );
  assert.equal(result.sent, true, result.reason);
  const [comm] = [...store._state.communications.values()];
  assert.equal(comm.communication_type, "monetary_offer");
  assert.equal(comm.seller_offer_version, "2",
    "anchors are strings by construction, so 2 and \"2\" cannot key differently");
});

// ── dry run ────────────────────────────────────────────────────────────────

test("a dry run stops BEFORE the seam, allocating no attempt", async () => {
  // A dry run that allocated an attempt and skipped the wire would leave a
  // numbered attempt with no provider request behind it, which crash recovery
  // reads as "a request may have gone out".
  const store = createMemoryS11Store();
  const { provider, options } = deps({ store, dry_run: true });
  const result = await dispatchEmailQueueRow(ROW(), options);

  assert.equal(result.ok, true);
  assert.equal(result.sent, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.provider_invoked, false);
  assert.equal(provider.count, 0);
  assert.equal(store._state.attempts.length, 0);
  assert.equal(store._state.communications.size, 0, "a dry run must not create a communication");
});

test("a dry run still reports what it WOULD have done", async () => {
  const { options } = deps({ dry_run: true });
  const result = await dispatchEmailQueueRow(ROW(), options);
  assert.equal(result.would_send.to, "seller@example.com");
  assert.equal(result.would_send.from, "acq@reivesti.com");
  assert.equal(result.would_send.communication_type, "campaign_touch");
  assert.equal(result.would_send.sender_remaining_today, 490);
});

test("a dry run is still subject to every veto", async () => {
  for (const over of [
    { dry_run: true, getSystemFlag: async () => false },
    { dry_run: true, sender: { ...SENDER, is_active: false } },
    { dry_run: true, resolveEligibility: async () => ({ ok: true, eligible: false, reason: "opted_out", blocking_reasons: ["opted_out"] }) },
  ]) {
    const { options } = deps(over);
    const result = await dispatchEmailQueueRow(ROW(), options);
    assert.notEqual(result.stage, "dry_run",
      "a dry run must not report a plan the real path would have refused");
  }
});
