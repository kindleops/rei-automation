import assert from "node:assert/strict";
import test from "node:test";

import { isUuid } from "@/lib/utils/is-uuid.js";
import {
  buildSendQueueInsertPayload,
  buildSuccessMessageEvent,
  normalizeSendQueueRow,
} from "@/lib/supabase/sms-engine.js";

// Column-type contract verified against production (live assertion lives in
// map-ownership-production-lookup.test.mjs via the PostgREST OpenAPI schema).
// Canonical phones.phone_id is ph_-prefixed TEXT; phone_number_id columns are UUID.
const COLUMN_TYPE_CONTRACT = Object.freeze({
  "phones.phone_id": "text",
  "send_queue.phone_id": "text",
  "send_queue.phone_number_id": "uuid",
  "message_events.phone_number_id": "uuid",
});

const PH_TEXT = "ph_certfix_16124515970";
const UUID = "11111111-2222-4333-8444-555555555555";
const BASE = {
  message_body: "hello",
  to_phone_number: "+16125550101",
  from_phone_number: "+16125559999",
  queue_key: "qk-contract-1",
};

test("column-type contract is stable and documented", () => {
  assert.equal(COLUMN_TYPE_CONTRACT["phones.phone_id"], "text");
  assert.equal(COLUMN_TYPE_CONTRACT["send_queue.phone_id"], "text");
  assert.equal(COLUMN_TYPE_CONTRACT["send_queue.phone_number_id"], "uuid");
  assert.equal(COLUMN_TYPE_CONTRACT["message_events.phone_number_id"], "uuid");
});

test("isUuid guard: ph_ text is not a UUID; a real UUID is", () => {
  assert.equal(isUuid(PH_TEXT), false);
  assert.equal(isUuid(UUID), true);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid("ph-david"), false);
});

test("normalizeSendQueueRow rescues a mis-placed ph_ from phone_number_id into phone_id", () => {
  const n = normalizeSendQueueRow({ ...BASE, phone_number_id: PH_TEXT });
  assert.equal(n.phone_id, PH_TEXT);
  assert.equal(n.phone_number_id, null);
});

test("send_queue insert: ph_ id -> phone_id (text); phone_number_id stays null; metadata carries canonical_phone_id", () => {
  const insert = buildSendQueueInsertPayload({ ...BASE, phone_id: PH_TEXT });
  assert.equal(insert.phone_id, PH_TEXT);
  assert.equal(insert.phone_number_id, null);
  assert.equal(insert.metadata.canonical_phone_id, PH_TEXT);
});

test("send_queue insert: a genuine UUID passes through to phone_number_id", () => {
  const insert = buildSendQueueInsertPayload({ ...BASE, phone_number_id: UUID });
  assert.equal(insert.phone_number_id, UUID);
});

test("outbound message_event: ph_ preserved only in metadata.canonical_phone_id, never in a UUID field", () => {
  const evt = buildSuccessMessageEvent({ ...BASE, phone_id: PH_TEXT }, { sid: "SM1", status: "sent" });
  assert.equal(evt.metadata.canonical_phone_id, PH_TEXT);
  assert.ok(evt.phone_number_id == null || isUuid(String(evt.phone_number_id)),
    "message_event must never carry ph_ text in phone_number_id");
});
