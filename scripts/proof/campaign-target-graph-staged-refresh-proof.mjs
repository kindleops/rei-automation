#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

const envFiles = [
  path.join(ROOT, "apps/api/.env.local"),
  path.join(ROOT, "apps/api/.env.production.local"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
];

function parseEnvValue(value) {
  const trimmed = String(value ?? "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!process.env[key]) process.env[key] = parseEnvValue(normalized.slice(equalsIndex + 1));
  }
}

for (const file of envFiles) loadEnvFile(file);

const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_URL_NO_POOL || process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("FAIL missing DATABASE_URL, SUPABASE_URL_NO_POOL, or SUPABASE_DB_URL");
  process.exit(1);
}

const batchLimit = Math.max(1, Math.min(Number(process.env.CAMPAIGN_TARGET_GRAPH_BATCH_LIMIT || 1000), 5000));
const maxBatches = Math.max(1, Number(process.env.CAMPAIGN_TARGET_GRAPH_MAX_BATCHES || 1));
const continueBatches = process.env.CAMPAIGN_TARGET_GRAPH_CONTINUE_BATCHES === "1";
const batchState = process.env.CAMPAIGN_TARGET_GRAPH_BATCH_STATE === "all"
  ? null
  : (process.env.CAMPAIGN_TARGET_GRAPH_BATCH_STATE || "AZ");
const batchMarket = process.env.CAMPAIGN_TARGET_GRAPH_BATCH_MARKET || null;
const runFallback = process.env.CAMPAIGN_TARGET_GRAPH_RUN_FALLBACK !== "0";
const fallbackLimit = Math.max(1, Math.min(Number(process.env.CAMPAIGN_TARGET_GRAPH_FALLBACK_LIMIT || 100), 5000));
const fallbackState = process.env.CAMPAIGN_TARGET_GRAPH_FALLBACK_STATE === "all"
  ? null
  : (process.env.CAMPAIGN_TARGET_GRAPH_FALLBACK_STATE || "FL");
const fallbackMarket = process.env.CAMPAIGN_TARGET_GRAPH_FALLBACK_MARKET || null;
const previewState = process.env.CAMPAIGN_TARGET_GRAPH_PREVIEW_STATE || (runFallback && fallbackState ? fallbackState : batchState) || "AZ";
const previewPropertyType = process.env.CAMPAIGN_TARGET_GRAPH_PREVIEW_PROPERTY_TYPE || "Single Family";
const requireApiProof = process.env.CAMPAIGN_TARGET_GRAPH_REQUIRE_API_PROOF === "1";

const baseUrl = String(
  process.env.COCKPIT_PROOF_BASE_URL ||
  process.env.API_URL ||
  process.env.LOCAL_API_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const opsSecret =
  process.env.OPS_DASHBOARD_SECRET ||
  process.env.VITE_OPS_DASHBOARD_SECRET ||
  process.env.VITE_BACKEND_API_SECRET ||
  "";

function apiHeaders() {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    origin: "http://localhost:5173",
  };
  if (opsSecret) headers["x-ops-dashboard-secret"] = opsSecret;
  return headers;
}

async function callApi(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: apiHeaders(),
      body: options.body,
      signal: AbortSignal.timeout(Number(options.timeoutMs || 30000)),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json, text, ms: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, status: 0, error, ms: Date.now() - startedAt };
  }
}

function intCount(row, key = "count") {
  return Number(row?.[key] || 0);
}

async function main() {
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const { rows: startRows } = await client.query("select public.refresh_campaign_target_graph_stage_start() as run_id");
    const runId = startRows[0]?.run_id;
    if (!runId) throw new Error("refresh_campaign_target_graph_stage_start did not return run_id");

    console.log(`run_id=${runId}`);
    console.log(`batch_limit=${batchLimit} state=${batchState || "all"} market=${batchMarket || "all"} max_batches=${continueBatches ? maxBatches : 1}`);

    let offset = 0;
    let latestBatch = null;
    const batchesToRun = continueBatches ? maxBatches : 1;

    for (let index = 0; index < batchesToRun; index += 1) {
      const { rows } = await client.query(
        "select * from public.refresh_campaign_target_graph_stage_batch($1::uuid, $2::integer, $3::integer, $4::text, $5::text)",
        [runId, batchLimit, offset, batchState, batchMarket],
      );
      latestBatch = rows[0] || null;
      console.log(
        `batch=${latestBatch?.batch_number || index + 1}` +
          ` source_rows=${latestBatch?.source_rows ?? 0}` +
          ` rows_inserted=${latestBatch?.rows_inserted ?? 0}` +
          ` stage_rows=${latestBatch?.stage_rows ?? 0}` +
          ` has_more=${latestBatch?.has_more ?? false}` +
          ` elapsed_ms=${latestBatch?.elapsed_ms ?? 0}`,
      );
      offset += batchLimit;
      if (!latestBatch?.has_more) break;
    }

    if (runFallback) {
      const { rows } = await client.query(
        "select * from public.refresh_campaign_target_graph_fallback_batch($1::uuid, $2::integer, $3::integer, $4::text, $5::text)",
        [runId, fallbackLimit, 0, fallbackState, fallbackMarket],
      );
      const fallback = rows[0] || {};
      console.log(
        `fallback_batch=${fallback.batch_number || "n/a"}` +
          ` state=${fallbackState || "all"}` +
          ` market=${fallbackMarket || "all"}` +
          ` source_rows=${fallback.source_rows ?? 0}` +
          ` rows_inserted=${fallback.rows_inserted ?? 0}` +
          ` stage_rows=${fallback.stage_rows ?? 0}` +
          ` has_more=${fallback.has_more ?? false}` +
          ` elapsed_ms=${fallback.elapsed_ms ?? 0}`,
      );
    }

    const { rows: stageCountRows } = await client.query("select count(*)::integer as count from public.campaign_target_graph_stage");
    const stageCount = intCount(stageCountRows[0]);
    console.log(`stage_count=${stageCount}`);

    if (stageCount <= 0) {
      throw new Error("stage_count is 0; refusing to truncate/commit production campaign_target_graph");
    }

    const { rows: commitRows } = await client.query(
      "select * from public.refresh_campaign_target_graph_stage_commit($1::uuid)",
      [runId],
    );
    const commit = commitRows[0] || {};
    console.log(
      `commit graph_rows=${commit.graph_rows ?? 0}` +
        ` facet_rows=${commit.facet_rows ?? 0}` +
        ` graph_refresh_scope=${commit.graph_refresh_scope || "unknown"}` +
        ` elapsed_ms=${commit.elapsed_ms ?? 0}`,
    );

    const { rows: graphCountRows } = await client.query(
      "select count(*)::integer as count, max(generated_at) as latest_generated_at from public.campaign_target_graph",
    );
    const { rows: facetCountRows } = await client.query(
      "select count(*)::integer as count, max(updated_at) as latest_updated_at from public.campaign_target_graph_facets",
    );
    const { rows: runRows } = await client.query(`
      select id, status, graph_rows, facet_rows, started_at, finished_at, metadata
      from public.campaign_target_graph_refresh_runs
      where id = $1::uuid
    `, [runId]);
    const { rows: batchRows } = await client.query(`
      select
        batch_number,
        batch_type,
        batch_key,
        rows_inserted,
        nullif(metadata->>'source_rows', '')::integer as source_rows,
        status,
        elapsed_ms,
        metadata
      from public.campaign_target_graph_refresh_batches
      where run_id = $1::uuid
      order by batch_number
    `, [runId]);

    const graphCount = intCount(graphCountRows[0]);
    const facetCount = intCount(facetCountRows[0]);
    console.log(`production_graph_count=${graphCount} latest_generated_at=${graphCountRows[0]?.latest_generated_at || "null"}`);
    console.log(`facet_count=${facetCount} latest_updated_at=${facetCountRows[0]?.latest_updated_at || "null"}`);
    console.log(`refresh_run=${JSON.stringify(runRows[0] || {})}`);
    console.log(`refresh_batches=${JSON.stringify(batchRows)}`);

    if (graphCount <= 0) throw new Error("production campaign_target_graph count is 0 after commit");
    if (facetCount <= 0) throw new Error("campaign_target_graph_facets count is 0 after commit");

    const preview = await callApi("/api/cockpit/campaigns/preview-targets", {
      method: "POST",
      timeoutMs: 60000,
      body: JSON.stringify({
        source: "campaign_target_graph",
        candidate_source: "campaign_target_graph",
        proof: true,
        include_diagnostics: true,
        dry_run: true,
        limitPreview: 3,
        target_limit: 3,
        filters: {
          properties: [
            { field_key: "properties.property_state", operator: "is_any_of", value: [previewState], domain: "properties" },
            { field_key: "properties.property_type", operator: "contains", value: previewPropertyType, domain: "properties" },
          ],
        },
      }),
    });

    if (preview.status === 0) {
      console.log(`preview_api=skipped server_unavailable base_url=${baseUrl} ms=${preview.ms}`);
      if (requireApiProof) throw new Error("preview API proof required but server is unavailable");
    } else {
      const json = preview.json || {};
      console.log(
        `preview_api_status=${preview.status}` +
          ` total_matched=${json.total_matched ?? json.total_matched_properties ?? json.total_scanned ?? 0}` +
          ` graph_refresh_scope=${json.graph_refresh_scope || json.diagnostics?.graphRefreshStatus?.graph_refresh_scope || "unknown"}` +
          ` graph_row_count=${json.graph_row_count ?? json.diagnostics?.graphRefreshStatus?.graph_row_count ?? "unknown"}`,
      );
      if (preview.status !== 200) throw new Error(`preview API returned status ${preview.status}`);
    }

    const options = await callApi("/api/cockpit/campaigns/options?field=properties.property_type&search=Single&limit=10", {
      timeoutMs: 30000,
    });

    if (options.status === 0) {
      console.log(`options_api=skipped server_unavailable base_url=${baseUrl} ms=${options.ms}`);
      if (requireApiProof) throw new Error("options API proof required but server is unavailable");
    } else {
      const json = options.json || {};
      console.log(
        `options_api_status=${options.status}` +
          ` options=${Array.isArray(json.options) ? json.options.length : 0}` +
          ` graph_refresh_scope=${json.graph_refresh_scope || json.graphRefreshStatus?.graph_refresh_scope || "unknown"}` +
          ` graph_row_count=${json.graph_row_count ?? json.graphRefreshStatus?.graph_row_count ?? "unknown"}`,
      );
      if (options.status !== 200) throw new Error(`options API returned status ${options.status}`);
    }

    console.log("PASS staged campaign target graph refresh proof");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`FAIL staged campaign target graph refresh proof: ${error?.message || String(error)}`);
  process.exit(1);
});
