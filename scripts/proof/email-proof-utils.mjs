import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

export const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
export const API_ROOT = path.join(ROOT, "apps/api");

let aliasesRegistered = false;

export function registerApiAliases() {
  if (aliasesRegistered) return;
  process.chdir(API_ROOT);
  register("./tests/alias-loader.mjs", pathToFileURL(`${API_ROOT}/`));
  aliasesRegistered = true;
}

export function createMarker() {
  return {
    failures: 0,
    mark(label, condition, detail = "") {
      const prefix = condition ? "PASS" : "FAIL";
      const line = `${prefix} ${label}${detail ? ` ${detail}` : ""}`;
      if (condition) {
        console.log(line);
      } else {
        this.failures += 1;
        console.error(line);
      }
    },
    finish(label) {
      if (this.failures > 0) {
        console.error(`FAIL ${label} failures=${this.failures}`);
        process.exit(1);
      }
      console.log(`PASS ${label}`);
    },
  };
}

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.action = "select";
    this.filters = [];
    this.orderBy = null;
    this.limitCount = null;
    this.rangeValue = null;
    this.single = false;
    this.payload = null;
    this.patch = null;
    this.onConflict = null;
  }

  select() {
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => String(row?.[column] ?? "") === String(value ?? ""));
    return this;
  }

  not(column, operator, value) {
    if (operator === "eq") {
      this.filters.push((row) => String(row?.[column] ?? "") !== String(value ?? ""));
    }
    return this;
  }

  in(column, values = []) {
    const set = new Set(values.map((value) => String(value)));
    this.filters.push((row) => set.has(String(row?.[column] ?? "")));
    return this;
  }

  gte(column, value) {
    this.filters.push((row) => String(row?.[column] ?? "") >= String(value ?? ""));
    return this;
  }

  or(expression = "") {
    const clauses = expression.split(",").map((part) => part.trim()).filter(Boolean);
    this.filters.push((row) => {
      return clauses.some((clause) => {
        const [column, operator, raw] = clause.split(".");
        if (operator !== "ilike") return false;
        const needle = lower(raw).replaceAll("%", "");
        return lower(row?.[column]).includes(needle);
      });
    });
    return this;
  }

  order(column, options = {}) {
    this.orderBy = { column, ascending: Boolean(options.ascending) };
    return this;
  }

  limit(value) {
    this.limitCount = Number(value);
    return this;
  }

  range(from, to) {
    this.rangeValue = [Number(from), Number(to)];
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  insert(payload) {
    this.action = "insert";
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(patch) {
    this.action = "update";
    this.patch = patch || {};
    return this;
  }

  upsert(payload, options = {}) {
    this.action = "upsert";
    this.payload = Array.isArray(payload) ? payload : [payload];
    this.onConflict = clean(options.onConflict);
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  execute() {
    const rows = this.db.rows[this.table];
    if (!rows) return { data: null, error: { message: `missing table ${this.table}` } };

    if (this.action === "insert") {
      const inserted = this.payload.map((row) => ({ id: row.id || `${this.table}_${rows.length + 1}`, ...clone(row) }));
      rows.push(...inserted);
      return { data: this.single ? inserted[0] : inserted, error: null, count: inserted.length };
    }

    if (this.action === "upsert") {
      const keys = this.onConflict ? this.onConflict.split(",").map((key) => key.trim()) : ["id"];
      const upserted = [];
      for (const payloadRow of this.payload) {
        const index = rows.findIndex((row) => keys.every((key) => String(row?.[key]) === String(payloadRow?.[key])));
        if (index >= 0) {
          rows[index] = { ...rows[index], ...clone(payloadRow) };
          upserted.push(rows[index]);
        } else {
          const next = { id: payloadRow.id || `${this.table}_${rows.length + 1}`, ...clone(payloadRow) };
          rows.push(next);
          upserted.push(next);
        }
      }
      return { data: this.single ? upserted[0] : upserted, error: null, count: upserted.length };
    }

    let selected = rows.filter((row) => this.filters.every((filter) => filter(row)));

    if (this.action === "update") {
      for (const row of selected) Object.assign(row, clone(this.patch));
      return { data: selected, error: null, count: selected.length };
    }

    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      selected = [...selected].sort((a, b) => {
        const left = a?.[column] ?? "";
        const right = b?.[column] ?? "";
        if (left === right) return 0;
        return (left > right ? 1 : -1) * (ascending ? 1 : -1);
      });
    }

    if (this.rangeValue) {
      const [from, to] = this.rangeValue;
      selected = selected.slice(from, to + 1);
    }

    if (Number.isFinite(this.limitCount)) selected = selected.slice(0, this.limitCount);
    return { data: this.single ? selected[0] || null : clone(selected), error: null, count: selected.length };
  }
}

export function createFakeSupabase(seed = {}) {
  const rows = {};
  for (const [table, value] of Object.entries(seed)) rows[table] = clone(value);
  return {
    rows,
    from(table) {
      if (!rows[table]) rows[table] = [];
      return new FakeQuery(this, table);
    },
  };
}
