/**
 * Burst→ledger ASSOCIATION and finalizer-throw ALERTING.
 *
 * Two defects in the same family, both producing a row that exists but can
 * never be settled and that no watchdog looks at:
 *
 *  1. ASSOCIATION. The deferred coordinator result carries its id on
 *     `seller_orchestration.burst_id`, but that object lives in a deeper block
 *     than the webhook's result assembly, so `result.burst_id` was undefined.
 *     `resolveInboundTerminalDisposition` then produced `detail.burst_id = null`
 *     and the pending ledger marker was written with NO burst association.
 *     Such a row is unsettleable — finalizeBurstConstituentLedger adopts
 *     constituents by EXACT burst_id match — and invisible, because
 *     findInboundLedgerSlaBreaches deliberately excludes awaiting-burst rows
 *     from the stuck scan.
 *
 *  2. ALERTING. settleConstituentLedger's catch turned a thrown finalizer into
 *     a plain return. The burst still reported ok:true, constituent rows kept
 *     their awaiting_burst_finalization marker, and nothing paged — the same
 *     unwatched parking, reached through a second door.
 *
 * Everything below asserts PERSISTED STATE or REAL CALL ARGUMENTS, never a
 * convenient stub's opinion.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";
import { createSellerInboundBurstCoordinator } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import { finalizeBurstConstituentLedger } from "@/lib/domain/seller-flow/finalize-burst-constituent-ledger.js";
import {
  AWAITING_BURST_DETAIL_KEY,
  markInboundAwaitingBurst,
  completeInboundProcessingClaim,
} from "@/lib/domain/inbound/inbound-processing-ledger.js";
import { TERMINAL_DISPOSITIONS } from "@/lib/domain/inbound/terminal-disposition.js";
import { makeInboundWebhookBaseDeps } from "../helpers/chainable-supabase.mjs";

const THREAD = "+15550100911";
const T0 = "2026-08-05T10:00:00.000Z";
const ms = (iso) => new Date(iso).getTime();

// ── stateful ledger (shared shape with the sibling settlement suite) ────────

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
        update: (patch) => {
          const w = {
            eq: (k, v) => {
              filters[k] = v;
              return w;
            },
            then: (resolve) => {
              for (const row of rows) {
                if (Object.entries(filters).every(([k, v]) => row[k] === v)) {
                  Object.assign(row, patch);
                }
              }
              return resolve({ data: null, error: null });
            },
          };
          return w;
        },
        then: (resolve) => {
          if (table !== "inbound_processing_ledger") return resolve({ data: [], error: null });
          const data = rows.filter((row) =>
            Object.entries(filters).every(([k, v]) => row[k] === v)
          );
          return resolve({ data: data.map((r) => ({ ...r })), error: null });
        },
      };
      return node;
    },
    async rpc(fn, params) {
      if (fn !== "complete_inbound_processing") return { data: null, error: null };
      const row = rows.find((r) => r.idempotency_key === params.p_idempotency_key);
      if (!row) return { data: { ok: false, reason: "not_found" }, error: null };
      if (row.status !== "processing") {
        return { data: { ok: false, reason: "not_processing" }, error: null };
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
    completeClaim: (args) => completeInboundProcessingClaim(args, { supabase }),
  };
}

// ══ PART A — the webhook must associate the marker with the real burst ══════

function webhookHarness({ burstEnabled = true, breakBurstId = false } = {}) {
  const clock = { t: ms(T0) };
  const now = () => new Date(clock.t).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const calls = { awaiting: [], terminal: [] };
  let coordinator = null;

  __setTextgridInboundTestDeps({
    ...makeInboundWebhookBaseDeps({
      getSystemFlags: async () => ({ auto_reply_enabled: true, followup_enabled: false }),
      getSystemValue: async (k) => (k === "auto_reply_mode" ? "internal_only" : null),
    }),
    info: () => {},
    warn: () => {},
    normalizeInboundTextgridPhone: (v) => v,
    beginIdempotentProcessing: async () => ({ ok: true, record_item_id: "rec-1" }),
    completeIdempotentProcessing: async () => ({ ok: true }),
    failIdempotentProcessing: async () => ({ ok: true }),
    hashIdempotencyPayload: () => "hash-1",
    // Durable-ledger seams.
    claimInboundProcessing: async () => ({
      ok: true,
      authority: "db",
      outcome: "claimed",
      ledger_id: "ledger-1",
      processing_run_id: "run-k1",
      attempt_count: 1,
    }),
    // With a DB claim active the terminal write is the run-id-fenced
    // completeClaim, NOT recordInboundTerminalDisposition. Spy on both so the
    // assertion cannot pass by watching a seam production does not use.
    recordInboundTerminalDisposition: async (args) => {
      calls.terminal.push(args);
      return { ok: true };
    },
    completeInboundProcessingClaim: async (args) => {
      calls.terminal.push(args);
      return { ok: true };
    },
    markInboundAwaitingBurst: async (args) => {
      calls.awaiting.push(args);
      return { ok: true, awaiting_burst: true };
    },
    loadContextWithFallback: async () => ({
      found: true,
      ids: { master_owner_id: 1, prospect_id: 2, property_id: 3, phone_item_id: 4 },
      items: {},
      summary: { conversation_stage: "ownership_check", property_address: "9 Oak Ln" },
    }),
    resolveRoute: async () => ({ stage: "ownership_check", use_case: "ownership_check" }),
    isOfferStageTrigger: () => ({ triggered: false }),
    logInboundMessageEvent: async () => ({ item_id: "podio-1" }),
    logInboundMessageEventSupabase: async () => ({ ok: true, id: "evt-1" }),
    createBrain: async () => ({ ok: true }),
    updateBrainAfterInbound: async () => ({ ok: true }),
    updateMasterOwnerAfterInbound: async () => ({ ok: true }),
    updateBrainStage: async () => ({ ok: true }),
    findLatestOpenOffer: async () => null,
    maybeProgressOfferStatus: async () => ({ ok: true }),
    maybeCreateOfferFromContext: async () => ({ ok: true }),
    maybeUpsertUnderwritingFromInbound: async () => ({ ok: true }),
    maybeQueueUnderwritingFollowUp: async () => ({ ok: true }),
    transferDealToUnderwriting: async () => ({ ok: true }),
    maybeCreateContractFromAcceptedOffer: async () => ({ ok: true }),
    syncPipelineState: async () => ({ ok: true }),
    cancelPendingQueueItemsForOwner: async () => ({ ok: true, canceled_count: 0 }),
    cancelSupabasePendingOutbound: async () => ({ ok: true, cancelled: 0 }),
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 0 }),
    notifyDiscordOps: async () => ({ ok: true }),
    postInboundSmsDiscordCard: async () => ({ ok: true }),
    findInboundAutopilotQueue: async () => null,
    updateInboundAutopilotQueue: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    isSellerInboundBurstEnabled: () => burstEnabled,
    createSellerInboundBurstCoordinator: (opts = {}) => {
      coordinator = createSellerInboundBurstCoordinator({
        ...opts,
        store,
        now,
        enabled: true,
        processSellerInboundMessage: async () => ({ ok: true, queued: false }),
      });
      if (!breakBurstId) return coordinator;
      // Simulate the burst store failing to return an id on append — the
      // degenerate case the guard exists for.
      return {
        ...coordinator,
        onPersistedInbound: async (args) => {
          const real = await coordinator.onPersistedInbound(args);
          return { ...real, append: { ...(real.append || {}), burst: {} } };
        },
      };
    },
  });

  return { store, calls, clock, now, get coordinator() { return coordinator; } };
}

async function deliver(h, { sid = "SM-a1", body = "Yeah" } = {}) {
  return handleTextgridInboundWebhook({
    id: sid,
    MessageSid: sid,
    from: THREAD,
    to: "+16125551234",
    body,
    received_at: h.now(),
  });
}

test("a deferred burst hands the ledger the EXACT burst id, never null", async (t) => {
  const h = webhookHarness();
  t.after(() => __resetTextgridInboundTestDeps());

  await deliver(h);

  const burst = await h.store.getOpen(THREAD);
  assert.ok(burst?.burst_id, "the store must hold an open burst");
  assert.equal(h.calls.awaiting.length, 1, "exactly one pendency marker per inbound");

  const marked = h.calls.awaiting[0];
  assert.notEqual(marked.burst_id, null, "a null association is unsettleable AND unwatched");
  assert.equal(marked.burst_id, burst.burst_id, "the marker must carry the store's exact id");
  assert.equal(
    marked.detail?.burst_id,
    burst.burst_id,
    "the persisted detail blob must carry it too — the finalizer reads detail"
  );
  assert.equal(marked.detail?.awaiting_burst_finalization, true);
  assert.equal(
    h.calls.terminal.length,
    0,
    "a deferred inbound must not be terminalized"
  );
});

test("no pending row may be written without a burst id — it fails loudly and RETRIABLY", async (t) => {
  const h = webhookHarness({ breakBurstId: true });
  t.after(() => __resetTextgridInboundTestDeps());

  await deliver(h, { sid: "SM-a2" });

  assert.equal(
    h.calls.awaiting.length,
    0,
    "an unassociated marker must NEVER be written — it would park the row forever"
  );
  assert.equal(h.calls.terminal.length, 1, "the failure must be recorded, not swallowed");
  const recorded = h.calls.terminal[0];
  assert.equal(
    recorded.disposition,
    TERMINAL_DISPOSITIONS.FAILED_RETRIABLE,
    "retriable: the provider redelivers and the next attempt can associate properly"
  );
  assert.equal(recorded.detail?.awaiting_burst_missing_burst_id, true);
});

test("the marker the webhook writes is the one the finalizer later selects", async () => {
  // Full association chain over the REAL marker writer and the REAL finalizer.
  const ledger = createStatefulLedger();
  const burst_id = `sib:${THREAD}:g1:evt-1`;

  ledger.rows.push({
    id: "row-k1",
    idempotency_key: "textgrid_inbound:SM-a1",
    processing_run_id: "run-k1",
    thread_key: THREAD,
    status: "processing",
    terminal_disposition: null,
    disposition_detail: {},
  });

  const marked = await markInboundAwaitingBurst(
    {
      idempotency_key: "textgrid_inbound:SM-a1",
      burst_id,
      detail: { burst_id, awaiting_burst_finalization: true },
      processing_run_id: "run-k1",
    },
    { supabase: ledger.supabase }
  );
  assert.equal(marked.ok, true);
  assert.equal(ledger.get("textgrid_inbound:SM-a1").disposition_detail.burst_id, burst_id);

  const settled = await finalizeBurstConstituentLedger({
    supabase: ledger.supabase,
    burst: { burst_id, thread_key: THREAD, generation: 1 },
    result: { ok: true, queued: true },
    completeClaim: ledger.completeClaim,
  });
  assert.equal(settled.ok, true);
  assert.equal(settled.finalized, 1, "the finalizer must select the row the webhook marked");
  const row = ledger.get("textgrid_inbound:SM-a1");
  assert.equal(row.status, "completed");
  assert.equal(row.terminal_disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
});

test("a successor generation never settles the previous generation's rows", async () => {
  const ledger = createStatefulLedger();
  const g1 = `sib:${THREAD}:g1:evt-1`;
  const g2 = `sib:${THREAD}:g2:evt-9`;
  ledger.add({ key: "k-g1", burst_id: g1 });
  ledger.add({ key: "k-g2", burst_id: g2 });

  const settled = await finalizeBurstConstituentLedger({
    supabase: ledger.supabase,
    burst: { burst_id: g1, thread_key: THREAD, generation: 1 },
    result: { ok: true, queued: true },
    completeClaim: ledger.completeClaim,
  });
  assert.equal(settled.finalized, 1, "only the claimed generation settles");

  assert.equal(ledger.get("k-g1").status, "completed");
  assert.equal(ledger.get("k-g2").status, "processing", "the successor must be untouched");
  assert.equal(ledger.get("k-g2").terminal_disposition, null);
  assert.equal(ledger.get("k-g2").disposition_detail.burst_id, g2);
});

test("an unassociated row is adopted by NO burst — the shape the guard prevents", async () => {
  const ledger = createStatefulLedger();
  const burst_id = `sib:${THREAD}:g1:evt-1`;
  ledger.add({ key: "k-orphan", burst_id: null }); // what the old code wrote
  ledger.add({ key: "k-ok", burst_id });

  const settled = await finalizeBurstConstituentLedger({
    supabase: ledger.supabase,
    burst: { burst_id, thread_key: THREAD, generation: 1 },
    result: { ok: true, queued: true },
    completeClaim: ledger.completeClaim,
  });
  assert.equal(settled.finalized, 1);
  assert.equal(
    ledger.get("k-orphan").status,
    "processing",
    "a null-association row can never be settled by any burst — parked forever"
  );
});

// ══ PART B — a thrown finalizer must page ═══════════════════════════════════

function coordinatorHarness({
  finalizer,
  processResult = null,
  maxAttempts = null,
} = {}) {
  const clock = { t: ms(T0) };
  const now = () => new Date(clock.t).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const ledger = createStatefulLedger();
  const alerts = [];

  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    supabase: ledger.supabase,
    ...(maxAttempts != null ? { max_attempts: maxAttempts } : {}),
    processSellerInboundMessage: async () =>
      processResult || { ok: true, queued: true, execution: { queued: true } },
    finalizeConstituentLedger: finalizer || finalizeBurstConstituentLedger,
    completeInboundProcessingClaim: ledger.completeClaim,
    alertBurstFailure: async (payload) => {
      alerts.push(payload);
    },
  });

  return { store, ledger, coordinator, alerts, clock, now };
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

test("a THROWN finalizer pages exactly once and never reports ledger success", async () => {
  const h = coordinatorHarness({
    finalizer: async () => {
      throw new Error("ledger write exploded");
    },
  });
  await ingest(h);
  const burst = await h.store.getOpen(THREAD);
  h.ledger.add({ key: "k1", burst_id: burst.burst_id });

  h.clock.t = ms(T0) + 25_000;
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  const outcome = flush.results[0];

  // The burst itself genuinely completed — that outcome is preserved.
  assert.equal(outcome.ok, true, "the completed burst outcome must be preserved");
  // …but the ledger failure is honest and observable.
  assert.equal(outcome.ledger_finalization.ok, false, "never describe a throw as success");
  assert.equal(outcome.ledger_finalization.reason, "ledger_finalization_threw");
  assert.equal(outcome.ledger_finalization.message, "ledger write exploded");

  assert.equal(h.alerts.length, 1, "the throw must page EXACTLY once");
  const alert = h.alerts[0];
  assert.equal(alert.reason, "ledger_finalization_threw");
  assert.equal(alert.burst_id, burst.burst_id, "the alert must identify the burst");
  assert.equal(alert.error, "ledger write exploded");

  // No seller content may reach a notification sink.
  const serialized = JSON.stringify(alert);
  assert.ok(!serialized.includes("Yeah"), "alert payloads must never carry seller text");
});

test("an alert sink that itself throws cannot mask the ledger failure", async () => {
  const h = coordinatorHarness({
    finalizer: async () => {
      throw new Error("boom");
    },
  });
  // Replace the sink with one that explodes.
  const exploding = createSellerInboundBurstCoordinator({
    store: h.store,
    now: h.now,
    enabled: true,
    supabase: h.ledger.supabase,
    processSellerInboundMessage: async () => ({ ok: true, queued: true }),
    finalizeConstituentLedger: async () => {
      throw new Error("boom");
    },
    completeInboundProcessingClaim: h.ledger.completeClaim,
    alertBurstFailure: async () => {
      throw new Error("pager down");
    },
  });
  await exploding.onPersistedInbound({
    thread_key: THREAD,
    event_id: "evt-1",
    provider_message_id: "SM-evt-1",
    body: "Yeah",
    received_at: h.now(),
  });
  h.clock.t = ms(T0) + 25_000;
  const flush = await exploding.flushEligible({ thread_key: THREAD });
  assert.equal(flush.results[0].ledger_finalization.reason, "ledger_finalization_threw");
});

test("normal, suppressed and exhausted branches settle without paging", async () => {
  // normal
  const normal = coordinatorHarness();
  await ingest(normal);
  const b1 = await normal.store.getOpen(THREAD);
  normal.ledger.add({ key: "k1", burst_id: b1.burst_id });
  normal.clock.t = ms(T0) + 25_000;
  const r1 = (await normal.coordinator.flushEligible({ thread_key: THREAD })).results[0];
  assert.equal(r1.ledger_finalization.ok, true);
  assert.equal(normal.ledger.get("k1").terminal_disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
  assert.equal(normal.alerts.length, 0, "a healthy settlement must not page");

  // suppressed (safety latch finalizes inline on append)
  const stop = coordinatorHarness();
  const stop_burst_id = `sib:${THREAD}:g1:evt-1`;
  stop.ledger.add({ key: "k1", burst_id: stop_burst_id });
  await ingest(stop, {
    body: "STOP",
    classification: { primary_intent: "opt_out", compliance_flag: "opt_out", confidence: 1 },
  });
  const stop_row = stop.ledger.get("k1");
  assert.equal(
    stop_row.terminal_disposition,
    TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT,
    "a STOP must never settle as a successful disposition"
  );
  assert.equal(stop.alerts.length, 0);

  // attempts exhausted — max_attempts below the claim's starting attempt_count
  // forces the branch (0 is falsy and would fall back to the default).
  const exhausted = coordinatorHarness({ maxAttempts: -1 });
  await ingest(exhausted);
  const b3 = await exhausted.store.getOpen(THREAD);
  exhausted.ledger.add({ key: "k1", burst_id: b3.burst_id });
  exhausted.clock.t = ms(T0) + 25_000;
  const r3 = (await exhausted.coordinator.flushEligible({ thread_key: THREAD })).results[0];
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, "attempts_exhausted");
  assert.equal(
    exhausted.ledger.get("k1").terminal_disposition,
    TERMINAL_DISPOSITIONS.FAILED_TERMINAL,
    "spent attempts are a terminal failure, never a success"
  );
});

test("a partial finalization reports pending honestly and pages through the finalizer's own path", async () => {
  // One constituent whose claim cannot be completed — the fence rejected it,
  // e.g. a reclaim moved the row to a new processing_run_id mid-settle.
  const clock = { t: ms(T0) };
  const now = () => new Date(clock.t).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const ledger = createStatefulLedger();
  const alerts = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    supabase: ledger.supabase,
    processSellerInboundMessage: async () => ({ ok: true, queued: true, execution: { queued: true } }),
    finalizeConstituentLedger: finalizeBurstConstituentLedger,
    completeInboundProcessingClaim: async (args) =>
      args.idempotency_key === "k2"
        ? { ok: false, reason: "run_id_mismatch" }
        : ledger.completeClaim(args),
    alertBurstFailure: async (p) => {
      alerts.push(p);
    },
  });
  const h = { store, ledger, coordinator, alerts, clock, now };

  await ingest(h);
  const burst = await h.store.getOpen(THREAD);
  h.ledger.add({ key: "k1", burst_id: burst.burst_id });
  h.ledger.add({ key: "k2", burst_id: burst.burst_id });

  h.clock.t = ms(T0) + 25_000;
  const outcome = (await h.coordinator.flushEligible({ thread_key: THREAD })).results[0];

  assert.equal(outcome.ledger_finalization.ok, false, "a partial settle is not ok");
  assert.ok(outcome.ledger_finalization.pending >= 1, "the unsettled row is reported");
  assert.equal(h.alerts.length, 1, "the finalizer's own alert path fires once");
  assert.equal(h.alerts[0].burst_id, burst.burst_id);
});

test("re-finalizing an already-settled burst is idempotent and does not re-page", async () => {
  const h = coordinatorHarness();
  await ingest(h);
  const burst = await h.store.getOpen(THREAD);
  h.ledger.add({ key: "k1", burst_id: burst.burst_id });

  h.clock.t = ms(T0) + 25_000;
  await h.coordinator.flushEligible({ thread_key: THREAD });
  const after_first = { ...h.ledger.get("k1") };
  const alerts_after_first = h.alerts.length;

  // Second pass over the same generation: the row is already terminal.
  const second = await finalizeBurstConstituentLedger({
    supabase: h.ledger.supabase,
    burst: { burst_id: burst.burst_id, thread_key: THREAD, generation: burst.generation },
    result: { ok: true, queued: true },
    completeClaim: h.ledger.completeClaim,
  });
  assert.equal(second.finalized, 0, "nothing left to settle");
  assert.equal(
    h.ledger.get("k1").terminal_disposition,
    after_first.terminal_disposition,
    "the recorded decision must not change on replay"
  );
  assert.equal(h.alerts.length, alerts_after_first, "replay must not re-page");
});
