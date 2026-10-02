import {
  isEmergencyStopActive,
  normalizeQueueProcessorMode,
} from "@/lib/domain/queue/queue-control-safety.js";
import { isConversationResponseRow } from "@/lib/domain/queue/campaign-execution-authority.js";

function clean(value) {
  return String(value ?? "").trim();
}

export function evaluateGlobalSendBrakeState(settings = {}) {
  const emergency_stop_active = isEmergencyStopActive(settings.queue_emergency_stop_at);
  const processor_mode = normalizeQueueProcessorMode(settings.queue_processor_mode, "off");
  const processor_paused = processor_mode === "off";
  const reasons = [];
  if (emergency_stop_active) reasons.push("queue_emergency_stop_active");
  if (processor_paused) reasons.push("queue_processor_paused");
  return {
    send_blocked: emergency_stop_active || processor_paused,
    emergency_stop_active,
    processor_paused,
    reasons,
  };
}

export function rowCampaignId(row = {}) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return clean(row.campaign_id || metadata.campaign_id) || null;
}

export function isProofQueueRow(row = {}) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return Boolean(
    metadata.no_send === true ||
    metadata.proof_hydration === true ||
    metadata.proof_mode === "no_send" ||
    metadata.launch_mode === "proof_hydration_no_send"
  );
}

/**
 * May the RUNNER hand this row to the processor, given its campaign's state?
 *
 * PAUSE ≠ SILENCE CONVERSATIONS (rc-7.1 D3/D7). A reply inside a conversation
 * the campaign started — inbound auto-reply, unknown-sender router reply,
 * acquisition inbound reply, an operator's Inbox send — inherits the
 * campaign_id but is not campaign outreach. D3 exempted it in
 * evaluateCampaignDispatchAuthority, but this pre-claim filter ran FIRST and
 * dropped every row of a non-live campaign, so the exemption was never
 * reached from the cron runner. The same predicate now applies here; those
 * rows still pass auto_reply_mode and every processor safety gate. A failed
 * live-campaign lookup does not hold them either: the dispatch authority does
 * not read campaign state for them at all. Proactive campaign rows (launch,
 * target enqueue, no-reply follow-ups) stay held, and still fail closed.
 */
export function isRunnableCampaignQueueRow(row = {}, liveCampaignIds = null) {
  const campaignId = rowCampaignId(row);
  if (!campaignId) return true;
  if (isConversationResponseRow(row)) return true;
  if (!liveCampaignIds) return false;
  return liveCampaignIds.has(campaignId);
}

export function shouldHoldRowFromStaleExpiration(row = {}, options = {}) {
  const brakeState = options.brakeState || {};
  const campaignStatus = options.campaignStatus || null;
  if (isProofQueueRow(row)) return false;
  if (brakeState.send_blocked && row.sms_eligible !== false) return true;
  const campaignId = rowCampaignId(row);
  // Conversation replies are not held by campaign pause (D3/D7); the global
  // brake above still holds them like every other row.
  if (
    campaignId &&
    campaignStatus &&
    !["active", "activating", "live_limited"].includes(campaignStatus) &&
    !isConversationResponseRow(row)
  ) {
    return true;
  }
  return false;
}

export function filterRowsByLiveCampaigns(rows = [], liveCampaignIds = null) {
  return rows.filter((row) => isRunnableCampaignQueueRow(row, liveCampaignIds));
}