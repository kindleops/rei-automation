#!/usr/bin/env node
/**
 * Live Supabase population audit for Advanced Map Filters registry.
 * Fails closed when credentials are unavailable unless --offline is passed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const args = new Set(process.argv.slice(2));
const offline = args.has("--offline");

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
  ...loadEnvFile(path.join(repoRoot, ".env.local")),
  ...loadEnvFile(path.join(repoRoot, ".env")),
  ...process.env,
};

const SUPABASE_URL = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "";
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";

const {
  RAW_MAP_FILTER_FIELD_DEFINITIONS,
  TABLE_ROW_BASELINES,
  EXCLUDED_EMPTY_FIELDS,
  EXCLUDED_SENSITIVE_FIELDS,
  FIELD_ALIASES,
  computeCoveragePercent,
} = await import("../../src/lib/domain/map-filters/active-field-registry-source.js");
const { assertRegistryIntegrity } = await import("../../src/lib/domain/map-filters/active-field-registry.js");

const PROOF_DIR = path.join(repoRoot, "proof/map-filters");

async function countPopulated(supabase, table, column, dataType) {
  if (!column) return TABLE_ROW_BASELINES[table] || 0;

  if (dataType === "json_text_array" || dataType === "json_object_array") {
    const { count, error } = await supabase
      .from(table)
      .select(column, { count: "exact", head: true })
      .not(column, "is", null)
      .neq(column, "[]");
    if (error) throw new Error(`${table}.${column}: ${error.message}`);
    return count ?? 0;
  }

  if (dataType === "boolean") {
    const { count, error } = await supabase
      .from(table)
      .select(column, { count: "exact", head: true })
      .not(column, "is", null);
    if (error) throw new Error(`${table}.${column}: ${error.message}`);
    return count ?? 0;
  }

  const { count, error } = await supabase
    .from(table)
    .select(column, { count: "exact", head: true })
    .not(column, "is", null)
    .neq(column, "");
  if (error) throw new Error(`${table}.${column}: ${error.message}`);
  return count ?? 0;
}

async function countPopulatedWithRetry(supabase, def, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await countPopulated(supabase, def.table, def.column, def.dataType);
    } catch (error) {
      lastError = error;
      console.error(`[map-filter-audit] field=${def.key} attempt=${attempt + 1} error=${error.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

function writeArtifacts(report) {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  const jsonPath = path.join(PROOF_DIR, "field-audit.json");
  const mdPath = path.join(PROOF_DIR, "field-audit.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const lines = [
    "# Map Filter Field Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `Registry fields: ${report.registryFieldCount}`,
    `Integrity errors: ${report.integrityErrors.length}`,
    `Drift items: ${report.drift.length}`,
    `OK: ${report.ok}`,
    "",
  ];
  if (report.drift.length) {
    lines.push("## Drift", "");
    for (const item of report.drift) {
      lines.push(`- ${item.kind}: ${JSON.stringify(item)}`);
    }
    lines.push("");
  }
  fs.writeFileSync(mdPath, lines.join("\n"));
  console.log(`[map-filter-audit] wrote ${jsonPath}`);
  console.log(`[map-filter-audit] wrote ${mdPath}`);
}

async function main() {
  const integrityErrors = assertRegistryIntegrity();
  const report = {
    generatedAt: new Date().toISOString(),
    mode: offline ? "offline" : "live",
    supabaseConnected: false,
    tableBaselines: TABLE_ROW_BASELINES,
    registryFieldCount: RAW_MAP_FILTER_FIELD_DEFINITIONS.length,
    integrityErrors,
    audited: [],
    drift: [],
    excludedEmptyFields: EXCLUDED_EMPTY_FIELDS,
    excludedSensitiveFields: EXCLUDED_SENSITIVE_FIELDS,
    aliases: FIELD_ALIASES,
    ok: integrityErrors.length === 0,
  };

  if (!SUPABASE_URL || !SERVICE_KEY) {
    if (offline) {
      report.note = "offline_mode_without_credentials";
      writeArtifacts(report);
      console.log(`[map-filter-audit] offline mode fields=${report.registryFieldCount} ok=${report.ok}`);
      process.exit(report.ok ? 0 : 1);
    }
    console.error("[map-filter-audit] Supabase credentials unavailable — failing closed (use --offline for static audit).");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  report.supabaseConnected = true;

  for (const table of Object.keys(TABLE_ROW_BASELINES)) {
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
    if (error) throw error;
    const liveTotal = count ?? 0;
    const baseline = TABLE_ROW_BASELINES[table];
    if (liveTotal !== baseline) {
      report.drift.push({ table, baseline, liveTotal, kind: "table_total" });
    }
  }

  for (const def of RAW_MAP_FILTER_FIELD_DEFINITIONS) {
    if (!def.column || def.entity === "geo" || def.dataType === "derived_presence") {
      report.audited.push({
        key: def.key,
        skipped: true,
        reason: def.entity === "geo" ? "geo_virtual" : def.dataType === "derived_presence" ? "derived_presence" : "no_column",
        baselinePopulated: def.populatedRows,
      });
      continue;
    }

    let livePopulated;
    try {
      livePopulated = await countPopulatedWithRetry(supabase, def);
    } catch (error) {
      report.ok = false;
      report.audited.push({
        key: def.key,
        table: def.table,
        column: def.column,
        issue: "query_failed",
        error: error.message,
      });
      continue;
    }

    const baselinePopulated = def.populatedRows;
    const entry = {
      key: def.key,
      table: def.table,
      column: def.column,
      baselinePopulated,
      livePopulated,
      baselineCoverage: def.coveragePercent,
      liveCoverage: computeCoveragePercent(livePopulated, TABLE_ROW_BASELINES[def.table]),
    };

    if (livePopulated <= 0) {
      report.ok = false;
      entry.issue = "live_empty";
    } else if (Math.abs(livePopulated - baselinePopulated) > Math.max(50, baselinePopulated * 0.01)) {
      report.drift.push({ ...entry, kind: "field_population" });
    }

    report.audited.push(entry);
  }

  writeArtifacts(report);
  console.log(`[map-filter-audit] fields=${report.registryFieldCount} drift=${report.drift.length} ok=${report.ok}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("[map-filter-audit] failed:", error);
  process.exit(1);
});