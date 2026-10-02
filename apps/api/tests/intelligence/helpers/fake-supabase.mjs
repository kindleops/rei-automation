/**
 * In-memory stand-in for the service-role supabase-js client, covering exactly
 * the query shapes store/intelligence-store.js uses. It enforces what the
 * PROPOSED migration enforces: primary/unique keys, append-only tables, one
 * champion per family, the live-run idempotency index. No network.
 *
 * hooks.beforeExecute({ table, op }) may return a value to short-circuit:
 *   { error } -> resolve with that error; "throw" -> throw; "hang" -> never resolve.
 */

import { randomUUID } from "node:crypto";

const UNIQUE = {
  decision_journal: [["decision_id"], ["idempotency_key"]],
  feature_definitions: [["feature_key", "version"]],
  feature_sets: [["feature_set_id"]],
  feature_snapshots: [["snapshot_id"]],
  outcome_definitions: [["outcome_key", "version"]],
  outcomes: [["outcome_key", "outcome_version", "subject_type", "subject_id"]],
  corrections: [["correction_id"], ["idempotency_key"]],
  dataset_snapshots: [["dataset_id"]],
  models: [["model_family"]],
  model_versions: [["model_version_id"], ["model_family", "version"]],
  model_status_events: [["event_id"]],
  training_runs: [["run_id"]],
  experiments: [["experiment_id"]],
  experiment_assignments: [["experiment_id", "unit_type", "unit_id"]],
  policy_versions: [["policy_key", "version"]],
  control_audit: [["audit_id"]],
};
const APPEND_ONLY = new Set(["decision_journal", "corrections", "model_status_events", "control_audit"]);
const DEFAULT_ID = {
  feature_snapshots: "snapshot_id",
  corrections: "correction_id",
  model_versions: "model_version_id",
  model_status_events: "event_id",
  training_runs: "run_id",
  control_audit: "audit_id",
};

function partialChecks(table, rows) {
  if (table === "model_versions") {
    const champions = new Map();
    for (const r of rows) {
      if (r.status !== "champion") continue;
      if (champions.has(r.model_family)) return { code: "23505", message: "model_versions_one_champion_per_family" };
      champions.set(r.model_family, true);
    }
  }
  if (table === "training_runs") {
    const live = new Set();
    for (const r of rows) {
      if (!["running", "succeeded"].includes(r.status)) continue;
      if (live.has(r.idempotency_key)) return { code: "23505", message: "training_runs_live_idempotency" };
      live.add(r.idempotency_key);
    }
  }
  return null;
}

const keyOf = (row, cols) => JSON.stringify(cols.map((c) => row[c] ?? null));
const clone = (v) => JSON.parse(JSON.stringify(v));

export function createFakeSupabase({ hooks = {}, now = () => new Date().toISOString() } = {}) {
  const tables = new Map();
  const calls = [];
  const rowsOf = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.op = "select";
      this.filters = [];
      this.payload = null;
      this.options = {};
      this.returning = false;
      this.single = null;
      this.ordering = null;
      this.limitN = null;
    }
    select() {
      if (this.op !== "select") this.returning = true;
      return this;
    }
    insert(rows) {
      this.op = "insert";
      this.payload = Array.isArray(rows) ? rows : [rows];
      return this;
    }
    upsert(rows, options = {}) {
      this.op = "upsert";
      this.payload = Array.isArray(rows) ? rows : [rows];
      this.options = options;
      return this;
    }
    update(patch) {
      this.op = "update";
      this.payload = patch;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    eq(column, value) {
      this.filters.push((r) => r[column] === value || String(r[column]) === String(value));
      return this;
    }
    in(column, values) {
      this.filters.push((r) => values.includes(r[column]));
      return this;
    }
    order(column, { ascending = true } = {}) {
      this.ordering = { column, ascending };
      return this;
    }
    limit(n) {
      this.limitN = n;
      return this;
    }
    maybeSingle() {
      this.single = "maybe";
      return this;
    }
    then(resolve, reject) {
      let pending;
      try {
        pending = this.execute();
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
      return pending.then(resolve, reject);
    }
    async execute() {
      calls.push({ table: this.table, op: this.op });
      const hook = hooks.beforeExecute ? hooks.beforeExecute({ table: this.table, op: this.op, payload: this.payload }) : undefined;
      if (hook === "throw") throw new Error("simulated client failure");
      if (hook === "hang") return new Promise(() => {});
      if (hook && hook.error) return { data: null, error: hook.error };
      const rows = rowsOf(this.table);
      const match = (r) => this.filters.every((f) => f(r));
      if (this.op === "select") {
        let data = rows.filter(match).map(clone);
        if (this.ordering) {
          const { column, ascending } = this.ordering;
          data.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1));
        }
        if (this.limitN !== null) data = data.slice(0, this.limitN);
        if (this.single === "maybe") {
          if (data.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
          return { data: data[0] || null, error: null };
        }
        return { data, error: null };
      }
      if (this.op === "update" || this.op === "delete") {
        if (APPEND_ONLY.has(this.table)) return { data: null, error: { code: "P0001", message: `${this.table} is append-only` } };
        const next = rows.map(clone);
        const touched = [];
        for (let i = 0; i < next.length; i += 1) {
          if (!match(next[i])) continue;
          if (this.op === "update") {
            next[i] = { ...next[i], ...clone(this.payload), updated_at: now() };
            touched.push(next[i]);
          } else {
            touched.push(next[i]);
            next[i] = null;
          }
        }
        const finalRows = next.filter(Boolean);
        const violation = partialChecks(this.table, finalRows);
        if (violation) return { data: null, error: violation };
        tables.set(this.table, finalRows);
        return { data: this.returning ? touched.map(clone) : null, error: null };
      }
      // insert / upsert
      const uniques = UNIQUE[this.table] || [];
      const next = rows.map(clone);
      const written = [];
      for (const raw of this.payload) {
        const row = clone(raw);
        const idCol = DEFAULT_ID[this.table];
        if (idCol && !row[idCol]) row[idCol] = randomUUID();
        if (!row.created_at) row.created_at = now();
        const conflictCols = this.options.onConflict ? this.options.onConflict.split(",").map((c) => c.trim()) : null;
        let conflictIndex = -1;
        let conflictOn = null;
        for (const cols of uniques) {
          const k = keyOf(row, cols);
          const idx = next.findIndex((r) => keyOf(r, cols) === k);
          if (idx >= 0) {
            conflictIndex = idx;
            conflictOn = cols;
            break;
          }
        }
        if (conflictIndex >= 0) {
          const onTarget = conflictCols && conflictOn.join(",") === conflictCols.join(",");
          if (this.op === "upsert" && onTarget && this.options.ignoreDuplicates) continue;
          if (this.op === "upsert" && onTarget && !APPEND_ONLY.has(this.table)) {
            next[conflictIndex] = { ...next[conflictIndex], ...row, updated_at: now() };
            written.push(next[conflictIndex]);
            continue;
          }
          return { data: null, error: { code: "23505", message: `duplicate key on ${this.table}(${conflictOn.join(",")})` } };
        }
        next.push(row);
        written.push(row);
      }
      const violation = partialChecks(this.table, next);
      if (violation) return { data: null, error: violation };
      tables.set(this.table, next);
      if (!this.returning) return { data: null, error: null };
      const data = written.map(clone);
      return { data: this.single === "maybe" ? data[0] || null : data, error: null };
    }
  }

  return {
    calls,
    rows: (table) => clone(rowsOf(table)),
    schema(name) {
      if (name !== "intelligence") throw new Error(`unexpected schema ${name}`);
      return { from: (table) => new Query(table) };
    },
  };
}
