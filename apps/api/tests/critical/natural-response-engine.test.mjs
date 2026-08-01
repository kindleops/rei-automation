import test from "node:test";
import assert from "node:assert/strict";

import {
  NATURAL_RESPONSE_ENGINE_VERSION,
  buildModelCallFromEnv,
  generateConstrainedReply,
  validateGeneratedReply,
} from "@/lib/domain/seller-flow/natural-response-engine.js";

const BASE_ARGS = Object.freeze({
  objective: "answer_price_question_and_confirm_interest",
  deterministicText: "Thanks for getting back to us — are you open to an offer on the property?",
  allowedFacts: {
    property_address: "1428 Maple Ave",
    our_role: "local cash buyer",
  },
  prohibitedClaims: ["guaranteed closing", "no fees ever", "we are licensed agents"],
  unansweredSellerQuestions: ["how much will you offer"],
  nextQuestion: "What price would work for you?",
  conversationHistory: [
    { direction: "outbound", text: "Hi, we buy houses in your area. Would you consider selling 1428 Maple Ave?" },
    { direction: "inbound", text: "How much will you offer?" },
  ],
  stage: "offer_interest",
  status: "new_reply",
  temperature: "warm",
  sellerTone: "curious",
  language: "English",
  languageConfidence: 0.95,
  maxLength: 320,
});

function mockModel(output, { provider = "mock", model = "mock-1" } = {}) {
  return async () => ({ output, provider, model });
}

function goodOutput(overrides = {}) {
  return {
    response_text:
      "Great question — we don't have a number yet for 1428 Maple Ave. As a local cash buyer we'd make one after a quick look. What price would work for you?",
    facts_used: ["property_address", "our_role"],
    questions_answered: ["how much will you offer"],
    next_question: "What price would work for you?",
    confidence: 0.9,
    ...overrides,
  };
}

// --- generation happy path -------------------------------------------------

test("valid constrained output is accepted and fully audited", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: mockModel(goodOutput()),
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "generated");
  assert.equal(result.fallback_reason, null);
  assert.deepEqual(result.facts_used, ["property_address", "our_role"]);
  assert.deepEqual(result.questions_answered, ["how much will you offer"]);
  assert.equal(result.next_question, "What price would work for you?");
  assert.equal(result.confidence, 0.9);
  assert.equal(result.model.provider, "mock");
  assert.equal(result.engine_version, NATURAL_RESPONSE_ENGINE_VERSION);
  assert.equal(result.audit.objective, BASE_ARGS.objective);
});

// --- deterministic fallback family ------------------------------------------

test("no model configured falls back to the deterministic template verbatim", async () => {
  const result = await generateConstrainedReply({ ...BASE_ARGS });
  assert.equal(result.ok, true);
  assert.equal(result.source, "deterministic_fallback");
  assert.equal(result.fallback_reason, "no_model_configured");
  assert.equal(result.response_text, BASE_ARGS.deterministicText);
});

test("model throw falls back with model_error", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(result.source, "deterministic_fallback");
  assert.equal(result.fallback_reason, "model_error");
  assert.equal(result.response_text, BASE_ARGS.deterministicText);
});

test("model timeout falls back with model_timeout", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    timeoutMs: 20,
    modelCall: () => new Promise(() => {}),
  });
  assert.equal(result.source, "deterministic_fallback");
  assert.equal(result.fallback_reason, "model_timeout");
});

test("invalid schema falls back", async () => {
  for (const bad of [null, "just text", { facts_used: [] }, { response_text: "" }, { response_text: "ok", confidence: "high" }]) {
    const result = await generateConstrainedReply({ ...BASE_ARGS, modelCall: mockModel(bad) });
    assert.equal(result.source, "deterministic_fallback", JSON.stringify(bad));
    assert.equal(result.fallback_reason, "invalid_schema");
  }
});

test("low model confidence falls back", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: mockModel(goodOutput({ confidence: 0.3 })),
  });
  assert.equal(result.fallback_reason, "low_confidence");
});

test("excessive length falls back", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: mockModel(goodOutput({ response_text: "x".repeat(321) })),
  });
  assert.equal(result.fallback_reason, "excessive_length");
});

// --- hallucination and policy violations -------------------------------------

test("invented price is rejected", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: mockModel(
      goodOutput({ response_text: "We can offer $185,000 for 1428 Maple Ave today." })
    ),
  });
  assert.equal(result.source, "deterministic_fallback");
  assert.equal(result.fallback_reason, "invented_numeric_claim");
});

test("invented timeline is rejected", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: mockModel(goodOutput({ response_text: "We close in 7 days, guaranteed cash." })),
  });
  assert.equal(result.fallback_reason, "invented_numeric_claim");
});

test("numbers already present in allowed facts or history are permitted", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    conversationHistory: [
      ...BASE_ARGS.conversationHistory,
      { direction: "inbound", text: "I want $250,000 for it." },
    ],
    modelCall: mockModel(
      goodOutput({ response_text: "Understood on $250,000 for 1428 Maple Ave — we'll see what we can do. What timeline works for you?" })
    ),
  });
  assert.equal(result.source, "generated");
});

test("prohibited claim is rejected", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: mockModel(
      goodOutput({ response_text: "No fees ever and a guaranteed closing for 1428 Maple Ave." })
    ),
  });
  assert.equal(result.fallback_reason, "prohibited_claim");
});

test("claiming an unapproved fact or question is rejected", async () => {
  const fact = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: mockModel(goodOutput({ facts_used: ["property_address", "arv_estimate"] })),
  });
  assert.equal(fact.fallback_reason, "unapproved_fact_used");

  const question = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: mockModel(goodOutput({ questions_answered: ["when can you close"] })),
  });
  assert.equal(question.fallback_reason, "unapproved_question_answered");
});

// --- suppression: absolutely no reply ----------------------------------------

test("opt-out and wrong-number suppression produce no reply at all", async () => {
  for (const reason of ["opt_out", "stop", "wrong_number", "seller_initiated_after_stop"]) {
    const result = await generateConstrainedReply({
      ...BASE_ARGS,
      suppression: { active: true, reason },
      modelCall: mockModel(goodOutput()),
    });
    assert.equal(result.ok, false, reason);
    assert.equal(result.response_text, null, reason);
    assert.equal(result.source, "suppressed_no_reply", reason);
    assert.equal(result.fallback_reason, `suppressed_${reason}`, reason);
  }
});

test("unknown active suppression reason fails closed with no reply", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    suppression: { active: true, reason: "mystery_hold" },
    modelCall: mockModel(goodOutput()),
  });
  assert.equal(result.ok, false);
  assert.equal(result.response_text, null);
  assert.equal(result.fallback_reason, "suppressed_unknown_reason");
});

// --- language policy ---------------------------------------------------------

test("Spanish reply allowed only with sufficient language confidence", async () => {
  const spanish = goodOutput({
    response_text:
      "Gracias por responder — somos compradores locales interesados en su propiedad. ¿Qué precio le interesa?",
    questions_answered: [],
  });
  const confident = await generateConstrainedReply({
    ...BASE_ARGS,
    unansweredSellerQuestions: [],
    language: "Spanish",
    languageConfidence: 0.95,
    modelCall: mockModel(spanish),
  });
  assert.equal(confident.source, "generated");

  const unconfident = await generateConstrainedReply({
    ...BASE_ARGS,
    unansweredSellerQuestions: [],
    language: "Spanish",
    languageConfidence: 0.4,
    modelCall: mockModel(spanish),
  });
  assert.equal(unconfident.fallback_reason, "language_confidence_insufficient");
});

test("Spanish text in an English thread is rejected as language mismatch", async () => {
  const result = await generateConstrainedReply({
    ...BASE_ARGS,
    modelCall: mockModel(
      goodOutput({ response_text: "Hola — gracias por responder sobre su casa y propiedad." })
    ),
  });
  assert.equal(result.fallback_reason, "language_mismatch");
});

// --- golden conversations ----------------------------------------------------

test("golden: re-engagement continues the thread instead of restarting", async () => {
  const history = [
    { direction: "outbound", text: "Hi, we buy houses in your area. Would you consider selling 1428 Maple Ave?" },
    { direction: "inbound", text: "Not interested." },
    { direction: "inbound", text: "Are you still interested in buying?" },
  ];
  const restart = await generateConstrainedReply({
    ...BASE_ARGS,
    reEngagement: true,
    conversationHistory: history,
    unansweredSellerQuestions: [],
    modelCall: mockModel(
      goodOutput({
        response_text: history[0].text,
        questions_answered: [],
      })
    ),
  });
  assert.equal(restart.fallback_reason, "mechanical_restart");

  const natural = await generateConstrainedReply({
    ...BASE_ARGS,
    reEngagement: true,
    conversationHistory: history,
    unansweredSellerQuestions: [],
    modelCall: mockModel(
      goodOutput({
        response_text:
          "Absolutely, still interested in 1428 Maple Ave. Glad you reached back out — what changed on your end? What price would work for you?",
        questions_answered: [],
      })
    ),
  });
  assert.equal(natural.source, "generated");
});

test("golden scenario matrix stays inside policy", async () => {
  const scenarios = [
    {
      name: "changed_mind",
      history: [
        { direction: "inbound", text: "Stop texting me. Actually wait — what would you pay?" },
      ],
      output: goodOutput({
        response_text: "Happy to talk numbers on 1428 Maple Ave whenever you are. What price would work for you?",
        questions_answered: [],
      }),
    },
    {
      name: "property_mismatch",
      history: [{ direction: "inbound", text: "That's not my house." }],
      output: goodOutput({
        response_text: "Apologies for the mix-up — thanks for letting us know. If you do own property you'd consider selling, happy to chat.",
        facts_used: [],
        questions_answered: [],
        next_question: null,
      }),
    },
    {
      name: "who_is_this_and_source_of_number",
      history: [{ direction: "inbound", text: "Who is this and how did you get my number?" }],
      output: goodOutput({
        response_text: "We're a local cash buyer reaching out about 1428 Maple Ave — your info came from public property records. Are you open to selling?",
        questions_answered: [],
      }),
    },
    {
      name: "probate_estate",
      history: [{ direction: "inbound", text: "This was my late father's house, it's in probate." }],
      output: goodOutput({
        response_text: "So sorry for your loss — no rush at all. When the estate settles we'd be glad to talk about 1428 Maple Ave if it helps.",
        questions_answered: [],
        next_question: null,
      }),
    },
    {
      name: "agent_involved",
      history: [{ direction: "inbound", text: "Talk to my realtor." }],
      output: goodOutput({
        response_text: "Will do — happy to work through your realtor on 1428 Maple Ave. Could you share their contact?",
        questions_answered: [],
        next_question: "Could you share their contact?",
      }),
    },
    {
      name: "hostile_non_opt_out",
      history: [{ direction: "inbound", text: "You vultures keep blowing up my phone." }],
      output: goodOutput({
        response_text: "Understood, and sorry about that. One quick question and we'll leave you be — any interest in an offer on 1428 Maple Ave?",
        questions_answered: [],
      }),
    },
    {
      name: "ambiguous_one_word",
      history: [{ direction: "inbound", text: "maybe" }],
      output: goodOutput({
        response_text: "No pressure at all. If the number made sense, would you consider selling 1428 Maple Ave?",
        questions_answered: [],
      }),
    },
    {
      name: "emoji_only",
      history: [{ direction: "inbound", text: "👍" }],
      output: goodOutput({
        response_text: "Great — what price would work for you on 1428 Maple Ave?",
        questions_answered: [],
      }),
    },
    {
      name: "typos",
      history: [{ direction: "inbound", text: "ya i mite sel idk wat its worht" }],
      output: goodOutput({
        response_text: "Totally fair — we can figure value together for 1428 Maple Ave. Do you have a ballpark price in mind?",
        questions_answered: [],
      }),
    },
    {
      name: "multiple_questions",
      history: [
        { direction: "inbound", text: "How much will you offer? And do I pay closing costs?" },
      ],
      questions: ["how much will you offer", "do i pay closing costs"],
      output: goodOutput({
        response_text: "We'd need a quick look at 1428 Maple Ave before naming a number, and you would not cover our costs. What price would work for you?",
        questions_answered: ["how much will you offer", "do i pay closing costs"],
      }),
    },
    {
      name: "delayed_reply_month_old_campaign",
      history: [
        { direction: "outbound", text: "Hi, we buy houses in your area. Would you consider selling 1428 Maple Ave?" },
        { direction: "inbound", text: "Just saw this from last month. Still buying?" },
      ],
      output: goodOutput({
        response_text: "Yes, still buying — glad the note reached you. Is 1428 Maple Ave something you'd consider selling now?",
        questions_answered: [],
      }),
    },
  ];

  for (const scenario of scenarios) {
    const result = await generateConstrainedReply({
      ...BASE_ARGS,
      conversationHistory: scenario.history,
      unansweredSellerQuestions: scenario.questions || [],
      modelCall: mockModel(scenario.output),
    });
    assert.equal(result.source, "generated", `${scenario.name}: ${result.fallback_reason}`);
    assert.ok(result.response_text.length <= BASE_ARGS.maxLength, scenario.name);
  }
});

// --- validator unit coverage --------------------------------------------------

test("validateGeneratedReply orders violations deterministically", () => {
  assert.equal(validateGeneratedReply({ candidate: null }), "invalid_schema");
  assert.equal(
    validateGeneratedReply({
      candidate: { response_text: "ok", confidence: 0.9 },
      maxLength: 1,
    }),
    "excessive_length"
  );
  assert.equal(
    validateGeneratedReply({
      candidate: { response_text: "We pay $999,999 cash", confidence: 0.9 },
      allowedFacts: {},
      deterministicText: "",
    }),
    "invented_numeric_claim"
  );
  assert.equal(
    validateGeneratedReply({
      candidate: goodOutput(),
      allowedFacts: BASE_ARGS.allowedFacts,
      unansweredSellerQuestions: BASE_ARGS.unansweredSellerQuestions,
      deterministicText: BASE_ARGS.deterministicText,
      language: "English",
      languageConfidence: 0.95,
    }),
    null
  );
});

// --- env adapter ---------------------------------------------------------------

test("buildModelCallFromEnv returns null without provider keys", () => {
  assert.equal(buildModelCallFromEnv({ env: {} }), null);
});

test("buildModelCallFromEnv posts an OpenAI-compatible request and parses JSON content", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(goodOutput()) } }],
      }),
    };
  };
  const call = buildModelCallFromEnv({ env: { GROQ_API_KEY: "test-key" }, fetchImpl });
  assert.equal(typeof call, "function");
  const result = await call({ system: "sys", prompt: "prompt", timeoutMs: 1000 });
  assert.equal(result.provider, "groq");
  assert.equal(captured.url.includes("groq.com"), true);
  assert.equal(JSON.parse(captured.init.body).messages.length, 2);
  assert.equal(result.output.confidence, 0.9);
});
