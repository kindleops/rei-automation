/**
 * monetary-communication-authority.test.mjs
 *
 * A message that states a price is the one place where a duplicate is not the
 * worst outcome. Sending DIFFERENT TERMS under the same identity is worse: the
 * seller sees two numbers from us and we cannot say which one we are bound to.
 *
 * So monetary identity is the OFFER and its VERSION, never the rendered amount,
 * the template, or the send time. A transport retry re-sends an already
 * authorised message; it never re-underwrites.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveQueueRowIdentity } from "@/lib/domain/communications/queue-row-identity.js";
import { dispatchSellerQueueRow } from "@/lib/domain/communications/dispatch-seller-queue-row.js";
import { buildLogicalCommunicationKey } from "@/lib/domain/communications/logical-communication-key.js";
import { createMemoryS11Store } from "../helpers/s11-memory-store.mjs";
import { TextGridError } from "@/lib/providers/textgrid.js";

const ALLOW_RUNTIME = async (key) => {
  if (key === "queue_processor_mode") return "live";
  if (key === "queue_execution_mode") return "normal";
  return null;
};

function monetaryRow(overrides = {}, metadata = {}) {
  return {
    id: "q-monetary-1",
    thread_key: "+13125550100",
    to_phone_number: "+13125550100",
    metadata: {
      use_case: "initial_offer",
      offer_id: "offer:opp-1:v1",
      ...metadata,
    },
    ...overrides,
  };
}

function makeSpy(impl) {
  const spy = { count: 0, bodies: [] };
  spy.fn = async (args) => {
    spy.count += 1;
    spy.bodies.push(args?.body);
    if (typeof impl === "function") return impl(args);
    return { sid: `SM_${spy.count}` };
  };
  return spy;
}

const run = (queue_row, message, deps) =>
  dispatchSellerQueueRow(queue_row, message, {
    getSystemValue: ALLOW_RUNTIME,
    ...deps,
  });

// ── identity ──────────────────────────────────────────────────────────────

test("a priced message is identified by its offer and version", () => {
  const identity = resolveQueueRowIdentity(monetaryRow());
  assert.equal(identity.ok, true);
  assert.equal(identity.communication_type, "monetary_offer");
  assert.deepEqual(identity.anchors, { offer_id: "offer:opp-1:v1", offer_version: "1" });
});

test("monetary identity beats campaign identity on the same row", () => {
  // A priced message sent inside a campaign is STILL a monetary communication.
  // Binding it to the touch would let a retry deliver a different authorised
  // amount under an identity that says nothing about money.
  const identity = resolveQueueRowIdentity(monetaryRow({
    campaign_target_id: "11111111-1111-4111-8111-111111111111",
    touch_number: 3,
  }));
  assert.equal(identity.communication_type, "monetary_offer");
});

test("a priced message with no offer authority is REFUSED, not sent", async () => {
  const spy = makeSpy();
  const identity = resolveQueueRowIdentity(monetaryRow({}, { offer_id: null }));
  assert.equal(identity.ok, false);
  assert.equal(identity.reason, "monetary_communication_without_offer_authority");

  const result = await run(
    monetaryRow({}, { offer_id: null }),
    { to: "+13125550100", from: "+18885551212", body: "We can offer $250,000." },
    { store: createMemoryS11Store(), sendProvider: spy.fn }
  );
  assert.equal(spy.count, 0, "a price with no authority behind it must never reach the wire");
  assert.equal(result.reason, "monetary_communication_without_offer_authority");
});

// ── the amount is not identity ────────────────────────────────────────────

test("re-rendering the SAME offer version is ONE communication", async () => {
  const store = createMemoryS11Store();
  const spy = makeSpy();

  await run(monetaryRow(), { to: "+13125550100", from: "+18885551212", body: "We can offer $250,000." },
    { store, sendProvider: spy.fn });
  // Same offer, same version, different wording and a different template.
  await run(monetaryRow({}, { template_id: "tpl-B" }),
    { to: "+13125550100", from: "+18885551212", body: "Our offer is 250k, cash." },
    { store, sendProvider: spy.fn });

  assert.equal(store._state.communications.size, 1,
    "wording and template are presentation, not identity");
});

test("a NEW offer version is a NEW communication", async () => {
  const store = createMemoryS11Store();
  const spy = makeSpy();

  await run(monetaryRow(), { to: "+13125550100", from: "+18885551212", body: "offer v1" },
    { store, sendProvider: spy.fn });
  await run(monetaryRow({ id: "q-monetary-2" }, { offer_id: "offer:opp-1:v2" }),
    { to: "+13125550100", from: "+18885551212", body: "offer v2" },
    { store, sendProvider: spy.fn });

  assert.equal(store._state.communications.size, 2,
    "changed terms require a new version AND a new domain action");
});

test("the two offer versions produce DIFFERENT logical keys", () => {
  const v1 = buildLogicalCommunicationKey({
    communication_type: "monetary_offer", offer_id: "offer:opp-1:v1", offer_version: "1",
  });
  const v2 = buildLogicalCommunicationKey({
    communication_type: "monetary_offer", offer_id: "offer:opp-1:v1", offer_version: "2",
  });
  assert.equal(v1.ok, true);
  assert.equal(v2.ok, true);
  assert.notEqual(v1.key, v2.key, "the version must participate in identity");
});

// ── retry cannot drift terms ──────────────────────────────────────────────

test("a transport retry reuses the SAME offer version and communication", async () => {
  const store = createMemoryS11Store();
  // A real TextGridError: the classifier reads cause_code/network_phase from it,
  // and a bare Error would fall to the fail-closed unknown branch instead.
  const refused = new TextGridError("fetch failed", {
    cause_code: "ECONNREFUSED", network_phase: "connect", may_have_transmitted: false,
  });
  let first = true;
  const spy = makeSpy(async () => {
    if (first) { first = false; throw refused; }
    return { sid: "SM_RETRY" };
  });

  const a = await run(monetaryRow(), { to: "+13125550100", from: "+18885551212", body: "offer v1" },
    { store, sendProvider: spy.fn });
  assert.equal(a.provider_invoked, true);

  const b = await run(monetaryRow(), { to: "+13125550100", from: "+18885551212", body: "offer v1" },
    { store, sendProvider: spy.fn });

  assert.equal(store._state.communications.size, 1, "a retry is the SAME monetary action");
  assert.equal(store._state.attempts.length, 2, "a retry is a NEW attempt");
  const comm = [...store._state.communications.values()][0];
  assert.equal(comm.seller_offer_version, "1", "the version must not move under a retry");
  assert.equal(b.ok, true, `retry should proceed: ${b.reason}`);
});

test("a bound row whose offer version has MOVED is refused", async () => {
  // Something upstream re-underwrote between attempts. Delivering now would put
  // terms in front of the seller that were never authorised under this
  // communication, so refuse loudly instead of silently repairing.
  const store = createMemoryS11Store();
  const created = await store.getOrCreateLogicalCommunication({
    logical_key: `lck_v1:monetary_offer:${"a".repeat(64)}`,
    communication_type: "monetary_offer",
    lineage: { seller_offer_id: "offer:opp-1:v1", seller_offer_version: "1" },
  });
  const spy = makeSpy();

  const result = await run(
    monetaryRow({ logical_communication_id: created.communication.id },
      { offer_id: "offer:opp-1:v2" }),
    { to: "+13125550100", from: "+18885551212", body: "offer v2" },
    { store, sendProvider: spy.fn }
  );

  assert.equal(spy.count, 0, "drifted terms must never reach the wire");
  assert.equal(result.reason, "monetary_communication_offer_mismatch");
  assert.equal(result.stage, "monetary_authority");
});
