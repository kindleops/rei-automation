// ─── route-title-company.js ─────────────────────────────────────────────────
// Supabase-native, market-based title-company routing.
//
// Routing contract:
//   property ZIP -> canonical market -> primary title company -> backup
//
// This preserves the ORIGINAL architecture rather than replacing it:
//   * market canonicalization reuses the existing registry helpers
//     (normalizeMarketLabel + MARKET_ALIASES from config/market-sending-zones.js,
//     the same canonical labels config/markets.js defines);
//   * company fields mirror the original Podio Title Companies app shape that
//     domain/title/select-title-company.js consumed (name / contact manager /
//     new-order email / phone);
//   * the prior "filter by market, best first, take one" behavior becomes an
//     explicit ranked route (rank 1 primary, rank 2 backup).
//
// DETERMINISTIC + IDEMPOTENT. Selection is ordered by route_rank over ACTIVE
// routes, and the DB enforces at most one active company per (market, rank), so
// the same case always resolves to the same company regardless of row order. A
// case that is already routed is never re-routed.
//
// FAILS CLOSED. If the primary is unavailable or lacks the contact email the
// title intro requires, the configured backup is used. If neither exists, the
// case records a durable `title_route_unavailable` condition — no company is
// fabricated and nothing silently continues.

import { normalizeMarketLabel, MARKET_ALIASES } from "@/lib/config/market-sending-zones.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

export const TITLE_ROUTE_VERSION = "title_route_v1";

export const TITLE_ROUTE_STATUS = Object.freeze({
  ROUTED: "routed",
  UNAVAILABLE: "title_route_unavailable",
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

const ALIAS_BY_LOWER = new Map(
  Object.entries(MARKET_ALIASES).map(([alias, canonical]) => [
    lower(normalizeMarketLabel(alias)),
    normalizeMarketLabel(canonical),
  ])
);

/**
 * Canonical market label for routing. Reuses the existing normalizer + alias
 * table so title routing lands on the SAME canonical market the rest of the
 * system uses ("Fort Worth, TX" -> "Dallas, TX").
 */
export function canonicalizeMarket(raw_market) {
  const normalized = normalizeMarketLabel(raw_market);
  if (!normalized) return null;
  if (lower(normalized) === "unmapped") return null;
  return ALIAS_BY_LOWER.get(lower(normalized)) || normalized;
}

/**
 * The company attached to a route row. Accepts either the mapped `company`
 * shape or the raw PostgREST embed (`title_companies`), so the same predicate
 * works on a loader result and on a raw row.
 */
export function routeCompany(route = {}) {
  return route.company || route.title_companies || null;
}

/** A route is usable only if its company is active and has the intro email. */
export function isUsableRoute(route = {}) {
  if (route.is_active === false) return false;
  const company = routeCompany(route);
  // No company attached is NOT usable: routing must never fall back to reading
  // contact fields off the route row itself.
  if (!company) return false;
  if (company.is_active === false) return false;
  return Boolean(clean(company.new_order_email));
}

/**
 * Choose the winning route from ranked candidates: lowest rank that is usable.
 * Pure and exported so primary/backup precedence is directly assertable.
 */
export function chooseRoute(routes = []) {
  const ordered = [...(Array.isArray(routes) ? routes : [])]
    .filter((r) => r && r.is_active !== false)
    .sort((a, b) => Number(a.route_rank ?? 99) - Number(b.route_rank ?? 99));

  const winner = ordered.find(isUsableRoute);
  if (!winner) {
    return {
      ok: false,
      reason: ordered.length ? "no_usable_title_company" : "no_route_for_market",
    };
  }
  return { ok: true, route: winner, is_primary: Number(winner.route_rank) === 1 };
}

/**
 * Resolve the canonical market for a closing case: the property record is the
 * ZIP-bearing anchor, so market is read from it (falling back to the
 * opportunity). Returns { market, zip, source }.
 */
export async function resolveClosingCaseMarket({ closing_case = {}, supabase } = {}) {
  const property_id = clean(closing_case.property_id);
  if (property_id && supabase) {
    const { data, error } = await supabase
      .from("properties")
      .select("property_id,market,property_address_zip")
      .eq("property_id", property_id)
      .maybeSingle();
    if (!error && data) {
      const market = canonicalizeMarket(data.market);
      if (market) {
        return {
          market,
          zip: clean(data.property_address_zip) || null,
          source: "properties.market",
          raw_market: clean(data.market) || null,
        };
      }
    }
  }

  if (clean(closing_case.opportunity_id) && supabase) {
    const { data, error } = await supabase
      .from("acquisition_opportunities")
      .select("id,market")
      .eq("id", clean(closing_case.opportunity_id))
      .maybeSingle();
    if (!error && data) {
      const market = canonicalizeMarket(data.market);
      if (market) {
        return {
          market,
          zip: null,
          source: "acquisition_opportunities.market",
          raw_market: clean(data.market) || null,
        };
      }
    }
  }

  return { market: null, zip: null, source: null, raw_market: null };
}

async function loadRoutesForMarket(supabase, market) {
  const { data, error } = await supabase
    .from("title_company_market_routes")
    .select(
      "id,market,title_company_key,route_rank,is_active,route_version,title_companies(title_company_key,name,contact_manager,new_order_email,phone,is_active)"
    )
    .eq("market", market)
    .eq("is_active", true)
    .order("route_rank", { ascending: true })
    .limit(10);
  if (error) throw error;

  return (Array.isArray(data) ? data : []).map((row) => ({
    ...row,
    company: row.title_companies || null,
  }));
}

/**
 * Route (or return the existing routing for) a closing case's title company.
 *
 * Returns { ok, routed, already_routed, title_company_key, market, is_primary,
 *           status, reason }.
 * On failure the case is stamped with a durable title_route_unavailable status.
 */
export async function routeTitleCompanyForClosingCase({
  closing_case = null,
  closing_case_id = null,
  supabase: injected = null,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, routed: false, reason: "missing_supabase" };

  let case_row = closing_case;
  if (!case_row && clean(closing_case_id)) {
    const { data, error } = await supabase
      .from("closing_cases")
      .select("*")
      .eq("closing_case_id", clean(closing_case_id))
      .maybeSingle();
    if (error) return { ok: false, routed: false, reason: "lookup_failed" };
    case_row = data || null;
  }
  if (!case_row) return { ok: false, routed: false, reason: "closing_case_not_found" };

  const case_id = clean(case_row.closing_case_id);

  // IDEMPOTENT: an already-routed case is never re-routed. A webhook replay
  // cannot produce a second title routing.
  if (clean(case_row.title_company_key)) {
    return {
      ok: true,
      routed: false,
      already_routed: true,
      closing_case_id: case_id,
      title_company_key: clean(case_row.title_company_key),
      market: clean(case_row.title_route_market) || null,
      status: TITLE_ROUTE_STATUS.ROUTED,
      reason: "already_routed",
    };
  }

  const resolved_market = await resolveClosingCaseMarket({ closing_case: case_row, supabase });

  if (!resolved_market.market) {
    await stampUnavailable(supabase, case_id, { reason: "market_unresolved" });
    return {
      ok: false,
      routed: false,
      closing_case_id: case_id,
      status: TITLE_ROUTE_STATUS.UNAVAILABLE,
      reason: "market_unresolved",
    };
  }

  let routes = [];
  try {
    routes = await loadRoutesForMarket(supabase, resolved_market.market);
  } catch (error) {
    warn("[TITLE_ROUTE_LOOKUP_FAILED]", {
      closing_case_id: case_id,
      market: resolved_market.market,
      error: error?.message || "route_lookup_failed",
    });
    // A lookup failure is not proof that no route exists — do NOT stamp the
    // durable unavailable condition on a transient error.
    return { ok: false, routed: false, closing_case_id: case_id, reason: "route_lookup_failed" };
  }

  const chosen = chooseRoute(routes);
  if (!chosen.ok) {
    await stampUnavailable(supabase, case_id, {
      reason: chosen.reason,
      market: resolved_market.market,
    });
    return {
      ok: false,
      routed: false,
      closing_case_id: case_id,
      market: resolved_market.market,
      status: TITLE_ROUTE_STATUS.UNAVAILABLE,
      reason: chosen.reason,
    };
  }

  const company = routeCompany(chosen.route);
  const selected_at = new Date().toISOString();

  const { error: update_error } = await supabase
    .from("closing_cases")
    .update({
      title_company_key: clean(company.title_company_key),
      title_company_name: clean(company.name) || null,
      title_company_email: clean(company.new_order_email) || null,
      title_route_market: resolved_market.market,
      title_route_rank: Number(chosen.route.route_rank),
      title_route_source: resolved_market.source,
      title_route_version: clean(chosen.route.route_version) || TITLE_ROUTE_VERSION,
      title_route_status: TITLE_ROUTE_STATUS.ROUTED,
      title_company_selected_at: selected_at,
      last_activity_at: selected_at,
    })
    .eq("closing_case_id", case_id)
    // Only bind a route to a case that does not already have one (concurrency).
    .is("title_company_key", null);

  if (update_error) {
    warn("[TITLE_ROUTE_PERSIST_FAILED]", {
      closing_case_id: case_id,
      error: update_error?.message || "persist_failed",
    });
    return { ok: false, routed: false, closing_case_id: case_id, reason: "persist_failed" };
  }

  await recordRouteEvent(supabase, case_id, {
    market: resolved_market.market,
    zip: resolved_market.zip,
    title_company_key: clean(company.title_company_key),
    route_rank: Number(chosen.route.route_rank),
    is_primary: chosen.is_primary,
    route_version: clean(chosen.route.route_version) || TITLE_ROUTE_VERSION,
    source: resolved_market.source,
  });

  info("[TITLE_COMPANY_ROUTED]", {
    closing_case_id: case_id,
    market: resolved_market.market,
    title_company_key: company.title_company_key,
    is_primary: chosen.is_primary,
  });

  return {
    ok: true,
    routed: true,
    already_routed: false,
    closing_case_id: case_id,
    market: resolved_market.market,
    title_company_key: clean(company.title_company_key),
    title_company_email: clean(company.new_order_email) || null,
    is_primary: chosen.is_primary,
    route_rank: Number(chosen.route.route_rank),
    status: TITLE_ROUTE_STATUS.ROUTED,
    reason: "title_company_routed",
  };
}

async function stampUnavailable(supabase, closing_case_id, detail = {}) {
  try {
    await supabase
      .from("closing_cases")
      .update({
        title_route_status: TITLE_ROUTE_STATUS.UNAVAILABLE,
        title_route_version: TITLE_ROUTE_VERSION,
        title_route_market: clean(detail.market) || null,
        last_activity_at: new Date().toISOString(),
      })
      .eq("closing_case_id", closing_case_id);
    await recordRouteEvent(supabase, closing_case_id, {
      ...detail,
      status: TITLE_ROUTE_STATUS.UNAVAILABLE,
    });
  } catch (error) {
    warn("[TITLE_ROUTE_UNAVAILABLE_STAMP_FAILED]", {
      closing_case_id,
      error: error?.message || "stamp_failed",
    });
  }
}

async function recordRouteEvent(supabase, closing_case_id, detail = {}) {
  try {
    await supabase.from("closing_activity_events").insert({
      closing_case_id,
      event_type: "title_route",
      source: "title_router",
      idempotency_key: `title_route:${closing_case_id}:${clean(detail.title_company_key) || detail.status || detail.reason || "unresolved"}`,
      detail,
    });
  } catch {
    // Audit best-effort: never block routing on the event write.
  }
}

export default routeTitleCompanyForClosingCase;
