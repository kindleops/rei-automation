#!/usr/bin/env node
/**
 * Prove bridge integrity against canonical prospects.linked_property_ids_json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../..");
const proofDir = path.join(apiRoot, "proof/map-filters");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) continue;
    out[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = {
  ...loadEnvFile(path.join(apiRoot, ".env.local")),
  ...loadEnvFile(path.join(apiRoot, ".env")),
  ...process.env,
};
for (const [key, value] of Object.entries(env)) {
  if (value && !process.env[key]) process.env[key] = value;
}

const { queryWithTimeout } = await import("../../src/lib/postgres/client.js");

const started = Date.now();
const report = { generatedAt: new Date().toISOString(), ok: true, issues: [] };

const rebuild = await queryWithTimeout("SELECT public.rebuild_map_filter_property_prospect_links() AS stats", [], 600_000);
report.rebuild = rebuild.rows[0]?.stats;

const [totals, jsonPairs, bridgePairs, dupes, orphans, ownerMismatch] = await Promise.all([
  queryWithTimeout(
    `SELECT
      (SELECT COUNT(*)::bigint FROM prospects) AS total_prospects,
      (SELECT COUNT(*)::bigint FROM prospects WHERE linked_property_ids_json IS NOT NULL AND linked_property_ids_json::text NOT IN ('[]','null')) AS prospects_with_links`,
    [],
    120_000,
  ),
  queryWithTimeout(
    `SELECT COUNT(*)::bigint AS json_relationship_entries
     FROM prospects pr
     CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(pr.linked_property_ids_json,'[]'::jsonb)) elem
     WHERE trim(elem) <> ''`,
    [],
    300_000,
  ),
  queryWithTimeout(`SELECT COUNT(*)::bigint AS bridge_relationships FROM map_filter_property_prospect_links`, [], 60_000),
  queryWithTimeout(
    `SELECT COUNT(*)::bigint AS duplicate_pairs FROM (
       SELECT property_id, prospect_id, COUNT(*) c
       FROM map_filter_property_prospect_links GROUP BY 1,2 HAVING COUNT(*) > 1
     ) d`,
    [],
    60_000,
  ),
  queryWithTimeout(
    `SELECT COUNT(*)::bigint AS orphan_property_refs
     FROM map_filter_property_prospect_links link
     WHERE NOT EXISTS (SELECT 1 FROM properties p WHERE p.property_id = link.property_id)`,
    [],
    120_000,
  ),
  queryWithTimeout(
    `SELECT COUNT(*)::bigint AS master_owner_mismatches
     FROM map_filter_property_prospect_links link
     JOIN prospects pr ON pr.prospect_id = link.prospect_id
     WHERE pr.master_owner_id IS DISTINCT FROM link.master_owner_id`,
    [],
    120_000,
  ),
]);

report.totals = {
  totalProspects: Number(totals.rows[0]?.total_prospects || 0),
  prospectsWithLinkedProperties: Number(totals.rows[0]?.prospects_with_links || 0),
  jsonRelationshipEntries: Number(jsonPairs.rows[0]?.json_relationship_entries || 0),
  bridgeRelationships: Number(bridgePairs.rows[0]?.bridge_relationships || 0),
  duplicatePairs: Number(dupes.rows[0]?.duplicate_pairs || 0),
  orphanPropertyRefs: Number(orphans.rows[0]?.orphan_property_refs || 0),
  masterOwnerMismatches: Number(ownerMismatch.rows[0]?.master_owner_mismatches || 0),
  durationMs: Date.now() - started,
};

const missingFromBridge = await queryWithTimeout(
  `SELECT COUNT(*)::bigint AS missing
   FROM (
     SELECT DISTINCT trim(elem) AS property_id, pr.prospect_id
     FROM prospects pr
     CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(pr.linked_property_ids_json,'[]'::jsonb)) elem
     WHERE trim(elem) <> '' AND trim(elem) ~ '^[0-9a-fA-F-]{8,}$'
   ) src
   WHERE NOT EXISTS (
     SELECT 1 FROM map_filter_property_prospect_links link
     WHERE link.property_id = src.property_id AND link.prospect_id = src.prospect_id
   )`,
  [],
  300_000,
);
report.totals.missingCanonicalLinks = Number(missingFromBridge.rows[0]?.missing || 0);

if (report.totals.duplicatePairs > 0) {
  report.ok = false;
  report.issues.push("duplicate_pairs_present");
}
if (report.totals.masterOwnerMismatches > 0) {
  report.ok = false;
  report.issues.push("master_owner_mismatch");
}
if (report.totals.missingCanonicalLinks > 0) {
  report.ok = false;
  report.issues.push("missing_canonical_links");
}

fs.mkdirSync(proofDir, { recursive: true });
fs.writeFileSync(path.join(proofDir, "property-prospect-link-integrity.json"), JSON.stringify(report, null, 2));

const md = [
  "# Property–Prospect Link Bridge Integrity",
  "",
  `Generated: ${report.generatedAt}`,
  `Status: **${report.ok ? "PASS" : "FAIL"}**`,
  "",
  `- Total prospects: ${report.totals.totalProspects}`,
  `- Prospects with linked properties: ${report.totals.prospectsWithLinkedProperties}`,
  `- JSON relationship entries: ${report.totals.jsonRelationshipEntries}`,
  `- Bridge relationships: ${report.totals.bridgeRelationships}`,
  `- Duplicate pairs: ${report.totals.duplicatePairs}`,
  `- Malformed (rebuild): ${report.rebuild?.malformed ?? "n/a"}`,
  `- Orphan property refs: ${report.totals.orphanPropertyRefs}`,
  `- Missing canonical links: ${report.totals.missingCanonicalLinks}`,
  `- Master owner mismatches: ${report.totals.masterOwnerMismatches}`,
  `- Duration: ${report.totals.durationMs}ms`,
].join("\n");
fs.writeFileSync(path.join(proofDir, "property-prospect-link-integrity.md"), md);

console.log(`[link-integrity] ok=${report.ok} bridge=${report.totals.bridgeRelationships}`);
process.exit(report.ok ? 0 : 1);