/**
 * Opt-out suppression is FAIL CLOSED (2026-10-06).
 *
 * Prod audit (read-only): 2 of 72 inbound opt-outs since 2026-09-25 left no
 * sms_suppression_list row — the upsert error was caught, warn()-logged and
 * dropped. The unknown-inbound and Discord opt-out writers could never succeed
 * at all (missing NOT NULL columns / non-existent columns). Pinned here:
 *   - one writer (record-phone-suppression.js) with the binding row shape
 *   - retry, then a durable automation_suppressions block + critical alert
 *   - applyInboundSuppression never reports success on a failed write
 *   - the send-time guard blocks a suppressed thread with no list row, and an
 *     active fallback block
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  recordPhoneSuppression,
  SUPPRESSION_FALLBACK_REASON,
} from "@/lib/domain/compliance/record-phone-suppression.js";
import { applyInboundSuppression } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { evaluateCanonicalContactability } from "@/lib/domain/compliance/evaluate-canonical-contactability.js";
import { EVENT_CATALOG } from "@/lib/domain/notifications/notification-event-catalog.js";

const PHONE = "+18133409070";
const noSleep = async () => {};

// A write client whose sms_suppression_list upsert fails `failures` times.
function writeClient({ failures = 0, fallbackError = null } = {}) {
  const calls = { upserts: [], inserts: [] };
  let remaining = failures;
  const client = {
    from(table) {
      return {
        upsert(row, options) {
          calls.upserts.push({ table, row, options });
          const error = remaining > 0 ? { message: "fetch failed" } : null;
          if (remaining > 0) remaining -= 1;
          return { select: () => ({ maybeSingle: async () => ({ data: error ? null : { id: "s1" }, error }) }) };
        },
        insert(row) {
          calls.inserts.push({ table, row });
          return { select: () => ({ maybeSingle: async () => ({ data: fallbackError ? null : { id: "a1" }, error: fallbackError }) }) };
        },
      };
    },
  };
  return { client, calls };
}

test("the writer upserts the phone-scoped row campaign eligibility reads", async () => {
  const { client, calls } = writeClient();
  const result = await recordPhoneSuppression({ supabase: client, phone: "8133409070", reason: "opt_out", threadKey: PHONE }, { sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(calls.upserts.length, 1);
  const { table, row, options } = calls.upserts[0];
  assert.equal(table, "sms_suppression_list");
  assert.equal(row.phone_e164, PHONE, "normalized to +1E.164");
  assert.equal(row.suppression_type, "opt_out", "NOT NULL column");
  assert.equal(row.sender_phone_e164, null, "phone-scoped: every sender");
  assert.equal(row.is_active, true);
  assert.equal(options.onConflict, "phone_e164,sender_phone_e164");
  for (const ghost of ["opt_out_keyword", "metadata", "updated_at"]) {
    assert.equal(ghost in row, false, `${ghost} is not a column of sms_suppression_list`);
  }
});

test("a transient failure is retried and succeeds", async () => {
  const { client, calls } = writeClient({ failures: 2 });
  const result = await recordPhoneSuppression({ supabase: client, phone: PHONE }, { sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls.upserts.length, 3);
  assert.equal(calls.inserts.length, 0, "no fallback when the list write lands");
});

test("every attempt failing writes a durable block, alerts, and reports failure", async () => {
  const { client, calls } = writeClient({ failures: 99 });
  const alerts = [];
  const result = await recordPhoneSuppression(
    { supabase: client, phone: PHONE, reason: "opt_out", threadKey: PHONE, sourceEventId: "evt-1" },
    { sleep: noSleep, alert: async (p) => { alerts.push(p); return { ok: true }; } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.fail_closed, true);
  assert.equal(result.fallback_block, true);
  assert.equal(calls.inserts.length, 1);
  const block = calls.inserts[0];
  assert.equal(block.table, "automation_suppressions");
  assert.equal(block.row.phone_e164, PHONE);
  assert.equal(block.row.status, "active");
  assert.equal(block.row.expires_at, null, "never expires on its own");
  assert.equal(block.row.dedupe_key, `${SUPPRESSION_FALLBACK_REASON}:${PHONE}`);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].fallback_block, true);
  assert.equal(result.alerted, true);
});

test("even when the fallback block fails the alert still fires and nothing claims success", async () => {
  const { client } = writeClient({ failures: 99, fallbackError: { message: "connection reset" } });
  const alerts = [];
  const result = await recordPhoneSuppression({ supabase: client, phone: PHONE }, { sleep: noSleep, alert: async (p) => { alerts.push(p); return { ok: true }; } });
  assert.equal(result.ok, false);
  assert.equal(result.fallback_block, false);
  assert.match(result.fallback_error, /connection reset/);
  assert.equal(alerts.length, 1);
});

test("a duplicate fallback block counts as blocked (an earlier failure already holds the number)", async () => {
  const { client } = writeClient({ failures: 99, fallbackError: { message: "duplicate key value violates unique constraint" } });
  const result = await recordPhoneSuppression({ supabase: client, phone: PHONE }, { sleep: noSleep, alert: async () => ({ ok: true }) });
  assert.equal(result.fallback_block, true);
});

test("applyInboundSuppression (the live STOP path) never reports success on a failed write", async () => {
  const { client } = writeClient({ failures: 99 });
  const alerts = [];
  const result = await applyInboundSuppression({
    supabaseClient: client,
    phoneNumber: PHONE,
    reason: "opt_out",
    threadKey: PHONE,
    dryRun: false,
    suppressionDeps: { sleep: noSleep, alert: async (p) => { alerts.push(p); return { ok: true }; } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "suppression_failed");
  assert.equal(result.fail_closed, true);
  assert.equal(alerts.length, 1);
});

test("the alert event exists in the notification catalog as critical compliance", () => {
  const entry = EVENT_CATALOG.compliance_suppression_write_failed;
  assert.ok(entry);
  assert.equal(entry.defaultSeverity, "critical");
  assert.equal(entry.soundCategory, "compliance");
});

// ── send-time guard (belt and braces) ───────────────────────────────────────

function readClient(tables = {}) {
  return {
    from(table) {
      const rows = tables[table] || [];
      const chain = {
        select: () => chain,
        eq: () => chain,
        or: () => chain,
        in: () => chain,
        order: () => chain,
        limit: async () => ({ data: rows, error: null }),
        maybeSingle: async () => ({ data: rows[0] || null, error: null }),
        then: (resolve, reject) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject),
      };
      return chain;
    },
  };
}

test("send time: a suppressed thread with NO list row is blocked", async () => {
  const result = await evaluateCanonicalContactability(
    { thread_key: PHONE, to_phone_number: PHONE },
    { supabase: readClient({ inbox_thread_state: [{ status: "open", contactability_status: "contactable", is_suppressed: true, metadata: {} }] }) },
  );
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "thread_is_suppressed");
});

test("send time: an active fail-closed automation_suppressions block is honoured", async () => {
  const result = await evaluateCanonicalContactability(
    { thread_key: PHONE, to_phone_number: PHONE },
    { supabase: readClient({ automation_suppressions: [{ id: "a1", status: "active", expires_at: null, suppression_reason: SUPPRESSION_FALLBACK_REASON }] }) },
  );
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "automation_suppression_active");
});

test("send time: an expired automation suppression does not block", async () => {
  const result = await evaluateCanonicalContactability(
    { thread_key: PHONE, to_phone_number: PHONE },
    { supabase: readClient({ automation_suppressions: [{ id: "a1", status: "active", expires_at: "2020-01-01T00:00:00Z" }] }) },
  );
  assert.notEqual(result.reason, "automation_suppression_active");
});
