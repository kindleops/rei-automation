#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const marker = {
  failures: 0,
  mark(label, condition, detail = "") {
    const prefix = condition ? "PASS" : "FAIL";
    const line = `${prefix} ${label}${detail ? ` ${detail}` : ""}`;
    if (condition) {
      console.log(line);
      return;
    }
    this.failures += 1;
    console.error(line);
  },
  finish(label) {
    if (this.failures > 0) {
      console.error(`FAIL ${label} failures=${this.failures}`);
      process.exit(1);
    }
    console.log(`PASS ${label}`);
  },
};

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

const migration = read("apps/api/supabase/migrations/20260605061522_campaign_target_graph_all_properties.sql");
const runner = read("scripts/ops/full-campaign-target-graph-refresh.mjs");
const service = read("apps/api/src/lib/domain/campaigns/campaign-automation-service.js");
const catalog = read("apps/api/src/lib/domain/campaigns/campaign-field-catalog.js");
const facetMigration = read("apps/api/supabase/migrations/20260602181243_campaign_target_graph_filter_columns.sql");

const auditedFields = [
  "properties.property_address_city",
  "properties.property_address_county_name",
  "properties.property_address_state",
  "properties.property_address_zip",
  "properties.property_type",
  "properties.property_class",
  "properties.seller_tags_text",
  "properties.property_flags_text",
  "properties.rehab_level",
  "properties.building_condition",
  "prospects.age_bucket",
  "prospects.buying_power",
  "prospects.net_asset_value",
];

marker.mark(
  "migration defines property-universe complement batch",
  migration.includes("refresh_campaign_target_graph_property_universe_batch") &&
    migration.includes("'campaign_target_graph.refresh.property_universe'"),
);
marker.mark(
  "property-universe rows are non-sendable missing-phone rows",
  migration.includes("false AS queue_eligible") &&
    migration.includes("'missing_phone'::text AS queue_block_reason") &&
    migration.includes("'missing_phone', true"),
);
marker.mark(
  "property-universe phase does not require phone_id/canonical_e164",
  !/FROM universe_paths\s+WHERE\s+phone_id\s+IS\s+NOT\s+NULL/i.test(migration) &&
    !/FROM universe_paths\s+WHERE\s+canonical_e164\s+IS\s+NOT\s+NULL/i.test(migration),
);

marker.mark(
  "full refresh runner enables universe phase by default",
  runner.includes("universeEnabled") &&
    runner.includes("refresh_campaign_target_graph_property_universe_batch") &&
    runner.includes("production_universe_complete") &&
    runner.includes("property_universe_offset:"),
);
marker.mark(
  "universe runner uses front cursor over shrinking unmatched set",
  runner.includes('phase === "universe" ? 0 : progress.nextOffset') &&
    runner.includes('phase === "universe" || (phase === "fallback" && config.fallbackCursor === "front")'),
);

marker.mark(
  "preview summary separates matched properties from reachable phones",
  service.includes("matchedPropertyCount") &&
    service.includes("reachableContacts") &&
    service.includes("linkedMasterOwners") &&
    service.includes("With reachable phone") &&
    service.includes("precomputed_property_universe_target_graph"),
);
marker.mark(
  "missing-phone graph blockers are grouped as no-phone blockers",
  service.includes("NO_PHONE: missingPhone.count") &&
    service.includes("'missing_phone', 'filter_valid_phone'"),
);
marker.mark(
  "graph row rule documents nullable phone/prospect fields",
  service.includes("1 row = 1 campaign property; seller/phone fields may be null until reachable"),
);

const missingCatalog = auditedFields.filter((field) => !catalog.includes(`'${field}'`));
const missingGraphMapping = auditedFields.filter((field) => !service.includes(`'${field}':`));
const missingFacet = auditedFields.filter((field) => !facetMigration.includes(`'${field}'`));

marker.mark(
  "all pasted audit fields are cataloged",
  missingCatalog.length === 0,
  missingCatalog.length ? missingCatalog.join(",") : "",
);
marker.mark(
  "all pasted audit fields map to campaign_target_graph filters",
  missingGraphMapping.length === 0,
  missingGraphMapping.length ? missingGraphMapping.join(",") : "",
);
marker.mark(
  "all pasted audit fields are represented in graph facets",
  missingFacet.length === 0,
  missingFacet.length ? missingFacet.join(",") : "",
);

marker.finish("campaign all-properties field audit proof");
