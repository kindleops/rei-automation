// ─── negotiation-shadow-eval.mjs ─────────────────────────────────────────────
// Spec §19 — production shadow evaluation of the S3–S6 negotiation loop.
//
// Replays REAL seller inbound messages (pulled verbatim from production
// message_events on 2026-07-02) through the exact production decision path:
// classify → resolveAskingPriceSignal → resolveSellerStageTransition →
// resolveNegotiationTurn (zone + sufficiency + strategy router + reducer) →
// template-render safety.
//
// NOTHING IS SENT. No database writes. Pure evaluation with a fixed ADE
// authority fixture per case, comparing expected vs actual stage, strategy,
// offer authority, next action, and rendered-reply monetary safety.
//
// Run: npm run proof:negotiation-shadow

import { classify } from "@/lib/domain/classification/classify.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { resolveNegotiationTurn } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { personalizeTemplate } from "@/lib/sms/personalize_template.js";
import { LOCAL_TEMPLATE_CANDIDATES } from "@/lib/domain/templates/local-template-registry.js";

const ADE_MID = Object.freeze({
  recommended_cash_offer: 180000,
  minimum_acceptable_offer: 160000,
  investor_ceiling_mid: 205000,
  investor_ceiling_high: 215000,
  valuation_mid: 290000,
  valuation_confidence: 0.78,
  estimated_repairs: 35000,
  comp_count: 6,
  seller_finance_score: 68,
  novation_score: 55,
  subject_to_score: 25,
});

const ADE_SMALL = Object.freeze({
  ...ADE_MID,
  recommended_cash_offer: 95000,
  minimum_acceptable_offer: 85000,
  investor_ceiling_mid: 110000,
  investor_ceiling_high: 118000,
  valuation_mid: 150000,
  estimated_repairs: 18000,
});

// Every message below is a verbatim production seller reply (2026-07-01/02).
const CASES = [
  {
    name: "fast price reply — favorable ask under authority",
    message: "Yes $250k",
    stage_before: "offer_interest",
    ade: { ...ADE_MID, recommended_cash_offer: 240000, investor_ceiling_mid: 260000, investor_ceiling_high: 270000 },
    known_facts: { ownership_status: "confirmed" },
    expect: {
      price_captured: 250000,
      zone: "within_authority",
      strategy: "accept_seller_terms",
      monetary_at_most: 250000,
      stage_at_least: 5,
    },
  },
  {
    name: "fast price reply — near gap",
    message: "I do. 430k cash offer",
    stage_before: "offer_interest",
    ade: { ...ADE_MID, recommended_cash_offer: 380000, investor_ceiling_mid: 400000, investor_ceiling_high: 415000, valuation_mid: 520000 },
    known_facts: { ownership_status: "confirmed", occupancy_status: "vacant", condition_disclosed: true },
    expect: {
      price_captured: 430000,
      // High-value band tightens the near factor (430k/400k = 1.075 > 1.06),
      // so this ask deterministically lands moderate → justified offer.
      zone: "moderate_gap",
      strategy: "conditional_offer",
      monetary_at_most: 400000,
      stage_at_least: 4,
    },
  },
  {
    name: "unrealistic ask — extreme gap, no endless lowballs",
    message: "Yes, I am and I will sell it for 1,500,000 cash no negotiations",
    stage_before: "ownership_confirmation",
    ade: ADE_MID,
    known_facts: {},
    expect: {
      price_captured: 1500000,
      zone: "large_gap",
      strategy_in: ["expectation_reset", "future_nurture", "human_review"],
      no_monetary: true,
    },
  },
  {
    name: "unrealistic ask with hostility deadline",
    message: "350k ! otherwise lose my number",
    stage_before: "asking_price",
    ade: ADE_SMALL,
    known_facts: { ownership_status: "confirmed" },
    expect: {
      price_captured: 350000,
      zone: "large_gap",
      strategy_in: ["expectation_reset", "future_nurture", "human_review"],
      no_monetary: true,
    },
  },
  {
    name: "price + condition + occupancy in one reply (duplex, tenants)",
    message: "400,000. It's a duplex with two Rental sides. With renters in.",
    stage_before: "offer_interest",
    ade: { ...ADE_MID, recommended_cash_offer: 350000, investor_ceiling_mid: 380000, investor_ceiling_high: 395000, valuation_mid: 470000 },
    known_facts: { ownership_status: "confirmed" },
    unit_count: 2,
    expect: {
      price_captured: 400000,
      zone: "near_gap",
      stage_at_least: 4,
    },
  },
  {
    name: "make-me-an-offer without a price",
    message: "Make me an offer.",
    stage_before: "offer_interest",
    ade: null,
    known_facts: { ownership_status: "confirmed" },
    expect: {
      price_captured: null,
      no_send_above_authority: true,
      next_action_present: true,
    },
  },
  {
    name: "drive-by condition challenge",
    message: "Door is unlock you can go check it out and send me your offer",
    stage_before: "property_condition",
    ade: ADE_SMALL,
    known_facts: { ownership_status: "confirmed", asking_price: { value: 120000, confidence: 0.9 } },
    expect: {
      no_send_above_authority: true,
      next_action_present: true,
    },
  },
  {
    name: "hostile tenant-protection reply — no condition argument",
    message: "Hi greg. I consider it my highest priority to save my well taken care of tenants from being raped and pillaged by out of town investors.",
    stage_before: "asking_price",
    ade: ADE_MID,
    known_facts: { ownership_status: "confirmed" },
    expect: {
      no_monetary: true,
      no_stage_regression: true,
    },
  },
  {
    name: "seller counter within authority",
    message: "200k cash ? You ready",
    stage_before: "offer",
    ade: ADE_MID, // ceiling 205k → 200k counter is inside authority
    known_facts: { ownership_status: "confirmed", occupancy_status: "vacant", condition_disclosed: true, asking_price: { value: 230000, confidence: 0.9 } },
    prior_state: {
      initial_asking_price: 230000,
      current_asking_price: 230000,
      asking_price_history: [{ value: 230000, kind: "initial", at: "2026-06-30T00:00:00Z" }],
      initial_offer: 180000,
      latest_offer: 180000,
      offers_made: [{ amount: 180000, strategy: "initial_offer" }],
      recommended_offer: 180000,
      authorized_offer_floor: 160000,
      authorized_offer_ceiling: 205000,
    },
    expect: {
      price_captured: 200000,
      strategy: "accept_seller_terms",
      monetary_at_most: 200000,
      seller_concession_detected: true,
    },
  },
  {
    name: "seller counter far above authority",
    message: "How much you want to buy ? If I sale my property it is over $500.000",
    stage_before: "asking_price",
    ade: ADE_SMALL,
    known_facts: { ownership_status: "confirmed" },
    expect: {
      zone: "large_gap",
      no_monetary: true,
    },
  },
  {
    name: "alternate-strategy signal — seller finance",
    message: "I want seller finance",
    stage_before: "offer",
    ade: { ...ADE_MID, seller_finance_score: 72 },
    known_facts: { ownership_status: "confirmed", occupancy_status: "vacant", condition_disclosed: true, asking_price: { value: 320000, confidence: 0.9 } },
    prior_state: {
      initial_asking_price: 320000,
      current_asking_price: 320000,
      initial_offer: 180000,
      latest_offer: 205000,
      offers_made: [{ amount: 180000 }, { amount: 205000 }],
      recommended_offer: 180000,
      authorized_offer_floor: 160000,
      authorized_offer_ceiling: 205000,
    },
    expect: {
      strategy_in: ["seller_finance_probe", "final_authorized_offer"],
      no_send_above_authority: true,
    },
  },
  {
    name: "accepted terms — inside authority",
    message: "Ok let's move forward",
    stage_before: "offer",
    ade: ADE_MID,
    known_facts: { ownership_status: "confirmed", occupancy_status: "vacant", condition_disclosed: true, asking_price: { value: 195000, confidence: 0.9 } },
    prior_state: {
      initial_asking_price: 195000,
      current_asking_price: 195000,
      initial_offer: 180000,
      latest_offer: 180000,
      offers_made: [{ amount: 180000, strategy: "initial_offer" }],
      recommended_offer: 180000,
      authorized_offer_floor: 160000,
      authorized_offer_ceiling: 205000,
    },
    expect: {
      strategy: "accept_seller_terms",
      terms_accepted: true,
      accepted_at_most: 195000,
      stage_at_least: 6,
    },
  },
  {
    name: "opt-out during negotiation — negotiation halts",
    message: "Please stop and take me off the calling or reaching list",
    stage_before: "offer",
    ade: ADE_MID,
    known_facts: { ownership_status: "confirmed", asking_price: { value: 220000, confidence: 0.9 } },
    expect: {
      blocked: true,
      no_monetary: true,
      no_stage_regression: true,
    },
  },
  {
    name: "spanish as-is price",
    message: "$160k en la condicion Que se encuentra sin aser preguntas sin sentido",
    stage_before: "offer_interest",
    ade: ADE_MID, // ceiling 205k → within authority
    known_facts: { ownership_status: "confirmed" },
    expect: {
      price_captured: 160000,
      zone: "within_authority",
      strategy: "accept_seller_terms",
      monetary_at_most: 160000,
    },
  },
  {
    name: "minimum-price framing",
    message: "300,000 minimum I'm not stupid this market is exploding",
    stage_before: "asking_price",
    ade: ADE_MID,
    known_facts: { ownership_status: "confirmed" },
    expect: {
      price_captured: 300000,
      zone: "large_gap",
      no_monetary: true,
    },
  },
];

function renderSafetyCheck(strategyDecision, adeCeiling) {
  // Render the strategy's template from the canonical local registry with the
  // authorized amount ONLY — assert no seller price, no $0, nothing above the
  // ceiling can appear.
  if (!strategyDecision?.template_use_case) return { ok: true, rendered: null };
  const template = LOCAL_TEMPLATE_CANDIDATES.find(
    (t) => t.use_case === strategyDecision.template_use_case
  );
  if (!template) return { ok: true, rendered: null, note: "db_template_only" };
  const amount = strategyDecision.monetary?.amount ?? null;
  const rendered = personalizeTemplate(template.text, {
    property_address: "123 Shadow St",
    seller_first_name: "Alex",
    offer_price: amount != null ? `$${Number(amount).toLocaleString("en-US")}` : null,
    smart_cash_offer_display: amount != null ? `$${Number(amount).toLocaleString("en-US")}` : null,
    comp_anchor_statement: strategyDecision.monetary?.anchor_statement ?? null,
  });
  if (!rendered.ok) {
    // Fail-closed render (missing monetary authority) is SAFE.
    return { ok: true, rendered: null, failed_closed: true };
  }
  if (/\$0\b/.test(rendered.text)) return { ok: false, reason: "rendered_zero_dollar", rendered: rendered.text };
  const amounts = [...rendered.text.matchAll(/\$([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  for (const a of amounts) {
    if (adeCeiling != null && a > adeCeiling) {
      return { ok: false, reason: `rendered_amount_${a}_above_ceiling_${adeCeiling}`, rendered: rendered.text };
    }
  }
  return { ok: true, rendered: rendered.text };
}

async function runCase(c) {
  const failures = [];
  const classification = await classify(c.message, null, { heuristicOnly: true });
  const intent = classification?.primary_intent || "unclear";

  const priorState = c.prior_state || null;
  const price_signal = resolveAskingPriceSignal(c.message, {
    reference:
      priorState?.current_asking_price ??
      c.ade?.recommended_cash_offer ??
      null,
    negotiationActive: Boolean(priorState?.offers_made?.length),
    sourceMessageId: "shadow-msg",
  });

  if (c.expect.price_captured !== undefined) {
    const got = price_signal.asking_price?.value ?? null;
    if (got !== c.expect.price_captured) {
      failures.push(`price_captured expected ${c.expect.price_captured} got ${got}`);
    }
  }

  const adeResult = c.ade
    ? {
        sufficient_facts: true,
        underwriting_ready: true,
        recommended_offer: c.ade.recommended_cash_offer,
        investor_ceiling_mid: c.ade.investor_ceiling_mid,
      }
    : null;

  let transition = resolveSellerStageTransition({
    stage_before: c.stage_before,
    known_facts: c.known_facts || {},
    new_facts: { asking_price: price_signal.asking_price },
    intent,
    classification_confidence: classification?.confidence ?? null,
    automation_mode: "shadow",
    negotiation_state: priorState,
    ade_result: adeResult,
    source_message_id: "shadow-msg",
  });

  const negotiation = resolveNegotiationTurn({
    transition,
    priceSignal: price_signal,
    priorState,
    adeSnapshot: c.ade,
    engineDecision: null,
    intent,
    classificationConfidence: classification?.confidence ?? null,
    contextSummary: { property_type: c.unit_count >= 2 ? "duplex" : "sfr", unit_count: c.unit_count || null },
    sourceMessageId: "shadow-msg",
  });

  const strategy = negotiation?.strategy_decision || null;
  const state = negotiation?.state_preview || null;
  const zone = negotiation?.zone?.zone || null;

  // Mirror the orchestrator: newly accepted terms resolve the S5 milestone,
  // so the lifecycle is re-resolved before persistence/reply.
  if (state?.terms_accepted && !priorState?.terms_accepted) {
    transition = resolveSellerStageTransition({
      stage_before: transition.stage_before,
      known_facts: transition.facts_patch,
      new_facts: {},
      intent,
      classification_confidence: classification?.confidence ?? null,
      automation_mode: "shadow",
      negotiation_state: state,
      ade_result: adeResult || { sufficient_facts: true, underwriting_ready: true },
      source_message_id: "shadow-msg",
    });
  }

  if (c.expect.blocked) {
    if (negotiation !== null) failures.push(`expected negotiation halt, got strategy ${strategy?.strategy}`);
  }
  if (c.expect.zone && zone !== c.expect.zone) failures.push(`zone expected ${c.expect.zone} got ${zone}`);
  if (c.expect.strategy && strategy?.strategy !== c.expect.strategy) {
    failures.push(`strategy expected ${c.expect.strategy} got ${strategy?.strategy}`);
  }
  if (c.expect.strategy_in && !c.expect.strategy_in.includes(strategy?.strategy)) {
    failures.push(`strategy expected one of ${c.expect.strategy_in} got ${strategy?.strategy}`);
  }
  if (c.expect.no_monetary && strategy?.monetary?.amount != null) {
    failures.push(`expected no monetary authority, got ${strategy.monetary.amount}`);
  }
  if (c.expect.monetary_at_most != null) {
    const amount = strategy?.monetary?.amount ?? null;
    if (amount == null) failures.push("expected an authorized amount, got none");
    else if (amount > c.expect.monetary_at_most) failures.push(`amount ${amount} exceeds ${c.expect.monetary_at_most}`);
  }
  if (c.expect.stage_at_least && Number(transition?.stage_after_number || 0) < c.expect.stage_at_least) {
    failures.push(`stage expected >= S${c.expect.stage_at_least} got S${transition?.stage_after_number}`);
  }
  if (c.expect.no_stage_regression) {
    const beforeNum = Number(transition?.stage_before_number || 1);
    if (Number(transition?.stage_after_number || 1) < beforeNum) failures.push("stage regressed");
  }
  if (c.expect.terms_accepted && state?.terms_accepted !== true) failures.push("terms not accepted");
  if (c.expect.accepted_at_most != null && state?.accepted_price > c.expect.accepted_at_most) {
    failures.push(`accepted ${state.accepted_price} exceeds seller ask ${c.expect.accepted_at_most}`);
  }
  if (c.expect.seller_concession_detected && !(state?.seller_concessions?.length > 0)) {
    failures.push("seller concession not detected");
  }
  if (c.expect.next_action_present && !(transition?.next_action || strategy?.next_action)) {
    failures.push("no next action");
  }

  // Universal invariants: authority ceiling + monotonic stage.
  const ceiling = c.ade?.investor_ceiling_mid ?? null;
  if (strategy?.monetary?.amount != null && ceiling != null && strategy.monetary.amount > ceiling) {
    failures.push(`AUTHORITY VIOLATION: ${strategy.monetary.amount} > ceiling ${ceiling}`);
  }
  const render = renderSafetyCheck(strategy, ceiling);
  if (!render.ok) failures.push(`RENDER SAFETY: ${render.reason}`);

  return {
    name: c.name,
    ok: failures.length === 0,
    failures,
    observed: {
      intent,
      price: price_signal.asking_price?.value ?? null,
      stage_after: transition?.stage_after || null,
      zone,
      strategy: strategy?.strategy || null,
      amount: strategy?.monetary?.amount ?? null,
      next_action: strategy?.next_action || transition?.next_action || null,
      rendered: render.rendered,
    },
  };
}

const results = [];
for (const c of CASES) {
  try {
    results.push(await runCase(c));
  } catch (error) {
    results.push({ name: c.name, ok: false, failures: [`threw: ${error?.message}`], observed: null });
  }
}

let pass = 0;
for (const r of results) {
  const mark = r.ok ? "✅" : "❌";
  if (r.ok) pass += 1;
  console.log(`${mark} ${r.name}`);
  if (r.observed) {
    console.log(
      `   intent=${r.observed.intent} price=${r.observed.price} stage=${r.observed.stage_after} zone=${r.observed.zone} strategy=${r.observed.strategy} amount=${r.observed.amount} next=${r.observed.next_action}`
    );
  }
  for (const f of r.failures) console.log(`   ↳ ${f}`);
}
console.log(`\nSHADOW EVAL: ${pass}/${results.length} conversations conform. Sends: 0 (pure evaluation).`);
process.exit(pass === results.length ? 0 : 1);
