#!/usr/bin/env node

import {
  callJson,
  countSendQueueRowsForCampaign,
  createMarker,
  isHttpUnavailable,
  routeSummary,
  supabase,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign launch execution proof";

const LIVE_LIMIT = Math.max(1, Math.min(Number(process.env.CAMPAIGN_LAUNCH_PROOF_LIVE_LIMIT || 1), 5));
const PLAN_LIMIT = 5;
const BUILD_LIMIT = Number(process.env.CAMPAIGN_LAUNCH_PROOF_BUILD_LIMIT || 25);
const FAR_FUTURE_SCHEDULE_AT = process.env.CAMPAIGN_LAUNCH_PROOF_FIRST_SCHEDULED_AT || "2099-01-05T16:00:00.000Z";

function distributionTotal(rows = []) {
  return rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
}

async function fetchProofQueueRows(campaignId) {
  if (!supabase || !campaignId) return [];
  const { data, error } = await supabase
    .from("send_queue")
    .select(
      "id,campaign_id,campaign_target_id,property_id,master_owner_id,prospect_id,phone_id,to_phone_number,from_phone_number,textgrid_number_id,textgrid_number,template_id,message_body,message_text,scheduled_for_utc,queue_status,sms_eligible,routing_allowed,safety_status,guard_status,sent_at,provider_message_id,metadata"
    )
    .eq("campaign_id", campaignId)
    .order("scheduled_for_utc", { ascending: true });
  if (error) throw error;
  return data || [];
}

function requiredQueueFieldsPresent(row = {}) {
  return Boolean(
    row.campaign_id &&
      row.campaign_target_id &&
      row.property_id &&
      row.master_owner_id &&
      row.prospect_id &&
      row.phone_id &&
      row.to_phone_number &&
      row.from_phone_number &&
      row.textgrid_number_id &&
      row.template_id &&
      row.message_body &&
      row.scheduled_for_utc &&
      row.queue_status &&
      row.metadata?.target_snapshot &&
      row.metadata?.routing_snapshot &&
      row.metadata?.template_snapshot &&
      row.metadata?.schedule_snapshot
  );
}

const campaignPayload = {
  name: `Proof Campaign Launch Execution ${Date.now()}`,
  description: "Proof campaign for guarded launch execution. SMS is not sent.",
  status: "draft",
  objective: "ownership_check",
  candidate_source: "campaign_target_graph",
  daily_cap: PLAN_LIMIT,
  total_cap: PLAN_LIMIT,
  batch_max: PLAN_LIMIT,
  market_cap: PLAN_LIMIT,
  per_sender_cap: PLAN_LIMIT,
  send_interval_seconds: 600,
  contact_window_start: "09:00",
  contact_window_end: "20:00",
  auto_queue_enabled: true,
  auto_send_enabled: false,
  auto_reply_mode: "disabled",
  metadata: {
    proof: true,
    proof_name: label,
    candidate_source: "campaign_target_graph",
  },
  target_filters: {
    candidate_source: "campaign_target_graph",
    valid_e164_required: true,
    sms_eligible_required: true,
    daily_cap: PLAN_LIMIT,
    total_cap: PLAN_LIMIT,
    batch_max: PLAN_LIMIT,
    market_cap: PLAN_LIMIT,
    per_sender_cap: PLAN_LIMIT,
  },
};

const create = await callJson("/api/cockpit/campaigns", {
  method: "POST",
  body: JSON.stringify(campaignPayload),
  timeout_seconds: 30,
});

if (isHttpUnavailable(create)) {
  marker.mark("campaign launch execution proof skipped because API server is not running", true, routeSummary(create), true);
  marker.finish(label);
}

marker.mark("save draft returned 200", create.status === 200, routeSummary(create));
const campaignId = create.json?.campaign_id;
marker.mark("campaign_id returned", Boolean(campaignId), `campaign_id=${campaignId || "missing"}`);

const before = await countSendQueueRowsForCampaign(campaignId);
if (before !== null) marker.mark("draft starts with no campaign send_queue rows", before === 0, `count=${before}`);

const build = await callJson(`/api/cockpit/campaigns/${campaignId}/build-targets`, {
  method: "POST",
  body: JSON.stringify({
    source: "campaign_target_graph",
    candidate_source: "campaign_target_graph",
    limit: BUILD_LIMIT,
  }),
  timeout_seconds: 60,
});
marker.mark("build targets returned 200", build.status === 200, routeSummary(build));
marker.mark("targets built from campaign_target_graph", Number(build.json?.built_count || 0) >= PLAN_LIMIT, `built=${build.json?.built_count ?? "unknown"}`);
marker.mark("build created no send_queue rows", build.json?.no_send_queue_rows_created === true);

const afterBuild = await countSendQueueRowsForCampaign(campaignId);
if (afterBuild !== null) marker.mark("build inserted no send_queue rows", afterBuild === before, `before=${before} after=${afterBuild}`);

const planBase = {
  explicit_operator_action: true,
  max_targets: PLAN_LIMIT,
  daily_cap: PLAN_LIMIT,
  per_sender_cap: PLAN_LIMIT,
  per_market_cap: PLAN_LIMIT,
  spread_interval_seconds: 600,
  first_scheduled_at: FAR_FUTURE_SCHEDULE_AT,
  suppress_previously_contacted: true,
};

const dryRun = await callJson(`/api/cockpit/campaigns/${campaignId}/queue-plan`, {
  method: "POST",
  body: JSON.stringify({
    ...planBase,
    dry_run: true,
    no_send: true,
    confirm_live: false,
  }),
  timeout_seconds: 90,
});
marker.mark("launch dry-run returned 200", dryRun.status === 200, routeSummary(dryRun));
marker.mark("dry-run created 5 planned targets", Number(dryRun.json?.targets_created || 0) === PLAN_LIMIT, `targets=${dryRun.json?.targets_created}`);
marker.mark("dry-run created no queue rows", Number(dryRun.json?.queue_rows_created || dryRun.json?.send_queue_rows_created || 0) === 0);
marker.mark("dry-run live gate closed", dryRun.json?.live_gate?.may_create_send_queue_rows === false);

const afterDryRun = await countSendQueueRowsForCampaign(campaignId);
if (afterDryRun !== null) marker.mark("dry-run inserted no send_queue rows", afterDryRun === before, `count=${afterDryRun}`);

const noSend = await callJson(`/api/cockpit/campaigns/${campaignId}/queue-plan`, {
  method: "POST",
  body: JSON.stringify({
    ...planBase,
    dry_run: false,
    no_send: true,
    confirm_live: false,
  }),
  timeout_seconds: 90,
});
marker.mark("launch no-send returned 200", noSend.status === 200, routeSummary(noSend));
marker.mark("no-send planned 5 targets", Number(noSend.json?.targets_created || 0) === PLAN_LIMIT, `targets=${noSend.json?.targets_created}`);
marker.mark("no-send created no queue rows", Number(noSend.json?.queue_rows_created || noSend.json?.send_queue_rows_created || 0) === 0);
marker.mark("no-send live gate closed", noSend.json?.live_gate?.may_create_send_queue_rows === false);

const afterNoSend = await countSendQueueRowsForCampaign(campaignId);
if (afterNoSend !== null) marker.mark("no-send inserted no send_queue rows", afterNoSend === before, `count=${afterNoSend}`);

const guardedLive = await callJson(`/api/cockpit/campaigns/${campaignId}/queue-plan`, {
  method: "POST",
  body: JSON.stringify({
    ...planBase,
    max_targets: LIVE_LIMIT,
    daily_cap: LIVE_LIMIT,
    per_sender_cap: LIVE_LIMIT,
    per_market_cap: LIVE_LIMIT,
    dry_run: false,
    no_send: false,
    confirm_live: true,
    create_send_queue_rows: true,
    proof: true,
  }),
  timeout_seconds: 120,
});
marker.mark("guarded live launch returned 200", guardedLive.status === 200, routeSummary(guardedLive));
marker.mark("guarded live gate open", guardedLive.json?.live_gate?.may_create_send_queue_rows === true);
marker.mark("guarded live created 1-5 queue rows", Number(guardedLive.json?.queue_rows_created || 0) >= 1 && Number(guardedLive.json?.queue_rows_created || 0) <= 5, `rows=${guardedLive.json?.queue_rows_created}`);
marker.mark("sender distribution returned", distributionTotal(guardedLive.json?.sender_distribution || []) === Number(guardedLive.json?.targets_created || 0));
marker.mark("template distribution returned", distributionTotal(guardedLive.json?.template_distribution || []) === Number(guardedLive.json?.targets_created || 0));
marker.mark("schedule summary returned", Boolean(guardedLive.json?.first_scheduled_at && guardedLive.json?.last_scheduled_at));

const rows = await fetchProofQueueRows(campaignId);
marker.mark("send_queue rows exist for guarded live campaign", rows.length === Number(guardedLive.json?.queue_rows_created || 0), `rows=${rows.length}`);
marker.mark("all proof queue rows carry required fields", rows.every(requiredQueueFieldsPresent));
marker.mark("all proof queue rows are scheduled", rows.every((row) => row.queue_status === "scheduled"));
marker.mark("all proof queue rows are future dated", rows.every((row) => new Date(row.scheduled_for_utc).getTime() > Date.now()), `first=${rows[0]?.scheduled_for_utc || "missing"}`);
marker.mark("no provider send artifacts exist", rows.every((row) => !row.sent_at && !row.provider_message_id));
marker.mark("queue rows remain sendable but scheduled", rows.every((row) => row.sms_eligible === true && row.routing_allowed === true && row.safety_status === "passed"));
marker.mark("no duplicate phone queue rows in proof batch", new Set(rows.map((row) => row.to_phone_number)).size === rows.length);
marker.mark("duplicate protection summary passed", guardedLive.json?.duplicate_protection?.no_duplicate_phone_queue_rows === true);

const archive = await callJson(`/api/cockpit/campaigns/${campaignId}`, {
  method: "PATCH",
  body: JSON.stringify({
    status: "archived",
    auto_queue_enabled: false,
    metadata: {
      proof_archived: true,
      proof_name: label,
      guarded_live_queue_rows_created: rows.length,
    },
  }),
  timeout_seconds: 30,
});
marker.mark("proof campaign archived after verification", archive.status === 200, routeSummary(archive), true);

console.log(JSON.stringify({
  campaign_id: campaignId,
  targets_created: guardedLive.json?.targets_created || 0,
  queue_rows_created: rows.length,
  skipped_count: guardedLive.json?.skipped_count || 0,
  blocked_count: guardedLive.json?.blocked_count || 0,
  sender_distribution: guardedLive.json?.sender_distribution || [],
  template_distribution: guardedLive.json?.template_distribution || [],
  first_scheduled_at: guardedLive.json?.first_scheduled_at || null,
  last_scheduled_at: guardedLive.json?.last_scheduled_at || null,
  status: guardedLive.json?.status || null,
}, null, 2));

marker.finish(label);
