// ─── deal-context-asof-resolution.test.mjs ───────────────────────────────────
//
// Resolver-level lock for the inbound-context recovery fix in
// getDealContextByThread (deal-context-service.js). Two defects capped its
// real-world coverage after the Podio cutover:
//
//   (a) A v_deal_context_cards row with NULL ids short-circuited the fallback,
//       so a thread whose ids live only on its message_events never recovered.
//   (b) The fallback read the single LATEST message_event for ids — which at
//       decision time is the just-arrived null-id inbound — instead of the
//       latest event that actually CARRIES ids (the campaign/outreach send).
//
// The fix (b) reads the latest id-carrying event, and — critically — bounds that
// lookup to an optional `asOfTimestamp` (the inbound's received-at). 10.7% of
// inbound threads are multi-context (a portfolio owner blasted about many
// properties, or the same phone re-campaigned about a different property/owner
// over time). Without the as-of bound, resolving a reply — or replaying a
// historical inbound via recoverUnprocessedInboundMessages (72h lookback, which
// passes inboundReceivedAt: row.received_at) — could bind a LATER or unrelated
// property. The bound makes it structurally impossible: only events at or before
// the inbound instant are considered.
//
// These tests drive the REAL getDealContextByThread against a filtering
// PostgREST stub, and assert `unsupportedCalls` is empty so no operator was
// silently widened. All identifiers are synthetic.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { getDealContextByThread } from "@/lib/domain/deal-context/deal-context-service.js";
import { makeInboundRealPathSupabase } from "../helpers/inbound-real-path-supabase.mjs";

const T = "+15550100200";

// An outbound campaign send carries property + owner ids; an inbound reply, post
// Podio, carries none. Helper to build message_events fixture rows.
function outbound({ id, property_id, master_owner_id, prospect_id = null, created_at }) {
  return {
    id,
    thread_key: T,
    direction: "outbound",
    property_id,
    master_owner_id,
    prospect_id,
    created_at,
  };
}
function inboundReply({ id, created_at }) {
  return {
    id,
    thread_key: T,
    direction: "inbound",
    property_id: null,
    master_owner_id: null,
    prospect_id: null,
    created_at,
  };
}

function assertNoWidening(supabase) {
  assert.deepEqual(
    supabase.unsupportedCalls,
    [],
    `resolver used an unsupported/widened operator: ${JSON.stringify(supabase.unsupportedCalls)}`
  );
}

// ── (b) POSITIVE ────────────────────────────────────────────────────────────
// Latest event is the null-id inbound; the id-carrying outbound came earlier.
// The bounded resolver must read the outbound's ids, not the inbound's nulls.
test("POSITIVE: as-of resolution reads the latest id-carrying event, not the null-id inbound", async () => {
  const supabase = makeInboundRealPathSupabase({
    message_events: [
      outbound({ id: "e1", property_id: "PROP_A", master_owner_id: "OWN_A", prospect_id: "PROS_A", created_at: "2030-01-01T00:00:00.000Z" }),
      inboundReply({ id: "e2", created_at: "2030-01-01T00:05:00.000Z" }),
    ],
  });

  const ctx = await getDealContextByThread(T, {
    supabase,
    asOfTimestamp: "2030-01-01T00:05:00.000Z",
  });

  assert.equal(ctx?.property_id, "PROP_A");
  assert.equal(ctx?.master_owner_id, "OWN_A");
  assert.equal(ctx?.prospect_id, "PROS_A");
  assertNoWidening(supabase);
});

// ── FAIL-CLOSED ───────────────────────────────────────────────────────────────
// No id-carrying event at or before the inbound ⇒ no ids resolve. Downstream,
// hasUsableContext is false and the decision stays at missing_context.
test("FAIL-CLOSED: no id-carrying event before the inbound resolves no usable id", async () => {
  const supabase = makeInboundRealPathSupabase({
    message_events: [inboundReply({ id: "e2", created_at: "2030-01-01T00:05:00.000Z" })],
  });

  const ctx = await getDealContextByThread(T, {
    supabase,
    asOfTimestamp: "2030-01-01T00:05:00.000Z",
  });

  const hasUsableId =
    Boolean(String(ctx?.property_id ?? "").trim()) ||
    Boolean(String(ctx?.master_owner_id ?? "").trim()) ||
    Boolean(String(ctx?.prospect_id ?? "").trim());
  assert.equal(hasUsableId, false, "must not fabricate an id when none precedes the inbound");
  assertNoWidening(supabase);
});

// ── (a) VIEW NULL-ID FALLTHROUGH ──────────────────────────────────────────────
// Read path (no as-of): a view row exists but carries no ids. It must NOT
// short-circuit; the fallback recovers the ids from message_events.
test("(a): a null-id v_deal_context_cards row falls through to the message_events fallback", async () => {
  const supabase = makeInboundRealPathSupabase({
    message_events: [
      outbound({ id: "e1", property_id: "PROP_A", master_owner_id: "OWN_A", created_at: "2030-01-01T00:00:00.000Z" }),
    ],
    tables: {
      v_deal_context_cards: [
        { thread_key: T, context_type: "unlinked_thread", property_id: null, master_owner_id: null, prospect_id: null },
      ],
    },
  });

  const ctx = await getDealContextByThread(T, { supabase }); // read path, no as-of

  assert.equal(ctx?.property_id, "PROP_A", "null-id view row must not short-circuit the fallback");
  assert.equal(ctx?.master_owner_id, "OWN_A");
  assertNoWidening(supabase);
});

// ── MULTI-PROPERTY / MULTI-CONTEXT AMBIGUITY ─────────────────────────────────
// One thread, two campaigns over time (property A then, later, property B).
// Each reply must bind the campaign in force AT THAT REPLY — the earlier reply
// binds A even though B exists later on the same thread.
test("AMBIGUITY: each reply binds the campaign in force at its own instant, never a later one", async () => {
  const supabase = makeInboundRealPathSupabase({
    message_events: [
      outbound({ id: "e1", property_id: "PROP_A", master_owner_id: "OWN", created_at: "2030-01-01T00:00:00.000Z" }),
      inboundReply({ id: "e2", created_at: "2030-01-01T00:05:00.000Z" }), // reply #1
      outbound({ id: "e3", property_id: "PROP_B", master_owner_id: "OWN", created_at: "2030-02-01T00:00:00.000Z" }),
      inboundReply({ id: "e4", created_at: "2030-02-01T00:05:00.000Z" }), // reply #2
    ],
  });

  const atReply1 = await getDealContextByThread(T, { supabase, asOfTimestamp: "2030-01-01T00:05:00.000Z" });
  assert.equal(atReply1?.property_id, "PROP_A", "reply #1 must bind property A, not the later B");

  const atReply2 = await getDealContextByThread(T, { supabase, asOfTimestamp: "2030-02-01T00:05:00.000Z" });
  assert.equal(atReply2?.property_id, "PROP_B", "reply #2 must bind property B");

  assert.equal(atReply1?.master_owner_id, "OWN");
  assertNoWidening(supabase);
});

// ── REPLAY / RECOVERY SAFETY ─────────────────────────────────────────────────
// recoverUnprocessedInboundMessages reprocesses a historical inbound and passes
// inboundReceivedAt: row.received_at. Even when a LATER campaign for a different
// owner/property now sits on the thread, the bounded resolution must return the
// as-of context — never the newer one. The unbounded read is shown to bind the
// later context, proving WHY the bound is required.
test("REPLAY: reprocessing an old inbound binds the as-of context, not a newer campaign", async () => {
  const supabase = makeInboundRealPathSupabase({
    message_events: [
      outbound({ id: "e1", property_id: "PROP_X", master_owner_id: "OWN_X", created_at: "2030-01-01T00:00:00.000Z" }),
      inboundReply({ id: "e2", created_at: "2030-01-01T00:05:00.000Z" }), // the historical inbound being recovered
      // A later, unrelated campaign to a DIFFERENT owner arrives on the thread:
      outbound({ id: "e3", property_id: "PROP_Y", master_owner_id: "OWN_Y", created_at: "2030-03-15T00:00:00.000Z" }),
    ],
  });

  // Recovery bounds to the historical inbound's received-at.
  const asOf = await getDealContextByThread(T, { supabase, asOfTimestamp: "2030-01-01T00:05:00.000Z" });
  assert.equal(asOf?.property_id, "PROP_X", "recovered inbound must bind the as-of property, not the later PROP_Y");
  assert.equal(asOf?.master_owner_id, "OWN_X", "recovered inbound must bind the as-of owner, not the later OWN_Y");

  // Without the bound (read path), the resolver reflects current state and would
  // bind the newer campaign — the exact mis-bind the as-of bound prevents.
  const unbounded = await getDealContextByThread(T, { supabase });
  assert.equal(unbounded?.property_id, "PROP_Y", "control: the unbounded read binds the latest campaign");

  assertNoWidening(supabase);
});

// ── MULTI-OWNER CONCURRENT AMBIGUITY → FAIL CLOSED ───────────────────────────
// Two DIFFERENT owners have id-carrying events at the SAME most-recent instant
// at/before the inbound. Timestamp ordering cannot say which owner the reply is
// to, so the resolver must fail closed to review — never silently pick the latest.
test("MULTI-OWNER: distinct owners tied at the as-of instant fail closed (no guess)", async () => {
  const supabase = makeInboundRealPathSupabase({
    message_events: [
      outbound({ id: "e1", property_id: "PROP_X", master_owner_id: "OWN_X", created_at: "2030-01-01T00:00:00.000Z" }),
      outbound({ id: "e2", property_id: "PROP_Y", master_owner_id: "OWN_Y", created_at: "2030-01-01T00:00:00.000Z" }), // same instant, different owner
      inboundReply({ id: "e3", created_at: "2030-01-01T00:05:00.000Z" }),
    ],
  });

  const ctx = await getDealContextByThread(T, { supabase, asOfTimestamp: "2030-01-01T00:05:00.000Z" });

  assert.equal(ctx, null, "ambiguous owner at the as-of instant must fail closed to review");
  assertNoWidening(supabase);
});

// ── SAME-OWNER CONCURRENT (MULTI-PROPERTY) → DETERMINISTIC ───────────────────
// The portfolio case: one owner blasted about several properties in a single
// burst (identical timestamps). The owner is unique, so this must STILL resolve
// deterministically — only the ambiguous-owner case fails closed.
test("SAME-OWNER: multiple properties tied at the as-of instant still resolve deterministically", async () => {
  const supabase = makeInboundRealPathSupabase({
    message_events: [
      outbound({ id: "e1", property_id: "PROP_A", master_owner_id: "OWN", created_at: "2030-01-01T00:00:00.000Z" }),
      outbound({ id: "e2", property_id: "PROP_B", master_owner_id: "OWN", created_at: "2030-01-01T00:00:00.000Z" }), // same instant + owner, different property
      inboundReply({ id: "e3", created_at: "2030-01-01T00:05:00.000Z" }),
    ],
  });

  const ctx = await getDealContextByThread(T, { supabase, asOfTimestamp: "2030-01-01T00:05:00.000Z" });

  assert.equal(ctx?.master_owner_id, "OWN", "unique owner must still resolve");
  assert.equal(ctx?.property_id, "PROP_B", "property is taken deterministically from the ordered top event (id desc)");
  assertNoWidening(supabase);
});
