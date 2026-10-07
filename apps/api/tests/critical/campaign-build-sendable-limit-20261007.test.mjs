// ─── campaign-build-sendable-limit-20261007.test.mjs ────────────────────────
// Owner bug (2026-10-07): the Composer / Schedule build applied the campaign
// send limit BEFORE sender routing, so sellers in markets with no sender route
// (Baltimore, Tulsa…) consumed limit slots: 4,345 eligible -> 783 "ready" ->
// 159 sendable today. planCampaignTargetRows (the ONE row planner Build, Reach's
// simulation and the whole-cohort count all call) now asks the planner's router
// per market before the slice: sendable recipients fill the limit first, no-route
// recipients follow and are counted.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { planCampaignTargetRows, planRecipientSendability } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { evaluateAudienceSenderCoverage } from "@/lib/domain/campaigns/campaign-launch-readiness.js";
import { makeCampaignQueuePlanStore } from "../helpers/campaign-queue-plan-store.mjs";

const NOW = "2026-10-07T15:00:00.000Z";

function graphRow(index, market, state, overrides = {}) {
  return {
    graph_id: `graph_${String(index).padStart(3, "0")}`,
    property_id: `prop_${index}`,
    master_owner_id: `mo_${index}`,
    seller_person_key: `person_${index}`,
    canonical_e164: `+1555300${String(1000 + index).slice(-4)}`,
    market,
    state,
    property_type: "Single Family",
    canonical_property_group: "Residential",
    language: null,
    sms_eligible: true,
    true_post_contact_suppression: false,
    wrong_number: false,
    pending_prior_touch: false,
    active_queue_item: false,
    sender_covered: true, // the graph's stale legacy projection said "covered"
    sender_market: market,
    timezone: "America/Chicago",
    identity_alignment: "verified",
    acquisition_score: 90 - index, // no-route sellers rank FIRST in the graph order below
    seller_first_name: "Ana",
    seller_full_name: "Ana Diaz",
    property_address_full: `${index} Main St`,
    touch_count: 0,
    never_contacted: true,
    queue_eligible: true,
    queue_block_reason: null,
    ...overrides,
  };
}

const campaign = { id: "camp_limit", name: "limit", status: "built", total_cap: 3, metadata: { stage_code: "S1" }, created_at: NOW };

// Baltimore and Tulsa first (higher score), then Dallas: the old slice took 3 no-route rows.
const ROWS = [
  graphRow(1, "Baltimore, MD", "MD"),
  graphRow(2, "Tulsa, OK", "OK"),
  graphRow(3, "Baltimore, MD", "MD"),
  graphRow(4, "Dallas, TX", "TX"),
  graphRow(5, "Dallas, TX", "TX"),
  graphRow(6, "Dallas, TX", "TX"),
  graphRow(7, "Dallas, TX", "TX"),
];

// The planner's own router, exact-market (Routing 2.0 off): only Dallas has a number.
const DALLAS_FLEET = [
  { id: "dal-1", phone_number: "+14693131600", market: "Dallas, TX", status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0 },
];
const routerDeps = (store) => ({
  supabase: store.supabase,
  textgridNumberRows: DALLAS_FLEET,
  loadDispatchBlockedSets: async () => ({ template_ids: new Set(), sender_numbers: new Set() }),
});

test("the send limit is filled with SENDABLE sellers first; no-route sellers follow and are counted", async () => {
  const store = makeCampaignQueuePlanStore();
  const planned = await planCampaignTargetRows({ campaign, options: {}, graph: { rows: ROWS }, targetLimit: 3, deps: routerDeps(store), resolveLanguages: false });
  assert.deepEqual(planned.rows.map((row) => row.market), ["Dallas, TX", "Dallas, TX", "Dallas, TX"]);
  assert.equal(planned.summary.built, 3);
  assert.equal(planned.summary.sender_routing_evaluated, true);
  assert.equal(planned.summary.sendable_recipients, 4);
  assert.equal(planned.summary.no_sender_route_recipients, 3);
  assert.deepEqual(planned.summary.no_sender_route_by_market, { "Baltimore, MD": 2, "Tulsa, OK": 1 });
  assert.equal(planned.summary.no_sender_route_in_build, 0);
  assert.equal(planned.summary.ready_sendable, planned.summary.ready);
});

test("Build and the cohort agree: every built ready row is sendable by the same router", async () => {
  const store = makeCampaignQueuePlanStore();
  const deps = routerDeps(store);
  const planned = await planCampaignTargetRows({ campaign, options: {}, graph: { rows: ROWS }, targetLimit: 3, deps, resolveLanguages: false });
  const ready = planned.rows.filter((row) => row.target_status === "ready");
  const senders = await evaluateAudienceSenderCoverage(ready, deps);
  assert.equal(senders.sendable_now, planned.summary.ready_sendable);
  assert.equal(senders.no_sendable_number, 0);
});

test("when the limit has room, no-route sellers are still built AFTER every sendable one (nothing silently dropped)", async () => {
  const store = makeCampaignQueuePlanStore();
  const planned = await planCampaignTargetRows({ campaign, options: {}, graph: { rows: ROWS }, targetLimit: 10, deps: routerDeps(store), resolveLanguages: false });
  const markets = planned.rows.map((row) => row.market);
  assert.deepEqual(markets.slice(0, 4), ["Dallas, TX", "Dallas, TX", "Dallas, TX", "Dallas, TX"]);
  assert.deepEqual(markets.slice(4).sort(), ["Baltimore, MD", "Baltimore, MD", "Tulsa, OK"]);
  assert.equal(planned.summary.no_sender_route_in_build, 3);
  assert.equal(planned.summary.ready_sendable, 4);
});

test("with Routing 2.0 the router's answer changes, not the planner: a regional route makes Tulsa sendable", async () => {
  const store = makeCampaignQueuePlanStore();
  const deps = {
    ...routerDeps(store),
    // stands in for the v2 router: Dallas covers Oklahoma (owner 2026-10-02 / 10-07)
    evaluateRecipientSendability: async (rows) => ({
      markets: [...new Set(rows.map((r) => r.market))].map((market) => ({ market, sendable: market !== "Baltimore, MD" })),
    }),
  };
  const planned = await planCampaignTargetRows({ campaign, options: {}, graph: { rows: ROWS }, targetLimit: 3, deps, resolveLanguages: false });
  // ranked order kept within the sendable group: Tulsa (score 88) before the Dallas rows
  assert.deepEqual(planned.rows.map((row) => row.market), ["Tulsa, OK", "Dallas, TX", "Dallas, TX"]);
  assert.equal(planned.summary.no_sender_route_recipients, 2);
});

test("a router that cannot answer never reorders or drops anyone (unknown is not unsendable)", async () => {
  const failing = await planRecipientSendability([{ market: "Dallas, TX" }], { evaluateRecipientSendability: async () => { throw new Error("down"); } });
  assert.equal(failing.evaluated, false);
  const store = makeCampaignQueuePlanStore();
  const planned = await planCampaignTargetRows({
    campaign, options: {}, graph: { rows: ROWS }, targetLimit: 3, resolveLanguages: false,
    deps: { supabase: store.supabase, evaluateRecipientSendability: async (rows) => ({ markets: [...new Set(rows.map((r) => r.market))].map((market) => ({ market, sendable: null })) }) },
  });
  assert.deepEqual(planned.rows.map((row) => row.market), ["Baltimore, MD", "Tulsa, OK", "Baltimore, MD"]);
  assert.equal(planned.summary.no_sender_route_recipients, 0);
});
