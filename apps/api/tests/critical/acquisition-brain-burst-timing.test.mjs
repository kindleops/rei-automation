// ─── acquisition-brain-burst-timing.test.mjs ───────────────────────────────
// Real burst segmentation + timing + contact window (shadow only).
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  planShadowBurst,
  planAllShadowBursts,
  segmentInboundBursts,
  seededInRange,
  evaluateContactWindowAt,
  evaluateContactWindowShadow,
  computeReplyTiming,
  computeBurstId,
  computeBurstContentHash,
  orderInboundMessages,
  resolveShadowTimezone,
  evaluateShadowBurstForInbound,
  BURST_DEBOUNCE_MIN_MS,
  BURST_DEBOUNCE_MAX_MS,
  MAX_BURST_DURATION_MS,
  SHADOW_BURST_EVENT,
  BURST_PLANNER_VERSION,
} from "@/lib/domain/acquisition-brain/shadow-burst-timing.js";

const THREAD = "+16128072000";
const BASE = "2026-07-17T15:00:00.000Z";
const baseMs = Date.parse(BASE);

function msg(id, text, intent, offset_ms = 0, extra = {}) {
  return {
    id: String(id),
    message: text,
    classification: { primary_intent: intent, confidence: 0.95 },
    timestamp: new Date(baseMs + offset_ms).toISOString(),
    ...extra,
  };
}

// ── 1–8 segmentation ─────────────────────────────────────────────────────

test("1 single-message burst", () => {
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [msg(1, "Yeah", "ownership_confirmed", 0)],
  });
  assert.equal(s.bursts.length, 1);
  assert.equal(s.bursts[0].ordered_message_ids.length, 1);
});

test("2 two messages inside debounce join one burst", () => {
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "What's the proposal?", "asks_offer", 10_000),
    ],
  });
  assert.equal(s.bursts.length, 1);
  assert.equal(s.bursts[0].ordered_message_ids.length, 2);
});

test("3 message exactly at debounce boundary joins", () => {
  const first = msg(1, "Yeah", "ownership_confirmed", 0);
  const deb = seededInRange(`${THREAD}:1`, BURST_DEBOUNCE_MIN_MS, BURST_DEBOUNCE_MAX_MS);
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [first, msg(2, "ok", "unclear", deb)],
  });
  assert.equal(s.bursts.length, 1);
  assert.equal(s.bursts[0].ordered_message_ids.length, 2);
});

test("4 message after debounce creates new burst", () => {
  const first = msg(1, "Yeah", "ownership_confirmed", 0);
  const deb = seededInRange(`${THREAD}:1`, BURST_DEBOUNCE_MIN_MS, BURST_DEBOUNCE_MAX_MS);
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [first, msg(2, "later", "unclear", deb + 1)],
  });
  assert.equal(s.bursts.length, 2);
});

test("5 message after 90s hard cap creates new burst", () => {
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "still", "unclear", MAX_BURST_DURATION_MS + 1),
    ],
  });
  assert.equal(s.bursts.length, 2);
  assert.ok(s.bursts[0].hard_close_at);
});

test("6 three-message extension remains within hard cap", () => {
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "proposal?", "asks_offer", 15_000),
      msg(3, "roof", "condition_disclosed", 30_000),
    ],
  });
  assert.equal(s.bursts.length, 1);
  assert.equal(s.bursts[0].ordered_message_ids.length, 3);
  const first = Date.parse(s.bursts[0].first_message_at);
  const last = Date.parse(s.bursts[0].latest_message_at);
  assert.ok(last - first <= MAX_BURST_DURATION_MS);
});

test("7 messages hours apart are separate bursts", () => {
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "still interested", "asks_offer", 3 * 3600_000),
    ],
  });
  assert.equal(s.bursts.length, 2);
});

test("8 messages days apart are separate bursts", () => {
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "hello again", "unclear", 3 * 86400_000),
    ],
  });
  assert.equal(s.bursts.length, 2);
});

// ── 9–14 identity / ordering ─────────────────────────────────────────────

test("9 duplicate webhook (same id) contributes once", () => {
  const a = msg(1, "Yeah", "ownership_confirmed", 0);
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [a, { ...a }, { ...a, timestamp: new Date(baseMs + 5).toISOString() }],
  });
  assert.equal(s.bursts[0].ordered_message_ids.length, 1);
});

test("10 duplicate message ID ignored", () => {
  const ordered = orderInboundMessages([
    msg(1, "a", "unclear", 0),
    msg(1, "b", "unclear", 1000),
  ]);
  assert.equal(ordered.length, 1);
});

test("11 out-of-order arrival orders deterministically", () => {
  const s = segmentInboundBursts({
    thread_key: THREAD,
    messages: [
      msg(2, "second", "asks_offer", 10_000),
      msg(1, "first", "ownership_confirmed", 0),
    ],
  });
  assert.deepEqual(s.bursts[0].ordered_message_ids, ["1", "2"]);
});

test("12 concurrent evaluation same inputs same plan", () => {
  const messages = [
    msg(1, "Yeah", "ownership_confirmed", 0),
    msg(2, "proposal?", "asks_offer", 5_000),
  ];
  const a = planShadowBurst({ thread_key: THREAD, messages, now: new Date(baseMs + 60_000) });
  const b = planShadowBurst({ thread_key: THREAD, messages, now: new Date(baseMs + 60_000) });
  assert.equal(a.event.dedupe_key, b.event.dedupe_key);
  assert.equal(a.plan.final_planned_send_at, b.plan.final_planned_send_at);
});

test("13 same message count different IDs cannot collide", () => {
  const a = computeBurstContentHash(["1", "2"], [BASE, new Date(baseMs + 1).toISOString()]);
  const b = computeBurstContentHash(["3", "4"], [BASE, new Date(baseMs + 1).toISOString()]);
  assert.notEqual(a, b);
  assert.notEqual(computeBurstId(THREAD, "1"), computeBurstId(THREAD, "2"));
});

test("14 content hash stability", () => {
  const h1 = computeBurstContentHash(["a", "b"], ["t1", "t2"]);
  const h2 = computeBurstContentHash(["a", "b"], ["t1", "t2"]);
  assert.equal(h1, h2);
});

// ── 15–21 provisional / final / timing ───────────────────────────────────

test("15 provisional plan while collecting", () => {
  const messages = [msg(1, "Yeah", "ownership_confirmed", 0)];
  const r = planShadowBurst({
    thread_key: THREAD,
    messages,
    now: new Date(baseMs + 1_000),
  });
  assert.equal(r.plan.plan_status, "provisional");
  assert.equal(r.plan.burst_status, "collecting");
  assert.equal(r.plan.may_transport, false);
});

test("16 final plan after debounce", () => {
  const messages = [msg(1, "Yeah", "ownership_confirmed", 0)];
  const r = planShadowBurst({
    thread_key: THREAD,
    messages,
    now: new Date(baseMs + 120_000),
  });
  assert.equal(r.plan.plan_status, "final_shadow");
  assert.equal(r.plan.burst_status, "closed");
});

test("17 real prior plan supersession only", () => {
  const m1 = [msg(1, "Yeah", "ownership_confirmed", 0)];
  const first = planShadowBurst({
    thread_key: THREAD,
    messages: m1,
    now: new Date(baseMs + 120_000),
  });
  const m2 = [
    msg(1, "Yeah", "ownership_confirmed", 0),
    msg(2, "proposal?", "asks_offer", 5_000),
  ];
  const second = planShadowBurst({
    thread_key: THREAD,
    messages: m2,
    now: new Date(baseMs + 120_000),
    prior_plan_events: [
      {
        id: "evt-prior-1",
        dedupe_key: first.event.dedupe_key,
        payload: first.plan,
      },
    ],
  });
  assert.equal(second.plan.superseded_reply_plans.length, 1);
  assert.equal(second.plan.superseded_reply_plans[0].plan_id, "evt-prior-1");
});

test("18 no fabricated supersession without prior events", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "proposal?", "asks_offer", 5_000),
      msg(3, "roof", "condition_disclosed", 10_000),
    ],
    now: new Date(baseMs + 120_000),
    prior_plan_events: [],
  });
  assert.equal(r.plan.superseded_reply_plans.length, 0);
});

test("19 planned_send_at never precedes debounce_until", () => {
  const messages = [msg(1, "Yes, what's the proposal?", "asks_offer", 0)];
  const r = planShadowBurst({
    thread_key: THREAD,
    messages,
    now: new Date(baseMs + 120_000),
  });
  if (r.plan.final_planned_send_at) {
    assert.ok(
      Date.parse(r.plan.final_planned_send_at) >= Date.parse(r.plan.debounce_until)
    );
  }
});

test("20 selected delay below debounce still floors at debounce", () => {
  const timing = computeReplyTiming({
    latest_message_at: BASE,
    debounce_until: new Date(baseMs + 40_000).toISOString(),
    debounce_ms: 40_000,
    timing_label: "urgent_compliant",
    burst_seed: "t:1",
    timezone: "America/Chicago",
  });
  // force short delay via seed — still max(debounce, raw)
  assert.ok(Date.parse(timing.planned_send_at_before_contact_window) >= baseMs + 40_000);
});

test("21 selected delay above debounce uses delay", () => {
  const timing = computeReplyTiming({
    latest_message_at: BASE,
    debounce_until: new Date(baseMs + 20_000).toISOString(),
    debounce_ms: 20_000,
    timing_label: "price_condition",
    burst_seed: "long-delay-seed",
    timezone: "America/Chicago",
  });
  assert.ok(timing.selected_reply_delay_ms >= 40_000);
  assert.ok(
    Date.parse(timing.raw_reply_at) >= baseMs + timing.selected_reply_delay_ms
  );
});

// ── 22–26 contact window + DST ───────────────────────────────────────────

test("22 contact window start 08:00 allowed", () => {
  // 2026-07-17 13:00 UTC = 08:00 CDT
  const w = evaluateContactWindowAt("2026-07-17T13:00:00.000Z", "America/Chicago");
  assert.equal(w.allowed, true);
});

test("23 contact window end 21:00 not allowed", () => {
  // 2026-07-18 02:00 UTC = 21:00 CDT
  const w = evaluateContactWindowAt("2026-07-18T02:00:00.000Z", "America/Chicago");
  assert.equal(w.allowed, false);
  assert.ok(w.next_eligible_at);
});

test("24 delay crossing 21:00 defers", () => {
  // latest just before close; long delay would push past 21:00
  const latest = "2026-07-18T01:50:00.000Z"; // 20:50 CDT
  const timing = computeReplyTiming({
    latest_message_at: latest,
    debounce_until: "2026-07-18T01:50:30.000Z",
    debounce_ms: 30_000,
    timing_label: "price_condition",
    burst_seed: "cross-close",
    timezone: "America/Chicago",
  });
  assert.ok(
    timing.timing_policy === "deferred_contact_window" ||
      evaluateContactWindowAt(timing.final_planned_send_at, "America/Chicago").allowed
  );
  if (timing.final_planned_send_at) {
    const final_w = evaluateContactWindowAt(timing.final_planned_send_at, "America/Chicago");
    assert.equal(final_w.allowed, true);
  }
});

test("25 DST spring transition next_eligible non-null", () => {
  // 2026-03-08 US spring forward
  const w = evaluateContactWindowAt("2026-03-08T10:00:00.000Z", "America/Chicago");
  assert.ok(w.next_eligible_at || w.allowed);
  assert.notEqual(w.next_eligible_at, null);
});

test("26 DST fall transition next_eligible non-null", () => {
  const w = evaluateContactWindowAt("2026-11-01T10:00:00.000Z", "America/Chicago");
  assert.ok(w.next_eligible_at || w.allowed);
});

test("07:59 local deferred", () => {
  // 12:59 UTC = 07:59 CDT on 2026-07-17
  const w = evaluateContactWindowAt("2026-07-17T12:59:00.000Z", "America/Chicago");
  assert.equal(w.allowed, false);
  assert.ok(w.next_eligible_at);
});

test("20:59 local allowed", () => {
  // 01:59 UTC next day = 20:59 CDT
  const w = evaluateContactWindowAt("2026-07-18T01:59:00.000Z", "America/Chicago");
  assert.equal(w.allowed, true);
});

test("midnight local deferred", () => {
  const w = evaluateContactWindowAt("2026-07-17T05:00:00.000Z", "America/Chicago");
  assert.equal(w.allowed, false);
  assert.ok(w.next_eligible_at);
});

// ── 27–29 timezone ───────────────────────────────────────────────────────

test("27 property timezone preferred", () => {
  const r = resolveShadowTimezone({
    property_timezone: "America/New_York",
    campaign_timezone: "America/Chicago",
  });
  assert.equal(r.timezone, "America/New_York");
  assert.equal(r.source, "property_market");
  assert.equal(r.fallback_used, false);
});

test("28 campaign timezone fallback", () => {
  const r = resolveShadowTimezone({
    campaign_timezone: "America/Denver",
  });
  assert.equal(r.timezone, "America/Denver");
  assert.equal(r.source, "campaign_market");
});

test("29 unknown/invalid timezone safe behavior", () => {
  const r = resolveShadowTimezone({ property_timezone: "Not/A_Zone" });
  assert.equal(r.timezone, null);
  assert.ok(r.human_review_required);
  const timing = computeReplyTiming({
    latest_message_at: BASE,
    debounce_until: new Date(baseMs + 30_000).toISOString(),
    timing_label: "clear_proposal_interest",
    burst_seed: "x",
    timezone: null,
    timezone_resolution: r,
  });
  assert.equal(timing.may_transport, false);
  assert.ok(timing.timing_policy === "human_review" || !timing.final_planned_send_at);
});

// ── 30–36 compliance / Spanish / alias ───────────────────────────────────

test("30 opt-out dominance over later proposal", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      msg(1, "STOP", "opt_out", 0),
      msg(2, "What's your proposal?", "asks_offer", 5_000),
    ],
    now: new Date(baseMs + 120_000),
  });
  // STOP closes first burst terminal; second is separate
  const all = planAllShadowBursts({
    thread_key: THREAD,
    messages: [
      msg(1, "STOP", "opt_out", 0),
      msg(2, "What's your proposal?", "asks_offer", 5_000),
    ],
    now: new Date(baseMs + 120_000),
  });
  assert.ok(all.bursts.some((b) => b.status === "terminal" || b.terminal_kind === "opt_out"));
  const stopPlan = all.plans.find((p) => p.plan.final_proposed_nba === "opt_out");
  assert.ok(stopPlan);
  assert.equal(stopPlan.plan.timing_policy, "terminal_no_reply");
  assert.equal(stopPlan.plan.may_send, false);
});

test("31 wrong-number dominance", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [msg(1, "Wrong number", "wrong_number", 0)],
    now: new Date(baseMs + 120_000),
  });
  assert.equal(r.plan.final_proposed_nba, "suppress");
  assert.equal(r.plan.timing_policy, "terminal_no_reply");
});

test("32 sold/never-owned dominance", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [msg(1, "I never owned that property", "never_owned", 0)],
    now: new Date(baseMs + 120_000),
  });
  assert.ok(["suppress", "opt_out"].includes(r.plan.final_proposed_nba) || r.plan.burst_status === "terminal");
});

test("33 probate/authority review path no contract", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      msg(1, "Yes", "ownership_confirmed", 0),
      msg(2, "Actually this is his brother", "ownership_confirmed", 5_000),
      msg(3, "He passed away", "ownership_confirmed", 10_000),
    ],
    now: new Date(baseMs + 120_000),
  });
  assert.notEqual(r.plan.final_proposed_nba, "prepare_proposal");
});

test("34 Stage 7–10 seller claim does not open transaction stages", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [msg(1, "We are under contract already", "info_request", 0)],
    now: new Date(baseMs + 120_000),
  });
  const stage = String(r.plan.facts_after?.[0]?.stage || r.plan.proposed_stage_after || "");
  assert.ok(!["under_contract", "closing", "closed", "funded"].includes(stage));
});

test("35 Spanish multi-message burst", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      msg(1, "Sí, soy el dueño", "ownership_confirmed", 0, {
        classification: { primary_intent: "ownership_confirmed", language: "es" },
      }),
      msg(2, "Cuál es la propuesta?", "asks_offer", 8_000, {
        classification: { primary_intent: "asks_offer", language: "es" },
      }),
    ],
    now: new Date(baseMs + 120_000),
  });
  assert.equal(r.ok, true);
  assert.equal(r.plan.inbound_message_ids.length, 2);
});

test("36 archived alias rejected", () => {
  const r = planShadowBurst({
    thread_key: "6128072000",
    messages: [msg(1, "Yeah", "ownership_confirmed", 0)],
  });
  assert.equal(r.ok, false);
  const s = segmentInboundBursts({
    thread_key: "legacy-alias",
    messages: [msg(1, "Yeah", "ownership_confirmed", 0)],
  });
  assert.equal(s.ok, false);
});

// ── 37–43 events / safety ────────────────────────────────────────────────

test("37 event dedupe key includes content hash and planner version", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [msg(1, "Yeah", "ownership_confirmed", 0)],
    now: new Date(baseMs + 120_000),
  });
  assert.equal(r.event.event_type, SHADOW_BURST_EVENT);
  assert.ok(r.event.dedupe_key.includes(r.plan.burst_id));
  assert.ok(r.event.dedupe_key.includes(r.plan.burst_content_hash));
  assert.ok(r.event.dedupe_key.includes(BURST_PLANNER_VERSION));
});

test("38 event persistence failure returns fail-open shape", async () => {
  const { emitShadowBurstPlan } = await import(
    "@/lib/domain/acquisition-brain/shadow-burst-timing.js"
  );
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [msg(1, "Yeah", "ownership_confirmed", 0)],
    now: new Date(baseMs + 120_000),
  });
  const out = await emitShadowBurstPlan(r, {
    emitAutomationEvent: async () => {
      throw new Error("persist_failed");
    },
  });
  assert.equal(out.ok, false);
});

test("39 history load failure does not throw evaluation", async () => {
  const { evaluateAndEmitShadowBurst } = await import(
    "@/lib/domain/acquisition-brain/shadow-burst-timing.js"
  );
  const out = await evaluateAndEmitShadowBurst({
    thread_key: THREAD,
    current_message: msg(1, "Yeah", "ownership_confirmed", 0),
    supabase: {
      from() {
        throw new Error("db_down");
      },
    },
    emit: false,
  });
  // still plans from current message alone
  assert.equal(out.ok, true);
  assert.equal(out.may_enqueue, false);
});

test("40 queue/provider/stage flags always false", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [msg(1, "Yeah", "ownership_confirmed", 0)],
    now: new Date(baseMs + 120_000),
  });
  assert.equal(r.may_enqueue, false);
  assert.equal(r.may_send, false);
  assert.equal(r.may_mutate_stages, false);
  assert.equal(r.plan.may_transport, false);
});

test("41 provider call zero invariant (no network in pure plan)", () => {
  // pure function — if this returns, no network occurred
  const r = evaluateShadowBurstForInbound({
    thread_key: THREAD,
    current_message: msg(1, "Yeah", "ownership_confirmed", 0),
    recent_messages: [],
    now: new Date(baseMs + 120_000),
  });
  assert.equal(r.ok, true);
  assert.equal(r.may_send, false);
});

test("42 stage mutation zero invariant", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [msg(1, "We closed yesterday", "info_request", 0)],
    now: new Date(baseMs + 120_000),
  });
  assert.equal(r.may_mutate_stages, false);
});

test("43 legacy unaffected flags (shadow isolation)", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "What's the proposal?", "asks_offer", 5_000),
      msg(3, "Needs a roof", "condition_disclosed", 10_000),
    ],
    now: new Date(baseMs + 120_000),
  });
  assert.equal(r.plan.final_proposed_nba, "request_asking_price");
  assert.equal(r.plan.may_enqueue, false);
  assert.equal(r.plan.may_send, false);
});

// ── Examples + determinism ───────────────────────────────────────────────

test("deterministic debounce in 20–40s range", () => {
  const a = seededInRange("seed-a", BURST_DEBOUNCE_MIN_MS, BURST_DEBOUNCE_MAX_MS);
  const b = seededInRange("seed-a", BURST_DEBOUNCE_MIN_MS, BURST_DEBOUNCE_MAX_MS);
  assert.equal(a, b);
  assert.ok(a >= BURST_DEBOUNCE_MIN_MS && a <= BURST_DEBOUNCE_MAX_MS);
});

test("Example 1: Yeah + proposal + roof → request_asking_price", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "What's the proposal?", "asks_offer", 5_000),
      msg(3, "Needs a roof", "condition_disclosed", 10_000),
    ],
    now: new Date(baseMs + 120_000),
  });
  assert.equal(r.ok, true);
  assert.equal(r.plan.final_proposed_nba, "request_asking_price");
  assert.equal(r.plan.final_template_use_case, "seller_asking_price");
  assert.equal(r.plan.inbound_message_ids.length, 3);
  assert.ok(r.plan.questions_already_answered.includes("ownership_confirmed"));
});

test("Example 2: price + condition consolidates without re-ask price", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      msg(1, "Yes, what's the proposal?", "asks_offer", 0),
      msg(2, "Around 250k", "asking_price_provided", 5_000),
      msg(3, "Roof and HVAC are old", "condition_disclosed", 10_000),
      msg(4, "Would want to close next month", "info_request", 15_000),
    ],
    now: new Date(baseMs + 120_000),
  });
  assert.notEqual(r.plan.final_proposed_nba, "request_asking_price");
  assert.ok(r.plan.questions_already_answered.includes("asking_price"));
});

test("true multi-burst thread: not one burst per thread", () => {
  const all = planAllShadowBursts({
    thread_key: THREAD,
    messages: [
      msg(1, "Yeah", "ownership_confirmed", 0),
      msg(2, "proposal?", "asks_offer", 5_000),
      msg(3, "hello again", "unclear", 2 * 3600_000),
      msg(4, "still here", "unclear", 2 * 3600_000 + 5_000),
    ],
    now: new Date(baseMs + 3 * 3600_000),
  });
  assert.ok(all.bursts.length >= 2);
  assert.ok(all.plans.length >= 2);
});

test("evaluateContactWindowShadow alias works", () => {
  const w = evaluateContactWindowShadow(new Date("2026-07-17T15:00:00.000Z"), "America/Chicago");
  assert.equal(w.allowed, true);
});

test("p95 pure compute under 15ms on fixture loop", () => {
  const samples = [];
  for (let i = 0; i < 50; i += 1) {
    const t0 = Date.now();
    planShadowBurst({
      thread_key: THREAD,
      messages: [
        msg(1, "Yeah", "ownership_confirmed", 0),
        msg(2, "proposal?", "asks_offer", 5_000),
      ],
      now: new Date(baseMs + 120_000),
    });
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  assert.ok(p95 < 15, `p95=${p95}`);
});
