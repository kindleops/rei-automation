/**
 * SENDER ROUTING 2.0 — policy, gate, park/wake, inventory truth, coverage.
 * Owner brief §D.4. No network: every dependency is injected.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  AFFINITY_TIERS as T,
  HOLD_REASON,
  PURPOSES,
  buildRoutingGraph,
  evaluateSenderEligibility,
  routeLabel,
  selectSender,
} from "@/lib/domain/routing/sender-routing/sender-routing-policy.js";
import { senderRoutingCeiling, isSenderRoutingFlagEnabled, SENDER_ROUTING_FLAGS } from "@/lib/domain/routing/sender-routing/sender-routing-gate.js";
import { routeCandidateViaPolicy, routeQueueRowViaPolicy } from "@/lib/domain/routing/sender-routing/sender-routing-runtime.js";
import { inventoryFingerprint, reevaluateParkedSends, runWakeSweep } from "@/lib/domain/routing/sender-routing/sender-routing-wake.js";
import { reconcileInventory, INVENTORY_STATES, WEBHOOK_STATES, proposedEvidenceBackfill } from "@/lib/domain/routing/sender-routing/sender-inventory-reconciliation.js";
import { computeCoverage, previewRouteEdit, COVERAGE_STATUS } from "@/lib/domain/routing/sender-routing/sender-coverage.js";
import { PROPOSED_POOLS, PROPOSED_ROUTES, proposedGraphRows } from "@/lib/domain/routing/sender-routing/proposed-initial-graph.js";
import { byUsageThenRecency } from "@/lib/domain/routing/sender-routing/sender-allocator.js";
import { loadBlocked } from "@/lib/domain/routing/sender-routing/sender-routing-service.js";
import { chooseTextgridNumber } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import { selectAvailableTextgridNumber } from "@/lib/supabase/sms-engine.js";

const NOW = new Date("2026-10-02T18:00:00Z");

// ── fixtures ────────────────────────────────────────────────────────────────
const ready = (meta = {}) => ({ sms_webhook_status: "verified", ...meta });
function num(id, phone, market, extra = {}) {
  return {
    id,
    phone_number: phone,
    market,
    status: "active",
    health_state: "unverified",
    cooling_until: null,
    registration_status: "registered",
    daily_limit: 800,
    messages_sent_today: 0,
    last_used_at: null,
    ...extra,
    metadata: ready(extra.metadata),
  };
}
const MARKETS = [
  { id: "alpha-aa", display_name: "Alpha, AA" },
  { id: "beta-bb", display_name: "Beta, BB" },
  { id: "gamma-cc", display_name: "Gamma, CC" },
  { id: "delta-dd", display_name: "Delta, DD" },
];
// pools: A (home alpha), B (home beta), C (home gamma)
function graphRows({ routes, members } = {}) {
  return {
    markets: MARKETS,
    pools: [
      { pool_key: "pool_a", display_name: "Alpha Hub", home_market_id: "alpha-aa" },
      { pool_key: "pool_b", display_name: "Beta Hub", home_market_id: "beta-bb" },
      { pool_key: "pool_c", display_name: "Gamma Hub", home_market_id: "gamma-cc" },
    ],
    pool_numbers: members || [
      { pool_key: "pool_a", textgrid_number_id: "a1" },
      { pool_key: "pool_a", textgrid_number_id: "a2" },
      { pool_key: "pool_b", textgrid_number_id: "b1" },
      { pool_key: "pool_c", textgrid_number_id: "c1" },
    ],
    routes: routes || [
      { market_id: "alpha-aa", pool_key: "pool_a", priority: 10, affinity_tier: T.PRIMARY },
      { market_id: "alpha-aa", pool_key: "pool_b", priority: 20, affinity_tier: T.PREFERRED },
      { market_id: "alpha-aa", pool_key: "pool_c", priority: 30, affinity_tier: T.REGIONAL },
      { market_id: "delta-dd", pool_key: "pool_b", priority: 10, affinity_tier: T.PREFERRED },
      { market_id: "delta-dd", pool_key: "pool_c", priority: 20, affinity_tier: T.BLOCKED },
    ],
    version: 7,
    source: "fixture",
  };
}
const FLEET = () => [
  num("a1", "+15550000001", "Alpha, AA", { messages_sent_today: 50 }),
  num("a2", "+15550000002", "Alpha, AA", { messages_sent_today: 10 }),
  num("b1", "+15550000011", "Beta, BB", { messages_sent_today: 5 }),
  num("c1", "+15550000021", "Gamma, CC", { messages_sent_today: 0 }),
];
const graph = (o) => buildRoutingGraph(graphRows(o));
const pick = (input, { fleet = FLEET(), blocked = new Set(), g = graph(), per_sender_cap = 800 } = {}) =>
  selectSender({ market_id: "alpha-aa", purpose: PURPOSES.PROACTIVE, ...input }, { graph: g, fleet, blocked, now: NOW, per_sender_cap });
const down = (fleet, ids, patch = { status: "paused" }) => fleet.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r));

// ── selection order ─────────────────────────────────────────────────────────
test("exact market available -> its primary pool, least-used number within it", () => {
  const r = pick({});
  assert.equal(r.ok, true);
  assert.equal(r.pool_key, "pool_a");
  assert.equal(r.number.id, "a2", "allocator within the pool: least sent today");
  assert.equal(r.tier, T.PRIMARY);
  assert.equal(r.local, true);
  assert.equal(r.routing_tier, "exact_market_match");
});

test("exact down -> preferred fallback", () => {
  const r = pick({}, { fleet: down(FLEET(), ["a1", "a2"]) });
  assert.equal(r.pool_key, "pool_b");
  assert.equal(r.tier, T.PREFERRED);
  assert.equal(r.local, false);
  assert.equal(r.routing_tier, "approved_regional_fallback");
  assert.equal(r.label, "Sending via Beta Hub regional pool for Alpha");
});

test("preferred down -> regional fallback", () => {
  const r = pick({}, { fleet: down(FLEET(), ["a1", "a2", "b1"]) });
  assert.equal(r.pool_key, "pool_c");
  assert.equal(r.tier, T.REGIONAL);
});

test("all down -> HOLD no_eligible_sender_for_route with per-pool context", () => {
  const r = pick({}, { fleet: down(FLEET(), ["a1", "a2", "b1", "c1"]) });
  assert.equal(r.ok, false);
  assert.equal(r.held, true);
  assert.equal(r.hold_reason, HOLD_REASON);
  assert.equal(r.cause, "all_pools_ineligible");
  assert.deepEqual(r.pools_checked.map((p) => [p.pool_key, p.tier, p.pool_reason]), [
    ["pool_a", T.PRIMARY, "no_eligible_number"],
    ["pool_b", T.PREFERRED, "no_eligible_number"],
    ["pool_c", T.REGIONAL, "no_eligible_number"],
  ]);
  assert.ok(r.pools_checked.every((p) => p.numbers.every((n) => n.reason === "status_paused")));
});

test("priority order A/B/C: geography before load balancing", () => {
  // A and C healthy (C far less used) -> A wins
  const both = FLEET().map((r) => (r.id === "b1" ? { ...r, status: "paused" } : r.id.startsWith("a") ? { ...r, messages_sent_today: 700 } : r));
  assert.equal(pick({}, { fleet: both }).pool_key, "pool_a");
  // A down, B healthy, C less used -> B wins
  const aDown = down(FLEET(), ["a1", "a2"]).map((r) => (r.id === "b1" ? { ...r, messages_sent_today: 600 } : r));
  assert.equal(pick({}, { fleet: aDown }).pool_key, "pool_b");
});

test("blocked / cooling / paused / unregistered / webhook-unverified / retired / pre-production are skipped", () => {
  const cases = [
    [{ status: "paused" }, "status_paused"],
    [{ health_state: "cooling" }, "health_cooling"],
    [{ cooling_until: "2026-10-03T00:00:00Z" }, "cooling_until"],
    [{ registration_status: null }, "unregistered"],
    [{ metadata: { sms_webhook_status: "configured" } }, "webhook_unverified"],
    [{ metadata: { sms_webhook_status: "verified", lifecycle_state: "retired" } }, "retired"],
    [{ metadata: { sms_webhook_status: "verified", onboarding_stage: "configuring" } }, "onboarding_incomplete"],
  ];
  for (const [patch, reason] of cases) {
    const row = { ...num("x", "+15550009999", "Alpha, AA"), ...patch, metadata: { ...ready(), ...(patch.metadata || {}) } };
    assert.equal(evaluateSenderEligibility(row, { now: NOW }).reason, reason, JSON.stringify(patch));
  }
  const blocked = new Set(["+15550000002"]);
  const r = pick({}, { blocked });
  assert.equal(r.number.id, "a1", "operator-blocked a2 is skipped even though it is least used");
  assert.equal(r.pools_checked[0].numbers.find((n) => n.textgrid_number_id === "a2").reason, "blocked_by_operator");
  // cooling expired -> eligible again
  assert.equal(evaluateSenderEligibility({ ...num("x", "+15550009999", "Alpha, AA"), cooling_until: "2026-10-01T00:00:00Z" }, { now: NOW }).ok, true);
});

test("capacity exhausted -> next pool, pool_reason capacity_exhausted; warm-up limit is honoured", () => {
  const full = FLEET().map((r) => (r.id.startsWith("a") ? { ...r, messages_sent_today: 800 } : r));
  const r = pick({}, { fleet: full });
  assert.equal(r.pool_key, "pool_b");
  assert.equal(r.pools_checked[0].pool_reason, "capacity_exhausted");
  // per-number cap below daily_limit governs
  const capped = pick({}, { fleet: FLEET().map((r) => (r.id.startsWith("a") ? { ...r, messages_sent_today: 100 } : r)), per_sender_cap: 100 });
  assert.equal(capped.pool_key, "pool_b");
  const warming = num("w", "+15550000077", "Alpha, AA", { messages_sent_today: 25, metadata: { onboarding_stage: "warming", warmup_daily_limit: 25 } });
  assert.equal(evaluateSenderEligibility(warming, { now: NOW, per_sender_cap: 800 }).reason, "daily_limit_reached");
});

// ── thread continuity ───────────────────────────────────────────────────────
test("reply keeps the thread's number when eligible and routed, even below a healthy higher route", () => {
  const r = pick({ purpose: PURPOSES.REPLY, thread_number: "+15550000021" });
  assert.equal(r.decision, "thread_continuity");
  assert.equal(r.number.id, "c1");
  assert.equal(r.thread_reroute, null);
});

test("proactive keeps an established thread's number too (Option A); geography serves new conversations", () => {
  const kept = pick({ purpose: PURPOSES.PROACTIVE, thread_number: "+15550000021" });
  assert.equal(kept.decision, "thread_continuity");
  assert.equal(kept.number.id, "c1");
  const fresh = pick({ purpose: PURPOSES.PROACTIVE });
  assert.equal(fresh.pool_key, "pool_a", "a new conversation takes the highest-priority pool");
});

test("thread number fails -> fallback through the graph, reroute recorded", () => {
  const r = pick({ purpose: PURPOSES.REPLY, thread_number: "+15550000002" }, { blocked: new Set(["+15550000002"]) });
  assert.equal(r.ok, true);
  assert.equal(r.number.id, "a1");
  assert.equal(r.decision, "graph_route");
  assert.equal(r.thread_reroute.reason, "thread_number_blocked_by_operator");
  assert.equal(r.thread_reroute.to, "•••0001");
});

test("thread number fails and no fallback -> parked", () => {
  const r = selectSender({ market_id: "delta-dd", purpose: PURPOSES.REPLY, thread_number: "+15550000011" }, { graph: graph(), fleet: down(FLEET(), ["b1"]), blocked: new Set(), now: NOW });
  assert.equal(r.held, true);
  assert.equal(r.cause, "all_pools_ineligible");
  assert.equal(r.thread.reason, "status_paused");
  assert.deepEqual(r.pools_checked.map((p) => p.pool_key), ["pool_b"], "BLOCKED-NEVER pool_c is never checked");
});

test("a thread number in a BLOCKED-NEVER pool for the market is never kept", () => {
  const r = selectSender({ market_id: "delta-dd", purpose: PURPOSES.REPLY, thread_number: "+15550000021" }, { graph: graph(), fleet: FLEET(), blocked: new Set(), now: NOW });
  assert.equal(r.pool_key, "pool_b");
  assert.equal(r.thread_reroute.reason, "thread_number_pool_blocked_for_market");
});

test("unknown market and unrouted market hold; never a nationwide fallback", () => {
  assert.equal(pick({ market_id: null, market: "Nowhere, ZZ" }).cause, "market_unresolved");
  assert.equal(pick({ market_id: "beta-bb" }).cause, "market_has_no_routes");
  assert.equal(pick({ market_id: null, market: "Alpha, AA" }).pool_key, "pool_a", "labels resolve through the canonical registry");
});

test("operator override: audited only, never into BLOCKED-NEVER, still eligibility-gated", () => {
  assert.equal(pick({ override: { pool_key: "pool_c" } }).cause, "override_unaudited");
  const ok = pick({ override: { pool_key: "pool_c", actor: "ops@x", reason: "seller asked" } });
  assert.equal(ok.decision, "operator_override");
  assert.equal(ok.pool_key, "pool_c");
  const never = selectSender({ market_id: "delta-dd", override: { pool_key: "pool_c", actor: "ops@x", reason: "r" } }, { graph: graph(), fleet: FLEET(), now: NOW });
  assert.equal(never.cause, "override_pool_blocked_for_market");
  const unhealthy = pick({ override: { pool_key: "pool_c", actor: "ops@x", reason: "r" } }, { fleet: down(FLEET(), ["c1"]) });
  assert.equal(unhealthy.cause, "override_pool_ineligible");
});

test("duplicate inventory: a number listed in two pools is kept once and reported", () => {
  const g = graph({ members: [{ pool_key: "pool_a", textgrid_number_id: "a1" }, { pool_key: "pool_b", textgrid_number_id: "a1" }] });
  assert.equal(g.issues.filter((i) => i.code === "number_in_two_pools").length, 1);
  assert.deepEqual([...g.numbersByPool.keys()], ["pool_a"]);
});

test("route label is operator copy: local vs regional", () => {
  const g = graph();
  assert.equal(routeLabel(g, { pool_key: "pool_a", market_id: "alpha-aa" }), "Sending via Alpha Hub local pool");
  assert.equal(routeLabel(g, { pool_key: "pool_c", market_id: "alpha-aa" }), "Sending via Gamma Hub regional pool for Alpha");
});

test("the allocator is the feeder's (least sent today, then least recently used)", () => {
  const rows = [{ id: 1, messages_sent_today: 3, last_used_at: "2026-10-01" }, { id: 2, messages_sent_today: 1, last_used_at: "2026-10-02" }, { id: 3, messages_sent_today: 1, last_used_at: "2026-09-01" }];
  assert.deepEqual([...rows].sort(byUsageThenRecency).map((r) => r.id), [3, 2, 1]);
});

// ── the gate ────────────────────────────────────────────────────────────────
test("gate: env ceiling exact 'true'; runtime switch required; failures are OFF", async () => {
  assert.equal(senderRoutingCeiling({}), false);
  assert.equal(senderRoutingCeiling({ SENDER_ROUTING_V2_ENABLED: "1" }), false);
  assert.equal(senderRoutingCeiling({ SENDER_ROUTING_V2_ENABLED: "true" }), true);
  const env = { SENDER_ROUTING_V2_ENABLED: "true" };
  assert.equal((await isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env, readSystemValue: async () => "false" })).enabled, false);
  assert.equal((await isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env, readSystemValue: async () => { throw new Error("x"); } })).enabled, false);
  assert.equal((await isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env, readSystemValue: () => new Promise(() => {}), timeoutMs: 5 })).enabled, false);
  assert.equal((await isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env, readSystemValue: async () => "true" })).enabled, true);
  assert.equal((await isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env: {}, readSystemValue: async () => "true" })).enabled, false);
});

const LEGACY_ROWS = [
  { id: "m1", phone_number: "+16125550001", market: "Minneapolis, MN", status: "active", messages_sent_today: 4, last_used_at: "2026-10-01T00:00:00Z" },
  { id: "m2", phone_number: "+16125550002", market: "Minneapolis, MN", status: "active", messages_sent_today: 2, last_used_at: "2026-10-01T00:00:00Z" },
];
const gateOnDeps = (over = {}) => ({
  env: { SENDER_ROUTING_V2_ENABLED: "true" },
  readSystemFlag: async () => "true",
  loadGraphRows: async () => graphRows(),
  blocked_sender_numbers: [],
  per_sender_cap: 800,
  ...over,
});

test("gate OFF: the feeder router is unchanged (ceiling off, and ceiling on with runtime off, both fall through)", async () => {
  const candidate = { market: "Minneapolis, MN", state: "MN", touch_number: 2 };
  const options = { first_touch: false, blocked_sender_numbers: new Set() };
  const off = await chooseTextgridNumber(candidate, options, { textgridNumberRows: LEGACY_ROWS, env: {} });
  const runtimeOff = await chooseTextgridNumber(candidate, options, { textgridNumberRows: LEGACY_ROWS, env: { SENDER_ROUTING_V2_ENABLED: "true" }, readSystemFlag: async () => "false" });
  assert.deepEqual(runtimeOff, off);
  assert.equal(off.selected_textgrid_number, "+16125550002");
  assert.equal(off.routing_tier, "exact_market_match");
  // graph schema missing with the gate on -> legacy too
  const noSchema = await chooseTextgridNumber(candidate, options, { textgridNumberRows: LEGACY_ROWS, ...gateOnDeps({ loadGraphRows: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } }) });
  assert.deepEqual(noSchema, off);
});

test("gate ON: the feeder routes through the graph (campaign caller) and holds with context", async () => {
  const routed = await routeCandidateViaPolicy({ canonical_market_id: "alpha-aa", market: "Alpha, AA" }, { blocked_sender_numbers: new Set() }, { ...gateOnDeps(), loadFleet: async () => FLEET() });
  assert.equal(routed.ok, true);
  assert.equal(routed.selected_textgrid_number, "+15550000002");
  assert.equal(routed.selection_reason, "sender_routing_v2:graph_route:pool_a");
  const held = await routeCandidateViaPolicy({ canonical_market_id: "alpha-aa" }, { blocked_sender_numbers: new Set() }, { ...gateOnDeps(), loadFleet: async () => down(FLEET(), ["a1", "a2", "b1", "c1"]) });
  assert.equal(held.ok, false);
  assert.equal(held.hold_reason, HOLD_REASON);
  assert.equal(held.routing_block_reason, "NO_ELIGIBLE_SENDER_FOR_ROUTE");
  assert.match(held.hold_detail, /Alpha Hub \(primary\): no_eligible_number/);
});

test("gate ON: the same policy serves replies at dispatch — park without retry, keep, reroute", async () => {
  const row = { id: "q1", thread_key: "+19995550000", property_id: "p1", from_phone_number: "+15550000021", queue_status: "queued" };
  const deps = (fleet) => ({ ...gateOnDeps(), loadTextgridFleet: async () => fleet, loadPropertyMarketId: async () => "alpha-aa", auditSenderRouting: async () => null });
  const kept = await selectAvailableTextgridNumber(row, deps(FLEET()));
  assert.equal(kept.ok, true);
  assert.equal(kept.from_phone_number, "+15550000021");
  assert.equal(kept.reason, "sender_routing_v2_revalidated");
  const rerouted = await selectAvailableTextgridNumber(row, deps(down(FLEET(), ["c1"])));
  assert.equal(rerouted.ok, true);
  assert.equal(rerouted.from_phone_number, "+15550000002");
  const parked = await selectAvailableTextgridNumber(row, deps(down(FLEET(), ["a1", "a2", "b1", "c1"])));
  assert.equal(parked.ok, false);
  assert.equal(parked.ineligible_sender, true, "the runner blocks it (blocked_sender_ineligible), never a transport failure");
  assert.equal(parked.terminal, false);
  assert.equal(parked.reason, HOLD_REASON);
  // blocklist unreadable -> deferred, not sent
  const unreadable = await routeQueueRowViaPolicy(row, { ...deps(FLEET()), blocked_sender_numbers: undefined, getSystemValue: async () => { throw new Error("down"); } });
  assert.equal(unreadable.deferred, true);
});

test("gate OFF at dispatch: revalidation of the pinned sender is the legacy branch", async () => {
  const row = { id: "q1", from_phone_number: "+16125550001" };
  const r = await selectAvailableTextgridNumber(row, { env: {}, loadOutboundNumberByPhone: async () => ({ ...LEGACY_ROWS[0] }) });
  assert.equal(r.reason, "queue_row_from_phone_number_revalidated");
});

// ── park / wake ─────────────────────────────────────────────────────────────
test("inventory returns -> re-evaluation wakes the parked send (dry run writes nothing; apply needs both gates)", async () => {
  const parkedRow = { id: "q9", queue_status: "blocked_sender_ineligible", guard_reason: HOLD_REASON, market_id: "alpha-aa", from_phone_number: null, campaign_id: null, scheduled_for_utc: "2026-10-02T17:00:00Z" };
  const allDown = down(FLEET(), ["a1", "a2", "b1", "c1"], { health_state: "cooling" });
  const g = graph();
  assert.equal(reevaluateParkedSends({ rows: [parkedRow], graph: g, fleet: allDown, now: NOW })[0].outcome, "still_parked");
  const back = allDown.map((r) => (r.id === "b1" ? { ...r, health_state: "unverified" } : r));
  const woke = reevaluateParkedSends({ rows: [parkedRow], graph: g, fleet: back, now: NOW })[0];
  assert.equal(woke.outcome, "routable");
  assert.equal(woke.pool_key, "pool_b");
  assert.equal(woke.wake_status, "queued");
  assert.notEqual(inventoryFingerprint({ graph: g, fleet: allDown, now: NOW }), inventoryFingerprint({ graph: g, fleet: back, now: NOW }));

  const writes = [];
  const base = { now: NOW, loadGraph: async () => g, loadFleet: async () => back, loadBlocked: async () => new Set(), loadParkedRows: async () => [parkedRow], applyWake: async (id, status) => (writes.push([id, status]), true) };
  const off = await runWakeSweep({ trigger: "cooling_expired", apply: true }, { ...base, gates: { routing: false, wakeApply: true } });
  assert.equal(off.skipped, true);
  const dry = await runWakeSweep({ trigger: "cooling_expired", apply: true }, { ...base, gates: { routing: true, wakeApply: false } });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.routable, 1);
  assert.equal(writes.length, 0);
  const applied = await runWakeSweep({ trigger: "cooling_expired", apply: true }, { ...base, gates: { routing: true, wakeApply: true } });
  assert.deepEqual(writes, [["q9", "queued"]]);
  assert.equal(applied.writes, 1);
  const unchanged = await runWakeSweep({ trigger: "periodic" }, { ...base, gates: { routing: true, wakeApply: true }, lastFingerprint: applied.fingerprint });
  assert.equal(unchanged.reason, "inventory_unchanged");
});

// ── inventory truth ─────────────────────────────────────────────────────────
test("reconciliation: provider-only, local-only stale, matched, config mismatch, duplicates, webhook truth", () => {
  const WH = "https://ops.leadcommand.ai/api/webhooks/textgrid/inbound";
  const provider = [
    { phone_number: "+13175550001", sms_url: WH, campaign: "CHM4NL2" },
    { phone_number: "+16125550001", sms_url: WH, campaign: "CHM4NL2" },
    { phone_number: "+14705550001", sms_url: WH, campaign: "CHM4NL2" },
    { phone_number: "+17865550001", sms_url: "", campaign: null },
  ];
  const local = [
    { id: "1", phone_number: "+16125550001", status: "active", metadata: {} },
    { id: "2", phone_number: "+14705550001", status: "paused", metadata: { hold_reason: "not linked to 10DLC campaign CHM4NL2 yet" } },
    { id: "3", phone_number: "+13055550001", status: "paused", metadata: {} },
    { id: "4", phone_number: "+17865550001", status: "active", metadata: {} },
    { id: "5", phone_number: "+17865550001", status: "active", metadata: {} },
  ];
  const rep = reconcileInventory(provider, local, { inboundCounts: new Map([["+16125550001", 12]]) });
  const by = Object.fromEntries(rep.rows.map((r) => [r.phone, r]));
  assert.equal(by["+13175550001"].state, INVENTORY_STATES.PROVIDER_ONLY);
  assert.equal(by["+13175550001"].webhook_state, WEBHOOK_STATES.CONFIGURED_UNVERIFIED, "configured is not verified without inbound");
  assert.equal(by["+16125550001"].state, INVENTORY_STATES.MATCHED);
  assert.equal(by["+16125550001"].webhook_state, WEBHOOK_STATES.VERIFIED);
  assert.equal(by["+13055550001"].state, INVENTORY_STATES.LOCAL_ONLY);
  assert.equal(by["+14705550001"].state, INVENTORY_STATES.CONFIG_MISMATCH);
  assert.equal(by["+17865550001"].state, INVENTORY_STATES.CONFIG_MISMATCH);
  assert.ok(by["+17865550001"].flags.includes("duplicate_local"));
  assert.ok(by["+17865550001"].flags.includes("webhook_missing"));
  assert.equal(rep.totals.duplicates, 1);
  // provider not read -> never LOCAL_ONLY, webhook UNKNOWN
  const blind = reconcileInventory(null, [local[2]]);
  assert.equal(blind.rows[0].state, INVENTORY_STATES.MATCHED);
  assert.equal(blind.rows[0].webhook_state, WEBHOOK_STATES.UNKNOWN);
  // backfill writes only evidenced facts, never for a mismatch
  const bf = proposedEvidenceBackfill(rep);
  assert.deepEqual(bf.find((b) => b.phone === "+16125550001"), { phone: "+16125550001", registration_status: "registered", sms_webhook_status: "verified" });
  assert.equal(bf.find((b) => b.phone === "+14705550001").registration_status, null);
});

// ── coverage + configuration safety ────────────────────────────────────────
test("coverage statuses and metrics are factual", () => {
  const g = graph({ routes: [...graphRows().routes, { market_id: "gamma-cc", pool_key: "pool_c", priority: 10, affinity_tier: T.PRIMARY }] });
  const cov = computeCoverage({ graph: g, fleet: down(FLEET(), ["a1", "a2"]), now: NOW, per_sender_cap: 800 });
  const s = Object.fromEntries(cov.markets.map((m) => [m.market_id, m.status]));
  assert.equal(s["alpha-aa"], COVERAGE_STATUS.DEGRADED);
  assert.equal(s["gamma-cc"], COVERAGE_STATUS.LOCAL);
  assert.equal(s["delta-dd"], COVERAGE_STATUS.REGIONAL);
  assert.equal(s["beta-bb"], COVERAGE_STATUS.UNCOVERED);
  assert.equal(cov.metrics.healthy_senders, 2);
  assert.equal(cov.metrics.daily_capacity_remaining, 795 + 800);
});

test("route-edit impact preview: N become routable, N lose coverage", () => {
  const rows = [{ id: "r1", market_id: "delta-dd" }, { id: "r2", market_id: "delta-dd" }, { id: "x", market_id: "alpha-aa" }];
  const fleet = down(FLEET(), ["b1"]);
  const add = previewRouteEdit({ graph: graph(), market_id: "delta-dd", routes: [{ pool_key: "pool_b", tier: T.PREFERRED }, { pool_key: "pool_a", tier: T.REGIONAL }], rows, fleet, now: NOW });
  assert.equal(add.rows_considered, 2);
  assert.equal(add.became_routable, 2);
  assert.equal(add.coverage_before, COVERAGE_STATUS.UNCOVERED);
  assert.equal(add.coverage_after, COVERAGE_STATUS.DEGRADED);
  const remove = previewRouteEdit({ graph: graph(), market_id: "alpha-aa", routes: [], rows, fleet: FLEET(), now: NOW });
  assert.equal(remove.lost_coverage, 1);
});

// ── the proposal itself ─────────────────────────────────────────────────────
test("proposed graph: canonical-shaped, one pool per number, Miami 4780 excluded, pending numbers only after onboarding", () => {
  const phones = PROPOSED_POOLS.flatMap((p) => [...p.members, ...(p.pending_onboarding || [])]);
  assert.equal(new Set(phones).size, phones.length);
  assert.ok(!phones.includes("+13057604780"));
  const markets = Object.keys(PROPOSED_ROUTES).map((id) => ({ id, display_name: id }));
  const g = buildRoutingGraph(proposedGraphRows({ markets, fleet: [] }));
  assert.deepEqual(g.issues.filter((i) => i.code !== "pool_number_unresolved"), []);
  assert.equal((g.numbersByPool.get("indianapolis") || []).length, 0);
  const g2 = buildRoutingGraph(proposedGraphRows({ markets, fleet: [], includePending: true }));
  assert.equal(g2.numbersByPool.get("indianapolis").length, 1);
  for (const list of Object.values(PROPOSED_ROUTES)) for (const r of list) assert.ok(["owner", "proposal", "confirm"].includes(r.provenance));
});

test("service blocklist: the guard's Set-valued blocklist is honoured; unreadable is null (fail closed)", async () => {
  const values = { sms_blocked_sender_numbers: "+15550000002, 5550000011" };
  const set = await loadBlocked({ env: {}, getSystemValue: async (k) => values[k] ?? null });
  assert.deepEqual([...set].sort(), ["+15550000002", "+15550000011"]);
  assert.equal(await loadBlocked({ env: {}, getSystemValue: async () => { throw new Error("down"); } }), null);
});

// ── Campaign Composer preview ──────────────────────────────────────────────
import { previewAudienceSenderCoverage } from "@/lib/domain/routing/sender-routing/audience-coverage-preview.js";

test("Composer preview: gate OFF reports the legacy router as the engine, plus a labelled v2 preview; shared numbers counted once", async () => {
  const fleet = [
    { ...num("m1", "+16125550001", "Minneapolis, MN"), messages_sent_today: 100 },
    { ...num("m2", "+16125550002", "Minneapolis, MN"), messages_sent_today: 0 },
    { ...num("d1", "+14695550001", "Dallas, TX"), messages_sent_today: 0 },
    { ...num("l1", "+13235550001", "Los Angeles, CA") },
  ];
  const g = buildRoutingGraph({
    markets: [{ id: "minneapolis-mn", display_name: "Minneapolis, MN", state: "MN" }, { id: "omaha-ne", display_name: "Omaha, NE", state: "NE" }, { id: "phoenix-az", display_name: "Phoenix, AZ", state: "AZ" }],
    pools: [{ pool_key: "minneapolis", display_name: "Minneapolis", home_market_id: "minneapolis-mn" }, { pool_key: "los_angeles", display_name: "Los Angeles" }, { pool_key: "dallas", display_name: "Dallas" }],
    pool_numbers: [{ pool_key: "minneapolis", textgrid_number_id: "m1" }, { pool_key: "minneapolis", textgrid_number_id: "m2" }, { pool_key: "los_angeles", textgrid_number_id: "l1" }, { pool_key: "dallas", textgrid_number_id: "d1" }],
    routes: [
      { market_id: "minneapolis-mn", pool_key: "minneapolis", priority: 10, affinity_tier: T.PRIMARY },
      { market_id: "omaha-ne", pool_key: "minneapolis", priority: 10, affinity_tier: T.PREFERRED },
      { market_id: "phoenix-az", pool_key: "los_angeles", priority: 10, affinity_tier: T.PREFERRED },
      { market_id: "phoenix-az", pool_key: "dallas", priority: 20, affinity_tier: T.LAST_RESORT },
    ],
    version: 1,
  });
  const markets = [{ market_id: "minneapolis-mn", targets: 300 }, { market_id: "omaha-ne", targets: 50 }, { market_id: "phoenix-az", targets: 40 }];
  const out = await previewAudienceSenderCoverage({ markets, gate_enabled: false, graph: g, fleet, blocked: new Set(["+13235550001"]), per_sender_cap: 800, now: NOW });
  assert.equal(out.engine, "legacy_router");
  const legacyMpls = out.markets.find((m) => m.market === "Minneapolis, MN");
  assert.equal(legacyMpls.coverage, "LOCAL");
  assert.equal(legacyMpls.healthy_numbers, 2);
  assert.match(out.v2_preview.label, /NOT the engine/);
  const v2 = Object.fromEntries(out.v2_preview.markets.map((m) => [m.market_id, m]));
  assert.equal(v2["omaha-ne"].coverage, "REGIONAL");
  assert.equal(v2["omaha-ne"].shared_numbers, 2, "Omaha and Minneapolis share the Minneapolis numbers");
  assert.equal(v2["phoenix-az"].coverage, "DEGRADED");
  assert.equal(v2["phoenix-az"].serving_tier, T.LAST_RESORT);
  assert.equal(v2["phoenix-az"].unavailable[0].reasons[0].reason, "blocked_by_operator");
  assert.equal(out.v2_preview.totals.distinct_healthy_numbers, 3, "m1, m2, d1 — counted once across markets");
  assert.equal(out.v2_preview.totals.distinct_daily_capacity, 700 + 800 + 800);
  const on = await previewAudienceSenderCoverage({ markets, gate_enabled: true, graph: g, fleet, blocked: new Set(["+13235550001"]), per_sender_cap: 800, now: NOW });
  assert.equal(on.engine, "sender_routing_v2");
  assert.equal(on.v2_preview, null);
});
