#!/usr/bin/env node
/**
 * SENDER ROUTING 2.0 — DRY RUN of the PROPOSED graph. READ-ONLY. SENDS NOTHING.
 *
 *   node --import ./scripts/register-aliases-ops.mjs scripts/ops/sender-routing/dry-run.mjs [--out=<dir>]
 *
 * Inputs (all read-only):
 *   - every queued / scheduled / sender-parked send_queue row
 *   - the 13 late replies held no_eligible_sender (owner cohort, 2026-10-02)
 *     and deal e740c6d8
 *   - textgrid_numbers (true sends today), the operator blocklist,
 *     queue_per_number_cap, canonical_markets, the TextGrid inventory (GET)
 * Each row is routed through selectSender() under the proposed graph:
 *   A  today's inventory (+ the evidence backfill the seed proposes)
 *   B  A + Chicago +18722547122 onboarded (simulated: registered, inbound
 *      verified, active at the fleet standard 800/day) — what the graph does once the owner finishes onboarding
 *      (r3; Indianapolis / Tampa finished onboarding on 2026-10-03 and are in A)
 * and reported with market, current state, pool, number, tier, eligibility.
 * "legacy_at_send" shows what today's router does for the row.
 */
import { readOnlyClient, readTextgridInventory, readAll, arg, writeOut, OWNER_PASTE_2026_10_02 } from "./_readonly.mjs";
import { withDerivedSentToday } from "../../../src/lib/domain/delivery/sender-sent-today.js";
import { evaluateOutboundNumberEligibility } from "../../../src/lib/supabase/sms-engine.js";
import { byUsageThenRecency } from "../../../src/lib/domain/routing/sender-routing/sender-allocator.js";
import { buildRoutingGraph, selectSender, describeHold, maskPhone, normalizeE164, PURPOSES } from "../../../src/lib/domain/routing/sender-routing/sender-routing-policy.js";
import { proposedGraphRows, PROPOSED_ROUTES } from "../../../src/lib/domain/routing/sender-routing/proposed-initial-graph.js";
import { reconcileInventory, proposedEvidenceBackfill, applyBackfillToFleet } from "../../../src/lib/domain/routing/sender-routing/sender-inventory-reconciliation.js";
import { computeCoverage } from "../../../src/lib/domain/routing/sender-routing/sender-coverage.js";

const HELD_13 = ["a8a68af2-7016-487b-ab72-6c27cf51c523", "537d5fcf-d81a-4005-9b80-21b2741c1aee", "1ae5b9de-8802-45a5-b7fb-65f1ffa8b184", "e4a5d3b6-e731-47f3-8f9c-ffbeae814b07", "0d43521a-be75-4423-b034-c53a26ef33de", "fd9dd740-001e-49fc-8975-2388de51f4b6", "ab74d8c6-66e5-4a84-885b-91e0f23f97ba", "f9eb92fa-0b36-44b7-b344-c05230ea48e6", "b5ad155c-11b6-484b-95ff-3b9932da27b5", "a2dca29d-af1f-4f80-9808-77fc60eb0e66", "cd5a81f8-59ee-4da7-abe6-c2aa44df34ea", "a09e8ebc-8e9b-4dad-8bc6-f1123011d343", "08fd5cb5-7e1d-4992-8787-8f6c980a67dd"];
const E740 = "e740c6d8-3286-42f2-9f1d-a0ca405a7d8f";
const PENDING = [
  { phone_number: "+18722547122", market: "Chicago, IL", friendly_name: "CHICAGO" },
];

const sb = readOnlyClient();
const now = new Date();
const outDir = arg("out");

// ── inventory ──
const rawFleet = await readAll(sb, "textgrid_numbers", "*");
const fleetToday = await withDerivedSentToday(sb, rawFleet, { now });
const { data: sc } = await sb.from("system_control").select("key,value").in("key", ["sms_blocked_sender_numbers", "queue_per_number_cap"]);
const scv = Object.fromEntries((sc || []).map((r) => [r.key, r.value]));
const blocked = new Set(String(scv.sms_blocked_sender_numbers || "").split(",").map(normalizeE164).filter(Boolean));
const per_sender_cap = Number(scv.queue_per_number_cap) || null;
const markets = (await readAll(sb, "canonical_markets", "id,display_name,state,is_active")).filter((m) => m.is_active !== false);

let provider = null;
try {
  provider = await readTextgridInventory();
} catch {
  provider = null;
}
const inboundCounts = new Map();
for (const row of rawFleet) {
  const { count } = await sb.from("message_events").select("id", { count: "exact", head: true }).eq("to_phone_number", row.phone_number).eq("direction", "inbound");
  inboundCounts.set(normalizeE164(row.phone_number), count || 0);
}
const recon = reconcileInventory(provider || OWNER_PASTE_2026_10_02, rawFleet, { blocked, inboundCounts });
const backfill = proposedEvidenceBackfill(recon);
const fleetA = applyBackfillToFleet(fleetToday, backfill);
const fleetB = [
  ...fleetA.filter((row) => !PENDING.some((p) => p.phone_number === row.phone_number)),
  ...PENDING.map((p, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`,
    ...p,
    status: "active",
    health_state: "unverified",
    registration_status: "registered",
    daily_limit: 800, // fleet standard (owner rejected 25/day on 2026-10-03)
    messages_sent_today: 0,
    last_used_at: null,
    metadata: { onboarding_stage: "active", sms_webhook_status: "verified", inbound_verified_at: "SIMULATED" },
  })),
];
const graphA = buildRoutingGraph(proposedGraphRows({ markets, fleet: fleetA }));
const graphB = buildRoutingGraph(proposedGraphRows({ markets, fleet: fleetB, includePending: true }));

// ── inputs ──
const queueRows = await readAll(sb, "send_queue", "id,queue_status,guard_reason,failed_reason,campaign_id,from_phone_number,thread_key,property_id,market,scheduled_for_utc,metadata", (q) => q.in("queue_status", ["queued", "scheduled", "blocked_sender_ineligible"]));
const opps = await readAll(sb, "acquisition_opportunities", "id,primary_property_id,primary_thread_key,market", (q) => q.in("id", [...HELD_13, E740]));
const propIds = [...new Set([...queueRows.map((r) => r.property_id || r.metadata?.property_id), ...opps.map((o) => o.primary_property_id)].filter(Boolean).map(String))];
const threadKeys = [...new Set([...queueRows.map((r) => r.thread_key), ...opps.map((o) => o.primary_thread_key)].filter(Boolean))];
const props = propIds.length ? await readAll(sb, "properties", "property_id,canonical_market_id", (q) => q.in("property_id", propIds)) : [];
const threads = threadKeys.length ? await readAll(sb, "inbox_thread_state", "thread_key,our_number", (q) => q.in("thread_key", threadKeys)) : [];
const marketOf = new Map(props.map((p) => [String(p.property_id), p.canonical_market_id]));
const ourOf = new Map(threads.map((t) => [t.thread_key, normalizeE164(t.our_number)]));

const inputs = [];
for (const r of queueRows) {
  inputs.push({
    kind: "send_queue",
    id: r.id,
    ref: String(r.id).slice(0, 8),
    current: r.queue_status + (r.guard_reason ? `:${r.guard_reason}` : ""),
    source: r.metadata?.source || null,
    campaign_id: r.campaign_id,
    market_id: marketOf.get(String(r.property_id || r.metadata?.property_id || "")) || null,
    market: r.market || null,
    pinned: normalizeE164(r.from_phone_number) || null,
    thread_number: normalizeE164(r.from_phone_number) || ourOf.get(r.thread_key) || null,
  });
}
for (const o of opps) {
  const isE740 = o.id === E740;
  const live = isE740 ? queueRows.find((r) => r.thread_key === o.primary_thread_key && r.queue_status === "queued") : null;
  inputs.push({
    kind: isE740 ? "deal_e740c6d8" : "held_late_reply",
    id: o.id,
    ref: String(o.id).slice(0, 8),
    current: isE740 ? `queued row ${live ? String(live.id).slice(0, 8) : "?"} on ${maskPhone(live?.from_phone_number)} (legacy state rule IN->Minneapolis)` : "held:no_eligible_sender (NO_APPROVED_ROUTING_PATH)",
    campaign_id: null,
    market_id: marketOf.get(String(o.primary_property_id)) || null,
    market: o.market || null,
    pinned: null,
    thread_number: ourOf.get(o.primary_thread_key) || null,
  });
}

// ── legacy at send time (what the runner does today) ──
const legacyRotation = fleetToday.filter((row) => evaluateOutboundNumberEligibility(row, now).ok).sort(byUsageThenRecency);
function legacyAtSend(input) {
  if (input.kind === "held_late_reply") return "held (campaign router: no approved path)";
  if (input.pinned) {
    const row = fleetToday.find((f) => normalizeE164(f.phone_number) === input.pinned);
    const v = evaluateOutboundNumberEligibility(row, now);
    if (!v.ok) return `parks: ${v.reason}`;
    return blocked.has(input.pinned) ? "refused: blocked_sender_number (health guard)" : `sends ${maskPhone(input.pinned)}`;
  }
  const first = legacyRotation[0];
  if (!first) return "fails: no_available_textgrid_numbers";
  const p = normalizeE164(first.phone_number);
  return blocked.has(p) ? `rotation picks ${maskPhone(p)} (${first.market}) -> refused blocked_sender_number` : `rotation picks ${maskPhone(p)} (${first.market}), any market`;
}

function route(graph, fleet, input) {
  const purpose = input.campaign_id ? PURPOSES.PROACTIVE : PURPOSES.REPLY;
  const r = selectSender({ market_id: input.market_id, market: input.market, purpose, thread_number: input.thread_number }, { graph, fleet, blocked, now, per_sender_cap });
  if (!r.ok) return { ok: false, cell: `HOLD ${r.cause}`, detail: describeHold(r), cause: r.cause };
  return { ok: true, cell: `${r.pool_key} · ${maskPhone(r.number.phone_number)} · ${r.tier}${r.local ? " (local)" : " (regional)"} · ${r.decision}${r.thread_reroute ? ` [reroute: ${r.thread_reroute.reason}]` : ""}`, pool: r.pool_key, label: r.label };
}

const results = inputs.map((input) => ({ ...input, purpose: input.campaign_id ? "proactive" : "reply", legacy_at_send: legacyAtSend(input), A: route(graphA, fleetA, input), B: route(graphB, fleetB, input) }));

// ── per-market rollup for the proposed graph table ──
const covA = computeCoverage({ graph: graphA, fleet: fleetA, blocked, now, per_sender_cap });
const covB = computeCoverage({ graph: graphB, fleet: fleetB, blocked, now, per_sender_cap });
const statusB = new Map(covB.markets.map((m) => [m.market_id, m.status]));
const unlocked = new Map();
for (const r of results) {
  if (!r.market_id) continue;
  const today = r.kind === "held_late_reply" || /refused|parks|fails/.test(r.legacy_at_send);
  const e = unlocked.get(r.market_id) || { held_now: 0, unlocked_A: 0, unlocked_B: 0, rows: 0 };
  e.rows += 1;
  if (today) {
    e.held_now += 1;
    if (r.A.ok) e.unlocked_A += 1;
    if (r.B.ok) e.unlocked_B += 1;
  }
  unlocked.set(r.market_id, e);
}
const poolName = (g, k) => g.pools.get(k)?.name || k;
const graphTable = covA.markets
  .filter((m) => PROPOSED_ROUTES[m.market_id])
  .map((m) => {
    const routes = PROPOSED_ROUTES[m.market_id];
    const cell = (tier) => routes.filter((x) => x.tier === tier).map((x) => `${poolName(graphA, x.pool_key)}${x.provenance === "owner" ? " (owner)" : x.provenance === "confirm" ? " (owner, confirm)" : ""}`).join(", ") || "—";
    const u = unlocked.get(m.market_id) || { held_now: 0, unlocked_A: 0, unlocked_B: 0, rows: 0 };
    return { market_id: m.market_id, market: m.display_name, primary: cell("primary"), preferred: cell("preferred_fallback"), regional: cell("regional_fallback"), last_resort: cell("last_resort"), health_today: m.status, health_after_onboarding: statusB.get(m.market_id), held_now: u.held_now, unlocked_today: u.unlocked_A, unlocked_after_onboarding: u.unlocked_B };
  });

const md = [];
md.push(`# Sender Routing 2.0 — dry run (${now.toISOString()})`, "", "READ-ONLY. Nothing was queued, released or sent.", "");
md.push(`Inventory: ${rawFleet.length} local numbers; provider ${provider ? "TextGrid API (GET)" : "owner paste"}; blocklist ${blocked.size}; per-number cap ${per_sender_cap}.`, "");
md.push(`Coverage A (today): ${JSON.stringify(covA.metrics)}`, `Coverage B (+Chicago): ${JSON.stringify(covB.metrics)}`, "");
md.push("## Proposed graph", "", "| TARGET MARKET | PRIMARY | PREFERRED | REGIONAL | LAST RESORT | HEALTH today | HEALTH +Chicago | HELD NOW | UNLOCKED today | UNLOCKED +Chicago |", "|---|---|---|---|---|---|---|---|---|---|");
for (const t of graphTable) md.push(`| ${t.market} | ${t.primary} | ${t.preferred} | ${t.regional} | ${t.last_resort} | ${t.health_today} | ${t.health_after_onboarding} | ${t.held_now} | ${t.unlocked_today} | ${t.unlocked_after_onboarding} |`);
md.push("", "## Rows", "", "| kind | ref | market | purpose | current | legacy at send | A: proposed graph today | B: + Chicago |", "|---|---|---|---|---|---|---|---|");
for (const r of results) md.push(`| ${r.kind} | ${r.ref} | ${r.market_id || r.market || "?"} | ${r.purpose} | ${r.current} | ${r.legacy_at_send} | ${r.A.cell} | ${r.B.cell} |`);
md.push("", "## Hold detail (A)", "");
for (const r of results.filter((x) => !x.A.ok)) md.push(`- ${r.ref} ${r.A.detail}`);

console.log(md.slice(0, 8).join("\n"));
const summary = {
  rows: results.length,
  A_routable: results.filter((r) => r.A.ok).length,
  B_routable: results.filter((r) => r.B.ok).length,
  held13_A: results.filter((r) => r.kind === "held_late_reply" && r.A.ok).length,
  held13_B: results.filter((r) => r.kind === "held_late_reply" && r.B.ok).length,
};
console.log(JSON.stringify(summary));
if (outDir) {
  writeOut(`${outDir}/dry-run.md`, md.join("\n"));
  writeOut(`${outDir}/dry-run.json`, { generated_at: now.toISOString(), summary, coverage_today: covA.metrics, coverage_after_onboarding: covB.metrics, graph_table: graphTable, backfill, results: results.map(({ A, B, ...rest }) => ({ ...rest, A: A.cell, A_detail: A.detail || null, B: B.cell, B_detail: B.detail || null })) });
}
