// ─── webhook-request-receipts.test.mjs ───────────────────────────────────────
// Route-level request-receipt audit layer:
//   * module contract — masked/hashed phones, hashed bodies (never raw),
//     canonical rejection vocabulary, bounded purge;
//   * route integration — every terminal outcome of the inbound webhook
//     (oversized, malformed/missing sender, strict signature reject, handler
//     accept, duplicate delivery, fail-closed claim, empty body) writes
//     exactly one durable receipt, and receipts never alter the response.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import "../helpers/critical-test-environment.mjs";

import {
  recordWebhookRequestReceipt,
  purgeExpiredWebhookRequestReceipts,
  maskPhoneForReceipt,
  digestBodyForReceipt,
  RECEIPT_REJECTION_REASONS,
} from "@/lib/domain/webhooks/webhook-request-receipts.js";

import {
  POST as postTextgridInbound,
  __setTextgridInboundRouteTestDeps,
  __resetTextgridInboundRouteTestDeps,
} from "@/app/api/webhooks/textgrid/inbound/route.js";

const INBOUND_URL = "http://localhost:3000/api/webhooks/textgrid/inbound";

// ── module contract ──────────────────────────────────────────────────────────

test("maskPhoneForReceipt keeps only country prefix + last four, plus a digest", () => {
  const masked = maskPhoneForReceipt("+16128072000");
  assert.equal(masked.masked, "+1******2000");
  assert.equal(
    masked.digest,
    crypto.createHash("sha256").update("+16128072000", "utf8").digest("hex")
  );
  assert.ok(!masked.masked.includes("807"), "middle digits must not survive");

  const junk = maskPhoneForReceipt("bob");
  assert.equal(junk.masked, null, "non-phone garbage is hash-only");
  assert.ok(junk.digest);

  const empty = maskPhoneForReceipt("");
  assert.equal(empty.masked, null);
  assert.equal(empty.digest, null);
});

test("digestBodyForReceipt never returns raw text", () => {
  const digest = digestBodyForReceipt("I want to sell my house at 123 Main St");
  assert.equal(digest.body_length, 38);
  assert.match(digest.body_sha256, /^[0-9a-f]{64}$/);
});

function makeCapturingSupabase() {
  const inserts = [];
  return {
    inserts,
    client: {
      from(table) {
        return {
          insert(row) {
            inserts.push({ table, row });
            return {
              select() {
                return {
                  single: async () => ({ data: { id: "receipt-1" }, error: null }),
                };
              },
            };
          },
        };
      },
    },
  };
}

test("recordWebhookRequestReceipt persists digests and masks, never raw content", async () => {
  const { inserts, client } = makeCapturingSupabase();
  const result = await recordWebhookRequestReceipt(
    {
      correlation_id: "corr-1",
      endpoint: "/api/webhooks/textgrid/inbound",
      provider_message_sid: "SMx1",
      from_phone: "+16128072000",
      to_phone: "+16128060495",
      raw_body: "Body=secret seller text&From=%2B16128072000",
      outcome: "rejected",
      rejection_reason: "invalid_signature",
      signature_status: "invalid",
      http_status: 401,
    },
    { supabase: client }
  );

  assert.equal(result.ok, true);
  assert.equal(inserts.length, 1);
  const row = inserts[0].row;
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes("secret seller text"), "raw body must never persist");
  assert.ok(!serialized.includes("16128072000"), "full phone must never persist");
  assert.equal(row.from_phone_masked, "+1******2000");
  assert.match(row.body_sha256, /^[0-9a-f]{64}$/);
  assert.equal(row.body_length, 43);
  assert.equal(row.outcome, "rejected");
  assert.equal(row.rejection_reason, "invalid_signature");
  assert.ok(row.retain_until, "retention deadline required");
});

test("rejected receipts require a canonical rejection reason", async () => {
  const { inserts, client } = makeCapturingSupabase();
  const bad = await recordWebhookRequestReceipt(
    {
      endpoint: "/x",
      outcome: "rejected",
      rejection_reason: "because_reasons",
      http_status: 400,
    },
    { supabase: client }
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid_rejection_reason");
  assert.equal(inserts.length, 0, "invalid receipts must write nothing");

  const bad_outcome = await recordWebhookRequestReceipt(
    { endpoint: "/x", outcome: "exploded", http_status: 500 },
    { supabase: client }
  );
  assert.equal(bad_outcome.ok, false);
  assert.equal(inserts.length, 0);
});

test("the canonical rejection vocabulary covers every launch-required reject class", () => {
  for (const required of [
    "invalid_signature",
    "missing_signature",
    "malformed_payload",
    "missing_sender",
    "missing_destination",
    "empty_body",
    "unsupported_media_only",
    "oversized_request",
    "unknown_provider_event",
    "authentication_failure",
    "parser_exception",
    "debug_stage_forbidden",
    "rate_limited",
    "internal_error",
    "inbound_claim_unavailable",
  ]) {
    assert.ok(
      RECEIPT_REJECTION_REASONS.includes(required),
      `missing canonical reason: ${required}`
    );
  }
});

test("purge is bounded select-then-delete with the ledger clamp contract", async () => {
  const deleted = [];
  const client = {
    from() {
      return {
        select() {
          return {
            lt() {
              return {
                order() {
                  return {
                    limit: async (n) => ({
                      data: Array.from({ length: Math.min(n, 3) }, (_, i) => ({
                        id: `r${i}`,
                      })),
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        },
        delete() {
          return {
            in: async (_col, ids) => {
              deleted.push(ids);
              return { error: null, count: ids.length };
            },
          };
        },
      };
    },
  };
  const result = await purgeExpiredWebhookRequestReceipts({ limit: 99999 }, { supabase: client });
  assert.equal(result.ok, true);
  assert.equal(result.purged, 3);
  assert.equal(deleted.length, 1);
});

// ── route integration ────────────────────────────────────────────────────────

function makeRouteDeps(receipts, overrides = {}) {
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    maybeHandleBuyerTextgridInboundImpl: async () => ({ ok: true, matched: false }),
    handleTextgridInboundImpl: async () => ({ ok: true, idempotency_key: "k" }),
    sendInboundSmsDiscordAlertImpl: async () => {},
    recordWebhookRequestReceiptImpl: async (args) => {
      receipts.push(args);
      return { ok: true, receipt_id: `r-${receipts.length}` };
    },
    ...overrides,
  };
}

function formRequest(params, headers = {}) {
  return new Request(INBOUND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(params),
  });
}

test("route: missing sender writes a rejected receipt with 400", async (t) => {
  const receipts = [];
  __setTextgridInboundRouteTestDeps(makeRouteDeps(receipts));
  t.after(() => __resetTextgridInboundRouteTestDeps());

  const response = await postTextgridInbound(
    formRequest({ Body: "hello", SmsStatus: "received" })
  );

  assert.equal(response.status, 400);
  assert.equal(receipts.length, 1, "exactly one receipt per request");
  assert.equal(receipts[0].outcome, "rejected");
  assert.equal(receipts[0].rejection_reason, "missing_sender");
  assert.equal(receipts[0].http_status, 400);
  assert.equal(receipts[0].endpoint, "/api/webhooks/textgrid/inbound");
  assert.ok(receipts[0].correlation_id);
});

test("route: unparseable body writes a malformed_payload receipt", async (t) => {
  const receipts = [];
  __setTextgridInboundRouteTestDeps(makeRouteDeps(receipts));
  t.after(() => __resetTextgridInboundRouteTestDeps());

  const response = await postTextgridInbound(
    new Request(INBOUND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json at all",
    })
  );

  assert.equal(response.status, 400);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, "rejected");
  assert.equal(receipts[0].rejection_reason, "malformed_payload");
});

test("route: oversized request is rejected with 413 and receipted before parsing", async (t) => {
  const receipts = [];
  let handler_called = false;
  __setTextgridInboundRouteTestDeps(
    makeRouteDeps(receipts, {
      handleTextgridInboundImpl: async () => {
        handler_called = true;
        return { ok: true };
      },
    })
  );
  t.after(() => __resetTextgridInboundRouteTestDeps());

  const big = "Body=" + "x".repeat(300 * 1024);
  const response = await postTextgridInbound(
    new Request(INBOUND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: big,
    })
  );

  assert.equal(response.status, 413);
  assert.equal(handler_called, false);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].rejection_reason, "oversized_request");
  assert.equal(receipts[0].http_status, 413);
});

test("route: strict-mode invalid signature writes an invalid_signature receipt with 401", async (t) => {
  const prev_mode = process.env.TEXTGRID_WEBHOOK_SIGNATURE_MODE;
  const prev_token = process.env.TEXTGRID_AUTH_TOKEN;
  process.env.TEXTGRID_WEBHOOK_SIGNATURE_MODE = "strict";
  process.env.TEXTGRID_AUTH_TOKEN = "test-auth-token";
  t.after(() => {
    if (prev_mode === undefined) delete process.env.TEXTGRID_WEBHOOK_SIGNATURE_MODE;
    else process.env.TEXTGRID_WEBHOOK_SIGNATURE_MODE = prev_mode;
    if (prev_token === undefined) delete process.env.TEXTGRID_AUTH_TOKEN;
    else process.env.TEXTGRID_AUTH_TOKEN = prev_token;
  });

  const receipts = [];
  __setTextgridInboundRouteTestDeps(makeRouteDeps(receipts));
  t.after(() => __resetTextgridInboundRouteTestDeps());

  const response = await postTextgridInbound(
    formRequest(
      {
        SmsMessageSid: "SM-receipt-strict",
        From: "+15550001234",
        To: "+15559876543",
        Body: "Hello",
        SmsStatus: "received",
      },
      { "x-textgrid-signature": "definitely-wrong" }
    )
  );

  assert.equal(response.status, 401);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, "rejected");
  assert.equal(receipts[0].rejection_reason, "invalid_signature");
  assert.equal(receipts[0].signature_status, "invalid");
  assert.equal(receipts[0].http_status, 401);
});

test("route: accepted inbound writes an accepted receipt carrying the idempotency key", async (t) => {
  const receipts = [];
  __setTextgridInboundRouteTestDeps(
    makeRouteDeps(receipts, {
      handleTextgridInboundImpl: async () => ({
        ok: true,
        idempotency_key: "textgrid_inbound:SM-accept",
        terminal_disposition: "no_reply_required",
      }),
    })
  );
  t.after(() => __resetTextgridInboundRouteTestDeps());

  const response = await postTextgridInbound(
    formRequest({
      SmsMessageSid: "SM-accept",
      From: "+15550001234",
      To: "+15559876543",
      Body: "Yes",
      SmsStatus: "received",
    })
  );

  assert.equal(response.status, 200);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, "accepted");
  assert.equal(receipts[0].idempotency_key, "textgrid_inbound:SM-accept");
  assert.equal(receipts[0].detail.terminal_disposition, "no_reply_required");
  const serialized = JSON.stringify(receipts[0]);
  assert.ok(receipts[0].raw_body.includes("Yes"), "digest input is passed through");
  assert.ok(!serialized.includes('"from_phone_masked"'), "masking happens in the module, not the route");
});

test("route: duplicate delivery writes a duplicate receipt with the prior disposition", async (t) => {
  const receipts = [];
  __setTextgridInboundRouteTestDeps(
    makeRouteDeps(receipts, {
      handleTextgridInboundImpl: async () => ({
        ok: true,
        duplicate: true,
        reason: "duplicate_completed_delivery",
        terminal_disposition: "duplicate_ignored",
        prior_disposition: "reply_sent",
        idempotency_key: "textgrid_inbound:SM-dup",
      }),
    })
  );
  t.after(() => __resetTextgridInboundRouteTestDeps());

  const response = await postTextgridInbound(
    formRequest({
      SmsMessageSid: "SM-dup",
      From: "+15550001234",
      To: "+15559876543",
      Body: "Yes",
      SmsStatus: "received",
    })
  );

  assert.equal(response.status, 200);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, "duplicate");
  assert.equal(receipts[0].detail.duplicate_reason, "duplicate_completed_delivery");
  assert.equal(receipts[0].detail.prior_disposition, "reply_sent");
});

test("route: fail-closed claim maps to 503 with an inbound_claim_unavailable receipt", async (t) => {
  const receipts = [];
  __setTextgridInboundRouteTestDeps(
    makeRouteDeps(receipts, {
      handleTextgridInboundImpl: async () => ({
        ok: false,
        reason: "claim_function_unavailable",
        fail_closed: true,
        retryable: true,
        retry_after_seconds: 30,
        idempotency_key: "textgrid_inbound:SM-fc",
      }),
    })
  );
  t.after(() => __resetTextgridInboundRouteTestDeps());

  const response = await postTextgridInbound(
    formRequest({
      SmsMessageSid: "SM-fc",
      From: "+15550001234",
      To: "+15559876543",
      Body: "Yes",
      SmsStatus: "received",
    })
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "30");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, "rejected");
  assert.equal(receipts[0].rejection_reason, "inbound_claim_unavailable");
  assert.equal(receipts[0].http_status, 503);
});

test("route: empty body refusal maps to an empty_body receipt", async (t) => {
  const receipts = [];
  __setTextgridInboundRouteTestDeps(
    makeRouteDeps(receipts, {
      handleTextgridInboundImpl: async () => ({
        ok: false,
        reason: "empty_inbound_body",
      }),
    })
  );
  t.after(() => __resetTextgridInboundRouteTestDeps());

  const response = await postTextgridInbound(
    formRequest({
      SmsMessageSid: "SM-empty",
      From: "+15550001234",
      To: "+15559876543",
      Body: "",
      SmsStatus: "received",
    })
  );

  assert.equal(response.status, 200);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, "rejected");
  assert.equal(receipts[0].rejection_reason, "empty_body");
});

test("route: a receipt write failure never changes the response", async (t) => {
  __setTextgridInboundRouteTestDeps(
    makeRouteDeps([], {
      recordWebhookRequestReceiptImpl: async () => {
        throw new Error("receipt store down");
      },
      handleTextgridInboundImpl: async () => ({ ok: true }),
    })
  );
  t.after(() => __resetTextgridInboundRouteTestDeps());

  const response = await postTextgridInbound(
    formRequest({
      SmsMessageSid: "SM-receipt-fail",
      From: "+15550001234",
      To: "+15559876543",
      Body: "Yes",
      SmsStatus: "received",
    })
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
});
