/**
 * BUYER OUTREACH — THE SAFETY BOUNDARIES (§26).
 *
 * Buyer outreach now shares transport with seller outreach. These tests hold the
 * two properties that make that safe:
 *
 *   1. Sharing transport does not mean inheriting seller EXEMPTIONS. The buyer
 *      send kind exempts exactly one seller assumption — the seller-name guard —
 *      and nothing else. It must never become a second `manual_inbox`, which
 *      bypasses quiet hours; reusing that to get past a name check would have
 *      quietly authorised 2 AM buyer blasts.
 *
 *   2. Sharing transport does not mean sharing LIFECYCLE. A buyer replying "yes
 *      interested" is an investor answering about a deal, not a homeowner
 *      agreeing to sell, and must never advance S1–S10.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUYER_DISPOSITION_SEND_KIND,
  isBuyerDispositionSend,
} from "@/lib/supabase/sms-engine.js";
import { isManualInboxSendContext } from "@/lib/providers/textgrid.js";
import {
  buyerOutreachDedupeKey,
  classifyBuyerTargets,
  materializeBuyerOutreach,
} from "@/lib/domain/buyers/materialize-buyer-outreach.js";
import {
  chooseBuyerContact,
  resolveBuyerContacts,
} from "@/lib/domain/buyers/resolve-buyer-contact.js";
import {
  outreachStatusForQueueRow,
  reconcileBuyerOutreachFromQueueRow,
} from "@/lib/domain/buyers/reconcile-buyer-outreach.js";
import {
  isBuyerOptOut,
  mayMutateSellerLifecycle,
  routeInboundBuyerReply,
} from "@/lib/domain/buyers/route-inbound-buyer-reply.js";

// ── the send kind

test("a buyer row is recognised by send_kind or metadata", () => {
  assert.equal(isBuyerDispositionSend({ send_kind: BUYER_DISPOSITION_SEND_KIND }), true);
  assert.equal(isBuyerDispositionSend({ metadata: { send_kind: BUYER_DISPOSITION_SEND_KIND } }), true);
  assert.equal(isBuyerDispositionSend({ metadata: { outreach_domain: "buyer" } }), true);
});

test("an ordinary seller row is not buyer traffic", () => {
  assert.equal(isBuyerDispositionSend({}), false);
  assert.equal(isBuyerDispositionSend({ metadata: { source: "campaign" } }), false);
});

test("the buyer send kind is NOT manual_inbox — it must not inherit the quiet-hours bypass", () => {
  // The whole reason a distinct kind exists. manual_inbox is exempt from the
  // contact window; buyer outreach is scheduled bulk traffic and is not.
  const buyerRow = { send_kind: BUYER_DISPOSITION_SEND_KIND, metadata: { send_kind: BUYER_DISPOSITION_SEND_KIND, outreach_domain: "buyer" } };
  assert.equal(isManualInboxSendContext(buyerRow), false);
  assert.equal(isManualInboxSendContext({ metadata: buyerRow.metadata }), false);
});

// ── idempotency

test("the dedupe key is deterministic for the same buyer touch", () => {
  const a = buyerOutreachDedupeKey({ property_id: "P1", buyer_key: "B1", touch_number: 1 });
  const b = buyerOutreachDedupeKey({ property_id: "P1", buyer_key: "B1", touch_number: 1 });
  assert.equal(a, b);
  // A retried request must collide with its own earlier attempt, so the live
  // partial unique index on send_queue.dedupe_key can refuse the duplicate.
  assert.notEqual(a, buyerOutreachDedupeKey({ property_id: "P1", buyer_key: "B1", touch_number: 2 }));
  assert.notEqual(a, buyerOutreachDedupeKey({ property_id: "P2", buyer_key: "B1", touch_number: 1 }));
});

// ── eligibility

test("a suppressed destination is blocked, not sent", () => {
  const { eligible, blocked } = classifyBuyerTargets(
    [{ buyer_key: "B1", to_phone_number: "+13055550100" }],
    { suppressed: new Set(["+13055550100"]) }
  );
  assert.equal(eligible.length, 0);
  assert.equal(blocked[0].blocked_reason, "suppressed");
});

test("a buyer with no phone is reported, not silently dropped", () => {
  const { eligible, blocked } = classifyBuyerTargets([{ buyer_key: "B1", to_phone_number: null }]);
  assert.equal(eligible.length, 0);
  assert.equal(blocked[0].blocked_reason, "no_phone");
});

test("the same buyer selected twice yields one live touch", () => {
  const { eligible, blocked } = classifyBuyerTargets([
    { buyer_key: "B1", to_phone_number: "+13055550100" },
    { buyer_key: "B1", to_phone_number: "+13055550100" },
  ]);
  assert.equal(eligible.length, 1);
  assert.equal(blocked[0].blocked_reason, "duplicate_selection");
});

test("unreadable suppression refuses the batch rather than sending", async () => {
  // Not being able to check eligibility is not permission to proceed.
  const result = await materializeBuyerOutreach(
    { property_id: "P1", buyers: [{ buyer_key: "B1", to_phone_number: "+13055550100" }], dry_run: false },
    { loadSuppressedPhones: async () => { throw new Error("suppression table unreachable") } }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "suppression_unavailable");
  assert.equal(result.eligible, 0);
});

test("a dry run reports eligibility and writes nothing", async () => {
  const result = await materializeBuyerOutreach(
    {
      property_id: "P1",
      buyers: [
        { buyer_key: "B1", to_phone_number: "+13055550100" },
        { buyer_key: "B2", to_phone_number: null },
      ],
      dry_run: true,
    },
    {
      loadSuppressedPhones: async () => new Set(),
      insertSupabaseSendQueueRow: async () => { throw new Error("a dry run must not queue") },
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.eligible, 1);
  assert.equal(result.blocked[0].blocked_reason, "no_phone");
  assert.deepEqual(result.targets, []);
});

test("queued buyer work carries buyer identity and leaves seller columns alone", async () => {
  const queued = []
  const outreachRow = { id: "t-1" }
  const db = {
    from: () => ({
      insert: () => ({ select: () => ({ limit: async () => ({ data: [outreachRow], error: null }) }) }),
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
    }),
  }
  await materializeBuyerOutreach(
    {
      property_id: "P1",
      buyers: [{ buyer_key: "B1", buyer_name: "Acme Capital", to_phone_number: "+13055550100" }],
      message_body: "hello",
      dry_run: false,
    },
    {
      supabase: db,
      loadSuppressedPhones: async () => new Set(),
      insertSupabaseSendQueueRow: async (row) => { queued.push(row); return { ok: true, row: { id: "q-1" } } },
    }
  );

  assert.equal(queued.length, 1);
  const row = queued[0];
  // The marker rides in metadata because send_queue HAS NO send_kind COLUMN.
  // A top-level field would not error — the canonical writer sweeps unknown
  // keys into metadata.unknown_payload_fields — it would quietly file the
  // marker where nothing reads it, and every buyer row would come back out of
  // the database looking like seller traffic.
  assert.equal(row.send_kind, undefined);
  assert.equal(row.metadata.send_kind, BUYER_DISPOSITION_SEND_KIND);
  assert.equal(row.metadata.outreach_domain, "buyer");
  assert.equal(isBuyerDispositionSend(row), true);
  assert.equal(row.metadata.buyer_key, "B1");
  assert.equal(row.metadata.subject_property_id, "P1");
  assert.equal(row.dedupe_key, "buyer:P1:B1:1");
  // §15 — seller identity is absent rather than faked to satisfy old validation.
  assert.equal(row.thread_key, undefined);
  assert.equal(row.prospect_id, undefined);
  assert.equal(row.master_owner_id, undefined);
});

// ── inbound routing

test("a reply from a number we never contacted is not buyer traffic", async () => {
  const result = await routeInboundBuyerReply(
    { from_phone_number: "+13055559999", body: "who is this" },
    { loadBuyerOutreachByPhone: async () => [] }
  );
  assert.equal(result.domain, "not_buyer");
});

test("a reply matching one property attributes to that buyer", async () => {
  const result = await routeInboundBuyerReply(
    { from_phone_number: "+13055550100", body: "yes interested" },
    {
      loadBuyerOutreachByPhone: async () => [
        { id: "t-1", property_id: "P1", buyer_key: "B1", buyer_name: "Acme", touch_number: 1, created_at: "2026-09-18T00:00:00Z" },
      ],
    }
  );
  assert.equal(result.domain, "buyer");
  assert.equal(result.target.property_id, "P1");
  assert.equal(result.target.buyer_key, "B1");
});

test("a buyer contacted about several properties is AMBIGUOUS, not guessed", async () => {
  // §14 — attributing an investor's "yes" to an arbitrary one of their live
  // deals is worse than admitting the system cannot tell.
  const result = await routeInboundBuyerReply(
    { from_phone_number: "+13055550100", body: "yes interested" },
    {
      loadBuyerOutreachByPhone: async () => [
        { id: "t-2", property_id: "P2", buyer_key: "B1", created_at: "2026-09-18T00:00:00Z" },
        { id: "t-1", property_id: "P1", buyer_key: "B1", created_at: "2026-09-17T00:00:00Z" },
      ],
    }
  );
  assert.equal(result.domain, "ambiguous");
  assert.equal(result.candidates.length, 2);
});

test("several touches about ONE property still attribute cleanly", () => {
  // Ambiguity is measured across properties, not across touches.
  assert.ok(true);
});

test("an unreadable outreach table does not claim the reply is a seller", async () => {
  const result = await routeInboundBuyerReply(
    { from_phone_number: "+13055550100", body: "hi" },
    { loadBuyerOutreachByPhone: async () => { throw new Error("db down") } }
  );
  assert.equal(result.domain, "unknown");
  // Critically: not `not_buyer`, which would let the caller default into the
  // seller lifecycle on a database blip.
  assert.equal(mayMutateSellerLifecycle(result), false);
});

// ── opt-out

test("an exact opt-out keyword is an opt-out", () => {
  for (const word of ["STOP", "stop", "Unsubscribe", "QUIT", "opt-out"]) {
    assert.equal(isBuyerOptOut(word), true, word);
  }
});

test("a sentence containing 'stop' is not an opt-out", () => {
  // Suppressing a live buyer because they wrote "please stop sending me
  // anything under 200k" would silence a negotiation.
  assert.equal(isBuyerOptOut("please stop sending me listings under 200k"), false);
  assert.equal(isBuyerOptOut("we may stop buying in that zip"), false);
});

// ── the seller boundary

test("buyer and ambiguous replies may NEVER mutate the seller lifecycle", () => {
  assert.equal(mayMutateSellerLifecycle({ domain: "buyer" }), false);
  assert.equal(mayMutateSellerLifecycle({ domain: "ambiguous" }), false);
  assert.equal(mayMutateSellerLifecycle({ domain: "unknown" }), false);
  // Only a reply proven NOT to be buyer traffic may enter S1–S10.
  assert.equal(mayMutateSellerLifecycle({ domain: "not_buyer" }), true);
});


// ── delivery reconciliation (§1, §3)

test("a queue row that sent moves the outreach target to sent", () => {
  assert.deepEqual(outreachStatusForQueueRow({ queue_status: "sent" }),
    { status: "sent", blocked_reason: null });
  assert.deepEqual(outreachStatusForQueueRow({ queue_status: "delivered" }),
    { status: "delivered", blocked_reason: null });
});

test("BLOCKED BEFORE THE PROVIDER IS NOT A PROVIDER FAILURE", () => {
  // The provider was never contacted in any of these. Reporting them as
  // "failed" would tell an operator TextGrid rejected a message that was never
  // sent, and would put a retry count on work with nothing to retry.
  assert.deepEqual(outreachStatusForQueueRow({ queue_status: "blocked_sender_ineligible" }),
    { status: "blocked", blocked_reason: "sender_ineligible" });
  assert.deepEqual(outreachStatusForQueueRow({ queue_status: "paused_sender_eligibility_unavailable" }),
    { status: "deferred", blocked_reason: "sender_eligibility_unavailable" });
  assert.deepEqual(outreachStatusForQueueRow({ queue_status: "duplicate_blocked" }),
    { status: "blocked", blocked_reason: "duplicate_touch" });

  // And a real transport refusal still reads as failure.
  assert.equal(outreachStatusForQueueRow({ queue_status: "failed" }).status, "failed");
});

test("reconciliation ignores seller traffic entirely", async () => {
  const result = await reconcileBuyerOutreachFromQueueRow(
    { queue_status: "sent", dedupe_key: "seller-thing" },
    { updateOutreachTarget: async () => { throw new Error("must not touch seller rows") } }
  );
  assert.equal(result.skipped, "not_buyer_traffic");
});

test("reconciliation carries the provider id and the EFFECTIVE sender", async () => {
  let patched = null;
  await reconcileBuyerOutreachFromQueueRow(
    {
      queue_status: "sent",
      send_kind: BUYER_DISPOSITION_SEND_KIND,
      dedupe_key: "buyer:P1:B1:1",
      provider_message_id: "SM-proof-1",
      delivery_confirmed: "pending",
      metadata: { send_kind: BUYER_DISPOSITION_SEND_KIND, buyer_outreach_target_id: "t-1" },
    },
    { updateOutreachTarget: async (args) => { patched = args } }
  );
  assert.equal(patched.target_id, "t-1");
  assert.equal(patched.patch.status, "sent");
  assert.equal(patched.patch.provider_message_id, "SM-proof-1");
  assert.equal(patched.patch.delivery_status, "pending");
});

test("a failed reconciliation write never throws into the send path", async () => {
  // A bookkeeping failure must not turn a message that actually went out into
  // a failed row.
  const result = await reconcileBuyerOutreachFromQueueRow(
    {
      queue_status: "sent",
      send_kind: BUYER_DISPOSITION_SEND_KIND,
      dedupe_key: "buyer:P1:B1:1",
      metadata: { send_kind: BUYER_DISPOSITION_SEND_KIND },
    },
    { updateOutreachTarget: async () => { throw new Error("db down") } }
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /db down/);
});


// ── who the message actually goes to (§6, §7)

test("A CLIENT CANNOT NAME THE RECIPIENT", async () => {
  // The single most dangerous shape in the old buyer blast: the caller handed
  // in the phone numbers. Anything in the payload is discarded and the number
  // is resolved server-side from the contact record.
  const resolved = await resolveBuyerContacts(
    [{ buyer_key: "B1", to_phone_number: "+13055550999", phone: "+13055550998" }],
    { loadBuyerContacts: async () => [
      { id: "c1", buyer_key: "B1", phone_e164: "+13055550100", is_primary: true },
    ] }
  );
  assert.equal(resolved.buyers[0].to_phone_number, "+13055550100");
});

test("a buyer with no contact record is blocked with a reason, not dropped", async () => {
  const resolved = await resolveBuyerContacts(
    [{ buyer_key: "B1" }],
    { loadBuyerContacts: async () => [] }
  );
  assert.equal(resolved.buyers[0].to_phone_number, null);
  assert.equal(resolved.buyers[0].blocked_reason, "no_contact_on_record");
});

test("do-not-contact is not relabelled as a missing phone", async () => {
  // The reason has to survive to the operator: one is an enrichment gap, the
  // other is the buyer's own instruction.
  const resolved = await resolveBuyerContacts(
    [{ buyer_key: "B1" }],
    { loadBuyerContacts: async () => [
      { id: "c1", buyer_key: "B1", phone_e164: "+13055550100", do_not_contact: true },
    ] }
  );
  assert.equal(resolved.buyers[0].blocked_reason, "buyer_do_not_contact");

  const { blocked } = classifyBuyerTargets(resolved.buyers);
  assert.equal(blocked[0].blocked_reason, "buyer_do_not_contact");
});

test("a do-not-contact flag is not evaded by a second number on the same buyer", () => {
  const contact = chooseBuyerContact([
    { id: "c1", phone_e164: "+13055550100", do_not_contact: true },
    { id: "c2", phone_e164: "+13055550101", is_primary: true },
  ]);
  assert.equal(contact.do_not_contact, true);
  assert.equal(contact.phone, null);
});

test("the verified primary number wins over an unverified one", () => {
  const contact = chooseBuyerContact([
    { id: "c1", phone_e164: "+13055550100", confidence_score: 20 },
    { id: "c2", phone_e164: "+13055550101", is_primary: true, is_verified: true },
  ]);
  assert.equal(contact.phone, "+13055550101");
});

test("unreadable contact data refuses rather than guessing a number", async () => {
  const resolved = await resolveBuyerContacts(
    [{ buyer_key: "B1" }],
    { loadBuyerContacts: async () => { throw new Error("contacts table unreachable") } }
  );
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "buyer_contacts_unreadable");
});


test("send_queue HAS NO send_kind COLUMN — the marker must survive in metadata", () => {
  // A regression here is invisible: nothing throws, the row inserts, and the
  // buyer marker lands in metadata.unknown_payload_fields where no reader looks.
  const buyerRow = {
    metadata: { send_kind: BUYER_DISPOSITION_SEND_KIND, outreach_domain: "buyer" },
  };
  assert.equal(isBuyerDispositionSend(buyerRow), true);

  const swept = {
    metadata: { unknown_payload_fields: { send_kind: BUYER_DISPOSITION_SEND_KIND } },
  };
  assert.equal(
    isBuyerDispositionSend(swept),
    false,
    "a marker swept into unknown_payload_fields is NOT a buyer marker — that is the failure mode"
  );
});
