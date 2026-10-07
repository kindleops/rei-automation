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
  CAMPAIGN_RANKING_VERSION, CONTACT_DOMINANCE_DELTA, LAYER_WEIGHTS, MARKET_PRIOR, PRESSURE_GATE_FLOOR, PRESSURE_TERMS, TIER_POINTS,
  compareCampaignRankV2, computeCampaignRankV2, hasCurrentSituation, rankCampaignRowsV2, rankingMetadata,
} from "@/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js";
import { CONTACT_POINTS, contactConfidence, equityEvidence, identityTier, matchingTagClass } from "@/lib/domain/campaigns/ranking-v2/contact-evidence.js";
import { RESPONSE_CONTEXT, fitMarketResponse } from "@/lib/domain/campaigns/ranking-v2/market-response.js";
import { armComparison, diffCI, funnelBySignal, funnelLabels, wilson } from "@/lib/domain/campaigns/ranking-v2/funnel-analytics.js";
import { computeMarketQuality, marketAssetLane, marketQualityForRow } from "@/lib/domain/campaigns/ranking-v2/market-quality.js";
import { buildWhyTargeted, labelForEvidenceCode } from "@/lib/domain/campaigns/ranking-v2/why-targeted.js";
import {
  compileGraphPushdown, evaluateExpression, gateExpressionCoverage, normalizeScreenerExpression, runSellerScreener, screenRows,
} from "@/lib/domain/campaigns/ranking-v2/seller-screener.js";
import { measureMetricCoverage, screenerMetricCatalog } from "@/lib/domain/campaigns/ranking-v2/screener-metrics.js";
import { cohortSegment, summarizeCampaignQuality } from "@/lib/domain/campaigns/ranking-v2/campaign-quality-report.js";
import { rankDiscoveryZips } from "@/lib/domain/campaigns/ranking-v2/campaign-discovery.js";
import { applyCampaignRankingV2, rankingV2FetchLimit } from "@/lib/domain/campaigns/ranking-v2/ranking-context.js";
import { readWhyTargeted, runDiscovery, runFunnel, runScreener, _resetScreenerServiceCache } from "@/lib/domain/campaigns/ranking-v2/screener-service.js";
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
const GOOD_CONTACT = { phone_type: "W", identity_alignment: "verified", matching_flags: "Likely Owner, Family", usage_2_months: "Heavy Usage", phone_owner_count: 1 };
const BAD_CONTACT = { phone_type: "L", identity_alignment: "mismatch", matching_flags: "Resident, Likely Renting", usage_2_months: null, phone_owner_count: 3 };
const ACUTE = () => sit("A", { fsp: 80, sell365: 40, equity: 85, codes: ["TAX_DELINQUENT", "VACANT", "EQUITY_80P", "TENURE_20Y", "REPAIR_TIER_HEAVY_FORMULA"] });
const SOFT = () => sit("C", { fatigue: 40, codes: ["VF_TIRED_LANDLORD"] });

// ── ranking v2.1 (owner rebuild 2026-10-07) ──────────────────────────────────
test("§67 at equal contact: a tired-landlord-only seller with legacy 99 never outranks a tax-delinquent/vacant/long-tenure/high-repair seller — legacy is never read when current evidence exists", () => {
  const soft = computeCampaignRankV2(row(1, { ...GOOD_CONTACT, acquisition_score: 99 }), { situation: SOFT() });
  const acute = computeCampaignRankV2(row(2, { ...GOOD_CONTACT, acquisition_score: null }), { situation: ACUTE() });
  assert.ok(acute.priority_score > soft.priority_score, `${acute.priority_score} > ${soft.priority_score}`);
  assert.equal(soft.layers.pressure.source, "seller_situation_v2");
  assert.equal(soft.legacy_shadow.final_acquisition_score, 99, "legacy is echoed, not used");
  const soft2 = computeCampaignRankV2(row(1, { ...GOOD_CONTACT, acquisition_score: 0 }), { situation: SOFT() });
  assert.equal(soft2.priority_score, soft.priority_score, "the legacy number has zero influence");
});

test("hierarchy: contact confidence comes first — distress at a landline/mismatch/renter/shared phone does not outrank a verified-mobile likely owner", () => {
  const acuteBad = computeCampaignRankV2(row(1, BAD_CONTACT), { situation: ACUTE() });
  const softGood = computeCampaignRankV2(row(2, GOOD_CONTACT), { situation: SOFT() });
  assert.ok(softGood.priority_score > acuteBad.priority_score);
  assert.ok(acuteBad.layers.pressure.gate < 0.5, "pressure is conditional on contact");
  assert.ok(acuteBad.layers.contact.evidence.some((e) => e.code === "SHARED_PHONE_AMBIGUOUS"));
  assert.equal(acuteBad.layers.contact.tag, "renter_no_owner");
  // ...and at equal contact, pressure decides
  const acuteGood = computeCampaignRankV2(row(3, GOOD_CONTACT), { situation: ACUTE() });
  assert.ok(acuteGood.priority_score > softGood.priority_score);
});

test("layers are explainable: weights sum to 1, every layer carries its score, terms and evidence", () => {
  assert.equal(Object.values(LAYER_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(6), "1.000000");
  assert.equal(Object.values(PRESSURE_TERMS).reduce((a, t) => a + t.weight, 0).toFixed(6), "1.000000");
  const r = computeCampaignRankV2(row(1, GOOD_CONTACT), { situation: ACUTE(), market: computeMarketQuality({ qualified_sales_1y: 250, distinct_investor_buyers_36m: 20, investor_purchases_1y: 30, buyer_known_1y: 60 }) });
  const L = r.layers;
  const expected = Math.round((0.4 * L.contact.score + 0.3 * L.pressure.effective + 0.15 * L.deal.score + 0.15 * L.market.score) * 100) / 100;
  assert.ok(Math.abs(r.priority_score - expected) < 0.02, `${r.priority_score} vs ${expected}`);
  assert.equal(L.market.score, 100);
  assert.ok(L.contact.evidence.length >= 3 && L.contact.evidence.some((e) => e.code.startsWith("IDENTITY_TIER_")));
  assert.ok(L.pressure.terms.every((t) => "used_prior" in t));
});

test("§12 fallback: no current situation → legacy halved and capped at 50 in L2 only, marked; stub/UNKNOWN/foreign-version never count as current", () => {
  const fb = computeCampaignRankV2(row(1, { acquisition_score: 100 }), { situation: null });
  assert.equal(fb.rank_source, "legacy_fallback");
  assert.equal(fb.layers.pressure.score, 50);
  assert.equal(fb.fallback_reason, "seller_situation_absent");
  const none = computeCampaignRankV2(row(2, { acquisition_score: null }), { situation: null });
  assert.equal(none.rank_source, "v2_no_situation");
  assert.equal(none.layers.pressure.score, PRESSURE_TERMS.tier.prior);
  assert.equal(hasCurrentSituation(sit("A", { reasons: ["STUB"] })), false);
  assert.equal(hasCurrentSituation(sit("UNKNOWN")), false);
  assert.equal(hasCurrentSituation({ ...sit("A"), score_version: "seller_situation_v1" }), false);
  assert.equal(computeCampaignRankV2(row(3), { situation: sit("UNKNOWN") }).fallback_reason, "seller_situation_tier_unknown");
});

test("L0: an ineligible row is reported and sorts last (gates are not re-decided here)", () => {
  const out = rankCampaignRowsV2([row(1, { queue_eligible: false, ...GOOD_CONTACT }), row(2, BAD_CONTACT)], { situations: new Map([["prop_1", ACUTE()], ["prop_2", SOFT()]]) });
  assert.deepEqual(out.map((r) => r.property_id), ["prop_2", "prop_1"]);
  assert.equal(out[1]._rank_v2.eligible, false);
  assert.equal(out[1]._rank_v2.priority_score, null);
});

test("UNKNOWN semantics — equity: a 0/blank loan is unknown (never 100%); known only with loan>0, or vendor Free-And-Clear", () => {
  assert.deepEqual(equityEvidence({ estimated_value: 200000, total_loan_balance: 0, property_flags_text: "Absentee Owner" }), { known: false, percent: null, class: "unknown", rule: "no_loan_evidence", provenance: null });
  assert.equal(equityEvidence({ estimated_value: 200000, total_loan_balance: null }).class, "unknown");
  assert.deepEqual(equityEvidence({ estimated_value: 200000, total_loan_balance: 50000 }).percent, 75);
  assert.equal(equityEvidence({ estimated_value: 200000, total_loan_balance: 0, property_flags_text: "Free And Clear; Absentee Owner" }).percent, 100);
  const flagOnly = equityEvidence({ estimated_value: 200000, total_loan_balance: 0, property_flags_text: "High Equity" });
  assert.equal(flagOnly.known, false);
  assert.equal(flagOnly.class, "high");
  assert.equal(flagOnly.percent, null);
  const unknown = computeCampaignRankV2(row(1, { total_loan_balance: 0, equity_percent: 100, property_flags_text: null }), { situation: SOFT() });
  assert.equal(unknown.layers.deal.equity.class, "unknown");
  assert.ok(!unknown.why.some((w) => /100% equity/.test(w.label)), "no 100% equity claim from a zero loan");
});

test("UNKNOWN semantics — phone: empty best_phone_score / line type / tag are unknown (neutral), never 0; evidence we have is used", () => {
  const empty = contactConfidence({ best_phone_score: null });
  assert.equal(empty.known_signals, 0);
  assert.ok(empty.score > 40 && empty.score < 60, `neutral ${empty.score}`);
  assert.equal(contactConfidence({ best_phone_score: 99 }).score, empty.score, "best_phone_score is never read");
  assert.equal(contactConfidence(GOOD_CONTACT).score, 100);
  assert.ok(contactConfidence(BAD_CONTACT).score < 10);
  assert.equal(matchingTagClass("Linked To Company, Family", { entityOwned: true }), "linked_to_company");
  assert.equal(matchingTagClass("Linked To Company, Family", { entityOwned: false }), "potential_owner");
  assert.equal(matchingTagClass("Resident, Likely Renting"), "renter_no_owner");
  assert.equal(matchingTagClass("Likely Owner, Family, Resident"), "likely_owner", "ownership evidence beats resident");
  assert.equal(matchingTagClass(null), "missing");
});

test("market response is bounded context: min effective n, shrinkage toward the lane rate, recency decay, immature excluded, capped ±4", () => {
  const now = Date.parse("2026-10-07T00:00:00Z");
  const day = 86400000;
  const outcomes = [];
  for (let i = 0; i < 3000; i += 1) outcomes.push({ market: "Hot, TX", lane: "sfr", contacted_at: new Date(now - 30 * day).toISOString(), interested: i % 10 === 0 });
  for (let i = 0; i < 3000; i += 1) outcomes.push({ market: "Cold, TX", lane: "sfr", contacted_at: new Date(now - 30 * day).toISOString(), interested: i % 100 === 0 });
  for (let i = 0; i < 50; i += 1) outcomes.push({ market: "Tiny, TX", lane: "sfr", contacted_at: new Date(now - 30 * day).toISOString(), interested: true });
  for (let i = 0; i < 5000; i += 1) outcomes.push({ market: "Fresh, TX", lane: "sfr", contacted_at: new Date(now - 3 * day).toISOString(), interested: true });
  const fit = fitMarketResponse(outcomes, { now });
  assert.ok(fit.get("Hot, TX|sfr").points > 3.9 && fit.get("Hot, TX|sfr").points <= RESPONSE_CONTEXT.CAP, "strong market saturates at the cap (shrunk)");
  assert.ok(fit.get("Hot, TX|sfr").shrunk < fit.get("Hot, TX|sfr").raw, "shrunk toward the lane rate");
  assert.equal(fit.get("Cold, TX|sfr").points < 0 && fit.get("Cold, TX|sfr").points >= -RESPONSE_CONTEXT.CAP, true);
  assert.equal(fit.get("Tiny, TX|sfr").points, null, "below min effective n → no context");
  assert.equal(fit.has("Fresh, TX|sfr"), false, "immature outcomes excluded");
  const hot = computeCampaignRankV2(row(1, GOOD_CONTACT), { situation: SOFT(), response: fit.get("Hot, TX|sfr") });
  const flat = computeCampaignRankV2(row(1, GOOD_CONTACT), { situation: SOFT() });
  assert.ok(hot.priority_score - flat.priority_score <= 0.15 * RESPONSE_CONTEXT.CAP + 0.01, "influence ≤ 0.15 × cap");
});

test("ties and totals: equal priorities break by contact then property id — a total, deterministic order", () => {
  const rows = [3, 1, 2].map((i) => row(i));
  const situations = new Map(rows.map((r) => [r.property_id, sit("B", { fsp: 50 })]));
  const a = rankCampaignRowsV2(rows, { situations }).map((r) => r.property_id);
  const b = rankCampaignRowsV2([...rows].reverse(), { situations }).map((r) => r.property_id);
  assert.deepEqual(a, ["prop_1", "prop_2", "prop_3"]);
  assert.deepEqual(a, b);
});

test("property-based: 3,000 random rows — priority within 0–100, monotone in contact and in tier, legacy never moves a row with current evidence", () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 3000; i += 1) {
    const base = row(i, { phone_type: rnd() < 0.5 ? "W" : rnd() < 0.5 ? "L" : null, identity_alignment: ["verified", "probable", "unknown", "mismatch", null][Math.floor(rnd() * 5)], matching_flags: [null, "Likely Owner", "Resident, Likely Renting", "Family"][Math.floor(rnd() * 4)], total_loan_balance: rnd() < 0.5 ? 0 : 100000, estimated_value: 250000 });
    const s = sit(["A", "B", "C"][Math.floor(rnd() * 3)], { fsp: Math.round(rnd() * 100), sell365: Math.round(rnd() * 95), equity: Math.round(rnd() * 100), codes: Array.from({ length: Math.floor(rnd() * 6) }, (_, k) => `CODE_${k}`) });
    const r = computeCampaignRankV2({ ...base, acquisition_score: Math.round(rnd() * 100) }, { situation: s });
    assert.ok(r.priority_score >= 0 && r.priority_score <= 100);
    assert.equal(computeCampaignRankV2({ ...base, acquisition_score: 0 }, { situation: s }).priority_score, r.priority_score);
    const better = computeCampaignRankV2({ ...base, ...GOOD_CONTACT }, { situation: s });
    assert.ok(better.priority_score >= r.priority_score - 1e-9, "better contact never lowers priority");
    if (s.opportunity_tier !== "A") {
      const upTier = computeCampaignRankV2(base, { situation: { ...s, opportunity_tier: "A" } });
      assert.ok(upTier.priority_score >= computeCampaignRankV2(base, { situation: s }).priority_score - 1e-9, "a higher tier never lowers priority");
    }
  }
});

test("rankingMetadata is compact, layered and labelled (never the legacy name)", () => {
  const m = rankingMetadata(computeCampaignRankV2(row(1, GOOD_CONTACT), { situation: sit("A", { fsp: 80, codes: ["TAX_DELINQUENT", "VACANT"] }) }));
  assert.equal(m.ranking_version, CAMPAIGN_RANKING_VERSION);
  assert.equal(CAMPAIGN_RANKING_VERSION, "campaign_rank_v2.1");
  assert.deepEqual(Object.keys(m.layers).sort(), ["contact", "deal", "market", "pressure", "pressure_effective", "response_context_points"]);
  assert.ok(m.why.some((w) => /tax delinquent/i.test(w)));
  assert.equal("final_acquisition_score" in m, false);
});

test("SQL twin pins the v2.1 layer weights, gate, contact points and the equity rule (PROPOSED_20261007080000)", () => {
  const sql = fs.readFileSync(new URL("../../../../supabase/migrations/PROPOSED_20261007080000_campaign_ranking_v2.sql", import.meta.url), "utf8");
  assert.ok(sql.includes(`${LAYER_WEIGHTS.contact} * p_contact`));
  assert.equal(PRESSURE_GATE_FLOOR, 0);
  assert.ok(sql.includes(`${LAYER_WEIGHTS.pressure} * p_pressure * (p_contact / 100)`));
  assert.ok(sql.includes(`${LAYER_WEIGHTS.deal} * p_deal`));
  assert.ok(sql.includes(`${LAYER_WEIGHTS.market} * coalesce(least(greatest(p_market,0),100), ${MARKET_PRIOR})`));
  for (const [k, v] of Object.entries(CONTACT_POINTS.line)) if (k !== "unknown") assert.ok(sql.includes(`WHEN '${k}' THEN ${v}`), `line ${k}`);
  assert.ok(sql.includes(`ELSE ${CONTACT_POINTS.line.unknown} END`));
  for (const k of ["strongest", "strong", "moderate", "weak", "contradictory"]) assert.ok(sql.includes(`'${k}' THEN ${CONTACT_POINTS.identity_tier[k]}`), `identity tier ${k}`);
  assert.ok(sql.includes(`ELSE ${CONTACT_POINTS.identity_tier.none} END`));
  assert.ok(sql.includes(`${CONTACT_POINTS.shared_phone_penalty} ELSE 0 END`));
  for (const [t, pts] of Object.entries(TIER_POINTS)) assert.ok(t === "C" ? sql.includes(`ELSE ${pts} END`) : sql.includes(`'${t}' THEN ${pts}`));
  assert.ok(sql.includes("WHEN p_value > 0 AND p_loan > 0 THEN"));
  assert.ok(sql.includes("free and clear"));
  assert.ok(!/campaign_rank_v2_score\(/.test(sql.split("-- ── 2.")[0]), "no v2.0 band score function");
  assert.ok(fs.existsSync(new URL("../../../../supabase/migrations/PROPOSED_20261007080000_campaign_ranking_v2_rollback.sql", import.meta.url)));
  assert.match(sql, /MIGRATION \(b\): ORDERING-AFFECTING/);
});

test("migration (a) is schema-support only: new tables/views, CONCURRENTLY indexes, no existing table altered, pretest rolls back", () => {
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  const a = fs.readFileSync(new URL("20261007090000_ranking_shadow_support.sql", dir), "utf8");
  const code = a.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.ok(!/ALTER TABLE public\.(?!campaign_rank_shadow|campaign_test_)/.test(code), "no ALTER of an existing table");
  assert.ok(!/campaign_target_graph/.test(code), "never touches the graph");
  assert.ok(!/^\s*(UPDATE|DELETE|TRUNCATE|INSERT)\s/im.test(code), "no data rewrites");
  for (const m of code.matchAll(/CREATE INDEX (\w+)/g)) assert.equal(m[1], "CONCURRENTLY");
  const pre = fs.readFileSync(new URL("20261007090000_ranking_shadow_support_pretest.sql", dir), "utf8");
  assert.match(pre.trim(), /ROLLBACK;$/);
  assert.ok(fs.existsSync(new URL("20261007090000_ranking_shadow_support_rollback.sql", dir)));
});

test("identity tiers: missing vendor tag is absence of evidence; contradictions are lower", () => {
  const tiers = [
    ["verified", "likely_owner", "strongest"], ["verified", "linked_to_company", "strongest"], ["verified", "missing", "strong"],
    ["probable", "likely_owner", "strong"], ["entity_company_linked", "linked_to_company", "strong"], ["probable", "missing", "moderate"],
    ["entity_company_linked", "missing", "moderate"], ["verified", "potential_owner", "moderate"], ["missing", "likely_owner", "moderate"],
    ["unknown", "missing", "weak"], ["unknown", "likely_owner", "moderate"], ["missing", "missing", "none"],
    ["mismatch", "likely_owner", "contradictory"], ["verified", "renter_no_owner", "contradictory"], ["probable", "renter_no_owner", "contradictory"],
  ];
  for (const [id, tag, want] of tiers) assert.equal(identityTier(id, tag), want, `${id} × ${tag}`);
  const P = CONTACT_POINTS.identity_tier;
  assert.ok(P.strongest > P.strong && P.strong > P.moderate && P.moderate > P.none && P.none > P.weak && P.weak > P.contradictory);
  const s = (o) => contactConfidence({ phone_type: "W", usage_2_months: "Moderate Usage", phone_owner_count: 1, ...o }).score;
  assert.ok(s({ identity_alignment: "verified", matching_flags: "Likely Owner" }) > s({ identity_alignment: "verified", matching_flags: null }));
  assert.ok(s({ identity_alignment: "verified", matching_flags: null }) > s({ identity_alignment: "probable", matching_flags: null }), "verified + no tag beats likely + no tag");
  assert.ok(s({ identity_alignment: "probable", matching_flags: null }) > s({ identity_alignment: "unknown", matching_flags: null }));
  assert.ok(s({ identity_alignment: "verified", matching_flags: "Resident, Likely Renting" }) < s({ identity_alignment: "unknown", matching_flags: null }) + 15, "contradiction drops below unknown-level");
});

test(`gate guarantee: tier A with MAXIMUM distress never outranks a contact ≥ ${CONTACT_DOMINANCE_DELTA} points stronger (tier C, MINIMUM distress), deal & market equal — exhaustive over contact profiles`, () => {
  const lines = ["W", "L", null];
  const ids = ["verified", "probable", "entity_company_linked", "unknown", "mismatch", null];
  const tags = ["Likely Owner", "Linked To Company", "Potential Owner", "Potentially Linked To Company", "Family", "Resident, Likely Renting", null];
  const usages = ["Heavy Usage", "Moderate Usage", "Light Usage", "Minimal Usage", null];
  const byScore = new Map();
  for (const phone_type of lines) for (const identity_alignment of ids) for (const matching_flags of tags) for (const usage_2_months of usages) for (const phone_owner_count of [1, 3]) {
    const prof = { phone_type, identity_alignment, matching_flags, usage_2_months, phone_owner_count, is_corporate_owner: true };
    const sc = contactConfidence(prof).score;
    if (!byScore.has(sc)) byScore.set(sc, prof);
  }
  const base = { estimated_value: 250000, total_loan_balance: 100000, property_zip: "75217", property_type: "Single Family", queue_eligible: true };
  const maxA = sit("A", { fsp: 100, sell365: 95, equity: 100, fatigue: 100, tax: 100, codes: Array.from({ length: 10 }, (_, k) => `CODE_${k}`) });
  const minC = sit("C", { fsp: 0, sell365: 0, equity: 0, fatigue: 0, tax: 0, codes: [] });
  minC.components.debt_pressure = 0; minC.components.property_burden = 0;
  const scores = [...byScore.keys()].sort((a, b) => a - b);
  let checked = 0;
  for (const lo of scores) for (const hi of scores) {
    if (hi - lo < CONTACT_DOMINANCE_DELTA) continue;
    const a = computeCampaignRankV2({ ...base, ...byScore.get(lo), property_id: "a" }, { situation: maxA });
    const c = computeCampaignRankV2({ ...base, ...byScore.get(hi), property_id: "c" }, { situation: minC });
    assert.equal(a.layers.deal.score, c.layers.deal.score);
    assert.ok(c.priority_score > a.priority_score, `contact ${hi} (C) must beat contact ${lo} (A): ${c.priority_score} vs ${a.priority_score}`);
    checked += 1;
  }
  assert.ok(checked > 50, `checked ${checked} pairs`);
  // and distress is at most 30% of priority
  const top = computeCampaignRankV2({ ...base, ...byScore.get(scores[scores.length - 1]) }, { situation: maxA });
  assert.ok(top.layers.pressure.effective * LAYER_WEIGHTS.pressure <= 30 + 1e-9);
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

test("planCampaignTargetRows with CAMPAIGN_RANKING_V2=on: layered order, v2.1 priority_score + metadata.ranking, limit applied AFTER ranking, one context call each", async () => {
  const store = makeCampaignQueuePlanStore();
  const rows = [
    row(1, { ...GOOD_CONTACT, seller_person_key: "k1", matching_flags: undefined, acquisition_score: 95 }),
    row(2, { ...GOOD_CONTACT, seller_person_key: "k2", matching_flags: undefined, acquisition_score: 10 }),
    row(3, { ...BAD_CONTACT, seller_person_key: "k3", matching_flags: undefined, acquisition_score: 99 }),
    row(4, { ...GOOD_CONTACT, seller_person_key: "k4", matching_flags: undefined, acquisition_score: 50 }),
  ].map((r) => { delete r.matching_flags; return r; });
  const calls = { situations: 0, markets: 0, flags: 0, response: 0 };
  const situations = new Map([["prop_1", SOFT()], ["prop_2", ACUTE()], ["prop_3", ACUTE()], ["prop_4", sit("B", { fsp: 40, codes: ["ABSENTEE", "TENURE_20Y"] })]]);
  const deps = {
    supabase: store.supabase,
    env: ON,
    rankingV2: {
      loadSituations: async (r) => { calls.situations += 1; assert.equal(r.length, 4); return situations; },
      loadMarkets: async () => { calls.markets += 1; return new Map(); },
      loadMatchingFlags: async () => { calls.flags += 1; return new Map([["k1", "Likely Owner"], ["k2", "Likely Owner"], ["k3", "Resident, Likely Renting"], ["k4", "Likely Owner"]]); },
      loadResponse: async () => { calls.response += 1; return null; },
    },
  };
  const planned = await planCampaignTargetRows({ campaign: { id: "c2", name: "c2", metadata: {} }, options: {}, graph: { rows }, targetLimit: 3, deps, resolveLanguages: false });
  assert.deepEqual(planned.rows.map((r) => r.property_id), ["prop_2", "prop_4", "prop_1"], "acute+good contact, stacked+good, soft+good; acute at a bad contact (legacy 99) is cut");
  assert.equal(planned.rows[0].metadata.ranking.ranking_version, "campaign_rank_v2.1");
  assert.ok(planned.rows[0].priority_score > planned.rows[2].priority_score);
  assert.deepEqual(calls, { situations: 1, markets: 1, flags: 1, response: 1 });
});

test("ranking context failure never fails a build: rows rank on the marked legacy fallback in L2", async () => {
  const out = await applyCampaignRankingV2([row(1, { acquisition_score: 70 }), row(2, { acquisition_score: 30 })], {
    rankingV2: { loadSituations: async () => { throw new Error("boom"); }, loadMarkets: async () => new Map() },
  });
  assert.deepEqual(out.rows.map((r) => r._rank_v2.rank_source), ["legacy_fallback", "legacy_fallback"]);
  assert.deepEqual(out.rows.map((r) => r.property_id), ["prop_1", "prop_2"]);
  assert.match(out.summary.errors[0], /situations_unavailable:boom/);
  assert.equal(rankingV2FetchLimit(1000), 20000);
  assert.equal(rankingV2FetchLimit(50000), 50000);
});

test("dedupe: with the v2 comparator the better-ranked property of a shared phone is the primary", () => {
  const phone = "+15553000001";
  const a = { ...row(1, { canonical_e164: phone, acquisition_score: 99 }), _rank_v2: computeCampaignRankV2(row(1, GOOD_CONTACT), { situation: SOFT() }) };
  const b = { ...row(2, { canonical_e164: phone, master_owner_id: "mo_1", acquisition_score: 10 }), _rank_v2: computeCampaignRankV2(row(2, GOOD_CONTACT), { situation: sit("A", { fsp: 90, codes: ["TAX_DELINQUENT", "LIEN_RECORDED"] }) }) };
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

// ── funnel analytics ─────────────────────────────────────────────────────────
test("funnel: stages imply their predecessors, who-is-this/SP is not interest, transitions are k/n with Wilson CIs", () => {
  const who = funnelLabels({ delivered: true, inbound: 1, intents: ["who_is_this"], stages: ["SP"] });
  assert.equal(who.replied, true);
  assert.equal(who.interested, false);
  assert.equal(who.owner, false);
  const own = funnelLabels({ delivered: true, inbound: 1, intents: ["ownership_confirmed"], stages: ["asking_price"] });
  assert.equal(own.owner, true);
  assert.equal(own.interested, false);
  const priced = funnelLabels({ delivered: true, inbound: 2, intents: ["asking_price_provided"], stages: ["S4B"], ask: 220000, value: 200000 });
  assert.deepEqual([priced.owner, priced.interested, priced.price, priced.realistic], [true, true, true, true]);
  assert.equal(funnelLabels({ delivered: true, inbound: 1, intents: [], stages: [], ask: 2020 }).price, false, "a year is never a price");
  assert.equal(funnelLabels({ delivered: true, inbound: 1, intents: ["wrong_number"], stages: [] }).owner, false);
  const items = [
    { labels: priced, signals: { tier: "A" } },
    { labels: own, signals: { tier: "A" } },
    { labels: who, signals: { tier: "C" } },
    { labels: funnelLabels({ delivered: true, inbound: 0 }), signals: { tier: "C" } },
  ];
  const f = funnelBySignal(items, { signals: ["tier"] });
  const t = Object.fromEntries(f.overall.transitions.map((x) => [`${x.from}→${x.to}`, x]));
  assert.deepEqual([t["delivered→replied"].k, t["delivered→replied"].n], [3, 4]);
  assert.deepEqual([t["owner→interested"].k, t["owner→interested"].n], [1, 2]);
  assert.ok(t["owner→interested"].thin);
  const given = funnelBySignal(items, { signals: ["tier"], conditionalOn: "owner" });
  assert.equal(given.overall.n, 2);
  assert.deepEqual(given.by_signal.tier.map((g) => [g.value, g.n]), [["A", 2]]);
  assert.deepEqual(wilson(0, 0), [null, null]);
});

test("deal attribution: a contract needs a non-voided closing record; lifecycle-only formal_contract is unverified; profitable = funded", () => {
  const base = { delivered: true, inbound: 3, intents: ["asking_price_provided"], stages: ["S4B"], ask: 200000, value: 250000 };
  const voided = funnelLabels({ ...base, lifecycle: ["offer", "formal_contract"], closing: { contract_status: "cancelled", voided: true } });
  assert.equal(voided.negotiation, true);
  assert.equal(voided.contract, false);
  assert.equal(voided.contract_voided, true);
  const lifecycleOnly = funnelLabels({ ...base, lifecycle: ["formal_contract"] });
  assert.equal(lifecycleOnly.contract, false);
  assert.equal(lifecycleOnly.contract_unverified, true);
  const real = funnelLabels({ ...base, lifecycle: ["offer"], closing: { contract_status: "signed", funding_status: "pending" } });
  assert.deepEqual([real.contract, real.deal], [true, false]);
  const funded = funnelLabels({ ...base, closing: { contract_status: "signed", funding_status: "funded" } });
  assert.deepEqual([funded.contract, funded.deal], [true, true]);
  const f = funnelBySignal([{ labels: funded, signals: { p: "x" } }, { labels: voided, signals: { p: "x" } }, ...Array.from({ length: 998 }, () => ({ labels: funnelLabels({ delivered: true, inbound: 0 }), signals: { p: "x" } }))], { signals: ["p"] });
  assert.equal(f.overall.north_star.contracts_per_1000, 1);
  assert.equal(f.overall.north_star.profitable_deals_per_1000, 1);
  assert.equal(f.overall.north_star.voided_contracts, 1);
  assert.equal(f.by_signal.p[0].north_star.delivered, 1000);
});

test("two-arm checkpoint: Newcombe difference CIs and pre-registered verdicts", () => {
  const d = diffCI(30, 300, 10, 300);
  assert.equal(d.diff, 0.0667);
  assert.ok(d.ci95[0] > 0 && d.ci95[1] > d.diff);
  assert.deepEqual(diffCI(0, 0, 1, 10), { diff: null, ci95: [null, null] });
  const mk = (arm, owner) => ({ labels: funnelLabels({ delivered: true, inbound: owner ? 1 : 0, intents: owner ? ["ownership_confirmed"] : [] }), signals: { arm } });
  const items = [...Array.from({ length: 300 }, (_, i) => mk("test", i < 30)), ...Array.from({ length: 300 }, (_, i) => mk("control", i < 10))];
  const cmp = armComparison(items, { checkpoint: "21d" });
  assert.equal(cmp.arms.test.delivered, 300);
  assert.equal(cmp.arms.test.owner.k, 30);
  assert.match(cmp.verdict.P1_owner, /test better/);
  assert.equal(cmp.verdict.decision_checkpoint, "FINAL");
  assert.equal(cmp.verdict.min_n_met, true);
  assert.match(armComparison(items, { checkpoint: "72h" }).verdict.decision_checkpoint, /informational/);
});

test("funnel API is dark by default and needs a scope", async () => {
  assert.equal((await runFunnel({ since: "2026-09-01" }, { env: {}, db: { query: async () => { throw new Error("no"); } } })).error, "seller_screener_disabled");
  assert.equal((await runFunnel({}, { env: { SELLER_SCREENER: "on" }, db: { query: async () => ({ rows: [] }) } })).error, "scope_required");
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
  assert.deepEqual(where, ["state = any($2::text[])"], "equity is a derived (known-only) metric — never pushed down as the raw column");
  assert.deepEqual(params, [["TX"]]);
  assert.equal(pushed.size, 1);
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
  const res = await readWhyTargeted(["a", "b", "missing"], { env: { SELLER_SCREENER: "on" }, db, loadSituations: async () => new Map([["a", sit("A", { fsp: 80, codes: ["TAX_DELINQUENT", "VACANT"] })]]), loadMarkets: async () => new Map(), loadMatchingFlags: async () => new Map(), loadResponse: async () => null });
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
  assert.match(out.zips[0].headline, /^Dallas, TX 75217 · \d+ high-pressure sellers \(tier A\) · \d+ stacked \(tier B\) of 18 reachable · \d+ high-contact-confidence · equity % unknown · strong buyer depth · investor activity high$/);
  assert.equal(out.zips[0].median_equity_percent_known, null, "no loan+value evidence → equity unknown, never 100%");
  assert.equal(out.zips[0].high_pressure, out.zips[0].tiers.A);
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

// ── audience filter vs message angle (owner 2026-10-07) ──────────────────────
test("audience vs angle: a name/copy-implied term with no filter is 'angle-only, not filtered'; a real filter is 'filtered'; discovery questions in copy never imply targeting", async () => {
  const { deriveAudienceVsAngle } = await import("@/lib/domain/campaigns/campaign-audience-angle.js");
  const tlOnlyName = deriveAudienceVsAngle({ name: "Dallas SFR · TL", metadata: { template_use_case: "ownership_check", target_filters: { properties: [{ field_key: "properties.market", operator: "is_any_of", value: ["Dallas, TX"] }, { field_key: "properties.property_type", operator: "is_any_of", value: ["Single Family"] }] } } }, { templates: [{ template_id: "1", template_body: "Hi, are you still the owner of {{property_address}}?", sends: 10 }] });
  assert.deepEqual(tlOnlyName.badges.map((b) => b.key), ["tired_landlord"]);
  assert.equal(tlOnlyName.terms.find((t) => t.key === "single_family").status, "filtered");
  assert.equal(tlOnlyName.audience_filters.length, 2);
  assert.equal(tlOnlyName.message_angle.use_case, "ownership_check");
  const filtered = deriveAudienceVsAngle({ name: "Los Angeles · MFR / TL", metadata: { target_filters: { properties: [{ field_key: "properties.property_flags_text", operator: "is_any_of", value: ["Tired Landlord"] }, { field_key: "properties.property_type", operator: "is_any_of", value: ["Multi-Family"] }] } } });
  assert.equal(filtered.badges.length, 0);
  assert.equal(filtered.terms.find((t) => t.key === "tired_landlord").status, "filtered");
  const question = deriveAudienceVsAngle({ name: "Miami - Test", metadata: {} }, { templates: [{ template_id: "2", template_body: "Is the home vacant or rented right now?" }] });
  assert.equal(question.badges.length, 0, "a vacancy QUESTION is not a vacancy TARGET");
  const copy = deriveAudienceVsAngle({ name: "Spring", metadata: {} }, { templates: [{ template_id: "3", template_body: "Tired of being a landlord? We buy as-is." }] });
  assert.deepEqual(copy.badges.map((b) => [b.key, b.implied_by]), [["tired_landlord", ["template_copy"]]]);
  assert.deepEqual(deriveAudienceVsAngle({ name: "x" }).audience_summary, ["(no saved audience filter)"]);
});

test("experiment decomposition: interest/delivered = reach × motivation, with per-right-owner rates and Katz RR CIs", () => {
  const mk = (arm, owner, interested) => ({ labels: funnelLabels({ delivered: true, inbound: owner ? 1 : 0, intents: owner ? (interested ? ["seller_interested"] : ["ownership_confirmed"]) : [] }), signals: { arm } });
  const items = [
    ...Array.from({ length: 300 }, (_, i) => mk("test", i < 60, i < 20)),     // reach 20%, motivation 33%
    ...Array.from({ length: 300 }, (_, i) => mk("control", i < 20, i < 7)),   // reach 6.7%, motivation 35%
  ];
  const cmp = armComparison(items, { checkpoint: "21d" });
  assert.equal(cmp.per_right_owner.test.owners, 60);
  assert.equal(cmp.per_right_owner.test.interested.k, 20);
  assert.equal(cmp.decomposition.verdict.reach, "test better");
  assert.equal(cmp.decomposition.verdict.motivation, "inconclusive");
  assert.match(cmp.decomposition.reads_as, /REACHING the owner/);
  const rrProduct = cmp.decomposition.reach_rr.rr * cmp.decomposition.motivation_rr.rr;
  assert.ok(Math.abs(rrProduct - cmp.decomposition.total_rr.rr) < 0.02, "RR_total = RR_reach × RR_motivation");
  assert.ok(cmp.decomposition.share_of_log_lift_from_reach > 1, "all of the lift (and more) comes from reach");
  assert.ok("realistic" in cmp.test_minus_control_per_owner && "negotiation" in cmp.test_minus_control_per_owner);
  assert.equal(cmp.arms.test.north_star.contracts_per_1000, 0, "north star reported even at 0");
});
