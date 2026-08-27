import test from "node:test";
import assert from "node:assert/strict";

import {
  isInboundAutoReply,
  isImmediateInboundAutoReply,
  isManualInboxSend,
} from "@/lib/domain/queue/is-manual-inbox-send.js";

const NOW = "2026-08-27T04:00:00.000Z";
const FRESH = "2026-08-27T03:59:10.000Z"; // 50s ago
const AGED = "2026-08-27T01:30:00.000Z"; // 2.5h ago

// Regression for the contact-window (quiet-hours) exemption. A reply generated
// in direct response to a consumer-initiated inbound (the seller just texted
// us) must be exempt from the 21:00 local outbound send window — replying
// promptly is responsive, consumer-initiated communication. The exemption must
// be scoped tightly: outbound campaign rows, nurture, and follow-ups must NOT
// match (they are sender-initiated and must respect quiet hours).

test("inbound auto-reply is recognized by queue_key prefix (immediate seller-flow reply)", () => {
  const row = {
    queue_key:
      "inbound_auto_reply:4ec7942e-8250-4128-abb6-d348fa4cf7a7:occ_seller_asking_price_en_v1:+16128072000",
    type: "auto_reply",
    metadata: { source: "auto_reply" },
  };
  assert.equal(isInboundAutoReply(row), true);
  // It is NOT a manual inbox send (that is a distinct exemption).
  assert.equal(isManualInboxSend(row), false);
});

test("inbound auto-reply is recognized by type+source even without the prefix", () => {
  assert.equal(
    isInboundAutoReply({ type: "auto_reply", metadata: { source: "auto_reply" } }),
    true
  );
  assert.equal(
    isInboundAutoReply({
      type: "auto_reply",
      metadata: { source: "textgrid_inbound_unknown_router" },
    }),
    true
  );
});

test("queue_key can be read from metadata as a fallback", () => {
  assert.equal(
    isInboundAutoReply({ metadata: { queue_key: "inbound_auto_reply:x:y:+1555" } }),
    true
  );
});

test("outbound campaign rows are NOT exempt (must respect quiet hours)", () => {
  assert.equal(
    isInboundAutoReply({
      queue_key: "campaign:abc123:first_touch",
      type: "campaign",
      metadata: { source: "campaign_feed" },
    }),
    false
  );
});

test("nurture / scheduled follow-up rows are NOT exempt", () => {
  assert.equal(
    isInboundAutoReply({
      queue_key: "followup:seller:stage3",
      type: "follow_up",
      metadata: { source: "followup_scheduler" },
    }),
    false
  );
  // A non-auto_reply type with an unrelated source must not match.
  assert.equal(
    isInboundAutoReply({ type: "outbound", metadata: { source: "autopilot" } }),
    false
  );
});

test("manual inbox sends are handled by their own exemption, not this one", () => {
  const manual = {
    queue_key: "inbox:send_now:thread-1",
    metadata: { source: "inbox", action: "send_now" },
  };
  assert.equal(isManualInboxSend(manual), true);
  assert.equal(isInboundAutoReply(manual), false);
});

test("empty / null rows do not match (fail safe)", () => {
  assert.equal(isInboundAutoReply(null), false);
  assert.equal(isInboundAutoReply({}), false);
  assert.equal(isInboundAutoReply({ metadata: {} }), false);
});

// --- Freshness bound: only IMMEDIATE inbound replies are quiet-hours exempt ---

test("fresh inbound auto-reply IS quiet-hours exempt", () => {
  const row = {
    queue_key: "inbound_auto_reply:evt:tmpl:+16128072000",
    type: "auto_reply",
    created_at: FRESH,
    metadata: { source: "auto_reply" },
  };
  assert.equal(isImmediateInboundAutoReply(row, NOW), true);
});

test("aged inbound auto-reply is NOT exempt (must respect quiet hours)", () => {
  const row = {
    queue_key: "inbound_auto_reply:evt:tmpl:+16128072000",
    type: "auto_reply",
    created_at: AGED, // 2.5h old — backlogged/retry-delayed
    metadata: { source: "auto_reply" },
  };
  // Correct shape, but stale → defers to next window.
  assert.equal(isInboundAutoReply(row), true);
  assert.equal(isImmediateInboundAutoReply(row, NOW), false);
});

test("inbound auto-reply with no timestamp fails CLOSED (not exempt)", () => {
  const row = {
    queue_key: "inbound_auto_reply:evt:tmpl:+16128072000",
    type: "auto_reply",
    metadata: { source: "auto_reply" },
  };
  assert.equal(isImmediateInboundAutoReply(row, NOW), false);
});

test("freshness anchor falls back to metadata inbound timestamp", () => {
  const row = {
    type: "auto_reply",
    metadata: { source: "auto_reply", inbound_received_at: FRESH },
  };
  assert.equal(isImmediateInboundAutoReply(row, NOW), true);
});

test("outbound rows are never exempt regardless of freshness", () => {
  const row = {
    queue_key: "campaign:abc:first_touch",
    type: "campaign",
    created_at: FRESH,
    metadata: { source: "campaign_feed" },
  };
  assert.equal(isImmediateInboundAutoReply(row, NOW), false);
});

test("a future created_at (clock skew) does not exempt", () => {
  const row = {
    queue_key: "inbound_auto_reply:evt:tmpl:+1555",
    type: "auto_reply",
    created_at: "2026-08-27T05:00:00.000Z", // 1h in the future vs NOW
    metadata: { source: "auto_reply" },
  };
  assert.equal(isImmediateInboundAutoReply(row, NOW), false);
});
