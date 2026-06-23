import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { hasSupabaseConfig, supabase } from "@/lib/supabase/client.js";
import { requireCronAuth } from "@/lib/security/cron-auth.js";
import { INTERNAL_TEST_PHONE_SET, isInternalTestPhone } from "@/lib/config/internal-phones.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const logger = child({ module: "api.internal.outbound.coverage_report" });

export async function GET(request) {
  const auth = requireCronAuth(request, logger);
  if (!auth.authorized) return auth.response;

  if (!hasSupabaseConfig()) {
    return NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 503 });
  }

  try {
    const [
      totalProperties,
      totalOwners,
      totalPhones,
      discoveryViewRows,
      outreachStateRows,
      sendQueueRows,
      messageEventRows,
      nullOwnerEventCount,
      freshByMarket,
    ] = await Promise.all([
      supabase.from("properties").select("id", { count: "exact", head: true }),
      supabase.from("master_owners").select("id", { count: "exact", head: true }),
      supabase.from("phones").select("id", { count: "exact", head: true }),
      supabase.from("v_outbound_discovery_fresh").select("never_contacted"),
      supabase.from("contact_outreach_state").select("last_sms_at, suppression_until, touch_count"),
      supabase.from("send_queue").select("queue_status, to_phone_number, master_owner_id"),
      supabase
        .from("message_events")
        .select("to_phone_number, master_owner_id, property_id, created_at")
        .eq("direction", "outbound")
        .order("created_at", { ascending: false })
        .limit(3000),
      supabase
        .from("message_events")
        .select("id", { count: "exact", head: true })
        .eq("direction", "outbound")
        .is("master_owner_id", null),
      supabase
        .from("v_outbound_discovery_fresh")
        .select("market")
        .eq("never_contacted", true),
    ]);

    // ── Discovery view stats ──────────────────────────────────────────────
    const disc_rows = Array.isArray(discoveryViewRows.data) ? discoveryViewRows.data : [];
    const disc_never = disc_rows.filter((r) => r.never_contacted === true).length;
    const disc_prev = disc_rows.filter((r) => r.never_contacted === false).length;

    // ── Outreach state stats ──────────────────────────────────────────────
    const cos_rows = Array.isArray(outreachStateRows.data) ? outreachStateRows.data : [];
    const cos_with_sms = cos_rows.filter((r) => r.last_sms_at).length;
    const cos_suppressed = cos_rows.filter(
      (r) => r.suppression_until && new Date(r.suppression_until) > new Date()
    ).length;
    const cos_touch_cap = cos_rows.filter((r) => Number(r.touch_count ?? 0) >= 5).length;

    // ── Send queue stats ──────────────────────────────────────────────────
    const queue_rows = Array.isArray(sendQueueRows.data) ? sendQueueRows.data : [];
    const queue_by_status = {};
    const active_statuses = new Set(["queued", "scheduled", "pending", "approved", "ready", "sending"]);
    let queue_active = 0;
    const queue_active_phones = new Set();
    const queue_active_owners = new Set();
    for (const r of queue_rows) {
      queue_by_status[r.queue_status] = (queue_by_status[r.queue_status] || 0) + 1;
      if (active_statuses.has(r.queue_status)) {
        queue_active++;
        if (r.to_phone_number) queue_active_phones.add(r.to_phone_number);
        if (r.master_owner_id) queue_active_owners.add(r.master_owner_id);
      }
    }

    // ── Message events: separate real vs internal ─────────────────────────
    const ev_rows = Array.isArray(messageEventRows.data) ? messageEventRows.data : [];
    const real_ev = ev_rows.filter((r) => !isInternalTestPhone(r.to_phone_number));
    const internal_ev = ev_rows.filter((r) => isInternalTestPhone(r.to_phone_number));

    // Real seller repeat abuse (>= 3 touches)
    const real_phone_counts = {};
    for (const r of real_ev) {
      if (!r.master_owner_id) continue;
      const key = `${r.to_phone_number}|${r.master_owner_id}`;
      if (!real_phone_counts[key]) {
        real_phone_counts[key] = {
          to_phone_number: r.to_phone_number,
          master_owner_id: r.master_owner_id,
          count: 0,
          first_at: r.created_at,
          last_at: r.created_at,
        };
      }
      real_phone_counts[key].count++;
      if (r.created_at < real_phone_counts[key].first_at) real_phone_counts[key].first_at = r.created_at;
      if (r.created_at > real_phone_counts[key].last_at) real_phone_counts[key].last_at = r.created_at;
    }
    const top_repeat_real = Object.values(real_phone_counts)
      .filter((e) => e.count >= 3)
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const internal_phone_counts = {};
    for (const r of internal_ev) {
      const key = r.to_phone_number;
      if (!internal_phone_counts[key]) {
        internal_phone_counts[key] = { to_phone_number: key, count: 0 };
      }
      internal_phone_counts[key].count++;
    }
    const internal_summary = Object.values(internal_phone_counts);

    // Real seller unique phones / owners
    const real_unique_phones = new Set(real_ev.map((r) => r.to_phone_number)).size;
    const real_unique_owners = new Set(real_ev.filter((r) => r.master_owner_id).map((r) => r.master_owner_id)).size;
    const real_unique_props = new Set(real_ev.filter((r) => r.property_id).map((r) => r.property_id)).size;

    // Fresh inventory by market
    const fresh_rows = Array.isArray(freshByMarket.data) ? freshByMarket.data : [];
    const market_counts = {};
    for (const r of fresh_rows) {
      const m = r.market || "unknown";
      market_counts[m] = (market_counts[m] || 0) + 1;
    }
    const fresh_by_market = Object.entries(market_counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([market, count]) => ({ market, eligible_never_contacted: count }));

    const total_properties = totalProperties.count ?? 0;
    const total_owners = totalOwners.count ?? 0;

    return NextResponse.json({
      ok: true,
      generated_at: new Date().toISOString(),

      inventory_funnel: {
        total_properties,
        total_master_owners: total_owners,
        total_phones: totalPhones.count ?? 0,
        discovery_view_total: disc_rows.length,
        discovery_never_contacted: disc_never,
        discovery_previously_contacted: disc_prev,
        property_coverage_pct:
          total_properties > 0 ? Math.round((real_unique_props / total_properties) * 10000) / 100 : 0,
        owner_coverage_pct:
          total_owners > 0 ? Math.round((real_unique_owners / total_owners) * 10000) / 100 : 0,
        note: "~82,710 properties (71%) have no master_owner_id — not contactable until owner is linked",
      },

      real_seller_metrics: {
        total_outbound_events: real_ev.length,
        unique_phones_contacted: real_unique_phones,
        unique_owners_contacted: real_unique_owners,
        unique_properties_contacted: real_unique_props,
        high_touch_phones_gte5: Object.values(real_phone_counts).filter((e) => e.count >= 5).length,
      },

      internal_test_metrics: {
        registered_internal_phones: [...INTERNAL_TEST_PHONE_SET],
        total_internal_events_in_sample: internal_ev.length,
        internal_phones_found: internal_summary,
        excluded_from_seller_kpis: true,
      },

      contact_state_health: {
        outreach_state_total: cos_rows.length,
        outreach_state_with_sms: cos_with_sms,
        outreach_state_suppressed_now: cos_suppressed,
        touch_cap_candidates_gte5: cos_touch_cap,
        gap_warning:
          cos_with_sms < real_unique_owners
            ? `${real_unique_owners - cos_with_sms} real contacted owners missing from contact_outreach_state — run outbound-contact-state-reconcile.sql`
            : "ok",
      },

      send_queue: {
        by_status: queue_by_status,
        active_pending_count: queue_active,
        active_unique_phones: queue_active_phones.size,
        active_unique_owners: queue_active_owners.size,
      },

      safety_flags: {
        null_owner_outbound_events: nullOwnerEventCount.count ?? 0,
        null_owner_flag:
          (nullOwnerEventCount.count ?? 0) > 0
            ? "WARNING: outbound events with null owner detected — dedup bypassed for these"
            : "ok",
      },

      fresh_inventory_by_market: fresh_by_market,
      fresh_inventory_total: fresh_rows.length,

      top_repeat_real_seller_contacts: top_repeat_real,
    });
  } catch (error) {
    logger.error("coverage_report.failed", { error: error?.message });
    return NextResponse.json(
      { ok: false, error: error?.message || "coverage_report_failed" },
      { status: 500 }
    );
  }
}
