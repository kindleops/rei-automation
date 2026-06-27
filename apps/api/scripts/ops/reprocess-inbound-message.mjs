#!/usr/bin/env node
import { handleTextgridInbound } from "../../src/lib/flows/handle-textgrid-inbound.js";

const providerMessageSid = process.argv[2];
const from = process.argv[3];
const to = process.argv[4];
const body = process.argv[5] || "Yes";

if (!providerMessageSid || !from || !to) {
  console.error(
    "Usage: node scripts/ops/reprocess-inbound-message.mjs <provider_sid> <from_e164> <to_e164> [body]"
  );
  process.exit(1);
}

const payload = {
  message_id: providerMessageSid,
  from,
  to,
  message_body: body,
  body,
  status: "received",
  received_at: new Date().toISOString(),
};

const result = await handleTextgridInbound(payload, {
  auto_reply_enabled: true,
  auto_reply_live_enabled: true,
  auto_reply_mode: "live_limited",
  inbound_user_initiated: false,
});

console.log(
  JSON.stringify(
    {
      ok: result?.ok,
      duplicate: result?.duplicate,
      reason: result?.reason,
      error: result?.error,
      detected_intent:
        result?.classification?.primary_intent ||
        result?.seller_stage_reply?.plan?.detected_intent,
      brain_stage: result?.seller_stage_reply?.brain_stage,
      queued: result?.seller_stage_reply?.queued,
      queue_row_id: result?.autopilot_queue_row?.id,
    },
    null,
    2
  )
);