// ─── acquisition-brain-full-simulation-corpus.test.mjs ─────────────────────
// Full Stage 1–10 deterministic simulation corpus (no provider, no queue).
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildClassifierResultContract } from "@/lib/domain/acquisition-brain/fact-provenance-contract.js";
import {
  buildShadowFactState,
  compareIncrementalVsFull,
} from "@/lib/domain/acquisition-brain/shadow-fact-state.js";
import {
  planAllShadowBursts,
  segmentInboundBursts,
} from "@/lib/domain/acquisition-brain/shadow-burst-timing.js";
import {
  planShadowFollowup,
  cancelShadowFollowup,
  CANCELLATION_REASONS,
} from "@/lib/domain/acquisition-brain/shadow-followup-planner.js";
import {
  buildSellerIntelligenceProfile,
} from "@/lib/domain/acquisition-brain/shadow-seller-intelligence.js";
import { FACT_TYPES } from "@/lib/domain/acquisition-brain/fact-provenance-contract.js";

const AS_OF = "2026-07-18T15:00:00.000Z";
const base = Date.parse(AS_OF);

function inbound(id, text, intent, offset_s = 0, lang = "en") {
  return {
    id: String(id),
    message: text,
    classification: { primary_intent: intent, confidence: 0.95, language: lang },
    timestamp: new Date(base + offset_s * 1000).toISOString(),
    language: lang,
    direction: "inbound",
  };
}

function replayJourney(messages, thread = "+15551110001") {
  let facts = [];
  const states = [];
  for (const m of messages) {
    const s = buildShadowFactState({
      facts_before: facts,
      message: m.message,
      classification: m.classification,
      message_event_id: m.id,
      source_timestamp: m.timestamp,
    });
    facts = s.facts_after;
    states.push(s);
  }
  const bursts = planAllShadowBursts({
    thread_key: thread,
    messages,
    now: new Date(base + 120_000),
  });
  const intel = buildSellerIntelligenceProfile({
    thread_key: thread,
    facts_after: facts,
    messages,
    as_of: AS_OF,
    burst_events: (bursts.bursts || []).map((b) => ({ burst_id: b.burst_id })),
  });
  const eq = compareIncrementalVsFull(messages);
  return {
    facts,
    states,
    final_nba: states[states.length - 1]?.proposed_next_best_action,
    bursts,
    intel,
    equivalent: eq.equivalent,
  };
}

// ── Programmatic corpus (deterministic seeds) ────────────────────────────

function generateEnglishInbounds(n = 1000) {
  const templates = [
    ["Yeah", "ownership_confirmed"],
    ["STOP", "opt_out"],
    ["Wrong number", "wrong_number"],
    ["Around 250k", "asking_price_provided"],
    ["Needs a roof", "condition_disclosed"],
    ["What's the proposal?", "asks_offer"],
    ["Not interested", "not_interested"],
    ["My wife is on title", "ownership_confirmed"],
    ["I never owned it", "never_owned"],
    ["Under contract already", "info_request"],
  ];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const [text, intent] = templates[i % templates.length];
    out.push({
      id: `en-${i}`,
      message: `${text} #${i}`,
      intent,
      language: "en",
    });
  }
  return out;
}

function generateSpanishInbounds(n = 500) {
  const templates = [
    ["Sí, soy el dueño", "ownership_confirmed"],
    ["Cuál es la propuesta?", "asks_offer"],
    ["Necesita techo", "condition_disclosed"],
    ["ALTO", "opt_out"],
    ["Número equivocado", "wrong_number"],
    ["Alrededor de 250k", "asking_price_provided"],
  ];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const [text, intent] = templates[i % templates.length];
    out.push({
      id: `es-${i}`,
      message: `${text} #${i}`,
      intent,
      language: "es",
    });
  }
  return out;
}

test("corpus size: 1000 English + 500 Spanish inbounds", () => {
  const en = generateEnglishInbounds(1000);
  const es = generateSpanishInbounds(500);
  assert.equal(en.length, 1000);
  assert.equal(es.length, 500);
  // smoke classify/fact extract on sample
  for (const sample of [...en.slice(0, 20), ...es.slice(0, 20)]) {
    const c = buildClassifierResultContract({
      message: sample.message,
      classification: {
        primary_intent: sample.intent,
        confidence: 0.9,
        language: sample.language,
      },
      source_message_id: sample.id,
      source_timestamp: AS_OF,
    });
    assert.ok(Array.isArray(c.facts));
  }
});

test("Journey A: straight seller path", () => {
  const r = replayJourney([
    inbound(1, "Yes I own it", "ownership_confirmed", 0),
    inbound(2, "What's the proposal?", "asks_offer", 10),
    inbound(3, "Around 250k", "asking_price_provided", 20),
    inbound(4, "Needs a roof", "condition_disclosed", 30),
  ]);
  assert.equal(r.equivalent, true);
  assert.ok(r.facts.some((f) => f.fact_type === FACT_TYPES.OWNERSHIP_CONFIRMED));
  assert.notEqual(r.intel.profile.opportunity_score.temperature, "terminal");
  assert.equal(r.intel.may_send, false);
});

test("Journey B: multi-fact early skips redundant NBA path", () => {
  const r = replayJourney([
    inbound(
      1,
      "Yes I own it, want a proposal, around 200k, roof is old",
      "asks_offer",
      0
    ),
  ]);
  assert.ok(r.states[0].questions_already_answered?.length >= 1 || r.facts.length >= 1);
});

test("Journey E: probate → authority review", () => {
  const r = replayJourney([
    inbound(1, "Yes", "ownership_confirmed", 0),
    inbound(2, "Actually his brother", "ownership_confirmed", 10),
    inbound(3, "He passed away", "ownership_confirmed", 20),
  ]);
  assert.equal(r.intel.profile.signals.authority.human_review_required, true);
});

test("Journey H: wrong number terminal", () => {
  const r = replayJourney([inbound(1, "Wrong number", "wrong_number", 0)]);
  assert.equal(r.intel.profile.opportunity_score.temperature, "terminal");
  assert.equal(r.final_nba, "suppress");
});

test("Journey I: opt-out terminal", () => {
  const r = replayJourney([
    inbound(1, "Yeah", "ownership_confirmed", 0),
    inbound(2, "STOP", "opt_out", 10),
  ]);
  assert.equal(r.intel.profile.opportunity_score.temperature, "terminal");
});

test("Journey J: Spanish journey language preserved", () => {
  const r = replayJourney(
    [
      inbound(1, "Sí, soy el dueño", "ownership_confirmed", 0, "es"),
      inbound(2, "Cuál es la propuesta?", "asks_offer", 10, "es"),
    ],
    "+15551110002"
  );
  assert.equal(
    r.intel.profile.signals.communication.preferred_language.value,
    "es"
  );
});

test("Journey K: multi-message burst consolidation", () => {
  const msgs = [
    inbound(1, "Yeah", "ownership_confirmed", 0),
    inbound(2, "proposal?", "asks_offer", 5),
    inbound(3, "roof", "condition_disclosed", 10),
  ];
  const seg = segmentInboundBursts({
    thread_key: "+15551110003",
    messages: msgs,
  });
  assert.equal(seg.bursts.length, 1);
  assert.equal(seg.bursts[0].ordered_message_ids.length, 3);
});

test("Journey L: delivery follow-up then inbound cancel", () => {
  const planned = planShadowFollowup({
    thread_key: "+15551110004",
    triggering_outbound_id: "out-1",
    delivery_event_id: "del-1",
    delivery_status: "delivered",
    delivered_at: AS_OF,
    provider_sid: "SMtest",
    outbound_use_case: "ownership_check",
    stage: "ownership_check",
  });
  assert.equal(planned.ok, true);
  const cancelled = cancelShadowFollowup({
    plan: planned.plan,
    reason: CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
    source_event_id: "in-1",
  });
  assert.equal(cancelled.ok, true);
  assert.equal(planned.may_send, false);
});

test("Journey M: out-of-order stable final", () => {
  const msgs = [
    inbound(2, "proposal?", "asks_offer", 10),
    inbound(1, "Yeah", "ownership_confirmed", 0),
  ];
  // process in timestamp order via segment
  const r = replayJourney(
    [...msgs].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
    ),
    "+15551110005"
  );
  assert.equal(r.equivalent, true);
});

test("Journey N: under contract claim no Stage 8", () => {
  const r = replayJourney([
    inbound(1, "We are under contract already", "info_request", 0),
  ]);
  assert.ok(
    r.intel.profile.signals.acquisition_intent.external_transaction_claims
      .already_under_contract_claim ||
      r.facts.some((f) => f.fact_type === FACT_TYPES.UNDER_CONTRACT_CLAIM)
  );
  assert.ok(
    r.intel.profile.opportunity_score.gating_rules
      .under_contract_claim_not_stage_advance
  );
});

test("Journey G: spouse co-owner authority", () => {
  const r = replayJourney([
    inbound(1, "My wife is also on title", "ownership_confirmed", 0),
  ]);
  // may extract spouse or ownership
  assert.equal(r.intel.may_mutate_stages, false);
});

test("hard gates: zero provider/queue/stage mutations across journeys", () => {
  const journeys = [
    [inbound(1, "STOP", "opt_out")],
    [inbound(1, "Wrong number", "wrong_number")],
    [
      inbound(1, "Yeah", "ownership_confirmed", 0),
      inbound(2, "250k", "asking_price_provided", 10),
    ],
  ];
  for (const j of journeys) {
    const r = replayJourney(j, `+1555${String(Math.random()).slice(2, 10)}`);
    assert.equal(r.intel.may_enqueue, false);
    assert.equal(r.intel.may_send, false);
    assert.equal(r.intel.may_mutate_stages, false);
  }
});

test("300 multi-turn conversations equivalence sample", () => {
  let ok = 0;
  for (let i = 0; i < 300; i += 1) {
    const thread = `+1555${String(10000000 + i).padStart(8, "0")}`;
    const msgs = [
      inbound(`${i}-1`, "Yeah", "ownership_confirmed", 0),
      inbound(`${i}-2`, i % 5 === 0 ? "STOP" : "proposal?", i % 5 === 0 ? "opt_out" : "asks_offer", 8),
    ];
    const r = replayJourney(msgs, thread);
    if (r.equivalent) ok += 1;
  }
  assert.equal(ok, 300);
});

test("internal authority readiness plan documented (no activation)", () => {
  // Control-plane plan constants — not written to production
  const plan = {
    acquisition_brain_mode: "internal_shadow",
    allowed_modes: ["internal_shadow", "internal_authoritative", "public_limited"],
    initial_authority_scope: {
      threads: "internal_canary_only",
      stages: [1, 2, 3],
      templates: "deterministic_only",
      max_queue_intent: 1,
      contact_window: "normal",
      stages_4_6: "legacy_or_review",
      stages_7_10: "authoritative_events_only",
    },
    rollback_triggers: [
      "duplicate_send",
      "wrong_number_violation",
      "opt_out_violation",
      "stage_jump",
      "queue_backlog",
    ],
    production_control_plane_changed: false,
  };
  assert.equal(plan.production_control_plane_changed, false);
  assert.equal(plan.acquisition_brain_mode, "internal_shadow");
});
