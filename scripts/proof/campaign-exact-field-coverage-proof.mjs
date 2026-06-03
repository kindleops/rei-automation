#!/usr/bin/env node

import {
  callJson,
  createMarker,
  isHttpUnavailable,
  routeSummary,
} from "./campaign-proof-utils.mjs";

const marker = createMarker();
const label = "campaign exact field coverage proof";

const domains = ["properties", "prospects", "master_owners", "phones", "outreach", "sender_coverage"];

const expected = {
  properties: {
    text: [
      "property_county_name", "property_state", "property_zip", "market", "market_region",
      "property_type", "sale_date", "seller_tags_text", "last_sale_doc_type",
      "property_address_city", "property_address_county_name", "property_address_state",
      "property_address_zip", "property_address_range", "property_class", "owner_type",
      "owner_location", "document_type", "air_conditioning", "basement", "building_condition",
      "building_quality", "construction_type", "county_land_use_code", "exterior_walls",
      "floor_cover", "garage", "heating_fuel_type", "heating_type", "interior_walls",
      "pool", "porch", "patio", "deck", "driveway", "roof_cover", "roof_type",
      "sewer", "water", "zoning", "subdivision_name", "school_district_name",
      "flood_zone", "geographic_features", "property_flags_text", "search_profile_hash",
      "sqft_range", "rehab_level", "lot_nbr", "style", "topography", "other_rooms",
      "deal_list_label", "owner_type_guess",
    ],
    number: [
      "estimated_value", "equity_amount", "equity_percent", "total_loan_balance",
      "total_loan_payment", "tax_amt", "sale_price", "units_count", "tax_delinquent_year",
      "ownership_years", "total_loan_amt", "building_square_feet", "year_built",
      "effective_year_built", "total_baths", "total_bedrooms", "lot_acreage",
      "lot_square_feet", "avg_sqft_per_unit", "beds_per_unit", "structured_motivation_score",
      "deal_strength_score", "tag_distress_score", "final_acquisition_score",
      "assd_improvement_value", "assd_land_value", "assd_total_value", "assd_year",
      "calculated_improvement_value", "calculated_land_value", "calculated_total_value",
      "lot_size_depth_feet", "lot_size_frontage_feet", "num_of_fireplaces",
      "past_due_amount", "stories", "sum_buildings_nbr", "sum_commercial_units",
      "sum_garage_sqft", "estimated_repair_cost", "estimated_repair_cost_per_sqft",
    ],
    boolean: ["tax_delinquent", "active_lien", "is_corporate_owner", "out_of_state_owner"],
    json: ["seller_tags_json"],
    date: ["recording_date", "default_date"],
  },
  prospects: {
    text: [
      "language_preference", "gender", "marital_status", "education_model",
      "occupation_group", "est_household_income", "net_asset_value", "buying_power",
      "mob", "matching_flags", "person_flags_text", "timezone", "contact_window",
      "seller_tags_text",
    ],
    boolean: ["sms_eligible", "email_eligible"],
  },
  master_owners: {
    text: ["owner_type_guess", "priority_tier", "follow_up_cadence"],
    number: [
      "contactability_score", "financial_pressure_score", "urgency_score", "priority_score",
      "portfolio_total_value", "portfolio_total_equity", "portfolio_total_loan_balance",
      "portfolio_total_loan_payment", "portfolio_total_tax_amount", "portfolio_total_units",
      "property_count", "tax_delinquent_count", "oldest_tax_delinquent_year",
      "active_lien_count", "max_ownership_years",
    ],
  },
  phones: {
    text: ["phone_owner", "activity_status", "usage_12_months", "usage_2_months"],
  },
};

function expectedEntries() {
  const entries = [];
  for (const [domain, typeGroups] of Object.entries(expected)) {
    for (const [type, columns] of Object.entries(typeGroups)) {
      for (const column of columns) entries.push({ domain, column, key: `${domain}.${column}`, type });
    }
  }
  return entries;
}

function groupedFilters(filters) {
  const groups = Object.fromEntries(domains.map((domain) => [domain, []]));
  for (const [field, value] of filters) {
    const domain = field.split(".")[0];
    groups[domain].push({
      field_key: field,
      operator: "is_any_of",
      value: [value],
      domain,
      category: "proof",
    });
  }
  return groups;
}

async function callOptions(field) {
  const result = await callJson(`/api/cockpit/campaigns/options?field=${encodeURIComponent(field)}&limit=5`, {
    timeout_seconds: 90,
  });
  return { result, json: result.json || {} };
}

async function callPreview(filters) {
  const result = await callJson("/api/cockpit/campaigns/preview-targets", {
    method: "POST",
    timeout_seconds: 120,
    body: JSON.stringify({
      source: "outbound_feeder_candidates",
      proof: true,
      dry_run: true,
      scan_limit: 5000,
      limitPreview: 1,
      filters: groupedFilters(filters),
    }),
  });
  return {
    result,
    total: Number(result.json?.total_matched ?? result.json?.reach?.totalMatched ?? 0),
  };
}

const catalogResponse = await callJson("/api/cockpit/campaigns/field-catalog", { timeout_seconds: 60 });

if (isHttpUnavailable(catalogResponse)) {
  marker.mark("live API route skipped because API server is not running", true, routeSummary(catalogResponse), true);
  marker.finish(label);
}

marker.mark("field catalog returned 200", catalogResponse.status === 200, routeSummary(catalogResponse));
marker.mark("field catalog reports ok true", catalogResponse.json?.ok === true);

const fields = [];
for (const domain of catalogResponse.json?.domains || []) {
  for (const category of domain.categories || []) fields.push(...(category.fields || []));
}
const byKey = new Map(fields.map((field) => [field.key, field]));
const coverageFailures = [];

for (const expectedField of expectedEntries()) {
  const field = byKey.get(expectedField.key);
  if (!field) {
    coverageFailures.push(`${expectedField.key}:missing`);
    continue;
  }
  if (field.type !== expectedField.type) {
    coverageFailures.push(`${expectedField.key}:type=${field.type},expected=${expectedField.type}`);
  }
  if (field.supported_in_preview !== true) {
    coverageFailures.push(`${expectedField.key}:not_preview_supported`);
  }
  if (expectedField.type === "text" && field.supports_options !== true) {
    coverageFailures.push(`${expectedField.key}:text_without_options`);
  }
}

marker.mark(
  "all requested properties/prospects/master_owners/phones fields are cataloged with requested types",
  coverageFailures.length === 0,
  coverageFailures.slice(0, 10).join(" | "),
);

for (const field of [
  "properties.style",
  "prospects.mob",
  "prospects.est_household_income",
  "master_owners.priority_tier",
  "phones.usage_12_months",
]) {
  const { result, json } = await callOptions(field);
  const firstOption = Array.isArray(json.options) ? json.options.find((option) => Number(option.count || 0) > 0) : null;
  marker.mark(`${field} options returned 200`, result.status === 200, routeSummary(result));
  marker.mark(`${field} returns real options`, Boolean(firstOption), firstOption ? `${firstOption.label}:${firstOption.count}` : "none");
  marker.mark(`${field} uses full source table option counts`, json.countJoinStrategy === "source_table_full_scan", json.countJoinStrategy || "missing");
}

const stackedFilters = [
  ["properties.market", "Atlanta, GA"],
  ["properties.property_type", "Single Family"],
  ["prospects.est_household_income", "$35,000-$39,999"],
  ["master_owners.priority_tier", "TIER_1"],
  ["phones.usage_12_months", "Heavy Usage"],
];

let prior = Infinity;
const stackCounts = [];
for (let index = 1; index <= stackedFilters.length; index += 1) {
  const activeFilters = stackedFilters.slice(0, index);
  const preview = await callPreview(activeFilters);
  const nonIncreasing = preview.total <= prior;
  stackCounts.push(preview.total);
  marker.mark(
    `stacked filter count ${index} is non-increasing`,
    preview.result.status === 200 && nonIncreasing,
    `count=${preview.total} prior=${prior === Infinity ? "none" : prior} ${routeSummary(preview.result)}`,
  );
  prior = preview.total;
}

marker.mark(
  "stacked property/prospect/master-owner/phone filters narrow live reach",
  stackCounts.every((count, index) => index === 0 || count <= stackCounts[index - 1]),
  `counts=${stackCounts.join(">")}`,
);

marker.finish(label);
