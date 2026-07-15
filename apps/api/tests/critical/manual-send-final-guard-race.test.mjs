/**
 * Enqueue-to-dispatch race protection for Cockpit/Map immediate manual sends.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { executeManualInboxSendNow } from "@/lib/domain/inbox/send-now-service.js";
import { evaluateAndBlockSendAtCompliance } from "@/lib/domain/queue/block-send-at-compliance.js";

const THREAD = "+15005550006";
const FROM = "+15005550001";

const BASE_PAYLOAD = {
  thread_key: THREAD,
  to_phone_number: THREAD,
  from_phone_number: FROM,
  message_body: "Manual operator proof message",
  queue_key: "inbox:manual-race-proof",
  source: "manual_inbox",
  action: "send_now",
};

function makeClaimableSupabase(queue_row, options = {}) {
  const rows = new Map([[String(queue_row.id), { ...queue_row }]]);
  const { suppression_after_enqueue = false } = options;

  return {
    rows,
    from(table) {
      if (table === "send_queue") {
        return {
          select() {
            return {
              eq(_col, val) {
                return {
                  maybeSingle: async () => ({
                    data: rows.get(String(val)) || null,
                    error: null,
                  }),
                };
              },
            };
          },
          update(patch) {
            const apply = async (id) => {
              const row = rows.get(String(id));
              if (!row) return { data: null, error: null };
              Object.assign(row, patch);
              if (patch.metadata) {
                row.metadata = { ...(row.metadata || {}), ...patch.metadata };
              }
              return { data: row, error: null };
            };
            return {
              eq(_col, val) {
                return {
                  in(_col2, statuses) {
                    return {
                      select() {
                        return {
                          maybeSingle: async () => {
                            const row = rows.get(String(val));
                            if (!row || !statuses.includes(row.queue_status)) {
                              return { data: null, error: null };
                            }
                            const updated = await apply(val);
                            return { data: updated.data, error: null };
                          },
                        };
                      },
                    };
                  },
                  then(resolve, reject) {
                    return apply(val).then(resolve, reject);
                  },
                };
              },
            };
          },
        };
      }

      if (table === "sms_suppression_list") {
        return {
          select: () => ({
            eq: () => ({
              or: () => ({
                eq: () => ({
                  limit: async () => ({
                    data: suppression_after_enqueue
                      ? [{ id: "sup-race", suppression_reason: "opt_out", is_active: true }]
                      : [],
                    error: null,
                    count: suppression_after_enqueue ? 1 : 0,
                  }),
                }),
              }),
            }),
            or: () => ({
              eq: () => ({
                limit: async () => ({
                  data: suppression_after_enqueue
                    ? [{ id: "sup-race", suppression_reason: "opt_out", is_active: true }]
                    : [],
                  error: null,
                  count: suppression_after_enqueue ? 1 : 0,
                }),
              }),
            }),
          }),
        };
      }

      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
          }),
          or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
        }),
      };
    },
  };
}

function makeDeps(supabase, overrides = {}) {
  let provider_calls = 0;
  const queue_row_id = overrides.queue_row_id || "manual-race-row";

  return {
    provider_calls: () => provider_calls,
    deps: {
      supabase,
      getSystemValue: async () => null,
      createQueueRowImpl: async (input) => ({
        ok: true,
        queue_row_id,
        queue_id: queue_row_id,
        queue_key: input.queue_key,
        result: { raw: { metadata: input.metadata } },
      }),
      sendTextgridImpl: async () => {
        provider_calls += 1;
        return { ok: true, sid: "SMrace" };
      },
      finalizeSendQueueSuccessImpl: async (row) => ({ ...row, queue_status: "sent" }),
      writeOutboundSuccessMessageEventImpl: async () => ({ id: "evt-race" }),
      finalizeSendQueueFailureImpl: async (row) => ({ ...row, queue_status: "failed" }),
      writeOutboundFailureMessageEventImpl: async () => null,
      ...overrides.deps,
    },
  };
}

test("race: suppression after enqueue blocks manual send with zero TextGrid calls", async () => {
  const supabase = makeClaimableSupabase(
    {
      id: "manual-race-row",
      thread_key: THREAD,
      to_phone_number: THREAD,
      from_phone_number: FROM,
      queue_status: "queued",
      message_body: BASE_PAYLOAD.message_body,
      metadata: { source: "manual_inbox", manual_operator_send: true },
    },
    { suppression_after_enqueue: true }
  );
  const harness = makeDeps(supabase);

  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "compliance_blocked_at_send_time");
  assert.equal(result.provider_skipped, true);
  assert.equal(result.retryable, false);
  assert.equal(result.queue_status, "cancelled");
  assert.equal(harness.provider_calls(), 0);
  assert.equal(supabase.rows.get("manual-race-row").queue_status, "cancelled");
});

test("race: wrong-number after enqueue blocks manual send", async () => {
  const supabase = makeClaimableSupabase({
    id: "manual-wrong-row",
    thread_key: THREAD,
    to_phone_number: THREAD,
    from_phone_number: FROM,
    queue_status: "queued",
    message_body: BASE_PAYLOAD.message_body,
    metadata: { source: "manual_inbox", manual_operator_send: true },
  });

  supabase.from = ((baseFrom) => (table) => {
    if (table === "phones") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                phone_id: "ph_wrong",
                canonical_e164: THREAD,
                phone_contact_status: "wrong_number",
                wrong_number_at: "2026-07-15T00:00:00.000Z",
                activity_status: "active",
              },
              error: null,
            }),
          }),
        }),
      };
    }
    return baseFrom(table);
  })(supabase.from.bind(supabase));

  const harness = makeDeps(supabase, { queue_row_id: "manual-wrong-row" });
  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);

  assert.equal(result.ok, false);
  assert.equal(result.compliance_reason_code, "wrong_number_at_send_time");
  assert.equal(harness.provider_calls(), 0);
});

test("race: cancelled row after enqueue blocks manual send", async () => {
  const supabase = makeClaimableSupabase({
    id: "manual-cancel-row",
    thread_key: THREAD,
    to_phone_number: THREAD,
    from_phone_number: FROM,
    queue_status: "queued",
    message_body: BASE_PAYLOAD.message_body,
    metadata: { source: "manual_inbox", manual_operator_send: true },
  });

  const originalFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    if (table === "send_queue") {
      const base = originalFrom(table);
      return {
        ...base,
        select() {
          return {
            eq(_col, val) {
              return {
                maybeSingle: async () => {
                  const row = supabase.rows.get(String(val));
                  if (!row) return { data: null, error: null };
                  return {
                    data: { ...row, queue_status: "cancelled" },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    }
    return originalFrom(table);
  };

  const harness = makeDeps(supabase, { queue_row_id: "manual-cancel-row" });
  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "compliance_blocked_at_send_time");
  assert.equal(harness.provider_calls(), 0);
});

test("race: suppression lookup error at final dispatch fails closed for manual send", async () => {
  const supabase = makeClaimableSupabase({
    id: "manual-failclosed-row",
    thread_key: THREAD,
    to_phone_number: THREAD,
    from_phone_number: FROM,
    queue_status: "queued",
    message_body: BASE_PAYLOAD.message_body,
    metadata: { source: "manual_inbox", manual_operator_send: true },
  });

  const originalFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    if (table === "sms_suppression_list") {
      return {
        select: () => ({
          eq: () => {
            throw new Error("db_down");
          },
        }),
      };
    }
    return originalFrom(table);
  };

  const harness = makeDeps(supabase, { queue_row_id: "manual-failclosed-row" });
  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);

  assert.equal(result.ok, false);
  assert.equal(result.detail_reason, "suppression_lookup_failed_fail_closed");
  assert.equal(harness.provider_calls(), 0);
});

test("race: healthy manual send reaches provider exactly once", async () => {
  const supabase = makeClaimableSupabase({
    id: "manual-healthy-row",
    thread_key: THREAD,
    to_phone_number: THREAD,
    from_phone_number: FROM,
    queue_status: "queued",
    message_body: BASE_PAYLOAD.message_body,
    metadata: { source: "manual_inbox", manual_operator_send: true },
  });
  const harness = makeDeps(supabase, { queue_row_id: "manual-healthy-row" });

  const result = await executeManualInboxSendNow(BASE_PAYLOAD, harness.deps);

  assert.equal(result.ok, true);
  assert.equal(harness.provider_calls(), 1);
  assert.equal(result.delivery_status_display, "sent");
});

test("map_command shares executeManualInboxSendNow and final guard", async () => {
  const supabase = makeClaimableSupabase(
    {
      id: "map-race-row",
      thread_key: THREAD,
      to_phone_number: THREAD,
      from_phone_number: FROM,
      queue_status: "queued",
      message_body: "Ownership check proof",
      metadata: { source: "map_command", manual_operator_send: true },
    },
    { suppression_after_enqueue: true }
  );
  const harness = makeDeps(supabase, { queue_row_id: "map-race-row" });

  const result = await executeManualInboxSendNow(
    {
      ...BASE_PAYLOAD,
      source: "map_command",
      send_source: "map_command",
      action: "send_ownership_check",
      created_from: "leadcommand_map",
    },
    harness.deps
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "compliance_blocked_at_send_time");
  assert.equal(harness.provider_calls(), 0);
});

test("evaluateAndBlockSendAtCompliance remains unreachable to provider when blocked", async () => {
  let transport_calls = 0;
  const row = {
    id: "guard-proof",
    thread_key: THREAD,
    to_phone_number: THREAD,
    queue_status: "processing",
    metadata: { manual_operator_send: true, source: "manual_inbox" },
  };
  const supabase = makeClaimableSupabase(row, { suppression_after_enqueue: true });

  const block = await evaluateAndBlockSendAtCompliance(row, {
    supabase,
    manual_operator_send: true,
    sendTextgridSMS: async () => {
      transport_calls += 1;
      return { ok: true, sid: "SMshould-not" };
    },
  });

  assert.equal(block.blocked, true);
  assert.equal(transport_calls, 0);
  assert.equal(block.result?.sent, false);
});