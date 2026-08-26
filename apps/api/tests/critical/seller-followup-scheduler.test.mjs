import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveFollowUpPlan,
  scheduleFollowUp,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";

test("resolveFollowUpPlan: permanent suppression intents never schedule", () => {
  const plan = resolveFollowUpPlan("opt_out", { thread_key: "+15550001111" });
  assert.equal(plan.suppressed, true);
  assert.equal(plan.followup_created, false);
});

test("resolveFollowUpPlan: not_interested schedules nurture follow-up", () => {
  const plan = resolveFollowUpPlan("not_interested", { thread_key: "+15550001111" });
  assert.equal(plan.suppressed, false);
  assert.equal(plan.followup_created, true);
  assert.ok(plan.scheduled_for);
});

test("scheduleFollowUp: uses canonical enqueueSendQueueItem path", async () => {
  const inserted = [];
  const supabase = {
    from(table) {
      if (table === "sms_suppression_list") {
        return {
          select: () => ({
            eq: () => ({
              ilike: async () => ({ count: 0, error: null }),
            }),
          }),
        };
      }
      if (table === "send_queue") {
        return {
          select: () => ({
            eq: () => ({
              ilike: async () => ({ count: 0, error: null }),
            }),
          }),
          insert: (payload) => {
            inserted.push(payload);
            return {
              select: () => ({
                maybeSingle: async () => ({
                  data: { id: 501, ...payload },
                  error: null,
                }),
              }),
            };
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({
            ilike: async () => ({ count: 0, error: null }),
          }),
        }),
      };
    },
  };

  const result = await scheduleFollowUp(
    "not_interested",
    "+15550001111",
    { master_owner_id: "mo_1", property_id: "prop_1", source: "test" },
    supabase
  );

  assert.equal(result.ok, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].type, "followup");
  assert.equal(inserted[0].to_phone_number, "+15550001111");
  assert.equal(inserted[0].dedupe_key, "seller_followup:+15550001111:not_interested");
  assert.equal(inserted[0].metadata.deferred_message_resolution, true);
});

test("scheduleFollowUp: idempotent replay returns duplicate_followup_exists", async () => {
  const existing = {
    id: 88,
    queue_key: "followup:abc",
    dedupe_key: "seller_followup:+15550001111:not_interested",
    queue_status: "scheduled",
  };
  const supabase = {
    from(table) {
      if (table === "sms_suppression_list") {
        return {
          select: () => ({
            eq: () => ({
              ilike: async () => ({ count: 0, error: null }),
            }),
          }),
        };
      }
      if (table === "send_queue") {
        return {
          select: () => ({
            eq: () => ({
              ilike: async () => ({ count: 0, error: null }),
              order: function () {
                return this;
              },
              limit: function () {
                return this;
              },
              maybeSingle: async () => ({ data: existing, error: null }),
            }),
          }),
          insert: () => ({
            select: () => ({
              maybeSingle: async () => ({
                data: null,
                error: { code: "23505", message: "duplicate" },
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ ilike: async () => ({ count: 0 }) }) }) };
    },
  };

  const result = await scheduleFollowUp("not_interested", "+15550001111", {}, supabase);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "duplicate_followup_exists");
});

test("scheduleFollowUp: blocks 21610-suppressed recipient", async () => {
  // Contract re-pin: the canonical sms_suppression_list read is now
  // select(...).eq("phone_e164", …) resolving row objects (see
  // suppression-21610-canonical-precedence) — an ACTIVE recipient-wide 21610
  // row must block the follow-up enqueue fail-closed.
  const supabase = {
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        ilike() { return chain; },
        or() { return chain; },
        then(resolve) {
          if (table === "sms_suppression_list") {
            resolve({
              data: [
                {
                  id: "sup-21610-1",
                  phone_e164: "+15550009999",
                  is_active: true,
                  sender_phone_e164: null,
                  suppression_type: "blacklist_pair",
                  reason:
                    'TextGrid HTTP failure: {"status":"400","code":"21610","message":"blacklist"}',
                  suppression_reason:
                    'TextGrid HTTP failure: {"status":"400","code":"21610","message":"blacklist"}',
                },
              ],
              error: null,
            });
            return;
          }
          resolve({ data: [], error: null, count: 0 });
        },
      };
      return chain;
    },
  };

  const result = await scheduleFollowUp("unclear", "+15550009999", {}, supabase);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed_21610");
});