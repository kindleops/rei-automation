#!/usr/bin/env node

import {
  callJson,
  createMarker,
  isHttpUnavailable,
  readRel,
  routeSummary,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign field catalog proof";

const route = readRel("apps/api/src/app/api/cockpit/campaigns/field-catalog/route.js");
const catalog = readRel("apps/api/src/lib/domain/campaigns/campaign-field-catalog.js");

const domains = [
  "properties",
  "prospects",
  "master_owners",
  "phones",
  "outreach",
  "sender_coverage",
];

marker.mark("field-catalog route uses catalog response", route.includes("getCampaignFieldCatalogResponse"));
marker.mark("field catalog defines six campaign domains", domains.every((domain) => catalog.includes(`'${domain}'`)));
marker.mark("field catalog keeps source-by-domain mapping", catalog.includes("SOURCE_BY_DOMAIN"));
marker.mark("field catalog has canonical source mappings", catalog.includes("CANONICAL_SOURCE_MAPPINGS"));
marker.mark("field catalog has no send_queue writes", !/\.from\(['"]send_queue['"]\)\.(insert|update|delete|upsert)/.test(catalog));
marker.mark("field catalog does not call TextGrid sender", !/sendText|sendSms|textgrid\.messages/i.test(catalog));

const result = await callJson("/api/cockpit/campaigns/field-catalog", { timeout_seconds: 30 });

if (isHttpUnavailable(result)) {
  marker.mark("live field-catalog route skipped because API server is not running", true, routeSummary(result), true);
} else {
  const json = result.json || {};
  marker.mark("field-catalog returned 200", result.status === 200, routeSummary(result));
  marker.mark("field-catalog reports ok true", json.ok === true);
  marker.mark("field-catalog returns six domains", Array.isArray(json.domains) && json.domains.length === 6, `domains=${json.domains?.length ?? "missing"}`);
  marker.mark("field-catalog returns 155 fields", Number(json.total_fields) === 155, `total_fields=${json.total_fields}`);
  marker.mark("field-catalog includes properties.market", JSON.stringify(json).includes("properties.market"));
  marker.mark("field-catalog includes properties.property_address_city", JSON.stringify(json).includes("properties.property_address_city"));
}

marker.finish(label);
