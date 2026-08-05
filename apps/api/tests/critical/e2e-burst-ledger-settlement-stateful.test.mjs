/**
 * Burst terminal settlement, driven through the REAL finalizer against a
 * STATEFUL ledger — not a callback spy.
 *
 * The sibling suite (burst-terminal-ledger-settlement.test.mjs) proves the
 * coordinator INVOKES a settlement callback on every terminal branch. It cannot
 * prove the callback settles the rows CORRECTLY: its stub always reports
 * success, so a regression that recorded a STOP as `reply_sent`, or spent
 * attempts as a successful disposition, would pass it untouched.
 *
 * This file closes that gap. It wires the production `finalizeBurstConstituentLedger`
 * into the coordinator over a Supabase double that really stores rows, and a
 * completion double that enforces the real `complete_inbound_processing`
 * contract (fenced on status='processing', terminal dispositions only). Every
 * assertion below reads PERSISTED ROW STATE — never a captured argument.
 *
 * The 2026-08-03 failure shape was "a decision nobody ever recorded". Asserting
 * on the call rather than the record is how that shape hides.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { createSellerInboundBurstCoordinator } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import { finalizeBurstConstituentLedger } from "@/lib/domain/seller-flow/finalize-burst-constituent-ledger.js";
import {
  AWAITING_BURST_DETAIL_KEY,
  completeInboundProcessingClaim,
} from "@/lib/domain/inbound/inbound-processing-ledger.js";
import { TERMINAL_DISPOSITIONS } from "@/lib/domain/inbound/terminal-disposition.js";

const THREAD = "+15550100311";
const T0 = "2026-08-04T10:00:00.000Z";
const ms = (iso) => new Date(iso).getTime();

// ── the stateful doubles ────────────────────────────────────────────────────

/**
 * A ledger that actually stores rows, plus the two seams production uses to
 * reach it:
 *   - `supabase`  — the SELECT the finalizer issues to find constituents.
 *   - `rpc`       — `complete_inbound_processing`, fenced exactly as the real
 *                   function is: only a row still at status='processing' whose
 *                   processing_run_id matches may be terminalized, and only to
 *                   a canonical terminal disposition.
 * Driving the REAL completeInboundProcessingClaim over this rpc keeps the
 * production terminal-disposition validation in the loop.
 */
function createStatefulLedger() {
  const rows = [];

  function add({ key, run = `run-${key}`, burst_id, status = "processing" }) {
    const row = {
      id: `row-${key}`,
      idempotency_key: key,
      processing_run_id: run,
      thread_key: THREAD,
      status,
      terminal_disposition: null,
      disposition_detail: { [AWAITING_BURST_DETAIL_KEY]: true, burst_id },
    };
    rows.push(row);
    return row;
  }

  const supabase = {
    from(table) {
      const filters = {};
      const node = {
        select: () => node,
        eq: (k, v) => {
          filters[k] = v;
          return node;
        },
        then: (resolve) => {
          if (table !== "inbound_processing_ledger") {
            return resolve({ data: [], error: null });
          }
          const data = rows.filter((row) =>
            Object.entries(filters).every(([k, v]) => row[k] === v)
          );
          // Return copies: the finalizer must not mutate our store directly.
          return resolve({ data: data.map((r) => ({ ...r })), error: null });
        },
      };
      return node;
    },
    // The real complete_inbound_processing RPC contract.
    async rpc(fn, params) {
      if (fn !== "complete_inbound_processing") return { data: null, error: null };
      const row = rows.find((r) => r.idempotency_key === params.p_idempotency_key);
      if (!row) return { data: { ok: false, reason: "not_found" }, error: null };
      if (row.status !== "processing") {
        return {
          data: { ok: false, reason: "not_processing", current_status: row.status },
          error: null,
        };
      }
      if (row.processing_run_id !== params.p_processing_run_id) {
        return { data: { ok: false, reason: "run_id_mismatch" }, error: null };
      }
      row.status = "completed";
      row.terminal_disposition = params.p_disposition;
      row.disposition_detail = { ...row.disposition_detail, ...(params.p_detail || {}) };
      return { data: { ok: true }, error: null };
    },
  };

  return {
    rows,
    add,
    supabase,
    get: (key) => rows.find((r) => r.idempotency_key === key) || null,
    // The coordinator seam, bound to this store the way flush-inbound-bursts-request
    // binds the production client.
    completeClaim: (args) => completeInboundProcessingClaim(args, { supabase }),
  };
}

/**
 * Coordinator wired to the REAL finalizer. `onProcess` runs inside the claimed
 * window, which is where a competing generation can appear.
 */
function harness({ processResult = null, maxAttempts = null, onProcess = null } = {}) {
  const state = { clock: ms(T0) };
  const now = () => new Date(state.clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const ledger = createStatefulLedger();

  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    supabase: ledger.supabase,
    ...(maxAttempts != null ? { max_attempts: maxAttempts } : {}),
    processSellerInboundMessage: async () => {
      if (onProcess) await onProcess({ coordinator, store, ledger, now });
      return processResult || { ok: true, queued: true, execution: { queued: true } };
    },
    finalizeConstituentLedger: finalizeBurstConstituentLedger,
    completeInboundProcessingClaim: ledger.completeClaim,
    alertBurstFailure: async () => {},
  });

  return { state, store, ledger, coordinator, now };
}

async function ingest(h, { body = "Yeah", event_id = "evt-1", classification = null } = {}) {
  return h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id,
    provider_message_id: `SM-${event_id}`,
    body,
    classification,
    received_at: h.now(),
  });
}

// ── branch 1: normal completion ─────────────────────────────────────────────

test("a normally completed burst records reply_sent on the real ledger row", async () => {
  const h = harness();
  await ingest(h);
  const burst = await h.store.getOpen(THREAD);
  h.ledger.add({ key: "k1", burst_id: burst.burst_id });

  h.state.clock = ms(T0) + 25_000; // past the quiet window
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });

  assert.equal(flush.results[0].ok, true);
  assert.equal(flush.results[0].ledger_finalization.ok, true);
  assert.equal(flush.results[0].ledger_finalization.finalized, 1);
  assert.equal(flush.results[0].ledger_finalization.pending, 0);

  const row = h.ledger.get("k1");
  assert.equal(row.status, "completed", "the constituent must not stay processing");
  assert.equal(
    row.terminal_disposition,
    TERMINAL_DISPOSITIONS.REPLY_SENT,
    "a queued reply is reply_sent"
  );
  assert.equal(row.disposition_detail.burst_id, burst.burst_id, "provenance is recorded");
  assert.equal(row.disposition_detail.finalized_by, "burst_completion");
});

// ── branch 2: safety suppression ────────────────────────────────────────────

test("a STOP burst records suppressed_opt_out — never a successful disposition", async () => {
  const h = harness();
  // A safety latch finalizes INLINE during append, so the row must already
  // carry its pendency marker — exactly as the live webhook records it before
  // the burst layer can settle it.
  const burst_id = `sib:${THREAD}:g1:evt-1`;
  h.ledger.add({ key: "k1", burst_id });

  await ingest(h, {
    body: "STOP",
    classification: { primary_intent: "opt_out", compliance_flag: "opt_out", confidence: 1 },
  });

  const row = h.ledger.get("k1");
  assert.equal(row.status, "completed", "a suppressed burst must still settle its rows");
  assert.equal(
    row.terminal_disposition,
    TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT,
    "STOP is suppressed_opt_out — a regression mapping it to reply_sent fails here"
  );
  assert.notEqual(row.terminal_disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
});

// ── branch 3: attempts exhausted ────────────────────────────────────────────

test("an attempts-exhausted burst records failed_terminal, not a success", async () => {
  // max_attempts below the claim's starting attempt_count forces the branch.
  const h = harness({ maxAttempts: -1 });
  await ingest(h);
  const burst = await h.store.getOpen(THREAD);
  h.ledger.add({ key: "k1", burst_id: burst.burst_id });

  h.state.clock = ms(T0) + 25_000;
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });

  assert.equal(flush.results[0].ok, false);
  assert.equal(flush.results[0].reason, "attempts_exhausted");

  const row = h.ledger.get("k1");
  assert.equal(row.status, "completed", "a failed burst may not leave rows awaiting forever");
  assert.equal(
    row.terminal_disposition,
    TERMINAL_DISPOSITIONS.FAILED_TERMINAL,
    "spent attempts are terminal, not retriable — and never a success disposition"
  );
  assert.notEqual(row.terminal_disposition, TERMINAL_DISPOSITIONS.FAILED_RETRIABLE);
  assert.notEqual(row.terminal_disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
});

// ── the generation-isolation guard ──────────────────────────────────────────

test("a competing successor burst is NOT settled by the claimed generation", async () => {
  // Regression guard. finalize-burst-constituent-ledger.js:91 already requires
  // an exact burst_id match, so this is expected to pass — it exists so a future
  // change that settles "whatever is open now" instead of "what was claimed"
  // cannot land silently. That mistake would settle the successor with the
  // predecessor's outcome and strand the real constituents.
  const successor = {};

  const h = harness({
    // Runs while generation 1 holds the claim: a second inbound arrives and
    // opens generation 2 on the same thread.
    onProcess: async ({ coordinator, store, ledger, now }) => {
      await coordinator.onPersistedInbound({
        thread_key: THREAD,
        event_id: "evt-2",
        provider_message_id: "SM-evt-2",
        body: "Also its a 3br",
        received_at: now(),
      });
      const open = await store.getOpen(THREAD);
      successor.burst_id = open?.burst_id ?? null;
      successor.generation = open?.generation ?? null;
      ledger.add({ key: "k2", burst_id: successor.burst_id });
    },
  });

  await ingest(h);
  const claimed = await h.store.getOpen(THREAD);
  h.ledger.add({ key: "k1", burst_id: claimed.burst_id });

  h.state.clock = ms(T0) + 25_000;
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });

  // A genuinely distinct later generation really was created mid-flight.
  assert.ok(successor.burst_id, "a successor generation must exist for this test to mean anything");
  assert.notEqual(successor.burst_id, claimed.burst_id, "successor is a different burst");
  assert.equal(successor.generation, claimed.generation + 1, "and a later generation");

  // Settlement targeted the CLAIMED burst.
  assert.equal(flush.results[0].burst.burst_id, claimed.burst_id);
  assert.equal(flush.results[0].ledger_finalization.finalized, 1, "exactly one row settled");

  const first = h.ledger.get("k1");
  const second = h.ledger.get("k2");
  assert.equal(first.status, "completed");
  assert.equal(first.terminal_disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);

  // The successor generation is untouched — its constituent is still awaiting
  // its OWN flush, and its burst is still open.
  assert.equal(second.status, "processing", "the successor's row must not be settled");
  assert.equal(second.terminal_disposition, null, "no disposition may be borrowed across generations");
  assert.equal(second.disposition_detail[AWAITING_BURST_DETAIL_KEY], true);

  const successor_row = await h.store.getOpen(THREAD);
  assert.equal(successor_row?.burst_id, successor.burst_id, "successor is still the open burst");
  assert.equal(successor_row?.completed_at ?? null, null, "successor was not completed");
});

// ── idempotency ─────────────────────────────────────────────────────────────

test("re-flushing settles nothing further and never rewrites a disposition", async () => {
  const h = harness();
  await ingest(h);
  const burst = await h.store.getOpen(THREAD);
  h.ledger.add({ key: "k1", burst_id: burst.burst_id });

  h.state.clock = ms(T0) + 25_000;
  await h.coordinator.flushEligible({ thread_key: THREAD });
  const after_first = { ...h.ledger.get("k1") };

  await h.coordinator.flushEligible({ thread_key: THREAD });
  const after_second = h.ledger.get("k1");

  assert.equal(after_second.status, after_first.status);
  assert.equal(after_second.terminal_disposition, after_first.terminal_disposition);
  assert.equal(after_second.terminal_disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
});

// ── the fence itself ────────────────────────────────────────────────────────

test("a row belonging to another burst is never adopted", async () => {
  const h = harness();
  await ingest(h);
  const burst = await h.store.getOpen(THREAD);
  h.ledger.add({ key: "k1", burst_id: burst.burst_id });
  h.ledger.add({ key: "foreign", burst_id: "sib:+15550100999:g7:other" });

  h.state.clock = ms(T0) + 25_000;
  await h.coordinator.flushEligible({ thread_key: THREAD });

  assert.equal(h.ledger.get("k1").terminal_disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
  const foreign = h.ledger.get("foreign");
  assert.equal(foreign.status, "processing", "another burst's row is not this burst's business");
  assert.equal(foreign.terminal_disposition, null);
});

// ── DOCUMENTED HAZARD (characterization, not an endorsement) ────────────────

test("DOCUMENTED HAZARD: a benign inbound on an already-suppressed thread parks a ledger row that no watchdog alarms", async () => {
  // This test PINS CURRENT BEHAVIOUR so that whoever fixes it later gets a loud,
  // executable signal. It is not an assertion that this behaviour is correct.
  //
  // Chain: a thread carries durable suppression (a prior STOP). Any later
  // BENIGN message latches safety with kind `contact_suppression`
  // (seller-inbound-burst-coordinator.js:176-182) and the burst finalizes
  // INLINE during onPersistedInbound. The webhook only marks the ledger row
  // awaiting_burst_finalization AFTERWARDS (handle-textgrid-inbound.js:1051,
  // outside the core that ran the burst at :2267) — and because the message is
  // benign, resolveInboundTerminalDisposition does not take the opt_out branch
  // and falls through to the burst-deferral PENDING branch instead. The row is
  // therefore marked as awaiting a burst that already completed.
  //
  // Seller-facing behaviour is CORRECT: the thread is suppressed, so silence is
  // right and nobody is ignored who should have been answered. The cost is
  // ledger hygiene and observability — the row sits at status='processing'
  // forever, and findInboundLedgerSlaBreaches filters awaiting-burst rows out
  // of stuck_processing (inbound-processing-ledger.js:565-578), so it
  // contributes zero to breach_count and never pages. The exclusion is
  // justified in-comment by "the burst liveness scan alarms an open/claimed
  // burst", which cannot cover this case: the burst here is COMPLETED.
  const h = harness();

  const ingested = await h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: "evt-1",
    provider_message_id: "SM-evt-1",
    body: "Yeah", // benign — NOT an opt-out
    received_at: h.now(),
    prior_thread_suppressed: true,
  });

  assert.equal(ingested.safety?.latch, true, "durable suppression latches every later fragment");
  assert.equal(ingested.safety?.kind, "contact_suppression");
  assert.equal(ingested.flush?.suppressed, true, "the burst finalized inline, during ingest");

  // The webhook marks the row only after the core returned — by which time the
  // burst is already terminal.
  const burst_id = ingested.append?.burst?.burst_id;
  h.ledger.add({ key: "k1", burst_id });

  // Nothing is left to settle it, now or ever.
  h.state.clock = ms(T0) + 25_000;
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  assert.equal(flush.results[0].ok, false);
  assert.equal(flush.results[0].reason, "no_eligible_burst");

  const row = h.ledger.get("k1");
  assert.equal(row.status, "processing", "CURRENT BEHAVIOUR: the row is parked indefinitely");
  assert.equal(row.terminal_disposition, null, "CURRENT BEHAVIOUR: no disposition is ever recorded");
  assert.equal(
    row.disposition_detail[AWAITING_BURST_DETAIL_KEY],
    true,
    "and it still claims to be awaiting a burst that has already completed"
  );
});

test("the real terminal-disposition validation is in the loop", async () => {
  // Guards the guard: completeInboundProcessingClaim rejects any disposition
  // outside the canonical terminal set, so the doubles above cannot silently
  // accept an invented value.
  const ledger = createStatefulLedger();
  ledger.add({ key: "k1", burst_id: "sib:x:g1:e1" });

  const rejected = await ledger.completeClaim({
    idempotency_key: "k1",
    processing_run_id: "run-k1",
    disposition: "reply_deferred_burst", // pending, deliberately NOT terminal
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "invalid_terminal_disposition");
  assert.equal(ledger.get("k1").status, "processing", "a rejected write changes nothing");
});
