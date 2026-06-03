#!/usr/bin/env node

import {
  callJson,
  countSendQueueRowsForCampaign,
  createMarker,
  isHttpUnavailable,
  readRel,
  routeSummary,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign build-targets proof";

const route = readRel("apps/api/src/app/api/cockpit/campaigns/[id]/build-targets/route.js");
const service = readRel("apps/api/src/lib/domain/campaigns/campaign-automation-service.js");
const buildFunction = service.slice(
  service.indexOf("export async function buildCampaignTargets"),
  service.indexOf("function parseTimeMinutes")
);

marker.mark("build-targets route uses campaign automation service", route.includes("buildCampaignTargets"));
marker.mark("build service writes campaign_targets", service.includes(".from('campaign_targets').insert"));
marker.mark("build service deletes only campaign target snapshots", service.includes(".from('campaign_targets').delete().eq('campaign_id'"));
marker.mark("build service records no send_queue rows in response", service.includes("no_send_queue_rows_created"));
marker.mark("build function does not insert send_queue rows", !/\.from\('send_queue'\)\.insert/.test(buildFunction));

const create = await callJson("/api/cockpit/campaigns", {
  method: "POST",
  body: JSON.stringify({
    name: `Proof Build Targets ${Date.now()}`,
    description: "Proof campaign; build targets only; no SMS.",
    status: "draft",
    objective: "ownership_check",
    candidate_source: "v_feeder_candidates_fast",
    auto_queue_enabled: false,
    auto_send_enabled: false,
    auto_reply_mode: "disabled",
    metadata: { proof: true },
    target_filters: {
      sms_eligible_required: true,
      valid_e164_required: true,
      require_linked_property: true,
      require_linked_master_owner: true,
      dedupe_same_phone: true,
      dedupe_same_owner: true,
      routing_safe_only: true,
    },
  }),
  timeout_seconds: 20,
});

if (isHttpUnavailable(create)) {
  marker.mark("live build-targets route skipped because API server is not running", true, routeSummary(create), true);
} else {
  marker.mark("campaign create returned 200", create.status === 200, routeSummary(create));
  const campaignId = create.json?.campaign_id;
  marker.mark("campaign_id returned", Boolean(campaignId), `campaign_id=${campaignId || "missing"}`);

  const before = await countSendQueueRowsForCampaign(campaignId);
  if (before !== null) marker.mark("proof campaign starts with no send_queue rows", before === 0, `count=${before}`);

  const build = await callJson(`/api/cockpit/campaigns/${campaignId}/build-targets`, {
    method: "POST",
    body: JSON.stringify({ scan_limit: 10, limit: 3 }),
    timeout_seconds: 60,
  });
  const json = build.json || {};
  marker.mark("build-targets returned 200", build.status === 200, routeSummary(build));
  marker.mark("build-targets reports built_count", Number.isFinite(Number(json.built_count)), `built_count=${json.built_count}`);
  marker.mark("build-targets reports no send_queue rows", json.no_send_queue_rows_created === true);

  const after = await countSendQueueRowsForCampaign(campaignId);
  if (after !== null) marker.mark("build-targets inserted no send_queue rows", after === 0, `count=${after}`);

  const archive = await callJson(`/api/cockpit/campaigns/${campaignId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "archived", auto_queue_enabled: false, metadata: { proof_archived: true } }),
    timeout_seconds: 20,
  });
  marker.mark("proof campaign archived", archive.status === 200, routeSummary(archive), true);
}

marker.finish(label);
