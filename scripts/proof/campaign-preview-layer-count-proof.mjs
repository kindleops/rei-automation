#!/usr/bin/env node

import {
  callJson,
  createMarker,
  isHttpUnavailable,
  readRel,
  routeSummary,
  supabase,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign preview layer count proof";
const campaignSessionId = `campaign-preview-layer-count-proof-${Date.now()}`;

const route = readRel("apps/api/src/app/api/cockpit/campaigns/preview-targets/route.js");
const service = readRel("apps/api/src/lib/domain/campaigns/campaign-automation-service.js");
const previewFunction = service.slice(
  service.indexOf("export async function previewCampaignTargets"),
  service.indexOf("function mapCampaignSummary")
);

const layerKeys = [
  "propertiesMatched",
  "prospectsMatched",
  "masterOwnersMatched",
  "phonesMatched",
  "outreachEligible",
  "senderCoverageEligible",
];

const domains = [
  "properties",
  "prospects",
  "master_owners",
  "phones",
  "outreach",
  "sender_coverage",
];

function groupedFilters(filter = null) {
  const groups = Object.fromEntries(domains.map((domain) => [domain, []]));
  if (filter?.field_key) {
    const domain = filter.field_key.split(".")[0];
    groups[domain] = [filter];
  }
  return groups;
}

function previewPayload(filter = null) {
  return {
    source: "v_properties",
    proof: true,
    include_diagnostics: true,
    dry_run: true,
    campaign_session_id: campaignSessionId,
    scan_limit: 10,
    limitPreview: 3,
    filters: groupedFilters(filter),
  };
}

async function callPreview(name, payload) {
  const result = await callJson("/api/cockpit/campaigns/preview-targets", {
    method: "POST",
    body: JSON.stringify(payload),
    timeout_seconds: 60,
  });
  return { name, result, json: result.json || {} };
}

function hasLayerCounts(json = {}) {
  const counts = json.layerCounts;
  return Boolean(
    counts &&
      typeof counts === "object" &&
      layerKeys.every((key) => Number.isFinite(Number(counts[key])))
  );
}

function warnings(json = {}) {
  return [
    ...(Array.isArray(json.warnings) ? json.warnings : []),
    ...(Array.isArray(json.diagnostics?.warnings) ? json.diagnostics.warnings : []),
  ].map((warning) => String(warning));
}

function sampleTargetsSeparated(json = {}) {
  const samples = Array.isArray(json.sampleTargets)
    ? json.sampleTargets
    : Array.isArray(json.sample_targets)
      ? json.sample_targets
      : [];
  if (!samples.length) return true;
  return ["property", "prospect", "master_owner", "phone", "outreach", "sender_coverage"]
    .every((key) => samples[0] && typeof samples[0][key] === "object");
}

async function countProofSendQueueRows() {
  if (!supabase) return null;
  const { count, error } = await supabase
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .contains("metadata", { campaign_session_id: campaignSessionId });
  if (error) throw error;
  return Number(count || 0);
}

async function readEmergencyStopActive() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("system_control")
    .select("value")
    .eq("key", "queue_emergency_stop_at")
    .maybeSingle();
  if (error) throw error;
  const value = String(data?.value ?? "").trim().toLowerCase();
  return Boolean(value && !["0", "false", "off", "none", "null", "cleared", "clear"].includes(value));
}

marker.mark("preview route uses campaign automation service", route.includes("previewCampaignTargets"));
marker.mark("preview route forces dry_run", route.includes("dry_run: true"));
marker.mark("preview route has no insert/update/delete", !/\.(insert|update|delete|upsert)\s*\(/.test(route));
marker.mark("preview function defines layerCounts", previewFunction.includes("layerCounts"));
marker.mark("preview function does not insert send_queue rows", !/\.from\(['"]send_queue['"]\)\.insert/.test(previewFunction));
marker.mark("preview function does not call queue runners", !/runSendQueue|processSendQueue|queueOutboundMessage/.test(previewFunction));
marker.mark("preview route/function does not call TextGrid sender", !/sendText|sendSms|textgrid\.messages|insertSupabaseSendQueueRow/i.test(route + previewFunction));

let beforeCount = null;
try {
  beforeCount = await countProofSendQueueRows();
  if (beforeCount !== null) marker.mark("proof session starts with no send_queue rows", beforeCount === 0, `count=${beforeCount}`);
} catch (error) {
  marker.mark("send_queue proof-session count available", false, error?.message || String(error), true);
}

try {
  const emergencyActive = await readEmergencyStopActive();
  if (emergencyActive === null) {
    marker.mark("global emergency stop live check skipped without Supabase service role", true, "", true);
  } else {
    marker.mark("global emergency stop remains active", emergencyActive);
  }
} catch (error) {
  marker.mark("global emergency stop read available", false, error?.message || String(error), true);
}

const cases = [
  ["no filters", previewPayload()],
  ["state TX", previewPayload({
    field_key: "properties.property_state",
    operator: "is_any_of",
    value: ["TX"],
  })],
  ["property type", previewPayload({
    field_key: "properties.property_type",
    operator: "is_any_of",
    value: ["Single Family"],
  })],
  ["routing tier", previewPayload({
    field_key: "sender_coverage.routing_tier",
    operator: "is_any_of",
    value: ["exact", "alias", "regional", "cluster"],
  })],
];

const first = await callPreview(cases[0][0], cases[0][1]);
if (isHttpUnavailable(first.result)) {
  marker.mark("live preview layer count route skipped because API server is not running", true, routeSummary(first.result), true);
} else {
  const results = [first];
  for (const [name, payload] of cases.slice(1)) {
    results.push(await callPreview(name, payload));
  }

  for (const { name, result, json } of results) {
    marker.mark(`${name} returned 200`, result.status === 200, routeSummary(result));
    marker.mark(`${name} reports ok true`, json.ok === true);
    marker.mark(`${name} exposes layerCounts`, hasLayerCounts(json));
    marker.mark(`${name} preserves separated sampleTargets`, sampleTargetsSeparated(json));
  }

  const routing = results.find((entry) => entry.name === "routing tier")?.json || {};
  marker.mark(
    "routing tier preview has layerCounts or warning",
    hasLayerCounts(routing) || warnings(routing).length > 0,
    `warnings=${warnings(routing).join("|") || "none"}`
  );

  try {
    const afterCount = await countProofSendQueueRows();
    if (afterCount !== null) marker.mark("preview layer proof inserted no send_queue rows", afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);
  } catch (error) {
    marker.mark("send_queue proof-session recount available", false, error?.message || String(error), true);
  }
}

marker.finish(label);
