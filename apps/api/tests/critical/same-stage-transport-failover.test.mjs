import test from "node:test";
import assert from "node:assert/strict";

import { resolveRotationTemplate } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import { finalizeSendQueueFailure } from "@/lib/supabase/sms-engine.js";

// Phase 8: same-stage transport failover. On a content-filter block (or other
// retryable transport failure) the retry path must rotate to a DIFFERENT
// same-use_case template instead of re-sending the identical body. These tests
// pin the rotation selector: it excludes already-tried templates, preserves the
// stage (never changes use_case), renders from the row's own fields, never
// returns a blank/placeholder body, and reports exhaustion when nothing is left.

const LONG_DASH = /[—–]/;

const TEMPLATES = [
  {
    template_id: "own-a",
    use_case: "ownership_check",
    stage_code: "S1",
    language: "English",
    is_active: true,
    safe_for_auto_reply: true,
    template_body: "Hi {{seller_first_name}}, do you still own {{property_address}}?",
  },
  {
    template_id: "own-b",
    use_case: "ownership_check",
    stage_code: "S1",
    language: "English",
    is_active: true,
    safe_for_auto_reply: true,
    template_body: "Hello {{seller_first_name}}, are you still the owner of {{property_address}}?",
  },
  {
    template_id: "own-c",
    use_case: "ownership_check",
    stage_code: "S1",
    language: "English",
    is_active: true,
    safe_for_auto_reply: true,
    template_body: "Quick question {{seller_first_name}}, do you own {{property_address}}?",
  },
];

function mockSupabase(templates) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    limit: async () => ({ data: templates, error: null }),
  };
  return { from: () => chain };
}

const row = (overrides = {}) => ({
  id: "q1",
  use_case_template: "ownership_check",
  language: "English",
  seller_first_name: "Jane",
  property_address: "123 Main St",
  template_id: "own-a",
  metadata: {},
  ...overrides,
});

test("rotation selects a DIFFERENT same-use_case template, excluding the failed one", async () => {
  const r = await resolveRotationTemplate(row(), {
    excludeTemplateIds: ["own-a"],
    supabase: mockSupabase(TEMPLATES),
  });
  assert.equal(r.resolved, true);
  assert.notEqual(r.template_id, "own-a", "must not return the failed template");
  assert.equal(r.use_case, "ownership_check", "stage/use_case preserved");
  assert.match(r.message_body, /123 Main St/, "rendered with the row's property");
  assert.doesNotMatch(r.message_body, /\{\{/, "no unfilled placeholders");
  assert.doesNotMatch(r.message_body, LONG_DASH, "no em/en dashes ever");
});

test("rotation excludes ALL already-tried templates (accumulated across retries)", async () => {
  const r = await resolveRotationTemplate(row(), {
    excludeTemplateIds: ["own-a", "own-b"],
    supabase: mockSupabase(TEMPLATES),
  });
  assert.equal(r.resolved, true);
  assert.equal(r.template_id, "own-c", "must skip both tried templates and pick the remaining one");
});

test("rotation reports exhaustion when every same-stage template has been tried", async () => {
  const r = await resolveRotationTemplate(row(), {
    excludeTemplateIds: ["own-a", "own-b", "own-c"],
    supabase: mockSupabase(TEMPLATES),
  });
  assert.equal(r.resolved, false, "no alternate remains");
  assert.equal(r.reason, "no_alternate_template");
});

test("rotation never returns a blank body and preserves use_case", async () => {
  const r = await resolveRotationTemplate(row(), {
    excludeTemplateIds: ["own-a"],
    supabase: mockSupabase(TEMPLATES),
  });
  assert.ok(clean(r.message_body).length > 0, "non-empty body");
  assert.equal(r.use_case, "ownership_check");
});

test("no use_case on the row -> no rotation (fails closed, no guess)", async () => {
  const r = await resolveRotationTemplate(
    row({ use_case_template: null, metadata: {} }),
    { supabase: mockSupabase(TEMPLATES) }
  );
  assert.equal(r.resolved, false);
  assert.equal(r.reason, "rotation_use_case_missing");
});

function clean(v) {
  return String(v ?? "").trim();
}

// ── Integration: finalizeSendQueueFailure wires rotation into the requeue ──────

const ROTATION_ROW = {
  id: "rot-1",
  queue_status: "sending",
  retry_count: 0,
  max_retries: 2,
  from_phone_number: "+13235589881",
  to_phone_number: "+16023329348",
  message_body: "Hi Jane, do you still own 123 Main St?",
  template_id: "own-a",
  selected_template_id: "own-a",
  use_case_template: "ownership_check",
  language: "English",
  seller_first_name: "Jane",
  property_address: "123 Main St",
  // The blocked attempt already carries a provider SID (TextGrid accepted then
  // filtered) in all three sources the send-time idempotency guard reads.
  provider_message_id: "SM_BLOCKED_SID",
  textgrid_message_id: "SM_BLOCKED_SID",
  metadata: { provider_message_sid: "SM_BLOCKED_SID" },
};

function captureDeps(templates) {
  const captured = [];
  const deps = {
    updateSendQueueRowWithLock: async (row_id, lock_token, payload) => {
      captured.push({ row_id, lock_token, payload });
      return { id: row_id, ...payload };
    },
    supabase: mockSupabase(templates),
  };
  return { captured, deps };
}

const CONTENT_FILTER_ERROR = () => new Error("blocked by textgrid content filter");

test("content-filter block rotates to a new same-stage template and requeues (not terminal)", async () => {
  const { captured, deps } = captureDeps(TEMPLATES);
  await finalizeSendQueueFailure(ROTATION_ROW, "lock", CONTENT_FILTER_ERROR(), deps);
  assert.equal(captured.length, 1);
  const { payload } = captured[0];
  assert.equal(payload.queue_status, "queued", "rotated -> requeued, not terminal");
  assert.notEqual(payload.template_id, "own-a", "a different template was selected");
  assert.ok(payload.next_retry_at, "a retry is scheduled");
  assert.equal(payload.metadata.same_stage_failover, true);
  assert.ok(payload.metadata.tried_template_ids.includes("own-a"), "the failed template is recorded as tried");
  assert.match(payload.message_body, /123 Main St/, "rotated body is rendered from the row");
  assert.doesNotMatch(payload.message_body, LONG_DASH);
});

test("rotation clears the blocked SID (all three sources) so the rotated body actually sends", async () => {
  const { captured, deps } = captureDeps(TEMPLATES);
  await finalizeSendQueueFailure(ROTATION_ROW, "lock", CONTENT_FILTER_ERROR(), deps);
  const { payload } = captured[0];
  assert.equal(payload.provider_message_id, null);
  assert.equal(payload.textgrid_message_id, null);
  assert.equal(payload.metadata.provider_message_sid, null);
  assert.equal(payload.metadata.blocked_provider_message_id, "SM_BLOCKED_SID", "blocked SID kept for audit");
});

test("rotation preserves stage and charges the transport failure to retry_count", async () => {
  const { captured, deps } = captureDeps(TEMPLATES);
  await finalizeSendQueueFailure(ROTATION_ROW, "lock", CONTENT_FILTER_ERROR(), deps);
  const { payload } = captured[0];
  assert.equal(payload.retry_count, 1, "transport failure increments retry_count");
  // use_case_template is never rewritten by the failover -> stage preserved.
  assert.equal(payload.use_case_template ?? "ownership_check", "ownership_check");
});

test("content-filter block with no alternate template -> terminal (no infinite same-body retry)", async () => {
  // Only the failed template exists in the pool; nothing left to rotate to.
  const { captured, deps } = captureDeps([TEMPLATES[0]]);
  await finalizeSendQueueFailure(ROTATION_ROW, "lock", CONTENT_FILTER_ERROR(), deps);
  const { payload } = captured[0];
  assert.notEqual(payload.queue_status, "queued", "no alternate -> terminal, not requeued");
  assert.equal(payload.next_retry_at, null, "no retry scheduled once exhausted");
});
