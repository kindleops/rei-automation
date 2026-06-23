#!/usr/bin/env node

import {
  callJson,
  createMarker,
  isHttpUnavailable,
  readRel,
  routeSummary,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign preview-targets proof";

const route = readRel("apps/api/src/app/api/cockpit/campaigns/preview-targets/route.js");
const service = readRel("apps/api/src/lib/domain/campaigns/campaign-automation-service.js");

marker.mark("preview route uses campaign automation service", route.includes("previewCampaignTargets"));
marker.mark("preview route forces dry_run", route.includes("dry_run: true"));
marker.mark("preview route has no insert/update/delete", !/\.(insert|update|delete|upsert)\s*\(/.test(route));
marker.mark("preview service reuses feeder candidates", service.includes("getSupabaseFeederCandidates"));
marker.mark("preview service evaluates eligibility", service.includes("evaluateCandidateEligibility"));
marker.mark("preview service computes routing readiness", service.includes("chooseTextgridNumber"));
marker.mark("preview service computes template readiness", service.includes("renderOutboundTemplate"));

const result = await callJson("/api/cockpit/campaigns/preview-targets", {
  method: "POST",
  body: JSON.stringify({
    dry_run: true,
    candidate_source: "v_feeder_candidates_fast",
    scan_limit: 10,
    limit: 3,
    target_filters: {
      states: [],
      markets: [],
      sms_eligible_required: true,
      valid_e164_required: true,
      exclude_opt_outs: true,
      dedupe_same_phone: true,
      dedupe_same_owner: true,
      require_linked_property: true,
      require_linked_master_owner: true,
      routing_safe_only: true,
    },
  }),
  timeout_seconds: 20,
});

if (isHttpUnavailable(result)) {
  marker.mark("live preview route skipped because API server is not running", true, routeSummary(result), true);
} else {
  const json = result.json || {};
  marker.mark("live preview route returned json", result.status === 200, routeSummary(result));
  marker.mark("preview reports total scanned", Number.isFinite(Number(json.total_scanned)), `total_scanned=${json.total_scanned}`);
  marker.mark("preview reports clean targets", Number.isFinite(Number(json.clean_targets)), `clean_targets=${json.clean_targets}`);
  marker.mark("preview reports ready_to_queue", Number.isFinite(Number(json.ready_to_queue)), `ready_to_queue=${json.ready_to_queue}`);
  marker.mark("preview reports blocked counts", json.blocked_counts_by_reason && typeof json.blocked_counts_by_reason === "object");
  marker.mark("preview reports sender coverage", json.sender_coverage_counts && typeof json.sender_coverage_counts === "object");
  marker.mark("preview reports identity counts", json.identity_counts && typeof json.identity_counts === "object");
  marker.mark("preview reports language counts", json.language_counts && typeof json.language_counts === "object");
  marker.mark("preview reports template readiness", json.template_readiness_counts && typeof json.template_readiness_counts === "object");
}

marker.finish(label);
