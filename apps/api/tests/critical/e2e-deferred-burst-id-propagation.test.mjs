/**
 * The deferred burst ID must SURVIVE the whole chain:
 *
 *   webhook -> burst coordinator -> terminal resolver -> markInboundAwaitingBurst
 *           -> exact stored burst ID -> exact constituent finalization
 *
 * Nothing here injects the expected burst ID. The ID is generated inside the
 * burst store, read back out of the store, and only then compared against what
 * the ledger recorded. Injecting it would prove the assertion, not the wiring.
 *
 * Why it matters: an inbound handed to the burst layer is parked at
 * status='processing' with `awaiting_burst_finalization` in disposition_detail.
 * finalizeBurstConstituentLedger adopts constituents by EXACT burst_id match
 * (finalize-burst-constituent-ledger.js:88-92). If the deferred result does not
 * expose burst_id, the resolver writes detail.burst_id = null, the row is parked
 * UNASSOCIATED, and no burst can ever adopt it — the 2026-08-03 shape again: a
 * decision nobody records, invisible because the row looks like a deliberate wait.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { createSellerInboundBurstCoordinator } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import { finalizeBurstConstituentLedger } from "@/lib/domain/seller-flow/finalize-burst-constituent-ledger.js";
import { resolveInboundTerminalDisposition } from "@/lib/domain/inbound/terminal-disposition.js";
import { AWAITING_BURST_DETAIL_KEY } from "@/lib/domain/inbound/inbound-processing-ledger.js";
import { TERMINAL_DISPOSITIONS } from "@/lib/domain/inbound/terminal-disposition.js";
import { classify } from "@/lib/domain/classification/classify.js";
import {
  resolveAskingPriceSignal,
  extractMonetaryMentions,
} from "@/lib/domain/seller-flow/monetary-understanding.js";

const THREAD = "+15550100455";
const T0 = "2026-08-04T10:00:00.000Z";
const ms = (iso) => new Date(iso).getTime();

// ── harness ─────────────────────────────────────────────────────────────────

function ledgerStore() {
  const rows = [];
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
          if (table !== "inbound_processing_ledger") return resolve({ data: [], error: null });
          const data = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
          return resolve({ data: data.map((r) => ({ ...r })), error: null });
        },
      };
      return node;
    },
  };
  return {
    rows,
    supabase,
    get: (key) => rows.find((r) => r.idempotency_key === key) || null,
    /** The ledger writer the webhook calls for a PENDING (burst-deferred) inbound. */
    markAwaiting({ idempotency_key, burst_id, detail, processing_run_id }) {
      rows.push({
        id: `row-${idempotency_key}`,
        idempotency_key,
        processing_run_id,
        thread_key: THREAD,
        status: "processing",
        terminal_disposition: null,
        disposition_detail: { ...(detail || {}), [AWAITING_BURST_DETAIL_KEY]: true, burst_id },
      });
      return { ok: true, awaiting_burst: true };
    },
    completeClaim({ idempotency_key, disposition }) {
      const row = rows.find((r) => r.idempotency_key === idempotency_key);
      if (!row || row.status !== "processing") return { ok: false, reason: "not_processing" };
      row.status = "completed";
      row.terminal_disposition = disposition;
      return { ok: true };
    },
  };
}

function burstHarness({
  processResult = null,
  finalizeImpl = null,
  onProcess = null,
  refuseKeys = [],
} = {}) {
  const state = { clock: ms(T0) };
  const now = () => new Date(state.clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const ledger = ledgerStore();
  const alerts = [];

  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    supabase: ledger.supabase,
    processSellerInboundMessage: async () => {
      if (onProcess) await onProcess({ coordinator, store, ledger, now });
      return processResult || { ok: true, queued: true, execution: { queued: true } };
    },
    finalizeConstituentLedger: finalizeImpl || finalizeBurstConstituentLedger,
    // A refused key models a row the ledger will not terminalize (claim fenced
    // by another worker). The row is still FOUND by the finalizer's select —
    // that is what makes it a partial finalization rather than a no-op.
    completeInboundProcessingClaim: (args) =>
      refuseKeys.includes(args.idempotency_key)
        ? { ok: false, reason: "claim_fenced" }
        : ledger.completeClaim(args),
    alertBurstFailure: async (payload) => {
      alerts.push(payload);
    },
  });

  return { state, store, ledger, coordinator, alerts, now };
}

/**
 * Models the webhook's deferred-burst result assembly
 * (handle-textgrid-inbound.js:2338 captures deferred_burst_id, :3071 exposes it
 * at the top level) WITHOUT hardcoding the ID — it is read from the coordinator's
 * own return value, which is where production reads it too.
 */
function webhookResultFor(burst_deferral, classification) {
  return {
    ok: true,
    classification,
    burst_id: burst_deferral?.append?.burst?.burst_id || null,
    seller_stage_reply: { queued: false, reason: "deferred_to_burst_flush", plan: {} },
  };
}

// ── ADDITION 1: the ID survives the whole chain ─────────────────────────────

test("a deferred inbound is parked under the EXACT burst ID the store generated", async () => {
  const h = burstHarness();

  // 1. The webhook hands the inbound to the burst layer.
  const classification = await classify("Yeah", null, { heuristicOnly: true });
  const deferral = await h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: "evt-1",
    provider_message_id: "SM-evt-1",
    body: "Yeah",
    classification,
    received_at: h.now(),
  });
  assert.equal(deferral.deferred, true, "the decision was handed to the burst layer");

  // The ID is whatever the STORE minted. Never asserted against a literal.
  const stored = await h.store.getOpen(THREAD);
  assert.ok(stored?.burst_id, "the store minted a burst id");

  // 2. The terminal resolver must carry that ID through to the pending detail.
  const resolved = resolveInboundTerminalDisposition(webhookResultFor(deferral, classification));
  assert.equal(resolved.pending, true, "a burst handoff is pending, never terminal");
  assert.equal(
    resolved.detail.burst_id,
    stored.burst_id,
    "the resolver must expose the real burst id, not null"
  );

  // 3. The ledger row is parked under that same ID.
  h.ledger.markAwaiting({
    idempotency_key: "k1",
    burst_id: resolved.detail.burst_id,
    detail: resolved.detail,
    processing_run_id: "run-1",
  });
  assert.equal(h.ledger.get("k1").disposition_detail.burst_id, stored.burst_id);

  // 4. And the burst that eventually completes adopts it by exact match.
  h.state.clock = ms(T0) + 25_000;
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  assert.equal(flush.results[0].ledger_finalization.finalized, 1, "the constituent was adopted");

  const row = h.ledger.get("k1");
  assert.equal(row.status, "completed");
  assert.equal(row.terminal_disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
  assert.equal(row.disposition_detail.burst_id, stored.burst_id, "settled under the same id it was parked under");
});

test("a null burst id would strand the row — the resolver must never produce one", async () => {
  // The defect this guards: if the deferred result does not expose burst_id, the
  // pending row is written unassociated and NO burst can ever adopt it, because
  // finalization matches on exact id.
  const h = burstHarness();
  const classification = await classify("Yeah", null, { heuristicOnly: true });
  const deferral = await h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: "evt-1",
    provider_message_id: "SM-evt-1",
    body: "Yeah",
    classification,
    received_at: h.now(),
  });
  const stored = await h.store.getOpen(THREAD);

  const resolved = resolveInboundTerminalDisposition(webhookResultFor(deferral, classification));
  assert.notEqual(resolved.detail.burst_id, null, "a null id here is the defect");

  // Demonstrate the consequence concretely: a row parked with a null id is
  // invisible to the burst that owns it.
  h.ledger.markAwaiting({ idempotency_key: "orphan", burst_id: null, detail: {}, processing_run_id: "run-x" });
  h.ledger.markAwaiting({
    idempotency_key: "k1",
    burst_id: resolved.detail.burst_id,
    detail: resolved.detail,
    processing_run_id: "run-1",
  });

  h.state.clock = ms(T0) + 25_000;
  await h.coordinator.flushEligible({ thread_key: THREAD });

  assert.equal(h.ledger.get("k1").status, "completed", "the correctly-associated row settles");
  assert.equal(
    h.ledger.get("orphan").status,
    "processing",
    "an unassociated row can never be adopted — which is why the id must travel"
  );
  assert.equal(h.ledger.get("orphan").terminal_disposition, null);
  assert.notEqual(stored.burst_id, null);
});

// ── ADDITION 2: the finalizer throwing must stay loud ───────────────────────

test("a throwing finalizer keeps the burst outcome explicit and never reports success", async () => {
  const h = burstHarness({
    finalizeImpl: async () => {
      throw new Error("ledger unreachable");
    },
  });

  const classification = await classify("Yeah", null, { heuristicOnly: true });
  await h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: "evt-1",
    provider_message_id: "SM-evt-1",
    body: "Yeah",
    classification,
    received_at: h.now(),
  });
  const stored = await h.store.getOpen(THREAD);
  h.ledger.markAwaiting({ idempotency_key: "k1", burst_id: stored.burst_id, detail: {}, processing_run_id: "run-1" });

  h.state.clock = ms(T0) + 25_000;
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  const result = flush.results[0];

  // The burst outcome is still explicit — the throw is caught, not swallowed
  // into an exception that loses the burst.
  assert.equal(result.ok, true, "the burst itself completed");
  assert.ok(result.burst?.burst_id, "and its terminal record is real");

  // The ledger failure is explicit and structured, not silently absent.
  assert.ok(result.ledger_finalization, "the failure must be reported, not omitted");
  assert.equal(result.ledger_finalization.ok, false, "a thrown finalizer is NOT success");
  assert.equal(result.ledger_finalization.reason, "ledger_finalization_threw");
  assert.ok(result.ledger_finalization.message, "the cause is carried");

  // And the pending row does NOT look finalized.
  const row = h.ledger.get("k1");
  assert.equal(row.status, "processing", "an unsettled row must still read as unsettled");
  assert.equal(row.terminal_disposition, null, "no disposition may be invented on failure");
  assert.equal(row.disposition_detail[AWAITING_BURST_DETAIL_KEY], true, "it stays retryable");
});

test("partial finalization alerts rather than passing silently", async () => {
  // One row settles, one cannot. The outcome must be reported as NOT ok and an
  // alert must fire — a half-settled burst is the shape that hides worst.
  const h = burstHarness({ refuseKeys: ["k2"] });
  const classification = await classify("Yeah", null, { heuristicOnly: true });
  await h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: "evt-1",
    provider_message_id: "SM-evt-1",
    body: "Yeah",
    classification,
    received_at: h.now(),
  });
  const stored = await h.store.getOpen(THREAD);
  h.ledger.markAwaiting({ idempotency_key: "k1", burst_id: stored.burst_id, detail: {}, processing_run_id: "run-1" });
  h.ledger.markAwaiting({ idempotency_key: "k2", burst_id: stored.burst_id, detail: {}, processing_run_id: "run-2" });

  h.state.clock = ms(T0) + 25_000;
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  const finalization = flush.results[0].ledger_finalization;

  assert.equal(finalization.ok, false, "partial finalization is not success");
  assert.equal(finalization.finalized, 1);
  assert.equal(finalization.pending, 1);
  assert.equal(h.alerts.length, 1, "partial finalization must alert");
  assert.equal(h.alerts[0].partial_ledger_finalization, true);
  assert.equal(h.alerts[0].pending_count, 1);
});

// ── ADDITION 3: cross-domain scenarios ──────────────────────────────────────

test("an appointment the seller already has is neither a call request nor a price", async () => {
  const result = await classify("I have a scheduled call at 3pm", null, { heuristicOnly: true });
  const intents = [result.primary_intent, ...(result.secondary_intents || [])];
  assert.equal(
    intents.includes("callback_requested"),
    false,
    "reporting an existing appointment does not request contact"
  );
  assert.equal(
    intents.includes("asking_price_provided"),
    false,
    '"at 3pm" is a time, not an asking price'
  );
  assert.equal(resolveAskingPriceSignal("I have a scheduled call at 3pm", {})?.asking_price ?? null, null);
});

test("an offer of availability IS a call request, and still not a price", async () => {
  const result = await classify("You can call me at 3pm", null, { heuristicOnly: true });
  const intents = [result.primary_intent, ...(result.secondary_intents || [])];
  assert.ok(intents.includes("callback_requested"), `expected a call request, got ${JSON.stringify(intents)}`);
  assert.equal(intents.includes("asking_price_provided"), false, '"at 3pm" is still not money');
  assert.equal(resolveAskingPriceSignal("You can call me at 3pm", {})?.asking_price ?? null, null);
});

test("a directional word after a priced number does not turn it into an address", () => {
  // The compass-direction skip was added so "4157 S Main St" reads as an
  // address. It must not swallow a real price that happens to be followed by a
  // direction word. Every case below carries genuine monetary evidence.
  for (const [message, expected] of [
    ["I want 300k East of the drive", 300000],
    ["I want $300,000 East of the drive", 300000],
    ["I'd take 250k South of the highway", 250000],
    ["I want 300k North of town", 300000],
    ["my price is $250,000 west of here", 250000],
  ]) {
    assert.equal(
      resolveAskingPriceSignal(message, {})?.asking_price?.value ?? null,
      expected,
      `${JSON.stringify(message)} states a real price`
    );
  }
});

test("a directional phrase after a number is preserved AT THE MENTION LEVEL", () => {
  // The third measurement of this string, and the one an asking-price probe
  // cannot see. extractMonetaryMentions is upstream of the asking-price
  // qualification rule, so it shows the direction guard's effect directly:
  //   "I want 300 East of the drive"   41edd220 []  ->  HEAD ["asking_price:300"]
  // Pinned because the no-reference asking-price path is null on BOTH trees and
  // therefore cannot detect a regression of bdf58c1d on its own.
  for (const message of [
    "I want 300 East of the drive",
    "I want 300 North of town",
    "I want 300 west of here",
  ]) {
    const kinds = extractMonetaryMentions(message, {}).map((m) => `${m.kind}:${m.value}`);
    assert.deepEqual(
      kinds,
      ["asking_price:300"],
      `${JSON.stringify(message)} must still yield the mention`
    );
  }
});

test("a directional phrase after a scaled price is preserved", () => {
  // Three-way measured (eeee5bd8 / 41edd220 / HEAD) with a reference supplied,
  // which is the form the negotiation path uses:
  //   "I want 300 East of the drive"  300000 -> null -> 300000
  // The middle column is the direction-skip regression; the right column is
  // bdf58c1d fixing it. Pinned so it cannot silently regress a second time.
  for (const message of [
    "I want 300 East of the drive",
    "I want 300 North of town",
    "I want 300 west of here",
  ]) {
    assert.equal(
      resolveAskingPriceSignal(message, { reference: 200000 })?.asking_price?.value ?? null,
      300000,
      `${JSON.stringify(message)} is a price with a direction phrase after it`
    );
  }
});

test("PRE-EXISTING: an unscaled bare number is not money, with or without a direction", () => {
  // Narrower than an earlier revision of this test claimed. WITHOUT a reference
  // these are null on eeee5bd8, on 41edd220 and on HEAD alike — a bare
  // sub-thousand number carrying no currency symbol, thousands separator or
  // scale suffix has never qualified. That is a property of the qualification
  // rule, not of the direction skip.
  for (const message of [
    "I want 300 East of the drive",
    "I want 300 North of town",
    "I want 300 west of here",
  ]) {
    assert.equal(
      resolveAskingPriceSignal(message, {})?.asking_price ?? null,
      null,
      `CURRENT AND BASELINE BEHAVIOUR for ${JSON.stringify(message)} with no reference`
    );
  }
});

test("KNOWN DEFECT: a price ending in a capitalized compass direction is dropped (residual of the direction skip, PR #66)", () => {
  // Characterizes CURRENT behaviour so it flips loudly when fixed.
  //
  // MEASURED REGRESSION, still live after bdf58c1d. With a reference supplied:
  //   "I want 300 East"       eeee5bd8 300000 -> HEAD null
  //   "I want 300 South"      eeee5bd8 300000 -> HEAD null
  //   "I'd take 250 North"    eeee5bd8 250000 -> HEAD null
  //   "my price is 300 East"  eeee5bd8 300000 -> HEAD null
  //
  // Root cause is the capitalized-proper-noun branch of isAddressAdjacent
  // (/^[A-ZÀ-Ý][a-zà-ÿ]{2,}$/), the same branch behind the "Net" family: a
  // capitalized full-word direction at the end of the message looks like a
  // street name because nothing follows it to disambiguate. bdf58c1d fixed the
  // case where a phrase FOLLOWS the direction; the trailing form is untouched.
  //
  // Bounded honestly — these do NOT regress, which is what isolates the trigger
  // to a capitalized, multi-letter, trailing direction:
  //   "I want 300 west" (lowercase)          300000, unchanged
  //   "I want 300 E" (single letter)         300000, unchanged
  //   "I want 300 South of the river"        300000, unchanged
  //   "I want 300 East side"                 300000, unchanged
  for (const message of ["I want 300 East", "I want 300 South", "I'd take 250 North", "my price is 300 East"]) {
    assert.equal(
      resolveAskingPriceSignal(message, { reference: 200000 })?.asking_price ?? null,
      null,
      `CURRENT BEHAVIOUR (regressed from baseline) for ${JSON.stringify(message)}`
    );
  }

  // The bounding cases must keep working — if one of these breaks, the fix for
  // the above over-corrected.
  for (const [message, expected] of [
    ["I want 300 west", 300000],
    ["I want 300 E", 300000],
    ["I want 300 South of the river", 300000],
    ["I want 300 East side", 300000],
  ]) {
    assert.equal(
      resolveAskingPriceSignal(message, { reference: 200000 })?.asking_price?.value ?? null,
      expected,
      `${JSON.stringify(message)} must keep extracting`
    );
  }
});

test("a direction-prefixed street number is still not money", () => {
  assert.equal(resolveAskingPriceSignal("4157 S Main St", {})?.asking_price ?? null, null);
});

test("a successor burst is untouched by the generation that was claimed", async () => {
  const successor = {};

  // The successor must be created INSIDE the claimed window. Appending before
  // the flush would simply join the still-open generation 1 rather than opening
  // a new one — the claim is what closes generation 1 to further appends.
  const h = burstHarness({
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
      ledger.markAwaiting({
        idempotency_key: "k2",
        burst_id: successor.burst_id,
        detail: {},
        processing_run_id: "run-2",
      });
    },
  });

  const classification = await classify("Yeah", null, { heuristicOnly: true });
  await h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: "evt-1",
    provider_message_id: "SM-evt-1",
    body: "Yeah",
    classification,
    received_at: h.now(),
  });
  const claimed = await h.store.getOpen(THREAD);
  h.ledger.markAwaiting({ idempotency_key: "k1", burst_id: claimed.burst_id, detail: {}, processing_run_id: "run-1" });

  h.state.clock = ms(T0) + 25_000;
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });

  assert.ok(successor.burst_id, "a successor generation exists");
  assert.notEqual(successor.burst_id, claimed.burst_id, "and it is a different burst");
  assert.equal(successor.generation, claimed.generation + 1, "and a later generation");
  assert.equal(flush.results[0].burst.burst_id, claimed.burst_id, "settlement targeted the claimed burst");

  assert.equal(h.ledger.get("k1").status, "completed", "the claimed generation settled its own row");
  assert.equal(h.ledger.get("k1").terminal_disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
  assert.equal(h.ledger.get("k2").status, "processing", "the successor's row is untouched");
  assert.equal(h.ledger.get("k2").terminal_disposition, null);
  assert.equal(h.ledger.get("k2").disposition_detail.burst_id, successor.burst_id);
});
