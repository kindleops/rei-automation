import test from "node:test";
import assert from "node:assert/strict";

import {
  SEND_QUEUE_INSERT_COLUMNS,
  buildSendQueueInsertPayload,
  insertSupabaseSendQueueRow,
  normalizeSendQueueRow,
} from "@/lib/supabase/sms-engine.js";
import {
  createInboxSendNowQueueRow,
  executeManualInboxSendNow,
} from "@/lib/domain/inbox/send-now-service.js";
import { evaluateQueueCreationRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";

const INSERT_COLUMN_SET = new Set(SEND_QUEUE_INSERT_COLUMNS);

function buildMockSupabase() {
  const inserted = [];
  return {
    inserted,
    from(table) {
      assert.equal(table, "send_queue");
      const chain = {
        update() {
          return chain;
        },
        eq() {
          return chain;
        },
        in() {
          return chain;
        },
        select() {
          return chain;
        },
        contains() {
          return chain;
        },
        gte() {
          return chain;
        },
        insert(payload) {
          inserted.push(payload);
          return {
            select: () => ({
              maybeSingle: async () => ({
                data: { id: `row-${inserted.length}`, ...payload },
                error: null,
              }),
            }),
          };
        },
      };
      return chain;
    },
  };
}

function makePausedSupabase() {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data:
                table === "inbox_thread_state"
                  ? { status: "paused_review", metadata: {} }
                  : null,
            }),
          or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
          order: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: null }),
            }),
          }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: 0 }) }),
        order: () => ({
          limit: () => ({
            maybeSingle: () => Promise.resolve({ data: null }),
          }),
        }),
        contains: () => ({
          gte: () => Promise.resolve({ count: 0 }),
        }),
      }),
    }),
  };
}

function makeSuppressedSupabase() {
  return {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: table === "inbox_thread_state" ? { status: "active", metadata: {} } : null,
            }),
          or: () => ({ eq: () => Promise.resolve({ count: 1 }) }),
        }),
        or: () => ({ eq: () => Promise.resolve({ count: 1 }) }),
        contains: () => ({
          gte: () => Promise.resolve({ count: 0 }),
        }),
      }),
    }),
  };
}

test("buildSendQueueInsertPayload never emits unknown send_queue columns", () => {
  const payload = buildSendQueueInsertPayload({
    queue_key: "inbox:send_now:test",
    queue_status: "queued",
    message_body: "Manual operator proof",
    to_phone_number: "+12146072916",
    from_phone_number: "+18885551212",
    thread_key: "+12146072916",
    agent_id: "legacy-agent-701",
    cash_offer_snapshot_id: "should-not-insert",
    offer_record_sync_status: "should-not-insert",
    metadata: { source: "manual_inbox", action: "send_now" },
  });

  for (const key of Object.keys(payload)) {
    assert.equal(
      INSERT_COLUMN_SET.has(key),
      true,
      `unexpected insert column: ${key}`
    );
  }
  assert.equal("agent_id" in payload, false);
  assert.equal("cash_offer_snapshot_id" in payload, false);
  assert.equal(payload.sms_agent_id, "legacy-agent-701");
});

test("legacy agent_id maps to sms_agent_id and selected routing agent stays canonical", () => {
  const normalized = normalizeSendQueueRow({
    agent_id: "agent-sms-42",
    metadata: { routing_agent_id: "agent-route-99" },
    message_body: "hello",
  });

  assert.equal(normalized.sms_agent_id, "agent-sms-42");
  assert.equal(normalized.selected_agent_id, "agent-route-99");

  const payload = buildSendQueueInsertPayload(normalized);
  assert.equal(payload.sms_agent_id, "agent-sms-42");
  assert.equal(payload.selected_agent_id, "agent-route-99");
  assert.equal("agent_id" in payload, false);
});

test("insertSupabaseSendQueueRow uses production-safe payload for manual inbox send", async () => {
  const supabase = buildMockSupabase();
  const result = await insertSupabaseSendQueueRow(
    {
      queue_key: "inbox:send_now:schema-proof",
      queue_status: "queued",
      message_body: "Schema proof message",
      to_phone_number: "+12146072916",
      from_phone_number: "+18885551212",
      thread_key: "+12146072916",
      agent_id: "legacy-111",
      metadata: {
        source: "manual_inbox",
        action: "send_now",
        created_from: "leadcommand_inbox",
      },
    },
    { supabase, now: "2026-06-24T12:00:00.000Z" }
  );

  assert.equal(result.ok, true);
  assert.equal(supabase.inserted.length, 1);
  const inserted = supabase.inserted[0];
  assert.equal("agent_id" in inserted, false);
  assert.equal(inserted.sms_agent_id, "legacy-111");
  for (const key of Object.keys(inserted)) {
    assert.equal(INSERT_COLUMN_SET.has(key), true, `unexpected insert column: ${key}`);
  }
});

test("manual inbox send bypasses paused review and runtime brakes but not suppression", async () => {
  const emergency_settings = {
    campaign_mode: "paused",
    queue_emergency_stop_at: "2026-05-31T12:00:00.000Z",
    queue_auto_enqueue_enabled: "false",
  };
  const runtime_brake = evaluateQueueCreationRuntimeBrakes(emergency_settings, {
    action: "manual_inbox_send_now_queue_create",
    failClosed: false,
  });
  assert.equal(runtime_brake.ok, false);

  const supabase = buildMockSupabase();
  const paused_supabase = {
    from(table) {
      const base = makePausedSupabase().from(table);
      if (table === "send_queue") {
        return {
          ...base,
          insert(payload) {
            supabase.inserted.push(payload);
            return {
              select: () => ({
                maybeSingle: async () => ({
                  data: { id: "manual-bypass-row", ...payload },
                  error: null,
                }),
              }),
            };
          },
        };
      }
      return base;
    },
  };

  const result = await createInboxSendNowQueueRow(
    {
      thread_key: "+12146072916",
      to_phone_number: "+12146072916",
      from_phone_number: "+18885551212",
      message_body: "Manual bypass proof",
      source: "manual_inbox",
      action: "send_now",
    },
    {
      supabase: paused_supabase,
      getSystemValue: async (key) => emergency_settings[key] ?? null,
      hardComplianceCheckImpl: async () => ({ blocked: false }),
      checkBlacklistPriorFailureImpl: async () => ({ blocked: false }),
      recentDeliveryFailuresImpl: async () => ({ suppress: false }),
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.queue_inserted, true);
  assert.equal(supabase.inserted.length, 1);
  assert.equal("agent_id" in supabase.inserted[0], false);
});

test("manual inbox send remains blocked for suppressed recipient", async () => {
  let insert_called = false;
  const result = await createInboxSendNowQueueRow(
    {
      thread_key: "+15005550001",
      to_phone_number: "+15005550001",
      from_phone_number: "+15005550002",
      message_body: "Should not send",
      source: "manual_inbox",
      action: "send_now",
    },
    {
      supabase: makeSuppressedSupabase(),
      insertImpl: async () => {
        insert_called = true;
        return { ok: true, queue_row_id: "should-not-insert" };
      },
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed");
  assert.equal(insert_called, false);
});

test("executeManualInboxSendNow bypasses campaign/emergency runtime brakes", async () => {
  const result = await executeManualInboxSendNow(
    {
      thread_key: "+12146072916",
      to_phone_number: "+12146072916",
      from_phone_number: "+18885551212",
      message_body: "Runtime brake bypass proof",
      queue_key: "inbox:send_now:runtime-bypass",
    },
    {
      getSystemValue: async (key) => {
        if (key === "queue_emergency_stop_at") return "2026-05-31T12:00:00.000Z";
        if (key === "campaign_mode") return "paused";
        return null;
      },
      supabase: {
        from() {
          return {
            update() {
              return this;
            },
            eq() {
              return this;
            },
            in() {
              return this;
            },
            select() {
              return this;
            },
            maybeSingle: async () => ({ data: null, error: null }),
          };
        },
      },
      createQueueRowImpl: async (input) => ({
        ok: true,
        queue_row_id: "runtime-bypass-row",
        queue_key: input.queue_key,
        result: { raw: { metadata: input.metadata } },
        warning_codes: [],
      }),
    }
  );

  assert.notEqual(result.reason, "runtime_brake_active");
  assert.notEqual(result.reason, "queue_emergency_stop_active");
  assert.notEqual(result.reason, "campaign_paused");
  assert.equal(result.reason, "queue_item_claim_conflict");
});