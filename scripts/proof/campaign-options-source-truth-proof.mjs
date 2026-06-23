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
const label = "campaign options source truth proof";
const campaignSessionId = `campaign-options-source-truth-proof-${Date.now()}`;

const optionsRoute = readRel("apps/api/src/app/api/cockpit/campaigns/options/route.js");
const legacyRoute = readRel("apps/api/src/app/api/cockpit/campaigns/filter-options/route.js");
const catalog = readRel("apps/api/src/lib/domain/campaigns/campaign-field-catalog.js");
const previewRoute = readRel("apps/api/src/app/api/cockpit/campaigns/preview-targets/route.js");
const previewService = readRel("apps/api/src/lib/domain/campaigns/campaign-automation-service.js");
const wizardAdapter = readRel("apps/dashboard/src/modules/campaigns/campaignWizardAdapter.ts");
const previewFunction = previewService.slice(
  previewService.indexOf("export async function previewCampaignTargets"),
  previewService.indexOf("function mapCampaignSummary"),
);

const domains = ["properties", "prospects", "master_owners", "phones", "outreach", "sender_coverage"];
const forbiddenMarketColumns = new Set([
  "property_address_city",
  "city",
  "owner_location",
  "property_address_county_name",
  "property_county_name",
  "county",
]);

const fields = [
  "properties.market",
  "properties.property_address_city",
  "properties.property_type",
  "prospects.language_preference",
  "prospects.matching_flags",
  "master_owners.priority_tier",
  "phones.phone_owner",
  "outreach.never_contacted",
  "sender_coverage.routing_tier",
];

function warnings(json = {}) {
  return [
    ...(Array.isArray(json.warnings) ? json.warnings : []),
    ...(json.warning ? [json.warning] : []),
  ].map((warning) => String(warning));
}

function options(json = {}) {
  return Array.isArray(json.options) ? json.options : [];
}

async function callOptions(field, limit = 25) {
  const params = new URLSearchParams({ field, limit: String(limit) });
  const result = await callJson(`/api/cockpit/campaigns/options?${params.toString()}`, {
    timeout_seconds: 60,
  });
  return { field, result, json: result.json || {} };
}

function groupedFilters(field, value) {
  const groups = Object.fromEntries(domains.map((domain) => [domain, []]));
  const domain = field.split(".")[0];
  groups[domain] = [{
    field_key: field,
    operator: "is_any_of",
    value: [value],
    domain,
    category: "proof",
  }];
  return groups;
}

async function callPreviewForOption(field, value) {
  return callJson("/api/cockpit/campaigns/preview-targets", {
    method: "POST",
    timeout_seconds: 90,
    body: JSON.stringify({
      source: "outbound_feeder_candidates",
      proof: true,
      include_diagnostics: true,
      dry_run: true,
      campaign_session_id: campaignSessionId,
      scan_limit: 5000,
      limitPreview: 1,
      filters: groupedFilters(field, value),
    }),
  });
}

function totalMatched(json = {}) {
  return Number(json.total_matched ?? json.reach?.totalMatched ?? json.total_matching_properties ?? 0);
}

function countsAlign(left, right) {
  const delta = Math.abs(Number(left || 0) - Number(right || 0));
  const tolerance = Math.max(5, Math.ceil(Math.max(Number(left || 0), Number(right || 0)) * 0.02));
  return delta <= tolerance;
}

async function countSendQueueRows() {
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

marker.mark("options route uses catalog option query", optionsRoute.includes("queryCampaignFieldOptions"));
marker.mark("legacy filter-options route uses catalog option query", legacyRoute.includes("queryCampaignFieldOptions"));
marker.mark("legacy filter-options route has no Math.random", !legacyRoute.includes("Math.random"));
marker.mark("catalog has no Math.random option counts", !catalog.includes("Math.random"));
marker.mark("dashboard adapter has no hardcoded OPTION_SETS", !wizardAdapter.includes("OPTION_SETS"));
marker.mark("market mapping names forbidden locality columns", catalog.includes("MARKET_FORBIDDEN_COLUMNS"));
marker.mark("market source columns are true market candidates", catalog.includes("TRUE_MARKET_COLUMNS"));
marker.mark("options response includes source/count diagnostics", [
  "optionSourceTableOrView",
  "optionColumn",
  "countSourceTableOrView",
  "countColumn",
  "countMeaning",
  "queryMs",
].every((token) => catalog.includes(token)));
marker.mark("preview route forces dry run", previewRoute.includes("dry_run: true"));
marker.mark("preview/options do not insert send_queue", !/\.from\(['"]send_queue['"]\)\.insert/.test(optionsRoute + legacyRoute + previewRoute + previewFunction));
marker.mark("preview/options do not call TextGrid sender", !/sendTextgridSMS|sendText|textgrid\.messages/i.test(optionsRoute + legacyRoute + previewRoute + previewFunction));

const beforeSendQueue = await countSendQueueRows();
const first = await callOptions(fields[0]);

if (isHttpUnavailable(first.result)) {
  marker.mark("live options route skipped because API server is not running", true, routeSummary(first.result), true);
} else {
  const results = [first];
  for (const field of fields.slice(1)) results.push(await callOptions(field));

  for (const { field, result, json } of results) {
    marker.mark(`${field} did not 500`, result.status !== 500, routeSummary(result));
    marker.mark(`${field} returned 200`, result.status === 200, routeSummary(result));
    marker.mark(`${field} reports ok true`, json.ok === true);
    marker.mark(`${field} returns options array`, Array.isArray(json.options));
    marker.mark(`${field} includes source diagnostics`, Boolean("sourceUsed" in json && "sourceColumn" in json && "countMeaning" in json));
  }

  const market = results.find((entry) => entry.field === "properties.market")?.json || {};
  const marketColumn = String(market.sourceColumn || "");
  const marketWarnings = warnings(market);
  marker.mark(
    "properties.market sourceColumn is a true market column or unavailable",
    (!marketColumn || !forbiddenMarketColumns.has(marketColumn)) &&
      (["market", "canonical_market", "seller_market", "market_name", "name", "label"].includes(marketColumn) ||
        marketWarnings.includes("canonical_market_unavailable")),
    `sourceColumn=${marketColumn || "null"} warnings=${marketWarnings.join("|") || "none"}`,
  );
  marker.mark(
    "properties.market does not use city/locality fallback",
    !["property_address_city", "city"].includes(marketColumn),
    `sourceColumn=${marketColumn || "null"}`,
  );

  const city = results.find((entry) => entry.field === "properties.property_address_city")?.json || {};
  marker.mark(
    "properties.property_address_city returns city separately when available",
    warnings(city).some((warning) => warning.includes("campaign_target_graph_facets_unavailable")) ||
      warnings(city).includes("field_options_unavailable") ||
      ["property_address_city", "property_city", "city"].includes(String(city.sourceColumn || "")),
    `sourceColumn=${city.sourceColumn || "missing"} options=${options(city).length}`,
  );

  for (const field of ["prospects.language_preference", "prospects.matching_flags", "master_owners.priority_tier", "phones.phone_owner", "outreach.never_contacted", "sender_coverage.routing_tier"]) {
    const json = results.find((entry) => entry.field === field)?.json || {};
    marker.mark(`${field} returns real options or warning`, options(json).length > 0 || warnings(json).length > 0);
  }

  for (const field of ["properties.market", "properties.property_type"]) {
    const json = results.find((entry) => entry.field === field)?.json || {};
    const option = options(json).find((entry) => Number(entry.count || 0) > 0);
    if (!option) {
      marker.mark(`${field} count alignment skipped because no counted option was returned`, true, `warnings=${warnings(json).join("|") || "none"}`, true);
      continue;
    }
    const preview = await callPreviewForOption(field, option.value);
    const matched = totalMatched(preview.json || {});
    marker.mark(`${field} option count aligns with preview`, countsAlign(matched, option.count), `option=${option.value} count=${option.count} preview=${matched} ${routeSummary(preview)}`);
  }
}

const afterSendQueue = await countSendQueueRows();
if (beforeSendQueue !== null && afterSendQueue !== null) {
  marker.mark("no send_queue rows inserted", beforeSendQueue === afterSendQueue, `before=${beforeSendQueue} after=${afterSendQueue}`);
} else {
  marker.mark("send_queue mutation check skipped without Supabase env", true, "", true);
}

const emergencyStopActive = await readEmergencyStopActive();
if (emergencyStopActive === null) {
  marker.mark("emergency stop check skipped without Supabase env", true, "", true);
} else {
  marker.mark("emergency stop remains active", emergencyStopActive === true);
}

marker.finish(label);
