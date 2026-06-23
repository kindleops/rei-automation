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
const label = "campaign preview filter mapping proof";
const campaignSessionId = `campaign-preview-filter-mapping-proof-${Date.now()}`;

const route = readRel("apps/api/src/app/api/cockpit/campaigns/preview-targets/route.js");
const service = readRel("apps/api/src/lib/domain/campaigns/campaign-automation-service.js");
const previewFunction = service.slice(
  service.indexOf("export async function previewCampaignTargets"),
  service.indexOf("function mapCampaignSummary"),
);

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

function previewPayload(filter = null, extra = {}) {
  return {
    source: "v_properties",
    proof: true,
    include_diagnostics: true,
    dry_run: true,
    campaign_session_id: campaignSessionId,
    scan_limit: 5,
    limitPreview: 1,
    filters: groupedFilters(filter),
    ...extra,
  };
}

async function callPreview(name, payload) {
  const result = await callJson("/api/cockpit/campaigns/preview-targets", {
    method: "POST",
    body: JSON.stringify(payload),
    timeout_seconds: 45,
  });
  return { name, result, json: result.json || {} };
}

function diagnostic(json = {}) {
  return json.diagnostics && typeof json.diagnostics === "object" ? json.diagnostics : json;
}

function appliedFilter(json = {}, fieldKey) {
  const lists = [
    json.appliedFilters,
    json.applied_filters,
    diagnostic(json).normalizedFilters,
    diagnostic(json).supportedFilters,
  ].filter(Array.isArray);
  return lists.flat().find((filter) => (
    filter?.field_key === fieldKey ||
    filter?.fieldKey === fieldKey
  )) || null;
}

function appliedHasColumn(json, fieldKey, columns = []) {
  const filter = appliedFilter(json, fieldKey);
  if (!filter) return false;
  const mapped = [
    filter.preview_column,
    filter.previewColumn,
    ...(Array.isArray(filter.preview_columns) ? filter.preview_columns : []),
    ...(Array.isArray(filter.previewColumns) ? filter.previewColumns : []),
    ...(Array.isArray(filter.preview_mapping?.preview_columns) ? filter.preview_mapping.preview_columns : []),
    filter.preview_mapping?.preview_column,
  ].filter(Boolean);
  return columns.length === 0 || mapped.some((column) => columns.includes(column));
}

function hasUnsupportedWarning(json = {}) {
  const warnings = [
    ...(Array.isArray(json.warnings) ? json.warnings : []),
    ...(Array.isArray(diagnostic(json).warnings) ? diagnostic(json).warnings : []),
  ].map((item) => JSON.stringify(item).toLowerCase());
  const unsupported = [
    ...(Array.isArray(json.unsupported_in_preview) ? json.unsupported_in_preview : []),
    ...(Array.isArray(diagnostic(json).unsupportedFilters) ? diagnostic(json).unsupportedFilters : []),
  ];
  return warnings.some((warning) => warning.includes("unsupported_in_preview")) || unsupported.length > 0;
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
marker.mark("preview function has no send_queue insert", !/\.from\(['"]send_queue['"]\)\.insert/.test(previewFunction));
marker.mark("preview function does not call queue runners", !/runSendQueue|processSendQueue|queueOutboundMessage/.test(previewFunction));
marker.mark("preview route/function does not call TextGrid sender", !/sendText|sendSms|textgrid\.messages|insertSupabaseSendQueueRow/i.test(route + previewFunction));
marker.mark("preview source normalizes domain sources", service.includes("PREVIEW_DOMAIN_SOURCES") && service.includes("previewSourcePlan"));
marker.mark("preview maps key campaign fields", [
  "properties.property_state",
  "properties.property_zip",
  "properties.market",
  "properties.property_type",
  "prospects.matching_flags",
  "sender_coverage.routing_tier",
].every((field) => service.includes(field)));
marker.mark("preview emits proof diagnostics", service.includes("buildPreviewDiagnostics") && service.includes("appliedSqlFilters"));

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

const noFilters = await callPreview("no filters", previewPayload());

if (isHttpUnavailable(noFilters.result)) {
  marker.mark("live preview filter mapping route skipped because API server is not running", true, routeSummary(noFilters.result), true);
} else {
  marker.mark("no-filter preview returned 200", noFilters.result.status === 200, routeSummary(noFilters.result));
  marker.mark("domain source normalized to candidate source", diagnostic(noFilters.json).receivedSource === "v_properties" && diagnostic(noFilters.json).sourceUsed !== "v_properties", `sourceUsed=${diagnostic(noFilters.json).sourceUsed || "missing"}`);
  marker.mark("diagnostics include normalized filters", Array.isArray(diagnostic(noFilters.json).normalizedFilters));
  marker.mark("diagnostics include supported filters", Array.isArray(diagnostic(noFilters.json).supportedFilters));
  marker.mark("diagnostics include unsupported filters", Array.isArray(diagnostic(noFilters.json).unsupportedFilters));
  marker.mark("diagnostics include applied filter summary", Array.isArray(diagnostic(noFilters.json).appliedSqlFilters));
  marker.mark("diagnostics include preview source columns", Array.isArray(diagnostic(noFilters.json).previewSourceColumns));
  marker.mark("diagnostics include source used", Boolean(diagnostic(noFilters.json).sourceUsed));
  marker.mark("no filters returns matched rows when source has rows", Number(noFilters.json.total_scanned || 0) === 0 || Number(noFilters.json.total_matched || noFilters.json.reach?.totalMatched || 0) > 0, `scanned=${noFilters.json.total_scanned} matched=${noFilters.json.total_matched || noFilters.json.reach?.totalMatched}`);

  const state = await callPreview("state TX", previewPayload({
    field_key: "properties.property_state",
    operator: "is_any_of",
    value: ["TX"],
  }));
  marker.mark("property_state filter returned 200", state.result.status === 200, routeSummary(state.result));
  marker.mark("property_state preview remains numeric", Number.isFinite(Number(state.json.total_matched ?? state.json.reach?.totalMatched)), `matched=${state.json.total_matched ?? state.json.reach?.totalMatched}`);
  marker.mark("property_state applied mapping present", appliedHasColumn(state.json, "properties.property_state", ["property_state", "property_address_state", "state"]));

  const propertyType = await callPreview("property type", previewPayload({
    field_key: "properties.property_type",
    operator: "is_any_of",
    value: ["Single Family"],
  }));
  marker.mark("property_type filter returned 200", propertyType.result.status === 200, routeSummary(propertyType.result));
  marker.mark("property_type preview remains numeric", Number.isFinite(Number(propertyType.json.total_matched ?? propertyType.json.reach?.totalMatched)), `matched=${propertyType.json.total_matched ?? propertyType.json.reach?.totalMatched}`);
  marker.mark("property_type applied mapping present", appliedHasColumn(propertyType.json, "properties.property_type", ["property_type", "canonical_property_group", "property_class"]));

  const auditedGraphFields = [
    {
      name: "property units_count",
      field_key: "properties.units_count",
      operator: "gte",
      value: 2,
      columns: ["units_count"],
    },
    {
      name: "legacy property units alias",
      field_key: "properties.units",
      expected_field_key: "properties.units_count",
      operator: "gte",
      value: 2,
      columns: ["units_count"],
    },
    {
      name: "tax delinquent",
      field_key: "properties.tax_delinquent",
      operator: "is_true",
      value: true,
      columns: ["tax_delinquent"],
    },
    {
      name: "active lien",
      field_key: "properties.active_lien",
      operator: "is_true",
      value: true,
      columns: ["active_lien"],
    },
    {
      name: "property flags",
      field_key: "properties.property_flags_text",
      operator: "contains",
      value: "vacant",
      columns: ["property_flags_text"],
    },
    {
      name: "building condition",
      field_key: "properties.building_condition",
      operator: "is_any_of",
      value: ["Poor"],
      columns: ["building_condition"],
    },
    {
      name: "property class",
      field_key: "properties.property_class",
      operator: "is_any_of",
      value: ["Residential"],
      columns: ["property_class", "canonical_property_group"],
    },
    {
      name: "corporate owner flag",
      field_key: "properties.is_corporate_owner",
      operator: "is_true",
      value: true,
      columns: ["is_corporate_owner"],
    },
    {
      name: "out-of-state owner flag",
      field_key: "properties.out_of_state_owner",
      operator: "is_true",
      value: true,
      columns: ["out_of_state_owner"],
    },
    {
      name: "owner type guess",
      field_key: "master_owners.owner_type_guess",
      operator: "is_any_of",
      value: ["Corporate"],
      columns: ["owner_type_guess"],
    },
    {
      name: "prospect gender",
      field_key: "prospects.gender",
      operator: "is_any_of",
      value: ["Male"],
      columns: ["gender"],
    },
    {
      name: "prospect net asset value",
      field_key: "prospects.net_asset_value",
      operator: "is_any_of",
      value: ["$100k-$250k"],
      columns: ["net_asset_value"],
    },
    {
      name: "prospect buying power",
      field_key: "prospects.buying_power",
      operator: "is_any_of",
      value: ["High"],
      columns: ["buying_power"],
    },
    {
      name: "prospect email eligible",
      field_key: "prospects.email_eligible",
      operator: "is_true",
      value: true,
      columns: ["email_eligible"],
    },
    {
      name: "phone owner",
      field_key: "phones.phone_owner",
      operator: "is_any_of",
      value: ["Mobile"],
      columns: ["phone_owner"],
    },
    {
      name: "phone activity status",
      field_key: "phones.activity_status",
      operator: "is_any_of",
      value: ["active"],
      columns: ["phone_activity_status"],
    },
    {
      name: "phone usage 12 months",
      field_key: "phones.usage_12_months",
      operator: "is_any_of",
      value: ["1"],
      columns: ["usage_12_months"],
    },
  ];

  for (const audit of auditedGraphFields) {
    const expectedFieldKey = audit.expected_field_key || audit.field_key;
    const response = await callPreview(audit.name, previewPayload({
      field_key: audit.field_key,
      operator: audit.operator,
      value: audit.value,
    }));
    marker.mark(`${audit.name} filter returned 200`, response.result.status === 200, routeSummary(response.result));
    marker.mark(`${audit.name} preview remains numeric`, Number.isFinite(Number(response.json.total_matched ?? response.json.reach?.totalMatched)), `matched=${response.json.total_matched ?? response.json.reach?.totalMatched}`);
    marker.mark(`${audit.name} applied graph mapping present`, appliedHasColumn(response.json, expectedFieldKey, audit.columns));
  }

  const market = await callPreview("market", previewPayload({
    field_key: "properties.market",
    operator: "eq",
    value: "Houston, TX",
  }));
  marker.mark("market filter returned 200", market.result.status === 200, routeSummary(market.result));
  marker.mark("market filter reports ok true", market.json.ok === true);
  const marketColumns = diagnostic(market.json).previewSourceColumns || [];
  const marketMappingRequired = marketColumns.includes("market") || marketColumns.includes("seller_market");
  marker.mark("market applied mapping present when source column is available", !marketMappingRequired || appliedHasColumn(market.json, "properties.market", ["market", "seller_market"]));

  const flags = await callPreview("matching flags", previewPayload({
    field_key: "prospects.matching_flags",
    operator: "contains",
    value: "Likely Owner",
  }));
  marker.mark("matching_flags filter returned 200", flags.result.status === 200, routeSummary(flags.result));
  marker.mark("matching_flags filter reports ok true", flags.json.ok === true);
  marker.mark("matching_flags applied mapping present", appliedHasColumn(flags.json, "prospects.matching_flags", ["matching_flags", "matching_flags_text", "prospect_matching_flags"]));

  const formerlyUnsupported = await callPreview("formerly unsupported county field", previewPayload({
    field_key: "properties.property_county_name",
    operator: "contains",
    value: "Proof County",
  }));
  marker.mark("formerly unsupported approved field did not 500", formerlyUnsupported.result.status === 200, routeSummary(formerlyUnsupported.result));
  marker.mark("formerly unsupported approved field now applies without unsupported warning", !hasUnsupportedWarning(formerlyUnsupported.json));
  marker.mark("formerly unsupported approved field applied mapping present", appliedHasColumn(formerlyUnsupported.json, "properties.property_county_name", ["property_county_name"]));

  try {
    const afterCount = await countProofSendQueueRows();
    if (afterCount !== null) marker.mark("preview inserted no send_queue rows", afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);
  } catch (error) {
    marker.mark("send_queue proof-session recount available", false, error?.message || String(error), true);
  }
}

marker.finish(label);
