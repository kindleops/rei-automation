// ─── inbound-real-path-supabase.mjs ──────────────────────────────────────────
// A filtering PostgREST-style stub for the REAL inbound path.
//
// The other helpers in this directory return canned rows per table, which is
// enough to exercise a single module. This one actually applies the query
// operators against fixture rows, because the regression it serves drives
// find-recent-outbound-pair, the auto-reply duplicate guard and the send_queue
// insertion boundary over the SAME dataset. Selection order and row filtering
// are the behaviour under test, so they cannot be faked.
//
// NO SILENT NO-OPS. An earlier version accepted `delete`, `or`, `contains` and
// `range` and quietly ignored them, which meant a query could be narrowed in
// production and unnarrowed here while the suite still passed green. Every
// operator is either implemented with real semantics or rejected loudly:
// `unsupportedCalls` records the attempt AND an error is thrown, so an operator
// swallowed by a try/catch in production code is still visible to the test.
// Assert `supabase.unsupportedCalls` is empty to prove the exercised path used
// only operators this helper actually honours.
//
// Rows inserted into send_queue are captured, not discarded: "exactly one S2
// row was created" is an assertion about a real insert.

function clean(value) {
  return String(value ?? "").trim();
}

function asTime(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Column values compare as timestamps only when both sides parse as dates. */
function comparable(column, value) {
  const time = Date.parse(clean(value));
  if (Number.isFinite(time)) return { kind: "time", value: time };
  const num = Number(value);
  if (value !== null && value !== "" && Number.isFinite(num)) {
    return { kind: "number", value: num };
  }
  return { kind: "string", value: clean(value) };
}

function compare(rowValue, filterValue) {
  const a = comparable(null, rowValue);
  const b = comparable(null, filterValue);
  if (a.kind === "time" && b.kind === "time") return a.value - b.value;
  if (a.kind === "number" && b.kind === "number") return a.value - b.value;
  return String(rowValue ?? "").localeCompare(String(filterValue ?? ""));
}

export function makeInboundRealPathSupabase({
  send_queue = [],
  sms_templates = [],
  message_events = [],
  sms_suppression_list = [],
  tables = {},
} = {}) {
  const store = {
    send_queue: [...send_queue],
    sms_templates: [...sms_templates],
    message_events: [...message_events],
    sms_suppression_list: [...sms_suppression_list],
    ...tables,
  };
  const inserted = { send_queue: [], sms_suppression_list: [], message_events: [] };
  /** Every operator this helper does NOT implement that the run attempted. */
  const unsupportedCalls = [];
  /** Every operator the run DID use, per table — the operator audit. */
  const usedOperators = new Set();
  let seq = 0;

  function rowsFor(table) {
    if (!Array.isArray(store[table])) store[table] = [];
    return store[table];
  }

  function from(table) {
    const filters = [];
    const orders = [];
    let limitValue = null;
    let insertPayload = null;
    let updatePayload = null;
    let countMode = false;
    let headMode = false;

    const use = (op) => usedOperators.add(`${table}.${op}`);

    /**
     * Loud rejection. Records first so the attempt is provable even when the
     * throw is swallowed by a try/catch in the production code under test.
     */
    const reject = (op, detail) => {
      unsupportedCalls.push({ table, op, detail: detail || null });
      throw new Error(
        `inbound-real-path-supabase: unsupported operator .${op}() on "${table}"` +
          `${detail ? ` (${detail})` : ""}. Implement its real semantics in the ` +
          `helper — never let it silently widen the query.`
      );
    };

    const run = () => {
      if (insertPayload) {
        const payloads = Array.isArray(insertPayload) ? insertPayload : [insertPayload];
        const rows = payloads.map((payload) => {
          seq += 1;
          const row = { id: payload.id || `${table}-${seq}`, ...payload };
          rowsFor(table).push(row);
          if (!inserted[table]) inserted[table] = [];
          inserted[table].push(row);
          return row;
        });
        return { data: rows.length === 1 ? rows[0] : rows, error: null };
      }
      if (updatePayload) {
        const matched = rowsFor(table).filter((row) => filters.every((f) => f(row)));
        for (const row of matched) Object.assign(row, updatePayload);
        return { data: matched, error: null };
      }
      let data = rowsFor(table).filter((row) => filters.every((f) => f(row)));
      // The exact count is taken AFTER filters and BEFORE limit, which is what
      // PostgREST reports and what truncation detection depends on.
      const count = data.length;
      // Applied in reverse so the FIRST .order() call is the primary key, which
      // is how PostgREST composes them.
      for (const order of [...orders].reverse()) {
        data = [...data].sort((a, b) => {
          const delta = compare(a?.[order.column], b?.[order.column]);
          return order.ascending ? delta : -delta;
        });
      }
      if (typeof limitValue === "number") data = data.slice(0, limitValue);
      // head:true returns no rows at all — only the count.
      if (headMode) return { data: null, count, error: null };
      if (countMode) return { data, count, error: null };
      return { data, error: null };
    };

    const api = {
      // `select(col, { count: "exact", head: true })` is a real PostgREST count
      // query and IS exercised — shadow fact-state counts message_events before
      // replaying history, to detect truncation. It returns no rows: `data` is
      // null and `count` carries the total AFTER filters, so it must be
      // implemented rather than degraded into a row fetch.
      select: (_columns, options) => {
        use("select");
        if (options && options.count !== undefined) {
          if (options.count !== "exact") {
            reject("select", `only count:"exact" is implemented, got ${JSON.stringify(options.count)}`);
          }
          use("select.count");
          countMode = true;
        }
        if (options && options.head === true) {
          use("select.head");
          headMode = true;
        }
        return api;
      },
      insert: (payload) => {
        use("insert");
        insertPayload = payload;
        return api;
      },
      update: (payload) => {
        use("update");
        updatePayload = payload;
        return api;
      },
      eq: (column, value) => {
        use("eq");
        filters.push((row) => clean(row?.[column]) === clean(value));
        return api;
      },
      neq: (column, value) => {
        use("neq");
        filters.push((row) => clean(row?.[column]) !== clean(value));
        return api;
      },
      in: (column, values = []) => {
        use("in");
        const allowed = new Set((values || []).map(clean));
        filters.push((row) => allowed.has(clean(row?.[column])));
        return api;
      },
      is: (column, value) => {
        use("is");
        if (value !== null) reject("is", `only IS NULL is implemented, got ${String(value)}`);
        filters.push((row) => row?.[column] == null);
        return api;
      },
      not: (column, operator, value) => {
        use("not");
        if (operator === "is" && value === null) {
          filters.push((row) => row?.[column] != null && clean(row?.[column]) !== "");
          return api;
        }
        if (operator === "in") {
          const blocked = new Set(
            String(value || "")
              .replace(/^\(|\)$/g, "")
              .split(",")
              .map((entry) => clean(entry).replace(/^"|"$/g, ""))
              .filter(Boolean)
          );
          filters.push((row) => !blocked.has(clean(row?.[column])));
          return api;
        }
        return reject("not", `operator "${operator}" is not implemented`);
      },
      lt: (column, value) => {
        use("lt");
        filters.push((row) => compare(row?.[column], value) < 0);
        return api;
      },
      lte: (column, value) => {
        use("lte");
        filters.push((row) => compare(row?.[column], value) <= 0);
        return api;
      },
      gt: (column, value) => {
        use("gt");
        filters.push((row) => compare(row?.[column], value) > 0);
        return api;
      },
      gte: (column, value) => {
        use("gte");
        filters.push((row) => compare(row?.[column], value) >= 0);
        return api;
      },
      order: (column, options = {}) => {
        use("order");
        orders.push({ column, ascending: options.ascending !== false });
        return api;
      },
      limit: (value) => {
        use("limit");
        limitValue = value;
        return api;
      },
      maybeSingle: async () => {
        use("maybeSingle");
        const { data, error } = run();
        if (error) return { data: null, error };
        if (Array.isArray(data)) return { data: data[0] ?? null, error: null };
        return { data: data ?? null, error: null };
      },
      single: async () => {
        use("single");
        const { data, error } = run();
        if (error) return { data: null, error };
        if (Array.isArray(data)) return { data: data[0] ?? null, error: null };
        return { data: data ?? null, error: null };
      },
      then: (resolve, reject_) => Promise.resolve(run()).then(resolve, reject_),

      // ── Deliberately NOT implemented ──────────────────────────────────────
      // Each of these previously returned `api` unchanged, which silently
      // widened the query. They now record and throw. If the exercised path
      // ever needs one, implement its real semantics here rather than
      // reinstating a no-op.
      or: (expression) => reject("or", `expression: ${expression}`),
      contains: (column) => reject("contains", `column: ${column}`),
      range: (start, end) => reject("range", `${start}..${end}`),
      delete: () => reject("delete"),
      upsert: () => reject("upsert"),
      filter: (column, operator) => reject("filter", `${column} ${operator}`),
      match: () => reject("match"),
      textSearch: (column) => reject("textSearch", `column: ${column}`),
      abortSignal: () => reject("abortSignal"),
      csv: () => reject("csv"),
      explain: () => reject("explain"),
    };
    return api;
  }

  return {
    from,
    store,
    inserted,
    unsupportedCalls,
    /** Sorted `table.operator` pairs the run actually exercised. */
    operatorAudit: () => [...usedOperators].sort(),
    rpc: async (name) => {
      unsupportedCalls.push({ table: "(rpc)", op: "rpc", detail: name });
      throw new Error(`inbound-real-path-supabase: unsupported rpc("${name}")`);
    },
  };
}

export default makeInboundRealPathSupabase;
