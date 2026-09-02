import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { probeDealContextAmbiguity } from "@/lib/domain/deal-context/deal-context-service.js";
import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { buildContextResolutionResult } from "@/lib/domain/context/context-resolution-result.js";
import { deriveDecisionInputFromSnapshot, buildDecisionLedgerRow } from "@/lib/domain/seller-flow/record-seller-automation-decision.js";
import { resolveExceptionWorkflowForDecision } from "@/lib/domain/seller-flow/coverage-net/exception-workflows.js";

// §6 wiring: the ambiguity probe reports a tie as a VALUE; the executor labels an
// ambiguous resolution conflicting_property (owned workflow), not missing_context;
// the ledger carries the identity provenance.

const AS_OF = "2026-09-01T12:00:00.000Z";
const THREAD = "+15550100777";

// Fake message_events supporting the two probe queries.
function makeSupabase(events) {
  return {
    from(table) {
      assert.equal(table, "message_events");
      const q = { f: [], order: null, lim: null };
      const api = {
        select: () => api,
        eq: (c, v) => { q.f.push((r) => r[c] === v); return api; },
        not: (c, op, v) => { q.f.push((r) => !(v === null ? r[c] == null : r[c] === v)); return api; },
        lte: (c, v) => { q.f.push((r) => r[c] <= v); return api; },
        gte: (c, v) => { q.f.push((r) => r[c] >= v); return api; },
        order: (c, o) => { q.order = q.order || []; q.order.push([c, o?.ascending !== false]); return api; },
        limit: (n) => { q.lim = n; return api; },
        async maybeSingle() { return { data: rows()[0] || null, error: null }; },
        then(res) { return Promise.resolve({ data: rows(), error: null }).then(res); },
      };
      function rows() {
        let out = events.filter((r) => q.f.every((f) => f(r)));
        if (q.order) out = [...out].sort((a, b) => { for (const [c, asc] of q.order) { if (a[c] === b[c]) continue; return (a[c] < b[c] ? -1 : 1) * (asc ? 1 : -1); } return 0; });
        return q.lim ? out.slice(0, q.lim) : out;
      }
      return api;
    },
  };
}

test("probe: two id-carrying events at the same top instant under DIFFERENT owners is a tie", async () => {
  const supabase = makeSupabase([
    { id: "e1", thread_key: THREAD, property_id: "prop-1", master_owner_id: "owner-1", created_at: "2026-09-01T11:00:00.000Z" },
    { id: "e2", thread_key: THREAD, property_id: "prop-2", master_owner_id: "owner-2", created_at: "2026-09-01T11:00:00.000Z" },
  ]);
  const r = await probeDealContextAmbiguity(THREAD, { supabase, asOfTimestamp: AS_OF });
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.distinct_owners.sort(), ["owner-1", "owner-2"]);
  assert.equal(r.reason, "multi_owner_tie_at_as_of_instant");
});

test("probe: a single owner at the top instant is NOT a tie; multiple properties under one owner stay deterministic", async () => {
  const supabase = makeSupabase([
    { id: "e1", thread_key: THREAD, property_id: "prop-1", master_owner_id: "owner-1", created_at: "2026-09-01T11:00:00.000Z" },
    { id: "e2", thread_key: THREAD, property_id: "prop-2", master_owner_id: "owner-1", created_at: "2026-09-01T11:00:00.000Z" },
  ]);
  const r = await probeDealContextAmbiguity(THREAD, { supabase, asOfTimestamp: AS_OF });
  assert.equal(r.ambiguous, false);
  assert.equal(r.reason, "single_owner");
});

test("probe: an event AFTER the as-of bound never participates; no as-of bound means no probe", async () => {
  const supabase = makeSupabase([
    { id: "e1", thread_key: THREAD, property_id: "prop-1", master_owner_id: "owner-1", created_at: "2026-09-01T11:00:00.000Z" },
    { id: "e9", thread_key: THREAD, property_id: "prop-9", master_owner_id: "owner-9", created_at: "2026-09-01T13:00:00.000Z" },
  ]);
  const r = await probeDealContextAmbiguity(THREAD, { supabase, asOfTimestamp: AS_OF });
  assert.equal(r.ambiguous, false);
  const none = await probeDealContextAmbiguity(THREAD, { supabase });
  assert.equal(none.ambiguous, false);
  assert.equal(none.reason, "no_as_of_bound");
});

test("probe: a failure never invents a hold", async () => {
  const broken = { from() { throw new Error("db down"); } };
  const r = await probeDealContextAmbiguity(THREAD, { supabase: broken, asOfTimestamp: AS_OF });
  assert.equal(r.ambiguous, false);
  assert.equal(r.reason, "probe_failed");
});

// ── executor labelling ──

const classification = { primary_intent: "seller_interested", detected_intent: "seller_interested", confidence: 0.9, automation_decision: { auto_reply_allowed: true } };

test("executor: an AMBIGUOUS resolution with no usable ids is conflicting_property (owned workflow), not missing_context", () => {
  const ambiguous = buildContextResolutionResult({ deal_context: { ambiguous: true, distinct_owners: ["owner-1", "owner-2"] } });
  const d = applyInboundAutomationDecision({ message: "yes", threadKey: THREAD, classification, contextResolution: ambiguous });
  assert.equal(d.should_mark_human_review, true);
  assert.equal(d.human_review_reason, "conflicting_property");
  assert.equal(resolveExceptionWorkflowForDecision({ reason: d.human_review_reason, canonical_intent: "seller_interested" }).key, "conflicting_property_identity");
  assert.equal(d.context_resolution.status, "ambiguous");
});

test("executor: no resolution at all with no usable ids stays missing_context (behaviour unchanged)", () => {
  const d = applyInboundAutomationDecision({ message: "yes", threadKey: THREAD, classification });
  assert.equal(d.human_review_reason, "missing_context");
});

// ── ledger provenance ──

test("the ledger lineage carries the identity resolution provenance", () => {
  const input = deriveDecisionInputFromSnapshot({
    source_event_id: "evt-ctx-1",
    source_thread_key: THREAD,
    canonical_intent: "seller_interested",
    canonical_decision: {},
    context_resolution: { status: "resolved", confidence: "high", winner: "explicit_ids", reason: "single_lineage", repair: null },
  });
  const row = buildDecisionLedgerRow(input);
  assert.equal(row.lineage.context_resolution.status, "resolved");
  assert.equal(row.lineage.context_resolution.winner, "explicit_ids");
});
