#!/usr/bin/env node
/**
 * SENDER ROUTING 2.0 r3 — ACTIVATION DRY RUN, per market. READ-ONLY. SENDS NOTHING.
 *
 *   node --import ./scripts/register-aliases-ops.mjs scripts/ops/sender-routing/activation-dry-run.mjs [--out=<dir>]
 *
 * For every canonical market: the proposed r3 routes, the would-be first-touch
 * sender per route (the SAME selectSender the planner, the Composer cohort and
 * the runner call once the gate is on), and the campaign_target_graph counts
 * the route unlocks:
 *   graph_rows        all rows of the market
 *   route_dependent   rows blocked by nothing but sender coverage
 *                     (queue_block_reason IS NULL or 'no_sender_coverage')
 *   first_touch       route_dependent AND never_contacted (the Composer's
 *                     first-touch cohort before template / identity checks)
 * Scenarios:
 *   A  today's fleet + the seed's evidence backfill (fresh TextGrid GET + inbound history)
 *   B  A + Chicago +18722547122 activated at 800/day + St. Louis inbound-verified
 *      (what the graph does once the owner finishes onboarding)
 * Capacity: per pool, the cold daily capacity of its eligible numbers (each number's
 * effective limit = min(daily_limit, queue_per_number_cap)); shared numbers counted once.
 * Pool load = first_touch rows of the markets whose FIRST eligible route is that pool.
 */
import { readOnlyClient, readTextgridInventory, readAll, arg, writeOut } from "./_readonly.mjs";
import { withDerivedSentToday } from "../../../src/lib/domain/delivery/sender-sent-today.js";
import { buildRoutingGraph, selectSender, evaluateSenderEligibility, effectiveDailyLimit, maskPhone, normalizeE164, PURPOSES } from "../../../src/lib/domain/routing/sender-routing/sender-routing-policy.js";
import { proposedGraphRows, PROPOSED_ROUTES, PROPOSED_POOLS, UNMAPPED_MARKETS } from "../../../src/lib/domain/routing/sender-routing/proposed-initial-graph.js";
import { reconcileInventory, proposedEvidenceBackfill, applyBackfillToFleet } from "../../../src/lib/domain/routing/sender-routing/sender-inventory-reconciliation.js";

const COMPOSER_MARKETS = ["chicago-il", "detroit-mi", "cleveland-oh", "phoenix-az", "inland-empire-ca", "orlando-fl", "kansas-city-mo", "oklahoma-city-ok", "san-antonio-tx", "philadelphia-pa"];
const CHICAGO = "+18722547122";
const ST_LOUIS = "+13149268488";

const sb = readOnlyClient();
const now = new Date();
const outDir = arg("out");

const rawFleet = await readAll(sb, "textgrid_numbers", "*");
const fleetToday = await withDerivedSentToday(sb, rawFleet, { now });
const { data: sc } = await sb.from("system_control").select("key,value").in("key", ["sms_blocked_sender_numbers", "queue_per_number_cap", "allow_regional_fallback_for_first_touch", "require_local_routing", "sender_routing_v2_enabled"]);
const scv = Object.fromEntries((sc || []).map((r) => [r.key, r.value]));
const blocked = new Set(String(scv.sms_blocked_sender_numbers || "").split(",").map(normalizeE164).filter(Boolean));
const per_sender_cap = Number(scv.queue_per_number_cap) || null;
const markets = (await readAll(sb, "canonical_markets", "id,display_name,state,is_active")).filter((m) => m.is_active !== false);

const provider = await readTextgridInventory().catch(() => null);
const inboundCounts = new Map();
for (const row of rawFleet) {
  const { count } = await sb.from("message_events").select("id", { count: "exact", head: true }).eq("to_phone_number", row.phone_number).eq("direction", "inbound");
  inboundCounts.set(normalizeE164(row.phone_number), count || 0);
}
const recon = reconcileInventory(provider || [], rawFleet, { blocked, inboundCounts });
const backfill = proposedEvidenceBackfill(recon);
const fleetA = applyBackfillToFleet(fleetToday, backfill);
const fleetB = [
  ...fleetA.map((row) => (normalizeE164(row.phone_number) === ST_LOUIS ? { ...row, metadata: { ...(row.metadata || {}), sms_webhook_status: "verified", inbound_verified_at: "SIMULATED" } } : row)),
  { id: "00000000-0000-4000-8000-000000000872", phone_number: CHICAGO, market: "Chicago, IL", status: "active", health_state: "unverified", registration_status: "registered", daily_limit: 800, messages_sent_today: 0, last_used_at: null, metadata: { onboarding_stage: "active", sms_webhook_status: "verified", inbound_verified_at: "SIMULATED" } },
];
const graphA = buildRoutingGraph(proposedGraphRows({ markets, fleet: fleetA }));
const graphB = buildRoutingGraph(proposedGraphRows({ markets, fleet: fleetB, includePending: true }));

// ── graph counts per market (count-only, head requests) ──
async function count(market, extra = (q) => q) {
  const { count: n, error } = await extra(sb.from("campaign_target_graph").select("graph_id", { count: "exact", head: true }).eq("market", market));
  if (error) throw new Error(`count ${market}: ${error.message}`);
  return n || 0;
}
const counts = new Map();
for (const m of markets) {
  const dep = (q) => q.or("queue_block_reason.is.null,queue_block_reason.eq.no_sender_coverage");
  counts.set(m.id, {
    graph_rows: await count(m.display_name),
    route_dependent: await count(m.display_name, dep),
    first_touch: await count(m.display_name, (q) => dep(q).eq("never_contacted", true)),
    covered_now: await count(m.display_name, (q) => q.is("queue_block_reason", null)),
  });
}

function routeMarket(graph, fleet, market_id) {
  // The Composer / readiness question: can a first touch be placed (today's cap ignored, it paces).
  const r = selectSender({ market_id, purpose: PURPOSES.PROACTIVE }, { graph, fleet, blocked, now, per_sender_cap, ignore_daily_limit: true });
  return r.ok
    ? { ok: true, pool: r.pool_key, tier: r.tier, local: r.local, sender: maskPhone(r.number.phone_number), sender_market: r.number.market, route_type: r.local ? "exact" : "regional", label: r.label }
    : { ok: false, cause: r.cause, pools: (r.pools_checked || []).map((p) => `${p.pool_key}:${p.pool_reason}[${[...new Set(p.numbers.map((n) => n.reason).filter(Boolean))].join("/")}]`).join("; ") };
}

const fleetIdx = (fleet) => new Map(fleet.map((row) => [normalizeE164(row.phone_number), row]));
function poolCapacity(graph, fleet) {
  const idx = fleetIdx(fleet);
  const out = new Map();
  for (const [pool_key, members] of graph.numbersByPool) {
    let cap = 0;
    const nums = [];
    for (const m of members) {
      const row = (m.textgrid_number_id && fleet.find((f) => f.id === m.textgrid_number_id)) || idx.get(m.phone_number);
      const v = evaluateSenderEligibility(row, { blocked, now, per_sender_cap, member_status: m.status, ignore_daily_limit: true });
      const limit = row ? effectiveDailyLimit(row, { per_sender_cap }) : 0;
      nums.push(`${maskPhone(m.phone_number || row?.phone_number)}${v.ok ? ` ${limit}/d` : ` ✗${v.reason}`}`);
      if (v.ok) cap += limit || 0;
    }
    out.set(pool_key, { cap, nums });
  }
  return out;
}

function scenario(graph, fleet) {
  const rows = markets.map((m) => ({ market_id: m.id, market: m.display_name, ...counts.get(m.id), routes: (PROPOSED_ROUTES[m.id] || []).map((x) => x.pool_key), route: routeMarket(graph, fleet, m.id) }));
  const caps = poolCapacity(graph, fleet);
  const load = new Map();
  for (const r of rows) if (r.route.ok) load.set(r.route.pool, (load.get(r.route.pool) || 0) + r.first_touch);
  const pools = PROPOSED_POOLS.map((p) => ({ pool: p.pool_key, numbers: caps.get(p.pool_key)?.nums || [], cold_capacity_per_day: caps.get(p.pool_key)?.cap || 0, first_touch_load: load.get(p.pool_key) || 0 }))
    .map((p) => ({ ...p, days_to_first_touch_all: p.cold_capacity_per_day ? Math.ceil(p.first_touch_load / p.cold_capacity_per_day) : null }));
  const tot = (pred) => rows.filter(pred).reduce((s, r) => s + r.first_touch, 0);
  return {
    rows,
    pools,
    totals: {
      first_touch_routable: tot((r) => r.route.ok),
      first_touch_exact: tot((r) => r.route.ok && r.route.local),
      first_touch_regional: tot((r) => r.route.ok && !r.route.local),
      first_touch_held: tot((r) => !r.route.ok),
      markets_exact: rows.filter((r) => r.route.ok && r.route.local).length,
      markets_regional: rows.filter((r) => r.route.ok && !r.route.local).length,
      markets_held: rows.filter((r) => !r.route.ok).length,
      fleet_cold_capacity_per_day: pools.reduce((sum, p) => sum + p.cold_capacity_per_day, 0), // a number is in exactly one pool
    },
  };
}

const A = scenario(graphA, fleetA);
const B = scenario(graphB, fleetB);

const md = [];
md.push(`# Sender Routing 2.0 r3 — activation dry run (${now.toISOString()})`, "", "READ-ONLY. Nothing queued, released, written or sent.", "");
md.push(`Provider: ${provider ? `TextGrid API GET (${provider.length} numbers)` : "unavailable"} · local numbers ${rawFleet.length} · blocklist ${[...blocked].map(maskPhone).join(", ")} · per-number cap ${per_sender_cap} · allow_regional_fallback_for_first_touch=${scv.allow_regional_fallback_for_first_touch} · require_local_routing=${scv.require_local_routing ?? "(unset)"} · sender_routing_v2_enabled=${scv.sender_routing_v2_enabled ?? "(absent)"}`, "");
md.push(`Evidence backfill (seed): ${backfill.map((b) => `${maskPhone(b.phone)} ${b.registration_status || "-"}/${b.sms_webhook_status || "-"}`).join(" · ")}`, "");
for (const [name, S] of [["A — today (+ seed evidence)", A], ["B — + Chicago active 800/d + St. Louis inbound-verified", B]]) {
  md.push(`## ${name}`, "", `Totals: ${JSON.stringify(S.totals)}`, "");
  md.push("| market | routes (priority order) | graph rows | route-dependent | first-touch | queue-ready in graph today | would-be sender (first touch) |", "|---|---|---|---|---|---|---|");
  for (const r of [...S.rows].sort((a, b) => b.graph_rows - a.graph_rows)) {
    const cell = r.route.ok ? `${r.route.route_type} · ${r.route.pool} ${r.route.sender} (${r.route.sender_market})` : `HOLD ${r.route.cause}${r.route.pools ? ` — ${r.route.pools}` : ""}`;
    md.push(`| ${r.market} | ${r.routes.join(" → ") || "UNMAPPED"} | ${r.graph_rows} | ${r.route_dependent} | ${r.first_touch} | ${r.covered_now} | ${cell} |`);
  }
  md.push("", "| pool | numbers | cold capacity/day | first-touch load (first eligible route) | days at full cap |", "|---|---|---|---|---|");
  for (const p of S.pools) md.push(`| ${p.pool} | ${p.numbers.join(", ")} | ${p.cold_capacity_per_day} | ${p.first_touch_load} | ${p.days_to_first_touch_all ?? "—"} |`);
  md.push("");
}
md.push("## Composer counts (first-touch cohort, before template / identity checks)", "", "| market | route-dependent | first-touch | A sender | B sender |", "|---|---|---|---|---|");
for (const id of COMPOSER_MARKETS) {
  const a = A.rows.find((r) => r.market_id === id);
  const b = B.rows.find((r) => r.market_id === id);
  const c = (x) => (x.route.ok ? `${x.route.route_type} ${x.route.pool} ${x.route.sender} → ${x.first_touch} sendable` : `HOLD (${x.route.cause}) → 0`);
  md.push(`| ${a.market} | ${a.route_dependent} | ${a.first_touch} | ${c(a)} | ${c(b)} |`);
}
md.push("", "## Unmapped (owner assigns)", "");
for (const u of UNMAPPED_MARKETS) {
  const c = counts.get(u.market_id);
  md.push(`- ${u.market_id}: ${u.why} — route-dependent ${c?.route_dependent ?? "?"}, first-touch ${c?.first_touch ?? "?"}`);
}

console.log(md.join("\n"));
writeOut(outDir ? `${outDir}/activation-dry-run.md` : null, md.join("\n"));
writeOut(outDir ? `${outDir}/activation-dry-run.json` : null, { generated_at: now.toISOString(), blocked: [...blocked], backfill, A, B });
