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
import { isUuid } from "@/lib/utils/is-uuid.js";

// Canonical production phones.phone_id is ph_-prefixed TEXT. Guard: no ph_ text may
// ever be assigned to a UUID column (phone_number_id).
const CANONICAL_PHONE_ID = "ph_certfix_16124515970";
function assertUuidOrNull(value, label) {
  assert.ok(
    value == null || isUuid(String(value)),
    `${label} must be null or a genuine UUID, got: ${JSON.stringify(value)}`,
  );
}

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
  // Canonical ph_ text id — belongs in phone_id, never in the UUID phone_number_id column.
  phone_id: CANONICAL_PHONE_ID,
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
  // Canonical ph_ text preserved as phone_id; UUID column stays null (never coerced).
  assert.equal(n.phone_id, CANONICAL_PHONE_ID);
  assert.equal(n.phone_number_id, null);
  assertUuidOrNull(n.phone_number_id, "normalized.phone_number_id");
  assert.equal(n.metadata.canonical_phone_id, CANONICAL_PHONE_ID);
});

test("validateInboxSendNowPayload rescues a mis-placed ph_ id and never keeps it in phone_number_id", () => {
  // Fail-closed: legacy payload that (incorrectly) sends the ph_ id as phone_number_id.
  const legacy = { ...MAP_PAYLOAD, phone_id: undefined, phone_number_id: CANONICAL_PHONE_ID };
  const validation = validateInboxSendNowPayload(legacy, "+16125559999");
  assert.equal(validation.ok, true);
  assert.equal(validation.normalized.phone_id, CANONICAL_PHONE_ID);
  assert.equal(validation.normalized.phone_number_id, null);
  assertUuidOrNull(validation.normalized.phone_number_id, "rescued.phone_number_id");
});

test("a genuine UUID phone_number_id is permitted through to the UUID column", () => {
  const uuid = "11111111-2222-4333-8444-555555555555";
  const withUuid = { ...MAP_PAYLOAD, phone_id: undefined, phone_number_id: uuid };
  const n = validateInboxSendNowPayload(withUuid, "+16125559999").normalized;
  assert.equal(n.phone_number_id, uuid);
  assertUuidOrNull(n.phone_number_id, "uuid.phone_number_id");
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
  // Canonical ph_ id lives in phone_id; UUID column phone_number_id stays null.
  assert.equal(captured.phone_id, CANONICAL_PHONE_ID);
  assert.equal(captured.phone_number_id, null);
  assertUuidOrNull(captured.phone_number_id, "insertRow.phone_number_id");
  assert.equal(captured.metadata.source, "map_command");
  assert.notEqual(captured.source, "manual_inbox");

  const insertPayload = buildSendQueueInsertPayload(captured);
  assert.equal(insertPayload.seller_first_name, "David");
  assert.equal(insertPayload.message_type, "ownership_check");
  assert.equal(insertPayload.source, "map_command");
  assert.equal(insertPayload.property_id, "prop-david");
  assert.equal(insertPayload.master_owner_id, "mo-david");
  assert.equal(insertPayload.prospect_id, "pros-david");
  // Final send_queue insert: phone_id = canonical text, phone_number_id = null (no ph_ in UUID).
  assert.equal(insertPayload.phone_id, CANONICAL_PHONE_ID);
  assert.equal(insertPayload.phone_number_id, null);
  assertUuidOrNull(insertPayload.phone_number_id, "sendQueueInsert.phone_number_id");
  assert.equal(insertPayload.metadata.canonical_phone_id, CANONICAL_PHONE_ID);
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
  // message_events carries the canonical ph_ id only in metadata; the UUID column
  // (if present) must never hold ph_ text.
  assert.equal(outboundEvent.metadata?.canonical_phone_id, CANONICAL_PHONE_ID);
  assertUuidOrNull(outboundEvent.phone_number_id, "messageEvent.phone_number_id");
  // Claim metadata must also carry the canonical id through (no ph_ in any UUID field).
  assert.equal(supabase.claimedMetadata?.canonical_phone_id, CANONICAL_PHONE_ID);
});