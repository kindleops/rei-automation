// P0 2026-10-08 — the three essential send-path safeguards are WIRED:
//   1. evaluateAndBlockSendAtCompliance runs the send-time contact guard after
//      canonical contactability (fail closed; read failure defers, never sends)
//   2. runSendQueue runs the resume drain before claiming (fail closed)
//   3. live TextGrid verification refuses non-allowlisted recipients
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateAndBlockSendAtCompliance } from "@/lib/domain/queue/block-send-at-compliance.js";
import { SEND_TIME_GUARD_REASONS } from "@/lib/domain/queue/send-time-contact-guard.js";
import { applyResumeDrain } from "@/lib/domain/queue/apply-resume-drain.js";
import { runLiveTextgridSendVerification } from "@/lib/verification/live-textgrid.js";

function recordingSupabase({ rows = [], failRead = false } = {}) {
  const updates = [];
  const api = {
    updates,
    from(table) {
      const q = { table, filters: [], patch: null };
      const chain = {
        select() { return chain; },
        in(col, vals) { q.filters.push(["in", col, vals]); return chain; },
        lt(col, v) { q.filters.push(["lt", col, v]); return chain; },
        eq(col, v) { q.filters.push(["eq", col, v]); return chain; },
        order() { return chain; },
        limit() {
          if (failRead) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: rows, error: null });
        },
        update(patch) { q.patch = patch; updates.push(q); return chain; },
        then(resolve) { return Promise.resolve({ data: null, error: null }).then(resolve); },
      };
      return chain;
    },
  };
  return api;
}

const contactabilityPass = async () => ({ blocked: false });

test("wired guard: a suppressed recipient is cancelled before transport", async () => {
  const supabase = recordingSupabase();
  const out = await evaluateAndBlockSendAtCompliance(
    { id: "q1", to_phone_number: "+13145550100", queue_status: "processing", metadata: {} },
    {
      supabase,
      runSendTimeContactGuard: async () => ({ blocked: true, reason: SEND_TIME_GUARD_REASONS.SUPPRESSION_LIST, reason_code: "suppressed" }),
      evaluateCanonicalContactability: contactabilityPass,
    },
  );
  assert.equal(out.blocked, true);
  assert.equal(out.result.final_queue_status, "cancelled");
  assert.equal(supabase.updates.at(-1).patch.queue_status, "cancelled");
});

test("wired guard: a guard read failure DEFERS (no send, no cancel)", async () => {
  const supabase = recordingSupabase();
  const out = await evaluateAndBlockSendAtCompliance(
    { id: "q2", to_phone_number: "3145550101", queue_status: "processing", metadata: {} },
    { supabase, evaluateCanonicalContactability: contactabilityPass, runSendTimeContactGuard: async () => ({ blocked: true, reason: SEND_TIME_GUARD_REASONS.READ_FAILED }) },
  );
  assert.equal(out.blocked, true);
  assert.equal(out.result.deferred, true);
  assert.equal(out.result.retryable, true);
  assert.notEqual(supabase.updates.at(-1).patch.queue_status, "cancelled");
  assert.equal(supabase.updates.at(-1).patch.is_locked, false);
});

test("wired guard: a guard that throws is treated as a read failure (fail closed)", async () => {
  const supabase = recordingSupabase();
  const out = await evaluateAndBlockSendAtCompliance(
    { id: "q3", to_phone_number: "+13145550102", queue_status: "processing", metadata: {} },
    { supabase, evaluateCanonicalContactability: contactabilityPass, runSendTimeContactGuard: async () => { throw new Error("db down"); } },
  );
  assert.equal(out.blocked, true);
  assert.equal(out.result.sent, false);
});

test("wired guard: a clean recipient passes", async () => {
  const supabase = recordingSupabase();
  const out = await evaluateAndBlockSendAtCompliance(
    // Owner rule P0 2026-10-09: an automated row carries its sms_templates id.
    { id: "q4", to_phone_number: "+13145550103", queue_status: "processing", template_id: "200001", metadata: {} },
    { supabase, evaluateCanonicalContactability: contactabilityPass, runSendTimeContactGuard: async () => ({ blocked: false }) },
  );
  assert.equal(out.blocked, false);
});

test("resume drain: stale opener is re-planned, stale manual is held, fresh row untouched", async () => {
  const now = "2026-10-08T15:00:00.000Z"; // 10:00 America/Chicago
  const rows = [
    { id: "o1", queue_status: "queued", scheduled_for_utc: "2026-10-08T05:00:00.000Z", to_phone_number: "+1", thread_key: "+1", type: "campaign", metadata: { recipient_timezone: "America/Chicago" } },
    { id: "m1", queue_status: "queued", scheduled_for_utc: "2026-10-08T13:00:00.000Z", to_phone_number: "+2", thread_key: "+2", type: "manual", metadata: {} },
    { id: "f1", queue_status: "queued", scheduled_for_utc: "2026-10-08T14:59:00.000Z", to_phone_number: "+3", thread_key: "+3", type: "campaign", metadata: {} },
  ];
  const supabase = recordingSupabase({ rows });
  const out = await applyResumeDrain({ supabase, now });
  assert.equal(out.ok, true);
  const byId = Object.fromEntries(supabase.updates.map((u) => [u.filters.find((f) => f[1] === "id")?.[2], u.patch]));
  assert.ok(byId.o1?.scheduled_for_utc > now, "stale opener moved forward");
  assert.equal(byId.m1?.queue_status, "held");
  assert.equal(byId.f1, undefined, "fresh row untouched");
});

test("resume drain: read failure fails closed", async () => {
  const out = await applyResumeDrain({ supabase: recordingSupabase({ failRead: true }), now: new Date().toISOString() });
  assert.equal(out.ok, false);
});

test("verification send refuses a recipient that is not allowlisted", async () => {
  let sent = false;
  const out = await runLiveTextgridSendVerification(
    { to: "+15555550199", from: "+13149268488", body: "hi", confirm_live: true },
    {
      env: { ALLOW_LIVE_TEXTGRID_VERIFICATION_SENDS: "true" },
      getSystemFlag: async () => true,
      getSystemValue: async () => "+15555550100",
      sendTextgridSMS: async () => { sent = true; return { sid: "x" }; },
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.reason, "verification_recipient_not_allowlisted");
  assert.equal(sent, false);
});

test("verification send refuses when the allowlist is empty", async () => {
  let sent = false;
  const out = await runLiveTextgridSendVerification(
    { to: "+15555550100", body: "hi", confirm_live: true },
    { env: { ALLOW_LIVE_TEXTGRID_VERIFICATION_SENDS: "true" }, getSystemFlag: async () => true, getSystemValue: async () => "", sendTextgridSMS: async () => { sent = true; return { sid: "x" }; } },
  );
  assert.equal(out.ok, false);
  assert.equal(sent, false);
});
