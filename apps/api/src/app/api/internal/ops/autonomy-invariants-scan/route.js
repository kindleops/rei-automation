// Autonomy invariant scan (supersprint §18).
//
// A READ-ONLY watchdog that loads bounded windows of the canonical tables and
// runs the pure invariant evaluator over them, returning a machine-readable
// report of impossible / dangerous cross-entity states. It never writes: no
// repair, no mutation, no send. Fatal (monetary / identity) violations are
// surfaced with `fail_closed: true` so a caller can refuse to proceed.
//
// Auth: internal secret / cron, same contract as the other internal scanners.

import { NextResponse } from "next/server";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import {
  evaluateAutonomyInvariants,
  summarizeInvariantViolations,
  AUTONOMY_INVARIANTS_VERSION,
} from "@/lib/domain/seller-flow/autonomy-invariants.js";
import { info, warn } from "@/lib/logging/logger.js";

export const dynamic = "force-dynamic";

// Bounded windows: a scan must finish and must never be neutered by an
// oversized query string. Clamp everything.
const DEFAULT_WINDOW_HOURS = 72;
const MAX_WINDOW_HOURS = 24 * 30;
const DEFAULT_ROW_LIMIT = 2000;
const MAX_ROW_LIMIT = 5000;

export function clampPositiveInt(raw, fallback, max) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, Math.round(parsed)), max);
}

function hoursAgoIso(hours, nowMs) {
  return new Date(nowMs - hours * 60 * 60 * 1000).toISOString();
}

async function readWindow(supabase, table, build) {
  try {
    const { data, error } = await build(supabase.from(table).select("*"));
    if (error) return { rows: [], error: error.message || `${table}_read_failed` };
    return { rows: Array.isArray(data) ? data : [], error: null };
  } catch (error) {
    return { rows: [], error: error?.message || `${table}_read_failed` };
  }
}

/**
 * Load bounded, read-only windows of the canonical tables. Every read error is
 * captured (never thrown) so a single unavailable table degrades the report
 * rather than hiding every other invariant.
 */
export async function loadInvariantWindows(supabase, { window_hours, row_limit, now_ms }) {
  const since = hoursAgoIso(window_hours, now_ms);
  const [offers, closing_cases, queue_rows, opportunities, followups] = await Promise.all([
    readWindow(supabase, "seller_offers", (q) => q.order("created_at", { ascending: false }).limit(row_limit)),
    readWindow(supabase, "closing_cases", (q) => q.order("created_at", { ascending: false }).limit(row_limit)),
    readWindow(supabase, "send_queue", (q) => q.gte("created_at", since).order("created_at", { ascending: false }).limit(row_limit)),
    readWindow(supabase, "acquisition_opportunities", (q) => q.order("updated_at", { ascending: false }).limit(row_limit)),
    readWindow(supabase, "send_queue", (q) => q.in("queue_status", ["scheduled", "queued", "pending"]).eq("message_type", "follow_up").limit(row_limit)),
  ]);
  return {
    windows: {
      offers: offers.rows,
      closing_cases: closing_cases.rows,
      queue_rows: queue_rows.rows,
      opportunities: opportunities.rows,
      followups: followups.rows.map((r) => ({ thread_key: r.thread_key || r.to_phone_number, status: "scheduled", due_at: r.scheduled_for })),
    },
    read_errors: Object.fromEntries(
      [["seller_offers", offers], ["closing_cases", closing_cases], ["send_queue", queue_rows], ["acquisition_opportunities", opportunities], ["followups", followups]]
        .filter(([, r]) => r.error)
        .map(([k, r]) => [k, r.error])
    ),
    since,
  };
}

export async function handleAutonomyInvariantsScanRequest(request, deps = {}) {
  const auth = (deps.requireInternalSecret || requireInternalSecret)(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, reason: auth.error || "unauthorized" }, { status: auth.status || 401 });
  }

  const params = new URL(request.url).searchParams;
  const window_hours = clampPositiveInt(params.get("window_hours"), DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS);
  const row_limit = clampPositiveInt(params.get("row_limit"), DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT);
  const now_ms = deps.now ? deps.now() : Date.now();

  const resolve_supabase = deps.resolveSupabase || resolveCanonicalSupabase;
  const supabase = deps.supabase || (await resolve_supabase());
  if (!supabase) {
    // The watchdog looked at nothing. That must never read as "clean".
    warn("autonomy_invariants_scan.supabase_unconfigured", {});
    return NextResponse.json({ ok: false, reason: "supabase_unconfigured", scanned: false, version: AUTONOMY_INVARIANTS_VERSION }, { status: 500 });
  }

  const load = deps.loadInvariantWindows || loadInvariantWindows;
  const { windows, read_errors, since } = await load(supabase, { window_hours, row_limit, now_ms });

  const violations = evaluateAutonomyInvariants({ ...windows, now: new Date(now_ms).toISOString() });
  const summary = summarizeInvariantViolations(violations);
  const truncated = Object.values(windows).some((rows) => rows.length >= row_limit);

  const report = {
    ok: summary.ok && Object.keys(read_errors).length === 0,
    scanned: true,
    version: AUTONOMY_INVARIANTS_VERSION,
    window_hours,
    row_limit,
    since,
    // A capped window means the counts are a floor; say so.
    truncated,
    read_errors,
    counts: Object.fromEntries(Object.entries(windows).map(([k, v]) => [k, v.length])),
    summary,
    fatal: violations.filter((v) => v.fatal),
    violations,
  };

  if (summary.fatal > 0) {
    warn("autonomy_invariants_scan.fatal_violations", {
      fatal: summary.fatal,
      total: summary.total,
      by_code: summary.by_code,
      sample: report.fatal.slice(0, 5).map((v) => ({ code: v.code, entity_type: v.entity_type, entity_id: v.entity_id })),
    });
  } else {
    info("autonomy_invariants_scan.completed", { total: summary.total, counts: report.counts, truncated });
  }

  return NextResponse.json(report, { status: 200 });
}

export async function resolveCanonicalSupabase() {
  try {
    const { hasSupabaseConfig } = await import("@/lib/supabase/client.js");
    if (!hasSupabaseConfig()) return null;
    const { getDefaultSupabaseClient } = await import("@/lib/supabase/default-client.js");
    return getDefaultSupabaseClient() || null;
  } catch {
    return null;
  }
}

export async function GET(request) {
  return handleAutonomyInvariantsScanRequest(request);
}

export async function POST(request) {
  return handleAutonomyInvariantsScanRequest(request);
}
