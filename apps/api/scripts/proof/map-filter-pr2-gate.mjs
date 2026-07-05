#!/usr/bin/env node
/**
 * PR2 final verification gate — live Supabase/Postgres proof.
 *
 * Usage:
 *   node --env-file=.env.local --import ./tests/register-aliases.mjs scripts/proof/map-filter-pr2-gate.mjs
 */
import "../../tests/register-aliases.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { createClient } from "@supabase/supabase-js";

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

const SUPABASE_URL = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "";
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPS_SECRET = env.OPS_DASHBOARD_SECRET || "test";

const { hasDatabaseUrl, queryWithTimeout } = await import("../../src/lib/postgres/client.js");
const { compileMapFilter } = await import("../../src/lib/domain/map-filters/map-filter-compiler.js");
const { countMapFilterEntities } = await import("../../src/lib/domain/map-filters/map-filter-count-service.js");
const {
  buildPropertyCountSql,
  buildPropertyEligibilitySql,
  buildProspectCountSql,
  buildOwnerCountSql,
} = await import("../../src/lib/domain/map-filters/map-filter-predicate-sql.js");
const { MAP_FILTER_LIMITS } = await import("../../src/lib/domain/map-filters/map-filter-limits.js");
const {
  buildFilterTokenDigest,
  exposeFilterTokenDigest,
  resolveMapFilterAuthScope,
} = await import("../../src/lib/domain/map-filters/filter-scope.js");
const {
  upsertMapFilterToken,
  loadMapFilterToken,
} = await import("../../src/lib/domain/map-filters/map-filter-token-store.js");
const { MAP_FILTER_SCHEMA_VERSION, MAP_FILTER_REGISTRY_VERSION } = await import(
  "../../src/lib/domain/map-filters/versions.js"
);
const {
  RAW_MAP_FILTER_FIELD_DEFINITIONS,
  TABLE_ROW_BASELINES,
  EXCLUDED_EMPTY_FIELDS,
  EXCLUDED_SENSITIVE_FIELDS,
  computeCoveragePercent,
} = await import("../../src/lib/domain/map-filters/active-field-registry-source.js");
const { MAP_FILTER_ACCOUNTING_CASES, QUERY_PLAN_CASES, EMPTY_EXPRESSION } = await import(
  "./map-filter-reference-cases.js"
);
const { POST: previewRoute } = await import(
  "../../src/app/api/internal/dashboard/ops/map/filters/preview/route.js"
);
const { POST: tokenRoute } = await import(
  "../../src/app/api/internal/dashboard/ops/map/filters/token/route.js"
);
const { buildOpsDashboardSessionToken } = await import("../../src/lib/security/dashboard-auth.js");

const args = process.argv.slice(2);
const suiteArg = args.find((a) => a.startsWith("--suite="))?.split("=")[1] || args[args.indexOf("--suite") + 1] || "all";
const caseArg = args.find((a) => a.startsWith("--case="))?.split("=")[1] || null;

const SUITE_CASE_IDS = {
  "simple-property-accounting": [
    "no_filter", "sfr", "multifamily_2_4", "multifamily_5_plus", "commercial", "storage_units",
    "equity_50_plus", "tax_delinquent", "active_lien", "out_of_state_owner",
  ],
  "prospect-accounting": ["prospect_sms_eligible", "prospect_primary"],
  "owner-accounting": ["owner_tier_1", "owner_property_count_5", "owner_portfolio_units_20"],
  "mixed-expression-accounting": ["property_prospect_mixed", "property_owner_mixed", "nested_mixed_or", "negated_relationship"],
  "relationship-semantics": ["rel_any_linked", "rel_primary_only", "rel_none_linked", "rel_all_linked"],
};

const report = {
  generatedAt: new Date().toISOString(),
  gate: "PR2",
  suite: suiteArg,
  ok: true,
  sections: {},
};

function fail(section, message, extra = {}) {
  report.ok = false;
  report.sections[section] = report.sections[section] || { ok: false, issues: [] };
  report.sections[section].ok = false;
  report.sections[section].issues.push({ message, ...extra });
}

function pass(section, data = {}) {
  report.sections[section] = { ok: true, ...data };
}

function writeArtifacts() {
  fs.mkdirSync(proofDir, { recursive: true });
  fs.writeFileSync(path.join(proofDir, "map-filter-pr2-gate.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(proofDir, "map-filter-pr2-gate.md"), renderMarkdown(report));
}

function renderMarkdown(r) {
  const lines = [
    "# PR2 Verification Gate Report",
    "",
    `Generated: ${r.generatedAt}`,
    `Overall: **${r.ok ? "PASS" : "FAIL"}**`,
    "",
  ];
  for (const [name, section] of Object.entries(r.sections || {})) {
    lines.push(`## ${name}`, "", `Status: **${section.ok ? "PASS" : "FAIL"}**`, "");
    if (section.summary) lines.push(section.summary, "");
    if (section.issues?.length) {
      lines.push("Issues:");
      for (const issue of section.issues) lines.push(`- ${issue.message || JSON.stringify(issue)}`);
      lines.push("");
    }
    if (section.cases?.length) {
      lines.push("| Case | Property Δ | Prospect Δ | Owner Δ | Duration | Pass |");
      lines.push("|------|------------|------------|---------|----------|------|");
      for (const c of section.cases) {
        lines.push(
          `| ${c.label || c.id} | ${c.propertyDiff} | ${c.prospectDiff} | ${c.ownerDiff} | ${c.durationMs}ms | ${c.pass ? "✓" : "✗"} |`,
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function runDirectCounts(compiled) {
  const { sql: predicateSql, params } = buildPropertyEligibilitySql(
    compiled.compiledPredicateAst,
    compiled.params || [],
  );
  const propertyQuery = buildPropertyCountSql(predicateSql);
  const allParams = [...params, ...propertyQuery.extraParams];
  const started = Date.now();
  const [propertyRes, prospectRes, ownerRes] = await Promise.all([
    queryWithTimeout(propertyQuery.sql, allParams, MAP_FILTER_LIMITS.countQueryTimeoutMs),
    queryWithTimeout(buildProspectCountSql(predicateSql).sql, params, MAP_FILTER_LIMITS.countQueryTimeoutMs),
    queryWithTimeout(buildOwnerCountSql(predicateSql), params, MAP_FILTER_LIMITS.countQueryTimeoutMs),
  ]);
  return {
    matchingProperties: Number(propertyRes.rows[0]?.count || 0),
    matchingProspects: Number(prospectRes.rows[0]?.count || 0),
    matchingMasterOwners: Number(ownerRes.rows[0]?.count || 0),
    durationMs: Date.now() - started,
  };
}

async function runCompilerCounts(compiled) {
  const started = Date.now();
  const result = await countMapFilterEntities(compiled);
  return {
    matchingProperties: result.counts.matchingProperties,
    matchingProspects: result.counts.matchingProspects,
    matchingMasterOwners: result.counts.matchingMasterOwners,
    durationMs: Date.now() - started,
  };
}

async function countPopulated(supabase, table, column, dataType) {
  if (!column) return 0;
  if (dataType === "json_text_array" || dataType === "json_object_array") {
    const { count, error } = await supabase
      .from(table)
      .select(column, { count: "exact", head: true })
      .not(column, "is", null)
      .neq(column, "[]");
    if (error) throw error;
    return count ?? 0;
  }
  if (dataType === "boolean") {
    const { count, error } = await supabase
      .from(table)
      .select(column, { count: "exact", head: true })
      .not(column, "is", null);
    if (error) throw error;
    return count ?? 0;
  }
  const { count, error } = await supabase
    .from(table)
    .select(column, { count: "exact", head: true })
    .not(column, "is", null)
    .neq(column, "");
  if (error) throw error;
  return count ?? 0;
}

async function runFieldAudit() {
  const section = { ok: true, issues: [], tableTotals: {}, audited: [], drift: [], excludedEmpty: [] };
  if (!SUPABASE_URL || !SERVICE_KEY) {
    fail("fieldAudit", "Supabase credentials missing for live audit");
    return;
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const table of Object.keys(TABLE_ROW_BASELINES)) {
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
    if (error) throw error;
    const liveTotal = count ?? 0;
    section.tableTotals[table] = { baseline: TABLE_ROW_BASELINES[table], live: liveTotal };
    if (liveTotal <= 0) {
      section.ok = false;
      section.issues.push({ message: `table_empty:${table}` });
    }
  }

  const columnRows = await queryWithTimeout(
    `SELECT table_name, column_name, data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('properties','prospects','master_owners')`,
    [],
    30_000,
  );
  const columnIndex = new Map(
    columnRows.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
  );

  for (const def of RAW_MAP_FILTER_FIELD_DEFINITIONS) {
    if (!def.column || def.entity === "geo" || def.dataType === "derived_presence") {
      section.audited.push({ key: def.key, skipped: true, reason: def.entity === "geo" ? "geo" : "derived_presence" });
      continue;
    }
    const colKey = `${def.table}.${def.column}`;
    const colMeta = columnIndex.get(colKey);
    if (!colMeta) {
      section.ok = false;
      section.issues.push({ message: `missing_column:${colKey}` });
      continue;
    }

    const livePopulated = await countPopulated(supabase, def.table, def.column, def.dataType);
    const entry = {
      key: def.key,
      column: colKey,
      dataType: def.dataType,
      jsonStorageShape: def.jsonStorageShape || null,
      dbType: colMeta.data_type,
      dbUdt: colMeta.udt_name,
      livePopulated,
      liveCoverage: computeCoveragePercent(livePopulated, section.tableTotals[def.table]?.live || TABLE_ROW_BASELINES[def.table]),
    };
    if (livePopulated <= 0) {
      section.ok = false;
      entry.issue = "live_empty";
      section.issues.push({ message: `live_empty:${def.key}` });
    }
    if (def.dataType === "json_text_array" && !["json", "jsonb", "ARRAY"].includes(colMeta.data_type) && colMeta.udt_name !== "jsonb") {
      section.issues.push({ message: `json_type_mismatch:${def.key}`, dbType: colMeta.data_type });
    }
    section.audited.push(entry);
  }

  for (const excluded of EXCLUDED_EMPTY_FIELDS) {
    const [table, column] = excluded.split(".");
    const livePopulated = await countPopulated(supabase, table, column, "text");
    section.excludedEmpty.push({ field: excluded, livePopulated });
    if (livePopulated > 0) {
      section.drift.push({ kind: "excluded_now_populated", field: excluded, livePopulated });
    }
  }

  const md = [
    "# Map Filter Field Audit (Live)",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Table Totals",
    "",
    "| Table | Live | Baseline |",
    "|-------|------|----------|",
    ...Object.entries(section.tableTotals).map(([t, v]) => `| ${t} | ${v.live} | ${v.baseline} |`),
    "",
    `Active fields audited: ${section.audited.filter((a) => !a.skipped).length}`,
    `Drift entries: ${section.drift.length}`,
    `Status: **${section.ok ? "PASS" : "FAIL"}**`,
  ].join("\n");

  fs.mkdirSync(proofDir, { recursive: true });
  fs.writeFileSync(path.join(proofDir, "field-audit.json"), JSON.stringify(section, null, 2));
  fs.writeFileSync(path.join(proofDir, "field-audit.md"), md);

  if (section.ok) pass("fieldAudit", section);
  else {
    report.sections.fieldAudit = section;
    report.ok = false;
  }
}

async function runAccountingProof({ suiteName = "accountingProof", artifactName = "map-filter-accounting-proof.json", caseIds = null } = {}) {
  const section = { ok: true, cases: [], issues: [], suite: suiteName };
  const cases = caseIds
    ? MAP_FILTER_ACCOUNTING_CASES.filter((c) => caseIds.includes(c.id))
    : MAP_FILTER_ACCOUNTING_CASES;
  const { count: exactProperties } = await queryWithTimeout(
    `SELECT COUNT(*)::bigint AS count FROM properties`,
    [],
    30_000,
  ).then((r) => ({ count: Number(r.rows[0]?.count || 0) }));

  const { count: mappableProperties } = await queryWithTimeout(
    `SELECT COUNT(DISTINCT property_id)::bigint AS count FROM properties
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
    [],
    30_000,
  ).then((r) => ({ count: Number(r.rows[0]?.count || 0) }));

  section.exactPropertyCount = exactProperties;
  section.mappablePropertyCount = mappableProperties;

  for (const testCase of cases) {
    if (caseArg && testCase.id !== caseArg) continue;
    const caseStarted = Date.now();
    console.log(`[pr2-gate] accounting case start: ${testCase.id}`);
    const compiledResult = compileMapFilter(testCase.expression);
    if (!compiledResult.ok) {
      section.ok = false;
      section.cases.push({ id: testCase.id, label: testCase.label, pass: false, error: compiledResult.errors });
      continue;
    }

    const [direct, compiler] = await Promise.all([
      runDirectCounts(compiledResult.compiled),
      runCompilerCounts(compiledResult.compiled),
    ]);

    const propertyDiff = direct.matchingProperties - compiler.matchingProperties;
    const prospectDiff = direct.matchingProspects - compiler.matchingProspects;
    const ownerDiff = direct.matchingMasterOwners - compiler.matchingMasterOwners;
    const passCase = propertyDiff === 0 && prospectDiff === 0 && ownerDiff === 0;

    if (!passCase) section.ok = false;

    const durationMs = Date.now() - caseStarted;
    console.log(`[pr2-gate] accounting case done: ${testCase.id} pass=${passCase} elapsed=${durationMs}ms`);
    section.cases.push({
      id: testCase.id,
      label: testCase.label,
      direct,
      compiler,
      propertyDiff,
      prospectDiff,
      ownerDiff,
      durationMs,
      pass: passCase,
    });
    fs.writeFileSync(path.join(proofDir, artifactName), JSON.stringify(section, null, 2));
  }

  const noFilter = section.cases.find((c) => c.id === "no_filter");
  if (!noFilter?.pass || noFilter.compiler.matchingProperties !== mappableProperties) {
    section.ok = false;
    section.issues.push({
      message: "no_filter_mismatch",
      expected: mappableProperties,
      compiler: noFilter?.compiler?.matchingProperties,
      direct: noFilter?.direct?.matchingProperties,
    });
  }

  fs.writeFileSync(path.join(proofDir, artifactName), JSON.stringify(section, null, 2));
  if (section.ok) pass(suiteName, section);
  else {
    report.sections[suiteName] = section;
    report.ok = false;
  }
}

async function runTokenSecurityProof() {
  const section = { ok: true, checks: [], issues: [] };

  const meta = await queryWithTimeout(
    `SELECT c.relname, c.relrowsecurity,
            (SELECT COUNT(*) FROM pg_policies p WHERE p.tablename = 'map_filter_tokens') AS policy_count
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'map_filter_tokens'`,
    [],
    30_000,
  );
  const indexes = await queryWithTimeout(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='map_filter_tokens'`,
    [],
    30_000,
  );
  const constraints = await queryWithTimeout(
    `SELECT conname, contype FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname='public' AND rel.relname='map_filter_tokens'`,
    [],
    30_000,
  );

  section.table = {
    name: "public.map_filter_tokens",
    rlsEnabled: Boolean(meta.rows[0]?.relrowsecurity),
    policyCount: Number(meta.rows[0]?.policy_count || 0),
    indexes: indexes.rows,
    constraints: constraints.rows,
    storesFullDigest: true,
    storesExposedToken: true,
    revocationModel: "DELETE row (service_role); no client SELECT policy",
    expiryColumn: "expires_at",
  };

  const expression = {
    id: "root",
    type: "group",
    combinator: "AND",
    negated: false,
    enabled: true,
    children: [
      {
        id: "gate-rule",
        type: "rule",
        fieldKey: "property.property_type",
        operator: "equals",
        value: "SFR",
        enabled: true,
      },
    ],
  };

  const compiled = compileMapFilter(expression);
  const scopeA = {
    organizationId: "pr2-gate-org-a",
    createdBy: "pr2-gate",
    permissionScope: "ops_dashboard_authenticated",
    filterSchemaVersion: MAP_FILTER_SCHEMA_VERSION,
    registryVersion: MAP_FILTER_REGISTRY_VERSION,
  };
  const scopeB = { ...scopeA, organizationId: "pr2-gate-org-b" };
  const scopeGuest = { ...scopeA, permissionScope: "ops_dashboard_unauthenticated" };

  const tokenA1 = await upsertMapFilterToken({ authScope: scopeA, compiled: compiled.compiled, ttlHours: 24 });
  const tokenA2 = await upsertMapFilterToken({ authScope: scopeA, compiled: compiled.compiled, ttlHours: 24 });
  const tokenB1 = await upsertMapFilterToken({ authScope: scopeB, compiled: compiled.compiled, ttlHours: 24 });
  const tokenGuest = await upsertMapFilterToken({ authScope: scopeGuest, compiled: compiled.compiled, ttlHours: 24 });

  const check = (name, ok, detail = {}) => {
    section.checks.push({ name, ok, ...detail });
    if (!ok) {
      section.ok = false;
      section.issues.push({ message: name, ...detail });
    }
  };

  check("same_expression_same_scope_reuses_digest", tokenA1.filterTokenDigest === tokenA2.filterTokenDigest, {
    digestA: tokenA1.filterTokenDigest,
    digestB: tokenA2.filterTokenDigest,
  });
  check("different_org_different_token", tokenA1.filterToken !== tokenB1.filterToken);
  check("different_permission_scope_different_token", tokenA1.filterToken !== tokenGuest.filterToken);
  check("exposed_token_is_128_bit", tokenA1.filterToken.length === 32);
  check("full_digest_is_256_bit", tokenA1.filterTokenDigest.length === 64);

  const expired = await upsertMapFilterToken({
    authScope: scopeA,
    compiled: compiled.compiled,
    ttlHours: -1,
  });
  const expiredLoad = await loadMapFilterToken(expired.filterToken, scopeA);
  check("expired_token_fails", !expiredLoad.ok && expiredLoad.error === "token_expired");

  await queryWithTimeout(`DELETE FROM map_filter_tokens WHERE filter_token_digest = $1`, [tokenA1.filterTokenDigest]);
  const revokedLoad = await loadMapFilterToken(tokenA1.filterToken, scopeA);
  check("revoked_token_fails", !revokedLoad.ok && revokedLoad.error === "token_not_found");

  const crossOrgLoad = await loadMapFilterToken(tokenB1.filterToken, scopeA);
  check("cross_organization_access_fails", !crossOrgLoad.ok && crossOrgLoad.error === "token_scope_denied");

  const staleRegistryLoad = await loadMapFilterToken(tokenGuest.filterToken, {
    ...scopeGuest,
    registryVersion: "2099-01-01.0",
  });
  check("unsupported_registry_version_fails", !staleRegistryLoad.ok && staleRegistryLoad.error === "token_scope_denied");

  const staleSchemaLoad = await loadMapFilterToken(tokenGuest.filterToken, {
    ...scopeGuest,
    filterSchemaVersion: 999,
  });
  check("unsupported_schema_version_fails", !staleSchemaLoad.ok && staleSchemaLoad.error === "token_scope_denied");

  // cleanup remaining gate tokens
  await queryWithTimeout(
    `DELETE FROM map_filter_tokens WHERE organization_id LIKE 'pr2-gate-%'`,
    [],
    30_000,
  );

  fs.writeFileSync(path.join(proofDir, "token-security.json"), JSON.stringify(section, null, 2));

  if (section.ok) pass("tokenSecurity", section);
  else {
    report.sections.tokenSecurity = section;
    report.ok = false;
  }
}

function buildAuthRequest(body, { secret = OPS_SECRET, orgId = "default", cookie = true } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret) headers.set("x-ops-dashboard-secret", secret);
  if (orgId) headers.set("x-ops-organization-id", orgId);
  if (cookie) {
    const token = buildOpsDashboardSessionToken(secret);
    if (token) headers.set("cookie", `ops_dashboard_session=${token}`);
  }
  return new Request("http://localhost/api/internal/dashboard/ops/map/filters/preview", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function responseHasLeak(payload) {
  const text = JSON.stringify(payload);
  const leaks = [];
  if (/\bSELECT\b/i.test(text)) leaks.push("sql_select");
  if (/\bFROM\s+properties\b/i.test(text)) leaks.push("table_name");
  if (/compiledPredicateAst/i.test(text)) leaks.push("compiled_ast");
  if (/filter_token_digest/i.test(text) && text.includes("filterTokenDigest")) {
    // full digest in token route is expected server-side only — preview must not expose
  }
  if (/compiledPredicateAst/.test(text)) leaks.push("compiled_ast");
  if (/permission_scope/i.test(text)) leaks.push("permission_scope");
  return leaks;
}

async function runRouteSmoke() {
  const section = { ok: true, cases: [], issues: [] };
  const validExpr = {
    expression: {
      id: "root",
      type: "group",
      combinator: "AND",
      negated: false,
      enabled: true,
      children: [
        { id: "r1", type: "rule", fieldKey: "property.property_type", operator: "equals", value: "SFR", enabled: true },
      ],
    },
  };

  const tests = [
    { name: "preview_property", route: previewRoute, body: validExpr, expectOk: true },
    {
      name: "preview_prospect",
      route: previewRoute,
      body: {
        expression: {
          id: "root",
          type: "group",
          combinator: "AND",
          negated: false,
          enabled: true,
          children: [
            { id: "r1", type: "rule", fieldKey: "prospect.sms_eligible", operator: "is_true", value: true, enabled: true },
          ],
        },
      },
      expectOk: true,
    },
    {
      name: "preview_owner",
      route: previewRoute,
      body: {
        expression: {
          id: "root",
          type: "group",
          combinator: "AND",
          negated: false,
          enabled: true,
          children: [
            { id: "r1", type: "rule", fieldKey: "master_owner.property_count", operator: "greater_than_or_equal", value: 5, enabled: true },
          ],
        },
      },
      expectOk: true,
    },
    {
      name: "preview_nested_mixed",
      route: previewRoute,
      body: { expression: MAP_FILTER_ACCOUNTING_CASES.find((c) => c.id === "nested_mixed_or").expression },
      expectOk: true,
    },
    {
      name: "preview_invalid_field",
      route: previewRoute,
      body: {
        expression: {
          id: "root",
          type: "group",
          combinator: "AND",
          negated: false,
          enabled: true,
          children: [
            { id: "r1", type: "rule", fieldKey: "property.not_real", operator: "equals", value: "x", enabled: true },
          ],
        },
      },
      expectOk: false,
    },
    {
      name: "preview_invalid_operator",
      route: previewRoute,
      body: {
        expression: {
          id: "root",
          type: "group",
          combinator: "AND",
          negated: false,
          enabled: true,
          children: [
            { id: "r1", type: "rule", fieldKey: "property.property_type", operator: "between", value: [1, 2], enabled: true },
          ],
        },
      },
      expectOk: false,
    },
    { name: "token_valid", route: tokenRoute, body: validExpr, expectOk: true },
    { name: "unauthenticated", route: previewRoute, body: validExpr, expectOk: false, secret: "" , cookie: false },
  ];

  for (const t of tests) {
    const req = buildAuthRequest(t.body, { secret: t.secret ?? OPS_SECRET, cookie: t.cookie !== false });
    const res = await t.route(req);
    const json = await res.json();
    const leaks = responseHasLeak(json);
    const ok = (json.ok === t.expectOk) && leaks.length === 0 && (t.expectOk ? !json.data?.compiledPredicateAst : true);
    if (!ok) {
      section.ok = false;
      section.issues.push({ message: t.name, status: res.status, jsonOk: json.ok, leaks });
    }
    section.cases.push({ name: t.name, status: res.status, ok: json.ok, pass: ok, leaks });
  }

  fs.writeFileSync(path.join(proofDir, "route-smoke.json"), JSON.stringify(section, null, 2));

  if (section.ok) pass("routeSmoke", section);
  else {
    report.sections.routeSmoke = section;
    report.ok = false;
  }
}

async function runQueryPlanProof() {
  const section = { ok: true, cases: [], timeoutMs: MAP_FILTER_LIMITS.countQueryTimeoutMs };

  for (const testCase of QUERY_PLAN_CASES) {
    const compiledResult = compileMapFilter(testCase.expression);
    const { sql: predicateSql, params } = buildPropertyEligibilitySql(
      compiledResult.compiled.compiledPredicateAst,
      compiledResult.compiled.params,
      { bounds: testCase.bounds || null },
    );
    const propertyQuery = buildPropertyCountSql(predicateSql, testCase.bounds || null);
    const allParams = [...params, ...propertyQuery.extraParams];
    const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${propertyQuery.sql}`;
    const started = Date.now();
    const planRes = await queryWithTimeout(explainSql, allParams, MAP_FILTER_LIMITS.countQueryTimeoutMs);
    const plan = planRes.rows[0]?.["QUERY PLAN"]?.[0]?.Plan || {};
    section.cases.push({
      id: testCase.id,
      planningMs: planRes.rows[0]?.["QUERY PLAN"]?.[0]?.["Planning Time"],
      executionMs: planRes.rows[0]?.["QUERY PLAN"]?.[0]?.["Execution Time"],
      totalMs: Date.now() - started,
      nodeType: plan["Node Type"],
      rows: plan["Actual Rows"],
      sharedHitBlocks: plan["Shared Hit Blocks"],
      sharedReadBlocks: plan["Shared Read Blocks"],
      indexUsed: JSON.stringify(plan).includes("Index"),
      sequentialScan: plan["Node Type"] === "Seq Scan" || JSON.stringify(plan).includes("Seq Scan"),
    });
  }

  fs.mkdirSync(proofDir, { recursive: true });
  fs.writeFileSync(path.join(proofDir, "query-plans.json"), JSON.stringify(section, null, 2));
  const md = [
    "# Map Filter Query Plans",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "| Case | Execution ms | Planning ms | Node | Index | Seq Scan |",
    "|------|--------------|-------------|------|-------|----------|",
    ...section.cases.map(
      (c) => `| ${c.id} | ${c.executionMs} | ${c.planningMs} | ${c.nodeType} | ${c.indexUsed} | ${c.sequentialScan} |`,
    ),
  ].join("\n");
  fs.writeFileSync(path.join(proofDir, "query-plans.md"), md);
  pass("queryPlanProof", section);
}

async function runSuite(name) {
  const started = Date.now();
  console.log(`[pr2-gate] suite start: ${name}`);
  switch (name) {
    case "field-audit":
      await runFieldAudit();
      break;
    case "simple-property-accounting":
      await runAccountingProof({
        suiteName: "simplePropertyAccounting",
        artifactName: "simple-property-accounting.json",
        caseIds: SUITE_CASE_IDS["simple-property-accounting"],
      });
      break;
    case "prospect-accounting":
      await runAccountingProof({
        suiteName: "prospectAccounting",
        artifactName: "prospect-accounting.json",
        caseIds: SUITE_CASE_IDS["prospect-accounting"],
      });
      break;
    case "owner-accounting":
      await runAccountingProof({
        suiteName: "ownerAccounting",
        artifactName: "owner-accounting.json",
        caseIds: SUITE_CASE_IDS["owner-accounting"],
      });
      break;
    case "mixed-expression-accounting":
      await runAccountingProof({
        suiteName: "mixedExpressionAccounting",
        artifactName: "mixed-expression-accounting.json",
        caseIds: SUITE_CASE_IDS["mixed-expression-accounting"],
      });
      break;
    case "relationship-semantics":
      await runAccountingProof({
        suiteName: "relationshipSemantics",
        artifactName: "relationship-semantics.json",
        caseIds: SUITE_CASE_IDS["relationship-semantics"],
      });
      break;
    case "token-security":
      await runTokenSecurityProof();
      break;
    case "route-smoke":
      await runRouteSmoke();
      break;
    case "query-plans":
      await runQueryPlanProof();
      break;
    default:
      throw new Error(`unknown_suite:${name}`);
  }
  console.log(`[pr2-gate] suite done: ${name} elapsed=${Date.now() - started}ms`);
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("[pr2-gate] Missing Supabase credentials");
    process.exit(1);
  }
  if (!hasDatabaseUrl()) {
    console.error("[pr2-gate] Missing database URL");
    process.exit(1);
  }

  await queryWithTimeout("SELECT 1 AS ok", [], 10_000);

  const suites =
    suiteArg === "all"
      ? [
          "field-audit",
          "simple-property-accounting",
          "prospect-accounting",
          "owner-accounting",
          "mixed-expression-accounting",
          "relationship-semantics",
          "token-security",
          "route-smoke",
          "query-plans",
        ]
      : [suiteArg];

  for (const suite of suites) {
    await runSuite(suite);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    ok: report.ok,
    suites: Object.fromEntries(
      Object.entries(report.sections).map(([k, v]) => [k, { ok: v.ok, caseCount: v.cases?.length ?? v.checks?.length ?? null }]),
    ),
  };
  fs.mkdirSync(proofDir, { recursive: true });
  fs.writeFileSync(path.join(proofDir, "pr2-verification-summary.md"), renderMarkdown(report));
  fs.writeFileSync(path.join(proofDir, "pr2-verification-summary.json"), JSON.stringify(summary, null, 2));
  writeArtifacts();
  console.log(`[pr2-gate] complete ok=${report.ok} artifacts=${proofDir}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("[pr2-gate] failed:", error);
  report.ok = false;
  report.fatal = error?.message || String(error);
  writeArtifacts();
  process.exit(1);
});