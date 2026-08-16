// Async recovery signature gate.
//
// The live inbound webhook route persists every inbound to webhook_log BEFORE the
// strict signature gate (so forged inbound is audited) and returns 401 for a bad
// signature. Without a gate, the every-2-minutes recovery cron
// (processInboundWebhookRecovery) would re-read that persisted-but-unverified
// row and re-enter seller-flow — silently undoing strict enforcement.
//
// Fix under test:
//   1. Producer: the route stamps the receipt-time verdict onto the persisted
//      row as payload.signature_status.
//   2. Recovery: processInboundWebhookRecovery only reprocesses rows whose
//      stamped verdict === "valid"; everything else is audited + retired.

import test from "node:test";
import assert from "node:assert/strict";

import { processInboundWebhookRecovery } from "@/lib/domain/webhooks/webhook-event-processor.js";
import {
  POST as postTextgridInbound,
  __setTextgridInboundRouteTestDeps,
  __resetTextgridInboundRouteTestDeps,
} from "@/app/api/webhooks/textgrid/inbound/route.js";
import { verifyTextgridWebhookRequest } from "@/lib/webhooks/textgrid-verify-webhook.js";

// Minimal chainable Supabase fake (same shape used across the critical suite).
function createFakeSupabase(respond, log = []) {
  return {
    from(table) {
      const ctx = { table, op: "select", filters: [], payload: null, single: false };
      const finish = () => {
        log.push(ctx);
        const out = respond(ctx) || {};
        return Promise.resolve({
          data: out.data !== undefined ? out.data : ctx.single ? null : [],
          error: out.error || null,
        });
      };
      const q = {
        select() { return q; },
        insert(p) { ctx.op = "insert"; ctx.payload = p; return q; },
        update(p) { ctx.op = "update"; ctx.payload = p; return q; },
        upsert(p) { ctx.op = "upsert"; ctx.payload = p; return q; },
        eq(c, v) { ctx.filters.push(["eq", c, v]); return q; },
        gt(c, v) { ctx.filters.push(["gt", c, v]); return q; },
        in(c, v) { ctx.filters.push(["in", c, v]); return q; },
        order() { return q; },
        limit() { return q; },
        maybeSingle() { ctx.single = true; return finish(); },
        single() { ctx.single = true; return finish(); },
        then(res, rej) { return finish().then(res, rej); },
      };
      return q;
    },
  };
}

function inboundWebhookRow(id, signature_status) {
  return {
    id,
    provider_message_sid: `SM_${id}`,
    event_type: "inbound",
    processed: false,
    direction: "inbound",
    created_at: "2026-08-15T00:00:00.000Z",
    payload: {
      from: "+13055376631",
      to: "+19048774448",
      message_id: `SM_${id}`,
      message_body: "Yes I still own it",
      direction: "inbound",
      ...(signature_status === undefined ? {} : { signature_status }),
    },
  };
}

function harness(rows) {
  const marked = [];
  const supabase = createFakeSupabase((ctx) => {
    if (ctx.table === "webhook_log" && ctx.op === "select") return { data: rows };
    if (ctx.table === "webhook_log" && ctx.op === "update") {
      const id = ctx.filters.find((f) => f[1] === "id")?.[2];
      marked.push({ id, processing_result: ctx.payload?.processing_result || null });
      return { data: { id } };
    }
    if (ctx.table === "message_events" && ctx.op === "select") return { data: null };
    return { data: null };
  });
  const state = { handlerCalls: 0, handledIds: [], marked };
  const deps = {
    supabase,
    handleTextgridInbound: async (payload) => {
      state.handlerCalls += 1;
      state.handledIds.push(payload.message_id);
      return { ok: true };
    },
  };
  return { deps, state };
}

// ── Requirement 1: forged/invalid-signature inbound is never recovered ────────
test("recovery gate: forged/invalid inbound is audited but never re-enters seller-flow", async () => {
  const { deps, state } = harness([inboundWebhookRow("forged", "invalid")]);
  const outcome = await processInboundWebhookRecovery({ limit: 10 }, deps);

  assert.equal(state.handlerCalls, 0, "seller-flow handler must not run for a forged inbound");
  assert.equal(outcome.processed, 0);
  assert.equal(outcome.skipped_unverified, 1);
  const r = outcome.results.find((x) => x.webhook_log_id === "forged");
  assert.equal(r.reason, "signature_not_verified");
  assert.equal(r.signature_status, "invalid");
  // audited + retired (marked processed so it is never re-scanned)
  const audit = state.marked.find((m) => m.id === "forged");
  assert.ok(audit, "forged row must be marked/retired");
  assert.equal(audit.processing_result.status, "signature_rejected");
  assert.equal(audit.processing_result.signature_status, "invalid");
});

// ── Requirement 2: valid verified inbound remains recoverable ─────────────────
test("recovery gate: valid verified inbound is still reprocessed by seller-flow", async () => {
  const { deps, state } = harness([inboundWebhookRow("good", "valid")]);
  const outcome = await processInboundWebhookRecovery({ limit: 10 }, deps);

  assert.equal(state.handlerCalls, 1, "verified inbound must be reprocessed");
  assert.deepEqual(state.handledIds, ["SM_good"]);
  assert.equal(outcome.processed, 1);
  assert.equal(outcome.skipped_unverified, 0);
});

// ── Requirement 3: observe/off-window bypassed events never recover under strict
test("recovery gate: observe/off bypassed inbound is not recoverable under strict", async () => {
  const { deps, state } = harness([
    inboundWebhookRow("obs", "skipped_mode_off"),
    inboundWebhookRow("off", "skipped_log_only"),
  ]);
  const outcome = await processInboundWebhookRecovery({ limit: 10 }, deps);

  assert.equal(state.handlerCalls, 0, "bypassed inbound must never re-enter seller-flow");
  assert.equal(outcome.processed, 0);
  assert.equal(outcome.skipped_unverified, 2);
});

// ── Requirement 1 (missing/unverified): fail closed on absent verdict ─────────
test("recovery gate: missing or absent signature verdict is fail-closed", async () => {
  const { deps, state } = harness([
    inboundWebhookRow("missing", "missing"),
    inboundWebhookRow("legacy", undefined), // pre-fix row with no stamped field
  ]);
  const outcome = await processInboundWebhookRecovery({ limit: 10 }, deps);

  assert.equal(state.handlerCalls, 0);
  assert.equal(outcome.skipped_unverified, 2);
  const legacy = outcome.results.find((x) => x.webhook_log_id === "legacy");
  assert.equal(legacy.signature_status, "unverified");
});

// ── Mixed batch: only the verified-valid row is reprocessed ───────────────────
test("recovery gate: mixed batch reprocesses only the verified-valid inbound", async () => {
  const { deps, state } = harness([
    inboundWebhookRow("v", "valid"),
    inboundWebhookRow("i", "invalid"),
  ]);
  const outcome = await processInboundWebhookRecovery({ limit: 10 }, deps);

  assert.equal(state.handlerCalls, 1);
  assert.deepEqual(state.handledIds, ["SM_v"]);
  assert.equal(outcome.processed, 1);
  assert.equal(outcome.skipped_unverified, 1);
});

// ── Producer: the route persists the verdict onto webhook_log (so recovery can gate)
test("producer: strict-rejected inbound is 401 and persisted with signature_status=invalid", async (t) => {
  const prevMode = process.env.TEXTGRID_WEBHOOK_SIGNATURE_MODE;
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.TEXTGRID_WEBHOOK_SIGNATURE_MODE = "strict";
  process.env.SUPABASE_URL = "https://placeholder.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder-service-role-key";

  let captured = null;
  let handler_ran = false;
  __setTextgridInboundRouteTestDeps({
    verifyTextgridWebhookRequestImpl: (opts) =>
      verifyTextgridWebhookRequest({ ...opts, webhook_secret: "wh-secret-xyz" }),
    writeWebhookLogImpl: async (row) => {
      captured = row;
      return { id: "wh_captured" };
    },
    recordWebhookRequestReceiptImpl: async () => {},
    sendInboundSmsDiscordAlertImpl: async () => {},
    handleTextgridInboundImpl: async () => {
      handler_ran = true;
      return { ok: true };
    },
    maybeHandleBuyerTextgridInboundImpl: async () => ({ ok: true, matched: false }),
    processInboundWebhookLiveImpl: async () => {
      handler_ran = true;
      return { ok: true };
    },
  });

  t.after(() => {
    __resetTextgridInboundRouteTestDeps();
    if (prevMode === undefined) delete process.env.TEXTGRID_WEBHOOK_SIGNATURE_MODE;
    else process.env.TEXTGRID_WEBHOOK_SIGNATURE_MODE = prevMode;
    if (prevUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });

  const response = await postTextgridInbound(
    new Request("http://localhost:3000/api/webhooks/textgrid/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-textgrid-signature": "definitely-a-forged-signature",
      },
      body: new URLSearchParams({
        SmsMessageSid: "SM_producer_forged",
        From: "+15550001234",
        To: "+15559876543",
        Body: "forged inbound",
        SmsStatus: "received",
      }),
    })
  );

  assert.equal(response.status, 401, "forged inbound must be rejected");
  assert.equal(handler_ran, false, "forged inbound must not reach any downstream handler");
  assert.ok(captured, "the inbound must still be persisted to webhook_log for audit");
  assert.equal(captured.direction, "inbound");
  assert.equal(
    captured.payload.signature_status,
    "invalid",
    "webhook_log must carry the invalid verdict so recovery can fail closed"
  );
  assert.equal(captured.payload.signature_verified, false);
});
