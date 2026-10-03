/**
 * SENDER ROUTING 2.0 — the routing graph loader (server-side, canonical).
 *
 * Reads the PROPOSED tables (migration 20261002130000_sender_routing_v2.sql):
 *   sender_pools · sender_pool_numbers · market_sender_routes
 * plus canonical_markets, and the latest graph_version from sender_routing_audit.
 * Never from frontend constants, env vars or campaign code.
 *
 * Fail-safe: if the schema is not there (migration not applied) or a read
 * fails, the loader returns { ok:false } and latches "schema unavailable" for
 * 10 minutes so the hot path makes no further reads. Callers then keep the
 * legacy router (sender-routing-runtime.js) — a missing graph never holds
 * traffic by itself.
 */

import { buildRoutingGraph } from "./sender-routing-policy.js";

export const GRAPH_TABLES = Object.freeze({
  pools: "sender_pools",
  pool_numbers: "sender_pool_numbers",
  routes: "market_sender_routes",
  audit: "sender_routing_audit",
  overrides: "sender_routing_overrides",
  markets: "canonical_markets",
});

const SCHEMA_MISSING_CODES = new Set(["PGRST106", "PGRST205", "PGRST204", "42P01", "3F000", "42501"]);
const SCHEMA_MISSING_RE = /(relation .* does not exist|could not find the table|schema cache|permission denied)/i;
const CACHE_TTL_MS = 30_000;
const LATCH_MS = 10 * 60_000;

let cached = null;
let latchedUntil = 0;

export function isSchemaMissingError(error) {
  if (!error) return false;
  return SCHEMA_MISSING_CODES.has(String(error.code || "")) || SCHEMA_MISSING_RE.test(String(error.message || ""));
}

async function getSupabase(deps) {
  if (deps.supabase) return deps.supabase;
  const { hasSupabaseConfig, supabase } = await import("../../../supabase/client.js");
  if (!hasSupabaseConfig()) throw new Error("supabase_not_configured");
  return supabase;
}

async function readAll(supabase, table, select) {
  const { data, error } = await supabase.from(table).select(select).limit(5000);
  if (error) throw Object.assign(new Error(error.message || `${table}_read_failed`), { code: error.code, table });
  return Array.isArray(data) ? data : [];
}

/** Raw rows from the database, or throws. */
export async function readGraphRows(deps = {}) {
  const supabase = await getSupabase(deps);
  const [markets, pools, pool_numbers, routes, audit] = await Promise.all([
    readAll(supabase, GRAPH_TABLES.markets, "id,display_name,state,is_active"),
    readAll(supabase, GRAPH_TABLES.pools, "id,pool_key,display_name,home_market_id,is_active"),
    readAll(supabase, GRAPH_TABLES.pool_numbers, "id,sender_pool_id,textgrid_number_id,status"),
    readAll(supabase, GRAPH_TABLES.routes, "id,market_id,sender_pool_id,priority,affinity_tier,enabled,provenance,notes,updated_at"),
    supabase.from(GRAPH_TABLES.audit).select("graph_version").not("graph_version", "is", null).order("graph_version", { ascending: false }).limit(1).then(({ data, error }) => {
      if (error) throw Object.assign(new Error(error.message), { code: error.code, table: GRAPH_TABLES.audit });
      return data || [];
    }),
  ]);
  return {
    markets: markets.filter((m) => m.is_active !== false),
    pools,
    pool_numbers,
    routes,
    version: audit[0]?.graph_version ?? null,
    source: "live",
  };
}

/** { ok, graph } | { ok:false, reason }. Cached 30 s; schema-missing latched 10 min. */
export async function loadRoutingGraph(deps = {}) {
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  if (typeof deps.loadGraphRows === "function") {
    try {
      return { ok: true, graph: buildRoutingGraph(await deps.loadGraphRows()) };
    } catch (error) {
      return { ok: false, reason: isSchemaMissingError(error) ? "graph_schema_unavailable" : "graph_read_failed", error: error?.message };
    }
  }
  if (now < latchedUntil) return { ok: false, reason: "graph_schema_unavailable" };
  if (cached && now - cached.at < CACHE_TTL_MS) return { ok: true, graph: cached.graph };
  try {
    const graph = buildRoutingGraph(await readGraphRows(deps));
    cached = { graph, at: now };
    return { ok: true, graph };
  } catch (error) {
    if (isSchemaMissingError(error)) {
      latchedUntil = now + LATCH_MS;
      return { ok: false, reason: "graph_schema_unavailable" };
    }
    return { ok: false, reason: "graph_read_failed", error: error?.message };
  }
}

export function invalidateRoutingGraphCache() {
  cached = null;
  latchedUntil = 0;
}
