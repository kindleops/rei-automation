// ─── dual-context-builder-crosscheck.test.mjs ────────────────────────────────
// G4 cross-check: the two context builders — classification/
// build-conversation-context.js (conversation_context_v1 for the classifier)
// and domain/context/find-recent-outbound-pair.js (fallback pair resolution) —
// must agree BY CONSTRUCTION on which outbound row the seller is answering.
// Their historical divergence produced the 4-day-stale binding (fixed at
// 663461ba): a fresh provider-linked ownership opening lost to an old
// delivered S2 auto-reply because one builder demanded deal-identity ids on
// the conversation row and the other did not.
//
// One fixture thread, both builders, same chosen outbound. Do NOT refactor the
// builders into one — this test is the agreed containment for the duality.

import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { findRecentOutboundContextPair } from "@/lib/domain/context/find-recent-outbound-pair.js";

const SELLER = "+16128072000";
const OURS = "+16128060495";
const INBOUND_AT = "2026-08-06T18:00:00.000Z";

const STALE_S2 = {
  id: "q-stale-s2",
  to_phone_number: SELLER,
  from_phone_number: OURS,
  message_type: "proposal_interest",
  use_case_template: "proposal_interest",
  queue_status: "delivered",
  sent_at: "2026-08-02T17:00:00.000Z", // four days stale
  delivered_at: "2026-08-02T17:00:05.000Z",
  created_at: "2026-08-02T16:59:00.000Z",
  provider_message_id: "SM_STALE_S2",
  master_owner_id: "own_1",
  property_id: "prop_1",
  message_body: "Would you consider an offer on the property?",
  metadata: {},
};

// The fresh ownership opening: genuinely sent, provider SID, seller replied
// 36 seconds later — but NO owner/property ids (the 2026-08-06 defect shape).
const FRESH_S1 = {
  id: "q-fresh-s1",
  to_phone_number: SELLER,
  from_phone_number: OURS,
  message_type: "ownership_check",
  use_case_template: "ownership_check",
  queue_status: "sent",
  sent_at: "2026-08-06T17:59:24.000Z",
  delivered_at: null,
  created_at: "2026-08-06T17:59:20.000Z",
  provider_message_id: "SM_FRESH_S1",
  master_owner_id: null,
  property_id: null,
  message_body: "Do you still own 4157 Pillsbury Ave S Unit B?",
  metadata: {},
};

// Sent AFTER the inbound: may never become the question the inbound answered.
const LATER_OUTBOUND = {
  id: "q-later",
  to_phone_number: SELLER,
  from_phone_number: OURS,
  message_type: "asking_price",
  use_case_template: "asking_price",
  queue_status: "sent",
  sent_at: "2026-08-06T18:05:00.000Z",
  created_at: "2026-08-06T18:04:00.000Z",
  provider_message_id: "SM_LATER",
  master_owner_id: "own_1",
  property_id: "prop_1",
  message_body: "What number did you have in mind?",
  metadata: {},
};

function makeFakeSupabase(seed) {
  const state = {
    send_queue: seed.send_queue || [],
    message_events: seed.message_events || [],
  };

  function query(table) {
    const q = {
      _filters: [],
      _order: [],
      _limit: null,
      select() {
        return q;
      },
      eq(col, val) {
        q._filters.push((r) => String(r[col]) === String(val));
        return q;
      },
      in(col, vals) {
        q._filters.push((r) => vals.map(String).includes(String(r[col])));
        return q;
      },
      is(col, val) {
        q._filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return q;
      },
      not(col, _op, val) {
        q._filters.push((r) => !(val === null ? r[col] == null : r[col] === val));
        return q;
      },
      gt(col, val) {
        q._filters.push((r) => String(r[col] ?? "") > String(val));
        return q;
      },
      lt(col, val) {
        q._filters.push((r) => String(r[col] ?? "") < String(val));
        return q;
      },
      lte(col, val) {
        q._filters.push((r) => String(r[col] ?? "") <= String(val));
        return q;
      },
      gte(col, val) {
        q._filters.push((r) => String(r[col] ?? "") >= String(val));
        return q;
      },
      order(col, opts = {}) {
        q._order.push([col, opts.ascending !== false]);
        return q;
      },
      limit(n) {
        q._limit = n;
        return q;
      },
      maybeSingle() {
        return q._exec().then(({ data, error }) => ({ data: data[0] || null, error }));
      },
      then(onF, onR) {
        return q._exec().then(onF, onR);
      },
      async _exec() {
        let rows = (state[table] || []).filter((r) => q._filters.every((f) => f(r)));
        if (q._order.length) {
          rows = [...rows].sort((a, b) => {
            for (const [col, asc] of q._order) {
              const av = String(a[col] ?? "");
              const bv = String(b[col] ?? "");
              if (av !== bv) return asc ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
            }
            return 0;
          });
        }
        if (q._limit) rows = rows.slice(0, q._limit);
        return { data: rows, error: null };
      },
    };
    return q;
  }

  return { from: (table) => query(table) };
}

test("dual context builders choose the SAME outbound row for the same thread", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [STALE_S2, FRESH_S1, LATER_OUTBOUND],
    message_events: [],
  });

  const conversation_context = await buildConversationContext({
    thread_key: SELLER,
    inbound_received_at: INBOUND_AT,
    supabase,
  });
  assert.ok(conversation_context, "buildConversationContext returned null");

  const pair = await findRecentOutboundContextPair(SELLER, OURS, {
    supabase,
    inbound_received_at: INBOUND_AT,
  });
  assert.equal(pair.found, true, JSON.stringify(pair));
  assert.equal(pair.source, "recent_outbound_send_queue");

  // THE cross-check: both builders bound the inbound to the same outbound.
  assert.equal(conversation_context.last_outbound_message_id, "SM_FRESH_S1");
  assert.equal(pair.context.match.matched_provider_message_id, "SM_FRESH_S1");
  assert.equal(pair.context.match.matched_queue_id, "q-fresh-s1");
  assert.equal(
    conversation_context.last_outbound_message_id,
    pair.context.match.matched_provider_message_id,
    "context builders diverged on which outbound the seller is answering"
  );

  // The conversation facts come from the FRESH row…
  assert.equal(conversation_context.last_outbound_use_case, "ownership_check");
  assert.equal(conversation_context.question_status, "unanswered");
  assert.equal(
    pair.context.recent.last_outbound_message,
    "Do you still own 4157 Pillsbury Ave S Unit B?"
  );
  // …while deal IDENTITY is backfilled from thread history (a thread fact).
  assert.equal(pair.context.ids.master_owner_id, "own_1");
  assert.equal(pair.context.ids.property_id, "prop_1");
  assert.equal(pair.context.match.match_strategy, "fresh_sent_outbound_backfilled_context");
  // The conversation template is never inherited from the older turn.
  assert.equal(pair.context.ids.template_id, null);
});

test("temporal authority: both builders refuse an outbound sent after the inbound", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [STALE_S2, LATER_OUTBOUND],
    message_events: [],
  });

  const conversation_context = await buildConversationContext({
    thread_key: SELLER,
    inbound_received_at: INBOUND_AT,
    supabase,
  });
  const pair = await findRecentOutboundContextPair(SELLER, OURS, {
    supabase,
    inbound_received_at: INBOUND_AT,
  });

  // With the fresh S1 gone, the only legal answer is the stale-but-real S2 —
  // never the row sent five minutes AFTER the seller's message.
  assert.equal(conversation_context.last_outbound_message_id, "SM_STALE_S2");
  assert.equal(pair.context.match.matched_provider_message_id, "SM_STALE_S2");
  assert.equal(
    conversation_context.last_outbound_message_id,
    pair.context.match.matched_provider_message_id
  );
});

test("classifier-linked provider SID wins in the pair builder and matches the SID the classifier bound", async () => {
  const supabase = makeFakeSupabase({
    send_queue: [STALE_S2, FRESH_S1],
    message_events: [],
  });

  const pair = await findRecentOutboundContextPair(SELLER, OURS, {
    supabase,
    inbound_received_at: INBOUND_AT,
    context_source_id: "SM_FRESH_S1",
  });
  assert.equal(pair.context.match.context_linked, true);
  assert.equal(pair.context.match.match_strategy, "classifier_context_linked_outbound");
  assert.equal(pair.context.match.matched_provider_message_id, "SM_FRESH_S1");
});
