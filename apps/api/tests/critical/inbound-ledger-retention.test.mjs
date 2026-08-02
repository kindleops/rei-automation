// ─── inbound-ledger-retention.test.mjs ───────────────────────────────────────
// PII minimization + retention + durable-write truthfulness for the inbound
// processing ledger:
//   * begin persists a SHA-256 digest + length, never raw seller text, and
//     anchors retain_until at receipt + INBOUND_LEDGER_RETENTION_DAYS;
//   * a terminal-disposition update that matched zero rows reports
//     { ok: false, reason: "ledger_row_missing" } — never a silent success;
//   * the handler wrapper surfaces that failure and raises the P0
//     inbound_no_disposition alert;
//   * the purge deletes expired rows in bounded select-then-delete batches and
//     the scheduled cleanup route drives it behind internal auth.

import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  INBOUND_LEDGER_RETENTION_DAYS,
  beginInboundLedgerEntry,
  recordInboundTerminalDisposition,
  purgeExpiredInboundLedgerRows,
} from "@/lib/domain/inbound/inbound-processing-ledger.js";
import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";
import {
  clampPurgeCount,
  handleLedgerRetentionPurgeRequest,
} from "@/app/api/internal/inbound/ledger-retention-purge/route.js";

// ── PII minimization + retention anchoring ───────────────────────────────────

test("begin persists a body digest and retain_until, never the raw seller text", async () => {
  const inserts = [];
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    insert: (row) => {
      inserts.push(row);
      return {
        select: () => ({ single: async () => ({ data: { id: "ledger-1" }, error: null }) }),
      };
    },
  };
  const supabase_double = { from: () => chain };

  const raw_body = "Yes — call me about 123 Main St after 3pm";
  const begin = await beginInboundLedgerEntry(
    {
      idempotency_key: "textgrid_inbound:SM-pii-1",
      provider_message_sid: "SM-pii-1",
      from_phone: "+15550000001",
      to_phone: "+15550000002",
      message_body: raw_body,
      received_at: "2026-08-01T00:00:00.000Z",
    },
    { supabase: supabase_double, now: "2026-08-01T00:00:05.000Z" }
  );

  assert.equal(begin.ok, true);
  assert.equal(inserts.length, 1);
  const row = inserts[0];
  assert.equal(
    row.body_sha256,
    crypto.createHash("sha256").update(raw_body, "utf8").digest("hex")
  );
  assert.equal(row.body_length, raw_body.length);
  assert.equal(row.message_preview, undefined);
  assert.equal(row.message_body, undefined);
  assert.ok(
    !JSON.stringify(row).includes("123 Main St"),
    "raw seller text must never reach the ledger row"
  );
  // retain_until anchors on receipt + the documented retention window.
  assert.equal(INBOUND_LEDGER_RETENTION_DAYS, 30);
  assert.equal(row.retain_until, "2026-08-31T00:00:00.000Z");
  assert.equal(row.received_at, "2026-08-01T00:00:00.000Z");
});

// ── durable-write truthfulness (zero-row update) ─────────────────────────────

test("a disposition update that matched no ledger row reports ledger_row_missing", async () => {
  const chain = {
    update: () => chain,
    eq: async () => ({ error: null, count: 0 }),
  };
  const supabase_double = { from: () => chain };

  const result = await recordInboundTerminalDisposition(
    {
      idempotency_key: "textgrid_inbound:SM-missing-1",
      disposition: "no_reply_required",
    },
    { supabase: supabase_double }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "ledger_row_missing");
  assert.equal(result.updated_count, 0);
});

// ── wrapper surfaces + alerts on a failed disposition write ──────────────────

test("handler wrapper raises the P0 alert when the disposition write fails", async () => {
  const alerts = [];
  __setTextgridInboundTestDeps({
    beginInboundLedgerEntry: async () => ({ ok: true, ledger_id: "ledger-gone-1" }),
    recordInboundTerminalDisposition: async () => ({
      ok: false,
      reason: "ledger_row_missing",
      updated_count: 0,
    }),
    recordInboundNoDispositionAlert: async (metadata) => {
      alerts.push(metadata);
      return { ok: true };
    },
    getSystemFlags: async () => ({}),
    getSystemValue: async () => null,
  });
  let result;
  try {
    result = await handleTextgridInboundWebhook(
      {
        message_id: "SM-gone-1",
        from: "+15550000001",
        to: "+15550000002",
        message_body: "hello",
      },
      { inbound_debug_stage: "handler_entry" }
    );
  } finally {
    __resetTextgridInboundTestDeps();
  }

  assert.equal(result.ok, true);
  assert.equal(result.terminal_disposition, "no_reply_required");
  assert.equal(alerts.length, 1, "the wrapper must raise the P0 alert exactly once");
  assert.equal(alerts[0].record_failure, true);
  assert.equal(alerts[0].record_failure_reason, "ledger_row_missing");
  assert.equal(alerts[0].idempotency_key, "textgrid_inbound:SM-gone-1");
});

test("handler wrapper does not page when supabase is simply unconfigured", async () => {
  const alerts = [];
  __setTextgridInboundTestDeps({
    beginInboundLedgerEntry: async () => ({ ok: false, reason: "supabase_unconfigured" }),
    recordInboundTerminalDisposition: async () => ({
      ok: false,
      reason: "supabase_unconfigured",
    }),
    recordInboundNoDispositionAlert: async (metadata) => {
      alerts.push(metadata);
      return { ok: true };
    },
    getSystemFlags: async () => ({}),
    getSystemValue: async () => null,
  });
  try {
    const result = await handleTextgridInboundWebhook(
      {
        message_id: "SM-noconfig-1",
        from: "+15550000001",
        to: "+15550000002",
        message_body: "hello",
      },
      { inbound_debug_stage: "handler_entry" }
    );
    assert.equal(result.ok, true);
  } finally {
    __resetTextgridInboundTestDeps();
  }
  assert.equal(alerts.length, 0, "no alert sink exists without supabase — do not page");
});

// ── retention purge (bounded select-then-delete) ─────────────────────────────

function makePurgeDouble(expired_ids = []) {
  const calls = { limits: [], deleted: [] };
  const supabase = {
    from: () => ({
      select: () => ({
        lt: () => ({
          order: () => ({
            limit: async (n) => {
              calls.limits.push(n);
              return { data: expired_ids.map((id) => ({ id })), error: null };
            },
          }),
        }),
      }),
      delete: () => ({
        in: async (_col, ids) => {
          calls.deleted.push(ids);
          return { error: null, count: ids.length };
        },
      }),
    }),
  };
  return { supabase, calls };
}

test("purge hard-deletes expired rows in one bounded batch", async () => {
  const { supabase, calls } = makePurgeDouble(["a", "b", "c"]);
  const result = await purgeExpiredInboundLedgerRows(
    { limit: 500 },
    { supabase, now: "2026-08-31T00:00:01.000Z" }
  );
  assert.deepEqual(result, { ok: true, purged: 3, more: false });
  assert.deepEqual(calls.limits, [500]);
  assert.deepEqual(calls.deleted, [["a", "b", "c"]]);
});

test("purge reports more work when the batch fills, and no-ops when nothing expired", async () => {
  const full = makePurgeDouble(["a", "b"]);
  const full_result = await purgeExpiredInboundLedgerRows({ limit: 2 }, { supabase: full.supabase });
  assert.deepEqual(full_result, { ok: true, purged: 2, more: true });

  const empty = makePurgeDouble([]);
  const empty_result = await purgeExpiredInboundLedgerRows({}, { supabase: empty.supabase });
  assert.deepEqual(empty_result, { ok: true, purged: 0, more: false });
  assert.deepEqual(empty.calls.deleted, [], "no delete may run when nothing expired");
});

test("purge clamps the batch limit so a cron invocation stays bounded", async () => {
  const { supabase, calls } = makePurgeDouble([]);
  await purgeExpiredInboundLedgerRows({ limit: 999999 }, { supabase });
  await purgeExpiredInboundLedgerRows({ limit: -5 }, { supabase });
  assert.deepEqual(calls.limits, [2000, 500]);
});

// ── scheduled cleanup route ──────────────────────────────────────────────────

const ROUTE_URL = "http://localhost:3000/api/internal/inbound/ledger-retention-purge";

function buildRequest(query = "") {
  return {
    url: `${ROUTE_URL}${query}`,
    headers: {
      get: (key) => (key.toLowerCase() === "x-internal-api-secret" ? "test" : null),
    },
  };
}

test("clampPurgeCount bounds invalid and excessive input", () => {
  assert.equal(clampPurgeCount(null, 500, 2000), 500);
  assert.equal(clampPurgeCount("abc", 500, 2000), 500);
  assert.equal(clampPurgeCount("-5", 500, 2000), 500);
  assert.equal(clampPurgeCount(0, 500, 2000), 500);
  assert.equal(clampPurgeCount("250", 500, 2000), 250);
  assert.equal(clampPurgeCount("999999", 500, 2000), 2000);
});

test("purge route rejects anonymous callers before touching the ledger", async () => {
  const calls = [];
  const response = await handleLedgerRetentionPurgeRequest(
    { url: ROUTE_URL, headers: { get: () => null } },
    {
      purgeExpiredInboundLedgerRows: async (args) => {
        calls.push(args);
        return { ok: true, purged: 0, more: false };
      },
    }
  );
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("purge route drains expired rows across batches and reports the total", async () => {
  const results = [
    { ok: true, purged: 500, more: true },
    { ok: true, purged: 3, more: false },
  ];
  const calls = [];
  const response = await handleLedgerRetentionPurgeRequest(buildRequest(), {
    purgeExpiredInboundLedgerRows: async (args) => {
      calls.push(args);
      return results.shift();
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.purged, 503);
  assert.equal(body.batches, 2);
  assert.equal(body.more, false);
  assert.equal(body.retention_days, INBOUND_LEDGER_RETENTION_DAYS);
  assert.deepEqual(calls, [{ limit: 500 }, { limit: 500 }]);
});

test("purge route stops at max_batches so a single invocation stays bounded", async () => {
  const calls = [];
  const response = await handleLedgerRetentionPurgeRequest(
    buildRequest("?max_batches=3&limit=10"),
    {
      purgeExpiredInboundLedgerRows: async (args) => {
        calls.push(args);
        return { ok: true, purged: 10, more: true };
      },
    }
  );
  const body = await response.json();
  assert.equal(calls.length, 3);
  assert.equal(body.purged, 30);
  assert.equal(body.more, true);
});

test("purge route surfaces purge failures instead of hiding them", async () => {
  const failed = await handleLedgerRetentionPurgeRequest(buildRequest(), {
    purgeExpiredInboundLedgerRows: async () => ({ ok: false, reason: "ledger_purge_failed", purged: 0 }),
  });
  assert.equal(failed.status, 500);
  const failed_body = await failed.json();
  assert.equal(failed_body.ok, false);
  assert.equal(failed_body.reason, "ledger_purge_failed");

  // Pre-migration state: nothing retained, nothing to purge — report clean.
  const missing = await handleLedgerRetentionPurgeRequest(buildRequest(), {
    purgeExpiredInboundLedgerRows: async () => ({ ok: false, reason: "ledger_table_missing", purged: 0 }),
  });
  assert.equal(missing.status, 200);
});
