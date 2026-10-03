/**
 * SENDER ROUTING 2.0 — Sender Coverage read model + route-edit impact preview
 * (owner brief §A "Configuration safety", §C). Pure.
 *
 * Status per market (factual definitions, shown verbatim in the UI):
 *   LOCAL      the market's first route is its own local pool and that pool
 *              has an eligible sender now.
 *   REGIONAL   the market has no local pool first in line by design (its first
 *              route is another market's hub) and that route can send now.
 *   DEGRADED   a higher-priority route has no eligible sender; a lower-priority
 *              route is carrying the market.
 *   UNCOVERED  no route in the market's graph has an eligible sender (or the
 *              market has no routes): sends park as no_eligible_sender_for_route.
 */

import { AFFINITY_TIERS, evaluateSenderEligibility, isLocalPool, maskPhone, normalizeE164, routeLabel, selectSender, PURPOSES } from "./sender-routing-policy.js";

export const COVERAGE_STATUS = Object.freeze({ LOCAL: "LOCAL", REGIONAL: "REGIONAL", DEGRADED: "DEGRADED", UNCOVERED: "UNCOVERED" });

export const COVERAGE_DEFINITIONS = Object.freeze({
  LOCAL: "First route is the market's own pool and it can send now.",
  REGIONAL: "No local pool first in line by design; the first route (another market's hub) can send now.",
  DEGRADED: "A higher-priority route cannot send; a lower-priority route is carrying the market.",
  UNCOVERED: "No route in the market's graph can send. Sends park as no_eligible_sender_for_route.",
});

const clean = (value) => String(value ?? "").trim();

function fleetMaps(fleet = []) {
  const byId = new Map();
  const byPhone = new Map();
  for (const row of fleet || []) {
    if (clean(row?.id)) byId.set(clean(row.id), row);
    const p = normalizeE164(row?.phone_number);
    if (p) byPhone.set(p, row);
  }
  return { byId, byPhone };
}

/** Per-pool health with per-number reasons. */
export function poolHealth(graph, { fleet = [], blocked = new Set(), now = new Date(), per_sender_cap = null } = {}) {
  const maps = fleetMaps(fleet);
  const out = new Map();
  for (const [key, pool] of graph.pools.entries()) {
    const members = graph.numbersByPool.get(key) || [];
    const numbers = members.map((m) => {
      const row = (m.textgrid_number_id && maps.byId.get(m.textgrid_number_id)) || (m.phone_number && maps.byPhone.get(m.phone_number)) || null;
      const v = evaluateSenderEligibility(row, { blocked, now, per_sender_cap, member_status: m.status });
      return { phone: maskPhone(m.phone_number || row?.phone_number), textgrid_number_id: m.textgrid_number_id || row?.id || null, eligible: v.ok, reason: v.reason, remaining: v.remaining };
    });
    const eligible = numbers.filter((n) => n.eligible);
    out.set(key, {
      pool_key: key,
      name: pool.name,
      home_market_id: pool.home_market_id,
      enabled: pool.enabled,
      total: numbers.length,
      eligible: eligible.length,
      remaining_capacity: eligible.reduce((s, n) => s + (Number.isFinite(n.remaining) ? n.remaining : 0), 0),
      health: !pool.enabled ? "disabled" : !numbers.length ? "empty" : eligible.length === numbers.length ? "healthy" : eligible.length ? "partial" : "down",
      numbers,
    });
  }
  return out;
}

export function marketCoverage(graph, market_id, pools) {
  const routes = (graph.routes.get(market_id) || []).filter((r) => r.tier !== AFFINITY_TIERS.BLOCKED && r.enabled);
  const lines = routes.map((r) => {
    const h = pools.get(r.pool_key);
    return {
      pool_key: r.pool_key,
      pool_name: h?.name || r.pool_key,
      tier: r.tier,
      priority: r.priority,
      provenance: r.provenance,
      local: isLocalPool(graph, r.pool_key, market_id),
      eligible: h && h.enabled ? h.eligible : 0,
      total: h?.total || 0,
      health: h?.health || "empty",
      remaining_capacity: h && h.enabled ? h.remaining_capacity : 0,
    };
  });
  const firstEligible = lines.findIndex((l) => l.eligible > 0);
  let status;
  if (firstEligible === -1) status = COVERAGE_STATUS.UNCOVERED;
  else if (firstEligible > 0) status = COVERAGE_STATUS.DEGRADED;
  else status = lines[0].local ? COVERAGE_STATUS.LOCAL : COVERAGE_STATUS.REGIONAL;
  const active = firstEligible === -1 ? null : lines[firstEligible];
  return {
    market_id,
    display_name: graph.markets.get(market_id)?.display_name || market_id,
    status,
    active_pool: active?.pool_key || null,
    label: active ? routeLabel(graph, { pool_key: active.pool_key, market_id }) : null,
    routes: lines,
    blocked_pools: (graph.routes.get(market_id) || []).filter((r) => r.tier === AFFINITY_TIERS.BLOCKED).map((r) => r.pool_key),
  };
}

/** The whole surface: markets x ordered pools x health + metrics. */
export function computeCoverage({ graph, fleet = [], blocked = new Set(), now = new Date(), per_sender_cap = null, parkedByMarket = null } = {}) {
  const pools = poolHealth(graph, { fleet, blocked, now, per_sender_cap });
  const markets = [...graph.markets.keys()].map((id) => ({ ...marketCoverage(graph, id, pools), parked_sends: parkedByMarket ? parkedByMarket.get(id) || 0 : null }));
  const by = (s) => markets.filter((m) => m.status === s).length;
  const eligibleNumbers = new Set();
  let capacity = 0;
  for (const p of pools.values()) {
    if (!p.enabled) continue;
    for (const n of p.numbers) {
      if (n.eligible && !eligibleNumbers.has(n.textgrid_number_id || n.phone)) {
        eligibleNumbers.add(n.textgrid_number_id || n.phone);
        capacity += Number.isFinite(n.remaining) ? n.remaining : 0;
      }
    }
  }
  const parked = parkedByMarket ? [...parkedByMarket.values()].reduce((s, n) => s + n, 0) : null;
  return {
    graph_version: graph.version,
    graph_source: graph.source,
    definitions: COVERAGE_DEFINITIONS,
    metrics: {
      markets: markets.length,
      local: by(COVERAGE_STATUS.LOCAL),
      regional: by(COVERAGE_STATUS.REGIONAL),
      degraded: by(COVERAGE_STATUS.DEGRADED),
      uncovered: by(COVERAGE_STATUS.UNCOVERED),
      healthy_senders: eligibleNumbers.size,
      daily_capacity_remaining: capacity,
      parked_sends: parked,
    },
    pools: [...pools.values()],
    markets,
  };
}

/** A copy of the graph with one market's routes replaced (for previews). */
export function withMarketRoutes(graph, market_id, routes = []) {
  const next = new Map(graph.routes);
  const list = routes
    .map((r, i) => ({
      route_id: clean(r.route_id) || `${market_id}:${r.pool_key}`,
      market_id,
      pool_key: clean(r.pool_key),
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : (i + 1) * 10,
      tier: clean(r.tier || r.affinity_tier),
      enabled: r.enabled !== false,
      provenance: clean(r.provenance) || "operator_edit",
      notes: clean(r.notes) || null,
    }))
    .filter((r) => graph.pools.has(r.pool_key) && Object.values(AFFINITY_TIERS).includes(r.tier))
    .sort((a, b) => a.priority - b.priority);
  next.set(market_id, list);
  return Object.freeze({ ...graph, routes: next });
}

/**
 * Impact of replacing a market's routes, on the sends that would route through
 * it (queued / scheduled / parked rows for that market). No writes.
 *   rows [{ id, market_id, campaign_id, thread_number|from_phone_number }]
 */
export function previewRouteEdit({ graph, market_id, routes, rows = [], fleet = [], blocked = new Set(), now = new Date(), per_sender_cap = null } = {}) {
  const after = withMarketRoutes(graph, market_id, routes);
  const ctx = { fleet, blocked, now, per_sender_cap };
  const pick = (g, row) =>
    selectSender({ market_id, purpose: clean(row.campaign_id) ? PURPOSES.PROACTIVE : PURPOSES.REPLY, thread_number: row.thread_number || row.from_phone_number || null }, { ...ctx, graph: g });
  const changes = { became_routable: 0, lost_coverage: 0, changed_pool: 0, unchanged: 0 };
  const detail = rows
    .filter((row) => row.market_id === market_id)
    .map((row) => {
      const a = pick(graph, row);
      const b = pick(after, row);
      let effect = "unchanged";
      if (!a.ok && b.ok) effect = "became_routable";
      else if (a.ok && !b.ok) effect = "lost_coverage";
      else if (a.ok && b.ok && a.pool_key !== b.pool_key) effect = "changed_pool";
      changes[effect] += 1;
      return { id: row.id, effect, before: a.ok ? a.pool_key : a.cause, after: b.ok ? b.pool_key : b.cause };
    });
  const pools = poolHealth(after, ctx);
  const poolsBefore = poolHealth(graph, ctx);
  return {
    market_id,
    coverage_before: marketCoverage(graph, market_id, poolsBefore).status,
    coverage_after: marketCoverage(after, market_id, pools).status,
    rows_considered: detail.length,
    ...changes,
    detail,
  };
}
