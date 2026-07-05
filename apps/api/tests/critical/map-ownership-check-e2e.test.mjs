import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSendQueueInsertPayload,
  buildSuccessMessageEvent,
} from "@/lib/supabase/sms-engine.js";
import {
  createInboxSendNowQueueRow,
  executeManualInboxSendNow,
  validateInboxSendNowPayload,
} from "@/lib/domain/inbox/send-now-service.js";

const MAP_PAYLOAD = {
  queue_key: "map:ownership_check:prop-david:1710000000000",
  queue_status: "queued",
  thread_key: "+16125550101",
  to_phone_number: "+16125550101",
  from_phone_number: "+16125559999",
  message_body:
    "Hi David, this is Michael. I had a quick question about 3945 25th Ave S, Minneapolis, MN 55406.",
  message_text:
    "Hi David, this is Michael. I had a quick question about 3945 25th Ave S, Minneapolis, MN 55406.",
  rendered_message:
    "Hi David, this is Michael. I had a quick question about 3945 25th Ave S, Minneapolis, MN 55406.",
  property_id: "prop-david",
  master_owner_id: "mo-david",
  prospect_id: "pros-david",
  phone_number_id: "ph-david",
  seller_first_name: "David",
  seller_display_name: "David Gilkey",
  agent_name: "Michael Porter",
  template_id: "tpl-david",
  selected_template_id: "tpl-david",
  template_key: "tpl-david",
  template_source: "sms_templates",
  language: "English",
  property_address: "3945 25th Ave S, Minneapolis, MN 55406",
  source: "map_command",
  send_source: "map_command",
  created_from: "leadcommand_map",
  action: "send_ownership_check",
  message_type: "ownership_check",
  use_case_template: "ownership_check",
  manual_operator_send: true,
  metadata: {
    source: "map_command",
    send_source: "map_command",
    origin_surface: "command_map",
    action: "send_ownership_check",
    manual_operator_send: true,
    message_events_source_app: "LeadCommand Map",
    seller_first_name: "David",
    seller_display_name: "David Gilkey",
    agent_name: "Michael Porter",
    template_id: "tpl-david",
    selected_template_id: "tpl-david",
    template_key: "tpl-david",
    template_source: "sms_templates",
    rendered_message:
      "Hi David, this is Michael. I had a quick question about 3945 25th Ave S, Minneapolis, MN 55406.",
  },
};

function makeSupabaseForE2E() {
  let claimedMetadata = null;
  let insertedPayload = null;
  const supabase = {
    from(table) {
      const chain = {
        update(payload) {
          if (table === "send_queue") claimedMetadata = payload.metadata;
          return chain;
        },
        eq() { return chain; },
        in() { return chain; },
        select() { return chain; },
        contains() { return chain; },
        gte() { return chain; },
        or() { return chain; },
        maybeSingle: async () => {
          if (table === "send_queue" && claimedMetadata) {
            return {
              data: {
                id: "queue-row-1",
                ...MAP_PAYLOAD,
                metadata: claimedMetadata,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
    get insertedPayload() { return insertedPayload; },
    get claimedMetadata() { return claimedMetadata; },
    setInserted(payload) { insertedPayload = payload; },
  };
  return supabase;
}

test("validateInboxSendNowPayload preserves map ownership provenance fields", () => {
  const validation = validateInboxSendNowPayload(MAP_PAYLOAD, "+16125559999");
  assert.equal(validation.ok, true);
  const n = validation.normalized;
  assert.equal(n.source, "map_command");
  assert.equal(n.send_source, "map_command");
  assert.equal(n.message_type, "ownership_check");
  assert.equal(n.seller_first_name, "David");
  assert.equal(n.seller_display_name, "David Gilkey");
  assert.equal(n.agent_name, "Michael Porter");
  assert.equal(n.template_id, "tpl-david");
  assert.equal(n.selected_template_id, "tpl-david");
  assert.equal(n.template_key, "tpl-david");
  assert.equal(n.template_source, "sms_templates");
  assert.equal(n.rendered_message, MAP_PAYLOAD.rendered_message);
  assert.equal(n.metadata.source, "map_command");
  assert.equal(n.metadata.message_events_source_app, "LeadCommand Map");
});

test("createInboxSendNowQueueRow insert payload retains map provenance", async () => {
  let captured = null;
  const result = await createInboxSendNowQueueRow(MAP_PAYLOAD, {
    resolveFromImpl: async () => "+16125559999",
    hardComplianceCheckImpl: async () => ({ blocked: false }),
    checkBlacklistPriorFailureImpl: async () => ({ blocked: false }),
    recentDeliveryFailuresImpl: async () => ({ suppress: false }),
    canSendImpl: async () => ({ ok: true }),
    insertImpl: async (payload) => {
      captured = payload;
      return {
        ok: true,
        queue_row_id: "queue-row-1",
        queue_id: payload.queue_id,
        queue_key: payload.queue_key,
        raw: payload,
      };
    },
    supabase: {
      from() {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          in() { return chain; },
          contains() { return chain; },
          gte() { return chain; },
          or() { return chain; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    },
  });

  assert.equal(result.ok, true);
  assert.ok(captured);
  assert.equal(captured.source, "map_command");
  assert.equal(captured.message_type, "ownership_check");
  assert.equal(captured.seller_first_name, "David");
  assert.equal(captured.seller_display_name, "David Gilkey");
  assert.equal(captured.agent_name, "Michael Porter");
  assert.equal(captured.template_id, "tpl-david");
  assert.equal(captured.selected_template_id, "tpl-david");
  assert.equal(captured.template_key, "tpl-david");
  assert.equal(captured.template_source, "sms_templates");
  assert.equal(captured.rendered_message, MAP_PAYLOAD.rendered_message);
  assert.equal(captured.property_id, "prop-david");
  assert.equal(captured.master_owner_id, "mo-david");
  assert.equal(captured.prospect_id, "pros-david");
  assert.equal(captured.phone_number_id, "ph-david");
  assert.equal(captured.metadata.source, "map_command");
  assert.notEqual(captured.source, "manual_inbox");

  const insertPayload = buildSendQueueInsertPayload(captured);
  assert.equal(insertPayload.seller_first_name, "David");
  assert.equal(insertPayload.message_type, "ownership_check");
  assert.equal(insertPayload.source, "map_command");
  assert.equal(insertPayload.property_id, "prop-david");
  assert.equal(insertPayload.master_owner_id, "mo-david");
  assert.equal(insertPayload.prospect_id, "pros-david");
  assert.equal(insertPayload.phone_number_id, "ph-david");
});

test("executeManualInboxSendNow claim metadata preserves map_command and message event source_app", async () => {
  const supabase = makeSupabaseForE2E();
  let outboundEvent = null;

  const result = await executeManualInboxSendNow(MAP_PAYLOAD, {
    supabase,
    createQueueRowImpl: async (input) => {
      supabase.setInserted(input);
      return {
        ok: true,
        queue_row_id: "queue-row-1",
        queue_id: input.queue_id,
        queue_key: input.queue_key,
        result: { raw: input },
      };
    },
    sendTextgridImpl: async () => ({ ok: true, sid: "SM_TEST_1", status: "sent" }),
    finalizeSendQueueSuccessImpl: async (row) => row,
    writeOutboundSuccessMessageEventImpl: async (row, sendResult) => {
      outboundEvent = buildSuccessMessageEvent(row, sendResult);
      return outboundEvent;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(supabase.claimedMetadata?.source, "map_command");
  assert.equal(supabase.claimedMetadata?.send_source, "map_command");
  assert.equal(supabase.claimedMetadata?.created_from, "leadcommand_map");
  assert.equal(supabase.claimedMetadata?.action, "send_ownership_check");
  assert.equal(supabase.claimedMetadata?.origin_surface, "command_map");
  assert.equal(supabase.claimedMetadata?.message_events_source_app, "LeadCommand Map");
  assert.notEqual(supabase.claimedMetadata?.source, "manual_inbox");

  assert.ok(outboundEvent);
  assert.equal(outboundEvent.source_app, "LeadCommand Map");
  assert.equal(outboundEvent.trigger_name, "queue-send");
  assert.equal(outboundEvent.metadata?.source, "map_command");
});