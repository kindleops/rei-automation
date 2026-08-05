/**
 * Pending burst-ledger representation + constituent finalization.
 *
 * `reply_deferred_burst` is illegal in BOTH ledger CHECK constraints
 * (status IN processing|completed|failed; terminal_disposition IN the ten
 * terminal values) and complete_inbound_processing rejects it outright. So an
 * inbound handed to the burst layer stays status='processing' and carries its
 * pendency in disposition_detail (unconstrained jsonb) — no migration.
 *
 * The trap that made this necessary: passing the pending value through the
 * terminal writer fails the write, which then raises a FALSE
 * inbound_no_disposition P0 and leaves the row processing anyway.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  AWAITING_BURST_DETAIL_KEY,
  markInboundAwaitingBurst,
  findInboundLedgerSlaBreaches,
} from "@/lib/domain/inbound/inbound-processing-ledger.js";
import {
  finalizeBurstConstituentLedger,
  resolveBurstConstituentDisposition,
} from "@/lib/domain/seller-flow/finalize-burst-constituent-ledger.js";
import { TERMINAL_DISPOSITIONS } from "@/lib/domain/inbound/terminal-disposition.js";

const THREAD = "+15550100077";
const BURST_ID = "sib:+15550100077:g1:abc";

function ledgerSupabase(rows, { updateError = null, selectError = null } = {}) {
  const state = { updates: [], rows: rows.map((r) => ({ ...r })) };
  return {
    state,
    client: {
      from() {
        const filters = {};
        const node = {
          // select() begins a read chain; eq() accumulates filters.
          select: () => node,
          eq: (k, v) => { filters[k] = v; return node; },
          lt: () => node,
          or: () => node,
          order: () => node,
          limit: async () => resolveRead(),
          update: (patch) => { state.updates.push(patch); return writeNode(); },
          then: (resolve) => resolve(resolveRead()),
        };
        function resolveRead() {
          if (selectError) return { data: null, error: selectError };
          const matched = state.rows.filter((row) =>
            Object.entries(filters).every(([k, v]) => row[k] === v)
          );
          return { data: matched, error: null };
        }
        function writeNode() {
          const w = {
            eq: () => w,
            then: (resolve) => resolve({ data: null, error: updateError }),
          };
          return w;
        }
        return node;
      },
    },
  };
}

// ── pending representation ──────────────────────────────────────────────────

test("burst pendency is recorded without terminalizing the row", async () => {
  const { client, state } = ledgerSupabase([]);
  const outcome = await markInboundAwaitingBurst(
    { idempotency_key: "textgrid_inbound:SM1", burst_id: BURST_ID, detail: { burst_id: BURST_ID }, processing_run_id: "run-1" },
    { supabase: client }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.awaiting_burst, true);

  const patch = state.updates[0];
  assert.ok(patch, "an update must have been issued");
  assert.equal(patch.disposition_detail[AWAITING_BURST_DETAIL_KEY], true);
  assert.equal(patch.disposition_detail.burst_id, BURST_ID);
  // Critically: it does NOT set status or terminal_disposition.
  assert.equal("status" in patch, false, "pendency must not change status");
  assert.equal("terminal_disposition" in patch, false, "pendency is not a terminal disposition");
});

test("the seller's message body is never written to the ledger", async () => {
  const { client, state } = ledgerSupabase([]);
  await markInboundAwaitingBurst(
    {
      idempotency_key: "textgrid_inbound:SM2",
      burst_id: BURST_ID,
      detail: { burst_id: BURST_ID, message_body: "Yeah", raw_text: "Yeah", body_sha256: "x" },
      processing_run_id: "run-2",
    },
    { supabase: client }
  );
  const serialized = JSON.stringify(state.updates[0]);
  assert.equal(serialized.includes("Yeah"), false, "no raw body may reach the ledger");
  assert.equal(serialized.includes("message_body"), false);
  assert.equal(serialized.includes("raw_text"), false);
});

// ── the SLO scanner understands the difference ──────────────────────────────

test("an awaiting-burst row is not counted as a stuck inbound", async () => {
  const rows = [
    {
      id: "r1", idempotency_key: "k1", thread_key: THREAD, status: "processing",
      received_at: "2026-08-03T22:40:31.039Z", attempt_count: 1,
      disposition_detail: { [AWAITING_BURST_DETAIL_KEY]: true, burst_id: BURST_ID },
    },
    {
      id: "r2", idempotency_key: "k2", thread_key: THREAD, status: "processing",
      received_at: "2026-08-03T22:40:31.039Z", attempt_count: 1,
      disposition_detail: {},
    },
  ];
  const { client } = ledgerSupabase(rows);
  const scan = await findInboundLedgerSlaBreaches(
    { sla_minutes: 10 },
    { supabase: client, now: "2026-08-04T00:40:00.000Z" }
  );
  assert.equal(scan.ok, true);
  assert.equal(scan.awaiting_burst_count, 1, "the parked row is reported separately");
  assert.equal(scan.stuck_processing.length, 1, "only the genuinely stuck row counts");
  assert.equal(scan.stuck_processing[0].idempotency_key, "k2");
  assert.equal(scan.breach_count, 1, "a deliberate wait must not page as a silent drop");
});

// ── constituent finalization ────────────────────────────────────────────────

test("burst completion finalizes every pending constituent row", async () => {
  const rows = [
    { id: "r1", idempotency_key: "k1", processing_run_id: "run1", status: "processing", thread_key: THREAD,
      disposition_detail: { [AWAITING_BURST_DETAIL_KEY]: true, burst_id: BURST_ID } },
    { id: "r2", idempotency_key: "k2", processing_run_id: "run2", status: "processing", thread_key: THREAD,
      disposition_detail: { [AWAITING_BURST_DETAIL_KEY]: true, burst_id: BURST_ID } },
  ];
  const { client } = ledgerSupabase(rows);
  const completed = [];
  const outcome = await finalizeBurstConstituentLedger({
    supabase: client,
    burst: { burst_id: BURST_ID, thread_key: THREAD, status: "completed", constituent_event_ids: ["e1", "e2"] },
    result: { ok: true, queued: true, queue_row_id: "q1" },
    completeClaim: async (args) => { completed.push(args); return { ok: true }; },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.finalized, 2, "no constituent may be left awaiting");
  assert.equal(outcome.pending, 0);
  assert.equal(outcome.disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
  assert.equal(completed.length, 2);
  // Cross-references are recorded; the body is not.
  assert.equal(completed[0].detail.burst_id, BURST_ID);
  assert.equal(completed[0].detail.queue_row_id, "q1");
  assert.equal(JSON.stringify(completed).includes("message_body"), false);
});

test("a repeated worker invocation is a no-op, not a conflicting disposition", async () => {
  // After finalization the rows are no longer status='processing', so the
  // lookup returns nothing.
  const { client } = ledgerSupabase([]);
  const completed = [];
  const outcome = await finalizeBurstConstituentLedger({
    supabase: client,
    burst: { burst_id: BURST_ID, thread_key: THREAD, status: "completed" },
    result: { ok: true, queued: true },
    completeClaim: async (a) => { completed.push(a); return { ok: true }; },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.finalized, 0);
  assert.deepEqual(completed, [], "nothing may be re-finalized");
});

test("partial finalization alerts and leaves the remainder retryable", async () => {
  const rows = [
    { id: "r1", idempotency_key: "k1", processing_run_id: "run1", status: "processing", thread_key: THREAD,
      disposition_detail: { [AWAITING_BURST_DETAIL_KEY]: true, burst_id: BURST_ID } },
    { id: "r2", idempotency_key: "k2", processing_run_id: "run2", status: "processing", thread_key: THREAD,
      disposition_detail: { [AWAITING_BURST_DETAIL_KEY]: true, burst_id: BURST_ID } },
  ];
  const { client } = ledgerSupabase(rows);
  const alerts = [];
  const outcome = await finalizeBurstConstituentLedger({
    supabase: client,
    burst: { burst_id: BURST_ID, thread_key: THREAD, status: "completed" },
    result: { ok: true, queued: true },
    completeClaim: async (args) =>
      args.idempotency_key === "k2" ? { ok: false, reason: "claim_fenced" } : { ok: true },
    alert: async (m) => { alerts.push(m); },
  });

  assert.equal(outcome.ok, false, "partial finalization is not success");
  assert.equal(outcome.finalized, 1);
  assert.equal(outcome.pending, 1);
  assert.equal(alerts.length, 1, "partial finalization must alert");
  assert.equal(alerts[0].partial_ledger_finalization, true);
  assert.equal(alerts[0].pending_count, 1);
});

// ── outcome mapping, safety keeps precedence ────────────────────────────────

test("burst outcomes map onto the real ledger vocabulary", () => {
  const cases = [
    [{ ok: true, queued: true }, TERMINAL_DISPOSITIONS.REPLY_SENT],
    [{ ok: true, queued: false }, TERMINAL_DISPOSITIONS.NO_REPLY_REQUIRED],
    [{ ok: true, suppressed: true }, TERMINAL_DISPOSITIONS.SUPPRESSED_POLICY],
    [{ ok: true, suppressed: true, suppression_kind: "opt_out" }, TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT],
    [{ ok: true, suppressed: true, suppression_kind: "wrong_number" }, TERMINAL_DISPOSITIONS.SUPPRESSED_WRONG_NUMBER],
    [{ ok: true, human_review_required: true }, TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED],
    [{ ok: true, contact_window_deferred: true }, TERMINAL_DISPOSITIONS.REPLY_DEFERRED_COMPLIANCE],
    [{ ok: false }, TERMINAL_DISPOSITIONS.FAILED_RETRIABLE],
    [{ ok: false, retriable: false }, TERMINAL_DISPOSITIONS.FAILED_TERMINAL],
  ];
  for (const [result, expected] of cases) {
    assert.equal(resolveBurstConstituentDisposition(result), expected, JSON.stringify(result));
  }
});

test("opt-out beats a queued reply in the same burst result", () => {
  assert.equal(
    resolveBurstConstituentDisposition({ ok: true, queued: true, suppression_kind: "opt_out" }),
    TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT,
    "safety outcomes keep precedence over response generation"
  );
});

test("a row marked for a DIFFERENT burst is never adopted", async () => {
  const rows = [
    { id: "r9", idempotency_key: "k9", processing_run_id: "run9", status: "processing", thread_key: THREAD,
      disposition_detail: { [AWAITING_BURST_DETAIL_KEY]: true, burst_id: "sib:other:g1:zzz" } },
  ];
  const { client } = ledgerSupabase(rows);
  const completed = [];
  const outcome = await finalizeBurstConstituentLedger({
    supabase: client,
    burst: { burst_id: BURST_ID, thread_key: THREAD, status: "completed" },
    result: { ok: true, queued: true },
    completeClaim: async (a) => { completed.push(a); return { ok: true }; },
  });
  assert.equal(outcome.finalized, 0);
  assert.deepEqual(completed, [], "one burst must never finalize another burst's rows");
});

test("an unmarked processing row is never adopted", async () => {
  const rows = [
    { id: "r8", idempotency_key: "k8", processing_run_id: "run8", status: "processing", thread_key: THREAD,
      disposition_detail: {} },
  ];
  const { client } = ledgerSupabase(rows);
  const completed = [];
  await finalizeBurstConstituentLedger({
    supabase: client,
    burst: { burst_id: BURST_ID, thread_key: THREAD, status: "completed" },
    result: { ok: true, queued: true },
    completeClaim: async (a) => { completed.push(a); return { ok: true }; },
  });
  assert.deepEqual(completed, [], "a row with no pendency marker is not a constituent");
});
