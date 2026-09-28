import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  FEEDER_BUFFER_TARGET,
  FEEDER_HYDRATION_CHUNK,
  feedCampaignBatch,
  isCohortResolved,
  resolveFeedLimit,
  campaignDayStart,
} from "@/lib/domain/campaigns/run-campaign-outbound-feeder.js";
import {
  buildScheduledActivationRequest,
  isScheduleMissed,
} from "@/lib/domain/campaigns/campaign-activation-orchestrator.js";

/**
 * THE 50-MESSAGE CHOKE POINT (production, 2026-09-28).
 *
 * Minneapolis: 563 targets, 60 held, 503 eligible. The builder clamped
 * batch_max to 50 and the feeder used batch_max as its buffer, so 50 rows were
 * queued and the other 453 sellers sat `ready` with nothing to queue them.
 * These tests drive the real feeder cycle against an in-memory store: the queue
 * plan and the processor are simulated, the feeder's accounting is not.
 */

const DAY = 86_400_000;
const ACTIVE = new Set(["queued", "scheduled", "pending", "ready", "approved", "processing", "sending"]);

function makeStore({ ready = 0, blocked = 0, preQueued = 0, campaign = {} } = {}) {
  const targets = [];
  for (let i = 0; i < ready + preQueued; i += 1) targets.push({ id: `t${i}`, target_status: i < preQueued ? "planned" : "ready" });
  for (let i = 0; i < blocked; i += 1) targets.push({ id: `b${i}`, target_status: "blocked" });
  const queue = [];
  const store = {
    now: Date.parse("2026-09-29T15:00:00Z"),
    targets,
    queue,
    campaign: {
      id: "mpls",
      name: "Map area · Minneapolis",
      status: "active",
      auto_queue_enabled: true,
      batch_max: 50, // the stored clamp — must no longer bound anything
      daily_cap: 750,
      total_cap: 1000,
      market_cap: 400,
      per_sender_cap: 150,
      send_interval_seconds: 45,
      contact_window_start: "08:00",
      contact_window_end: "21:00",
      metadata: { timezone: "America/Chicago" },
      ...campaign,
    },
    transitions: [],
  };
  for (let i = 0; i < preQueued; i += 1) {
    queue.push({ id: `q${queue.length}`, campaign_id: "mpls", queue_status: "scheduled", scheduled_for: new Date(store.now).toISOString(), updated_at: new Date(store.now).toISOString(), metadata: {} });
  }
  return store;
}

/** Minimal PostgREST-shaped builder over the store. */
function fakeSupabase(store) {
  return {
    from(table) {
      const filters = [];
      let head = false;
      let order = null;
      let limitN = null;
      let patch = null;
      const rows = () => (table === "campaign_targets" ? store.targets : table === "send_queue" ? store.queue : [store.campaign]);
      const run = () => {
        let out = rows().filter((r) => filters.every((f) => f(r)));
        if (order) out = [...out].sort((a, b) => String(b[order] || "").localeCompare(String(a[order] || "")));
        if (limitN != null) out = out.slice(0, limitN);
        if (patch) {
          for (const r of out) Object.assign(r, patch);
          return { data: out, error: null };
        }
        return head ? { count: out.length, error: null, data: null } : { data: out, error: null, count: out.length };
      };
      const b = {
        select(_cols, opts = {}) { head = Boolean(opts.head); return b; },
        update(p) { patch = p; return b; },
        eq(col, v) { filters.push((r) => (col === "campaign_id" && table === "campaign_targets") || col === "campaign_id" ? (r.campaign_id ?? "mpls") === v : r[col] === v); return b; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return b; },
        not(col, _op, list) { const vals = list.replace(/[()]/g, "").split(","); filters.push((r) => !vals.includes(r[col])); return b; },
        gte(col, v) { filters.push((r) => String(r[col]) >= v); return b; },
        order(col) { order = col; return b; },
        limit(n) { limitN = n; return b; },
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] || null, error: null }; },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return b;
    },
  };
}

/**
 * Queue plan double: plans up to `limit` ready targets, subject to a window
 * that may be closed and a sender fleet with finite capacity per plan.
 */
function fakePlan(store, { windowOpen = () => true, senderCapacity = Infinity } = {}) {
  return async (_id, input) => {
    const skipped = {};
    if (!windowOpen()) {
      const n = store.targets.filter((t) => t.target_status === "ready").length;
      if (n) skipped.schedule_window_full = n;
      return { ok: true, send_queue_rows_created: 0, skipped_counts_by_reason: skipped, blockers: [] };
    }
    const ready = store.targets.filter((t) => t.target_status === "ready");
    const cap = Math.min(input.limit, senderCapacity);
    const take = ready.slice(0, cap);
    if (ready.length > take.length && senderCapacity < input.limit) skipped.per_sender_cap_reached = ready.length - take.length;
    for (const t of take) {
      t.target_status = "planned";
      store.queue.push({ id: `q${store.queue.length}`, campaign_id: "mpls", target_id: t.id, queue_status: "scheduled", scheduled_for: new Date(store.now).toISOString(), updated_at: new Date(store.now).toISOString(), metadata: { launch_mode: "guarded_live_queue_creation" } });
    }
    return { ok: true, send_queue_rows_created: take.length, skipped_counts_by_reason: skipped, blockers: [] };
  };
}

/** Processor double: sends up to `n` active rows, stamped at the store clock. */
function processorSends(store, n) {
  let sent = 0;
  for (const row of store.queue) {
    if (sent >= n) break;
    if (!ACTIVE.has(row.queue_status)) continue;
    row.queue_status = "sent";
    row.updated_at = new Date(store.now).toISOString();
    sent += 1;
  }
  return sent;
}

function deps(store, plan) {
  return {
    supabase: fakeSupabase(store),
    now: store.now,
    createCampaignQueuePlan: plan,
    recomputeCampaignProgress: async () => ({}),
    transitionCampaignStatus: async (_s, _id, to) => {
      store.transitions.push(to);
      store.campaign.status = to;
      return { ok: true };
    },
  };
}

const sentCount = (store) => store.queue.filter((r) => r.queue_status === "sent").length;

test("campaign size is not worker size: batch_max=50 no longer bounds the refill", () => {
  const campaign = { batch_max: 50, daily_cap: 750, total_cap: 1000 };
  const empty = resolveFeedLimit({ campaign, activeLiveRows: 0, readyRemaining: 453 });
  assert.equal(empty.limit, FEEDER_HYDRATION_CHUNK);
  // 50 queued used to mean "buffer satisfied". It is now just a partly full buffer.
  const fifty = resolveFeedLimit({ campaign, activeLiveRows: 50, readyRemaining: 453 });
  assert.equal(fifty.limit, Math.min(FEEDER_BUFFER_TARGET - 50, FEEDER_HYDRATION_CHUNK));
  assert.notEqual(fifty.bound, "buffer_full");
});

test("549 eligible, first chunk 50: the feeder carries the WHOLE cohort to sent", async () => {
  const store = makeStore({ ready: 499, preQueued: 50 });
  const plan = fakePlan(store);
  let cycles = 0;
  while (store.campaign.status === "active" && cycles < 200) {
    await feedCampaignBatch(store.campaign, deps(store, plan));
    processorSends(store, 20);
    store.now += 5 * 60 * 1000;
    cycles += 1;
  }
  assert.equal(sentCount(store), 549, "every eligible seller was sent, not 50");
  assert.equal(store.targets.filter((t) => t.target_status === "ready").length, 0);
  assert.deepEqual(store.transitions, ["completed"]);
  // never more than one queue row per target
  const ids = store.queue.map((r) => r.target_id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

test("563 audience / 60 held: 503 executed, 60 stay held, then complete", async () => {
  const store = makeStore({ ready: 453, preQueued: 50, blocked: 60 });
  const plan = fakePlan(store);
  let cycles = 0;
  while (store.campaign.status === "active" && cycles < 200) {
    await feedCampaignBatch(store.campaign, deps(store, plan));
    processorSends(store, 25);
    store.now += 5 * 60 * 1000;
    cycles += 1;
  }
  assert.equal(store.targets.length, 563);
  assert.equal(sentCount(store), 503);
  assert.equal(store.targets.filter((t) => t.target_status === "blocked").length, 60, "held targets are never forced");
  assert.equal(store.campaign.status, "completed");
});

test("the feeder does not complete a campaign because the queue is momentarily empty", async () => {
  const store = makeStore({ ready: 300 });
  const result = await feedCampaignBatch(store.campaign, deps(store, fakePlan(store)));
  assert.equal(result.completed, false);
  assert.ok(result.inserted > 0);
  assert.equal(store.campaign.status, "active");
});

test("multi-day: 1,500 eligible at 750/day finishes on day 2 without re-activation", async () => {
  const store = makeStore({ ready: 1500, campaign: { daily_cap: 750, total_cap: 2000 } });
  const plan = fakePlan(store);
  const day0 = store.now;
  let cycles = 0;
  while (store.campaign.status === "active" && cycles < 2000) {
    await feedCampaignBatch(store.campaign, deps(store, plan));
    processorSends(store, 30);
    store.now += 5 * 60 * 1000;
    cycles += 1;
  }
  // Bucket by the campaign's LOCAL day — the boundary the feeder paces against.
  const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" });
  const byDay = {};
  for (const r of store.queue.filter((q) => q.queue_status === "sent")) {
    const d = localDay.format(new Date(r.updated_at));
    byDay[d] = (byDay[d] || 0) + 1;
  }
  assert.ok(day0 > 0);
  assert.equal(sentCount(store), 1500);
  assert.ok(Object.values(byDay).every((n) => n <= 750), `daily cap held: ${JSON.stringify(byDay)}`);
  assert.ok(Object.keys(byDay).length >= 2, "the remainder carried into the next day");
  assert.equal(store.campaign.status, "completed");
});

test("contact window closed: remainder persists, campaign NOT completed, resumes next window", async () => {
  const store = makeStore({ ready: 200 });
  let open = false;
  const plan = fakePlan(store, { windowOpen: () => open });
  const closed = await feedCampaignBatch(store.campaign, deps(store, plan));
  assert.equal(closed.inserted, 0);
  assert.equal(closed.completed, false);
  assert.equal(store.campaign.status, "active");
  assert.equal(store.targets.filter((t) => t.target_status === "ready").length, 200);
  open = true;
  const reopened = await feedCampaignBatch(store.campaign, deps(store, plan));
  assert.ok(reopened.inserted > 0, "resumed in the next valid window");
});

test("sender capacity below the remainder: place what fits, keep the rest pending", async () => {
  const store = makeStore({ ready: 400 });
  const plan = fakePlan(store, { senderCapacity: 30 });
  const r = await feedCampaignBatch(store.campaign, deps(store, plan));
  assert.equal(r.inserted, 30);
  assert.equal(r.completed, false);
  assert.equal(store.targets.filter((t) => t.target_status === "ready").length, 370);
  processorSends(store, 30);
  const r2 = await feedCampaignBatch(store.campaign, deps(store, plan));
  assert.equal(r2.inserted, 30, "the next cycle continues");
});

test("completion only when every remaining target is permanently ineligible", () => {
  assert.equal(isCohortResolved({ readyRemaining: 0, activeLiveRows: 0 }), true);
  assert.equal(isCohortResolved({ readyRemaining: 0, activeLiveRows: 3 }), false, "rows still in flight");
  assert.equal(isCohortResolved({ readyRemaining: 5, skippedByReason: { prior_contacted_suppression: 5 } }), true);
  assert.equal(isCohortResolved({ readyRemaining: 5, skippedByReason: { schedule_window_full: 5 } }), false);
  assert.equal(isCohortResolved({ readyRemaining: 5, skippedByReason: { per_sender_cap_reached: 5 } }), false);
  assert.equal(isCohortResolved({ readyRemaining: 5, skippedByReason: {} }), false);
});

test("total_cap is the operator's intent and still bounds the campaign", () => {
  const r = resolveFeedLimit({ campaign: { total_cap: 400, daily_cap: 750 }, activeLiveRows: 0, readyRemaining: 100, committedTargets: 400 });
  assert.equal(r.limit, 0);
  assert.equal(r.bound, "total_cap_reached");
});

test("scheduled activation: real chunk (not 5) and a stale schedule is missed, never auto-fired", () => {
  assert.equal(buildScheduledActivationRequest({ id: "c", scheduled_for: "2026-09-29T14:10:00Z" }).batch_max, 100);
  const now = Date.parse("2026-09-28T13:00:00Z");
  assert.equal(isScheduleMissed({ scheduled_for: "2026-09-25T17:10:00Z" }, now), true);
  assert.equal(isScheduleMissed({ scheduled_for: "2026-09-28T12:30:00Z" }, now), false);
});

test("the day boundary is the campaign's local midnight, not the server's", () => {
  const now = new Date("2026-09-29T03:30:00Z"); // 22:30 CDT on the 28th
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  assert.equal(campaignDayStart(now, "America/Chicago", parts).toISOString(), "2026-09-28T05:00:00.000Z");
});

test("an active campaign with no audience is never auto-completed", async () => {
  const store = makeStore({ ready: 0 });
  const r = await feedCampaignBatch(store.campaign, deps(store, fakePlan(store)));
  assert.equal(r.completed, false);
  assert.equal(store.campaign.status, "active");
});
