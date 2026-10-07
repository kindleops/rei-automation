// Sender Routing 2.0 r3 activation (owner regional map, 2026-10-07).
//
// 1. The r3 graph says what the owner said (and nothing he did not): every
//    canonical market is either routed or explicitly UNMAPPED; owner regions
//    map to the owner's pools in a justified priority order.
// 2. First touch through the real feeder router (the planner's / Composer
//    cohort's chooseTextgridNumber) with the gate ON: regional is normal, the
//    blocklist / cooling / onboarding / capacity always win, threads are sticky,
//    and the send-time health guard accepts a v2 regional first touch only when
//    allow_regional_fallback_for_first_touch is on.
// 3. The proposed coverage SQL (PROPOSED_20261007170000) is pinned to the JS
//    policy so the graph projection and the router cannot drift again.
// No network: every dependency is injected.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AFFINITY_TIERS as T, PURPOSES, buildRoutingGraph, evaluateSenderEligibility, selectSender } from "@/lib/domain/routing/sender-routing/sender-routing-policy.js";
import { PROPOSED_POOLS, PROPOSED_ROUTES, UNMAPPED_MARKETS, proposedGraphRows } from "@/lib/domain/routing/sender-routing/proposed-initial-graph.js";
import { isSenderRoutingFlagEnabled, SENDER_ROUTING_FLAGS } from "@/lib/domain/routing/sender-routing/sender-routing-gate.js";
import { chooseTextgridNumber } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import { evaluateSmsHealthGuard } from "@/lib/domain/delivery/sms-health-guard.js";
import { BLOCKING_HEALTH_STATE, BLOCKING_NUMBER_STATUS } from "@/lib/supabase/sms-engine.js";
import { buildParitySql, helperBody } from "../../scripts/ops/sender-routing/coverage-sql-parity.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.resolve(here, "../../../../supabase/migrations/PROPOSED_20261007170000_graph_sender_coverage_routing_v2.sql"), "utf8");
const NOW = new Date("2026-10-07T16:00:00Z");

// The 58 active canonical markets (canonical_markets, prod 2026-10-07).
const CANONICAL = ["birmingham-al", "phoenix-az", "tucson-az", "bakersfield-ca", "fresno-ca", "inland-empire-ca", "los-angeles-ca", "modesto-ca", "sacramento-ca", "san-diego-ca", "stockton-ca", "colorado-springs-co", "hartford-ct", "jacksonville-fl", "miami-fl", "orlando-fl", "tampa-fl", "atlanta-ga", "des-moines-ia", "boise-id", "chicago-il", "indianapolis-in", "wichita-ks", "louisville-ky", "new-orleans-la", "baltimore-md", "detroit-mi", "minneapolis-mn", "kansas-city-mo", "st-louis-mo", "charlotte-nc", "durham-nc", "fayetteville-nc", "rocky-mount-nc", "omaha-ne", "albuquerque-nm", "las-vegas-nv", "rochester-ny", "cincinnati-oh", "cleveland-oh", "columbus-oh", "oklahoma-city-ok", "tulsa-ok", "philadelphia-pa", "pittsburgh-pa", "providence-ri", "memphis-tn", "austin-tx", "dallas-tx", "el-paso-tx", "houston-tx", "san-antonio-tx", "salt-lake-city-ut", "hampton-roads-va", "richmond-va", "seattle-wa", "spokane-wa", "milwaukee-wi"];
const LABEL = (id) => {
  const parts = id.split("-");
  const st = parts.pop().toUpperCase();
  return `${parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(" ")}, ${st}`;
};
const MARKETS = CANONICAL.map((id) => ({ id, display_name: id === "st-louis-mo" ? "St. Louis, MO" : LABEL(id), state: id.slice(-2).toUpperCase() }));
const pools = (id) => (PROPOSED_ROUTES[id] || []).map((r) => r.pool_key);

// ── 1. the graph is the owner's map ─────────────────────────────────────────
test("r3 covers every canonical market exactly once: routed or explicitly unmapped", () => {
  const routed = Object.keys(PROPOSED_ROUTES);
  const unmapped = UNMAPPED_MARKETS.map((m) => m.market_id);
  assert.deepEqual([...routed, ...unmapped].sort(), [...CANONICAL].sort());
  assert.deepEqual(unmapped.sort(), ["louisville-ky", "memphis-tn", "new-orleans-la", "pittsburgh-pa", "rochester-ny"]);
  for (const list of Object.values(PROPOSED_ROUTES)) {
    assert.equal(new Set(list.map((r) => r.pool_key)).size, list.length, "no pool twice in a market");
    for (const r of list) assert.ok(PROPOSED_POOLS.some((p) => p.pool_key === r.pool_key), `unknown pool ${r.pool_key}`);
  }
});

test("a market with its own pool routes there first (primary); a market without one never claims primary", () => {
  for (const p of PROPOSED_POOLS) {
    const first = PROPOSED_ROUTES[p.home_market_id]?.[0];
    assert.equal(first?.pool_key, p.pool_key, `${p.home_market_id} first route`);
    assert.equal(first?.tier, T.PRIMARY);
  }
  const homes = new Set(PROPOSED_POOLS.map((p) => p.home_market_id));
  for (const [id, list] of Object.entries(PROPOSED_ROUTES)) if (!homes.has(id)) assert.notEqual(list[0].tier, T.PRIMARY, id);
});

test("owner 10-07 regions map to the owner's pools, in the justified order", () => {
  const WEST = ["inland-empire-ca", "sacramento-ca", "las-vegas-nv", "phoenix-az", "spokane-wa", "salt-lake-city-ut", "boise-id", "albuquerque-nm", "colorado-springs-co", "seattle-wa", "san-diego-ca", "tucson-az", "fresno-ca", "bakersfield-ca", "modesto-ca", "stockton-ca"];
  for (const id of WEST) {
    assert.deepEqual(pools(id), ["los_angeles", "dallas"], id);
    assert.equal(PROPOSED_ROUTES[id][1].tier, T.LAST_RESORT, `${id}: Dallas is last resort only (owner 10-02)`);
  }
  for (const id of ["austin-tx", "el-paso-tx", "oklahoma-city-ok", "tulsa-ok"]) assert.deepEqual(pools(id), ["dallas", "houston"], id);
  assert.deepEqual(pools("san-antonio-tx"), ["houston", "dallas"]);
  assert.deepEqual(pools("orlando-fl"), ["tampa", "miami"], "Miami or Tampa cover Orlando");
  assert.deepEqual(pools("birmingham-al"), ["jacksonville", "tampa", "miami"], "Florida numbers cover Alabama");
  assert.deepEqual(pools("chicago-il"), ["chicago", "indianapolis", "minneapolis"]);
  assert.deepEqual(pools("detroit-mi"), ["chicago", "indianapolis"]);
  assert.deepEqual(pools("cleveland-oh"), ["chicago", "indianapolis"]);
  assert.deepEqual(pools("cincinnati-oh"), ["indianapolis", "chicago"]);
  assert.deepEqual(pools("columbus-oh"), ["indianapolis", "chicago"]);
  for (const id of ["kansas-city-mo", "wichita-ks"]) assert.deepEqual(pools(id), ["st_louis", "minneapolis"], id);
  for (const id of ["des-moines-ia", "omaha-ne", "milwaukee-wi"]) assert.deepEqual(pools(id), ["minneapolis", "st_louis"], id);
  for (const id of ["durham-nc", "fayetteville-nc", "rocky-mount-nc", "richmond-va", "hampton-roads-va", "baltimore-md", "philadelphia-pa", "hartford-ct", "providence-ri"]) {
    assert.deepEqual(pools(id), ["charlotte", "atlanta"], id);
  }
  // Charlotte tiered: Carolinas / Virginia strong, farther Northeast weak
  assert.equal(PROPOSED_ROUTES["richmond-va"][0].tier, T.PREFERRED);
  assert.equal(PROPOSED_ROUTES["philadelphia-pa"][0].tier, T.LAST_RESORT);
});

// ── 2. first touch through the real router ──────────────────────────────────
const live = (id, phone, market, extra = {}) => ({
  id, phone_number: phone, market, status: "active", health_state: "unverified", cooling_until: null, registration_status: "registered",
  daily_limit: 800, messages_sent_today: 0, last_used_at: null, metadata: { sms_webhook_status: "verified" }, ...extra,
});
// The r3 fleet as it is today (blocked: LA 4544, Charlotte 5818, Miami 5670; Miami 2999 cooling;
// St. Louis webhook unverified; Atlanta 2/3 unregistered), plus Chicago CONFIGURING.
const FLEET = () => [
  live("mpls1", "+16128060495", "Minneapolis, MN"), live("mpls2", "+16125092382", "Minneapolis, MN"), live("mpls3", "+16125092623", "Minneapolis, MN"),
  live("stl", "+13149268488", "St. Louis, MO", { daily_limit: 100, metadata: { sms_webhook_status: "configured" } }),
  live("chi", "+18722547122", "Chicago, IL", { status: "paused", metadata: { onboarding_stage: "configuring", sms_webhook_status: "configured" } }),
  live("ind", "+13173494612", "Indianapolis, IN", { metadata: { onboarding_stage: "active", sms_webhook_status: "verified" } }),
  live("dal", "+14693131600", "Dallas, TX"), live("hou", "+12818458577", "Houston, TX"),
  live("la1", "+13234104544", "Los Angeles, CA"), live("la4", "+13235589881", "Los Angeles, CA"),
  live("atl1", "+14704920588", "Atlanta, GA"), live("atl2", "+14702936385", "Atlanta, GA", { registration_status: null }), live("atl3", "+14702936402", "Atlanta, GA", { registration_status: null }),
  live("clt1", "+17042405818", "Charlotte, NC"), live("clt2", "+19804589889", "Charlotte, NC"),
  live("jax", "+19048774448", "Jacksonville, FL"), live("tpa", "+18138947553", "Tampa, FL"),
  live("mia1", "+17866052999", "Miami, FL", { health_state: "cooling" }), live("mia2", "+13058975670", "Miami, FL"),
];
const BLOCKED = ["+13234104544", "+17042405818", "+13058975670"];
const graphRowsFor = (fleet, includePending = true) => proposedGraphRows({ markets: MARKETS, fleet, includePending });
const pick = (id, fleet = FLEET(), extra = {}) => selectSender({ market_id: id, purpose: PURPOSES.PROACTIVE, ...extra }, { graph: buildRoutingGraph(graphRowsFor(fleet)), fleet, blocked: new Set(BLOCKED), now: NOW, per_sender_cap: 800, ignore_daily_limit: extra.ignore_daily_limit ?? true });

test("first touch today: regional pools carry the owner's markets; blocked / cooling / unverified / CONFIGURING never send", () => {
  const cases = {
    "phoenix-az": ["los_angeles", "+13235589881"], // LA 4544 blocked -> LA #4
    "inland-empire-ca": ["los_angeles", "+13235589881"],
    "orlando-fl": ["tampa", "+18138947553"],
    "miami-fl": ["tampa", "+18138947553"], // 2999 cooling, 5670 blocked
    "oklahoma-city-ok": ["dallas", "+14693131600"],
    "san-antonio-tx": ["houston", "+12818458577"],
    "chicago-il": ["indianapolis", "+13173494612"], // Chicago CONFIGURING -> Indianapolis
    "detroit-mi": ["indianapolis", "+13173494612"],
    "cleveland-oh": ["indianapolis", "+13173494612"],
    "kansas-city-mo": ["minneapolis", null], // St. Louis webhook unverified -> Minneapolis
    "philadelphia-pa": ["charlotte", "+19804589889"], // 5818 blocked
    "atlanta-ga": ["atlanta", "+14704920588"], // Atlanta 2/3 unregistered
  };
  for (const [id, [pool, phone]] of Object.entries(cases)) {
    const r = pick(id);
    assert.equal(r.ok, true, `${id}: ${r.cause}`);
    assert.equal(r.pool_key, pool, id);
    if (phone) assert.equal(r.number.phone_number, phone, id);
    assert.ok(!BLOCKED.includes(r.number.phone_number));
  }
  assert.equal(pick("phoenix-az").routing_tier, "approved_regional_fallback");
  assert.equal(pick("dallas-tx").routing_tier, "exact_market_match");
});

test("onboarding moves traffic only by graph order: Chicago activated -> Chicago/Detroit/Cleveland; St. Louis verified -> KC", () => {
  const fleet = FLEET().map((row) => {
    if (row.id === "chi") return { ...row, status: "active", metadata: { onboarding_stage: "active", sms_webhook_status: "verified" } };
    if (row.id === "stl") return { ...row, metadata: { sms_webhook_status: "verified" } };
    return row;
  });
  assert.equal(pick("chicago-il", fleet).pool_key, "chicago");
  assert.equal(pick("chicago-il", fleet).local, true);
  assert.equal(pick("detroit-mi", fleet).pool_key, "chicago");
  assert.equal(pick("cincinnati-oh", fleet).pool_key, "indianapolis", "Cincinnati keeps Indianapolis first");
  assert.equal(pick("kansas-city-mo", fleet).pool_key, "st_louis");
  assert.equal(pick("omaha-ne", fleet).pool_key, "minneapolis");
});

test("capacity is shared by number: LA #4 at its 800 cold cap -> Phoenix falls to Dallas last resort, never to a blocked LA number", () => {
  const fleet = FLEET().map((row) => (row.id === "la4" ? { ...row, messages_sent_today: 800 } : row));
  const r = pick("phoenix-az", fleet, { ignore_daily_limit: false });
  assert.equal(r.pool_key, "dallas");
  assert.equal(r.tier, T.LAST_RESORT);
  assert.equal(pick("phoenix-az", fleet, { ignore_daily_limit: true }).pool_key, "los_angeles", "readiness ignores today's cap (it paces)");
});

test("unmapped markets hold (no guess), exactly as today where none has a local number", () => {
  for (const { market_id } of UNMAPPED_MARKETS) {
    const r = pick(market_id);
    assert.equal(r.ok, false, market_id);
    assert.equal(r.cause, "market_has_no_routes");
  }
});

test("threads are sticky: an established St. Louis thread on Minneapolis 0495 keeps it after St. Louis is verified", () => {
  const fleet = FLEET().map((row) => (row.id === "stl" ? { ...row, metadata: { sms_webhook_status: "verified" } } : row));
  for (const purpose of [PURPOSES.REPLY, PURPOSES.PROACTIVE]) {
    const r = selectSender({ market_id: "st-louis-mo", purpose, thread_number: "+16128060495" }, { graph: buildRoutingGraph(graphRowsFor(fleet)), fleet, blocked: new Set(BLOCKED), now: NOW, per_sender_cap: 800 });
    assert.equal(r.decision, "thread_continuity");
    assert.equal(r.number.phone_number, "+16128060495");
  }
  // a thread on a now-blocked number reroutes through the graph, recorded
  const r = selectSender({ market_id: "phoenix-az", purpose: PURPOSES.REPLY, thread_number: "+13234104544" }, { graph: buildRoutingGraph(graphRowsFor(FLEET())), fleet: FLEET(), blocked: new Set(BLOCKED), now: NOW, per_sender_cap: 800 });
  assert.equal(r.number.phone_number, "+13235589881");
  assert.equal(r.thread_reroute.reason, "thread_number_blocked_by_operator");
});

test("the planner's feeder router with the gate ON places a regional first touch; OFF it stays exact-market", async () => {
  const candidate = { market: "Phoenix, AZ", state: "AZ", is_first_touch: true, touch_number: 1 };
  const options = { first_touch: true, routing_safe_only: true, blocked_sender_numbers: new Set(BLOCKED), ignore_daily_limit: true };
  const on = await chooseTextgridNumber(candidate, options, {
    env: { SENDER_ROUTING_V2_ENABLED: "true" }, readSystemFlag: async () => "true",
    loadGraphRows: async () => graphRowsFor(FLEET()), textgridNumberRows: FLEET(), per_sender_cap: 800,
  });
  assert.equal(on.ok, true);
  assert.equal(on.selected_textgrid_number, "+13235589881");
  assert.equal(on.routing_tier, "approved_regional_fallback");
  assert.equal(on.selection_reason, "sender_routing_v2:graph_route:los_angeles");
  const off = await chooseTextgridNumber(candidate, options, { env: {}, textgridNumberRows: FLEET() });
  assert.equal(off.ok, false, "gate off: first touch is exact-market only (Phoenix has no number)");
});

test("send-time health guard: a v2 regional first touch passes only with allow_regional_fallback_for_first_touch on", () => {
  const base = { from_phone_number: "+13235589881", routing_tier: "approved_regional_fallback", first_touch: true, env: {} };
  assert.equal(evaluateSmsHealthGuard({ ...base, system_control: { allow_regional_fallback_for_first_touch: "true" } }).allowed, true);
  assert.equal(evaluateSmsHealthGuard({ ...base, system_control: { allow_regional_fallback_for_first_touch: "false" } }).reason, "regional_fallback_blocked_first_touch");
  assert.equal(evaluateSmsHealthGuard({ ...base, system_control: { allow_regional_fallback_for_first_touch: "true", require_local_routing: "true" } }).allowed, false);
  assert.equal(evaluateSmsHealthGuard({ ...base, from_phone_number: "+13234104544", system_control: { allow_regional_fallback_for_first_touch: "true", sms_blocked_sender_numbers: BLOCKED.join(",") } }).reason, "blocked_sender_number");
});

// ── 3. the coverage SQL is pinned to the JS policy ──────────────────────────
const strip = (text) => text.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
const helper = strip(helperBody(SQL));
const resolver = strip(SQL.slice(SQL.indexOf("FUNCTION public.resolve_campaign_safe_sender_route")));
function listAfter(code, pattern) {
  const at = code.search(pattern);
  assert.ok(at >= 0, `pattern not found: ${pattern}`);
  const open = code.indexOf("(", at + code.slice(at).search(/(NOT IN|IN)\s*\(/));
  const close = code.indexOf(")", open);
  return new Set(code.slice(open + 1, close).split(",").map((v) => v.trim().replace(/^'|'$/g, "")));
}

test("v2 pick SQL denies exactly the statuses / health states the canonical dispatch eligibility denies", () => {
  assert.deepEqual([...listAfter(helper, /lower\(trim\(COALESCE\(tn\.status/)].sort(), [...BLOCKING_NUMBER_STATUS].sort());
  assert.deepEqual([...listAfter(helper, /lower\(trim\(COALESCE\(tn\.health_state/)].sort(), [...BLOCKING_HEALTH_STATE].sort());
  assert.match(helper, /tn\.cooling_until > now\(\)/);
  assert.match(helper, /sms_blocked_sender_numbers/);
  // and the exact-market branch of the resolver keeps the same lists
  assert.deepEqual([...listAfter(resolver, /lower\(trim\(COALESCE\(tn\.status/)].sort(), [...BLOCKING_NUMBER_STATUS].sort());
  assert.deepEqual([...listAfter(resolver, /lower\(trim\(COALESCE\(tn\.health_state/)].sort(), [...BLOCKING_HEALTH_STATE].sort());
});

test("v2 pick SQL applies the policy's extra gates: retired, registered, verified webhook, pre-production stages", () => {
  const stages = [...listAfter(helper, /onboarding_stage', ''\)\)\) NOT IN/)];
  assert.deepEqual(stages.sort(), ["configuring", "discovered", "inbound_verified"]);
  const row = live("x", "+15550001111", "Phoenix, AZ");
  for (const stage of stages) assert.equal(evaluateSenderEligibility({ ...row, metadata: { ...row.metadata, onboarding_stage: stage } }, { now: NOW }).reason, "onboarding_incomplete", stage);
  assert.equal(evaluateSenderEligibility({ ...row, metadata: { ...row.metadata, onboarding_stage: "warming" } }, { now: NOW }).ok, true, "warming may carry traffic");
  assert.equal(evaluateSenderEligibility({ ...row, registration_status: null }, { now: NOW }).reason, "unregistered");
  assert.equal(evaluateSenderEligibility({ ...row, metadata: { sms_webhook_status: "configured" } }, { now: NOW }).reason, "webhook_unverified");
  assert.equal(evaluateSenderEligibility({ ...row, metadata: { sms_webhook_status: "configured", inbound_verified_at: "2026-10-07" } }, { now: NOW }).ok, true);
  assert.match(helper, /lifecycle_state', ''\)\)\) <> 'retired'/);
  assert.match(helper, /registration_status, ''\)\)\) = 'registered'/);
  assert.match(helper, /inbound_verified_at/);
  assert.match(helper, /sms_webhook_status', ''\)\)\) = 'verified'/);
});

test("v2 pick SQL walks the graph like selectSender: enabled routes, active pools and members, never blocked_never, priority first", () => {
  assert.match(helper, /msr\.enabled/);
  assert.match(helper, /sp\.is_active/);
  assert.match(helper, /spn\.status = 'active'/);
  assert.match(helper, /msr\.affinity_tier <> 'blocked_never'/);
  assert.match(helper, /ORDER BY c\.priority, c\.messages_sent_today, c\.last_used_at NULLS FIRST, c\.id/);
  assert.match(helper, /home_market_id = msr\.market_id\) AS is_local/);
});

test("the resolver reads the graph only when the runtime switch is on, with the gate's own truthy values", async () => {
  const truthy = [...listAfter(resolver, /sender_routing_v2_enabled'\s+AND lower\(trim\(COALESCE\(sc\.value/)];
  for (const value of truthy) {
    assert.equal((await isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env: { SENDER_ROUTING_V2_ENABLED: "true" }, readSystemValue: async () => value })).enabled, true, value);
  }
  assert.match(resolver, /WHERE NOT input\.v2_on\s+AND inventory\.market_key = input\.market_key/, "switch off = exact-market (the 010000 rule)");
  assert.match(resolver, /WHERE input\.v2_on\s+AND input\.market_id IS NOT NULL/, "switch on = graph only; an unresolved market is not covered");
  assert.match(resolver, /CASE WHEN v\.is_local THEN 'exact_market_match' ELSE 'approved_regional_fallback' END/);
  assert.match(resolver, /'sender_routing_v2:' \|\| v\.pool_key \|\| ':' \|\| v\.affinity_tier/);
  assert.match(resolver, /COALESCE\(chosen\.regional, false\) AS fallback_covered/);
  assert.doesNotMatch(resolver, /approved_state_fallback|route_rules|midwest_to_minneapolis/, "no legacy state table");
});

test("the parity tool runs the migration's helper body verbatim against stand-ins (read-only)", () => {
  const fleet = FLEET();
  const sql = buildParitySql({ sqlText: SQL, graphRows: graphRowsFor(fleet), fleet, backfill: [] });
  assert.doesNotMatch(sql, /public\.(market_sender_routes|sender_pools|sender_pool_numbers)\b/);
  assert.match(sql, /FROM public\.textgrid_numbers tn LEFT JOIN sr_backfill/);
  assert.ok(sql.includes(helperBody(SQL).replaceAll("public.market_sender_routes", "sr_routes").replaceAll("public.sender_pools", "sr_pools").replaceAll("public.sender_pool_numbers", "sr_members").replaceAll("public.textgrid_numbers", "sr_numbers").replaceAll("p_market_id", "m.id")));
  assert.doesNotMatch(sql, /\b(insert|update|delete|create|drop|alter)\b/i);
});
