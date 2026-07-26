/**
 * In-memory `acquisition_opportunities` (+ history) store for the Auto Reply
 * Intelligence V2 multi-turn persistence tests.
 *
 * CONTRACT: this file emulates STORAGE and PostgREST query/response shape only
 * (eq/in filtering, order/limit chaining, insert-returning, update-returning,
 * upsert). It must never decide a stage, fact, authority, negotiation or
 * template outcome — every such decision in the tests that use this helper
 * comes from the real production functions
 * (persistSellerTransitionArtifacts, loadSellerDealState, opportunity-service).
 *
 * This is what makes the multi-turn tests real rather than fictional: facts are
 * written and re-read through the exact production persistence path, so a fact
 * that production would lose between turns is lost here too.
 */

function cleanStr(value) {
  return String(value ?? "").trim();
}

function matches(row, filters) {
  return filters.every((f) => {
    const actual = row[f.col];
    if (f.op === "eq") return cleanStr(actual) === cleanStr(f.val);
    if (f.op === "in") return (f.val || []).map(cleanStr).includes(cleanStr(actual));
    if (f.op === "is") return f.val === null ? actual == null : actual === f.val;
    return true;
  });
}

export function makeAcquisitionOpportunityStore({ rows = [] } = {}) {
  const table = new Map();
  const history = [];
  let nextId = 1;
  for (const row of rows) {
    const id = row.id || `opp-${nextId++}`;
    table.set(id, { metadata: {}, version: 1, ...row, id });
  }

  function selectQuery(filters = [], pendingUpdate = null) {
    const resolveRows = () => {
      const found = [...table.values()].filter((row) => matches(row, filters));
      if (pendingUpdate) {
        for (const row of found) Object.assign(row, pendingUpdate);
      }
      return found.map((row) => ({ ...row }));
    };

    const query = {
      select: () => query,
      eq: (col, val) => selectQuery([...filters, { op: "eq", col, val }], pendingUpdate),
      in: (col, val) => selectQuery([...filters, { op: "in", col, val }], pendingUpdate),
      is: (col, val) => selectQuery([...filters, { op: "is", col, val }], pendingUpdate),
      order: () => query,
      limit: () => query,
      maybeSingle: async () => {
        const found = resolveRows();
        return { data: found[0] ?? null, error: null };
      },
      single: async () => {
        const found = resolveRows();
        if (!found[0]) return { data: null, error: { message: "no_rows_returned" } };
        return { data: found[0], error: null };
      },
      then: (onFulfilled, onRejected) =>
        Promise.resolve({ data: resolveRows(), error: null }).then(onFulfilled, onRejected),
    };
    return query;
  }

  const opportunitiesTable = {
    select: () => selectQuery(),
    insert: (payload) => {
      const row = Array.isArray(payload) ? payload[0] : payload;
      const created = { metadata: {}, version: 1, ...row, id: row?.id || `opp-${nextId++}` };
      table.set(created.id, created);
      return selectQuery([{ op: "eq", col: "id", val: created.id }]);
    },
    update: (patch) => selectQuery([], patch),
    upsert: (payload) => {
      const row = Array.isArray(payload) ? payload[0] : payload;
      const existing = row?.id ? table.get(row.id) : null;
      if (existing) {
        Object.assign(existing, row);
        return selectQuery([{ op: "eq", col: "id", val: existing.id }]);
      }
      return opportunitiesTable.insert(row);
    },
  };

  const genericTable = {
    select: () => selectQuery([{ op: "eq", col: "__never__", val: "__never__" }]),
    insert: (payload) => {
      history.push(payload);
      return selectQuery([{ op: "eq", col: "__never__", val: "__never__" }]);
    },
    update: () => selectQuery([{ op: "eq", col: "__never__", val: "__never__" }]),
    upsert: (payload) => {
      history.push(payload);
      return selectQuery([{ op: "eq", col: "__never__", val: "__never__" }]);
    },
  };

  return {
    from(tableName) {
      return tableName === "acquisition_opportunities" ? opportunitiesTable : genericTable;
    },
    /** Test-only introspection. */
    __rows: () => [...table.values()],
    __history: () => history,
  };
}

export default makeAcquisitionOpportunityStore;
