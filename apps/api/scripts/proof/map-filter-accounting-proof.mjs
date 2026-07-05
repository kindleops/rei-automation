#!/usr/bin/env node
/**
 * Live Supabase accounting proof for Advanced Map Filters counts.
 * Compares canonical compiler counts against direct SQL baselines.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

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

const OFFLINE_MODE = process.argv.includes("--offline");

const { hasDatabaseUrl (queryWithTimeout } = await import("../../src/lib/postgres/client.js");
const { compileMapFilter } = await import("../../src/lib/domain/map-filters/map-filter-compiler.js");
const { countMapFilterEntities } = await import("../../src/lib/domain/map-filters/map-filter-count-service.js");
const { getMapFilterPresets } = await import("../../src/lib/domain/map-filters/map-filter-presets.js");
const { TABLE_ROW_BASELINES } = await import("../../src/lib/domain/map-filters/active-field-registry-source.js");

async function baselinePropertyCount() {
  const result = await queryWithTimeout(
    `SELECT COUNT(DISTINCT property_id)::bigint AS count
     FROM properties
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
    [],
    30_000,
  );
  return Number(result.rows[0]?.count || 0);
}

async function runCase(label, expression) {
  const compiled = compileMapFilter(expression);
  if (!compiled.ok) {
    return { label, ok: false, error: "compile_failed", issues: compiled.errors };
  }
  const counted = await countMapFilterEntities(compiled.compiled);
  return {
    label,
    ok: true,
    counts: counted.counts,
    timing: counted.timing,
    activeRuleCount: compiled.compiled.activeRuleCount,
  };
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    offlineMode: OFFLINE_MODE,
    databaseConnected: hasDatabaseUrl(),
    tableBaselines: TABLE_ROW_BASELINES,
    cases: [],
    ok: true,
  };

  if (!hasDatabaseUrl()) {
    if (!OFFLINE_MODE) {
      console.error("[map-filter-accounting] DATABASE_URL missing — pass --offline to skip live proof.");
      process.exit(1);
    }
    console.log("[map-filter-accounting] Offline mode — skipping live count reconciliation.");
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const emptyExpression = {
    id: "root",
    type: "group",
    combinator: "AND",
    negated: false,
    enabled: true,
    children: [],
  };

  const baseline = await baselinePropertyCount();
  const noFilter = await runCase("no_filters", emptyExpression);
  report.cases.push(noFilter, ...(
    await Promise.all(
      getMapFilterPresets()
        .filter((preset) =>
          ["multifamily_5_plus", "sms_eligible", "portfolio_5_plus", "high_equity_absentee"].includes(preset.key),
        )
        .map((preset) => runCase(`preset:${preset.key}`, preset.expression)),
    )
  ));

  report.baselineMappableProperties = baseline;
  report.noFilterMatchingProperties = noFilter.counts?.matchingProperties ?? null;

  if (noFilter.ok && Math.abs(noFilter.counts.matchingProperties - baseline) > 0) {
    report.ok = false;
    report.issues = report.issues || [];
    report.issues.push({
      kind: "no_filter_mismatch",
      baseline,
      counted: noFilter.counts.matchingProperties,
    });
  }

  for (const entry of report.cases) {
    if (!entry.ok) report.ok = false;
  }

  const outPath = path.join(repoRoot, "proof/map-filter-accounting-proof.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(
    `[map-filter-accounting] cases=${report.cases.length} baseline=${baseline} ok=${report.ok}`,
  );
  console.log(`[map-filter-accounting] wrote ${outPath}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("[map-filter-accounting] failed:", error);
  process.exit(1);
});