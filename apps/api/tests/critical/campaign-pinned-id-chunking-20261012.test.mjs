/**
 * P0 2026-10-12 — HOT LEADS (1,484 pinned property ids) showed "Audience
 * couldn't be read — whole-cohort count failed — cohort_rows_unavailable".
 * The whole-cohort keyset worker inlined every pinned id into ONE PostgREST
 * `in.(…)` GET (~15 KB request line) and the gateway answered 400 Bad Request.
 *
 * Proven here with a gateway that refuses any request carrying more than the
 * cap: no audience reader (whole cohort, Reach preview, filter effects) sends
 * more than EXPLICIT_PROPERTY_CHUNK ids in one request, and every count is
 * exact — equal to a direct evaluation of the predicate over the graph.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  countCampaignAudienceCohort, previewCampaignTargets, measureCampaignFilterEffects,
  EXPLICIT_PROPERTY_CHUNK, explicitIdChunkParts,
} from "@/lib/domain/campaigns/campaign-automation-service.js";
import { _resetGraphFunnelRpcState } from "@/lib/domain/campaigns/campaign-graph-funnel.js";
import { makeCampaignQueuePlanStore } from "../helpers/campaign-queue-plan-store.mjs";

const MPLS = "Minneapolis, MN";
const CAP = 250; // the brief's hard ceiling; the code chunks at EXPLICIT_PROPERTY_CHUNK (≤ CAP)

const pid = (i) => String(210000000 + i);
function graphRow(i, overrides = {}) {
  return {
    graph_id: (i * 2654435761 % 2 ** 32).toString(16).padStart(8, "0") + String(i).padStart(6, "0"),
    property_id: pid(i),
    master_owner_id: `mo_${i}`,
    prospect_id: null,
    seller_person_key: `person_${i}`,
    canonical_e164: `+1555${String(1000000 + i).slice(-7)}`,
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
    acquisition_score: i % 97,
    seller_first_name: "Ana",
    touch_count: 0,
    never_contacted: true,
    queue_eligible: i % 7 !== 0,
    queue_block_reason: i % 7 !== 0 ? null : "SMS_INELIGIBLE",
    ...overrides,
  };
}

const cmp = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
function matches(row, predicate) {
  return predicate.every((c) => {
    const v = row[c.column] ?? null;
    switch (c.op) {
      case "eq": return v !== null && String(v) === String(c.value);
      case "gt": return v !== null && cmp(v, c.value) > 0;
      case "gte": return v !== null && (typeof v === "number" ? v >= Number(c.value) : cmp(v, c.value) >= 0);
      case "lt": return v !== null && cmp(v, c.value) < 0;
      case "lte": return v !== null && (typeof v === "number" ? v <= Number(c.value) : cmp(v, c.value) <= 0);
      case "in": return v !== null && c.values.has(String(v));
      case "is_null": return v === null;
      case "not_null": return v !== null;
      default: throw new Error(`unexpected op ${c.op}`);
    }
  });
}

/**
 * campaign_target_graph behind a gateway: a request whose `in` list exceeds
 * CAP ids is refused exactly as production refused it (400 Bad Request).
 */
function gatewayGraph(rows, stats) {
  return () => {
    const predicate = [];
    const orders = [];
    let from = 0;
    let to = null;
    let countOpt = null;
    let refused = false;
    const push = (op, column, extra) => { predicate.push({ op, column, ...extra }); return api; };
    const api = {
      select(_c, opts) { if (opts?.count) countOpt = opts; return api; },
      eq: (c, v) => push("eq", c, { value: v }),
      gt: (c, v) => push("gt", c, { value: v }),
      gte: (c, v) => push("gte", c, { value: v }),
      lt: (c, v) => push("lt", c, { value: v }),
      lte: (c, v) => push("lte", c, { value: v }),
      in(c, v) {
        stats.maxIn = Math.max(stats.maxIn, v.length);
        if (v.length > CAP) refused = true;
        return push("in", c, { values: new Set(v.map(String)) });
      },
      is(c, v) { if (v !== null) throw new Error("is() non-null"); return push("is_null", c); },
      not(c, op, v) { if (op !== "is" || v !== null) throw new Error("not() unsupported"); return push("not_null", c); },
      order(col, opts = {}) { orders.push({ col, asc: opts.ascending !== false }); return api; },
      range(a, b) { from = a; to = b; return api; },
      limit(n) { to = from + n - 1; return api; },
      then(resolve, reject) {
        stats.requests += 1;
        if (refused) {
          stats.refused += 1;
          return Promise.resolve({ data: null, count: null, error: { message: "Bad Request", code: "400" } }).then(resolve, reject);
        }
        let out = rows.filter((row) => matches(row, predicate));
        const count = out.length;
        if (orders.length) {
          out = [...out].sort((a, b) => {
            for (const { col, asc } of orders) {
              const x = a[col] ?? null;
              const y = b[col] ?? null;
              if (x === y) continue;
              if (x === null) return 1;
              if (y === null) return -1;
              const d = typeof x === "number" ? x - y : typeof x === "boolean" ? Number(x) - Number(y) : cmp(x, y);
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
  };
}

function world(pinnedCount) {
  const store = makeCampaignQueuePlanStore();
  // the pinned set plus properties outside it (must never leak in)
  const rows = Array.from({ length: pinnedCount + 300 }, (_, i) => graphRow(i + 1));
  for (const row of rows) store.seedRow("campaign_target_graph", row);
  const pinned = rows.slice(0, pinnedCount).map((row) => row.property_id);
  const stats = { maxIn: 0, requests: 0, refused: 0 };
  const graph = gatewayGraph(store.table("campaign_target_graph").rows, stats);
  const supabase = {
    from: (table) => (table === "campaign_target_graph" ? graph() : store.supabase.from(table)),
    rpc: (name, params) => store.supabase.rpc(name, params),
  };
  const set = new Set(pinned);
  const inPinned = rows.filter((row) => set.has(row.property_id));
  return {
    supabase,
    stats,
    filters: { properties: [{ field_key: "properties.property_id", operator: "is_any_of", value: pinned }] },
    expected: { total: inPinned.length, eligible: inPinned.filter((row) => row.queue_eligible).length },
  };
}

test("the chunker partitions any large explicit id list into ≤ cap disjoint parts", () => {
  assert.ok(EXPLICIT_PROPERTY_CHUNK <= CAP);
  const ids = Array.from({ length: 2_000 }, (_, i) => pid(i));
  const owners = Array.from({ length: 400 }, (_, i) => `mo_${i}`);
  const parts = explicitIdChunkParts({ catalog_filters: { supported: [
    { field_key: "properties.property_id", operator: "is_any_of", value: ids },
    { field_key: "properties.master_owner_id", operator: "is_any_of", value: owners },
  ] } });
  for (const part of parts) for (const f of part.catalog_filters.supported) assert.ok(f.value.length <= EXPLICIT_PROPERTY_CHUNK);
  // every (property id, owner id) pair lands in exactly one part: a partition
  const pairs = new Set();
  let total = 0;
  for (const part of parts) {
    const [p, o] = part.catalog_filters.supported;
    for (const a of p.value) for (const b of o.value) { pairs.add(`${a}|${b}`); total += 1; }
  }
  assert.equal(pairs.size, 2_000 * 400);
  assert.equal(total, 2_000 * 400, "no pair in two parts");
  assert.equal(explicitIdChunkParts({ catalog_filters: { supported: [{ field_key: "properties.property_id", operator: "is_any_of", value: ids.slice(0, 5) }] } }).length, 1);
});

test("the gateway fixture really refuses an over-cap request (the production 400)", async () => {
  const w = world(CAP + 1);
  const { error } = await w.supabase.from("campaign_target_graph").select("graph_id").in("property_id", w.filters.properties[0].value);
  assert.equal(error?.message, "Bad Request");
});

for (const n of [1484, 10_000]) {
  test(`${n.toLocaleString("en-US")} pinned ids: whole cohort reads in chunks, no request over the cap, exact count`, async () => {
    const w = world(n);
    const cohort = await countCampaignAudienceCohort({ filters: w.filters, template_use_case: "ownership_check", stage_code: "S1" }, { supabase: w.supabase });
    assert.equal(cohort.ok, true, `${cohort.error}: ${cohort.message}`);
    assert.equal(w.stats.refused, 0);
    assert.ok(w.stats.maxIn <= EXPLICIT_PROPERTY_CHUNK, `max in-list ${w.stats.maxIn}`);
    assert.equal(cohort.queue_eligible_in_audience, w.expected.eligible);
    assert.equal(cohort.rows_read, w.expected.eligible, "every eligible row read once — no duplicate, none missed");
  });

  test(`${n.toLocaleString("en-US")} pinned ids: Reach preview and filter effects count exactly through chunks`, async () => {
    _resetGraphFunnelRpcState();
    const w = world(n);
    const preview = await previewCampaignTargets({ source: "campaign_target_graph", filters: w.filters, build_limit: 1000 }, { supabase: w.supabase });
    assert.equal(w.stats.refused, 0);
    assert.ok(w.stats.maxIn <= EXPLICIT_PROPERTY_CHUNK);
    assert.equal(Number(preview.total_matched), w.expected.total);
    assert.equal(Number(preview.ready_to_queue), w.expected.eligible);
    const effects = await measureCampaignFilterEffects({ filters: w.filters }, { supabase: w.supabase });
    assert.equal(w.stats.refused, 0);
    assert.ok(w.stats.maxIn <= EXPLICIT_PROPERTY_CHUNK);
    const pinned = (effects.effects || []).find((e) => e.field_key === "properties.property_id");
    assert.ok(pinned, "the pinned filter is measured");
    assert.equal(pinned.count_after, w.expected.total);
    assert.equal(pinned.eligible_after, w.expected.eligible);
  });
}
