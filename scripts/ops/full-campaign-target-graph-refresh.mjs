#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const RUNNER_SOURCE = "full_campaign_target_graph_refresh_runner";
const RUNNER_VERSION = 2;

function clean(value) {
  return String(value ?? "").trim();
}

function parseEnvValue(value) {
  const trimmed = clean(value);
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

for (const file of [
  path.join(ROOT, "apps/api/.env.local"),
  path.join(ROOT, "apps/api/.env.production.local"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
]) {
  loadEnvFile(file);
}

const argv = process.argv.slice(2);

function argValue(name, fallback = null) {
  const dashed = `--${name}`;
  const underscored = `--${name.replace(/-/g, "_")}`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === dashed || arg === underscored) return argv[index + 1] ?? fallback;
    if (arg.startsWith(`${dashed}=`)) return arg.slice(dashed.length + 1);
    if (arg.startsWith(`${underscored}=`)) return arg.slice(underscored.length + 1);
  }
  return fallback;
}

function hasFlag(name) {
  const dashed = `--${name}`;
  const underscored = `--${name.replace(/-/g, "_")}`;
  return argv.includes(dashed) || argv.includes(underscored);
}

function firstSetting(...values) {
  for (const value of values) {
    if (clean(value)) return clean(value);
  }
  return "";
}

function boolSetting(value, fallback = false) {
  const text = clean(value).toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function intSetting(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(clean(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

function nullableFilter(value) {
  const text = clean(value);
  if (!text || text.toLowerCase() === "all") return null;
  return text;
}

const config = {
  batchLimit: intSetting(
    firstSetting(
      argValue("batch-limit"),
      process.env.CAMPAIGN_TARGET_GRAPH_BATCH_LIMIT
    ),
    50000,
    { min: 1, max: 50000 }
  ),
  maxBatches: (() => {
    const raw = firstSetting(
      argValue("max-batches"),
      process.env.CAMPAIGN_TARGET_GRAPH_MAX_BATCHES
    );
    return raw ? intSetting(raw, null, { min: 0, max: 1000000 }) : null;
  })(),
  state: nullableFilter(firstSetting(
    argValue("state"),
    process.env.CAMPAIGN_TARGET_GRAPH_STATE,
    process.env.CAMPAIGN_TARGET_GRAPH_BATCH_STATE
  )),
  market: nullableFilter(firstSetting(
    argValue("market"),
    process.env.CAMPAIGN_TARGET_GRAPH_MARKET,
    process.env.CAMPAIGN_TARGET_GRAPH_BATCH_MARKET
  )),
  fallbackEnabled: hasFlag("no-fallback")
    ? false
    : boolSetting(firstSetting(
        argValue("fallback-enabled"),
        process.env.CAMPAIGN_TARGET_GRAPH_FALLBACK_ENABLED,
        process.env.CAMPAIGN_TARGET_GRAPH_RUN_FALLBACK
      ), true),
  resume: hasFlag("fresh")
    ? false
    : boolSetting(firstSetting(
        argValue("resume"),
        process.env.CAMPAIGN_TARGET_GRAPH_RESUME
      ), true),
  runId: nullableFilter(firstSetting(argValue("run-id"), process.env.CAMPAIGN_TARGET_GRAPH_RUN_ID)),
  scopeLevel: clean(firstSetting(
    argValue("scope-level"),
    process.env.CAMPAIGN_TARGET_GRAPH_SCOPE_LEVEL
  )).toLowerCase() || "state",
  commit: hasFlag("no-commit")
    ? false
    : boolSetting(firstSetting(argValue("commit"), process.env.CAMPAIGN_TARGET_GRAPH_COMMIT), true),
  verifyApi: hasFlag("skip-api-verify")
    ? false
    : boolSetting(firstSetting(argValue("verify-api"), process.env.CAMPAIGN_TARGET_GRAPH_VERIFY_API), true),
  launchFlow: hasFlag("skip-launch-flow")
    ? false
    : boolSetting(firstSetting(argValue("launch-flow"), process.env.CAMPAIGN_TARGET_GRAPH_LAUNCH_FLOW), true),
  fastMs: intSetting(firstSetting(argValue("fast-ms"), process.env.CAMPAIGN_TARGET_GRAPH_FAST_MS), 3000, {
    min: 1,
    max: 120000,
  }),
  minStageRows: intSetting(
    firstSetting(argValue("min-stage-rows"), process.env.CAMPAIGN_TARGET_GRAPH_MIN_STAGE_ROWS),
    921,
    { min: 1, max: 100000000 }
  ),
  launchTargetLimit: intSetting(
    firstSetting(argValue("launch-target-limit"), process.env.CAMPAIGN_TARGET_GRAPH_LAUNCH_TARGET_LIMIT),
    5,
    { min: 1, max: 1000 }
  ),
  fallbackCursor: clean(firstSetting(
    argValue("fallback-cursor"),
    process.env.CAMPAIGN_TARGET_GRAPH_FALLBACK_CURSOR
  )).toLowerCase() || "offset",
  forceSmallBatch: hasFlag("force-small-batch") || boolSetting(process.env.FORCE_SMALL_BATCH, false),
  forceCommitPartial: hasFlag("force-commit-partial") || boolSetting(process.env.FORCE_COMMIT_PARTIAL, false),
};

if (config.market && !["market", "state_market"].includes(config.scopeLevel)) {
  config.scopeLevel = "market";
}
if (!["state", "market", "state_market"].includes(config.scopeLevel)) {
  throw new Error(`Unsupported scope_level=${config.scopeLevel}; expected state or market`);
}
if (!["offset", "front"].includes(config.fallbackCursor)) {
  throw new Error(`Unsupported fallback_cursor=${config.fallbackCursor}; expected offset or front`);
}
if (config.batchLimit < 100 && !config.forceSmallBatch) {
  throw new Error("batch_limit below 100 is refused for full graph refresh; set FORCE_SMALL_BATCH=1 to override");
}

const isFullTraversal = !config.state && !config.market;

const dbUrl =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_URL_NO_POOL ||
  process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  console.error("FAIL missing DATABASE_URL, SUPABASE_URL_NO_POOL, or SUPABASE_DB_URL");
  process.exit(1);
}

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
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: apiHeaders(),
      body: options.body,
      signal: AbortSignal.timeout(Number(options.timeoutMs || 60000)),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      json,
      text,
      ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error,
      ms: Math.round(performance.now() - startedAt),
    };
  }
}

function normalizeState(value) {
  const text = clean(value).toUpperCase();
  return text || null;
}

function normalizeMarket(value) {
  return clean(value) || null;
}

function scopeLabel(scope) {
  return `state=${scope.state || "all"} market=${scope.market || "all"}`;
}

function phasePrefix(phase) {
  return phase === "fallback" ? "fallback_property_offset:" : "property_offset:";
}

function rowPhase(row) {
  const key = clean(row.batch_key);
  if (key.startsWith("fallback_property_offset:")) return "fallback";
  if (key.startsWith("property_offset:")) return "direct";
  return "unknown";
}

function batchMetadata(row) {
  return row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
}

function sameScope(row, phase, scope) {
  if (row.status !== "completed") return false;
  if (rowPhase(row) !== phase) return false;
  const metadata = batchMetadata(row);
  return (
    normalizeState(metadata.batch_state) === normalizeState(scope.state) &&
    normalizeMarket(metadata.batch_market) === normalizeMarket(scope.market)
  );
}

function scopeProgress(batchRows, phase, scope) {
  const rows = batchRows.filter((row) => sameScope(row, phase, scope));
  let nextOffset = 0;
  let complete = false;
  for (const row of rows) {
    const metadata = batchMetadata(row);
    const offset = intSetting(metadata.batch_offset, 0, { min: 0 });
    const limit = intSetting(metadata.batch_limit, 0, { min: 0 });
    nextOffset = Math.max(nextOffset, offset + limit);
    if (metadata.has_more === false || clean(metadata.has_more).toLowerCase() === "false") {
      complete = true;
    }
    if (Number(metadata.source_rows || row.source_rows || 0) === 0) complete = true;
  }
  return { complete, nextOffset, completedBatches: rows.length };
}

function sqlFilters(startIndex = 1, includeMasterOwner = false) {
  const conditions = [];
  const values = [];
  let index = startIndex;
  const stateExpr = "upper(coalesce(nullif(property_state, ''), nullif(property_address_state, '')))";
  if (includeMasterOwner) conditions.push("nullif(master_owner_id, '') is not null");
  conditions.push(`${stateExpr} is not null`);
  if (config.state) {
    conditions.push(`${stateExpr} = $${index}`);
    values.push(config.state.toUpperCase());
    index += 1;
  }
  if (config.market) {
    conditions.push("market = $".concat(index));
    values.push(config.market);
    index += 1;
  }
  return { where: conditions.length ? `where ${conditions.join(" and ")}` : "", values };
}

async function discoverScopes(client, phase) {
  const includeMasterOwner = phase === "direct";
  const { where, values } = sqlFilters(1, includeMasterOwner);
  const stateExpr = "upper(coalesce(nullif(property_state, ''), nullif(property_address_state, '')))";
  const marketExpr = "nullif(market, '')";
  const byMarket = config.scopeLevel === "market" || config.scopeLevel === "state_market";
  const sql = byMarket
    ? `
      select ${stateExpr} as state, ${marketExpr} as market, count(*)::integer as source_properties
      from public.properties
      ${where}
      group by 1, 2
      order by 1, 2 nulls first
    `
    : `
      select ${stateExpr} as state, null::text as market, count(*)::integer as source_properties
      from public.properties
      ${where}
      group by 1
      order by 1
    `;
  const { rows } = await client.query(sql, values);
  return rows
    .map((row) => ({
      state: normalizeState(row.state),
      market: normalizeMarket(row.market),
      sourceProperties: Number(row.source_properties || 0),
    }))
    .filter((scope) => scope.state);
}

async function loadBatchRows(client, runId) {
  const { rows } = await client.query(
    `
      select
        id,
        batch_number,
        batch_type,
        batch_key,
        rows_inserted,
        status,
        elapsed_ms,
        metadata
      from public.campaign_target_graph_refresh_batches
      where run_id = $1::uuid
      order by batch_number
    `,
    [runId]
  );
  return rows;
}

async function loadRun(client, runId) {
  const { rows } = await client.query(
    `
      select id, status, metadata, started_at, finished_at
      from public.campaign_target_graph_refresh_runs
      where id = $1::uuid
    `,
    [runId]
  );
  return rows[0] || null;
}

async function findResumableRun(client) {
  if (!config.resume) {
    if (config.runId) {
      console.log(`resume=false ignoring run_id=${config.runId}; a fresh staged run will be created`);
    }
    return null;
  }

  if (config.runId) {
    const { rows } = await client.query(
      `
        select id, status, metadata, started_at
        from public.campaign_target_graph_refresh_runs
        where id = $1::uuid
      `,
      [config.runId]
    );
    const run = rows[0];
    if (!run) throw new Error(`No refresh run found for run_id=${config.runId}`);
    if (run.status !== "started") throw new Error(`Refresh run ${config.runId} is not active; status=${run.status}`);
    return run;
  }

  const { rows } = await client.query(
    `
      select id, status, metadata, started_at
      from public.campaign_target_graph_refresh_runs
      where status = 'started'
        and metadata->>'source' = $1
      order by started_at desc
      limit 1
    `,
    [RUNNER_SOURCE]
  );
  return rows[0] || null;
}

async function startRun(client) {
  const existing = await findResumableRun(client);
  if (existing) {
    await patchRunMetadata(client, existing.id, {
      source: RUNNER_SOURCE,
      runner_version: RUNNER_VERSION,
      batch_limit: config.batchLimit,
      state_filter: config.state,
      market_filter: config.market,
      scope_level: config.scopeLevel,
      fallback_enabled: config.fallbackEnabled,
    });
    console.log(`resume_run_id=${existing.id} started_at=${existing.started_at}`);
    return existing.id;
  }

  if (!config.resume) {
    console.log("fresh_run resume=false: creating a new run_id and intentionally truncating campaign_target_graph_stage");
  }
  const { rows } = await client.query("select public.refresh_campaign_target_graph_stage_start() as run_id");
  const runId = rows[0]?.run_id;
  if (!runId) throw new Error("refresh_campaign_target_graph_stage_start did not return run_id");
  await patchRunMetadata(client, runId, {
    source: RUNNER_SOURCE,
    runner_version: RUNNER_VERSION,
    refresh_strategy: "full_staged_state_market_runner",
    graph_refresh_scope: "partial",
    completed_all_batches: false,
    production_direct_complete: false,
    production_fallback_complete: false,
    fallback_enabled: config.fallbackEnabled,
    batch_limit: config.batchLimit,
    state_filter: config.state,
    market_filter: config.market,
    scope_level: config.scopeLevel,
  });
  console.log(`new_run_id=${runId}`);
  return runId;
}

async function patchRunMetadata(client, runId, metadata) {
  await client.query(
    `
      update public.campaign_target_graph_refresh_runs
      set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb
      where id = $1::uuid
    `,
    [runId, JSON.stringify(metadata)]
  );
}

async function counts(client) {
  const { rows } = await client.query(
    `
      select
        (select count(*)::integer from public.campaign_target_graph) as graph_rows,
        (select count(*)::integer from public.campaign_target_graph_facets) as facet_rows,
        (select count(*)::integer from public.campaign_target_graph_stage) as stage_rows
    `
  );
  return rows[0] || { graph_rows: 0, facet_rows: 0, stage_rows: 0 };
}

async function runBatch(client, phase, runId, scope, offset) {
  const fn = phase === "fallback"
    ? "public.refresh_campaign_target_graph_fallback_batch"
    : "public.refresh_campaign_target_graph_stage_batch";
  const { rows } = await client.query(
    `select * from ${fn}($1::uuid, $2::integer, $3::integer, $4::text, $5::text)`,
    [runId, config.batchLimit, offset, scope.state, scope.market]
  );
  const row = rows[0] || {};
  await patchRunMetadata(client, runId, {
    source: RUNNER_SOURCE,
    runner_version: RUNNER_VERSION,
    graph_refresh_scope: "partial",
    completed_all_batches: false,
    current_phase: phase,
    fallback_enabled: config.fallbackEnabled,
    stage_rows: Number(row.stage_rows || 0),
  });
  return row;
}

function budgetExhausted(startedBatches) {
  return config.maxBatches !== null && startedBatches >= config.maxBatches;
}

async function runPhase(client, runId, phase, scopes, startedBatches) {
  let batchRows = await loadBatchRows(client, runId);
  let scopesCompleted = 0;

  for (const scope of scopes) {
    const progress = scopeProgress(batchRows, phase, scope);
    if (progress.complete) {
      scopesCompleted += 1;
      console.log(`[${phase}] skip completed ${scopeLabel(scope)} batches=${progress.completedBatches}`);
      continue;
    }

    let offset = progress.nextOffset;
    for (;;) {
      if (budgetExhausted(startedBatches)) {
        console.log(`[${phase}] paused max_batches=${config.maxBatches} next ${scopeLabel(scope)} offset=${offset}`);
        return { allComplete: false, startedBatches, scopesCompleted };
      }

      const row = await runBatch(client, phase, runId, scope, offset);
      startedBatches += 1;

      console.log(
        `[${phase}] batch=${row.batch_number || "n/a"} ${scopeLabel(scope)}` +
          ` offset=${offset}` +
          ` source_rows=${row.source_rows ?? 0}` +
          ` rows_inserted=${row.rows_inserted ?? 0}` +
          ` stage_rows=${row.stage_rows ?? 0}` +
          ` has_more=${row.has_more ?? false}` +
          ` elapsed_ms=${row.elapsed_ms ?? 0}`
      );
      if (
        scope.state &&
        Number(row.elapsed_ms || 0) > 30000 &&
        (Number(row.source_rows || 0) === 0 || Number(row.rows_inserted || 0) === 0)
      ) {
        console.warn(
          `[${phase}] WARN zero_row_state_batch state=${scope.state}` +
            ` market=${scope.market || "all"}` +
            ` offset=${offset}` +
            ` source_rows=${row.source_rows ?? 0}` +
            ` rows_inserted=${row.rows_inserted ?? 0}` +
            ` elapsed_ms=${row.elapsed_ms ?? 0}`
        );
      }

      batchRows = await loadBatchRows(client, runId);
      if (Number(row.source_rows || 0) === 0 || row.has_more === false) {
        scopesCompleted += 1;
        break;
      }
      if (phase === "fallback" && config.fallbackCursor === "front" && Number(row.rows_inserted || 0) > 0) {
        offset = 0;
        continue;
      }
      offset += config.batchLimit;
    }
  }

  return { allComplete: true, startedBatches, scopesCompleted };
}

async function markPhaseComplete(client, runId, phase, extra = {}) {
  await patchRunMetadata(client, runId, {
    source: RUNNER_SOURCE,
    runner_version: RUNNER_VERSION,
    graph_refresh_scope: "partial",
    completed_all_batches: false,
    [`production_${phase}_complete`]: true,
    ...extra,
  });
}

async function commitRun(client, runId, beforeGraphRows) {
  const current = await counts(client);
  const stageRows = Number(current.stage_rows || 0);
  const productionRows = Number(current.graph_rows || beforeGraphRows || 0);
  if (stageRows <= 0) {
    throw new Error("stage_rows=0; refusing commit because it would empty production graph");
  }
  if (stageRows < config.minStageRows && !config.forceCommitPartial) {
    throw new Error(`stage_rows=${stageRows} below min_stage_rows=${config.minStageRows}; refusing commit`);
  }

  const minimumProductionCoverage = productionRows > 0 ? Math.floor(productionRows * 0.8) : 0;
  if (minimumProductionCoverage > 0 && stageRows < minimumProductionCoverage && !config.forceCommitPartial) {
    throw new Error(
      `stage_rows=${stageRows} below 80% of production graph rows=${productionRows}; ` +
        "refusing commit unless FORCE_COMMIT_PARTIAL=1"
    );
  }
  if (config.forceCommitPartial && stageRows < Math.max(config.minStageRows, minimumProductionCoverage)) {
    console.warn(
      `WARN FORCE_COMMIT_PARTIAL=1 bypassing partial commit guard ` +
        `stage_rows=${stageRows} production_rows=${productionRows} min_stage_rows=${config.minStageRows}`
    );
  }

  await client.query("begin");
  try {
    await patchRunMetadata(client, runId, {
      source: RUNNER_SOURCE,
      runner_version: RUNNER_VERSION,
      completed_all_batches: true,
      graph_refresh_scope: "full",
      full_refresh_complete: true,
      fallback_enabled: config.fallbackEnabled,
      committed_by: RUNNER_SOURCE,
    });
    const { rows } = await client.query(
      "select * from public.refresh_campaign_target_graph_stage_commit($1::uuid)",
      [runId]
    );
    await patchRunMetadata(client, runId, {
      source: RUNNER_SOURCE,
      runner_version: RUNNER_VERSION,
      completed_all_batches: true,
      graph_refresh_scope: "full",
      full_refresh_complete: true,
      fallback_enabled: config.fallbackEnabled,
      committed_by: RUNNER_SOURCE,
    });
    await client.query("commit");
    return rows[0] || {};
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function coverageReport(client, runId) {
  const { rows: summaryRows } = await client.query(
    `
      select
        count(*)::integer as graph_rows,
        count(*) filter (where queue_eligible)::integer as queue_eligible_rows,
        count(*) filter (where sms_eligible)::integer as sms_eligible_rows,
        count(*) filter (where sender_covered)::integer as sender_covered_rows,
        count(distinct state)::integer as states,
        count(distinct market)::integer as markets,
        max(generated_at) as latest_generated_at
      from public.campaign_target_graph
    `
  );
  const { rows: stateRows } = await client.query(
    `
      select state, count(*)::integer as rows, count(*) filter (where queue_eligible)::integer as queue_eligible
      from public.campaign_target_graph
      group by state
      order by count(*) desc
      limit 20
    `
  );
  const { rows: sourceRows } = await client.query(
    `
      select graph_source, count(*)::integer as rows
      from public.campaign_target_graph
      group by graph_source
      order by count(*) desc
    `
  );
  const { rows: runRows } = await client.query(
    `
      select id, status, graph_rows, facet_rows, started_at, finished_at, metadata
      from public.campaign_target_graph_refresh_runs
      where id = $1::uuid
    `,
    [runId]
  );
  const { rows: batchSummaryRows } = await client.query(
    `
      select
        case
          when batch_key like 'fallback_property_offset:%' then 'fallback'
          when batch_key like 'property_offset:%' then 'direct'
          else 'unknown'
        end as phase,
        count(*)::integer as batches,
        coalesce(sum(rows_inserted), 0)::integer as rows_inserted,
        coalesce(sum(nullif(metadata->>'source_rows', '')::integer), 0)::integer as source_rows,
        coalesce(sum(elapsed_ms), 0)::integer as elapsed_ms
      from public.campaign_target_graph_refresh_batches
      where run_id = $1::uuid
      group by 1
      order by 1
    `,
    [runId]
  );
  return {
    summary: summaryRows[0] || {},
    states: stateRows,
    sources: sourceRows,
    run: runRows[0] || {},
    batches: batchSummaryRows,
  };
}

function apiErrorDetail(result) {
  if (result.error) return result.error.message || String(result.error);
  if (result.json?.error) return `${result.json.error}:${result.json.message || ""}`;
  return result.text ? result.text.slice(0, 160) : "";
}

async function verifyFastEndpoint(label, pathOrUrl, options) {
  let result = await callApi(pathOrUrl, options);
  if (result.status === 200 && result.ms > config.fastMs) {
    console.log(`[api] ${label} warmup_status=200 warmup_ms=${result.ms}`);
    result = await callApi(pathOrUrl, options);
  }
  console.log(`[api] ${label} status=${result.status} ms=${result.ms}`);
  if (result.status !== 200) {
    throw new Error(`${label} API failed status=${result.status} ${apiErrorDetail(result)}`);
  }
  if (result.ms > config.fastMs) {
    throw new Error(`${label} API slow ms=${result.ms} threshold_ms=${config.fastMs}`);
  }
  return result;
}

async function verifyPreviewAndOptions() {
  const preview = await verifyFastEndpoint("/preview-targets", "/api/cockpit/campaigns/preview-targets", {
    method: "POST",
    timeoutMs: 120000,
    body: JSON.stringify({
      source: "campaign_target_graph",
      candidate_source: "campaign_target_graph",
      include_diagnostics: true,
      dry_run: true,
      limitPreview: 3,
      target_limit: 3,
      filters: {},
    }),
  });
  const previewJson = preview.json || {};
  console.log(
    `[api] preview total_matched=${previewJson.total_matched ?? previewJson.total_matched_properties ?? "unknown"}` +
      ` graph_scope=${previewJson.graph_refresh_scope || previewJson.diagnostics?.graphRefreshStatus?.graph_refresh_scope || "unknown"}` +
      ` graph_rows=${previewJson.graph_row_count ?? previewJson.diagnostics?.graphRefreshStatus?.graph_row_count ?? "unknown"}`
  );

  const options = await verifyFastEndpoint(
    "/options",
    "/api/cockpit/campaigns/options?field=properties.property_type&search=Single&limit=10",
    { timeoutMs: 60000 }
  );
  const optionsJson = options.json || {};
  console.log(
    `[api] options count=${Array.isArray(optionsJson.options) ? optionsJson.options.length : 0}` +
      ` graph_scope=${optionsJson.graph_refresh_scope || optionsJson.graphRefreshStatus?.graph_refresh_scope || "unknown"}` +
      ` graph_rows=${optionsJson.graph_row_count ?? optionsJson.graphRefreshStatus?.graph_row_count ?? "unknown"}`
  );
  return { preview, options };
}

async function countSendQueueRowsForCampaign(client, campaignId) {
  const { rows } = await client.query(
    "select count(*)::integer as count from public.send_queue where campaign_id = $1",
    [campaignId]
  );
  return Number(rows[0]?.count || 0);
}

async function startCampaignLaunchFlow(client, runId) {
  const create = await callApi("/api/cockpit/campaigns", {
    method: "POST",
    timeoutMs: 60000,
    body: JSON.stringify({
      name: `Full Graph Launch ${new Date().toISOString()}`,
      description: "Guarded launch flow created after full campaign_target_graph refresh. No SMS send is performed.",
      status: "ready",
      objective: "ownership_check",
      candidate_source: "campaign_target_graph",
      daily_cap: config.launchTargetLimit,
      total_cap: config.launchTargetLimit,
      batch_max: config.launchTargetLimit,
      market_cap: config.launchTargetLimit,
      per_sender_cap: config.launchTargetLimit,
      send_interval_seconds: 60,
      contact_window_start: "09:00",
      contact_window_end: "20:00",
      auto_queue_enabled: true,
      auto_send_enabled: false,
      auto_reply_mode: "disabled",
      metadata: {
        launch_flow_started: true,
        graph_refresh_run_id: runId,
        candidate_source: "campaign_target_graph",
      },
      target_filters: {
        sms_eligible_required: true,
        valid_e164_required: true,
        routing_safe_only: true,
        dedupe_same_phone: true,
        dedupe_same_owner: true,
      },
    }),
  });
  console.log(`[launch] create status=${create.status} ms=${create.ms}`);
  if (create.status !== 200) throw new Error(`campaign create failed ${apiErrorDetail(create)}`);

  const campaignId = create.json?.campaign_id || create.json?.campaign?.id;
  if (!campaignId) throw new Error("campaign create did not return campaign_id");

  const sendQueueBefore = await countSendQueueRowsForCampaign(client, campaignId);
  const build = await callApi(`/api/cockpit/campaigns/${campaignId}/build-targets`, {
    method: "POST",
    timeoutMs: 180000,
    body: JSON.stringify({
      source: "campaign_target_graph",
      candidate_source: "campaign_target_graph",
      limit: config.launchTargetLimit,
    }),
  });
  console.log(`[launch] build-targets status=${build.status} ms=${build.ms} built_count=${build.json?.built_count ?? "unknown"}`);
  if (build.status !== 200) throw new Error(`build-targets failed ${apiErrorDetail(build)}`);
  if (build.json?.no_send_queue_rows_created !== true) {
    throw new Error("build-targets response did not confirm no_send_queue_rows_created");
  }

  const queuePlan = await callApi(`/api/cockpit/campaigns/${campaignId}/queue-plan`, {
    method: "POST",
    timeoutMs: 120000,
    body: JSON.stringify({
      dry_run: true,
      create_send_queue_rows: false,
      explicit_operator_action: true,
      source: "campaign_target_graph",
      candidate_source: "campaign_target_graph",
      limit: Math.min(config.launchTargetLimit, 5),
    }),
  });
  console.log(
    `[launch] queue-plan status=${queuePlan.status} ms=${queuePlan.ms}` +
      ` dry_run=${queuePlan.json?.dry_run ?? "unknown"}` +
      ` send_queue_rows_created=${queuePlan.json?.send_queue_rows_created ?? "unknown"}`
  );
  if (queuePlan.status !== 200) throw new Error(`queue-plan failed ${apiErrorDetail(queuePlan)}`);
  if (queuePlan.json?.dry_run !== true || Number(queuePlan.json?.send_queue_rows_created || 0) !== 0) {
    throw new Error("queue-plan was not a no-send dry run");
  }

  const sendQueueAfter = await countSendQueueRowsForCampaign(client, campaignId);
  if (sendQueueAfter !== sendQueueBefore) {
    throw new Error(`send_queue changed for campaign_id=${campaignId}: before=${sendQueueBefore} after=${sendQueueAfter}`);
  }

  return {
    campaignId,
    builtCount: Number(build.json?.built_count || 0),
    queuePlanTargets: Number(queuePlan.json?.selected_targets || queuePlan.json?.planned_targets || 0),
  };
}

async function main() {
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const before = await counts(client);
    console.log(
      `config batch_limit=${config.batchLimit}` +
        ` max_batches=${config.maxBatches ?? "all"}` +
        ` state=${config.state || "all"}` +
        ` market=${config.market || "all"}` +
        ` fallback_enabled=${config.fallbackEnabled}` +
        ` scope_level=${config.scopeLevel}` +
        ` fallback_cursor=${config.fallbackCursor}` +
        ` resume=${config.resume}` +
        ` commit=${config.commit}` +
        ` force_small_batch=${config.forceSmallBatch}` +
        ` force_commit_partial=${config.forceCommitPartial}`
    );
    console.log(`before graph_rows=${before.graph_rows} facet_rows=${before.facet_rows} stage_rows=${before.stage_rows}`);

    const runId = await startRun(client);
    let startedBatches = 0;
    const run = await loadRun(client, runId);
    const runMetadata = run?.metadata && typeof run.metadata === "object" ? run.metadata : {};

    const directScopes = await discoverScopes(client, "direct");
    const fallbackScopes = config.fallbackEnabled ? await discoverScopes(client, "fallback") : [];
    console.log(`[direct] scopes=${directScopes.length}`);
    console.log(`[fallback] scopes=${fallbackScopes.length} enabled=${config.fallbackEnabled}`);

    if (runMetadata.production_direct_complete === true) {
      console.log("[direct] skip phase production_direct_complete=true");
    } else {
      const direct = await runPhase(client, runId, "direct", directScopes, startedBatches);
      startedBatches = direct.startedBatches;
      if (!direct.allComplete) {
        await patchRunMetadata(client, runId, {
          source: RUNNER_SOURCE,
          graph_refresh_scope: "partial",
          completed_all_batches: false,
          pause_reason: "max_batches",
        });
        console.log(`PAUSED run_id=${runId} after_batches=${startedBatches}`);
        return;
      }
      if (isFullTraversal) {
        await markPhaseComplete(client, runId, "direct", { direct_scope_count: directScopes.length });
      } else {
        await patchRunMetadata(client, runId, {
          source: RUNNER_SOURCE,
          graph_refresh_scope: "partial",
          completed_all_batches: false,
          last_targeted_direct_complete: true,
        });
      }
    }

    if (runMetadata.production_fallback_complete === true) {
      console.log("[fallback] skip phase production_fallback_complete=true");
    } else if (config.fallbackEnabled) {
      const fallback = await runPhase(client, runId, "fallback", fallbackScopes, startedBatches);
      startedBatches = fallback.startedBatches;
      if (!fallback.allComplete) {
        await patchRunMetadata(client, runId, {
          source: RUNNER_SOURCE,
          graph_refresh_scope: "partial",
          completed_all_batches: false,
          pause_reason: "max_batches",
        });
        console.log(`PAUSED run_id=${runId} after_batches=${startedBatches}`);
        return;
      }
      if (isFullTraversal) {
        await markPhaseComplete(client, runId, "fallback", { fallback_scope_count: fallbackScopes.length });
      } else {
        await patchRunMetadata(client, runId, {
          source: RUNNER_SOURCE,
          graph_refresh_scope: "partial",
          completed_all_batches: false,
          last_targeted_fallback_complete: true,
        });
      }
    }

    const stageAfterBatches = await counts(client);
    console.log(`stage_after_batches=${stageAfterBatches.stage_rows}`);

    let commit = null;
    if (config.commit && isFullTraversal) {
      commit = await commitRun(client, runId, Number(before.graph_rows || 0));
      console.log(
        `commit graph_rows=${commit.graph_rows ?? 0}` +
          ` facet_rows=${commit.facet_rows ?? 0}` +
          ` graph_refresh_scope=${commit.graph_refresh_scope || "unknown"}` +
          ` elapsed_ms=${commit.elapsed_ms ?? 0}`
      );
    } else {
      console.log(`commit=skipped${isFullTraversal ? "" : " filtered_traversal"}`);
    }

    const after = await counts(client);
    console.log(`after graph_rows=${after.graph_rows} facet_rows=${after.facet_rows} stage_rows=${after.stage_rows}`);
    if (
      config.commit &&
      isFullTraversal &&
      Number(before.graph_rows || 0) > 0 &&
      Number(after.graph_rows || 0) < Math.floor(Number(before.graph_rows || 0) * 0.8) &&
      !config.forceCommitPartial
    ) {
      throw new Error(`graph row count below 80% after commit: before=${before.graph_rows} after=${after.graph_rows}`);
    }

    const report = await coverageReport(client, runId);
    console.log(`coverage_summary=${JSON.stringify(report.summary)}`);
    console.log(`coverage_sources=${JSON.stringify(report.sources)}`);
    console.log(`coverage_batches=${JSON.stringify(report.batches)}`);
    console.log(`coverage_top_states=${JSON.stringify(report.states)}`);
    console.log(`refresh_run=${JSON.stringify(report.run)}`);

    if (config.verifyApi) {
      await verifyPreviewAndOptions();
    }

    if (config.launchFlow) {
      const launch = await startCampaignLaunchFlow(client, runId);
      console.log(`launch_flow=${JSON.stringify(launch)}`);
    }

    console.log(`PASS full campaign target graph refresh run_id=${runId}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`FAIL full campaign target graph refresh: ${error?.message || String(error)}`);
  process.exit(1);
});
