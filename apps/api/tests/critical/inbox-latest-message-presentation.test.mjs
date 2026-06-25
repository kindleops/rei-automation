import test from "node:test";
import assert from "node:assert/strict";

import {
  gateDeliveryFieldsForDirection,
  normalizeLatestMessageDirection,
  resolveLatestMessageStatusLabel,
} from "../../src/lib/domain/inbox/latest-message-presentation.js";

test("inbound latest message never surfaces delivery receipt labels", () => {
  const row = {
    latest_message_direction: "inbound",
    latest_delivery_status: "delivered",
    delivery_status: "delivered",
    provider_delivery_status: "delivered",
  };
  assert.equal(resolveLatestMessageStatusLabel(row), "Inbound");
  const gated = gateDeliveryFieldsForDirection(row, "inbound");
  assert.equal(gated.latest_delivery_status, null);
  assert.equal(gated.delivery_status, null);
});

test("outbound delivered followed by inbound shows Inbound", () => {
  assert.equal(
    resolveLatestMessageStatusLabel({
      latest_message_direction: "inbound",
      latest_delivery_status: "delivered",
    }),
    "Inbound",
  );
});

test("outbound failed followed by inbound shows Inbound", () => {
  assert.equal(
    resolveLatestMessageStatusLabel({
      latest_message_direction: "inbound",
      latest_delivery_status: "failed",
      latest_failed_at: "2026-06-24T12:00:00.000Z",
    }),
    "Inbound",
  );
});

test("inbound followed by outbound delivered shows Delivered", () => {
  assert.equal(
    resolveLatestMessageStatusLabel({
      latest_message_direction: "outbound",
      latest_delivery_status: "delivered",
      latest_delivered_at: "2026-06-24T12:00:00.000Z",
    }),
    "Delivered",
  );
});

test("inbound followed by outbound failed shows Failed", () => {
  assert.equal(
    resolveLatestMessageStatusLabel({
      latest_message_direction: "outbound",
      latest_delivery_status: "failed",
      latest_failed_at: "2026-06-24T12:00:00.000Z",
    }),
    "Failed",
  );
});

test("normalizeLatestMessageDirection handles shorthand values", () => {
  assert.equal(normalizeLatestMessageDirection("in"), "inbound");
  assert.equal(normalizeLatestMessageDirection("outbound"), "outbound");
  assert.equal(normalizeLatestMessageDirection(""), "unknown");
});