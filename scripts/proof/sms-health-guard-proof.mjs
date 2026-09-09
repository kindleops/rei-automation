#!/usr/bin/env node

import { evaluateSmsHealthGuard, getDefaultSmsHealthGuardConfig } from "../../apps/api/src/lib/domain/delivery/sms-health-guard.js";

let failures = 0;

// Disposition 2026-09-09: the guard carries NO hardcoded blocklists. Blocks live in
// system_control.sms_blocked_* (production) or SMS_BLOCKED_* env. Fixtures here use env.
process.env.SMS_BLOCKED_SENDER_NUMBERS = "+14704920588";
process.env.SMS_BLOCKED_TEMPLATE_IDS = "208481";

function mark(label, condition, detail = "") {
  const line = `${condition ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`;
  if (condition) {
    console.log(line);
  } else {
    failures += 1;
    console.error(line);
  }
}

const defaults = getDefaultSmsHealthGuardConfig({}, {});
mark(
  "hardcoded blocklists are empty (blocks live in system_control / env only)",
  defaults.blocked_sender_numbers.length === 0 && defaults.blocked_template_ids.length === 0,
  JSON.stringify(defaults)
);

const blockedSender = evaluateSmsHealthGuard({
  from_phone_number: "+14704920588",
  template_id: "900001",
  routing_tier: "exact_market_match",
  first_touch: true,
  require_local_routing: true,
});

mark("env-blocked sender number is blocked", blockedSender.allowed === false && blockedSender.reason === "blocked_sender_number", JSON.stringify(blockedSender));

const blockedTemplate = evaluateSmsHealthGuard({
  from_phone_number: "+15551231234",
  template_id: "208481",
  routing_tier: "exact_market_match",
  first_touch: true,
  require_local_routing: true,
});

mark("env-blocked template id is blocked", blockedTemplate.allowed === false && blockedTemplate.reason === "blocked_template_id", JSON.stringify(blockedTemplate));

const blockedRegional = evaluateSmsHealthGuard({
  from_phone_number: "+15551231234",
  template_id: "900001",
  routing_tier: "approved_regional_fallback",
  first_touch: true,
  require_local_routing: true,
});

mark(
  "approved regional fallback is blocked for first touch when local routing is required",
  blockedRegional.allowed === false && blockedRegional.reason === "regional_fallback_blocked_require_local_routing",
  JSON.stringify(blockedRegional)
);

const safe = evaluateSmsHealthGuard({
  from_phone_number: "+15551231234",
  template_id: "900001",
  routing_tier: "exact_market_match",
  first_touch: true,
  require_local_routing: true,
});

mark("safe sender plus safe template plus exact market match passes", safe.allowed === true, JSON.stringify(safe));

if (failures > 0) {
  console.error(`sms health guard proof failed: ${failures}`);
  process.exit(1);
}

console.log("PASS sms health guard proof");
