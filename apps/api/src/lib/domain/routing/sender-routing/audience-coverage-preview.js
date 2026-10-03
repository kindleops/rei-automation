/**
 * AUDIENCE SENDER COVERAGE PREVIEW — for Campaign Composer (read-only).
 *
 *   previewAudienceSenderCoverage({ markets, gate_enabled, graph, fleet, blocked, now, per_sender_cap })
 *     markets  [{ market_id?, market?, state?, targets }]
 *   -> {
 *        engine: 'legacy_router' | 'sender_routing_v2'   the engine that WILL dispatch now
 *        markets: [{ market_id, market, targets, coverage, serving_pool, serving_tier,
 *                    healthy_numbers, daily_capacity, unavailable: [{ pool, reasons }] }],
 *        totals: { distinct_healthy_numbers, distinct_daily_capacity, targets },
 *        v2_preview: same shape, labelled — only when the gate is off (null when on)
 *      }
 *
 * The engine that dispatches under the current gate state:
 *   gate OFF  the legacy campaign router (supabase-candidate-feeder
 *             chooseTextgridNumber: exact market -> approved alias -> state
 *             regional rule), operator blocklist applied — the same call the
 *             campaign planner makes, with the fleet injected (no I/O);
 *   gate ON   Sender Routing 2.0 (the graph + selectSender).
 * Eligibility is the canonical sender dispatch eligibility everywhere.
 *
 * Capacity is never double-counted: a number that serves several markets is
 * counted once in totals (per-market figures say what that market could use
 * if it had the numbers to itself; `shared_numbers` flags the overlap).
 */

import { evaluateSenderDispatchEligibility } from "@/lib/domain/delivery/sender-dispatch-eligibility.js";
import { chooseTextgridNumber } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import { effectiveDailyLimit, maskPhone, normalizeE164, resolveGraphMarketId } from "./sender-routing-policy.js";
import { marketCoverage, poolHealth } from "./sender-coverage.js";

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const marketKey = (value) => lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function remainingFor(row, per_sender_cap) {
  const limit = effectiveDailyLimit(row, { per_sender_cap });
  return limit === null ? 0 : Math.max(0, limit - (Number(row.messages_sent_today) || 0));
}

function totalsOf(list, fleetById, per_sender_cap) {
  const ids = new Set();
  for (const m of list) for (const id of m._numbers || []) ids.add(id);
  let capacity = 0;
  for (const id of ids) capacity += remainingFor(fleetById.get(id) || {}, per_sender_cap);
  const counts = new Map();
  for (const m of list) for (const id of m._numbers || []) counts.set(id, (counts.get(id) || 0) + 1);
  for (const m of list) m.shared_numbers = (m._numbers || []).filter((id) => counts.get(id) > 1).length;
  return { distinct_healthy_numbers: ids.size, distinct_daily_capacity: capacity, targets: list.reduce((s, m) => s + (Number(m.targets) || 0), 0) };
}

const strip = (list) => list.map(({ _numbers, ...rest }) => rest);

async function legacyMarket(input, ctx) {
  const label = clean(input.market) || ctx.graph?.markets?.get(clean(input.market_id))?.display_name || clean(input.market_id);
  const state = clean(input.state) || ctx.graph?.markets?.get(clean(input.market_id))?.state || null;
  const verdict = (row) => evaluateSenderDispatchEligibility(row, { blocked: ctx.blocked, now: ctx.now });
  const r = await chooseTextgridNumber(
    { market: label, state, touch_number: 1, is_first_touch: true },
    { first_touch: true, blocked_sender_numbers: ctx.blocked, allow_regional_fallback_for_first_touch: true },
    { textgridNumberRows: ctx.fleet, env: {} }
  );
  const local = ctx.fleet.filter((row) => marketKey(row.market) === marketKey(label));
  const unavailable = local.filter((row) => !verdict(row).ok);
  const base = { market_id: clean(input.market_id) || null, market: label, targets: Number(input.targets) || 0 };
  const unavailableOut = unavailable.length
    ? [{ pool: label, reasons: unavailable.map((row) => ({ phone: maskPhone(row.phone_number), reason: verdict(row).reason })) }]
    : [];
  if (!r?.ok || !r.selected_textgrid_market) {
    return { ...base, coverage: "UNCOVERED", serving_pool: null, serving_tier: null, healthy_numbers: 0, daily_capacity: 0, unavailable: unavailableOut, _numbers: [] };
  }
  const servingKey = marketKey(r.selected_textgrid_market);
  const serving = ctx.fleet.filter((row) => marketKey(row.market) === servingKey && verdict(row).ok && remainingFor(row, ctx.per_sender_cap) > 0);
  const exact = r.routing_tier === "exact_market_match";
  return {
    ...base,
    coverage: exact ? "LOCAL" : unavailable.length ? "DEGRADED" : "REGIONAL",
    serving_pool: r.selected_textgrid_market,
    serving_tier: r.routing_tier,
    healthy_numbers: serving.length,
    daily_capacity: serving.reduce((s, row) => s + remainingFor(row, ctx.per_sender_cap), 0),
    unavailable: unavailableOut,
    _numbers: serving.map((row) => clean(row.id)),
  };
}

function v2Market(input, ctx, pools) {
  const market_id = resolveGraphMarketId(ctx.graph, { market_id: input.market_id, market: input.market });
  const base = { market_id, market: market_id ? ctx.graph.markets.get(market_id)?.display_name : clean(input.market) || null, targets: Number(input.targets) || 0 };
  if (!market_id) return { ...base, coverage: "UNCOVERED", serving_pool: null, serving_tier: null, healthy_numbers: 0, daily_capacity: 0, unavailable: [], note: "market not in the canonical registry", _numbers: [] };
  const cov = marketCoverage(ctx.graph, market_id, pools);
  const active = cov.routes.find((r) => r.pool_key === cov.active_pool) || null;
  const activePool = active ? pools.get(active.pool_key) : null;
  const eligible = activePool ? activePool.numbers.filter((n) => n.eligible && (n.remaining === null || n.remaining > 0)) : [];
  return {
    ...base,
    coverage: cov.status,
    serving_pool: active?.pool_name || null,
    serving_tier: active?.tier || null,
    label: cov.label,
    healthy_numbers: eligible.length,
    daily_capacity: eligible.reduce((s, n) => s + (Number.isFinite(n.remaining) ? n.remaining : 0), 0),
    unavailable: cov.routes
      .filter((r) => r.health !== "healthy")
      .map((r) => ({ pool: r.pool_name, tier: r.tier, reasons: (pools.get(r.pool_key)?.numbers || []).filter((n) => !n.eligible).map((n) => ({ phone: n.phone, reason: n.reason })) })),
    _numbers: eligible.map((n) => clean(n.textgrid_number_id)),
  };
}

export async function previewAudienceSenderCoverage({ markets = [], gate_enabled = false, graph = null, fleet = [], blocked = new Set(), now = new Date(), per_sender_cap = null } = {}) {
  const ctx = { graph, fleet: fleet || [], blocked: blocked instanceof Set ? new Set([...blocked].map(normalizeE164)) : new Set(), now, per_sender_cap };
  const fleetById = new Map(ctx.fleet.map((row) => [clean(row.id), row]));
  const pools = graph ? poolHealth(graph, { fleet: ctx.fleet, blocked: ctx.blocked, now, per_sender_cap }) : null;

  const legacy = [];
  for (const m of markets) legacy.push(await legacyMarket(m, ctx));
  const v2 = graph ? markets.map((m) => v2Market(m, ctx, pools)) : null;

  if (gate_enabled && v2) {
    const totals = totalsOf(v2, fleetById, per_sender_cap);
    return { engine: "sender_routing_v2", graph_version: graph.version, markets: strip(v2), totals, v2_preview: null };
  }
  const totals = totalsOf(legacy, fleetById, per_sender_cap);
  const preview = v2
    ? { label: "Sender Routing 2.0 preview — NOT the engine that sends today (gate off)", graph_version: graph.version, graph_source: graph.source, totals: totalsOf(v2, fleetById, per_sender_cap), markets: strip(v2) }
    : null;
  return { engine: "legacy_router", markets: strip(legacy), totals, v2_preview: preview };
}
