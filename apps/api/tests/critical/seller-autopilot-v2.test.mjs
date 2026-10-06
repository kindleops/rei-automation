/**
 * Seller Autopilot S1–S4 v2 — pure-module guards (no I/O).
 * Price logic, MAO cap, holds, intent rules and the flag default.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  isSellerAutopilotV2Enabled,
  computeAsIsAnchor,
  roundAnchorDown,
  resolveV2OfferAuthority,
  resolveV2AssetGate,
  planSellerAutopilotV2,
  resolveV2Intent,
  applySellerAutopilotV2Overlay,
  resolveV2AskingPriceThisTurn,
  resolveV2LanguageContinuity,
  buildV2ExecutionDirectives,
  V2_HOLD_REASONS,
  V2_INTENTS,
  V2_STAGES,
} from "@/lib/domain/seller-flow/seller-autopilot-v2.js";
import { resolveAuthorizedOfferAmount } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { MONETARY_OFFER_USE_CASES } from "@/lib/domain/seller-flow/seller-offer-authority.js";
import { adeSnapshot } from "../helpers/seller-autopilot-v2-harness.mjs";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const SPENDABLE = { spendable: true, reason: "valuation_offer_authoritative" };
const comps = (prices, extra = {}) =>
  prices.map((p, i) => ({ comp_id: `c${i}`, sale_price: p, distance_miles: 0.5, sale_date: "2026-07-01", source: "public_record_sold", ...extra }));
const ctx = (use_case, extra = {}) => ({
  context_version: "conversation_context_v1",
  canonical_thread: "+16125550123",
  inbound_thread: "+16125550123",
  last_outbound_message_id: "SM1",
  last_outbound_use_case: use_case,
  last_outbound_delivered_at: "2026-10-06T11:00:00.000Z",
  current_inbound_received_at: "2026-10-06T11:05:00.000Z",
  intervening_outbound_count: 0,
  intervening_inbound_count: 0,
  question_status: "unanswered",
  unanswered_question: true,
  ...extra,
});
const cls = (primary_intent, extra = {}) => ({
  primary_intent,
  confidence: 0.9,
  language: "English",
  automation_decision: { auto_reply_allowed: true, human_review_required: false },
  ...extra,
});
const authority = (over = {}) =>
  resolveV2OfferAuthority({ ade_snapshot: adeSnapshot(over), spendability: SPENDABLE, property_metadata: { property_type: "Single Family" } });

test("the flag defaults OFF; only explicit truthy values enable it", () => {
  assert.equal(isSellerAutopilotV2Enabled({}), false);
  assert.equal(isSellerAutopilotV2Enabled({ SELLER_AUTOPILOT_V2: "" }), false);
  assert.equal(isSellerAutopilotV2Enabled({ SELLER_AUTOPILOT_V2: "false" }), false);
  assert.equal(isSellerAutopilotV2Enabled({ SELLER_AUTOPILOT_V2: "0" }), false);
  for (const v of ["1", "true", "on", "yes", "TRUE"]) assert.equal(isSellerAutopilotV2Enabled({ SELLER_AUTOPILOT_V2: v }), true, v);
});

test("anchor = the lowest nearby as-is comp, rounded DOWN", () => {
  const a = computeAsIsAnchor({ comps: comps([152_400, 160_000, 175_000, 180_000]), mao: 200_000, now: NOW });
  assert.equal(a.ok, true);
  assert.equal(a.rule, "lowest_nearby_as_is_comp");
  assert.equal(a.amount, 150_000);
  assert.equal(a.capped_at_mao, false);
  assert.deepEqual(a.comp_ids, ["c0"]);
});

test("an outlier lowest comp (< 75% of the median) → average of the 3 lowest non-outlier comps", () => {
  const a = computeAsIsAnchor({ comps: comps([90_000, 160_000, 165_000, 170_000, 180_000]), mao: 200_000, now: NOW });
  assert.equal(a.ok, true);
  assert.equal(a.lowest_was_outlier, true);
  assert.equal(a.rule, "average_of_3_lowest_non_outlier_comps");
  assert.deepEqual(a.comp_prices, [160_000, 165_000, 170_000]);
  assert.equal(a.amount, 165_000);
});

test("the anchor is capped at MAO and NEVER above it (randomized)", () => {
  const capped = computeAsIsAnchor({ comps: comps([200_000, 210_000, 220_000]), mao: 171_999, now: NOW });
  assert.equal(capped.capped_at_mao, true);
  assert.equal(capped.amount, 170_000);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) {
    const n = 3 + Math.floor(rnd() * 8);
    const prices = Array.from({ length: n }, () => 20_000 + Math.round(rnd() * 600_000));
    const mao = 15_000 + Math.round(rnd() * 500_000);
    const a = computeAsIsAnchor({ comps: comps(prices), mao, now: NOW });
    if (a.ok) assert.ok(a.amount <= mao, `amount ${a.amount} > mao ${mao}`);
  }
});

test("rounding: ≥$100K floors to $5K, below to $1K", () => {
  assert.equal(roundAnchorDown(149_999), 145_000);
  assert.equal(roundAnchorDown(99_999), 99_000);
  assert.equal(roundAnchorDown(0), null);
});

test("anchor holds: fewer than 3 nearby recent comps; far / old / package sales are excluded", () => {
  assert.equal(computeAsIsAnchor({ comps: comps([150_000, 160_000]), mao: 200_000, now: NOW }).reason, V2_HOLD_REASONS.FEW_COMPS);
  const far = computeAsIsAnchor({ comps: comps([150_000, 160_000, 170_000], { distance_miles: 2.5 }), mao: 200_000, now: NOW });
  assert.equal(far.reason, V2_HOLD_REASONS.FEW_COMPS);
  const old = computeAsIsAnchor({ comps: comps([150_000, 160_000, 170_000], { sale_date: "2025-01-01" }), mao: 200_000, now: NOW });
  assert.equal(old.reason, V2_HOLD_REASONS.FEW_COMPS);
  const pkg = computeAsIsAnchor({ comps: comps([150_000, 160_000, 170_000], { source: "portfolio_sale" }), mao: 200_000, now: NOW });
  assert.equal(pkg.reason, V2_HOLD_REASONS.FEW_COMPS);
});

test("offer authority holds: no snapshot, multifamily, stale, non-authoritative, MAO missing, inconsistent", () => {
  assert.equal(resolveV2OfferAuthority({ ade_snapshot: null }).reason, V2_HOLD_REASONS.NO_OFFER);
  assert.equal(resolveV2AssetGate({ ade_snapshot: adeSnapshot(), property_metadata: { property_type: "Duplex" } }).sfr, false);
  assert.equal(resolveV2AssetGate({ ade_snapshot: adeSnapshot(), property_metadata: { unit_count: 6 } }).reason, V2_HOLD_REASONS.NOT_SFR);
  assert.equal(resolveV2OfferAuthority({ ade_snapshot: adeSnapshot({ asset_type: "multifamily_5_plus" }), spendability: SPENDABLE }).reason, V2_HOLD_REASONS.NOT_SFR);
  assert.equal(authority({ computed_at: "2026-09-01T00:00:00.000Z" }).reason, V2_HOLD_REASONS.STALE);
  const low = resolveV2OfferAuthority({ ade_snapshot: adeSnapshot(), spendability: { spendable: false, reason: "valuation_tier_not_offer_authoritative" } });
  assert.match(low.reason, /^v2_hold_offer_not_authoritative:valuation_tier_not_offer_authoritative/);
  const noMao = adeSnapshot();
  delete noMao.evidence.offer_calculation.effective_authorized_ceiling;
  assert.equal(resolveV2OfferAuthority({ ade_snapshot: noMao, spendability: SPENDABLE }).reason, V2_HOLD_REASONS.MAO_MISSING);
  assert.equal(authority({ offer: 180_000, mao: 170_000 }).reason, V2_HOLD_REASONS.OFFER_ABOVE_MAO);
  assert.equal(authority({ mao: 300_000, valuation_mid: 260_000 }).reason, V2_HOLD_REASONS.MAO_ABOVE_VALUE);
  assert.equal(authority().ok, true);
});

const plan = (intent, use_case, extra = {}) =>
  planSellerAutopilotV2({
    classification: cls(intent, extra.cls || {}),
    message: extra.message || "x",
    conversation_context: ctx(use_case),
    asking_price_this_turn: extra.ask ?? null,
    known_asking_price: extra.known ?? null,
    offer_authority: extra.authority === undefined ? authority() : extra.authority,
    now: NOW,
  });

test("S1 yes → interest question; S2 yes → price question; S3 bare yes → price re-ask", () => {
  assert.equal(plan("ownership_confirmed", "ownership_check", { message: "Yes" }).template_use_case, "consider_selling");
  assert.equal(plan("seller_interested", "proposal_interest", { message: "Yes" }).template_use_case, "seller_asking_price");
  assert.equal(plan("ownership_confirmed", "asking_price", { message: "yes" }).template_use_case, "seller_asking_price");
});

test("S3 price ≤ MAO → confirm basics (no number); price > MAO → condition probe", () => {
  const ok = plan("asking_price_provided", "asking_price", { ask: 145_000 });
  assert.equal(ok.template_use_case, "price_works_confirm_basics");
  assert.equal(ok.price_branch, "ask_at_or_below_offer");
  assert.equal(ok.monetary, null);
  assert.equal(plan("asking_price_provided", "asking_price", { ask: 165_000 }).price_branch, "ask_within_range");
  const high = plan("asking_price_provided", "asking_price", { ask: 240_000 });
  assert.equal(high.template_use_case, "price_high_condition_probe");
  assert.equal(high.monetary, null);
});

test("S4 any answer → anchor with the computed X and full evidence; no price → condition → anchor", () => {
  const a = plan("condition_disclosed", "condition_check", { known: 240_000 });
  assert.equal(a.action, "reply");
  assert.equal(a.template_use_case, "as_is_comp_anchor");
  assert.equal(a.monetary.amount, 150_000);
  assert.ok(a.monetary.amount <= a.monetary.ceiling);
  assert.equal(a.monetary.offer_version.snapshot_id, "snap-prop-v2-1");
  assert.deepEqual(a.monetary.comp_ids, ["comp-1"]);
  assert.equal(plan("asking_price_absent", "asking_price", { message: "no idea" }).template_use_case, "no_price_condition_probe");
  assert.equal(plan("asks_offer", "proposal_interest", { message: "send a bid" }).template_use_case, "no_price_condition_probe");
  assert.equal(plan("condition_disclosed", "condition_check").price_branch, "no_price_anchor");
});

test("guards: no offer → number-free condition probe, then review at the number step; multifamily / inconsistent price → review", () => {
  const none = plan("asking_price_provided", "asking_price", { ask: 240_000, authority: null });
  assert.equal(none.action, "reply");
  assert.equal(none.template_use_case, "price_high_condition_probe");
  assert.equal(none.hold_note, V2_HOLD_REASONS.NO_OFFER);
  assert.equal(none.monetary, null);
  const noneAnchor = plan("condition_disclosed", "condition_check", { known: 240_000, authority: null });
  assert.equal(noneAnchor.action, "review");
  assert.equal(noneAnchor.review_reason, V2_HOLD_REASONS.NO_OFFER);
  assert.equal(noneAnchor.monetary, null);
  const lowTier = resolveV2OfferAuthority({ ade_snapshot: adeSnapshot({ tier: "CREATIVE_TERMS" }), spendability: { spendable: false, reason: "valuation_tier_not_offer_authoritative" } });
  assert.equal(plan("condition_disclosed", "condition_check", { authority: lowTier }).action, "review");
  const mfPrice = resolveV2OfferAuthority({ ade_snapshot: adeSnapshot(), spendability: SPENDABLE, property_metadata: { unit_count: 2 } });
  assert.equal(plan("asking_price_provided", "asking_price", { ask: 240_000, authority: mfPrice }).action, "review");
  const mf = resolveV2OfferAuthority({ ade_snapshot: adeSnapshot(), spendability: SPENDABLE, property_metadata: { property_type: "Triplex", unit_count: 3 } });
  const mfPlan = plan("condition_disclosed", "condition_check", { authority: mf });
  assert.equal(mfPlan.action, "review");
  assert.equal(mfPlan.review_reason, V2_HOLD_REASONS.NOT_SFR);
  assert.equal(mfPlan.monetary, null);
  assert.equal(plan("asking_price_provided", "asking_price", { ask: 331 }).review_reason, V2_HOLD_REASONS.ASK_INCONSISTENT);
  assert.equal(plan("asking_price_provided", "asking_price", { ask: 5_000_000 }).review_reason, V2_HOLD_REASONS.ASK_INCONSISTENT);
});

test("opt-out, wrong number, hostile, not interested, referral, sold, trust are DEFERRED to the existing pipeline", () => {
  for (const intent of ["opt_out", "wrong_number", "hostile_or_legal", "not_interested", "non_owner_referral", "former_owner_respondent", "executor_heir_respondent", "property_specific_non_owner", "need_time"]) {
    const p = plan(intent, "condition_check");
    assert.equal(p.handled, false, intent);
    assert.equal(p.action, "defer", intent);
  }
  // A compliance flag on ANY intent defers.
  assert.equal(plan("asking_price_provided", "asking_price", { ask: 150_000, cls: { compliance_flag: "stop" } }).action, "defer");
  // Opt-out words beat every v2 rule, in the overlay too.
  const r = resolveV2Intent({ classification: cls("unclear"), message: "send me an offer or stop texting me", stage: V2_STAGES.S2 });
  assert.equal(r.intent, V2_INTENTS.OPT_OUT);
  const o = applySellerAutopilotV2Overlay(cls("unclear"), { message: "send a bid. STOP", conversation_context: ctx("proposal_interest") });
  assert.equal(o.overlay, null);
});

test("capital gains → creative probe even after a soft no; why/who → identity + resume the stage", () => {
  const cg = plan("not_interested", "proposal_interest", { message: "No, the capital gains would kill me" });
  assert.equal(cg.template_use_case, "capital_gains_creative_probe");
  assert.deepEqual(plan("who_is_this", "ownership_check").template_preference, ["who_is_this_resume_ownership", "who_is_this"]);
  assert.deepEqual(plan("who_is_this", "proposal_interest").template_preference, ["who_is_this"]);
  assert.deepEqual(plan("who_is_this", "asking_price").template_preference, ["who_is_this_resume_price", "who_is_this"]);
  assert.deepEqual(plan("who_is_this", "condition_check").template_preference, ["who_is_this_resume_condition", "who_is_this"]);
});

test("overlay binds a bare yes ONLY to an open question; the classifier's review verdict otherwise stands", () => {
  const review = cls("unclear", { confidence: 0.64, automation_decision: { auto_reply_allowed: false, human_review_required: true } });
  const bound = applySellerAutopilotV2Overlay(review, { message: "Sure", conversation_context: ctx("proposal_interest") });
  assert.equal(bound.classification.primary_intent, "seller_interested");
  assert.equal(bound.classification.automation_decision.human_review_required, false);
  const stale = applySellerAutopilotV2Overlay(review, { message: "Sure", conversation_context: ctx("proposal_interest", { unanswered_question: false }) });
  assert.equal(stale.overlay, null);
  assert.equal(stale.classification.automation_decision.human_review_required, true);
  const tal = applySellerAutopilotV2Overlay(review, { message: "Tal vez si es una buena propuesta, la podría considerar", conversation_context: ctx("proposal_interest") });
  assert.equal(tal.classification.primary_intent, "seller_interested");
  const plain = plan("unclear", "proposal_interest", { cls: { automation_decision: { human_review_required: true } } });
  assert.equal(plain.action, "defer");
});

test("multilingual: local-unit price, Latin-script offer requests, language continuity", () => {
  assert.equal(resolveV2AskingPriceThisTurn({ classification: cls("asking_price_provided"), message: "24万" }).amount, 240_000);
  assert.equal(resolveV2AskingPriceThisTurn({ classification: cls("unclear"), message: "24万" }).amount, null);
  for (const m of ["Faites-moi une offre", "Faça uma oferta", "Machen Sie mir ein Angebot", "Mi faccia un'offerta", "Złóż ofertę"]) {
    assert.equal(resolveV2Intent({ classification: cls("unclear"), message: m, stage: V2_STAGES.S3 }).intent, V2_INTENTS.OFFER_REQUEST, m);
  }
  const lang = resolveV2LanguageContinuity(cls("condition_disclosed"), { seller_reply_language: "Spanish" }, "Necesita techo nuevo");
  assert.equal(lang.language, "Spanish");
  assert.equal(resolveV2LanguageContinuity(cls("condition_disclosed"), { seller_reply_language: "Spanish" }, "It needs a new roof"), null);
});

test("directives: the anchor amount renders and persists only through the bounded offer authority", () => {
  const a = plan("condition_disclosed", "condition_check");
  const d = buildV2ExecutionDirectives(a);
  assert.equal(d.strategyDirective.next_action, "send_message_now");
  assert.deepEqual(d.strategyDirective.template_preference, ["as_is_comp_anchor"]);
  const deal = { offer_authoritative: true, ...d.dealAuthorityPatch };
  assert.equal(resolveAuthorizedOfferAmount(deal), 150_000);
  assert.equal(resolveAuthorizedOfferAmount({ ...deal, authorized_offer_amount: 999_999 }), null, "above ceiling fails closed");
  assert.equal(resolveAuthorizedOfferAmount({ ...deal, offer_authoritative: false }), null);
  // LOGGING MODEL: anchors are NOT formal offers (negotiation_quotes, not seller_offers).
  assert.equal(MONETARY_OFFER_USE_CASES.has("as_is_comp_anchor"), false);
  assert.equal(MONETARY_OFFER_USE_CASES.has("price_anchor_above_max"), false);
  assert.equal(MONETARY_OFFER_USE_CASES.has("comp_anchor"), false);
  const r = buildV2ExecutionDirectives(plan("condition_disclosed", "condition_check", { authority: null }));
  assert.equal(r.strategyDirective.review_required, true);
  assert.equal(r.dealAuthorityPatch, null);
});

// ── Re-delivery (Phase 5) ────────────────────────────────────────────────────
import { resolveAutoReplyRedelivery } from "@/lib/domain/seller-flow/seller-autopilot-v2-redelivery.js";

const failedRow = (over = {}) => ({
  id: "row-1",
  type: "auto_reply",
  queue_status: "failed_transport",
  provider_message_id: "SM123",
  template_id: "400065",
  use_case_template: "consider_selling",
  to_phone_number: "+16125550123",
  from_phone_number: "+16125550100",
  sent_at: new Date(NOW - 10 * 60_000).toISOString(),
  metadata: { source: "auto_reply", decision_id: "evt-1", failure_class: "content_filter_blocked" },
  ...over,
});
const ALT = [{ template_id: "400066", is_active: true, safe_for_auto_reply: true }];

test("re-delivery: one retry, new logical communication, alternate body, sender re-selected", () => {
  const r = resolveAutoReplyRedelivery({ row: failedRow(), now: NOW, inbound_classification: cls("ownership_confirmed"), alternate_templates: ALT });
  assert.equal(r.eligible, true);
  assert.equal(r.row.metadata.decision_id, "evt-1:redelivery:1");
  assert.equal(r.row.template_id, "400066");
  assert.equal(r.row.from_phone_number, null);
  assert.equal(r.row.max_retries, 1);
  const again = resolveAutoReplyRedelivery({ row: { ...failedRow(), metadata: { ...r.row.metadata, failure_class: "content_filter_blocked" } }, now: NOW, inbound_classification: cls("ownership_confirmed"), alternate_templates: ALT });
  assert.equal(again.reason, "already_a_redelivery");
});

test("re-delivery never double-sends: unknown outcome, delivered, newer inbound, suppression, opt-out, stale, no alternate", () => {
  const base = { now: NOW, inbound_classification: cls("ownership_confirmed"), alternate_templates: ALT };
  assert.equal(resolveAutoReplyRedelivery({ ...base, row: failedRow({ provider_message_id: null }) }).reason, "no_provider_sid_outcome_unknown");
  assert.equal(resolveAutoReplyRedelivery({ ...base, row: failedRow({ delivered_at: "2026-10-06T11:00:00Z" }) }).reason, "was_delivered");
  assert.equal(resolveAutoReplyRedelivery({ ...base, row: failedRow(), newer_inbound_exists: true }).reason, "seller_wrote_again");
  assert.equal(resolveAutoReplyRedelivery({ ...base, row: failedRow(), active_suppression: true }).reason, "active_suppression");
  assert.equal(resolveAutoReplyRedelivery({ ...base, row: failedRow(), inbound_classification: cls("opt_out", { compliance_flag: "stop" }) }).eligible, false);
  assert.equal(resolveAutoReplyRedelivery({ ...base, row: failedRow({ sent_at: new Date(NOW - 2 * 3600_000).toISOString() }) }).reason, "reply_too_old");
  assert.equal(resolveAutoReplyRedelivery({ ...base, row: failedRow(), alternate_templates: [] }).reason, "no_alternate_approved_body");
  assert.match(resolveAutoReplyRedelivery({ ...base, row: failedRow({ metadata: { source: "auto_reply", failure_class: "invalid_number" } }) }).reason, /^never_redeliver/);
  assert.equal(resolveAutoReplyRedelivery({ ...base, row: failedRow({ type: "campaign", metadata: { source: "campaign", failure_class: "content_filter_blocked" } }) }).reason, "not_an_auto_reply");
});


// ── Owner decisions 2026-10-06 ───────────────────────────────────────────────
import { evaluateOfferReadiness, summarizeOfferReadiness, authoritativeMaxOffer } from "@/lib/acquisition/offerReadiness.js";
import { shouldSkipExisting, resolveConfig, runBackfillTick, resolveScope } from "@/lib/acquisition/scoringBackfill.js";
import { buildNegotiationQuote, quoteTypeFor, describeQuote, QUOTE_TYPES } from "@/lib/domain/seller-flow/negotiation-quotes.js";
import { parseEnabledLanguages, isReplyLanguageEnabled, summarizeAutopilotLanguageStatus, detectIdentityStatement, isBareNo } from "@/lib/domain/seller-flow/seller-autopilot-v2.js";

test("offer-ready predicate: authoritative tier + fresh (≥09-12, ≤30 d) + offer + ceiling; backfill rows never price", () => {
  const fresh = adeSnapshot();
  assert.equal(evaluateOfferReadiness(fresh).ready, true);
  assert.equal(evaluateOfferReadiness(null).reason, "not_scored");
  assert.equal(evaluateOfferReadiness(adeSnapshot({ computed_at: "2026-09-01T00:00:00Z" })).reason, "score_predates_current_policy");
  const LATER = Date.parse("2026-11-15T00:00:00Z");
  assert.equal(evaluateOfferReadiness(adeSnapshot({ computed_at: "2026-09-20T00:00:00Z" }), { now: LATER }).reason, "score_stale");
  assert.equal(evaluateOfferReadiness(adeSnapshot({ tier: "CREATIVE_TERMS" })).reason, "tier_not_offer_authoritative");
  const backfill = adeSnapshot();
  backfill.evidence.backfill = { evidence_mode: "compact", monetary_authority: false };
  assert.equal(evaluateOfferReadiness(backfill).reason, "backfill_row_not_monetary_authority");
  assert.equal(authoritativeMaxOffer(adeSnapshot({ mao: 79_100 })), 79_100);
  const s = summarizeOfferReadiness(["a", "b", "c", "c"], new Map([["a", fresh], ["b", adeSnapshot({ tier: "NURTURE" })]]));
  assert.deepEqual([s.sendable, s.offer_ready, s.review_only], [3, 1, 2]);
  assert.equal(s.label, "3 sendable · 1 offer-ready · 2 review-only");
  // v2 uses the SAME predicate
  assert.equal(resolveV2OfferAuthority({ ade_snapshot: adeSnapshot({ computed_at: "2026-09-20T00:00:00Z" }), spendability: SPENDABLE, now: LATER }).reason, V2_HOLD_REASONS.STALE);
});

test("campaign-scoped scoring: only campaign targets, full monetary scorer, offer-ready rows skipped, compact rows rescored", async () => {
  const cfg = resolveConfig({ scope: { kind: "campaign", campaign_ids: ["c1"] } });
  assert.deepEqual(resolveScope(null), { kind: "all_properties" });
  assert.equal(cfg.scope.kind, "campaign");
  assert.equal(shouldSkipExisting(adeSnapshot(), cfg), true, "already offer-ready");
  assert.equal(shouldSkipExisting({ ...adeSnapshot({ tier: "CREATIVE_TERMS" }) }, cfg), true, "fresh engine verdict, not a gap");
  const compact = adeSnapshot();
  compact.evidence.backfill = { evidence_mode: "compact", monetary_authority: false };
  assert.equal(shouldSkipExisting(compact, cfg), false, "backfill row rescored at full authority");
  assert.equal(shouldSkipExisting(adeSnapshot({ computed_at: "2026-09-01T00:00:00Z" }), cfg), false, "pre-policy row rescored");

  const pages = [["p1", "p2", "p3"], []];
  const calls = { page: [], monetary: [], compact: 0 };
  const store = {
    readState: async () => ({ status: "running", config: { scope: { kind: "campaign", campaign_ids: ["c1"] } } }),
    writeState: async () => {},
    readContactWindow: async () => ({ start: "08:00", end: "21:00" }),
    probeLoad: async () => ({ ok: true, latency_ms: 5, active_backends: 1, long_running: 0, lock_waits: 0 }),
    loadPropertyPage: async (p) => { calls.page.push(p.scope); return pages.shift() || []; },
    loadExistingScores: async () => [adeSnapshot({ property_id: "p2" })],
    scoreOne: async () => { calls.compact += 1; return { ok: true }; },
    scoreOneMonetary: async (id) => { calls.monetary.push(id); return { ok: true }; },
  };
  const summary = await runBackfillTick({ store, ignoreWindow: true, sleep: async () => {} });
  assert.equal(calls.page[0].kind, "campaign");
  assert.deepEqual(calls.monetary, ["p1", "p3"], "p2 already offer-ready → skipped");
  assert.equal(calls.compact, 0, "campaign scope never writes compact backfill rows");
  assert.equal(summary.scored, 2);
  assert.equal(summary.skipped_existing, 1);
});

test("negotiation quote contract: anchor ≤ max with evidence; confirm-basics carries no number; formal offers typed", () => {
  assert.equal(quoteTypeFor({ use_case: "as_is_comp_anchor" }), QUOTE_TYPES.ANCHOR);
  assert.equal(quoteTypeFor({ use_case: "price_anchor_above_max" }), QUOTE_TYPES.ANCHOR);
  assert.equal(quoteTypeFor({ use_case: "offer_reveal_cash" }), QUOTE_TYPES.FORMAL_OFFER);
  assert.equal(quoteTypeFor({ use_case: "price_works_confirm_basics" }), QUOTE_TYPES.CONFIRM_BASICS);
  assert.equal(quoteTypeFor({ use_case: "mystery", template_body: "around {{offer_price}}" }), QUOTE_TYPES.ANCHOR);
  assert.equal(quoteTypeFor({ use_case: "consider_selling", template_body: "Would you consider a proposal?" }), null);
  const base = { quote_key: "k", thread_key: "+16125550123", rule_branch: "above_max" };
  assert.throws(() => buildNegotiationQuote({ ...base, quote_type: "anchor", amount: 180_000, max_offer: 170_000 }), /above_max_offer/);
  assert.throws(() => buildNegotiationQuote({ ...base, quote_type: "anchor", amount: 150_000 }), /max_offer_required/);
  assert.throws(() => buildNegotiationQuote({ ...base, quote_type: "confirm_basics_no_number", amount: 1 }), /carries_no_number/);
  const row = buildNegotiationQuote({ ...base, quote_type: "anchor", amount: 185_000, max_offer: 190_000, quoted_at: "2026-10-06T15:00:00Z" });
  assert.equal(describeQuote(row), "Anchor $185K quoted 10-06 (rule: above_max)");
});

test("above max: X = the engine's opening offer, floored, never above MAO, and no comp claim", () => {
  const a = plan("condition_disclosed", "condition_check", { authority: authority({ comp_prices: [200_000, 210_000, 220_000], mao: 171_999, offer: 152_300 }) });
  assert.equal(a.template_use_case, "price_anchor_above_max");
  assert.equal(a.monetary.rule, "above_max");
  assert.equal(a.monetary.amount, 150_000);
  assert.ok(a.monetary.amount <= a.monetary.ceiling);
});

test("bare No at S1 → one clarifier; identity statements and a second No route to review", () => {
  const review = cls("unclear", { confidence: 0.6, automation_decision: { auto_reply_allowed: false, human_review_required: true } });
  const o = applySellerAutopilotV2Overlay(review, { message: "No", conversation_context: ctx("ownership_check") });
  assert.equal(o.overlay.v2_intent, "bare_no_to_ownership");
  const p1 = planSellerAutopilotV2({ classification: o.classification, message: "No", conversation_context: ctx("ownership_check"), now: NOW });
  assert.deepEqual(p1.template_preference, ["ownership_connection_clarifier"]);
  const after = ctx("ownership_check", { last_outbound_template_use_case: "ownership_connection_clarifier" });
  const p2 = planSellerAutopilotV2({ classification: review, message: "No", conversation_context: after, now: NOW });
  assert.equal(p2.action, "review");
  assert.equal(p2.review_reason, "v2_bare_no_after_ownership_clarifier");
  const p3 = planSellerAutopilotV2({ classification: cls("property_specific_non_owner"), message: "my LLC owns it", conversation_context: after, now: NOW });
  assert.equal(p3.review_reason, "v2_identity_resolution:entity_owner");
  const p4 = planSellerAutopilotV2({ classification: cls("wrong_number"), message: "wrong number", conversation_context: after, now: NOW });
  assert.equal(p4.action, "defer", "wrong number keeps the suppression lane");
  assert.equal(detectIdentityStatement("I just manage it"), "property_manager");
  assert.equal(detectIdentityStatement("my mom owns it"), "family_owner");
  assert.equal(detectIdentityStatement("I rent here"), "occupant");
  assert.equal(isBareNo("Nope."), true);
  assert.equal(isBareNo("No I don't own it"), false);
});

test("per-language enablement: default EN+ES; unknown names never enable; status shows the split", () => {
  assert.deepEqual(parseEnabledLanguages(null), ["English", "Spanish"]);
  assert.deepEqual(parseEnabledLanguages("english, pt, klingon, hindi"), ["English", "Portuguese", "Indian (Hindi or Other)"]);
  assert.equal(isReplyLanguageEnabled("Portuguese"), false);
  assert.equal(isReplyLanguageEnabled("Spanish"), true);
  const st = summarizeAutopilotLanguageStatus({ flag: true, raw: null });
  assert.deepEqual(st.languages_enabled, ["English", "Spanish"]);
  assert.equal(st.languages_review_only.length, 14);
  assert.equal(st.source, "default");
});

test("Composer Offer Ready preflight reads a campaign's queue-eligible targets with the same predicate", async () => {
  const { readComposerOfferReadiness } = await import("@/lib/domain/campaigns/campaign-composer.js");
  const targets = [{ property_id: "a" }, { property_id: "b" }, { property_id: "c" }];
  const calls = [];
  const supabase = {
    from(table) {
      const b = {
        select: () => b, eq: (...a) => (calls.push([table, "eq", ...a]), b), in: (...a) => (calls.push([table, "in", a[0]]), b), not: () => b, order: () => b,
        range: () => Promise.resolve({ data: targets, error: null }),
      };
      return b;
    },
  };
  const scores = new Map([["a", adeSnapshot()], ["b", adeSnapshot({ tier: "CREATIVE_TERMS" })]]);
  const r = await readComposerOfferReadiness({ campaign_id: "cbc2a5d3" }, { supabase, readOfferReadinessScores: async () => scores });
  assert.equal(r.ok, true);
  assert.equal(r.label, "3 sendable · 1 offer-ready · 2 review-only");
  assert.deepEqual(r.by_reason, { offer_ready: 1, tier_not_offer_authoritative: 1, not_scored: 1 });
  assert.ok(calls.some((c) => c[0] === "campaign_targets" && c[1] === "in" && c[2] === "target_status"), "queue-eligible targets only");
});

test("campaign scoring run: owner auto-pause thresholds and the 12:00Z start rule", async () => {
  const { evaluateBatchHealth, windowVerdict } = await import("../../scripts/ops/campaign-offer-scoring-run.mjs");
  assert.equal(windowVerdict(new Date("2026-10-06T08:37:00Z")).ok, false);
  assert.equal(windowVerdict(new Date("2026-10-06T12:00:00Z")).ok, true);
  const ok = evaluateBatchHealth({ load: { active_sessions: 8, max_query_seconds: 2 }, attempted: 25, scored: 25, deltaBytes: 25 * 200 * 1024, totalBytes: 5e6 });
  assert.equal(ok.healthy, true);
  const bad = evaluateBatchHealth({ load: { active_sessions: 13, max_query_seconds: 11 }, timeouts: 3, errors: 1, attempted: 25, scored: 24, deltaBytes: 24 * 400 * 1024, totalBytes: 0.9 * 1024 ** 3 });
  assert.equal(bad.healthy, false);
  assert.equal(bad.reasons.length, 6);
});
