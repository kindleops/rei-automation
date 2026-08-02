// ─── inbound-idempotency-key.test.mjs ────────────────────────────────────────
// No-SID idempotency contract for the durable inbound ledger key:
//   * an internal retry of the SAME request derives the SAME key — the receipt
//     instant comes only from provider/route-supplied payload fields (the
//     webhook route stamps http_received_at once and persists it with the
//     payload), never from new Date() inside the handler;
//   * the same text received again later (a new HTTP receipt) derives a
//     DIFFERENT key, so two genuine "yes" messages never collapse into one
//     ledger row;
//   * the provider-SID path is unchanged.

import test from "node:test";
import assert from "node:assert/strict";

import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";

async function captureLedgerBegin(payload) {
  const begins = [];
  __setTextgridInboundTestDeps({
    beginInboundLedgerEntry: async (args) => {
      begins.push(args);
      return { ok: true, ledger_id: `ledger-${begins.length}` };
    },
    recordInboundTerminalDisposition: async () => ({ ok: true }),
    getSystemFlags: async () => ({}),
    getSystemValue: async () => null,
  });
  try {
    // handler_entry short-circuits the core after flag resolution: these tests
    // exercise only the wrapper's key derivation, not inbound processing.
    const result = await handleTextgridInboundWebhook(payload, {
      inbound_debug_stage: "handler_entry",
    });
    assert.equal(result.ok, true);
  } finally {
    __resetTextgridInboundTestDeps();
  }
  assert.equal(begins.length, 1);
  return begins[0];
}

const NOSID_PREFIX = "textgrid_inbound:nosid:";

test("an internal retry of the same no-SID request derives the same key", async () => {
  const request = {
    from: "+15550000001",
    to: "+15550000002",
    message_body: "yes",
    // Stamped once by the webhook route at HTTP receipt and persisted with the
    // payload — a replay/retry of the same request carries the same value.
    http_received_at: "2026-08-01T12:00:00.000Z",
  };

  const first = await captureLedgerBegin({ ...request });
  const retry = await captureLedgerBegin({ ...request });

  assert.ok(first.idempotency_key.startsWith(NOSID_PREFIX));
  assert.equal(first.idempotency_key, retry.idempotency_key);
  // Caller contract: the ledger receives the raw body for digesting (it never
  // persists the text) plus the receipt instant for retention anchoring.
  assert.equal(first.message_body, "yes");
  assert.equal(first.message_preview, undefined);
  assert.equal(first.received_at, "2026-08-01T12:00:00.000Z");
});

test("the same text received again later derives a different key", async () => {
  const base = {
    from: "+15550000001",
    to: "+15550000002",
    message_body: "yes",
  };

  const first = await captureLedgerBegin({
    ...base,
    http_received_at: "2026-08-01T12:00:00.000Z",
  });
  const second = await captureLedgerBegin({
    ...base,
    http_received_at: "2026-08-01T12:05:00.000Z",
  });

  assert.ok(first.idempotency_key.startsWith(NOSID_PREFIX));
  assert.ok(second.idempotency_key.startsWith(NOSID_PREFIX));
  assert.notEqual(first.idempotency_key, second.idempotency_key);
});

test("without any receipt field the no-SID key stays stable across retries", async () => {
  // Degenerate direct-invocation shape (no route normalization): the key must
  // not include new Date() — an internal retry still derives the same key.
  const request = {
    from: "+15550000001",
    to: "+15550000002",
    message_body: "yes",
  };

  const first = await captureLedgerBegin({ ...request });
  const retry = await captureLedgerBegin({ ...request });

  assert.ok(first.idempotency_key.startsWith(NOSID_PREFIX));
  assert.equal(first.idempotency_key, retry.idempotency_key);
  assert.equal(first.received_at, null);
});

test("the provider SID path is unchanged by receipt timestamps", async () => {
  const first = await captureLedgerBegin({
    message_id: "SM123",
    from: "+15550000001",
    to: "+15550000002",
    message_body: "yes",
    http_received_at: "2026-08-01T12:00:00.000Z",
  });
  const later = await captureLedgerBegin({
    message_id: "SM123",
    from: "+15550000001",
    to: "+15550000002",
    message_body: "yes",
    http_received_at: "2026-08-01T13:00:00.000Z",
  });

  assert.equal(first.idempotency_key, "textgrid_inbound:SM123");
  assert.equal(later.idempotency_key, "textgrid_inbound:SM123");
  assert.equal(first.provider_message_sid, "SM123");
});
