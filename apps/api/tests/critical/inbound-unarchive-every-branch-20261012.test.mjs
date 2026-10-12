/**
 * "A reply always unarchives" (owner rule). 542f27d2 (+16128072000, scope NULL)
 * was archived 09-04, got an inbound 10-07 13:14Z and stayed archived.
 * Read-only investigation: the stored key EQUALS the inbound key; the inbound
 * had no seller context and returned through the unknown-router branch before
 * the un-archive step. Both branches now un-archive through one helper, which
 * also finds a row stored under another key format (canonical_e164), keeps
 * identity_alignment rows archived, and logs when no row matches.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { unarchiveThreadOnInbound } from "@/lib/flows/inbound-thread-unarchive.js";
import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";
import { createInMemoryIdempotencyLedger } from "../helpers/test-helpers.js";

function stateDb(rows) {
  return {
    rows,
    from(table) {
      assert.equal(table, "inbox_thread_state");
      const filters = [];
      const q = {
        select: () => q,
        eq: (col, val) => { filters.push((r) => String(r[col] ?? "") === String(val)); return q; },
        limit: () => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }),
      };
      return q;
    },
  };
}
const patcher = () => {
  const calls = [];
  return { calls, patch: async (args) => { calls.push(args); return { ok: true }; } };
};

test("a stored key in a different format from inbound_from still unarchives (canonical_e164)", async () => {
  const db = stateDb([{ thread_key: "6128072000", canonical_e164: "+16128072000", is_archived: true, archive_scope: null }]);
  const p = patcher();
  const out = await unarchiveThreadOnInbound({ supabase: db, inboundFrom: "+16128072000", patch: p.patch });
  assert.deepEqual(out.unarchived, ["6128072000"]);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].threadKey, "6128072000");
  assert.deepEqual(p.calls[0].patch, { is_archived: false, archive_scope: null });
  assert.equal(p.calls[0].meta.matched_by, "canonical_e164");
  assert.equal(p.calls[0].meta.source_view, "inbound_auto_unarchive");
});

test("the 542f27d2 shape: exact key, NULL scope → unarchived; its identity_alignment twin stays archived", async () => {
  const db = stateDb([
    { thread_key: "+16128072000", canonical_e164: "+16128072000", is_archived: true, archive_scope: null },
    { thread_key: "6128072000", canonical_e164: "+16128072000", is_archived: true, archive_scope: "identity_alignment" },
  ]);
  const p = patcher();
  const out = await unarchiveThreadOnInbound({ supabase: db, inboundFrom: "+16128072000", patch: p.patch });
  assert.deepEqual(out.unarchived, ["+16128072000"]);
  assert.equal(p.calls.length, 1, "the exact row wins; the alias identity row is not touched");
  const alias = stateDb([{ thread_key: "6128072000", canonical_e164: "+16128072000", is_archived: true, archive_scope: "identity_alignment" }]);
  const q = patcher();
  const kept = await unarchiveThreadOnInbound({ supabase: alias, inboundFrom: "+16128072000", patch: q.patch });
  assert.deepEqual(kept.preserved, ["6128072000"]);
  assert.equal(q.calls.length, 0);
});

test("no matching row is logged, never silent", async () => {
  const logs = [];
  const out = await unarchiveThreadOnInbound({ supabase: stateDb([]), inboundFrom: "+16125550000", patch: async () => assert.fail("no patch"), log: (event, data) => logs.push({ event, data }) });
  assert.equal(out.reason, "no_thread_row");
  assert.equal(logs[0].event, "textgrid.inbound_unarchive_no_thread_row");
});

test("an inbound with NO seller context (unknown router) still unarchives its thread", async (t) => {
  const ledger = createInMemoryIdempotencyLedger();
  const calls = [];
  __setTextgridInboundTestDeps({
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (value) => value,
    getSupabaseClient: () => ({ from: () => { const q = { select: () => q, in: () => q, eq: () => q, limit: () => Promise.resolve({ data: [], error: null }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }; return q; } }),
    loadContextWithFallback: async () => ({ found: false, reason: "context_not_found" }),
    handleUnknownInboundRouter: async () => ({ ok: true, unknown_router: { bucket: "UNCLEAR_UNKNOWN" } }),
    logInboundMessageEvent: async () => ({ item_id: null }),
    unarchiveThreadOnInbound: async (args) => { calls.push(args); return { ok: true, matched: 1, unarchived: [args.inboundFrom], preserved: [] }; },
    info: () => {},
    warn: () => {},
  });
  t.after(() => __resetTextgridInboundTestDeps());
  const result = await handleTextgridInboundWebhook({ SmsMessageSid: "SM-unknown-archived", From: "+16128072000", To: "+13149268488", Body: "Inbound test", SmsStatus: "received" }, {});
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, "the unknown branch ran the un-archive");
  assert.equal(calls[0].inboundFrom, "+16128072000");
  assert.equal(calls[0].branch, "unknown_context");
});
