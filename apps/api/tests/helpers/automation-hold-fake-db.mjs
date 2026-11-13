// In-memory PostgREST-style Supabase double for the automation-hold suites (P0 2026-10-16).
// Generic tables (unknown tables read as empty), the automation_hold_for RPC with the SAME predicate as
// the SQL function (via matchAutomationHolds; SQL parity is proved separately on disposable PG17), and
// switches to make the hold lookup fail (fail-closed tests).
import { matchAutomationHolds } from "@/lib/domain/holds/automation-hold.js";

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    // json path: a->b->>c reads row.a.b.c as text
    const v = col.includes("->")
      ? (() => { const parts = col.split(/->>?/); let cur = row; for (const k of parts) cur = cur == null ? undefined : cur[k]; return cur == null ? undefined : String(cur); })()
      : row[col];
    if (op === "eq") return v === val;
    if (op === "neq") return v !== val;
    if (op === "in") return Array.isArray(val) && val.includes(v);
    if (op === "is") return val === null ? v == null : v === val;
    if (op === "gt") return String(v ?? "") > String(val);
    if (op === "lt") return String(v ?? "") < String(val);
    return true;
  });
}

export function makeHoldFakeDb(seed = {}) {
  const tables = new Map(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const calls = { rpc: [], inserts: [], updates: [] };
  const options = { rpcError: null, rpcThrows: false, noRpc: false, holdsSelectError: null };
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  function query(name) {
    const filters = [];
    let order = null;
    let limit = null;
    let mode = "select";
    let payload = null;
    const run = () => {
      if (name === "automation_holds" && options.holdsSelectError && mode === "select") return { data: null, error: { message: options.holdsSelectError } };
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: r.id || `${name}-${table(name).length + 1}`, ...r }));
        table(name).push(...rows);
        calls.inserts.push({ table: name, rows });
        return { data: rows, error: null };
      }
      if (mode === "update") {
        const hits = table(name).filter((r) => matches(r, filters));
        hits.forEach((r) => Object.assign(r, payload));
        calls.updates.push({ table: name, patch: payload, count: hits.length });
        return { data: hits, error: null };
      }
      let out = table(name).filter((r) => matches(r, filters));
      if (order) out = [...out].sort((a, b) => (order.asc ? 1 : -1) * (String(a[order.col] ?? "") < String(b[order.col] ?? "") ? -1 : 1));
      if (limit != null) out = out.slice(0, limit);
      return { data: out, error: null };
    };
    const api = {
      select() { return api; },
      eq(c, v) { filters.push(["eq", c, v]); return api; },
      neq(c, v) { filters.push(["neq", c, v]); return api; },
      in(c, v) { filters.push(["in", c, v]); return api; },
      is(c, v) { filters.push(["is", c, v]); return api; },
      gt(c, v) { filters.push(["gt", c, v]); return api; },
      lt(c, v) { filters.push(["lt", c, v]); return api; },
      not() { return api; },
      or() { return api; },
      order(col, o) { order = { col, asc: o?.ascending !== false }; return api; },
      limit(n) { limit = n; return api; },
      insert(p) { mode = "insert"; payload = p; return api; },
      update(p) { mode = "update"; payload = p; return api; },
      async maybeSingle() { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
      async single() { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }

  const db = {
    tables,
    calls,
    options,
    rows: (name) => table(name),
    from: (name) => query(name),
    async rpc(fn, params) {
      calls.rpc.push({ fn, params });
      if (options.rpcThrows) throw new Error("rpc transport down");
      if (options.rpcError) return { data: null, error: { message: options.rpcError } };
      if (fn !== "automation_hold_for") return { data: null, error: { message: `unknown rpc ${fn}` } };
      const scope = {
        thread_key: params.p_thread_key, inbox_thread_id: params.p_inbox_thread_id, property_id: params.p_property_id,
        opportunity_id: params.p_opportunity_id, master_owner_id: params.p_master_owner_id,
      };
      return { data: matchAutomationHolds(table("automation_holds"), scope, params.p_capability), error: null };
    },
  };
  return db;
}

export const IDS = Object.freeze({
  H_THREAD: "596a9368-6ef8-40f8-97cb-fcc46e6672d3", H_TK: "+15550101001", H_PROP: "225438557",
  H_OPP: "9b690ce3-ff88-400b-b56e-69e9bd0055b0", H_OFFER: "93790b80-46d8-473f-8aa3-8085b88c2ad6",
  M_THREAD: "58d05df2-561d-4c9e-9226-ab3de105d773", M_TK: "+15550101002", M_PROP: "251027062",
  M_OPP: "47da7121-c39d-425a-b608-046750e35027",
  C_TK: "+15550101003", C_PROP: "P_CONTROL", C_OPP: "c0000000-0000-4000-8000-0000000000bb",
});

/** Prod-shaped Hartford + Maxwell + a control deal, with the two registry holds active. */
export function seedContainment({ holds = true } = {}) {
  const now = new Date().toISOString();
  return {
    automation_holds: holds
      ? [
          { id: "11111111-0000-4000-8000-000000000001", hold_key: "owner_hold_20261016:hartford", hold_type: "operator_hold", thread_key: IDS.H_TK, inbox_thread_id: IDS.H_THREAD, property_id: IDS.H_PROP, opportunity_id: IDS.H_OPP, blocked_capabilities: null, released_at: null },
          { id: "11111111-0000-4000-8000-000000000002", hold_key: "owner_handled_20261014:maxwell", hold_type: "permanent_exclusion", thread_key: IDS.M_TK, inbox_thread_id: IDS.M_THREAD, property_id: IDS.M_PROP, opportunity_id: IDS.M_OPP, blocked_capabilities: null, released_at: null },
        ]
      : [],
    acquisition_opportunities: [
      { id: IDS.H_OPP, primary_thread_key: IDS.H_TK, primary_property_id: IDS.H_PROP, master_owner_id: "mo_h", acquisition_stage: "offer", opportunity_status: "archived", automation_state: "cancelled", active_offer_id: `offer:${IDS.H_OPP}:v1`, metadata: { negotiation_state: { terms_accepted: false } }, dedupe_key: "dk_h", updated_at: now },
      { id: IDS.M_OPP, primary_thread_key: IDS.M_TK, primary_property_id: IDS.M_PROP, master_owner_id: "mo_m", acquisition_stage: "asking_price", opportunity_status: "active", automation_state: "inactive", metadata: {}, dedupe_key: "dk_m", updated_at: now },
      { id: IDS.C_OPP, primary_thread_key: IDS.C_TK, primary_property_id: IDS.C_PROP, master_owner_id: "mo_c", acquisition_stage: "offer", opportunity_status: "active", automation_state: "running", metadata: {}, dedupe_key: "dk_c", updated_at: now },
    ],
    seller_offers: [
      { id: IDS.H_OFFER, offer_id: `offer:${IDS.H_OPP}:v1`, opportunity_id: IDS.H_OPP, property_id: IDS.H_PROP, thread_key: IDS.H_TK, offer_version: 1, offer_type: "cash", direction: "outbound", purchase_price: 315000, status: "active", sent_at: "2026-09-25T16:21:00Z", created_at: "2026-10-07T09:36:13Z", metadata: { offer_event: { amount: 315000, source: "operator", operator_id: "operator_unattributed" } } },
      { id: "c0000000-0000-4000-8000-0000000000cc", offer_id: "offer:control:v1", opportunity_id: IDS.C_OPP, property_id: IDS.C_PROP, thread_key: IDS.C_TK, offer_version: 1, offer_type: "initial_offer", direction: "outbound", purchase_price: 100000, authorized_ceiling: 120000, ade_snapshot_id: "ade:c:1", status: "active", sent_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", closing_date: "2026-11-01", closing_term: "14_calendar_days_from_acceptance", emd_term: "3_business_days_from_acceptance", metadata: {} },
    ],
    property_acquisition_scores: [
      { property_id: IDS.H_PROP, minimum_acceptable_offer: 97500, valuation_mid: 298100, computed_at: "2026-09-25", evidence: { offer_calculation: { effective_authorized_ceiling: 126100 } } },
      { property_id: IDS.C_PROP, minimum_acceptable_offer: 110000, valuation_mid: 180000, computed_at: "2026-10-01", evidence: { offer_calculation: { effective_authorized_ceiling: 125000 } } },
    ],
    closing_cases: [],
    automation_hold_events: [],
    send_queue: [],
  };
}
