/**
 * SENDER ROUTING 2.0 — production wiring for the Sender Coverage surface,
 * route-edit preview / save, and the wake sweep. Server-side only; routes call
 * these behind the operator (ensureMutationAuth) or cron auth.
 *
 *   readSenderCoverage    READ-ONLY. Live graph when the PROPOSED schema exists,
 *                         else the proposal (labelled source 'proposal', not
 *                         enabled) so the owner can review it in place.
 *   previewMarketRoutes   READ-ONLY impact preview of a route edit.
 *   saveMarketRoutes      GATED write (SENDER_ROUTING_GRAPH_WRITES env +
 *                         system_control.sender_routing_graph_writes), through
 *                         the service_role-only function
 *                         sender_routing_replace_market_routes (atomic, audited,
 *                         versioned). Refuses when the gate is off or the
 *                         schema is absent.
 *   runSenderWakeSweep    dry run unless both wake gates are on.
 */

import { withDerivedSentToday } from "@/lib/domain/delivery/sender-sent-today.js";
import { buildRoutingGraph, deriveLifecycleState, normalizeE164, webhookStateOf, AFFINITY_TIERS } from "./sender-routing-policy.js";
import { SENDER_ROUTING_FLAGS, isSenderRoutingFlagEnabled } from "./sender-routing-gate.js";
import { GRAPH_TABLES, invalidateRoutingGraphCache, isSchemaMissingError, loadRoutingGraph } from "./sender-routing-graph.js";
import { computeCoverage, previewRouteEdit } from "./sender-coverage.js";
import { PROPOSED_GRAPH_VERSION, PROPOSED_SEED_BACKFILL, proposedGraphRows } from "./proposed-initial-graph.js";
import { applyBackfillToFleet } from "./sender-inventory-reconciliation.js";
import { PARKED_QUEUE_STATUS, isParkedForSender, runWakeSweep } from "./sender-routing-wake.js";

const clean = (value) => String(value ?? "").trim();
const CANDIDATE_STATUSES = ["queued", "scheduled", PARKED_QUEUE_STATUS];

async function db(deps) {
  if (deps.supabase) return deps.supabase;
  return (await import("@/lib/supabase/client.js")).supabase;
}

export async function loadFleet(deps = {}) {
  if (typeof deps.loadFleet === "function") return deps.loadFleet();
  const supabase = await db(deps);
  const { data, error } = await supabase.from("textgrid_numbers").select("*").limit(200);
  if (error) throw error;
  return withDerivedSentToday(supabase, Array.isArray(data) ? data : [], deps);
}

export async function loadBlocked(deps = {}) {
  if (typeof deps.loadBlocked === "function") return deps.loadBlocked();
  try {
    const guard = await import("@/lib/domain/delivery/sms-health-guard.js");
    const sc = await guard.loadSmsHealthGuardSystemControl(deps.getSystemValue || null);
    if (!sc || sc.sms_blocked_sender_numbers === undefined) return null;
    return new Set([...guard.getDispatchBlockedSets(deps.env || process.env, sc).sender_numbers].map(normalizeE164).filter(Boolean));
  } catch {
    return null;
  }
}

async function loadPerSenderCap(deps) {
  if (deps.per_sender_cap !== undefined) return deps.per_sender_cap;
  const { loadConfiguredPerSenderCap } = await import("@/lib/domain/campaigns/sender-capacity.js");
  return loadConfiguredPerSenderCap(deps);
}

async function loadMarkets(deps) {
  if (typeof deps.loadMarkets === "function") return deps.loadMarkets();
  const supabase = await db(deps);
  const { data, error } = await supabase.from(GRAPH_TABLES.markets).select("id,display_name,state,is_active").limit(500);
  if (error) throw error;
  return (data || []).filter((m) => m.is_active !== false);
}

/** Send rows that route through the graph: queued, scheduled and sender-parked, with market + thread number resolved. */
export async function loadRoutableRows(deps = {}) {
  if (typeof deps.loadRoutableRows === "function") return deps.loadRoutableRows();
  const supabase = await db(deps);
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_status,guard_reason,failed_reason,campaign_id,from_phone_number,thread_key,property_id,market,market_id,scheduled_for_utc,metadata")
    .in("queue_status", CANDIDATE_STATUSES)
    .limit(2000);
  if (error) throw error;
  const rows = data || [];
  const propertyIds = [...new Set(rows.map((r) => clean(r.property_id || r.metadata?.property_id)).filter(Boolean))];
  const threadKeys = [...new Set(rows.map((r) => clean(r.thread_key)).filter(Boolean))];
  const [props, threads] = await Promise.all([
    propertyIds.length ? supabase.from("properties").select("property_id,canonical_market_id").in("property_id", propertyIds) : { data: [] },
    threadKeys.length ? supabase.from("inbox_thread_state").select("thread_key,our_number").in("thread_key", threadKeys) : { data: [] },
  ]);
  const marketOf = new Map((props.data || []).map((p) => [String(p.property_id), p.canonical_market_id]));
  const ourOf = new Map((threads.data || []).map((t) => [t.thread_key, t.our_number]));
  return rows.map((r) => ({
    ...r,
    market_id: marketOf.get(clean(r.property_id || r.metadata?.property_id)) || clean(r.market_id) || null,
    thread_number: clean(r.from_phone_number) || clean(ourOf.get(r.thread_key)) || null,
  }));
}

async function resolveGraph(deps, fleet) {
  const live = await loadRoutingGraph(deps);
  if (live.ok) return { graph: live.graph, status: "live" };
  const markets = await loadMarkets(deps);
  return { graph: buildRoutingGraph(proposedGraphRows({ markets, fleet })), status: live.reason === "graph_schema_unavailable" ? "proposal_schema_not_applied" : "proposal_live_graph_unreadable" };
}

export async function readSenderCoverage(deps = {}) {
  const [gate, fleet, blocked, per_sender_cap] = await Promise.all([
    isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env: deps.env || process.env, readSystemValue: deps.readSystemFlag || null }),
    loadFleet(deps),
    loadBlocked(deps),
    loadPerSenderCap(deps).catch(() => null),
  ]);
  const { graph, status } = await resolveGraph(deps, fleet);
  // Proposal mode: review the graph as the seed would leave the fleet (its
  // evidence backfill applied in memory, labelled in the response).
  const fleetView = status === "live" ? fleet : applyBackfillToFleet(fleet, PROPOSED_SEED_BACKFILL);
  let rows = [];
  try {
    rows = await loadRoutableRows(deps);
  } catch {
    rows = null;
  }
  const parkedByMarket = rows ? new Map() : null;
  for (const row of rows || []) {
    if (!isParkedForSender(row) || !row.market_id) continue;
    parkedByMarket.set(row.market_id, (parkedByMarket.get(row.market_id) || 0) + 1);
  }
  const coverage = computeCoverage({ graph, fleet: fleetView, blocked: blocked || new Set(), now: deps.now || new Date(), per_sender_cap, parkedByMarket });
  return {
    ok: true,
    gate: { enabled: gate.enabled, reason: gate.reason },
    graph_status: status,
    graph_enabled: gate.enabled && status === "live",
    seed_backfill_simulated: status !== "live",
    proposal_version: status === "live" ? null : PROPOSED_GRAPH_VERSION,
    blocklist_readable: Boolean(blocked),
    per_sender_cap,
    parked_unresolved_market: (rows || []).filter((r) => isParkedForSender(r) && !r.market_id).length,
    numbers: fleetView.map((row) => ({
      phone: `•••${normalizeE164(row.phone_number).slice(-4)}`,
      market: row.market || null,
      lifecycle: deriveLifecycleState(row, { blocked: blocked || new Set(), now: deps.now || new Date() }),
      webhook: webhookStateOf(row),
      registration_status: row.registration_status || null,
    })),
    ...coverage,
  };
}

function validateRoutes(routes = []) {
  const errors = [];
  const seen = new Set();
  const tiers = new Set(Object.values(AFFINITY_TIERS));
  routes.forEach((r, i) => {
    const key = clean(r?.pool_key);
    if (!key) errors.push({ index: i, error: "pool_key_required" });
    if (seen.has(key)) errors.push({ index: i, error: "duplicate_pool" });
    seen.add(key);
    if (!tiers.has(clean(r?.tier || r?.affinity_tier))) errors.push({ index: i, error: "invalid_tier" });
  });
  return errors;
}

export async function previewMarketRoutes({ market_id, routes = [] } = {}, deps = {}) {
  const errors = validateRoutes(routes);
  if (!clean(market_id)) errors.push({ error: "market_id_required" });
  if (errors.length) return { ok: false, status: 400, error: "invalid_routes", errors };
  const [fleet, blocked, per_sender_cap] = await Promise.all([loadFleet(deps), loadBlocked(deps), loadPerSenderCap(deps).catch(() => null)]);
  const { graph, status } = await resolveGraph(deps, fleet);
  const fleetView = status === "live" ? fleet : applyBackfillToFleet(fleet, PROPOSED_SEED_BACKFILL);
  if (!graph.markets.has(market_id)) return { ok: false, status: 404, error: "market_not_canonical" };
  const rows = await loadRoutableRows(deps).catch(() => []);
  return { ok: true, graph_status: status, ...previewRouteEdit({ graph, market_id, routes, rows, fleet: fleetView, blocked: blocked || new Set(), now: deps.now || new Date(), per_sender_cap }) };
}

export async function saveMarketRoutes({ market_id, routes = [], reason = null } = {}, { operator = null } = {}, deps = {}) {
  const gate = await isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.GRAPH_WRITES, { env: deps.env || process.env, readSystemValue: deps.readSystemFlag || null });
  if (!gate.enabled) return { ok: false, status: 423, error: "graph_writes_disabled", reason: gate.reason };
  if (!clean(operator)) return { ok: false, status: 401, error: "operator_required" };
  if (!clean(reason)) return { ok: false, status: 400, error: "reason_required" };
  const errors = validateRoutes(routes);
  if (errors.length) return { ok: false, status: 400, error: "invalid_routes", errors };
  const supabase = await db(deps);
  const payload = routes.map((r, i) => ({ pool_key: clean(r.pool_key), priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : (i + 1) * 10, affinity_tier: clean(r.tier || r.affinity_tier), enabled: r.enabled !== false, notes: clean(r.notes) || null }));
  const { data, error } = await supabase.rpc("sender_routing_replace_market_routes", { p_market_id: market_id, p_routes: payload, p_actor: clean(operator), p_reason: clean(reason) });
  if (error) {
    if (isSchemaMissingError(error) || /function .* does not exist|PGRST202/i.test(`${error.code} ${error.message}`)) return { ok: false, status: 409, error: "routing_schema_not_applied" };
    return { ok: false, status: 400, error: "route_write_rejected", message: error.message };
  }
  invalidateRoutingGraphCache();
  return { ok: true, graph_version: data ?? null };
}

export async function runSenderWakeSweep({ trigger = "periodic", apply = false, force = false } = {}, deps = {}) {
  const env = deps.env || process.env;
  const [routing, wakeApply] = await Promise.all([
    isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env, readSystemValue: deps.readSystemFlag || null }),
    isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.WAKE_APPLY, { env, readSystemValue: deps.readSystemFlag || null }),
  ]);
  const supabase = routing.enabled ? await db(deps) : null;
  let lastFingerprint = null;
  if (routing.enabled && trigger === "periodic") {
    const { data } = await supabase.from(GRAPH_TABLES.audit).select("subject").eq("event_type", "wake_run").order("created_at", { ascending: false }).limit(1);
    lastFingerprint = data?.[0]?.subject?.fingerprint || null;
  }
  const result = await runWakeSweep({ trigger, apply, force }, {
    now: deps.now,
    gates: { routing: routing.enabled, wakeApply: wakeApply.enabled },
    lastFingerprint,
    perSenderCap: await loadPerSenderCap(deps).catch(() => null),
    loadGraph: async () => {
      const g = await loadRoutingGraph(deps);
      return g.ok ? g.graph : null;
    },
    loadFleet: () => loadFleet(deps),
    loadBlocked: () => loadBlocked(deps),
    loadParkedRows: async () => (await loadRoutableRows(deps)).filter(isParkedForSender),
    applyWake: async (id, wake_status, note) => {
      const { data: current } = await supabase.from("send_queue").select("metadata,queue_status").eq("id", id).maybeSingle();
      if (!current || current.queue_status !== PARKED_QUEUE_STATUS) return false;
      const { data, error } = await supabase
        .from("send_queue")
        .update({ queue_status: wake_status, guard_status: null, guard_reason: null, failed_reason: null, updated_at: new Date().toISOString(), metadata: { ...(current.metadata || {}), sender_route_wake: note } })
        .eq("id", id)
        .eq("queue_status", PARKED_QUEUE_STATUS)
        .select("id");
      return !error && (data || []).length === 1;
    },
  });
  if (routing.enabled && !result.skipped) {
    await supabase.from(GRAPH_TABLES.audit).insert({ event_type: "wake_run", actor: "sender_routing_wake", reason: trigger, subject: { fingerprint: result.fingerprint, dry_run: result.dry_run, parked: result.parked, routable: result.routable, writes: result.writes } }).then(() => null, () => null);
  }
  return { ...result, outcomes: (result.outcomes || []).map(({ sender_routing, ...rest }) => rest) };
}

/**
 * Campaign Composer: sender coverage for an audience (READ-ONLY).
 *   markets [{ market_id?, market?, state?, targets }]
 * The engine reported is the one that dispatches NOW: Sender Routing 2.0 only
 * when its gate is on AND the live graph loads (otherwise the runtime falls
 * back to the legacy router, so the preview does too). With the gate off the
 * graph preview (live, else the labelled proposal) is returned as v2_preview.
 */
export async function readAudienceSenderCoverage({ markets = [] } = {}, deps = {}) {
  const { previewAudienceSenderCoverage } = await import("./audience-coverage-preview.js");
  const [gate, fleet, blocked, per_sender_cap] = await Promise.all([
    isSenderRoutingFlagEnabled(SENDER_ROUTING_FLAGS.ROUTING, { env: deps.env || process.env, readSystemValue: deps.readSystemFlag || null }),
    loadFleet(deps),
    loadBlocked(deps),
    loadPerSenderCap(deps).catch(() => null),
  ]);
  if (!blocked) return { ok: false, error: "sender_blocklist_unreadable" };
  const { graph, status } = await resolveGraph(deps, fleet);
  const live = status === "live";
  const fleetForGraph = live ? fleet : applyBackfillToFleet(fleet, PROPOSED_SEED_BACKFILL);
  const engineIsV2 = gate.enabled && live;
  // The legacy pass uses the graph ONLY for canonical labels + state (what the
  // planner's candidates carry); its routing is the legacy router's own.
  const legacy = await previewAudienceSenderCoverage({ markets, gate_enabled: false, graph, fleet, blocked, per_sender_cap, now: deps.now || new Date() });
  const v2 = await previewAudienceSenderCoverage({ markets, gate_enabled: true, graph, fleet: fleetForGraph, blocked, per_sender_cap, now: deps.now || new Date() });
  if (engineIsV2) return { ok: true, gate: gate.reason, ...v2 };
  return {
    ok: true,
    gate: gate.reason,
    ...legacy,
    v2_preview: { label: `Sender Routing 2.0 preview — NOT the engine that sends today (${gate.enabled ? "graph not live" : "gate off"})`, graph_status: status, seed_backfill_simulated: !live, graph_version: graph.version, markets: v2.markets, totals: v2.totals },
  };
}
