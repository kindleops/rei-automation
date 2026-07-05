#!/usr/bin/env node
/**
 * Live population audit via pooler Postgres (authoritative).
 * Fails closed without credentials unless --offline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const PROOF_DIR = path.join(repoRoot, "proof/map-filters");
const args = new Set(process.argv.slice(2));
const offline = args.has("--offline");
const DEFAULT_BATCH_SIZE = 6;
const BATCH_TIMEOUT_MS = 120_000;

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
for (const [key, value] of Object.entries(env)) {
  if (value && !process.env[key]) process.env[key] = value;
}

const {
  RAW_MAP_FILTER_FIELD_DEFINITIONS,
  TABLE_ROW_BASELINES,
  EXCLUDED_EMPTY_FIELDS,
  EXCLUDED_SENSITIVE_FIELDS,
  FIELD_ALIASES,
  computeCoveragePercent,
} = await import("../../src/lib/domain/map-filters/active-field-registry-source.js");
const { assertRegistryIntegrity } = await import("../../src/lib/domain/map-filters/active-field-registry.js");

function populationExpr(table, column, dataType) {
  const col = `${table}.${column}`;
  if (dataType === "json_text_array" || dataType === "json_object_array") {
    return `COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND ${col}::text NOT IN ('[]','null'))`;
  }
  if (dataType === "boolean") {
    return `COUNT(*) FILTER (WHERE ${col} IS NOT NULL)`;
  }
  return `COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND ${col}::text <> '')`;
}

function writeArtifacts(report) {
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROOF_DIR, "field-audit.json"), JSON.stringify(report, null, 2));
  const lines = [
    "# Map Filter Field Audit (Pooler SQL)",
    "",
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `Registry fields: ${report.registryFieldCount}`,
    `Drift items: ${report.drift.length}`,
    `Failed fields: ${report.failedFields.length}`,
    `OK: ${report.ok}`,
    "",
  ];
  if (report.drift.length) {
    lines.push("## Drift", "");
    for (const item of report.drift) {
      lines.push(`- ${item.kind}: ${item.key || item.table || item.field}`);
      if (item.key === "property.master_owner_id") {
        lines.push(
          "  - Cause: registry coverage metadata overstated population at 100%; live pooler audit shows ~33.5% of properties carry a non-empty `master_owner_id`.",
          "  - Filter semantics unchanged; only published coverage metadata corrected in registry v2026-07-05.1.",
          `  - Baseline populated: ${item.baselinePopulated}, live populated: ${item.livePopulated}, difference: ${item.livePopulated - item.baselinePopulated}`,
        );
      } else {
        lines.push(`  - Detail: ${JSON.stringify(item)}`);
      }
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(PROOF_DIR, "field-audit.md"), lines.join("\n"));
}

async function auditWithPooler(queryWithTimeout) {
  const integrityErrors = assertRegistryIntegrity();
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "live-pooler",
    supabaseConnected: false,
    tableBaselines: TABLE_ROW_BASELINES,
    registryFieldCount: RAW_MAP_FILTER_FIELD_DEFINITIONS.length,
    integrityErrors,
    audited: [],
    drift: [],
    failedFields: [],
    excludedEmptyFields: EXCLUDED_EMPTY_FIELDS,
    excludedSensitiveFields: EXCLUDED_SENSITIVE_FIELDS,
    aliases: FIELD_ALIASES,
    ok: integrityErrors.length === 0,
  };

  for (const table of Object.keys(TABLE_ROW_BASELINES)) {
    const res = await queryWithTimeout(`SELECT COUNT(*)::bigint AS count FROM ${table}`, [], 60_000);
    const liveTotal = Number(res.rows[0]?.count || 0);
    if (liveTotal !== TABLE_ROW_BASELINES[table]) {
      report.drift.push({ kind: "table_total", table, baseline: TABLE_ROW_BASELINES[table], liveTotal });
    }
  }

  const columnRows = await queryWithTimeout(
    `SELECT table_name, column_name, data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('properties','prospects','master_owners')`,
    [],
    60_000,
  );
  const columnIndex = new Map(columnRows.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));

  const auditable = RAW_MAP_FILTER_FIELD_DEFINITIONS.filter(
    (def) => def.column && def.entity !== "geo" && def.dataType !== "derived_presence",
  );

  function recordFieldResult(def, livePopulated) {
    const colKey = `${def.table}.${def.column}`;
    const colMeta = columnIndex.get(colKey);
    const baselinePopulated = def.populatedRows;
    const entry = {
      key: def.key,
      table: def.table,
      column: def.column,
      baselinePopulated,
      livePopulated,
      baselineCoverage: def.coveragePercent,
      liveCoverage: computeCoveragePercent(livePopulated, TABLE_ROW_BASELINES[def.table]),
      dbType: colMeta?.data_type || null,
      jsonStorageShape: def.jsonStorageShape || null,
    };

    if (!colMeta) {
      report.ok = false;
      entry.issue = "missing_column";
      report.failedFields.push(def.key);
    } else if (livePopulated <= 0) {
      report.ok = false;
      entry.issue = "live_empty";
      report.failedFields.push(def.key);
    } else if (Math.abs(livePopulated - baselinePopulated) > Math.max(50, baselinePopulated * 0.01)) {
      report.drift.push({ kind: "field_population", ...entry });
    }
    report.audited.push(entry);
  }

  async function auditFieldBatch(batch, label) {
    const unions = batch
      .map(
        (def) =>
          `SELECT '${def.key.replace(/'/g, "''")}'::text AS key, (${populationExpr(def.table, def.column, def.dataType)})::bigint AS live_populated FROM ${def.table}`,
      )
      .join(" UNION ALL ");
    const batchStarted = Date.now();
    console.log(`[map-filter-audit] ${label} fields=${batch.map((b) => b.key).join(", ")}`);
    const res = await queryWithTimeout(unions, [], BATCH_TIMEOUT_MS);
    for (const row of res.rows) {
      const def = batch.find((d) => d.key === row.key);
      if (!def) continue;
      recordFieldResult(def, Number(row.live_populated || 0));
    }
    console.log(`[map-filter-audit] ${label} done elapsed=${Date.now() - batchStarted}ms`);
  }

  async function auditFieldsWithRetry(batch, label) {
    try {
      await auditFieldBatch(batch, label);
      return;
    } catch (error) {
      console.error(`[map-filter-audit] ${label} failed: ${error.message}`);
      if (batch.length <= 1) {
        report.ok = false;
        report.failedFields.push(batch[0].key);
        report.audited.push({ key: batch[0].key, issue: "query_failed", error: error.message });
        return;
      }
      const midpoint = Math.ceil(batch.length / 2);
      await auditFieldsWithRetry(batch.slice(0, midpoint), `${label}a`);
      await auditFieldsWithRetry(batch.slice(midpoint), `${label}b`);
    }
  }

  let batchNumber = 0;
  for (let i = 0; i < auditable.length; i += DEFAULT_BATCH_SIZE) {
    batchNumber += 1;
    const batch = auditable.slice(i, i + DEFAULT_BATCH_SIZE);
    await auditFieldsWithRetry(batch, `batch ${batchNumber}`);
    writeArtifacts(report);
  }

  for (const def of RAW_MAP_FILTER_FIELD_DEFINITIONS) {
    if (def.column && def.entity !== "geo" && def.dataType !== "derived_presence") continue;
    report.audited.push({
      key: def.key,
      skipped: true,
      reason: def.entity === "geo" ? "geo_virtual" : def.dataType === "derived_presence" ? "derived_presence" : "no_column",
      baselinePopulated: def.populatedRows,
    });
  }

  writeArtifacts(report);
  return report;
}

async function main() {
  const integrityErrors = assertRegistryIntegrity();
  if (offline) {
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "offline",
      registryFieldCount: RAW_MAP_FILTER_FIELD_DEFINITIONS.length,
      integrityErrors,
      ok: integrityErrors.length === 0,
    };
    writeArtifacts(report);
    process.exit(report.ok ? 0 : 1);
  }

  const { hasDatabaseUrl, queryWithTimeout } = await import("../../src/lib/postgres/client.js");
  if (!hasDatabaseUrl()) {
    console.error("[map-filter-audit] Pooler credentials unavailable — failing closed (use --offline).");
    process.exit(1);
  }

  const report = await auditWithPooler(queryWithTimeout);
  console.log(`[map-filter-audit] fields=${report.registryFieldCount} failed=${report.failedFields.length} drift=${report.drift.length} ok=${report.ok}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("[map-filter-audit] failed:", error);
  process.exit(1);
});