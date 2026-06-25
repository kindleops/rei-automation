import {
  isEmergencyStopActive,
  normalizeQueueProcessorMode,
} from "@/lib/domain/queue/queue-control-safety.js";

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

export function isRunnableCampaignQueueRow(row = {}, liveCampaignIds = null) {
  const campaignId = rowCampaignId(row);
  if (!campaignId) return true;
  if (!liveCampaignIds) return false;
  return liveCampaignIds.has(campaignId);
}

export function shouldHoldRowFromStaleExpiration(row = {}, options = {}) {
  const brakeState = options.brakeState || {};
  const campaignStatus = options.campaignStatus || null;
  if (isProofQueueRow(row)) return false;
  if (brakeState.send_blocked && row.sms_eligible !== false) return true;
  const campaignId = rowCampaignId(row);
  if (campaignId && campaignStatus && !["active", "activating", "live_limited"].includes(campaignStatus)) {
    return true;
  }
  return false;
}

export function filterRowsByLiveCampaigns(rows = [], liveCampaignIds = null) {
  return rows.filter((row) => isRunnableCampaignQueueRow(row, liveCampaignIds));
}