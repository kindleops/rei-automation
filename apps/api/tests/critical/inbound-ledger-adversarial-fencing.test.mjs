// ─── inbound-ledger-adversarial-fencing.test.mjs ─────────────────────────────
// Certification (closure pass, 2026-08-26): adversarial worker-race coverage
// for the AUTHORITATIVE inbound idempotency contract —
// claim_inbound_processing / complete_inbound_processing on
// inbound_processing_ledger (migration 20260802090000).
//
// Required invariant (Phase 3): a crashed, delayed, duplicate, or stale
// worker must NEVER corrupt the authoritative state of a successful newer
// processing attempt.
//
// The stub below is a statement-faithful in-memory mirror of the two RPCs
// (same outcomes, same fences, same counters); the same scenarios are also
// exercised against the REAL SQL functions during the Supabase branch
// rehearsal (see the certification runbook), so this file certifies the JS
// wrapper behavior and documents the contract deterministically.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  claimInboundProcessing,
  completeInboundProcessingClaim,
} from "@/lib/domain/inbound/inbound-processing-ledger.js";

// ── statement-faithful in-memory mirror of the SQL contract ────────────────
function makeLedgerRpcStub({ now = () => Date.now() } = {}) {
  const rows = new Map(); // idempotency_key → row
  function claim(params) {
    const key = String(params.p_idempotency_key ?? "").trim();
    if (!key) return { ok: false, outcome: "invalid_claim", reason: "idempotency_key_required" };
    const lease_seconds = Math.min(Math.max(params.p_lease_seconds ?? 600, 30), 3600);
    const max_attempts = Math.min(Math.max(params.p_max_attempts ?? 5, 1), 20);
    const run_id = params.p_processing_run_id || crypto.randomUUID();
    const t = now();
    const row = rows.get(key);
    if (!row) {
      const fresh = {
        id: crypto.randomUUID(), idempotency_key: key, status: "processing",
        attempt_count: 1, processing_run_id: run_id,
        lease_expires_at: t + lease_seconds * 1000,
        terminal_disposition: null, error_message: null,
        completed_at: null, duplicate_delivery_count: 0,
      };
      rows.set(key, fresh);
      return { ok: true, outcome: "claimed_new", ledger_id: fresh.id, processing_run_id: run_id, attempt_count: 1 };
    }
    if (row.status === "completed") {
      row.duplicate_delivery_count += 1;
      return {
        ok: true, outcome: "duplicate_completed", ledger_id: row.id,
        prior_disposition: row.terminal_disposition,
        prior_processing_run_id: row.processing_run_id,
        duplicate_delivery_count: row.duplicate_delivery_count,
      };
    }
    if (row.status === "failed" && row.terminal_disposition === "failed_terminal") {
      row.duplicate_delivery_count += 1;
      return { ok: true, outcome: "terminally_failed", ledger_id: row.id, prior_disposition: "failed_terminal" };
    }
    if (row.status === "processing" && row.lease_expires_at != null && row.lease_expires_at > t) {
      return {
        ok: true, outcome: "already_processing", ledger_id: row.id,
        holder_processing_run_id: row.processing_run_id,
        attempt_count: row.attempt_count,
      };
    }
    if (row.attempt_count >= max_attempts) {
      row.status = "failed";
      row.terminal_disposition = "failed_terminal";
      row.error_message = row.error_message || "attempts_exhausted";
      row.completed_at = t;
      row.lease_expires_at = null;
      return { ok: true, outcome: "terminally_failed", ledger_id: row.id, reason: "attempts_exhausted", prior_disposition: "failed_terminal" };
    }
    row.status = "processing";
    row.attempt_count += 1;
    row.processing_run_id = run_id;
    row.lease_expires_at = t + lease_seconds * 1000;
    row.terminal_disposition = null;
    row.error_message = null;
    row.completed_at = null;
    return { ok: true, outcome: "retry_claimed", ledger_id: row.id, processing_run_id: run_id, attempt_count: row.attempt_count };
  }
  const TERMINALS = new Set([
    "reply_sent", "reply_deferred_compliance", "suppressed_opt_out",
    "suppressed_wrong_number", "suppressed_policy", "human_review_required",
    "duplicate_ignored", "no_reply_required", "failed_retriable", "failed_terminal",
  ]);
  function complete(params) {
    const key = String(params.p_idempotency_key ?? "").trim();
    if (!key) return { ok: false, reason: "idempotency_key_required" };
    if (!params.p_processing_run_id) return { ok: false, reason: "processing_run_id_required" };
    if (!TERMINALS.has(params.p_disposition)) {
      return { ok: false, reason: "invalid_terminal_disposition", disposition: params.p_disposition };
    }
    const row = rows.get(key);
    const target_status = ["failed_retriable", "failed_terminal"].includes(params.p_disposition)
      ? "failed" : "completed";
    // Run-id fence: only the current claim holder, and only while processing.
    if (row && row.status === "processing" && row.processing_run_id === params.p_processing_run_id) {
      row.status = target_status;
      row.terminal_disposition = params.p_disposition;
      row.error_message = params.p_error_message ?? null;
      row.completed_at = now();
      row.lease_expires_at = null;
      return { ok: true, disposition: params.p_disposition, status: target_status };
    }
    if (!row) return { ok: false, reason: "ledger_row_missing" };
    return {
      ok: false, reason: "claim_fenced",
      current_status: row.status,
      current_disposition: row.terminal_disposition,
      current_processing_run_id: row.processing_run_id,
    };
  }
  return {
    rows,
    supabase: {
      rpc: async (fn, params) => {
        if (fn === "claim_inbound_processing") return { data: claim(params), error: null };
        if (fn === "complete_inbound_processing") return { data: complete(params), error: null };
        return { data: null, error: new Error(`unexpected rpc ${fn}`) };
      },
    },
    expireLease(key) {
      const row = rows.get(key);
      if (row) row.lease_expires_at = now() - 1;
    },
  };
}

const KEY = "textgrid_inbound:SM_adversarial_001";
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

test("duplicate webhook while lease is live backs off (already_processing, no second execution)", async () => {
  const stub = makeLedgerRpcStub();
  const first = await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_A }, { supabase: stub.supabase });
  assert.equal(first.outcome, "claimed_new");
  const second = await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_B }, { supabase: stub.supabase });
  assert.equal(second.outcome, "already_processing");
  assert.equal(second.holder_processing_run_id, RUN_A, "holder identity is surfaced for audit");
  assert.equal(stub.rows.get(KEY).attempt_count, 1, "losing claim must not consume an attempt");
});

test("STALE WORKER CANNOT CORRUPT A NEWER RESULT: lease expiry → reclaim → newer completes → stale completion fenced", async () => {
  const stub = makeLedgerRpcStub();
  await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_A }, { supabase: stub.supabase });
  stub.expireLease(KEY); // worker A stalls past its lease
  const reclaim = await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_B }, { supabase: stub.supabase });
  assert.equal(reclaim.outcome, "retry_claimed");
  assert.equal(reclaim.attempt_count, 2);

  // Recovery (run B) finishes FIRST with the authoritative outcome.
  const newer = await completeInboundProcessingClaim(
    { idempotency_key: KEY, processing_run_id: RUN_B, disposition: "reply_sent" },
    { supabase: stub.supabase }
  );
  assert.equal(newer.ok, true);

  // The original stalled worker resumes and attempts BOTH completion shapes.
  const staleComplete = await completeInboundProcessingClaim(
    { idempotency_key: KEY, processing_run_id: RUN_A, disposition: "no_reply_required" },
    { supabase: stub.supabase }
  );
  assert.equal(staleComplete.ok, false);
  assert.equal(staleComplete.reason, "claim_fenced");
  const staleFail = await completeInboundProcessingClaim(
    { idempotency_key: KEY, processing_run_id: RUN_A, disposition: "failed_retriable" },
    { supabase: stub.supabase }
  );
  assert.equal(staleFail.ok, false, "a stale worker may not mark the newer success failed");
  assert.equal(staleFail.reason, "claim_fenced");

  const row = stub.rows.get(KEY);
  assert.equal(row.status, "completed");
  assert.equal(row.terminal_disposition, "reply_sent", "authoritative result survives every stale write");
});

test("stale worker racing the OTHER way: stale finishes before recovery — recovery observes the fence too", async () => {
  const stub = makeLedgerRpcStub();
  await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_A }, { supabase: stub.supabase });
  stub.expireLease(KEY);
  await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_B }, { supabase: stub.supabase });
  // A (stale) tries to complete after B reclaimed but before B finished:
  const stale = await completeInboundProcessingClaim(
    { idempotency_key: KEY, processing_run_id: RUN_A, disposition: "reply_sent" },
    { supabase: stub.supabase }
  );
  assert.equal(stale.ok, false, "reclaim rotated the run id — the stale holder is already fenced");
  // B completes normally.
  const winner = await completeInboundProcessingClaim(
    { idempotency_key: KEY, processing_run_id: RUN_B, disposition: "human_review_required" },
    { supabase: stub.supabase }
  );
  assert.equal(winner.ok, true);
  assert.equal(stub.rows.get(KEY).terminal_disposition, "human_review_required");
});

test("duplicate webhook AFTER completion is counted, never re-executed and never a silent drop", async () => {
  const stub = makeLedgerRpcStub();
  await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_A }, { supabase: stub.supabase });
  await completeInboundProcessingClaim(
    { idempotency_key: KEY, processing_run_id: RUN_A, disposition: "reply_sent" },
    { supabase: stub.supabase }
  );
  for (let i = 1; i <= 3; i++) {
    const dup = await claimInboundProcessing({ idempotency_key: KEY }, { supabase: stub.supabase });
    assert.equal(dup.outcome, "duplicate_completed");
    assert.equal(dup.prior_disposition, "reply_sent");
    assert.equal(stub.rows.get(KEY).duplicate_delivery_count, i, "every duplicate is durably counted");
  }
});

test("retriable failure is reclaimable with a fresh run id; disposition state is reset for the new attempt", async () => {
  const stub = makeLedgerRpcStub();
  await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_A }, { supabase: stub.supabase });
  const failed = await completeInboundProcessingClaim(
    { idempotency_key: KEY, processing_run_id: RUN_A, disposition: "failed_retriable", error_message: "boom" },
    { supabase: stub.supabase }
  );
  assert.equal(failed.ok, true);
  assert.equal(stub.rows.get(KEY).status, "failed");

  const retry = await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_B }, { supabase: stub.supabase });
  assert.equal(retry.outcome, "retry_claimed");
  const row = stub.rows.get(KEY);
  assert.equal(row.processing_run_id, RUN_B);
  assert.equal(row.terminal_disposition, null, "reclaim clears the failed disposition for the new attempt");
  assert.equal(row.error_message, null);
});

test("attempt exhaustion flips terminal instead of looping forever", async () => {
  const stub = makeLedgerRpcStub();
  // Consume all 5 attempts: claim, expire, reclaim…
  await claimInboundProcessing({ idempotency_key: KEY }, { supabase: stub.supabase });
  for (let i = 0; i < 4; i++) {
    stub.expireLease(KEY);
    const c = await claimInboundProcessing({ idempotency_key: KEY }, { supabase: stub.supabase });
    assert.equal(c.outcome, "retry_claimed");
  }
  stub.expireLease(KEY);
  const exhausted = await claimInboundProcessing({ idempotency_key: KEY }, { supabase: stub.supabase });
  assert.equal(exhausted.outcome, "terminally_failed");
  assert.equal(exhausted.reason, "attempts_exhausted");
  assert.equal(stub.rows.get(KEY).terminal_disposition, "failed_terminal");
  // And later duplicates keep reporting the terminal failure durably.
  const dup = await claimInboundProcessing({ idempotency_key: KEY }, { supabase: stub.supabase });
  assert.equal(dup.outcome, "terminally_failed");
});

test("pending burst disposition can never be written as terminal (JS gate rejects before the RPC)", async () => {
  const stub = makeLedgerRpcStub();
  await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_A }, { supabase: stub.supabase });
  const rejected = await completeInboundProcessingClaim(
    { idempotency_key: KEY, processing_run_id: RUN_A, disposition: "reply_deferred_burst" },
    { supabase: stub.supabase }
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "invalid_terminal_disposition");
  assert.equal(stub.rows.get(KEY).status, "processing", "row untouched by the rejected write");
});

test("completion without a run id is refused (no unfenced writes exist)", async () => {
  const stub = makeLedgerRpcStub();
  await claimInboundProcessing({ idempotency_key: KEY, processing_run_id: RUN_A }, { supabase: stub.supabase });
  const missing = await completeInboundProcessingClaim(
    { idempotency_key: KEY, disposition: "reply_sent" },
    { supabase: stub.supabase }
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "processing_run_id_required");
});
