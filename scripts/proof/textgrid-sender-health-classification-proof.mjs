#!/usr/bin/env node

import { buildTextGridSenderHealth } from "../../apps/api/src/lib/domain/messaging/textgrid-sender-health.js";

let failures = 0;

function mark(label, condition, detail = "") {
  const line = `${condition ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`;
  if (condition) {
    console.log(line);
  } else {
    failures += 1;
    console.error(line);
  }
}

const rows = [
  {
    id: "msg-content-filter",
    direction: "outbound",
    from_phone_number: "+15550001111",
    to_phone_number: "+15550002222",
    provider_delivery_status: "failed",
    delivery_status: null,
    failure_reason: null,
    error_message: null,
    provider_failure_reason: "Blocked by Textgrid Content Filter",
    metadata: {},
    message_body: "Hello Sarah, would you consider an offer?",
    updated_at: "2026-05-31T12:00:00.000Z",
  },
  {
    id: "msg-content-filter-column",
    direction: "outbound",
    from_phone_number: "+15550003333",
    to_phone_number: "+15550004444",
    provider_delivery_status: "failed",
    delivery_status: null,
    failure_class: "content_filter_blocked",
    metadata: {},
    message_body: "Checking whether you would sell the house.",
    updated_at: "2026-05-31T12:05:00.000Z",
  },
];

const health = buildTextGridSenderHealth(rows, []);
const sender = health.find((row) => row.sender === "+15550001111");
const columnSender = health.find((row) => row.sender === "+15550003333");

mark("sender health row exists", Boolean(sender), JSON.stringify(health));
mark("content filter counted without failure_class", sender?.content_filter_count === 1, JSON.stringify(sender));
mark("failed count includes provider content filter", sender?.failed_count === 1, JSON.stringify(sender));
mark("content filter rate uses sender denominator", sender?.content_filter_rate === 100, JSON.stringify(sender));
mark("last failed timestamp captured", sender?.last_failed_at === "2026-05-31T12:00:00.000Z", JSON.stringify(sender));
mark("content filter counted from failure_class column", columnSender?.content_filter_count === 1, JSON.stringify(columnSender));

if (failures > 0) {
  console.error(`textgrid sender health classification proof failed: ${failures}`);
  process.exit(1);
}

console.log("PASS textgrid sender health classification proof");
