#!/usr/bin/env node

import {
  callJson,
  isHttpUnavailable,
  routeSummary,
} from "./campaign-proof-utils.mjs";

const fields = [
  "properties.market",
  "properties.property_address_city",
  "properties.property_state",
  "properties.property_zip",
  "properties.property_type",
  "prospects.language_preference",
  "prospects.age_bucket",
  "prospects.matching_flags",
  "prospects.person_flags_text",
  "prospects.seller_tags_text",
  "master_owners.priority_tier",
  "master_owners.owner_type_guess",
  "master_owners.follow_up_cadence",
  "master_owners.contactability_score",
  "master_owners.financial_pressure_score",
  "master_owners.urgency_score",
  "master_owners.priority_score",
  "phones.phone_owner",
  "phones.activity_status",
  "phones.usage_12_months",
  "phones.usage_2_months",
  "outreach.never_contacted",
  "outreach.pending_prior_touch",
  "outreach.true_post_contact_suppression",
  "outreach.duplicate_queue_status",
  "sender_coverage.routing_allowed",
  "sender_coverage.routing_tier",
  "sender_coverage.selected_textgrid_market",
  "sender_coverage.selected_textgrid_state",
  "sender_coverage.sender_coverage_status",
];

function warnings(json = {}) {
  return [
    ...(Array.isArray(json.warnings) ? json.warnings : []),
    ...(json.warning ? [json.warning] : []),
  ];
}

function summarize(field, result) {
  const json = result.json || {};
  const options = Array.isArray(json.options) ? json.options : [];
  return {
    field,
    status: result.status,
    ok: json.ok === true,
    optionSource: json.optionSourceTableOrView || json.sourceUsed || null,
    optionColumn: json.optionColumn || json.sourceColumn || null,
    countSource: json.countSourceTableOrView || json.countSourceUsed || null,
    countColumn: json.countColumn || null,
    countMeaning: json.countMeaning || null,
    optionMode: json.option_mode || null,
    optionCountReturned: options.length,
    warnings: warnings(json),
    sampleOptions: options.slice(0, 5).map((option) => ({
      value: option.value,
      label: option.label,
      count: option.count ?? null,
    })),
  };
}

const firstParams = new URLSearchParams({ field: fields[0], limit: "25" });
const first = await callJson(`/api/cockpit/campaigns/options?${firstParams.toString()}`, {
  timeout_seconds: 60,
});

if (isHttpUnavailable(first)) {
  console.log(JSON.stringify({
    ok: false,
    skipped: true,
    reason: "api_server_unavailable",
    detail: routeSummary(first),
  }, null, 2));
  process.exit(0);
}

const rows = [summarize(fields[0], first)];
for (const field of fields.slice(1)) {
  const params = new URLSearchParams({ field, limit: "25" });
  const result = await callJson(`/api/cockpit/campaigns/options?${params.toString()}`, {
    timeout_seconds: 60,
  });
  rows.push(summarize(field, result));
}

console.log(JSON.stringify({
  ok: true,
  generatedAt: new Date().toISOString(),
  fields: rows,
}, null, 2));
