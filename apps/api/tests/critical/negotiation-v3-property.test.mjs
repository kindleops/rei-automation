/**
 * Negotiation Engine v3 — property-based randomized tests (§91) + golden cases.
 * Seeded PRNG (deterministic, no network). Invariants:
 *   never above the ceiling · never above the autonomous limit without HUMAN ·
 *   every number logged before send · a logging failure blocks the send ·
 *   no false comp claim · no unit math without a unit count ·
 *   no money without authoritative evidence · pressure never moves C/T/AL/AF ·
 *   both flags default OFF · NEVER BLANK (owner 10-07): numbers whenever the
 *   authority supplies a ceiling + offer; autonomy gated by grade / rung / lane ·
 *   anchor never below investor price × (1 − 25%).
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildNegotiationPlan,
  nextNegotiationMove,
  planLadder,
  logQuoteThenSend,
  buildQuoteLogRow,
  summarizeNegotiationQuotes,
  isOfferReady,
  normalizeAuthority,
  authorityFromOfferAuthority,
  validateSellerFacing,
  sellerFacingReply,
  supportiveComps,
  resolveNegotiationFlags,
  NEGOTIATION_ACTIONS as A,
  QUOTE_TYPES_V3 as Q,
} from "../../src/lib/domain/negotiation-v3/index.js";
import { authoritativeOfferFromScore } from "../../src/lib/acquisition/offerAuthority.js";

const NOW = Date.parse("2026-10-07T05:00:00Z");
const ON = { NEGOTIATION_ENGINE_V3: "true", AUTONOMOUS_MONETARY_QUOTES: "true" };
const N_PLANS = Number(process.env.NV3_CASES || 4000);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uni = (r, lo, hi) => lo + (hi - lo) * r();
const pick = (r, list) => list[Math.floor(r() * list.length)];
const round100 = (v) => Math.round(v / 100) * 100;

function genComps(r, V, { mf = false, units = null } = {}) {
  const n = Math.floor(uni(r, 0, 9));
  return Array.from({ length: n }, (_, i) => ({
    comp_id: `c${i}`,
    sale_price: round100(V * uni(r, 0.3, 1.4)),
    distance_miles: uni(r, 0, 2.5),
    sale_date: new Date(NOW - uni(r, 0, 500) * 86_400_000).toISOString().slice(0, 10),
    source: pick(r, ["public_record_sold", "mls_sold", "portfolio_sale"]),
    units: mf ? pick(r, [units, units, null, 1, 4]) : null,
  }));
}

/** A score row; `corrupt` makes it non-authoritative in one random way. */
function genScore(r, { mf = false, units = null, corrupt = null } = {}) {
  const V = round100(uni(r, 60_000, 1_500_000));
  const Rr = round100(V * uni(r, 0.36, 0.8));
  const C = Math.min(round100(Rr * uni(r, 1.0, 1.3)), round100(V * 0.9));
  const repairs = round100(V * uni(r, 0, 0.42));
  const row = {
    property_id: `p${Math.floor(r() * 1e9)}`,
    decision_tier: pick(r, ["AUTO_HARD_OFFER", "AUTO_RANGE_OFFER"]),
    recommended_cash_offer: Math.min(Rr, C),
    valuation_mid: V,
    estimated_repairs: repairs,
    computed_at: new Date(NOW - uni(r, 0, 25) * 86_400_000).toISOString(),
    comp_count: Math.floor(uni(r, 5, 15)),
    evidence: {
      offer_calculation: { effective_authorized_ceiling: C },
      engine: { version: "2.0.0" },
      subject: mf
        ? { asset_family: "multifamily", asset_type: "multifamily", asset_identity_conflict: false, normalized_features: { units } }
        : { asset_family: "residential", asset_type: "single_family", asset_identity_conflict: false, normalized_features: { units: 1 } },
      selected_comps: genComps(r, mf && units ? V : V, { mf, units }),
    },
  };
  switch (corrupt) {
    case "tier":
      row.decision_tier = pick(r, ["CREATIVE_TERMS", "REVIEW_REQUIRED", "NURTURE", ""]);
      break;
    case "stale":
      row.computed_at = new Date(NOW - uni(r, 31, 200) * 86_400_000).toISOString();
      break;
    case "predates":
      row.computed_at = "2026-09-01T00:00:00Z";
      break;
    case "no_ceiling":
      row.evidence.offer_calculation.effective_authorized_ceiling = pick(r, [null, 0, -5, ""]);
      break;
    case "no_offer":
      row.recommended_cash_offer = pick(r, [null, 0]);
      break;
    case "sanity":
      row.recommended_cash_offer = round100(V * 0.05);
      break;
    case "low_n":
      row.comp_count = Math.floor(uni(r, 0, 4));
      break;
    case "identity":
      row.evidence.subject = { asset_family: "multifamily", asset_identity_conflict: true, normalized_features: { units: 1 } };
      break;
    case "compact":
      row.evidence.backfill = { monetary_authority: false };
      break;
    case "missing":
      return null;
    default:
  }
  return row;
}

/** CONTRACT_offer_authority-shaped output (D), random grade / rung / lane / authorization. */
function genOfferAuthority(r, { mf = false, units = null } = {}) {
  const I = round100(uni(r, 60_000, 1_500_000));
  const C = round100(I * (1 - uni(r, 0.08, 0.2)));
  const R = round100(C * (1 - uni(r, 0.03, 0.12)));
  const blank = r() < 0.05;
  const lane = mf ? pick(r, [units >= 5 ? "mf5" : "mf24", units >= 5 ? "mf5" : "mf24", null]) : pick(r, ["sfr", "sfr", "sfr", null]);
  const bandMid = units ? I / units : null;
  return {
    property_id: `d${Math.floor(r() * 1e9)}`,
    engine: "offer_engine_v3_merged",
    engine_version: "test",
    computed_at: new Date(NOW - 86_400_000).toISOString(),
    authorized: r() < 0.7,
    fresh: r() < 0.9,
    reasons: [],
    lane,
    investor_price: r() < 0.85 ? I : null,
    value: I,
    ceiling: blank ? null : C,
    offer: blank ? null : R,
    per_unit: mf && Number.isInteger(units) && units >= 2 ? { units, value: Math.round(I / units), band: { low: round100(bandMid * 0.92), high: round100(bandMid * 1.06) } } : null,
    confidence_grade: pick(r, ["A", "A", "A", "B", "C", "D", null]),
    fallback_rung: pick(r, [0, 0, 0, 1, 2, null]),
    fallback_geography: r() < 0.1,
    negotiation_authority: {
      asset_family: mf ? "multifamily" : "residential",
      units: mf ? units : 1,
      asset_identity_conflict: mf && units === 1,
      comps: genComps(r, I, { mf, units }),
    },
  };
}

function genSituation(r) {
  if (r() < 0.3) return null;
  const c = () => (r() < 0.2 ? null : Math.floor(uni(r, 0, 100)));
  return {
    score_version: "seller_situation_v2",
    seller_situation: pick(r, ["FINANCIALLY_PRESSURED", "FATIGUED_LANDLORD", "EQUITY_RICH_ABSENTEE", "TAX_DISTRESSED", "WEALTH_PRESERVATION", "NO_CLEAR_SITUATION"]),
    conversation_angle: pick(r, [null, "SPEED_CERTAINTY", "SELLER_FINANCE", "TENANT_RELIEF"]),
    components: { forced_sale_pressure: c(), landlord_fatigue: c(), equity_unlock: c(), tax_pain: c(), debt_pressure: c(), property_burden: c() },
  };
}

function genCtx(r, opts = {}) {
  const mf = opts.mf ?? r() < 0.25;
  const units = mf ? pick(r, [2, 3, 4, 6, 11, 18, 24, null, 1, 2.5, 0]) : null;
  const corrupt = opts.corrupt === undefined ? (r() < 0.3 ? pick(r, ["tier", "stale", "predates", "no_ceiling", "no_offer", "sanity", "low_n", "identity", "compact", "missing"]) : null) : opts.corrupt;
  const useD = opts.d ?? r() < 0.4;
  const score = useD ? null : genScore(r, { mf, units, corrupt });
  const oa = useD ? genOfferAuthority(r, { mf, units }) : null;
  const V = score?.valuation_mid ?? oa?.value ?? 200_000;
  return {
    ade_snapshot: score,
    offer_authority: oa,
    property: { property_id: score?.property_id ?? oa?.property_id, property_type: mf ? "Multi-Family" : "Single Family", units_count: mf ? pick(r, [units, units, units, null, units === 11 ? 12 : units]) : 1 },
    seller: {
      asking_price: r() < 0.2 ? null : round100(V * uni(r, 0.3, 2.5)),
      condition: r() < 0.25 ? null : pick(r, ["good", "dated", "needs work"]),
      occupancy: pick(r, [null, "vacant", "tenant occupied"]),
    },
    situation: genSituation(r),
    market: r() < 0.5 ? null : { buyer_depth: pick(r, ["strong", "normal", "weak"]) },
    now: NOW,
    env: opts.env ?? ON,
    _corrupt: useD ? null : corrupt,
  };
}

/** Drive one negotiation for up to 8 seller events; return every move. */
function simulate(r, plan) {
  const moves = [];
  const state = { lc_positions: [], seller_positions: [], holds: 0 };
  let ask = plan.seller_ask ?? round100((plan.valuation_mid ?? 200_000) * uni(r, 0.4, 2.2));
  for (let i = 0; i < 8; i += 1) {
    const kind = i === 0 ? pick(r, ["price", "make_offer", "no_price", "price"]) : pick(r, ["counter", "counter", "counter", "pushback", "accept", "reject", "capital_gains"]);
    const event = { kind, amount: ["price", "counter"].includes(kind) ? ask : null };
    const move = nextNegotiationMove(plan, state, event);
    moves.push({ move, event, state: { ...state, lc_positions: [...state.lc_positions] } });
    if (move.action === A.QUOTE) {
      if (move.quote_type === Q.FORMAL_OFFER) break;
      if (!state.lc_positions.length || move.amount > Math.max(...state.lc_positions)) state.lc_positions.push(move.amount);
      state.holds = 0;
    } else if (move.action === A.HOLD) {
      state.holds += 1;
    } else if (move.action !== A.NO_NUMBER) {
      break;
    }
    if (event.amount != null) state.seller_positions.push(event.amount);
    ask = Math.max(10_000, round100(ask * uni(r, 0.9, 1.01)));
  }
  return moves;
}

test("flags: both default OFF; quotes flag alone does nothing", () => {
  assert.deepEqual(resolveNegotiationFlags({}), { engine_v3: false, autonomous_monetary_quotes: false });
  assert.deepEqual(resolveNegotiationFlags({ AUTONOMOUS_MONETARY_QUOTES: "true" }), { engine_v3: false, autonomous_monetary_quotes: false });
  assert.deepEqual(resolveNegotiationFlags(ON), { engine_v3: true, autonomous_monetary_quotes: true });
});

const counters = { plans: 0, ok_plans: 0, moves: 0, quotes: 0, human: 0, comp_lang: 0, mf_quotes: 0, closes: 0 };

test(`property: ${N_PLANS} random plans × negotiations — money invariants (prod v2 + D-shaped authorities)`, () => {
  const r = rng(20261007);
  const GRADES = ["A"]; // owner ladder 10-07: only grade A + nearest ring is autonomous
  for (let i = 0; i < N_PLANS; i += 1) {
    const ctx = genCtx(r, { env: ON });
    // MF lanes are human by default; open them in half the MF cases to exercise per-door quotes.
    // Ungraded prod rows are review by default; in half the cases use the legacy fallback to exercise the
    // money path. MF lanes are closed by default; open them in half the MF cases to exercise per-unit quotes.
    ctx.config = {};
    if (r() < 0.5) ctx.config.autonomy = { ungraded: "authorized_only" };
    if (ctx.property.property_type === "Multi-Family" && r() < 0.5) Object.assign(ctx.config, { lanes: { mf24: { enabled: true }, mf5: { enabled: true } }, lane_backtest_passed: { "2_4": true, "5_plus": true }, mf5_requires_noi_corroboration: false });
    const plan = buildNegotiationPlan(ctx);
    counters.plans += 1;
    const oa = ctx.offer_authority;
    // NEVER BLANK: numbers whenever the authority supplies a ceiling and an offer (R ≤ C).
    const supplied = oa
      ? oa.ceiling != null && oa.offer != null && oa.offer <= oa.ceiling
      : ctx.ade_snapshot != null && !["no_ceiling", "no_offer"].includes(ctx._corrupt);
    assert.equal(plan.ok, supplied, `never blank (${ctx._corrupt || "d"})`);
    if (plan.ok) {
      counters.ok_plans += 1;
      assert.ok(plan.autonomous_limit < plan.ceiling, "AL strictly below ceiling");
      assert.ok(plan.target <= plan.autonomous_limit);
      assert.ok(plan.ladder_anchor <= plan.target);
      if (plan.anchor_floor != null && plan.anchor_floor <= plan.target) assert.ok(plan.ladder_anchor >= plan.anchor_floor, "anchor ≥ investor floor");
      if (oa?.investor_price) assert.equal(plan.anchor_floor, Math.ceil((oa.investor_price * 0.75) / (oa.investor_price * 0.75 >= 100_000 ? 1000 : 500)) * (oa.investor_price * 0.75 >= 100_000 ? 1000 : 500));
      if (plan.opening_anchor != null && plan.seller_ask != null) assert.ok(plan.opening_anchor < plan.seller_ask);
      const lad = plan.ladder.map((x) => x.amount);
      for (let k = 1; k < lad.length; k += 1) assert.ok(lad[k] >= lad[k - 1], "ladder monotone");
      assert.equal(lad[lad.length - 1], plan.autonomous_limit, "final rung = autonomous limit");
      if (plan.per_unit) assert.ok(Number.isInteger(plan.per_unit.units) && plan.per_unit.units >= 2);
      if (oa && oa.authorized && oa.fresh && plan.autonomy.eligible) {
        assert.ok(oa.confidence_grade == null || GRADES.includes(oa.confidence_grade), "grade gate");
        assert.ok(oa.fallback_rung == null || oa.fallback_rung === 0, "nearest ring only");
        assert.notEqual(oa.fallback_geography, true, "no fallback geography");
      }
      if (oa && (!GRADES.includes(oa.confidence_grade) && oa.confidence_grade != null)) assert.equal(plan.autonomy.eligible, false, "low grade never autonomous");
    } else {
      assert.equal(plan.ceiling, null);
      assert.equal(plan.ladder.length, 0);
    }
    if (ctx._corrupt) assert.equal(plan.autonomy.eligible, false, `corruption ${ctx._corrupt} must deny autonomy`);
    for (const { move } of simulate(r, plan)) {
      counters.moves += 1;
      if (move.amount != null) assert.ok(plan.ok && move.amount <= plan.ceiling, "never above ceiling");
      if (move.proposal?.amount != null) assert.ok(plan.ceiling == null || move.proposal.amount <= plan.ceiling, "proposal never above ceiling");
      if (move.action === A.QUOTE) {
        counters.quotes += 1;
        assert.ok(plan.ok && plan.authority.authorized && plan.autonomy.eligible, "no money without authority + grade");
        assert.ok(move.amount <= plan.autonomous_limit, "never above AL without HUMAN");
        if (plan.anchor_floor != null) assert.ok(move.amount >= plan.anchor_floor, "never below investor floor");
        assert.equal(move.requires_log, true);
        assert.ok([Q.NEGOTIATION_ANCHOR, Q.CONCESSION, Q.FORMAL_OFFER].includes(move.quote_type));
        // Disclosure (owner 10-07): position-only by default; comps only on pushback, ≤ our number, verifiable.
        const check = validateSellerFacing({ text: move.reply.text_en, branch: move.reply.branch, claims: move.reply.claims, quoted_amount: move.reply.quoted_amount, quoted_per_unit: move.reply.quoted_per_unit, plan });
        assert.ok(check.ok, check.violations.join(","));
        if (move.reply.branch === "comps_support") {
          counters.comp_lang += 1;
          assert.equal(move.rule_branch, "pushback_restate_position", "comp claims only in the pushback branch");
          assert.ok(move.reply.claims[0].figure <= (move.reply.quoted_per_unit ?? move.amount));
        } else assert.ok(["position", "position_per_unit"].includes(move.reply.branch));
        if (plan.asset === "multifamily") {
          counters.mf_quotes += 1;
          assert.ok(move.per_unit && move.per_unit.units === plan.per_unit.units && move.per_unit.door * move.per_unit.units <= move.amount);
          assert.equal(move.per_unit.band_low, undefined, "investor band never seller-facing");
        } else assert.equal(move.per_unit, null, "no unit math on SFR");
      } else {
        assert.equal(move.amount, null, "only QUOTE carries an amount");
      }
      if (move.action === A.HUMAN) counters.human += 1;
      if (move.action === A.CLOSE_UNREALISTIC) counters.closes += 1;
    }
  }
  assert.ok(counters.quotes > 300 && counters.ok_plans > 1000, JSON.stringify(counters));
  console.log("[nv3 property]", JSON.stringify(counters));
});

test("property: our numbers never go down; anchor below the ask; non-uniform concessions", () => {
  const r = rng(7);
  let sequences = 0;
  let nonUniform = 0;
  for (let i = 0; i < N_PLANS; i += 1) {
    const plan = buildNegotiationPlan({ ...genCtx(r, { mf: false, corrupt: null, d: false }), config: { autonomy: { ungraded: "authorized_only" } } });
    if (!plan.ok) continue;
    const moves = simulate(r, plan);
    const ours = moves.filter((m) => m.move.action === A.QUOTE && m.move.quote_type !== Q.FORMAL_OFFER && m.move.rule_branch !== "pushback_restate_position").map((m) => m.move.amount);
    for (let k = 1; k < ours.length; k += 1) assert.ok(ours[k] > ours[k - 1], "monotone LC positions");
    const first = moves.find((m) => m.move.quote_type === Q.NEGOTIATION_ANCHOR);
    if (first?.event.amount != null) assert.ok(first.move.amount < first.event.amount, "anchor below the ask");
    if (ours.length >= 3) {
      sequences += 1;
      const d = ours.slice(1).map((v, k) => v - ours[k]);
      if (new Set(d).size > 1) nonUniform += 1;
    }
    const lad = plan.ladder.map((x) => x.delta).filter((x) => x != null);
    if (plan.autonomous_limit - plan.ladder_anchor >= 20_000) assert.ok(lad[0] > lad[lad.length - 1], "planned rungs decrease");
  }
  assert.ok(sequences > 50 && nonUniform / sequences > 0.8, `${nonUniform}/${sequences}`);
});

test("property: pressure / situation never moves ceiling, target, autonomous limit or floor (§57)", () => {
  const r = rng(99);
  for (let i = 0; i < N_PLANS; i += 1) {
    const ctx = genCtx(r, { corrupt: null });
    const a = buildNegotiationPlan({ ...ctx, situation: null, market: null });
    const b = buildNegotiationPlan({ ...ctx, situation: genSituation(r) || { components: { forced_sale_pressure: 100, tax_pain: 100 } }, market: { buyer_depth: "weak" } });
    for (const k of ["ok", "ceiling", "target", "autonomous_limit", "anchor_floor"]) assert.equal(b[k], a[k], k);
    assert.equal(b.autonomy.eligible, a.autonomy.eligible, "pressure never changes autonomy");
  }
});

test("property: AUTONOMOUS_MONETARY_QUOTES off ⇒ zero QUOTE moves, money becomes HUMAN proposals", () => {
  const r = rng(3);
  let proposals = 0;
  for (let i = 0; i < Math.floor(N_PLANS / 2); i += 1) {
    const env = pick(r, [{}, { NEGOTIATION_ENGINE_V3: "true" }, { AUTONOMOUS_MONETARY_QUOTES: "true" }]);
    const plan = buildNegotiationPlan(genCtx(r, { env }));
    for (const { move } of simulate(r, plan)) {
      assert.notEqual(move.action, A.QUOTE);
      if (move.proposal?.amount != null) proposals += 1;
    }
  }
  assert.ok(proposals > 100);
});

test("property: no unit math without a valid unit count", () => {
  const r = rng(54);
  for (let i = 0; i < N_PLANS; i += 1) {
    const ctx = genCtx(r, { mf: true, corrupt: null, d: false });
    ctx.config = { lanes: { mf24: { enabled: true }, mf5: { enabled: true } }, lane_backtest_passed: { "2_4": true, "5_plus": true }, mf5_requires_noi_corroboration: false };
    const plan = buildNegotiationPlan(ctx);
    const u = [ctx.property.units_count, ctx.ade_snapshot.evidence.subject.normalized_features.units].filter((x) => x != null);
    const valid = u.length > 0 && u.every((x) => Number.isInteger(x) && x >= 2) && new Set(u).size === 1;
    if (!valid) {
      assert.equal(plan.per_unit, null);
      assert.equal(plan.autonomy.eligible, false);
      const m = nextNegotiationMove(plan, {}, { kind: "price", per_unit: 70_000 });
      assert.equal(m.amount, null);
      assert.equal(m.per_unit, null);
    }
  }
});

test("property: logged BEFORE send, and a logging failure blocks the send", async () => {
  const r = rng(11);
  let checked = 0;
  for (let i = 0; i < 1500; i += 1) {
    const plan = buildNegotiationPlan({ ...genCtx(r, { mf: false, corrupt: null, d: false }), config: { autonomy: { ungraded: "authorized_only" } } });
    if (!plan.ok) continue;
    const move = nextNegotiationMove(plan, {}, { kind: "price", amount: plan.target + 25_000 });
    if (!(move.action === A.QUOTE || move.quote_type === Q.NO_NUMBER)) continue;
    const ids = { thread_key: `t${i}`, inbound_message_event_id: `e${i}`, language: "English", template_id: "tpl_1" };
    const order = [];
    const fail = r() < 0.5;
    const record = async (_sb, row) => {
      order.push(["log", row.amount]);
      return fail ? { ok: false, reason: "negotiation_quote_write_failed:42P01" } : { ok: true, row };
    };
    const send = async () => order.push(["send"]);
    const res = await logQuoteThenSend({ supabase: {}, plan, move, ids, send, record });
    if (fail) {
      assert.equal(res.sent, false);
      assert.equal(res.blocked, "quote_log_failed");
      assert.deepEqual(order.map((o) => o[0]), ["log"]);
    } else {
      assert.equal(res.sent, true);
      assert.deepEqual(order.map((o) => o[0]), ["log", "send"]);
    }
    checked += 1;
  }
  // A thrown client is also a failure, never a send.
  const plan = buildNegotiationPlan(genCtx(rng(1), { mf: false, corrupt: null, d: false }));
  const res = await logQuoteThenSend({ supabase: null, plan, move: { requires_log: true, quote_type: Q.NO_NUMBER, rule_branch: "x" }, ids: { thread_key: "t" }, send: () => assert.fail("sent") });
  assert.equal(res.sent, false);
  assert.ok(checked > 300);
});

test("log row: refuses money above AL / without template / without authority; anchor ≠ formal offer", () => {
  const plan = buildNegotiationPlan(illustrative({ ask: 245_000 }));
  const ids = { thread_key: "t", inbound_message_event_id: "e", language: "English", template_id: "tpl" };
  const mk = (amount, quote_type = Q.NEGOTIATION_ANCHOR) => {
    const m = { action: A.QUOTE, amount, quote_type, rule_branch: "r", requires_log: true, language_branch: "position" };
    return { ...m, reply: sellerFacingReply(plan, m) };
  };
  assert.throws(() => buildQuoteLogRow(plan, mk(plan.autonomous_limit + 1000), ids), /above_autonomous_limit/);
  assert.throws(() => buildQuoteLogRow(plan, mk(200_000), { thread_key: "t" }), /template_and_language/);
  assert.throws(() => buildQuoteLogRow({ ...plan, ok: false }, mk(200_000), ids), /without_authority/);
  const anchor = buildQuoteLogRow(plan, mk(213_000), ids);
  const offer = buildQuoteLogRow(plan, mk(220_000, Q.FORMAL_OFFER), ids);
  assert.equal(anchor.quote_type, "anchor");
  assert.equal(offer.quote_type, "formal_offer");
  for (const k of ["target_at_quote", "autonomous_limit_at_quote", "max_offer_at_quote", "engine_version", "rule_branch", "language", "template_id"]) assert.ok(anchor[k] != null, k);
  const s = summarizeNegotiationQuotes([{ ...anchor, quoted_at: "2026-10-07T01:00:00Z" }, { ...offer, quoted_at: "2026-10-07T02:00:00Z" }]);
  assert.equal(s.anchors.length, 1);
  assert.equal(s.formal_offers.length, 1);
  assert.equal(s.current_position.type, "formal_offer");
});

// ── illustrative §45 case: ceiling 260 / target 225 ─────────────────────────
function illustrative({ ask = 245_000, situation = null, condition = "dated" } = {}) {
  return {
    authority: {
      source: "test_authority",
      engine_version: "t",
      ok: true,
      fresh: true,
      ceiling: 260_000,
      recommended: 225_000,
      valuation_mid: 400_000,
      estimated_repairs: 0,
      comps: [],
      asset_type: "single_family",
    },
    property: { property_type: "Single Family" },
    seller: { asking_price: ask, condition },
    situation,
    now: NOW,
    env: ON,
    config: { autonomy: { ungraded: "authorized_only" } },
  };
}

test("§45: C 260 / T 225 / ask 245 ⇒ anchor 210–220; ask 350 ⇒ a stronger anchor", () => {
  const p245 = buildNegotiationPlan(illustrative({ ask: 245_000 }));
  assert.equal(p245.target, 225_000);
  assert.equal(p245.autonomous_limit, 242_000);
  assert.ok(p245.opening_anchor >= 210_000 && p245.opening_anchor <= 220_000, String(p245.opening_anchor));
  const p350 = buildNegotiationPlan(illustrative({ ask: 350_000 }));
  assert.ok(p350.opening_anchor < p245.opening_anchor);
  assert.ok(p350.opening_anchor > 170_000, "never the destructive 170 opener");
  // ask 245 sits above AL 242 and below C 260 ⇒ concessions to 242, then HUMAN.
  const state = { lc_positions: [p245.opening_anchor], seller_positions: [245_000] };
  let m = nextNegotiationMove(p245, state, { kind: "counter", amount: 244_000 });
  assert.equal(m.action, A.QUOTE);
  state.lc_positions.push(m.amount);
  for (let i = 0; i < 4 && m.action === A.QUOTE; i += 1) {
    m = nextNegotiationMove(p245, state, { kind: "counter", amount: 243_500 - i * 100 });
    if (m.action === A.QUOTE) state.lc_positions.push(m.amount);
  }
  assert.ok(Math.max(...state.lc_positions) <= 242_000);
  const last = nextNegotiationMove(p245, { lc_positions: [242_000], seller_positions: [244_000] }, { kind: "counter", amount: 243_000 });
  assert.equal(last.action, A.HUMAN);
  assert.equal(last.rule_branch, "above_autonomous_limit_needs_approval");
});

test("§58: $1M ask on a ~$300K house closes politely, no number; new evidence ⇒ human", () => {
  const ctx = illustrative({ ask: 1_000_000 });
  ctx.authority.valuation_mid = 300_000;
  ctx.authority.ceiling = 200_000;
  ctx.authority.recommended = 180_000;
  const plan = buildNegotiationPlan(ctx);
  const m = nextNegotiationMove(plan, {}, { kind: "price", amount: 1_000_000 });
  assert.equal(m.action, A.CLOSE_UNREALISTIC);
  assert.equal(m.amount, null);
  assert.equal(nextNegotiationMove(plan, {}, { kind: "price", amount: 1_000_000, new_value_evidence: true }).action, A.HUMAN);
});

test("§55: capital gains ⇒ approved creative probe, no number; terms ⇒ human", () => {
  const plan = buildNegotiationPlan(illustrative({}));
  const m = nextNegotiationMove(plan, {}, { kind: "capital_gains" });
  assert.equal(m.action, A.NO_NUMBER);
  assert.equal(m.language_branch, "creative");
  assert.equal(nextNegotiationMove(plan, {}, { kind: "creative_terms" }).action, A.HUMAN);
  // A creative angle without supporting evidence is dropped.
  const p = buildNegotiationPlan(illustrative({ situation: { seller_situation: "FATIGUED_LANDLORD", conversation_angle: "SELLER_FINANCE", components: {} } }));
  assert.equal(p.strategy.creative_probe, false);
});

test("D's merged-engine authority must be ok AND fresh with a ceiling", () => {
  assert.equal(normalizeAuthority({ ok: true, fresh: false, ceiling: 1, recommended: 1, valuation_mid: 2 }).ok, false);
  assert.equal(normalizeAuthority({ ok: true, fresh: true, recommended: 864_000, valuation_mid: 1_080_000 }).ok, false); // v3.1 Conway shape: no ceiling
  assert.equal(normalizeAuthority({ ok: true, fresh: true, ceiling: 300, recommended: 400, valuation_mid: 500 }).ok, false); // R > C
});

// ── golden cases ─────────────────────────────────────────────────────────────
// rows: prod property_acquisition_scores (read-only extract 2026-10-07), read through
// agent D's authoritativeOfferFromScore (the ONE money interface).
// d_merged: agent D's merged-engine SHADOW output mapped to CONTRACT_offer_authority
// (D does not emit confidence_grade / fallback_rung yet — tests set them explicitly).
const goldenFile = JSON.parse(readFileSync(new URL("../fixtures/negotiation-v3-golden.json", import.meta.url), "utf8"));
const golden = goldenFile.rows;
const dMerged = goldenFile.d_merged;
const viaD = (row) => authoritativeOfferFromScore(row, { now: NOW, env: {} });

test("golden 1311 Conway 274574569 (MF 5+, 11 doors; owner offered $825K): real per-door plan, ~$78.5K/door target", () => {
  const property = { property_type: "Multi-Family", units_count: 11 };
  const plan = buildNegotiationPlan({ offer_authority: dMerged["274574569"], property, seller: { condition: "dated" }, now: NOW, env: ON });
  assert.equal(plan.ok, true, "never blank");
  assert.equal(plan.lane, "mf5");
  assert.equal(plan.ceiling, 919_242);
  assert.equal(plan.target, 864_000);
  assert.ok(plan.per_unit.target >= 75_000 && plan.per_unit.target <= 80_000, String(plan.per_unit.target));
  assert.equal(plan.autonomous_limit, 891_000); // $81K/door
  assert.equal(plan.anchor_floor, 808_000); // investor $1,076,900 × 0.75
  assert.deepEqual([plan.per_unit.band_low, plan.per_unit.band_high], [93_000, 103_000]);
  // D shadow (not authorized) + MF lane ⇒ numbers for the operator, HUMAN proposal; anchor $829K ≈ the owner's $825K.
  const m = nextNegotiationMove(plan, {}, { kind: "make_offer" });
  assert.equal(m.action, A.HUMAN);
  assert.equal(m.proposal.amount, 829_000);
  assert.deepEqual(m.proposal.per_unit, { units: 11, door: 75_000 });
  // Disclosure (owner 10-07): position-only — the $93–103K investor band is NEVER volunteered.
  assert.equal(m.proposal.reply.branch, "position_per_unit");
  assert.equal(m.proposal.reply.text_en, "Based on the building, the condition and the numbers, we'd need to be around $75K a unit to make it work.");
  assert.ok(!/93|103/.test(m.proposal.reply.text_en));
  assert.ok(m.proposal.reply.claims.length === 0);
  assert.equal(plan.anchor_floor_policy.discount, 0.25);
  assert.equal(plan.anchor_floor_policy.basis, "default_temporary");
  // If D authorizes it at grade A AND the owner opens the MF 5+ lane: an autonomous per-door anchor.
  const open = buildNegotiationPlan({ offer_authority: { ...dMerged["274574569"], authorized: true, confidence_grade: "A", fallback_rung: 0 }, property, seller: { condition: "dated" }, now: NOW, env: ON, config: { lanes: { mf24: { enabled: true }, mf5: { enabled: true } }, lane_backtest_passed: { "2_4": true, "5_plus": true }, mf5_requires_noi_corroboration: false } });
  const q = nextNegotiationMove(open, {}, { kind: "make_offer" });
  assert.equal(q.action, A.QUOTE);
  assert.equal(q.per_unit.door, 75_000);
  // Through today's prod row the engine is v2: numbers still shown ($211.8K = $19.3K/door), never autonomous.
  const v2 = buildNegotiationPlan({ offer_authority: viaD(golden["274574569"]), property, seller: { condition: "dated" }, now: NOW, env: ON });
  assert.equal(v2.ok, true);
  assert.equal(v2.ceiling, 211_800);
  assert.equal(v2.autonomy.eligible, false);
});

test("golden 627 Ontario 273586189 (MF label, units = 1): numbers shown, low grade / conflict ⇒ no autonomous quote", () => {
  const property = { property_type: "Multi-Family", units_count: 1 };
  const plan = buildNegotiationPlan({ offer_authority: viaD(golden["273586189"]), property, seller: { asking_price: 300_000, condition: "ok" }, now: NOW, env: ON });
  assert.equal(plan.ok, true, "never blank");
  assert.equal(plan.ceiling, 27_300);
  assert.equal(plan.per_unit, null, "no per-unit math on 1 unit");
  assert.equal(plan.autonomy.eligible, false);
  // D resolving the lane, with a low grade: still numbers, still no autonomous quote.
  for (const lane of ["sfr", "mf24"]) {
    const p = buildNegotiationPlan({ offer_authority: { ...viaD(golden["273586189"]), lane, confidence_grade: "D", fallback_rung: 3 }, property, seller: { asking_price: 300_000, condition: "ok" }, now: NOW, env: ON });
    assert.equal(p.ok, true);
    assert.ok(p.autonomy.reasons.includes("grade_D_review"));
    const m = nextNegotiationMove(p, {}, { kind: "price", amount: 300_000 });
    assert.notEqual(m.action, A.QUOTE);
    assert.equal(m.amount, null);
  }
});

test("golden Phoenix-area 18-unit 25943678: prod v2 has no ceiling ⇒ the only no-numbers case; never money", () => {
  const plan = buildNegotiationPlan({ offer_authority: viaD(golden["25943678"]), property: { property_type: "Multi-Family", units_count: 18 }, seller: { asking_price: 2_000_000, condition: "ok" }, now: NOW, env: ON });
  assert.equal(plan.ok, false); // D's never-blank fallback will supply numbers here; until then nothing to show
  const m = nextNegotiationMove(plan, {}, { kind: "price", amount: 2_000_000 });
  assert.equal(m.action, A.HUMAN);
  assert.equal(m.amount, null);
});

test("golden Houston SFR 2131325199 (prod v2 AUTO_HARD_OFFER): no value−repairs floor; bounded plan, no comp claim", () => {
  const row = golden["2131325199"];
  assert.equal(isOfferReady(row, { now: NOW }).ready, true);
  const ctx = { offer_authority: viaD(row), property: { property_type: "Single Family" }, seller: { asking_price: 95_000, condition: "dated" }, now: NOW, env: ON };
  const plan = buildNegotiationPlan(ctx);
  assert.equal(plan.ok, true);
  assert.deepEqual([plan.ceiling, plan.autonomous_limit, plan.target, plan.anchor_floor], [69_400, 61_000, 53_000, null]);
  const m = nextNegotiationMove(plan, {}, { kind: "price", amount: 95_000 });
  assert.equal(m.action, A.HUMAN); // ungraded v2 row ⇒ proposal / review (owner ladder 10-07)
  assert.equal(m.proposal.amount, 47_500);
  assert.equal(m.proposal.reply.text_en, "Based on the condition and the numbers, we'd need to be around $47,500 to make it work.");
  const legacy = buildNegotiationPlan({ ...ctx, config: { autonomy: { ungraded: "authorized_only" } } });
  assert.equal(nextNegotiationMove(legacy, {}, { kind: "price", amount: 95_000 }).action, A.QUOTE);
  assert.deepEqual(plan.ladder.map((x) => x.amount), [47_500, 53_500, 57_500, 61_000]);
  assert.equal(nextNegotiationMove(buildNegotiationPlan({ ...ctx, env: {}, config: { autonomy: { ungraded: "authorized_only" } } }), {}, { kind: "price", amount: 95_000 }).action, A.HUMAN); // flags default OFF
});

test("golden Houston SFR 2130847744 (D merged shadow): investor floor binds; grade A + nearest ring autonomous, B / D / fallback geography review", () => {
  const ctx = { property: { property_type: "Single Family" }, seller: { asking_price: 230_000, condition: "dated" }, now: NOW, env: ON };
  const base = buildNegotiationPlan({ ...ctx, offer_authority: dMerged["2130847744"] });
  assert.deepEqual([base.ceiling, base.target, base.autonomous_limit, base.anchor_floor, base.opening_anchor], [186_244, 167_000, 176_000, 157_000, 157_000]);
  assert.equal(nextNegotiationMove(base, {}, { kind: "price", amount: 230_000 }).action, A.HUMAN); // shadow: not authorized
  const a = buildNegotiationPlan({ ...ctx, offer_authority: { ...dMerged["2130847744"], authorized: true, confidence_grade: "A", fallback_rung: 0 } });
  assert.equal(nextNegotiationMove(a, {}, { kind: "price", amount: 230_000 }).amount, 157_000);
  const b = buildNegotiationPlan({ ...ctx, offer_authority: { ...dMerged["2130847744"], authorized: true, confidence_grade: "B", fallback_rung: 0 } });
  const mb = nextNegotiationMove(b, {}, { kind: "price", amount: 230_000 });
  assert.equal(mb.action, A.HUMAN);
  assert.equal(mb.proposal.reply.text_en, "Based on the condition and the numbers, we'd need to be around $157K to make it work."); // pre-populated
  const fg = buildNegotiationPlan({ ...ctx, offer_authority: { ...dMerged["2130847744"], authorized: true, confidence_grade: "A", fallback_rung: 0, fallback_geography: true } });
  assert.ok(fg.autonomy.reasons.includes("fallback_geography_review"));
  const market = buildNegotiationPlan({ ...ctx, property: { property_type: "Single Family", market: "Houston, TX" }, offer_authority: dMerged["2130847744"], config: { anchor_floor: { by_market_lane: { "Houston, TX|sfr": 0.15 } } } });
  assert.deepEqual([market.anchor_floor_policy.discount, market.anchor_floor_policy.basis, market.anchor_floor], [0.15, "market_lane", 178_000]);
  const d = buildNegotiationPlan({ ...ctx, offer_authority: { ...dMerged["2130847744"], authorized: true, confidence_grade: "D", fallback_rung: 3 } });
  assert.equal(d.ok, true);
  assert.equal(d.target, 167_000, "same numbers at a low grade");
  const md = nextNegotiationMove(d, {}, { kind: "price", amount: 230_000 });
  assert.equal(md.action, A.HUMAN);
  assert.equal(md.proposal.amount, 157_000);
});

test("planLadder: shares 0.45/0.30/0.25, ends at AL, empty when anchor > AL", () => {
  assert.deepEqual(planLadder({ anchor: 200_000, autonomous_limit: 240_000 }).map((x) => x.amount), [200_000, 218_000, 230_000, 240_000]);
  assert.deepEqual(planLadder({ anchor: 250_000, autonomous_limit: 240_000 }), []);
});

test("property: disclosure — comps only on pushback, only truthful + supportive, never a figure above our number", () => {
  const r = rng(404);
  let comps = 0;
  let positionOnPushback = 0;
  for (let i = 0; i < N_PLANS; i += 1) {
    const ctx = { ...genCtx(r, { mf: false, corrupt: null, d: false }), config: { autonomy: { ungraded: "authorized_only" } } };
    const plan0 = buildNegotiationPlan(ctx);
    if (!plan0.ok) continue;
    const below = r() < 0.5; // comps mostly at/below our number vs mostly above it
    ctx.ade_snapshot.evidence.selected_comps = Array.from({ length: Math.floor(uni(r, 0, 7)) }, (_, k) => ({
      comp_id: `n${k}`,
      sale_price: round100(plan0.ladder_anchor * (below ? uni(r, 0.7, 1.02) : uni(r, 0.95, 1.8))),
      distance_miles: uni(r, 0, 1.4),
      sale_date: new Date(NOW - uni(r, 0, 420) * 86_400_000).toISOString().slice(0, 10),
      source: pick(r, ["public_record_sold", "mls_sold", "bulk_portfolio"]),
    }));
    const plan = buildNegotiationPlan(ctx);
    const state = { lc_positions: [plan.ladder_anchor], seller_positions: [] };
    for (const kind of ["pushback", "counter", "price"]) {
      const m = nextNegotiationMove(plan, state, { kind, amount: kind === "pushback" ? null : round100(plan.target * 1.3) });
      const reply = m.reply || m.proposal?.reply;
      if (!reply) continue;
      const check = validateSellerFacing({ text: reply.text_en, branch: reply.branch, claims: reply.claims, quoted_amount: reply.quoted_amount, quoted_per_unit: reply.quoted_per_unit, plan });
      assert.ok(check.ok, check.violations.join(","));
      if (reply.branch === "comps_support") {
        comps += 1;
        assert.equal(kind, "pushback", "comp claims only in the pushback branch");
        const used = ctx.ade_snapshot.evidence.selected_comps.filter((c) => reply.claims[0].evidence_ids.includes(c.comp_id));
        assert.ok(used.length >= 2);
        for (const c of used) assert.ok(c.sale_price <= reply.quoted_amount && c.distance_miles <= 1.0 && !/bulk|portfolio/.test(c.source), "cited comps are real, nearby, at or below our number");
        // Not cherry-picked: the median of ALL qualifying comps is at or below our number.
        const pool = plan.screened_comps.map((c) => c.sale_price).sort((x, y) => x - y);
        assert.ok(pool[Math.floor((pool.length - 1) / 2)] <= reply.quoted_amount);
      } else if (kind === "pushback") positionOnPushback += 1;
    }
  }
  assert.ok(comps > 100 && positionOnPushback > 100, `${comps}/${positionOnPushback}`);
});

test("disclosure validator: rejects bands above our number, market talk outside pushback, unverifiable claims", () => {
  const plan = buildNegotiationPlan({ offer_authority: dMerged["274574569"], property: { property_type: "Multi-Family", units_count: 11 }, seller: { condition: "dated" }, now: NOW, env: ON });
  const base = { branch: "position_per_unit", claims: [], quoted_amount: 829_000, quoted_per_unit: 75_000, plan };
  assert.equal(validateSellerFacing({ ...base, text: "Based on the building, the condition and the numbers, we'd need to be around $75K a unit to make it work." }).ok, true);
  const leak = validateSellerFacing({ ...base, text: "Similar buildings are trading around $93K–$103K a door; we'd likely be around $75K a door." });
  assert.equal(leak.ok, false);
  assert.ok(leak.violations.some((v) => /above_quoted/.test(v)) && leak.violations.includes("market_language_outside_pushback_branch"));
  assert.equal(validateSellerFacing({ ...base, text: "Nearby sales support $70K a unit." }).ok, false); // market talk outside pushback
  assert.ok(validateSellerFacing({ ...base, claims: [{ figure: 70_000, evidence_ids: ["x"], evidence_prices: [70_000] }], text: "we'd need $75K a unit" }).violations.includes("comp_claim_outside_pushback_branch"));
  const fake = validateSellerFacing({ ...base, branch: "comps_support", claims: [{ figure: 70_000, evidence_ids: ["not-a-real-comp"], evidence_prices: [70_000] }], text: "comparable buildings nearby recently sold around $70K a unit" });
  assert.ok(fake.violations.includes("claim_evidence_not_verifiable"));
  // The plan knows the band (operator), the seller-facing reply never carries it.
  assert.equal(plan.per_unit.band_low, 93_000);
  assert.equal(supportiveComps(plan, 829_000).allowed, false);
});

test("Deal Intelligence desk view (§82): numbers + grade + why always; autonomy shown separately", async () => {
  const { buildNegotiationDeskView } = await import("../../src/lib/domain/negotiation-v3/view.js");
  const v = buildNegotiationDeskView({ ade_snapshot: golden["2131325199"], property: { property_type: "Single Family" }, seller: { asking_price: 95_000, condition: "dated" }, quotes: [{ quote_type: "anchor", amount: 47_500, quoted_at: "2026-10-07T01:00:00Z", rule_branch: "opening_anchor_vs_ask" }], now: NOW, env: {} });
  assert.equal(v.status, "operator_approval"); // ungraded prod row ⇒ review
  assert.equal(v.nextMove.reply.branch, "position");
  assert.deepEqual([v.ask, v.anchor, v.currentPosition.amount, v.target, v.autonomousLimit, v.ceiling], [95_000, 47_500, 47_500, 53_000, 61_000, 69_400]);
  assert.equal(v.nextMove.action, "HUMAN"); // flags off ⇒ proposal only
  assert.ok(v.why.length >= 5);
  const conway = buildNegotiationDeskView({ offer_authority: dMerged["274574569"], property: { property_type: "Multi-Family", units_count: 11 }, seller: { asking_price: 900_000, condition: "dated" }, quotes: null, now: NOW, env: {} });
  assert.equal(conway.status, "operator_approval");
  assert.equal(conway.target, 864_000);
  assert.equal(conway.perUnit.band_low, 93_000);
  assert.equal(conway.quotesCaptured, false);
  assert.ok(conway.autonomy.reasons.includes("lane_mf5_closed"));
});

test("quote log row columns ⊆ PROPOSED negotiation_quotes columns (no phantom column)", () => {
  const sql = ["PROPOSED_20261006120000_negotiation_quotes.sql", "PROPOSED_20261007042000_negotiation_quotes_observed_offer.sql", "PROPOSED_20261007060000_negotiation_quotes_v3.sql"]
    .map((f) => readFileSync(new URL(`../../../../supabase/migrations/${f}`, import.meta.url), "utf8"))
    .join("\n");
  const plan = buildNegotiationPlan(illustrative({ ask: 245_000 }));
  const mv = { action: A.QUOTE, amount: 213_000, quote_type: Q.NEGOTIATION_ANCHOR, rule_branch: "r", requires_log: true, per_unit: null, language_branch: "position" };
  const row = buildQuoteLogRow(plan, { ...mv, reply: sellerFacingReply(plan, mv) }, { thread_key: "t", language: "English", template_id: "tpl" });
  for (const col of Object.keys(row)) assert.ok(new RegExp(`\\b${col}\\b\\s+(text|numeric|integer|jsonb|uuid|timestamptz)`).test(sql), `column ${col} missing from PROPOSED SQL`);
});

test("disclosure blocks the send: a rendered text leaking a figure above our number never logs or sends", async () => {
  const plan = buildNegotiationPlan(illustrative({ ask: 245_000 }));
  const move = nextNegotiationMove(plan, {}, { kind: "price", amount: 245_000 });
  assert.equal(move.action, A.QUOTE);
  const ids = { thread_key: "t", inbound_message_event_id: "e", language: "English", template_id: "tpl", rendered_text: "Homes nearby sell for $260K, but we'd need to be around $213K." };
  const res = await logQuoteThenSend({ supabase: {}, plan, move, ids, send: () => assert.fail("sent"), record: async () => assert.fail("logged") });
  assert.equal(res.sent, false);
  assert.match(res.reason, /disclosure_violation/);
});
