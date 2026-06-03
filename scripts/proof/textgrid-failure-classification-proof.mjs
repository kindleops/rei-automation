#!/usr/bin/env node

import { normalizeTextGridFailure } from "../../apps/api/src/lib/domain/messaging/textgrid-failure-normalization.js";

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

const cases = [
  {
    label: "content filter",
    input: { status: "failed", reason: "Blocked by Textgrid Content Filter" },
    expected: "content_filter_blocked",
    retry_allowed: false,
  },
  {
    label: "recipient opted out",
    input: { status: "failed", error_message: "Recipient opted out" },
    expected: "recipient_opted_out",
    retry_allowed: false,
  },
  {
    label: "invalid to number",
    input: { status: "failed", message: "'To' number invalid" },
    expected: "invalid_to_number",
    retry_allowed: false,
  },
  {
    label: "end user out of credit",
    input: { status: "failed", provider_failure_reason: "End User Out of Credit" },
    expected: "recipient_out_of_credit",
    retry_allowed: true,
  },
  {
    label: "unknown failed reason",
    input: { status: "failed", error_message: "Provider returned failed" },
    expected: "unknown_failure",
    retry_allowed: false,
  },
  {
    label: "existing failure_class column",
    input: { status: "failed", failure_class: "content_filter_blocked" },
    expected: "content_filter_blocked",
    retry_allowed: false,
  },
];

for (const item of cases) {
  const result = normalizeTextGridFailure(item.input);
  mark(`${item.label} maps to ${item.expected}`, result.failure_class === item.expected, JSON.stringify(result));
  mark(`${item.label} delivery_status failed`, result.delivery_status === "failed", JSON.stringify(result));
  mark(`${item.label} retry_allowed`, result.retry_allowed === item.retry_allowed, JSON.stringify(result));
}

if (failures > 0) {
  console.error(`textgrid failure classification proof failed: ${failures}`);
  process.exit(1);
}

console.log("PASS textgrid failure classification proof");
