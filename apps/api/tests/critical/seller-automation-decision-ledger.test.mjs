import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDecisionLedgerRow,
  buildDecisionId,
  deriveDecisionAction,
  deriveDecisionInputFromSnapshot,
  recordSellerAutomationDecision,
  DECISION_ACTIONS,
  DECISION_LEDGER_VERSION,
} from "@/lib/domain/seller-flow/record-seller-automation-decision.js";

// The canonical append-only decision ledger (supersprint §3/§4).
//   one seller event -> one canonical decision -> one immutable row.
// Tests: deterministic id; total action derivation; row mapping + malformed
// conversation id handling; snapshot derivation with lineage; idempotency
// (onConflict do-nothing); append-only (the writer never issues an UPDATE);
// fail-closed on a missing event id; schema-missing tolerance.

const THREAD = "+15550100123";

// In-memory ledger enforcing the real constraints: UNIQUE(event_id),
// append-only (no UPDATE path is ever taken by the writer).
function makeSupabase({ failWith = null } = {}) {
  const state = { rows: [], updateCalls: 0 };
  function from(name) {
    assert.equal(name, "seller_automation_decisions", "writer must target the ledger table");
    return {
      upsert(row, opts) {
        return {
          select: () => ({
            async maybeSingle() {
              if (failWith) return { data: null, error: { message: failWith } };
              assert.equal(opts?.onConflict, "event_id");
              assert.equal(opts?.ignoreDuplicates, true, "must be append-only ignore-duplicates");
              const exists = state.rows.some((r) => r.event_id === row.event_id);
              if (exists) return { data: null, error: null }; // idempotent no-op
              const created = { id: `row-${state.rows.length + 1}`, ...row };
              state.rows.push(created);
              return { data: { id: created.id, decision_id: created.decision_id }, error: null };
            },
          }),
        };
      },
      update() {
        state.updateCalls += 1; // the writer must NEVER call this
        throw new Error("update is not permitted on an append-only ledger");
      },
    };
  }
  return { from, _state: state };
}

// ── id + action derivation ───────────────────────────────────────────────────

test("decision id is deterministic per event", () => {
  assert.equal(buildDecisionId("evt-1"), "decision:evt-1");
  assert.equal(buildDecisionId(""), null);
  assert.equal(buildDecisionId(null), null);
});

test("action derivation is total: every decision resolves to exactly one action", () => {
  assert.equal(deriveDecisionAction({ closing_case_id: "closing:x" }), DECISION_ACTIONS.ACCEPT);
  assert.equal(deriveDecisionAction({ terms_accepted: true }), DECISION_ACTIONS.ACCEPT);
  assert.equal(deriveDecisionAction({ safety_status: "suppressed" }), DECISION_ACTIONS.SUPPRESS);
  assert.equal(deriveDecisionAction({ should_suppress_contact: true }), DECISION_ACTIONS.SUPPRESS);
  assert.equal(deriveDecisionAction({ queued: true, negotiation_strategy: "counter_offer" }), DECISION_ACTIONS.NEGOTIATE);
  assert.equal(deriveDecisionAction({ queued: true }), DECISION_ACTIONS.SEND);
  assert.equal(deriveDecisionAction({ should_mark_human_review: true }), DECISION_ACTIONS.ESCALATE);
  assert.equal(deriveDecisionAction({ safety_status: "review" }), DECISION_ACTIONS.ESCALATE);
  assert.equal(deriveDecisionAction({ follow_up_at: "2026-09-10T00:00:00Z" }), DECISION_ACTIONS.SCHEDULE);
  assert.equal(deriveDecisionAction({ safe_fallback: { suggested_text: "?" } }), DECISION_ACTIONS.CLARIFY);
  // a fully empty/uncertain decision still resolves — never null/unhandled
  const a = deriveDecisionAction({});
  assert.equal(a, DECISION_ACTIONS.HOLD);
  assert.ok(Object.values(DECISION_ACTIONS).includes(a));
});

// ── row mapping ──────────────────────────────────────────────────────────────

test("the ledger row carries the full lineage and never fabricates ids", () => {
  const row = buildDecisionLedgerRow({
    event_id: "evt-42",
    provider_message_sid: "SM123",
    conversation_id: THREAD,
    opportunity_id: "opp-1",
    property_id: "prop-1",
    seller_id: "owner-1",
    decision_version: "seller_flow_decision_v1",
    normalized_intent: "seller_interested",
    confidence: 0.91,
    prior_stage: "ownership_confirmation",
    resulting_stage: "offer_interest",
    action: "send",
    action_reason: "interest_confirmed",
    offer_id: "offer:opp-1:v1",
    offer_version: 1,
    terms_hash: "hash-1",
    ade_snapshot_id: "ade:1",
    queue_row_id: "q-1",
    closing_case_id: null,
    policy_versions: { offer: "v1" },
    execution_result: { queued: true },
    lineage: { thread_key: THREAD },
  });
  assert.equal(row.decision_id, "decision:evt-42");
  assert.equal(row.event_id, "evt-42");
  assert.equal(row.conversation_id, THREAD);
  assert.equal(row.offer_id, "offer:opp-1:v1");
  assert.equal(row.offer_version, 1);
  assert.equal(row.queue_row_id, "q-1");
  assert.equal(row.closing_case_id, null);
  assert.deepEqual(row.policy_versions, { offer: "v1" });
  assert.deepEqual(row.execution_result, { queued: true });
});

test("a malformed conversation id is stored as null, not a broken key", () => {
  const row = buildDecisionLedgerRow({ event_id: "e", conversation_id: "not-a-phone" });
  assert.equal(row.conversation_id, null);
  // a valid E.164 survives
  assert.equal(buildDecisionLedgerRow({ event_id: "e", conversation_id: THREAD }).conversation_id, THREAD);
});

test("an absent decision_version falls back to the ledger version, action never null", () => {
  const row = buildDecisionLedgerRow({ event_id: "e" });
  assert.equal(row.decision_version, DECISION_LEDGER_VERSION);
  assert.ok(Object.values(DECISION_ACTIONS).includes(row.action));
});

// ── snapshot derivation ──────────────────────────────────────────────────────

test("a decision input is derived from the intelligence snapshot with lineage", () => {
  const snapshot = {
    source_event_id: "evt-99",
    provider_message_sid: "SM999",
    source_thread_key: THREAD,
    canonical_intent: "asks_offer",
    universal_stage: "offer",
    safety_status: "allowed",
    decision_version: "inbound_intelligence_v4_three_layer",
    canonical_decision: {
      stage_before: "asking_price",
      stage_after: "offer",
      offer_id: "offer:opp-9:v2",
      offer_version: 2,
      offer_terms_hash: "hash-9",
      ade_snapshot_id: "ade:9",
      queue_row_id: "q-9",
      next_action: "generate_offer",
      transition: { negotiation_strategy: "counter_offer" },
      rendered_message: "hi",
    },
  };
  const input = deriveDecisionInputFromSnapshot(snapshot);
  assert.equal(input.event_id, "evt-99");
  assert.equal(input.conversation_id, THREAD);
  assert.equal(input.offer_id, "offer:opp-9:v2");
  assert.equal(input.offer_version, 2);
  assert.equal(input.queue_row_id, "q-9");
  assert.equal(input.ade_snapshot_id, "ade:9");
  assert.equal(input.lineage.offer_id, "offer:opp-9:v2");

  const row = buildDecisionLedgerRow(input);
  // queued + negotiation strategy -> NEGOTIATE
  assert.equal(row.action, DECISION_ACTIONS.NEGOTIATE);
});

// ── idempotency + append-only ────────────────────────────────────────────────

test("recording is idempotent by event_id and never updates history", async () => {
  const supabase = makeSupabase();
  const input = { event_id: "evt-idem", conversation_id: THREAD, normalized_intent: "seller_interested" };
  const first = await recordSellerAutomationDecision({ supabase, input });
  const second = await recordSellerAutomationDecision({ supabase, input });
  assert.equal(first.ok, true);
  assert.equal(first.inserted, true);
  assert.equal(second.ok, true);
  assert.equal(second.inserted, false, "a duplicate event is an idempotent no-op");
  assert.equal(supabase._state.rows.length, 1);
  assert.equal(supabase._state.updateCalls, 0, "the writer must never UPDATE the ledger");
});

// ── dry run + fail-closed + schema tolerance ─────────────────────────────────

test("dry_run writes nothing", async () => {
  const supabase = makeSupabase();
  const r = await recordSellerAutomationDecision({ supabase, input: { event_id: "e", conversation_id: THREAD }, dry_run: true });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.inserted, false);
  assert.equal(supabase._state.rows.length, 0);
});

test("a missing event id fails closed", async () => {
  const supabase = makeSupabase();
  const r = await recordSellerAutomationDecision({ supabase, input: { conversation_id: THREAD } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_event_id");
});

test("a missing ledger table is reported as schema_missing, not thrown", async () => {
  const supabase = makeSupabase({ failWith: "relation \"seller_automation_decisions\" does not exist" });
  const r = await recordSellerAutomationDecision({ supabase, input: { event_id: "e", conversation_id: THREAD } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "schema_missing");
  assert.equal(r.schema_missing, true);
});
