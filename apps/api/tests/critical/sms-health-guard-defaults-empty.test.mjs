/**
 * sms-health-guard-defaults-empty.test.mjs
 *
 * Disposition 2026-09-09: the guard's HARDCODED blocklists (ff571386, unreviewed
 * WIP, no recorded rationale) are gone. A block is legitimate only where the
 * operator can see it: system_control.sms_blocked_* or SMS_BLOCKED_* env. This
 * test keeps the defaults empty and proves both dynamic layers still enforce
 * at selection (blocked sets) and at dispatch (evaluateSmsHealthGuard).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  getDefaultSmsHealthGuardConfig,
  getDispatchBlockedSets,
  isTemplateDispatchBlocked,
  isSenderDispatchBlocked,
  evaluateSmsHealthGuard,
} from "@/lib/domain/delivery/sms-health-guard.js";

const NO_ENV = {};
const FORMER_TEMPLATE_LITERALS = ["208481", "204257", "204529", "204561", "204705", "204721", "207681"];
const FORMER_SENDER_LITERALS = ["+14704920588", "+14693131600"];

test("hardcoded defaults are empty: nothing is blocked by a literal in code", () => {
  const config = getDefaultSmsHealthGuardConfig(NO_ENV, {});
  assert.deepEqual(config.blocked_sender_numbers, []);
  assert.deepEqual(config.blocked_template_ids, []);
  const sets = getDispatchBlockedSets(NO_ENV, {});
  for (const id of FORMER_TEMPLATE_LITERALS) assert.equal(isTemplateDispatchBlocked(id, sets), false, id);
  for (const phone of FORMER_SENDER_LITERALS) assert.equal(isSenderDispatchBlocked(phone, sets), false, phone);
});

test("system_control lists still enforce (the operator-managed layer, as written in prod)", () => {
  const sets = getDispatchBlockedSets(NO_ENV, {
    sms_blocked_sender_numbers: "+14704920588,+14693131600",
    sms_blocked_template_ids: "204257,204561,204705,204721,207681",
  });
  assert.equal(isSenderDispatchBlocked("+14704920588", sets), true);
  assert.equal(isSenderDispatchBlocked("4693131600", sets), true, "normalized to E.164");
  assert.equal(isTemplateDispatchBlocked("204257", sets), true);
  assert.equal(isTemplateDispatchBlocked("204529", sets), false, "OBSOLETE entry is not carried");
  assert.equal(isTemplateDispatchBlocked("208481", sets), false, "OBSOLETE entry is not carried");
});

test("env lists still enforce (the emergency layer)", () => {
  const sets = getDispatchBlockedSets(
    { SMS_BLOCKED_SENDER_NUMBERS: "+15550001111", SMS_BLOCKED_TEMPLATE_IDS: "900001" },
    {}
  );
  assert.equal(isSenderDispatchBlocked("+15550001111", sets), true);
  assert.equal(isTemplateDispatchBlocked("900001", sets), true);
});

test("dispatch refuses from a dynamic list exactly as it used to from the literal", () => {
  process.env.SMS_BLOCKED_TEMPLATE_IDS = "900002";
  process.env.SMS_BLOCKED_SENDER_NUMBERS = "+15550002222";
  try {
    const t = evaluateSmsHealthGuard({
      from_phone_number: "+15551231234", template_id: "900002", routing_tier: "exact_market_match", first_touch: true,
    });
    assert.equal(t.allowed, false);
    assert.equal(t.reason, "blocked_template_id");
    const s = evaluateSmsHealthGuard({
      from_phone_number: "+15550002222", template_id: "900003", routing_tier: "exact_market_match", first_touch: true,
    });
    assert.equal(s.allowed, false);
    assert.equal(s.reason, "blocked_sender_number");
  } finally {
    delete process.env.SMS_BLOCKED_TEMPLATE_IDS;
    delete process.env.SMS_BLOCKED_SENDER_NUMBERS;
  }
});
