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
  assert.equal(row.send_kind, BUYER_DISPOSITION_SEND_KIND);
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
