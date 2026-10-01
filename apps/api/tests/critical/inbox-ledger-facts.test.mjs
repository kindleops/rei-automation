/**
 * INBOX DESKTOP 4.0 — the ledger's per-row facts are a PROJECTION.
 *
 * The desktop triage ledger reads its row state (bucket flags, read state,
 * needs-review reason, waiting/follow-up timestamps, stored valuation) from
 * /api/cockpit/inbox/ledger-facts so the compact list contract (<=51 keys)
 * stays untouched. These pin that the projection decides nothing: flags are
 * the canonical predicate's own columns, valuation is the stored estimate
 * (never ARV, never equity derived from a percentage), and a failed valuation
 * read never fails the state.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LEDGER_FACTS_MAX_KEYS,
  LEDGER_FACT_FLAG_COLUMNS,
  LEDGER_FACT_PROPERTY_COLUMNS,
  LEDGER_FACT_STATE_COLUMNS,
  getInboxLedgerFacts,
  parseLedgerFactKeys,
  resolveNeedsReviewReason,
  shapeLedgerFacts,
} from "../../src/lib/domain/inbox/inbox-ledger-facts.js";

function makeSupabase({ stateRows = [], properties = [], propertyError = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, columns: null, inColumn: null, inValues: null };
      calls.push(call);
      const api = {
        select(columns) { call.columns = columns; return api; },
        in(column, values) { call.inColumn = column; call.inValues = values; return api; },
        then(resolve) {
          if (table === "properties" && propertyError) {
            return Promise.resolve().then(() => resolve({ data: null, error: propertyError }));
          }
          const source = table === "properties" ? properties : stateRows;
          const allowed = new Set(call.inValues || []);
          const data = source.filter((row) => allowed.has(String(row[call.inColumn] ?? "")));
          return Promise.resolve().then(() => resolve({ data, error: null }));
        },
      };
      return api;
    },
  };
}

const STATE = {
  thread_key: "+16122232473",
  property_id: "273000001",
  is_read: false,
  last_inbound_at: "2026-09-30T20:20:43.090Z",
  last_outbound_at: "2026-09-30T19:00:00.000Z",
  latest_message_at: "2026-09-30T20:20:43.090Z",
  latest_direction: "inbound",
  latest_delivery_status: null,
  snoozed_until: null,
  follow_up_at: null,
  next_scheduled_for: null,
  disposition: "not_interested",
  last_intent: "not_interested",
  confidence: 0.92,
  manual_override: false,
  f_needs_review: false,
  f_pending_schedule: false,
  seller_stage: "offer_interest",
  lifecycle_stage: "ownership_confirmation",
  in_priority: false,
  in_new_replies: false,
  in_needs_review: false,
  in_waiting: false,
  in_follow_up: true,
  in_scheduled: false,
  in_snoozed: false,
  in_suppressed: false,
  in_dead: false,
  in_cold: false,
  in_archived: false,
};

test("flags are the canonical predicate's own columns, nothing re-derived", () => {
  const facts = shapeLedgerFacts(STATE, null);
  assert.deepEqual(facts.flags, ["follow_up"]);
  assert.equal(facts.is_read, false);
  assert.equal(facts.stage, "offer_interest", "seller_stage wins over the legacy lifecycle column");
  assert.equal(facts.seller_stage, "offer_interest", "the raw column travels too, for like-for-like stage diffs");
  assert.equal(facts.disposition, "not_interested");
  assert.equal(facts.pending_send, false);
  assert.equal(facts.last_inbound_at, "2026-09-30T20:20:43.090Z");
});

test("needs-review reason follows the predicate: override, then confidence, then bucket", () => {
  assert.equal(resolveNeedsReviewReason({ in_needs_review: false, manual_override: true }), null, "not in the bucket, no reason");
  assert.equal(resolveNeedsReviewReason({ in_needs_review: true, manual_override: true, confidence: 0.2 }), "manual_override");
  assert.equal(resolveNeedsReviewReason({ in_needs_review: true, confidence: 0.42 }), "low_confidence");
  assert.equal(resolveNeedsReviewReason({ in_needs_review: true, confidence: 0.9 }), "needs_review_bucket");
});

test("valuation is the stored estimate only — never ARV, never a derived equity amount", () => {
  const facts = shapeLedgerFacts(STATE, { property_id: "273000001", estimated_value: "212000", equity_percent: 76, equity_amount: null, arv: 300000 });
  assert.equal(facts.estimated_value, 212000);
  assert.equal(facts.equity_percent, 76);
  assert.equal(facts.equity_amount, null, "equity amount is not computed from the percentage");
  const noValue = shapeLedgerFacts(STATE, { property_id: "273000001", estimated_value: 0, arv: 300000 });
  assert.equal(noValue.estimated_value, null, "a zero estimate is no estimate, and ARV is not a substitute");
});

test("unknown values stay unknown", () => {
  const facts = shapeLedgerFacts({ thread_key: "+1", confidence: 7, is_read: "yes" }, null);
  assert.equal(facts.is_read, null);
  assert.equal(facts.confidence, null, "a confidence outside 0..1 is not reported");
  assert.equal(facts.last_intent, null);
  assert.deepEqual(facts.flags, []);
});

test("keys are trimmed, de-duplicated and bounded", () => {
  assert.deepEqual(parseLedgerFactKeys(" +1, +2 ,+1,,+3"), ["+1", "+2", "+3"]);
  const many = Array.from({ length: LEDGER_FACTS_MAX_KEYS + 30 }, (_, i) => `+1555000${i}`).join(",");
  assert.equal(parseLedgerFactKeys(many).length, LEDGER_FACTS_MAX_KEYS);
});

test("reads the predicate view by thread_key, then properties by the ids it carries", async () => {
  const supabase = makeSupabase({ stateRows: [STATE], properties: [{ property_id: "273000001", estimated_value: 212000, equity_percent: 76, equity_amount: 160000 }] });
  const { facts, missing } = await getInboxLedgerFacts(["+16122232473", "+19990000000"], { supabase });
  assert.equal(supabase.calls[0].table, "v_inbox_thread_state_buckets");
  assert.equal(supabase.calls[0].inColumn, "thread_key");
  assert.equal(supabase.calls[0].columns, [...LEDGER_FACT_STATE_COLUMNS, ...LEDGER_FACT_FLAG_COLUMNS].join(","));
  assert.equal(supabase.calls[1].table, "properties");
  assert.equal(supabase.calls[1].columns, LEDGER_FACT_PROPERTY_COLUMNS.join(","));
  assert.deepEqual(supabase.calls[1].inValues, ["273000001"]);
  assert.equal(facts["+16122232473"].estimated_value, 212000);
  assert.equal(facts["+16122232473"].equity_amount, 160000);
  assert.deepEqual(missing, ["+19990000000"]);
});

test("a valuation read that fails never fails the state facts", async () => {
  const supabase = makeSupabase({ stateRows: [STATE], propertyError: { message: "boom" } });
  const { facts } = await getInboxLedgerFacts(["+16122232473"], { supabase });
  assert.deepEqual(facts["+16122232473"].flags, ["follow_up"]);
  assert.equal(facts["+16122232473"].estimated_value, null);
});

test("no keys, no reads", async () => {
  const supabase = makeSupabase();
  const result = await getInboxLedgerFacts([], { supabase });
  assert.deepEqual(result, { facts: {}, missing: [] });
  assert.equal(supabase.calls.length, 0);
});
