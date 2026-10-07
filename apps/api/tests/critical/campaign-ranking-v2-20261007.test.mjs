// Acquisition OS §11–19 / §67–72 / §89 / §94 — campaign ranking v2, tiers,
// market quality, discovery, Seller Screener, why-targeted, quality report.
// No network: every DB read is an injected fake that counts its calls.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { SCORE_VERSION, INPUT_MODEL_VERSION, buildRawFactsFromRows, scoreSellerSituation } from "@/lib/acquisition/seller-situation/index.js";
import { isCampaignRankingV2Enabled, isSellerScreenerEnabled } from "@/lib/domain/campaigns/ranking-v2/flags.js";
import {
  CAMPAIGN_RANKING_VERSION, RANK_TERMS, compareCampaignRankV2, computeCampaignRankV2, contactabilityScore,
  hasCurrentSituation, rankCampaignRowsV2, rankingMetadata,
} from "@/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js";
import { computeMarketQuality, marketAssetLane, marketQualityForRow } from "@/lib/domain/campaigns/ranking-v2/market-quality.js";
import { buildWhyTargeted, labelForEvidenceCode } from "@/lib/domain/campaigns/ranking-v2/why-targeted.js";
import {
  compileGraphPushdown, evaluateExpression, gateExpressionCoverage, normalizeScreenerExpression, runSellerScreener, screenRows,
} from "@/lib/domain/campaigns/ranking-v2/seller-screener.js";
import { measureMetricCoverage, screenerMetricCatalog } from "@/lib/domain/campaigns/ranking-v2/screener-metrics.js";
import { cohortSegment, summarizeCampaignQuality } from "@/lib/domain/campaigns/ranking-v2/campaign-quality-report.js";
import { rankDiscoveryZips } from "@/lib/domain/campaigns/ranking-v2/campaign-discovery.js";
import { applyCampaignRankingV2, rankingV2FetchLimit } from "@/lib/domain/campaigns/ranking-v2/ranking-context.js";
import { readWhyTargeted, runDiscovery, runScreener, _resetScreenerServiceCache } from "@/lib/domain/campaigns/ranking-v2/screener-service.js";
import { collapseGraphRowsToRecipients } from "@/lib/domain/campaigns/campaign-recipient-dedup.js";
import { planCampaignTargetRows, launchCandidateFromTarget } from "@/lib/domain/campaigns/campaign-automation-service.js";
import { graphFieldApplicability } from "@/lib/domain/campaigns/campaign-graph-filter-plan.js";
import { CAMPAIGN_FIELD_CATALOG, getCampaignFieldDefinition } from "@/lib/domain/campaigns/campaign-field-catalog.js";
import { makeCampaignQueuePlanStore } from "../helpers/campaign-queue-plan-store.mjs";

const ON = { CAMPAIGN_RANKING_V2: "on" };

function sit(tier, { fsp = null, sell365 = null, equity = null, fatigue = null, tax = null, codes = [], situation = "NO_CLEAR_SITUATION", reasons = null } = {}) {
  return {
    score_version: SCORE_VERSION,
    input_model_version: INPUT_MODEL_VERSION,
    scored_at: "2026-10-07T04:00:00.000Z",
    property_id: null,
    components: { forced_sale_pressure: fsp, landlord_fatigue: fatigue, equity_unlock: equity, property_burden: null, tax_pain: tax, debt_pressure: null },
    sell_probability: { d90: null, d180: null, d365: sell365 },
    seller_situation: situation,
    conversation_angle: null,
    opportunity_tier: tier,
    tier_reasons: reasons || codes.slice(0, 2),
    evidence: codes.map((code) => ({ code, points: 10, component: "forced_sale_pressure", source_table: "seller.property_features_v1", source_field: code.toLowerCase(), value: true, provenance: "public_record" })),
    coverage: { fields_known: 10, fields_total: 12, ratio: 0.83, missing: [] },
    confidence: 0.8,
    legacy_shadow: { final_acquisition_score: null, structured_motivation_score: null, tag_distress_score: null, deal_strength_score: null },
  };
}

function row(i, overrides = {}) {
  return {
    graph_id: `graph_${String(i).padStart(4, "0")}`,
    property_id: `prop_${i}`,
    master_owner_id: `mo_${i}`,
    seller_person_key: `person_${i}`,
    canonical_e164: `+1555300${String(1000 + i).slice(-4)}`,
    market: "Dallas, TX",
    state: "TX",
    property_zip: "75217",
    property_type: "Single Family",
    canonical_property_group: "Residential",
    sms_eligible: true,
    true_post_contact_suppression: false,
    wrong_number: false,
    pending_prior_touch: false,
    active_queue_item: false,
    sender_covered: true,
    sender_market: "Dallas, TX",
    timezone: "America/Chicago",
    identity_alignment: "verified",
    phone_type: "W",
    acquisition_score: 60,
    seller_first_name: "Ana",
    seller_full_name: "Ana Diaz",
    property_address_full: `${i} Main St, Dallas, TX`,
    touch_count: 0,
    never_contacted: true,
    queue_eligible: true,
    equity_percent: 60,
    total_loan_balance: 50000,
    ownership_years: 18,
    ...overrides,
  };
}

// ── flags (§84) ──────────────────────────────────────────────────────────────
test("flags: CAMPAIGN_RANKING_V2 and SELLER_SCREENER are separate and default OFF", () => {
  assert.equal(isCampaignRankingV2Enabled({}), false);
  assert.equal(isSellerScreenerEnabled({}), false);
  for (const v of ["1", "true", "on", "YES"]) assert.equal(isCampaignRankingV2Enabled({ CAMPAIGN_RANKING_V2: v }), true);
  for (const v of ["", "0", "off", "false", "maybe"]) assert.equal(isCampaignRankingV2Enabled({ CAMPAIGN_RANKING_V2: v }), false);
  assert.equal(isSellerScreenerEnabled({ CAMPAIGN_RANKING_V2: "on" }), false, "no master switch");
});

// ── ranking v2 (§11 / §12 / §67) ─────────────────────────────────────────────
test("§67: a tired-landlord-only seller (tier C) with legacy 99 never outranks a tax-delinquent, vacant, high-equity, long-tenure, high-repair seller (tier A) with no legacy score", () => {
  const softLegacy = { ...row(1, { acquisition_score: 99 }), _rank_v2: computeCampaignRankV2(row(1, { acquisition_score: 99 }), { situation: sit("C", { fatigue: 40, codes: ["VF_TIRED_LANDLORD"] }) }) };
  const acute = { ...row(2, { acquisition_score: null }), _rank_v2: computeCampaignRankV2(row(2, { acquisition_score: null }), { situation: sit("A", { fsp: 80, sell365: 40, equity: 85, codes: ["TAX_DELINQUENT", "VACANT", "EQUITY_80P", "TENURE_20Y", "REPAIR_TIER_HEAVY_FORMULA"] }) }) };
  assert.ok(compareCampaignRankV2(acute, softLegacy) < 0);
  assert.ok(acute._rank_v2.priority_score >= 75);
  assert.ok(softLegacy._rank_v2.priority_score < 50);
  assert.equal(softLegacy._rank_v2.legacy_shadow.final_acquisition_score, 99, "legacy is echoed, not used");
});

test("§12 fallback: no current situation → LEGACY FALLBACK band, marked, always below every v2 band; neither → unranked last", () => {
  const fb = computeCampaignRankV2(row(1, { acquisition_score: 100 }), { situation: null });
  assert.equal(fb.rank_source, "legacy_fallback");
  assert.equal(fb.band, "FALLBACK");
  assert.equal(fb.fallback_reason, "seller_situation_absent");
  assert.ok(fb.priority_score < 25, `fallback max ${fb.priority_score} must sit below tier C's floor`);
  const cZero = computeCampaignRankV2(row(2), { situation: sit("C", { fsp: 0, sell365: 0, equity: 0, fatigue: 0, tax: 0 }) });
  assert.ok(cZero.priority_score >= 25);
  const none = computeCampaignRankV2(row(3, { acquisition_score: null }), { situation: null });
  assert.equal(none.rank_source, "unranked");
  assert.equal(none.priority_score, null);
  const sorted = [none, fb, cZero].map((r, i) => ({ property_id: `p${i}`, _rank_v2: r })).sort(compareCampaignRankV2);
  assert.deepEqual(sorted.map((x) => x._rank_v2.band), ["C", "FALLBACK", "UNRANKED"]);
});

test("§12: stub, UNKNOWN tier and foreign score_version results never rank as v2", () => {
  assert.equal(hasCurrentSituation(sit("A", { reasons: ["STUB"] })), false);
  assert.equal(hasCurrentSituation(sit("UNKNOWN")), false);
  assert.equal(hasCurrentSituation({ ...sit("A"), score_version: "seller_situation_v1" }), false);
  const r = computeCampaignRankV2(row(1), { situation: sit("UNKNOWN") });
  assert.equal(r.rank_source, "legacy_fallback");
  assert.equal(r.fallback_reason, "seller_situation_tier_unknown");
});

test("unknown inputs use their documented neutral prior (never 0) and are reported as used_prior", () => {
  const r = computeCampaignRankV2(row(1, { identity_alignment: null, phone_type: null }), { situation: sit("B", {}) });
  const byKey = Object.fromEntries(r.terms.map((t) => [t.key, t]));
  for (const key of ["sell365", "forced_sale", "equity", "other_pressure", "aos", "market", "contact"]) {
    assert.equal(byKey[key].used_prior, true, key);
    assert.equal(byKey[key].points, Math.round(RANK_TERMS[key].weight * RANK_TERMS[key].prior * 100) / 100, key);
  }
  assert.equal(r.coverage.terms_known, 1, "only the stacked count is known");
  assert.equal(Object.values(RANK_TERMS).reduce((s, t) => s + t.weight, 0).toFixed(6), "1.000000");
});

test("ties and totals: equal ranks break by contactability then property id — a total, deterministic order", () => {
  const rows = [3, 1, 2].map((i) => row(i));
  const situations = new Map(rows.map((r) => [r.property_id, sit("B", { fsp: 50 })]));
  const a = rankCampaignRowsV2(rows, { situations }).map((r) => r.property_id);
  const b = rankCampaignRowsV2([...rows].reverse(), { situations }).map((r) => r.property_id);
  assert.deepEqual(a, ["prop_1", "prop_2", "prop_3"]);
  assert.deepEqual(a, b);
  const landline = row(0, { phone_type: "L" });
  const ranked = rankCampaignRowsV2([landline, row(9)], { situations: new Map([["prop_0", sit("B", { fsp: 50 })], ["prop_9", sit("B", { fsp: 50 })]]) });
  assert.equal(ranked[0].property_id, "prop_9", "same score: the mobile line ranks first");
});

test("property-based: 3,000 random rows — bands never interleave, legacy never lifts a row over current evidence", () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const tiers = ["A", "B", "C", "UNKNOWN", null];
  const rows = [];
  const situations = new Map();
  for (let i = 0; i < 3000; i += 1) {
    const r = row(i, { acquisition_score: rnd() < 0.3 ? null : Math.round(rnd() * 100), phone_type: rnd() < 0.5 ? "W" : "L", identity_alignment: ["verified", "probable", "unknown", null][Math.floor(rnd() * 4)] });
    rows.push(r);
    const t = tiers[Math.floor(rnd() * tiers.length)];
    if (t) situations.set(r.property_id, sit(t, { fsp: rnd() < 0.2 ? null : Math.round(rnd() * 100), sell365: Math.round(rnd() * 95), equity: Math.round(rnd() * 100), codes: Array.from({ length: Math.floor(rnd() * 6) }, (_, k) => `CODE_${k}`) }));
  }
  const ranked = rankCampaignRowsV2(rows, { situations });
  const order = { A: 0, B: 1, C: 2, FALLBACK: 3, UNRANKED: 4 };
  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok(order[ranked[i - 1]._rank_v2.band] <= order[ranked[i]._rank_v2.band], `band order broken at ${i}`);
    const p0 = ranked[i - 1]._rank_v2.priority_score;
    const p1 = ranked[i]._rank_v2.priority_score;
    if (p1 !== null) assert.ok(p0 >= p1);
  }
  for (const r of ranked) {
    const p = r._rank_v2.priority_score;
    if (p === null) continue;
    assert.ok(p >= 0 && p <= 100);
    if (r._rank_v2.band === "FALLBACK") assert.ok(p < 25);
  }
});

test("rankingMetadata is compact and labelled (never the legacy name)", () => {
  const m = rankingMetadata(computeCampaignRankV2(row(1), { situation: sit("A", { fsp: 80, codes: ["TAX_DELINQUENT", "VACANT"] }) }));
  assert.equal(m.ranking_version, CAMPAIGN_RANKING_VERSION);
  assert.equal(m.rank_source, "v2");
  assert.ok(Array.isArray(m.why) && m.why.some((w) => /tax delinquent/i.test(w)));
  assert.equal("final_acquisition_score" in m, false);
});

test("SQL twin pins the JS weights, priors and band encoding (PROPOSED_20261007080000)", () => {
  const sql = fs.readFileSync(new URL("../../../../supabase/migrations/PROPOSED_20261007080000_campaign_ranking_v2.sql", import.meta.url), "utf8");
  const sqlArg = { sell365: "p_sell365", forced_sale: "p_forced_sale", equity: "p_equity", other_pressure: "p_other_pressure", market: "p_market", contact: "p_contact" };
  for (const [key, arg] of Object.entries(sqlArg)) {
    const t = RANK_TERMS[key];
    assert.ok(sql.includes(`${t.weight} * coalesce(least(greatest(${arg}, 0), 100), ${t.prior})`), `SQL term ${key}`);
  }
  assert.ok(sql.includes(`${RANK_TERMS.stacked.weight} * least(coalesce(p_stacked_codes, 0) * 15, 100)`));
  assert.ok(sql.includes(`${RANK_TERMS.aos.weight} * coalesce(least(greatest(CASE WHEN p_aos > 100 THEN p_aos / 10 ELSE p_aos END, 0), 100), ${RANK_TERMS.aos.prior})`));
  for (const floor of [75, 50, 25]) assert.ok(sql.includes(`round(${floor} + 0.2499 * least(greatest(p_score,0),100), 2)`));
  assert.ok(sql.includes("round(0.2499 * least(greatest(p_legacy,0),100), 2)"));
  assert.ok(fs.existsSync(new URL("../../../../supabase/migrations/PROPOSED_20261007080000_campaign_ranking_v2_rollback.sql", import.meta.url)));
});

test("contactability: identity + line type + usage; null when nothing known (best_phone_score is never read)", () => {
  assert.equal(contactabilityScore({}), null);
  assert.equal(contactabilityScore({ best_phone_score: 99 }), null);
  assert.equal(contactabilityScore({ identity_alignment: "verified", phone_type: "W", usage_2_months: "Heavy Usage" }), 100);
  assert.equal(contactabilityScore({ identity_alignment: "mismatch", phone_type: "L", usage_2_months: "Minimal Usage" }), 20);
  assert.equal(contactabilityScore({ phone_type: "W" }), 20 + 30 + 15);
});

// ── build integration (byte-identical OFF, ranked ON) ────────────────────────
test("planCampaignTargetRows with the flag OFF: legacy order, legacy priority_score, no ranking metadata", async () => {
  const store = makeCampaignQueuePlanStore();
  const rows = [row(1, { acquisition_score: 40 }), row(2, { acquisition_score: 90 }), row(3, { acquisition_score: 70 })];
  const planned = await planCampaignTargetRows({ campaign: { id: "c1", name: "c1", metadata: {} }, options: {}, graph: { rows }, targetLimit: 10, deps: { supabase: store.supabase, env: {} }, resolveLanguages: false });
  assert.deepEqual(planned.rows.map((r) => r.property_id), ["prop_1", "prop_2", "prop_3"], "graph order kept (SQL did the legacy order)");
  assert.deepEqual(planned.rows.map((r) => r.priority_score), [40, 90, 70]);
  for (const r of planned.rows) assert.equal(r.metadata.ranking, undefined);
  assert.equal(planned.summary.ranking_v2, undefined);
});

test("planCampaignTargetRows with CAMPAIGN_RANKING_V2=on: tier order, v2 priority_score, metadata.ranking, limit applied AFTER ranking, set-based context (one call each)", async () => {
  const store = makeCampaignQueuePlanStore();
  const rows = [row(1, { acquisition_score: 95 }), row(2, { acquisition_score: 10 }), row(3, { acquisition_score: 50 }), row(4, { acquisition_score: 99 })];
  const calls = { situations: 0, markets: 0 };
  const situations = new Map([["prop_1", sit("C", { fatigue: 50 })], ["prop_2", sit("A", { fsp: 85, codes: ["TAX_DELINQUENT", "VACANT"] })], ["prop_3", sit("B", { fsp: 40, codes: ["ABSENTEE", "TENURE_20Y"] })]]);
  const deps = {
    supabase: store.supabase,
    env: ON,
    rankingV2: {
      loadSituations: async (r) => { calls.situations += 1; assert.equal(r.length, 4); return situations; },
      loadMarkets: async () => { calls.markets += 1; return new Map(); },
    },
  };
  const planned = await planCampaignTargetRows({ campaign: { id: "c2", name: "c2", metadata: {} }, options: {}, graph: { rows }, targetLimit: 3, deps, resolveLanguages: false });
  assert.deepEqual(planned.rows.map((r) => r.property_id), ["prop_2", "prop_3", "prop_1"], "A, B, C — prop_4 (legacy 99, no evidence) is cut by the limit");
  assert.ok(planned.rows[0].priority_score >= 75);
  assert.equal(planned.rows[0].metadata.ranking.band, "A");
  assert.equal(planned.rows[2].metadata.ranking.band, "C");
  assert.equal(planned.summary.ranking_v2.by_band.FALLBACK, 1);
  assert.deepEqual(calls, { situations: 1, markets: 1 });
});

test("ranking context failure never fails a build: rows fall to the marked fallback band", async () => {
  const out = await applyCampaignRankingV2([row(1, { acquisition_score: 70 }), row(2, { acquisition_score: 30 })], {
    rankingV2: { loadSituations: async () => { throw new Error("boom"); }, loadMarkets: async () => new Map() },
  });
  assert.deepEqual(out.rows.map((r) => r._rank_v2.band), ["FALLBACK", "FALLBACK"]);
  assert.deepEqual(out.rows.map((r) => r.property_id), ["prop_1", "prop_2"]);
  assert.match(out.summary.errors[0], /situations_unavailable:boom/);
  assert.equal(rankingV2FetchLimit(1000), 20000);
  assert.equal(rankingV2FetchLimit(50000), 50000);
});

test("dedupe: with the v2 comparator the better-ranked property of a shared phone is the primary", () => {
  const phone = "+15553000001";
  const a = { ...row(1, { canonical_e164: phone, acquisition_score: 99 }), _rank_v2: computeCampaignRankV2(row(1), { situation: sit("C", {}) }) };
  const b = { ...row(2, { canonical_e164: phone, master_owner_id: "mo_1", acquisition_score: 10 }), _rank_v2: computeCampaignRankV2(row(2), { situation: sit("A", { fsp: 90, codes: ["TAX_DELINQUENT", "LIEN_RECORDED"] }) }) };
  const legacy = collapseGraphRowsToRecipients([a, b]);
  assert.equal(legacy.recipients[0].primary_property_id, "prop_1", "OFF: legacy score picks the primary");
  const v2 = collapseGraphRowsToRecipients([a, b], { comparePriority: compareCampaignRankV2 });
  assert.equal(v2.recipients[0].primary_property_id, "prop_2");
});

test("a v2-ranked target never relabels its v2 priority as the legacy Final Acquisition Score", () => {
  const base = { id: "t1", property_id: "p1", to_phone_number: "+15553000001", priority_score: 88.5, metadata: { candidate_snapshot: { acquisition_score: 61, canonical_e164: "+15553000001" } } };
  const legacy = launchCandidateFromTarget(base, { id: "c" });
  assert.equal(legacy.final_acquisition_score, 88.5, "OFF: unchanged behaviour");
  const ranked = launchCandidateFromTarget({ ...base, metadata: { ...base.metadata, ranking: { ranking_version: CAMPAIGN_RANKING_VERSION } } }, { id: "c" });
  assert.equal(ranked.final_acquisition_score, 61);
  assert.equal(ranked.acquisition_score, 61);
});

// ── tiers (§14) on the real A1 model ─────────────────────────────────────────
test("§14 tiers come from A1's model on raw facts, with explainable reasons and why-targeted labels", () => {
  const property = { property_id: "p1", market: "Dallas, TX", property_address_state: "TX", property_address_zip: "75217", property_type: "Single Family", tax_delinquent: true, estimated_value: "200000", equity_percent: "85", total_loan_balance: "30000", ownership_years: "22", owner_location: "Absentee Owner", property_flags_text: "Vacant Home; Tax Delinquent; Tired Landlord", year_built: 1950, building_condition: "Poor" };
  const s = scoreSellerSituation(buildRawFactsFromRows({ property, features: null }), { now: "2026-10-07T00:00:00Z" });
  assert.equal(s.score_version, SCORE_VERSION);
  assert.equal(s.opportunity_tier, "A");
  assert.ok(s.tier_reasons.length > 0);
  const why = buildWhyTargeted({ row: { ...property, property_zip: "75217" }, situation: s });
  const labels = why.map((w) => w.label);
  assert.ok(labels.some((l) => /tax delinquent/i.test(l)), labels.join(" · "));
  assert.ok(labels.some((l) => /vacant/i.test(l)), labels.join(" · "));
  const soft = scoreSellerSituation(buildRawFactsFromRows({ property: { property_id: "p2", property_type: "Single Family", property_address_state: "TX", estimated_value: "200000", equity_percent: "20", total_loan_balance: "160000", ownership_years: "4", property_flags_text: "Tired Landlord", year_built: 1999 }, features: null }), { now: "2026-10-07T00:00:00Z" });
  assert.notEqual(soft.opportunity_tier, "A");
  assert.ok(compareCampaignRankV2({ property_id: "p1", _rank_v2: computeCampaignRankV2({ property_id: "p1" }, { situation: s }) }, { property_id: "p2", _rank_v2: computeCampaignRankV2({ property_id: "p2", acquisition_score: 99 }, { situation: soft }) }) < 0);
});

test("why-targeted: vendor-flag codes read as the fact, bookkeeping and protected codes never render", () => {
  assert.match(labelForEvidenceCode("VF_TAX_DELINQUENT"), /tax delinquent/i);
  assert.match(labelForEvidenceCode("EQUITY_80P"), /80/);
  assert.match(labelForEvidenceCode("TENURE_20Y"), /20/);
  assert.equal(labelForEvidenceCode("SOME_NEW_CODE_X"), "some new code x", "unknown codes humanize, never vanish");
  assert.equal(labelForEvidenceCode("NO_SIGNAL"), null);
  assert.equal(labelForEvidenceCode("MARITAL_STATUS_WIDOWED"), null);
  assert.equal(labelForEvidenceCode("AGE_75_PLUS"), null);
  const why = buildWhyTargeted({ row: { acquisition_score: 99, podio_tags: "Tired Landlord" }, situation: null });
  assert.deepEqual(why, [], "no legacy score or Podio tag ever becomes a reason");
});

// ── market quality (§15) ─────────────────────────────────────────────────────
test("§15 market_quality_v1 is the documented formula; unknown terms are dropped, not zeroed", () => {
  const mq = computeMarketQuality({ zip: "75217", asset: "sfr", qualified_sales_1y: 250, investor_purchases_1y: 30, buyer_known_1y: 60, distinct_investor_buyers_36m: 20 });
  assert.deepEqual(mq.terms, { liquidity: 100, buyer_depth: 100, investor_activity: 100 });
  assert.equal(mq.score, 100);
  assert.equal(mq.label, "strong");
  const thinSample = computeMarketQuality({ qualified_sales_1y: 10, investor_purchases_1y: 3, buyer_known_1y: 4, distinct_investor_buyers_36m: 2 });
  assert.equal(thinSample.terms.investor_activity, null, "fewer than 8 known-buyer sales → not measured");
  assert.equal(thinSample.score, Math.round((0.4 * thinSample.terms.liquidity + 0.4 * thinSample.terms.buyer_depth) / 0.8));
  assert.equal(computeMarketQuality({}).score, null);
  assert.equal(marketAssetLane({ units_count: 6 }), "mf_5_plus");
  assert.equal(marketAssetLane({ units_count: 3 }), "mf_2_4");
  const map = new Map([["75217|sfr", mq]]);
  assert.equal(marketQualityForRow({ property_zip: "75217-1234", property_type: "Single Family" }, map), mq);
});

// ── screener (§13 / §17 / §69) ───────────────────────────────────────────────
const TEXAS_SCREEN = {
  all: [
    { m: "state", op: "in", v: ["TX"] },
    { m: "forced_sale_pressure", op: "gte", v: 70 },
    { m: "sell365", op: "gte", v: 60 },
    { m: "equity_percent", op: "gte", v: 35 },
    { any: [{ m: "tax_pain", op: "gte", v: 50 }, { m: "landlord_fatigue", op: "gte", v: 65 }] },
    { m: "buyer_depth", op: "gte", v: 40 },
    { m: "mobile_reachable", op: "is_true" },
    { m: "days_since_outbound", op: "gte", v: 90 },
  ],
};

test("§69 DSL validates, and the brief's Texas example compiles: graph leaves pushed down, the rest in-process", () => {
  const bad = normalizeScreenerExpression({ all: [{ m: "race", op: "eq", v: "x" }, { m: "state", op: "zz" }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  const norm = normalizeScreenerExpression(TEXAS_SCREEN);
  assert.equal(norm.ok, true, norm.errors.join());
  const { where, params, pushed } = compileGraphPushdown(norm.expr, { startParam: 2 });
  assert.deepEqual(where, ["state = any($2::text[])", "equity_percent >= $3"]);
  assert.deepEqual(params, [["TX"], 35]);
  assert.equal(pushed.size, 2);
});

test("three-valued logic: unknown is not no — an unknown metric excludes the row AND is counted", () => {
  const { expr } = normalizeScreenerExpression({ all: [{ m: "forced_sale_pressure", op: "gte", v: 70 }] });
  const hits = new Set();
  assert.equal(evaluateExpression(expr, row(1), { situation: null }, hits), null);
  assert.deepEqual([...hits], ["forced_sale_pressure"]);
  const { expr: notExpr } = normalizeScreenerExpression({ not: { m: "forced_sale_pressure", op: "gte", v: 70 } });
  assert.equal(evaluateExpression(notExpr, row(1), { situation: null }), null, "NOT unknown stays unknown");
  const { expr: anyExpr } = normalizeScreenerExpression({ any: [{ m: "tax_pain", op: "gte", v: 50 }, { m: "tax_delinquent", op: "is_true" }] });
  assert.equal(evaluateExpression(anyExpr, row(1, { tax_delinquent: true }), { situation: null }), true, "OR short-circuits past an unknown");
});

test("§17 coverage gate: a metric below its threshold is refused by name with its measured coverage", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(i));
  const contexts = rows.map((_, i) => ({ situation: i < 3 ? sit("B", { fsp: 50 }) : null }));
  const cov = measureMetricCoverage(rows, contexts, ["forced_sale_pressure", "state"]);
  assert.equal(cov.forced_sale_pressure.ratio, 0.3);
  assert.equal(cov.forced_sale_pressure.exposed, false);
  assert.equal(cov.state.exposed, true);
  const { expr } = normalizeScreenerExpression({ all: [{ m: "forced_sale_pressure", op: "gte", v: 70 }, { m: "state", op: "eq", v: "TX" }] });
  assert.deepEqual(gateExpressionCoverage(expr, cov), [{ metric: "forced_sale_pressure", reason: "coverage_below_threshold", ratio: 0.3, threshold: 0.6 }]);
  const catalog = screenerMetricCatalog(cov);
  assert.equal(catalog.find((m) => m.key === "forced_sale_pressure").exposed, false);
  assert.equal(catalog.find((m) => m.key === "sell365").reason, "coverage_not_measured");
});

test("runSellerScreener: keyset batches, ONE situation + ONE market load per batch (never per row), sellers + ZIPs + histograms + why", async () => {
  const graph = Array.from({ length: 2500 }, (_, i) => row(i + 1, { property_id: `p${String(i + 1).padStart(5, "0")}`, property_zip: i % 2 ? "75217" : "75216" }));
  const calls = { graph: 0, situations: 0, markets: 0 };
  const db = {
    query: async (sql, params) => {
      calls.graph += 1;
      assert.match(sql, /^select .* from public\.campaign_target_graph where property_id > \$1 and state = any\(\$2::text\[\]\) order by property_id limit \d+$/);
      const [after, states] = params;
      const lim = Number(sql.match(/limit (\d+)$/)[1]);
      return { rows: graph.filter((r) => r.property_id > after && states.includes(r.state)).slice(0, lim) };
    },
  };
  const result = await runSellerScreener({ expression: { all: [{ m: "state", op: "in", v: ["TX"] }, { m: "forced_sale_pressure", op: "gte", v: 60 }] }, seller_limit: 5 }, {
    db,
    batchSize: 1000,
    loadSituations: async (rows) => { calls.situations += 1; return new Map(rows.map((r, i) => [r.property_id, i % 5 === 0 ? sit("A", { fsp: 80, codes: ["TAX_DELINQUENT", "VACANT"] }) : sit("C", { fsp: 10 })])); },
    loadMarkets: async () => { calls.markets += 1; return new Map([["75217|sfr", computeMarketQuality({ qualified_sales_1y: 300, distinct_investor_buyers_36m: 25, investor_purchases_1y: 30, buyer_known_1y: 80 })]]); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 2500);
  assert.equal(result.matched, 500);
  assert.deepEqual(calls, { graph: 3, situations: 3, markets: 3 });
  assert.equal(result.tiers.A, 500);
  assert.equal(result.sellers.length, 5);
  assert.ok(result.sellers[0].why.some((w) => /tax delinquent/i.test(w.label)));
  assert.equal(result.score_distribution.forced_sale_pressure.buckets.find((b) => b.lo === 80).n, 500);
  assert.ok(result.zips.length >= 1 && result.zips[0].high_pressure > 0);
});

test("screener/discovery/why-targeted APIs are dark by default (flag OFF → 404, no DB touched)", async () => {
  _resetScreenerServiceCache();
  const db = { query: async () => { throw new Error("must not read"); } };
  for (const call of [() => runScreener({ expression: { all: [] } }, { env: {}, db }), () => runDiscovery({ state: "TX" }, { env: {}, db }), () => readWhyTargeted(["p1"], { env: {}, db })]) {
    const r = await call();
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.error, "seller_screener_disabled");
  }
});

test("why-targeted service: one ANY() read for ≤200 ids, situation + market + rank + why per property", async () => {
  let reads = 0;
  const db = { query: async (sql, params) => { reads += 1; assert.match(sql, /property_id = any\(\$1::text\[\]\)/); return { rows: params[0].filter((id) => id !== "missing").map((id, i) => row(i, { property_id: id })) }; } };
  const res = await readWhyTargeted(["a", "b", "missing"], { env: { SELLER_SCREENER: "on" }, db, loadSituations: async () => new Map([["a", sit("A", { fsp: 80, codes: ["TAX_DELINQUENT", "VACANT"] })]]), loadMarkets: async () => new Map() });
  assert.equal(reads, 1);
  assert.deepEqual(res.missing, ["missing"]);
  assert.equal(res.properties.find((p) => p.property_id === "a").rank.band, "A");
  assert.equal(res.properties.find((p) => p.property_id === "b").rank.rank_source, "legacy_fallback");
});

// ── quality report (§19 / §70) + discovery (§16) ─────────────────────────────
test("§19 quality report: every split sums to the denominator; unknown language is unknown (never English)", () => {
  const rows = [row(1, { language: "es" }), row(2, { language: null }), row(3, { language: "auto", phone_type: "L", identity_alignment: "entity_company_linked" }), row(4, { never_contacted: false, last_outbound_at: "2026-09-01T00:00:00Z" })];
  const contexts = [{ situation: sit("A", { codes: ["TAX_DELINQUENT"] }) }, { situation: sit("C", { codes: ["VF_TIRED_LANDLORD"] }) }, { situation: null }, { situation: sit("B", { codes: ["ABSENTEE", "TENURE_20Y"] }) }]
    .map((c, i) => ({ ...c, rank: computeCampaignRankV2(rows[i], c) }));
  const rep = summarizeCampaignQuality(rows, contexts);
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(rep.denominator, 4);
  assert.equal(rep.segments.reduce((a, s) => a + s.count, 0), 4);
  assert.equal(sum(rep.tiers), 4);
  assert.equal(sum(rep.ranking), 4);
  assert.deepEqual(rep.language, { known: [{ key: "es", count: 1 }], unknown: 3 });
  assert.equal(sum(rep.contactability.line_type), 4);
  assert.deepEqual(rep.prior_property_touch, { touched: 1, never: 3, unknown: 0 });
  assert.equal(rep.expected_review_only.count, 1);
  assert.equal(cohortSegment(sit("C", { codes: ["TAX_RATE_GE_2PCT", "VF_HEAVILY_DATED"] })), "other_soft", "a high tax RATE or a dated interior is not hard evidence");
  assert.equal(cohortSegment(sit("B", { codes: ["TAX_DELINQUENT"] })), "tax_lien");
  assert.equal(cohortSegment(null), "unknown_score");
});

test("§16 discovery ranks ZIPs by (tier A + ½ tier B) × market quality, reachable only, with a factual headline", () => {
  const rows = [];
  const contexts = [];
  const strong = computeMarketQuality({ qualified_sales_1y: 400, distinct_investor_buyers_36m: 30, investor_purchases_1y: 30, buyer_known_1y: 80 });
  for (let i = 0; i < 40; i += 1) {
    rows.push(row(i, { property_zip: i < 20 ? "75217" : "75216", queue_eligible: i % 10 !== 9, equity_percent: 50 + (i % 5) }));
    contexts.push({ situation: i % 4 === 0 ? sit("A", { fsp: 80 }) : sit("B", { fsp: 30 }), market: i < 20 ? strong : null });
  }
  const out = rankDiscoveryZips(rows, contexts);
  assert.equal(out.zips[0].zip, "75217");
  assert.equal(out.zips[0].reachable, 18);
  assert.equal(out.zips[1].market_quality_assumed, true);
  assert.match(out.zips[0].headline, /^Dallas, TX 75217 · \d+ high-pressure sellers · \d+ tier A · \d+ tier B of 18 reachable · median equity \d+% · strong buyer depth · investor activity high$/);
});

// ── catalog / filter plan (additive) ─────────────────────────────────────────
test("seller-situation fields are recognised but NOT in the builder list, and refused until the projection lands", () => {
  assert.equal(CAMPAIGN_FIELD_CATALOG.some((f) => f.domain === "seller_situation"), false);
  const def = getCampaignFieldDefinition("seller_situation.forced_sale_pressure");
  assert.equal(def.screener_only, true);
  assert.equal(graphFieldApplicability("seller_situation.forced_sale_pressure").reason, "not_in_audience");
  assert.equal(graphFieldApplicability("seller_situation.forced_sale_pressure", { population: new Map([["forced_sale_pressure", true]]) }).applicable, true);
});

// ── performance (§94) ────────────────────────────────────────────────────────
test("§94 performance: rank 100K rows and screen 25K rows in-process within budget", () => {
  const n = 100_000;
  const rows = Array.from({ length: n }, (_, i) => row(i, { acquisition_score: i % 100 }));
  const situations = new Map(rows.map((r, i) => [r.property_id, sit(["A", "B", "C"][i % 3], { fsp: i % 100, sell365: i % 90, equity: 50, codes: ["TAX_DELINQUENT", "ABSENTEE"] })]));
  const t0 = performance.now();
  const ranked = rankCampaignRowsV2(rows, { situations });
  const rankMs = performance.now() - t0;
  assert.equal(ranked.length, n);
  const sub = ranked.slice(0, 25_000);
  const contexts = sub.map((r) => ({ situation: situations.get(r.property_id), rank: r._rank_v2 }));
  const { expr } = normalizeScreenerExpression(TEXAS_SCREEN);
  const t1 = performance.now();
  const res = screenRows(sub, contexts, expr);
  const screenMs = performance.now() - t1;
  const t2 = performance.now();
  for (let i = 0; i < 1000; i += 1) buildWhyTargeted({ row: sub[i], situation: contexts[i].situation });
  const whyMs = performance.now() - t2;
  console.log(`[perf] rank ${n} rows ${rankMs.toFixed(0)} ms · screen 25K ${screenMs.toFixed(0)} ms · why ×1000 ${whyMs.toFixed(1)} ms`);
  assert.ok(rankMs < 5000, `rank ${rankMs}ms`);
  assert.ok(screenMs < 3000, `screen ${screenMs}ms`);
  assert.ok(whyMs < 500, `why ${whyMs}ms`);
  assert.ok(res.matched >= 0);
});
