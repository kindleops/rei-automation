// Offline harness for Seller Autopilot S1–S4 v2: drives the REAL classifier,
// conversation-context builder, orchestrator and executor against an
// in-memory PostgREST-shaped database. No network, no provider, no prod.
// Shared by tests/critical/seller-autopilot-v2-flow.test.mjs and the
// read-only audit replay (scripts/ops/autopilot-v2-audit.mjs).

import { classify } from "@/lib/domain/classification/classify.js";
import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";

export const ALL_GROUPS = ["sfr", "duplex", "triplex", "fourplex", "small_multifamily", "multifamily_5_plus"];

export const PROD_LIKE_SYSTEM_CONTROL = Object.freeze({
  auto_reply_mode: "live_limited",
  auto_reply_eligibility_cutoff_at: "2026-09-09T23:08:01.626Z",
  auto_reply_thread_allowlist: "",
  campaign_mode: "live_limited",
  queue_emergency_stop_at: "",
});

export function tpl(template_id, use_case, language, template_body, { stage_code = null, reply_mode = "auto", property_type_scope = "Residential" } = {}) {
  return {
    template_id,
    id: `uuid-${template_id}`,
    use_case,
    stage_code,
    stage_label: null,
    template_name: `${use_case}_${language}_${template_id}`,
    language,
    reply_mode,
    property_type_scope,
    allowed_property_groups: property_type_scope ? ALL_GROUPS : null,
    prohibited_property_groups: null,
    usage_count: 0,
    success_rate: null,
    updated_at: "2026-10-01T00:00:00.000Z",
    is_active: true,
    safe_for_auto_reply: true,
    template_body,
  };
}

/** In-memory PostgREST-shaped client. Filters rows, applies inserts, records every write. */
export function memoryDb(seed = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  const writes = [];
  let seq = 0;
  const rowsOf = (t) => (tables[t] ||= []);
  const query = (table, mode, payload = null) => {
    const filters = [];
    let limit = null;
    let single = false;
    let order = null;
    const b = {
      select: () => b,
      eq: (c, v) => (filters.push((r) => r[c] === v), b),
      neq: (c, v) => (filters.push((r) => r[c] !== v), b),
      in: (c, vs) => (filters.push((r) => (vs || []).includes(r[c])), b),
      is: (c, v) => (filters.push((r) => (v === null ? r[c] == null : r[c] === v)), b),
      not: (c, op, v) => (op === "is" && v === null && filters.push((r) => r[c] != null), b),
      lt: (c, v) => (filters.push((r) => r[c] != null && String(r[c]) < String(v)), b),
      lte: (c, v) => (filters.push((r) => r[c] != null && String(r[c]) <= String(v)), b),
      gt: (c, v) => (filters.push((r) => r[c] != null && String(r[c]) > String(v)), b),
      gte: (c, v) => (filters.push((r) => r[c] != null && String(r[c]) >= String(v)), b),
      or: () => b, ilike: () => b, like: () => b, contains: () => b, filter: () => b, match: () => b, range: () => b,
      overlaps: () => b, textSearch: () => b,
      order: (c, o = {}) => ((order = { c, asc: o.ascending !== false }), b),
      limit: (n) => ((limit = n), b),
      maybeSingle: () => ((single = true), b),
      single: () => ((single = true), b),
      then(resolve, reject) {
        let out;
        if (mode === "select") {
          let rows = rowsOf(table).filter((r) => filters.every((f) => f(r)));
          if (order) rows = [...rows].sort((a, z) => (String(a[order.c]) < String(z[order.c]) ? -1 : 1) * (order.asc ? 1 : -1));
          if (limit != null) rows = rows.slice(0, limit);
          out = { data: single ? rows[0] ?? null : rows, error: null };
        } else {
          const saved = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `mem-${table}-${++seq}`, ...r }));
          writes.push({ table, mode, rows: saved });
          if (mode === "insert" || mode === "upsert") rowsOf(table).push(...saved);
          out = { data: single ? saved[0] ?? null : saved, error: null };
        }
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return b;
  };
  return {
    tables,
    writes,
    client: {
      from: (table) => ({
        select: () => query(table, "select"),
        insert: (p) => query(table, "insert", p),
        upsert: (p) => query(table, "upsert", p),
        update: (p) => query(table, "update", p),
        delete: () => query(table, "delete", {}),
      }),
      rpc: async () => ({ data: null, error: null }),
    },
  };
}

/** A Decision Engine snapshot shaped like a property_acquisition_scores row. */
export function adeSnapshot({
  property_id = "prop-v2-1",
  offer = 150_000,
  mao = 170_000,
  valuation_mid = 260_000,
  tier = "AUTO_RANGE_OFFER",
  comp_prices = [150_000, 160_000, 175_000, 180_000, 190_000],
  comp_distance = 0.6,
  comp_sale_date = "2026-07-15",
  computed_at = new Date(Date.now() - 5 * 86_400_000).toISOString(),
  asset_type = "single_family",
} = {}) {
  return {
    id: `pas-${property_id}`,
    property_id,
    recommended_cash_offer: offer,
    minimum_acceptable_offer: Math.round(offer * 0.93),
    investor_ceiling_mid: mao + 30_000,
    valuation_mid,
    valuation_confidence: 78,
    confidence: 82,
    comp_count: comp_prices.length,
    decision_tier: tier,
    computed_at,
    estimated_repairs: 40_000,
    evidence: {
      immutable_snapshot_id: `snap-${property_id}`,
      engine: { version: "2.0.0" },
      subject: { asset_type, normalized_features: { units: 1, asset_class: asset_type } },
      offer_calculation: {
        effective_authorized_ceiling: mao,
        assignment_margin_policy: { policy_version: "assignment_margin_v1", minimum_margin: 15_000, target_margin: 15_000 },
      },
      selected_comps: comp_prices.map((p, i) => ({
        id: `comp-${i + 1}`,
        comp_id: `comp-${i + 1}`,
        property_id: `cp-${i + 1}`,
        sale_price: p,
        sale_date: comp_sale_date,
        distance_miles: comp_distance,
        comp_confidence: 75,
        comp_score: 80,
        source: "public_record_sold",
      })),
    },
  };
}

/**
 * Run ONE seller inbound through the real pipeline. `db` persists across
 * turns: the prior outbound is whatever the previous turn queued (stamped
 * delivered here, the way the provider callback would).
 */
export async function runSellerTurn({
  db,
  thread = "+16125550123",
  message,
  receivedAt,
  propertyId = "prop-v2-1",
  ownerId = "mo-v2-1",
  stageBefore = "ownership_check",
  ade = null,
  propertySummary = {},
  autoReplyMode = "live_limited",
  systemControl = {},
}) {
  const control = { ...PROD_LIKE_SYSTEM_CONTROL, ...systemControl };
  const followups = [];
  const events = [];
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => db.client,
    getDealContextByThread: async () => null,
    probeDealContextAmbiguity: async () => ({ ambiguous: false }),
    runContactResolutionPhase: async () => ({ ran: false, sends: 0 }),
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 0 }),
    cancelPendingSellerEmails: async () => ({ ok: true, cancelled: 0 }),
    patchUniversalLeadState: async () => ({ ok: true }),
    emitAutomationEvent: async (event) => {
      events.push(event);
      return { ok: true };
    },
    executeReferralAutomation: async () => ({ ok: true }),
    // The legacy plan resolver reads the module-level Supabase client (not the
    // injected one), so offline it only burns 3×7 s of network retries. Its
    // result is a fallback behind canonical_decision.should_queue_reply, which
    // the canonical path always sets.
    resolveSellerAutoReplyPlan: async () => ({ ok: true, should_queue_reply: undefined, reason: "harness_legacy_plan_stub" }),
    scoreProperty: async () => (ade ? { ok: true, score: ade } : { ok: false, error: "no_ade_offline" }),
    scheduleFollowUp: async (intent) => {
      followups.push(intent);
      return { ok: true, followup_created: true, scheduled_for: "2026-11-05T00:00:00.000Z" };
    },
    info: () => {},
    warn: () => {},
  });
  try {
    const conversation_context = await buildConversationContext({
      thread_key: thread,
      inbound_received_at: receivedAt,
      supabase: db.client,
      canonical_stage: stageBefore,
    });
    const classification = await classify(message, null, { heuristicOnly: true, conversation_context });
    const before = db.writes.length;
    const out = await processSellerInboundMessage({
      message,
      threadKey: thread,
      inboundFrom: thread,
      inboundTo: "+16125550100",
      propertyId,
      ownerId,
      prospectId: "pros-v2-1",
      phoneId: "phone-v2-1",
      classification,
      context: {
        found: true,
        ids: { property_id: propertyId, master_owner_id: ownerId, prospect_id: "pros-v2-1", phone_item_id: "phone-v2-1" },
        summary: {
          conversation_stage: stageBefore,
          seller_stage: stageBefore,
          property_address: "1547 Summers Dr",
          seller_first_name: "Pat",
          ...propertySummary,
        },
      },
      route: { stage: stageBefore, use_case: stageBefore },
      inboundEventId: `evt-${thread}-${receivedAt}`,
      inboundReceivedAt: receivedAt,
      stageBefore,
      autoReplyMode,
      dryRun: false,
      proofRun: false,
      skipNotifications: true,
      supabaseClient: db.client,
      getSystemValue: async (key) => control[key] ?? null,
    });
    const inserts = db.writes
      .slice(before)
      .filter((w) => w.table === "send_queue" && w.mode === "insert")
      .flatMap((w) => w.rows);
    // The provider "delivers" what we queued so the next turn binds to it.
    for (const row of inserts) {
      row.queue_status = "delivered";
      row.sent_at = receivedAt;
      row.delivered_at = new Date(Date.parse(receivedAt) + 5_000).toISOString();
      row.provider_message_id = `SM-${row.id}`;
      row.to_phone_number = row.to_phone_number || thread;
    }
    // Record the inbound itself (so later turns see the question answered).
    db.tables.message_events = db.tables.message_events || [];
    db.tables.message_events.push({
      id: `in-${receivedAt}`,
      thread_key: thread,
      direction: "inbound",
      created_at: receivedAt,
      message_body: message,
      detected_intent: out?.classification?.primary_intent || classification.primary_intent,
    });
    return { out, inserts, followups, events, classification };
  } finally {
    __resetSellerInboundOrchestratorDeps();
  }
}

/** Seed a delivered campaign opener so turn 1 binds to the S1 ownership question. */
export function seedOpener(db, { thread = "+16125550123", body, deliveredAt, template_id = "200001" }) {
  db.tables.send_queue = db.tables.send_queue || [];
  db.tables.send_queue.push({
    id: "opener-1",
    to_phone_number: thread,
    thread_key: thread,
    message_type: "ownership_check",
    template_id,
    message_body: body,
    provider_message_id: "SM-opener",
    sent_at: deliveredAt,
    delivered_at: deliveredAt,
    queue_status: "delivered",
    type: "campaign",
    created_at: deliveredAt,
  });
}
