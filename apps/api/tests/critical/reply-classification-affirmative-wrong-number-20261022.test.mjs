/**
 * Production 2026-10-22: two replies a person can read were held `unclear`
 * (no auto reply, review):
 *   - "sure is" to "…are you still the owner?"          -> ownership_confirmed
 *   - "Sorry it's not the right number" to the same      -> wrong_number
 * Close variants are locked here, together with the cases that must NOT move:
 * negations, money talk, replies with no ownership question behind them,
 * STOP (absolute), "No" / "No thanks" to the ownership question, Spanish.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { classify, NOT_RIGHT_NUMBER_RULE_ID } from "@/lib/domain/classification/classify.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";

function supabaseWith({ outbound = [], templates = [] } = {}) {
  const make = (rows) => {
    const b = {
      select: () => b, eq: () => b, in: () => b, not: () => b, lte: () => b,
      gt: () => b, lt: () => b, order: () => b,
      limit: async () => ({ data: rows, error: null }),
    };
    return b;
  };
  return { from: (table) => make(table === "message_events" ? [] : table === "sms_templates" ? templates : outbound) };
}

async function contextAfter(body, template_use_case) {
  return buildConversationContext({
    thread_key: "+18175550100",
    inbound_received_at: "2026-10-22T14:00:00.000Z",
    supabase: supabaseWith({
      outbound: [{
        id: "out-1", message_type: null, message_body: body, template_id: "tpl-1", provider_message_id: null,
        sent_at: "2026-10-22T13:00:00.000Z", delivered_at: "2026-10-22T13:00:10.000Z", queue_status: "delivered",
      }],
      templates: [{ use_case: template_use_case }],
    }),
  });
}

const S1 = "Hi Pat, my name is Alex. Came across 100 Main St, are you still the owner?";
const S1_ES = "Hola Martin, soy Alex. Compro propiedad en 76106. Sigues siendo el dueno de 1621 Michael St?";
const S2 = "Thanks Pat. Would you consider selling 100 Main St if the terms worked for you?";
const S3 = "Do you have a price in mind for 100 Main St?";

const run = (message, ctx) => classify(message, null, { heuristicOnly: true, conversation_context: ctx });

test("affirmatives to OUR ownership question are ownership_confirmed (the 'sure is' miss)", async () => {
  const ctx = await contextAfter(S1, "ownership_check");
  assert.equal(ctx.last_outbound_use_case, "ownership_check");
  for (const m of ["sure is", "Sure is!", "It sure is", "sure am", "I sure do", "yes it is", "sure do", "that's me", "yes that's me", "Yes, that's me"]) {
    const r = await run(m, ctx);
    assert.equal(r.primary_intent, "ownership_confirmed", m);
    assert.ok(r.matched_rule_ids.includes("ctx_yes_after_ownership_check"), m);
    assert.equal(r.compliance_flag, null, m);
    assert.equal(r.automation_decision.suppression_action, "none", m);
    const rel = resolveInboundRelationship({ message: m, classification: r });
    assert.equal(rel.canonical_intent, "ownership_confirmed", m);
  }
});

test("'sure is' binds to the question it answers: to the S2 interest question it is interest, not ownership", async () => {
  const ctx = await contextAfter(S2, "consider_selling");
  const r = await run("sure is", ctx);
  assert.notEqual(r.primary_intent, "ownership_confirmed");
  assert.equal(r.primary_intent, "seller_interested");
});

test("no ownership question behind it: 'sure is' is not made confident", async () => {
  const r = await run("sure is", null);
  assert.equal(r.primary_intent, "unclear");
});

test("negations never become ownership_confirmed", async () => {
  const ctx = await contextAfter(S1, "ownership_check");
  for (const m of ["not sure", "sure isn't", "Sure isn't mine", "no it is not", "that's not me", "not really sure"]) {
    const r = await run(m, ctx);
    assert.notEqual(r.primary_intent, "ownership_confirmed", m);
  }
  // "that's not me" keeps its existing wrong-person reading.
  assert.equal((await run("that's not me", ctx)).primary_intent, "wrong_number");
});

test("'not the right number' to OUR ownership question is the same wrong number as 'wrong number'", async () => {
  const ctx = await contextAfter(S1, "ownership_check");
  const reference = await run("wrong number sorry", ctx);
  assert.equal(reference.primary_intent, "wrong_number");
  const pick = (r) => ({
    primary_intent: r.primary_intent,
    detected_intent: r.detected_intent,
    objection: r.objection,
    compliance_flag: r.compliance_flag,
    automation_decision: r.automation_decision,
  });
  const refRel = resolveInboundRelationship({ message: "wrong number sorry", classification: reference });
  for (const m of [
    "Sorry it's not the right number",
    "Sorry it’s not the right number",
    "not the right number",
    "Sorry, this isn't the correct number",
    "That's not the right phone number",
    "not the right #",
  ]) {
    const r = await run(m, ctx);
    assert.deepEqual(pick(r), pick(reference), m);
    assert.ok(r.matched_rule_ids.includes(NOT_RIGHT_NUMBER_RULE_ID), m);
    assert.equal(r.automation_decision.suppression_action, "archive_wrong_number", m);
    assert.notEqual(r.automation_decision.suppression_action, "opt_out", m);
    const rel = resolveInboundRelationship({ message: m, classification: r });
    assert.equal(rel.canonical_intent, refRel.canonical_intent, m);
    assert.equal(rel.relationship_outcome, refRel.relationship_outcome, m);
    assert.equal(rel.suppression_scope, refRel.suppression_scope, m);
  }
});

test("existing wrong-number / wrong-person variants are unchanged", async () => {
  const ctx = await contextAfter(S1, "ownership_check");
  for (const m of ["wrong number sorry", "wrong number", "you have the wrong person", "wrong person"]) {
    const r = await run(m, ctx);
    assert.equal(r.primary_intent, "wrong_number", m);
    assert.equal(r.automation_decision.suppression_action, "archive_wrong_number", m);
    assert.equal(r.compliance_flag, null, m);
  }
  // wrong person is a property-scoped non-owner, never a global opt-out
  const wp = await run("you have the wrong person", ctx);
  const rel = resolveInboundRelationship({ message: "you have the wrong person", classification: wp });
  assert.equal(rel.is_property_scoped, true);
});

test("'not the right number' is never a wrong number when it is about money or has no ownership question behind it", async () => {
  const s1 = await contextAfter(S1, "ownership_check");
  for (const m of ["that's not the right number for the house", "90k is not the right number", "Not the right number, the offer is too low"]) {
    const r = await run(m, s1);
    assert.notEqual(r.primary_intent, "wrong_number", m);
    assert.ok(!r.matched_rule_ids.includes(NOT_RIGHT_NUMBER_RULE_ID), m);
  }
  // after OUR price question it answers a number
  const s3 = await contextAfter(S3, "seller_asking_price");
  const asked = await run("not the right number", s3);
  assert.notEqual(asked.primary_intent, "wrong_number");
  assert.equal(asked.automation_decision.suppression_action, "none");
  // after OUR interest question, and with no context at all (offer and manual
  // rows often carry none), the words stay with the existing rules
  const s2 = await contextAfter(S2, "consider_selling");
  assert.notEqual((await run("not the right number", s2)).primary_intent, "wrong_number");
  const bare = await run("Sorry it's not the right number", null);
  assert.notEqual(bare.primary_intent, "wrong_number");
  assert.equal(bare.automation_decision.suppression_action, "none");
  // and a relationship is never bound from the words alone
  const rel = resolveInboundRelationship({ message: "Sorry it's not the right number", classification: bare });
  assert.notEqual(rel.relationship_outcome, "actual_wrong_number");
});

test("STOP is absolute: a wrong-number reply that also says stop is an opt-out", async () => {
  const ctx = await contextAfter(S1, "ownership_check");
  for (const m of ["wrong number stop texting me", "Sorry it's not the right number. Stop", "not the right number, stop texting me"]) {
    const r = await run(m, ctx);
    assert.equal(r.compliance_flag, "stop_texting", m);
    assert.equal(r.automation_decision.suppression_action, "opt_out", m);
    assert.equal(r.automation_decision.auto_reply_allowed, false, m);
  }
});

test("'No' and 'No thanks' to the ownership question keep their locked routing", async () => {
  const ctx = await contextAfter(S1, "ownership_check");
  for (const m of ["No", "No thanks"]) {
    const r = await run(m, ctx);
    assert.equal(r.primary_intent, "not_interested", m);
    assert.ok(r.matched_rule_ids.includes("ctx_bare_no_after_ownership_check_not_interested"), m);
    assert.equal(r.automation_decision.suppression_action, "none", m);
  }
});

test("Spanish replies are untouched (no English rule reads them)", async () => {
  const ctx = await contextAfter(S1_ES, "ownership_check");
  const yes = await run("Si es", ctx);
  assert.equal(yes.primary_intent, "ownership_confirmed");
  assert.equal(yes.language, "Spanish");
  const wrong = await run("numero equivocado", ctx);
  assert.equal(wrong.primary_intent, "wrong_number");
  assert.ok(!wrong.matched_rule_ids.includes(NOT_RIGHT_NUMBER_RULE_ID));
});
