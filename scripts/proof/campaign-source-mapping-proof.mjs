#!/usr/bin/env node

import {
  callJson,
  createMarker,
  isHttpUnavailable,
  readRel,
  routeSummary,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign source mapping proof";

const optionsRoute = readRel("apps/api/src/app/api/cockpit/campaigns/options/route.js");
const catalog = readRel("apps/api/src/lib/domain/campaigns/campaign-field-catalog.js");
const previewService = readRel("apps/api/src/lib/domain/campaigns/campaign-automation-service.js");

const fields = [
  "properties.market",
  "properties.property_address_city",
  "properties.property_state",
  "properties.property_zip",
  "properties.property_type",
];

const forbiddenMarketColumns = new Set([
  "property_address_city",
  "city",
  "owner_location",
  "property_address_county_name",
  "property_county_name",
  "county",
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function warnings(json = {}) {
  return [
    ...(Array.isArray(json.warnings) ? json.warnings : []),
    ...(json.warning ? [json.warning] : []),
  ].map((warning) => String(warning));
}

async function callOptions(field) {
  const params = new URLSearchParams({ field, limit: "25" });
  const result = await callJson(`/api/cockpit/campaigns/options?${params.toString()}`, {
    timeout_seconds: 30,
  });
  return { field, result, json: result.json || {} };
}

marker.mark("options route uses catalog option query", optionsRoute.includes("queryCampaignFieldOptions"));
marker.mark("catalog defines canonical source mappings", catalog.includes("CANONICAL_SOURCE_MAPPINGS"));
marker.mark(
  "properties.market mapping excludes city/county/locality columns",
  ![
    "property_address_city",
    "city",
    "owner_location",
    "property_address_county_name",
    "county",
  ].some((column) => {
    const marketMapping = catalog.slice(
      catalog.indexOf("'properties.market'"),
      catalog.indexOf("'properties.property_address_city'")
    );
    return marketMapping.includes(`'${column}'`) && !marketMapping.includes("forbiddenColumns");
  })
);
marker.mark("preview service consumes canonical source mappings", previewService.includes("getCampaignCanonicalSourceMapping"));

const first = await callOptions(fields[0]);
if (isHttpUnavailable(first.result)) {
  marker.mark("live options route skipped because API server is not running", true, routeSummary(first.result), true);
} else {
  const results = [first];
  for (const field of fields.slice(1)) {
    results.push(await callOptions(field));
  }

  for (const { field, result, json } of results) {
    marker.mark(`${field} did not 500`, result.status !== 500, routeSummary(result));
    marker.mark(`${field} returned 200`, result.status === 200, routeSummary(result));
    marker.mark(`${field} reports ok true`, json.ok === true);
    marker.mark(`${field} includes sourceUsed`, hasOwn(json, "sourceUsed") && Boolean(json.sourceUsed));
    marker.mark(`${field} includes sourceColumn`, hasOwn(json, "sourceColumn"));
    marker.mark(`${field} includes canonicalField`, json.canonicalField === field);
  }

  const market = results.find((entry) => entry.field === "properties.market")?.json || {};
  const marketColumn = String(market.sourceColumn || "");
  const marketWarnings = warnings(market);
  marker.mark(
    "properties.market sourceColumn is canonical or unavailable",
    (!marketColumn || !forbiddenMarketColumns.has(marketColumn)) &&
      (Boolean(marketColumn) || marketWarnings.includes("canonical_market_unavailable")),
    `sourceColumn=${marketColumn || "null"} warnings=${marketWarnings.join("|") || "none"}`
  );
  marker.mark(
    "properties.market returns canonical options or canonical_market_unavailable",
    Boolean(marketColumn) || marketWarnings.includes("canonical_market_unavailable"),
    `options=${Array.isArray(market.options) ? market.options.length : "missing"}`
  );

  const city = results.find((entry) => entry.field === "properties.property_address_city")?.json || {};
  marker.mark(
    "properties.property_address_city uses city source mapping",
    ["property_address_city", "city"].includes(String(city.sourceColumn || "")),
    `sourceColumn=${city.sourceColumn || "missing"}`
  );
}

marker.finish(label);
