// ─── acquisition-brain-seller-intelligence.test.mjs ────────────────────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSellerIntelligenceProfile,
  hasFactType,
  getActiveFactsByType,
  getBestActiveFact,
  getNormalizedFactValue,
  resolveCanonicalFactType,
  computeProfileInputHash,
  buildAuthorityProfile,
  buildCalibrationFixtures,
  TRI_STATE,
  SELLER_INTEL_EXCLUSIONS,
  SHADOW_SELLER_INTEL_EVENT,
  FACT_TYPE_ALIASES,
} from "@/lib/domain/acquisition-brain/shadow-seller-intelligence.js";
import { FACT_TYPES } from "@/lib/domain/acquisition-brain/fact-provenance-contract.js";

const THREAD = "+16128072000";
const AS_OF = "2026-07-18T12:00:00.000Z";

function fact(type, value, id = "m1") {
  return {
    fact_type: type,
    value,
    normalized_value: value,
    active: true,
    source_message_id: id,
    source_timestamp: AS_OF,
    fact_id: `${type}:${id}`,
  };
}

function msg(id, text, offset_s = 0) {
  return {
    id: String(id),
    message: text,
    timestamp: new Date(Date.parse(AS_OF) + offset_s * 1000).toISOString(),
  };
}

// 1–4 exact fact lookup
test("1 exact fact lookup", () => {
  const facts = [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)];
  assert.equal(hasFactType(facts, FACT_TYPES.OWNERSHIP_CONFIRMED), true);
  assert.equal(hasFactType(facts, FACT_TYPES.ASKING_PRICE), false);
});

test("2 unrelated true boolean does not match other types", () => {
  const facts = [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)];
  assert.equal(hasFactType(facts, FACT_TYPES.OPT_OUT), false);
  assert.equal(hasFactType(facts, FACT_TYPES.WRONG_NUMBER), false);
  assert.equal(hasFactType(facts, FACT_TYPES.ASKING_PRICE), false);
});

test("3 ownership does not imply price", () => {
  const facts = [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)];
  assert.equal(getNormalizedFactValue(facts, FACT_TYPES.ASKING_PRICE), null);
});

test("4 ownership does not imply opt_out", () => {
  assert.equal(
    hasFactType([fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)], FACT_TYPES.OPT_OUT),
    false
  );
});

test("proposal_interest does not imply probate", () => {
  assert.equal(
    hasFactType(
      [fact(FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED, true)],
      FACT_TYPES.PROBATE_DETECTED
    ),
    false
  );
});

test("asking_price does not imply condition", () => {
  assert.equal(
    hasFactType([fact(FACT_TYPES.ASKING_PRICE, 100)], FACT_TYPES.CONDITION_SUMMARY),
    false
  );
});

test("wrong_number does not imply every boolean fact", () => {
  const facts = [fact(FACT_TYPES.WRONG_NUMBER, true)];
  assert.equal(hasFactType(facts, FACT_TYPES.OWNERSHIP_CONFIRMED), false);
  assert.equal(hasFactType(facts, FACT_TYPES.OPT_OUT), false);
});

test("exact aliases resolve only documented types", () => {
  assert.equal(resolveCanonicalFactType("proposal_interest"), FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED);
  assert.equal(FACT_TYPE_ALIASES.condition, FACT_TYPES.CONDITION_SUMMARY);
  assert.equal(resolveCanonicalFactType("not_a_real_type_xyz"), null);
});

// 5–9 deterministic
test("5 deterministic output", () => {
  const input = {
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "Yeah")],
  };
  const a = JSON.stringify(buildSellerIntelligenceProfile(input).profile);
  const b = JSON.stringify(buildSellerIntelligenceProfile(input).profile);
  assert.equal(a, b);
});

test("6 stable input hash", () => {
  const h1 = computeProfileInputHash({
    thread_key: THREAD,
    facts: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "Yeah")],
    as_of: AS_OF,
  });
  const h2 = computeProfileInputHash({
    thread_key: THREAD,
    facts: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "Yeah")],
    as_of: AS_OF,
  });
  assert.equal(h1, h2);
});

test("7 changed fact changes hash", () => {
  const base = {
    thread_key: THREAD,
    messages: [msg(1, "Yeah")],
    as_of: AS_OF,
  };
  const h1 = computeProfileInputHash({
    ...base,
    facts: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
  });
  const h2 = computeProfileInputHash({
    ...base,
    facts: [fact(FACT_TYPES.ASKING_PRICE, 1)],
  });
  assert.notEqual(h1, h2);
});

test("8 changed message changes hash", () => {
  const h1 = computeProfileInputHash({
    thread_key: THREAD,
    facts: [],
    messages: [msg(1, "a")],
    as_of: AS_OF,
  });
  const h2 = computeProfileInputHash({
    thread_key: THREAD,
    facts: [],
    messages: [msg(2, "b")],
    as_of: AS_OF,
  });
  assert.notEqual(h1, h2);
});

test("9 no wall-clock nondeterminism", () => {
  const r1 = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "Yeah")],
  });
  const r2 = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "Yeah")],
  });
  assert.equal(r1.event.dedupe_key, r2.event.dedupe_key);
  assert.equal(r1.profile.as_of, AS_OF);
});

// 10–16 authority
test("10 authority unknown by default", () => {
  const a = buildAuthorityProfile([fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)], AS_OF);
  assert.equal(a.can_execute_alone, TRI_STATE.UNKNOWN);
});

test("11 verified solo authority only when fact authoritative", () => {
  const a = buildAuthorityProfile(
    [
      {
        ...fact(FACT_TYPES.CAN_EXECUTE_ALONE, true),
        claimed_or_verified: "authoritative",
      },
    ],
    AS_OF
  );
  assert.equal(a.can_execute_alone, TRI_STATE.VERIFIED_TRUE);
});

test("12 spouse requirement", () => {
  const a = buildAuthorityProfile([fact(FACT_TYPES.SPOUSE_REQUIRED, true)], AS_OF);
  assert.equal(a.can_execute_alone, TRI_STATE.VERIFIED_FALSE);
  assert.equal(a.spouse_required, true);
});

test("13 co-owner requirement", () => {
  assert.equal(
    buildAuthorityProfile([fact(FACT_TYPES.CO_OWNER_REQUIRED, true)], AS_OF)
      .can_execute_alone,
    TRI_STATE.VERIFIED_FALSE
  );
});

test("14 LLC authority", () => {
  assert.equal(
    buildAuthorityProfile([fact(FACT_TYPES.LLC_AUTHORITY_REQUIRED, true)], AS_OF)
      .llc_authority_required,
    true
  );
});

test("15 trust authority", () => {
  assert.equal(
    buildAuthorityProfile([fact(FACT_TYPES.TRUST_AUTHORITY_REQUIRED, true)], AS_OF)
      .trust_authority_required,
    true
  );
});

test("16 probate/executor", () => {
  const a = buildAuthorityProfile([fact(FACT_TYPES.PROBATE_DETECTED, true)], AS_OF);
  assert.equal(a.probate_or_heirship, true);
  assert.equal(a.human_review_required, true);
});

// 17–19 contract vs transaction
test("17 contract intent separate", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.CONTRACT_REQUESTED, true)],
    messages: [msg(1, "send contract")],
  });
  assert.equal(
    r.profile.signals.acquisition_intent.contract_intent.value,
    "contract_requested"
  );
});

test("18 under-contract seller claim separation", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [
      fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true),
      fact(FACT_TYPES.UNDER_CONTRACT_CLAIM, true),
    ],
    messages: [msg(1, "under contract")],
  });
  assert.equal(
    r.profile.signals.acquisition_intent.external_transaction_claims
      .already_under_contract_claim,
    true
  );
  assert.notEqual(
    r.profile.signals.acquisition_intent.contract_intent.value,
    "already_under_contract"
  );
});

test("19 closing claim separation", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.CLOSING_CLAIM, true)],
    messages: [msg(1, "we closed")],
  });
  assert.equal(
    r.profile.signals.acquisition_intent.external_transaction_claims.closing_claim,
    true
  );
});

// 20–26 engagement
test("20 first response latency", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "a", 0), msg(2, "b", 100)],
  });
  assert.equal(
    r.profile.signals.engagement.first_response_latency_ms.value,
    100_000
  );
});

test("21 median latency", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "a", 0), msg(2, "b", 10), msg(3, "c", 30)],
  });
  assert.ok(r.profile.signals.engagement.median_response_latency_ms.value != null);
});

test("22 insufficient latency data", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "only")],
  });
  assert.equal(
    r.profile.signals.engagement.engagement_trajectory.value,
    "insufficient_data"
  );
});

test("23–26 engagement fields present", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "a", 0), msg(2, "b?", 60)],
    burst_events: [{ burst_id: "b1" }],
  });
  assert.ok(r.profile.signals.engagement.inbound_count);
  assert.ok(r.profile.signals.engagement.multi_message_burst_count.value === 1);
});

// 27–31 communication
test("27 true burst tendency from events", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "a"), msg(2, "b"), msg(3, "c")],
    burst_events: [{ burst_id: "x" }, { burst_id: "y" }],
  });
  assert.equal(r.profile.signals.engagement.multi_message_burst_count.value, 2);
});

test("28 concise communication", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "ok")],
  });
  assert.equal(r.profile.signals.communication.length_style.value, "concise");
});

test("29 detailed communication", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "x".repeat(200))],
  });
  assert.equal(r.profile.signals.communication.length_style.value, "detailed");
});

test("30 preferred language", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [{ ...msg(1, "hola"), language: "es" }],
  });
  assert.equal(r.profile.signals.communication.preferred_language.value, "es");
});

test("31 insufficient preferred-time data", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "hi")],
  });
  assert.equal(
    r.profile.signals.communication.preferred_contact_time.value,
    "insufficient_data"
  );
});

// 32–39 negotiation
test("32 price anchor", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.ASKING_PRICE, 250000)],
    messages: [msg(1, "250k")],
  });
  assert.equal(r.profile.signals.negotiation.initial_price_anchor.value, 250000);
});

test("33 price range", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.ASKING_PRICE_RANGE, "200-250k")],
    messages: [msg(1, "around 200-250")],
  });
  assert.ok(r.profile.signals.negotiation.asking_price_range.value);
});

test("34 price firmness", () => {
  assert.ok(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [fact(FACT_TYPES.PRICE_FIRMNESS, "firm")],
      messages: [msg(1, "firm")],
    }).profile.signals.negotiation.price_firmness
  );
});

test("35 price flexibility", () => {
  assert.ok(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [fact(FACT_TYPES.PRICE_FLEXIBILITY, true)],
      messages: [msg(1, "flexible")],
    }).profile.signals.negotiation.price_flexibility
  );
});

test("36 counter sequence", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [
      fact(FACT_TYPES.SELLER_COUNTER, 1, "1"),
      fact(FACT_TYPES.SELLER_COUNTER, 2, "2"),
    ],
    messages: [msg(1, "c1"), msg(2, "c2")],
  });
  assert.equal(r.profile.signals.negotiation.seller_counter_count.value, 2);
});

test("37 competing proposal", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [fact(FACT_TYPES.COMPETING_PROPOSAL, true)],
      messages: [msg(1, "other offer")],
    }).profile.signals.negotiation.competing_proposal_mention.value,
    true
  );
});

test("38 recurring objection via not_interested", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [fact(FACT_TYPES.NOT_INTERESTED, true)],
      messages: [msg(1, "no")],
    }).profile.signals.acquisition_intent.not_interested.value,
    true
  );
});

test("39 trust question", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [fact(FACT_TYPES.CREDIBILITY_QUESTION, true)],
      messages: [msg(1, "who are you")],
    }).profile.signals.negotiation.credibility_or_trust_questions.value,
    true
  );
});

// 40–43 tone
test("40 explicit positive tone", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED, true)],
    messages: [msg(1, "interested")],
  });
  assert.equal(r.profile.signals.tone.conversation_tone.value, "positive");
});

test("41 skeptical tone", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [fact(FACT_TYPES.CREDIBILITY_QUESTION, true)],
      messages: [msg(1, "prove it")],
    }).profile.signals.tone.conversation_tone.value,
    "skeptical"
  );
});

test("42 hostile tone", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [fact(FACT_TYPES.HOSTILITY, true)],
      messages: [msg(1, "leave me alone")],
    }).profile.signals.tone.conversation_tone.value,
    "hostile"
  );
});

test("43 tone insufficient data", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [],
      messages: [],
    }).profile.signals.tone.conversation_tone.value,
    "insufficient_data"
  );
});

// 44–52 scoring hard rules
test("44 fast response alone not high priority", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "hi", 0), msg(2, "yo", 5)],
  });
  assert.notEqual(r.profile.opportunity_score.temperature, "high_priority");
  assert.ok(r.profile.opportunity_score.final_normalized_score <= 35);
});

test("45 long response alone not high priority", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "word ".repeat(100))],
  });
  assert.notEqual(r.profile.opportunity_score.temperature, "high_priority");
});

test("46 slow but qualified seller", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [
      fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true, "1"),
      fact(FACT_TYPES.SELLER_REQUESTS_PROPOSAL, true, "2"),
      fact(FACT_TYPES.ASKING_PRICE, 250000, "3"),
    ],
    messages: [msg(1, "own", 0), msg(2, "proposal", 86400), msg(3, "250k", 172800)],
  });
  assert.ok(
    ["warm", "qualified", "high_priority", "human_review"].includes(
      r.profile.opportunity_score.temperature
    )
  );
});

test("47 not interested cap", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.NOT_INTERESTED, true)],
    messages: [msg(1, "no")],
  });
  assert.ok(r.profile.opportunity_score.final_normalized_score <= 15);
});

test("48 opt-out terminal", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OPT_OUT, true)],
    messages: [msg(1, "STOP")],
  });
  assert.equal(r.profile.opportunity_score.temperature, "terminal");
});

test("49 wrong number terminal", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [fact(FACT_TYPES.WRONG_NUMBER, true)],
      messages: [msg(1, "wrong number")],
    }).profile.opportunity_score.temperature,
    "terminal"
  );
});

test("50 sold/never-owned unavailable", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [fact(FACT_TYPES.NEVER_OWNED, true)],
      messages: [msg(1, "never owned")],
    }).profile.opportunity_score.temperature,
    "unavailable"
  );
});

test("51 unverified authority penalty", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [
      fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true),
      fact(FACT_TYPES.SPOUSE_REQUIRED, true),
      fact(FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED, true),
      fact(FACT_TYPES.ASKING_PRICE, 1),
    ],
    messages: [msg(1, "wife on title")],
  });
  assert.equal(r.profile.signals.authority.can_execute_alone, TRI_STATE.VERIFIED_FALSE);
});

test("52 Stage 7–10 claim cannot increase stage readiness", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [
      fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true),
      fact(FACT_TYPES.UNDER_CONTRACT_CLAIM, true),
    ],
    messages: [msg(1, "under contract")],
  });
  assert.ok(
    r.profile.opportunity_score.gating_rules.under_contract_claim_not_stage_advance
  );
  assert.equal(
    r.profile.signals.acquisition_intent.contract_intent.value,
    "none"
  );
});

// 53–56 score / events
test("53 score component math present", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "yes")],
  });
  assert.ok(r.profile.opportunity_score.components.length > 0);
});

test("54 score normalization 0–100", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "yes")],
  });
  assert.ok(r.profile.opportunity_score.final_normalized_score >= 0);
  assert.ok(r.profile.opportunity_score.final_normalized_score <= 100);
});

test("55 score confidence present", () => {
  assert.ok(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [],
      messages: [],
    }).profile.opportunity_score.overall_confidence >= 0
  );
});

test("56 event dedupe stable", () => {
  const a = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "yes")],
  });
  const b = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "yes")],
  });
  assert.equal(a.event.dedupe_key, b.event.dedupe_key);
  assert.equal(a.event.event_type, SHADOW_SELLER_INTEL_EVENT);
});

test("57 archived alias", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: "6128072000",
      as_of: AS_OF,
      facts_after: [],
    }).ok,
    false
  );
});

test("58 Spanish profile", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [{ ...msg(1, "Sí soy el dueño"), language: "es" }],
  });
  assert.equal(r.profile.signals.communication.preferred_language.value, "es");
});

test("59 duplicate webhook same profile", () => {
  const facts = [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)];
  const messages = [msg(1, "yes")];
  const a = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: facts,
    messages,
  });
  const b = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: facts,
    messages,
  });
  assert.equal(a.event.dedupe_key, b.event.dedupe_key);
});

test("60 history load failure shape — pure still works", () => {
  assert.equal(
    buildSellerIntelligenceProfile({
      thread_key: THREAD,
      as_of: AS_OF,
      facts_after: [],
      messages: [],
    }).ok,
    true
  );
});

test("61 event persistence failure fail-open", async () => {
  const { emitShadowSellerIntelligence } = await import(
    "@/lib/domain/acquisition-brain/shadow-seller-intelligence.js"
  );
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [],
    messages: [msg(1, "x")],
  });
  const out = await emitShadowSellerIntelligence(r, {
    emitAutomationEvent: async () => {
      throw new Error("db");
    },
  });
  assert.equal(out.ok, false);
});

test("62 queue/provider/stage flags zero", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    as_of: AS_OF,
    facts_after: [fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true)],
    messages: [msg(1, "yes")],
  });
  assert.equal(r.may_enqueue, false);
  assert.equal(r.may_send, false);
  assert.equal(r.may_mutate_stages, false);
});

test("63 safety exclusions present", () => {
  assert.ok(SELLER_INTEL_EXCLUSIONS.includes("financial_desperation"));
  assert.ok(SELLER_INTEL_EXCLUSIONS.includes("race_or_ethnicity"));
});

test("calibration fixtures A–H", () => {
  const fix = buildCalibrationFixtures(AS_OF);
  assert.notEqual(fix.A_fast_no_ownership.profile.opportunity_score.temperature, "high_priority");
  assert.ok(
    ["warm", "qualified", "high_priority", "human_review", "developing"].includes(
      fix.B_slow_qualified.profile.opportunity_score.temperature
    )
  );
  assert.ok(fix.C_long_not_interested.profile.opportunity_score.final_normalized_score <= 15);
  assert.equal(fix.H_opt_out.profile.opportunity_score.temperature, "terminal");
  assert.equal(
    fix.G_under_contract_claim.profile.signals.acquisition_intent
      .external_transaction_claims.already_under_contract_claim,
    true
  );
  assert.equal(
    fix.E_probate.profile.signals.authority.human_review_required,
    true
  );
});

test("getActiveFactsByType exact only", () => {
  const facts = [
    fact(FACT_TYPES.OWNERSHIP_CONFIRMED, true),
    fact(FACT_TYPES.OPT_OUT, true),
  ];
  assert.equal(getActiveFactsByType(facts, FACT_TYPES.OWNERSHIP_CONFIRMED).length, 1);
  assert.equal(getBestActiveFact(facts, FACT_TYPES.OPT_OUT).fact_type, FACT_TYPES.OPT_OUT);
});
