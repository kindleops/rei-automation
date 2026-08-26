// ─── certification-guardrails-wave2.test.mjs ─────────────────────────────────
// Certification regression, wave 2 (backend certification pass, 2026-08-25):
//
//   * M11 — manual_temperature_lock was WRITE-ONLY: automated scoring
//     silently overwrote operator-set temperatures. Now guarded exactly like
//     manual_stage_lock (operators and resume_automatic_scoring still pass).
//   * D9  — a provider send that returned no SID was retried in 5 minutes,
//     risking a DUPLICATE seller SMS when the provider had actually accepted
//     the message. Now a terminal manual-review disposition.
//   * M3  — the chronology reconciler minted is_suppressed from the
//     PRESENTATION bucket, bypassing the evidence gate (the 2026-08-04
//     audit's 114 evidence-free suppressions). Now only real opt-out
//     evidence or an explicit override sets it.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { classifyTextGridProviderError } from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";
import { patchToInboxThreadState } from "@/lib/domain/inbox/classify-thread-from-chronology.js";

const THREAD = "+15551230042";

function makeStore({ initialRow = null } = {}) {
  const tables = {
    inbox_thread_state: initialRow ? [{ ...initialRow }] : [],
    universal_lead_state_events: [],
  };
  function threadStateHandle() {
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

// ── M11: manual temperature lock ────────────────────────────────────────────

test("automated temperature writes are blocked by manual_temperature_lock", async () => {
  const store = makeStore({
    initialRow: { thread_key: THREAD, lead_temperature: "hot", manual_temperature_lock: true },
  });
  const result = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { lead_temperature: "cold" },
    supabase: store,
    meta: { change_source: "autopilot", source_view: "seller_inbound_orchestrator" },
  });
  assert.ok(
    (result.stage_guards || []).includes("manual_temperature_lock_blocked_temperature_write"),
    JSON.stringify(result.stage_guards)
  );
  assert.equal(store.row().lead_temperature, "hot", "operator temperature must survive automation");
});

test("operator temperature writes pass the lock, and the release restores automation", async () => {
  const store = makeStore({
    initialRow: { thread_key: THREAD, lead_temperature: "hot", manual_temperature_lock: true },
  });
  const manual = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { lead_temperature: "warm" },
    supabase: store,
    meta: { change_source: "manual", source_view: "cockpit" },
  });
  assert.equal(manual.ok, true);
  assert.equal(store.row().lead_temperature, "warm");

  const released = await patchUniversalLeadState({
    threadKey: THREAD,
    patch: { lead_temperature: "cold" },
    supabase: store,
    meta: {
      change_source: "autopilot",
      source_view: "seller_inbound_orchestrator",
      resume_automatic_scoring: true,
    },
  });
  assert.equal(released.ok, true);
  assert.equal(store.row().lead_temperature, "cold");
  assert.equal(store.row().manual_temperature_lock, false, "release clears the lock");
});

// ── D9: ambiguous no-SID send is terminal, never a retry ────────────────────

test("a no-SID provider response classifies terminal manual-review, not retryable", () => {
  const marked = new Error("SEND FAILED - NO SID");
  marked.no_sid_ambiguous_send = true;
  for (const err of [marked, new Error("SEND FAILED - NO SID")]) {
    const classified = classifyTextGridProviderError(err);
    assert.equal(classified.retryable, false, err.message);
    assert.equal(classified.is_terminal, true);
    assert.equal(classified.non_retryable_reason, "provider_response_missing_sid_manual_review");
    assert.equal(classified.failure_class, "provider_ambiguous_accept");
  }
});

test("transient provider failures remain retryable (no over-reach)", () => {
  const transient = new Error("connect ETIMEDOUT");
  const classified = classifyTextGridProviderError(transient);
  assert.notEqual(classified.non_retryable_reason, "provider_response_missing_sid_manual_review");
  assert.equal(classified.is_terminal, false);
});

// ── M3: is_suppressed requires evidence, never the presentation bucket ──────

test("a suppressed inbox bucket alone never mints is_suppressed", () => {
  const row = patchToInboxThreadState(
    { inbox_bucket: "suppressed", opt_out: false },
    { thread_key: THREAD }
  );
  assert.ok(!row.is_suppressed, JSON.stringify({ is_suppressed: row.is_suppressed }));
  assert.equal(row.inbox_bucket, "suppressed", "presentation bucket still displays");
});

test("real opt-out evidence and explicit overrides still set is_suppressed", () => {
  const fromOptOut = patchToInboxThreadState(
    { inbox_bucket: "suppressed", opt_out: true },
    { thread_key: THREAD }
  );
  assert.equal(fromOptOut.is_suppressed, true);

  const fromOverride = patchToInboxThreadState(
    { inbox_bucket: "new_replies" },
    { thread_key: THREAD, is_suppressed: true }
  );
  assert.equal(fromOverride.is_suppressed, true);
});
