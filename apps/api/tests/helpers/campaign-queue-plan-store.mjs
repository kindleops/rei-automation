/**
 * Storage-only fake Supabase for the real createCampaignQueuePlan /
 * activateCampaignWithHydration production functions
 * (campaign-automation-service.js).
 *
 * CONTRACT (mirrors tests/helpers/lifecycle-integration-store.mjs): this file
 * emulates PostgREST STORAGE and query/response shape only — table rows,
 * .eq/.in/.order/.limit filtering, count/head selects, insert/update/delete,
 * and a `.rpc()` that always reports "function not found" (code 42883). It
 * must never decide an eligibility, suppression, routing, template, or
 * lifecycle outcome — every such decision in tests that use this store comes
 * from the real production function running against these tables.
 *
 * The `.rpc()` "not found" behavior is not a shortcut invented for this
 * fixture: campaign-state-machine.js and campaign-execution-lock.js both
 * already ship a real, production-authored degraded path for exactly this
 * condition (pre-migration / RPC-not-yet-deployed environments) —
 * transitionCampaignStatusFallback() and the "acquired: true, enforced:
 * false" lock result. Returning 42883 here exercises that real fallback code,
 * it does not bypass it.
 */

function cleanStr(value) {
  return String(value ?? "").trim();
}

function getPath(row, col) {
  const m = String(col || "").match(/^([a-zA-Z0-9_]+)->>([a-zA-Z0-9_]+)$/);
  if (m) {
    const obj = row?.[m[1]];
    return obj && typeof obj === "object" ? obj[m[2]] : undefined;
  }
  return row?.[col];
}

function asComparable(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (Number.isFinite(num) && cleanStr(value) !== "") return num;
  const time = Date.parse(value);
  if (!Number.isNaN(time) && /^\d{4}-\d{2}-\d{2}/.test(cleanStr(value))) return time;
  return String(value);
}

function evalOrSubclause(row, subclause) {
  const parts = String(subclause || "").trim().split(".");
  if (parts.length < 3) return false;
  const [col, op, ...rest] = parts;
  const value = rest.join(".");
  const rawVal = getPath(row, col);
  const strVal = cleanStr(rawVal).toLowerCase();
  if (op === "eq") return strVal === cleanStr(value).toLowerCase();
  if (op === "ilike") {
    const pattern = cleanStr(value).toLowerCase().replace(/%/g, "");
    return pattern ? strVal.includes(pattern) : true;
  }
  return false;
}

function applyFilterOp(op, col, value) {
  return (row) => {
    const raw = getPath(row, col);
    if (op === "eq") return cleanStr(raw) === cleanStr(value);
    if (op === "neq") return cleanStr(raw) !== cleanStr(value);
    if (op === "ilike") {
      const pattern = cleanStr(value).toLowerCase().replace(/%/g, "");
      return pattern ? cleanStr(raw).toLowerCase().includes(pattern) : true;
    }
    if (op === "gt") return asComparable(raw) !== null && asComparable(raw) > asComparable(value);
    if (op === "gte") return asComparable(raw) !== null && asComparable(raw) >= asComparable(value);
    if (op === "lt") return asComparable(raw) !== null && asComparable(raw) < asComparable(value);
    if (op === "lte") return asComparable(raw) !== null && asComparable(raw) <= asComparable(value);
    if (op === "is") return value === null ? raw === null || raw === undefined : raw === value;
    return true;
  };
}

/** Sort comparator honoring PostgREST's default nullsFirst=!ascending. */
function compareForOrder(a, b, col, { ascending = true, nullsFirst = !ascending } = {}) {
  const av = getPath(a, col);
  const bv = getPath(b, col);
  const aNull = av === null || av === undefined;
  const bNull = bv === null || bv === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return nullsFirst ? -1 : 1;
  if (bNull) return nullsFirst ? 1 : -1;
  const an = asComparable(av);
  const bn = asComparable(bv);
  if (an === bn) return 0;
  if (an < bn) return ascending ? -1 : 1;
  return ascending ? 1 : -1;
}

/** Generic PostgREST-shaped select chain over a live-backing rows array. */
function makeSelectChain(rowsGetter) {
  let filtered = null;
  const matchers = [];
  let orderSpec = null;
  let limitN = null;
  let countOpt = null;

  const ensure = () => {
    if (filtered) return filtered;
    filtered = rowsGetter().filter((r) => matchers.every((m) => m(r)));
    return filtered;
  };

  const resolveRows = () => {
    let rows = ensure();
    if (orderSpec) rows = [...rows].sort((a, b) => compareForOrder(a, b, orderSpec.col, orderSpec.opts));
    if (limitN != null) rows = rows.slice(0, limitN);
    return rows;
  };

  const api = {
    select(_cols, opts) {
      if (opts && opts.count) countOpt = opts;
      return api;
    },
    eq(col, val) {
      matchers.push(applyFilterOp("eq", col, val));
      return api;
    },
    neq(col, val) {
      matchers.push(applyFilterOp("neq", col, val));
      return api;
    },
    in(col, vals) {
      const set = new Set((vals || []).map(cleanStr));
      matchers.push((r) => set.has(cleanStr(getPath(r, col))));
      return api;
    },
    gt(col, val) {
      matchers.push(applyFilterOp("gt", col, val));
      return api;
    },
    gte(col, val) {
      matchers.push(applyFilterOp("gte", col, val));
      return api;
    },
    lt(col, val) {
      matchers.push(applyFilterOp("lt", col, val));
      return api;
    },
    lte(col, val) {
      matchers.push(applyFilterOp("lte", col, val));
      return api;
    },
    ilike(col, val) {
      matchers.push(applyFilterOp("ilike", col, val));
      return api;
    },
    is(col, val) {
      matchers.push(applyFilterOp("is", col, val));
      return api;
    },
    filter(col, op, val) {
      matchers.push(applyFilterOp(op, col, val));
      return api;
    },
    not() {
      return api;
    },
    or(clause) {
      matchers.push((r) => String(clause || "").split(",").some((sc) => evalOrSubclause(r, sc)));
      return api;
    },
    order(col, opts) {
      orderSpec = { col, opts };
      return api;
    },
    limit(n) {
      limitN = n;
      return api;
    },
    range() {
      return api;
    },
    maybeSingle: async () => {
      const rows = resolveRows();
      return { data: rows[0] ? { ...rows[0] } : null, error: null };
    },
    single: async () => {
      const rows = resolveRows();
      return { data: rows[0] ? { ...rows[0] } : null, error: null };
    },
    then(resolve, reject) {
      const rows = resolveRows();
      if (countOpt) {
        const payload = countOpt.head ? null : rows.map((r) => ({ ...r }));
        return Promise.resolve({ data: payload, count: rows.length, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
    },
  };
  return api;
}

function makeUpdateChain(rowsGetter, patch) {
  const matchers = [];
  const apply = () => {
    const matched = rowsGetter().filter((r) => matchers.every((m) => m(r)));
    matched.forEach((r) => Object.assign(r, patch));
    return matched.map((r) => ({ ...r }));
  };
  const chain = {
    eq(col, val) {
      matchers.push(applyFilterOp("eq", col, val));
      return chain;
    },
    in(col, vals) {
      const set = new Set((vals || []).map(cleanStr));
      matchers.push((r) => set.has(cleanStr(getPath(r, col))));
      return chain;
    },
    lt(col, val) {
      matchers.push(applyFilterOp("lt", col, val));
      return chain;
    },
    select() {
      return {
        maybeSingle: async () => {
          const m = apply();
          return { data: m[0] || null, error: null };
        },
        single: async () => {
          const m = apply();
          return { data: m[0] || null, error: null };
        },
        then(resolve, reject) {
          return Promise.resolve({ data: apply(), error: null }).then(resolve, reject);
        },
      };
    },
    then(resolve, reject) {
      return Promise.resolve({ data: apply(), error: null }).then(resolve, reject);
    },
  };
  return chain;
}

function makeDeleteChain(rowsArray) {
  const matchers = [];
  const apply = () => {
    const kept = [];
    const removed = [];
    for (const row of rowsArray) {
      if (matchers.every((m) => m(row))) removed.push(row);
      else kept.push(row);
    }
    rowsArray.length = 0;
    rowsArray.push(...kept);
    return removed;
  };
  const chain = {
    eq(col, val) {
      matchers.push(applyFilterOp("eq", col, val));
      return chain;
    },
    select() {
      return {
        then(resolve, reject) {
          return Promise.resolve({ data: apply().map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };
    },
    then(resolve, reject) {
      return Promise.resolve({ data: apply(), error: null }).then(resolve, reject);
    },
  };
  return chain;
}

const ACTIVE_DEDUPE_STATUSES = new Set([
  "queued",
  "ready",
  "runnable",
  "scheduled",
  "pending",
  "paused",
  "paused_after_hours",
]);

/**
 * A single generic, lazily-created table: real backing array, auto id,
 * PostgREST-shaped select/insert/update/delete. Every table this harness
 * touches (modeled or not) goes through this same code path, so an
 * aggregation helper hitting a table we didn't explicitly seed still gets
 * real (empty) storage semantics instead of a hand-picked stub.
 */
function makeTable(name, { idPrefix, dedupeKeyColumn } = {}) {
  const rows = [];
  let nextId = 1;

  function insertOne(payload) {
    if (dedupeKeyColumn) {
      const key = cleanStr(payload[dedupeKeyColumn]);
      if (key) {
        const conflict = rows.find(
          (r) =>
            cleanStr(r[dedupeKeyColumn]) === key &&
            !r.sent_at &&
            ACTIVE_DEDUPE_STATUSES.has(String(r.queue_status || "").toLowerCase())
        );
        if (conflict) {
          return {
            error: {
              code: "23505",
              message: `duplicate key value violates unique constraint "uq_${name}_active_${dedupeKeyColumn}"`,
            },
          };
        }
      }
    }
    const id = cleanStr(payload.id) || `${idPrefix || name}_${nextId++}`;
    const stored = { ...payload, id };
    rows.push(stored);
    return { row: stored };
  }

  return {
    name,
    rows,
    from() {
      return {
        select: (...args) => makeSelectChain(() => rows).select(...args),
        insert(payload) {
          const list = Array.isArray(payload) ? payload : [payload];
          const inserted = [];
          let insertError = null;
          for (const item of list) {
            const result = insertOne(item);
            if (result.error) {
              insertError = result.error;
              break;
            }
            inserted.push(result.row);
          }
          const respond = (single) => {
            if (insertError) return { data: null, error: insertError };
            if (single) return { data: inserted[0] ? { ...inserted[0] } : null, error: null };
            return { data: inserted.map((r) => ({ ...r })), error: null };
          };
          return {
            select: () => ({
              maybeSingle: async () => respond(true),
              single: async () => respond(true),
              then(resolve, reject) {
                return Promise.resolve(respond(false)).then(resolve, reject);
              },
            }),
            then(resolve, reject) {
              return Promise.resolve(respond(false)).then(resolve, reject);
            },
          };
        },
        update: (patch) => makeUpdateChain(() => rows, patch),
        delete: () => makeDeleteChain(rows),
        upsert(payload) {
          const list = Array.isArray(payload) ? payload : [payload];
          const result = list.map((item) => insertOne(item).row).filter(Boolean);
          return {
            select: () => Promise.resolve({ data: result, error: null }),
            then(resolve, reject) {
              return Promise.resolve({ data: result, error: null }).then(resolve, reject);
            },
          };
        },
      };
    },
  };
}

/**
 * Build a fresh store + fake Supabase client backing createCampaignQueuePlan
 * / activateCampaignWithHydration. Tables are created on first access, so any
 * table those functions (or the informational aggregation helpers they
 * transitively call via getCampaign) touch gets real, empty-by-default
 * PostgREST-shaped storage rather than a thrown error.
 */
export function makeCampaignQueuePlanStore() {
  const tables = new Map();
  tables.set("send_queue", makeTable("send_queue", { idPrefix: "sq", dedupeKeyColumn: "dedupe_key" }));

  function table(name) {
    if (!tables.has(name)) tables.set(name, makeTable(name));
    return tables.get(name);
  }

  const supabase = {
    from(name) {
      return table(name).from();
    },
    rpc(_name, _params) {
      // No RPC functions are deployed in this fixture — every caller in the
      // production path (campaign-state-machine.js, campaign-execution-
      // lock.js) has a real, disclosed fallback for exactly this error shape.
      // Chainable (some callers do `.rpc(...).maybeSingle()`), and directly
      // awaitable (most callers just `await supabase.rpc(...)`).
      const result = { data: null, error: { code: "42883", message: "function does not exist" } };
      const chain = {
        maybeSingle: async () => result,
        single: async () => result,
        then(resolve, reject) {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    },
  };

  return {
    supabase,
    table,
    /** Synchronous fixture seeding — bypasses the insert chain (that path is
     * exercised for real by the production code under test, e.g. send_queue
     * rows created by createCampaignQueuePlan itself). */
    seedRow(name, row) {
      const stored = { ...row };
      table(name).rows.push(stored);
      return stored;
    },
    rows(name) {
      return table(name).rows.map((r) => ({ ...r }));
    },
  };
}

export function makeCampaignQueuePlanDeps(store, extra = {}) {
  return { supabase: store.supabase, ...extra };
}
