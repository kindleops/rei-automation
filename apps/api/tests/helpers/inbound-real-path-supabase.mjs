// ─── inbound-real-path-supabase.mjs ──────────────────────────────────────────
// A filtering PostgREST-style stub for the REAL inbound path.
//
// The other helpers in this directory return canned rows per table, which is
// enough to exercise a single module. This one actually applies eq/in/lte/gte/
// order/limit against fixture rows, because the regression it serves drives
// find-recent-outbound-pair, the auto-reply duplicate guard and the send_queue
// insertion boundary over the SAME dataset. Selection order and row filtering
// are the behaviour under test, so they cannot be faked.
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
      for (const order of [...orders].reverse()) {
        data = [...data].sort((a, b) => {
          const av = order.column.includes("_at") ? asTime(a?.[order.column]) : clean(a?.[order.column]);
          const bv = order.column.includes("_at") ? asTime(b?.[order.column]) : clean(b?.[order.column]);
          if (av === bv) return 0;
          if (typeof av === "number" && typeof bv === "number") {
            return order.ascending ? av - bv : bv - av;
          }
          return order.ascending ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
        });
      }
      if (typeof limitValue === "number") data = data.slice(0, limitValue);
      return { data, error: null };
    };

    const api = {
      select: () => api,
      insert: (payload) => {
        insertPayload = payload;
        return api;
      },
      update: (payload) => {
        updatePayload = payload;
        return api;
      },
      upsert: (payload) => {
        insertPayload = payload;
        return api;
      },
      delete: () => api,
      eq: (column, value) => {
        filters.push((row) => clean(row?.[column]) === clean(value));
        return api;
      },
      neq: (column, value) => {
        filters.push((row) => clean(row?.[column]) !== clean(value));
        return api;
      },
      in: (column, values = []) => {
        const allowed = new Set((values || []).map(clean));
        filters.push((row) => allowed.has(clean(row?.[column])));
        return api;
      },
      is: (column, value) => {
        if (value === null) filters.push((row) => row?.[column] == null);
        return api;
      },
      not: (column, operator, value) => {
        if (operator === "is" && value === null) {
          filters.push((row) => row?.[column] != null && clean(row?.[column]) !== "");
        }
        return api;
      },
      lt: (column, value) => {
        filters.push((row) => asTime(row?.[column]) < asTime(value));
        return api;
      },
      lte: (column, value) => {
        filters.push((row) => asTime(row?.[column]) <= asTime(value));
        return api;
      },
      gt: (column, value) => {
        filters.push((row) => asTime(row?.[column]) > asTime(value));
        return api;
      },
      gte: (column, value) => {
        filters.push((row) => asTime(row?.[column]) >= asTime(value));
        return api;
      },
      or: () => api,
      contains: () => api,
      abortSignal: () => api,
      order: (column, options = {}) => {
        orders.push({ column, ascending: options.ascending !== false });
        return api;
      },
      limit: (value) => {
        limitValue = value;
        return api;
      },
      range: () => api,
      maybeSingle: async () => {
        const { data, error } = run();
        if (error) return { data: null, error };
        if (Array.isArray(data)) return { data: data[0] ?? null, error: null };
        return { data: data ?? null, error: null };
      },
      single: async () => {
        const { data, error } = run();
        if (error) return { data: null, error };
        if (Array.isArray(data)) return { data: data[0] ?? null, error: null };
        return { data: data ?? null, error: null };
      },
      then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
    };
    return api;
  }

  return { from, store, inserted, rpc: async () => ({ data: null, error: null }) };
}

export default makeInboundRealPathSupabase;
