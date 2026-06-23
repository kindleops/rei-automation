#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

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

function nullableCursor(value) {
  const text = clean(value);
  if (!text || text.toLowerCase() === "start" || text.toLowerCase() === "null") return null;
  return text;
}

function pgBool(value) {
  if (typeof value === "boolean") return value;
  return boolSetting(value, false);
}

const globalCursor = nullableCursor(firstSetting(
  argValue("after-graph-id"),
  argValue("cursor"),
  process.env.CAMPAIGN_GRAPH_FILTER_BACKFILL_AFTER_GRAPH_ID,
  process.env.CAMPAIGN_GRAPH_FILTER_BACKFILL_CURSOR
));

const config = {
  batchLimit: intSetting(
    firstSetting(
      argValue("batch-limit"),
      process.env.CAMPAIGN_GRAPH_FILTER_BACKFILL_BATCH_LIMIT
    ),
    5000,
    { min: 1, max: 50000 }
  ),
  maxBatches: (() => {
    const raw = firstSetting(
      argValue("max-batches"),
      process.env.CAMPAIGN_GRAPH_FILTER_BACKFILL_MAX_BATCHES
    );
    return raw ? intSetting(raw, null, { min: 0, max: 1000000 }) : null;
  })(),
  production: hasFlag("production")
    ? true
    : hasFlag("no-production")
      ? false
      : boolSetting(process.env.CAMPAIGN_GRAPH_FILTER_BACKFILL_PRODUCTION, true),
  stage: hasFlag("stage")
    ? true
    : hasFlag("no-stage")
      ? false
      : boolSetting(process.env.CAMPAIGN_GRAPH_FILTER_BACKFILL_STAGE, false),
  productionCursor: nullableCursor(firstSetting(
    argValue("production-after-graph-id"),
    process.env.CAMPAIGN_GRAPH_FILTER_BACKFILL_PRODUCTION_AFTER_GRAPH_ID,
    globalCursor
  )),
  stageCursor: nullableCursor(firstSetting(
    argValue("stage-after-graph-id"),
    process.env.CAMPAIGN_GRAPH_FILTER_BACKFILL_STAGE_AFTER_GRAPH_ID,
    globalCursor
  )),
};

const dbUrl =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_URL_NO_POOL ||
  process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  console.error("FAIL missing DATABASE_URL, SUPABASE_URL_NO_POOL, or SUPABASE_DB_URL");
  process.exit(1);
}

const targets = [];
if (config.production) {
  targets.push({
    name: "production",
    fn: "public.backfill_campaign_target_graph_filter_columns_batch",
    cursor: config.productionCursor,
    resumeEnv: "CAMPAIGN_GRAPH_FILTER_BACKFILL_PRODUCTION_AFTER_GRAPH_ID",
  });
}
if (config.stage) {
  targets.push({
    name: "stage",
    fn: "public.backfill_campaign_target_graph_stage_filter_columns_batch",
    cursor: config.stageCursor,
    resumeEnv: "CAMPAIGN_GRAPH_FILTER_BACKFILL_STAGE_AFTER_GRAPH_ID",
  });
}

if (targets.length === 0) {
  console.error("FAIL no target enabled; set CAMPAIGN_GRAPH_FILTER_BACKFILL_PRODUCTION=1 or CAMPAIGN_GRAPH_FILTER_BACKFILL_STAGE=1");
  process.exit(2);
}

async function callBatch(client, target, cursor) {
  const { rows } = await client.query(
    `select * from ${target.fn}($1::integer, $2::text)`,
    [config.batchLimit, cursor]
  );
  return rows[0] || {
    rows_selected: 0,
    rows_updated: 0,
    next_after_graph_id: null,
    has_more: false,
    elapsed_ms: 0,
  };
}

function printPause(target, cursor, batches, totals) {
  console.log(
    `[${target.name}] PAUSED batches=${batches}` +
      ` rows_selected=${totals.rowsSelected}` +
      ` rows_updated=${totals.rowsUpdated}` +
      ` resume_env="${target.resumeEnv}=${cursor || ""}"`
  );
}

async function runTarget(client, target, budget) {
  let cursor = target.cursor;
  let batches = 0;
  const totals = { rowsSelected: 0, rowsUpdated: 0 };

  for (;;) {
    if (config.maxBatches !== null && budget.started >= config.maxBatches) {
      printPause(target, cursor, batches, totals);
      return { complete: false, cursor, batches, ...totals };
    }

    const row = await callBatch(client, target, cursor);
    budget.started += 1;
    batches += 1;

    const rowsSelected = Number(row.rows_selected || 0);
    const rowsUpdated = Number(row.rows_updated || 0);
    const nextCursor = nullableCursor(row.next_after_graph_id);
    const hasMore = pgBool(row.has_more);
    const elapsedMs = Number(row.elapsed_ms || 0);

    totals.rowsSelected += rowsSelected;
    totals.rowsUpdated += rowsUpdated;

    console.log(
      `[${target.name}] batch=${batches}` +
        ` rows_selected=${rowsSelected}` +
        ` rows_updated=${rowsUpdated}` +
        ` cursor_in=${cursor || "start"}` +
        ` next_after_graph_id=${nextCursor || ""}` +
        ` has_more=${hasMore}` +
        ` elapsed_ms=${elapsedMs}`
    );

    if (rowsSelected === 0) {
      return { complete: true, cursor, batches, ...totals };
    }
    if (!nextCursor || nextCursor === cursor) {
      throw new Error(`[${target.name}] cursor did not advance; refusing to loop`);
    }

    cursor = nextCursor;
    if (!hasMore) {
      return { complete: true, cursor, batches, ...totals };
    }
  }
}

async function main() {
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    console.log(
      `config batch_limit=${config.batchLimit}` +
        ` max_batches=${config.maxBatches ?? "all"}` +
        ` production=${config.production}` +
        ` stage=${config.stage}` +
        " mode=chunked_filter_column_backfill no_truncate=true no_graph_refresh=true"
    );

    const budget = { started: 0 };
    const results = [];
    for (const target of targets) {
      const result = await runTarget(client, target, budget);
      results.push({ target: target.name, ...result });
      if (!result.complete) break;
    }

    console.log(`summary=${JSON.stringify({ batches_started: budget.started, results })}`);
    const incomplete = results.find((result) => !result.complete);
    if (incomplete) {
      console.log(`PAUSED campaign target graph filter backfill target=${incomplete.target}`);
      return;
    }
    console.log("PASS campaign target graph filter backfill");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`FAIL campaign target graph filter backfill: ${error?.message || String(error)}`);
  process.exit(1);
});
