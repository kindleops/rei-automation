#!/usr/bin/env node

import {
  callJson,
  createMarker,
  isHttpUnavailable,
  readRel,
  routeSummary,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign options proof";

const route = readRel("apps/api/src/app/api/cockpit/campaigns/options/route.js");
const catalog = readRel("apps/api/src/lib/domain/campaigns/campaign-field-catalog.js");

const fields = [
  "properties.market",
  "properties.property_address_city",
  "properties.property_state",
  "properties.property_zip",
  "properties.property_type",
  "prospects.matching_flags",
];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

async function callOptions(field) {
  const params = new URLSearchParams({ field, limit: "20" });
  const result = await callJson(`/api/cockpit/campaigns/options?${params.toString()}`, {
    timeout_seconds: 30,
  });
  return { field, result, json: result.json || {} };
}

marker.mark("options route uses catalog option query", route.includes("queryCampaignFieldOptions"));
marker.mark("options route has no insert/update/delete", !/\.(insert|update|delete|upsert)\s*\(/.test(route));
marker.mark("options query returns source diagnostics", catalog.includes("sourceUsed") && catalog.includes("sourceColumn") && catalog.includes("canonicalField"));
marker.mark("options query returns queryMs", catalog.includes("queryMs"));
marker.mark("options query hard-locks canonical market unavailable warning", catalog.includes("canonical_market_unavailable"));

const first = await callOptions(fields[0]);
if (isHttpUnavailable(first.result)) {
  marker.mark("live options route skipped because API server is not running", true, routeSummary(first.result), true);
} else {
  const results = [first];
  for (const field of fields.slice(1)) {
    results.push(await callOptions(field));
  }

  for (const { field, result, json } of results) {
    marker.mark(`${field} returned 200`, result.status === 200, routeSummary(result));
    marker.mark(`${field} reports ok true`, json.ok === true);
    marker.mark(`${field} returns options array`, Array.isArray(json.options));
    marker.mark(`${field} includes sourceUsed`, hasOwn(json, "sourceUsed") && Boolean(json.sourceUsed));
    marker.mark(`${field} includes sourceColumn`, hasOwn(json, "sourceColumn"));
    marker.mark(`${field} includes canonicalField`, json.canonicalField === field);
    marker.mark(`${field} includes warnings`, Array.isArray(json.warnings));
    marker.mark(`${field} includes queryMs`, Number.isFinite(Number(json.queryMs)));
  }
}

marker.finish(label);
