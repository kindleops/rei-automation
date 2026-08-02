// ─── natural-response-golden.test.mjs ────────────────────────────────────────
// Golden conversation matrix for the natural-response provider path:
//   * engine-level golden cases for every launch-critical intent family —
//     policy object in → mock model out → validation verdict + fallback
//     behavior asserted (no real provider is ever reachable);
//   * the NATURAL_REPLY_ENGINE mode matrix (disabled / shadow /
//     internal_proof / enabled) through executeInboundAutomationDecision;
//   * provider-client upgrades: model allowlist, bounded retry policy,
//     max_tokens budget, latency/usage metadata, timeout clamping.

import test from "node:test";
import assert from "node:assert/strict";

import "../helpers/critical-test-environment.mjs";

import {
  generateConstrainedReply,
  buildModelCallFromEnv,
  resolveNaturalReplyMode,
  resolveNaturalReplyTimeoutMs,
  NATURAL_REPLY_MODEL_ALLOWLIST,
} from "@/lib/domain/seller-flow/natural-response-engine.js";

import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

// ── engine-level golden matrix ───────────────────────────────────────────────

const BASE_POLICY = {
  objective: "Confirm ownership and gauge interest",
  deterministicText: "Hi Jane, are you the owner of 123 Main St? Reply STOP to opt out.",
  allowedFacts: {
    our_role: "local homebuyer",
    property_address: "123 Main St",
    seller_first_name: "Jane",
  },
  prohibitedClaims: ["guaranteed", "licensed agent", "attorney", "highest offer"],
  unansweredSellerQuestions: [],
  conversationHistory: [],
  stage: "ownership_confirmation",
  status: "active",
  temperature: "warm",
  sellerTone: "neutral",
  language: "English",
  languageConfidence: 1,
  maxLength: 320,
  reEngagement: false,
  suppression: { active: false, reason: null },
};

function mockModel(output) {
  return async () => ({ output, provider: "mock", model: "mock-1" });
}

function goodOutput(text, extra = {}) {
  return {
    response_text: text,
    facts_used: ["property_address", "seller_first_name"],
    questions_answered: [],
    next_question: null,
    confidence: 0.9,
    ...extra,
  };
}

// One golden case per launch-critical intent family. Each entry provides the
// policy overrides and an ON-POLICY mock reply that must be accepted.
const GOLDEN_FAMILIES = [
  {
    family: "ownership_confirmed_opener",
    policy: {},
    reply: "Hi Jane, thanks for confirming you own 123 Main St. Would you consider an offer? Reply STOP to opt out.",
  },
  {
    family: "interest",
    policy: {
      objective: "Seller expressed interest; move toward price conversation",
      deterministicText: "Great to hear, Jane. What price would work for 123 Main St?",
      stage: "offer_interest",
    },
    reply: "Glad you're open to it, Jane. What price would feel fair for 123 Main St?",
  },
  {
    family: "asking_price_given",
    policy: {
      objective: "Acknowledge the asking price without countering",
      deterministicText: "Thanks Jane — noted on 150k for 123 Main St. We'll review and follow up.",
      conversationHistory: [
        { direction: "inbound", text: "We want 150k for it" },
      ],
      stage: "price_discovery",
    },
    reply: "Thanks Jane, noted on 150k for 123 Main St. We'll take a look and get back to you.",
  },
  {
    family: "needs_time",
    policy: {
      objective: "Seller needs time; acknowledge and set a light follow-up",
      deterministicText: "No rush at all, Jane. I'll check back in a few weeks.",
      stage: "nurture",
    },
    reply: "Totally understand, Jane — no rush. I'll reach back out in a few weeks.",
  },
  {
    family: "re_engagement",
    policy: {
      objective: "Seller re-engaged after a decline; continue naturally",
      deterministicText: "Good to hear from you again, Jane. Are you thinking about selling 123 Main St now?",
      reEngagement: true,
      conversationHistory: [
        { direction: "outbound", text: "Hi Jane, are you the owner of 123 Main St?" },
        { direction: "inbound", text: "Not interested." },
        { direction: "inbound", text: "Are you still interested in buying?" },
      ],
    },
    reply: "Yes, still very interested in 123 Main St, Jane. Has anything changed on your end?",
  },
  {
    family: "probate_authority",
    policy: {
      objective: "Acknowledge probate; ask who has authority to sell",
      deterministicText: "Sorry for your loss, Jane. Who is handling the estate for 123 Main St?",
      stage: "authority_resolution",
      unansweredSellerQuestions: ["who did you say you were?"],
    },
    reply: {
      response_text: "We're a local homebuyer, Jane. Sorry for your loss — who is handling the estate for 123 Main St?",
      facts_used: ["our_role", "property_address", "seller_first_name"],
      questions_answered: ["who did you say you were?"],
      next_question: "Who is handling the estate?",
      confidence: 0.88,
    },
  },
  {
    family: "agent_involved",
    policy: {
      objective: "Property is listed; acknowledge without competing claims",
      deterministicText: "Understood, Jane — if anything changes with the listing on 123 Main St, we're here.",
      stage: "listed_property",
    },
    reply: "Understood, Jane. If the listing situation changes on 123 Main St, happy to talk then.",
  },
  {
    family: "price_negotiation",
    policy: {
      objective: "Continue the price conversation inside authorized bounds",
      deterministicText: "Thanks Jane. We're reviewing numbers on 123 Main St and will follow up with specifics.",
      conversationHistory: [
        { direction: "inbound", text: "Could you do 140k?" },
      ],
      stage: "negotiation",
    },
    reply: "Thanks Jane — let me run 140k by the team for 123 Main St and follow up with specifics.",
  },
  {
    family: "spanish_conversation",
    policy: {
      objective: "Continue in Spanish",
      deterministicText: "Gracias Jane. ¿Cuál sería un buen precio para su casa en 123 Main St?",
      language: "Spanish",
      languageConfidence: 0.95,
    },
    reply: "Gracias Jane. ¿Qué precio le parecería justo por su casa en 123 Main St?",
  },
  {
    family: "callback_request",
    policy: {
      objective: "Seller asked for a call; confirm a callback",
      deterministicText: "Happy to call, Jane. When is a good time to reach you about 123 Main St?",
      stage: "logistics",
    },
    reply: "Of course, Jane — when's a good time to call you about 123 Main St?",
  },
  {
    family: "email_request",
    policy: {
      objective: "Seller asked for email; confirm we can follow up by email",
      deterministicText: "Sure, Jane — we can follow up by email about 123 Main St. What address should we use?",
      stage: "logistics",
    },
    reply: "Sure thing, Jane. What email should we use to send details about 123 Main St?",
  },
  {
    family: "condition_disclosure",
    policy: {
      objective: "Acknowledge condition disclosure; reassure as-is",
      deterministicText: "Thanks for the heads up, Jane. Condition is fine — we buy as-is at 123 Main St.",
      stage: "condition_review",
    },
    reply: "Appreciate the honesty, Jane — condition isn't a problem, we buy as-is. Still open to talking about 123 Main St?",
  },
];

for (const golden of GOLDEN_FAMILIES) {
  test(`golden(${golden.family}): on-policy generation is accepted`, async () => {
    const output =
      typeof golden.reply === "string" ? goodOutput(golden.reply) : golden.reply;
    const result = await generateConstrainedReply({
      ...BASE_POLICY,
      ...golden.policy,
      modelCall: mockModel(output),
    });
    assert.equal(result.source, "generated", `family=${golden.family} reason=${result.fallback_reason}`);
    assert.equal(result.ok, true);
    assert.equal(result.response_text, String(output.response_text).trim());
  });
}

// Adversarial variants per high-risk family: the validator must refuse.

test("golden(probate_authority): invented estate-value number falls back", async () => {
  const result = await generateConstrainedReply({
    ...BASE_POLICY,
    objective: "Acknowledge probate",
    deterministicText: "Sorry for your loss, Jane. Who is handling the estate?",
    modelCall: mockModel(
      goodOutput("Estates like 123 Main St usually clear probate in 45 days, Jane.")
    ),
  });
  assert.equal(result.source, "deterministic_fallback");
  assert.equal(result.fallback_reason, "invented_numeric_claim");
  assert.match(result.response_text, /Who is handling the estate/);
});

test("golden(agent_involved): prohibited 'highest offer' claim falls back", async () => {
  const result = await generateConstrainedReply({
    ...BASE_POLICY,
    modelCall: mockModel(
      goodOutput("We'll beat any listing — highest offer guaranteed for 123 Main St, Jane.")
    ),
  });
  assert.equal(result.source, "deterministic_fallback");
  assert.ok(
    ["prohibited_claim", "invented_numeric_claim"].includes(result.fallback_reason)
  );
});

test("golden(price_negotiation): unapproved authority answer falls back", async () => {
  const result = await generateConstrainedReply({
    ...BASE_POLICY,
    unansweredSellerQuestions: [],
    modelCall: mockModel({
      response_text: "Yes Jane, we can close whenever you like on 123 Main St.",
      facts_used: ["property_address", "seller_first_name"],
      questions_answered: ["can you close fast?"],
      next_question: null,
      confidence: 0.9,
    }),
  });
  assert.equal(result.source, "deterministic_fallback");
  assert.equal(result.fallback_reason, "unapproved_question_answered");
});

test("golden(spanish_conversation): English reply to a confident Spanish thread falls back", async () => {
  const result = await generateConstrainedReply({
    ...BASE_POLICY,
    language: "Spanish",
    languageConfidence: 0.95,
    deterministicText: "Gracias Jane. ¿Cuál sería un buen precio para su casa?",
    modelCall: mockModel(goodOutput("Thanks Jane, what price works for you?")),
  });
  assert.equal(result.source, "deterministic_fallback");
  assert.equal(result.fallback_reason, "language_mismatch");
});

// Compliance families: generation must never even start.

for (const [family, reason] of [
  ["wrong_number", "wrong_number"],
  ["opt_out", "opt_out"],
  ["post_stop_seller_contact", "seller_initiated_after_stop"],
]) {
  test(`golden(${family}): suppression blocks generation entirely`, async () => {
    let model_called = false;
    const result = await generateConstrainedReply({
      ...BASE_POLICY,
      suppression: { active: true, reason },
      modelCall: async () => {
        model_called = true;
        return { output: goodOutput("should never run"), provider: "mock", model: "mock-1" };
      },
    });
    assert.equal(model_called, false, "model must never be invoked under suppression");
    assert.equal(result.source, "suppressed_no_reply");
    assert.equal(result.response_text, null);
    assert.equal(result.fallback_reason, `suppressed_${reason}`);
  });
}

// ── mode matrix through executeInboundAutomationDecision ───────────────────

function liveNestedThreadContext(inbound_from) {
  return {
    found: true,
    inbound_from,
    ids: { master_owner_id: "mo-21", prospect_id: "pros-31", property_id: "prop-227" },
    items: {},
    flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
    recent: { recently_used_template_ids: [], touch_count: 3, recent_events: [] },
    summary: {
      conversation_stage: "ownership_confirmation",
      seller_stage: "ownership_confirmation",
      property_address: "123 Main St",
      seller_first_name: "Jane",
      language_preference: "English",
      last_inbound_at: "2026-05-01T12:00:00.000Z",
    },
  };
}

const TEMPLATE = {
  id: "tpl-golden",
  template_id: "tpl-golden",
  use_case: "seller_asking_price",
  stage_code: "seller_asking_price",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  reply_mode: "auto_reply",
  template_body:
    "Hi {{seller_first_name}}, what were you hoping to get for {{property_address}}? Reply STOP to opt out.",
  property_type_scope: "any",
};

function makeCapturingSupabase() {
  const inserts = [];
  function makeChain(table) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      gte: () => chain,
      lte: () => chain,
      lt: () => chain,
      or: () => chain,
      order: () => chain,
      update: () => chain,
      insert: (row) => {
        inserts.push({ table, row });
        return chain;
      },
      upsert: (row) => {
        inserts.push({ table, row, upsert: true });
        return chain;
      },
      limit: async () => ({
        data: table === "sms_templates" ? [TEMPLATE] : [],
        error: null,
      }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
    };
    return chain;
  }
  return { inserts, client: { from: (table) => makeChain(table) } };
}

const GENERATED_TEXT =
  "Absolutely still interested in 123 Main St, Jane. What price would work for you? Reply STOP to opt out.";

function goodModelCall() {
  return async () => ({
    output: {
      response_text: GENERATED_TEXT,
      facts_used: ["property_address", "seller_first_name"],
      questions_answered: [],
      next_question: "What price would work for you?",
      confidence: 0.9,
    },
    provider: "mock",
    model: "mock-1",
  });
}

async function runDecision({ mode, phone = "+16125551234", modelCall = goodModelCall() }) {
  const prior = process.env.NATURAL_REPLY_ENGINE;
  if (mode === undefined) delete process.env.NATURAL_REPLY_ENGINE;
  else process.env.NATURAL_REPLY_ENGINE = mode;
  const { inserts, client } = makeCapturingSupabase();
  try {
    const context = liveNestedThreadContext(phone);
    const result = await executeInboundAutomationDecision({
      message: "What would you offer?",
      threadKey: phone,
      inboundFrom: phone,
      inboundTo: "+16125550000",
      ownerId: "mo-21",
      inboundEventId: "evt-golden-1",
      latestThreadContext: context,
      context,
      classification: {
        primary_intent: "asks_offer",
        confidence: 0.8,
        automation_decision: { auto_reply_allowed: true },
      },
      inboundReceivedAt: "2026-08-01T12:00:00.000Z",
      dryRun: true,
      autoReplyMode: "dry_run",
      supabaseClient: client,
      naturalReplyModelCall: modelCall,
    });
    return { result, inserts };
  } finally {
    if (prior === undefined) delete process.env.NATURAL_REPLY_ENGINE;
    else process.env.NATURAL_REPLY_ENGINE = prior;
  }
}

test("mode matrix: unset/garbage → disabled, template ships, no audit", async () => {
  for (const mode of [undefined, "definitely_not_a_mode"]) {
    const { result } = await runDecision({ mode });
    assert.match(result.rendered_message_text, /what were you hoping to get/);
    assert.equal(result.natural_reply, null);
  }
});

test("mode matrix: shadow evaluates + audits but the template always ships", async () => {
  const { result, inserts } = await runDecision({ mode: "shadow" });
  assert.match(result.rendered_message_text, /what were you hoping to get/);
  assert.notEqual(result.rendered_message_text, GENERATED_TEXT);
  assert.equal(result.natural_reply.mode, "shadow");
  assert.equal(result.natural_reply.shadow_reason, "shadow_mode");
  assert.equal(result.natural_reply.would_apply, true);
  assert.equal(result.natural_reply.source, "generated");
  const audit_events = inserts.filter((entry) => entry.table === "automation_events");
  assert.ok(
    audit_events.some(
      (entry) => entry.row?.event_type === "NATURAL_REPLY_SHADOW_EVALUATED"
    ),
    "shadow evaluation must persist an automation event"
  );
});

test("mode matrix: internal_proof does NOT substitute for a real seller phone", async () => {
  const { result } = await runDecision({ mode: "internal_proof", phone: "+16125551234" });
  assert.match(result.rendered_message_text, /what were you hoping to get/);
  assert.equal(result.natural_reply.shadow_reason, "internal_proof_recipient_not_internal");
});

test("mode matrix: internal_proof substitutes for an internal test phone", async () => {
  const { result } = await runDecision({ mode: "internal_proof", phone: "+16127433952" });
  assert.equal(result.rendered_message_text, GENERATED_TEXT);
  assert.equal(result.natural_reply.source, "generated");
  assert.equal(result.natural_reply.mode, "internal_proof");
});

test("mode matrix: enabled substitutes and persists an APPLIED audit event", async () => {
  const { result, inserts } = await runDecision({ mode: "enabled" });
  assert.equal(result.rendered_message_text, GENERATED_TEXT);
  const audit_events = inserts.filter((entry) => entry.table === "automation_events");
  assert.ok(
    audit_events.some((entry) => entry.row?.event_type === "NATURAL_REPLY_APPLIED"),
    "applied substitution must persist an automation event"
  );
});

test("mode matrix: hostile output under shadow audits the fallback and ships the template", async () => {
  const { result } = await runDecision({
    mode: "shadow",
    modelCall: async () => ({
      output: {
        response_text: "We guarantee $999,999 for 123 Main St!",
        facts_used: ["property_address"],
        questions_answered: [],
        next_question: null,
        confidence: 0.99,
      },
      provider: "mock",
      model: "mock-1",
    }),
  });
  assert.match(result.rendered_message_text, /what were you hoping to get/);
  assert.equal(result.natural_reply.source, "deterministic_fallback");
  assert.equal(result.natural_reply.fallback_reason, "invented_numeric_claim");
});

test("mode matrix: engine/model failure ships the template unchanged (safe degradation)", async () => {
  const { result } = await runDecision({
    mode: "enabled",
    modelCall: async () => {
      throw new Error("provider exploded");
    },
  });
  assert.match(result.rendered_message_text, /what were you hoping to get/);
  assert.equal(result.natural_reply.fallback_reason, "model_error");
  assert.equal(result.automation_decision.should_queue_reply, true);
});

// ── provider client upgrades ─────────────────────────────────────────────────

function providerEnv(extra = {}) {
  return { GROQ_API_KEY: "test-key-never-real", ...extra };
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

const MODEL_JSON = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          response_text: "hello",
          facts_used: [],
          questions_answered: [],
          next_question: null,
          confidence: 0.9,
        }),
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
};

test("provider: non-allowlisted NATURAL_REPLY_MODEL falls back to the provider default", async () => {
  const bodies = [];
  const call = buildModelCallFromEnv({
    env: providerEnv({ NATURAL_REPLY_MODEL: "totally-unvetted-model" }),
    fetchImpl: async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return okResponse(MODEL_JSON);
    },
  });
  const result = await call({ system: "s", prompt: "p", timeoutMs: 2000 });
  assert.equal(bodies[0].model, "llama-3.3-70b-versatile");
  assert.equal(result.model_allowlist_fallback, true);
  assert.ok(NATURAL_REPLY_MODEL_ALLOWLIST.groq.includes(bodies[0].model));
});

test("provider: allowlisted model, max_tokens budget, latency + usage metadata", async () => {
  const bodies = [];
  const call = buildModelCallFromEnv({
    env: providerEnv({ NATURAL_REPLY_MODEL: "llama-3.1-8b-instant" }),
    fetchImpl: async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return okResponse(MODEL_JSON);
    },
  });
  const result = await call({ system: "s", prompt: "p", timeoutMs: 2000, maxLength: 320 });
  assert.equal(bodies[0].model, "llama-3.1-8b-instant");
  assert.ok(bodies[0].max_tokens <= 400, "max_tokens must be capped");
  assert.ok(bodies[0].max_tokens >= 100, "max_tokens must cover the SMS budget");
  assert.equal(bodies[0].response_format.type, "json_object");
  assert.equal(result.model_allowlist_fallback, false);
  assert.equal(result.attempts, 1);
  assert.ok(Number.isFinite(result.latency_ms));
  assert.deepEqual(result.usage, {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
});

test("provider: one retry on 500, success on second attempt", async () => {
  let calls = 0;
  const call = buildModelCallFromEnv({
    env: providerEnv(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, json: async () => ({}) };
      return okResponse(MODEL_JSON);
    },
  });
  const result = await call({ system: "s", prompt: "p", timeoutMs: 2000 });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
});

test("provider: 429 retries once; a second 429 surfaces the error", async () => {
  let calls = 0;
  const call = buildModelCallFromEnv({
    env: providerEnv(),
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    },
  });
  await assert.rejects(() => call({ system: "s", prompt: "p", timeoutMs: 2000 }), /model_http_429/);
  assert.equal(calls, 2, "exactly one retry");
});

test("provider: plain 4xx never retries", async () => {
  let calls = 0;
  const call = buildModelCallFromEnv({
    env: providerEnv(),
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 400, json: async () => ({}) };
    },
  });
  await assert.rejects(() => call({ system: "s", prompt: "p", timeoutMs: 2000 }), /model_http_400/);
  assert.equal(calls, 1, "4xx must not retry");
});

test("provider: no key configured returns null (production-safe default)", () => {
  assert.equal(buildModelCallFromEnv({ env: {} }), null);
});

// ── config resolvers ─────────────────────────────────────────────────────────

test("resolveNaturalReplyMode: full matrix", () => {
  assert.deepEqual(resolveNaturalReplyMode({}), { mode: "disabled", reason: "engine_disabled" });
  assert.deepEqual(resolveNaturalReplyMode({ NATURAL_REPLY_ENGINE: "disabled" }), {
    mode: "disabled",
    reason: "engine_disabled",
  });
  assert.deepEqual(resolveNaturalReplyMode({ NATURAL_REPLY_ENGINE: "banana" }), {
    mode: "disabled",
    reason: "unrecognized_mode_value",
  });
  assert.equal(resolveNaturalReplyMode({ NATURAL_REPLY_ENGINE: "shadow" }).mode, "shadow");
  assert.equal(
    resolveNaturalReplyMode({ NATURAL_REPLY_ENGINE: "internal_proof" }).mode,
    "internal_proof"
  );
  assert.equal(resolveNaturalReplyMode({ NATURAL_REPLY_ENGINE: "Enabled" }).mode, "enabled");
});

test("resolveNaturalReplyTimeoutMs: default and clamps", () => {
  assert.equal(resolveNaturalReplyTimeoutMs({}), 8000);
  assert.equal(resolveNaturalReplyTimeoutMs({ NATURAL_REPLY_TIMEOUT_MS: "50" }), 1000);
  assert.equal(resolveNaturalReplyTimeoutMs({ NATURAL_REPLY_TIMEOUT_MS: "999999" }), 20000);
  assert.equal(resolveNaturalReplyTimeoutMs({ NATURAL_REPLY_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveNaturalReplyTimeoutMs({ NATURAL_REPLY_TIMEOUT_MS: "garbage" }), 8000);
});
