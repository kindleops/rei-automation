import assert from "node:assert/strict";
import test from "node:test";

import { validateInboxSendNowPayload } from "../../src/lib/domain/inbox/send-now-service.js";

test("map ownership check payload validates with ownership_check message_type", () => {
  const validation = validateInboxSendNowPayload(
    {
      queue_key: "map:ownership_check:prop-1:123",
      thread_key: "+16125550101",
      to_phone_number: "+16125550101",
      from_phone_number: "+16125559999",
      message_body: "Hi David, this is Michael. I had a quick question about 3945 25th Ave S, Minneapolis, MN 55406.",
      message_type: "ownership_check",
      use_case_template: "ownership_check",
      source: "map_command",
      send_source: "map_command",
      created_from: "leadcommand_map",
      action: "send_ownership_check",
      property_id: "prop-1",
      master_owner_id: "mo-1",
      prospect_id: "pros-1",
      phone_id: "ph_certfix_16124515970",
      seller_first_name: "David",
      template_id: "tpl-1",
      selected_template_id: "tpl-1",
      metadata: {
        source: "map_command",
        send_source: "map_command",
        origin_surface: "command_map",
        action: "send_ownership_check",
        manual_operator_send: true,
        message_events_source_app: "LeadCommand Map",
      },
    },
    "+16125559999",
  );

  assert.equal(validation.ok, true);
  assert.equal(validation.normalized.message_type, "ownership_check");
  assert.equal(validation.normalized.use_case_template, "ownership_check");
  assert.equal(validation.normalized.source, "map_command");
  assert.equal(validation.normalized.action, "send_ownership_check");
  // Canonical ph_ text id preserved as phone_id; UUID column stays null.
  assert.equal(validation.normalized.phone_id, "ph_certfix_16124515970");
  assert.equal(validation.normalized.phone_number_id, null);
});

test("map ownership check payload does not default to manual_inbox", () => {
  const validation = validateInboxSendNowPayload(
    {
      queue_key: "map:ownership_check:prop-2:456",
      thread_key: "+16125550202",
      to_phone_number: "+16125550202",
      from_phone_number: "+16125559999",
      message_body: "Hey Anthony, this is Helen. Are you the owner of 3752 16th Ave S, Minneapolis, MN 55407?",
      message_type: "ownership_check",
      use_case_template: "ownership_check",
      source: "map_command",
      action: "send_ownership_check",
      metadata: { source: "map_command", action: "send_ownership_check" },
    },
    "+16125559999",
  );

  assert.equal(validation.ok, true);
  assert.notEqual(validation.normalized.source, "manual_inbox");
  assert.notEqual(validation.normalized.message_type, "manual_reply");
});