/**
 * durable-inbound-opt-out.test.mjs
 *
 * Production defect (2026-09-08/09): five sellers texted STOP. The inbound path
 * correctly declined to auto-reply and sent nothing further, but wrote NO
 * durable record -- sms_suppression_list had no row, contact_outreach_state.dnc
 * was false, message_events.is_opt_out was false. The only thing keeping those
 * numbers out of future outreach was a 45-day cadence timer.
 *
 * Two independent bugs caused it, and this file pins both:
 *   1. applyInboundSuppression's INSERT omitted phone_e164 and suppression_type,
 *      the table's two NOT NULL columns -- so it could only ever fail. It also
 *      omitted the column campaign eligibility actually reads (phone_e164), so
 *      even a successful write would not have bound.
 *   2. It was unreachable: the caller passed dryRun = dryRun || !should_queue_live,
 *      and an opt-out NEVER queues a reply, so the write was always skipped
 *      while still reporting ok:true.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { applyInboundSuppression } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

function captureSupabase() {
  const calls = { upserts: [], inserts: [], updates: [] };
  const client = {
    from(table) {
      return {
        upsert(row, options) {
          calls.upserts.push({ table, row, options });
          return Promise.resolve({ data: [row], error: null });
        },
        insert(row) {
          calls.inserts.push({ table, row });
          return Promise.resolve({ data: [row], error: null });
        },
        update(patch) {
          const chain = {
            eq(column, value) {
              calls.updates.push({ table, patch, column, value });
              return Promise.resolve({ data: [], error: null });
            },
          };
          return chain;
        },
      };
    },
  };
  return { client, calls };
}

test("STOP writes a durable suppression row carrying both NOT NULL columns", async () => {
  const { client, calls } = captureSupabase();

  const result = await applyInboundSuppression({
    supabaseClient: client,
    phoneNumber: "+13055550188",
    reason: "opt_out",
    threadKey: "thread-abc",
    dryRun: false,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.inserts.length, 0, "must not use the old bare insert");
  assert.equal(calls.upserts.length, 1);

  const { table, row, options } = calls.upserts[0];
  assert.equal(table, "sms_suppression_list");
  // The two NOT NULL columns the old insert omitted.
  assert.equal(row.phone_e164, "+13055550188");
  assert.equal(row.suppression_type, "opt_out");
  // phone_e164 is the column enqueue-campaign-target-one filters on, so this is
  // the field that makes the block actually bind.
  assert.equal(row.is_active, true);
  assert.equal(row.source, "inbound_opt_out");
  // Phone-scoped block: NULL sender means every sender, not one pair.
  assert.equal(row.sender_phone_e164, null);
  assert.equal(options.onConflict, "phone_e164,sender_phone_e164");
  assert.equal(options.ignoreDuplicates, false);
});

test("a repeated STOP is idempotent rather than a duplicate-key failure", async () => {
  const { client, calls } = captureSupabase();
  const args = {
    supabaseClient: client,
    phoneNumber: "+13055550188",
    reason: "opt_out",
    dryRun: false,
  };
  await applyInboundSuppression(args);
  await applyInboundSuppression(args);
  assert.equal(calls.upserts.length, 2);
  for (const call of calls.upserts) {
    assert.equal(call.options.onConflict, "phone_e164,sender_phone_e164");
    assert.equal(call.options.ignoreDuplicates, false);
  }
});

test("a PostgREST error is surfaced, not swallowed into ok:true", async () => {
  const client = {
    from() {
      return {
        upsert() {
          return Promise.resolve({ data: null, error: { message: "null value in column \"phone_e164\"" } });
        },
      };
    },
  };
  const result = await applyInboundSuppression({
    supabaseClient: client,
    phoneNumber: "+13055550188",
    reason: "opt_out",
    dryRun: false,
  });
  assert.equal(result.ok, false, "a failed compliance write must never report success");
});

test("wrong_number still routes to the phones table, unchanged", async () => {
  const { client, calls } = captureSupabase();
  const result = await applyInboundSuppression({
    supabaseClient: client,
    phoneNumber: "+13055550188",
    phoneId: "ph_1",
    reason: "wrong_number",
    dryRun: false,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.upserts.length, 0);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].table, "phones");
  assert.equal(calls.updates[0].patch.phone_contact_status, "wrong_number");
});

test("an explicit dry run still writes nothing", async () => {
  const { client, calls } = captureSupabase();
  const result = await applyInboundSuppression({
    supabaseClient: client,
    phoneNumber: "+13055550188",
    reason: "opt_out",
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(calls.upserts.length, 0);
  assert.equal(calls.updates.length, 0);
});
