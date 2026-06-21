#!/usr/bin/env node
/**
 * Campaign Execution Truth Pass — controlled non-sending proof for Miami test campaign.
 */

import {
  callJson,
  countSendQueueRowsForCampaign,
  createMarker,
  isHttpUnavailable,
  routeSummary,
  supabase,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign execution truth proof";

const MIAMI_CAMPAIGN_ID = process.env.CAMPAIGN_TRUTH_TEST_ID || "320c798a-84c9-45b8-a7c9-d166ddd7bd46";
const PROOF_BATCH = 5;

async function countTargets(campaignId, filter = {}) {
  if (!supabase) return null;
  let q = supabase.from("campaign_targets").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
  if (filter.status) q = q.eq("target_status", filter.status);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function distinctCounts(campaignId) {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("campaign_recipient_distinct_counts", {
    p_campaign_id: campaignId,
  }).maybeSingle();
  if (error) return null;
  return data;
}

async function fetchTargetsPage(campaignId, page = 1, pageSize = 50) {
  return callJson(`/api/cockpit/campaigns/${campaignId}/targets?page=${page}&page_size=${pageSize}`, {
    method: "GET",
    timeout_seconds: 30,
  });
}

async function graphMatchCount() {
  if (!supabase) return null;
  const { count, error } = await supabase
    .from("campaign_target_graph")
    .select("graph_id", { count: "exact", head: true })
    .eq("market", "Miami, FL")
    .in("canonical_property_group", ["Multifamily", "multifamily"]);
  if (error) return null;
  return count;
}

const detail = await callJson(`/api/cockpit/campaigns/${MIAMI_CAMPAIGN_ID}`, {
  method: "GET",
  timeout_seconds: 45,
});

if (isHttpUnavailable(detail)) {
  marker.mark("API unavailable — start apps/api dev server", false, routeSummary(detail), true);
  marker.finish(label);
}

marker.mark("campaign detail returned 200", detail.status === 200, routeSummary(detail));
const summary = detail.json?.summary || {};
const metrics = detail.json?.recipient_metrics || summary.recipient_metrics || {};
const readiness = detail.json?.launch_readiness || {};

marker.mark("total_targets uses count bucket not 500 cap", Number(summary.total_targets || 0) >= 800, `total=${summary.total_targets}`);
marker.mark("launch_readiness present", Boolean(summary.launch_readiness || readiness.launch_readiness), `readiness=${summary.launch_readiness || readiness.launch_readiness}`);

const page1 = await fetchTargetsPage(MIAMI_CAMPAIGN_ID, 1, 50);
marker.mark("targets page 1 returned 200", page1.status === 200, routeSummary(page1));
const totalPages = Number(page1.json?.total_pages || 0);
const totalCount = Number(page1.json?.total_count || 0);
marker.mark("targets pagination total_count > 500", totalCount > 500, `total=${totalCount} pages=${totalPages}`);

if (totalPages > 1) {
  const last = await fetchTargetsPage(MIAMI_CAMPAIGN_ID, totalPages, 50);
  marker.mark("targets last page reachable", last.status === 200 && Array.isArray(last.json?.targets), `page=${totalPages}`);
}

const distinct = await distinctCounts(MIAMI_CAMPAIGN_ID);
if (distinct) {
  marker.mark("distinct phones <= target rows", Number(distinct.distinct_e164) <= totalCount, `phones=${distinct.distinct_e164} rows=${totalCount}`);
  marker.mark("duplicate phone groups tracked", distinct.duplicate_phone_groups != null, `dup_phones=${distinct.duplicate_phone_groups}`);
}

const beforeQueue = await countSendQueueRowsForCampaign(MIAMI_CAMPAIGN_ID);

const activate = await callJson(`/api/cockpit/campaigns/${MIAMI_CAMPAIGN_ID}/lifecycle`, {
  method: "POST",
  body: JSON.stringify({
    action: "activate",
    no_send: true,
    confirm_live: true,
    batch_max: PROOF_BATCH,
    activation_idempotency_key: `proof-truth-${Date.now()}`,
  }),
  timeout_seconds: 120,
});

const activateBlocked = activate.status !== 200 || activate.json?.ok === false;
if (activateBlocked && (readiness.launch_readiness === "blocked" || summary.launch_readiness === "blocked")) {
  marker.mark("activation blocked when launch_readiness blocked (expected)", true, routeSummary(activate));
} else {
  marker.mark("activate no_send returned 200", activate.status === 200, routeSummary(activate));
  marker.mark("activate settled with ok flag", activate.json?.ok != null, `ok=${activate.json?.ok}`);
}

const afterQueue = await countSendQueueRowsForCampaign(MIAMI_CAMPAIGN_ID);
if (afterQueue != null && beforeQueue != null) {
  const inserted = afterQueue - beforeQueue;
  if (!activateBlocked) {
    marker.mark("proof inserted <= 5 queue rows", inserted <= PROOF_BATCH, `before=${beforeQueue} after=${afterQueue}`);
  }
}

const repeat = await callJson(`/api/cockpit/campaigns/${MIAMI_CAMPAIGN_ID}/lifecycle`, {
  method: "POST",
  body: JSON.stringify({
    action: "activate",
    no_send: true,
    confirm_live: true,
    batch_max: PROOF_BATCH,
    activation_idempotency_key: activate.json?.activation_idempotency_key || `proof-truth-repeat-${Date.now()}`,
  }),
  timeout_seconds: 120,
});
if (!activateBlocked) {
  const afterRepeat = await countSendQueueRowsForCampaign(MIAMI_CAMPAIGN_ID);
  marker.mark("repeat activation idempotent (no new rows)", afterRepeat === afterQueue, `after=${afterRepeat}`);
}

const worker = await callJson("/api/internal/campaigns/activate-due", {
  method: "GET",
  timeout_seconds: 60,
});
marker.mark("scheduled worker route reachable", worker.status === 200 || worker.status === 401, routeSummary(worker));

const graphMatches = await graphMatchCount();
console.log("\n--- TRUTH PASS METRICS ---");
console.log(JSON.stringify({
  campaign_id: MIAMI_CAMPAIGN_ID,
  matched_properties_graph: graphMatches,
  target_row_count: totalCount,
  distinct_owners: distinct?.distinct_owners,
  distinct_phones: distinct?.distinct_e164,
  ready_recipients: summary.ready_targets,
  planned: summary.scheduled_targets,
  canonical_queued: summary.canonical_queued_count,
  launch_readiness: summary.launch_readiness || readiness.launch_readiness,
  template_readiness: readiness.template_readiness,
  activation_ok: activate.json?.ok,
  activation_error: activate.json?.error,
  blockers: activate.json?.blockers || readiness.blocker_codes,
  pagination_total: totalCount,
  pagination_pages: totalPages,
}, null, 2));

marker.finish(label);