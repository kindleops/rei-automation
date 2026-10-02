/**
 * RC 7.1 D9b — "throttle to zero" must stop a campaign, never uncap it.
 *
 * Defect: PATCH /api/cockpit/campaigns/{id} with daily_cap: 0 stored NULL
 * (positive-int coercion + `|| null`), and the feeder's resolveFeedLimit read
 * `cap ? ... : Infinity`, so a live campaign throttled to 0 sent without a cap.
 *
 * Contract (campaign-caps.js): null = no cap of that kind; 0 = send nothing.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createCampaignQueuePlan, updateCampaign } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { feedCampaignBatch, resolveFeedLimit, classifyFeederProgress } from "@/lib/domain/campaigns/run-campaign-outbound-feeder.js";
import { capRemaining, parseCampaignCap, zeroCampaignCaps } from "@/lib/domain/campaigns/campaign-caps.js";
import { makeCampaignQueuePlanDeps, makeCampaignQueuePlanStore } from "../helpers/campaign-queue-plan-store.mjs";

const ID = "9799d345-06c7-46d8-9b4d-db8b8a4e2bdc";
const NOW = "2026-05-04T15:00:00.000Z"; // Monday 10:00 America/Chicago
const MARKET = "Houston, TX";

function campaignRow(overrides = {}) {
  return {
    id: ID, name: "Cap zero", status: "built", objective: "ownership_check", market: MARKET, state: "TX",
    auto_queue_enabled: true, auto_send_enabled: false, auto_reply_mode: "disabled", emergency_stop_at: null,
    daily_cap: 25, total_cap: 25, batch_max: 25, market_cap: 25, per_sender_cap: 25, send_interval_seconds: 60,
    contact_window_start: "09:00", contact_window_end: "20:00", language_policy: "auto", agent_persona: null,
    candidate_source: "campaign_target_graph", description: null, metadata: {}, scheduled_for: null,
    created_at: NOW, updated_at: NOW,
    ...overrides,
  };
}

function seeded(overrides = {}) {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", campaignRow(overrides));
  return store;
}

const row = (store) => store.rows("campaigns")[0];

// ── caps parsing ────────────────────────────────────────────────────────────

test("parseCampaignCap: 0 stays 0, unset is null, positive is truncated", () => {
  assert.equal(parseCampaignCap(0), 0);
  assert.equal(parseCampaignCap("0"), 0);
  assert.equal(parseCampaignCap(null), null);
  assert.equal(parseCampaignCap(undefined), null);
  assert.equal(parseCampaignCap(""), null);
  assert.equal(parseCampaignCap(12.7), 12);
  assert.equal(capRemaining(0, 0), 0);
  assert.equal(capRemaining(null, 99), Number.POSITIVE_INFINITY);
  assert.deepEqual(zeroCampaignCaps({ daily_cap: 0, total_cap: null, market_cap: 5, per_sender_cap: "0" }), ["daily_cap", "per_sender_cap"]);
});

// ── 1. PATCH persists 0 ─────────────────────────────────────────────────────

test("PATCH daily_cap: 0 persists 0 (not null)", async () => {
  const store = seeded({ daily_cap: 750 });
  const result = await updateCampaign(ID, { daily_cap: 0 }, { supabase: store.supabase });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed_fields, ["daily_cap"]);
  assert.equal(row(store).daily_cap, 0);
  assert.notEqual(row(store).daily_cap, null);
});

test("PATCH 0 persists 0 for every cap column (total, market, per-sender), as numbers or strings", async () => {
  const store = seeded({ daily_cap: 750, total_cap: 1000, market_cap: 400, per_sender_cap: 150 });
  const result = await updateCampaign(ID, { total_cap: 0, market_cap: "0", per_sender_cap: 0 }, { supabase: store.supabase });
  assert.equal(result.ok, true);
  assert.equal(row(store).total_cap, 0);
  assert.equal(row(store).market_cap, 0);
  assert.equal(row(store).per_sender_cap, 0);
  assert.equal(row(store).daily_cap, 750, "untouched");
});

test("PATCH 0 inside target_filters also persists 0", async () => {
  const store = seeded({ daily_cap: 750 });
  await updateCampaign(ID, { target_filters: { daily_cap: 0 } }, { supabase: store.supabase });
  assert.equal(row(store).daily_cap, 0);
});

test("PATCH with a negative or non-numeric cap is refused (it would have become null = uncapped)", async () => {
  const store = seeded({ daily_cap: 750 });
  for (const bad of [-1, "abc", true]) {
    const result = await updateCampaign(ID, { daily_cap: bad }, { supabase: store.supabase });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, "invalid_cap");
    assert.deepEqual(result.fields, ["daily_cap"]);
  }
  assert.equal(row(store).daily_cap, 750);
});

test("null behaviour unchanged: a positive cap writes; an empty string clears to null; an unrelated save keeps null", async () => {
  const store = seeded({ daily_cap: 750, total_cap: null });
  await updateCampaign(ID, { daily_cap: 300 }, { supabase: store.supabase });
  assert.equal(row(store).daily_cap, 300);
  await updateCampaign(ID, { daily_cap: "" }, { supabase: store.supabase });
  assert.equal(row(store).daily_cap, null);
  await updateCampaign(ID, { name: "renamed" }, { supabase: store.supabase });
  assert.equal(row(store).total_cap, null);
});

// ── 2. the feeder sends nothing at cap 0 ────────────────────────────────────

test("resolveFeedLimit: daily_cap 0 / total_cap 0 / per-sender 0 / market 0 -> limit 0", () => {
  for (const caps of [{ daily_cap: 0 }, { total_cap: 0 }, { per_sender_cap: 0 }, { market_cap: 0 }, { daily_cap: "0" }]) {
    const r = resolveFeedLimit({ campaign: caps, activeLiveRows: 0, readyRemaining: 500, committedTargets: 0, sentToday: 0 });
    assert.equal(r.limit, 0, JSON.stringify(caps));
    assert.equal(r.bound, "campaign_cap_zero", JSON.stringify(caps));
  }
  assert.equal(classifyFeederProgress({ readyRemaining: 500, feedBound: "campaign_cap_zero" }).state, "blocked");
});

test("resolveFeedLimit: null caps keep their meaning (no campaign cap; buffer/chunk bound)", () => {
  const r = resolveFeedLimit({ campaign: { daily_cap: null, total_cap: null }, activeLiveRows: 0, readyRemaining: 500 });
  assert.equal(r.limit, 100);
  assert.equal(r.bound, "buffer");
  assert.equal(r.daily_remaining, Number.POSITIVE_INFINITY);
  assert.equal(r.total_remaining, Number.POSITIVE_INFINITY);
  const capped = resolveFeedLimit({ campaign: { daily_cap: 30, total_cap: null }, activeLiveRows: 0, readyRemaining: 500, sentToday: 10 });
  assert.equal(capped.limit, 20);
});

/** Minimal PostgREST-shaped store for the feeder's counts. */
function feederStore(campaign) {
  const targets = Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, campaign_id: campaign.id, target_status: "ready" }));
  const queue = [];
  const supabase = {
    from(table) {
      const filters = [];
      let head = false;
      const rows = () => (table === "campaign_targets" ? targets : table === "send_queue" ? queue : [campaign]);
      const run = () => {
        const out = rows().filter((r) => filters.every((f) => f(r)));
        return head ? { count: out.length, error: null, data: null } : { data: out, error: null, count: out.length };
      };
      const b = {
        select(_c, opts = {}) { head = Boolean(opts.head); return b; },
        update() { return b; },
        eq(col, v) { filters.push((r) => (r[col] ?? campaign.id) === v); return b; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return b; },
        not(col, _op, list) { const vals = list.replace(/[()]/g, "").split(","); filters.push((r) => !vals.includes(r[col])); return b; },
        gte(col, v) { filters.push((r) => String(r[col]) >= v); return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle: async () => ({ data: run().data?.[0] || null, error: null }),
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return b;
    },
  };
  return { supabase, targets, queue };
}

async function feedOnce(campaign) {
  const store = feederStore(campaign);
  let planCalls = 0
  const result = await feedCampaignBatch(campaign, {
    supabase: store.supabase,
    now: Date.parse("2026-09-29T15:00:00Z"),
    createCampaignQueuePlan: async (_id, input) => {
      planCalls += 1;
      const take = store.targets.filter((t) => t.target_status === "ready").slice(0, input.limit);
      for (const t of take) { t.target_status = "planned"; store.queue.push({ id: `q${store.queue.length}`, campaign_id: campaign.id, queue_status: "scheduled", metadata: {} }); }
      return { ok: true, send_queue_rows_created: take.length, skipped_counts_by_reason: {}, blockers: [] };
    },
    recomputeCampaignProgress: async () => ({}),
    transitionCampaignStatus: async () => ({ ok: true }),
  });
  return { result, store, planCalls };
}

const liveCampaign = (caps) => ({
  id: "mpls", name: "Minneapolis", status: "active", auto_queue_enabled: true, batch_max: 50,
  daily_cap: 750, total_cap: 1000, market_cap: 400, per_sender_cap: 150, send_interval_seconds: 45,
  contact_window_start: "08:00", contact_window_end: "21:00", metadata: { timezone: "America/Chicago" },
  ...caps,
});

test("feeder: a live campaign at daily_cap 0 queues 0 rows and never calls the planner", async () => {
  const { result, store, planCalls } = await feedOnce(liveCampaign({ daily_cap: 0 }));
  assert.equal(planCalls, 0);
  assert.equal(store.queue.length, 0);
  assert.equal(result.inserted, 0);
  assert.equal(result.batch_limit, 0);
  assert.equal(result.bound, "campaign_cap_zero");
  assert.equal(result.completed, false, "a zero cap is a stop, not a finished cohort");
});

test("feeder: total_cap 0 also queues 0 rows", async () => {
  const { store, planCalls } = await feedOnce(liveCampaign({ total_cap: 0 }));
  assert.equal(planCalls, 0);
  assert.equal(store.queue.length, 0);
});

test("feeder: null caps are unchanged — it still refills (bounded by the buffer/chunk)", async () => {
  const { result, store } = await feedOnce(liveCampaign({ daily_cap: null, total_cap: null }));
  assert.equal(store.queue.length, 100);
  assert.equal(result.inserted, 100);
});

// ── the planner refuses a zero cap even when called directly ────────────────

function planStore(overrides) {
  const store = makeCampaignQueuePlanStore();
  store.seedRow("campaigns", campaignRow(overrides));
  store.seedRow("sms_templates", {
    id: "tpl_oc_en", template_id: "tpl_oc_en", is_active: true, use_case: "ownership_check", language: "English",
    stage_code: "S1", is_first_touch: true, template_body: "Hi {{seller_first_name}}, do you still own {{property_address}}?",
    allowed_property_groups: [], prohibited_property_groups: [],
  });
  store.seedRow("textgrid_numbers", {
    id: "tg_1", phone_number: "+15559990001", market_name: MARKET, status: "active", allow_nationwide_fallback: false,
    allow_cluster_fallback: false, is_nationwide: false, messages_sent_today: 0, last_used_at: null,
  });
  store.seedRow("campaign_targets", {
    id: "tgt_1", campaign_id: ID, target_status: "ready", priority_score: 50, master_owner_id: "mo_1", prospect_id: "pr_1",
    property_id: "prop_1", phone_id: "ph_1", to_phone_number: "+15551230001", market: MARKET, state: "TX",
    timezone: "America/Chicago", identity_status: "verified", owner_name: "John Smith", language: "English",
    property_address: "123 Main St, Houston, TX 77002",
    metadata: {
      candidate_snapshot: { seller_first_name: "John", seller_full_name: "John Smith", owner_display_name: "John Smith", property_address_full: "123 Main St, Houston, TX 77002", property_city: "Houston", property_zip: "77002" },
      outreach_snapshot: { never_contacted: true, touch_count: 0, true_post_contact_suppression: false, wrong_number: false, pending_prior_touch: false, active_queue_item: false },
    },
  });
  return store;
}

test("createCampaignQueuePlan: daily_cap 0 is a blocker and creates no rows (it used to fall back to batch_max)", async () => {
  const store = planStore({ daily_cap: 0 });
  const result = await createCampaignQueuePlan(ID, { now: NOW, first_scheduled_at: NOW, explicit_operator_action: true }, makeCampaignQueuePlanDeps(store));
  assert.ok(result.blockers.includes("campaign_cap_zero:daily_cap"), JSON.stringify(result.blockers));
  assert.ok(!result.blockers.some((b) => b.startsWith("missing_cap:")), "zero is set, not missing");
  assert.equal(Number(result.send_queue_rows_created || 0), 0);
  assert.equal(store.rows("send_queue").length, 0);
});

test("createCampaignQueuePlan: positive caps still plan (control)", async () => {
  const store = planStore({});
  const result = await createCampaignQueuePlan(ID, { now: NOW, first_scheduled_at: NOW, explicit_operator_action: true }, makeCampaignQueuePlanDeps(store));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.send_queue_rows_created, 1);
});
