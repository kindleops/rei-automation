#!/usr/bin/env node
/**
 * Production launch proof — sync metrics + convert Miami test campaign to live.
 */

import {
  callJson,
  createMarker,
  isHttpUnavailable,
  routeSummary,
  supabase,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign production launch proof";
const MIAMI_ID = process.env.PROOF_CAMPAIGN_ID || "320c798a-84c9-45b8-a7c9-d166ddd7bd46";

async function countLiveQueue(campaignId) {
  if (!supabase) return null;
  const { count, error } = await supabase
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .in("queue_status", ["queued", "scheduled", "pending", "ready", "approved", "processing", "sending"]);
  if (error) throw error;
  return count ?? 0;
}

const before = await callJson(`/api/cockpit/campaigns/${MIAMI_ID}`, { method: "GET", timeout_seconds: 60 });
if (isHttpUnavailable(before)) {
  marker.mark("API unavailable", false, routeSummary(before), true);
  marker.finish(label);
}

const sync = await callJson(`/api/cockpit/campaigns/${MIAMI_ID}/lifecycle`, {
  method: "POST",
  body: JSON.stringify({ action: "sync_metrics" }),
  timeout_seconds: 120,
});
marker.mark("sync_metrics returned 200", sync.status === 200 && sync.json?.ok === true, routeSummary(sync));

const convert = await callJson(`/api/cockpit/campaigns/${MIAMI_ID}/lifecycle`, {
  method: "POST",
  body: JSON.stringify({
    action: "convert_to_live",
    confirm_live: true,
    explicit_operator_action: true,
    batch_max: 5,
    activation_idempotency_key: `production-launch:${Date.now()}`,
  }),
  timeout_seconds: 180,
});
marker.mark("convert_to_live returned 200", convert.status === 200 && convert.json?.ok === true, routeSummary(convert));
marker.mark("proof_mode cleared", convert.json?.mode !== "test" || convert.json?.state === "live", `state=${convert.json?.state} mode=${convert.json?.mode}`);

const after = await callJson(`/api/cockpit/campaigns/${MIAMI_ID}/summary`, { method: "GET", timeout_seconds: 60 });
marker.mark("summary after convert", after.status === 200 && after.json?.ok === true, routeSummary(after));

const liveQueue = await countLiveQueue(MIAMI_ID);
marker.mark("live queue rows present", Number(liveQueue || 0) > 0, `live_queue=${liveQueue}`);

console.log("LAUNCH_RESULT", JSON.stringify({
  sync: sync.json,
  convert: convert.json,
  summary: after.json,
  live_queue: liveQueue,
}, null, 2));

marker.finish(label);