#!/usr/bin/env node
/**
 * Verified launch filter pipeline proof.
 * For each allowlisted case: build expression → compile → preview count → token digest.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(apiRoot, "../..");

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

const OFFLINE_MODE = process.argv.includes("--offline");

function rule(id, fieldKey, operator, value, extra = {}) {
  return { id, type: "rule", fieldKey, operator, value, enabled: true, ...extra };
}

function group(id, combinator, children, extra = {}) {
  return { id, type: "group", combinator, negated: false, enabled: true, children, ...extra };
}

const VERIFIED_CASES = [
  {
    id: "no_filter",
    label: "No filter",
    expression: group("case-no-filter", "AND", []),
  },
  {
    id: "property_type_mf5",
    label: "Property Type = Multifamily 5+",
    expression: group("case-mf5", "AND", [
      rule("case-mf5-rule", "property.property_type", "equals", "Multifamily 5+"),
    ]),
  },
  {
    id: "property_type_mf24",
    label: "Property Type = Multifamily 2-4",
    expression: group("case-mf24", "AND", [
      rule("case-mf24-rule", "property.property_type", "equals", "Multifamily 2-4"),
    ]),
  },
  {
    id: "equity_percent_gte_50",
    label: "Equity Percentage >= 50",
    expression: group("case-equity", "AND", [
      rule("case-equity-rule", "property.equity_percent", "greater_than_or_equal", 50),
    ]),
  },
  {
    id: "units_count_gte_5",
    label: "Units Count >= 5",
    expression: group("case-units", "AND", [
      rule("case-units-rule", "property.units_count", "greater_than_or_equal", 5),
    ]),
  },
  {
    id: "estimated_value_gte_250k",
    label: "Estimated Value >= 250000",
    expression: group("case-value", "AND", [
      rule("case-value-rule", "property.estimated_value", "greater_than_or_equal", 250000),
    ]),
  },
  {
    id: "prospect_sms_eligible",
    label: "Prospect SMS Eligible = true",
    expression: group("case-sms", "AND", [
      rule("case-sms-rule", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "any_linked" }),
    ]),
  },
  {
    id: "prospect_has_phone",
    label: "Prospect Has Phone = true",
    expression: group("case-prospect-phone", "AND", [
      rule("case-prospect-phone-rule", "prospect.has_phone", "has_data", true, { relationshipMatch: "any_linked" }),
    ]),
  },
  {
    id: "prospect_primary",
    label: "Prospect Primary = true",
    expression: group("case-primary", "AND", [
      rule("case-primary-rule", "prospect.is_primary_prospect", "is_true", true, { relationshipMatch: "any_linked" }),
    ]),
  },
  {
    id: "owner_property_count_gte_5",
    label: "Master Owner Property Count >= 5",
    expression: group("case-owner-count", "AND", [
      rule("case-owner-count-rule", "master_owner.property_count", "greater_than_or_equal", 5),
    ]),
  },
  {
    id: "owner_portfolio_units_gte_20",
    label: "Master Owner Portfolio Units >= 20",
    expression: group("case-portfolio-units", "AND", [
      rule("case-portfolio-units-rule", "master_owner.portfolio_total_units", "greater_than_or_equal", 20),
    ]),
  },
  {
    id: "phone_has_canonical",
    label: "Phone Has Canonical = true",
    expression: group("case-phone", "AND", [
      rule("case-phone-rule", "phone.has_canonical_phone", "has_data", true, { relationshipMatch: "any_linked" }),
    ]),
  },
];

const { hasDatabaseUrl } = await import("../../src/lib/postgres/client.js");
const { compileMapFilter } = await import("../../src/lib/domain/map-filters/map-filter-compiler.js");
const { countMapFilterEntities } = await import("../../src/lib/domain/map-filters/map-filter-count-service.js");
const { buildFilterTokenDigest, exposeFilterTokenDigest } = await import("../../src/lib/domain/map-filters/filter-scope.js");
const { MAP_FILTER_SCHEMA_VERSION, MAP_FILTER_REGISTRY_VERSION } = await import("../../src/lib/domain/map-filters/versions.js");
const { getMapFilterPresets, isVerifiedQuickPreset } = await import("../../src/lib/domain/map-filters/map-filter-presets.js");
const { VERIFIED_LAUNCH_FILTER_DEFINITIONS, VERIFIED_QUICK_PRESET_KEYS } = await import("../../src/lib/domain/map-filters/operator-filter-catalog.js");

async function runCase(testCase) {
  const started = Date.now();
  const compiled = compileMapFilter(testCase.expression);
  if (!compiled.ok) {
    return {
      ...testCase,
      ok: false,
      compile: "fail",
      preview: "skip",
      token: "skip",
      error: "compile_failed",
      issues: compiled.errors,
      durationMs: Date.now() - started,
    };
  }

  const tokenDigest = buildFilterTokenDigest({
    organizationId: "proof-org",
    permissionScope: "ops_dashboard_authenticated",
    filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
    registryVersion: MAP_FILTER_REGISTRY_VERSION,
    normalizedExpression: compiled.compiled.normalizedExpression,
  });
  const tokenExposed = exposeFilterTokenDigest(tokenDigest);

  if (!hasDatabaseUrl()) {
    return {
      ...testCase,
      ok: true,
      compile: "pass",
      preview: OFFLINE_MODE ? "skip_offline" : "skip_no_db",
      token: "pass",
      filterToken: tokenExposed,
      activeRuleCount: compiled.compiled.activeRuleCount,
      durationMs: Date.now() - started,
    };
  }

  try {
    const counted = await countMapFilterEntities(compiled.compiled);
    const matchingProperties = Number(counted.counts.matchingProperties);
    if (!Number.isFinite(matchingProperties)) {
      return {
        ...testCase,
        ok: false,
        compile: "pass",
        preview: "fail",
        token: "pass",
        filterToken: tokenExposed,
        error: "invalid_matching_properties",
        durationMs: Date.now() - started,
      };
    }

    return {
      ...testCase,
      ok: true,
      compile: "pass",
      preview: "pass",
      token: "pass",
      filterToken: tokenExposed,
      matchingProperties,
      counts: counted.counts,
      timing: counted.timing,
      activeRuleCount: compiled.compiled.activeRuleCount,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...testCase,
      ok: false,
      compile: "pass",
      preview: "fail",
      token: "pass",
      filterToken: tokenExposed,
      error: error?.code || error?.message || "count_query_failed",
      phase: error?.phase || null,
      durationMs: Date.now() - started,
    };
  }
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    offlineMode: OFFLINE_MODE,
    databaseConnected: hasDatabaseUrl(),
    verifiedFieldCount: VERIFIED_LAUNCH_FILTER_DEFINITIONS.length,
    verifiedQuickPresetKeys: VERIFIED_QUICK_PRESET_KEYS,
    cases: [],
    quickPresets: [],
    ok: true,
  };

  report.cases = await Promise.all(VERIFIED_CASES.map((testCase) => runCase(testCase)));

  const presetResults = await Promise.all(
    getMapFilterPresets().map(async (preset) => {
      const result = await runCase({
        id: `preset:${preset.key}`,
        label: `Quick preset: ${preset.label}`,
        expression: preset.expression,
      });
      return {
        key: preset.key,
        verified: isVerifiedQuickPreset(preset.key),
        ...result,
      };
    }),
  );
  report.quickPresets = presetResults;

  for (const entry of [...report.cases, ...report.quickPresets]) {
    if (!entry.ok) report.ok = false;
  }

  const apiOut = path.join(apiRoot, "proof/map-filters/master-filters-pipeline-proof.json");
  const dashboardOut = path.join(repoRoot, "apps/dashboard/proof/master-filters/master-filters-pipeline-proof.json");
  fs.mkdirSync(path.dirname(apiOut), { recursive: true });
  fs.mkdirSync(path.dirname(dashboardOut), { recursive: true });
  fs.writeFileSync(apiOut, JSON.stringify(report, null, 2));
  fs.writeFileSync(dashboardOut, JSON.stringify(report, null, 2));

  console.log(
    `[master-filters-pipeline] cases=${report.cases.length} presets=${report.quickPresets.length} ok=${report.ok}`,
  );
  console.log(`[master-filters-pipeline] wrote ${apiOut}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("[master-filters-pipeline] failed:", error);
  process.exit(1);
});