// ─── inbound-claim-enforcement.test.mjs ──────────────────────────────────────
// The durable database claim contract is the ENFORCEMENT authority for inbound
// idempotency. These tests drive handleTextgridInboundWebhook with injected
// claim deps and prove:
//   * a duplicate_completed / terminally_failed / already_processing claim
//     outcome stops processing BEFORE the core handler and is never a silent
//     drop (duplicate_ignored + prior disposition reference on the response);
//   * fail-closed: Supabase configured but claim unavailable → the webhook
//     refuses to process (provider retry), it never processes unclaimed;
//   * a held claim (claimed_new / retry_claimed) records its terminal
//     disposition through the run-id-fenced complete RPC, not the legacy
//     unfenced update;
//   * a fenced completion (zombie) raises the P0 no-disposition alert;
//   * the per-instance /tmp runtime-state store is demoted to diagnostics —
//     its duplicate verdict cannot skip processing when a DB claim is held;
//   * JS-level concurrency: N parallel deliveries, exactly one execution wins.

import test from "node:test";
import assert from "node:assert/strict";

import "../helpers/critical-test-environment.mjs";

import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";

const PAYLOAD = {
  SmsMessageSid: "SMCLAIM1",
  From: "+15550100001",
  To: "+15550100002",
  Body: "yes I own it",
  SmsStatus: "received",
  http_received_at: "2026-08-02T12:00:00.000Z",
};

const KEY = "textgrid_inbound:SMCLAIM1";

function baseClaimDeps(overrides = {}) {
  return {
    getSystemFlags: async () => ({}),
    getSystemValue: async () => null,
    normalizeInboundTextgridPhone: (v) => v,
    // No thread-alias resolution against the placeholder client in hermetic runs.
    getSupabaseClient: () => null,
    beginInboundLedgerEntry: async () => {
      throw new Error("legacy beginInboundLedgerEntry must not run when a DB claim is active");
    },
    recordInboundTerminalDisposition: async () => {
      throw new Error("legacy recordInboundTerminalDisposition must not run when a DB claim is active");
    },
    completeInboundProcessingClaim: async () => ({ ok: true }),
    ...overrides,
  };
}

test("duplicate_completed claim returns duplicate_ignored with the prior disposition and never reaches the core", async (t) => {
  let core_probe_calls = 0;
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async () => ({
        ok: true,
        authority: "db",
        outcome: "duplicate_completed",
        ledger_id: "led-1",
        prior_disposition: "reply_sent",
        duplicate_delivery_count: 3,
      }),
      getSystemFlags: async () => {
        core_probe_calls += 1;
        return {};
      },
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook({ ...PAYLOAD });

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.reason, "duplicate_completed_delivery");
  assert.equal(result.terminal_disposition, "duplicate_ignored");
  assert.equal(result.prior_disposition, "reply_sent");
  assert.equal(result.ledger_id, "led-1");
  assert.equal(result.duplicate_delivery_count, 3);
  assert.equal(result.idempotency_key, KEY);
  assert.equal(core_probe_calls, 0, "core handler must not run for a settled key");
});

test("terminally_failed claim outcome refuses processing with the prior reference", async (t) => {
  let core_probe_calls = 0;
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async () => ({
        ok: true,
        authority: "db",
        outcome: "terminally_failed",
        ledger_id: "led-2",
        prior_disposition: "failed_terminal",
        duplicate_delivery_count: 1,
      }),
      getSystemFlags: async () => {
        core_probe_calls += 1;
        return {};
      },
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook({ ...PAYLOAD });

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.reason, "terminally_failed_delivery");
  assert.equal(result.terminal_disposition, "duplicate_ignored");
  assert.equal(result.prior_disposition, "failed_terminal");
  assert.equal(core_probe_calls, 0);
});

test("already_processing claim outcome defers without executing", async (t) => {
  let core_probe_calls = 0;
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async () => ({
        ok: true,
        authority: "db",
        outcome: "already_processing",
        ledger_id: "led-3",
        lease_expires_at: "2026-08-02T12:10:00.000Z",
      }),
      getSystemFlags: async () => {
        core_probe_calls += 1;
        return {};
      },
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook({ ...PAYLOAD });

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.reason, "event_already_processing");
  assert.equal(result.lease_expires_at, "2026-08-02T12:10:00.000Z");
  assert.equal(core_probe_calls, 0);
});

test("fail-closed: configured Supabase with an unavailable claim path refuses processing", async (t) => {
  let core_probe_calls = 0;
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async () => ({
        ok: false,
        authority: "db",
        outcome: null,
        reason: "claim_function_unavailable",
        fail_closed: true,
      }),
      getSystemFlags: async () => {
        core_probe_calls += 1;
        return {};
      },
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook({ ...PAYLOAD });

  assert.equal(result.ok, false);
  assert.equal(result.fail_closed, true);
  assert.equal(result.reason, "claim_function_unavailable");
  assert.equal(core_probe_calls, 0, "unclaimed processing is forbidden");
});

test("a held claim records its disposition through the run-id-fenced complete RPC", async (t) => {
  const completes = [];
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async () => ({
        ok: true,
        authority: "db",
        outcome: "claimed_new",
        ledger_id: "led-4",
        processing_run_id: "run-abc",
        attempt_count: 1,
      }),
      completeInboundProcessingClaim: async (args) => {
        completes.push(args);
        return { ok: true, disposition: args.disposition };
      },
      getSystemFlags: async () => ({}),
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(
    { ...PAYLOAD },
    { inbound_debug_stage: "handler_entry" }
  );

  assert.equal(result.ok, true);
  assert.equal(completes.length, 1, "exactly one fenced completion");
  assert.equal(completes[0].idempotency_key, KEY);
  assert.equal(completes[0].processing_run_id, "run-abc");
  assert.equal(completes[0].disposition, "no_reply_required");
  assert.equal(result.terminal_disposition, "no_reply_required");
});

test("retry_claimed executes and completes exactly like a fresh claim", async (t) => {
  const completes = [];
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async () => ({
        ok: true,
        authority: "db",
        outcome: "retry_claimed",
        ledger_id: "led-5",
        processing_run_id: "run-retry",
        attempt_count: 2,
      }),
      completeInboundProcessingClaim: async (args) => {
        completes.push(args);
        return { ok: true, disposition: args.disposition };
      },
      getSystemFlags: async () => ({}),
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(
    { ...PAYLOAD },
    { inbound_debug_stage: "handler_entry" }
  );

  assert.equal(result.ok, true);
  assert.equal(completes.length, 1);
  assert.equal(completes[0].processing_run_id, "run-retry");
});

test("a fenced completion (zombie) raises the P0 no-disposition alert", async (t) => {
  const alerts = [];
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async () => ({
        ok: true,
        authority: "db",
        outcome: "claimed_new",
        ledger_id: "led-6",
        processing_run_id: "run-zombie",
        attempt_count: 1,
      }),
      completeInboundProcessingClaim: async () => ({
        ok: false,
        reason: "claim_fenced",
        current_status: "processing",
      }),
      recordInboundNoDispositionAlert: async (args) => {
        alerts.push(args);
        return { ok: true };
      },
      getSystemFlags: async () => ({}),
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(
    { ...PAYLOAD },
    { inbound_debug_stage: "handler_entry" }
  );

  assert.equal(result.ok, true);
  assert.equal(alerts.length, 1, "fenced write must page");
  assert.equal(alerts[0].record_failure, true);
  assert.equal(alerts[0].record_failure_reason, "claim_fenced");
});

test("runtime-state duplicate verdict is diagnostic only under a DB claim (processing continues)", async (t) => {
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async () => ({
        ok: true,
        authority: "db",
        outcome: "retry_claimed",
        ledger_id: "led-7",
        processing_run_id: "run-diverge",
        attempt_count: 2,
      }),
      completeInboundProcessingClaim: async (args) => ({
        ok: true,
        disposition: args.disposition,
      }),
      // Warm-instance /tmp record claims this key already completed — the DB
      // reclaim (lease expired) is the authority; processing must continue.
      beginIdempotentProcessing: async () => ({
        ok: true,
        duplicate: true,
        reason: "duplicate_event_ignored",
        record_item_id: "rt-1",
      }),
      getSystemFlags: async () => ({}),
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(
    { ...PAYLOAD },
    { inbound_debug_stage: "after_message_event_lookup" }
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.stage,
    "after_message_event_lookup",
    "core must proceed past the diagnostic duplicate verdict"
  );
  assert.notEqual(result.duplicate, true);
});

test("runtime-state store failure cannot block a DB-claimed execution", async (t) => {
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async () => ({
        ok: true,
        authority: "db",
        outcome: "claimed_new",
        ledger_id: "led-8",
        processing_run_id: "run-degraded",
        attempt_count: 1,
      }),
      completeInboundProcessingClaim: async (args) => ({
        ok: true,
        disposition: args.disposition,
      }),
      beginIdempotentProcessing: async () => {
        throw new Error("disk full");
      },
      getSystemFlags: async () => ({}),
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(
    { ...PAYLOAD },
    { inbound_debug_stage: "after_message_event_lookup" }
  );

  assert.equal(result.ok, true);
  assert.equal(result.stage, "after_message_event_lookup");
});

test("without a DB claim the legacy path is unchanged (observability begin + unfenced record)", async (t) => {
  const begins = [];
  const records = [];
  __setTextgridInboundTestDeps({
    claimInboundProcessing: async () => ({
      ok: false,
      authority: "unavailable",
      outcome: null,
      reason: "supabase_unconfigured",
      fail_closed: false,
    }),
    beginInboundLedgerEntry: async (args) => {
      begins.push(args);
      return { ok: true, ledger_id: "legacy-1" };
    },
    recordInboundTerminalDisposition: async (args) => {
      records.push(args);
      return { ok: true, disposition: args.disposition };
    },
    completeInboundProcessingClaim: async () => {
      throw new Error("fenced complete must not run without a DB claim");
    },
    getSystemFlags: async () => ({}),
    getSystemValue: async () => null,
  });
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(
    { ...PAYLOAD },
    { inbound_debug_stage: "handler_entry" }
  );

  assert.equal(result.ok, true);
  assert.equal(begins.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].disposition, "no_reply_required");
});

test("JS-level storm: N parallel deliveries of one key, exactly one execution wins", async (t) => {
  // In-memory model of the claim contract's atomicity: first claim wins, the
  // rest observe already_processing until completion, duplicate_completed
  // after. This mirrors the SQL proven by
  // scripts/proof/inbound-claim-concurrency-proof.mjs against real Postgres.
  const rows = new Map();
  const completes = [];
  __setTextgridInboundTestDeps(
    baseClaimDeps({
      claimInboundProcessing: async ({ idempotency_key }) => {
        const existing = rows.get(idempotency_key);
        if (!existing) {
          const row = {
            status: "processing",
            run_id: `run-${rows.size + 1}`,
            duplicates: 0,
          };
          rows.set(idempotency_key, row);
          return {
            ok: true,
            authority: "db",
            outcome: "claimed_new",
            ledger_id: "led-storm",
            processing_run_id: row.run_id,
            attempt_count: 1,
          };
        }
        if (existing.status === "completed") {
          existing.duplicates += 1;
          return {
            ok: true,
            authority: "db",
            outcome: "duplicate_completed",
            ledger_id: "led-storm",
            prior_disposition: existing.disposition,
            duplicate_delivery_count: existing.duplicates,
          };
        }
        return {
          ok: true,
          authority: "db",
          outcome: "already_processing",
          ledger_id: "led-storm",
        };
      },
      completeInboundProcessingClaim: async (args) => {
        const row = rows.get(args.idempotency_key);
        if (!row || row.run_id !== args.processing_run_id) {
          return { ok: false, reason: "claim_fenced" };
        }
        row.status = "completed";
        row.disposition = args.disposition;
        completes.push(args);
        return { ok: true, disposition: args.disposition };
      },
      getSystemFlags: async () => ({}),
    })
  );
  t.after(() => __resetTextgridInboundTestDeps());

  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      handleTextgridInboundWebhook(
        { ...PAYLOAD },
        { inbound_debug_stage: "handler_entry" }
      )
    )
  );

  const executed = results.filter((r) => r.stage === "handler_entry");
  const deferred = results.filter((r) => r.reason === "event_already_processing");
  // Stragglers whose claim lands after the winner completed observe
  // duplicate_completed — an audited duplicate, equally "not executed".
  const late_duplicates = results.filter(
    (r) => r.reason === "duplicate_completed_delivery"
  );
  assert.equal(executed.length, 1, "exactly one delivery may execute");
  assert.equal(deferred.length + late_duplicates.length, 7);
  assert.equal(completes.length, 1, "exactly one fenced completion");

  // A later delivery after completion is an audited duplicate, not a drop.
  const late = await handleTextgridInboundWebhook({ ...PAYLOAD });
  assert.equal(late.duplicate, true);
  assert.equal(late.terminal_disposition, "duplicate_ignored");
  assert.equal(late.prior_disposition, "no_reply_required");
});
