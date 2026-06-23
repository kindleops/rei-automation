import test from "node:test";
import assert from "node:assert/strict";

import { validateOutboundSmsPayload } from "@/lib/domain/messaging/MessageValidationService.js";

test("RISK-029: missing to_phone_number → missing_to_phone_number", () => {
  const r = validateOutboundSmsPayload({ message_body: "Hello John, nice to connect." });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_to_phone_number");
});

test("RISK-029: missing message_body → missing_message_body", () => {
  const r = validateOutboundSmsPayload({ to_phone_number: "+15005550001" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_message_body");
});

test("RISK-029: manual message 1 char → message_too_short", () => {
  const r = validateOutboundSmsPayload({ to_phone_number: "+15005550001", message_body: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "message_too_short");
});

test("RISK-029: auto_reply 9 chars → message_too_short", () => {
  const r = validateOutboundSmsPayload({
    to_phone_number: "+15005550001",
    message_body: "123456789",
    message_type: "auto_reply",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "message_too_short");
});

test("RISK-029: blank greeting Hi , → blank_greeting_message_body", () => {
  const r = validateOutboundSmsPayload({
    to_phone_number: "+15005550001",
    message_body: "Hi , we noticed your property.",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "blank_greeting_message_body");
});

test("RISK-029: Hey , → blank_greeting_message_body", () => {
  const r = validateOutboundSmsPayload({
    to_phone_number: "+15005550001",
    message_body: "Hey , I wanted to reach out.",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "blank_greeting_message_body");
});

test("RISK-029: <script> tag → html_content_blocked", () => {
  const r = validateOutboundSmsPayload({
    to_phone_number: "+15005550001",
    message_body: "Hi John <script>alert(1)</script>",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "html_content_blocked");
});

test("RISK-029: valid manual payload → ok:true", () => {
  const r = validateOutboundSmsPayload({
    to_phone_number: "+15005550001",
    message_body: "Hi John, are you still interested in selling?",
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test("RISK-029: valid auto_reply payload → ok:true", () => {
  const r = validateOutboundSmsPayload({
    to_phone_number: "+15005550001",
    message_body: "Thank you for confirming ownership. Would you consider an offer?",
    message_type: "auto_reply",
  });
  assert.equal(r.ok, true);
});

test("RISK-029: deferred message bypasses body check → ok:true", () => {
  const r = validateOutboundSmsPayload({
    to_phone_number: "+15005550001",
    message_body: "",
    metadata: { deferred_message_resolution: true },
  });
  assert.equal(r.ok, true);
});

test("RISK-029: same input → same verdict in both manual and auto contexts", () => {
  const payload = {
    to_phone_number: "+15005550001",
    message_body: "Hi John, is the house still available?",
  };
  const manual = validateOutboundSmsPayload({ ...payload, message_type: "manual_reply" });
  const auto = validateOutboundSmsPayload({ ...payload, message_type: "auto_reply" });
  assert.equal(manual.ok, true);
  assert.equal(auto.ok, true);
  assert.equal(manual.reason, auto.reason);
});
