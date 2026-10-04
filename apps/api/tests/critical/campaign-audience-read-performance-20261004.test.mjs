/**
 * Composer audience READ PERFORMANCE (2026-10-04) — the numbers must not move.
 *
 *  - the funnel counted in one statement (campaign_target_graph_funnel_counts)
 *    equals the per-bucket counts, bucket for bucket, because the predicate is
 *    recorded from the same builder code, never re-written;
 *  - anything the recorder can't express exactly falls back (null), never
 *    approximates;
 *  - the population probe asks only for the columns a request consults, and
 *    its verdicts for those columns are unchanged.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { previewCampaignTargets, countCampaignAudienceCohort } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { recordGraphPredicate, readGraphFunnelCounts, GRAPH_FUNNEL_RPC, _resetGraphFunnelRpcState } from "@/lib/domain/campaigns/campaign-graph-funnel.js";
import { COLUMN_MISSING, graphPlanColumns, loadGraphColumnPopulation, resetGraphColumnPopulationCache } from "@/lib/domain/campaigns/campaign-graph-filter-plan.js";
import { DRAWN_AREA_FIELD_KEY } from "@/lib/domain/campaigns/campaign-drawn-area.js";
import { makeCampaignQueuePlanStore } from "../helpers/campaign-queue-plan-store.mjs";

const MPLS = "Minneapolis, MN";
const DALLAS = "Dallas, TX";

function graphRow(index, overrides = {}) {
  return {
    graph_id: `graph_${String(index).padStart(3, "0")}`,
    property_id: `prop_${index}`,
    master_owner_id: `mo_${index}`,
    prospect_id: null,
    seller_person_key: `person_${index}`,
    canonical_e164: `+1555300${String(1000 + index).slice(-4)}`,
    market: MPLS,
    state: "MN",
    property_type: "Single Family",
    sms_eligible: true,
    true_post_contact_suppression: false,
    wrong_number: false,
    pending_prior_touch: false,
    active_queue_item: false,
    sender_covered: true,
    sender_market: MPLS,
    timezone: "America/Chicago",
    identity_alignment: "verified",
    acquisition_score: 50 + index,
    seller_first_name: "Ana",
    touch_count: 0,
    never_contacted: true,
    queue_eligible: true,
    queue_block_reason: null,
    ...overrides,
  };
}

/** A varied audience: every funnel bucket is non-trivial. */
function seedGraph(store) {
  let i = 0;
  const add = (overrides) => store.seedRow("campaign_target_graph", graphRow(++i, overrides));
  for (let k = 0; k < 6; k += 1) add({});
  add({ queue_eligible: false, sms_eligible: false, queue_block_reason: "SMS_INELIGIBLE" });
  add({ canonical_e164: null, sms_eligible: false, queue_eligible: false });
  add({ true_post_contact_suppression: true, queue_eligible: false });
  add({ wrong_number: true, queue_eligible: false });
  add({ pending_prior_touch: true, queue_eligible: false });
  add({ active_queue_item: true, queue_eligible: false });
  add({ sender_covered: false, queue_eligible: false });
  add({ master_owner_id: null, prospect_id: "p_1" });
  add({ property_id: null });
  add({ market: DALLAS, state: "TX" });
  add({ market: DALLAS, state: "TX", sender_covered: false, queue_eligible: false });
  add({ property_type: "Apartment" });
}

const cmp = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y) && String(a).trim() !== "" && String(b).trim() !== "") return x - y;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

/** Evaluates a predicate with SQL semantics (NULL matches no comparison). */
function matches(row, predicate) {
  return predicate.every((clause) => {
    const value = row[clause.column] ?? null;
    switch (clause.op) {
      case "eq": return value !== null && String(value) === String(clause.value);
      case "neq": return value !== null && String(value) !== String(clause.value);
      case "gt": return value !== null && cmp(value, clause.value) > 0;
      case "gte": return value !== null && cmp(value, clause.value) >= 0;
      case "lt": return value !== null && cmp(value, clause.value) < 0;
      case "lte": return value !== null && cmp(value, clause.value) <= 0;
      case "in": return value !== null && clause.values.map(String).includes(String(value));
      case "is_null": return value === null;
      case "not_null": return value !== null;
      default: throw new Error(`unexpected op ${clause.op}`);
    }
  });
}

/**
 * The graph read with PostgREST's real semantics (the shared fixture ignores
 * `.not()`): every builder call is recorded and evaluated with SQL NULL rules,
 * order/range/limit applied, `count: exact` honoured. Other tables: the store.
 */
function faithfulGraphQuery(rows) {
  const predicate = [];
  const orders = [];
  let from = 0;
  let to = null;
  let countOpt = null;
  const push = (op, column, extra) => { predicate.push({ op, column, ...extra }); return api; };
  const api = {
    select(_cols, opts) { if (opts?.count) countOpt = opts; return api; },
    eq: (c, v) => push("eq", c, { value: v }),
    neq: (c, v) => push("neq", c, { value: v }),
    gt: (c, v) => push("gt", c, { value: v }),
    gte: (c, v) => push("gte", c, { value: v }),
    lt: (c, v) => push("lt", c, { value: v }),
    lte: (c, v) => push("lte", c, { value: v }),
    in: (c, v) => push("in", c, { values: v }),
    is(c, v) { if (v !== null) throw new Error("is() non-null unsupported in fixture"); return push("is_null", c); },
    not(c, op, v) { if (op !== "is" || v !== null) throw new Error("not() unsupported in fixture"); return push("not_null", c); },
    order(col, opts = {}) { orders.push({ col, asc: opts.ascending !== false, nullsFirst: opts.nullsFirst === true }); return api; },
    range(a, b) { from = a; to = b; return api; },
    limit(n) { to = from + n - 1; return api; },
    then(resolve, reject) {
      let out = rows().filter((row) => matches(row, predicate));
      const count = out.length;
      if (orders.length) {
        out = [...out].sort((a, b) => {
          for (const { col, asc, nullsFirst } of orders) {
            const x = a[col] ?? null;
            const y = b[col] ?? null;
            if (x === y) continue;
            if (x === null) return nullsFirst ? -1 : 1;
            if (y === null) return nullsFirst ? 1 : -1;
            const d = typeof x === "boolean" ? Number(x) - Number(y) : cmp(x, y);
            if (d !== 0) return asc ? d : -d;
          }
          return 0;
        });
      }
      out = out.slice(from, to === null ? undefined : to + 1);
      const data = countOpt?.head ? null : out.map((row) => ({ ...row }));
      return Promise.resolve({ data, count: countOpt ? count : null, error: null }).then(resolve, reject);
    },
  };
  return api;
}

function faithful(store, { calls = null } = {}) {
  const base = store.supabase;
  const graphRows = () => store.table("campaign_target_graph").rows;
  return {
    from: (table) => (table === "campaign_target_graph" ? faithfulGraphQuery(graphRows) : base.from(table)),
    rpc(name, params) {
      if (name !== GRAPH_FUNNEL_RPC || !calls) return base.rpc(name, params);
      calls.push(params);
      const rows = graphRows().filter((row) => matches(row, params.p_base));
      const data = Object.fromEntries(Object.entries(params.p_buckets).map(([key, predicate]) => [key, rows.filter((row) => matches(row, predicate)).length]));
      const result = { data, error: null };
      return { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
    },
  };
}

const FUNNEL_FIELDS = ["total_matched", "filter_matched", "addressable_properties", "sms_eligible_phones", "clean_targets", "ready_to_queue", "blocked", "blocked_counts_by_reason", "reach"];
const funnelOf = (preview) => Object.fromEntries(FUNNEL_FIELDS.map((key) => [key, preview[key]]));

const marketFilter = (markets) => ({ properties: [{ field_key: "properties.market", operator: "is_any_of", value: markets }] });

for (const [label, filters] of [
  ["market only (Minneapolis)", marketFilter([MPLS])],
  ["two markets (Minneapolis + Dallas)", marketFilter([MPLS, DALLAS])],
  ["market + property type", { properties: [...marketFilter([MPLS]).properties, { field_key: "properties.property_type", operator: "is_any_of", value: ["Single Family"] }] }],
]) {
  test(`one-statement funnel equals the per-bucket counts: ${label}`, async () => {
    _resetGraphFunnelRpcState();
    const store = makeCampaignQueuePlanStore();
    seedGraph(store);
    const slow = await previewCampaignTargets({ source: "campaign_target_graph", filters, build_limit: 1000 }, { supabase: faithful(store) });
    const calls = [];
    const fast = await previewCampaignTargets({ source: "campaign_target_graph", filters, build_limit: 1000 }, { supabase: faithful(store, { calls }) });
    assert.equal(calls.length, 1, "the funnel was counted by the rpc, once");
    assert.ok(Number(slow.total_matched) > 0, "the audience is not empty");
    assert.deepEqual(funnelOf(fast), funnelOf(slow));
    assert.equal(fast.build_simulation.ready, slow.build_simulation.ready);
  });
}

test("the recorded audience predicate is the builder's own calls, as data", () => {
  const predicate = recordGraphPredicate((q) => q.not("property_id", "is", null).in("market", [MPLS]).eq("queue_eligible", true).gte("acquisition_score", 60).is("canonical_e164", null));
  assert.deepEqual(predicate, [
    { op: "not_null", column: "property_id" },
    { op: "in", column: "market", values: [MPLS] },
    { op: "eq", column: "queue_eligible", value: true },
    { op: "gte", column: "acquisition_score", value: 60 },
    { op: "is_null", column: "canonical_e164" },
  ]);
});

test("anything without an exact translation refuses the fast path (never approximates)", () => {
  assert.equal(recordGraphPredicate((q) => q.ilike("podio_tags", "%equity%")), null);
  assert.equal(recordGraphPredicate((q) => q.or("a.is.null,b.eq.1")), null);
  assert.equal(recordGraphPredicate((q) => q.filter("podio_tags", "imatch", "x")), null);
  assert.equal(recordGraphPredicate((q) => q.not("market", "in", "(a,b)")), null);
  assert.equal(recordGraphPredicate((q) => q.in("market", [])), null);
  assert.equal(recordGraphPredicate((q) => q.eq("market", null)), null);
  assert.equal(recordGraphPredicate((q) => q.is("sms_eligible", true)), null);
  assert.equal(recordGraphPredicate((q) => q.eq("bad column", "x")), null);
});

test("a missing rpc (PGRST202) is remembered; the fallback is used without re-asking", async () => {
  _resetGraphFunnelRpcState();
  let asked = 0;
  const supabase = { rpc: async () => { asked += 1; return { data: null, error: { code: "PGRST202", message: "Could not find the function" } }; } };
  const args = { supabase, base: (q) => q.in("market", [MPLS]), buckets: [{ key: "total", apply: (q) => q }], now: 1_000 };
  assert.equal(await readGraphFunnelCounts(args), null);
  assert.equal(await readGraphFunnelCounts({ ...args, now: 2_000 }), null);
  assert.equal(asked, 1);
  assert.equal(await readGraphFunnelCounts({ ...args, now: 1_000 + 6 * 60 * 1000 }), null);
  assert.equal(asked, 2, "asked again after the back-off");
});

test("a malformed rpc answer is not a count", async () => {
  _resetGraphFunnelRpcState();
  const supabase = { rpc: async () => ({ data: { total: "n/a" }, error: null }) };
  assert.equal(await readGraphFunnelCounts({ supabase, base: (q) => q, buckets: [{ key: "total", apply: (q) => q }] }), null);
});

test("whole cohort: counting concurrently with the reads returns the same cohort", async () => {
  const store = makeCampaignQueuePlanStore();
  seedGraph(store);
  const cohort = await countCampaignAudienceCohort({ filters: marketFilter([MPLS]), template_use_case: "ownership_check", stage_code: "S1" }, { supabase: faithful(store) });
  assert.equal(cohort.ok, true, cohort.error);
  const eligible = store.table("campaign_target_graph").rows.filter((row) => row.market === MPLS && row.queue_eligible && row.property_id).length;
  assert.equal(cohort.queue_eligible_in_audience, eligible);
  assert.equal(cohort.rows_read, eligible);
});

test("population probe: only the consulted columns are asked, verdicts unchanged", async () => {
  resetGraphColumnPopulationCache();
  const asked = [];
  const supabase = {
    from() {
      const q = {
        _col: null,
        _head: false,
        select(cols, opts) { q._head = Boolean(opts?.head); if (!opts) q._col = cols; return q; },
        not(col) { q._col = col; return q; },
        limit() {
          asked.push(q._col);
          if (q._col === "beds") return Promise.resolve(q._head ? { count: null, error: { message: "", code: "" } } : { data: null, error: { code: "42703", message: "column campaign_target_graph.beds does not exist" } });
          return Promise.resolve(q._head ? { count: q._col === "income" ? 1 : 500, error: null } : { data: [], error: null });
        },
      };
      return q;
    },
  };
  const columns = graphPlanColumns([
    { field_key: "properties.market" },
    { field_key: DRAWN_AREA_FIELD_KEY },
    { field_key: "not.a.field" },
  ]);
  assert.deepEqual(columns, ["market"]);
  const scoped = await loadGraphColumnPopulation(supabase, { columns: ["market", "income", "beds"], now: 10 });
  assert.deepEqual([...new Set(asked)].sort(), ["beds", "income", "market"]);
  assert.equal(scoped.get("market"), true);
  assert.equal(scoped.get("income"), false);
  assert.equal(scoped.get("beds"), COLUMN_MISSING);
  // cached per column: asking again within the hour reads nothing
  const before = asked.length;
  const again = await loadGraphColumnPopulation(supabase, { columns: ["market"], now: 20 });
  assert.equal(asked.length, before);
  assert.equal(again.get("market"), true);
  // the full probe reuses the cached columns and fills the rest
  const full = await loadGraphColumnPopulation(supabase, { now: 30 });
  assert.equal(full.get("market"), true);
  assert.equal(full.get("beds"), COLUMN_MISSING);
  assert.equal(asked.filter((c) => c === "market").length, 1, "market probed once across all three calls");
  resetGraphColumnPopulationCache();
});

test("canonical languages: concurrent chunks are applied in order and stop at the first failed chunk, as before", async () => {
  const { fetchCanonicalLanguages } = await import("@/lib/domain/campaigns/campaign-recipient-metrics.js");
  const keys = Array.from({ length: 2200 }, (_, i) => `person_${i}`);
  const failChunk = 2; // keys 1000..1499
  let inFlight = 0;
  let maxInFlight = 0;
  const supabase = {
    from(table) {
      return {
        select() { return this; },
        async in(_col, ids) {
          inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          if (table !== "prospects") return { data: [], error: null };
          const index = Number(ids[0].split("_")[1]) / 500;
          if (index === failChunk) return { data: null, error: { message: "boom" } };
          return { data: ids.map((id) => ({ individual_key: id, language_preference: "Spanish", first_name: "Ana", full_name: "Ana D" })), error: null };
        },
      };
    },
  };
  const lookup = await fetchCanonicalLanguages(keys.map((k) => ({ seller_person_key: k })), { supabase });
  assert.ok(maxInFlight > 1, "chunks were read concurrently");
  assert.equal(lookup.personCount, 1000, "chunks 0 and 1 applied; the failed chunk and everything after it were not");
  assert.equal(lookup.resolve({ seller_person_key: "person_999" }).language, "Spanish");
  assert.equal(lookup.resolve({ seller_person_key: "person_1600" }).language, null);
});

test("recipient timezone: memoized zone validity gives the same answers", async () => {
  const { storedTimezoneToIana } = await import("@/lib/domain/queue/recipient-timezone.js");
  for (let i = 0; i < 3; i += 1) {
    assert.equal(storedTimezoneToIana("America/Chicago"), "America/Chicago");
    assert.equal(storedTimezoneToIana("Mars/Olympus"), null);
    assert.equal(storedTimezoneToIana("Central"), "America/Chicago");
    assert.equal(storedTimezoneToIana(""), null);
  }
});
