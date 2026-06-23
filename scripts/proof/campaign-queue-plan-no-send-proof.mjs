#!/usr/bin/env node

import {
  callJson,
  countSendQueueRowsForCampaign,
  createMarker,
  isHttpUnavailable,
  readRel,
  routeSummary,
  supabase,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign queue-plan no-send proof";

const route = readRel("apps/api/src/app/api/cockpit/campaigns/[id]/queue-plan/route.js");
const service = readRel("apps/api/src/lib/domain/campaigns/campaign-automation-service.js");

marker.mark("queue-plan route uses campaign automation service", route.includes("createCampaignQueuePlan"));
marker.mark("queue-plan route passes launch controls through", route.includes("createCampaignQueuePlan(campaignId, body)"));
marker.mark(
  "queue-plan service gates live row creation",
  service.includes("const shouldWriteQueueRows = !dryRun && !noSend && confirmLive && createRows && blockers.length === 0")
);
marker.mark("queue-plan service requires confirm_live for guarded live", service.includes("confirm_live_required"));
marker.mark("queue-plan service reports live gate", service.includes("may_create_send_queue_rows: shouldWriteQueueRows"));
marker.mark("queue-plan guarded live rows remain scheduled", service.includes("queue_status: 'scheduled'"));
marker.mark("queue-plan service does not import queue runners", !/runSendQueue|processSendQueue/.test(service));
marker.mark("queue-plan route does not call TextGrid provider", !/sendText|sendSms|textgrid\.messages|handle-textgrid/i.test(route + service));

let globalEmergencyActive = null;
if (supabase) {
  const { data, error } = await supabase
    .from("system_control")
    .select("value")
    .eq("key", "queue_emergency_stop_at")
    .maybeSingle();
  if (error) {
    marker.mark("emergency stop read available", false, error.message, true);
  } else {
    const value = String(data?.value ?? "").trim().toLowerCase();
    globalEmergencyActive = Boolean(value && !["0", "false", "off", "none", "null", "cleared", "clear"].includes(value));
    marker.mark("global emergency stop remains active", globalEmergencyActive, `value=${data?.value || "empty"}`);
  }
} else {
  marker.mark("global emergency stop live check skipped without Supabase service role", true, "", true);
}

const create = await callJson("/api/cockpit/campaigns", {
  method: "POST",
  body: JSON.stringify({
    name: `Proof Queue Plan ${Date.now()}`,
    description: "Proof campaign; queue plan dry-run; no SMS.",
    status: "ready",
    objective: "ownership_check",
    candidate_source: "v_feeder_candidates_fast",
    daily_cap: 1,
    total_cap: 1,
    batch_max: 1,
    market_cap: 1,
    per_sender_cap: 1,
    send_interval_seconds: 60,
    contact_window_start: "09:00",
    contact_window_end: "20:00",
    auto_queue_enabled: true,
    auto_send_enabled: false,
    auto_reply_mode: "disabled",
    metadata: { proof: true },
    target_filters: {
      daily_cap: 1,
      total_cap: 1,
      batch_max: 1,
      market_cap: 1,
      per_sender_cap: 1,
    },
  }),
  timeout_seconds: 20,
});

if (isHttpUnavailable(create)) {
  marker.mark("live queue-plan route skipped because API server is not running", true, routeSummary(create), true);
} else {
  marker.mark("campaign create returned 200", create.status === 200, routeSummary(create));
  const campaignId = create.json?.campaign_id;
  marker.mark("campaign_id returned", Boolean(campaignId), `campaign_id=${campaignId || "missing"}`);

  const before = await countSendQueueRowsForCampaign(campaignId);
  if (before !== null) marker.mark("proof campaign starts with no send_queue rows", before === 0, `count=${before}`);

  const dryRun = await callJson(`/api/cockpit/campaigns/${campaignId}/queue-plan`, {
    method: "POST",
    body: JSON.stringify({
      dry_run: true,
      no_send: true,
      confirm_live: false,
      create_send_queue_rows: false,
      explicit_operator_action: true,
      max_targets: 1,
      daily_cap: 1,
      per_sender_cap: 1,
      per_market_cap: 1,
    }),
    timeout_seconds: 30,
  });
  const json = dryRun.json || {};
  marker.mark("dry-run queue-plan returned 200", dryRun.status === 200, routeSummary(dryRun));
  marker.mark("dry-run flag preserved", json.dry_run === true, `dry_run=${json.dry_run}`);
  marker.mark("queue-plan created no send_queue rows", Number(json.send_queue_rows_created || 0) === 0, `rows=${json.send_queue_rows_created}`);
  marker.mark("queue-plan declares no_send", json.no_send === true);
  marker.mark("dry-run live gate closed", json.live_gate?.may_create_send_queue_rows === false);

  const afterDryRun = await countSendQueueRowsForCampaign(campaignId);
  if (afterDryRun !== null) marker.mark("dry-run inserted no send_queue rows", afterDryRun === 0, `count=${afterDryRun}`);

  const noSend = await callJson(`/api/cockpit/campaigns/${campaignId}/queue-plan`, {
    method: "POST",
    body: JSON.stringify({
      dry_run: false,
      no_send: true,
      confirm_live: false,
      create_send_queue_rows: true,
      explicit_operator_action: true,
      max_targets: 1,
      daily_cap: 1,
      per_sender_cap: 1,
      per_market_cap: 1,
    }),
    timeout_seconds: 30,
  });
  const noSendJson = noSend.json || {};
  marker.mark("no-send queue-plan returned 200", noSend.status === 200, routeSummary(noSend));
  marker.mark("no-send queue-plan created no rows", Number(noSendJson.send_queue_rows_created || 0) === 0, `rows=${noSendJson.send_queue_rows_created}`);
  marker.mark("no-send live gate closed", noSendJson.live_gate?.may_create_send_queue_rows === false);

  const afterNoSend = await countSendQueueRowsForCampaign(campaignId);
  if (afterNoSend !== null) marker.mark("no-send inserted no send_queue rows", afterNoSend === 0, `count=${afterNoSend}`);

  if (globalEmergencyActive === true) {
    const blocked = await callJson(`/api/cockpit/campaigns/${campaignId}/queue-plan`, {
      method: "POST",
      body: JSON.stringify({
        dry_run: false,
        no_send: false,
        confirm_live: true,
        create_send_queue_rows: true,
        explicit_operator_action: true,
        block_on_global_emergency_stop: true,
        max_targets: 1,
        daily_cap: 1,
        per_sender_cap: 1,
        per_market_cap: 1,
      }),
      timeout_seconds: 30,
    });
    const blockedJson = blocked.json || {};
    marker.mark("non-dry queue-plan blocked by emergency stop", blocked.status === 423 && blockedJson.exact_blockers?.includes("global_emergency_stop_active"), routeSummary(blocked));
    const afterBlocked = await countSendQueueRowsForCampaign(campaignId);
    if (afterBlocked !== null) marker.mark("blocked queue-plan inserted no send_queue rows", afterBlocked === 0, `count=${afterBlocked}`);
  }

  const archive = await callJson(`/api/cockpit/campaigns/${campaignId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "archived", auto_queue_enabled: false, metadata: { proof_archived: true } }),
    timeout_seconds: 20,
  });
  marker.mark("proof campaign archived", archive.status === 200, routeSummary(archive), true);
}

marker.finish(label);
