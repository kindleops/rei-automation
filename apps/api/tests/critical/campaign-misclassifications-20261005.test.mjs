/**
 * Real misclassifications from the 2026-10-05 campaign (production threads).
 * Compliance first. Each case uses the opener that was actually delivered.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationContext, deriveUseCaseFromBody } from "@/lib/domain/classification/build-conversation-context.js";
import { classify } from "@/lib/domain/classification/classify.js";

function supabaseWith({ outbound = [], intervening = [], templates = [] } = {}) {
  const make = (rows) => {
    const b = {
      select: () => b, eq: () => b, in: () => b, not: () => b, lte: () => b,
      gt: () => b, lt: () => b, order: () => b,
      limit: async () => ({ data: rows, error: null }),
    };
    return b;
  };
  return {
    from: (table) =>
      make(table === "message_events" ? intervening : table === "sms_templates" ? templates : outbound),
  };
}

async function contextAfter(body, { template_use_case = null, intervening = [] } = {}) {
  const outbound = {
    id: "out-1",
    message_type: null,
    message_body: body,
    template_id: template_use_case ? "tpl-1" : null,
    provider_message_id: null,
    sent_at: "2026-10-05T13:00:00.000Z",
    delivered_at: "2026-10-05T13:00:10.000Z",
    queue_status: "delivered",
  };
  return buildConversationContext({
    thread_key: "+18175550100",
    inbound_received_at: "2026-10-05T14:00:00.000Z",
    supabase: supabaseWith({
      outbound: [outbound],
      intervening,
      templates: template_use_case ? [{ use_case: template_use_case }] : [],
    }),
  });
}

const run = (message, ctx) => classify(message, null, { heuristicOnly: true, conversation_context: ctx });

function assertOptOut(r, label) {
  assert.equal(r.primary_intent, "opt_out", label);
  assert.equal(r.automation_decision.suppression_action, "opt_out", label);
  assert.equal(r.automation_decision.auto_reply_allowed, false, label);
  assert.equal(r.automation_decision.queue_action, "none", label);
}

// ── 1. COMPLIANCE ───────────────────────────────────────────────────────────

const MARTIN_OPENER = "Hola Martin, soy Alex. Compro propiedad en 76106. Sigues siendo el dueno de 1621 Michael St?";

test("COMPLIANCE: Martin Pulido 'Si. Dejé de molestar' is an opt-out, never ownership_confirmed, never an auto-reply", async () => {
  const ctx = await contextAfter(MARTIN_OPENER, { template_use_case: "ownership_check" });
  assert.equal(ctx.last_outbound_use_case, "ownership_check");
  const r = await run("Si. Dejé de molestar", ctx);
  assertOptOut(r, "Si. Dejé de molestar");
  assert.equal(r.compliance_flag, "stop_texting");
  assert.equal(r.language, "Spanish");
});

test("COMPLIANCE: Spanish stop-bothering / stop-writing variants opt out, with and without context, even beside a yes", async () => {
  const ctx = await contextAfter(MARTIN_OPENER);
  const variants = [
    "Deje de molestar", "Dejé de molestar", "Dejen de molestar", "Deja de molestar",
    "Dejen de molestarme", "Deje de molestarme por favor", "No molesten", "No me molesten",
    "Ya no me escriba", "Ya no me escriban", "Ya no me escribas", "No me escriban",
    "Sí soy el dueño pero dejen de molestar", "Si, ya no me escriba", "Yes. Stop bothering me",
    "Please don't bother",
  ];
  for (const message of variants) {
    assertOptOut(await run(message, ctx), `${message} (with context)`);
    assertOptOut(await run(message, null), `${message} (no context)`);
  }
});

test("COMPLIANCE: 'no molesta' (it doesn't bother) is not an opt-out phrase", async () => {
  const r = await run("No molesta, sí soy el dueño", null);
  assert.notEqual(r.compliance_flag, "stop_texting");
});

// ── 2. broken-English decline ───────────────────────────────────────────────

test("Sonia Lopez 'No i am not  sell the house of 3521 south adams st' is not_interested", async () => {
  const ctx = await contextAfter("Hola Sonia, Alex aqui. Pregunta rapida. Todavia eres el dueno de 3521 S Adams St?", { template_use_case: "ownership_check" });
  const r = await run("No i am not  sell the house of 3521 south adams st", ctx);
  assert.equal(r.primary_intent, "not_interested");
  assert.equal(r.automation_decision.auto_reply_allowed, false);
  for (const m of ["I will not sell the house", "Never selling my house", "We are not going to sell the property"]) {
    assert.equal((await run(m, null)).primary_intent, "not_interested", m);
  }
  // A price floor is still decided by the money path, not as a decline.
  assert.notEqual((await run("I won't sell it for less than 300k", null)).primary_intent, "unclear");
});

// ── 3. a URL is not a price ─────────────────────────────────────────────────

test("Pedro G Gonzalez: a bare App Store URL is unclear/review, never asking_price_provided", async () => {
  const ctx = await contextAfter("Hola Pedro, Alejandro aqui. Soy comprador local en Houston. 6702 Crestridge St es tu propiedad?", { template_use_case: "ownership_check" });
  for (const message of ["https://apps.apple.com/app/id336698281", "www.zillow.com/homedetails/123456789_zpid", "zillow.com/homes/77002"]) {
    const r = await run(message, ctx);
    assert.notEqual(r.primary_intent, "asking_price_provided", message);
    assert.ok(!r.price_parse?.qualifies_as_seller_asking_price, message);
    assert.equal(r.automation_decision.auto_reply_allowed, false, message);
    assert.equal(r.automation_decision.human_review_required, true, message);
  }
  // A real price beside a link is still a price.
  const priced = await run("I want 250k, see https://zillow.com/homedetails/123", ctx);
  assert.equal(priced.primary_intent, "asking_price_provided");
});

// ── 4. bare "No" bound to the question ──────────────────────────────────────

test("Donald N Coward / William C Judice: bare 'No' to the ownership question is non-owner (wrong person)", async () => {
  const openers = [
    "Hello Donald, this is Helen. I have been investing in Pasadena. Is 2114 Mulberry Ln yours?",
    "Hello William, this is Alex. I have been investing in Spring. Just checking, do you own 23227 Briarcreek Blvd?",
  ];
  for (const opener of openers) {
    const ctx = await contextAfter(opener, { template_use_case: "ownership_check" });
    for (const message of ["No", "No.", "Nope", "No I don't"]) {
      const r = await run(message, ctx);
      assert.equal(r.primary_intent, "wrong_number", `${message} after ${opener}`);
      assert.equal(r.context_status, "valid");
      assert.equal(r.automation_decision.auto_reply_allowed, false);
    }
  }
});

test("'Not anymore' to 'do you still own…?' is sold, not a wrong person", async () => {
  const ctx = await contextAfter("Do you still own 1 Main St?", { template_use_case: "ownership_check" });
  const r = await run("Not anymore", ctx);
  assert.equal(r.primary_intent, "sold_property");
  assert.equal(r.automation_decision.suppression_action, "none");
});

test("bare 'No' to 'open to a sale?' is not_interested", async () => {
  const ctx = await contextAfter("Thanks. Just curious, would you be open to a sale?");
  const r = await run("No", ctx);
  assert.equal(r.primary_intent, "not_interested");
});

test("a bare 'No' with NO context still never becomes a wrong number", async () => {
  const r = await run("No", null);
  assert.notEqual(r.primary_intent, "wrong_number");
});

// ── 5. purpose / identity questions ─────────────────────────────────────────

test("Dulsie E Robinson: 'Why are you asking?' after 'Yes, I do' routes to who_is_this", async () => {
  const ctx = await contextAfter("Hey Dulsie, this is Alex. Do you still own 3404 Rufus St?", {
    template_use_case: "ownership_check",
    intervening: [{ id: "a", created_at: "2026-10-05T13:30:00Z", direction: "inbound", message_body: "Yes, I do", detected_intent: "ownership_confirmed" }],
  });
  for (const message of ["Why are you asking?", "Why do you ask?", "Who is this?", "How did you get my number?", "¿Por qué pregunta?"]) {
    const r = await run(message, ctx);
    assert.equal(r.primary_intent, "who_is_this", message);
  }
});

// ── 6. price replies: classification (policy reported separately) ───────────

test("Yanli Mu '199k sale' and Frank L Hutchinson III '1 million for the property' are asking_price_provided", async () => {
  for (const [opener, message] of [
    ["Ni hao Yanli, wo shi Wei. Nin hai yongyou 3706 E Lockwood Dr ma?", "199k sale"],
    ["Hi Frank, my name is Mason. Came across 4722 Eppes St, are you still the owner?", "1 million for the property"],
  ]) {
    const ctx = await contextAfter(opener, { template_use_case: "ownership_check" });
    const r = await run(message, ctx);
    assert.equal(r.primary_intent, "asking_price_provided", message);
    assert.equal(r.automation_decision.auto_reply_allowed, true, message);
  }
});

// ── 7. Bethel: bare "Yes" binds through the template / body ─────────────────

test("Bethel C Nwachukwu: 'Yes' to 'Is this the correct number for the owner?' binds ownership with context", async () => {
  const opener = "Hey Bethel, hope all is well. This is Mason reaching out about 5909 Langley Rd. Is this the correct number for the owner?";
  assert.equal(deriveUseCaseFromBody(opener), "ownership_check");
  for (const template_use_case of ["ownership_check", null]) {
    const ctx = await contextAfter(opener, { template_use_case });
    const r = await run("Yes", ctx);
    assert.equal(r.primary_intent, "ownership_confirmed");
    assert.equal(r.context_status, "valid");
    assert.ok(!(r.ambiguity_flags || []).includes("short_reply_without_validated_context"));
    assert.equal(r.automation_decision.auto_reply_allowed, true);
    assert.equal(r.language, "English");
  }
});
