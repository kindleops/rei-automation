/**
 * IC8 baselines: a gentle, read-only, checkpointed reader over the API's
 * service-role Supabase client (PostgREST).
 *
 * Why REST: direct Postgres from apps/api/.env.local fails with 28P01 (stale
 * password, measured 2026-10-02), so the only sanctioned script path is the
 * service-role client. Every call is a GET (select) or a STABLE RPC.
 *
 * Load discipline:
 *   - statement_timeout: PostgREST runs as `authenticator`, whose role config
 *     sets statement_timeout=8s (IC8 runtime audit Q27). A client-side abort
 *     (default 20s) bounds the HTTP call as well.
 *   - keyset pagination (`id > cursor order by id limit N`, N <= 1000 =
 *     PostgREST max-rows) or bounded `in (...)` batches;
 *   - a pause between calls (paceMs);
 *   - explicit column lists only (JSON paths for metadata, never whole blobs).
 *
 * Checkpointing: each named table is appended to <workDir>/<name>.ndjson one
 * page at a time; <workDir>/checkpoint.json records cursor + byte length after
 * every page, so an interrupted extract resumes where it stopped (a torn page
 * is truncated away).
 */

import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRestReader({ supabase, workDir, paceMs = 300, timeoutMs = 20000, log = () => {} }) {
  fs.mkdirSync(workDir, { recursive: true });
  const checkpointPath = path.join(workDir, "checkpoint.json");
  const state = fs.existsSync(checkpointPath) ? JSON.parse(fs.readFileSync(checkpointPath, "utf8")) : { tables: {}, calls: 0 };
  const save = () => {
    const temp = `${checkpointPath}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temp, checkpointPath);
  };

  async function call(build, label) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      state.calls += 1;
      const { data, error } = await build().abortSignal(AbortSignal.timeout(timeoutMs));
      await sleep(paceMs);
      if (!error) return data || [];
      log(`  ${label}: attempt ${attempt} failed (${error.code || "error"}: ${String(error.message || "").slice(0, 120)})`);
      if (attempt === 3) throw new Error(`${label} failed: ${error.code || ""} ${String(error.message || "").slice(0, 200)}`);
      await sleep(paceMs * 4 * attempt);
    }
    return [];
  }

  function tableState(name) {
    const file = path.join(workDir, `${name}.ndjson`);
    if (!state.tables[name]) state.tables[name] = { done: false, cursor: null, bytes: 0, rows: 0, batch: 0 };
    const t = state.tables[name];
    if (!t.done) {
      // drop anything written after the last checkpointed page
      if (!fs.existsSync(file)) fs.writeFileSync(file, "");
      fs.truncateSync(file, t.bytes);
    }
    return { t, file };
  }

  function appendRows(file, t, rows) {
    if (rows.length) fs.appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
    t.bytes = fs.statSync(file).size;
    t.rows += rows.length;
  }

  /**
   * Keyset-paged scan. `query()` returns a fresh builder with filters applied;
   * the reader adds `.gt(key, cursor).order(key).limit(pageSize)`.
   * `transform(rows)` maps raw rows to what is persisted (drop PII here).
   */
  async function scan(name, { query, key = "id", pageSize = 1000, transform = (rows) => rows }) {
    const { t, file } = tableState(name);
    while (!t.done) {
      const raw = await call(() => {
        let q = query();
        if (t.cursor !== null) q = q.gt(key, t.cursor);
        return q.order(key, { ascending: true }).limit(pageSize);
      }, `${name} page after ${t.cursor === null ? "start" : "cursor"}`);
      appendRows(file, t, transform(raw));
      if (raw.length) t.cursor = raw[raw.length - 1][key];
      t.done = raw.length < pageSize;
      save();
      log(`  ${name}: ${t.rows} rows${t.done ? " (done)" : ""}`);
    }
    return readTable(name);
  }

  /** Bounded `in (...)` lookups over a fixed, sorted id list (checkpointed by batch index). */
  async function lookup(name, { ids, column, query, batchSize = 150, transform = (rows) => rows }) {
    const { t, file } = tableState(name);
    const list = [...new Set(ids.filter((v) => v !== null && v !== undefined && v !== "").map(String))].sort();
    const batches = Math.ceil(list.length / batchSize);
    while (!t.done) {
      if (t.batch >= batches) {
        t.done = true;
        save();
        break;
      }
      const slice = list.slice(t.batch * batchSize, (t.batch + 1) * batchSize);
      const raw = await call(() => query().in(column, slice), `${name} batch ${t.batch + 1}/${batches}`);
      if (raw.length >= 1000) throw new Error(`${name} batch ${t.batch + 1} hit the PostgREST row cap; lower batchSize`);
      appendRows(file, t, transform(raw));
      t.batch += 1;
      t.done = t.batch >= batches;
      save();
      if (t.batch % 10 === 0 || t.done) log(`  ${name}: batch ${t.batch}/${batches}, ${t.rows} rows`);
    }
    return readTable(name);
  }

  function readTable(name) {
    const file = path.join(workDir, `${name}.ndjson`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /** One-shot in-memory read that is never persisted (message bodies). */
  async function scanInMemory(label, { query, key = "id", pageSize = 1000 }) {
    const out = [];
    let cursor = null;
    for (;;) {
      const raw = await call(() => {
        let q = query();
        if (cursor !== null) q = q.gt(key, cursor);
        return q.order(key, { ascending: true }).limit(pageSize);
      }, `${label} (memory)`);
      out.push(...raw);
      if (raw.length < pageSize) break;
      cursor = raw[raw.length - 1][key];
    }
    return out;
  }

  return {
    scan,
    lookup,
    readTable,
    scanInMemory,
    call,
    isDone: (name) => Boolean(state.tables[name]?.done),
    stats: () => ({ calls: state.calls, tables: JSON.parse(JSON.stringify(state.tables)) }),
  };
}
