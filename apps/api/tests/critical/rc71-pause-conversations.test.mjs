/**
 * RC 7.1 owner decision 3 — PAUSE ≠ SILENCE CONVERSATIONS.
 *
 * Pausing a campaign stops its new proactive outbound only. Replies inside a
 * conversation the campaign started (the auto-reply row inherits campaign_id)
 * and the operator's own Inbox replies keep flowing; they answer to
 * auto_reply_mode and to every downstream safety gate, not to campaign pause.
 * Campaign outreach rows stay held exactly as before (see
 * campaign-pause-blocks-dispatch.test.mjs — unchanged).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMPAIGN_PAUSED_REASON,
  evaluateCampaignDispatchAuthority,
  isConversationResponseRow,
} from "@/lib/domain/queue/campaign-execution-authority.js";
import { isImmediateInboundAutoReply } from "@/lib/domain/queue/is-manual-inbox-send.js";

const CAMPAIGN = "b27c6890-ffc9-471f-8a2f-be8afd5ec165";
const paused = { loadCampaignStatus: async () => "paused" };

// Shapes as written in production (send_queue, 2026-10-01).
const AUTO_REPLY = {
  id: "ar1", campaign_id: CAMPAIGN, type: "auto_reply", message_type: "Follow-Up",
  queue_key: "inbound_auto_reply:evt_123", metadata: { source: "auto_reply", action_type: "autopilot_inbound_reply" },
};
const MANUAL_INBOX = { id: "m1", campaign_id: CAMPAIGN, type: "outbound", metadata: { source: "manual_inbox" } };
const UNKNOWN_ROUTER = { id: "u1", campaign_id: CAMPAIGN, type: "auto_reply", metadata: { source: "textgrid_inbound_unknown_router" } };
const ACQ_INBOUND = { id: "a1", campaign_id: CAMPAIGN, type: "auto_reply", queue_key: "acq-inbound:c1:x", metadata: { source: "default_acquisition_inbound_dispatcher" } };

const CAMPAIGN_LAUNCH = { id: "c1", campaign_id: CAMPAIGN, type: "campaign_launch", queue_key: "campaign:x:y", metadata: { source: "campaign_launch_execution" } };
const TARGET_ONE = { id: "c2", campaign_id: CAMPAIGN, type: "outbound", message_type: "ownership_check", queue_key: "campaign_target_one:t1", metadata: { source: "enqueue_campaign_target_one" } };
const NO_REPLY_FOLLOWUP = { id: "c3", campaign_id: CAMPAIGN, type: "followup", queue_key: "acq-followup:c1:S2:2026-10-02", metadata: {} };

for (const [label, row] of [
  ["seller-flow inbound auto-reply", AUTO_REPLY],
  ["operator Inbox reply", MANUAL_INBOX],
  ["unknown-inbound router reply", UNKNOWN_ROUTER],
  ["acquisition inbound reply", ACQ_INBOUND],
]) {
  test(`a paused campaign does NOT hold a conversation reply: ${label}`, async () => {
    assert.equal(isConversationResponseRow(row), true);
    const verdict = await evaluateCampaignDispatchAuthority(row, paused);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.scope, "conversation_traffic_not_held_by_campaign_pause");
  });
}

for (const [label, row] of [
  ["campaign launch touch", CAMPAIGN_LAUNCH],
  ["campaign target enqueue", TARGET_ONE],
  ["no-reply follow-up (proactive)", NO_REPLY_FOLLOWUP],
]) {
  test(`a paused campaign STILL holds its proactive outbound: ${label}`, async () => {
    assert.equal(isConversationResponseRow(row), false);
    const verdict = await evaluateCampaignDispatchAuthority(row, paused);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, CAMPAIGN_PAUSED_REASON);
  });
}

test("the exemption is ONLY from campaign pause: the row still goes to the processor's safety gates", async () => {
  // The dispatcher runs campaign authority, then the processor, where
  // opt-out/DNC/suppression, quiet hours and sender health live. Nothing here
  // short-circuits to a send.
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(new URL("../../src/lib/domain/queue/process-send-queue.js", import.meta.url), "utf8");
  const authorityAt = source.indexOf("await evaluateCampaignDispatchAuthority(");
  const delegateAt = source.indexOf("await processSupabaseQueueItem(resolved_queue_row, deps)");
  assert.ok(authorityAt > 0 && delegateAt > authorityAt);
  const authority = await fs.promises.readFile(new URL("../../src/lib/domain/queue/campaign-execution-authority.js", import.meta.url), "utf8");
  assert.ok(!/sendSms|textgrid|provider/i.test(authority.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "authority never sends");
});

test("quiet hours are not weakened: a stale auto-reply of a paused campaign is not window-exempt", () => {
  const stale = { ...AUTO_REPLY, created_at: "2026-10-01T02:00:00Z" };
  assert.equal(isImmediateInboundAutoReply(stale, new Date("2026-10-01T06:00:00Z")), false);
});
