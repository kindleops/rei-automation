/**
 * s11-content-and-sent-truth.test.mjs
 *
 * Two guarantees that sit either side of the provider call.
 *
 * BEFORE: no seller message leaves with an em dash, whatever produced the body.
 * AFTER:  nothing may claim a seller was sent something without provider
 *         evidence for it.
 *
 * The second is the one that protects the humans reading the dashboard. A row
 * that says "sent" with no provider SID behind it is a lie the whole team then
 * makes decisions on.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { dispatchSellerQueueRow } from "@/lib/domain/communications/dispatch-seller-queue-row.js";
import { dispatchManualOperatorSend } from "@/lib/domain/communications/dispatch-manual-operator-send.js";
import { assertNoEmDash } from "@/lib/domain/messaging/outbound-content-guard.js";
import { createMemoryS11Store } from "../helpers/s11-memory-store.mjs";

const ALLOW = async (key) => {
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  return null;
};

function spy() {
  const s = { count: 0, bodies: [] };
  s.fn = async (a) => { s.count += 1; s.bodies.push(a?.body); return { sid: `SM_${s.count}` }; };
  return s;
}

// ── the guard itself ──────────────────────────────────────────────────────

test("the guard catches em AND en dashes, and reports where", () => {
  assert.equal(assertNoEmDash("plain text").ok, true);
  const em = assertNoEmDash("we can close in 14 days — cash");
  assert.equal(em.ok, false);
  assert.equal(em.reason, "outbound_body_contains_em_dash");
  assert.ok(em.sample.includes("—"), "the sample must locate the offender");
  assert.equal(assertNoEmDash("range 10–14 days").ok, false, "en dash too");
});

// ── every seller source class ─────────────────────────────────────────────

const SOURCE_CLASSES = [
  { name: "campaign touch", row: { campaign_target_id: "33333333-3333-4333-8333-333333333333", touch_number: 1 } },
  { name: "autonomous reply", row: { metadata: { decision_id: "decision:evt-1" } } },
  { name: "clarification", row: { metadata: { decision_id: "decision:clarify-1" } } },
  { name: "negotiation", row: { metadata: { decision_id: "decision:negotiate-1" } } },
  { name: "follow-up", row: { metadata: { follow_up_id: "44444444-4444-4444-8444-444444444444" } } },
  { name: "monetary offer", row: { metadata: { use_case: "initial_offer", offer_id: "offer:opp-9:v1" } } },
  { name: "internal canary", row: { metadata: { canary_run_id: "canary-1", canary_leg: "s1" } } },
  { name: "Discord operator reply", row: { metadata: { operator_action_id: "op-77" } } },
];

for (const source of SOURCE_CLASSES) {
  test(`zero em dash: ${source.name} cannot reach the provider with one`, async () => {
    const store = createMemoryS11Store();
    const provider = spy();
    const result = await dispatchSellerQueueRow(
      { id: `q-${source.name}`, thread_key: "+13125550100", to_phone_number: "+13125550100",
        metadata: {}, ...source.row },
      { to: "+13125550100", from: "+18885551212", body: "Cash offer — closing in 14 days." },
      { store, sendProvider: provider.fn, getSystemValue: ALLOW }
    );

    assert.equal(provider.count, 0, `${source.name}: an em dash must never reach the wire`);
    assert.equal(result.reason, "outbound_body_contains_em_dash");
    assert.equal(result.provider_invoked, false);
  });
}

test("zero em dash: manual operator send is not exempt", async () => {
  const provider = spy();
  const result = await dispatchManualOperatorSend({
    operator_action_id: "op-manual-1",
    store: createMemoryS11Store(),
    getSystemValue: ALLOW,
    sendProvider: provider.fn,
    message: { to: "+13125550100", from: "+18885551212", body: "We can do 250k — cash." },
  });
  assert.equal(provider.count, 0, "an operator watching is not an exemption");
  assert.equal(result.reason, "outbound_body_contains_em_dash");
});

test("zero em dash: a clean body on every class DOES reach the provider", async () => {
  // Without this the whole block above could pass by refusing everything.
  for (const source of SOURCE_CLASSES) {
    const store = createMemoryS11Store();
    const provider = spy();
    await dispatchSellerQueueRow(
      { id: `q-ok-${source.name}`, thread_key: "+13125550100", to_phone_number: "+13125550100",
        metadata: {}, ...source.row },
      { to: "+13125550100", from: "+18885551212", body: "Cash offer, closing in 14 days." },
      { store, sendProvider: provider.fn, getSystemValue: ALLOW }
    );
    assert.equal(provider.count, 1, `${source.name}: a clean body must still send`);
    assert.ok(!/[–—]/.test(provider.bodies[0]));
  }
});

// ── sent truth ────────────────────────────────────────────────────────────

test("a send is only reported sent when the provider returned a SID", async () => {
  const store = createMemoryS11Store();
  // Provider accepts but returns NO sid: acceptance cannot be claimed.
  const provider = { count: 0, fn: async () => { provider.count += 1; return {}; } };

  const result = await dispatchSellerQueueRow(
    { id: "q-nosid", thread_key: "+13125550100", to_phone_number: "+13125550100",
      campaign_target_id: "55555555-5555-4555-8555-555555555555", touch_number: 1, metadata: {} },
    { to: "+13125550100", from: "+18885551212", body: "hello" },
    { store, sendProvider: provider.fn, getSystemValue: ALLOW }
  );

  assert.equal(provider.count, 1);
  assert.equal(result.sent, false, "no SID means we cannot assert the seller was sent anything");
  assert.equal(result.provider_message_id, null);
  // And it must NOT be treated as safely retryable.
  assert.equal(result.delivery_possibility, "may_have_been_sent");
  assert.equal(result.retry_authority, "retry_denied");
});

test("provider acceptance is recorded with its SID and forbids retry", async () => {
  const store = createMemoryS11Store();
  const provider = spy();
  const result = await dispatchSellerQueueRow(
    { id: "q-sid", thread_key: "+13125550100", to_phone_number: "+13125550100",
      campaign_target_id: "66666666-6666-4666-8666-666666666666", touch_number: 1, metadata: {} },
    { to: "+13125550100", from: "+18885551212", body: "hello" },
    { store, sendProvider: provider.fn, getSystemValue: ALLOW }
  );

  assert.equal(result.sent, true);
  assert.equal(result.provider_message_id, "SM_1");
  assert.equal(result.retry_authority, "terminal");
  const attempt = store._state.attempts[0];
  assert.equal(attempt.provider_message_id, "SM_1");
  assert.ok(attempt.provider_request_started_at, "the SID implies the request went out");
});
