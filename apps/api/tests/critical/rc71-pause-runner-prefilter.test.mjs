/**
 * RC 7.1 D7 — D3 completeness: the CRON RUNNER must not pre-empt the
 * pause ≠ silence exemption.
 *
 * D3 exempted conversation replies in evaluateCampaignDispatchAuthority, but
 * runSendQueue's pre-claim filter (filterRowsByLiveCampaigns,
 * run-send-queue.js) ran first and dropped every row whose campaign was not
 * live — so an auto-reply that inherited a paused campaign's campaign_id never
 * reached the processor from the runner. These tests drive runSendQueue's real
 * candidate → pre-filter → processor hand-off, then the real dispatch
 * authority, with production-shaped rows (send_queue, 2026-10-01).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runSendQueue } from "@/lib/domain/queue/run-send-queue.js";
import { evaluateCampaignDispatchAuthority } from "@/lib/domain/queue/campaign-execution-authority.js";
import {
  filterRowsByLiveCampaigns,
  shouldHoldRowFromStaleExpiration,
} from "@/lib/domain/queue/queue-send-brake-state.js";
import { buildSupabaseQueueRow, makeRunSendQueueDeps } from "../helpers/queue-run-test-harness.js";

const NOW = "2026-04-04T15:00:00.000Z";
const PAUSED = "b27c6890-ffc9-471f-8a2f-be8afd5ec165";
const LIVE = "c963defc-5672-4419-b494-807d453f8d18";

const at = { scheduled_for: "2026-04-04T14:59:00.000Z", scheduled_for_utc: "2026-04-04T14:59:00.000Z" };
// One seller per row, so the runner's batch de-duplication (owner:phone:touch)
// is not what separates them.
const row = (id, over) => buildSupabaseQueueRow(id, {
  ...at,
  campaign_id: PAUSED,
  master_owner_id: `mo_${id}`,
  phone_id: `ph_${id}`,
  to_phone_number: `+1500555${String(id).padStart(4, "0")}`,
  ...over,
});

// Conversation traffic, shaped as production writes it.
const AUTO_REPLY = row(3001, {
  type: "auto_reply", message_type: "Follow-Up", queue_key: "inbound_auto_reply:evt_1",
  metadata: { source: "auto_reply", action_type: "autopilot_inbound_reply" },
});
const UNKNOWN_ROUTER = row(3002, { type: "auto_reply", queue_key: "unk:1", metadata: { source: "textgrid_inbound_unknown_router" } });
const ACQ_INBOUND = row(3003, { type: "auto_reply", queue_key: "acq-inbound:c1:x", metadata: { source: "default_acquisition_inbound_dispatcher" } });
const MANUAL_INBOX = row(3004, { type: "outbound", queue_key: "f2e397f2-777e", metadata: { source: "manual_inbox", campaign_id: PAUSED } });
// Proactive campaign traffic.
const LAUNCH = row(3101, { type: "campaign_launch", queue_key: "campaign:x:y", metadata: { source: "campaign_launch_execution", campaign_id: PAUSED } });
const TARGET_ONE = row(3102, { type: "outbound", message_type: "ownership_check", queue_key: "campaign_target_one:t1", metadata: { source: "enqueue_campaign_target_one" } });
const FOLLOW_UP = row(3103, { type: "followup", queue_key: "acq-followup:c1:S2:2026-04-05", metadata: {} });
const LIVE_LAUNCH = row(3201, { campaign_id: LIVE, type: "campaign_launch", queue_key: "campaign:l:1", metadata: { source: "campaign_launch_execution" } });

/** The processor double runs the REAL dispatch authority against a paused campaign. */
function authorityProcessor(seen) {
  const status = { [PAUSED]: "paused", [LIVE]: "active" };
  return async (r) => {
    const verdict = await evaluateCampaignDispatchAuthority(r, { loadCampaignStatus: async (id) => status[id] ?? null });
    seen.push({ id: r.id, verdict });
    return verdict.ok ? { ok: true, sent: true, provider_message_id: `sid-${r.id}` } : { ok: false, skipped: true, reason: verdict.reason };
  };
}

test("the runner hands a paused campaign's conversation replies to the processor, which lets them through", async () => {
  const seen = [];
  const { deps } = makeRunSendQueueDeps({
    rows: [AUTO_REPLY, UNKNOWN_ROUTER, ACQ_INBOUND, MANUAL_INBOX, LAUNCH, TARGET_ONE, FOLLOW_UP, LIVE_LAUNCH],
    now: NOW,
    liveCampaignIds: [LIVE],
    processImpl: authorityProcessor(seen),
  });
  const result = await runSendQueue({ limit: 50, now: NOW }, deps);
  const reached = seen.map((s) => s.id).sort();
  assert.deepEqual(reached, [3001, 3002, 3003, 3004, 3201], "conversation replies + the live campaign's row reach the processor");
  assert.ok(seen.every((s) => s.verdict.ok), "and pass the campaign authority");
  assert.equal(result.sent_count, 5);
});

test("the runner still holds a paused campaign's proactive outbound: launch, target enqueue, no-reply follow-up", async () => {
  const seen = [];
  const { deps, info_calls } = makeRunSendQueueDeps({
    rows: [LAUNCH, TARGET_ONE, FOLLOW_UP],
    now: NOW,
    liveCampaignIds: [LIVE],
    processImpl: authorityProcessor(seen),
  });
  const result = await runSendQueue({ limit: 50, now: NOW }, deps);
  assert.deepEqual(seen, [], "nothing proactive reaches the processor while paused");
  assert.equal(result.sent_count, 0);
  const held = info_calls.find((c) => c.event === "queue.campaign_gated_rows_held");
  assert.equal(held?.meta?.held_back, 3);
});

test("a failed live-campaign lookup still fails CLOSED for proactive rows, not for conversation replies", () => {
  const kept = filterRowsByLiveCampaigns([AUTO_REPLY, MANUAL_INBOX, LAUNCH, TARGET_ONE], null).map((r) => r.id);
  assert.deepEqual(kept, [3001, 3004]);
});

test("stale-expiration hold: campaign pause no longer holds conversation replies; the global brake still holds everything", () => {
  const paused = { campaignStatus: "paused", brakeState: { send_blocked: false } };
  assert.equal(shouldHoldRowFromStaleExpiration(AUTO_REPLY, paused), false);
  assert.equal(shouldHoldRowFromStaleExpiration(MANUAL_INBOX, paused), false);
  assert.equal(shouldHoldRowFromStaleExpiration(LAUNCH, paused), true, "proactive rows stay held for Resume");
  const braked = { campaignStatus: "active", brakeState: { send_blocked: true } };
  assert.equal(shouldHoldRowFromStaleExpiration(AUTO_REPLY, braked), true, "emergency stop / processor off holds replies too");
});

test("the lifecycle reconcile reads the fields the conversation check needs", async () => {
  const fs = await import("node:fs");
  const src = await fs.promises.readFile(new URL("../../src/lib/supabase/sms-engine.js", import.meta.url), "utf8");
  const select = src.match(/\.select\("(id,queue_status,created_at,updated_at,scheduled_for[^"]*)"\)\s*\n\s*\.in\("queue_status", CANONICAL_ACTIVE_QUEUE_STATUSES\)/);
  assert.ok(select, "reconcile select found");
  for (const col of ["queue_key", "type", "message_type", "metadata"]) {
    assert.ok(select[1].split(",").includes(col), `reconcile selects ${col}`);
  }
});
