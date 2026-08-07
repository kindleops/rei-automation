// ─── campaign-recommendation-service.js ──────────────────────────────────
// Campaign recommendation service — SHADOW / RECOMMEND-ONLY (spine gap G11).
//
// Produces deterministic, versioned, explainable campaign recommendations per
// market. This module has NO code path that creates, activates, schedules, or
// mutates campaigns, send_queue rows, or any execution surface. Its only
// write is an insert into public.campaign_recommendations (status 'proposed'),
// and that persistence degrades gracefully to compute-only while the table's
// migration is unapplied. Autonomous scheduling is explicitly out of scope.
//
// Architecture:
//   computeCampaignRecommendations(inputs)   — PURE + deterministic scoring
//   buildCampaignRecommendationInputs(opts)  — impure gatherer; reuses
//     buildWarRoom() (send_queue/message_events/campaigns/textgrid aggregates
//     incl. its template leaderboard, which is the template-intelligence
//     rollup over the same fact tables) rather than duplicating its SQL, plus
//     the coverage-report inventory measure (v_outbound_discovery_fresh,
//     mirrors app/api/internal/outbound/coverage-report/route.js:51-139) and
//     textgrid_numbers daily caps for capacity.
//   persistCampaignRecommendations(rows)     — insert-only, replay-idempotent
//     via the (market, property_class, campaign_type, model_version,
//     recommended_on) natural key; 23505 → deduped no-op.
//   generateCampaignRecommendations(opts)    — gather → compute → persist.
//
// Declared-but-unfed input slots (documented pending): seller score
// (shadow_eligible_primary lives only in offline pilot scripts) and buyer
// demand/liquidity. Both appear in every score_breakdown with reserved weight,
// contribution 0, status 'pending_unfed' until a real feed exists.

import { hasSupabaseConfig, supabase } from "@/lib/supabase/client.js";
import { buildWarRoom } from "@/lib/domain/metrics/war-room-service.js";
import { child } from "@/lib/logging/logger.js";

const logger = child({
  module: "domain.recommendation.campaign_recommendation_service",
});

export const RECOMMENDATION_MODEL_VERSION = "campaign_reco_v1";

export const RECOMMENDATION_CAMPAIGN_TYPES = Object.freeze([
  // Large untouched eligible inventory + healthy delivery → open new volume.
  "cold_outreach_expansion",
  // Market already responding well with capacity headroom → add volume.
  "scale_active_market",
  // Volume exists but replies lag while delivery is fine → new creative, not
  // more of the same.
  "template_refresh",
]);

const MIN_RECOMMENDATION_SCORE = 0.35;
const TABLE = "campaign_recommendations";

function clean(value) {
  return String(value ?? "").trim();
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

// Percent (0-100) → 0-1 signal.
function rate01(value) {
  return clamp01(Number(value) / 100);
}

// Untouched-inventory saturation: how much of the reachable market this
// window's sends already consumed. 0 = untouched, 1 = fully saturated.
export function computeMarketSaturation({ window_sent = 0, eligible = 0 } = {}) {
  const sent = Math.max(0, Number(window_sent) || 0);
  const inventory = Math.max(0, Number(eligible) || 0);
  if (sent + inventory === 0) return 1;
  return round4(sent / (sent + inventory));
}

// log-scaled inventory signal: 0 at zero inventory, ~1 at 10k+ eligible rows.
function inventorySignal(eligible = 0) {
  const inventory = Math.max(0, Number(eligible) || 0);
  return clamp01(Math.log10(1 + inventory) / 4);
}

function capacityHeadroom({ daily_capacity = null, window_sent = 0, window_days = 7 } = {}) {
  const capacity = Number(daily_capacity);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    // Capacity unknown → neutral 0.5, flagged 'estimated' in the breakdown.
    return { value: 0.5, status: "estimated_no_capacity_data" };
  }
  const days = Math.max(1, Number(window_days) || 1);
  const avg_daily_sent = (Number(window_sent) || 0) / days;
  return {
    value: clamp01(1 - avg_daily_sent / capacity),
    status: "measured",
  };
}

// ── Scoring model (all weights fixed per model version) ───────────────────
const PENDING_SLOTS = Object.freeze([
  { signal: "seller_score", weight: 0.1 },
  { signal: "buyer_demand_liquidity", weight: 0.1 },
]);

const WEIGHTS = Object.freeze({
  cold_outreach_expansion: {
    untouched_inventory: 0.35,
    delivery_rate: 0.2,
    capacity_headroom: 0.15,
    low_saturation: 0.15,
    positive_rate: 0.1,
    reply_rate: 0.05,
    opt_out_rate: -0.15,
  },
  scale_active_market: {
    reply_rate: 0.3,
    positive_rate: 0.25,
    delivery_rate: 0.15,
    capacity_headroom: 0.15,
    template_strength: 0.1,
    untouched_inventory: 0.05,
    opt_out_rate: -0.2,
  },
  template_refresh: {
    refresh_need: 0.45,
    template_weakness: 0.2,
    delivery_rate: 0.15,
    untouched_inventory: 0.1,
    opt_out_rate: -0.1,
  },
});

// Delivery gate: a market delivering under 85% (with real volume) should not
// be recommended for more volume; scores are multiplied down, with a reason.
const DELIVERY_GATE_THRESHOLD = 85;
const DELIVERY_GATE_MULTIPLIER = 0.25;
const DELIVERY_GATE_MIN_SENT = 20;

function buildSignalValues({ market_row, eligible, capacity, window_days }) {
  const sent = Number(market_row?.sent) || 0;
  const delivery_rate = Number(market_row?.deliveryRate) || 0;
  const reply_rate = Number(market_row?.replyRate) || 0;
  const positive_rate = Number(market_row?.positiveRate) || 0;
  const opt_out_rate = Number(market_row?.optOutRate) || 0;
  const saturation = computeMarketSaturation({
    window_sent: sent,
    eligible,
  });
  const headroom = capacityHeadroom({
    daily_capacity: capacity?.daily_capacity ?? null,
    window_sent: sent,
    window_days,
  });
  // Template strength: share of window templates in this market that the
  // template rollup marks as scalable (0-1); weakness is its complement.
  const template_strength = clamp01(capacity?.template_strength ?? 0);
  // Refresh need: real volume with lagging reply rate (reply < 5% at 50+ sends).
  const refresh_need =
    sent >= 50 ? clamp01((5 - reply_rate) / 5) : 0;

  return {
    sent,
    delivery_rate,
    reply_rate,
    positive_rate,
    opt_out_rate,
    saturation,
    values: {
      untouched_inventory: inventorySignal(eligible),
      delivery_rate: rate01(delivery_rate),
      capacity_headroom: headroom.value,
      capacity_headroom_status: headroom.status,
      low_saturation: clamp01(1 - saturation),
      positive_rate: rate01(positive_rate),
      reply_rate: clamp01(reply_rate / 10), // 10%+ reply = full signal
      opt_out_rate: clamp01(opt_out_rate / 3), // 3%+ opt-out = full penalty
      template_strength,
      template_weakness: clamp01(1 - template_strength),
      refresh_need,
    },
  };
}

function scoreCampaignType({ campaign_type, signals }) {
  const weights = WEIGHTS[campaign_type];
  const breakdown = [];
  let score = 0;

  for (const [signal, weight] of Object.entries(weights)) {
    const value = clamp01(signals.values[signal] ?? 0);
    const contribution = round4(weight * value);
    score += contribution;
    breakdown.push({
      signal,
      weight,
      value: round4(value),
      contribution,
      status:
        signal === "capacity_headroom"
          ? signals.values.capacity_headroom_status
          : "measured",
    });
  }

  for (const slot of PENDING_SLOTS) {
    breakdown.push({
      signal: slot.signal,
      weight: slot.weight,
      value: null,
      contribution: 0,
      status: "pending_unfed",
    });
  }

  return { score: round4(score), breakdown };
}

function buildReasons({ campaign_type, signals, eligible, gated }) {
  const reasons = [];

  if (campaign_type === "cold_outreach_expansion") {
    reasons.push(
      `${eligible} eligible never-contacted rows in inventory (saturation ${(signals.saturation * 100).toFixed(1)}%).`
    );
  }
  if (campaign_type === "scale_active_market") {
    reasons.push(
      `Window performance: ${signals.reply_rate}% reply, ${signals.positive_rate}% positive on ${signals.sent} sends.`
    );
  }
  if (campaign_type === "template_refresh") {
    reasons.push(
      `Reply rate ${signals.reply_rate}% on ${signals.sent} sends with ${signals.delivery_rate}% delivery — volume exists, creative is not converting.`
    );
  }

  reasons.push(
    `Delivery ${signals.delivery_rate}%, opt-out ${signals.opt_out_rate}%.`
  );

  if (signals.values.capacity_headroom_status === "estimated_no_capacity_data") {
    reasons.push("Capacity headroom estimated: no daily-cap data for this market.");
  }

  if (gated) {
    reasons.push(
      `Delivery below ${DELIVERY_GATE_THRESHOLD}% on ${signals.sent} sends — score gated to ${DELIVERY_GATE_MULTIPLIER}x; fix deliverability before adding volume.`
    );
  }

  reasons.push(
    "Seller-score and buyer-demand inputs are declared but unfed (pending)."
  );

  return reasons;
}

/**
 * PURE deterministic scoring. Same inputs ⇒ same output (deep-equal), no I/O.
 *
 * inputs = {
 *   window_label, window_days, generated_at,
 *   markets: [war-room market_leaderboard rows],
 *   inventory_by_market: { [market]: eligible_never_contacted },
 *   capacity_by_market: { [market]: { daily_capacity, template_strength } },
 *   data_freshness: {...},
 * }
 */
export function computeCampaignRecommendations(inputs = {}) {
  const markets = Array.isArray(inputs.markets) ? inputs.markets : [];
  const inventory = inputs.inventory_by_market || {};
  const capacity = inputs.capacity_by_market || {};
  const window_days = Math.max(1, Number(inputs.window_days) || 7);
  const recommendations = [];

  for (const market_row of markets) {
    const market = clean(market_row?.market);
    if (!market) continue;

    const eligible = Math.max(0, Number(inventory[market]) || 0);
    const signals = buildSignalValues({
      market_row,
      eligible,
      capacity: capacity[market] || null,
      window_days,
    });

    const gated =
      signals.sent >= DELIVERY_GATE_MIN_SENT &&
      signals.delivery_rate < DELIVERY_GATE_THRESHOLD;

    for (const campaign_type of RECOMMENDATION_CAMPAIGN_TYPES) {
      const { score, breakdown } = scoreCampaignType({
        campaign_type,
        signals,
      });
      const gated_score = gated
        ? round4(score * DELIVERY_GATE_MULTIPLIER)
        : score;

      if (gated_score < MIN_RECOMMENDATION_SCORE) continue;

      recommendations.push({
        market,
        // Class-level response metrics are not broken out upstream yet; the
        // canonical communication classes (spine §7) slot in here once
        // Agent A's classifier feeds per-class aggregates.
        property_class: "all",
        campaign_type,
        score: gated_score,
        score_breakdown: gated
          ? [
              ...breakdown,
              {
                signal: "delivery_gate",
                weight: null,
                value: DELIVERY_GATE_MULTIPLIER,
                contribution: round4(gated_score - score),
                status: "gate_applied",
              },
            ]
          : breakdown,
        reasons: buildReasons({ campaign_type, signals, eligible, gated }),
        data_freshness: inputs.data_freshness || {},
        status: "proposed",
        model_version: RECOMMENDATION_MODEL_VERSION,
        recommended_at: inputs.generated_at || null,
      });
    }
  }

  // Deterministic order: score desc, then market, then campaign_type.
  recommendations.sort(
    (a, b) =>
      b.score - a.score ||
      a.market.localeCompare(b.market) ||
      a.campaign_type.localeCompare(b.campaign_type)
  );

  return recommendations;
}

// ── Impure input gatherer ─────────────────────────────────────────────────
const defaultDeps = {
  hasSupabaseConfig,
  getClient: () => supabase,
  buildWarRoom,
  logger,
  now: () => new Date(),
};

let runtimeDeps = { ...defaultDeps };

export function __setCampaignRecommendationTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetCampaignRecommendationTestDeps() {
  runtimeDeps = { ...defaultDeps };
}

function windowDays(label) {
  const match = /^(\d+)d$/.exec(clean(label));
  if (match) return Number(match[1]);
  return 7;
}

export async function buildCampaignRecommendationInputs({
  window = "30d",
} = {}) {
  const war_room = await runtimeDeps.buildWarRoom({ window });
  const client = runtimeDeps.getClient();

  // Untouched eligible inventory per market — the coverage-report measure
  // (v_outbound_discovery_fresh, never_contacted = true). PostgREST caps a
  // single response, so this is a lower-bound sample; flagged in freshness.
  const inventoryRes = await client
    .from("v_outbound_discovery_fresh")
    .select("market")
    .eq("never_contacted", true);

  const inventory_by_market = {};
  for (const row of inventoryRes?.data || []) {
    const market = clean(row?.market) || "unknown";
    inventory_by_market[market] = (inventory_by_market[market] || 0) + 1;
  }

  // Sending capacity per market: active textgrid numbers' daily caps.
  const numbersRes = await client
    .from("textgrid_numbers")
    .select("market,is_active,daily_cap");

  const capacity_by_market = {};
  for (const row of numbersRes?.data || []) {
    if (row?.is_active === false) continue;
    const market = clean(row?.market);
    if (!market) continue;
    const cap = Number(row?.daily_cap);
    if (!capacity_by_market[market]) {
      capacity_by_market[market] = { daily_capacity: 0, template_strength: 0 };
    }
    if (Number.isFinite(cap) && cap > 0) {
      capacity_by_market[market].daily_capacity += cap;
    }
  }

  // Template strength per market from the war-room template rollup (the
  // template-intelligence aggregate over the same fact tables): share of a
  // market's window templates marked 'Scale'.
  const template_totals = {};
  for (const tpl of war_room?.sms_template_leaderboard || []) {
    const market = clean(tpl?.topMarket);
    if (!market || market === "—") continue;
    if (!template_totals[market]) template_totals[market] = { total: 0, scale: 0 };
    template_totals[market].total += 1;
    if (tpl.recommendation === "Scale") template_totals[market].scale += 1;
  }
  for (const [market, counts] of Object.entries(template_totals)) {
    if (!capacity_by_market[market]) {
      capacity_by_market[market] = { daily_capacity: 0, template_strength: 0 };
    }
    capacity_by_market[market].template_strength =
      counts.total > 0 ? counts.scale / counts.total : 0;
  }

  const generated_at = runtimeDeps.now().toISOString();

  return {
    window_label: war_room?.window || clean(window),
    window_days: windowDays(war_room?.window || window),
    generated_at,
    markets: war_room?.market_leaderboard || [],
    inventory_by_market,
    capacity_by_market,
    data_freshness: {
      generated_at,
      window: war_room?.window || clean(window),
      sources: {
        market_metrics: "war-room live query (send_queue + message_events)",
        template_strength: "war-room sms_template_leaderboard rollup",
        inventory:
          "v_outbound_discovery_fresh never_contacted sample (PostgREST row-capped; lower bound)",
        capacity: "textgrid_numbers active daily_cap sum",
        seller_score: "pending_unfed",
        buyer_demand_liquidity: "pending_unfed",
      },
      inventory_rows_sampled: (inventoryRes?.data || []).length,
      inventory_query_error: inventoryRes?.error?.message || null,
      capacity_query_error: numbersRes?.error?.message || null,
    },
  };
}

function isMissingTableError(error) {
  if (!error) return false;
  const code = clean(error.code);
  const message = clean(error.message).toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    message.includes("does not exist") ||
    message.includes("could not find the table")
  );
}

export async function persistCampaignRecommendations(recommendations = []) {
  if (!runtimeDeps.hasSupabaseConfig()) {
    return {
      attempted: false,
      persisted: 0,
      deduped: 0,
      failed: 0,
      reason: "supabase_not_configured",
    };
  }

  const client = runtimeDeps.getClient();
  let persisted = 0;
  let deduped = 0;
  let failed = 0;

  for (const rec of recommendations) {
    const row = {
      market: rec.market,
      property_class: rec.property_class,
      campaign_type: rec.campaign_type,
      score: rec.score,
      score_breakdown: rec.score_breakdown,
      reasons: rec.reasons,
      data_freshness: rec.data_freshness,
      model_version: rec.model_version,
      status: "proposed",
    };

    const inserted = await client.from(TABLE).insert(row);

    if (inserted?.error) {
      if (isMissingTableError(inserted.error)) {
        runtimeDeps.logger.warn("campaign_recommendations.table_missing_noop", {
          reason: "campaign_recommendations_table_missing",
        });

        return {
          attempted: true,
          persisted,
          deduped,
          failed,
          reason: "campaign_recommendations_table_missing",
        };
      }

      if (clean(inserted.error.code) === "23505") {
        deduped += 1;
        continue;
      }

      failed += 1;
      runtimeDeps.logger.warn("campaign_recommendations.insert_failed", {
        market: rec.market,
        campaign_type: rec.campaign_type,
        error: clean(inserted.error.message) || "unknown_error",
      });
      continue;
    }

    persisted += 1;
  }

  return {
    attempted: true,
    persisted,
    deduped,
    failed,
    reason: "campaign_recommendations_persisted",
  };
}

/**
 * Gather → compute → (optionally) persist. Shadow-only end to end.
 */
export async function generateCampaignRecommendations({
  window = "30d",
  persist = true,
} = {}) {
  const inputs = await buildCampaignRecommendationInputs({ window });
  const recommendations = computeCampaignRecommendations(inputs);

  const persistence = persist
    ? await persistCampaignRecommendations(recommendations)
    : {
        attempted: false,
        persisted: 0,
        deduped: 0,
        failed: 0,
        reason: "persist_disabled",
      };

  runtimeDeps.logger.info("campaign_recommendations.generated", {
    window: inputs.window_label,
    markets_evaluated: inputs.markets.length,
    recommendations: recommendations.length,
    persistence_reason: persistence.reason,
    persisted: persistence.persisted,
  });

  return {
    ok: true,
    shadow_only: true,
    model_version: RECOMMENDATION_MODEL_VERSION,
    window: inputs.window_label,
    generated_at: inputs.generated_at,
    markets_evaluated: inputs.markets.length,
    recommendations,
    persistence,
  };
}

export default generateCampaignRecommendations;
