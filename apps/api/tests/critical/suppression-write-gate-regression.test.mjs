/**
 * Suppression WRITE-PATH proof.
 *
 * The unit tests next door prove the predicates. This file drives the real
 * `patchUniversalLeadState` against a stateful in-memory store and proves what
 * actually lands in `inbox_thread_state`:
 *
 *   1. a genuine opt-out still suppresses, with no evidence object   (non-negotiable)
 *   2. an operator suppression through the cockpit's server-built evidence works
 *   3. an unsupported suppression is refused and writes nothing
 *   4. `contactable` + `is_suppressed` can never be written together
 *   5. neither suppression nor clearing can land half-applied
 *
 * Production audit 2026-08-04: 293 binding-suppressed threads, 292 of them
 * simultaneously `contactability_status='contactable'`. The mechanism was the
 * decision contract's `contactable` floor being re-asserted on every inbound
 * turn while `is_suppressed` was only ever set, never cleared.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import {
  buildOperatorSuppressionEvidence,
  buildInboundSuppressionEvidence,
  detectSuppressionContradictions,
  resolveSuppressionWrite,
  SUPPRESSION_EVIDENCE_TYPES,
  TUPLE_INVARIANT_CONTRADICTIONS,
} from "@/lib/domain/lead-state/suppression-evidence.js";
import { buildSellerFlowDecision } from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";
import { BINDING_SUPPRESSION_REASONS } from "@/lib/domain/seller-flow/latest-intent-precedence.js";

const THREAD = "+15551230009";

// ── minimal stateful supabase double ────────────────────────────────────────

function makeStore({ initialRow = null } = {}) {
  const tables = {
    inbox_thread_state: initialRow ? [{ ...initialRow }] : [],
    universal_lead_state_events: [],
  };

  function threadStateHandle() {
    // Reads return copies: the writer holds `previous` across the upsert.
    const readRow = (key) => {
      const found = tables.inbox_thread_state.find((r) => r.thread_key === key);
      return found ? { ...found } : null;
    };
    return {
      select() {
        return {
          eq(_col, key) {
            return { maybeSingle: async () => ({ data: readRow(key), error: null }) };
          },
        };
      },
      upsert(row) {
        const existing = tables.inbox_thread_state.find((r) => r.thread_key === row.thread_key);
        let merged;
        if (existing) {
          Object.assign(existing, row);
          merged = existing;
        } else {
          merged = { ...row };
          tables.inbox_thread_state.push(merged);
        }
        return {
          select: () => ({ maybeSingle: async () => ({ data: { ...merged }, error: null }) }),
        };
      },
    };
  }

  function auditHandle() {
    return {
      insert(rows) {
        const inserted = (Array.isArray(rows) ? rows : [rows]).map((row, index) => ({
          id: `audit-${tables.universal_lead_state_events.length + index + 1}`,
          ...row,
        }));
        tables.universal_lead_state_events.push(...inserted);
        return { select: async () => ({ data: inserted.map((r) => ({ id: r.id })), error: null }) };
      },
    };
  }

  return {
    tables,
    row: () => tables.inbox_thread_state.find((r) => r.thread_key === THREAD) || null,
    from(table) {
      if (table === "inbox_thread_state") return threadStateHandle();
      if (table === "universal_lead_state_events") return auditHandle();
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const OPT_OUT_EVIDENCE = {
  type: SUPPRESSION_EVIDENCE_TYPES.EXPLICIT_OPT_OUT,
  source_event_id: "evt-stop-1",
  source_authority: "classifier",
  matched_phrase: "stop",
  rule_version: "v1",
};

// ── 1. a genuine opt-out MUST still suppress ────────────────────────────────

test("STOP writes the complete suppression tuple with no evidence object", async () => {
  const store = makeStore();
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "opted_out" },
    supabase: store,
    meta: { change_source: "autopilot", source_view: "seller_inbound_orchestrator" },
  });

  assert.equal(result.ok, true, "a real opt-out must never be blocked by the gate");
  const row = store.row();
  assert.equal(row.contactability_status, "opted_out");
  assert.equal(row.is_suppressed, true, "opt-out must persist binding suppression");
  assert.ok(row.suppressed_at, "the tuple includes when it happened");
  assert.deepEqual(detectSuppressionContradictions(row), []);
});

test("a confirmed wrong number persists invalid_number, not contactable", async () => {
  // `wrong_number` is not a canonical contactability code and normalizes to
  // contactable; invalid_number is what the resolver emits.
  const store = makeStore();
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "invalid_number" },
    supabase: store,
    meta: { change_source: "autopilot" },
  });
  assert.equal(result.ok, true);
  const row = store.row();
  assert.equal(row.contactability_status, "invalid_number");
  assert.equal(row.is_suppressed, true);
  assert.deepEqual(detectSuppressionContradictions(row), []);
});

// ── 2. operator suppression through the cockpit's server-built evidence ─────

test("the cockpit's server-built evidence authorizes a manual suppression", async () => {
  const evidence = buildOperatorSuppressionEvidence({
    actor: "cookie:ops_dashboard_session",
    reason: "seller called the office and asked us to stop",
    source_authority: "cockpit_lead_state_patch",
  });
  assert.ok(evidence, "the route must be able to build evidence server-side");
  assert.equal(evidence.type, SUPPRESSION_EVIDENCE_TYPES.MANUAL_OPERATOR);
  assert.equal(evidence.actor, "cookie:ops_dashboard_session");

  const store = makeStore();
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "do_not_text" },
    supabase: store,
    meta: {
      change_source: "manual",
      operator_id: "cookie:ops_dashboard_session",
      suppression_evidence: evidence,
    },
  });

  assert.equal(result.ok, true);
  const row = store.row();
  assert.equal(row.contactability_status, "do_not_text");
  assert.equal(row.is_suppressed, true);
  assert.ok(row.suppressed_at);
  assert.deepEqual(detectSuppressionContradictions(row), []);
});

test("evidence cannot be minted without a server-verified actor", () => {
  for (const actor of [null, "", "   ", undefined]) {
    assert.equal(
      buildOperatorSuppressionEvidence({ actor, reason: "because I said so" }),
      null,
      "no actor means no evidence, so the gate rejects"
    );
  }
});

test("the inbound builder keys off intent, never off the requested value", () => {
  // The incident shape: a stage transition asking for do_not_text.
  for (const intent of [
    "condition_disclosed",
    "ownership_confirmed",
    "asking_price_provided",
    "unclear",
    null,
  ]) {
    assert.equal(
      buildInboundSuppressionEvidence({ intent, source_event_id: "evt-1" }),
      null,
      `${intent} is not evidence of a do-not-contact instruction`
    );
  }
  // The durable set, each carrying the inbound that produced it.
  const durable = {
    opt_out: SUPPRESSION_EVIDENCE_TYPES.EXPLICIT_OPT_OUT,
    wrong_number: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_NUMBER,
    hostile_or_legal: SUPPRESSION_EVIDENCE_TYPES.LEGAL_PROHIBITION,
    wrong_person: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_PARTY,
    property_specific_non_owner: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_PARTY,
    former_owner_respondent: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_PARTY,
  };
  for (const [intent, type] of Object.entries(durable)) {
    const evidence = buildInboundSuppressionEvidence({ intent, source_event_id: "evt-1" });
    assert.ok(evidence, intent);
    assert.equal(evidence.type, type, intent);
    assert.equal(evidence.source_event_id, "evt-1");
    // …and without the citation it is not evidence at all.
    assert.equal(buildInboundSuppressionEvidence({ intent, source_event_id: null }), null, intent);
  }
});

test("the inbound path can now persist a do_not_text suppression", async () => {
  const store = makeStore();
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "do_not_text", operational_status: "needs_review" },
    supabase: store,
    meta: {
      change_source: "autopilot",
      reason: "HOLD_HOSTILE_LEGAL_REVIEW",
      suppression_evidence: buildInboundSuppressionEvidence({
        intent: "hostile_or_legal",
        source_event_id: "evt-hostile-1",
      }),
    },
  });
  assert.equal(result.ok, true, "a genuine legal prohibition must persist");
  const row = store.row();
  assert.equal(row.contactability_status, "do_not_text");
  assert.equal(row.is_suppressed, true);
  assert.deepEqual(detectSuppressionContradictions(row), []);
});

// ── 3. unsupported suppression is refused and writes nothing ────────────────

test("a stage transition cannot suppress and leaves no row behind", async () => {
  const store = makeStore();
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "do_not_text" },
    supabase: store,
    meta: { change_source: "autopilot", reason: "S1_TO_S4_CONDITION_DISCLOSED" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_suppression_rejected");
  assert.equal(result.rejected_reason, "missing_suppression_evidence");
  assert.equal(store.row(), null, "nothing may be written at all");
});

test("an unsupported suppression riding along with a lifecycle write loses only the suppression", async () => {
  const store = makeStore();
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "do_not_text", lifecycle_stage: "property_condition" },
    supabase: store,
    meta: { change_source: "autopilot", reason: "S1_TO_S4_CONDITION_DISCLOSED" },
  });

  assert.equal(result.ok, true);
  const row = store.row();
  assert.equal(row.lifecycle_stage, "property_condition", "the honest half of the patch applies");
  assert.notEqual(row.contactability_status, "do_not_text");
  assert.notEqual(row.is_suppressed, true, "no evidence-free suppression");
  assert.deepEqual(detectSuppressionContradictions(row), []);
});

test("dnc no longer suppresses through the unguarded door", async () => {
  // buildRowPatch escalates every registry-blocking contactability to
  // is_suppressed=true, but dnc was missing from the gate's value list.
  const store = makeStore();
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "dnc" },
    supabase: store,
    meta: { change_source: "autopilot", reason: "S1_TO_S2_OWNERSHIP_CONFIRMED" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_suppression_rejected");
  assert.equal(store.row(), null, "dnc must not write is_suppressed=true with no evidence");
});

// ── 4/5. contactable + suppressed can never be written together ─────────────

const SUPPRESSED_ROW = {
  thread_key: THREAD,
  contactability_status: "opted_out",
  is_suppressed: true,
  suppressed_at: "2026-06-01T15:00:00.000Z",
  lifecycle_stage: "ownership_confirmation",
};

test("an automated turn cannot reset a binding-suppressed thread to contactable", async () => {
  // THE production mechanism: the decision contract asserts a `contactable`
  // floor on every non-suppressing turn, including turns on a suppressed
  // thread. 292 rows carry the result.
  const store = makeStore({ initialRow: SUPPRESSED_ROW });
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "contactable", lead_temperature: "warm" },
    supabase: store,
    meta: { change_source: "autopilot", source_view: "seller_inbound_orchestrator" },
  });

  assert.equal(result.ok, true, "the rest of the turn still persists");
  assert.ok(
    result.suppression_guards.includes("suppression_clear_requires_operator_authority"),
    `expected an authority guard, got ${JSON.stringify(result.suppression_guards)}`
  );
  const row = store.row();
  assert.equal(row.contactability_status, "opted_out", "the suppression survives the turn");
  assert.equal(row.is_suppressed, true);
  assert.equal(row.lead_temperature, "warm", "non-binding fields still apply");
  assert.deepEqual(
    detectSuppressionContradictions(row),
    [],
    "contactable + suppressed must be unwritable"
  );
});

test("an operator clears the whole tuple or none of it", async () => {
  const store = makeStore({ initialRow: SUPPRESSED_ROW });
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "contactable" },
    supabase: store,
    meta: {
      change_source: "manual",
      operator_id: "cookie:ops_dashboard_session",
      reason: "seller called back and asked to be re-engaged",
    },
  });

  assert.equal(result.ok, true);
  const row = store.row();
  assert.equal(row.contactability_status, "contactable");
  assert.equal(row.is_suppressed, false, "clearing must clear the whole tuple");
  assert.equal(row.suppressed_at, null);
  assert.deepEqual(detectSuppressionContradictions(row), []);
});

test("a clear that cannot be completed is refused rather than half-applied", () => {
  // A legacy row also carries disposition='suppressed'. Writing contactable
  // without also clearing the disposition would leave the row binding AND
  // contactable — the exact 291-row shape.
  const outcome = resolveSuppressionWrite({
    previous: { ...SUPPRESSED_ROW, disposition: "suppressed" },
    patch: { contactability_status: "contactable" },
    change_source: "manual",
    operator: "operator:ryan",
  });
  assert.equal(outcome.action, "hold");
  assert.ok(outcome.guards.includes("partial_suppression_clear_blocked"));
  assert.deepEqual(outcome.strip, ["contactability_status"]);
});

test("valid evidence and full operator authority still cannot buy a contradictory row", async () => {
  // The evidence gate only ever fired on MISSING evidence, so valid evidence
  // used to be a licence to write anything. Here an operator with evidence AND
  // a clearance token asks for `contactable` on a row that would remain binding
  // (inbox_bucket=suppressed). The write must not land.
  const store = makeStore({
    initialRow: { thread_key: THREAD, inbox_bucket: "suppressed", is_suppressed: false },
  });
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { contactability_status: "contactable" },
    supabase: store,
    meta: {
      change_source: "manual",
      operator_id: "operator:ryan",
      suppression_evidence: OPT_OUT_EVIDENCE,
      suppression_clearance: { type: "operator_release", actor: "operator:ryan" },
    },
  });

  assert.equal(result.blocked, true, "an incompletable clear must not be written");
  assert.equal(result.reason, "partial_suppression_clear_blocked");
  assert.equal(
    store.row().contactability_status,
    undefined,
    "no contactability may be written at all"
  );
  assert.deepEqual(detectSuppressionContradictions(store.row()), []);
});

test("the merged-row invariant is evaluated on previous + patch, and names both tuple faults", () => {
  // The detector is now wired into the write path (it was exported, unit-tested
  // and never called). These are the two shapes it refuses there — asserted
  // directly, because tuple resolution makes them unreachable by construction.
  assert.deepEqual(TUPLE_INVARIANT_CONTRADICTIONS, [
    "contactable_while_binding_suppressed",
    "blocking_contactability_without_suppression",
  ]);
  // A patch that only sets is_suppressed against an existing contactable row is
  // the exact production failure — invisible to a patch-only check.
  const previous = { thread_key: THREAD, contactability_status: "contactable" };
  const patchOnly = { is_suppressed: true };
  assert.deepEqual(detectSuppressionContradictions(patchOnly), []);
  assert.ok(
    detectSuppressionContradictions({ ...previous, ...patchOnly }).includes(
      "contactable_while_binding_suppressed"
    ),
    "only the merged row exposes it"
  );
});

test("a fully-stripped patch never creates a row, with or without updated_by", async () => {
  // Both refusal paths must agree on what counts as substance. `updated_by` is
  // bookkeeping: if a guard strips everything else, upserting what remains would
  // mint {thread_key, updated_at, updated_by} on a thread that had no row — a
  // mystery row born from a REJECTED suppression write. The two filters had
  // diverged on exactly this field.
  for (const meta of [
    { change_source: "autopilot" },
    { change_source: "autopilot", updated_by: "automation_engine" },
    { change_source: "autopilot", updated_by: "automation_engine", operator_id: null },
  ]) {
    const store = makeStore({ initialRow: SUPPRESSED_ROW });
    const result = await patchUniversalLeadState({
      threadKey: THREAD,
      patch: { contactability_status: "contactable" },
      supabase: store,
      meta,
    });
    assert.equal(result.blocked, true, JSON.stringify(meta));
    assert.equal(
      result.reason,
      "suppression_clear_requires_operator_authority",
      "the refusal must name the real cause, not a generic no-op"
    );
    // The pre-existing row is untouched…
    assert.equal(store.row().contactability_status, "opted_out");
    assert.equal(store.row().is_suppressed, true);
    assert.equal(store.row().updated_by, undefined, "a refused write leaves no trace");
  }

  // …and on a thread with NO row, nothing is created at all.
  for (const meta of [
    { change_source: "autopilot" },
    { change_source: "autopilot", updated_by: "automation_engine" },
  ]) {
    const store = makeStore();
    const result = await patchUniversalLeadState({
      threadKey: THREAD,
      patch: { contactability_status: "do_not_text" },
      supabase: store,
      meta: { ...meta, reason: "S1_TO_S4_CONDITION_DISCLOSED" },
    });
    assert.equal(result.ok, false);
    assert.equal(store.row(), null, `no empty row may be minted (${JSON.stringify(meta)})`);
    assert.equal(store.tables.inbox_thread_state.length, 0);
  }
});

test("an unrelated write to an already-contradictory legacy row is not blocked or repaired", async () => {
  // 292 production rows are already contradictory. The gate must not make every
  // unrelated write to them fail, and must not silently rewrite them either.
  const legacy = {
    thread_key: THREAD,
    is_suppressed: true,
    contactability_status: "contactable",
    lifecycle_stage: "ownership_confirmation",
  };
  const store = makeStore({ initialRow: legacy });
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { lead_temperature: "hot" },
    supabase: store,
    meta: { change_source: "autopilot" },
  });

  assert.equal(result.ok, true);
  const row = store.row();
  assert.equal(row.lead_temperature, "hot");
  assert.equal(row.is_suppressed, true, "legacy state is left exactly as found");
  assert.equal(row.contactability_status, "contactable", "no production-shaped repair");
});

// ── one canonical binding-reason set ────────────────────────────────────────

test("every canonical binding reason produces a blocking contactability", () => {
  const expected = {
    opt_out: "opted_out",
    stop: "opted_out",
    unsubscribe: "opted_out",
    wrong_number: "invalid_number",
  };
  for (const reason of BINDING_SUPPRESSION_REASONS) {
    const decision = buildSellerFlowDecision({
      automation_decision: { should_suppress_contact: true, suppression_reason: reason },
    });
    assert.equal(
      decision.contactability,
      expected[reason] || "do_not_text",
      `binding reason ${reason} must establish a blocking contactability`
    );
  }
});

test("a non-binding reason asserts no contactability at all", () => {
  for (const reason of ["condition_disclosed", "low_confidence", "not_interested", "suppressed"]) {
    const decision = buildSellerFlowDecision({
      automation_decision: { should_suppress_contact: true, suppression_reason: reason },
    });
    assert.equal(decision.contactability, null, `${reason} must assert nothing`);
  }
});

test("the contactable floor is preserved for ordinary turns", () => {
  const decision = buildSellerFlowDecision({
    automation_decision: { should_queue_reply: true },
    contract: { normalized_intent: "seller_interested" },
  });
  assert.equal(decision.contactability, "contactable");
});
